//! Reading other agents' transcripts: a bounded line reader, and one parser per format that turns
//! a record into [`Item`]s (who said what, what it cost, where it ran). The callers in `mod.rs`
//! decide how much of a file to read; nothing here holds more than one line (`MAX_LINE`) or one
//! bounded JSON document (`MAX_DOCUMENT`) in memory.
//!
//! Formats (all written by the other tool, never by Kingu):
//! - Claude Code: JSON Lines, one record per message (`message.content`, `message.usage`); a
//!   message split over several records repeats its usage, so usage is counted once per `message.id`.
//! - Codex: JSON Lines of `{timestamp, type, payload}` (`session_meta`, `turn_context`,
//!   `response_item`, `event_msg`); usage is a running total (`token_count`), so it adds up deltas.
//! - Gemini CLI: one JSON document (`{sessionId, messages: [...]}`), or JSON Lines of those messages.
//! - OpenCode: a session file, its messages in `storage/message/<session>/`, their text in
//!   `storage/part/<message>/`.
//! - Cursor CLI: JSON Lines of `{role, message: {content}}`, the typed text in `<user_query>`.

use serde_json::Value;
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};

use super::Agent;

/// Longer lines are skipped whole (a pasted image, a huge tool result).
pub const MAX_LINE: usize = 8 * 1024 * 1024;
/// JSON documents (Gemini sessions, OpenCode files) larger than this are not parsed.
pub const MAX_DOCUMENT: u64 = 64 * 1024 * 1024;
/// OpenCode: at most this many message files of one session are read.
const MAX_OPENCODE_MESSAGES: usize = 5000;
/// One turn's text is cut to this many characters.
pub const MAX_TURN_CHARS: usize = 16_000;

/// Calls `f` with each complete line of `path` from byte `from` (a partial first line is dropped
/// when `from > 0`), until `max_bytes` were read or `f` breaks. Lines over `MAX_LINE` are skipped.
/// UTF-8 is decoded lossily (a seek can land inside a character). Returns the bytes read.
pub fn each_line(path: &Path, from: u64, max_bytes: u64, mut f: impl FnMut(&str) -> ControlFlow<()>) -> std::io::Result<u64> {
  let mut file = std::fs::File::open(path)?;
  if from > 0 {
    file.seek(SeekFrom::Start(from))?;
  }
  let mut reader = BufReader::with_capacity(64 * 1024, file.take(max_bytes));
  let mut line: Vec<u8> = Vec::new();
  let mut skipping = from > 0;
  let mut read = 0u64;
  loop {
    let chunk = reader.fill_buf()?;
    if chunk.is_empty() {
      break;
    }
    let (part, done, used) = match chunk.iter().position(|&b| b == b'\n') {
      Some(i) => (&chunk[..i], true, i + 1),
      None => (chunk, false, chunk.len()),
    };
    if !skipping {
      if line.len() + part.len() > MAX_LINE {
        line.clear();
        skipping = true;
      } else {
        line.extend_from_slice(part);
      }
    }
    reader.consume(used);
    read += used as u64;
    if done {
      if !skipping && f(&String::from_utf8_lossy(&line)).is_break() {
        return Ok(read);
      }
      line.clear();
      skipping = false;
    }
  }
  // The last line without a newline: a transcript being written ends torn, which is normal.
  if !skipping && !line.is_empty() {
    let _ = f(&String::from_utf8_lossy(&line));
  }
  Ok(read)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
  User,
  Assistant,
  Tool,
}

/// Token counts, normalized: `input` excludes cache reads and writes, `output` includes reasoning.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
  pub input: u64,
  pub output: u64,
  pub cache_read: u64,
  pub cache_write: u64,
}

impl Tokens {
  pub fn add(&mut self, o: &Tokens) {
    self.input += o.input;
    self.output += o.output;
    self.cache_read += o.cache_read;
    self.cache_write += o.cache_write;
  }
  pub fn is_zero(&self) -> bool {
    self.input + self.output + self.cache_read + self.cache_write == 0
  }
}

/// What a record says about the session (any field may be missing).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Meta {
  pub id: Option<String>,
  pub title: Option<String>,
  pub cwd: Option<String>,
  pub branch: Option<String>,
  pub model: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Item {
  Meta(Meta),
  /// `typed`: false for context the agent injected into a user turn (no prompt the user typed).
  Turn { role: Role, text: String, at: Option<i64>, typed: bool },
  Usage { at: Option<i64>, model: Option<String>, tokens: Tokens },
  /// A timestamp on a record that is neither (session start, events).
  At(i64),
}

/// Per-file state of a JSON Lines parser.
#[derive(Default)]
pub struct LineState {
  /// Claude: message ids whose usage was counted.
  seen: HashSet<String>,
  /// Codex: the last running total and the model of the turn.
  totals: Option<Tokens>,
  model: Option<String>,
}

fn s(v: &Value, k: &str) -> Option<String> {
  v.get(k).and_then(Value::as_str).filter(|x| !x.trim().is_empty()).map(str::to_owned)
}

fn n(v: Option<&Value>) -> u64 {
  v.and_then(Value::as_f64).filter(|x| x.is_finite() && *x > 0.0).map_or(0, |x| x as u64)
}

pub fn time_of(v: Option<&Value>) -> Option<i64> {
  v.and_then(crate::accounts::usage::parse_time).map(|t| t as i64)
}

/// The text of `content`: a string, or the `text` of its parts (`text`, `input_text`, `output_text`).
pub fn content_text(content: &Value) -> Option<String> {
  match content {
    Value::String(t) => Some(t.clone()).filter(|t| !t.trim().is_empty()),
    Value::Array(parts) => {
      let t: Vec<&str> = parts
        .iter()
        .filter(|p| p.as_str().is_some() || matches!(p.get("type").and_then(Value::as_str), None | Some("text" | "input_text" | "output_text")))
        .filter_map(|p| p.as_str().or_else(|| p.get("text").and_then(Value::as_str)))
        .collect();
      let joined = t.join("\n");
      (!joined.trim().is_empty()).then_some(joined)
    }
    _ => None,
  }
}

/// A user turn without the tag blocks agents put in front of it (`<environment_context>`,
/// `<command-name>`, a `<timestamp>`); `<user_query>` is the typed text where an agent marks it.
/// `typed` is false when nothing but injected blocks is left.
pub fn unwrap_prompt(text: &str) -> (String, bool) {
  let mut rest = text;
  loop {
    let trimmed = rest.trim_start();
    let Some(after) = trimmed.strip_prefix('<') else { break };
    let tag: String = after.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    if tag.is_empty() || !after[tag.len()..].starts_with('>') {
      break;
    }
    let open = tag.len() + 2;
    let close = format!("</{tag}>");
    let Some(end) = trimmed[open..].find(&close) else { break };
    let inner = &trimmed[open..open + end];
    if tag == "user_query" {
      let q = inner.trim();
      return if q.is_empty() { (text.trim().to_owned(), false) } else { (q.to_owned(), true) };
    }
    rest = &trimmed[open + end + close.len()..];
  }
  let left = rest.trim();
  if left.is_empty() { (text.trim().to_owned(), false) } else { (left.to_owned(), true) }
}

fn turn(role: Role, text: String, at: Option<i64>) -> Item {
  if role == Role::User {
    let (text, typed) = unwrap_prompt(&text);
    Item::Turn { role, text, at, typed }
  } else {
    Item::Turn { role, text, at, typed: true }
  }
}

/// A tool call as one short line: `Bash: ls -la`.
fn tool_line(name: &str, input: Option<&Value>) -> String {
  let arg = match input {
    Some(Value::Object(o)) => ["command", "file_path", "path", "pattern", "query", "url", "description"].iter().find_map(|k| o.get(*k).and_then(Value::as_str)).map(str::to_owned).unwrap_or_else(|| Value::Object(o.clone()).to_string()),
    Some(Value::String(t)) => t.clone(),
    Some(v) => v.to_string(),
    None => String::new(),
  };
  let arg: String = arg.split_whitespace().collect::<Vec<_>>().join(" ");
  let arg: String = arg.chars().take(200).collect();
  if arg.is_empty() { name.to_owned() } else { format!("{name}: {arg}") }
}

/// The items of one JSON Lines record of `agent`.
pub fn line_items(agent: Agent, v: &Value, st: &mut LineState, out: &mut Vec<Item>) {
  match agent {
    Agent::Claude => claude(v, st, out),
    Agent::Codex => codex(v, st, out),
    Agent::Gemini => gemini_record(v, out),
    Agent::Cursor => cursor(v, out),
    Agent::OpenCode => {}
  }
}

fn claude(v: &Value, st: &mut LineState, out: &mut Vec<Item>) {
  let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
  let at = time_of(v.get("timestamp"));
  match kind {
    "summary" | "custom-title" | "ai-title" => {
      let title = s(v, "customTitle").or_else(|| s(v, "aiTitle")).or_else(|| s(v, "summary"));
      out.push(Item::Meta(Meta { title, ..Default::default() }));
      return;
    }
    "user" | "assistant" => {}
    _ => {
      if let Some(t) = at {
        out.push(Item::At(t));
      }
      return;
    }
  }
  out.push(Item::Meta(Meta { id: s(v, "sessionId"), cwd: s(v, "cwd"), branch: s(v, "gitBranch"), ..Default::default() }));
  // Task sub-agents' records and Claude Code's own notes are not the conversation.
  if v.get("isSidechain").and_then(Value::as_bool) == Some(true) || v.get("isMeta").and_then(Value::as_bool) == Some(true) {
    if let Some(t) = at {
      out.push(Item::At(t));
    }
    return;
  }
  let Some(msg) = v.get("message") else { return };
  let model = s(msg, "model").filter(|m| m != "<synthetic>");
  if kind == "assistant" {
    if let Some(m) = &model {
      out.push(Item::Meta(Meta { model: Some(m.clone()), ..Default::default() }));
    }
    if let Some(u) = msg.get("usage") {
      // One API message streams into several records that each repeat its usage.
      let id = s(msg, "id").map(|id| format!("{id}:{}", s(v, "requestId").unwrap_or_default()));
      if id.as_ref().is_none_or(|id| st.seen.insert(id.clone())) {
        let tokens = Tokens { input: n(u.get("input_tokens")), output: n(u.get("output_tokens")), cache_read: n(u.get("cache_read_input_tokens")), cache_write: n(u.get("cache_creation_input_tokens")) };
        if !tokens.is_zero() && model.is_some() {
          out.push(Item::Usage { at, model: model.clone(), tokens });
        }
      }
    }
  }
  let role = if kind == "user" { Role::User } else { Role::Assistant };
  match msg.get("content") {
    Some(Value::String(t)) if !t.trim().is_empty() => out.push(turn(role, t.clone(), at)),
    Some(content @ Value::Array(parts)) => {
      if let Some(t) = content_text(content) {
        out.push(turn(role, t, at));
      }
      for p in parts.iter().filter(|p| p.get("type").and_then(Value::as_str) == Some("tool_use")) {
        out.push(Item::Turn { role: Role::Tool, text: tool_line(p.get("name").and_then(Value::as_str).unwrap_or("tool"), p.get("input")), at, typed: true });
      }
      if role == Role::User && !parts.iter().any(|p| p.get("type").and_then(Value::as_str) == Some("text"))
        && let Some(t) = at
      {
        out.push(Item::At(t));
      }
    }
    _ => {
      if let Some(t) = at {
        out.push(Item::At(t));
      }
    }
  }
}

fn codex(v: &Value, st: &mut LineState, out: &mut Vec<Item>) {
  let at = time_of(v.get("timestamp"));
  // Rollouts before the `{type, payload}` envelope wrote the item itself on each line.
  let (kind, p) = match v.get("payload") {
    Some(p) => (v.get("type").and_then(Value::as_str).unwrap_or(""), p),
    None if v.get("type").is_some() => ("response_item", v),
    None => ("session_meta", v),
  };
  match kind {
    "session_meta" => {
      let branch = p.get("git").and_then(|g| s(g, "branch"));
      out.push(Item::Meta(Meta { id: s(p, "id"), cwd: s(p, "cwd"), branch, ..Default::default() }));
      if let Some(t) = at.or_else(|| time_of(p.get("timestamp"))) {
        out.push(Item::At(t));
      }
    }
    "turn_context" => {
      st.model = s(p, "model").or(st.model.take());
      out.push(Item::Meta(Meta { cwd: s(p, "cwd"), model: st.model.clone(), ..Default::default() }));
    }
    "response_item" => match p.get("type").and_then(Value::as_str) {
      Some("message") => {
        let role = match p.get("role").and_then(Value::as_str) {
          Some("user") => Role::User,
          Some("assistant") => Role::Assistant,
          _ => return,
        };
        if let Some(t) = p.get("content").and_then(content_text) {
          out.push(turn(role, t, at));
        }
      }
      Some("function_call" | "custom_tool_call" | "local_shell_call") => {
        let name = s(p, "name").unwrap_or_else(|| "shell".into());
        let args = p.get("arguments").and_then(Value::as_str).and_then(|a| serde_json::from_str::<Value>(a).ok());
        let input = args.as_ref().or(p.get("input")).or(p.get("action"));
        out.push(Item::Turn { role: Role::Tool, text: tool_line(&name, input), at, typed: true });
      }
      _ => {
        if let Some(t) = at {
          out.push(Item::At(t));
        }
      }
    },
    "event_msg" if p.get("type").and_then(Value::as_str) == Some("token_count") => {
      let Some(total) = p.get("info").and_then(|i| i.get("total_token_usage")) else { return };
      let input = n(total.get("input_tokens"));
      let cached = n(total.get("cached_input_tokens")).min(input);
      // Codex's input includes the cached part; output already includes reasoning.
      let now = Tokens { input: input - cached, output: n(total.get("output_tokens")), cache_read: cached, cache_write: 0 };
      // A total that goes down is a restarted counter (a resumed rollout): all of it is new.
      let delta = match st.totals {
        Some(prev) if now.input >= prev.input && now.output >= prev.output && now.cache_read >= prev.cache_read => Tokens { input: now.input - prev.input, output: now.output - prev.output, cache_read: now.cache_read - prev.cache_read, cache_write: 0 },
        _ => now,
      };
      st.totals = Some(now);
      if !delta.is_zero() {
        out.push(Item::Usage { at, model: st.model.clone(), tokens: delta });
      }
    }
    _ => {
      if let Some(t) = at {
        out.push(Item::At(t));
      }
    }
  }
}

fn cursor(v: &Value, out: &mut Vec<Item>) {
  let role = match v.get("role").and_then(Value::as_str).or_else(|| v.get("message").and_then(|m| m.get("role")).and_then(Value::as_str)) {
    Some("user") => Role::User,
    Some("assistant") => Role::Assistant,
    _ => return,
  };
  let at = time_of(v.get("timestamp"));
  let content = v.get("message").and_then(|m| m.get("content")).or_else(|| v.get("content"));
  if let Some(t) = content.and_then(content_text) {
    out.push(turn(role, t, at));
  }
  if let Some(Value::Array(parts)) = content {
    for p in parts.iter().filter(|p| matches!(p.get("type").and_then(Value::as_str), Some("tool_use" | "tool-call"))) {
      let name = p.get("name").or_else(|| p.get("toolName")).and_then(Value::as_str).unwrap_or("tool");
      out.push(Item::Turn { role: Role::Tool, text: tool_line(name, p.get("input").or_else(|| p.get("args"))), at, typed: true });
    }
  }
}

/// One Gemini CLI message (`type`: `user`, `gemini`, `info`, `error`), or a session header.
fn gemini_record(v: &Value, out: &mut Vec<Item>) {
  if v.get("sessionId").is_some() || v.get("projectHash").is_some() {
    out.push(Item::Meta(Meta { id: s(v, "sessionId"), title: s(v, "summary"), ..Default::default() }));
    if let Some(t) = time_of(v.get("startTime")) {
      out.push(Item::At(t));
    }
    if let Some(t) = time_of(v.get("lastUpdated")) {
      out.push(Item::At(t));
    }
  }
  let at = time_of(v.get("timestamp"));
  let role = match v.get("type").and_then(Value::as_str) {
    Some("user") => Role::User,
    Some("gemini" | "model" | "assistant") => Role::Assistant,
    _ => {
      if let Some(t) = at {
        out.push(Item::At(t));
      }
      return;
    }
  };
  let model = s(v, "model");
  if model.is_some() {
    out.push(Item::Meta(Meta { model: model.clone(), ..Default::default() }));
  }
  if let Some(t) = v.get("content").and_then(content_text) {
    out.push(turn(role, t, at));
  } else if let Some(t) = at {
    out.push(Item::At(t));
  }
  if let Some(Value::Array(calls)) = v.get("toolCalls") {
    for c in calls {
      out.push(Item::Turn { role: Role::Tool, text: tool_line(c.get("name").and_then(Value::as_str).unwrap_or("tool"), c.get("args")), at, typed: true });
    }
  }
  if let Some(tk) = v.get("tokens") {
    // Gemini's input includes the cached part and tool-use prompts are billed as input;
    // thinking is billed as output.
    let input = n(tk.get("input")) + n(tk.get("tool"));
    let cached = n(tk.get("cached")).min(input);
    let tokens = Tokens { input: input - cached, output: n(tk.get("output")) + n(tk.get("thoughts")), cache_read: cached, cache_write: 0 };
    if !tokens.is_zero() {
      out.push(Item::Usage { at, model, tokens });
    }
  }
}

fn read_document(path: &Path) -> Option<Value> {
  let len = std::fs::metadata(path).ok()?.len();
  if len > MAX_DOCUMENT {
    return None;
  }
  let file = std::fs::File::open(path).ok()?;
  serde_json::from_reader(BufReader::new(file)).ok()
}

/// A Gemini session written as one JSON document.
pub fn gemini_document(path: &Path) -> Option<Vec<Item>> {
  let doc = read_document(path)?;
  let mut out = Vec::new();
  gemini_record(&doc, &mut out);
  for m in doc.get("messages").and_then(Value::as_array).into_iter().flatten() {
    gemini_record(m, &mut out);
  }
  Some(out)
}

/// `storage/session/<project>/<id>.json` → `storage`.
pub fn opencode_storage(session: &Path) -> Option<PathBuf> {
  Some(session.parent()?.parent()?.parent()?.to_path_buf())
}

/// The JSON files directly in `dir`, by name (OpenCode ids sort in creation order).
fn json_files(dir: &Path, max: usize) -> Vec<PathBuf> {
  let mut files: Vec<PathBuf> = std::fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json")).collect();
  files.sort();
  files.truncate(max);
  files
}

/// An OpenCode session: its file, then each message with its text parts.
pub fn opencode_items(session: &Path, with_text: bool) -> Option<Vec<Item>> {
  let doc = read_document(session)?;
  let mut out = Vec::new();
  let created = time_of(doc.get("time").and_then(|t| t.get("created")));
  out.push(Item::Meta(Meta { id: s(&doc, "id"), title: s(&doc, "title"), cwd: s(&doc, "directory"), ..Default::default() }));
  if let Some(t) = created {
    out.push(Item::At(t));
  }
  if let Some(t) = time_of(doc.get("time").and_then(|t| t.get("updated"))) {
    out.push(Item::At(t));
  }
  let (Some(storage), Some(id)) = (opencode_storage(session), s(&doc, "id")) else { return Some(out) };
  if id.contains(['/', '\\', '.']) {
    return Some(out);
  }
  for file in json_files(&storage.join("message").join(&id), MAX_OPENCODE_MESSAGES) {
    let Some(m) = read_document(&file) else { continue };
    let at = time_of(m.get("time").and_then(|t| t.get("created")));
    let role = match m.get("role").and_then(Value::as_str) {
      Some("user") => Role::User,
      Some("assistant") => Role::Assistant,
      _ => continue,
    };
    let model = s(&m, "modelID");
    if model.is_some() {
      out.push(Item::Meta(Meta { model: model.clone(), ..Default::default() }));
    }
    if let Some(tk) = m.get("tokens") {
      let cache = tk.get("cache");
      let tokens = Tokens { input: n(tk.get("input")), output: n(tk.get("output")) + n(tk.get("reasoning")), cache_read: n(cache.and_then(|c| c.get("read"))), cache_write: n(cache.and_then(|c| c.get("write"))) };
      if !tokens.is_zero() {
        out.push(Item::Usage { at, model: model.clone(), tokens });
      }
    }
    if !with_text {
      if let Some(t) = at {
        out.push(Item::At(t));
      }
      continue;
    }
    let Some(mid) = s(&m, "id").filter(|x| !x.contains(['/', '\\', '.'])) else { continue };
    let mut text = Vec::new();
    for part in json_files(&storage.join("part").join(&mid), 500) {
      let Some(p) = read_document(&part) else { continue };
      match p.get("type").and_then(Value::as_str) {
        Some("text") if p.get("synthetic").and_then(Value::as_bool) != Some(true) => text.extend(s(&p, "text")),
        Some("tool") => out.push(Item::Turn { role: Role::Tool, text: tool_line(p.get("tool").and_then(Value::as_str).unwrap_or("tool"), p.get("state").and_then(|st| st.get("input"))), at, typed: true }),
        _ => {}
      }
    }
    if text.is_empty() {
      if let Some(t) = at {
        out.push(Item::At(t));
      }
    } else {
      out.push(turn(role, text.join("\n"), at));
    }
  }
  Some(out)
}

/// The text a search looks at in one item: what was said, and tool calls.
pub fn item_text(item: &Item) -> Option<&str> {
  match item {
    Item::Turn { text, .. } => Some(text),
    Item::Meta(m) => m.title.as_deref(),
    _ => None,
  }
}

/// Up to `MAX_TURN_CHARS` characters of `text`.
pub fn cut(text: &str, max: usize) -> String {
  match text.char_indices().nth(max) {
    Some((i, _)) => format!("{}…", &text[..i]),
    None => text.to_owned(),
  }
}

/// One line of `text` around the first (case-insensitive) `needle`, for a search result.
pub fn excerpt(text: &str, needle_lower: &str) -> Option<String> {
  let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
  let lower = flat.to_lowercase();
  let at = lower.find(needle_lower)?;
  // Map the byte offset in the lowercased text back to a character index (lowercasing can
  // change byte lengths, never the character count for the scripts this is used on).
  let ci = lower[..at].chars().count();
  let chars: Vec<char> = flat.chars().collect();
  let start = ci.saturating_sub(60);
  let end = (ci + needle_lower.chars().count() + 140).min(chars.len());
  let mut s: String = chars[start..end].iter().collect();
  if start > 0 {
    s.insert(0, '…');
  }
  if end < chars.len() {
    s.push('…');
  }
  Some(s)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn items_of(agent: Agent, text: &str) -> Vec<Item> {
    let mut st = LineState::default();
    let mut out = Vec::new();
    for l in text.lines() {
      if let Ok(v) = serde_json::from_str::<Value>(l) {
        line_items(agent, &v, &mut st, &mut out);
      }
    }
    out
  }

  #[test]
  fn long_lines_are_skipped_and_torn_tails_read() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("t.jsonl");
    let big = "x".repeat(MAX_LINE + 10);
    std::fs::write(&p, format!("a\n{big}\nb\nc")).unwrap();
    let mut got = Vec::new();
    each_line(&p, 0, u64::MAX, |l| {
      got.push(l.to_owned());
      ControlFlow::Continue(())
    })
    .unwrap();
    assert_eq!(got, ["a", "b", "c"]);
    let mut tail = Vec::new();
    each_line(&p, 1, u64::MAX, |l| {
      tail.push(l.len());
      ControlFlow::Continue(())
    })
    .unwrap();
    assert_eq!(tail, [1, 1], "the partial first line is dropped, the long one skipped");
  }

  #[test]
  fn unwraps_injected_context() {
    assert_eq!(unwrap_prompt("<environment_context>cwd</environment_context>\n\nFix it"), ("Fix it".into(), true));
    assert_eq!(unwrap_prompt("<timestamp>x</timestamp><user_query>\nHello\n</user_query>"), ("Hello".into(), true));
    assert!(!unwrap_prompt("<command-name>/clear</command-name>").1);
    assert_eq!(unwrap_prompt("a <b>c</b>"), ("a <b>c</b>".into(), true), "only leading blocks");
  }

  #[test]
  fn claude_counts_a_split_message_once() {
    let rec = r#"{"type":"assistant","requestId":"r1","timestamp":"2026-10-18T07:00:00Z","message":{"id":"m1","model":"claude-sonnet-4-5","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":100,"cache_creation_input_tokens":20},"content":[{"type":"text","text":"Hi"}]}}"#;
    let items = items_of(Agent::Claude, &format!("{rec}\n{rec}\n"));
    let usage: Vec<_> = items.iter().filter(|i| matches!(i, Item::Usage { .. })).collect();
    assert_eq!(usage.len(), 1);
    assert!(matches!(usage[0], Item::Usage { tokens: Tokens { input: 10, output: 5, cache_read: 100, cache_write: 20 }, .. }));
  }

  #[test]
  fn codex_adds_up_running_totals() {
    let t = |i: u64, c: u64, o: u64| format!(r#"{{"timestamp":"2026-10-18T07:00:00Z","type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":{i},"cached_input_tokens":{c},"output_tokens":{o}}}}}}}}}"#);
    let text = [r#"{"type":"turn_context","payload":{"model":"gpt-5-codex","cwd":"/w"}}"#.to_owned(), t(100, 40, 10), t(150, 60, 30), t(20, 0, 5)].join("\n");
    let sum = items_of(Agent::Codex, &text).iter().fold(Tokens::default(), |mut acc, i| {
      if let Item::Usage { tokens, model, .. } = i {
        assert_eq!(model.as_deref(), Some("gpt-5-codex"));
        acc.add(tokens);
      }
      acc
    });
    // 60+30 uncached input, 40+20 cached, 10+20 output, then a restart adds 20 and 5.
    assert_eq!(sum, Tokens { input: 110, output: 35, cache_read: 60, cache_write: 0 });
  }

  #[test]
  fn excerpts_center_on_the_match() {
    let e = excerpt("one two\nthree   Login bug here", "login").unwrap();
    assert_eq!(e, "one two three Login bug here");
    let long = format!("{} needle {}", "a".repeat(200), "b".repeat(300));
    let e = excerpt(&long, "needle").unwrap();
    assert!(e.starts_with('…') && e.ends_with('…') && e.contains("needle"));
  }
}
