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
  let mut s = Session { id, title: String::new(), preview: None, cwd: None, branch: None, model: None, messages: 0, created: 0, updated: 0, path: path.display().to_string() };
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
}
