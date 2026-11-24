//! Codex rollouts of deleted workspaces (Orca 1.4.269 `src/main/codex/history/cleanup/*`,
//! `workspaces/cleanup/chat-history/codex-rollout-last-cwd.ts`), under the parent module's proof of
//! a deleted workspace. A rollout is `<home>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`; Codex
//! packs idle ones (`.jsonl.zst`) and archives them (`<home>/archived_sessions/<name>`), and the
//! same rollout can sit in several homes (the user's and each account's `CODEX_HOME`).
//!
//! A rollout goes only when all of this holds, and holds again right before its removal:
//!
//! - every Codex home can be vouched for ([`codex_homes`]): a home, an account folder or a
//!   `sessions` / `archived_sessions` / `thread-writer-locks` folder that is a link or does not
//!   read keeps every rollout, since a fork could sit behind it;
//! - no Codex has it open: no `thread-writer-locks/<id>.lock` in any home for any id in its name,
//!   every home holding one of its names keeps such locks (a Codex without them gives no proof),
//!   and no run of this app holds it;
//! - no other rollout reads its history from it ([`ForkIndex`]: `session_meta.history_base` or
//!   `forked_from_id` of every rollout in every home, read in full first and again nearest the
//!   removal). Anything that cannot be read (a folder, a header, a link inside a history folder)
//!   proves nothing unreferenced: the sweep stops. A parent goes once its last fork went;
//! - every name it has in those homes (plain, packed, archived) is a plain file inside its home,
//!   all of them an hour idle with their last turn (`turn_context`, else `session_meta`) in the
//!   gone folder, none changed while they were checked, and no hard link of it exists under a
//!   name this sweep does not know.
//!
//! Only unlinks names (never a folder, never through a link). Not done here, as Kingu has no such
//! files: Orca's legacy-copy asides, `.orca-session-copies` markers and import folder.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::{CodexHistoryUsage, GoneFolder, Identity, SweepResult, fold_name, gone_folder_of, identity_of, idle, read_last_cwd_with, read_listed, remove_one, same_folder, slug_of, still_gone, workspace_parent};

/// Most headers fit one read.
const HEAD_BYTES: usize = 64 * 1024;
const HEADER_MAX_BYTES: usize = 16 * 1024 * 1024;
/// A packed rollout cannot be read from its end, so it is unpacked whole; a larger one is kept.
const MAX_UNPACKED_BYTES: usize = 64 * 1024 * 1024;
/// Codex creates a rollout empty and writes its header after collecting git info.
const UNFINISHED_HEADER_GRACE_MS: u64 = 10 * 60 * 1000;
const MAX_INDEX_ENTRIES: usize = 2_000_000;
/// Each removal lists every history folder again; past this the rest waits for the next sweep.
const SWEEP_BUDGET: Duration = Duration::from_secs(120);
pub const USAGE_MAX_ENTRIES: usize = 4_000_000;
pub const USAGE_BUDGET: Duration = Duration::from_secs(60);
const HISTORY_FOLDERS: [&str; 2] = ["sessions", "archived_sessions"];
const LOCKS_FOLDER: &str = "thread-writer-locks";
/// Fields Codex's `SessionMeta` cannot parse without; a header missing one is skipped as Codex does.
const REQUIRED_META_FIELDS: [&str; 6] = ["session_id", "id", "timestamp", "cwd", "originator", "cli_version"];

// ---------------------------------------------------------------------------------------------
// Names

/// `rollout-YYYY-MM-DDTHH-MM-SS-<id>[_<id>].jsonl[.zst]`: a reverted thread's name carries its
/// thread id and its rollout id.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RolloutName {
  /// The `.jsonl` name, also for a packed file.
  plain: String,
  /// Lowercase; either can be what a lock or a fork names.
  ids: Vec<String>,
  packed: bool,
}

fn parse_rollout_name(name: &str) -> Option<RolloutName> {
  let (plain, packed) = match name.strip_suffix(".zst") {
    Some(plain) => (plain, true),
    None => (name, false),
  };
  let rest = plain.strip_suffix(".jsonl")?.strip_prefix("rollout-")?;
  let stamp = rest.get(..20)?;
  let stamped = stamp.bytes().enumerate().all(|(i, b)| match i {
    4 | 7 | 13 | 16 | 19 => b == b'-',
    10 => b == b'T',
    _ => b.is_ascii_digit(),
  });
  let ids: Vec<&str> = rest[20..].split('_').collect();
  if !stamped || ids.len() > 2 || !ids.iter().all(|id| crate::accounts::managed::is_uuid(id)) {
    return None;
  }
  Some(RolloutName { plain: plain.to_owned(), ids: ids.iter().map(|id| id.to_ascii_lowercase()).collect(), packed })
}

// ---------------------------------------------------------------------------------------------
// Homes

/// Whether `path` is a directory itself (never a link); `Err` when that cannot be told or it is
/// anything else.
fn real_dir(path: &Path) -> Result<bool, ()> {
  match std::fs::symlink_metadata(path) {
    Ok(meta) if meta.is_dir() => Ok(true),
    Ok(_) => Err(()),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
    Err(_) => Err(()),
  }
}

/// Every Codex home Kingu runs Codex with (Orca `listHostCodexRolloutHomes`): `own` (Kingu's
/// `CODEX_HOME`, else `~/.codex`) and each account folder in `accounts`
/// (`<data>/ai-accounts/codex/<id>`), each once by device and inode. `None` when one of them
/// cannot be vouched for: then no rollout is proven unreferenced or closed, and all are kept.
pub fn codex_homes(own: &Path, accounts: &Path) -> Option<Vec<PathBuf>> {
  let mut candidates = vec![own.to_path_buf()];
  if real_dir(accounts).ok()? {
    let mut folders = Vec::new();
    for entry in std::fs::read_dir(accounts).ok()? {
      let entry = entry.ok()?;
      // Kingu only ever names an account folder by its id.
      if !entry.file_name().to_str().is_some_and(crate::accounts::store::valid_id) {
        continue;
      }
      let kind = entry.file_type().ok()?;
      // An account folder that is a link is a home this sweep cannot follow.
      if kind.is_symlink() {
        return None;
      }
      if kind.is_dir() {
        folders.push(entry.path());
      }
    }
    folders.sort();
    candidates.extend(folders);
  }
  let mut seen = HashSet::new();
  let mut homes = Vec::new();
  for home in candidates {
    if !home.is_absolute() {
      return None;
    }
    if !real_dir(&home).ok()? {
      continue;
    }
    for folder in HISTORY_FOLDERS.iter().chain([&LOCKS_FOLDER]) {
      real_dir(&home.join(folder)).ok()?;
    }
    if seen.insert(identity_of(&home)?) {
      homes.push(home);
    }
  }
  Some(homes)
}

// ---------------------------------------------------------------------------------------------
// Reading a rollout

fn too_large() -> std::io::Error {
  std::io::Error::other("rollout too large to unpack")
}

/// At most `max + 1` bytes from the start of a rollout, unpacked when it is a `.zst` (every frame,
/// so nothing appended later is missed).
fn read_start(path: &Path, packed: bool, max: usize) -> std::io::Result<Vec<u8>> {
  let mut out = Vec::new();
  if !packed {
    std::fs::File::open(path)?.take(max as u64 + 1).read_to_end(&mut out)?;
    return Ok(out);
  }
  if std::fs::metadata(path)?.len() > MAX_UNPACKED_BYTES as u64 {
    return Err(too_large());
  }
  let bytes = std::fs::read(path)?;
  let mut source: &[u8] = &bytes;
  while !source.is_empty() && out.len() <= max {
    let mut frame = ruzstd::decoding::StreamingDecoder::new(&mut source).map_err(std::io::Error::other)?;
    let room = (max + 1 - out.len()) as u64;
    (&mut frame).take(room).read_to_end(&mut out)?;
  }
  Ok(out)
}

/// Codex nests the cwd in `payload`: `session_meta` holds the start folder, `turn_context` each
/// turn's. Tool calls name other folders and do not count.
fn codex_record_cwd(line: &[u8]) -> Option<String> {
  if !line.windows(5).any(|w| w == b"\"cwd\"") {
    return None;
  }
  let record: Value = serde_json::from_slice(line).ok()?;
  if !matches!(record.get("type")?.as_str()?, "session_meta" | "turn_context") {
    return None;
  }
  record.get("payload")?.as_object()?.get("cwd")?.as_str().map(str::to_owned)
}

/// The folder of a rollout's last turn; `None` when it records none or is too large to unpack.
fn read_last_rollout_cwd(path: &Path, packed: bool) -> std::io::Result<Option<String>> {
  if !packed {
    return read_last_cwd_with(path, &codex_record_cwd);
  }
  let text = read_start(path, true, MAX_UNPACKED_BYTES)?;
  if text.len() > MAX_UNPACKED_BYTES {
    return Ok(None);
  }
  Ok(text.rsplit(|b| *b == b'\n').find_map(codex_record_cwd))
}

/// The folder a rollout started in (its first `session_meta`), from its first read only.
fn read_start_cwd(path: &Path, packed: bool) -> Option<String> {
  let head = read_start(path, packed, HEAD_BYTES).ok()?;
  let whole = head.len() <= HEAD_BYTES;
  let mut lines: Vec<&[u8]> = head.split(|b| *b == b'\n').collect();
  if !whole {
    lines.pop();
  }
  for line in lines {
    let Ok(record) = serde_json::from_slice::<Value>(line) else { continue };
    if record.get("type").and_then(Value::as_str) == Some("session_meta") {
      return record.get("payload")?.get("cwd")?.as_str().map(str::to_owned);
    }
  }
  None
}

/// Re-read right before deletion: idle, and its last turn ran in the gone folder, not where it was
/// resumed. No recorded folder is no proof it stayed there.
fn rollout_idle_in(path: &Path, packed: bool, folder: &GoneFolder, now: u64) -> bool {
  let Ok(meta) = std::fs::metadata(path) else { return false };
  if !idle(&meta, now) {
    return false;
  }
  let Ok(Some(last)) = read_last_rollout_cwd(path, packed) else { return false };
  gone_folder_of(Path::new(&last)).is_some_and(|last| same_folder(&last, folder))
}

// ---------------------------------------------------------------------------------------------
// Fork references

/// What a rollout's header says it reads its earlier turns from.
#[derive(Debug, PartialEq, Eq)]
enum Header {
  /// Read far enough to know: the rollouts it names (none for a chat of its own).
  Settled(Vec<String>),
  /// No header yet (empty, or a line still being written), or none within the read limit.
  Unsettled,
  /// It could not be read: nothing is known about it.
  Failed,
}

/// What one line settles: the bases a header names, none (a complete header naming none, or the
/// first response), or nothing yet (`None`: read on). Any `session_meta` naming a base counts,
/// even one Codex would skip: keeping a parent too many loses nothing.
fn settle_line(line: &[u8]) -> Option<Vec<String>> {
  let record: Value = serde_json::from_slice(line).ok()?;
  let payload = record.get("payload")?.as_object()?;
  let id = |value: Option<&Value>| value.and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_ascii_lowercase);
  match record.get("type")?.as_str()? {
    "session_meta" => {
      let bases: Vec<String> = [id(payload.get("history_base").and_then(|base| base.get("thread_id"))), id(payload.get("forked_from_id"))].into_iter().flatten().collect();
      if !bases.is_empty() {
        return Some(bases);
      }
      REQUIRED_META_FIELDS.iter().all(|field| payload.get(*field).is_some_and(Value::is_string)).then(Vec::new)
    }
    "response_item" => payload.get("type").is_some_and(Value::is_string).then(Vec::new),
    _ => None,
  }
}

fn settle_lines(lines: &[&[u8]]) -> Option<Vec<String>> {
  lines.iter().filter(|line| !line.iter().all(u8::is_ascii_whitespace)).find_map(|line| settle_line(line))
}

/// Like Codex's own metadata reader: lines before a header are skipped until a response item.
fn read_header(path: &Path, packed: bool) -> Header {
  let mut data = match read_start(path, packed, HEAD_BYTES) {
    Ok(data) => data,
    Err(_) => return Header::Failed,
  };
  if data.len() > HEAD_BYTES {
    // The read cut the last piece off: only whole lines settle here.
    let mut lines: Vec<&[u8]> = data.split(|b| *b == b'\n').collect();
    lines.pop();
    if let Some(bases) = settle_lines(&lines) {
      return Header::Settled(bases);
    }
    data = match read_start(path, packed, HEADER_MAX_BYTES) {
      Ok(data) => data,
      Err(_) => return Header::Failed,
    };
  }
  let lines: Vec<&[u8]> = data.split(|b| *b == b'\n').collect();
  if let Some(bases) = settle_lines(&lines) {
    return Header::Settled(bases);
  }
  if data.len() > HEADER_MAX_BYTES {
    return Header::Unsettled;
  }
  // Codex writes session_meta first, in one write: finished lines without it never become a fork.
  // A line still being written could be that header, so it settles nothing yet.
  let trailing_complete = lines.last().is_none_or(|last| last.iter().all(u8::is_ascii_whitespace));
  if lines.len() > 1 && trailing_complete { Header::Settled(Vec::new()) } else { Header::Unsettled }
}

/// Enough of a file's stat to tell it changed or was replaced.
type Version = (u64, u64, u64, i64, i64);

fn version_of(meta: &std::fs::Metadata) -> Version {
  (meta.dev(), meta.ino(), meta.len(), meta.mtime(), meta.mtime_nsec())
}

struct Indexed {
  version: Version,
  ids: Vec<String>,
  bases: Vec<String>,
}

/// Which rollouts other rollouts read their history prefix from: a forked chat stores only its own
/// turns and reads the rest from its parent's file. Every rollout file of every home is listed on
/// each refresh (a header is read again only when its file changed), so a fork created, restored,
/// archived or deleted meanwhile is seen as it is on disk now.
#[derive(Default)]
struct ForkIndex {
  files: HashMap<PathBuf, Indexed>,
  /// The last refresh read everything.
  complete: bool,
}

impl ForkIndex {
  /// Lists every history folder of `homes` again. False when anything could not be read, so no
  /// rollout is proven unreferenced.
  fn refresh(&mut self, homes: &[PathBuf], now: u64) -> bool {
    let mut files = HashMap::new();
    let mut complete = true;
    let mut pending: Vec<PathBuf> = Vec::new();
    for home in homes {
      for folder in HISTORY_FOLDERS {
        match real_dir(&home.join(folder)) {
          Ok(true) => pending.push(home.join(folder)),
          Ok(false) => {}
          Err(()) => complete = false,
        }
      }
    }
    let mut entries = 0usize;
    while let Some(dir) = pending.pop() {
      // A folder listed a moment ago and gone now was moved: what it held is somewhere unread.
      let Ok(listing) = std::fs::read_dir(&dir) else {
        complete = false;
        continue;
      };
      for entry in listing {
        entries += 1;
        if entries > MAX_INDEX_ENTRIES {
          self.files = files;
          self.complete = false;
          return false;
        }
        let Ok(entry) = entry else {
          complete = false;
          continue;
        };
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
          complete = false;
          continue;
        };
        if kind.is_dir() {
          pending.push(path);
          continue;
        }
        // A link may lead to a fork this walk never reads.
        if kind.is_symlink() {
          complete = false;
          continue;
        }
        let Some(name) = entry.file_name().to_str().and_then(parse_rollout_name) else { continue };
        if !kind.is_file() {
          complete = false;
          continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
          complete = false;
          continue;
        };
        let version = version_of(&meta);
        let bases = match self.files.get(&path).filter(|known| known.version == version) {
          Some(known) => known.bases.clone(),
          None => match read_header(&path, name.packed) {
            Header::Settled(bases) => bases,
            // A header still being written may name a base; an old one never will.
            Header::Unsettled if meta.modified().ok().and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok()).is_some_and(|at| now.saturating_sub(at.as_millis() as u64) >= UNFINISHED_HEADER_GRACE_MS) => Vec::new(),
            Header::Unsettled | Header::Failed => {
              complete = false;
              continue;
            }
          },
        };
        files.insert(path, Indexed { version, ids: name.ids, bases });
      }
    }
    self.files = files;
    self.complete = complete;
    complete
  }

  /// Whether a rollout other than the one named `ids` reads its history from it.
  fn referenced(&self, ids: &[String]) -> bool {
    self.files.values().any(|file| file.bases.iter().any(|base| ids.contains(base)) && !file.ids.iter().any(|id| ids.contains(id)))
  }

  fn forget(&mut self, path: &Path) {
    self.files.remove(path);
  }
}

// ---------------------------------------------------------------------------------------------
// Writer locks

/// Codex holds `thread-writer-locks/<thread id>.lock` while a process has the thread open, also
/// after a resume that has not written a turn yet; deleting then would cut off every later turn.
/// A home whose Codex keeps no locks gives no such proof, so a rollout with a name there is open.
fn open_in_codex(homes: &[PathBuf], holders: &[&Path], ids: &[String]) -> bool {
  if ids.is_empty() || holders.is_empty() {
    return true;
  }
  for home in homes {
    for id in ids {
      match std::fs::symlink_metadata(home.join(LOCKS_FOLDER).join(format!("{id}.lock"))) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        _ => return true,
      }
    }
  }
  holders.iter().any(|home| real_dir(&home.join(LOCKS_FOLDER)) != Ok(true))
}

// ---------------------------------------------------------------------------------------------
// The names of one rollout

/// A rollout this sweep may delete: where its dated name sits, and the gone workspace it started in.
#[derive(Debug, Clone)]
struct Candidate {
  /// `YYYY`, `MM`, `DD`.
  date: [String; 3],
  name: RolloutName,
  folder: GoneFolder,
}

struct NameAt {
  home: PathBuf,
  /// `<home>/sessions` or `<home>/archived_sessions`: no removal leaves it.
  root: PathBuf,
  /// Below `root`.
  relative: PathBuf,
  packed: bool,
}

struct NameState {
  at: usize,
  path: PathBuf,
  content: Identity,
  version: Version,
  size: u64,
  nlink: u64,
}

/// Codex packs idle rollouts and archives them, and a rollout can be in several homes: every name
/// it can have, matched by name.
fn rollout_names(homes: &[PathBuf], candidate: &Candidate) -> Vec<NameAt> {
  let dated: PathBuf = candidate.date.iter().collect::<PathBuf>().join(&candidate.name.plain);
  let mut names = Vec::new();
  for home in homes {
    for (folder, relative) in [("sessions", dated.clone()), ("archived_sessions", PathBuf::from(&candidate.name.plain))] {
      for packed in [false, true] {
        let mut relative = relative.clone().into_os_string();
        if packed {
          relative.push(".zst");
        }
        names.push(NameAt { home: home.clone(), root: home.join(folder), relative: relative.into(), packed });
      }
    }
  }
  names
}

/// `None` when absent; `Err` when it cannot be proven absent, is no plain file, or a folder on the
/// way to it is a link (the name is then outside its home).
fn read_name(names: &[NameAt], at: usize) -> Result<Option<NameState>, ()> {
  let name = &names[at];
  let mut dir = name.root.clone();
  if !real_dir(&dir)? {
    return Ok(None);
  }
  let parts: Vec<_> = name.relative.iter().collect();
  for part in &parts[..parts.len() - 1] {
    dir.push(part);
    if !real_dir(&dir)? {
      return Ok(None);
    }
  }
  let path = name.root.join(&name.relative);
  let meta = match std::fs::symlink_metadata(&path) {
    Ok(meta) => meta,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(_) => return Err(()),
  };
  // Without an inode its other names cannot be told apart.
  if !meta.is_file() || meta.ino() == 0 {
    return Err(());
  }
  Ok(Some(NameState { at, path, content: (meta.dev(), meta.ino()), version: version_of(&meta), size: meta.len(), nlink: meta.nlink() }))
}

fn read_names(names: &[NameAt]) -> Result<Vec<NameState>, ()> {
  let mut found = Vec::new();
  for at in 0..names.len() {
    found.extend(read_name(names, at)?);
  }
  Ok(found)
}

// ---------------------------------------------------------------------------------------------
// The sweep

fn subfolders(dir: &Path, digits: usize) -> Vec<(String, PathBuf)> {
  let mut out: Vec<(String, PathBuf)> = std::fs::read_dir(dir)
    .into_iter()
    .flatten()
    .flatten()
    .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
    .filter_map(|e| e.file_name().to_str().filter(|n| n.len() == digits && n.bytes().all(|b| b.is_ascii_digit())).map(|n| (n.to_owned(), e.path())))
    .collect();
  out.sort();
  out
}

/// Idle rollouts in the dated folders of `homes` that started in a folder directly inside the
/// workspace parent which is gone and unlisted. Candidates only: each is proven again, name by
/// name, in [`delete_rollout`].
fn candidates(root: &Path, homes: &[PathBuf], now: u64) -> Vec<Candidate> {
  let listed = read_listed(root);
  let Some((_, parent_id)) = workspace_parent(root).filter(|_| listed.complete) else { return Vec::new() };
  let mut found: Vec<Candidate> = Vec::new();
  let mut seen = HashSet::new();
  for home in homes {
    for (year, year_dir) in subfolders(&home.join("sessions"), 4) {
      for (month, month_dir) in subfolders(&year_dir, 2) {
        for (day, day_dir) in subfolders(&month_dir, 2) {
          let mut files: Vec<_> = std::fs::read_dir(&day_dir).into_iter().flatten().flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_file())).collect();
          files.sort_by_key(|e| e.file_name());
          for file in files {
            let Some(name) = file.file_name().to_str().and_then(parse_rollout_name) else { continue };
            let key = (year.clone(), month.clone(), day.clone(), name.plain.clone());
            if seen.contains(&key) || !file.metadata().is_ok_and(|m| idle(&m, now)) {
              continue;
            }
            let Some(cwd) = read_start_cwd(&file.path(), name.packed) else { continue };
            // Deleted means: the first missing folder sits directly in the workspace parent, and
            // Kingu no longer lists it. A missing parent never qualifies.
            let Some(folder) = gone_folder_of(Path::new(&cwd)) else { continue };
            let Some(slug) = slug_of(&folder) else { continue };
            if folder.ancestor_id != parent_id || listed.claims.contains(&fold_name(slug)) {
              continue;
            }
            seen.insert(key);
            found.push(Candidate { date: [year.clone(), month.clone(), day.clone()], name, folder });
          }
        }
      }
    }
  }
  found
}

#[derive(Debug, PartialEq, Eq)]
enum Outcome {
  Kept,
  Deleted,
  /// Another rollout reads its history from it: tried again once that one went.
  Referenced,
  /// The fork index could not be read in full: no rollout is proven unreferenced this sweep.
  Blocked,
}

struct Sweep<'a> {
  root: &'a Path,
  list_homes: &'a dyn Fn() -> Option<Vec<PathBuf>>,
  now: &'a dyn Fn() -> u64,
  enabled: &'a dyn Fn() -> bool,
  live: &'a dyn Fn(&str) -> bool,
  index: ForkIndex,
  result: SweepResult,
}

impl Sweep<'_> {
  fn delete_rollout(&mut self, candidate: &Candidate) -> Outcome {
    let ids = &candidate.name.ids;
    if !(self.enabled)() || ids.iter().any(|id| (self.live)(id)) {
      return Outcome::Kept;
    }
    // Listed for each rollout: an account added since the sweep began may already hold a name.
    let Some(homes) = (self.list_homes)() else { return Outcome::Blocked };
    let names = rollout_names(&homes, candidate);
    let Ok(found) = read_names(&names) else { return Outcome::Kept };
    let holders: Vec<&Path> = found.iter().map(|state| names[state.at].home.as_path()).collect();
    if open_in_codex(&homes, &holders, ids) {
      return Outcome::Kept;
    }
    // A forked chat reads its earlier turns from this file: deleting it would empty that chat.
    if !self.index.complete && !self.index.refresh(&homes, (self.now)()) {
      return Outcome::Blocked;
    }
    if self.index.referenced(ids) {
      return Outcome::Referenced;
    }
    // A hard link under a name this sweep does not know: the chat lives on somewhere unread.
    let mut links: HashMap<Identity, u64> = HashMap::new();
    for state in &found {
      *links.entry(state.content).or_default() += 1;
    }
    if found.iter().any(|state| links[&state.content] != state.nlink) {
      return Outcome::Kept;
    }
    // Every name, plain or packed: a chat resumed or still written anywhere keeps them all. The
    // slow transcript reads first, then the cheap folder and row checks.
    let mut checked = HashSet::new();
    for state in &found {
      if checked.insert(state.content) && !(rollout_idle_in(&state.path, names[state.at].packed, &candidate.folder, (self.now)()) && still_gone(self.root, &candidate.folder, self.enabled)) {
        return Outcome::Kept;
      }
    }
    // Reading takes a while: a name that appeared or changed meanwhile means the chat is in use.
    let Ok(current) = read_names(&names) else { return Outcome::Kept };
    if current.len() != found.len() || current.iter().zip(&found).any(|(now, before)| now.at != before.at || now.version != before.version) {
      return Outcome::Kept;
    }
    // The checks above take a while: a fork Codex started meanwhile is on disk now.
    if !self.index.refresh(&homes, (self.now)()) {
      return Outcome::Blocked;
    }
    if self.index.referenced(ids) {
      return Outcome::Referenced;
    }
    // The setting, rows and folder once more nearest the unlink.
    if !still_gone(self.root, &candidate.folder, self.enabled) {
      return Outcome::Kept;
    }
    let mut removed: HashMap<Identity, (u64, u64, u64)> = HashMap::new();
    let mut failed = false;
    for state in &found {
      // Checked once more right before its own unlink: a resume opens or writes one name.
      let unchanged = matches!(read_name(&names, state.at), Ok(Some(now)) if now.version == state.version);
      if !unchanged || open_in_codex(&homes, &holders, ids) || !(self.enabled)() {
        break;
      }
      match remove_one(&state.path, false, &names[state.at].root) {
        Ok(_) => {
          self.index.forget(&state.path);
          let tally = removed.entry(state.content).or_insert((0, state.nlink, state.size));
          tally.0 += 1;
        }
        Err(e) => {
          log::warn!("workspace cleanup: Codex rollout not deleted: {e}");
          failed = true;
          break;
        }
      }
    }
    self.result.failed += u32::from(failed);
    if removed.is_empty() {
      return Outcome::Kept;
    }
    // Space returns only when a file's last link goes, so each file counts once and only then.
    self.result.freed_bytes += removed.values().filter(|(gone, nlink, _)| gone >= nlink).map(|(_, _, size)| size).sum::<u64>();
    self.result.deleted += 1;
    Outcome::Deleted
  }
}

/// Deletes the Codex rollouts of the open folder's deleted workspaces, under every name they have
/// in the homes `list_homes` gives (asked again for each rollout; `None` keeps everything).
/// `enabled` is asked before every removal; `now` is Unix ms; `live` tells a session this app runs.
pub fn sweep_codex(root: &Path, list_homes: &dyn Fn() -> Option<Vec<PathBuf>>, now: &dyn Fn() -> u64, enabled: &dyn Fn() -> bool, live: &dyn Fn(&str) -> bool) -> SweepResult {
  if !enabled() {
    return SweepResult::default();
  }
  let Some(homes) = list_homes() else { return SweepResult::default() };
  let mut pending = candidates(root, &homes, now());
  let mut sweep = Sweep { root, list_homes, now, enabled, live, index: ForkIndex::default(), result: SweepResult::default() };
  let deadline = Instant::now() + SWEEP_BUDGET;
  // A parent is tried again once a fork of it went, so a chain takes one pass per link.
  while !pending.is_empty() {
    let mut waiting = Vec::new();
    let mut progressed = false;
    for candidate in pending {
      if Instant::now() > deadline {
        log::info!("workspace cleanup: Codex rollouts left for the next sweep (time budget reached)");
        return sweep.result;
      }
      match sweep.delete_rollout(&candidate) {
        Outcome::Deleted => progressed = true,
        Outcome::Referenced => waiting.push(candidate),
        Outcome::Kept => {}
        Outcome::Blocked => {
          log::warn!("workspace cleanup: some Codex history could not be read; keeping Codex rollouts");
          return sweep.result;
        }
      }
    }
    if !progressed {
      break;
    }
    pending = waiting;
  }
  sweep.result
}

// ---------------------------------------------------------------------------------------------
// Disk usage (Orca `codex-history-disk-usage-worker-entry.ts`)

/// The homes whose history is measured: `own` and every account folder, as they resolve. Reading
/// sizes follows a home that is a link (nothing is removed here).
pub fn usage_homes(own: &Path, accounts: &Path) -> Vec<PathBuf> {
  let mut homes = vec![own.to_path_buf()];
  let mut folders: Vec<PathBuf> = std::fs::read_dir(accounts).into_iter().flatten().flatten().filter(|e| e.file_name().to_str().is_some_and(crate::accounts::store::valid_id)).map(|e| e.path()).collect();
  folders.sort();
  homes.extend(folders);
  homes
}

fn absent(e: &std::io::Error) -> bool {
  e.kind() == std::io::ErrorKind::NotFound
}

/// Sums the rollouts in the history folders of `homes`, reading metadata only. Links inside them
/// are never followed; a hard-linked rollout counts once; allocated blocks are what the disk gives
/// back. Past `max_entries` or `budget` the total is a lower bound.
pub fn history_usage(homes: &[PathBuf], max_entries: usize, budget: Duration) -> CodexHistoryUsage {
  let mut usage = CodexHistoryUsage { bytes: 0, rollouts: 0, complete: true };
  let deadline = Instant::now() + budget;
  let mut seen_folders = HashSet::new();
  let mut seen_files: HashSet<Identity> = HashSet::new();
  let mut pending = Vec::new();
  for home in homes {
    for folder in HISTORY_FOLDERS {
      match std::fs::canonicalize(home.join(folder)) {
        Ok(real) if seen_folders.insert(real.clone()) => pending.push(real),
        Ok(_) => {}
        Err(e) => usage.complete &= absent(&e),
      }
    }
  }
  let mut entries = 0usize;
  while let Some(dir) = pending.pop() {
    let listing = match std::fs::read_dir(&dir) {
      Ok(listing) => listing,
      Err(e) => {
        usage.complete &= absent(&e);
        continue;
      }
    };
    for entry in listing {
      entries += 1;
      if entries > max_entries || Instant::now() > deadline {
        usage.complete = false;
        return usage;
      }
      let Ok(entry) = entry else {
        usage.complete = false;
        continue;
      };
      let Ok(kind) = entry.file_type() else {
        usage.complete = false;
        continue;
      };
      if kind.is_dir() {
        pending.push(entry.path());
      } else if kind.is_file() && entry.file_name().to_str().is_some_and(|name| name.starts_with("rollout-") && (name.ends_with(".jsonl") || name.ends_with(".jsonl.zst"))) {
        match std::fs::symlink_metadata(entry.path()) {
          Ok(meta) if meta.is_file() => {
            // Some filesystems report inode 0 for every file; those count per name.
            if meta.ino() == 0 || seen_files.insert((meta.dev(), meta.ino())) {
              usage.rollouts += 1;
              usage.bytes += meta.blocks() * 512;
            }
          }
          Ok(_) => {}
          Err(e) => usage.complete &= absent(&e),
        }
      }
    }
  }
  usage
}

#[cfg(test)]
mod tests;
