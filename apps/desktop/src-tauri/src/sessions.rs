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
  /// `claude`, `codex`, `gemini`, `opencode`, `copilot`, `cursor`, `qoder`, `codebuddy`, `droid`, `kiro`, `cline`, `kimi`, `devin`, `grok`, `hermes`, `jcode`, `openclaw`, `pi`, `zcode`, `muse`, `omp`, `rovo`, `antigravity` or `opencode2` (Orca's session history covers many CLIs).
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

// ---- Grok CLI (Orca ai-vault scanners/grok, shared/grok-session-paths.ts) ---------------------

/// Orca `GROK_SESSION_GROUP_SCAN_MAX_ENTRIES`: folders looked at per level, so a huge or corrupt
/// store cannot stall the listing.
const GROK_SCAN_MAX_ENTRIES: usize = 2048;

/// Orca `isSafeGrokSessionId`: 1 to 128 of `A-Z a-z 0-9 _ -` (official ids are UUIDs).
fn grok_safe_id(s: &str) -> bool {
  !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Grok's folder under `sessions/` for a working folder (Orca `grokEncodedCwdDirName`): the path
/// URL-encoded like `encodeURIComponent` with `!'()*` encoded too; above 255 bytes, a slug of the
/// last name (lowercase, runs of other characters as `-`, at most 40) and 16 hex of its BLAKE3.
pub fn grok_dir_name(cwd: &str) -> Option<String> {
  if cwd.trim().is_empty() {
    return None;
  }
  let mut encoded = String::new();
  for b in cwd.bytes() {
    if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
      encoded.push(b as char);
    } else {
      encoded.push_str(&format!("%{b:02X}"));
    }
  }
  if encoded == "." || encoded == ".." {
    return None;
  }
  if encoded.len() <= 255 {
    return Some(encoded);
  }
  let last = Path::new(cwd).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
  let mut slug = String::new();
  for c in last.to_lowercase().chars() {
    if c.is_ascii_lowercase() || c.is_ascii_digit() {
      slug.push(c);
    } else if !slug.ends_with('-') {
      slug.push('-');
    }
  }
  let slug: String = slug.trim_matches('-').chars().take(40).collect();
  let hash = blake3::hash(cwd.as_bytes()).to_hex();
  Some(format!("{}-{}", if slug.is_empty() { "workspace" } else { &slug }, &hash.as_str()[..16]))
}

/// The working folder a URL-encoded group name stands for (`None` for a slug+hash name).
fn grok_decoded_dir(name: &str) -> Option<String> {
  let b = name.as_bytes();
  let mut out = Vec::with_capacity(b.len());
  let mut i = 0;
  while i < b.len() {
    match b[i] {
      b'%' => {
        let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
        out.push(u8::from_str_radix(hex, 16).ok()?);
        i += 3;
      }
      c if c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.' | b'~') => {
        out.push(c);
        i += 1;
      }
      _ => return None,
    }
  }
  String::from_utf8(out).ok().filter(|d| Path::new(d).is_absolute())
}

/// A real folder or file, not a link out of Grok's store (Orca `isSafeChatHistoryFile`).
fn grok_plain(p: &Path, dir: bool) -> bool {
  std::fs::symlink_metadata(p).is_ok_and(|m| if dir { m.is_dir() } else { m.is_file() })
}

/// Orca `extractGrokFirstUserPromptText`'s parts: string content, or `text` parts of an array.
fn grok_flatten(v: &Value) -> Option<String> {
  match v {
    Value::String(s) => Some(s.clone()),
    Value::Array(items) => {
      let parts: Vec<&str> = items
        .iter()
        .filter_map(|i| match i {
          Value::String(s) => Some(s.as_str()),
          Value::Object(o) if o.get("type").and_then(Value::as_str).is_none_or(|t| t == "text") => o.get("text").and_then(Value::as_str),
          _ => None,
        })
        .collect();
      (!parts.is_empty()).then(|| parts.join("\n"))
    }
    _ => None,
  }
}

/// Orca `stripGrokUserQueryEnvelope`: the body of `<user_query>`, all of it when the closer is missing.
fn grok_strip_query(text: &str) -> String {
  let lower = text.to_ascii_lowercase();
  let Some(start) = lower.find("<user_query>") else { return text.to_owned() };
  let body = start + "<user_query>".len();
  match lower[body..].find("</user_query>") {
    Some(end) => text[body..body + end].trim().to_owned(),
    None => text[body..].trim().to_owned(),
  }
}

/// Orca `isGrokBootstrapContextText`: only `<user_info>` context (perhaps with a `<git_status>`).
fn grok_bootstrap(text: &str) -> bool {
  let n = text.trim().to_ascii_lowercase();
  if !n.starts_with("<user_info>") {
    return false;
  }
  let Some(end) = n.find("</user_info>") else { return !n.contains("<user_query>") };
  let rest = n[end + "</user_info>".len()..].trim();
  rest.is_empty() || (rest.starts_with("<git_status>") && rest.ends_with("</git_status>"))
}

/// Orca `extractGrokFirstUserPromptText`: the user's ask without Grok's context envelope.
fn grok_user_text(v: &Value) -> Option<String> {
  let raw = grok_flatten(v)?;
  if grok_bootstrap(&raw) {
    return None;
  }
  let t = grok_strip_query(&raw).trim().to_owned();
  if t.is_empty() || grok_bootstrap(&t) {
    return None;
  }
  let lower = t.to_ascii_lowercase();
  if (lower.starts_with("<user_info>") || lower.starts_with("<user_info ")) && !lower.contains("<user_query>") {
    return None;
  }
  Some(t)
}

/// One Grok session (`<sessions>/<encoded cwd>/<id>/summary.json` with `chat_history.jsonl` beside
/// it, Orca `parseGrokSessionFile`): the summary gives the id, folder, title, model, branch, count
/// and times; the history the `user` / `assistant` turns.
pub fn read_grok(summary_path: &Path) -> Option<Session> {
  let dir = summary_path.parent()?;
  let dir_name = dir.file_name()?.to_str()?;
  if !grok_safe_id(dir_name) || summary_path.file_name()? != "summary.json" || !grok_plain(summary_path, false) {
    return None;
  }
  let summary: Value = serde_json::from_slice(&std::fs::read(summary_path).ok()?).ok()?;
  summary.as_object()?;
  let str_at = |v: &Value, p: &str| v.pointer(p).and_then(Value::as_str).map(str::trim).filter(|x| !x.is_empty()).map(str::to_owned);
  // The id is a resume argument: Grok's own when safe, else the folder's (already checked).
  let id = str_at(&summary, "/info/id").filter(|i| grok_safe_id(i)).unwrap_or_else(|| dir_name.to_owned());
  let count = ["/num_chat_messages", "/num_messages"].iter().filter_map(|p| summary.pointer(p).and_then(Value::as_u64)).find(|n| *n > 0).unwrap_or(0);
  let mut s = Session {
    id,
    title: str_at(&summary, "/generated_title").or_else(|| str_at(&summary, "/session_summary")).map(|t| short(&t, 120)).unwrap_or_default(),
    preview: None,
    cwd: str_at(&summary, "/info/cwd"),
    branch: str_at(&summary, "/head_branch"),
    model: str_at(&summary, "/current_model_id"),
    messages: 0,
    created: 0,
    updated: 0,
    path: summary_path.display().to_string(),
    agent: "grok",
  };
  for k in ["created_at", "updated_at", "last_active_at"] {
    widen(&mut s, summary.get(k).and_then(when_of));
  }
  let mut first_prompt: Option<String> = None;
  let mut turns = 0u32;
  // A summary-only session still lists (Orca ignores a missing or unreadable history).
  let history = dir.join("chat_history.jsonl");
  let text = if grok_plain(&history, false) { std::fs::read(&history).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default() } else { String::new() };
  for line in text.lines() {
    let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
    let role = v.get("type").and_then(Value::as_str).unwrap_or("");
    let Some(content) = v.get("content") else { continue };
    let t = match role {
      "user" => grok_user_text(content),
      "assistant" => match content {
        Value::String(c) => Some(grok_strip_query(c)),
        other => text_of(other),
      },
      _ => continue,
    };
    let Some(t) = t.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty()) else { continue };
    turns += 1;
    widen(&mut s, v.get("timestamp").and_then(when_of));
    if role == "user" {
      first_prompt.get_or_insert_with(|| t.clone());
    }
    s.preview = Some(short(&format!("{}: {t}", if role == "user" { "You" } else { "Agent" }), 240));
  }
  s.messages = if count > 0 { u32::try_from(count).unwrap_or(u32::MAX) } else { turns };
  if s.title.is_empty() {
    s.title = first_prompt.map_or_else(|| "Untitled session".into(), |t| short(&t, 120));
  }
  Some(s)
}

/// Grok sessions of `root` (`sessions` is `$GROK_HOME/sessions`, else `~/.grok/sessions`). Only the
/// groups of `root`'s folders are opened: the exact names of `dirs` (the folder and its worktrees,
/// long ones in the slug+hash form) and URL-encoded names of any folder inside `root`.
pub fn list_grok(root: &Path, dirs: &[PathBuf], sessions: &Path, limit: usize) -> Vec<Session> {
  let exact: Vec<String> = dirs.iter().filter_map(|d| d.to_str()).filter_map(grok_dir_name).collect();
  let mut files: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
  let groups = std::fs::read_dir(sessions).into_iter().flatten().flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).take(GROK_SCAN_MAX_ENTRIES);
  for g in groups {
    let Some(name) = g.file_name().to_str().map(str::to_owned) else { continue };
    if !exact.contains(&name) && !grok_decoded_dir(&name).is_some_and(|d| inside(root, &d)) {
      continue;
    }
    let ids = std::fs::read_dir(g.path()).into_iter().flatten().flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).take(GROK_SCAN_MAX_ENTRIES);
    for e in ids {
      if !e.file_name().to_str().is_some_and(grok_safe_id) {
        continue;
      }
      let summary = e.path().join("summary.json");
      if grok_plain(&summary, false) {
        files.push((modified(&summary), summary));
      }
    }
  }
  newest_of(root, files, limit, read_grok)
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
/// OpenCode's store or ZCode's (`zcode`: the same schema, whose hidden
/// transcript messages are left out, Orca `zcodeVisibleMessageFilter`).
pub fn store_query(session_cols: &[String], message_cols: &[String], part_cols: &[String], root: &Path, limit: usize, zcode: bool) -> Option<String> {
  let has = |cols: &[String], c: &str| cols.iter().any(|x| x == c);
  if !["id", "time_created", "time_updated", "directory"].iter().all(|c| has(session_cols, c)) {
    return None;
  }
  let col = |c: &str| if has(session_cols, c) { format!("s.{c}") } else { "NULL".into() };
  let messages = ["session_id", "data"].iter().all(|c| has(message_cols, c));
  let parts = messages && has(message_cols, "id") && ["message_id", "time_created", "data"].iter().all(|c| has(part_cols, c));
  let visible = if zcode { " AND COALESCE(json_extract(m.data, '$.semantics.transcriptVisibility'), 'visible') != 'hidden'" } else { "" };
  let count = if messages { format!("(SELECT COUNT(*) FROM message m WHERE m.session_id = s.id AND json_extract(m.data, '$.role') IN ('user','assistant'){visible})") } else { "0".into() };
  let last = if parts {
    format!("(SELECT json_object('role', json_extract(m.data, '$.role'), 'text', json_extract(p.data, '$.text')) FROM message m JOIN part p ON p.message_id = m.id WHERE m.session_id = s.id AND json_extract(m.data, '$.role') IN ('user','assistant') AND json_extract(p.data, '$.type') = 'text'{visible} ORDER BY p.time_created DESC LIMIT 1)")
  } else {
    "NULL".into()
  };
  let first = if parts {
    format!("(SELECT json_extract(p.data, '$.text') FROM message m JOIN part p ON p.message_id = m.id WHERE m.session_id = s.id AND json_extract(m.data, '$.role') = 'user' AND json_extract(p.data, '$.type') = 'text'{visible} ORDER BY p.time_created ASC LIMIT 1)")
  } else {
    "NULL".into()
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

/// One row of [`store_query`] as a session of `agent` (`path` is `<db>#<session id>`, Orca's candidate path).
pub fn store_session(row: &serde_json::Map<String, Value>, db: &Path, agent: &'static str) -> Option<Session> {
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
    agent,
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
  list_store(dbs, root, limit, "opencode")
}

/// ZCode sessions of `root`: its CLI keeps OpenCode's schema in `~/.zcode/cli/db/db.sqlite`
/// (Orca's `scanners/zcode`, kept apart from OpenCode's rows). Orca orders a transcript by ZCode's
/// `sequence` column; Kingu takes the first and latest text by time.
pub fn list_zcode(db: &Path, root: &Path, limit: usize) -> Vec<Session> {
  if !db.is_file() {
    return Vec::new();
  }
  list_store(&[db.to_path_buf()], root, limit, "zcode")
}

/// OpenCode 2 sessions of `root`: current releases keep `session_v2` / `session_message` tables in
/// the same `opencode*.db` files as v1 (Orca's `scanners/opencode2`; databases without them are skipped).
pub fn list_opencode2(dbs: &[PathBuf], root: &Path, limit: usize) -> Vec<Session> {
  list_store(dbs, root, limit, "opencode2")
}

/// An OpenCode 2 message's text (Orca `extractOpenCode2MessageText`, in SQL): `text` as a string
/// or a list of strings, else the `text` items of `content`. Malformed rows give NULL, not an error.
const OPENCODE2_TEXT: &str = "CASE WHEN json_valid(m.data) THEN CASE json_type(m.data, '$.text') \
  WHEN 'text' THEN json_extract(m.data, '$.text') \
  WHEN 'array' THEN (SELECT group_concat(j.value, char(10)) FROM json_each(m.data, '$.text') j WHERE j.type = 'text') \
  ELSE CASE WHEN json_type(m.data, '$.content') = 'array' THEN (SELECT group_concat(CASE WHEN j.type = 'object' THEN json_extract(j.value, '$.text') END, char(10)) FROM json_each(m.data, '$.content') j \
    WHERE CASE WHEN j.type = 'object' THEN json_extract(j.value, '$.type') = 'text' AND json_type(j.value, '$.text') = 'text' ELSE 0 END) END END END";

/// [`store_query`]'s columns for OpenCode 2's `session_v2` (Orca's list and parse queries): top-level,
/// unarchived sessions of `root`, the `user` / `assistant` message count, the first user message and
/// the latest text among the newest 100 messages (Orca's bounded preview window).
pub fn opencode2_query(session_cols: &[String], message_cols: &[String], root: &Path, limit: usize) -> Option<String> {
  let has = |cols: &[String], c: &str| cols.iter().any(|x| x == c);
  if !["id", "time_created", "time_updated", "directory"].iter().all(|c| has(session_cols, c)) {
    return None;
  }
  let col = |c: &str| if has(session_cols, c) { format!("s.{c}") } else { "NULL".into() };
  let messages = ["session_id", "type"].iter().all(|c| has(message_cols, c));
  let read = messages && ["data", "time_created", "seq"].iter().all(|c| has(message_cols, c));
  let count = if messages { "(SELECT COUNT(*) FROM session_message m WHERE m.session_id = s.id AND m.type IN ('user','assistant'))".into() } else { "0".to_owned() };
  let (last, first) = if read {
    (
      format!("(SELECT json_object('role', x.type, 'text', x.t) FROM (SELECT m.type AS type, {OPENCODE2_TEXT} AS t, m.time_created AS tc, m.seq AS sq FROM session_message m WHERE m.session_id = s.id AND m.type IN ('user','assistant') ORDER BY m.time_created DESC, m.seq DESC LIMIT 100) x WHERE trim(COALESCE(x.t, '')) != '' ORDER BY x.tc DESC, x.sq DESC LIMIT 1)"),
      format!("(SELECT {OPENCODE2_TEXT} FROM session_message m WHERE m.session_id = s.id AND m.type = 'user' ORDER BY m.time_created ASC, m.seq ASC LIMIT 1)"),
    )
  } else {
    ("NULL".into(), "NULL".into())
  };
  let top = if has(session_cols, "parent_id") { " AND s.parent_id IS NULL" } else { "" };
  let live = if has(session_cols, "time_archived") { " AND s.time_archived IS NULL" } else { "" };
  let r = root.to_string_lossy();
  let below = format!("{}/", r.trim_end_matches('/'));
  Some(format!(
    "SELECT s.id, {title} AS title, s.directory, s.time_created, s.time_updated, {model} AS model_json, {count} AS message_count, {last} AS last, {first} AS first_prompt \
     FROM session_v2 s WHERE (s.directory = {root} OR substr(s.directory, 1, {n}) = {below}){top}{live} \
     ORDER BY CASE WHEN s.time_updated > 0 THEN s.time_updated ELSE s.time_created END DESC LIMIT {limit}",
    title = col("title"),
    model = col("model"),
    root = sql_text(&r),
    n = below.chars().count(),
    below = sql_text(&below),
  ))
}

/// One [`opencode2_query`] row: as [`store_session`], with a bare model id accepted (Orca
/// `extractModelId`: a plain id or JSON with `id` / `modelID`) and an id safe to resume.
fn opencode2_session(row: &serde_json::Map<String, Value>, db: &Path) -> Option<Session> {
  let mut s = store_session(row, db, "opencode2").filter(|s| safe_id(&s.id))?;
  if s.model.is_none() {
    s.model = row.get("model_json").and_then(Value::as_str).map(str::trim).filter(|m| !m.is_empty() && !m.starts_with('{')).map(str::to_owned);
  }
  Some(s)
}

fn list_store(dbs: &[PathBuf], root: &Path, limit: usize, agent: &'static str) -> Vec<Session> {
  let mut out: Vec<Session> = Vec::new();
  for db in dbs {
    let sql = if agent == "opencode2" {
      opencode2_query(&column_names(db, "session_v2"), &column_names(db, "session_message"), root, limit)
    } else {
      store_query(&column_names(db, "session"), &column_names(db, "message"), &column_names(db, "part"), root, limit, agent == "zcode")
    };
    let Some(sql) = sql else { continue };
    match crate::accounts::managed::sqlite_rows(db, &sql) {
      Ok(rows) => out.extend(rows.iter().filter_map(|r| if agent == "opencode2" { opencode2_session(r, db) } else { store_session(r, db, agent) })),
      Err(e) => log::warn!("{agent} sessions in {}: {e}", db.display()),
    }
  }
  // The same session in two databases (a copied store): keep the newest.
  out.sort_by_key(|s| std::cmp::Reverse(s.updated));
  let mut seen = std::collections::HashSet::new();
  out.retain(|s| seen.insert(s.id.clone()));
  out.truncate(limit);
  out
}

// ---- Hermes and jcode (Orca ai-vault scanners/hermes, scanners/jcode) ------------------------

/// Orca `sessionIdFromFileName`: the trailing uuid of the file stem, else the whole stem.
fn id_from_file_name(path: &Path) -> Option<String> {
  let stem = path.file_stem()?.to_str()?;
  let tail = stem.get(stem.len().saturating_sub(36)..).unwrap_or("");
  let uuid = tail.len() == 36 && tail.char_indices().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { c == '-' } else { c.is_ascii_hexdigit() });
  Some(if uuid { tail } else { stem }.to_owned())
}

/// `session_*.json` files in `dir` and one folder level below (Orca's `filePredicate`; live
/// journals and backups have other names). Symlinks are not followed.
fn session_json_files(dir: &Path) -> Vec<(std::time::SystemTime, PathBuf)> {
  let mut out = Vec::new();
  let visit = |d: &Path, out: &mut Vec<(std::time::SystemTime, PathBuf)>, subdirs: &mut Vec<PathBuf>| {
    for e in std::fs::read_dir(d).into_iter().flatten().flatten().take(4096) {
      let Ok(t) = e.file_type() else { continue };
      let name = e.file_name();
      let name = name.to_string_lossy();
      if t.is_dir() {
        subdirs.push(e.path());
      } else if t.is_file() && name.starts_with("session_") && name.ends_with(".json") {
        out.push((modified(&e.path()), e.path()));
      }
    }
  };
  let mut subdirs = Vec::new();
  visit(dir, &mut out, &mut subdirs);
  for sub in subdirs.into_iter().take(2048) {
    visit(&sub, &mut out, &mut Vec::new());
  }
  out
}

fn str_field(v: &Value, k: &str) -> Option<String> {
  v.get(k).and_then(Value::as_str).map(str::trim).filter(|x| !x.is_empty()).map(str::to_owned)
}

/// One turn's text into the session's title (the first user turn) and preview (the latest).
fn take_turn(s: &mut Session, title: &mut Option<String>, role: &str, text: Option<String>) {
  let Some(t) = text.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty()) else { return };
  if role == "user" && title.is_none() {
    *title = Some(short(&t, 120));
  }
  let who = match role {
    "user" => "You",
    "assistant" => "Agent",
    _ => return,
  };
  s.preview = Some(short(&format!("{who}: {t}"), 240));
}

/// One Hermes session (`session_*.json`, Orca `parseHermesSessionRecord`): `session_id`, `model`,
/// `cwd`, `session_start` / `last_updated`, and its `user` / `assistant` messages (the first user
/// turn is the title); `message_count` when it lists no messages.
pub fn read_hermes(path: &Path) -> Option<Session> {
  let v: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
  v.as_object()?;
  let id = str_field(&v, "session_id").or_else(|| id_from_file_name(path)).filter(|i| safe_id(i))?;
  let mut s = Session { id, title: String::new(), preview: None, cwd: str_field(&v, "cwd"), branch: None, model: str_field(&v, "model"), messages: 0, created: 0, updated: 0, path: path.display().to_string(), agent: "hermes" };
  widen(&mut s, v.get("session_start").and_then(when_of));
  widen(&mut s, v.get("last_updated").and_then(when_of));
  let mut title = None;
  for m in v.get("messages").and_then(Value::as_array).into_iter().flatten() {
    let role = m.get("role").and_then(Value::as_str).unwrap_or("");
    if role != "user" && role != "assistant" {
      continue;
    }
    s.messages += 1;
    take_turn(&mut s, &mut title, role, m.get("content").and_then(text_of));
  }
  if s.messages == 0 {
    s.messages = v.get("message_count").and_then(Value::as_u64).unwrap_or(0).min(u32::MAX as u64) as u32;
  }
  s.title = title.unwrap_or_else(|| "Untitled session".into());
  Some(s)
}

/// Hermes sessions of `root` (`$HERMES_HOME/sessions`, else `~/.hermes/sessions`).
pub fn list_hermes(root: &Path, sessions: &Path, limit: usize) -> Vec<Session> {
  newest_of(root, session_json_files(sessions), limit, read_hermes)
}

/// Orca's `isInjectedContextMessage` for jcode: system and background-task turns, scheduled runs
/// and system reminders are not conversation.
fn jcode_injected(m: &Value) -> bool {
  let display = m.get("display_role").and_then(Value::as_str);
  if matches!(display, Some("system" | "background_task")) || m.get("role").and_then(Value::as_str) == Some("system") {
    return true;
  }
  let text = m.get("content").and_then(text_of).unwrap_or_default();
  text.starts_with("[Scheduled task]") || text.starts_with("<system-reminder>")
}

/// One jcode session (`session_*.json`, Orca `foldJcodeSessionContent`): `id` / `session_id`,
/// `model`, `custom_title` / `title` (kept over the first prompt), `working_dir` /
/// `working_directory`, `created_at` / `updated_at`, and every non-injected message.
pub fn read_jcode(path: &Path) -> Option<Session> {
  let v: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
  v.as_object()?;
  let id = str_field(&v, "id").or_else(|| str_field(&v, "session_id")).or_else(|| id_from_file_name(path)).filter(|i| safe_id(i))?;
  let cwd = str_field(&v, "working_dir").or_else(|| str_field(&v, "working_directory"));
  let mut s = Session { id, title: String::new(), preview: None, cwd, branch: None, model: str_field(&v, "model"), messages: 0, created: 0, updated: 0, path: path.display().to_string(), agent: "jcode" };
  let mut title = str_field(&v, "custom_title").or_else(|| str_field(&v, "title")).map(|t| short(&t, 120)).filter(|t| !t.is_empty());
  widen(&mut s, v.get("created_at").and_then(when_of));
  widen(&mut s, v.get("updated_at").and_then(when_of));
  for m in v.get("messages").and_then(Value::as_array).into_iter().flatten() {
    if !m.is_object() || jcode_injected(m) {
      continue;
    }
    widen(&mut s, m.get("timestamp").and_then(when_of));
    s.messages += 1;
    let role = m.get("role").and_then(Value::as_str).unwrap_or("");
    take_turn(&mut s, &mut title, role, m.get("content").and_then(text_of));
  }
  s.title = title.unwrap_or_else(|| "Untitled session".into());
  Some(s)
}

/// jcode sessions of `root` (`$JCODE_HOME/sessions`, else `~/.jcode/sessions`).
pub fn list_jcode(root: &Path, sessions: &Path, limit: usize) -> Vec<Session> {
  newest_of(root, session_json_files(sessions), limit, read_jcode)
}

// ---- OpenClaw and Pi (Orca ai-vault scanners/session-scanner-graph-parsers, scanners/openclaw) -

/// Orca `isOmpWrittenRecord`: OMP shares Pi's folder (it inherits `PI_CODING_AGENT_DIR`) and
/// writes records Pi never does.
fn omp_written(r: &Value) -> bool {
  let t = r.get("type").and_then(Value::as_str);
  (t == Some("title") && r.get("v").and_then(Value::as_i64) == Some(1))
    || r.get("runtime").is_some_and(Value::is_object)
    || (t == Some("model_change") && r.get("modelId").is_none() && str_field(r, "model").is_some())
}

/// One message-graph transcript (`.jsonl` of `session` / `model_change` / `message` records,
/// Orca `consumeMessageGraphRecordLine`): the `session` header gives the id and folder, the first
/// user message the title. `agent` is `openclaw`, `pi` or `omp`; a Pi-folder file OMP wrote is not Pi's.
pub fn read_graph(path: &Path, agent: &'static str) -> Option<Session> {
  graph(path, agent, false)
}

/// An OMP title record folded so far (Orca `OmpTranscriptTitle`).
#[derive(Clone)]
struct OmpTitle {
  title: String,
  user: bool,
  at: Option<i64>,
}

/// Orca `foldOmpTranscriptTitle`: OMP's persisted names (`title` v1 slots, `title_change`, the
/// `session` header's `title`, legacy `session_info` names); a user's name outlives automatic ones,
/// and an older record of the same source does not replace a newer one.
fn fold_omp_title(cur: Option<OmpTitle>, r: &Value) -> Option<OmpTitle> {
  let t = r.get("type").and_then(Value::as_str);
  let legacy = t == Some("session_info");
  if !legacy && !matches!(t, Some("session" | "title_change" | "title")) {
    return cur;
  }
  if t == Some("title") && r.get("v").and_then(Value::as_i64) != Some(1) {
    return cur;
  }
  let Some(title) = str_field(r, if legacy { "name" } else { "title" }).map(|x| short(&x, 120)).filter(|x| !x.is_empty()) else { return cur };
  let user = if legacy {
    true
  } else {
    match r.get("source").filter(|v| !v.is_null()).or_else(|| r.get("titleSource")).map(Value::as_str) {
      None => false,
      Some(Some("user")) => true,
      Some(Some("auto")) => false,
      Some(_) => return cur,
    }
  };
  if cur.as_ref().is_some_and(|c| c.user && !user) {
    return cur;
  }
  let at = r.get(if t == Some("title") { "updatedAt" } else { "timestamp" }).and_then(when_of);
  if let (Some(c), Some(a)) = (&cur, at)
    && c.user == user
    && c.at.is_some_and(|ca| a < ca)
  {
    return cur;
  }
  Some(OmpTitle { title, user, at })
}

/// [`read_graph`]; `omp_only`: a file in Pi's folder, an OMP session only once a record shows OMP wrote it.
fn graph(path: &Path, agent: &'static str, omp_only: bool) -> Option<Session> {
  let text = std::fs::read_to_string(path).ok()?;
  let mut s = Session { id: id_from_file_name(path)?, title: String::new(), preview: None, cwd: None, branch: None, model: None, messages: 0, created: 0, updated: 0, path: path.display().to_string(), agent };
  let mut title = None;
  let mut omp_title: Option<OmpTitle> = None;
  let mut omp_marked = false;
  for line in text.lines() {
    let Ok(r) = serde_json::from_str::<Value>(line) else { continue };
    if !r.is_object() {
      continue;
    }
    if omp_written(&r) {
      if agent == "pi" {
        return None;
      }
      omp_marked = true;
    }
    widen(&mut s, r.get("timestamp").and_then(when_of));
    if agent == "omp" {
      omp_title = fold_omp_title(omp_title, &r);
    }
    match r.get("type").and_then(Value::as_str) {
      Some("session") => {
        if let Some(id) = str_field(&r, "id") {
          s.id = id;
        }
        s.cwd = str_field(&r, "cwd").or(s.cwd.take());
      }
      Some("model_change") => s.model = str_field(&r, "modelId").or_else(|| str_field(&r, "model")).or(s.model.take()),
      Some("message") => {
        let Some(m) = r.get("message") else { continue };
        let role = m.get("role").and_then(Value::as_str).unwrap_or("");
        if role != "user" && role != "assistant" {
          continue;
        }
        s.messages += 1;
        if role == "assistant" {
          s.model = str_field(m, "model").or(s.model.take());
        }
        take_turn(&mut s, &mut title, role, m.get("content").and_then(text_of));
      }
      _ => {}
    }
  }
  if !safe_id(&s.id) || (omp_only && !omp_marked) {
    return None;
  }
  // OMP's stored name wins over the first prompt (Orca keeps the prompt as `fallbackTitle`).
  s.title = omp_title.map(|t| t.title).or(title).unwrap_or_else(|| "Untitled session".into());
  Some(s)
}

/// `.jsonl` files in the `sessions` folder of each agent under `agents` (OpenClaw's
/// `agents/<agent>/sessions/*.jsonl`; embedded tools' histories in other folders are left out).
fn openclaw_files(agents: &Path) -> Vec<(std::time::SystemTime, PathBuf)> {
  let mut out = Vec::new();
  for a in std::fs::read_dir(agents).into_iter().flatten().flatten().take(2048) {
    if !a.file_type().is_ok_and(|t| t.is_dir()) {
      continue;
    }
    for e in std::fs::read_dir(a.path().join("sessions")).into_iter().flatten().flatten().take(4096) {
      if e.file_type().is_ok_and(|t| t.is_file()) && e.path().extension().is_some_and(|x| x == "jsonl") {
        out.push((modified(&e.path()), e.path()));
      }
    }
  }
  out
}

/// OpenClaw sessions of `root`: each state folder's `agents` (`$OPENCLAW_STATE_DIR` or
/// `~/.openclaw`, and the legacy `~/.clawdbot`; Orca merges both).
pub fn list_openclaw(root: &Path, state_dirs: &[PathBuf], limit: usize) -> Vec<Session> {
  let files = state_dirs.iter().flat_map(|d| openclaw_files(&if d.file_name().is_some_and(|n| n == "agents") { d.clone() } else { d.join("agents") })).collect();
  newest_of(root, files, limit, |p| read_graph(p, "openclaw"))
}

/// Pi sessions of `root` (`$PI_CODING_AGENT_DIR`, else `~/.pi/agent/sessions`; one folder per
/// working folder, transcripts directly inside).
pub fn list_pi(root: &Path, sessions: &Path, limit: usize) -> Vec<Session> {
  let mut files = Vec::new();
  for d in std::fs::read_dir(sessions).into_iter().flatten().flatten().take(2048) {
    if !d.file_type().is_ok_and(|t| t.is_dir()) {
      continue;
    }
    for e in std::fs::read_dir(d.path()).into_iter().flatten().flatten().take(4096) {
      if e.file_type().is_ok_and(|t| t.is_file()) && e.path().extension().is_some_and(|x| x == "jsonl") {
        files.push((modified(&e.path()), e.path()));
      }
    }
  }
  newest_of(root, files, limit, |p| read_graph(p, "pi"))
}

// ---- Muse (Orca ai-vault scanners/muse) --------------------------------------------------------

/// Muse's `recorded_at`: microseconds (≥ 1e14) as ms, else the usual number or ISO forms.
fn muse_time(v: &Value) -> Option<i64> {
  match v.as_f64() {
    Some(x) if x >= 1e14 => Some((x / 1000.0) as i64),
    _ => when_of(v),
  }
}

/// Orca `unwrapMuseLogRecords`: a batch line's `children[].record_json`, else the line itself.
fn muse_records(line: &Value) -> Vec<Value> {
  match line.get("children").and_then(Value::as_array) {
    None => vec![line.clone()],
    Some(children) => children
      .iter()
      .filter_map(|c| {
        let raw = c.get("record_json")?;
        let v = match raw {
          Value::String(s) => serde_json::from_str(s).ok()?,
          v => v.clone(),
        };
        v.is_object().then_some(v)
      })
      .collect(),
  }
}

fn first_text_block(v: Option<&Value>) -> Option<String> {
  v?.as_array()?.iter().find_map(|b| str_field(b, "text"))
}

/// One Muse session (`<day shard>/<uuid>/session.jsonl`, Orca `foldMuseRecord`): folder from the
/// session metadata (else route facts), branch, model, user intents and committed assistant
/// messages; a run's start prompt counts only when it doesn't repeat the intent just accepted.
pub fn read_muse(path: &Path) -> Option<Session> {
  let id = path.parent()?.file_name()?.to_str()?.to_owned();
  if !safe_id(&id) {
    return None;
  }
  let text = std::fs::read_to_string(path).ok()?;
  let mut s = Session { id, title: String::new(), preview: None, cwd: None, branch: None, model: None, messages: 0, created: 0, updated: 0, path: path.display().to_string(), agent: "muse" };
  let mut title = None;
  let mut last_user: (Option<String>, Option<i64>) = (None, None);
  for line in text.lines().filter(|l| !l.trim().is_empty()) {
    let Ok(env) = serde_json::from_str::<Value>(line) else { continue };
    if !env.is_object() {
      continue;
    }
    for r in muse_records(&env) {
      let at = r.get("recorded_at").and_then(muse_time);
      widen(&mut s, at);
      let Some(p) = r.get("payload").filter(|p| p.is_object()) else { continue };
      let rec = p.get("record").cloned().unwrap_or(Value::Null);
      let mut user = |s: &mut Session, text: Option<String>, dedupe: bool| {
        let Some(t) = text else { return };
        if dedupe && last_user.0.as_deref() == Some(t.as_str()) && matches!((last_user.1, at), (Some(a), Some(b)) if (a - b).abs() < 60_000) {
          return;
        }
        last_user = (Some(t.clone()), at);
        s.messages += 1;
        take_turn(s, &mut title, "user", Some(t));
      };
      match r.get("payload_type").and_then(Value::as_str) {
        Some("runtime.session.metadata") => s.cwd = s.cwd.take().or_else(|| str_field(&rec, "workspace_root")),
        Some("runtime.session.route_facts") => s.cwd = s.cwd.take().or_else(|| str_field(&rec, "cwd")),
        Some("session.workspace_branch.observed") => s.branch = s.branch.take().or_else(|| rec.get("reference").and_then(|r| str_field(r, "name"))),
        Some("run.model.configured") => s.model = s.model.take().or_else(|| str_field(&rec, "model_id")),
        Some("runtime.user_intent.accepted") => {
          let t = first_text_block(p.get("refill_blocks")).or_else(|| p.get("model_messages")?.as_array()?.iter().find_map(|m| first_text_block(m.get("content"))));
          user(&mut s, t, false);
        }
        Some("runtime.session") => {
          let Some(ev) = p.get("event") else { continue };
          match ev.get("kind").and_then(Value::as_str) {
            Some("started") => user(&mut s, str_field(ev, "prompt"), true),
            Some("assistant_message_committed") => {
              if let Some(t) = str_field(ev, "text") {
                s.messages += 1;
                take_turn(&mut s, &mut title, "assistant", Some(t));
              }
            }
            Some("model_completed") => s.model = s.model.take().or_else(|| str_field(ev, "model")),
            _ => {}
          }
        }
        _ => {}
      }
    }
  }
  s.title = title.unwrap_or_else(|| "Untitled session".into());
  Some(s)
}

/// Muse sessions of `root` (`$XDG_DATA_HOME/muse/sessions`, else `~/.local/share/muse/sessions`):
/// every `session.jsonl` up to five folders down (date shards, then the session id).
pub fn list_muse(root: &Path, sessions: &Path, limit: usize) -> Vec<Session> {
  let mut files = Vec::new();
  let mut dirs = vec![(sessions.to_path_buf(), 0usize)];
  let mut seen = 0usize;
  while let Some((d, depth)) = dirs.pop() {
    for e in std::fs::read_dir(&d).into_iter().flatten().flatten().take(4096) {
      seen += 1;
      if seen > 50_000 {
        break;
      }
      let Ok(t) = e.file_type() else { continue };
      if t.is_dir() && depth < 5 {
        dirs.push((e.path(), depth + 1));
      } else if t.is_file() && e.file_name() == "session.jsonl" {
        files.push((modified(&e.path()), e.path()));
      }
    }
  }
  newest_of(root, files, limit, read_muse)
}

// ---- OMP (Orca ai-vault scanners/omp, the message-graph parser) --------------------------------

/// Orca `normalizedOmpProfile`: `Some(None)` is the default profile, `None` a name OMP rejects.
fn omp_profile(v: Option<&str>) -> Option<Option<String>> {
  let p = v.map(str::trim).unwrap_or("");
  if p.is_empty() || p == "default" {
    return Some(None);
  }
  let b = p.as_bytes();
  let reserved = {
    let stem = p.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit())
  };
  let ok = b.len() <= 64 && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-')) && !p.ends_with('.') && !reserved;
  ok.then(|| Some(p.to_owned()))
}

/// Orca `normalizeAgentSessionsDir(…, '.omp')`: a sessions folder, an agent folder or an `.omp` home.
fn omp_agent_sessions(home: &Path, raw: &str) -> PathBuf {
  let t = raw.trim().trim_end_matches(['/', '\\']);
  if t.is_empty() {
    return home.join(".omp").join("agent").join("sessions");
  }
  let p = PathBuf::from(t);
  match p.file_name().and_then(|n| n.to_str()) {
    Some("sessions") => p,
    Some("agent") => p.join("sessions"),
    Some(".omp") => p.join("agent").join("sessions"),
    _ => p,
  }
}

/// OMP's session folders (Orca `ompSessionsRootDirs`: `resolveOmpSessionsDir` mirroring OMP's
/// dirs.ts, then every named profile's existing store). `env` reads a variable. A relative or
/// root-folder override gives no folder.
pub fn omp_sessions_dirs(home: &Path, env: &dyn Fn(&str) -> Option<String>) -> Vec<PathBuf> {
  let usable = |p: PathBuf| (p.is_absolute() && p.parent().is_some()).then_some(p);
  let set = |k: &str| env(k).filter(|v| !v.is_empty());
  if let Some(d) = env("OMP_CODING_AGENT_DIR").filter(|v| !v.trim().is_empty()) {
    // The legacy override pins one location; no profile enumeration.
    return usable(omp_agent_sessions(home, &d)).into_iter().collect();
  }
  let mut out = Vec::new();
  // Node's `join(home, PI_CONFIG_DIR)`: an absolute value still lands under the home folder.
  let base = home.join(set("PI_CONFIG_DIR").map_or_else(|| ".omp".into(), |c| c.trim_start_matches(['/', '\\']).to_owned()));
  let xdg = if cfg!(unix) { set("XDG_DATA_HOME").map(PathBuf::from) } else { None };
  let raw = env("OMP_PROFILE").or_else(|| env("PI_PROFILE"));
  if let Some(profile) = omp_profile(raw.as_deref()) {
    let config_root = profile.as_ref().map_or_else(|| base.clone(), |p| base.join("profiles").join(p));
    let default_agent = config_root.join("agent");
    let inherited = omp_profile(env("PI_PROFILE").as_deref()).flatten().map(|p| base.join("profiles").join(p).join("agent"));
    let over = set("PI_CODING_AGENT_DIR").filter(|o| profile.is_none() && inherited.as_deref() != Some(Path::new(o)));
    let agent_dir = over.map_or_else(|| Some(default_agent.clone()), |o| usable(PathBuf::from(o)));
    if let Some(agent_dir) = agent_dir {
      let data_root = xdg.as_ref().filter(|_| agent_dir == default_agent).map(|x| profile.as_ref().map_or_else(|| x.join("omp"), |p| x.join("omp").join("profiles").join(p))).filter(|d| d.is_dir());
      out.push(data_root.map_or_else(|| agent_dir.join("sessions"), |d| d.join("sessions")));
    }
  }
  let profiles = base.join("profiles");
  let xdg_profiles = xdg.map(|x| x.join("omp").join("profiles"));
  let mut names: Vec<String> = [Some(&profiles), xdg_profiles.as_ref()]
    .into_iter()
    .flatten()
    .flat_map(|d| std::fs::read_dir(d).into_iter().flatten().flatten().take(256))
    .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
    .filter_map(|e| e.file_name().to_str().map(str::to_owned))
    .filter(|n| omp_profile(Some(n)).flatten().as_deref() == Some(n.as_str()))
    .collect();
  names.sort();
  names.dedup();
  for n in names {
    // OMP writes to the profile's XDG folder once it exists, so it comes first.
    out.extend(xdg_profiles.iter().map(|x| x.join(&n).join("sessions")).chain([profiles.join(&n).join("agent").join("sessions")]).filter(|d| d.is_dir()));
  }
  let mut seen = std::collections::HashSet::new();
  out.retain(|d| seen.insert(d.clone()));
  out
}

/// Orca `OMP_SESSION_ARTIFACT_DIR_PATTERN`: `<YYYY-MM-DDTHH-MM-SS-mmmZ>_<uuid>`, a conversation's task
/// artifact folder (subagent transcripts, counted under their parent rather than listed).
fn omp_artifact_dir(name: &str) -> bool {
  let Some((stamp, id)) = name.split_once('_') else { return false };
  let b = stamp.as_bytes();
  b.len() == 24
    && crate::accounts::managed::is_uuid(id)
    && b.iter().enumerate().all(|(i, c)| match i {
      4 | 7 | 13 | 16 | 19 => *c == b'-',
      10 => c.eq_ignore_ascii_case(&b'T'),
      23 => c.eq_ignore_ascii_case(&b'Z'),
      _ => c.is_ascii_digit(),
    })
}

/// OMP's `.jsonl` transcripts under `dir` (Orca `isOmpConversationDirectory`: workspace buckets, not
/// task artifact folders), at most four folders down; symlinks are not followed.
fn omp_files(dir: &Path) -> Vec<(std::time::SystemTime, PathBuf)> {
  let mut out = Vec::new();
  let mut stack = vec![(dir.to_path_buf(), 0usize)];
  let mut seen = 0usize;
  while let Some((d, level)) = stack.pop() {
    for e in std::fs::read_dir(&d).into_iter().flatten().flatten().take(4096) {
      seen += 1;
      if seen > 50_000 {
        return out;
      }
      let Ok(t) = e.file_type() else { continue };
      let p = e.path();
      if t.is_dir() && level < 4 && (level == 0 || !e.file_name().to_str().is_some_and(omp_artifact_dir)) {
        stack.push((p, level + 1));
      } else if t.is_file() && p.extension().is_some_and(|x| x == "jsonl") {
        out.push((modified(&p), p));
      }
    }
  }
  out
}

/// OMP sessions of `root`: every transcript in OMP's own folders, and those in Pi's folder (`pi`;
/// OMP inherits `PI_CODING_AGENT_DIR`) that hold a record only OMP writes (Orca `isOmpWrittenRecord`).
pub fn list_omp(root: &Path, dirs: &[PathBuf], pi: &Path, limit: usize) -> Vec<Session> {
  let mut files: Vec<(std::time::SystemTime, PathBuf)> = dirs.iter().flat_map(|d| omp_files(d)).collect();
  let own: std::collections::HashSet<PathBuf> = files.iter().map(|f| f.1.clone()).collect();
  let pi_files: Vec<_> = omp_files(pi).into_iter().filter(|f| !own.contains(&f.1)).collect();
  let in_pi: std::collections::HashSet<PathBuf> = pi_files.iter().map(|f| f.1.clone()).collect();
  files.extend(pi_files);
  newest_of(root, files, limit, |p| graph(p, "omp", in_pi.contains(p)))
}

// ---- Rovo Dev (Orca ai-vault scanners/session-scanner-graph-parsers, session-scanner-rovo-metadata) -

/// The first non-blank string among `keys` (Orca `firstString`).
fn first_str(v: &Value, keys: &[&str]) -> Option<String> {
  keys.iter().find_map(|k| str_field(v, k))
}

/// Orca `extractContentText` for Rovo: a string, or the strings / `text` / `content` of a list.
fn loose_text(v: &Value) -> Option<String> {
  match v {
    Value::String(s) => Some(s.clone()),
    Value::Array(items) => {
      let t: Vec<&str> = items.iter().filter_map(|i| i.as_str().or_else(|| i.get("text").and_then(Value::as_str)).or_else(|| i.get("content").and_then(Value::as_str))).filter(|t| !t.trim().is_empty()).collect();
      (!t.is_empty()).then(|| t.join(" "))
    }
    _ => None,
  }
}

/// A regular file (not a symlink) of at most `max` bytes, as text.
fn small_file(p: &Path, max: u64) -> Option<String> {
  let m = std::fs::symlink_metadata(p).ok()?;
  if !m.is_file() || m.len() > max {
    return None;
  }
  std::fs::read_to_string(p).ok()
}

/// One Rovo Dev session (`~/.rovodev/sessions/<id>/metadata.json` with its `session_context.json`,
/// Orca `parseRovoSessionFile`): the metadata gives the title, folder and times; the context's
/// `messages` and `message_history` (request / response `parts`) the turns.
pub fn read_rovo(meta_path: &Path) -> Option<Session> {
  let id = meta_path.parent()?.file_name()?.to_str()?.to_owned();
  if !safe_id(&id) {
    return None;
  }
  let meta: Value = serde_json::from_str(&small_file(meta_path, 16 << 20)?).ok()?;
  meta.as_object()?;
  let cwd = first_str(&meta, &["workspace_path", "workspacePath", "workspace", "cwd", "working_directory", "workingDirectory", "project_path", "projectPath"]);
  let mut s = Session { id, title: String::new(), preview: None, cwd, branch: None, model: None, messages: 0, created: 0, updated: 0, path: meta_path.display().to_string(), agent: "rovo" };
  let mut title = first_str(&meta, &["title", "name", "summary"]).map(|t| short(&t, 120));
  widen(&mut s, meta.get("created_at").or_else(|| meta.get("createdAt")).and_then(when_of));
  widen(&mut s, meta.get("updated_at").or_else(|| meta.get("updatedAt")).and_then(when_of));
  let context: Value = small_file(&meta_path.with_file_name("session_context.json"), 64 << 20).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
  for m in context.get("messages").and_then(Value::as_array).into_iter().flatten() {
    let role = m.get("role").and_then(Value::as_str).unwrap_or("");
    if role != "user" && role != "assistant" {
      continue;
    }
    s.messages += 1;
    widen(&mut s, m.get("timestamp").and_then(when_of));
    take_turn(&mut s, &mut title, role, m.get("content").and_then(loose_text));
  }
  for e in context.get("message_history").and_then(Value::as_array).into_iter().flatten() {
    widen(&mut s, e.get("timestamp").and_then(when_of));
    let role = match (e.get("role").and_then(Value::as_str), e.get("kind").and_then(Value::as_str)) {
      (Some(r), _) => r,
      (None, Some("request")) => "user",
      (None, Some("response")) => "assistant",
      _ => continue,
    };
    if role != "user" && role != "assistant" {
      continue;
    }
    // Orca `rovoTextParts`: user prompts and text parts; tool calls and returns are not turns.
    let parts: Vec<&str> = e
      .get("parts")
      .and_then(Value::as_array)
      .into_iter()
      .flatten()
      .filter(|p| match p.get("part_kind").and_then(Value::as_str) {
        Some("text") => true,
        Some("user-prompt") => role == "user",
        _ => false,
      })
      .filter_map(|p| p.get("content").and_then(Value::as_str).or_else(|| p.get("text").and_then(Value::as_str)))
      .collect();
    if parts.is_empty() {
      continue;
    }
    s.messages += 1;
    take_turn(&mut s, &mut title, role, Some(parts.join(" ")));
  }
  s.title = title.unwrap_or_else(|| "Untitled session".into());
  Some(s)
}

/// Rovo Dev sessions of `root` (`~/.rovodev/sessions/<id>/metadata.json`).
pub fn list_rovo(root: &Path, sessions: &Path, limit: usize) -> Vec<Session> {
  let mut files = Vec::new();
  for d in std::fs::read_dir(sessions).into_iter().flatten().flatten().take(4096) {
    if !d.file_type().is_ok_and(|t| t.is_dir()) {
      continue;
    }
    let meta = d.path().join("metadata.json");
    if std::fs::symlink_metadata(&meta).is_ok_and(|m| m.is_file()) {
      let t = modified(&meta).max(modified(&d.path().join("session_context.json")));
      files.push((t, meta));
    }
  }
  newest_of(root, files, limit, read_rovo)
}

// ---- Antigravity CLI (Orca ai-vault scanners/antigravity) --------------------------------------

/// Orca `extractAntigravityUserRequest`: the `<USER_REQUEST>` body, else the whole content.
fn ag_request(content: &str) -> Option<String> {
  const OPEN: &str = "<USER_REQUEST>";
  let body = match content.find(OPEN) {
    None => content,
    Some(i) => {
      let rest = &content[i + OPEN.len()..];
      rest.find("</USER_REQUEST>").map_or(rest, |e| &rest[..e])
    }
  };
  let t = body.trim();
  (!t.is_empty()).then(|| t.to_owned())
}

/// Orca `antigravityHistoryPromptHash`: the SHA-256 of a prompt with its whitespace folded, for a
/// prompt short enough to be stored whole (a title cut to 96 UTF-16 units cannot identify one).
fn ag_prompt_hash(v: &str) -> Option<String> {
  use sha2::{Digest, Sha256};
  if v.encode_utf16().count() > 4096 {
    return None;
  }
  let p = v.split_whitespace().collect::<Vec<_>>().join(" ");
  if p.is_empty() || p.encode_utf16().count() > 96 || p.ends_with("...") {
    return None;
  }
  Some(Sha256::digest(p.as_bytes()).iter().map(|b| format!("{b:02x}")).collect())
}

/// Where Antigravity's own indexes place its conversations (Orca `AntigravityHistoryIndex`): by
/// conversation id (`None` when sources disagree), and by opening-prompt hash with the time.
#[derive(Default)]
struct AgIndex {
  by_id: std::collections::HashMap<String, Option<String>>,
  by_prompt: std::collections::HashMap<String, Vec<(i64, String)>>,
}

/// Records `id → path` once; a second, different path marks the id ambiguous (Orca `unique`).
fn ag_unique(map: &mut std::collections::HashMap<String, Option<String>>, id: &str, path: Option<&str>) {
  if id.is_empty() || id.len() > 512 || path.is_some_and(|p| p.is_empty() || p.len() > 4096) {
    return;
  }
  match map.get(id) {
    Some(old) if old.as_deref() != path => {
      map.insert(id.to_owned(), None);
    }
    Some(_) => {}
    None => {
      map.insert(id.to_owned(), path.map(str::to_owned));
    }
  }
}

fn ag_absolute(p: &str) -> bool {
  let b = p.as_bytes();
  p.starts_with(['/', '\\']) || (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'/' | b'\\'))
}

const AG_INDEX_MAX: u64 = 4 << 20;

/// Antigravity's `history.jsonl` and `cache/{conversation_metadata,projects,last_conversations}.json`
/// beside its `brain` folder (Orca `indexAntigravityHistory` + `antigravityMetadataWorkspaces`),
/// each read only when at most 4 MiB.
fn ag_index(home: &Path) -> AgIndex {
  let mut ix = AgIndex::default();
  let json = |name: &str| small_file(&home.join("cache").join(name), AG_INDEX_MAX).and_then(|t| serde_json::from_str::<Value>(&t).ok()).filter(Value::is_object);
  for line in small_file(&home.join("history.jsonl"), AG_INDEX_MAX).unwrap_or_default().lines().take(10_000) {
    let Ok(r) = serde_json::from_str::<Value>(line) else { continue };
    let Some(ws) = r.get("workspace").and_then(Value::as_str).map(str::trim).filter(|w| !w.is_empty() && w.len() <= 4096) else { continue };
    let Some(at) = r.get("timestamp").and_then(when_of) else { continue };
    if let Some(id) = r.get("conversationId").and_then(Value::as_str) {
      ag_unique(&mut ix.by_id, id, Some(ws));
    }
    if let Some(h) = r.get("display").and_then(Value::as_str).and_then(ag_prompt_hash) {
      ix.by_prompt.entry(h).or_default().push((at, ws.to_owned()));
    }
  }
  let entries = |v: Option<Value>| v.and_then(|v| v.as_object().cloned()).into_iter().flatten().take(10_000);
  let mut project_paths = std::collections::HashMap::new();
  for (k, v) in entries(json("projects.json")) {
    let Some(v) = v.as_str() else { continue };
    if ag_absolute(&k) {
      ag_unique(&mut project_paths, v, Some(&k));
    } else if ag_absolute(v) {
      ag_unique(&mut project_paths, &k, Some(v));
    }
  }
  let mut paths = std::collections::HashMap::new();
  for (path, id) in entries(json("last_conversations.json")) {
    if let Some(id) = id.as_str().filter(|_| ag_absolute(&path)) {
      ag_unique(&mut paths, id, Some(&path));
    }
  }
  for (id, v) in entries(json("conversation_metadata.json").and_then(|m| m.get("conversations").cloned())) {
    if let Some(path) = v.pointer("/summary/ProjectID").and_then(Value::as_str).and_then(|p| project_paths.get(p)) {
      ag_unique(&mut paths, &id, path.as_deref());
    }
  }
  for (id, path) in paths {
    match ix.by_id.get(&id) {
      None => {
        ix.by_id.insert(id, path);
      }
      Some(old) if *old != path => {
        ix.by_id.insert(id, None);
      }
      Some(_) => {}
    }
  }
  ix
}

/// One Antigravity transcript (`<brain>/<id>/.system_generated/logs/transcript[_full].jsonl`, Orca
/// `consumeAntigravityRecordLine`): `USER_INPUT` / `REQUEST` requests and `PLANNER_RESPONSE`
/// replies; also the opening request's hash and time, to find its folder in the indexes.
fn read_antigravity(path: &Path) -> Option<(Session, Option<(String, i64)>)> {
  let id = path.parent()?.parent()?.parent()?.file_name()?.to_str()?.to_owned();
  if !safe_id(&id) {
    return None;
  }
  let text = std::fs::read_to_string(path).ok()?;
  let mut s = Session { id, title: String::new(), preview: None, cwd: None, branch: None, model: None, messages: 0, created: 0, updated: 0, path: path.display().to_string(), agent: "antigravity" };
  let mut title = None;
  let mut opening: Option<Option<(String, i64)>> = None;
  for line in text.lines() {
    if line.len() > 4 << 20 {
      continue;
    }
    let Ok(r) = serde_json::from_str::<Value>(line) else { continue };
    if !r.is_object() {
      continue;
    }
    let at = r.get("created_at").and_then(when_of);
    widen(&mut s, at);
    let (source, kind, content) = (str_field(&r, "source"), str_field(&r, "type"), str_field(&r, "content"));
    if matches!(source.as_deref(), Some("USER_EXPLICIT" | "USER")) && matches!(kind.as_deref(), Some("USER_INPUT" | "REQUEST")) {
      let Some(req) = content.as_deref().and_then(ag_request) else { continue };
      s.messages += 1;
      opening.get_or_insert_with(|| ag_prompt_hash(&req).zip(at));
      take_turn(&mut s, &mut title, "user", Some(req));
    } else if source.as_deref() == Some("MODEL") && kind.as_deref() == Some("PLANNER_RESPONSE") && content.is_some() {
      s.messages += 1;
      take_turn(&mut s, &mut title, "assistant", content);
    }
  }
  s.title = title.unwrap_or_else(|| "Untitled session".into());
  Some((s, opening.flatten()))
}

/// One conversation folder as a session: the full transcript over the compact one unless only the
/// compact one has turns (Orca `sessionAliasBeats`), with its folder from the indexes (Orca
/// `findAntigravityWorkspace`: by id, else one history row of the same opening prompt within 2 s).
fn read_antigravity_conversation(dir: &Path, ix: &AgIndex) -> Option<Session> {
  let logs = dir.join(".system_generated").join("logs");
  let mut best: Option<(Session, Option<(String, i64)>)> = None;
  for name in ["transcript_full.jsonl", "transcript.jsonl"] {
    let p = logs.join(name);
    if !std::fs::symlink_metadata(&p).is_ok_and(|m| m.is_file()) {
      continue;
    }
    let Some(c) = read_antigravity(&p) else { continue };
    if best.as_ref().is_none_or(|b| b.0.messages == 0 && c.0.messages > 0) {
      best = Some(c);
    }
  }
  let (mut s, opening) = best?;
  s.cwd = match ix.by_id.get(&s.id) {
    Some(path) => path.clone(),
    None => opening.and_then(|(hash, at)| {
      let m: Vec<&(i64, String)> = ix.by_prompt.get(&hash)?.iter().filter(|(t, _)| (t - at).abs() <= 2_000).collect();
      (m.len() == 1).then(|| m[0].1.clone())
    }),
  };
  Some(s)
}

/// Antigravity CLI sessions of `root` (`~/.gemini/antigravity-cli/brain`; the IDE's brains are an
/// opt-in in Orca that `agy` cannot resume natively, so they are left out).
pub fn list_antigravity(root: &Path, brain: &Path, limit: usize) -> Vec<Session> {
  let ix = brain.parent().map(ag_index).unwrap_or_default();
  let plain_dir = |p: &Path| std::fs::symlink_metadata(p).is_ok_and(|m| m.is_dir());
  let mut dirs = Vec::new();
  for d in std::fs::read_dir(brain).into_iter().flatten().flatten().take(4096) {
    let p = d.path();
    let logs = p.join(".system_generated").join("logs");
    if !d.file_type().is_ok_and(|t| t.is_dir()) || !plain_dir(&p.join(".system_generated")) || !plain_dir(&logs) {
      continue;
    }
    // The newer of the pair drives recency (Orca `aliasMtimeMs`).
    let t = modified(&logs.join("transcript.jsonl")).max(modified(&logs.join("transcript_full.jsonl")));
    if t > std::time::UNIX_EPOCH {
      dirs.push((t, p));
    }
  }
  newest_of(root, dirs, limit, |d| read_antigravity_conversation(d, &ix))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn reads_omp_transcripts_with_their_stored_names() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("repo");
    std::fs::create_dir_all(&root).unwrap();
    let cwd = root.display().to_string();
    let lines = |v: &[Value]| v.iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
    let omp = tmp.path().join("omp/sessions");
    let bucket = omp.join("--repo--");
    let stamp = "2026-05-01T10-08-30-000Z_0199a000-0000-7000-8000-0000000000aa";
    std::fs::create_dir_all(bucket.join(stamp)).unwrap();
    let prompt = serde_json::json!({"type": "message", "timestamp": "2026-05-01T10:08:31Z", "message": {"role": "user", "content": [{"type": "text", "text": "First prompt"}]}});
    std::fs::write(bucket.join(format!("{stamp}.jsonl")), lines(&[
      serde_json::json!({"type": "title", "v": 1, "title": "User name", "source": "user", "updatedAt": "2026-05-01T12:00:00Z"}),
      serde_json::json!({"type": "session", "id": "0199a000-0000-7000-8000-0000000000aa", "title": "Old header", "cwd": cwd, "timestamp": "2026-05-01T10:08:30Z"}),
      serde_json::json!({"type": "model_change", "model": "gpt-5.4-mini"}),
      prompt.clone(),
      serde_json::json!({"type": "title_change", "title": "Auto name", "source": "auto", "timestamp": "2026-05-01T13:00:00Z"}),
      serde_json::json!({"type": "message", "message": {"role": "assistant", "content": [{"type": "text", "text": "OMP answer"}]}}),
    ])).unwrap();
    // A task transcript inside the conversation's artifact folder is not its own row.
    std::fs::write(bucket.join(stamp).join("task.jsonl"), lines(&[serde_json::json!({"type": "session", "id": "task-1", "cwd": cwd})])).unwrap();
    // No stored name: the first prompt.
    std::fs::write(bucket.join("plain.jsonl"), lines(&[serde_json::json!({"type": "session", "id": "omp-plain", "cwd": cwd}), prompt.clone()])).unwrap();
    // Pi's folder: only the file OMP wrote is OMP's.
    let pi = tmp.path().join("pi");
    std::fs::create_dir_all(pi.join("--repo--")).unwrap();
    std::fs::write(pi.join("--repo--/a.jsonl"), lines(&[serde_json::json!({"type": "session", "id": "pi-own", "cwd": cwd}), prompt.clone()])).unwrap();
    std::fs::write(pi.join("--repo--/b.jsonl"), lines(&[serde_json::json!({"type": "session", "id": "omp-in-pi", "cwd": cwd}), serde_json::json!({"type": "session_info", "name": "Legacy name"}), serde_json::json!({"type": "model_change", "model": "m"})])).unwrap();
    let mut list = list_omp(&root, std::slice::from_ref(&omp), &pi, 10);
    list.sort_by(|a, b| a.id.cmp(&b.id));
    let rows: Vec<(&str, &str, &str)> = list.iter().map(|s| (s.id.as_str(), s.title.as_str(), s.agent)).collect();
    assert_eq!(rows, [("0199a000-0000-7000-8000-0000000000aa", "User name", "omp"), ("omp-in-pi", "Legacy name", "omp"), ("omp-plain", "First prompt", "omp")]);
    let main = &list[0];
    assert_eq!((main.messages, main.model.as_deref(), main.preview.as_deref()), (2, Some("gpt-5.4-mini"), Some("Agent: OMP answer")));
    assert_eq!(list_pi(&root, &pi, 10).iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["pi-own"]);

    // A newer rename of the same source wins; an older one does not.
    let fold = |v: &[Value]| v.iter().fold(None, fold_omp_title).map(|t| t.title);
    let slot = serde_json::json!({"type": "title", "v": 1, "title": "Current slot", "source": "user", "updatedAt": "2026-09-14T02:00:00Z"});
    assert_eq!(fold(&[slot.clone(), serde_json::json!({"type": "title_change", "title": "Old", "source": "user", "timestamp": "2026-09-14T01:00:00Z"})]).as_deref(), Some("Current slot"));
    assert_eq!(fold(&[slot.clone(), serde_json::json!({"type": "title_change", "title": "Newer", "source": "user", "timestamp": "2026-09-14T03:00:00Z"})]).as_deref(), Some("Newer"));
    assert_eq!(fold(&[serde_json::json!({"type": "title", "v": 2, "title": "x"}), serde_json::json!({"type": "title_change", "title": "y", "source": "bot"})]), None);
    assert!(omp_artifact_dir(stamp) && !omp_artifact_dir("--repo--") && !omp_artifact_dir("2026-05-01T10-08-30-000Z_not-a-uuid"));
  }

  #[test]
  fn finds_omp_folders_like_its_dirs_ts() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path();
    let env = |vars: &'static [(&'static str, &'static str)]| move |k: &str| vars.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string());
    assert_eq!(omp_sessions_dirs(home, &env(&[])), [home.join(".omp/agent/sessions")]);
    assert_eq!(omp_sessions_dirs(home, &env(&[("OMP_CODING_AGENT_DIR", "/x/.omp")])), [PathBuf::from("/x/.omp/agent/sessions")]);
    assert!(omp_sessions_dirs(home, &env(&[("OMP_CODING_AGENT_DIR", "relative")])).is_empty());
    assert_eq!(omp_sessions_dirs(home, &env(&[("OMP_PROFILE", "work")])), [home.join(".omp/profiles/work/agent/sessions")]);
    // A name OMP rejects selects no primary folder.
    assert!(omp_sessions_dirs(home, &env(&[("OMP_PROFILE", "Bad Name")])).is_empty());
    assert_eq!(omp_sessions_dirs(home, &env(&[("PI_CODING_AGENT_DIR", "/agents/pi")])), [PathBuf::from("/agents/pi/sessions")]);
    // Existing named profiles are listed too.
    std::fs::create_dir_all(home.join(".omp/profiles/side/agent/sessions")).unwrap();
    std::fs::create_dir_all(home.join(".omp/profiles/NOPE/agent/sessions")).unwrap();
    assert_eq!(omp_sessions_dirs(home, &env(&[])), [home.join(".omp/agent/sessions"), home.join(".omp/profiles/side/agent/sessions")]);
    assert_eq!((omp_profile(Some("default")), omp_profile(Some("con")), omp_profile(Some("a.b-c"))), (Some(None), None, Some(Some("a.b-c".into()))));
  }

  #[test]
  fn reads_rovo_metadata_with_its_context() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("repo");
    std::fs::create_dir_all(&root).unwrap();
    let sessions = tmp.path().join("rovo");
    let dir = sessions.join("6f0e4c1a-rovo");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("metadata.json"), serde_json::json!({"workspace_path": root.join("sub").display().to_string(), "created_at": "2026-11-21T01:00:00Z"}).to_string()).unwrap();
    std::fs::write(dir.join("session_context.json"), serde_json::json!({
      "message_history": [
        {"kind": "request", "timestamp": "2026-11-21T01:00:05Z", "parts": [{"part_kind": "system-prompt", "content": "be nice"}, {"part_kind": "user-prompt", "content": "Add the rovo scanner"}]},
        {"kind": "response", "timestamp": "2026-11-21T01:01:00Z", "parts": [{"part_kind": "tool-call", "tool_name": "x"}, {"part_kind": "text", "content": "Added. ✓ 日本語"}]},
        {"kind": "request", "parts": [{"part_kind": "tool-return", "content": "ok"}]}
      ]
    }).to_string()).unwrap();
    let other = sessions.join("elsewhere");
    std::fs::create_dir_all(&other).unwrap();
    std::fs::write(other.join("metadata.json"), serde_json::json!({"cwd": "/elsewhere", "title": "x"}).to_string()).unwrap();
    let list = list_rovo(&root, &sessions, 10);
    assert_eq!(list.len(), 1);
    let s = &list[0];
    assert_eq!((s.id.as_str(), s.title.as_str(), s.messages, s.agent), ("6f0e4c1a-rovo", "Add the rovo scanner", 2, "rovo"));
    assert_eq!(s.preview.as_deref(), Some("Agent: Added. ✓ 日本語"));
    assert!(s.updated > s.created && s.created > 0);
    // Metadata's title wins; a plain `messages` list counts too.
    std::fs::write(dir.join("metadata.json"), serde_json::json!({"cwd": root.display().to_string(), "title": "Named"}).to_string()).unwrap();
    std::fs::write(dir.join("session_context.json"), serde_json::json!({"messages": [{"role": "user", "content": [{"text": "hi"}]}, {"role": "system", "content": "s"}]}).to_string()).unwrap();
    let s = read_rovo(&dir.join("metadata.json")).unwrap();
    assert_eq!((s.title.as_str(), s.messages, s.preview.as_deref()), ("Named", 1, Some("You: hi")));
  }

  #[test]
  fn reads_antigravity_transcripts_placed_by_its_indexes() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("repo");
    std::fs::create_dir_all(&root).unwrap();
    let home = tmp.path().join(".gemini/antigravity-cli");
    let brain = home.join("brain");
    let rec = |source: &str, kind: &str, content: &str, at: &str| serde_json::json!({"source": source, "type": kind, "content": content, "created_at": at}).to_string();
    let write = |id: &str, name: &str, lines: &[String]| {
      let logs = brain.join(id).join(".system_generated/logs");
      std::fs::create_dir_all(&logs).unwrap();
      std::fs::write(logs.join(name), lines.join("\n")).unwrap();
    };
    // Matched by its opening prompt and time in history.jsonl.
    let a = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    write(a, "transcript.jsonl", &[rec("USER_EXPLICIT", "USER_INPUT", "<USER_REQUEST>ORCA_8742_REPRO</USER_REQUEST>", "2026-07-15T11:39:10.000Z"), rec("MODEL", "PLANNER_RESPONSE", "Done", "2026-07-15T11:39:12.000Z")]);
    // The full transcript is preferred over the compact one.
    write(a, "transcript_full.jsonl", &[rec("USER_EXPLICIT", "USER_INPUT", "<USER_REQUEST>ORCA_8742_REPRO</USER_REQUEST>", "2026-07-15T11:39:10.000Z"), rec("MODEL", "PLANNER_RESPONSE", "Done in full", "2026-07-15T11:39:12.000Z")]);
    // Placed by id through the cache's project index.
    let b = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    write(b, "transcript.jsonl", &[rec("USER", "REQUEST", "plain request", "2026-07-15T12:00:00.000Z")]);
    // A long prompt cannot be matched by its hash: no folder, so not listed.
    let c = "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa";
    let long = "shared worker preamble ".repeat(7);
    write(c, "transcript.jsonl", &[rec("USER_EXPLICIT", "USER_INPUT", &format!("<USER_REQUEST>{long}A</USER_REQUEST>"), "2026-07-15T11:39:10.000Z")]);
    let ms = 1_784_115_550_100i64; // 2026-07-15T11:39:10.100Z
    std::fs::write(home.join("history.jsonl"), [
      serde_json::json!({"display": "ORCA_8742_REPRO", "timestamp": ms, "workspace": root.display().to_string()}),
      serde_json::json!({"display": format!("{long}A"), "timestamp": ms, "workspace": root.display().to_string()}),
    ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();
    std::fs::create_dir_all(home.join("cache")).unwrap();
    std::fs::write(home.join("cache/projects.json"), serde_json::json!({root.join("pkg").display().to_string(): "proj-1"}).to_string()).unwrap();
    std::fs::write(home.join("cache/conversation_metadata.json"), serde_json::json!({"conversations": {b: {"summary": {"ProjectID": "proj-1"}}}}).to_string()).unwrap();
    let mut list = list_antigravity(&root, &brain, 10);
    list.sort_by(|x, y| x.id.cmp(&y.id));
    let rows: Vec<(&str, &str, Option<&str>)> = list.iter().map(|s| (s.id.as_str(), s.title.as_str(), s.preview.as_deref())).collect();
    assert_eq!(rows, [(a, "ORCA_8742_REPRO", Some("Agent: Done in full")), (b, "plain request", Some("You: plain request"))]);
    assert!(list[0].path.ends_with("transcript_full.jsonl") && list[0].agent == "antigravity" && list[0].messages == 2);
    assert_eq!(list[1].cwd.as_deref(), Some(root.join("pkg").display().to_string().as_str()));
    assert_eq!(ag_request("no tags").as_deref(), Some("no tags"));
    assert_eq!(ag_request("<USER_REQUEST>  open").as_deref(), Some("open"));
    assert!(ag_prompt_hash(&"x".repeat(97)).is_none() && ag_prompt_hash("ends...").is_none());
  }

  #[test]
  fn reads_opencode2_sessions_of_this_folder() {
    let sqlite = Path::new(crate::accounts::managed::SQLITE);
    if !sqlite.exists() {
      return;
    }
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("opencode.db");
    let sql = r#"
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT, model TEXT, version TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
      INSERT INTO session_v2 VALUES ('ses_2a', 'p', NULL, 's', '/repo', 'OpenCode 2 title', 'gpt-5', '2', 1000, 3000, NULL);
      INSERT INTO session_v2 VALUES ('ses_2b', 'p', NULL, 's', '/repo/.kingu/worktrees/t', NULL, '{"id":"claude-x"}', '2', 1500, 2000, NULL);
      INSERT INTO session_v2 VALUES ('ses_child', 'p', 'ses_2a', 's', '/repo', 'sub', NULL, '2', 1600, 2600, NULL);
      INSERT INTO session_v2 VALUES ('ses_old', 'p', NULL, 's', '/repo', 'Archived', NULL, '2', 100, 200, 300);
      INSERT INTO session_v2 VALUES ('ses_x', 'p', NULL, 's', '/repo-other', 'Elsewhere', NULL, '2', 100, 5000, NULL);
      INSERT INTO session_message VALUES ('m1', 'ses_2a', 'user', 1, 1000, 1000, '{"type":"user","text":"Fix the login"}');
      INSERT INTO session_message VALUES ('m2', 'ses_2a', 'assistant', 2, 2000, 2000, '{"type":"assistant","content":[{"type":"text","text":"Fixed"},"stray",{"type":"tool","name":"bash"},{"type":"text","text":"it."}]}');
      INSERT INTO session_message VALUES ('m3', 'ses_2a', 'assistant', 3, 2500, 2500, '{"content":[{"type":"tool","name":"bash"}]}');
      INSERT INTO session_message VALUES ('m4', 'ses_2a', 'tool', 4, 2600, 2600, 'not json');
      INSERT INTO session_message VALUES ('m5', 'ses_2b', 'user', 1, 1500, 1500, '{"text":["Add","search"]}');
    "#;
    assert!(std::process::Command::new(sqlite).arg(&db).arg(sql).status().unwrap().success());
    let list = list_opencode2(std::slice::from_ref(&db), Path::new("/repo"), 10);
    let ids: Vec<&str> = list.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, ["ses_2a", "ses_2b"]);
    let a = &list[0];
    assert_eq!((a.title.as_str(), a.model.as_deref(), a.messages, a.preview.as_deref(), a.agent), ("OpenCode 2 title", Some("gpt-5"), 3, Some("Agent: Fixed it."), "opencode2"));
    assert_eq!(a.path, format!("{}#ses_2a", db.display()));
    assert_eq!((list[1].title.as_str(), list[1].model.as_deref()), ("Add search", Some("claude-x")));
    // A v1-only database has no OpenCode 2 rows.
    let v1 = dir.path().join("opencode-v1.db");
    assert!(std::process::Command::new(sqlite).arg(&v1).arg("CREATE TABLE session (id TEXT);").status().unwrap().success());
    assert!(list_opencode2(&[v1], Path::new("/repo"), 10).is_empty());
  }

  #[test]
  fn reads_muse_session_logs() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("repo");
    std::fs::create_dir_all(&root).unwrap();
    let id = "0199a000-0000-7000-8000-00000000abcd";
    let dir = tmp.path().join("sessions/2026/11/21").join(id);
    std::fs::create_dir_all(&dir).unwrap();
    let rec = |t: &str, at: f64, payload: Value| serde_json::json!({"record_type": "event", "payload_type": t, "recorded_at": at, "payload": payload});
    let at = 1_795_000_000_000_000.0; // microseconds
    let batch = serde_json::json!({"children": [
      {"record_json": rec("runtime.session.metadata", at, serde_json::json!({"record": {"workspace_root": root.display().to_string()}})).to_string()},
      {"record_json": rec("session.workspace_branch.observed", at, serde_json::json!({"record": {"reference": {"name": "feat/x"}}}))},
    ]});
    let lines = [
      batch,
      rec("run.model.configured", at + 1.0, serde_json::json!({"record": {"model_id": "muse-1"}})),
      rec("runtime.user_intent.accepted", at + 2_000_000.0, serde_json::json!({"refill_blocks": [{"text": "write the docs"}]})),
      // The run's start repeats the intent: not a second turn.
      rec("runtime.session", at + 3_000_000.0, serde_json::json!({"event": {"kind": "started", "prompt": "write the docs"}})),
      rec("runtime.session", at + 4_000_000.0, serde_json::json!({"event": {"kind": "assistant_message_committed", "text": "Docs written."}})),
    ];
    std::fs::write(dir.join("session.jsonl"), lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();
    std::fs::write(dir.join("session.log.jsonl"), "{}").unwrap();
    let m = list_muse(&root, &tmp.path().join("sessions"), 10);
    assert_eq!(m.len(), 1);
    let s = &m[0];
    assert_eq!((s.id.as_str(), s.title.as_str(), s.messages, s.branch.as_deref(), s.model.as_deref(), s.agent), (id, "write the docs", 2, Some("feat/x"), Some("muse-1"), "muse"));
    assert_eq!(s.preview.as_deref(), Some("Agent: Docs written."));
    assert_eq!((s.created, s.updated), (1_795_000_000_000, 1_795_000_004_000));
  }

  #[test]
  fn reads_openclaw_and_pi_transcripts() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("repo");
    std::fs::create_dir_all(&root).unwrap();
    let cwd = root.display().to_string();
    let lines = |v: &[Value]| v.iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
    let state = tmp.path().join(".openclaw");
    std::fs::create_dir_all(state.join("agents/main/sessions")).unwrap();
    std::fs::create_dir_all(state.join("agents/main/tools")).unwrap();
    std::fs::write(state.join("agents/main/sessions/abc-1.jsonl"), lines(&[
      serde_json::json!({"type": "session", "id": "oc-1", "cwd": cwd, "timestamp": "2026-11-21T01:00:00Z"}),
      serde_json::json!({"type": "message", "timestamp": "2026-11-21T01:00:05Z", "message": {"role": "user", "content": [{"type": "text", "text": "deploy it"}]}}),
      serde_json::json!({"type": "message", "message": {"role": "assistant", "model": "claw-1", "content": "deployed"}}),
    ])).unwrap();
    std::fs::write(state.join("agents/main/tools/t.jsonl"), lines(&[serde_json::json!({"type": "session", "id": "tool", "cwd": cwd})])).unwrap();
    let o = list_openclaw(&root, &[state.clone(), tmp.path().join(".clawdbot")], 10);
    assert_eq!(o.len(), 1);
    assert_eq!((o[0].id.as_str(), o[0].title.as_str(), o[0].messages, o[0].model.as_deref(), o[0].agent), ("oc-1", "deploy it", 2, Some("claw-1"), "openclaw"));

    let pi = tmp.path().join("pi");
    std::fs::create_dir_all(pi.join("--repo--")).unwrap();
    std::fs::write(pi.join("--repo--/2026-05-01_pi.jsonl"), lines(&[
      serde_json::json!({"type": "session", "id": "0199a000-0000-7000-8000-000000000001", "cwd": cwd}),
      serde_json::json!({"type": "model_change", "modelId": "claude-sonnet-4-5"}),
      serde_json::json!({"type": "message", "message": {"role": "user", "content": [{"type": "text", "text": "Pi prompt"}]}}),
    ])).unwrap();
    // OMP writes into Pi's folder too: not a Pi session.
    std::fs::write(pi.join("--repo--/2026-05-01_omp.jsonl"), lines(&[
      serde_json::json!({"type": "title", "v": 1, "title": "OMP chat"}),
      serde_json::json!({"type": "session", "id": "omp-1", "cwd": cwd}),
    ])).unwrap();
    let p = list_pi(&root, &pi, 10);
    assert_eq!(p.len(), 1);
    assert_eq!((p[0].id.as_str(), p[0].title.as_str(), p[0].model.as_deref(), p[0].agent), ("0199a000-0000-7000-8000-000000000001", "Pi prompt", Some("claude-sonnet-4-5"), "pi"));
  }

  #[test]
  fn reads_hermes_and_jcode_sessions() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("proj");
    std::fs::create_dir_all(&root).unwrap();
    let cwd = root.join("sub").display().to_string();
    let hermes = tmp.path().join("hermes");
    std::fs::create_dir_all(&hermes).unwrap();
    std::fs::write(hermes.join("session_20261121_ab12.json"), serde_json::json!({
      "session_id": "20261121_ab12", "model": "hermes-4", "cwd": cwd, "session_start": "2026-11-21T01:00:00Z", "last_updated": "2026-11-21T02:00:00Z",
      "messages": [{"role": "system", "content": "be nice"}, {"role": "user", "content": "fix the login"}, {"role": "assistant", "content": [{"type": "text", "text": "done"}]}]
    }).to_string()).unwrap();
    std::fs::write(hermes.join("session_other.json"), serde_json::json!({"session_id": "o", "cwd": "/elsewhere", "message_count": 3}).to_string()).unwrap();
    std::fs::write(hermes.join("journal.json"), "{}").unwrap();
    let h = list_hermes(&root, &hermes, 10);
    assert_eq!(h.len(), 1);
    assert_eq!((h[0].id.as_str(), h[0].title.as_str(), h[0].messages, h[0].agent), ("20261121_ab12", "fix the login", 2, "hermes"));
    assert_eq!(h[0].preview.as_deref(), Some("Agent: done"));
    assert!(h[0].updated > h[0].created && h[0].created > 0);
    let only_count = read_hermes(&hermes.join("session_other.json")).unwrap();
    assert_eq!(only_count.messages, 3);

    let jcode = tmp.path().join("jcode");
    std::fs::create_dir_all(jcode.join("nested")).unwrap();
    let id = "3f2b1c4d-1111-4222-8333-944455556666";
    std::fs::write(jcode.join("nested").join(format!("session_{id}.json")), serde_json::json!({
      "working_dir": root.display().to_string(), "title": "Refactor auth", "created_at": "2026-11-20T10:00:00Z",
      "messages": [
        {"role": "user", "content": "<system-reminder>ctx</system-reminder>"},
        {"role": "user", "display_role": "background_task", "content": "bg"},
        {"role": "user", "content": "[Scheduled task] nightly"},
        {"role": "user", "content": "please refactor", "timestamp": "2026-11-20T11:00:00Z"},
        {"role": "tool", "content": "ok"},
        {"role": "assistant", "content": "refactored"}
      ]
    }).to_string()).unwrap();
    let j = list_jcode(&root, &jcode, 10);
    assert_eq!(j.len(), 1);
    assert_eq!((j[0].id.as_str(), j[0].title.as_str(), j[0].messages, j[0].agent), (id, "Refactor auth", 3, "jcode"));
    assert_eq!(j[0].preview.as_deref(), Some("Agent: refactored"));
    assert_eq!(id_from_file_name(Path::new("/x/session_abc.json")).as_deref(), Some("session_abc"));
  }

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
    assert!(store_query(&cols(&["id", "time_created"]), &[], &[], Path::new("/r"), 5, false).is_none());
    let bare = store_query(&cols(&["id", "time_created", "time_updated", "directory"]), &[], &[], Path::new("/r/it's"), 5, false).unwrap();
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
  fn reads_zcode_sessions_without_hidden_messages() {
    let sqlite = Path::new(crate::accounts::managed::SQLITE);
    if !sqlite.exists() {
      return;
    }
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("db.sqlite");
    let sql = r#"
      CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, model TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      INSERT INTO session VALUES ('z1', NULL, '/repo', '', NULL, 1000, 3000);
      INSERT INTO message VALUES ('m0', 'z1', 900, '{"role":"user","semantics":{"transcriptVisibility":"hidden"}}', 1);
      INSERT INTO message VALUES ('m1', 'z1', 1000, '{"role":"user"}', 2);
      INSERT INTO message VALUES ('m2', 'z1', 2000, '{"role":"assistant"}', 3);
      INSERT INTO part VALUES ('p0', 'm0', 'z1', 900, '{"type":"text","text":"injected context"}');
      INSERT INTO part VALUES ('p1', 'm1', 'z1', 1000, '{"type":"text","text":"Ship the release"}');
      INSERT INTO part VALUES ('p2', 'm2', 'z1', 2000, '{"type":"text","text":"Shipped."}');
    "#;
    assert!(std::process::Command::new(sqlite).arg(&db).arg(sql).status().unwrap().success());
    let list = list_zcode(&db, Path::new("/repo"), 10);
    assert_eq!(list.len(), 1);
    assert_eq!((list[0].title.as_str(), list[0].messages, list[0].preview.as_deref(), list[0].agent), ("Ship the release", 2, Some("Agent: Shipped."), "zcode"));
    assert!(list_zcode(&dir.path().join("missing.sqlite"), Path::new("/repo"), 10).is_empty());
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

  #[test]
  fn names_grok_folders_like_orca() {
    // Orca's grok-session-paths.test.ts vectors (URL form up to 255 bytes, then slug + BLAKE3).
    assert_eq!(grok_dir_name("/repo/!'()*").as_deref(), Some("%2Frepo%2F%21%27%28%29%2A"));
    assert_eq!(grok_dir_name(&format!("/{}", "a".repeat(252))), Some(format!("%2F{}", "a".repeat(252))));
    let long = "a".repeat(260);
    let cases = [
      (format!("/Users/test/{}", "中".repeat(30)), "workspace-43f12fb9a5ee1037".to_owned()),
      ("/Users/dev/Documents/開発プロジェクト/機能追加/テスト環境/ソースコード/main-branch".to_owned(), "main-branch-6aaeefdde2a621aa".to_owned()),
      (format!("/{long}/My Workspace  "), "my-workspace-821ab64a500ab620".to_owned()),
      (format!("/{long}/İProject"), "i-project-a676b9c62bbe86c8".to_owned()),
      (format!("/{long}/{} !! end", "A".repeat(39)), format!("{}--6306ef8d209ddda1", "a".repeat(39))),
    ];
    for (cwd, want) in cases {
      assert_eq!(grok_dir_name(&cwd), Some(want), "{cwd}");
    }
    let n = grok_dir_name(&format!("/{}", "a".repeat(253))).unwrap();
    assert!(n.starts_with(&"a".repeat(40)) && n.len() == 57, "{n}");
    assert_eq!(grok_dir_name("."), None);
    assert_eq!(grok_dir_name(".."), None);
    assert_eq!(grok_dir_name("  "), None);
    assert_eq!(grok_decoded_dir("%2Frepo%2Fapp").as_deref(), Some("/repo/app"));
    assert_eq!(grok_decoded_dir("app-0123456789abcdef"), None);
    for bad in ["../escape", "nested/id", "nested\\id", ".", "..", &"x".repeat(129)] {
      assert!(!grok_safe_id(bad), "{bad}");
    }
    assert!(grok_safe_id("019e37f4-5135-7b63-a4ab-6d13aa6bf528"));
  }

  #[test]
  fn unwraps_grok_user_queries() {
    let raw = "<user_info>\nOS Version: macos\n</user_info>\n<user_query>\nfix i18n keep ko\n</user_query>";
    assert_eq!(grok_user_text(&Value::String(raw.into())).as_deref(), Some("fix i18n keep ko"));
    assert_eq!(grok_user_text(&Value::String("<user_info>context</user_info><user_query>\nShip it".into())).as_deref(), Some("Ship it"));
    assert_eq!(grok_user_text(&Value::String("<user_info>\nOS Version: macos\n</user_info>".into())), None);
    assert_eq!(grok_user_text(&Value::String("<user_info>x</user_info><git_status>clean</git_status>".into())), None);
    assert_eq!(grok_user_text(&serde_json::json!([{ "type": "text", "text": "fix the flaky tests" }, { "type": "image" }])).as_deref(), Some("fix the flaky tests"));
  }

  #[test]
  fn reads_grok_sessions_of_the_folder() {
    let dir = tempfile::tempdir().unwrap();
    let sessions = dir.path().join("sessions");
    let root = Path::new("/repo");
    let worktree = PathBuf::from(format!("/repo/.kingu/worktrees/{}", "w".repeat(260)));
    let write = |group: &str, id: &str, cwd: &str, history: &str| {
      let d = sessions.join(group).join(id);
      std::fs::create_dir_all(&d).unwrap();
      let summary = serde_json::json!({ "info": { "id": id, "cwd": cwd }, "current_model_id": "grok-4", "head_branch": "main",
        "created_at": "2026-11-20T09:00:00.000Z", "updated_at": "2026-11-20T09:05:00.000Z" });
      std::fs::write(d.join("summary.json"), summary.to_string()).unwrap();
      std::fs::write(d.join("chat_history.jsonl"), history).unwrap();
    };
    let history = [
      serde_json::json!({ "type": "user", "content": [{ "type": "text", "text": "<user_info>\nShell: zsh\n</user_info>\n<user_query>\nAdd a test\n</user_query>" }], "timestamp": "2026-11-20T09:00:01.000Z" }),
      serde_json::json!({ "type": "tool", "content": "ignored" }),
      serde_json::json!({ "type": "assistant", "content": "Added it.", "timestamp": "2026-11-20T09:10:00.000Z" }),
    ]
    .map(|v| v.to_string())
    .join("\n");
    write(&grok_dir_name("/repo").unwrap(), "s-root", "/repo", &history);
    write(&grok_dir_name("/repo/sub").unwrap(), "s-sub", "/repo/sub", &history);
    write(&grok_dir_name(worktree.to_str().unwrap()).unwrap(), "s-long", worktree.to_str().unwrap(), "");
    write(&grok_dir_name("/other").unwrap(), "s-other", "/other", &history);
    // A group whose name says /repo but whose summary says otherwise is still dropped.
    write(&grok_dir_name("/repo/lie").unwrap(), "s-lie", "/elsewhere", &history);
    // Unsafe session folder names are never read.
    write(&grok_dir_name("/repo").unwrap(), "bad.id", "/repo", &history);
    let list = list_grok(root, &[root.to_path_buf(), worktree.clone()], &sessions, 10);
    let mut ids: Vec<&str> = list.iter().map(|s| s.id.as_str()).collect();
    ids.sort();
    assert_eq!(ids, ["s-long", "s-root", "s-sub"]);
    let s = list.iter().find(|s| s.id == "s-root").unwrap();
    assert_eq!((s.title.as_str(), s.model.as_deref(), s.branch.as_deref(), s.messages, s.preview.as_deref(), s.agent), ("Add a test", Some("grok-4"), Some("main"), 2, Some("Agent: Added it."), "grok"));
    assert_eq!(s.updated - s.created, 10 * 60 * 1000);
    let long = list.iter().find(|s| s.id == "s-long").unwrap();
    assert_eq!((long.title.as_str(), long.messages), ("Untitled session", 0));
  }
}
