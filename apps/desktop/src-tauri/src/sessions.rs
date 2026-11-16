//! Claude Code's own session history for the open folder and its worktrees (Orca's Agents tab):
//! the transcripts under `~/.claude/projects/<encoded path>/<session id>.jsonl`, read locally to
//! show a title, the latest message, counts and times. Nothing is sent anywhere.

use serde_json::Value;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Session {
  pub id: String,
  pub title: String,
  /// The latest assistant (or user) text, shortened.
  pub preview: Option<String>,
  pub cwd: Option<String>,
  pub branch: Option<String>,
  pub model: Option<String>,
  pub messages: u32,
  /// Unix ms.
  pub created: i64,
  pub updated: i64,
  pub path: String,
  /// `claude`, `codex` or `gemini` (Orca's session history covers many CLIs).
  pub agent: &'static str,
}

/// Claude Code's folder name for a working directory: every `/` and `.` becomes `-`.
pub fn encode(dir: &Path) -> String {
  dir.to_string_lossy().chars().map(|c| if c == '/' || c == '.' { '-' } else { c }).collect()
}

fn text_of(content: &Value) -> Option<String> {
  match content {
    Value::String(s) => Some(s.clone()),
    Value::Array(parts) => {
      let t: Vec<&str> = parts.iter().filter(|p| p.get("type").and_then(Value::as_str) == Some("text")).filter_map(|p| p.get("text").and_then(Value::as_str)).collect();
      if t.is_empty() { None } else { Some(t.join(" ")) }
    }
    _ => None,
  }
}

fn short(s: &str, n: usize) -> String {
  let one = s.split_whitespace().collect::<Vec<_>>().join(" ");
  if one.chars().count() > n { format!("{}…", one.chars().take(n).collect::<String>()) } else { one }
}

fn time_of(v: &Value) -> Option<i64> {
  let t = v.get("timestamp")?.as_str()?;
  // `2026-10-18T07:54:44.123Z`: seconds precision is enough for sorting and "5m ago".
  let (date, rest) = t.split_once('T')?;
  let mut d = date.split('-').map(|p| p.parse::<i64>().ok());
  let (y, m, day) = (d.next()??, d.next()??, d.next()??);
  let mut hms = rest.trim_end_matches('Z').split(':');
  let (hh, mm) = (hms.next()?.parse::<i64>().ok()?, hms.next()?.parse::<i64>().ok()?);
  let ss = hms.next().and_then(|x| x.parse::<f64>().ok()).unwrap_or(0.0) as i64;
  let (y2, m2) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
  let era = y2.div_euclid(400);
  let yoe = y2 - era * 400;
  let doy = (153 * m2 + 2) / 5 + day - 1;
  let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
  Some((days * 86_400 + hh * 3600 + mm * 60 + ss) * 1000)
}

/// Reads one transcript: the head for the title and start, the tail for the latest message.
pub fn read_session(path: &Path) -> Option<Session> {
  let id = path.file_stem()?.to_string_lossy().into_owned();
  let mut file = std::fs::File::open(path).ok()?;
  let len = file.metadata().ok()?.len();
  // Bytes, decoded lossily: a seek can land inside a multi-byte character (Thai, emoji).
  let mut head_bytes = Vec::new();
  (&mut file).take(256 * 1024).read_to_end(&mut head_bytes).ok();
  let head = String::from_utf8_lossy(&head_bytes).into_owned();
  let tail_from = len.saturating_sub(1024 * 1024);
  let tail = if tail_from > 0 {
    file.seek(SeekFrom::Start(tail_from)).ok()?;
    let mut tail_bytes = Vec::new();
    file.take(1024 * 1024).read_to_end(&mut tail_bytes).ok();
    String::from_utf8_lossy(&tail_bytes).into_owned()
  } else {
    head.clone()
  };
  let mut s = Session { id, title: String::new(), preview: None, cwd: None, branch: None, model: None, messages: 0, created: 0, updated: 0, path: path.display().to_string(), agent: "claude" };
  let mut summary: Option<String> = None;
  for line in head.lines() {
    let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
    let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
    if kind == "summary" || kind == "custom-title" {
      summary = v.get("summary").or_else(|| v.get("customTitle")).and_then(Value::as_str).map(str::to_owned).or(summary);
    }
    if s.created == 0
      && let Some(t) = time_of(&v)
    {
      s.created = t;
    }
    if s.cwd.is_none() {
      s.cwd = v.get("cwd").and_then(Value::as_str).map(str::to_owned);
      s.branch = v.get("gitBranch").and_then(Value::as_str).map(str::to_owned);
    }
    if s.title.is_empty()
      && kind == "user"
      && v.get("isSidechain").and_then(Value::as_bool) != Some(true)
      && let Some(t) = v.get("message").and_then(|m| m.get("content")).and_then(text_of)
      && !t.starts_with('<')
    {
      s.title = short(&t, 120);
    }
  }
  // Message count: every user/assistant record in the whole file (a cheap line scan).
  if let Ok(all) = std::fs::read(path) {
    s.messages = String::from_utf8_lossy(&all).lines().filter(|l| l.contains("\"type\":\"user\"") || l.contains("\"type\":\"assistant\"")).count() as u32;
  }
  for line in tail.lines() {
    let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
    if let Some(t) = time_of(&v) {
      s.updated = s.updated.max(t);
    }
    let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
    if (kind == "assistant" || kind == "user")
      && let Some(msg) = v.get("message")
    {
      if let Some(m) = msg.get("model").and_then(Value::as_str) {
        s.model = Some(m.to_owned());
      }
      if let Some(t) = msg.get("content").and_then(text_of)
        && !t.starts_with('<')
      {
        s.preview = Some(short(&format!("{}: {t}", if kind == "assistant" { "Agent" } else { "You" }), 240));
      }
    }
  }
  if let Some(t) = summary {
    s.title = short(&t, 120);
  }
  if s.title.is_empty() {
    s.title = "Untitled session".into();
  }
  if s.updated == 0 {
    s.updated = s.created;
  }
  Some(s)
}

/// Sessions whose working directory is `root` or a folder inside it (task worktrees included),
/// newest first.
pub fn list(root: &Path, limit: usize) -> Vec<Session> {
  let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else { return Vec::new() };
  let base = home.join(".claude").join("projects");
  let prefix = encode(root);
  let Ok(dirs) = std::fs::read_dir(&base) else { return Vec::new() };
  let mut files: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
  for d in dirs.flatten() {
    let name = d.file_name().to_string_lossy().into_owned();
    if name != prefix && !name.starts_with(&format!("{prefix}-")) {
      continue;
    }
    for f in std::fs::read_dir(d.path()).into_iter().flatten().flatten() {
      let p = f.path();
      if p.extension().and_then(|e| e.to_str()) == Some("jsonl") {
        files.push((f.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH), p));
      }
    }
  }
  files.sort_by_key(|f| std::cmp::Reverse(f.0));
  files.into_iter().take(limit).filter_map(|(_, p)| read_session(&p)).collect()
}

// ---- Codex and Gemini (Orca ai-vault scanners: codex rollouts, gemini chats) ----------------

/// `root` itself or a folder inside it (a task worktree is under `<root>/.kingu/worktrees`).
fn inside(root: &Path, cwd: &str) -> bool {
  let c = Path::new(cwd);
  c == root || c.starts_with(root)
}

/// Codex's user text that is not one of its own context blocks (`<environment_context>`, …).
fn user_text(s: &str) -> Option<&str> {
  let t = s.trim();
  (!t.is_empty() && !t.starts_with('<')).then_some(t)
}

fn codex_text(content: &Value) -> Option<String> {
  let parts = content.as_array()?;
  let t: Vec<&str> = parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect();
  if t.is_empty() { None } else { Some(t.join(" ")) }
}

/// One codex rollout (`rollout-<time>-<id>.jsonl`): `session_meta` gives the id and folder, the
/// first real user message the title, the last message the preview.
pub fn read_codex(path: &Path) -> Option<Session> {
  let text = std::fs::read(path).ok()?;
  let text = String::from_utf8_lossy(&text);
  let mut s = Session { id: String::new(), title: String::new(), preview: None, cwd: None, branch: None, model: None, messages: 0, created: 0, updated: 0, path: path.display().to_string(), agent: "codex" };
  for line in text.lines() {
    let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
    if let Some(t) = time_of(&v) {
      if s.created == 0 {
        s.created = t;
      }
      s.updated = s.updated.max(t);
    }
    let p = v.get("payload").unwrap_or(&Value::Null);
    match v.get("type").and_then(Value::as_str).unwrap_or("") {
      "session_meta" => {
        s.id = p.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
        s.cwd = p.get("cwd").and_then(Value::as_str).map(str::to_owned);
        s.branch = p.get("git").and_then(|g| g.get("branch")).and_then(Value::as_str).map(str::to_owned);
        if let Some(t) = p.get("title").or_else(|| p.get("thread_name")).and_then(Value::as_str).filter(|t| !t.trim().is_empty()) {
          s.title = short(t, 120);
        }
      }
      "turn_context" => s.model = p.get("model").and_then(Value::as_str).map(str::to_owned).or(s.model.take()),
      "response_item" if p.get("type").and_then(Value::as_str) == Some("message") => {
        let role = p.get("role").and_then(Value::as_str).unwrap_or("");
        let Some(t) = p.get("content").and_then(codex_text) else { continue };
        let Some(t) = user_text(&t) else { continue };
        if role == "user" || role == "assistant" {
          s.messages += 1;
          if role == "user" && s.title.is_empty() {
            s.title = short(t, 120);
          }
          s.preview = Some(short(&format!("{}: {t}", if role == "assistant" { "Agent" } else { "You" }), 240));
        }
      }
      _ => {}
    }
  }
  if s.id.is_empty() {
    return None;
  }
  if s.title.is_empty() {
    s.title = "Untitled session".into();
  }
  Some(s)
}

/// Codex sessions run in `root` or its worktrees, newest first (`$CODEX_HOME/sessions/YYYY/MM/DD`).
pub fn list_codex(root: &Path, codex_home: &Path, limit: usize) -> Vec<Session> {
  let mut files: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
  let mut stack = vec![codex_home.join("sessions")];
  while let Some(dir) = stack.pop() {
    for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
      let p = e.path();
      if p.is_dir() {
        stack.push(p);
      } else if p.extension().and_then(|x| x.to_str()) == Some("jsonl") && p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("rollout-")) {
        files.push((e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH), p));
      }
    }
  }
  files.sort_by_key(|f| std::cmp::Reverse(f.0));
  // Read newest first until `limit` of this folder's are found (at most 4× limit files opened).
  files.into_iter().take(limit.saturating_mul(4)).filter_map(|(_, p)| read_codex(&p)).filter(|s| s.cwd.as_deref().is_some_and(|c| inside(root, c))).take(limit).collect()
}

/// Gemini keys a project's chats by the SHA-256 of its path (`~/.gemini/tmp/<hash>/chats`).
pub fn gemini_hash(dir: &Path) -> String {
  use sha2::{Digest, Sha256};
  Sha256::digest(dir.to_string_lossy().as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// One gemini chat (`session-*.json`): `sessionId`, `startTime`, `lastUpdated`, `messages`.
pub fn read_gemini(path: &Path, cwd: &Path) -> Option<Session> {
  let v: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
  let id = v.get("sessionId").and_then(Value::as_str)?.to_owned();
  let at = |k: &str| time_of(&serde_json::json!({ "timestamp": v.get(k).and_then(Value::as_str).unwrap_or("") }));
  let msgs = v.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
  let text = |m: &Value| m.get("content").and_then(|c| c.as_str().map(str::to_owned).or_else(|| text_of(c)).or_else(|| codex_text(c)));
  let user = |m: &&Value| m.get("type").and_then(Value::as_str) == Some("user");
  let title = msgs.iter().filter(user).find_map(|m| text(m).filter(|t| user_text(t).is_some())).map(|t| short(&t, 120));
  let last = msgs.iter().rev().find_map(|m| text(m).filter(|t| !t.trim().is_empty()).map(|t| (user(&m), t)));
  let created = at("startTime").unwrap_or(0);
  Some(Session {
    id,
    title: title.unwrap_or_else(|| "Untitled session".into()),
    preview: last.map(|(u, t)| short(&format!("{}: {t}", if u { "You" } else { "Agent" }), 240)),
    cwd: Some(cwd.display().to_string()),
    branch: None,
    model: v.get("model").and_then(Value::as_str).map(str::to_owned),
    messages: msgs.iter().filter(|m| matches!(m.get("type").and_then(Value::as_str), Some("user" | "gemini"))).count() as u32,
    created,
    updated: at("lastUpdated").unwrap_or(created),
    path: path.display().to_string(),
    agent: "gemini",
  })
}

/// Gemini chats of `dirs` (the folder and each task worktree), newest first.
pub fn list_gemini(gemini_tmp: &Path, dirs: &[PathBuf], limit: usize) -> Vec<Session> {
  let mut out: Vec<Session> = dirs
    .iter()
    .flat_map(|d| {
      let chats = gemini_tmp.join(gemini_hash(d)).join("chats");
      std::fs::read_dir(&chats).into_iter().flatten().flatten().filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json")).filter_map(|e| read_gemini(&e.path(), d)).collect::<Vec<_>>()
    })
    .collect();
  out.sort_by_key(|s| std::cmp::Reverse(s.updated));
  out.truncate(limit);
  out
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn encodes_like_claude_code() {
    assert_eq!(encode(Path::new("/Users/a/Kingu/.kingu/worktrees/fix")), "-Users-a-Kingu--kingu-worktrees-fix");
  }

  #[test]
  fn reads_a_transcript() {
    let dir = std::env::temp_dir().join(format!("kingu-sessions-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("abc.jsonl");
    std::fs::write(
      &p,
      concat!(
        "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"Fix the login bug\"},\"cwd\":\"/w\",\"gitBranch\":\"main\",\"timestamp\":\"2026-10-18T07:00:00.000Z\"}\n",
        "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-x\",\"content\":[{\"type\":\"text\",\"text\":\"Done.\"}]},\"timestamp\":\"2026-10-18T07:05:00.000Z\"}\n"
      ),
    )
    .unwrap();
    let s = read_session(&p).unwrap();
    assert_eq!((s.id.as_str(), s.title.as_str(), s.model.as_deref()), ("abc", "Fix the login bug", Some("claude-x")));
    assert_eq!(s.preview.as_deref(), Some("Agent: Done."));
    assert_eq!(s.updated - s.created, 300_000);
    assert_eq!(s.messages, 2);
    std::fs::remove_dir_all(&dir).unwrap();
  }

  #[test]
  fn reads_codex_rollouts_of_this_folder_only() {
    let dir = tempfile::tempdir().unwrap();
    let day = dir.path().join("sessions/2026/11/13");
    std::fs::create_dir_all(&day).unwrap();
    let rollout = |name: &str, cwd: &str| {
      std::fs::write(
        day.join(name),
        format!(
          "{}\n{}\n{}\n{}\n",
          serde_json::json!({ "timestamp": "2026-11-13T10:00:00.000Z", "type": "session_meta", "payload": { "id": format!("id-{name}"), "cwd": cwd, "git": { "branch": "kingu/fix" } } }),
          serde_json::json!({ "timestamp": "2026-11-13T10:00:01.000Z", "type": "response_item", "payload": { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "<environment_context>x</environment_context>" }] } }),
          serde_json::json!({ "timestamp": "2026-11-13T10:00:02.000Z", "type": "response_item", "payload": { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "Fix the login race" }] } }),
          serde_json::json!({ "timestamp": "2026-11-13T10:05:00.000Z", "type": "response_item", "payload": { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "Fixed it." }] } }),
        ),
      )
      .unwrap();
    };
    rollout("rollout-a.jsonl", "/repo/.kingu/worktrees/fix");
    rollout("rollout-b.jsonl", "/elsewhere");
    let list = list_codex(Path::new("/repo"), dir.path(), 10);
    assert_eq!(list.len(), 1);
    let s = &list[0];
    assert_eq!((s.id.as_str(), s.title.as_str(), s.agent, s.messages), ("id-rollout-a.jsonl", "Fix the login race", "codex", 2));
    assert_eq!(s.preview.as_deref(), Some("Agent: Fixed it."));
    assert_eq!(s.branch.as_deref(), Some("kingu/fix"));
    assert_eq!(s.updated - s.created, 300_000);
  }

  #[test]
  fn reads_gemini_chats_by_project_hash() {
    let dir = tempfile::tempdir().unwrap();
    let repo = PathBuf::from("/repo");
    let chats = dir.path().join(gemini_hash(&repo)).join("chats");
    std::fs::create_dir_all(&chats).unwrap();
    std::fs::write(
      chats.join("session-1.json"),
      serde_json::json!({ "sessionId": "g1", "startTime": "2026-11-13T09:00:00.000Z", "lastUpdated": "2026-11-13T09:01:00.000Z", "messages": [{ "type": "user", "content": "Add search" }, { "type": "gemini", "content": "Added." }] }).to_string(),
    )
    .unwrap();
    let list = list_gemini(dir.path(), &[repo.clone(), PathBuf::from("/other")], 10);
    assert_eq!(list.len(), 1);
    assert_eq!((list[0].id.as_str(), list[0].title.as_str(), list[0].agent, list[0].messages), ("g1", "Add search", "gemini", 2));
    assert_eq!(list[0].preview.as_deref(), Some("Agent: Added."));
    assert_eq!(gemini_hash(&repo).len(), 64);
  }
}
