//! Status hooks for agent CLIs other than claude (Orca's managed agent hooks,
//! `agentStatusHooksEnabled`, Kingu's `kingu.agent.statusHooks`): how a card learns that gemini,
//! cursor-agent, copilot, droid, codex or opencode is working, needs a permission answer, asks a
//! question or is done, instead of guessing from terminal output.
//!
//! claude takes its hooks per session (`--settings`, hooks.rs). These CLIs only read hooks from
//! their user config, so, like Orca, Kingu adds its own entry there, next to the user's:
//! `~/.gemini/settings.json`, `~/.cursor/hooks.json`, `$COPILOT_HOME|~/.copilot/hooks/kingu-desktop.json`
//! (a file of its own), `~/.factory/settings.json` and `$CODEX_HOME/hooks.json` (plus the
//! `[hooks.state]` trust entries codex wants in `config.toml`). Every entry runs one script,
//! `<app data>/agent-status/agent-hook.sh <cli> <event>`, which appends the payload, tagged,
//! to the session's hook file named by `KINGU_AGENT_HOOK_FILE` — set only in the terminal Kingu
//! starts the CLI in — and does nothing anywhere else (and prints the allow/continue answer
//! cursor and gemini expect). So the global entry is inert outside Kingu.
//!
//! OpenCode needs no global edit: each session gets `OPENCODE_CONFIG_DIR` pointing at a Kingu
//! folder whose `plugins/` holds the status plugin (OpenCode loads it on top of
//! `~/.config/opencode`; a user's own `OPENCODE_CONFIG_DIR` is mirrored in with symlinks).
//!
//! Kingu's entries are recognised by the script path in their command (Orca matches its script
//! file the same way); install replaces them and keeps every other entry, remove (the setting
//! turned off) takes them out. Config files that do not parse are left alone; writes are atomic
//! with a `.kingu.bak` copy (trust.rs `replace_file`).

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use super::trust::{self, Homes};

/// What every Kingu entry's command contains (and nothing else's).
pub const MARKER: &str = "agent-status/agent-hook.sh";
const COPILOT_FILE: &str = "kingu-desktop.json";
const TOML_MARK: &str = "# Managed by Kingu (agent status hooks)";
const OPENCODE_PLUGIN: &str = "kingu-agent-status.js";

pub const SCRIPT: &str = r#"#!/bin/sh
# Managed by Kingu (agent status hooks); Kingu rewrites this file, edits are lost.
# $1 = agent CLI, $2 = hook event, $3 = what to print for the CLI (cursor, gemini wait for it).
# Appends the hook payload (stdin), tagged, to the status file of the Kingu terminal the CLI runs
# in (KINGU_AGENT_HOOK_FILE); in any other terminal it only drains stdin.
[ -n "${3-}" ] && printf '%s\n' "$3"
payload=$(cat)
f="${KINGU_AGENT_HOOK_FILE-}"
case "$f" in
  */agent-hooks/*.jsonl) ;;
  *) exit 0 ;;
esac
[ -n "$payload" ] || exit 0
one=$(printf '%s' "$payload" | tr '\r\n' '  ')
printf '{"kingu_hook":"%s","event":"%s","payload":%s}\n' "$1" "$2" "$one" >> "$f" 2>/dev/null
exit 0
"#;

pub const OPENCODE_PLUGIN_SOURCE: &str = r#"// Managed by Kingu (agent status hooks); Kingu rewrites this file, edits are lost.
// Reports the OpenCode session's state to the Kingu terminal it runs in (KINGU_AGENT_HOOK_FILE):
// busy / idle, a permission request and a question; child (subagent) sessions only for those two.
import { appendFileSync } from 'node:fs';

const file = process.env.KINGU_AGENT_HOOK_FILE;

function post(event, payload) {
	if (!file || !/\/agent-hooks\/[^/]+\.jsonl$/.test(file)) return;
	try {
		appendFileSync(file, JSON.stringify({ kingu_hook: 'opencode', event, payload: payload ?? {} }) + '\n');
	} catch {}
}

export const KinguAgentStatus = async () => {
	const children = new Set();
	return {
		event: async ({ event }) => {
			const p = event?.properties ?? {};
			const sid = p.sessionID ?? p.info?.sessionID;
			switch (event?.type) {
				case 'session.created':
					if (p.info?.parentID) children.add(p.info.id);
					else post('SessionStart', { sessionID: p.info?.id });
					return;
				case 'permission.asked':
				case 'permission.updated':
					return post('PermissionRequest', p);
				case 'question.asked':
					return post('AskUserQuestion', p);
				case 'permission.replied':
				case 'question.replied':
				case 'question.rejected':
					return post('SessionBusy', { sessionID: sid });
			}
			if (sid && children.has(sid)) return;
			if (event?.type === 'session.status') {
				const t = p.status?.type ?? event.status?.type;
				if (t === 'busy' || t === 'retry') post('SessionBusy', { sessionID: sid });
				else if (t === 'idle') post('SessionIdle', { sessionID: sid });
			} else if (event?.type === 'session.idle') post('SessionIdle', { sessionID: sid });
		}
	};
};
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Agent {
  Gemini,
  Cursor,
  Copilot,
  Droid,
  Codex,
}

impl Agent {
  pub const ALL: [Agent; 5] = [Agent::Gemini, Agent::Cursor, Agent::Copilot, Agent::Droid, Agent::Codex];

  pub fn of_id(id: &str) -> Option<Self> {
    match id {
      "gemini" => Some(Self::Gemini),
      "cursor" => Some(Self::Cursor),
      "copilot" => Some(Self::Copilot),
      "droid" => Some(Self::Droid),
      "codex" => Some(Self::Codex),
      _ => None,
    }
  }

  fn id(self) -> &'static str {
    match self {
      Self::Gemini => "gemini",
      Self::Cursor => "cursor",
      Self::Copilot => "copilot",
      Self::Droid => "droid",
      Self::Codex => "codex",
    }
  }

  /// The config file Kingu's entries go into.
  pub fn file(self, h: &Homes, copilot_home: Option<&Path>) -> PathBuf {
    match self {
      Self::Gemini => h.home.join(".gemini/settings.json"),
      Self::Cursor => h.home.join(".cursor/hooks.json"),
      Self::Copilot => copilot_home.map(Path::to_path_buf).unwrap_or_else(|| h.home.join(".copilot")).join("hooks").join(COPILOT_FILE),
      Self::Droid => h.home.join(".factory/settings.json"),
      Self::Codex => h.codex_home.clone().unwrap_or_else(|| h.home.join(".codex")).join("hooks.json"),
    }
  }

  /// Orca's events per CLI: (event, matcher, what the hook prints).
  fn events(self) -> Vec<(&'static str, Option<&'static str>, Option<&'static str>)> {
    match self {
      // Gemini waits for a JSON answer on stdout; it has no permission hook.
      Self::Gemini => ["BeforeAgent", "AfterAgent", "AfterTool", "BeforeTool"].map(|e| (e, None, Some("{}"))).to_vec(),
      // cursor's gate hooks fail closed on an empty answer, so they answer allow, exactly as Orca's do
      // (the answer cursor-agent then combines with its own permission settings).
      Self::Cursor => vec![
        ("beforeSubmitPrompt", None, Some(r#"{"continue":true}"#)),
        ("stop", None, Some("{}")),
        ("preToolUse", None, Some(r#"{"permission":"allow"}"#)),
        ("postToolUse", None, Some("{}")),
        ("postToolUseFailure", None, Some("{}")),
        ("beforeShellExecution", None, Some(r#"{"permission":"allow"}"#)),
        ("beforeMCPExecution", None, Some(r#"{"permission":"allow"}"#)),
        ("afterAgentResponse", None, Some("{}")),
      ],
      Self::Copilot => [
        "SessionStart",
        "SessionEnd",
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "PostToolUseFailure",
        "subagentStart",
        "SubagentStop",
        "PreCompact",
        "Stop",
        "ErrorOccurred",
        "PermissionRequest",
        "Notification",
      ]
      .map(|e| (e, None, Some("{}")))
      .to_vec(),
      Self::Droid => vec![
        ("SessionStart", None, None),
        ("UserPromptSubmit", None, None),
        ("Stop", None, None),
        ("SubagentStop", None, None),
        ("Notification", None, None),
        ("PreToolUse", Some("*"), None),
        ("PostToolUse", Some("*"), None),
        ("PermissionRequest", Some("*"), None),
      ],
      // Prints nothing: PermissionRequest makes no decision and codex shows its own prompt.
      Self::Codex => ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "SubagentStart", "SubagentStop", "Stop", "Interrupt"]
        .map(|e| (e, None, None))
        .to_vec(),
    }
  }

  fn definition(self, command: String, event: &str, matcher: Option<&str>) -> Value {
    match self {
      Self::Gemini => json!({ "hooks": [{ "type": "command", "command": command, "timeout": 10000 }] }),
      Self::Cursor => json!({ "command": command, "timeout": 10 }),
      Self::Copilot => json!({ "type": "command", "bash": command, "timeoutSec": 5 }),
      Self::Droid => {
        let mut d = json!({ "hooks": [{ "type": "command", "command": command, "timeout": 10 }] });
        if let Some(m) = matcher {
          d["matcher"] = json!(m);
        }
        d
      }
      Self::Codex => json!({ "hooks": [{ "type": "command", "command": command, "timeout": codex_timeout(event) }] }),
    }
  }
}

fn codex_timeout(event: &str) -> u64 {
  if event == "Interrupt" { 3 } else { 10 }
}

/// codex's trust label of a hooks.json event (`PreToolUse` → `pre_tool_use`).
pub fn codex_label(event: &str) -> String {
  let mut out = String::new();
  for (i, c) in event.chars().enumerate() {
    if c.is_ascii_uppercase() {
      if i > 0 {
        out.push('_');
      }
      out.push(c.to_ascii_lowercase());
    } else {
      out.push(c);
    }
  }
  out
}

/// codex's `trusted_hash` of a single-command group: sha256 of its canonical JSON (keys sorted,
/// no whitespace), as Orca computes it.
pub fn codex_hash(event: &str, command: &str) -> String {
  let preimage = format!(
    r#"{{"event_name":{},"hooks":[{{"async":false,"command":{},"timeout":{},"type":"command"}}]}}"#,
    json!(codex_label(event)),
    json!(command),
    codex_timeout(event)
  );
  let digest = Sha256::digest(preimage.as_bytes());
  format!("sha256:{}", digest.iter().map(|b| format!("{b:02x}")).collect::<String>())
}

pub fn sh_quote(s: &str) -> String {
  format!("'{}'", s.replace('\'', r"'\''"))
}

/// The hook command: the script when it is there, else drain stdin (and still give the answer).
pub fn hook_command(script: &Path, agent: Agent, event: &str, response: Option<&str>) -> String {
  let s = sh_quote(&script.to_string_lossy());
  let resp = response.map(sh_quote);
  let run = format!("/bin/sh {s} {} {event}{}", agent.id(), resp.as_deref().map(|r| format!(" {r}")).unwrap_or_default());
  let drain = match resp {
    Some(r) => format!("{{ cat >/dev/null 2>&1 || :; }}; printf '%s\\n' {r}"),
    None => "cat >/dev/null 2>&1 || :".to_owned(),
  };
  format!("if [ -f {s} ]; then {run}; else {drain}; fi")
}

fn is_managed(v: &Value) -> bool {
  ["command", "bash", "powershell"].iter().any(|k| v.get(*k).and_then(Value::as_str).is_some_and(|c| c.contains(MARKER)))
}

/// A hook group without Kingu's commands; None when nothing of it is left.
fn strip_group(g: &Value) -> Option<Value> {
  if is_managed(g) {
    return None;
  }
  if let Some(hs) = g.get("hooks").and_then(Value::as_array) {
    let kept: Vec<Value> = hs.iter().filter(|h| !is_managed(h)).cloned().collect();
    if kept.is_empty() && !hs.is_empty() {
      return None;
    }
    let mut g = g.clone();
    g["hooks"] = Value::Array(kept);
    return Some(g);
  }
  Some(g.clone())
}

/// Takes Kingu's entries out of `config.hooks` and adds `defs` (event, definition) after the
/// user's own. Returns each event's group index of Kingu's entry. Err: a shape it will not touch.
pub fn merge(config: &mut Map<String, Value>, defs: Vec<(String, Value)>) -> Result<Vec<(String, usize)>, String> {
  let hooks = config.entry("hooks").or_insert_with(|| Value::Object(Map::new()));
  let hooks = hooks.as_object_mut().ok_or("hooks is not an object")?;
  let events: Vec<String> = hooks.keys().cloned().collect();
  for e in events {
    let Some(arr) = hooks.get(&e).and_then(Value::as_array) else { continue };
    let cleaned: Vec<Value> = arr.iter().filter_map(strip_group).collect();
    if cleaned.len() != arr.len() || cleaned != *arr {
      if cleaned.is_empty() {
        hooks.remove(&e);
      } else {
        hooks.insert(e, Value::Array(cleaned));
      }
    }
  }
  let mut placed = Vec::new();
  for (event, def) in defs {
    let arr = hooks.entry(event.clone()).or_insert_with(|| Value::Array(Vec::new()));
    let arr = arr.as_array_mut().ok_or_else(|| format!("hooks.{event} is not a list"))?;
    arr.push(def);
    placed.push((event, arr.len() - 1));
  }
  Ok(placed)
}

/// `config.toml` with Kingu's `[hooks.state]` entries for `entries` (key, hash), replacing earlier
/// Kingu entries and any entry under those keys; `entries` empty: only takes Kingu's out.
pub fn codex_state_edit(text: &str, entries: &[(String, String)]) -> String {
  let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
  let lines: Vec<&str> = text.split_inclusive('\n').collect();
  let starts = trust::line_starts(text);
  let is_header = |i: usize| !starts[i].1 && lines[i].trim_start().starts_with('[');
  let mut drop = vec![false; lines.len()];
  let mut i = 0;
  while i < lines.len() {
    if !is_header(i) {
      i += 1;
      continue;
    }
    let end = (i + 1..lines.len()).find(|&j| is_header(j)).unwrap_or(lines.len());
    let ours = trust::header_keys(lines[i]).is_some_and(|k| {
      k.len() == 3 && k[0] == "hooks" && k[1] == "state" && (entries.iter().any(|(key, _)| *key == k[2]) || lines[i + 1..end].iter().any(|l| l.trim() == TOML_MARK))
    });
    if ours {
      drop[i..end].iter_mut().for_each(|d| *d = true);
    }
    i = end;
  }
  let mut out: String = lines.iter().zip(&drop).filter(|(_, d)| !**d).map(|(l, _)| *l).collect();
  // The blank line Kingu put before its first entry goes with it.
  if drop.iter().any(|d| *d) && !out.trim().is_empty() {
    out = format!("{}{eol}", out.trim_end_matches(['\n', '\r']));
  }
  for (key, hash) in entries {
    if !out.is_empty() && !out.ends_with('\n') {
      out.push_str(eol);
    }
    if !out.is_empty() && !out.ends_with(&format!("{eol}{eol}")) {
      out.push_str(eol);
    }
    out.push_str(&format!("[hooks.state.{}]{eol}{TOML_MARK}{eol}enabled = true{eol}trusted_hash = {}{eol}", json!(key), json!(hash)));
  }
  out
}

/// Writes a file Kingu owns (no backup), only when its content changed.
fn write_own(file: &Path, content: &str, mode: u32) -> Result<(), String> {
  if fs::read_to_string(file).is_ok_and(|c| c == content) {
    return Ok(());
  }
  let _ = fs::remove_file(file);
  trust::replace_file(file, content.as_bytes(), Some(mode))
}

/// Installs (`on`) or removes Kingu's entries for `agent` in `file`. Ok(false): nothing changed.
pub fn apply(agent: Agent, file: &Path, script: &Path, on: bool) -> Result<bool, String> {
  let target = trust::write_target(file)?;
  let mut config = match trust::read_json_object(&target) {
    Ok(Some(c)) => c,
    Ok(None) if !on => return Ok(false),
    Ok(None) => Map::new(),
    Err(_) => return Err(format!("{} อ่านไม่ได้ (ไม่ใช่ JSON) จึงไม่แก้", file.display())),
  };
  let before = config.clone();
  let defs = if on {
    agent.events().into_iter().map(|(e, m, r)| (e.to_owned(), agent.definition(hook_command(script, agent, e, r), e, m))).collect()
  } else {
    Vec::new()
  };
  let placed = merge(&mut config, defs)?;
  if on && matches!(agent, Agent::Cursor | Agent::Copilot) && !config.contains_key("version") {
    config.insert("version".into(), json!(1));
  }
  if agent == Agent::Copilot {
    // Copilot's own switch for all hooks would silence Kingu's file too (Orca drops it as well).
    config.remove("disableAllHooks");
  }
  let changed = config != before;
  if changed {
    if !on && agent == Agent::Copilot && config.get("hooks").and_then(Value::as_object).is_some_and(Map::is_empty) {
      fs::remove_file(&target).map_err(|e| e.to_string())?;
    } else {
      let text = serde_json::to_string_pretty(&Value::Object(config)).map_err(|e| e.to_string())? + "\n";
      trust::replace_file(&target, text.as_bytes(), Some(0o600))?;
    }
  }
  if agent == Agent::Codex {
    let source = trust::real(target.parent().ok_or("no folder")?).join("hooks.json");
    let entries: Vec<(String, String)> = placed
      .iter()
      .map(|(event, group)| (format!("{}:{}:{group}:0", source.display(), codex_label(event)), codex_hash(event, &hook_command(script, agent, event, None))))
      .collect();
    let toml_file = trust::write_target(&target.with_file_name("config.toml"))?;
    let text = match fs::read_to_string(&toml_file) {
      Ok(t) => t,
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
      Err(e) => return Err(e.to_string()),
    };
    if toml::from_str::<toml::Table>(text.trim_start_matches('\u{feff}')).is_err() {
      return Err(format!("{} อ่านไม่ได้ (ไม่ใช่ TOML) จึงไม่แก้", toml_file.display()));
    }
    let next = codex_state_edit(&text, &entries);
    if next != text {
      toml::from_str::<toml::Table>(next.trim_start_matches('\u{feff}')).map_err(|e| e.to_string())?;
      trust::replace_file(&toml_file, next.as_bytes(), Some(0o600))?;
      return Ok(true);
    }
  }
  Ok(changed)
}

/// `<data>/agent-status/opencode/<default | hash of the user's dir>`: the session's
/// `OPENCODE_CONFIG_DIR`, with the status plugin and (mirrored) the user's own config dir.
pub fn opencode_dir(base: &Path, user_dir: Option<&Path>) -> Result<PathBuf, String> {
  let name = match user_dir {
    Some(d) => {
      let digest = Sha256::digest(format!("source:{}", d.display()).as_bytes());
      digest.iter().take(16).map(|b| format!("{b:02x}")).collect::<String>()
    }
    None => "default".into(),
  };
  let dir = base.join("opencode").join(name);
  let plugins = dir.join("plugins");
  fs::create_dir_all(&plugins).map_err(|e| e.to_string())?;
  write_own(&plugins.join(OPENCODE_PLUGIN), OPENCODE_PLUGIN_SOURCE, 0o644)?;
  #[cfg(unix)]
  if let Some(user) = user_dir {
    use std::os::unix::fs::symlink;
    // Fresh links each time: the user's folder may have changed.
    for d in [&dir, &plugins] {
      for e in fs::read_dir(d).map_err(|e| e.to_string())?.flatten() {
        if e.file_type().is_ok_and(|t| t.is_symlink()) {
          let _ = fs::remove_file(e.path());
        }
      }
    }
    for e in fs::read_dir(user).map_err(|e| e.to_string())?.flatten() {
      let n = e.file_name();
      if n == "plugins" {
        for p in fs::read_dir(e.path()).map_err(|e| e.to_string())?.flatten() {
          if p.file_name() != OPENCODE_PLUGIN {
            let _ = symlink(p.path(), plugins.join(p.file_name()));
          }
        }
      } else {
        let _ = symlink(e.path(), dir.join(&n));
      }
    }
  }
  Ok(dir)
}

fn copilot_home() -> Option<PathBuf> {
  std::env::var_os("COPILOT_HOME").filter(|v| !v.is_empty()).map(PathBuf::from).filter(|p| p.is_absolute())
}

fn status_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  use tauri::Manager;
  Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("agent-status"))
}

fn ensure_script(dir: &Path) -> Result<PathBuf, String> {
  let script = dir.join("agent-hook.sh");
  write_own(&script, SCRIPT, 0o755)?;
  Ok(script)
}

/// Before `agent` (a profile id) starts: its status hooks are in place. Returns opencode's
/// `OPENCODE_CONFIG_DIR` for the session.
#[tauri::command]
pub async fn agent_status_hooks_install(app: tauri::AppHandle, agent: String, program: String) -> Result<Option<String>, String> {
  let dir = status_dir(&app)?;
  if agent == "opencode" {
    let user = std::env::var_os("OPENCODE_CONFIG_DIR").filter(|v| !v.is_empty()).map(PathBuf::from).filter(|p| p.is_dir());
    let d = tauri::async_runtime::spawn_blocking(move || opencode_dir(&dir, user.as_deref())).await.map_err(|e| e.to_string())??;
    return Ok(Some(d.to_str().ok_or("path is not UTF-8")?.to_owned()));
  }
  let Some(a) = Agent::of_id(&agent) else { return Ok(None) };
  let homes = trust::launch_homes(&app, &program)?;
  tauri::async_runtime::spawn_blocking(move || {
    let _one = trust::WRITING.lock().unwrap_or_else(|e| e.into_inner());
    let script = ensure_script(&dir)?;
    let file = a.file(&homes, copilot_home().as_deref());
    if apply(a, &file, &script, true)? {
      log::info!("agent status hooks for {agent} written to {}", file.display());
    }
    Ok::<_, String>(None)
  })
  .await
  .map_err(|e| e.to_string())?
}

/// `kingu.agent.statusHooks` turned off: Kingu's entries leave every CLI config it wrote to
/// (the user's own and the active codex account's).
#[tauri::command]
pub async fn agent_status_hooks_remove(app: tauri::AppHandle) -> Result<(), String> {
  let dir = status_dir(&app)?;
  let own = trust::launch_homes(&app, "")?;
  let account = trust::launch_homes(&app, "codex")?;
  tauri::async_runtime::spawn_blocking(move || {
    let _one = trust::WRITING.lock().unwrap_or_else(|e| e.into_inner());
    let script = dir.join("agent-hook.sh");
    let mut errors = Vec::new();
    for a in Agent::ALL {
      let mut files = vec![a.file(&own, copilot_home().as_deref())];
      if a == Agent::Codex {
        files.push(a.file(&account, None));
        files.dedup();
      }
      for f in files {
        if let Err(e) = apply(a, &f, &script, false) {
          errors.push(e);
        }
      }
    }
    if errors.is_empty() { Ok(()) } else { Err(errors.join("; ")) }
  })
  .await
  .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
  use super::*;

  fn homes(home: &Path) -> Homes {
    Homes { home: home.to_path_buf(), claude_config_dir: None, codex_home: None }
  }

  fn json_of(p: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(p).unwrap()).unwrap()
  }

  #[test]
  fn command_and_quoting() {
    let s = Path::new("/Users/a b/Library/Application Support/x/agent-status/agent-hook.sh");
    let c = hook_command(s, Agent::Cursor, "preToolUse", Some(r#"{"permission":"allow"}"#));
    assert_eq!(
      c,
      r#"if [ -f '/Users/a b/Library/Application Support/x/agent-status/agent-hook.sh' ]; then /bin/sh '/Users/a b/Library/Application Support/x/agent-status/agent-hook.sh' cursor preToolUse '{"permission":"allow"}'; else { cat >/dev/null 2>&1 || :; }; printf '%s\n' '{"permission":"allow"}'; fi"#
    );
    assert!(c.contains(MARKER));
    assert_eq!(sh_quote("it's"), r"'it'\''s'");
  }

  #[test]
  fn codex_labels_and_hash() {
    assert_eq!(codex_label("PreToolUse"), "pre_tool_use");
    assert_eq!(codex_label("Stop"), "stop");
    assert_eq!(codex_label("UserPromptSubmit"), "user_prompt_submit");
    // sha256 of {"event_name":"stop","hooks":[{"async":false,"command":"x","timeout":10,"type":"command"}]}
    let h = codex_hash("Stop", "x");
    let want = Sha256::digest(br#"{"event_name":"stop","hooks":[{"async":false,"command":"x","timeout":10,"type":"command"}]}"#);
    assert_eq!(h, format!("sha256:{}", want.iter().map(|b| format!("{b:02x}")).collect::<String>()));
    assert!(codex_hash("Interrupt", "x") != codex_hash("Stop", "x"));
  }

  #[test]
  fn merge_keeps_user_hooks_and_replaces_ours() {
    let mut c: Map<String, Value> = serde_json::from_value(json!({
      "theme": "dark",
      "hooks": {
        "BeforeTool": [{ "hooks": [{ "type": "command", "command": "mine.sh" }, { "type": "command", "command": "/x/agent-status/agent-hook.sh old" }] }],
        "Old": [{ "hooks": [{ "type": "command", "command": "/x/agent-status/agent-hook.sh gone" }] }]
      }
    }))
    .unwrap();
    let placed = merge(&mut c, vec![("BeforeTool".into(), json!({ "hooks": [{ "command": "/y/agent-status/agent-hook.sh new" }] }))]).unwrap();
    assert_eq!(placed, vec![("BeforeTool".into(), 1)]);
    assert_eq!(c["theme"], "dark");
    assert!(c["hooks"].get("Old").is_none());
    assert_eq!(c["hooks"]["BeforeTool"][0]["hooks"], json!([{ "type": "command", "command": "mine.sh" }]));
    assert_eq!(c["hooks"]["BeforeTool"][1]["hooks"][0]["command"], "/y/agent-status/agent-hook.sh new");
    merge(&mut c, vec![]).unwrap();
    assert_eq!(c["hooks"], json!({ "BeforeTool": [{ "hooks": [{ "type": "command", "command": "mine.sh" }] }] }));
    let mut bad: Map<String, Value> = serde_json::from_value(json!({ "hooks": [] })).unwrap();
    assert!(merge(&mut bad, vec![]).is_err());
  }

  #[test]
  fn installs_and_removes_per_cli() {
    let dir = tempfile::tempdir().unwrap();
    let home = fs::canonicalize(dir.path()).unwrap();
    let script = home.join("data/agent-status/agent-hook.sh");
    let h = homes(&home);
    // gemini: merged into an existing settings file.
    let gemini = Agent::Gemini.file(&h, None);
    fs::create_dir_all(gemini.parent().unwrap()).unwrap();
    fs::write(&gemini, r#"{"selectedAuthType":"oauth","hooks":{"AfterAgent":[{"hooks":[{"type":"command","command":"notify-me"}]}]}}"#).unwrap();
    assert!(apply(Agent::Gemini, &gemini, &script, true).unwrap());
    let v = json_of(&gemini);
    assert_eq!(v["selectedAuthType"], "oauth");
    assert_eq!(v["hooks"]["AfterAgent"][0]["hooks"][0]["command"], "notify-me");
    assert_eq!(v["hooks"]["AfterAgent"][1]["hooks"][0]["timeout"], 10000);
    assert!(v["hooks"]["BeforeTool"][0]["hooks"][0]["command"].as_str().unwrap().contains("gemini BeforeTool '{}'"));
    assert!(!apply(Agent::Gemini, &gemini, &script, true).unwrap(), "idempotent");
    assert!(apply(Agent::Gemini, &gemini, &script, false).unwrap());
    assert_eq!(json_of(&gemini), json!({ "selectedAuthType": "oauth", "hooks": { "AfterAgent": [{ "hooks": [{ "type": "command", "command": "notify-me" }] }] } }));
    // cursor: flat definitions and a version.
    let cursor = Agent::Cursor.file(&h, None);
    assert!(apply(Agent::Cursor, &cursor, &script, true).unwrap());
    let v = json_of(&cursor);
    assert_eq!(v["version"], 1);
    assert_eq!(v["hooks"]["stop"][0]["timeout"], 10);
    assert!(v["hooks"]["beforeShellExecution"][0]["command"].as_str().unwrap().ends_with(r#"printf '%s\n' '{"permission":"allow"}'; fi"#));
    // copilot: a file of Kingu's own, gone again on remove.
    let copilot = Agent::Copilot.file(&h, None);
    assert!(copilot.ends_with(".copilot/hooks/kingu-desktop.json"));
    assert!(apply(Agent::Copilot, &copilot, &script, true).unwrap());
    assert_eq!(json_of(&copilot)["hooks"]["Notification"][0]["timeoutSec"], 5);
    assert!(apply(Agent::Copilot, &copilot, &script, false).unwrap());
    assert!(!copilot.exists());
    // droid: tool events with the `*` matcher.
    let droid = Agent::Droid.file(&h, None);
    assert!(apply(Agent::Droid, &droid, &script, true).unwrap());
    let v = json_of(&droid);
    assert_eq!(v["hooks"]["PreToolUse"][0]["matcher"], "*");
    assert!(v["hooks"]["Stop"][0].get("matcher").is_none());
    // A file that does not parse is never touched.
    fs::write(&droid, "{oops").unwrap();
    assert!(apply(Agent::Droid, &droid, &script, true).is_err());
    assert_eq!(fs::read_to_string(&droid).unwrap(), "{oops");
  }

  #[test]
  fn codex_hooks_and_trust_entries() {
    let dir = tempfile::tempdir().unwrap();
    let home = fs::canonicalize(dir.path()).unwrap();
    let codex_home = home.join("acct");
    fs::create_dir_all(&codex_home).unwrap();
    fs::write(codex_home.join("config.toml"), "model = \"o3\"\n\n[hooks.state.\"/u:stop:0:0\"]\nenabled = true\n").unwrap();
    fs::write(codex_home.join("hooks.json"), r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"say done"}]}]}}"#).unwrap();
    let h = Homes { codex_home: Some(codex_home.clone()), ..homes(&home) };
    let script = home.join("data/agent-status/agent-hook.sh");
    let file = Agent::Codex.file(&h, None);
    assert!(apply(Agent::Codex, &file, &script, true).unwrap());
    let v = json_of(&file);
    assert_eq!(v["hooks"]["Stop"][0]["hooks"][0]["command"], "say done", "the user's group keeps index 0 (and its trust)");
    assert_eq!(v["hooks"]["Interrupt"][0]["hooks"][0]["timeout"], 3);
    let toml_text = fs::read_to_string(codex_home.join("config.toml")).unwrap();
    let t: toml::Table = toml::from_str(&toml_text).unwrap();
    let state = t["hooks"]["state"].as_table().unwrap();
    assert!(state.contains_key("/u:stop:0:0"), "user entries stay");
    let stop_key = format!("{}:stop:1:0", codex_home.join("hooks.json").display());
    let cmd = v["hooks"]["Stop"][1]["hooks"][0]["command"].as_str().unwrap();
    assert_eq!(state[&stop_key]["trusted_hash"].as_str().unwrap(), codex_hash("Stop", cmd));
    assert_eq!(state[&format!("{}:pre_tool_use:0:0", codex_home.join("hooks.json").display())]["enabled"].as_bool(), Some(true));
    assert!(!apply(Agent::Codex, &file, &script, true).unwrap(), "idempotent");
    assert!(apply(Agent::Codex, &file, &script, false).unwrap());
    assert_eq!(fs::read_to_string(codex_home.join("config.toml")).unwrap(), "model = \"o3\"\n\n[hooks.state.\"/u:stop:0:0\"]\nenabled = true\n");
    assert_eq!(json_of(&file), json!({ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "say done" }] }] } }));
  }

  #[test]
  fn opencode_overlay() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().join("agent-status");
    let d = opencode_dir(&base, None).unwrap();
    assert_eq!(fs::read_to_string(d.join("plugins").join(OPENCODE_PLUGIN)).unwrap(), OPENCODE_PLUGIN_SOURCE);
    #[cfg(unix)]
    {
      let user = dir.path().join("my-opencode");
      fs::create_dir_all(user.join("plugins")).unwrap();
      fs::write(user.join("opencode.json"), "{}").unwrap();
      fs::write(user.join("plugins/mine.js"), "").unwrap();
      let d = opencode_dir(&base, Some(&user)).unwrap();
      assert!(fs::symlink_metadata(d.join("opencode.json")).unwrap().file_type().is_symlink());
      assert!(fs::symlink_metadata(d.join("plugins/mine.js")).unwrap().file_type().is_symlink());
      assert!(d.join("plugins").join(OPENCODE_PLUGIN).is_file());
      assert_eq!(opencode_dir(&base, Some(&user)).unwrap(), d);
    }
  }

  #[cfg(unix)]
  #[test]
  fn script_appends_tagged_lines_only_to_a_kingu_hook_file() {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("agent-status/agent-hook.sh");
    write_own(&script, SCRIPT, 0o755).unwrap();
    let hooks = dir.path().join("agent-hooks");
    fs::create_dir_all(&hooks).unwrap();
    let file = hooks.join("t.jsonl");
    let run = |env: Option<&Path>, input: &str| {
      use std::io::Write as _;
      let mut cmd = std::process::Command::new("/bin/sh");
      cmd.arg(&script).args(["gemini", "BeforeTool", "{}"]).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped());
      cmd.env_remove("KINGU_AGENT_HOOK_FILE");
      if let Some(f) = env {
        cmd.env("KINGU_AGENT_HOOK_FILE", f);
      }
      let mut child = cmd.spawn().unwrap();
      child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
      String::from_utf8(child.wait_with_output().unwrap().stdout).unwrap()
    };
    assert_eq!(run(Some(&file), "{\n  \"tool_name\": \"run_shell\"\n}"), "{}\n");
    let line: Value = serde_json::from_str(fs::read_to_string(&file).unwrap().trim()).unwrap();
    assert_eq!(line, json!({ "kingu_hook": "gemini", "event": "BeforeTool", "payload": { "tool_name": "run_shell" } }));
    let other = dir.path().join("elsewhere.jsonl");
    assert_eq!(run(Some(&other), "{}"), "{}\n");
    assert!(!other.exists());
    assert_eq!(run(None, "{}"), "{}\n");
  }
}
