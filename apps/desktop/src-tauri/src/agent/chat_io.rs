//! Chat context and chat files (VS Code's chat context sources and chatImportExport.ts):
//!
//! - `chat_context_git_diff`: the working tree's changes where a chat runs, for the "Source
//!   Control" context source (a unified diff against HEAD, then the untracked files), cut to
//!   `MAX_DIFF_BYTES`.
//! - `chat_export`: one chat as a JSON file (its title, model, mode and saved events).
//! - `chat_import`: a file from `chat_export` (or VS Code's own chat export) as a new chat's
//!   transcript. Its sessions are not on this machine, so session ids are dropped: the imported
//!   chat shows its history and its next message starts a new session.

use std::path::Path;

use serde_json::Value;

use crate::i18n::msg::AgentMsg;
use crate::tr;

use super::chats::{self, ChatMeta, PERMISSION_MODES, Transcript};
use super::events::AgentEvent;

/// The diff sent as context is cut here (the prompt inlines it).
pub const MAX_DIFF_BYTES: usize = 48 * 1024;
/// A chat file larger than this is refused.
pub const MAX_IMPORT_BYTES: u64 = 16 * 1024 * 1024;
const FORMAT: &str = "kingu.chat";
const VERSION: u32 = 1;
const MAX_TITLE: usize = 200;

fn cut_to(s: &mut String, max: usize) -> bool {
  if s.len() <= max {
    return false;
  }
  let mut end = max;
  while !s.is_char_boundary(end) {
    end -= 1;
  }
  s.truncate(end);
  true
}

/// `git diff HEAD` (staged and unstaged; `git diff` plus `--cached` before the first commit),
/// then the untracked files' names. Empty when nothing changed.
pub fn git_changes(dir: &Path) -> Result<String, String> {
  let head = crate::git::run(dir, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok();
  let mut diff = if head {
    crate::git::run(dir, &["diff", "HEAD", "--no-color", "--no-ext-diff"])?
  } else {
    let mut d = crate::git::run(dir, &["diff", "--no-color", "--no-ext-diff"])?;
    d.extend(crate::git::run(dir, &["diff", "--cached", "--no-color", "--no-ext-diff"])?);
    d
  };
  let untracked = crate::git::run(dir, &["ls-files", "--others", "--exclude-standard"])?;
  let names = String::from_utf8_lossy(&untracked);
  let names: Vec<&str> = names.lines().filter(|l| !l.is_empty()).take(200).collect();
  if !names.is_empty() {
    diff.extend(format!("\nUntracked files:\n{}\n", names.join("\n")).into_bytes());
  }
  let mut text = String::from_utf8_lossy(&diff).into_owned();
  if cut_to(&mut text, MAX_DIFF_BYTES) {
    text.push_str("\n… (diff cut)\n");
  }
  Ok(text)
}

/// What an imported chat starts with (the webview adds it to chats.json).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ImportedChat {
  pub title: String,
  pub prompt: String,
  pub model: Option<String>,
  pub permission_mode: Option<String>,
  pub created_at: u64,
  pub events: usize,
}

/// The export file of `meta` with its saved `events`.
pub fn export_json(meta: &ChatMeta, events: &[AgentEvent], now: u64) -> Result<String, String> {
  let doc = serde_json::json!({
    "format": FORMAT,
    "version": VERSION,
    "exported_at": now,
    "chat": {
      "title": meta.title,
      "prompt": meta.prompt,
      "model": meta.model,
      "permission_mode": meta.permission_mode,
      "created_at": meta.created_at,
    },
    "events": events,
  });
  serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())
}

/// An event as imported: known shapes only, without the sessions it ran in.
fn imported(v: Value) -> Option<AgentEvent> {
  let mut ev = AgentEvent::from_host(v);
  match &mut ev {
    AgentEvent::Raw { .. } | AgentEvent::Anchor { .. } | AgentEvent::FileSnapshot { .. } => return None,
    AgentEvent::System { session_id, .. } | AgentEvent::Result { session_id, .. } => *session_id = None,
    AgentEvent::Checkpoint { session_id, resume_at, .. } => {
      *session_id = None;
      *resume_at = None;
    }
    _ => {}
  }
  chats::for_transcript(&ev)
}

fn text_of(v: &Value) -> Option<String> {
  v.as_str().map(str::to_string).filter(|s| !s.trim().is_empty())
}

/// VS Code's export (`requests[]` with `message.text` and `response[].value`) as chat events.
fn vscode_events(requests: &[Value]) -> Vec<AgentEvent> {
  let mut out = Vec::new();
  for r in requests {
    let Some(text) = r.pointer("/message/text").and_then(text_of) else { continue };
    out.push(AgentEvent::Message { role: "user".into(), text, parent_tool_use_id: None });
    let answer: Vec<String> = r
      .get("response")
      .and_then(Value::as_array)
      .map(|parts| parts.iter().filter_map(|p| p.get("value").and_then(|v| v.as_str().or_else(|| v.get("value").and_then(Value::as_str)))).map(str::to_string).collect())
      .unwrap_or_default();
    let answer = answer.join("");
    if !answer.trim().is_empty() {
      out.push(AgentEvent::Message { role: "assistant".into(), text: answer, parent_tool_use_id: None });
    }
  }
  out
}

/// A chat file's chat and events (`chat_export`'s, or VS Code's).
pub fn parse_import(text: &str, now: u64) -> Result<(ImportedChat, Vec<AgentEvent>), String> {
  let doc: Value = serde_json::from_str(text).map_err(|e| tr!(AgentMsg::ChatImportBad, error = e))?;
  let (chat, events) = if doc.get("format").and_then(Value::as_str) == Some(FORMAT) {
    let events: Vec<AgentEvent> = doc.get("events").and_then(Value::as_array).map(|a| a.iter().cloned().filter_map(imported).collect()).unwrap_or_default();
    (doc.get("chat").cloned().unwrap_or(Value::Null), events)
  } else if let Some(requests) = doc.get("requests").and_then(Value::as_array) {
    (Value::Null, vscode_events(requests))
  } else {
    return Err(tr!(AgentMsg::ChatImportBad, error = "not a chat export"));
  };
  if !events.iter().any(|e| matches!(e, AgentEvent::Message { role, .. } if role == "user")) {
    return Err(tr!(AgentMsg::ChatImportEmpty));
  }
  let first = events.iter().find_map(|e| match e {
    AgentEvent::Message { role, text, .. } if role == "user" => Some(text.clone()),
    _ => None,
  });
  let mut prompt = chat.get("prompt").and_then(text_of).or(first).unwrap_or_default();
  cut_to(&mut prompt, chats::MAX_PROMPT);
  let mut title = chat.get("title").and_then(text_of).unwrap_or_else(|| prompt.lines().next().unwrap_or("").trim().to_string());
  cut_to(&mut title, MAX_TITLE);
  if title.trim().is_empty() {
    title = "Imported chat".into();
  }
  let model = chat.get("model").and_then(text_of).filter(|m| m.len() <= 128 && m.chars().all(|c| c.is_ascii_graphic()));
  let permission_mode = chat.get("permission_mode").and_then(Value::as_str).filter(|m| PERMISSION_MODES.contains(m)).map(str::to_string);
  let created_at = chat.get("created_at").and_then(Value::as_u64).filter(|&t| t <= now).unwrap_or(now);
  Ok((ImportedChat { title, prompt, model, permission_mode, created_at, events: events.len() }, events))
}

/// Writes `events` as chat `id`'s transcript (refused when it already has one).
pub fn write_import(root: &Path, id: &str, events: &[AgentEvent]) -> Result<(), String> {
  if std::fs::symlink_metadata(chats::transcript_path(root, id)?).is_ok() {
    return Err(tr!(AgentMsg::ForkExists));
  }
  let t = Transcript::new(root, id)?;
  events.iter().try_for_each(|ev| t.append(ev))
}

pub fn read_import(path: &Path) -> Result<String, String> {
  let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
  if !meta.is_file() || meta.len() > MAX_IMPORT_BYTES {
    return Err(tr!(AgentMsg::ChatImportTooBig, path = path.display()));
  }
  std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn meta() -> ChatMeta {
    serde_json::from_value(json!({"id": "c-1", "title": "Fix the build", "prompt": "fix it", "cwd": {"kind": "folder"}, "model": "opus", "permission_mode": "plan", "created_at": 5})).unwrap()
  }

  #[test]
  fn export_round_trips_without_sessions() {
    let events = vec![
      AgentEvent::System { subtype: "init".into(), session_id: Some("s-1".into()), model: Some("m".into()) },
      AgentEvent::Message { role: "user".into(), text: "fix it".into(), parent_tool_use_id: None },
      AgentEvent::Message { role: "assistant".into(), text: "เสร็จแล้ว".into(), parent_tool_use_id: None },
      AgentEvent::Checkpoint { request: 0, session_id: Some("s-1".into()), resume_at: Some("u".into()) },
    ];
    let text = export_json(&meta(), &events, 10).unwrap();
    let (chat, back) = parse_import(&text, 100).unwrap();
    assert_eq!(chat, ImportedChat { title: "Fix the build".into(), prompt: "fix it".into(), model: Some("opus".into()), permission_mode: Some("plan".into()), created_at: 5, events: 4 });
    assert_eq!(back[0], AgentEvent::System { subtype: "init".into(), session_id: None, model: Some("m".into()) });
    assert_eq!(back[3], AgentEvent::Checkpoint { request: 0, session_id: None, resume_at: None });
    assert_eq!(back[2], events[2]);
  }

  #[test]
  fn imports_vscode_exports_and_refuses_others() {
    let doc = json!({"requesterUsername": "me", "requests": [
      {"message": {"text": "explain this"}, "response": [{"value": "It "}, {"value": "works."}]},
      {"message": {"text": ""}, "response": []}
    ]});
    let (chat, events) = parse_import(&doc.to_string(), 7).unwrap();
    assert_eq!(chat.title, "explain this");
    assert_eq!(chat.created_at, 7);
    assert_eq!(chat.permission_mode, None);
    assert_eq!(events, vec![
      AgentEvent::Message { role: "user".into(), text: "explain this".into(), parent_tool_use_id: None },
      AgentEvent::Message { role: "assistant".into(), text: "It works.".into(), parent_tool_use_id: None },
    ]);
    assert!(parse_import("{}", 1).is_err());
    assert!(parse_import("nope", 1).is_err());
    assert!(parse_import(&json!({"format": FORMAT, "events": [{"kind": "message", "role": "assistant", "text": "x"}]}).to_string(), 1).is_err());
  }

  #[test]
  fn import_drops_bad_fields() {
    let doc = json!({"format": FORMAT, "chat": {"model": "bad model", "permission_mode": "bypassPermissions", "created_at": 999}, "events": [
      {"kind": "message", "role": "user", "text": "hi"}, {"kind": "anchor", "uuid": "u"}, {"kind": "what"}
    ]});
    let (chat, events) = parse_import(&doc.to_string(), 10).unwrap();
    assert_eq!((chat.model, chat.permission_mode, chat.created_at, events.len()), (None, None, 10, 1));
  }

  #[test]
  fn writes_the_transcript_once() {
    let dir = tempfile::tempdir().unwrap();
    let events = vec![AgentEvent::Message { role: "user".into(), text: "hi".into(), parent_tool_use_id: None }];
    write_import(dir.path(), "c-2", &events).unwrap();
    assert_eq!(chats::load_transcript(dir.path(), "c-2").unwrap(), events);
    assert!(write_import(dir.path(), "c-2", &events).is_err());
  }

  #[test]
  fn diff_lists_changes_and_untracked_files() {
    let dir = tempfile::tempdir().unwrap();
    let git = |args: &[&str]| assert!(std::process::Command::new("git").arg("-C").arg(dir.path()).args(args).output().unwrap().status.success());
    git(&["init", "-q"]);
    assert_eq!(git_changes(dir.path()).unwrap(), "");
    std::fs::write(dir.path().join("a.txt"), "one\n").unwrap();
    git(&["add", "a.txt"]);
    std::fs::write(dir.path().join("b.txt"), "new\n").unwrap();
    let text = git_changes(dir.path()).unwrap();
    assert!(text.contains("+one"), "{text}");
    assert!(text.contains("Untracked files:\nb.txt"), "{text}");
  }
}
