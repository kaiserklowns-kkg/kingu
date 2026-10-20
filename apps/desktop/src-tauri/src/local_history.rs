//! Local History (VS Code: IWorkingCopyHistoryService, workingCopyHistoryService.ts): a copy of a
//! workspace file each time it is saved, kept in the app data dir like VS Code's
//! `User/History/<hash of the file's URI>/` folder: one file per entry (`<4 random chars><ext>`)
//! and `entries.json` (`{ version: 1, resource, entries: [{ id, source?, sourceDescription?,
//! timestamp }] }`; no `source` means "File Saved").
//!
//! An entry is a byte copy of the file as saved (its encoding kept), like VS Code's `cloneFile`.
//! The webview decides when to add one (on save, Create Entry, after Restore) and passes the
//! `workbench.localHistory.*` settings; the size limit, the excludes, the merge window and the
//! entry limit are applied here.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::State;

use crate::i18n::msg::LocalHistoryMsg;
use crate::tr;
use crate::workspace::Workspace;

pub const ENTRIES_FILE: &str = "entries.json";

/// `workbench.localHistory.*` as the webview read them.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySettings {
  /// `maxFileEntries`.
  pub max_entries: usize,
  /// `maxFileSize` in KB.
  pub max_file_size_kb: u64,
  /// `mergeWindow` in seconds.
  pub merge_window_secs: u64,
  /// The enabled `exclude` globs (relative to the folder, or absolute).
  #[serde(default)]
  pub exclude: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredEntry {
  pub id: String,
  /// The save source; `None` is VS Code's default source, "File Saved".
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub source: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub source_description: Option<String>,
  /// Milliseconds since the epoch.
  pub timestamp: u64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct EntriesFile {
  pub version: u32,
  /// The file's URI (`file:///…`).
  pub resource: String,
  pub entries: Vec<StoredEntry>,
}

/// What [`plan_add`] decided for a new entry.
#[derive(Debug, PartialEq, Eq)]
pub enum AddPlan {
  /// Overwrite the last entry (same source, within the merge window).
  Replace(usize),
  Append,
}

/// VS Code's addEntry: the last entry is replaced when it has the same source and is at most
/// `merge_window_secs` older; otherwise a new entry is added.
pub fn plan_add(entries: &[StoredEntry], source: Option<&str>, timestamp: u64, merge_window_secs: u64) -> AddPlan {
  match entries.last() {
    Some(last) if last.source.as_deref() == source && timestamp.saturating_sub(last.timestamp) <= merge_window_secs * 1000 => AddPlan::Replace(entries.len() - 1),
    _ => AddPlan::Append,
  }
}

/// VS Code's cleanUpEntries: the oldest entries beyond `max_entries` go. Returns the removed ones.
pub fn trim(entries: &mut Vec<StoredEntry>, max_entries: usize) -> Vec<StoredEntry> {
  if entries.len() <= max_entries {
    return Vec::new();
  }
  let cut = entries.len() - max_entries;
  entries.drain(..cut).collect()
}

/// Whether a file of `size` bytes at `rel` (absolute `abs`) is tracked (VS Code's shouldTrackHistory).
pub fn should_track(rel: &str, abs: &str, size: u64, settings: &HistorySettings) -> bool {
  if size > settings.max_file_size_kb.saturating_mul(1024) {
    return false;
  }
  let globs: Vec<regex::Regex> = settings.exclude.iter().filter_map(|g| crate::glob::to_regex(g)).collect();
  !(crate::glob::is_excluded(rel, &globs) || globs.iter().any(|g| g.is_match(abs)))
}

/// VS Code's `hash(string)` (base/common/hash.ts) over UTF-16 code units, as `toString(16)` prints
/// it (signed): the name of a file's history folder.
pub fn vscode_hash(s: &str) -> String {
  let step = |h: i32, v: i32| h.wrapping_shl(5).wrapping_sub(h).wrapping_add(v);
  let mut h = step(0, 149417);
  for unit in s.encode_utf16() {
    h = step(h, unit as i32);
  }
  if h < 0 { format!("-{:x}", (h as i64).unsigned_abs()) } else { format!("{h:x}") }
}

/// The `file://` URI of an absolute path, percent-encoded like VS Code's `URI.toString()`.
pub fn file_uri(abs: &Path) -> String {
  let mut out = String::from("file://");
  for b in abs.to_string_lossy().bytes() {
    match b {
      b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => out.push(b as char),
      _ => out.push_str(&format!("%{b:02X}")),
    }
  }
  out
}

fn now_ms() -> u64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

const ID_CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/// A new entry id: 4 random characters plus the file's extension (VS Code's randomPath).
fn new_id(dir: &Path, ext: &str, seed: &mut u64) -> String {
  loop {
    // xorshift over the time and a counter: unique enough for 4 characters, retried on a clash.
    *seed ^= *seed << 13;
    *seed ^= *seed >> 7;
    *seed ^= *seed << 17;
    let mut x = *seed;
    let mut id = String::with_capacity(4 + ext.len());
    for _ in 0..4 {
      id.push(ID_CHARS[(x % ID_CHARS.len() as u64) as usize] as char);
      x /= ID_CHARS.len() as u64;
    }
    id.push_str(ext);
    if !dir.join(&id).exists() {
      return id;
    }
  }
}

/// An entry id is a plain file name in its folder (never a path).
fn check_id(id: &str) -> Result<(), String> {
  if id.is_empty() || id == ENTRIES_FILE || id.contains(['/', '\\']) || id.starts_with('.') {
    return Err(tr!(LocalHistoryMsg::BadEntry, id));
  }
  Ok(())
}

/// One entry for the webview.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
  pub id: String,
  pub source: Option<String>,
  pub source_description: Option<String>,
  pub timestamp: u64,
}

impl From<&StoredEntry> for Entry {
  fn from(e: &StoredEntry) -> Self {
    Entry { id: e.id.clone(), source: e.source.clone(), source_description: e.source_description.clone(), timestamp: e.timestamp }
  }
}

/// The history store under `<app data>/History`. One lock for every change, so two saves of a
/// file never interleave their `entries.json` writes.
pub struct LocalHistory {
  home: PathBuf,
  lock: Mutex<u64>,
}

impl LocalHistory {
  pub fn new(home: PathBuf) -> Self {
    Self { home, lock: Mutex::new(now_ms() | 1) }
  }

  fn folder(&self, abs: &Path) -> PathBuf {
    self.home.join(vscode_hash(&file_uri(abs)))
  }

  fn read_file(dir: &Path) -> Option<EntriesFile> {
    let text = std::fs::read_to_string(dir.join(ENTRIES_FILE)).ok()?;
    serde_json::from_str(&text).ok()
  }

  fn write_file(dir: &Path, file: &EntriesFile) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let text = serde_json::to_string(file).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(ENTRIES_FILE), text).map_err(|e| format!("{}: {e}", dir.display()))
  }

  /// The entries of `abs`, oldest first; entries whose copy is gone are left out.
  pub fn list(&self, abs: &Path) -> Vec<Entry> {
    let dir = self.folder(abs);
    let Some(file) = Self::read_file(&dir) else { return Vec::new() };
    file.entries.iter().filter(|e| dir.join(&e.id).is_file()).map(Entry::from).collect()
  }

  /// Adds the file as it is on disk now; `None` when it is not tracked (too large, excluded).
  pub fn add(&self, rel: &str, abs: &Path, source: Option<&str>, settings: &HistorySettings, timestamp: Option<u64>) -> Result<Option<Entry>, String> {
    let bytes = std::fs::read(abs).map_err(|e| format!("{rel}: {e}"))?;
    // maxFileEntries 0 keeps nothing (VS Code adds the entry and trims it away at once).
    if settings.max_entries == 0 || !should_track(rel, &abs.to_string_lossy(), bytes.len() as u64, settings) {
      return Ok(None);
    }
    let mut seed = self.lock.lock().unwrap_or_else(|e| e.into_inner());
    let dir = self.folder(abs);
    let mut file = Self::read_file(&dir).unwrap_or_else(|| EntriesFile { version: 1, resource: file_uri(abs), entries: Vec::new() });
    file.entries.retain(|e| dir.join(&e.id).is_file());
    let source = source.filter(|s| !s.is_empty());
    let timestamp = timestamp.unwrap_or_else(now_ms);
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let entry = match plan_add(&file.entries, source, timestamp, settings.merge_window_secs) {
      AddPlan::Replace(i) => {
        let e = &mut file.entries[i];
        std::fs::write(dir.join(&e.id), &bytes).map_err(|e| e.to_string())?;
        e.timestamp = timestamp;
        e.clone()
      }
      AddPlan::Append => {
        let ext = abs.extension().map(|x| format!(".{}", x.to_string_lossy())).unwrap_or_default();
        let id = new_id(&dir, &ext, &mut seed);
        std::fs::write(dir.join(&id), &bytes).map_err(|e| e.to_string())?;
        let e = StoredEntry { id, source: source.map(str::to_string), source_description: None, timestamp };
        file.entries.push(e.clone());
        e
      }
    };
    for gone in trim(&mut file.entries, settings.max_entries) {
      let _ = std::fs::remove_file(dir.join(&gone.id));
    }
    Self::write_file(&dir, &file)?;
    Ok(Some(Entry::from(&entry)))
  }

  /// The bytes of an entry.
  pub fn content(&self, abs: &Path, id: &str) -> Result<Vec<u8>, String> {
    check_id(id)?;
    std::fs::read(self.folder(abs).join(id)).map_err(|_| tr!(LocalHistoryMsg::BadEntry, id))
  }

  /// The path of an entry's copy (for decoding it like a text file).
  pub fn entry_path(&self, abs: &Path, id: &str) -> Result<PathBuf, String> {
    check_id(id)?;
    let p = self.folder(abs).join(id);
    if p.is_file() { Ok(p) } else { Err(tr!(LocalHistoryMsg::BadEntry, id)) }
  }

  fn update(&self, abs: &Path, f: impl FnOnce(&Path, &mut EntriesFile) -> Result<(), String>) -> Result<(), String> {
    let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
    let dir = self.folder(abs);
    let mut file = Self::read_file(&dir).ok_or_else(|| tr!(LocalHistoryMsg::NoHistory))?;
    f(&dir, &mut file)?;
    if file.entries.is_empty() {
      let _ = std::fs::remove_dir_all(&dir);
      return Ok(());
    }
    Self::write_file(&dir, &file)
  }

  /// Rename: the entry's source becomes `name`.
  pub fn rename(&self, abs: &Path, id: &str, name: &str) -> Result<(), String> {
    check_id(id)?;
    self.update(abs, |_, file| {
      let e = file.entries.iter_mut().find(|e| e.id == id).ok_or_else(|| tr!(LocalHistoryMsg::BadEntry, id))?;
      e.source = Some(name.to_string()).filter(|s| !s.is_empty());
      Ok(())
    })
  }

  pub fn remove(&self, abs: &Path, id: &str) -> Result<(), String> {
    check_id(id)?;
    self.update(abs, |dir, file| {
      let before = file.entries.len();
      file.entries.retain(|e| e.id != id);
      if file.entries.len() == before {
        return Err(tr!(LocalHistoryMsg::BadEntry, id));
      }
      let _ = std::fs::remove_file(dir.join(id));
      Ok(())
    })
  }

  /// Moves the history of `from` to `to` (VS Code's moveEntries, on a rename in the Explorer).
  pub fn move_entries(&self, from: &Path, to: &Path) -> Result<(), String> {
    let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
    let (src, dst) = (self.folder(from), self.folder(to));
    let Some(mut moved) = Self::read_file(&src) else { return Ok(()) };
    let mut target = Self::read_file(&dst).unwrap_or_else(|| EntriesFile { version: 1, resource: file_uri(to), entries: Vec::new() });
    std::fs::create_dir_all(&dst).map_err(|e| format!("{}: {e}", dst.display()))?;
    for e in moved.entries.drain(..) {
      if std::fs::rename(src.join(&e.id), dst.join(&e.id)).is_ok() {
        target.entries.push(e);
      }
    }
    target.entries.sort_by_key(|e| e.timestamp);
    target.resource = file_uri(to);
    let _ = std::fs::remove_dir_all(&src);
    Self::write_file(&dst, &target)
  }

  /// Moves the history of every file under the folder `from` to the same path under `to` (a
  /// folder renamed or moved in the Explorer: VS Code's tracker moves each file's entries).
  pub fn move_folder(&self, from: &Path, to: &Path) -> Result<usize, String> {
    let prefix = format!("{}/", file_uri(from));
    let Ok(dirs) = std::fs::read_dir(&self.home) else { return Ok(0) };
    let moves: Vec<(PathBuf, PathBuf)> = dirs
      .flatten()
      .filter_map(|d| Self::read_file(&d.path()))
      .filter_map(|f| {
        let rest = f.resource.strip_prefix(&prefix)?;
        Some((from.join(percent_decode(rest)), to.join(percent_decode(rest))))
      })
      .collect();
    for (a, b) in &moves {
      self.move_entries(a, b)?;
    }
    Ok(moves.len())
  }

  /// Every file with history (Find Entry to Restore), newest first: paths under `root` relative
  /// to it, other files as `external:<absolute path>` (VS Code lists every file it has history of).
  pub fn files_under(&self, root: Option<&Path>) -> Vec<String> {
    let prefix = root.map(|r| format!("{}/", file_uri(r)));
    let Ok(dirs) = std::fs::read_dir(&self.home) else { return Vec::new() };
    let mut out: Vec<(u64, String)> = dirs
      .flatten()
      .filter_map(|d| Self::read_file(&d.path()))
      .filter_map(|f| {
        let newest = f.entries.iter().map(|e| e.timestamp).max()?;
        if let Some(rel) = prefix.as_deref().and_then(|p| f.resource.strip_prefix(p)) {
          return Some((newest, percent_decode(rel)));
        }
        let abs = f.resource.strip_prefix("file://")?;
        Some((newest, format!("{EXTERNAL_PREFIX}{}", percent_decode(abs))))
      })
      .collect();
    out.sort_by_key(|e| std::cmp::Reverse(e.0));
    out.into_iter().map(|(_, rel)| rel).collect()
  }

  /// Delete All: every entry of every file.
  pub fn clear(&self) -> Result<(), String> {
    let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
    match std::fs::remove_dir_all(&self.home) {
      Ok(()) => Ok(()),
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
      Err(e) => Err(format!("{}: {e}", self.home.display())),
    }
  }
}

fn percent_decode(s: &str) -> String {
  let bytes = s.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut i = 0;
  while i < bytes.len() {
    if bytes[i] == b'%'
      && i + 2 < bytes.len()
      && let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16)
    {
      out.push(b);
      i += 3;
      continue;
    }
    out.push(bytes[i]);
    i += 1;
  }
  String::from_utf8_lossy(&out).into_owned()
}

// --- Commands ---------------------------------------------------------------------------------

/// The webview's key of a file outside the open folder (`external:<absolute path>`).
const EXTERNAL_PREFIX: &str = "external:";

/// An `external:` key's absolute path (no `..`, no relative path).
fn external_path(rel: &str) -> Option<Result<PathBuf, String>> {
  let path = rel.strip_prefix(EXTERNAL_PREFIX)?;
  let p = Path::new(path);
  if !p.is_absolute() || p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
    return Some(Err(tr!(LocalHistoryMsg::BadPath, path)));
  }
  Some(Ok(p.to_path_buf()))
}

/// `rel` in the open folder (it need not exist: a deleted file keeps its history), or the file an
/// `external:` key names (an editor of a file outside the folder keeps history too, like VS Code).
fn file_of(ws: &Workspace, rel: &str) -> Result<PathBuf, String> {
  if let Some(abs) = external_path(rel) {
    return abs;
  }
  let root = ws.root()?;
  crate::git::check_rel(&root, rel)?;
  Ok(root.join(rel))
}

/// What `workbench.localHistory.exclude` matches: the workspace path, or an external file's absolute one.
fn match_path(rel: &str) -> &str {
  rel.strip_prefix(EXTERNAL_PREFIX).unwrap_or(rel)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Adds an entry for `rel` as it is on disk (after a save, Create Entry, Restore).
#[tauri::command]
pub async fn local_history_add(
  ws: State<'_, Workspace>,
  history: State<'_, Arc<LocalHistory>>,
  rel: String,
  source: Option<String>,
  settings: HistorySettings,
) -> Result<Option<Entry>, String> {
  let abs = file_of(&ws, &rel)?;
  let history = Arc::clone(&history);
  blocking(move || history.add(match_path(&rel), &abs, source.as_deref(), &settings, None)).await
}

#[tauri::command]
pub async fn local_history_list(ws: State<'_, Workspace>, history: State<'_, Arc<LocalHistory>>, rel: String) -> Result<Vec<Entry>, String> {
  let abs = file_of(&ws, &rel)?;
  let history = Arc::clone(&history);
  blocking(move || Ok(history.list(&abs))).await
}

/// An entry decoded like a text file (its encoding detected, as the file's editor would).
#[tauri::command]
pub async fn local_history_read(
  ws: State<'_, Workspace>,
  history: State<'_, Arc<LocalHistory>>,
  rel: String,
  id: String,
  options: crate::textfile::ReadOptions,
) -> Result<crate::textfile::ReadResult, String> {
  let abs = file_of(&ws, &rel)?;
  let history = Arc::clone(&history);
  blocking(move || crate::textfile::read(&history.entry_path(&abs, &id)?, &options)).await
}

#[tauri::command]
pub async fn local_history_rename(ws: State<'_, Workspace>, history: State<'_, Arc<LocalHistory>>, rel: String, id: String, name: String) -> Result<(), String> {
  let abs = file_of(&ws, &rel)?;
  let history = Arc::clone(&history);
  blocking(move || history.rename(&abs, &id, name.trim())).await
}

#[tauri::command]
pub async fn local_history_delete(ws: State<'_, Workspace>, history: State<'_, Arc<LocalHistory>>, rel: String, id: String) -> Result<(), String> {
  let abs = file_of(&ws, &rel)?;
  let history = Arc::clone(&history);
  blocking(move || history.remove(&abs, &id)).await
}

/// Delete All (the webview asks first).
#[tauri::command]
pub async fn local_history_delete_all(history: State<'_, Arc<LocalHistory>>) -> Result<(), String> {
  let history = Arc::clone(&history);
  blocking(move || history.clear()).await
}

/// Restore Contents: the entry's bytes replace the file (VS Code's cloneFile onto the resource).
#[tauri::command]
pub async fn local_history_restore(ws: State<'_, Workspace>, history: State<'_, Arc<LocalHistory>>, rel: String, id: String) -> Result<(), String> {
  let abs = file_of(&ws, &rel)?;
  // A file outside the folder is written where it is; a workspace file through the folder's checks.
  let root = if rel.starts_with(EXTERNAL_PREFIX) { None } else { Some(ws.root()?) };
  let history = Arc::clone(&history);
  blocking(move || {
    let bytes = history.content(&abs, &id)?;
    let target = match &root {
      Some(root) => crate::textfile::resolve_for_write(root, &rel)?,
      None => abs.clone(),
    };
    std::fs::write(&target, bytes).map_err(|e| format!("{rel}: {e}"))?;
    log::info!("local history: restored {rel} from {id}");
    Ok(())
  })
  .await
}

/// A file or folder was renamed or moved in the folder: the history of the file (of every file
/// under the folder) follows it.
#[tauri::command]
pub async fn local_history_move(ws: State<'_, Workspace>, history: State<'_, Arc<LocalHistory>>, from: String, to: String) -> Result<(), String> {
  let (src, dst) = (file_of(&ws, &from)?, file_of(&ws, &to)?);
  let history = Arc::clone(&history);
  blocking(move || {
    if dst.is_dir() {
      history.move_folder(&src, &dst).map(|_| ())
    } else {
      history.move_entries(&src, &dst)
    }
  })
  .await
}

/// The files of the open folder that have history, most recently changed first.
#[tauri::command]
pub async fn local_history_files(ws: State<'_, Workspace>, history: State<'_, Arc<LocalHistory>>) -> Result<Vec<String>, String> {
  let root = ws.root().ok();
  let history = Arc::clone(&history);
  blocking(move || Ok(history.files_under(root.as_deref()))).await
}

#[cfg(test)]
mod tests {
  use super::*;

  fn settings() -> HistorySettings {
    HistorySettings { max_entries: 50, max_file_size_kb: 256, merge_window_secs: 10, exclude: Vec::new() }
  }

  fn entry(id: &str, source: Option<&str>, timestamp: u64) -> StoredEntry {
    StoredEntry { id: id.into(), source: source.map(Into::into), source_description: None, timestamp }
  }

  #[test]
  fn merges_same_source_within_the_window() {
    let list = vec![entry("a", None, 1_000)];
    assert_eq!(plan_add(&list, None, 11_000, 10), AddPlan::Replace(0));
    assert_eq!(plan_add(&list, None, 11_001, 10), AddPlan::Append);
    assert_eq!(plan_add(&list, Some("Undo / Redo"), 2_000, 10), AddPlan::Append);
    assert_eq!(plan_add(&[], None, 0, 10), AddPlan::Append);
    // A zero window only merges saves in the same millisecond.
    assert_eq!(plan_add(&list, None, 1_001, 0), AddPlan::Append);
  }

  #[test]
  fn trims_the_oldest() {
    let mut list: Vec<_> = (0..5).map(|i| entry(&i.to_string(), None, i)).collect();
    let gone = trim(&mut list, 3);
    assert_eq!(gone.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["0", "1"]);
    assert_eq!(list.len(), 3);
    assert!(trim(&mut list, 3).is_empty());
  }

  #[test]
  fn tracks_by_size_and_excludes() {
    let mut s = settings();
    assert!(should_track("src/a.ts", "/w/src/a.ts", 256 * 1024, &s));
    assert!(!should_track("src/a.ts", "/w/src/a.ts", 256 * 1024 + 1, &s));
    s.exclude = vec!["**/dist/**".into(), "/w/secret.txt".into()];
    assert!(!should_track("pkg/dist/x.js", "/w/pkg/dist/x.js", 1, &s));
    assert!(!should_track("secret.txt", "/w/secret.txt", 1, &s));
    assert!(should_track("src/a.ts", "/w/src/a.ts", 1, &s));
  }

  #[test]
  fn hashes_like_vscode() {
    // hash('') in VS Code is numberHash(149417, 0) = 149417 = 0x247a9.
    assert_eq!(vscode_hash(""), "247a9");
    // hash('a') = 149417 * 31 + 97 = 4632024 = 0x46add8.
    assert_eq!(vscode_hash("a"), "46add8");
    // Values from VS Code's own hash(), including a negative one and non-ASCII (UTF-16 units).
    assert_eq!(vscode_hash("file:///Users/someone/project/src/a.ts"), "2aa598eb");
    assert_eq!(vscode_hash("file:///w/b.ts"), "-8401f63");
    assert_eq!(vscode_hash("file:///ก.ts"), "21514e86");
    assert_eq!(file_uri(Path::new("/a b/c#.ts")), "file:///a%20b/c%23.ts");
    assert_eq!(percent_decode("a%20b/c%23.ts"), "a b/c#.ts");
  }

  #[test]
  fn adds_merges_trims_renames_and_removes_on_disk() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path().join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    let file = ws.join("a.txt");
    let h = LocalHistory::new(tmp.path().join("History"));
    let mut s = settings();

    std::fs::write(&file, "one").unwrap();
    let first = h.add("a.txt", &file, None, &s, Some(1_000)).unwrap().unwrap();
    assert!(first.id.ends_with(".txt") && first.id.len() == 8);
    // Saved again within the merge window: the same entry, new content.
    std::fs::write(&file, "two").unwrap();
    let merged = h.add("a.txt", &file, None, &s, Some(5_000)).unwrap().unwrap();
    assert_eq!(merged.id, first.id);
    assert_eq!(h.content(&file, &first.id).unwrap(), b"two");
    // Another source never merges.
    let named = h.add("a.txt", &file, Some("Before refactor"), &s, Some(6_000)).unwrap().unwrap();
    assert_ne!(named.id, first.id);
    assert_eq!(h.list(&file).len(), 2);

    // entries.json has VS Code's shape.
    let dir = h.folder(&file);
    let json: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join(ENTRIES_FILE)).unwrap()).unwrap();
    assert_eq!(json["version"], 1);
    assert_eq!(json["resource"], file_uri(&file));
    assert!(json["entries"][0].get("source").is_none());
    assert_eq!(json["entries"][1]["source"], "Before refactor");

    // maxFileEntries drops the oldest, file included.
    s.max_entries = 2;
    std::fs::write(&file, "three").unwrap();
    h.add("a.txt", &file, None, &s, Some(60_000)).unwrap().unwrap();
    let list = h.list(&file);
    assert_eq!(list.len(), 2);
    assert!(!dir.join(&first.id).exists());

    h.rename(&file, &named.id, "Renamed").unwrap();
    assert_eq!(h.list(&file)[0].source.as_deref(), Some("Renamed"));
    assert!(h.rename(&file, "../x", "y").is_err());
    assert!(h.content(&file, ENTRIES_FILE).is_err());

    // Too large or excluded: not tracked.
    s.max_file_size_kb = 0;
    assert_eq!(h.add("a.txt", &file, None, &s, Some(90_000)).unwrap(), None);

    assert_eq!(h.files_under(Some(&ws)), vec!["a.txt".to_string()]);

    // Moved with the file; the last removal drops the folder.
    let to = ws.join("b c.txt");
    h.move_entries(&file, &to).unwrap();
    assert!(h.list(&file).is_empty());
    assert_eq!(h.list(&to).len(), 2);
    assert_eq!(h.files_under(Some(&ws)), vec!["b c.txt".to_string()]);
    for e in h.list(&to) {
      h.remove(&to, &e.id).unwrap();
    }
    assert!(!h.folder(&to).exists());

    std::fs::write(&file, "four").unwrap();
    s.max_file_size_kb = 256;
    h.add("a.txt", &file, None, &s, None).unwrap().unwrap();
    h.clear().unwrap();
    assert!(h.list(&file).is_empty());
    h.clear().unwrap();
  }

  #[test]
  fn a_folder_move_takes_every_file_history_under_it() {
    let tmp = tempfile::tempdir().unwrap();
    let h = LocalHistory::new(tmp.path().join("History"));
    let ws = tmp.path().join("ws");
    std::fs::create_dir_all(ws.join("src/deep")).unwrap();
    let s = settings();
    for f in ["src/a.ts", "src/deep/b.ts", "srcx.ts"] {
      std::fs::write(ws.join(f), f).unwrap();
      h.add(f, &ws.join(f), None, &s, Some(1_000)).unwrap().unwrap();
    }
    std::fs::rename(ws.join("src"), ws.join("lib")).unwrap();
    assert_eq!(h.move_folder(&ws.join("src"), &ws.join("lib")).unwrap(), 2);
    assert!(h.list(&ws.join("src/a.ts")).is_empty());
    assert_eq!(h.list(&ws.join("lib/a.ts")).len(), 1);
    assert_eq!(h.content(&ws.join("lib/deep/b.ts"), &h.list(&ws.join("lib/deep/b.ts"))[0].id).unwrap(), b"src/deep/b.ts");
    // A sibling whose name only starts the same stays.
    assert_eq!(h.list(&ws.join("srcx.ts")).len(), 1);
  }

  #[test]
  fn files_outside_the_folder_are_listed_as_external_keys() {
    let tmp = tempfile::tempdir().unwrap();
    let h = LocalHistory::new(tmp.path().join("History"));
    let ws = tmp.path().join("ws");
    let other = tmp.path().join("notes/todo.md");
    std::fs::create_dir_all(&ws).unwrap();
    std::fs::create_dir_all(other.parent().unwrap()).unwrap();
    std::fs::write(ws.join("a.txt"), "a").unwrap();
    std::fs::write(&other, "b").unwrap();
    let s = settings();
    h.add("a.txt", &ws.join("a.txt"), None, &s, Some(1_000)).unwrap().unwrap();
    h.add(&other.to_string_lossy(), &other, None, &s, Some(2_000)).unwrap().unwrap();
    assert_eq!(h.files_under(Some(&ws)), vec![format!("external:{}", other.display()), "a.txt".to_string()]);
    assert_eq!(h.files_under(None).len(), 2);
    assert_eq!(external_path(&format!("external:{}", other.display())).unwrap().unwrap(), other);
    assert!(external_path("external:relative/x").unwrap().is_err());
    assert!(external_path("external:/a/../b").unwrap().is_err());
    assert!(external_path("src/a.ts").is_none());
  }
}
