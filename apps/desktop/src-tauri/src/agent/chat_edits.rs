//! The agent chat's file edits, like VS Code's chat editing session (agent mode): what each
//! request (user message) changed, kept or undone per file, and "Restore checkpoint".
//!
//! - Before an edit tool (Edit, MultiEdit, Write, NotebookEdit) changes a file, the agent host's
//!   PreToolUse hook sends the file's content (`AgentEvent::FileSnapshot`); [`ChatEdits::on_event`]
//!   stores it for the chat's current request. The first snapshot of a file per request (while
//!   that file has a pending entry) is its state before the request touched it.
//! - Files changed another way (Bash) cannot be snapshotted first: when a turn starts Rust records
//!   `git status` and HEAD (in memory), and when it ends it lists the files whose status, size or
//!   mtime moved and that no edit tool snapshotted, as `Source::Shell` entries. A file that was
//!   clean and tracked before the turn (with HEAD unchanged) is restorable from HEAD, whose blob
//!   is stored as its snapshot; the rest are listed without Undo (`Before::Unknown`).
//! - Storage: `<root>/.kingu/chats/<id>/edits.json` (entries and requests, written atomically) and
//!   `<root>/.kingu/chats/<id>/snapshots/<sha256>` (content-addressed blobs). A file of
//!   `MAX_SNAPSHOT_BYTES` or more is not stored, and the store of one chat stays under
//!   `MAX_STORE_BYTES` (later snapshots are refused, `Skip::Budget`).
//! - Paths are kept relative to the chat's cwd, `/`-separated; every read and write checks them
//!   (no `..`, no `.git`, not a symlink, nearest existing ancestor inside the cwd).
//! - Undo / Restore checkpoint write files under the worktree's git queue lane and are refused
//!   while a turn of the chat runs. Keep only clears the entry.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use base64::Engine;
use sha2::{Digest, Sha256};

use crate::git_queue::{self, Scope};
use crate::i18n::msg::AgentMsg;
use crate::tr;

use super::chats::{check_id, transcript_path};
use super::events::AgentEvent;

/// Files this large are not snapshotted (the host has the same limit).
pub const MAX_SNAPSHOT_BYTES: u64 = 5 * 1024 * 1024;
/// Snapshot store bound per chat.
pub const MAX_STORE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_ENTRIES: usize = 5000;
const MAX_REQUESTS: usize = 10_000;
/// More changed files than this in `git status` and the turn's Bash changes are not tracked.
const MAX_BASELINE: usize = 5000;
const VERSION: u32 = 1;
const FILE: &str = "edits.json";
const SNAPSHOTS: &str = "snapshots";

/// Why a file has no snapshot to go back to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Skip {
  /// `MAX_SNAPSHOT_BYTES` or more.
  TooLarge,
  /// The chat's snapshot store is full.
  Budget,
  Outside,
  Symlink,
  Unreadable,
  /// Changed outside the edit tools: a new untracked file.
  Untracked,
  /// Changed outside the edit tools: it already had uncommitted changes before the turn.
  DirtyBefore,
  /// Changed outside the edit tools in a turn that also moved HEAD (a commit, a checkout).
  HeadMoved,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Before {
  /// The content, in the snapshot store.
  File { hash: String, size: u64 },
  /// The file did not exist: Undo deletes it.
  Absent,
  /// Nothing to go back to.
  Unknown { reason: Skip },
}

impl Before {
  pub fn restorable(&self) -> bool {
    !matches!(self, Before::Unknown { .. })
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
  /// Snapshotted by the PreToolUse hook before an edit tool ran.
  Tool,
  /// Found changed by `git status` after the turn (Bash and friends).
  Shell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
  /// In the working set.
  Pending,
  Kept,
  Undone,
  /// Undone by Restore checkpoint.
  Reverted,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Entry {
  /// Relative to the chat's cwd, `/`-separated.
  pub path: String,
  pub request: u32,
  pub before: Before,
  pub source: Source,
  pub state: State,
  #[serde(default)]
  pub at: u64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Request {
  pub index: u32,
  pub at: u64,
  /// Undone by Restore checkpoint of this request or an earlier one.
  #[serde(default)]
  pub reverted: bool,
  /// The turn moved HEAD: its Bash changes were not all listed.
  #[serde(default)]
  pub head_moved: bool,
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct EditsFile {
  pub version: u32,
  /// The chat's cwd (canonical) the paths are relative to.
  pub cwd: String,
  pub requests: Vec<Request>,
  pub entries: Vec<Entry>,
}

/// What Undo / Restore checkpoint did.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct Report {
  pub restored: Vec<String>,
  pub deleted: Vec<String>,
  pub skipped: Vec<(String, Skip)>,
}

/// One file of the working set (VS Code's chat editing widget row).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct WorkingFile {
  pub path: String,
  /// The earliest request with a pending change of it.
  pub request: u32,
  pub source: Source,
  pub restorable: bool,
  pub reason: Option<Skip>,
  /// It did not exist before (Undo deletes it).
  pub created: bool,
  /// It does not exist now.
  pub deleted: bool,
  /// A restorable Shell entry: its "before" is HEAD.
  pub from_head: bool,
  /// Line counts; `None` for binary or unknown.
  pub added: Option<u64>,
  pub removed: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct RequestView {
  pub index: u32,
  pub at: u64,
  pub reverted: bool,
  pub head_moved: bool,
  /// Files this request changed (any state but reverted).
  pub files: usize,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct View {
  /// The cwd relative to the open folder (`""`, or `.kingu/worktrees/<slug>`).
  pub prefix: String,
  pub running: bool,
  pub files: Vec<WorkingFile>,
  pub requests: Vec<RequestView>,
}

fn now_ms() -> u64 {
  std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

// ---------------------------------------------------------------------------------------------
// Paths

/// `path` (absolute, or relative to `cwd`) as a `/`-separated path relative to `cwd` (canonical),
/// or why not: `..` or `.git` in it, outside `cwd` (after resolving the nearest existing
/// ancestor, so a symlinked folder pointing out is refused), or a symlink itself.
pub fn rel_in(cwd: &Path, path: &Path) -> Result<String, Skip> {
  let full = if path.is_absolute() { path.to_path_buf() } else { cwd.join(path) };
  if full.components().any(|c| matches!(c, Component::ParentDir)) {
    return Err(Skip::Outside);
  }
  // The agent may name the cwd through a symlink (/tmp → /private/tmp): resolve what exists.
  let rel = match full.strip_prefix(cwd) {
    Ok(r) => r.to_path_buf(),
    Err(_) => {
      let (base, rest) = split_existing(&full);
      let real = base.canonicalize().map_err(|_| Skip::Outside)?;
      real.join(rest).strip_prefix(cwd).map_err(|_| Skip::Outside)?.to_path_buf()
    }
  };
  let mut parts = Vec::new();
  for c in rel.components() {
    match c {
      Component::Normal(n) => {
        let n = n.to_str().ok_or(Skip::Unreadable)?;
        if n == ".git" {
          return Err(Skip::Outside);
        }
        parts.push(n.to_owned());
      }
      Component::CurDir => {}
      _ => return Err(Skip::Outside),
    }
  }
  if parts.is_empty() {
    return Err(Skip::Outside);
  }
  let rel = parts.join("/");
  check_rel(cwd, &rel)?;
  Ok(rel)
}

/// The longest existing prefix of `p` and the rest.
fn split_existing(p: &Path) -> (PathBuf, PathBuf) {
  let mut base = p.to_path_buf();
  let mut rest = Vec::new();
  while base.symlink_metadata().is_err() {
    match (base.file_name().map(|n| n.to_owned()), base.parent()) {
      (Some(n), Some(parent)) => {
        rest.push(n);
        base = parent.to_path_buf();
      }
      _ => break,
    }
  }
  (base, rest.iter().rev().collect())
}

/// A stored relative path is still a plain file path inside `cwd`: not a symlink, and its
/// nearest existing ancestor resolves inside `cwd`.
pub fn check_rel(cwd: &Path, rel: &str) -> Result<(), Skip> {
  let p = Path::new(rel);
  if rel.is_empty() || !p.components().all(|c| matches!(c, Component::Normal(n) if n != ".git")) {
    return Err(Skip::Outside);
  }
  let full = cwd.join(p);
  if full.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink()) {
    return Err(Skip::Symlink);
  }
  let mut probe = full.parent().map(Path::to_path_buf);
  while let Some(d) = probe {
    if d.symlink_metadata().is_ok() {
      let real = d.canonicalize().map_err(|_| Skip::Outside)?;
      return if real.starts_with(cwd) { Ok(()) } else { Err(Skip::Outside) };
    }
    probe = d.parent().map(Path::to_path_buf);
  }
  Err(Skip::Outside)
}

// ---------------------------------------------------------------------------------------------
// Store

/// One chat's edits file and snapshot blobs.
pub struct Store {
  dir: PathBuf,
  cwd: PathBuf,
  max_bytes: u64,
}

fn not_symlinked_dir(p: &Path) -> Result<(), String> {
  if let Ok(meta) = std::fs::symlink_metadata(p)
    && (meta.file_type().is_symlink() || !meta.is_dir())
  {
    return Err(format!("{}: not a directory", p.display()));
  }
  Ok(())
}

/// `<root>/.kingu/chats/<id>`, refusing symlinked folders on the way.
pub fn chat_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
  check_id(id)?;
  let chats = transcript_path(root, id)?.parent().map(Path::to_path_buf).ok_or("no chats folder")?;
  let dir = chats.join(id);
  not_symlinked_dir(&dir)?;
  not_symlinked_dir(&dir.join(SNAPSHOTS))?;
  Ok(dir)
}

/// Removes the chat's edits and snapshots (with its transcript, when the chat is deleted).
pub fn delete(root: &Path, id: &str) -> Result<(), String> {
  let dir = chat_dir(root, id)?;
  match std::fs::remove_dir_all(&dir) {
    Ok(()) => Ok(()),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(e) => Err(format!("{}: {e}", dir.display())),
  }
}

fn write_atomic_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
  let dir = path.parent().ok_or("no parent")?;
  std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
  let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("f");
  let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
  let result = (|| {
    let mut f = std::fs::File::create(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    if let Ok(meta) = std::fs::metadata(path) {
      let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    std::fs::rename(&tmp, path)
  })();
  if let Err(e) = result {
    let _ = std::fs::remove_file(&tmp);
    return Err(format!("{}: {e}", path.display()));
  }
  Ok(())
}

impl Store {
  /// The store of chat `id` of `root`, whose edits are made in `cwd` (canonicalized here).
  pub fn open(root: &Path, id: &str, cwd: &Path) -> Result<Self, String> {
    let dir = chat_dir(root, id)?;
    let cwd = cwd.canonicalize().map_err(|e| format!("{}: {e}", cwd.display()))?;
    Ok(Self { dir, cwd, max_bytes: MAX_STORE_BYTES })
  }

  /// The store of chat `id` with the cwd its edits file names (checked by `resolve`), or `None`
  /// before the chat recorded any edit.
  pub fn existing(root: &Path, id: &str, resolve: impl FnOnce(&Path) -> Result<PathBuf, String>) -> Result<Option<Self>, String> {
    let dir = chat_dir(root, id)?;
    let Some(text) = read_text(&dir.join(FILE))? else { return Ok(None) };
    let file: EditsFile = serde_json::from_str(&text).map_err(|e| format!("{FILE}: {e}"))?;
    let cwd = resolve(Path::new(&file.cwd))?;
    Ok(Some(Self { dir, cwd, max_bytes: MAX_STORE_BYTES }))
  }

  #[cfg(test)]
  fn with_max(mut self, max: u64) -> Self {
    self.max_bytes = max;
    self
  }

  pub fn cwd(&self) -> &Path {
    &self.cwd
  }

  pub fn load(&self) -> Result<EditsFile, String> {
    let Some(text) = read_text(&self.dir.join(FILE))? else {
      return Ok(EditsFile { version: VERSION, cwd: self.cwd.display().to_string(), ..Default::default() });
    };
    let file: EditsFile = serde_json::from_str(&text).map_err(|e| format!("{FILE}: {e}"))?;
    if file.version > VERSION {
      return Err(format!("{FILE}: written by a newer Kingu (version {})", file.version));
    }
    if Path::new(&file.cwd) != self.cwd {
      return Err(tr!(AgentMsg::EditCwdChanged, path = file.cwd));
    }
    Ok(file)
  }

  pub fn save(&self, file: &EditsFile) -> Result<(), String> {
    let mut file = file.clone();
    file.version = VERSION;
    file.cwd = self.cwd.display().to_string();
    // Bounded: the oldest settled entries go first.
    if file.entries.len() > MAX_ENTRIES {
      let mut extra = file.entries.len() - MAX_ENTRIES;
      file.entries.retain(|e| {
        if extra > 0 && e.state != State::Pending {
          extra -= 1;
          false
        } else {
          true
        }
      });
    }
    let text = serde_json::to_vec(&file).map_err(|e| e.to_string())?;
    write_atomic_bytes(&self.dir.join(FILE), &text)
  }

  fn blobs(&self) -> PathBuf {
    self.dir.join(SNAPSHOTS)
  }

  fn store_bytes(&self) -> u64 {
    std::fs::read_dir(self.blobs()).map_or(0, |d| d.flatten().filter_map(|e| e.metadata().ok()).filter(|m| m.is_file()).map(|m| m.len()).sum())
  }

  /// Stores `bytes` (deduplicated by hash) within the bounds.
  pub fn put(&self, bytes: &[u8]) -> Result<Before, String> {
    let size = bytes.len() as u64;
    if size >= MAX_SNAPSHOT_BYTES {
      return Ok(Before::Unknown { reason: Skip::TooLarge });
    }
    let hash = format!("{:x}", Sha256::digest(bytes));
    let path = self.blobs().join(&hash);
    if path.is_file() {
      return Ok(Before::File { hash, size });
    }
    if self.store_bytes() + size > self.max_bytes {
      return Ok(Before::Unknown { reason: Skip::Budget });
    }
    write_atomic_bytes(&path, bytes)?;
    Ok(Before::File { hash, size })
  }

  pub fn get(&self, hash: &str) -> Result<Vec<u8>, String> {
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
      return Err("bad snapshot id".into());
    }
    let path = self.blobs().join(hash);
    if std::fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file()) {
      return Err("bad snapshot".into());
    }
    std::fs::read(&path).map_err(|e| format!("snapshot {}: {e}", &hash[..8]))
  }

  /// The file as it is now: `None` when missing; `Err` when it cannot be read as a plain file.
  fn current(&self, rel: &str) -> Result<Option<Vec<u8>>, Skip> {
    check_rel(&self.cwd, rel)?;
    let full = self.cwd.join(rel);
    match std::fs::symlink_metadata(&full) {
      Err(_) => Ok(None),
      Ok(m) if !m.is_file() => Err(Skip::Unreadable),
      Ok(m) if m.len() >= MAX_SNAPSHOT_BYTES => Err(Skip::TooLarge),
      Ok(_) => std::fs::read(&full).map(Some).map_err(|_| Skip::Unreadable),
    }
  }

  /// Puts `rel` back to `before` (deleting it for `Absent`).
  fn restore(&self, rel: &str, before: &Before, report: &mut Report) -> Result<(), String> {
    let shown = || rel.to_owned();
    check_rel(&self.cwd, rel).map_err(|_| tr!(AgentMsg::EditPathOutside, path = shown()))?;
    let full = self.cwd.join(rel);
    match before {
      Before::Unknown { reason } => report.skipped.push((rel.to_owned(), *reason)),
      Before::Absent => match std::fs::symlink_metadata(&full) {
        Ok(m) if m.is_file() => {
          std::fs::remove_file(&full).map_err(|e| format!("{rel}: {e}"))?;
          report.deleted.push(rel.to_owned());
        }
        Ok(_) => report.skipped.push((rel.to_owned(), Skip::Unreadable)),
        Err(_) => report.deleted.push(rel.to_owned()),
      },
      Before::File { hash, .. } => {
        let bytes = self.get(hash)?;
        if std::fs::symlink_metadata(&full).is_ok_and(|m| !m.is_file()) {
          report.skipped.push((rel.to_owned(), Skip::Unreadable));
          return Ok(());
        }
        write_atomic_bytes(&full, &bytes)?;
        report.restored.push(rel.to_owned());
      }
    }
    Ok(())
  }
}

fn read_text(path: &Path) -> Result<Option<String>, String> {
  if std::fs::symlink_metadata(path).is_ok_and(|m| !m.is_file()) {
    return Err(format!("{}: not a regular file", path.display()));
  }
  match std::fs::read(path) {
    Ok(b) => String::from_utf8(b).map(Some).map_err(|_| format!("{}: not UTF-8", path.display())),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(e) => Err(format!("{}: {e}", path.display())),
  }
}

// ---------------------------------------------------------------------------------------------
// Recording

/// A new request (a user message); returns its index.
pub fn begin_request(store: &Store, at: u64) -> Result<u32, String> {
  let mut f = store.load()?;
  let index = f.requests.last().map_or(0, |r| r.index + 1);
  f.requests.push(Request { index, at, reverted: false, head_moved: false });
  if f.requests.len() > MAX_REQUESTS {
    f.requests.drain(..f.requests.len() - MAX_REQUESTS);
  }
  store.save(&f)?;
  Ok(index)
}

/// The snapshot an edit tool's PreToolUse hook sent, for `request`. Only the first one per file
/// while it has a pending entry of that request counts. Returns whether an entry was added.
pub fn record_snapshot(store: &Store, request: u32, path: &str, existed: bool, content: Option<&[u8]>, skipped: Option<&str>) -> Result<bool, String> {
  let rel = match rel_in(&store.cwd, Path::new(path)) {
    Ok(r) => r,
    Err(reason) => {
      log::info!("chat edits: snapshot of a path outside the chat folder ({reason:?}) not kept");
      return Ok(false);
    }
  };
  let mut f = store.load()?;
  if f.entries.iter().any(|e| e.request == request && e.path == rel && e.state == State::Pending) {
    return Ok(false);
  }
  let before = match (skipped, content) {
    (Some("too_large"), _) => Before::Unknown { reason: Skip::TooLarge },
    (Some("symlink"), _) => Before::Unknown { reason: Skip::Symlink },
    (Some("outside"), _) => Before::Unknown { reason: Skip::Outside },
    (Some(_), _) => Before::Unknown { reason: Skip::Unreadable },
    (None, _) if !existed => Before::Absent,
    (None, Some(bytes)) => store.put(bytes)?,
    (None, None) => Before::Unknown { reason: Skip::Unreadable },
  };
  f.entries.push(Entry { path: rel, request, before, source: Source::Tool, state: State::Pending, at: now_ms() });
  store.save(&f)?;
  Ok(true)
}

/// What one file looked like in `git status` before a turn.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Sig {
  code: String,
  size: u64,
  mtime: u128,
}

/// The cwd's `git status` and HEAD when a turn started (kept in memory only).
#[derive(Debug, Clone)]
pub struct Baseline {
  head: Option<String>,
  files: HashMap<String, Sig>,
}

fn sig(cwd: &Path, rel: &str, code: String) -> Sig {
  let meta = std::fs::symlink_metadata(cwd.join(rel)).ok();
  let mtime = meta.as_ref().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
  Sig { code, size: meta.map_or(0, |m| m.len()), mtime }
}

/// HEAD and each changed path with its status letters (XY).
type StatusNow = (Option<String>, Vec<(String, String)>);

fn status_now(cwd: &Path) -> Option<StatusNow> {
  let st = crate::git::status(cwd).ok().flatten()?;
  let files = st
    .entries
    .into_iter()
    // Kingu's own state (this store, transcripts) is not the agent's change.
    .filter(|e| e.path != ".kingu" && !e.path.starts_with(".kingu/"))
    .map(|e| (e.path, format!("{}{}", e.index.as_deref().unwrap_or("."), e.worktree.as_deref().unwrap_or("."))))
    .collect();
  Some((head_full(cwd).or(st.head), files))
}

fn head_full(cwd: &Path) -> Option<String> {
  crate::git::run(cwd, &["rev-parse", "--verify", "--quiet", "HEAD"]).ok().map(|o| String::from_utf8_lossy(&o).trim().to_owned())
}

/// `git status` of the cwd before a turn; `None` outside a repository or with too many changes.
pub fn baseline(cwd: &Path) -> Option<Baseline> {
  let (head, files) = status_now(cwd)?;
  if files.len() > MAX_BASELINE {
    log::info!("chat edits: {} changed files before the turn, Bash changes are not tracked", files.len());
    return None;
  }
  Some(Baseline { head, files: files.into_iter().map(|(p, code)| (p.clone(), sig(cwd, &p, code))).collect() })
}

/// After a turn: files changed since `base` that no edit tool of `request` snapshotted.
pub fn end_turn(store: &Store, request: u32, base: Option<&Baseline>) -> Result<bool, String> {
  let Some(base) = base else { return Ok(false) };
  let Some((head, now)) = status_now(&store.cwd) else { return Ok(false) };
  let mut f = store.load()?;
  let head_moved = head != base.head;
  if head_moved && let Some(r) = f.requests.iter_mut().find(|r| r.index == request) {
    r.head_moved = true;
  }
  let tool: HashSet<String> = f.entries.iter().filter(|e| e.request == request && e.source == Source::Tool).map(|e| e.path.clone()).collect();
  let mut changed: BTreeMap<String, Before> = BTreeMap::new();
  let now_paths: HashSet<&str> = now.iter().map(|(p, _)| p.as_str()).collect();
  for (path, code) in &now {
    if tool.contains(path) || check_rel(&store.cwd, path).is_err() {
      continue;
    }
    let before = match base.files.get(path) {
      Some(old) if *old == sig(&store.cwd, path, code.clone()) => continue,
      Some(_) => Before::Unknown { reason: Skip::DirtyBefore },
      None if code.contains('?') => Before::Unknown { reason: Skip::Untracked },
      None if head_moved => Before::Unknown { reason: Skip::HeadMoved },
      None => from_head(store, path)?,
    };
    changed.insert(path.clone(), before);
  }
  // Dirty before, clean now (checked out or committed by a command).
  for path in base.files.keys() {
    if !now_paths.contains(path.as_str()) && !tool.contains(path) && check_rel(&store.cwd, path).is_ok() {
      changed.insert(path.clone(), Before::Unknown { reason: if head_moved { Skip::HeadMoved } else { Skip::DirtyBefore } });
    }
  }
  let any = !changed.is_empty() || head_moved;
  let at = now_ms();
  for (path, before) in changed {
    f.entries.push(Entry { path, request, before, source: Source::Shell, state: State::Pending, at });
  }
  if any {
    store.save(&f)?;
  }
  Ok(any)
}

/// A file that was clean before the turn: its HEAD blob is its "before".
fn from_head(store: &Store, rel: &str) -> Result<Before, String> {
  let spec = format!("HEAD:./{rel}");
  let size = match crate::git::run(&store.cwd, &["cat-file", "-s", &spec]) {
    Ok(o) => String::from_utf8_lossy(&o).trim().parse::<u64>().unwrap_or(u64::MAX),
    // Not in HEAD (added to the index by the command).
    Err(_) => return Ok(Before::Unknown { reason: Skip::Untracked }),
  };
  if size >= MAX_SNAPSHOT_BYTES {
    return Ok(Before::Unknown { reason: Skip::TooLarge });
  }
  let bytes = crate::git::run(&store.cwd, &["cat-file", "blob", &spec])?;
  store.put(&bytes)
}

// ---------------------------------------------------------------------------------------------
// Working set

/// The first pending entry of each file, in order of first change.
fn pending_heads(f: &EditsFile) -> Vec<&Entry> {
  let mut seen = HashSet::new();
  let mut heads: Vec<&Entry> = Vec::new();
  let mut pending: Vec<&Entry> = f.entries.iter().filter(|e| e.state == State::Pending).collect();
  pending.sort_by_key(|e| e.request);
  for e in pending {
    if seen.insert(e.path.as_str()) {
      heads.push(e);
    }
  }
  heads
}

pub fn view(store: &Store, prefix: String, running: bool) -> Result<View, String> {
  let f = store.load()?;
  let mut files = Vec::new();
  for e in pending_heads(&f) {
    let now = store.current(&e.path);
    let deleted = matches!(now, Ok(None));
    let before = match &e.before {
      Before::File { hash, .. } => store.get(hash).ok(),
      _ => None,
    };
    // An edit that was denied, or changed back: nothing to show.
    let unchanged = match (&e.before, &now) {
      (Before::Absent, Ok(None)) => true,
      (Before::File { .. }, Ok(Some(cur))) => before.as_deref() == Some(cur.as_slice()),
      _ => false,
    };
    if unchanged {
      continue;
    }
    let counts = match (&e.before, &now) {
      (Before::Absent, Ok(Some(cur))) => line_counts(b"", cur),
      (Before::File { .. }, Ok(Some(cur))) => before.as_deref().and_then(|b| line_counts(b, cur)),
      (Before::File { .. }, Ok(None)) => before.as_deref().and_then(|b| line_counts(b, b"")),
      _ => None,
    };
    files.push(WorkingFile {
      path: e.path.clone(),
      request: e.request,
      source: e.source,
      restorable: e.before.restorable(),
      reason: match &e.before {
        Before::Unknown { reason } => Some(*reason),
        _ => None,
      },
      created: e.before == Before::Absent,
      deleted,
      from_head: e.source == Source::Shell && e.before.restorable(),
      added: counts.map(|c| c.0),
      removed: counts.map(|c| c.1),
    });
  }
  let requests = f
    .requests
    .iter()
    .map(|r| RequestView {
      index: r.index,
      at: r.at,
      reverted: r.reverted,
      head_moved: r.head_moved,
      files: f.entries.iter().filter(|e| e.request == r.index && e.state != State::Reverted).map(|e| &e.path).collect::<HashSet<_>>().len(),
    })
    .collect();
  Ok(View { prefix, running, files, requests })
}

/// The working set's "before" of `rel` as text (the left side of its diff); empty when it did
/// not exist.
pub fn original(store: &Store, rel: &str) -> Result<String, String> {
  let f = store.load()?;
  let head = pending_heads(&f).into_iter().find(|e| e.path == rel).ok_or_else(|| tr!(AgentMsg::EditNotRestorable, path = rel))?;
  match &head.before {
    Before::File { hash, .. } => Ok(String::from_utf8_lossy(&store.get(hash)?).into_owned()),
    Before::Absent => Ok(String::new()),
    Before::Unknown { .. } => Err(tr!(AgentMsg::EditNotRestorable, path = rel)),
  }
}

fn selected<'a>(paths: Option<&'a [String]>) -> impl Fn(&str) -> bool + 'a {
  move |p| paths.is_none_or(|ps| ps.iter().any(|x| x == p))
}

/// Keep: the pending changes of `paths` (all with `None`) leave the working set.
pub fn keep(store: &Store, paths: Option<&[String]>) -> Result<usize, String> {
  let mut f = store.load()?;
  let want = selected(paths);
  let mut n = 0;
  for e in f.entries.iter_mut().filter(|e| e.state == State::Pending && want(&e.path)) {
    e.state = State::Kept;
    n += 1;
  }
  store.save(&f)?;
  Ok(n)
}

/// Undo: `paths` (all with `None`) go back to their state before their first pending change.
/// A file without a snapshot is refused when named alone, skipped with others.
pub fn undo(store: &Store, paths: Option<&[String]>) -> Result<Report, String> {
  let mut f = store.load()?;
  let want = selected(paths);
  let heads: Vec<Entry> = pending_heads(&f).into_iter().filter(|e| want(&e.path)).cloned().collect();
  if let [only] = heads.as_slice()
    && !only.before.restorable()
    && paths.is_some()
  {
    return Err(tr!(AgentMsg::EditNotRestorable, path = only.path.clone()));
  }
  let _queue = git_queue::lock(&store.cwd, Scope::Worktree, "undo agent edits")?;
  let mut report = Report::default();
  let mut done = HashSet::new();
  for e in &heads {
    store.restore(&e.path, &e.before, &mut report)?;
    if e.before.restorable() {
      done.insert(e.path.clone());
    }
  }
  for e in f.entries.iter_mut().filter(|e| e.state == State::Pending && done.contains(&e.path)) {
    e.state = State::Undone;
  }
  store.save(&f)?;
  Ok(report)
}

/// Restore checkpoint: undoes every change of request `index` and later ones (each file goes
/// back to its state before the earliest of those requests that changed it) and marks those
/// requests reverted.
pub fn restore_checkpoint(store: &Store, index: u32) -> Result<Report, String> {
  let mut f = store.load()?;
  if !f.requests.iter().any(|r| r.index == index) {
    return Err(tr!(AgentMsg::EditNoRequest, index = index + 1));
  }
  let mut firsts: Vec<Entry> = Vec::new();
  let mut later: Vec<&Entry> = f.entries.iter().filter(|e| e.request >= index && e.state != State::Reverted).collect();
  later.sort_by_key(|e| e.request);
  for e in later {
    if !firsts.iter().any(|x| x.path == e.path) {
      firsts.push(e.clone());
    }
  }
  let _queue = git_queue::lock(&store.cwd, Scope::Worktree, "restore checkpoint")?;
  let mut report = Report::default();
  for e in &firsts {
    store.restore(&e.path, &e.before, &mut report)?;
  }
  for e in f.entries.iter_mut().filter(|e| e.request >= index) {
    e.state = State::Reverted;
  }
  for r in f.requests.iter_mut().filter(|r| r.index >= index) {
    r.reverted = true;
  }
  store.save(&f)?;
  Ok(report)
}

/// Lines added and removed between `a` and `b` (a minimal line diff, Myers); `None` when either
/// looks binary (a NUL in its first 8 KB).
pub fn line_counts(a: &[u8], b: &[u8]) -> Option<(u64, u64)> {
  let binary = |x: &[u8]| x[..x.len().min(8192)].contains(&0);
  if binary(a) || binary(b) {
    return None;
  }
  let lines = |x: &[u8]| -> Vec<u64> {
    if x.is_empty() {
      return Vec::new();
    }
    x.split_inclusive(|&c| c == b'\n')
      .map(|l| {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        l.strip_suffix(b"\n").unwrap_or(l).hash(&mut h);
        h.finish()
      })
      .collect()
  };
  let (a, b) = (lines(a), lines(b));
  // Common prefix and suffix first: most edits are small.
  let pre = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
  let suf = a[pre..].iter().rev().zip(b[pre..].iter().rev()).take_while(|(x, y)| x == y).count();
  let (a, b) = (&a[pre..a.len() - suf], &b[pre..b.len() - suf]);
  let (n, m) = (a.len(), b.len());
  if n == 0 || m == 0 {
    return Some((m as u64, n as u64));
  }
  // Edit distance D = n + m - 2·LCS, then added = m - LCS, removed = n - LCS.
  let max = n + m;
  const MAX_D: usize = 20_000;
  let off = max as isize;
  let mut v = vec![0isize; 2 * max + 2];
  for d in 0..=max.min(MAX_D) {
    let d = d as isize;
    let mut k = -d;
    while k <= d {
      let i = (k + off) as usize;
      let mut x = if k == -d || (k != d && v[i - 1] < v[i + 1]) { v[i + 1] } else { v[i - 1] + 1 };
      let mut y = x - k;
      while (x as usize) < n && (y as usize) < m && a[x as usize] == b[y as usize] {
        x += 1;
        y += 1;
      }
      v[i] = x;
      if x as usize >= n && y as usize >= m {
        let lcs = (n + m - d as usize) / 2;
        return Some(((m - lcs) as u64, (n - lcs) as u64));
      }
      k += 2;
    }
  }
  // Very different: count every line of the changed middle.
  Some((m as u64, n as u64))
}

// ---------------------------------------------------------------------------------------------
// Live state: which request each running chat is in

#[derive(Default)]
struct Live {
  /// The request whose turn runs now, with the git status from before it.
  active: Option<(u32, Option<Baseline>)>,
  /// Messages sent while a turn ran: their turns follow, in order.
  queued: VecDeque<u32>,
}

/// Turns in progress per chat, and one lock for every chat's edits file (the run's event thread
/// and the webview's commands both write it).
#[derive(Default)]
pub struct ChatEdits {
  live: Mutex<HashMap<String, Live>>,
}

fn key(root: &Path, id: &str) -> String {
  format!("{}\0{id}", root.display())
}

impl ChatEdits {
  /// Whether a turn of the chat runs (Undo and Restore checkpoint wait for it to end).
  #[cfg(test)]
  pub fn running(&self, root: &Path, id: &str) -> bool {
    self.live.lock().unwrap().get(&key(root, id)).is_some_and(|l| l.active.is_some() || !l.queued.is_empty())
  }

  /// Runs `f` with the edits lock held, refusing while the chat's turn runs when `idle`.
  pub fn with<T>(&self, root: &Path, id: &str, idle: bool, f: impl FnOnce(bool) -> Result<T, String>) -> Result<T, String> {
    let live = self.live.lock().unwrap();
    let running = live.get(&key(root, id)).is_some_and(|l| l.active.is_some() || !l.queued.is_empty());
    if idle && running {
      return Err(tr!(AgentMsg::EditsBusy));
    }
    f(running)
  }

  /// Folds one event of the chat's run into its edits; returns the events to pass on (the
  /// snapshot itself is dropped, a `Checkpoint` follows each user message, `EditsChanged` tells
  /// the webview to reload the working set, and `Exit` stays last).
  pub fn on_event(&self, root: &Path, id: &str, cwd: &Path, ev: AgentEvent) -> Vec<AgentEvent> {
    let mut live = self.live.lock().unwrap();
    let state = live.entry(key(root, id)).or_default();
    let store = match Store::open(root, id, cwd) {
      Ok(s) => s,
      Err(e) => {
        log::warn!("chat edits {id}: {e}");
        return if matches!(ev, AgentEvent::FileSnapshot { .. }) { Vec::new() } else { vec![ev] };
      }
    };
    let warn = |what: &str, r: Result<bool, String>| {
      r.unwrap_or_else(|e| {
        log::warn!("chat edits {id}: {what}: {e}");
        false
      })
    };
    match ev {
      AgentEvent::FileSnapshot { path, existed, content_b64, skipped, .. } => {
        let Some((request, _)) = state.active.as_ref().map(|(r, _)| (*r, ())) else { return Vec::new() };
        let content = content_b64.as_deref().and_then(|b| base64::engine::general_purpose::STANDARD.decode(b).ok());
        let added = warn("snapshot", record_snapshot(&store, request, &path, existed, content.as_deref(), skipped.as_deref()));
        if added { vec![AgentEvent::EditsChanged { request: Some(request) }] } else { Vec::new() }
      }
      AgentEvent::Message { ref role, .. } if role == "user" => match begin_request(&store, now_ms()) {
        Ok(index) => {
          if state.active.is_none() {
            state.active = Some((index, baseline(store.cwd())));
          } else {
            state.queued.push_back(index);
          }
          vec![ev, AgentEvent::Checkpoint { request: index }]
        }
        Err(e) => {
          log::warn!("chat edits {id}: request: {e}");
          vec![ev]
        }
      },
      AgentEvent::Result { .. } => {
        let mut out = vec![ev];
        if let Some((request, base)) = state.active.take() {
          warn("turn end", end_turn(&store, request, base.as_ref()));
          out.push(AgentEvent::EditsChanged { request: Some(request) });
        }
        if let Some(next) = state.queued.pop_front() {
          state.active = Some((next, baseline(store.cwd())));
        }
        out
      }
      AgentEvent::Exit { .. } => {
        let ended = state.active.take();
        if let Some((request, base)) = &ended {
          warn("turn end", end_turn(&store, *request, base.as_ref()));
        }
        live.remove(&key(root, id));
        let request = ended.map(|(r, _)| r);
        vec![AgentEvent::EditsChanged { request }, ev]
      }
      ev => vec![ev],
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::process::Command;

  fn tmp() -> (tempfile::TempDir, PathBuf) {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().canonicalize().unwrap();
    (t, root)
  }

  fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
      .arg("-C")
      .arg(dir)
      .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
      .args(args)
      .output()
      .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
  }

  fn write(root: &Path, rel: &str, text: &str) {
    let p = root.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
  }

  fn read(root: &Path, rel: &str) -> Option<String> {
    std::fs::read_to_string(root.join(rel)).ok()
  }

  /// An edit tool changing `rel` to `text` in `request`, snapshotted first as the hook does.
  fn tool_edit(store: &Store, request: u32, rel: &str, text: &str) {
    let full = store.cwd().join(rel);
    let prior = std::fs::read(&full).ok();
    record_snapshot(store, request, full.to_str().unwrap(), prior.is_some(), prior.as_deref(), None).unwrap();
    write(store.cwd(), rel, text);
  }

  #[test]
  fn paths_stay_inside_the_cwd() {
    let (_t, root) = tmp();
    let outside = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(outside.path().join("f"), "x").unwrap();
    assert_eq!(rel_in(&root, &root.join("src/a.rs")), Ok("src/a.rs".into()));
    assert_eq!(rel_in(&root, Path::new("src/new/b.rs")), Ok("src/new/b.rs".into()), "relative and not yet existing");
    assert_eq!(rel_in(&root, &root.join("src/../../x")), Err(Skip::Outside));
    assert_eq!(rel_in(&root, &outside.path().join("f")), Err(Skip::Outside));
    assert_eq!(rel_in(&root, &root.join(".git/config")), Err(Skip::Outside));
    assert_eq!(rel_in(&root, &root), Err(Skip::Outside));
    #[cfg(unix)]
    {
      std::os::unix::fs::symlink(outside.path(), root.join("out")).unwrap();
      std::os::unix::fs::symlink(outside.path().join("f"), root.join("link")).unwrap();
      assert_eq!(rel_in(&root, &root.join("out/f")), Err(Skip::Outside), "through a symlinked folder");
      assert_eq!(rel_in(&root, &root.join("out/new")), Err(Skip::Outside));
      assert_eq!(rel_in(&root, &root.join("link")), Err(Skip::Symlink));
      // The cwd named through a symlink is the same folder.
      let alias_dir = tempfile::tempdir().unwrap();
      let alias = alias_dir.path().join("alias");
      std::os::unix::fs::symlink(&root, &alias).unwrap();
      assert_eq!(rel_in(&root, &alias.join("src/a.rs")), Ok("src/a.rs".into()));
    }
  }

  #[test]
  fn store_dedupes_and_stays_bounded() {
    let (_t, root) = tmp();
    let store = Store::open(&root, "c", &root).unwrap().with_max(100);
    let a = store.put(&[b'a'; 60]).unwrap();
    assert!(matches!(a, Before::File { size: 60, .. }));
    assert_eq!(store.put(&[b'a'; 60]).unwrap(), a, "same content, same blob");
    assert_eq!(store.put(&[b'b'; 60]).unwrap(), Before::Unknown { reason: Skip::Budget });
    assert!(matches!(store.put(&[b'c'; 40]).unwrap(), Before::File { .. }), "still fits");
    let big = vec![b'x'; MAX_SNAPSHOT_BYTES as usize];
    let store = Store::open(&root, "d", &root).unwrap();
    assert_eq!(store.put(&big).unwrap(), Before::Unknown { reason: Skip::TooLarge });
    let names: Vec<_> = std::fs::read_dir(root.join(".kingu/chats/c/snapshots")).unwrap().flatten().collect();
    assert_eq!(names.len(), 2);
    assert!(store.get("../../x").is_err());
  }

  #[cfg(unix)]
  #[test]
  fn refuses_symlinked_store_folders() {
    let (_t, root) = tmp();
    let outside = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.join(".kingu/chats")).unwrap();
    std::os::unix::fs::symlink(outside.path(), root.join(".kingu/chats/c")).unwrap();
    assert!(Store::open(&root, "c", &root).is_err());
    std::fs::create_dir_all(root.join(".kingu/chats/d")).unwrap();
    std::os::unix::fs::symlink(outside.path(), root.join(".kingu/chats/d/snapshots")).unwrap();
    assert!(Store::open(&root, "d", &root).is_err());
    assert!(Store::open(&root, "../x", &root).is_err());
  }

  #[test]
  fn undo_restores_content_and_deletes_created_files() {
    let (_t, root) = tmp();
    write(&root, "a.txt", "one\ntwo\n");
    let store = Store::open(&root, "c", &root).unwrap();
    let r = begin_request(&store, 1).unwrap();
    tool_edit(&store, r, "a.txt", "one\nTWO\nthree\n");
    tool_edit(&store, r, "a.txt", "one\nTWO\nthree\nfour\n");
    tool_edit(&store, r, "new/b.txt", "b\n");
    let v = view(&store, String::new(), false).unwrap();
    assert_eq!(v.files.len(), 2);
    assert_eq!((v.files[0].path.as_str(), v.files[0].added, v.files[0].removed), ("a.txt", Some(3), Some(1)));
    assert!(v.files[1].created && v.files[1].restorable);
    assert_eq!(original(&store, "a.txt").unwrap(), "one\ntwo\n", "the first snapshot of the request");

    let rep = undo(&store, Some(&["a.txt".into()])).unwrap();
    assert_eq!(rep.restored, ["a.txt"]);
    assert_eq!(read(&root, "a.txt").as_deref(), Some("one\ntwo\n"));
    let rep = undo(&store, None).unwrap();
    assert_eq!(rep.deleted, ["new/b.txt"]);
    assert!(!root.join("new/b.txt").exists());
    assert!(view(&store, String::new(), false).unwrap().files.is_empty());
  }

  #[test]
  fn keep_clears_and_a_later_edit_starts_from_the_kept_content() {
    let (_t, root) = tmp();
    write(&root, "a.txt", "v0");
    let store = Store::open(&root, "c", &root).unwrap();
    let r0 = begin_request(&store, 1).unwrap();
    tool_edit(&store, r0, "a.txt", "v1");
    assert_eq!(keep(&store, None).unwrap(), 1);
    assert!(view(&store, String::new(), false).unwrap().files.is_empty());
    let r1 = begin_request(&store, 2).unwrap();
    tool_edit(&store, r1, "a.txt", "v2");
    undo(&store, None).unwrap();
    assert_eq!(read(&root, "a.txt").as_deref(), Some("v1"), "kept changes stay");
  }

  #[test]
  fn denied_edits_and_unchanged_files_are_not_listed() {
    let (_t, root) = tmp();
    write(&root, "a.txt", "same");
    let store = Store::open(&root, "c", &root).unwrap();
    let r = begin_request(&store, 1).unwrap();
    let full = root.join("a.txt");
    record_snapshot(&store, r, full.to_str().unwrap(), true, Some(b"same"), None).unwrap();
    record_snapshot(&store, r, root.join("never.txt").to_str().unwrap(), false, None, None).unwrap();
    assert!(view(&store, String::new(), false).unwrap().files.is_empty());
  }

  #[test]
  fn skipped_snapshots_are_listed_without_undo() {
    let (_t, root) = tmp();
    write(&root, "big.bin", "x");
    let store = Store::open(&root, "c", &root).unwrap();
    let r = begin_request(&store, 1).unwrap();
    record_snapshot(&store, r, root.join("big.bin").to_str().unwrap(), true, None, Some("too_large")).unwrap();
    assert!(!record_snapshot(&store, r, "/etc/hosts", true, Some(b"x"), None).unwrap(), "outside: not kept");
    let v = view(&store, String::new(), false).unwrap();
    assert_eq!(v.files.len(), 1);
    assert_eq!((v.files[0].restorable, v.files[0].reason), (false, Some(Skip::TooLarge)));
    assert!(undo(&store, Some(&["big.bin".into()])).unwrap_err().contains("cannot be undone"));
    assert_eq!(undo(&store, None).unwrap().skipped, [("big.bin".to_owned(), Skip::TooLarge)]);
  }

  #[cfg(unix)]
  #[test]
  fn undo_never_writes_through_a_symlink() {
    let (_t, root) = tmp();
    let outside = tempfile::tempdir().unwrap();
    write(&root, "a.txt", "before");
    let store = Store::open(&root, "c", &root).unwrap();
    let r = begin_request(&store, 1).unwrap();
    tool_edit(&store, r, "a.txt", "after");
    // The file is replaced by a symlink pointing out of the folder before Undo.
    std::fs::remove_file(root.join("a.txt")).unwrap();
    std::os::unix::fs::symlink(outside.path().join("target"), root.join("a.txt")).unwrap();
    assert!(undo(&store, None).is_err());
    assert!(!outside.path().join("target").exists());
  }

  #[test]
  fn restore_checkpoint_goes_back_per_request_in_order() {
    let (_t, root) = tmp();
    write(&root, "a.txt", "a0");
    write(&root, "b.txt", "b0");
    let store = Store::open(&root, "c", &root).unwrap();
    let r0 = begin_request(&store, 1).unwrap();
    tool_edit(&store, r0, "a.txt", "a1");
    let r1 = begin_request(&store, 2).unwrap();
    tool_edit(&store, r1, "a.txt", "a2");
    tool_edit(&store, r1, "a.txt", "a2b");
    tool_edit(&store, r1, "c.txt", "c1");
    let r2 = begin_request(&store, 3).unwrap();
    tool_edit(&store, r2, "b.txt", "b2");
    tool_edit(&store, r2, "a.txt", "a3");
    keep(&store, Some(&["b.txt".into()])).unwrap();

    // Back to before request 1: request 0's edit of a.txt stays, the rest goes (kept ones too).
    let rep = restore_checkpoint(&store, r1).unwrap();
    assert_eq!(read(&root, "a.txt").as_deref(), Some("a1"));
    assert_eq!(read(&root, "b.txt").as_deref(), Some("b0"));
    assert!(!root.join("c.txt").exists());
    assert_eq!(rep.deleted, ["c.txt"]);
    let v = view(&store, String::new(), false).unwrap();
    assert_eq!(v.requests.iter().map(|r| r.reverted).collect::<Vec<_>>(), [false, true, true]);
    assert_eq!(v.files.iter().map(|f| (f.path.as_str(), f.request)).collect::<Vec<_>>(), [("a.txt", 0)], "request 0 is still pending");

    // A new request after the restore, then back to the very start.
    let r3 = begin_request(&store, 4).unwrap();
    assert_eq!(r3, 3);
    tool_edit(&store, r3, "b.txt", "b3");
    restore_checkpoint(&store, r0).unwrap();
    assert_eq!(read(&root, "a.txt").as_deref(), Some("a0"));
    assert_eq!(read(&root, "b.txt").as_deref(), Some("b0"));
    assert!(view(&store, String::new(), false).unwrap().files.is_empty());
    assert!(restore_checkpoint(&store, 9).unwrap_err().contains("no request 10"));
  }

  #[test]
  fn state_survives_reopening() {
    let (_t, root) = tmp();
    write(&root, "a.txt", "x");
    {
      let store = Store::open(&root, "c", &root).unwrap();
      let r = begin_request(&store, 1).unwrap();
      tool_edit(&store, r, "a.txt", "y");
    }
    let store = Store::existing(&root, "c", |p| Ok(p.to_path_buf())).unwrap().unwrap();
    assert_eq!(view(&store, String::new(), false).unwrap().files.len(), 1);
    assert!(Store::existing(&root, "none", |p| Ok(p.to_path_buf())).unwrap().is_none());
    delete(&root, "c").unwrap();
    assert!(!root.join(".kingu/chats/c").exists());
    // Another cwd cannot reuse the file.
    let other = root.join("sub");
    std::fs::create_dir_all(&other).unwrap();
    let store = Store::open(&root, "e", &root).unwrap();
    begin_request(&store, 1).unwrap();
    assert!(Store::open(&root, "e", &other).unwrap().load().is_err());
  }

  #[test]
  fn bash_changes_are_found_after_the_turn() {
    let (_t, root) = tmp();
    git(&root, &["init", "-q", "-b", "main"]);
    write(&root, "tracked.txt", "t0\n");
    write(&root, "dirty.txt", "d0\n");
    write(&root, "edited.txt", "e0\n");
    git(&root, &["add", "."]);
    git(&root, &["commit", "-qm", "init"]);
    write(&root, "dirty.txt", "d1\n");
    let store = Store::open(&root, "c", &root).unwrap();
    let r = begin_request(&store, 1).unwrap();
    let base = baseline(&root);
    assert!(base.is_some());
    // The turn: an edit tool, then commands.
    tool_edit(&store, r, "edited.txt", "e1\n");
    write(&root, "tracked.txt", "t1\n");
    write(&root, "dirty.txt", "d2 longer\n");
    write(&root, "made.txt", "m\n");
    assert!(end_turn(&store, r, base.as_ref()).unwrap());
    let v = view(&store, String::new(), false).unwrap();
    let row = |p: &str| v.files.iter().find(|f| f.path == p).cloned().unwrap_or_else(|| panic!("{p} missing: {v:?}"));
    assert_eq!(row("edited.txt").source, Source::Tool);
    let t = row("tracked.txt");
    assert!(t.source == Source::Shell && t.restorable && t.from_head);
    assert_eq!((t.added, t.removed), (Some(1), Some(1)));
    assert_eq!(row("dirty.txt").reason, Some(Skip::DirtyBefore));
    assert_eq!(row("made.txt").reason, Some(Skip::Untracked));
    assert_eq!(v.files.len(), 4);
    let rep = undo(&store, None).unwrap();
    assert_eq!(read(&root, "tracked.txt").as_deref(), Some("t0\n"), "restored from HEAD");
    assert_eq!(read(&root, "edited.txt").as_deref(), Some("e0\n"));
    assert_eq!(read(&root, "dirty.txt").as_deref(), Some("d2 longer\n"), "no copy: left alone");
    assert_eq!(rep.skipped.len(), 2);
    // Outside a repository there is nothing to compare.
    let (_t2, plain) = tmp();
    assert!(baseline(&plain).is_none());
  }

  #[test]
  fn live_events_track_requests_and_queue_follow_ups() {
    let (_t, root) = tmp();
    write(&root, "a.txt", "0");
    let edits = ChatEdits::default();
    let user = |t: &str| AgentEvent::Message { role: "user".into(), text: t.into() };
    let snap = |content: &str| AgentEvent::FileSnapshot {
      tool_use_id: "t".into(),
      tool: "Edit".into(),
      path: root.join("a.txt").display().to_string(),
      existed: true,
      size: 1,
      content_b64: Some(base64::engine::general_purpose::STANDARD.encode(content)),
      skipped: None,
    };
    let result = || AgentEvent::Result {
      subtype: "success".into(),
      is_error: false,
      result: None,
      session_id: None,
      num_turns: None,
      duration_ms: None,
      total_cost_usd: None,
      usage: None,
    };
    let out = edits.on_event(&root, "c", &root, user("first"));
    assert_eq!(out[1], AgentEvent::Checkpoint { request: 0 });
    assert!(edits.running(&root, "c"));
    assert!(edits.with(&root, "c", true, |_| Ok(())).unwrap_err().contains("still working"));
    assert_eq!(edits.on_event(&root, "c", &root, snap("0")), [AgentEvent::EditsChanged { request: Some(0) }]);
    write(&root, "a.txt", "1");
    // A follow-up sent mid-turn is the next request, starting when this turn ends.
    assert_eq!(edits.on_event(&root, "c", &root, user("second"))[1], AgentEvent::Checkpoint { request: 1 });
    assert!(edits.on_event(&root, "c", &root, snap("1")).is_empty(), "same file, same request");
    edits.on_event(&root, "c", &root, result());
    edits.on_event(&root, "c", &root, snap("1"));
    write(&root, "a.txt", "2");
    let out = edits.on_event(&root, "c", &root, AgentEvent::Exit { code: Some(0), signal: None, stopped: false });
    assert!(matches!(out.last(), Some(AgentEvent::Exit { .. })), "Exit stays last");
    assert!(!edits.running(&root, "c"));
    let store = Store::open(&root, "c", &root).unwrap();
    restore_checkpoint(&store, 1).unwrap();
    assert_eq!(read(&root, "a.txt").as_deref(), Some("1"));
    restore_checkpoint(&store, 0).unwrap();
    assert_eq!(read(&root, "a.txt").as_deref(), Some("0"));
  }

  #[test]
  fn line_counts_are_a_minimal_diff() {
    assert_eq!(line_counts(b"a\nb\nc\n", b"a\nB\nc\n"), Some((1, 1)));
    assert_eq!(line_counts(b"", b"a\nb\n"), Some((2, 0)));
    assert_eq!(line_counts(b"a\nb\n", b""), Some((0, 2)));
    assert_eq!(line_counts(b"a\nb\nc\nd\n", b"a\nc\nd\ne\nf\n"), Some((2, 1)));
    assert_eq!(line_counts(b"x", b"x"), Some((0, 0)));
    assert_eq!(line_counts(b"a\0b", b"c"), None);
    assert_eq!(line_counts(b"no newline", b"no newline\n"), Some((0, 0)));
  }
}
