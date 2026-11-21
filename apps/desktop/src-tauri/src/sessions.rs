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
  /// `claude`, `codex`, `gemini`, `opencode`, `copilot`, `cursor`, `qoder`, `codebuddy`, `droid`, `kiro`, `cline`, `kimi` or `devin` (Orca's session history covers many CLIs).
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

// ---- GitHub Copilot CLI (Orca ai-vault scanners/copilot) -------------------------------------

/// One Copilot CLI session (`$COPILOT_HOME/session-state/…/<id>.jsonl`, Orca
/// `parseCopilotSessionFile`): `session.start` gives the id, folder and branch, `user.message` /
/// `assistant.message` the counts, title and preview, `session.model_change` the model.
pub fn read_copilot(path: &Path) -> Option<Session> {
  let text = std::fs::read(path).ok()?;
  let text = String::from_utf8_lossy(&text);
  let stem = path.file_stem()?.to_string_lossy().into_owned();
  let mut s = Session { id: stem, title: String::new(), preview: None, cwd: None, branch: None, model: None, messages: 0, created: 0, updated: 0, path: path.display().to_string(), agent: "copilot" };
  for line in text.lines() {
    let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
    if let Some(t) = time_of(&v) {
      if s.created == 0 {
        s.created = t;
      }
      s.updated = s.updated.max(t);
    }
    let d = v.get("data").unwrap_or(&Value::Null);
    let str_of = |k: &str| d.get(k).and_then(Value::as_str).map(str::trim).filter(|x| !x.is_empty()).map(str::to_owned);
    match v.get("type").and_then(Value::as_str).unwrap_or("") {
      "session.start" => {
        if let Some(id) = str_of("sessionId") {
          s.id = id;
        }
        let c = d.get("context").unwrap_or(&Value::Null);
        let ctx = |k: &str| c.get(k).and_then(Value::as_str).filter(|x| !x.is_empty()).map(str::to_owned);
        s.cwd = s.cwd.take().or_else(|| ctx("cwd")).or_else(|| ctx("gitRoot"));
        s.branch = s.branch.take().or_else(|| ctx("branch"));
      }
      "session.model_change" => s.model = str_of("newModel").or(s.model.take()),
      // Folder-trust notices name the folder when session.start did not (Orca `extractTrustedFolder`).
      "session.info" => {
        if s.cwd.is_none() {
          s.cwd = str_of("message").and_then(|m| m.strip_prefix("Folder ").and_then(|r| r.strip_suffix(" has been added to trusted folders.")).map(str::to_owned));
        }
      }
      "user.message" => {
        s.messages += 1;
        // `transformedContent` is the prompt plus the context Copilot adds; the typed prompt comes first.
        if let Some(t) = str_of("content").or_else(|| str_of("transformedContent")) {
          if s.title.is_empty() {
            s.title = short(&t, 120);
          }
          s.preview = Some(short(&format!("You: {t}"), 240));
        }
      }
      "assistant.message" => {
        s.messages += 1;
        if let Some(t) = str_of("content") {
          s.preview = Some(short(&format!("Agent: {t}"), 240));
        }
      }
      "session.shutdown" => s.model = str_of("currentModel").or(s.model.take()),
      _ => {}
    }
  }
  if s.messages == 0 {
    return None;
  }
  if s.title.is_empty() {
    s.title = "Untitled session".into();
  }
  Some(s)
}

/// Copilot CLI sessions run in `root` or its worktrees, newest first (`session_state` is
/// `$COPILOT_HOME/session-state`, `~/.copilot/session-state` by default; Orca reads it recursively).
pub fn list_copilot(root: &Path, session_state: &Path, limit: usize) -> Vec<Session> {
  let mut files: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
  let mut stack = vec![(session_state.to_path_buf(), 0usize)];
  while let Some((dir, depth)) = stack.pop() {
    for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
      let p = e.path();
      let Ok(ft) = e.file_type() else { continue };
      if ft.is_dir() && depth < 4 {
        stack.push((p, depth + 1));
      } else if ft.is_file() && p.extension().and_then(|x| x.to_str()) == Some("jsonl") {
        files.push((e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH), p));
      }
    }
  }
  files.sort_by_key(|f| std::cmp::Reverse(f.0));
  files.into_iter().take(limit.saturating_mul(4)).filter_map(|(_, p)| read_copilot(&p)).filter(|s| s.cwd.as_deref().is_some_and(|c| inside(root, c))).take(limit).collect()
}

// ---- Cursor agent CLI (Orca ai-vault scanners/cursor) ------------------------------------------

/// A Cursor chat's `meta.json` (`~/.cursor/chats/<workspace>/<chat id>/meta.json`, Orca
/// `readCursorChatMeta`): its title, folder and times; the transcript does not carry the folder.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct CursorMeta {
  pub title: String,
  pub cwd: Option<String>,
  pub created: i64,
  pub updated: i64,
}

/// Every chat's meta by chat id (Orca `buildCursorChatMetaIndex`: the first workspace folder that has the chat wins).
pub fn cursor_meta_index(chats: &Path) -> std::collections::HashMap<String, CursorMeta> {
  let mut out = std::collections::HashMap::new();
  let mut workspaces: Vec<PathBuf> = std::fs::read_dir(chats).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
  workspaces.sort();
  for ws in workspaces {
    for chat in std::fs::read_dir(&ws).into_iter().flatten().flatten() {
      let id = chat.file_name().to_string_lossy().into_owned();
      if out.contains_key(&id) || !chat.path().is_dir() {
        continue;
      }
      let Ok(bytes) = std::fs::read(chat.path().join("meta.json")) else { continue };
      let Ok(v) = serde_json::from_slice::<Value>(&bytes) else { continue };
      let ms = |k: &str| v.get(k).and_then(Value::as_f64).filter(|x| *x > 0.0).map_or(0, |x| x as i64);
      out.insert(
        id,
        CursorMeta {
          title: v.get("title").and_then(Value::as_str).map(str::trim).unwrap_or_default().to_owned(),
          cwd: v.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty()).map(str::to_owned),
          created: ms("createdAtMs"),
          updated: ms("updatedAtMs"),
        },
      );
    }
  }
  out
}

/// A message's text (`message.content` or `content`: a string, or parts with `text`).
fn cursor_text(v: &Value) -> Option<String> {
  let c = v.get("message").and_then(|m| m.get("content")).or_else(|| v.get("content"))?;
  let t = c.as_str().map(str::to_owned).or_else(|| codex_text(c))?;
  let t = t.trim();
  (!t.is_empty()).then(|| t.to_owned())
}

/// One transcript (`…/agent-transcripts/<chat id>/<session>.jsonl`, Orca `parseCursorSessionFile`):
/// `role` user / assistant lines; the session id is the file's trailing UUID, else its name.
pub fn read_cursor(path: &Path, meta: Option<&CursorMeta>) -> Option<Session> {
  let text = std::fs::read(path).ok()?;
  let text = String::from_utf8_lossy(&text);
  let stem = path.file_stem()?.to_string_lossy().into_owned();
  let id = if stem.len() >= 36 && stem.is_char_boundary(stem.len() - 36) && crate::accounts::managed::is_uuid(&stem[stem.len() - 36..]) { stem[stem.len() - 36..].to_owned() } else { stem };
  let mut s = Session { id, title: String::new(), preview: None, cwd: meta.and_then(|m| m.cwd.clone()), branch: None, model: None, messages: 0, created: 0, updated: 0, path: path.display().to_string(), agent: "cursor" };
  for line in text.lines() {
    let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
    if let Some(t) = time_of(&v) {
      if s.created == 0 {
        s.created = t;
      }
      s.updated = s.updated.max(t);
    }
    let role = v.get("role").and_then(Value::as_str).unwrap_or("");
    if role != "user" && role != "assistant" {
      continue;
    }
    s.messages += 1;
    if let Some(t) = cursor_text(&v) {
      if role == "user" && s.title.is_empty() {
        s.title = short(&t, 120);
      }
      s.preview = Some(short(&format!("{}: {t}", if role == "user" { "You" } else { "Agent" }), 240));
    }
  }
  if s.messages == 0 {
    return None;
  }
  if let Some(m) = meta {
    if !m.title.is_empty() {
      s.title = short(&m.title, 120);
    }
    if m.created > 0 {
      s.created = m.created;
    }
    s.updated = s.updated.max(m.updated);
  }
  if s.title.is_empty() {
    s.title = "Untitled session".into();
  }
  Some(s)
}

/// Cursor sessions run in `root` or its worktrees, newest first (`cursor_home`: `~/.cursor`). A
/// transcript whose chat has no meta.json names no folder, so it is left out.
pub fn list_cursor(root: &Path, cursor_home: &Path, limit: usize) -> Vec<Session> {
  let meta = cursor_meta_index(&cursor_home.join("chats"));
  let mut files: Vec<(std::time::SystemTime, PathBuf, String)> = Vec::new();
  for project in std::fs::read_dir(cursor_home.join("projects")).into_iter().flatten().flatten() {
    for chat in std::fs::read_dir(project.path().join("agent-transcripts")).into_iter().flatten().flatten() {
      let chat_id = chat.file_name().to_string_lossy().into_owned();
      let in_scope = meta.get(&chat_id).and_then(|m| m.cwd.as_deref()).is_some_and(|c| inside(root, c));
      if !in_scope || !chat.path().is_dir() {
        continue;
      }
      for f in std::fs::read_dir(chat.path()).into_iter().flatten().flatten() {
        let p = f.path();
        if p.extension().and_then(|x| x.to_str()) == Some("jsonl") {
          files.push((f.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH), p, chat_id.clone()));
        }
      }
    }
  }
  files.sort_by_key(|f| std::cmp::Reverse(f.0));
  let mut out: Vec<Session> = files.into_iter().take(limit.saturating_mul(4)).filter_map(|(_, p, chat)| read_cursor(&p, meta.get(&chat))).collect();
  out.sort_by_key(|s| std::cmp::Reverse(s.updated));
  out.truncate(limit);
  out
}

// ---- Qoder, CodeBuddy and Factory Droid (Orca ai-vault scanners/qoder, codebuddy, droid) -----

/// `.jsonl` files under `dir` (at most `depth` folders down), newest first.
fn jsonl_files(dir: &Path, depth: usize) -> Vec<PathBuf> {
  let mut files: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
  let mut stack = vec![(dir.to_path_buf(), 0usize)];
  while let Some((d, level)) = stack.pop() {
    for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
      let p = e.path();
      let Ok(ft) = e.file_type() else { continue };
      if ft.is_dir() && level < depth {
        stack.push((p, level + 1));
      } else if ft.is_file() && p.extension().and_then(|x| x.to_str()) == Some("jsonl") {
        files.push((e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH), p));
      }
    }
  }
  files.sort_by_key(|f| std::cmp::Reverse(f.0));
  files.into_iter().map(|(_, p)| p).collect()
}

/// The newest `limit` sessions `read` makes of the files under `dirs` that ran in `root`.
fn newest_in(root: &Path, dirs: &[PathBuf], depth: usize, limit: usize, read: impl Fn(&Path) -> Option<Session>) -> Vec<Session> {
  let mut files: Vec<PathBuf> = dirs.iter().flat_map(|d| jsonl_files(d, depth)).collect();
  files.dedup();
  let mut out: Vec<Session> = files.into_iter().take(limit.saturating_mul(4)).filter_map(|p| read(&p)).filter(|s| s.cwd.as_deref().is_some_and(|c| inside(root, c))).collect();
  out.sort_by_key(|s| std::cmp::Reverse(s.updated));
  out.truncate(limit);
  out
}

/// Qoder shares Claude Code's transcript format, with startup records of its own (Orca
/// `consumeQoderLine`): `workspace-directories` names the folder, `runtime-config` the model.
pub fn read_qoder(path: &Path) -> Option<Session> {
  let mut s = read_session(path)?;
  s.agent = "qoder";
  if s.cwd.is_none() || s.model.is_none() {
    let text = String::from_utf8_lossy(&std::fs::read(path).ok()?).into_owned();
    for line in text.lines().take(200) {
      let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
      match v.get("type").and_then(Value::as_str) {
        Some("workspace-directories") if s.cwd.is_none() => s.cwd = v.get("directories").and_then(|d| d.get(0)).and_then(Value::as_str).map(str::to_owned),
        Some("runtime-config") if s.model.is_none() => s.model = v.get("model").and_then(Value::as_str).map(str::to_owned),
        _ => {}
      }
    }
  }
  (s.messages > 0).then_some(s)
}

/// Qoder sessions of `root` (`~/.qoder/projects/<project>/<id>.jsonl`).
pub fn list_qoder(root: &Path, projects: &Path, limit: usize) -> Vec<Session> {
  newest_in(root, &[projects.to_path_buf()], 1, limit, read_qoder)
}

/// CodeBuddy's message text: a string, or `text` / `input_text` / `output_text` parts (Orca `codebuddyContentText`).
fn codebuddy_text(c: &Value) -> Option<String> {
  let t = match c {
    Value::String(s) => s.clone(),
    Value::Array(parts) => parts
      .iter()
      .filter(|p| matches!(p.get("type").and_then(Value::as_str), Some("text" | "input_text" | "output_text")))
      .filter_map(|p| p.get("text").and_then(Value::as_str))
      .collect::<Vec<_>>()
      .join(" "),
    _ => return None,
  };
  let t = t.trim();
  (!t.is_empty()).then(|| t.to_owned())
}

/// One CodeBuddy session (`~/.codebuddy/projects/…/<id>.jsonl`, Orca `consumeCodebuddySessionLine`):
/// `message` records with a role, a `summary` or `ai-title` for the title, the first `cwd` seen.
pub fn read_codebuddy(path: &Path) -> Option<Session> {
  let text = String::from_utf8_lossy(&std::fs::read(path).ok()?).into_owned();
  let mut s = Session { id: path.file_stem()?.to_string_lossy().into_owned(), title: String::new(), preview: None, cwd: None, branch: None, model: None, messages: 0, created: 0, updated: 0, path: path.display().to_string(), agent: "codebuddy" };
  let (mut summary, mut ai_title, mut first_prompt) = (None::<String>, None::<String>, None::<String>);
  for line in text.lines() {
    let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
    if let Some(id) = v.get("sessionId").and_then(Value::as_str).map(str::trim).filter(|x| !x.is_empty()) {
      s.id = id.to_owned();
    }
    if let Some(t) = time_of(&v) {
      if s.created == 0 {
        s.created = t;
      }
      s.updated = s.updated.max(t);
    }
    if s.cwd.is_none() {
      s.cwd = v.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty()).map(str::to_owned);
    }
    let str_at = |k: &str| v.get(k).and_then(Value::as_str).map(str::trim).filter(|x| !x.is_empty()).map(str::to_owned);
    match v.get("type").and_then(Value::as_str).unwrap_or("") {
      "summary" => summary = str_at("summary").or(summary),
      "ai-title" => ai_title = str_at("aiTitle").or(ai_title),
      "message" => {
        let role = v.get("role").and_then(Value::as_str).unwrap_or("");
        let text = v.get("content").and_then(codebuddy_text);
        s.messages += 1;
        // A turn CodeBuddy never sent as the user's (`providerData.skipRun`) does not name the session.
        let meta = v.get("providerData").and_then(|p| p.get("skipRun")).and_then(Value::as_bool) == Some(true);
        if role == "user" {
          if let Some(t) = text.as_deref().filter(|t| !meta && !t.starts_with('<')) {
            first_prompt.get_or_insert_with(|| t.to_owned());
          }
        } else if role == "assistant"
          && let Some(m) = v.get("providerData").and_then(|p| p.get("model")).and_then(Value::as_str)
        {
          s.model = Some(m.to_owned());
        }
        if let Some(t) = text.filter(|_| role == "user" || role == "assistant") {
          s.preview = Some(short(&format!("{}: {t}", if role == "user" { "You" } else { "Agent" }), 240));
        }
      }
      _ => {}
    }
  }
  if s.messages == 0 {
    return None;
  }
  s.title = short(&summary.or(ai_title).or(first_prompt).unwrap_or_else(|| "Untitled session".into()), 120);
  Some(s)
}

/// CodeBuddy sessions of `root` (`~/.codebuddy/projects`).
pub fn list_codebuddy(root: &Path, projects: &Path, limit: usize) -> Vec<Session> {
  newest_in(root, &[projects.to_path_buf()], 2, limit, read_codebuddy)
}

/// One Factory Droid session (`~/.factory/sessions/…/<id>.jsonl`, Orca `consumeDroidRecordLine`):
/// `session_start` gives the id, title and folder, `system` the folder and model, `message` and
/// `completion` the turns.
pub fn read_droid(path: &Path) -> Option<Session> {
  let text = String::from_utf8_lossy(&std::fs::read(path).ok()?).into_owned();
  let mut s = Session { id: path.file_stem()?.to_string_lossy().into_owned(), title: String::new(), preview: None, cwd: None, branch: None, model: None, messages: 0, created: 0, updated: 0, path: path.display().to_string(), agent: "droid" };
  let mut first_prompt: Option<String> = None;
  for line in text.lines() {
    let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
    if let Some(t) = time_of(&v) {
      if s.created == 0 {
        s.created = t;
      }
      s.updated = s.updated.max(t);
    }
    let str_at = |k: &str| v.get(k).and_then(Value::as_str).map(str::trim).filter(|x| !x.is_empty()).map(str::to_owned);
    match v.get("type").and_then(Value::as_str).unwrap_or("") {
      "session_start" => {
        if let Some(id) = str_at("id") {
          s.id = id;
        }
        if let Some(t) = str_at("title") {
          s.title = short(&t, 120);
        }
        s.cwd = str_at("cwd").or(s.cwd.take());
      }
      "system" => {
        s.cwd = str_at("cwd").or(s.cwd.take());
        s.model = str_at("model").or(s.model.take());
      }
      "message" => {
        let role = str_at("role").or_else(|| v.get("message").and_then(|m| m.get("role")).and_then(Value::as_str).map(str::to_owned)).unwrap_or_default();
        if role != "user" && role != "assistant" {
          continue;
        }
        s.messages += 1;
        let text = str_at("text").or_else(|| v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_str().map(str::to_owned).or_else(|| codex_text(c))));
        if let Some(t) = text.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty()) {
          if role == "user" {
            first_prompt.get_or_insert_with(|| t.clone());
          }
          s.preview = Some(short(&format!("{}: {t}", if role == "user" { "You" } else { "Agent" }), 240));
        }
      }
      "completion" => {
        s.messages += 1;
        if let Some(t) = str_at("finalText") {
          s.preview = Some(short(&format!("Agent: {t}"), 240));
        }
      }
      _ => {}
    }
    if let Some(id) = str_at("session_id").or_else(|| str_at("sessionId")) {
      s.id = id;
    }
  }
  if s.messages == 0 {
    return None;
  }
  if s.title.is_empty() {
    s.title = first_prompt.map_or_else(|| "Untitled session".into(), |t| short(&t, 120));
  }
  Some(s)
}

/// Droid sessions of `root` (`~/.factory/sessions` and `~/.factory/projects`, as Orca reads both).
pub fn list_droid(root: &Path, factory: &Path, limit: usize) -> Vec<Session> {
  newest_in(root, &[factory.join("sessions"), factory.join("projects")], 3, limit, read_droid)
}

// ---- Kiro CLI (Orca ai-vault scanners/kiro) ---------------------------------------------------

/// A time given as an ISO string or a Unix number (seconds, or ms when that large), as Unix ms.
fn when_of(v: &Value) -> Option<i64> {
  match v {
    Value::String(s) => time_of(&serde_json::json!({ "timestamp": s })),
    Value::Number(n) => n.as_f64().filter(|x| *x > 0.0).map(|x| if x > 1e12 { x as i64 } else { (x * 1000.0) as i64 }),
    _ => None,
  }
}

/// Kiro's content blocks (`{ kind: "text", data }`) as text (Orca `toPreviewBlocks`, text only).
fn kiro_text(content: &Value) -> Option<String> {
  let t: Vec<&str> = content.as_array()?.iter().filter(|b| b.get("kind").and_then(Value::as_str) == Some("text")).filter_map(|b| b.get("data").and_then(Value::as_str)).collect();
  let t = t.join(" ");
  let t = t.trim();
  (!t.is_empty()).then(|| t.to_owned())
}

/// One Kiro chat (`~/.kiro/sessions/cli/<uuid>.json` metadata with its `<uuid>.jsonl` transcript,
/// Orca `parseKiroSessionFile`); a child session (`parent_session_id`) is reached through its parent.
pub fn read_kiro(meta_path: &Path) -> Option<Session> {
  let id = meta_path.file_stem()?.to_string_lossy().into_owned();
  if !crate::accounts::managed::is_uuid(&id) {
    return None;
  }
  let meta: Value = serde_json::from_slice(&std::fs::read(meta_path).ok()?).ok()?;
  if meta.get("parent_session_id").and_then(Value::as_str).is_some_and(|p| !p.trim().is_empty()) {
    return None;
  }
  let created = meta.get("created_at").and_then(when_of).unwrap_or(0);
  let mut s = Session {
    id,
    title: meta.get("title").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty()).map(|t| short(t, 120)).unwrap_or_default(),
    preview: None,
    cwd: meta.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty()).map(str::to_owned),
    branch: None,
    model: meta.pointer("/session_state/rts_model_state/model_info/model_id").and_then(Value::as_str).map(str::to_owned),
    messages: 0,
    created,
    updated: meta.get("updated_at").and_then(when_of).unwrap_or(created),
    path: meta_path.display().to_string(),
    agent: "kiro",
  };
  let mut first_prompt: Option<String> = None;
  // The transcript can be missing (metadata comes before the first turn): an empty session.
  let transcript = std::fs::read(meta_path.with_extension("jsonl")).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
  for line in transcript.lines() {
    let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
    let Some(data) = v.get("data") else { continue };
    let (user, assistant) = match v.get("kind").and_then(Value::as_str) {
      Some("Prompt") => (true, false),
      Some("AssistantMessage") => (false, true),
      _ => continue,
    };
    if user && let Some(t) = data.pointer("/meta/timestamp").and_then(when_of) {
      s.updated = s.updated.max(t);
    }
    s.messages += 1;
    if let Some(t) = data.get("content").and_then(kiro_text) {
      if user {
        first_prompt.get_or_insert_with(|| t.clone());
      }
      s.preview = Some(short(&format!("{}: {t}", if assistant { "Agent" } else { "You" }), 240));
    }
  }
  if s.title.is_empty() {
    s.title = first_prompt.map_or_else(|| "Untitled session".into(), |t| short(&t, 120));
  }
  Some(s)
}

/// Kiro sessions of `root` (`~/.kiro/sessions/cli`, flat metadata / transcript pairs).
pub fn list_kiro(root: &Path, sessions: &Path, limit: usize) -> Vec<Session> {
  let mut metas: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(sessions)
    .into_iter()
    .flatten()
    .flatten()
    .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
    .map(|e| (e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH), e.path()))
    .collect();
  metas.sort_by_key(|m| std::cmp::Reverse(m.0));
  let mut out: Vec<Session> = metas.into_iter().take(limit.saturating_mul(4)).filter_map(|(_, p)| read_kiro(&p)).filter(|s| s.cwd.as_deref().is_some_and(|c| inside(root, c))).collect();
  out.sort_by_key(|s| std::cmp::Reverse(s.updated));
  out.truncate(limit);
  out
}

// ---- Cline and Kimi Code (Orca ai-vault scanners/cline, scanners/kimi) -----------------------

/// A session id or folder name that is safe as one path segment and as a command argument.
fn safe_id(s: &str) -> bool {
  !s.is_empty() && s.len() <= 200 && !s.starts_with(['.', '-']) && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Widens a session's time span with one more time (Orca `updateTimeline`: earliest and latest).
fn widen(s: &mut Session, t: Option<i64>) {
  let Some(t) = t else { return };
  if s.created == 0 || t < s.created {
    s.created = t;
  }
  s.updated = s.updated.max(t);
}

fn modified(p: &Path) -> std::time::SystemTime {
  std::fs::metadata(p).and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH)
}

/// The newest `limit` of `files` (newest first by `(mtime, path)`) that `read` makes into sessions of `root`.
fn newest_of(root: &Path, mut files: Vec<(std::time::SystemTime, PathBuf)>, limit: usize, read: impl Fn(&Path) -> Option<Session>) -> Vec<Session> {
  files.sort_by_key(|f| std::cmp::Reverse(f.0));
  let mut out: Vec<Session> = files.into_iter().take(limit.saturating_mul(4)).filter_map(|(_, p)| read(&p)).filter(|s| s.cwd.as_deref().is_some_and(|c| inside(root, c))).collect();
  out.sort_by_key(|s| std::cmp::Reverse(s.updated));
  out.truncate(limit);
  out
}

/// One Cline session (`<sessions>/<id>/<id>.json` metadata with its `<id>.messages.json`, Orca
/// `parseClineSessionContent`): the metadata gives the id, folder (`cwd`, else `workspace_root`),
/// model, start and prompt; the messages file the `user` / `assistant` turns and `updated_at`.
pub fn read_cline(meta_path: &Path) -> Option<Session> {
  let dir_name = meta_path.parent()?.file_name()?.to_str()?;
  // Orca `isClineSessionMetadataPath`: the manifest is named after its session folder.
  if !safe_id(dir_name) || meta_path.file_name()?.to_str()? != format!("{dir_name}.json") {
    return None;
  }
  let meta: Value = serde_json::from_slice(&std::fs::read(meta_path).ok()?).ok()?;
  meta.as_object()?;
  let str_at = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(str::trim).filter(|x| !x.is_empty()).map(str::to_owned);
  let id = str_at(&meta, "session_id").unwrap_or_else(|| dir_name.to_owned());
  if !safe_id(&id) {
    return None;
  }
  let mut s = Session { id, title: String::new(), preview: None, cwd: str_at(&meta, "cwd").or_else(|| str_at(&meta, "workspace_root")), branch: None, model: str_at(&meta, "model"), messages: 0, created: 0, updated: 0, path: meta_path.display().to_string(), agent: "cline" };
  widen(&mut s, meta.get("started_at").and_then(when_of));
  let mut first_prompt: Option<String> = None;
  // The messages file can be missing or broken: the session still lists from its metadata.
  let messages: Option<Value> = std::fs::read(meta_path.with_extension("messages.json")).ok().and_then(|b| serde_json::from_slice(&b).ok());
  if let Some(m) = messages.filter(Value::is_object) {
    widen(&mut s, m.get("updated_at").and_then(when_of));
    for msg in m.get("messages").and_then(Value::as_array).into_iter().flatten() {
      let role = msg.get("role").and_then(Value::as_str).unwrap_or("");
      if role != "user" && role != "assistant" {
        continue;
      }
      s.messages += 1;
      widen(&mut s, msg.get("ts").and_then(when_of));
      let text = msg.get("content").and_then(text_of).map(|t| t.trim().to_owned()).filter(|t| !t.is_empty());
      if role == "user" && first_prompt.is_none() {
        first_prompt = text.clone();
      }
      if role == "assistant" && s.model.is_none() {
        s.model = msg.pointer("/modelInfo/id").and_then(Value::as_str).map(str::trim).filter(|x| !x.is_empty()).map(str::to_owned);
      }
      if let Some(t) = text {
        s.preview = Some(short(&format!("{}: {t}", if role == "user" { "You" } else { "Agent" }), 240));
      }
    }
  }
  s.title = first_prompt.or_else(|| str_at(&meta, "prompt")).map_or_else(|| "Untitled session".into(), |t| short(&t, 120));
  Some(s)
}

/// Cline sessions of `root` (`$CLINE_SESSION_DATA_DIR`, else `~/.cline/data/sessions`; one
/// manifest directly inside each session folder).
pub fn list_cline(root: &Path, sessions: &Path, limit: usize) -> Vec<Session> {
  let files = std::fs::read_dir(sessions)
    .into_iter()
    .flatten()
    .flatten()
    .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
    .filter_map(|e| {
      let name = e.file_name().to_str().filter(|n| safe_id(n))?.to_owned();
      let meta = e.path().join(format!("{name}.json"));
      // Freshness follows the messages file too (Orca's `contentDependencyPath`).
      let t = modified(&meta).max(modified(&meta.with_extension("messages.json")));
      meta.is_file().then_some((t, meta))
    })
    .collect();
  newest_of(root, files, limit, read_cline)
}

/// Kimi's `session_index.jsonl` (next to `sessions/`): session id to work folder, later lines
/// winning (Orca `parseKimiSessionIndex`; Orca caches it per scan, Kingu reads it once per listing).
pub fn kimi_work_dirs(index: &Path) -> std::collections::HashMap<String, String> {
  let mut out = std::collections::HashMap::new();
  let text = std::fs::read(index).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
  for line in text.lines().filter(|l| !l.trim().is_empty()) {
    let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
    let at = |k: &str| v.get(k).and_then(Value::as_str).map(str::trim).filter(|x| !x.is_empty()).map(str::to_owned);
    if let (Some(id), Some(dir)) = (at("sessionId"), at("workDir")) {
      out.insert(id, dir);
    }
  }
  out
}

/// One Kimi Code session (`<home>/sessions/<workspace>/session_<…>/state.json`, Orca
/// `parseKimiSessionFile`): the state gives the title, last prompt and times, the index the
/// folder, and the main agent's `agents/<id>/wire.jsonl` the turns and model.
pub fn read_kimi(state_path: &Path, work_dirs: &std::collections::HashMap<String, String>) -> Option<Session> {
  // The id keeps its `session_` prefix: `kimi --session` expects it.
  let id = state_path.parent()?.file_name()?.to_str()?.to_owned();
  if !id.starts_with("session_") || !safe_id(&id) || state_path.file_name()? != "state.json" {
    return None;
  }
  let state: Value = serde_json::from_slice(&std::fs::read(state_path).ok()?).ok()?;
  state.as_object()?;
  let str_at = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(str::trim).filter(|x| !x.is_empty()).map(str::to_owned);
  let mut s = Session { id: id.clone(), title: String::new(), preview: None, cwd: work_dirs.get(&id).cloned(), branch: None, model: None, messages: 0, created: 0, updated: 0, path: state_path.display().to_string(), agent: "kimi" };
  widen(&mut s, state.get("createdAt").and_then(when_of));
  widen(&mut s, state.get("updatedAt").and_then(when_of));
  let mut title = str_at(&state, "title");
  // The root main agent (Orca `kimiPrimaryAgentWirePath`), else `main`; never a folder outside the session.
  let primary = state
    .get("agents")
    .and_then(Value::as_object)
    .and_then(|a| a.iter().find(|(_, v)| v.get("type").and_then(Value::as_str) == Some("main") && v.get("parentAgentId").is_none_or(Value::is_null)).map(|(k, _)| k.clone()))
    .filter(|k| safe_id(k))
    .unwrap_or_else(|| "main".into());
  let wire = std::fs::read(state_path.with_file_name("agents").join(primary).join("wire.jsonl")).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
  let mut pending = String::new();
  let flush = |s: &mut Session, pending: &mut String| {
    let t = std::mem::take(pending);
    let t = t.trim();
    if !t.is_empty() {
      s.messages += 1;
      s.preview = Some(short(&format!("Agent: {t}"), 240));
    }
  };
  for line in wire.lines() {
    let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
    match v.get("type").and_then(Value::as_str).unwrap_or("") {
      "config.update" => s.model = str_at(&v, "modelAlias").or(s.model.take()),
      "usage.record" => s.model = str_at(&v, "model").or(s.model.take()),
      "context.append_message" => {
        let Some(m) = v.get("message") else { continue };
        // Kimi labels injected reminders as user messages too; `origin.kind` marks real input.
        if m.get("role").and_then(Value::as_str) != Some("user") || m.pointer("/origin/kind").and_then(Value::as_str) != Some("user") {
          continue;
        }
        s.messages += 1;
        if let Some(t) = m.get("content").and_then(|c| c.as_str().map(str::to_owned).or_else(|| text_of(c))).map(|t| t.trim().to_owned()).filter(|t| !t.is_empty()) {
          title.get_or_insert_with(|| t.clone());
          s.preview = Some(short(&format!("You: {t}"), 240));
        }
      }
      "context.append_loop_event" => {
        let Some(e) = v.get("event") else { continue };
        match e.get("type").and_then(Value::as_str) {
          Some("content.part") if e.pointer("/part/type").and_then(Value::as_str) == Some("text") => {
            if let Some(t) = e.pointer("/part/text").and_then(Value::as_str) {
              pending.push_str(t);
            }
          }
          // Streamed text chunks make one message per assistant step.
          Some("step.end") => flush(&mut s, &mut pending),
          _ => {}
        }
      }
      _ => {}
    }
  }
  flush(&mut s, &mut pending);
  s.title = title.or_else(|| str_at(&state, "lastPrompt")).map_or_else(|| "Untitled session".into(), |t| short(&t, 120));
  Some(s)
}

/// Kimi Code sessions of `root` (`$KIMI_CODE_HOME/sessions`, else `~/.kimi-code/sessions`), with
/// their folders from the home's `session_index.jsonl`.
pub fn list_kimi(root: &Path, sessions: &Path, limit: usize) -> Vec<Session> {
  let work_dirs = sessions.parent().map(|home| kimi_work_dirs(&home.join("session_index.jsonl"))).unwrap_or_default();
  let mut files = Vec::new();
  for ws in std::fs::read_dir(sessions).into_iter().flatten().flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())) {
    for d in std::fs::read_dir(ws.path()).into_iter().flatten().flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())) {
      if !d.file_name().to_str().is_some_and(|n| n.starts_with("session_") && safe_id(n)) {
        continue;
      }
      let state = d.path().join("state.json");
      if state.is_file() {
        files.push((modified(&state), state));
      }
    }
  }
  newest_of(root, files, limit, |p| read_kimi(p, &work_dirs))
}

// ---- Devin CLI (Orca ai-vault scanners/devin) -------------------------------------------------

/// One row of Devin's `sessions.db` (Orca `readDevinSessionsIndex`): what fills a transcript's gaps.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct DevinRow {
  pub cwd: Option<String>,
  pub title: Option<String>,
  pub created: i64,
  pub updated: i64,
  pub hidden: bool,
}

/// `sessions.db` by session id (only the columns this release has, as Orca probes them).
pub fn devin_index(db: &Path) -> std::collections::HashMap<String, DevinRow> {
  let mut out = std::collections::HashMap::new();
  if !db.is_file() {
    return out;
  }
  let have: Vec<String> = crate::accounts::managed::sqlite_rows(db, "SELECT name FROM pragma_table_info('sessions')")
    .unwrap_or_default()
    .into_iter()
    .filter_map(|r| r.get("name").and_then(Value::as_str).map(str::to_owned))
    .collect();
  if !have.iter().any(|c| c == "id") {
    return out;
  }
  let cols: Vec<&str> = ["working_directory", "title", "created_at", "last_activity_at", "hidden"].into_iter().filter(|c| have.iter().any(|h| h == c)).collect();
  let sql = format!("SELECT id{} FROM sessions", cols.iter().map(|c| format!(", {c}")).collect::<String>());
  for r in crate::accounts::managed::sqlite_rows(db, &sql).unwrap_or_default() {
    let Some(id) = r.get("id").and_then(Value::as_str).filter(|x| !x.is_empty()) else { continue };
    let text = |k: &str| r.get(k).and_then(Value::as_str).map(str::trim).filter(|x| !x.is_empty()).map(str::to_owned);
    // Unix seconds (Orca `unixSecondsToIso`).
    let secs = |k: &str| r.get(k).and_then(Value::as_f64).filter(|x| *x > 0.0).map_or(0, |x| (x * 1000.0) as i64);
    out.insert(
      id.to_owned(),
      DevinRow { cwd: text("working_directory"), title: text("title"), created: secs("created_at"), updated: secs("last_activity_at"), hidden: r.get("hidden").and_then(Value::as_f64).is_some_and(|h| h != 0.0) },
    );
  }
  out
}

/// A step's message text (`message.content`, `message`, `text` or `content`; a string or text parts).
fn devin_text(step: &Value) -> Option<String> {
  let wrapped = step.get("message").and_then(|m| m.get("content"));
  for c in [wrapped, step.get("message"), step.get("text"), step.get("content")].into_iter().flatten() {
    let t = c.as_str().map(str::to_owned).or_else(|| text_of(c)).or_else(|| codex_text(c));
    if let Some(t) = t.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty()) {
      return Some(t);
    }
  }
  None
}

/// One Devin transcript (an ATIF document: `session_id`, `working_directory`, `agent.model_name`,
/// `steps`; Orca `parseDevinSessionRecord`), then `sessions.db` fills what it never recorded; a
/// hidden row hides the session (Orca `enrichDevinSessionFromDb`).
pub fn read_devin(path: &Path, index: &std::collections::HashMap<String, DevinRow>) -> Option<Session> {
  let v: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
  let text = |k: &str| v.get(k).and_then(Value::as_str).map(str::trim).filter(|x| !x.is_empty()).map(str::to_owned);
  let id = text("session_id").or_else(|| text("sessionId")).unwrap_or(path.file_stem()?.to_string_lossy().into_owned());
  let model = v.pointer("/agent/model_name").or_else(|| v.pointer("/agent/model")).and_then(Value::as_str).map(str::to_owned).or_else(|| text("generation_model"));
  let mut s = Session { id, title: String::new(), preview: None, cwd: text("working_directory"), branch: None, model, messages: 0, created: 0, updated: 0, path: path.display().to_string(), agent: "devin" };
  for step in v.get("steps").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default() {
    let meta = step.get("metadata");
    let at = step.get("timestamp").or_else(|| meta.and_then(|m| m.get("created_at"))).and_then(when_of);
    if let Some(t) = at {
      if s.created == 0 {
        s.created = t;
      }
      s.updated = s.updated.max(t);
    }
    // System steps are never messages, titles or previews.
    let source = step.get("source").and_then(Value::as_str).unwrap_or("");
    let user = source != "system" && (source == "user" || meta.and_then(|m| m.get("is_user_input")).and_then(Value::as_bool) == Some(true));
    let agent = source == "agent" || step.get("role").and_then(Value::as_str) == Some("assistant") || step.get("tool_calls").is_some();
    if source == "system" || !(user || agent) {
      continue;
    }
    s.messages += 1;
    if let Some(t) = devin_text(step) {
      if user && s.title.is_empty() {
        s.title = short(&t, 120);
      }
      s.preview = Some(short(&format!("{}: {t}", if user { "You" } else { "Agent" }), 240));
    }
  }
  if let Some(row) = index.get(&s.id) {
    if row.hidden {
      return None;
    }
    if s.title.is_empty() {
      s.title = row.title.as_deref().map(|t| short(t, 120)).unwrap_or_default();
    }
    s.cwd = s.cwd.take().or_else(|| row.cwd.clone());
    if s.created == 0 {
      s.created = row.created;
    }
    if s.updated == 0 {
      s.updated = row.updated;
    }
  }
  if s.messages == 0 {
    return None;
  }
  if s.title.is_empty() {
    s.title = "Untitled session".into();
  }
  if s.updated == 0 {
    s.updated = s.created;
  }
  Some(s)
}

/// Devin sessions of `root` (`cli` is `~/.local/share/devin/cli`: its `transcripts` and
/// `agent_logs` JSON files, with `sessions.db` beside them).
pub fn list_devin(root: &Path, cli: &Path, limit: usize) -> Vec<Session> {
  let index = devin_index(&cli.join("sessions.db"));
  let mut files: Vec<(std::time::SystemTime, PathBuf)> = ["transcripts", "agent_logs"]
    .iter()
    .flat_map(|d| std::fs::read_dir(cli.join(d)).into_iter().flatten().flatten())
    .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
    .map(|e| (e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH), e.path()))
    .collect();
  files.sort_by_key(|f| std::cmp::Reverse(f.0));
  let mut out: Vec<Session> = files.into_iter().take(limit.saturating_mul(4)).filter_map(|(_, p)| read_devin(&p, &index)).filter(|s| s.cwd.as_deref().is_some_and(|c| inside(root, c))).collect();
  // The same session in both folders: keep the newest.
  out.sort_by_key(|s| std::cmp::Reverse(s.updated));
  let mut seen = std::collections::HashSet::new();
  out.retain(|s| seen.insert(s.id.clone()));
  out.truncate(limit);
  out
}

// ---- OpenCode (Orca ai-vault scanners/opencode/sqlite) ---------------------------------------

/// OpenCode's databases (Orca `listOpenCodeDatabases`): `$OPENCODE_DB` when set (absolute, or a
/// name in the data folder; `:memory:` has none), else every `opencode*.db` in
/// `$XDG_DATA_HOME/opencode` (`~/.local/share/opencode`).
pub fn opencode_dbs(home: &Path, xdg_data_home: Option<&str>, opencode_db: Option<&str>) -> Vec<PathBuf> {
  let data = xdg_data_home.map(str::trim).filter(|x| !x.is_empty()).map(PathBuf::from).unwrap_or_else(|| home.join(".local").join("share")).join("opencode");
  if let Some(sel) = opencode_db.map(str::trim).filter(|x| !x.is_empty()) {
    if sel == ":memory:" {
      return Vec::new();
    }
    let p = if Path::new(sel).is_absolute() { PathBuf::from(sel) } else { data.join(sel) };
    return if p.is_file() { vec![p] } else { Vec::new() };
  }
  opencode_dbs_in(&data)
}

/// The `opencode.db` / `opencode-<name>.db` files of an OpenCode data folder.
pub fn opencode_dbs_in(data: &Path) -> Vec<PathBuf> {
  let named = |n: &str| {
    n.strip_prefix("opencode").and_then(|r| r.strip_suffix(".db")).is_some_and(|mid| mid.is_empty() || (mid.len() > 1 && mid.starts_with('-') && mid[1..].chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))))
  };
  let mut out: Vec<PathBuf> = std::fs::read_dir(data).into_iter().flatten().flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_file()) && e.file_name().to_str().is_some_and(named)).map(|e| e.path()).collect();
  out.sort();
  out
}

/// A string as an SQL literal (the `sqlite3` CLI takes no bound parameters).
fn sql_text(s: &str) -> String {
  format!("'{}'", s.replace('\'', "''"))
}

/// The newest `limit` top-level, unarchived sessions run in `root` or below it, with the message
/// count and the latest text part (Orca's list + preview queries). Columns an older OpenCode lacks
/// are left out, as Orca's schema probes do; a database without `session` gives no query.
pub fn opencode_query(session_cols: &[String], message_cols: &[String], part_cols: &[String], root: &Path, limit: usize) -> Option<String> {
  let has = |cols: &[String], c: &str| cols.iter().any(|x| x == c);
  if !["id", "time_created", "time_updated", "directory"].iter().all(|c| has(session_cols, c)) {
    return None;
  }
  let col = |c: &str| if has(session_cols, c) { format!("s.{c}") } else { "NULL".into() };
  let messages = ["session_id", "data"].iter().all(|c| has(message_cols, c));
  let parts = messages && has(message_cols, "id") && ["message_id", "time_created", "data"].iter().all(|c| has(part_cols, c));
  let count = if messages { "(SELECT COUNT(*) FROM message m WHERE m.session_id = s.id AND json_extract(m.data, '$.role') IN ('user','assistant'))" } else { "0" };
  let last = if parts {
    "(SELECT json_object('role', json_extract(m.data, '$.role'), 'text', json_extract(p.data, '$.text')) FROM message m JOIN part p ON p.message_id = m.id WHERE m.session_id = s.id AND json_extract(m.data, '$.role') IN ('user','assistant') AND json_extract(p.data, '$.type') = 'text' ORDER BY p.time_created DESC LIMIT 1)"
  } else {
    "NULL"
  };
  let first = if parts {
    "(SELECT json_extract(p.data, '$.text') FROM message m JOIN part p ON p.message_id = m.id WHERE m.session_id = s.id AND json_extract(m.data, '$.role') = 'user' AND json_extract(p.data, '$.type') = 'text' ORDER BY p.time_created ASC LIMIT 1)"
  } else {
    "NULL"
  };
  let top = if has(session_cols, "parent_id") { " AND s.parent_id IS NULL" } else { "" };
  let live = if has(session_cols, "time_archived") { " AND s.time_archived IS NULL" } else { "" };
  let r = root.to_string_lossy();
  let below = format!("{}/", r.trim_end_matches('/'));
  Some(format!(
    "SELECT s.id, {title} AS title, s.directory, s.time_created, s.time_updated, {model} AS model_json, {count} AS message_count, {last} AS last, {first} AS first_prompt \
     FROM session s WHERE (s.directory = {root} OR substr(s.directory, 1, {n}) = {below}){top}{live} \
     ORDER BY CASE WHEN s.time_updated > 0 THEN s.time_updated ELSE s.time_created END DESC LIMIT {limit}",
    title = col("title"),
    model = col("model"),
    root = sql_text(&r),
    n = below.chars().count(),
    below = sql_text(&below),
  ))
}

/// OpenCode's default title for a session nobody named (`New session - <ISO time>`).
fn opencode_default_title(t: &str) -> bool {
  t.starts_with("New session - ") || t.starts_with("Child session - ")
}

/// One row of [`opencode_query`] as a session (`path` is `<db>#<session id>`, Orca's candidate path).
pub fn opencode_session(row: &serde_json::Map<String, Value>, db: &Path) -> Option<Session> {
  let text = |k: &str| row.get(k).and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty());
  let num = |k: &str| row.get(k).and_then(Value::as_i64).unwrap_or(0);
  let id = text("id")?.to_owned();
  let model = text("model_json").and_then(|m| serde_json::from_str::<Value>(m).ok()).and_then(|m| {
    // Current `id`, older `modelID` (Orca `extractModelId`).
    m.get("id").or_else(|| m.get("modelID")).and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty()).map(str::to_owned)
  });
  let last = text("last").and_then(|l| serde_json::from_str::<Value>(l).ok());
  let preview = last.as_ref().and_then(|l| {
    let t = l.get("text").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty())?;
    Some(short(&format!("{}: {t}", if l.get("role").and_then(Value::as_str) == Some("user") { "You" } else { "Agent" }), 240))
  });
  let title = text("title").filter(|t| !opencode_default_title(t)).or_else(|| text("first_prompt")).map(|t| short(t, 120));
  let created = num("time_created");
  let updated = num("time_updated");
  Some(Session {
    title: title.unwrap_or_else(|| "Untitled session".into()),
    preview,
    cwd: text("directory").map(str::to_owned),
    branch: None,
    model,
    messages: u32::try_from(num("message_count")).unwrap_or(0),
    created,
    updated: if updated > 0 { updated } else { created },
    path: format!("{}#{id}", db.display()),
    id,
    agent: "opencode",
  })
}

fn column_names(db: &Path, table: &str) -> Vec<String> {
  crate::accounts::managed::sqlite_rows(db, &format!("SELECT name FROM pragma_table_info({})", sql_text(table)))
    .unwrap_or_default()
    .into_iter()
    .filter_map(|r| r.get("name").and_then(Value::as_str).map(str::to_owned))
    .collect()
}

/// OpenCode sessions run in `root` or its worktrees, newest first; a database that cannot be read
/// is skipped (logged), like Orca's scan issues.
pub fn list_opencode(dbs: &[PathBuf], root: &Path, limit: usize) -> Vec<Session> {
  let mut out: Vec<Session> = Vec::new();
  for db in dbs {
    let Some(sql) = opencode_query(&column_names(db, "session"), &column_names(db, "message"), &column_names(db, "part"), root, limit) else { continue };
    match crate::accounts::managed::sqlite_rows(db, &sql) {
      Ok(rows) => out.extend(rows.iter().filter_map(|r| opencode_session(r, db))),
      Err(e) => log::warn!("opencode sessions in {}: {e}", db.display()),
    }
  }
  // The same session in two databases (a copied store): keep the newest.
  out.sort_by_key(|s| std::cmp::Reverse(s.updated));
  let mut seen = std::collections::HashSet::new();
  out.retain(|s| seen.insert(s.id.clone()));
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

  #[test]
  fn finds_opencode_databases_like_orca() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("xdg/opencode");
    std::fs::create_dir_all(&data).unwrap();
    for n in ["opencode.db", "opencode-work.db", "opencode-.db", "other.db", "opencode.db-wal"] {
      std::fs::write(data.join(n), "").unwrap();
    }
    let xdg = dir.path().join("xdg");
    let names = |v: Vec<PathBuf>| v.iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect::<Vec<_>>();
    assert_eq!(names(opencode_dbs(dir.path(), xdg.to_str(), None)), ["opencode-work.db", "opencode.db"]);
    assert_eq!(names(opencode_dbs(dir.path(), xdg.to_str(), Some("opencode-work.db"))), ["opencode-work.db"]);
    assert!(opencode_dbs(dir.path(), xdg.to_str(), Some(":memory:")).is_empty());
    assert!(opencode_dbs(dir.path(), xdg.to_str(), Some("missing.db")).is_empty());
  }

  #[test]
  fn opencode_query_follows_the_schema() {
    let cols = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert!(opencode_query(&cols(&["id", "time_created"]), &[], &[], Path::new("/r"), 5).is_none());
    let bare = opencode_query(&cols(&["id", "time_created", "time_updated", "directory"]), &[], &[], Path::new("/r/it's"), 5).unwrap();
    assert!(bare.contains("NULL AS title") && bare.contains("0 AS message_count") && !bare.contains("parent_id"));
    assert!(bare.contains("'/r/it''s/'"), "quotes are escaped: {bare}");
  }

  #[test]
  fn reads_opencode_sessions_of_this_folder() {
    let sqlite = Path::new(crate::accounts::managed::SQLITE);
    if !sqlite.exists() {
      return;
    }
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("opencode.db");
    let sql = r#"
      CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, model TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      INSERT INTO session VALUES ('ses_a', NULL, '/repo', 'Fix login', '{"id":"gpt-5"}', 1000, 3000, NULL);
      INSERT INTO session VALUES ('ses_b', NULL, '/repo/.kingu/worktrees/t1', 'New session - 2026-11-20T00:00:00.000Z', NULL, 1500, 2000, NULL);
      INSERT INTO session VALUES ('ses_child', 'ses_a', '/repo', 'sub', NULL, 1600, 2600, NULL);
      INSERT INTO session VALUES ('ses_old', NULL, '/repo', 'Archived', NULL, 100, 200, 300);
      INSERT INTO session VALUES ('ses_x', NULL, '/repo-other', 'Elsewhere', NULL, 100, 5000, NULL);
      INSERT INTO message VALUES ('m1', 'ses_a', 1000, '{"role":"user"}');
      INSERT INTO message VALUES ('m2', 'ses_a', 2000, '{"role":"assistant"}');
      INSERT INTO part VALUES ('p1', 'm1', 'ses_a', 1000, '{"type":"text","text":"Fix the login bug"}');
      INSERT INTO part VALUES ('p2', 'm2', 'ses_a', 2000, '{"type":"text","text":"Fixed it."}');
      INSERT INTO part VALUES ('p3', 'm2', 'ses_a', 2001, '{"type":"tool","tool":"bash"}');
      INSERT INTO message VALUES ('m3', 'ses_b', 1500, '{"role":"user"}');
      INSERT INTO part VALUES ('p4', 'm3', 'ses_b', 1500, '{"type":"text","text":"Add search"}');
    "#;
    assert!(std::process::Command::new(sqlite).arg(&db).arg(sql).status().unwrap().success());
    let list = list_opencode(std::slice::from_ref(&db), Path::new("/repo"), 10);
    let ids: Vec<&str> = list.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, ["ses_a", "ses_b"]);
    let a = &list[0];
    assert_eq!((a.title.as_str(), a.model.as_deref(), a.messages, a.preview.as_deref(), a.agent), ("Fix login", Some("gpt-5"), 2, Some("Agent: Fixed it."), "opencode"));
    assert_eq!(a.path, format!("{}#ses_a", db.display()));
    // OpenCode's default title gives way to the first prompt.
    assert_eq!(list[1].title, "Add search");
    assert_eq!(list_opencode(&[db], Path::new("/repo"), 1).len(), 1);
  }

  #[test]
  fn reads_copilot_sessions_of_this_folder_only() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("session-state");
    std::fs::create_dir_all(state.join("2026")).unwrap();
    let line = |v: serde_json::Value| v.to_string();
    let mine = [
      line(serde_json::json!({ "type": "session.start", "timestamp": "2026-11-20T09:00:00.000Z", "data": { "sessionId": "cp-1", "context": { "cwd": "/repo/.kingu/worktrees/t1", "branch": "kingu/t1" } } })),
      line(serde_json::json!({ "type": "session.model_change", "timestamp": "2026-11-20T09:00:01.000Z", "data": { "newModel": "gpt-5" } })),
      line(serde_json::json!({ "type": "user.message", "timestamp": "2026-11-20T09:00:02.000Z", "data": { "content": "Add search", "transformedContent": "<current_datetime>x</current_datetime> Add search" } })),
      line(serde_json::json!({ "type": "assistant.message", "timestamp": "2026-11-20T09:01:00.000Z", "data": { "content": "Added." } })),
    ]
    .join("\n");
    std::fs::write(state.join("2026").join("cp-1.jsonl"), mine).unwrap();
    let other = line(serde_json::json!({ "type": "session.info", "timestamp": "2026-11-20T10:00:00.000Z", "data": { "message": "Folder /elsewhere has been added to trusted folders." } }))
      + "\n"
      + &line(serde_json::json!({ "type": "user.message", "timestamp": "2026-11-20T10:00:01.000Z", "data": { "content": "x" } }));
    std::fs::write(state.join("cp-2.jsonl"), other).unwrap();
    std::fs::write(state.join("empty.jsonl"), "").unwrap();
    let list = list_copilot(Path::new("/repo"), &state, 10);
    assert_eq!(list.len(), 1);
    let s = &list[0];
    assert_eq!((s.id.as_str(), s.title.as_str(), s.model.as_deref(), s.branch.as_deref(), s.messages, s.agent), ("cp-1", "Add search", Some("gpt-5"), Some("kingu/t1"), 2, "copilot"));
    assert_eq!(s.preview.as_deref(), Some("Agent: Added."));
    assert_eq!(read_copilot(&state.join("cp-2.jsonl")).unwrap().cwd.as_deref(), Some("/elsewhere"));
  }

  #[test]
  fn reads_cursor_transcripts_scoped_by_their_chat_meta() {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    let chat = "c1";
    let uuid = "0b7c5e0e-1111-4222-8333-944455556666";
    std::fs::create_dir_all(h.join("chats/ws1").join(chat)).unwrap();
    std::fs::write(h.join("chats/ws1").join(chat).join("meta.json"), serde_json::json!({ "title": "Fix login", "cwd": "/repo", "createdAtMs": 1_700_000_000_000_i64, "updatedAtMs": 1_700_000_100_000_i64 }).to_string()).unwrap();
    std::fs::create_dir_all(h.join("chats/ws1/c2")).unwrap();
    std::fs::write(h.join("chats/ws1/c2/meta.json"), serde_json::json!({ "title": "Other", "cwd": "/elsewhere" }).to_string()).unwrap();
    let t1 = h.join("projects/p/agent-transcripts").join(chat);
    std::fs::create_dir_all(&t1).unwrap();
    let lines = [
      serde_json::json!({ "role": "user", "message": { "content": [{ "type": "text", "text": "Fix the login bug" }] } }).to_string(),
      serde_json::json!({ "role": "assistant", "message": { "content": "Fixed it." } }).to_string(),
      serde_json::json!({ "role": "tool", "content": "ignored" }).to_string(),
    ]
    .join("\n");
    std::fs::write(t1.join(format!("{uuid}.jsonl")), lines).unwrap();
    let t2 = h.join("projects/p/agent-transcripts/c2");
    std::fs::create_dir_all(&t2).unwrap();
    std::fs::write(t2.join("x.jsonl"), serde_json::json!({ "role": "user", "content": "hi" }).to_string()).unwrap();
    let t3 = h.join("projects/p/agent-transcripts/no-meta");
    std::fs::create_dir_all(&t3).unwrap();
    std::fs::write(t3.join("y.jsonl"), serde_json::json!({ "role": "user", "content": "hi" }).to_string()).unwrap();
    let list = list_cursor(Path::new("/repo"), h, 10);
    assert_eq!(list.len(), 1);
    let s = &list[0];
    assert_eq!((s.id.as_str(), s.title.as_str(), s.messages, s.agent, s.created), (uuid, "Fix login", 2, "cursor", 1_700_000_000_000));
    assert_eq!(s.preview.as_deref(), Some("Agent: Fixed it."));
  }

  #[test]
  fn reads_qoder_codebuddy_and_droid_sessions() {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    let j = |v: serde_json::Value| v.to_string();
    // Qoder: Claude's format, the folder from workspace-directories.
    std::fs::create_dir_all(h.join("qoder/p1")).unwrap();
    std::fs::write(
      h.join("qoder/p1/q1.jsonl"),
      [
        j(serde_json::json!({ "type": "workspace-directories", "directories": ["/repo"] })),
        j(serde_json::json!({ "type": "runtime-config", "model": "qwen3-coder" })),
        j(serde_json::json!({ "type": "user", "timestamp": "2026-11-20T09:00:00.000Z", "message": { "role": "user", "content": "Fix login" } })),
        j(serde_json::json!({ "type": "assistant", "timestamp": "2026-11-20T09:01:00.000Z", "message": { "role": "assistant", "content": [{ "type": "text", "text": "Done." }] } })),
      ]
      .join("\n"),
    )
    .unwrap();
    let q = list_qoder(Path::new("/repo"), &h.join("qoder"), 10);
    assert_eq!(q.len(), 1);
    assert_eq!((q[0].agent, q[0].title.as_str(), q[0].model.as_deref(), q[0].cwd.as_deref()), ("qoder", "Fix login", Some("qwen3-coder"), Some("/repo")));
    // CodeBuddy: message records, an ai-title, a skipped injected turn.
    std::fs::create_dir_all(h.join("cb/proj")).unwrap();
    std::fs::write(
      h.join("cb/proj/x.jsonl"),
      [
        j(serde_json::json!({ "type": "message", "sessionId": "cb-1", "cwd": "/repo/.kingu/worktrees/t", "timestamp": "2026-11-20T09:00:00.000Z", "role": "user", "content": "context", "providerData": { "skipRun": true } })),
        j(serde_json::json!({ "type": "message", "timestamp": "2026-11-20T09:00:01.000Z", "role": "user", "content": [{ "type": "input_text", "text": "Add search" }] })),
        j(serde_json::json!({ "type": "message", "timestamp": "2026-11-20T09:00:02.000Z", "role": "assistant", "content": "Added.", "providerData": { "model": "hunyuan" } })),
      ]
      .join("\n"),
    )
    .unwrap();
    let c = list_codebuddy(Path::new("/repo"), &h.join("cb"), 10);
    assert_eq!((c[0].id.as_str(), c[0].title.as_str(), c[0].model.as_deref(), c[0].messages), ("cb-1", "Add search", Some("hunyuan"), 3));
    // Droid: session_start, a message and a completion; another folder's session is left out.
    std::fs::create_dir_all(h.join("factory/sessions")).unwrap();
    std::fs::write(
      h.join("factory/sessions/d1.jsonl"),
      [
        j(serde_json::json!({ "type": "session_start", "id": "dr-1", "title": "Refactor auth", "cwd": "/repo", "timestamp": "2026-11-20T09:00:00.000Z" })),
        j(serde_json::json!({ "type": "message", "role": "user", "text": "Refactor auth" })),
        j(serde_json::json!({ "type": "completion", "finalText": "Refactored." })),
      ]
      .join("\n"),
    )
    .unwrap();
    std::fs::write(h.join("factory/sessions/d2.jsonl"), j(serde_json::json!({ "type": "session_start", "id": "dr-2", "cwd": "/other" })) + "\n" + &j(serde_json::json!({ "type": "message", "role": "user", "text": "x" }))).unwrap();
    let d = list_droid(Path::new("/repo"), &h.join("factory"), 10);
    assert_eq!(d.len(), 1);
    assert_eq!((d[0].id.as_str(), d[0].title.as_str(), d[0].messages, d[0].preview.as_deref()), ("dr-1", "Refactor auth", 2, Some("Agent: Refactored.")));
  }

  #[test]
  fn reads_kiro_metadata_with_its_transcript() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    let id = "0b7c5e0e-1111-4222-8333-944455556666";
    std::fs::write(d.join(format!("{id}.json")), serde_json::json!({ "cwd": "/repo", "title": "", "created_at": "2026-11-20T09:00:00.000Z", "updated_at": 1_795_000_000, "session_state": { "rts_model_state": { "model_info": { "model_id": "claude-sonnet" } } } }).to_string()).unwrap();
    std::fs::write(
      d.join(format!("{id}.jsonl")),
      [
        serde_json::json!({ "kind": "Prompt", "data": { "content": [{ "kind": "text", "data": "Write tests" }], "meta": { "timestamp": "2026-11-20T09:00:05.000Z" } } }).to_string(),
        serde_json::json!({ "kind": "AssistantMessage", "data": { "content": [{ "kind": "text", "data": "Written." }, { "kind": "toolUse", "data": { "name": "fs" } }] } }).to_string(),
        serde_json::json!({ "kind": "ToolResults", "data": { "content": [] } }).to_string(),
      ]
      .join("\n"),
    )
    .unwrap();
    let child = "0b7c5e0e-1111-4222-8333-000000000002";
    std::fs::write(d.join(format!("{child}.json")), serde_json::json!({ "cwd": "/repo", "parent_session_id": id }).to_string()).unwrap();
    std::fs::write(d.join("not-a-uuid.json"), serde_json::json!({ "cwd": "/repo" }).to_string()).unwrap();
    let list = list_kiro(Path::new("/repo"), d, 10);
    assert_eq!(list.len(), 1);
    let s = &list[0];
    assert_eq!((s.id.as_str(), s.title.as_str(), s.model.as_deref(), s.messages, s.preview.as_deref()), (id, "Write tests", Some("claude-sonnet"), 2, Some("Agent: Written.")));
    // The prompt's own time is later than the metadata's `updated_at`, so it wins.
    assert_eq!(s.updated, time_of(&serde_json::json!({ "timestamp": "2026-11-20T09:00:05.000Z" })).unwrap());
    assert_eq!(when_of(&serde_json::json!(1_795_000_000)), Some(1_795_000_000_000), "seconds");
    assert_eq!(when_of(&serde_json::json!(1_795_000_000_123_i64)), Some(1_795_000_000_123), "milliseconds");
  }

  #[test]
  fn reads_cline_metadata_with_its_messages() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    let s1 = d.join("cl-1");
    std::fs::create_dir_all(&s1).unwrap();
    std::fs::write(s1.join("cl-1.json"), serde_json::json!({ "session_id": "cl-1", "workspace_root": "/repo/sub", "started_at": 1_793_000_000, "prompt": "From metadata" }).to_string()).unwrap();
    std::fs::write(
      s1.join("cl-1.messages.json"),
      serde_json::json!({ "updated_at": 1_795_000_000_000_i64, "messages": [
        { "role": "user", "content": [{ "type": "text", "text": "Fix the build" }], "ts": 1_794_000_000_000_i64 },
        { "role": "assistant", "content": "Fixed.", "modelInfo": { "id": "claude-sonnet" } },
        { "role": "system", "content": "ignored" }
      ] })
      .to_string(),
    )
    .unwrap();
    // No messages file: listed from its metadata, titled by its prompt.
    let s2 = d.join("cl-2");
    std::fs::create_dir_all(&s2).unwrap();
    std::fs::write(s2.join("cl-2.json"), serde_json::json!({ "cwd": "/repo", "prompt": "Only a prompt", "model": "m" }).to_string()).unwrap();
    // A manifest not named after its folder, and a session elsewhere, are left out.
    let s3 = d.join("cl-3");
    std::fs::create_dir_all(&s3).unwrap();
    std::fs::write(s3.join("other.json"), serde_json::json!({ "cwd": "/repo" }).to_string()).unwrap();
    let s4 = d.join("cl-4");
    std::fs::create_dir_all(&s4).unwrap();
    std::fs::write(s4.join("cl-4.json"), serde_json::json!({ "cwd": "/other" }).to_string()).unwrap();
    let mut list = list_cline(Path::new("/repo"), d, 10);
    list.sort_by(|a, b| a.id.cmp(&b.id));
    assert_eq!(list.len(), 2);
    let a = &list[0];
    assert_eq!((a.id.as_str(), a.title.as_str(), a.cwd.as_deref(), a.model.as_deref(), a.messages, a.preview.as_deref()), ("cl-1", "Fix the build", Some("/repo/sub"), Some("claude-sonnet"), 2, Some("Agent: Fixed.")));
    assert_eq!((a.created, a.updated), (1_793_000_000_000, 1_795_000_000_000), "seconds start, ms turns");
    assert_eq!((list[1].id.as_str(), list[1].title.as_str(), list[1].messages, list[1].model.as_deref()), ("cl-2", "Only a prompt", 0, Some("m")));
    assert!(!safe_id("../x") && !safe_id("-rf") && !safe_id("") && safe_id("session_a1.b-c"));
  }

  #[test]
  fn reads_kimi_state_with_its_index_and_wire() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let id = "session_abc123";
    let sd = home.join("sessions/ws-hash").join(id);
    std::fs::create_dir_all(sd.join("agents/root")).unwrap();
    std::fs::write(
      home.join("session_index.jsonl"),
      [serde_json::json!({ "sessionId": id, "workDir": "/old" }).to_string(), serde_json::json!({ "sessionId": id, "workDir": "/repo" }).to_string(), "not json".into()].join("\n"),
    )
    .unwrap();
    std::fs::write(sd.join("state.json"), serde_json::json!({ "lastPrompt": "Last prompt", "createdAt": "2026-11-20T09:00:00.000Z", "updatedAt": "2026-11-20T09:10:00.000Z", "agents": { "root": { "type": "main", "parentAgentId": null }, "sub": { "type": "main", "parentAgentId": "root" } } }).to_string()).unwrap();
    let j = |v: serde_json::Value| v.to_string();
    std::fs::write(
      sd.join("agents/root/wire.jsonl"),
      [
        j(serde_json::json!({ "type": "config.update", "modelAlias": "kimi-k2" })),
        j(serde_json::json!({ "type": "context.append_message", "message": { "role": "user", "origin": { "kind": "system" }, "content": "reminder" } })),
        j(serde_json::json!({ "type": "context.append_message", "message": { "role": "user", "origin": { "kind": "user" }, "content": [{ "type": "text", "text": "Add a test" }] } })),
        j(serde_json::json!({ "type": "context.append_loop_event", "event": { "type": "content.part", "part": { "type": "text", "text": "Added " } } })),
        j(serde_json::json!({ "type": "context.append_loop_event", "event": { "type": "content.part", "part": { "type": "text", "text": "it." } } })),
        j(serde_json::json!({ "type": "context.append_loop_event", "event": { "type": "step.end" } })),
        j(serde_json::json!({ "type": "usage.record", "model": "kimi-k2.5" })),
      ]
      .join("\n"),
    )
    .unwrap();
    // Not in the index (no folder), and not a `session_` folder: both left out.
    let other = home.join("sessions/ws-hash/session_noindex");
    std::fs::create_dir_all(&other).unwrap();
    std::fs::write(other.join("state.json"), "{}").unwrap();
    std::fs::create_dir_all(home.join("sessions/ws-hash/misc")).unwrap();
    std::fs::write(home.join("sessions/ws-hash/misc/state.json"), "{}").unwrap();
    let list = list_kimi(Path::new("/repo"), &home.join("sessions"), 10);
    assert_eq!(list.len(), 1);
    let s = &list[0];
    assert_eq!((s.id.as_str(), s.title.as_str(), s.cwd.as_deref(), s.model.as_deref(), s.messages, s.preview.as_deref()), (id, "Add a test", Some("/repo"), Some("kimi-k2.5"), 2, Some("Agent: Added it.")));
    assert!(s.updated > s.created);
  }

  #[test]
  fn reads_devin_transcripts_filled_and_hidden_by_its_db() {
    let dir = tempfile::tempdir().unwrap();
    let cli = dir.path();
    std::fs::create_dir_all(cli.join("transcripts")).unwrap();
    let doc = |id: &str, cwd: Option<&str>| {
      serde_json::json!({ "session_id": id, "working_directory": cwd, "agent": { "model_name": "swe-1" }, "steps": [
        { "source": "system", "message": "boot", "timestamp": "2026-11-20T08:59:00.000Z" },
        { "source": "user", "message": "Fix the build", "timestamp": "2026-11-20T09:00:00.000Z" },
        { "source": "agent", "message": { "content": [{ "type": "text", "text": "Fixed." }] }, "timestamp": "2026-11-20T09:01:00.000Z" }
      ] })
      .to_string()
    };
    std::fs::write(cli.join("transcripts/a.json"), doc("dv-1", Some("/repo"))).unwrap();
    std::fs::write(cli.join("transcripts/b.json"), doc("dv-2", None)).unwrap();
    std::fs::write(cli.join("transcripts/c.json"), doc("dv-3", Some("/repo"))).unwrap();
    // Without sessions.db: only the transcript that names its folder.
    assert_eq!(list_devin(Path::new("/repo"), cli, 10).iter().map(|s| s.id.as_str()).collect::<Vec<_>>().len(), 2);
    let a = read_devin(&cli.join("transcripts/a.json"), &Default::default()).unwrap();
    assert_eq!((a.title.as_str(), a.model.as_deref(), a.messages, a.preview.as_deref()), ("Fix the build", Some("swe-1"), 2, Some("Agent: Fixed.")));
    let sqlite = Path::new(crate::accounts::managed::SQLITE);
    if !sqlite.exists() {
      return;
    }
    let sql = "CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT, title TEXT, created_at INTEGER, last_activity_at INTEGER, hidden INTEGER);
      INSERT INTO sessions VALUES ('dv-2', '/repo/.kingu/worktrees/t', 'From the db', 1795000000, 1795000100, 0);
      INSERT INTO sessions VALUES ('dv-3', '/repo', 'Hidden one', 1795000000, 1795000100, 1);";
    assert!(std::process::Command::new(sqlite).arg(cli.join("sessions.db")).arg(sql).status().unwrap().success());
    let mut ids: Vec<String> = list_devin(Path::new("/repo"), cli, 10).into_iter().map(|s| s.id).collect();
    ids.sort();
    assert_eq!(ids, ["dv-1", "dv-2"], "the db fills dv-2's folder and hides dv-3");
  }
}
