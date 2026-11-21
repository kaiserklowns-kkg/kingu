//! Agent CLI status through Claude Code hooks (how Orca knows an agent is working, waiting for a
//! permission answer or done). A CLI task starts `claude --settings <json>` whose hooks append each
//! hook's JSON payload (stdin) as one line to `<app cache>/agent-hooks/<token>.jsonl`; the webview
//! reads new lines with `agent_hook_read`. codex appends its `notify` payloads to the same kind of
//! file (`agent_hook_file`; the command is built in agentProfiles.ts), and so do the status hooks
//! of other CLIs (status_hooks.rs) through `KINGU_AGENT_HOOK_FILE`. The token is random per CLI
//! session, so a file name never carries a task name or path.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

const DIR: &str = "agent-hooks";
/// The events that move a card: started, working, waiting for you (a permission prompt, a
/// question, idle), turn done, ended.
pub const EVENTS: &[&str] = &["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Notification", "Stop", "SessionEnd"];
/// Events newer Claude Code versions know, with the first version that has each (Orca's
/// `CLAUDE_HOOK_EVENT_FIRST_VERSIONS`, cli-capabilities/claude-hook-event-versions.ts). An older
/// claude rejects the whole `--settings` on an unknown event, so each is added only when
/// `claude --version` says it is known; an unknown version gets none of them (Orca: the floor).
/// PostToolUseFailure keeps a failed tool "working"; Elicitation (an MCP server's dialog) waits on
/// you; PostCompact ends a manual /compact that sends no Stop; StopFailure ends a turn an API
/// error stopped. SubagentStart/SubagentStop (both from 2.0.43) keep the lead "working" while its
/// background subagents run (Orca's child roster).
pub const GATED_EVENTS: &[(&str, (u32, u32, u32))] = &[
  ("SubagentStart", (2, 0, 43)),
  ("SubagentStop", (2, 0, 43)),
  // An agent team's teammate went idle: it no longer keeps the lead working (Orca's roster).
  ("TeammateIdle", (2, 1, 33)),
  ("PostToolUseFailure", (2, 0, 56)),
  ("Elicitation", (2, 1, 63)),
  ("ElicitationResult", (2, 1, 63)),
  ("PostCompact", (2, 1, 76)),
  ("StopFailure", (2, 1, 78)),
  // A batch end lists the calls it settled: a permission Claude denied itself (no Post* hook) ends (Orca).
  ("PostToolBatch", (2, 1, 118)),
];

/// The events a claude of `version` gets.
pub fn events_for(version: Option<(u32, u32, u32)>) -> Vec<&'static str> {
  let mut out = EVENTS.to_vec();
  if let Some(v) = version {
    out.extend(GATED_EVENTS.iter().filter(|(_, floor)| v >= *floor).map(|(e, _)| *e));
  }
  out
}

/// Claude's own version line, `2.1.80 (Claude Code)` (Orca `parseClaudeCliVersionOutput`: a
/// launcher's own version, e.g. from `npx`, must not count).
pub fn parse_claude_version(out: &str) -> Option<(u32, u32, u32)> {
  out.lines().find_map(|l| {
    let i = l.to_ascii_lowercase().find("(claude code)")?;
    let word = l[..i].split_whitespace().last()?;
    let core = word.split(['-', '+']).next()?;
    let mut n = core.split('.').map(|x| x.parse::<u32>().ok());
    Some((n.next()??, n.next()??, n.next()??))
  })
}

/// `<program> --version`, at most 5 s, cached per program for the app's run.
pub(crate) fn claude_version(program: &str) -> Option<(u32, u32, u32)> {
  use std::collections::HashMap;
  use std::sync::{Mutex, OnceLock};
  static CACHE: OnceLock<Mutex<HashMap<String, Option<(u32, u32, u32)>>>> = OnceLock::new();
  let cache = CACHE.get_or_init(Mutex::default);
  if let Some(v) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(program) {
    return *v;
  }
  let mut child = crate::shell_env::command(program)
    .arg("--version")
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::null())
    .spawn()
    .ok()?;
  let start = std::time::Instant::now();
  loop {
    match child.try_wait() {
      Ok(Some(_)) => break,
      Ok(None) if start.elapsed() < std::time::Duration::from_secs(5) => std::thread::sleep(std::time::Duration::from_millis(50)),
      _ => {
        let _ = child.kill();
        let _ = child.wait();
        return None;
      }
    }
  }
  let mut out = String::new();
  child.stdout.take()?.read_to_string(&mut out).ok()?;
  let v = parse_claude_version(&out);
  // A probe that worked is kept; a failed one is tried again next launch.
  if v.is_some() {
    cache.lock().unwrap_or_else(|e| e.into_inner()).insert(program.to_string(), v);
  }
  v
}

/// One read returns at most this much (a long session catches up over several reads).
const MAX_READ: u64 = 1 << 20;

pub fn valid_token(token: &str) -> bool {
  (8..=64).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// The hook file's path as it goes single-quoted into a shell command; our own path never
/// contains a quote, but check.
pub fn quotable_path(file: &Path) -> Result<&str, String> {
  let path = file.to_str().ok_or("hook path is not valid UTF-8")?;
  if path.contains('\'') || path.contains('\n') {
    return Err("hook path cannot be quoted".into());
  }
  Ok(path)
}

/// A path as the hook's POSIX shell takes it. Claude Code on Windows runs hook commands in Git Bash,
/// which takes `C:/Users/…` (forward slashes) as it does `/c/Users/…`; backslashes are left to MSYS's
/// own conversion otherwise. Not yet checked on a Windows machine.
pub fn shell_path(path: &str, windows: bool) -> String {
  if windows { path.replace('\\', "/") } else { path.to_owned() }
}

/// Claude Code's PermissionRequest hook that waits for Kingu's answer (Orca's blocking hook,
/// claude-hook-decision-script.ts + claude-permission-hook-hold.ts). It appends the request with a
/// hold id, marks itself waiting (`<file>.<id>.wait`) and prints the answer Kingu writes to
/// `<file>.<id>.answer`; after 122 s (past claude's own two minutes, inside the entry's 130 s
/// timeout) or with no answer it prints `{}`, so claude asks as usual. Claude shows its dialog
/// meanwhile, so the person can still answer in the terminal.
pub const PERMISSION_HOLD_SCRIPT: &str = r#"#!/bin/sh
# Managed by Kingu (agent hooks); Kingu rewrites this file, edits are lost.
f="$1"
payload=$(cat)
one=$(printf '%s' "$payload" | tr '\r\n' '  ')
id="$(date +%s)-$$"
base="${f%.jsonl}"
w="$base.$id.wait"
a="$base.$id.answer"
case "$one" in
  '{}'|'{ }') printf '%s\n' "$one" >> "$f"; printf '{}\n'; exit 0 ;;
  '{'*) ;;
  *) printf '%s\n' "$one" >> "$f"; printf '{}\n'; exit 0 ;;
esac
trap 'rm -f "$w" "$a"' EXIT
trap 'exit 0' HUP INT TERM
: > "$w"
printf '{"kingu_hold":"%s",%s\n' "$id" "${one#\{}" >> "$f"
n=0
while [ "$n" -lt 244 ]; do
  if [ -s "$a" ]; then cat "$a"; exit 0; fi
  sleep 0.5
  n=$((n + 1))
done
printf '{}\n'
"#;
/// The hold's own budget is 122 s; the entry's timeout outlasts it (Orca: 130 s).
pub const PERMISSION_HOLD_TIMEOUT_SECONDS: u64 = 130;
const HOLD_SCRIPT_NAME: &str = "permission-hold.sh";

/// `--settings` JSON with a command hook per event that appends the payload to `file`; with
/// `hold_script`, PermissionRequest runs it instead and waits for Kingu's answer.
pub fn settings_json(file: &Path, events: &[&str], hold_script: Option<&Path>) -> Result<String, String> {
  let path = shell_path(quotable_path(file)?, cfg!(windows));
  let command = format!("{{ cat; echo; }} >> '{path}'");
  let entry = serde_json::json!([{ "hooks": [{ "type": "command", "command": command }] }]);
  let hold = match hold_script {
    Some(script) => Some(serde_json::json!([{ "hooks": [{ "type": "command", "command": format!("/bin/sh '{}' '{path}'", shell_path(quotable_path(script)?, cfg!(windows))), "timeout": PERMISSION_HOLD_TIMEOUT_SECONDS }] }])),
    None => None,
  };
  let hooks: serde_json::Map<String, serde_json::Value> = events
    .iter()
    .map(|e| (e.to_string(), if *e == "PermissionRequest" { hold.clone().unwrap_or_else(|| entry.clone()) } else { entry.clone() }))
    .collect();
  Ok(serde_json::json!({ "hooks": hooks }).to_string())
}

/// A hold id the script made (`<unix seconds>-<pid>`).
pub fn valid_hold(id: &str) -> bool {
  (3..=40).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit() || b == b'-')
}

/// Claude's PermissionRequest decision (Orca `claudePermissionReply`; never `updatedPermissions`:
/// an answer covers this one request only).
pub fn permission_reply(allow: bool, message: &str) -> String {
  let decision = if allow { serde_json::json!({ "behavior": "allow" }) } else { serde_json::json!({ "behavior": "deny", "message": message }) };
  serde_json::json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": decision } }).to_string()
}

/// Hands the answer to a waiting hold of the session whose hook file is `file`. False when that
/// hook no longer waits (it timed out, or claude moved on), so the caller answers another way.
pub fn answer_hold(file: &Path, hold: &str, reply: &str) -> Result<bool, String> {
  if !valid_hold(hold) {
    return Err("invalid hold id".into());
  }
  let base = file.with_extension("");
  let name = base.file_name().and_then(|n| n.to_str()).ok_or("bad hook file")?;
  let at = |ext: &str| base.with_file_name(format!("{name}.{hold}.{ext}"));
  if !at("wait").exists() {
    return Ok(false);
  }
  // Written whole, then renamed: the script prints the file as soon as it is not empty.
  let tmp = at("answer.tmp");
  std::fs::write(&tmp, format!("{reply}\n")).map_err(|e| e.to_string())?;
  std::fs::rename(&tmp, at("answer")).map_err(|e| e.to_string())?;
  Ok(true)
}

#[derive(Debug, serde::Serialize, PartialEq)]
pub struct HookRead {
  pub events: Vec<serde_json::Value>,
  /// Where the next read starts (after the last complete line).
  pub offset: u64,
}

/// Complete lines of `bytes` as JSON values (blank or broken lines skipped) and how many bytes they used.
pub fn parse_lines(bytes: &[u8]) -> (Vec<serde_json::Value>, usize) {
  let Some(end) = bytes.iter().rposition(|&b| b == b'\n').map(|i| i + 1) else { return (Vec::new(), 0) };
  let events = bytes[..end]
    .split(|&b| b == b'\n')
    .filter(|l| !l.iter().all(u8::is_ascii_whitespace))
    .filter_map(|l| serde_json::from_slice(l).ok())
    .collect();
  (events, end)
}

pub fn read_from(file: &Path, offset: u64) -> Result<HookRead, String> {
  let Ok(mut f) = std::fs::File::open(file) else { return Ok(HookRead { events: Vec::new(), offset }) };
  let len = f.metadata().map_err(|e| e.to_string())?.len();
  // The file was replaced (a new session with the same token): start over.
  let offset = if offset > len { 0 } else { offset };
  f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
  let mut bytes = Vec::new();
  f.take(MAX_READ).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
  let (events, used) = parse_lines(&bytes);
  Ok(HookRead { events, offset: offset + used as u64 })
}

pub(crate) fn file_of(app: &AppHandle, token: &str) -> Result<PathBuf, String> {
  if !valid_token(token) {
    return Err("invalid hook token".into());
  }
  Ok(app.path().app_cache_dir().map_err(|e| e.to_string())?.join(DIR).join(format!("{token}.jsonl")))
}

/// A new session's hook file, empty (creates the hooks folder).
fn fresh_file(app: &AppHandle, token: &str) -> Result<PathBuf, String> {
  let file = file_of(app, token)?;
  if let Some(dir) = file.parent() {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
  }
  std::fs::write(&file, b"").map_err(|e| e.to_string())?;
  Ok(file)
}

/// The `--settings` JSON for a new claude session; `program`: the claude it runs (for its version).
#[tauri::command]
pub async fn agent_hook_settings(app: AppHandle, token: String, program: Option<String>) -> Result<String, String> {
  let program = program.filter(|p| !p.trim().is_empty()).unwrap_or_else(|| "claude".into());
  let version = tauri::async_runtime::spawn_blocking(move || claude_version(&program)).await.map_err(|e| e.to_string())?;
  let file = fresh_file(&app, &token)?;
  let script = file.with_file_name(HOLD_SCRIPT_NAME);
  // Kingu's own copy each launch (an edit or an older version never stays).
  let hold = std::fs::write(&script, PERMISSION_HOLD_SCRIPT).map(|_| script.as_path()).map_err(|e| log::warn!("permission hold script: {e}")).ok();
  settings_json(&file, &events_for(version), hold)
}

/// Answers the waiting PermissionRequest hook `hold` of a claude session (the task's quick reply).
/// False when that hook no longer waits.
#[tauri::command]
pub fn agent_permission_answer(app: AppHandle, token: String, hold: String, allow: bool) -> Result<bool, String> {
  answer_hold(&file_of(&app, &token)?, &hold, &permission_reply(allow, "Denied in Kingu."))
}

/// The hook file of a new session whose CLI appends to it itself (codex `notify`).
#[tauri::command]
pub fn agent_hook_file(app: AppHandle, token: String) -> Result<String, String> {
  let file = fresh_file(&app, &token)?;
  quotable_path(&file).map(str::to_owned)
}

#[tauri::command]
pub fn agent_hook_read(app: AppHandle, token: String, offset: u64) -> Result<HookRead, String> {
  read_from(&file_of(&app, &token)?, offset)
}

/// The hook token of an ADE terminal pane (Orca's per-pane hook env): every terminal of a task's
/// worktree gets `KINGU_AGENT_HOOK_FILE`, so an agent CLI typed by hand in any pane reports its
/// state too (through the status hooks Kingu installs; status_hooks.rs). Derived from the PTY key,
/// so the page finds the file again after a reload without storing anything.
pub fn pane_token(key: &str) -> String {
  format!("pane-{}", &crate::snap::sha256_hex(key.as_bytes())[..32])
}

/// The hook file a new pane's shell gets as `KINGU_AGENT_HOOK_FILE` (the folder is created).
pub fn pane_file(app: &AppHandle, key: &str) -> Result<PathBuf, String> {
  let file = file_of(app, &pane_token(key))?;
  if let Some(dir) = file.parent() {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
  }
  Ok(file)
}

/// A new pane starts with an empty hook file (an old one of the same key is from a shell that is gone).
pub fn pane_file_reset(app: &AppHandle, key: &str) {
  if let Ok(file) = file_of(app, &pane_token(key)) {
    let _ = std::fs::write(file, b"");
  }
}

/// New hook events of an ADE terminal pane (see `pane_token`).
#[tauri::command]
pub fn agent_pane_hook_read(app: AppHandle, key: String, offset: u64) -> Result<HookRead, String> {
  crate::pty::validate_key(&key)?;
  read_from(&file_of(&app, &pane_token(&key))?, offset)
}

/// The pane was closed.
#[tauri::command]
pub fn agent_pane_hook_clear(app: AppHandle, key: String) -> Result<(), String> {
  crate::pty::validate_key(&key)?;
  agent_hook_clear(app, pane_token(&key))
}

/// The session ended or its task was removed.
#[tauri::command]
pub fn agent_hook_clear(app: AppHandle, token: String) -> Result<(), String> {
  let file = file_of(&app, &token)?;
  match std::fs::remove_file(&file) {
    Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
    _ => Ok(()),
  }
}

// ---------------------------------------------------------------------------------------------
// Per-run files: what a CLI launch needs on disk for one session (gemini's system-defaults
// settings with the Snap MCP servers, agentProfiles.ts `Launch.files`), in
// `<app cache>/agent-runs/<token>/`, never in the repo, the worktree or the user's config.

const RUNS_DIR: &str = "agent-runs";
const RUN_TTL: std::time::Duration = std::time::Duration::from_secs(7 * 24 * 60 * 60);
const MAX_RUN_FILE: usize = 4 * 1024 * 1024;

/// Creates (empty) the run folder of `token` under `base` and removes run folders older than a week.
pub fn run_dir_in(base: &Path, token: &str) -> Result<PathBuf, String> {
  if !valid_token(token) {
    return Err("invalid run token".into());
  }
  if let Ok(read) = std::fs::read_dir(base) {
    for entry in read.flatten() {
      let old = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > RUN_TTL);
      if old {
        let _ = std::fs::remove_dir_all(entry.path());
      }
    }
  }
  let dir = base.join(token);
  let _ = std::fs::remove_dir_all(&dir);
  std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
  }
  Ok(dir)
}

/// Writes `files` (absolute paths the profile built from the run folder) into exactly that
/// folder: each must be a plain file name directly inside it. Mode 0600 (they can hold env).
pub fn write_run_files(dir: &Path, files: &[(String, String)]) -> Result<(), String> {
  for (path, content) in files {
    let p = Path::new(path);
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    if p.parent() != Some(dir) || name.is_empty() || name.starts_with('.') || content.len() > MAX_RUN_FILE {
      return Err(format!("{path}: not a file of this run"));
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
      use std::os::unix::fs::OpenOptionsExt;
      options.mode(0o600);
    }
    use std::io::Write;
    options.open(p).and_then(|mut f| f.write_all(content.as_bytes())).map_err(|e| format!("{path}: {e}"))?;
  }
  Ok(())
}

fn runs_base(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(app.path().app_cache_dir().map_err(|e| e.to_string())?.join(RUNS_DIR))
}

/// A new session's run folder (agentProfiles `runDir`).
#[tauri::command]
pub fn agent_run_dir(app: AppHandle, token: String) -> Result<String, String> {
  let dir = run_dir_in(&runs_base(&app)?, &token)?;
  quotable_path(&dir).map(str::to_owned)
}

#[derive(serde::Deserialize)]
pub struct RunFile {
  path: String,
  content: String,
}

/// Writes a launch's files into its run folder before the CLI starts.
#[tauri::command]
pub fn agent_run_files_write(app: AppHandle, token: String, files: Vec<RunFile>) -> Result<(), String> {
  if !valid_token(&token) {
    return Err("invalid run token".into());
  }
  let dir = runs_base(&app)?.join(&token);
  let dir = dir.canonicalize().map_err(|e| e.to_string())?;
  let files: Vec<(String, String)> = files.into_iter().map(|f| {
    // The profile built the path from the (non-canonical) folder `agent_run_dir` returned.
    let name = Path::new(&f.path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let real = Path::new(&f.path).parent().and_then(|p| p.canonicalize().ok());
    (if real.as_deref() == Some(dir.as_path()) { dir.join(name).display().to_string() } else { f.path }, f.content)
  }).collect();
  write_run_files(&dir, &files)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn tokens() {
    assert!(valid_token("3f2a9c1e-77aa-4d1b-9c55-0e1f2a3b4c5d"));
    assert!(!valid_token("short"));
    assert!(!valid_token("../../etc/passwd-xxxx"));
  }

  #[test]
  fn settings_append_each_event_to_the_file() {
    let json: serde_json::Value = serde_json::from_str(&settings_json(Path::new("/c/agent-hooks/t.jsonl"), EVENTS, None).unwrap()).unwrap();
    for e in EVENTS {
      assert_eq!(json["hooks"][e][0]["hooks"][0]["command"], "{ cat; echo; } >> '/c/agent-hooks/t.jsonl'");
    }
    assert!(settings_json(Path::new("/it's/t.jsonl"), EVENTS, None).is_err());
    assert_eq!(quotable_path(Path::new("/c/agent-hooks/t.jsonl")).unwrap(), "/c/agent-hooks/t.jsonl");
    assert!(quotable_path(Path::new("/c/a\nb.jsonl")).is_err());
  }

  #[test]
  fn newer_events_follow_the_claude_version() {
    assert_eq!(parse_claude_version("2.1.80 (Claude Code)\n"), Some((2, 1, 80)));
    assert_eq!(parse_claude_version("npx 10.2.0\n2.0.60-beta.1 (Claude Code)"), Some((2, 0, 60)));
    assert_eq!(parse_claude_version("10.2.0"), None);
    assert_eq!(events_for(None), EVENTS.to_vec());
    let mid = events_for(Some((2, 1, 63)));
    assert!(mid.contains(&"PostToolUseFailure") && mid.contains(&"Elicitation") && !mid.contains(&"PostCompact"));
    assert!(events_for(Some((2, 1, 78))).contains(&"StopFailure"));
    assert!(!events_for(Some((2, 0, 55))).contains(&"PostToolUseFailure"));
    assert!(events_for(Some((3, 0, 0))).len() == EVENTS.len() + GATED_EVENTS.len());
  }

  #[test]
  fn pane_tokens_are_valid_and_stable_per_key() {
    let a = pane_token("ade:abc:fix-login:t1");
    assert!(valid_token(&a));
    assert_eq!(a, pane_token("ade:abc:fix-login:t1"));
    assert_ne!(a, pane_token("ade:abc:fix-login:t2"));
    assert!(!a.contains("fix-login"));
  }

  #[test]
  fn parses_complete_lines_only() {
    let (events, used) = parse_lines(b"{\"hook_event_name\":\"Stop\"}\n\nnot json\n{\"hook_event_name\":\"Notif");
    assert_eq!(events, vec![serde_json::json!({"hook_event_name":"Stop"})]);
    assert_eq!(used, b"{\"hook_event_name\":\"Stop\"}\n\nnot json\n".len());
    assert_eq!(parse_lines(b"partial").1, 0);
  }

  #[test]
  fn reads_on_from_an_offset_and_restarts_after_truncation() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("t.jsonl");
    assert_eq!(read_from(&file, 0).unwrap(), HookRead { events: vec![], offset: 0 });
    std::fs::write(&file, "{\"a\":1}\n{\"b\":2}\n").unwrap();
    let first = read_from(&file, 0).unwrap();
    assert_eq!(first.events.len(), 2);
    assert!(read_from(&file, first.offset).unwrap().events.is_empty());
    std::fs::write(&file, "{\"c\":3}\n").unwrap();
    assert_eq!(read_from(&file, first.offset).unwrap().events, vec![serde_json::json!({"c":3})]);
  }

  #[test]
  fn run_files_stay_in_their_run_folder() {
    let base = tempfile::tempdir().unwrap();
    let dir = run_dir_in(base.path(), "abcd-1234").unwrap();
    assert!(run_dir_in(base.path(), "../x").is_err());
    let ok = dir.join("gemini-system-defaults.json").display().to_string();
    write_run_files(&dir, &[(ok.clone(), "{}".into())]).unwrap();
    assert_eq!(std::fs::read_to_string(&ok).unwrap(), "{}");
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      assert_eq!(std::fs::metadata(&ok).unwrap().permissions().mode() & 0o777, 0o600);
    }
    for bad in [base.path().join("x.json"), dir.join("sub/x.json"), dir.join(".hidden"), dir.join("../abcd-1234x/y")] {
      assert!(write_run_files(&dir, &[(bad.display().to_string(), "x".into())]).is_err(), "{}", bad.display());
    }
    // A new run with the same token starts empty.
    let again = run_dir_in(base.path(), "abcd-1234").unwrap();
    assert!(std::fs::read_dir(again).unwrap().next().is_none());
  }

  #[test]
  fn permission_request_waits_with_a_longer_timeout() {
    let json: serde_json::Value = serde_json::from_str(&settings_json(Path::new("/c/agent-hooks/t.jsonl"), EVENTS, Some(Path::new("/c/agent-hooks/permission-hold.sh"))).unwrap()).unwrap();
    let hold = &json["hooks"]["PermissionRequest"][0]["hooks"][0];
    assert_eq!(hold["command"], "/bin/sh '/c/agent-hooks/permission-hold.sh' '/c/agent-hooks/t.jsonl'");
    assert_eq!(hold["timeout"], 130);
    assert_eq!(json["hooks"]["Stop"][0]["hooks"][0]["command"], "{ cat; echo; } >> '/c/agent-hooks/t.jsonl'");
    let reply: serde_json::Value = serde_json::from_str(&permission_reply(false, "no")).unwrap();
    assert_eq!(reply["hookSpecificOutput"]["decision"], serde_json::json!({ "behavior": "deny", "message": "no" }));
    assert!(valid_hold("1795160000-4242") && !valid_hold("../x") && !valid_hold("1"));
    assert_eq!(shell_path(r"C:\Users\a\AppData\Local\kingu\agent-hooks\t.jsonl", true), "C:/Users/a/AppData/Local/kingu/agent-hooks/t.jsonl");
    assert_eq!(shell_path("/c/agent-hooks/t.jsonl", false), "/c/agent-hooks/t.jsonl");
  }

  /// The real script under /bin/sh: the request lands in the hook file with its hold id, Kingu's
  /// answer comes out on stdout, and nothing is left behind.
  #[cfg(unix)]
  #[test]
  fn the_hold_script_prints_kingus_answer() {
    use std::io::Write;
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("permission-hold.sh");
    std::fs::write(&script, PERMISSION_HOLD_SCRIPT).unwrap();
    let file = dir.path().join("tok12345.jsonl");
    std::fs::write(&file, b"").unwrap();
    let mut child = std::process::Command::new("/bin/sh").arg(&script).arg(&file).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(br#"{"hook_event_name":"PermissionRequest","tool_name":"Bash"}"#).unwrap();
    let start = std::time::Instant::now();
    let hold = loop {
      let (events, _) = parse_lines(&std::fs::read(&file).unwrap());
      if let Some(h) = events.first().and_then(|e| e["kingu_hold"].as_str().map(str::to_owned)) {
        assert_eq!(events[0]["tool_name"], "Bash");
        break h;
      }
      assert!(start.elapsed().as_secs() < 10, "the request never arrived");
      std::thread::sleep(std::time::Duration::from_millis(50));
    };
    assert!(answer_hold(&file, &hold, &permission_reply(true, "")).unwrap());
    let out = child.wait_with_output().unwrap();
    let printed: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(printed["hookSpecificOutput"]["decision"]["behavior"], "allow");
    let left: Vec<_> = std::fs::read_dir(dir.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(left.len(), 2, "only the script and the hook file stay: {left:?}");
    assert!(!answer_hold(&file, &hold, "{}").unwrap(), "a finished hold takes no answer");
  }
}
