//! Agent chats: conversations with the agent that are not ADE tasks (no worktree, no setup
//! script, no tabs), like VS Code's chat sessions. One chat is one agent-host session.
//!
//! - `<root>/.kingu/chats.json`: the chat list (the webview owns it and its reducers; Rust
//!   validates the whole list and writes it atomically, like tasks.json).
//! - `<root>/.kingu/chats/<id>.jsonl`: the chat's transcript, appended by Rust from the run's
//!   event stream (`Transcript`), one `{"t": ms, "event": AgentEvent}` per line. Streaming
//!   chunks, stderr and raw lines are not kept, long fields are cut, and the file is kept under
//!   `MAX_TRANSCRIPT_BYTES` by dropping its oldest lines. It holds no more than Claude's own
//!   session log (prompts, tool calls and results); account env never reaches events.
//! - `resolve_cwd`: where a chat (or any agent run given an explicit folder) may run: the open
//!   folder itself or one of its task worktrees, after canonicalizing.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::i18n::msg::{AgentMsg, FilesMsg, TasksMsg};
use crate::settings::{kingu_file, read, write_atomic};
use crate::tr;

use super::events::AgentEvent;
use super::tasks::{RunSummary, valid_session_id, validate_run_summary};
use super::worktree::validate_slug;

const FILE: &str = "chats.json";
const DIR: &str = "chats";
const VERSION: u32 = 1;
const MAX_CHATS: usize = 300;
const MAX_ID: usize = 64;
const MAX_TITLE: usize = 200;
/// The chat's first prompt (for "Promote to task"); the webview cuts it to this.
pub const MAX_PROMPT: usize = 2000;
const MAX_MODEL: usize = 128;
/// Tools a chat may turn off, and how long one name may be.
pub const MAX_DISABLED_TOOLS: usize = 500;
const MAX_TOOL_NAME: usize = 200;
/// The modes a saved chat may keep. "Allow all" (`bypassPermissions`) is never saved: `chats.json`
/// lives in the folder, so a repository could ship one that turns every prompt off.
pub const PERMISSION_MODES: &[&str] = &["default", "acceptEdits", "plan"];
/// The modes a run may start with or switch to: the saved ones, and "Allow all", which the user
/// picks (and confirms) in the chat for that session only.
pub const RUN_PERMISSION_MODES: &[&str] = &["default", "acceptEdits", "plan", "bypassPermissions"];

/// Transcript bounds: the file never grows past this; when it would, the oldest lines go until
/// it is at most half of it.
pub const MAX_TRANSCRIPT_BYTES: u64 = 4 * 1024 * 1024;
/// Events read back when a chat is opened (the timeline's own cap, `MAX_ITEMS` in events.ts).
pub const MAX_LOADED_EVENTS: usize = 3000;
const MAX_TEXT: usize = 64 * 1024;
const MAX_THINKING: usize = 16 * 1024;
const MAX_TOOL_RESULT: usize = 8 * 1024;
const MAX_ERROR: usize = 4 * 1024;
const MAX_INPUT_STRING: usize = 2 * 1024;
const MAX_INPUT: usize = 16 * 1024;
/// A tool input a transcript keeps whole (`Transcript::full_inputs`: Arkai's history), at most.
const MAX_FULL_INPUT: usize = 256 * 1024;

/// Where the chat's agent runs: the open folder or a task's worktree.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChatCwd {
  Folder,
  Task { slug: String },
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ChatMeta {
  pub id: String,
  /// From the first prompt, then the AI title (`ai_chat_title`); renameable.
  pub title: String,
  /// The title is still Kingu's own (not renamed by the user), so an AI title may replace it.
  /// False for chats saved before it existed.
  #[serde(default)]
  pub title_auto: bool,
  /// The first prompt (cut to `MAX_PROMPT`), for "Promote to task".
  #[serde(default)]
  pub prompt: String,
  pub cwd: ChatCwd,
  /// The agent session; a message after the run ended resumes it.
  #[serde(default)]
  pub session_id: Option<String>,
  /// After a rewind or a fork: the next run resumes `session_id` up to this message only, in a
  /// fork of it (`rewind`); cleared once that run reports its own session.
  #[serde(default)]
  pub resume_at: Option<String>,
  #[serde(default)]
  pub model: Option<String>,
  #[serde(default)]
  pub permission_mode: Option<String>,
  /// Which agent runs the chat (`runtimes`): `claude`, the Claude Agent SDK, unless set.
  #[serde(default = "super::runtimes::default_id")]
  pub runtime: String,
  /// The chat's agent besides Agent and Plan (the permission mode): `ask`, or a custom agent's
  /// name (`customizations`; looked up among the files found, never read from this value).
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub agent: Option<String>,
  /// Unix milliseconds.
  pub created_at: u64,
  #[serde(default)]
  pub updated_at: u64,
  #[serde(default)]
  pub last_run: Option<RunSummary>,
  /// A turn was running when this was saved; still set at the next launch means Kingu quit
  /// mid-turn (`kingu.chat.resumeWorkOnRestart` continues those chats).
  #[serde(default, skip_serializing_if = "std::ops::Not::not")]
  pub working: bool,
  /// A side chat (the Agent panel's "Ask in Side Chat"): the chat it was forked from. Kept out of
  /// the chat history until the user keeps it as a chat of its own.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub side_of: Option<String>,
  /// Tools the user turned off in the chat's Configure Tools picker (Claude tool names,
  /// `mcp__<server>` or `mcp__<server>__<tool>`); its runs go without them (`disallowedTools`).
  /// Only ever takes tools away, so a repository's chats.json cannot grant anything.
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub disabled_tools: Vec<String>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct ChatsFile {
  version: u32,
  chats: Vec<ChatMeta>,
}

/// Chat ids name a file: lowercase letters, digits and `-`, 1-64 characters.
pub fn valid_id(id: &str) -> bool {
  !id.is_empty() && id.len() <= MAX_ID && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') && !id.starts_with('-')
}

pub fn check_id(id: &str) -> Result<(), String> {
  if valid_id(id) { Ok(()) } else { Err(tr!(AgentMsg::BadChatId)) }
}

/// A tool name as the SDK takes it: `Bash`, `mcp__github`, `mcp__github__search_issues`.
pub fn valid_tool_name(t: &str) -> bool {
  !t.is_empty() && t.len() <= MAX_TOOL_NAME && t.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '*'))
}

/// A list of tool names to leave out: at most `MAX_DISABLED_TOOLS`, each `valid_tool_name`.
pub fn check_tool_names(id: &str, tools: &[String]) -> Result<(), String> {
  if tools.len() > MAX_DISABLED_TOOLS || tools.iter().any(|t| !valid_tool_name(t)) {
    return Err(format!("{id}: invalid tool list"));
  }
  Ok(())
}

fn valid_model(m: &str) -> bool {
  !m.trim().is_empty() && m.len() <= MAX_MODEL && m.chars().all(|c| c.is_ascii_graphic())
}

pub fn path(root: &Path) -> Result<PathBuf, String> {
  kingu_file(root, FILE)
}

/// Empty when the file does not exist yet.
pub fn load(root: &Path) -> Result<Vec<ChatMeta>, String> {
  let path = path(root)?;
  let Some(text) = read(&path)? else { return Ok(Vec::new()) };
  let file: ChatsFile = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
  if file.version > VERSION {
    return Err(tr!(AgentMsg::AutomationsNewer, path = path.display(), version = file.version));
  }
  Ok(file.chats)
}

pub fn validate(chats: &[ChatMeta]) -> Result<(), String> {
  if chats.len() > MAX_CHATS {
    return Err(tr!(TasksMsg::TooManyChats, max = MAX_CHATS));
  }
  let mut seen = HashSet::new();
  for c in chats {
    check_id(&c.id)?;
    if !seen.insert(c.id.as_str()) {
      return Err(format!("{}: duplicate chat", c.id));
    }
    if c.title.trim().is_empty() || c.title.chars().count() > MAX_TITLE {
      return Err(tr!(TasksMsg::TitleLength, name = c.id, max = MAX_TITLE));
    }
    if c.prompt.chars().count() > MAX_PROMPT {
      return Err(tr!(TasksMsg::ChatPromptTooLong, id = c.id, max = MAX_PROMPT));
    }
    if let ChatCwd::Task { slug } = &c.cwd {
      validate_slug(slug)?;
    }
    if c.session_id.as_deref().is_some_and(|id| !valid_session_id(id)) {
      return Err(format!("{}: invalid session id", c.id));
    }
    if c.resume_at.as_deref().is_some_and(|u| !super::rewind::valid_uuid(u) || c.session_id.is_none()) {
      return Err(format!("{}: invalid resume point", c.id));
    }
    if c.model.as_deref().is_some_and(|m| !valid_model(m)) {
      return Err(format!("{}: invalid model", c.id));
    }
    if c.permission_mode.as_deref().is_some_and(|m| !PERMISSION_MODES.contains(&m)) {
      return Err(format!("{}: unsupported permission mode", c.id));
    }
    if !super::runtimes::valid_id(&c.runtime) {
      return Err(format!("{}: invalid runtime", c.id));
    }
    if c.agent.as_deref().is_some_and(|a| a.trim().is_empty() || a.chars().count() > 100 || a.chars().any(char::is_control)) {
      return Err(format!("{}: invalid agent", c.id));
    }
    if let Some(parent) = &c.side_of {
      check_id(parent)?;
    }
    if let Some(r) = &c.last_run {
      validate_run_summary(&c.id, r)?;
    }
    check_tool_names(&c.id, &c.disabled_tools)?;
  }
  Ok(())
}

pub fn save(root: &Path, chats: &[ChatMeta]) -> Result<(), String> {
  validate(chats)?;
  let text = serde_json::to_string_pretty(&ChatsFile { version: VERSION, chats: chats.to_vec() }).map_err(|e| e.to_string())?;
  write_atomic(&path(root)?, &(text + "\n"))
}

// ---------------------------------------------------------------------------------------------
// Working directory

/// `cwd` as a run directory of `root` (both canonicalized): `root` itself or a task worktree
/// `<root>/.kingu/worktrees/<slug>`. Symlinks are resolved first, so one pointing elsewhere is refused.
pub fn resolve_cwd(root: &Path, cwd: &Path) -> Result<PathBuf, String> {
  let shown = cwd.display().to_string();
  if !cwd.is_absolute() {
    return Err(tr!(AgentMsg::ChatCwdOutside, path = shown));
  }
  let dir = std::fs::canonicalize(cwd).map_err(|_| tr!(AgentMsg::ChatCwdMissing, path = shown))?;
  if !dir.is_dir() {
    return Err(tr!(AgentMsg::ChatCwdMissing, path = shown));
  }
  let root = std::fs::canonicalize(root).map_err(|e| format!("{}: {e}", root.display()))?;
  if dir == root {
    return Ok(dir);
  }
  let worktrees = std::fs::canonicalize(super::worktree::worktree_path(&root, "x").parent().unwrap_or(&root)).ok();
  let in_worktrees = worktrees.is_some_and(|w| dir.parent() == Some(w.as_path()));
  let slug_ok = dir.file_name().and_then(|n| n.to_str()).is_some_and(|n| validate_slug(n).is_ok());
  if in_worktrees && slug_ok { Ok(dir) } else { Err(tr!(AgentMsg::ChatCwdOutside, path = shown)) }
}

// ---------------------------------------------------------------------------------------------
// Transcript

/// `<root>/.kingu/chats/<id>.jsonl`, refusing a symlinked `.kingu`, `chats` or transcript.
pub fn transcript_path(root: &Path, id: &str) -> Result<PathBuf, String> {
  check_id(id)?;
  let kingu = kingu_file(root, FILE)?.parent().map(Path::to_path_buf).ok_or("no .kingu")?;
  let dir = kingu.join(DIR);
  for p in [&kingu, &dir] {
    if let Ok(meta) = std::fs::symlink_metadata(p)
      && (meta.file_type().is_symlink() || !meta.is_dir())
    {
      return Err(tr!(FilesMsg::NotADirectory, path = p.display()));
    }
  }
  let file = dir.join(format!("{id}.jsonl"));
  if let Ok(meta) = std::fs::symlink_metadata(&file)
    && !meta.is_file()
  {
    return Err(tr!(FilesMsg::NotARegularFile, path = file.display()));
  }
  Ok(file)
}

fn cut(s: &mut String, max: usize) {
  if s.len() > max {
    let mut end = max;
    while !s.is_char_boundary(end) {
      end -= 1;
    }
    s.truncate(end);
    s.push('…');
  }
}

/// A tool input as kept: long strings cut; still too large, only its string fields' first lines.
fn bounded_input(v: &Value) -> Value {
  let mut v = v.clone();
  if let Value::Object(map) = &mut v {
    for val in map.values_mut() {
      if let Value::String(s) = val {
        cut(s, MAX_INPUT_STRING);
      }
    }
  }
  if v.to_string().len() <= MAX_INPUT {
    return v;
  }
  match v {
    Value::Object(map) => Value::Object(
      map
        .into_iter()
        .filter_map(|(k, val)| val.as_str().map(|s| (k, Value::String(s.lines().next().unwrap_or("").chars().take(200).collect()))))
        .collect(),
    ),
    _ => Value::Null,
  }
}

/// The event as the transcript keeps it, or `None` for what it leaves out (streaming chunks,
/// stderr, raw lines).
pub fn for_transcript(ev: &AgentEvent) -> Option<AgentEvent> {
  for_transcript_with(ev, false)
}

/// `full_inputs`: a tool call's input is kept whole up to `MAX_FULL_INPUT` (the chat shows it cut
/// all the same: [`load_transcript`]).
fn for_transcript_with(ev: &AgentEvent, full_inputs: bool) -> Option<AgentEvent> {
  let mut ev = ev.clone();
  match &mut ev {
    AgentEvent::ToolUse { input, .. } if full_inputs && input.to_string().len() <= MAX_FULL_INPUT => {}
    AgentEvent::Delta { .. } | AgentEvent::Stderr { .. } | AgentEvent::Raw { .. } | AgentEvent::FileSnapshot { .. } | AgentEvent::EditsChanged { .. } => {
      return None;
    }
    AgentEvent::Message { text, .. } => cut(text, MAX_TEXT),
    AgentEvent::Thinking { text, .. } => cut(text, MAX_THINKING),
    AgentEvent::ToolUse { input, .. } | AgentEvent::PermissionRequest { input, .. } => *input = bounded_input(input),
    AgentEvent::ToolResult { content, .. } => cut(content, MAX_TOOL_RESULT),
    AgentEvent::Result { result: Some(r), .. } => cut(r, MAX_TEXT),
    AgentEvent::Error { message } => cut(message, MAX_ERROR),
    AgentEvent::HookRun { output, .. } => cut(output, MAX_ERROR),
    _ => {}
  }
  Some(ev)
}

#[derive(serde::Serialize, serde::Deserialize)]
pub(super) struct Line {
  pub t: u64,
  pub event: AgentEvent,
}

fn now_ms() -> u64 {
  std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn open_append(path: &Path) -> std::io::Result<std::fs::File> {
  let mut o = std::fs::OpenOptions::new();
  o.create(true).append(true);
  #[cfg(unix)]
  std::os::unix::fs::OpenOptionsExt::custom_flags(&mut o, libc::O_NOFOLLOW);
  o.open(path)
}

/// Appends one chat's events to its transcript. One per run; the single-owner rule
/// (`host::Owners`) keeps two runs of a chat from writing at once.
pub struct Transcript {
  path: PathBuf,
  max: u64,
  full_inputs: bool,
}

impl Transcript {
  pub fn new(root: &Path, id: &str) -> Result<Self, String> {
    let path = transcript_path(root, id)?;
    let dir = path.parent().ok_or("transcript path has no parent")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(Self { path, max: MAX_TRANSCRIPT_BYTES, full_inputs: false })
  }

  /// Keeps tool inputs whole (within `MAX_FULL_INPUT`): a runtime whose history is the transcript.
  pub fn full_inputs(mut self, on: bool) -> Self {
    self.full_inputs = on;
    self
  }

  #[cfg(test)]
  fn with_max(mut self, max: u64) -> Self {
    self.max = max;
    self
  }

  /// Best effort: a full disk must not stop the run, so errors are only logged by the caller.
  pub fn append(&self, ev: &AgentEvent) -> Result<(), String> {
    self.append_at(ev, now_ms())
  }

  fn append_at(&self, ev: &AgentEvent, t: u64) -> Result<(), String> {
    let Some(event) = for_transcript_with(ev, self.full_inputs) else { return Ok(()) };
    let mut line = serde_json::to_vec(&Line { t, event }).map_err(|e| e.to_string())?;
    line.push(b'\n');
    let size = std::fs::symlink_metadata(&self.path).map_or(0, |m| m.len());
    if size + line.len() as u64 > self.max {
      self.compact(self.max / 2 - (line.len() as u64).min(self.max / 2))?;
    }
    let mut f = open_append(&self.path).map_err(|e| format!("{}: {e}", self.path.display()))?;
    f.write_all(&line).map_err(|e| format!("{}: {e}", self.path.display()))
  }

  /// Keeps the newest whole lines that fit in `keep` bytes.
  fn compact(&self, keep: u64) -> Result<(), String> {
    let bytes = std::fs::read(&self.path).map_err(|e| format!("{}: {e}", self.path.display()))?;
    let mut start = bytes.len().saturating_sub(keep as usize);
    if start > 0 {
      start = bytes[start - 1..].iter().position(|&b| b == b'\n').map_or(bytes.len(), |i| start + i);
    }
    let kept = String::from_utf8_lossy(&bytes[start..]).into_owned();
    write_atomic_big(&self.path, &kept)
  }
}

/// `write_atomic` without the settings size cap (a transcript is bounded by `MAX_TRANSCRIPT_BYTES`).
pub(super) fn write_atomic_big(path: &Path, content: &str) -> Result<(), String> {
  if content.len() as u64 <= 1024 * 1024 {
    return write_atomic(path, content);
  }
  let dir = path.parent().ok_or("no parent")?;
  let tmp = dir.join(format!(".{}.{}.tmp", path.file_name().and_then(|n| n.to_str()).unwrap_or("chat"), std::process::id()));
  let result = (|| {
    let mut f = std::fs::File::create(&tmp)?;
    f.write_all(content.as_bytes())?;
    f.sync_all()?;
    std::fs::rename(&tmp, path)
  })();
  if let Err(e) = result {
    let _ = std::fs::remove_file(&tmp);
    return Err(format!("{}: {e}", path.display()));
  }
  Ok(())
}

/// The newest `MAX_LOADED_EVENTS` events of the chat, oldest first, as the chat shows them (tool
/// inputs cut); empty without a transcript. Lines that do not parse (a torn last line after a
/// crash) are skipped, and so are `Anchor`s (rewind points, for Rust only).
pub fn load_transcript(root: &Path, id: &str) -> Result<Vec<AgentEvent>, String> {
  let mut events = load_transcript_full(root, id)?;
  for ev in &mut events {
    if let AgentEvent::ToolUse { input, .. } = ev {
      *input = bounded_input(input);
    }
  }
  Ok(events)
}

/// [`load_transcript`] with tool inputs as kept (whole for Arkai): the conversation a continued
/// Arkai run gets back.
pub fn load_transcript_full(root: &Path, id: &str) -> Result<Vec<AgentEvent>, String> {
  let path = transcript_path(root, id)?;
  let bytes = match std::fs::read(&path) {
    Ok(b) => b,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
    Err(e) => return Err(format!("{}: {e}", path.display())),
  };
  // A file grown past the cap by hand: read only its tail.
  let from = bytes.len().saturating_sub(2 * MAX_TRANSCRIPT_BYTES as usize);
  let text = String::from_utf8_lossy(&bytes[from..]);
  let mut events: Vec<AgentEvent> = text
    .lines()
    .filter_map(|l| serde_json::from_str::<Line>(l).ok())
    .map(|l| l.event)
    .filter(|e| !rust_only(e))
    .collect();
  if events.len() > MAX_LOADED_EVENTS {
    events.drain(..events.len() - MAX_LOADED_EVENTS);
  }
  Ok(events)
}

/// Transcript events for Rust only: rewind points and what the Chat Debug view reads.
pub fn rust_only(ev: &AgentEvent) -> bool {
  matches!(ev, AgentEvent::Anchor { .. } | AgentEvent::HookRun { .. } | AgentEvent::RunInfo { .. })
}

/// Every kept line of the transcript with its time (Unix ms), oldest first, anchors included;
/// at most the newest `max` lines. Torn lines are skipped. Empty without a transcript.
pub fn load_lines(root: &Path, id: &str, max: usize) -> Result<Vec<(u64, AgentEvent)>, String> {
  let path = transcript_path(root, id)?;
  let bytes = match std::fs::read(&path) {
    Ok(b) => b,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
    Err(e) => return Err(format!("{}: {e}", path.display())),
  };
  let from = bytes.len().saturating_sub(2 * MAX_TRANSCRIPT_BYTES as usize);
  let text = String::from_utf8_lossy(&bytes[from..]);
  let mut lines: Vec<(u64, AgentEvent)> = text.lines().filter_map(|l| serde_json::from_str::<Line>(l).ok()).map(|l| (l.t, l.event)).collect();
  if lines.len() > max {
    lines.drain(..lines.len() - max);
  }
  Ok(lines)
}

pub fn delete_transcript(root: &Path, id: &str) -> Result<(), String> {
  let path = transcript_path(root, id)?;
  match std::fs::remove_file(&path) {
    Ok(()) => Ok(()),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(e) => Err(format!("{}: {e}", path.display())),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn chat(id: &str) -> ChatMeta {
    ChatMeta {
      id: id.into(),
      title: format!("แชต {id}"),
      title_auto: true,
      prompt: "อธิบาย main.rs".into(),
      cwd: ChatCwd::Folder,
      session_id: Some("0b5e-4c1d_9".into()),
      resume_at: None,
      model: Some("claude-opus-5-5[1m]".into()),
      permission_mode: Some("acceptEdits".into()),
      runtime: "claude".into(),
      agent: None,
      created_at: 1,
      updated_at: 2,
      last_run: Some(RunSummary {
        status: "idle".into(),
        at: 3,
        summary: Some("เสร็จ".into()),
        error: None,
        cost_usd: Some(0.01),
        input_tokens: Some(10),
        output_tokens: Some(2),
        num_turns: Some(1),
        started_at: Some(1),
      }),
      working: false,
      side_of: None,
      disabled_tools: Vec::new(),
    }
  }

  #[test]
  fn chats_round_trip_and_start_empty() {
    let tmp = tempfile::tempdir().unwrap();
    assert_eq!(load(tmp.path()).unwrap(), []);
    let chats = vec![chat("c-1"), ChatMeta { cwd: ChatCwd::Task { slug: "fix-login".into() }, working: true, ..chat("c-2") }];
    save(tmp.path(), &chats).unwrap();
    assert_eq!(load(tmp.path()).unwrap(), chats);
    let text = std::fs::read_to_string(tmp.path().join(".kingu/chats.json")).unwrap();
    assert!(text.contains(r#""kind": "task""#) && text.contains(r#""slug": "fix-login""#), "{text}");
    let names: Vec<_> = std::fs::read_dir(tmp.path().join(".kingu")).unwrap().flatten().map(|e| e.file_name()).collect();
    assert_eq!(names, ["chats.json"], "no temp file left behind");
  }

  #[test]
  fn older_files_get_defaults() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir(tmp.path().join(".kingu")).unwrap();
    std::fs::write(tmp.path().join(".kingu/chats.json"), r#"{"version":1,"chats":[{"id":"a","title":"A","cwd":{"kind":"folder"},"created_at":5}]}"#).unwrap();
    let c = &load(tmp.path()).unwrap()[0];
    assert_eq!((c.prompt.as_str(), c.session_id.as_deref(), c.model.as_deref(), c.updated_at, c.title_auto), ("", None, None, 0, false));
    assert_eq!(c.runtime, "claude", "chats from before runtimes run on the Claude SDK");
    std::fs::write(tmp.path().join(".kingu/chats.json"), r#"{"version":9,"chats":[]}"#).unwrap();
    assert!(load(tmp.path()).unwrap_err().contains("newer Kingu"));
  }

  #[test]
  fn rejects_invalid_lists() {
    let tmp = tempfile::tempdir().unwrap();
    let bad = |f: fn(&mut ChatMeta)| {
      let mut c = chat("a");
      f(&mut c);
      save(tmp.path(), &[c]).is_err()
    };
    assert!(bad(|c| c.id = "../x".into()));
    assert!(bad(|c| c.id = "A".into()));
    assert!(bad(|c| c.id = String::new()));
    assert!(bad(|c| c.id = "x".repeat(MAX_ID + 1)));
    assert!(bad(|c| c.title = " ".into()));
    assert!(bad(|c| c.title = "ก".repeat(MAX_TITLE + 1)));
    assert!(bad(|c| c.prompt = "x".repeat(MAX_PROMPT + 1)));
    assert!(bad(|c| c.cwd = ChatCwd::Task { slug: "../etc".into() }));
    assert!(bad(|c| c.session_id = Some("--resume; rm".into())));
    assert!(bad(|c| c.resume_at = Some("not-a-uuid".into())));
    assert!(bad(|c| (c.session_id, c.resume_at) = (None, Some("0b5e9a1c-4c1d-4e2f-9a3b-1234567890ab".into()))));
    assert!(validate(&[ChatMeta { resume_at: Some("0b5e9a1c-4c1d-4e2f-9a3b-1234567890ab".into()), ..chat("a") }]).is_ok());
    assert!(bad(|c| c.model = Some("opus --dangerously".into())));
    assert!(bad(|c| c.model = Some(" ".into())));
    assert!(bad(|c| c.permission_mode = Some("bypassPermissions".into())));
    assert!(bad(|c| c.runtime = "Gemini CLI".into()));
    assert!(bad(|c| c.runtime = String::new()));
    assert!(validate(&[ChatMeta { runtime: "gemini".into(), ..chat("a") }]).is_ok());
    assert!(validate(&[ChatMeta { agent: Some("Planner".into()), ..chat("a") }]).is_ok());
    assert!(validate(&[ChatMeta { side_of: Some("c-1".into()), ..chat("a") }]).is_ok());
    assert!(validate(&[ChatMeta { side_of: Some("../x".into()), ..chat("a") }]).is_err());
    assert!(validate(&[ChatMeta { disabled_tools: vec!["Bash".into(), "mcp__github".into(), "mcp__gh__search_issues".into()], ..chat("a") }]).is_ok());
    assert!(bad(|c| c.disabled_tools = vec!["Bash; rm".into()]));
    assert!(bad(|c| c.disabled_tools = vec![String::new()]));
    assert!(bad(|c| c.disabled_tools = vec!["x".into(); MAX_DISABLED_TOOLS + 1]));
    assert!(bad(|c| c.agent = Some(" ".into())));
    assert!(bad(|c| c.agent = Some("a\nb".into())));
    assert!(bad(|c| c.last_run.as_mut().unwrap().status = "weird".into()));
    assert!(bad(|c| c.last_run.as_mut().unwrap().cost_usd = Some(-1.0)));
    assert!(save(tmp.path(), &[chat("a"), chat("a")]).is_err());
    assert!(!tmp.path().join(".kingu/chats.json").exists());
    let mut c = chat("a");
    c.title = "ก".repeat(MAX_TITLE);
    c.prompt = "ก".repeat(MAX_PROMPT);
    assert!(validate(&[c]).is_ok(), "limits count characters");
  }

  #[test]
  fn cwd_is_the_root_or_a_task_worktree() {
    let tmp = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(tmp.path()).unwrap();
    let wt = root.join(".kingu/worktrees/fix-login");
    std::fs::create_dir_all(wt.join("src")).unwrap();
    std::fs::create_dir_all(root.join("sub")).unwrap();
    std::fs::create_dir_all(root.join(".kingu/worktrees/Bad_Name")).unwrap();
    assert_eq!(resolve_cwd(&root, &root).unwrap(), root);
    assert_eq!(resolve_cwd(&root, &root.join("sub/..")).unwrap(), root, "canonicalized");
    assert_eq!(resolve_cwd(&root, &wt).unwrap(), wt);
    for outside in [root.join("sub"), wt.join("src"), root.join(".kingu"), root.join(".kingu/worktrees"), root.join(".kingu/worktrees/Bad_Name"), root.parent().unwrap().to_path_buf()] {
      assert!(resolve_cwd(&root, &outside).unwrap_err().contains("only in the open folder"), "{}", outside.display());
    }
    assert!(resolve_cwd(&root, Path::new("relative")).is_err());
    assert!(resolve_cwd(&root, &root.join(".kingu/worktrees/gone")).unwrap_err().contains("not found"));
  }

  #[cfg(unix)]
  #[test]
  fn cwd_symlinks_are_resolved_before_the_check() {
    let tmp = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(tmp.path()).unwrap();
    std::fs::create_dir_all(root.join(".kingu/worktrees")).unwrap();
    std::os::unix::fs::symlink(outside.path(), root.join(".kingu/worktrees/evil")).unwrap();
    assert!(resolve_cwd(&root, &root.join(".kingu/worktrees/evil")).is_err());
    // A symlinked root (e.g. /tmp → /private/tmp) is the same folder.
    let link = tempfile::tempdir().unwrap();
    let alias = link.path().join("alias");
    std::os::unix::fs::symlink(&root, &alias).unwrap();
    assert_eq!(resolve_cwd(&root, &alias).unwrap(), root);
  }

  fn msg(text: &str) -> AgentEvent {
    AgentEvent::Message { role: "assistant".into(), text: text.into(), parent_tool_use_id: None }
  }

  #[test]
  fn transcript_keeps_normalized_events_and_reads_them_back() {
    let tmp = tempfile::tempdir().unwrap();
    let t = Transcript::new(tmp.path(), "c-1").unwrap();
    assert_eq!(load_transcript(tmp.path(), "c-1").unwrap(), [], "no transcript yet");
    let events = [
      AgentEvent::System { subtype: "init".into(), session_id: Some("s-1".into()), model: Some("m".into()) },
      AgentEvent::Message { role: "user".into(), text: "แก้บั๊ก".into(), parent_tool_use_id: None },
      AgentEvent::Delta { block: "text".into(), text: "ก".into() },
      AgentEvent::Stderr { line: "secret-ish".into() },
      AgentEvent::Raw { line: "{}".into() },
      AgentEvent::ToolUse { id: "t1".into(), name: "Write".into(), input: json!({"file_path": "a.rs", "content": "x".repeat(10_000)}), parent_tool_use_id: None },
      AgentEvent::ToolResult { tool_use_id: "t1".into(), content: "y".repeat(20_000), is_error: false, parent_tool_use_id: None },
      msg("เสร็จ"),
      AgentEvent::Exit { code: Some(0), signal: None, stopped: false },
    ];
    for e in &events {
      t.append(e).unwrap();
    }
    let back = load_transcript(tmp.path(), "c-1").unwrap();
    assert_eq!(back.len(), 6, "delta, stderr and raw are not kept");
    assert_eq!(back[0], events[0]);
    assert_eq!(back[1], events[1]);
    let AgentEvent::ToolUse { input, .. } = &back[2] else { panic!() };
    assert_eq!(input["file_path"], "a.rs");
    assert!(input["content"].as_str().unwrap().len() <= MAX_INPUT_STRING + 3);
    let AgentEvent::ToolResult { content, .. } = &back[3] else { panic!() };
    assert!(content.len() <= MAX_TOOL_RESULT + 3 && content.ends_with('…'));
    assert_eq!(back[5], events[8]);
    // A torn last line (crash mid-write) is skipped.
    std::fs::OpenOptions::new().append(true).open(transcript_path(tmp.path(), "c-1").unwrap()).unwrap().write_all(b"{\"t\":1,\"ev").unwrap();
    assert_eq!(load_transcript(tmp.path(), "c-1").unwrap().len(), 6);
    delete_transcript(tmp.path(), "c-1").unwrap();
    delete_transcript(tmp.path(), "c-1").unwrap();
    assert_eq!(load_transcript(tmp.path(), "c-1").unwrap(), []);
    assert!(Transcript::new(tmp.path(), "../x").is_err());
    assert!(load_transcript(tmp.path(), "C").is_err());
  }

  #[test]
  fn full_inputs_are_kept_for_the_model_and_cut_for_the_chat() {
    let tmp = tempfile::tempdir().unwrap();
    let content = "x".repeat(MAX_INPUT_STRING * 4);
    let call = AgentEvent::ToolUse { id: "c".into(), name: "Write".into(), input: json!({"file_path": "a.rs", "content": content}), parent_tool_use_id: None };
    Transcript::new(tmp.path(), "a").unwrap().full_inputs(true).append(&call).unwrap();
    let AgentEvent::ToolUse { input, .. } = &load_transcript_full(tmp.path(), "a").unwrap()[0] else { panic!() };
    assert_eq!(input["content"].as_str().unwrap().len(), MAX_INPUT_STRING * 4, "the model gets the whole input back");
    let AgentEvent::ToolUse { input, .. } = &load_transcript(tmp.path(), "a").unwrap()[0] else { panic!() };
    assert!(input["content"].as_str().unwrap().len() <= MAX_INPUT_STRING + 3, "the chat shows it cut");
    // Past its own cap, and without the option, the input is cut when written.
    let huge = AgentEvent::ToolUse { id: "d".into(), name: "Write".into(), input: json!({"content": "y".repeat(MAX_FULL_INPUT)}), parent_tool_use_id: None };
    let t = Transcript::new(tmp.path(), "b").unwrap().full_inputs(true);
    t.append(&huge).unwrap();
    Transcript::new(tmp.path(), "b").unwrap().append(&call).unwrap();
    for ev in load_transcript_full(tmp.path(), "b").unwrap() {
      let AgentEvent::ToolUse { input, .. } = ev else { panic!() };
      assert!(input["content"].as_str().unwrap().len() <= MAX_INPUT_STRING + 3);
    }
  }

  #[test]
  fn transcript_stays_under_its_cap_and_keeps_the_newest_lines() {
    let tmp = tempfile::tempdir().unwrap();
    let max = 4096;
    let t = Transcript::new(tmp.path(), "c").unwrap().with_max(max);
    for i in 0..500 {
      t.append_at(&msg(&format!("ข้อความ {i}")), i).unwrap();
      let size = std::fs::metadata(transcript_path(tmp.path(), "c").unwrap()).unwrap().len();
      assert!(size <= max, "{size} > {max} after {i}");
    }
    let back = load_transcript(tmp.path(), "c").unwrap();
    assert!(back.len() > 10 && back.len() < 500);
    assert_eq!(back.last(), Some(&msg("ข้อความ 499")));
    // Whole lines only: every kept line parses and they are consecutive.
    let n: Vec<usize> = back.iter().map(|e| if let AgentEvent::Message { text, .. } = e { text[text.rfind(' ').unwrap() + 1..].parse().unwrap() } else { 0 }).collect();
    assert!(n.windows(2).all(|w| w[1] == w[0] + 1));
  }

  #[test]
  fn loading_returns_at_most_the_newest_events() {
    let tmp = tempfile::tempdir().unwrap();
    let t = Transcript::new(tmp.path(), "c").unwrap();
    for i in 0..MAX_LOADED_EVENTS + 5 {
      t.append_at(&msg(&i.to_string()), 0).unwrap();
    }
    let back = load_transcript(tmp.path(), "c").unwrap();
    assert_eq!(back.len(), MAX_LOADED_EVENTS);
    assert_eq!(back[0], msg("5"));
  }

  #[test]
  fn oversized_inputs_shrink_to_first_lines() {
    let big: serde_json::Map<String, Value> = (0..40).map(|i| (format!("k{i}"), json!(format!("line one\n{}", "z".repeat(5000))))).collect();
    let v = bounded_input(&Value::Object(big));
    assert!(v.to_string().len() <= MAX_INPUT);
    assert_eq!(v["k0"], "line one");
    assert_eq!(bounded_input(&json!(["x".repeat(MAX_INPUT * 2)])), Value::Null);
  }

  #[cfg(unix)]
  #[test]
  fn refuses_symlinked_transcripts() {
    let tmp = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(tmp.path().join(".kingu")).unwrap();
    std::os::unix::fs::symlink(outside.path(), tmp.path().join(".kingu/chats")).unwrap();
    assert!(Transcript::new(tmp.path(), "c").is_err());
    std::fs::remove_file(tmp.path().join(".kingu/chats")).unwrap();
    std::fs::create_dir(tmp.path().join(".kingu/chats")).unwrap();
    std::os::unix::fs::symlink(outside.path().join("f"), tmp.path().join(".kingu/chats/c.jsonl")).unwrap();
    let t = Transcript { path: tmp.path().join(".kingu/chats/c.jsonl"), max: MAX_TRANSCRIPT_BYTES, full_inputs: false };
    assert!(t.append(&msg("x")).is_err(), "O_NOFOLLOW");
    assert!(!outside.path().join("f").exists());
  }
}
