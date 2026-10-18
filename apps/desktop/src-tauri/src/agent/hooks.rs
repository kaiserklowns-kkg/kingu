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

/// `--settings` JSON with a command hook per event that appends the payload to `file`.
pub fn settings_json(file: &Path) -> Result<String, String> {
  let path = quotable_path(file)?;
  let command = format!("{{ cat; echo; }} >> '{path}'");
  let entry = serde_json::json!([{ "hooks": [{ "type": "command", "command": command }] }]);
  let hooks: serde_json::Map<String, serde_json::Value> = EVENTS.iter().map(|e| (e.to_string(), entry.clone())).collect();
  Ok(serde_json::json!({ "hooks": hooks }).to_string())
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

fn file_of(app: &AppHandle, token: &str) -> Result<PathBuf, String> {
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

/// The `--settings` JSON for a new claude session.
#[tauri::command]
pub fn agent_hook_settings(app: AppHandle, token: String) -> Result<String, String> {
  settings_json(&fresh_file(&app, &token)?)
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

/// The session ended or its task was removed.
#[tauri::command]
pub fn agent_hook_clear(app: AppHandle, token: String) -> Result<(), String> {
  let file = file_of(&app, &token)?;
  match std::fs::remove_file(&file) {
    Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
    _ => Ok(()),
  }
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
    let json: serde_json::Value = serde_json::from_str(&settings_json(Path::new("/c/agent-hooks/t.jsonl")).unwrap()).unwrap();
    for e in EVENTS {
      assert_eq!(json["hooks"][e][0]["hooks"][0]["command"], "{ cat; echo; } >> '/c/agent-hooks/t.jsonl'");
    }
    assert!(settings_json(Path::new("/it's/t.jsonl")).is_err());
    assert_eq!(quotable_path(Path::new("/c/agent-hooks/t.jsonl")).unwrap(), "/c/agent-hooks/t.jsonl");
    assert!(quotable_path(Path::new("/c/a\nb.jsonl")).is_err());
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
}
