//! Workspace Cleanup › chat history of deleted workspaces (Orca 1.4.269,
//! `src/main/workspaces/cleanup/chat-history/*` and `src/main/ai-vault/deletion/*`). Off by
//! default (`kingu.workspaceCleanup.deleteChatHistory`): Rust reads the user settings file itself
//! before every removal, so nothing here can delete while the switch is off.
//!
//! A Kingu workspace is a task worktree `<root>/.kingu/worktrees/<slug>`, so that folder is the
//! one workspace parent (Orca's `<workspaces root>/<repo>`), and tasks.json is what Kingu still
//! lists. A chat is deleted only when all of this is proven, and proven again right before its
//! removal:
//!
//! - the deepest existing ancestor of the folder the chat ran in is, by device and inode, that
//!   workspace parent, and the first missing name below it is a task slug (a missing parent, such
//!   as an unmounted volume, proves nothing; an unreadable folder proves nothing);
//! - tasks.json reads, and no task (archived ones included) has that slug in any case spelling;
//! - the parent holds no entry that could be the folder under another spelling, and no `.git`;
//! - the chat was not written in the last hour (Orca's `WORKSPACE_CLEANUP_RULE_GRACE_MS`).
//!
//! Swept: Claude Code transcripts (`<home>/projects/<folder>/<session>.jsonl`, every record
//! carries its own `cwd`, so the *last* one shows a chat resumed somewhere else; such a chat is
//! kept) with their subagent transcripts and `session-env`, in `~/.claude`, Kingu's own
//! `CLAUDE_CONFIG_DIR` and every account's folder ([`claude_homes`]: a home or `projects` folder
//! that is a link or does not read is skipped); Kingu's own chats of a task worktree
//! (`chats.json`, at rest); and Codex rollouts (`codex.rs`, behind Orca's fork-reference index,
//! writer locks and every-name rule). Never touched: chats of the open folder itself, any other
//! agent's history (they record the folder once and cannot prove where they were resumed), and
//! Claude's `file-history`.

#[cfg(unix)]
mod codex;

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{AppHandle, Manager, State};

use crate::agent::worktree::{validate_slug, worktree_path};
use crate::agent::{AgentHost, chat_edits, chats, tasks};
use crate::workspace::Workspace;

/// The user setting that turns the sweep on; anything but `true` in the user settings file is off.
pub const SETTING: &str = "kingu.workspaceCleanup.deleteChatHistory";
/// Recently written history may belong to a workspace still in use or being recreated.
pub const GRACE_MS: u64 = 60 * 60 * 1000;

const CHUNK_BYTES: u64 = 256 * 1024;
const MAX_SCAN_BYTES: u64 = 16 * 1024 * 1024;
const COMPANION_FILE_LIMIT: usize = 2000;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SweepResult {
  pub deleted: u32,
  pub failed: u32,
  pub freed_bytes: u64,
}

impl SweepResult {
  fn add(&mut self, other: SweepResult) {
    self.deleted += other.deleted;
    self.failed += other.failed;
    self.freed_bytes += other.freed_bytes;
  }
}

/// A folder is compared by filesystem identity, so symlinks and spellings are the OS's call.
type Identity = (u64, u64);

#[derive(Debug, PartialEq, Eq)]
enum Presence {
  Present,
  Missing,
  /// A permission or I/O error: never absence.
  Unknown,
}

fn presence(path: &Path) -> Presence {
  match std::fs::symlink_metadata(path) {
    Ok(_) => Presence::Present,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Presence::Missing,
    Err(_) => Presence::Unknown,
  }
}

#[cfg(unix)]
fn identity_of(path: &Path) -> Option<Identity> {
  use std::os::unix::fs::MetadataExt;
  let meta = std::fs::metadata(path).ok()?;
  (meta.is_dir() && meta.ino() != 0).then(|| (meta.dev(), meta.ino()))
}

/// Without device and inode nothing can be proven, so nothing is ever swept.
#[cfg(not(unix))]
fn identity_of(_path: &Path) -> Option<Identity> {
  None
}

/// A gone folder: the deepest existing ancestor of a path and the first missing name below it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoneFolder {
  ancestor: PathBuf,
  ancestor_id: Identity,
  name: OsString,
}

/// `None` when the path exists, is not absolute, or its state cannot be proven.
pub fn gone_folder_of(path: &Path) -> Option<GoneFolder> {
  if !path.is_absolute() {
    return None;
  }
  let mut current = path;
  let mut name: Option<&std::ffi::OsStr> = None;
  loop {
    match presence(current) {
      Presence::Unknown => return None,
      Presence::Present => {
        let name = name?;
        return Some(GoneFolder { ancestor: current.to_path_buf(), ancestor_id: identity_of(current)?, name: name.to_os_string() });
      }
      Presence::Missing => {
        name = Some(current.file_name()?);
        current = current.parent()?;
      }
    }
  }
}

/// macOS and Windows names usually ignore case, so protection compares them folded (upper then
/// lower, as Orca: it folds pairs one lowercasing misses). Linux names are exact.
fn fold_name(name: &str) -> String {
  if cfg!(target_os = "linux") { name.to_owned() } else { name.to_uppercase().to_lowercase() }
}

/// What Kingu still lists under the workspace parent: the slug of every task, archived or not.
struct Listed {
  claims: HashSet<String>,
  /// False when tasks.json did not read or a listed worktree path is a link: then nothing is proven.
  complete: bool,
}

fn read_listed(root: &Path) -> Listed {
  let Ok(list) = tasks::load(root) else { return Listed { claims: HashSet::new(), complete: false } };
  let mut complete = true;
  let mut claims = HashSet::new();
  for task in &list {
    // A listed worktree that is a link works somewhere this sweep cannot follow.
    if std::fs::symlink_metadata(worktree_path(root, &task.slug)).is_ok_and(|m| m.file_type().is_symlink()) {
      complete = false;
    }
    claims.insert(fold_name(&task.slug));
  }
  Listed { claims, complete }
}

/// `<root>/.kingu/worktrees`: the only folder whose children are Kingu workspaces. `None` when it
/// is missing or holds a `.git` (a checkout, not a folder of workspaces).
fn workspace_parent(root: &Path) -> Option<(PathBuf, Identity)> {
  let dir = worktree_path(root, "x").parent()?.to_path_buf();
  let id = identity_of(&dir)?;
  (presence(&dir.join(".git")) == Presence::Missing).then_some((dir, id))
}

/// Whether the parent holds an entry that could be this folder under a lossy spelling: transcript
/// parsers trim the recorded cwd, and names can differ only in case.
fn has_lookalike_sibling(folder: &GoneFolder) -> bool {
  let wanted = fold_name(folder.name.to_string_lossy().trim());
  let Ok(entries) = std::fs::read_dir(&folder.ancestor) else { return true };
  for entry in entries {
    let Ok(entry) = entry else { return true };
    if fold_name(entry.file_name().to_string_lossy().trim()) == wanted {
      return true;
    }
  }
  false
}

fn slug_of(folder: &GoneFolder) -> Option<&str> {
  folder.name.to_str().filter(|name| validate_slug(name).is_ok())
}

/// The whole proof, read fresh: the switch, Kingu's rows, the parent and the folder itself last
/// (it may come back while the rest is read).
fn still_gone(root: &Path, folder: &GoneFolder, enabled: &dyn Fn() -> bool) -> bool {
  let Some(slug) = slug_of(folder) else { return false };
  if !enabled() {
    return false;
  }
  let listed = read_listed(root);
  if !listed.complete || listed.claims.contains(&fold_name(slug)) {
    return false;
  }
  workspace_parent(root).is_some_and(|(_, id)| id == folder.ancestor_id)
    && identity_of(&folder.ancestor) == Some(folder.ancestor_id)
    && presence(&folder.ancestor.join(&folder.name)) == Presence::Missing
    && !has_lookalike_sibling(folder)
}

fn same_folder(a: &GoneFolder, b: &GoneFolder) -> bool {
  a.ancestor_id == b.ancestor_id && fold_name(&a.name.to_string_lossy()) == fold_name(&b.name.to_string_lossy())
}

// ---------------------------------------------------------------------------------------------
// Claude Code transcripts

/// The record's own top-level `cwd`; tool arguments nested inside can carry other folders.
fn top_level_cwd(line: &[u8]) -> Option<String> {
  if !line.windows(5).any(|w| w == b"\"cwd\"") {
    return None;
  }
  let record: serde_json::Value = serde_json::from_slice(line).ok()?;
  record.as_object()?.get("cwd")?.as_str().map(str::to_owned)
}

/// The last cwd a JSONL transcript recorded, reading whole records back from its end (at most
/// `MAX_SCAN_BYTES`: long API blobs carry no cwd, so it reads back until a record with one).
pub fn read_last_recorded_cwd(path: &Path) -> std::io::Result<Option<String>> {
  read_last_cwd_with(path, &top_level_cwd)
}

/// [`read_last_recorded_cwd`] with the agent's own way of telling a record's cwd.
fn read_last_cwd_with(path: &Path, record_cwd: &dyn Fn(&[u8]) -> Option<String>) -> std::io::Result<Option<String>> {
  let mut file = std::fs::File::open(path)?;
  let size = file.metadata()?.len();
  // The record that straddles chunk boundaries: its bytes so far, in file order.
  let mut carry: Vec<u8> = Vec::new();
  let mut end = size;
  while end > 0 && size - end < MAX_SCAN_BYTES {
    let start = end.saturating_sub(CHUNK_BYTES);
    let mut chunk = vec![0u8; (end - start) as usize];
    file.seek(SeekFrom::Start(start))?;
    file.read_exact(&mut chunk)?;
    let mut line_end = chunk.len();
    for index in (0..chunk.len()).rev() {
      if chunk[index] != b'\n' {
        continue;
      }
      let head = &chunk[index + 1..line_end];
      let cwd = if carry.is_empty() { record_cwd(head) } else { record_cwd(&[head, &carry].concat()) };
      if cwd.is_some() {
        return Ok(cwd);
      }
      carry.clear();
      line_end = index;
    }
    carry = [&chunk[..line_end], &carry].concat();
    if start == 0 {
      return Ok(record_cwd(&carry));
    }
    end = start;
  }
  Ok(None)
}

fn mtime_ms(meta: &std::fs::Metadata) -> Option<u64> {
  meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
}

fn idle(meta: &std::fs::Metadata, now: u64) -> bool {
  mtime_ms(meta).is_some_and(|at| now.saturating_sub(at) >= GRACE_MS && at <= now)
}

/// Re-read right before deletion: still idle, and its last record was written in the gone folder.
/// No recorded location is no proof the chat stayed there: keep it.
fn transcript_still_idle_in(path: &Path, folder: &GoneFolder, now: u64) -> bool {
  let Ok(meta) = std::fs::metadata(path) else { return false };
  if !idle(&meta, now) {
    return false;
  }
  let Ok(Some(last)) = read_last_recorded_cwd(path) else { return false };
  gone_folder_of(Path::new(&last)).is_some_and(|last| same_folder(&last, folder))
}

/// `<project folder>/<session id>/`: Claude keeps a chat's subagent transcripts there.
fn session_dir(transcript: &Path) -> Option<PathBuf> {
  let stem = transcript.file_stem()?.to_str()?;
  (!stem.is_empty() && stem != "." && stem != "..").then(|| transcript.with_file_name(stem))
}

/// Files the chat's removal also deletes. `None` when a folder is unreadable (it may hold a live
/// subagent's transcript) or there are too many to check.
fn companion_files(transcript: &Path) -> Option<Vec<PathBuf>> {
  let mut files = Vec::new();
  let mut pending = vec![session_dir(transcript)?];
  while let Some(dir) = pending.pop() {
    let entries = match std::fs::read_dir(&dir) {
      Ok(entries) => entries,
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
      Err(_) => return None,
    };
    for entry in entries {
      let entry = entry.ok()?;
      if entry.file_type().ok()?.is_dir() {
        pending.push(entry.path());
      } else {
        files.push(entry.path());
      }
    }
    if files.len() > COMPANION_FILE_LIMIT {
      return None;
    }
  }
  Some(files)
}

fn file_version(path: &Path) -> Option<(u64, std::time::SystemTime)> {
  let meta = std::fs::metadata(path).ok()?;
  Some((meta.len(), meta.modified().ok()?))
}

/// The chat and every companion it deletes with it: all idle, all last written in the gone folder,
/// and none of them changed while they were being checked.
fn chat_still_idle_in(transcript: &Path, folder: &GoneFolder, now: u64) -> bool {
  let Some(before) = file_version(transcript) else { return false };
  if !transcript_still_idle_in(transcript, folder, now) {
    return false;
  }
  let Some(companions) = companion_files(transcript) else { return false };
  let mut versions = HashMap::new();
  for companion in &companions {
    let Some(version) = file_version(companion) else { return false };
    versions.insert(companion.clone(), version);
    let still = if companion.extension().is_some_and(|e| e == "jsonl") { transcript_still_idle_in(companion, folder, now) } else { std::fs::metadata(companion).is_ok_and(|m| idle(&m, now)) };
    if !still {
      return false;
    }
  }
  if file_version(transcript) != Some(before) {
    return false;
  }
  let Some(after) = companion_files(transcript) else { return false };
  after.len() == companions.len() && after.iter().all(|c| versions.get(c).is_some_and(|v| file_version(c).as_ref() == Some(v)))
}

/// Bytes a removal frees; a link counts as itself, never its target.
fn measure(path: &Path) -> u64 {
  let Ok(meta) = std::fs::symlink_metadata(path) else { return 0 };
  if !meta.is_dir() {
    return meta.len();
  }
  std::fs::read_dir(path).into_iter().flatten().flatten().map(|e| measure(&e.path())).sum()
}

/// Removes one validated path for good (the Trash would keep the space this is meant to free). A
/// missing path is done; a link, a path of the wrong kind, or one that leads outside `root` is
/// refused (`Err`).
fn remove_one(path: &Path, dir: bool, root: &Path) -> Result<u64, String> {
  let meta = match std::fs::symlink_metadata(path) {
    Ok(meta) => meta,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
    Err(e) => return Err(format!("{}: {e}", path.display())),
  };
  if meta.file_type().is_symlink() || meta.is_dir() != dir || (!dir && !meta.is_file()) {
    return Err(format!("{}: unexpected kind", path.display()));
  }
  let real = std::fs::canonicalize(path).map_err(|e| format!("{}: {e}", path.display()))?;
  let real_root = std::fs::canonicalize(root).map_err(|e| format!("{}: {e}", root.display()))?;
  if real == real_root || !real.starts_with(&real_root) {
    return Err(format!("{}: outside {}", path.display(), root.display()));
  }
  let bytes = measure(path);
  let removed = if dir { std::fs::remove_dir_all(path) } else { std::fs::remove_file(path) };
  match removed {
    Ok(()) => Ok(bytes),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(0),
    Err(e) => Err(format!("{}: {e}", path.display())),
  }
}

/// Companions first, so a partial failure leaves the transcript listed for the next run. Claude's
/// `file-history` (rewind backups of the user's files) is not part of a session and stays.
fn delete_claude_session(claude_home: &Path, transcript: &Path) -> Result<u64, String> {
  let projects = claude_home.join("projects");
  let dir = session_dir(transcript).ok_or("no session id")?;
  let id = dir.file_name().ok_or("no session id")?.to_owned();
  let mut freed = remove_one(&dir, true, &projects)?;
  let session_env = claude_home.join("session-env");
  if session_env.is_dir() {
    freed += remove_one(&session_env.join(id), true, &session_env)?;
  }
  Ok(freed + remove_one(transcript, false, &projects)?)
}

/// Claude Code's folder name for a working directory. It replaces every character that is not a
/// letter or digit; `sessions::encode` only `/` and `.`. Both are tried: the name only narrows
/// which folders are read, the recorded cwd is the proof.
fn project_prefixes(parent: &Path) -> Vec<String> {
  let mut scopes = vec![parent.to_path_buf()];
  if let Ok(real) = std::fs::canonicalize(parent)
    && real != parent
  {
    scopes.push(real);
  }
  let mut out = Vec::new();
  for scope in scopes {
    let text = scope.to_string_lossy();
    for name in [crate::sessions::encode(&scope), text.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect::<String>()] {
      let prefix = format!("{name}-");
      if !out.contains(&prefix) {
        out.push(prefix);
      }
    }
  }
  out
}

/// Transcripts Claude filed under a folder inside the workspace parent: plain `.jsonl` files
/// directly in plain project folders (links are never followed).
fn claude_transcripts(claude_home: &Path, parent: &Path) -> Vec<PathBuf> {
  let prefixes = project_prefixes(parent);
  let mut out = Vec::new();
  for dir in std::fs::read_dir(claude_home.join("projects")).into_iter().flatten().flatten() {
    let name = dir.file_name().to_string_lossy().into_owned();
    if !prefixes.iter().any(|p| name.starts_with(p.as_str())) || !dir.file_type().is_ok_and(|t| t.is_dir()) {
      continue;
    }
    for file in std::fs::read_dir(dir.path()).into_iter().flatten().flatten() {
      let path = file.path();
      if path.extension().is_some_and(|e| e == "jsonl") && file.file_type().is_ok_and(|t| t.is_file()) {
        out.push(path);
      }
    }
  }
  out.sort();
  out
}

/// Deletes Claude Code transcripts whose Kingu workspace folder is gone, however the workspace was
/// deleted. `enabled` is asked before every removal; `now` is Unix ms.
pub fn sweep_claude(root: &Path, claude_home: &Path, now: &dyn Fn() -> u64, enabled: &dyn Fn() -> bool) -> SweepResult {
  let mut result = SweepResult::default();
  if !enabled() {
    return result;
  }
  let listed = read_listed(root);
  if !listed.complete {
    return result;
  }
  let Some((parent, parent_id)) = workspace_parent(root) else { return result };
  let started = now();
  let mut groups: Vec<(GoneFolder, Vec<PathBuf>)> = Vec::new();
  for transcript in claude_transcripts(claude_home, &parent) {
    if !std::fs::metadata(&transcript).is_ok_and(|m| idle(&m, started)) {
      continue;
    }
    let Ok(Some(cwd)) = read_last_recorded_cwd(&transcript) else { continue };
    // Deleted means: the first missing folder sits directly in the workspace parent, and Kingu no
    // longer lists it. A missing parent never qualifies.
    let Some(folder) = gone_folder_of(Path::new(&cwd)) else { continue };
    let Some(slug) = slug_of(&folder) else { continue };
    if folder.ancestor_id != parent_id || listed.claims.contains(&fold_name(slug)) {
      continue;
    }
    match groups.iter_mut().find(|(known, _)| same_folder(known, &folder)) {
      Some((_, chats)) => chats.push(transcript),
      None => groups.push((folder, vec![transcript])),
    }
  }
  for (folder, transcripts) in groups {
    if !still_gone(root, &folder, enabled) {
      continue;
    }
    for transcript in transcripts {
      // The slow transcript reads first, then the cheap folder and row checks nearest the removal.
      if !chat_still_idle_in(&transcript, &folder, now()) || !still_gone(root, &folder, enabled) {
        continue;
      }
      match delete_claude_session(claude_home, &transcript) {
        Ok(bytes) => {
          result.deleted += 1;
          result.freed_bytes += bytes;
        }
        Err(e) => {
          log::warn!("workspace cleanup: chat history not deleted: {e}");
          result.failed += 1;
        }
      }
    }
  }
  result
}

/// A folder that is itself a directory (never a link) and lists.
fn plain_dir(path: &Path) -> bool {
  std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir()) && std::fs::read_dir(path).is_ok()
}

/// The Claude homes to sweep (Orca `claudeProfileHistoryDirs`: the user's own config folder and
/// each account's): `own` (`~/.claude`, Kingu's `CLAUDE_CONFIG_DIR`) and every account folder in
/// `accounts` (`<data>/ai-accounts/claude/<id>`, an account's `CLAUDE_CONFIG_DIR`), each once by
/// device and inode. A home, a `projects` folder or the accounts folder that is a link or does not
/// list is left out: nothing is read or removed through it.
pub fn claude_homes(own: &[PathBuf], accounts: &Path) -> Vec<PathBuf> {
  let mut candidates = own.to_vec();
  if plain_dir(accounts) {
    let mut folders: Vec<PathBuf> = std::fs::read_dir(accounts)
      .into_iter()
      .flatten()
      .flatten()
      .filter(|e| e.file_name().to_str().is_some_and(crate::accounts::store::valid_id) && e.file_type().is_ok_and(|t| t.is_dir()))
      .map(|e| e.path())
      .collect();
    folders.sort();
    candidates.extend(folders);
  }
  let mut seen = HashSet::new();
  candidates.into_iter().filter(|home| home.is_absolute() && plain_dir(home) && plain_dir(&home.join("projects")) && identity_of(home).is_some_and(|id| seen.insert(id))).collect()
}

// ---------------------------------------------------------------------------------------------
// Kingu's own chats

/// The gone workspace folder of a chat that ran in a task worktree and is at rest now. A chat of
/// the open folder itself has no workspace to lose and is never one.
fn chat_gone_folder(root: &Path, chat: &chats::ChatMeta, now: u64, live: &dyn Fn(&str) -> bool) -> Option<GoneFolder> {
  let chats::ChatCwd::Task { slug } = &chat.cwd else { return None };
  let used = chat.updated_at.max(chat.created_at);
  if chat.working || used > now || now - used < GRACE_MS || chat.session_id.as_deref().is_some_and(live) {
    return None;
  }
  let transcript = chats::transcript_path(root, &chat.id).ok()?;
  match std::fs::metadata(&transcript) {
    Ok(meta) if !idle(&meta, now) => return None,
    Ok(_) => {}
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
    Err(_) => return None,
  }
  let folder = gone_folder_of(&worktree_path(root, slug))?;
  // The parent itself must exist: the first missing name is the worktree, not `.kingu`.
  (folder.name.to_str() == Some(slug.as_str())).then_some(folder)
}

/// Ids of the open folder's chats whose task worktree is gone and unlisted (candidates: each is
/// proven again by [`forget_chat`]).
pub fn orphaned_chats(root: &Path, now: u64, enabled: &dyn Fn() -> bool, live: &dyn Fn(&str) -> bool) -> Vec<String> {
  if !enabled() {
    return Vec::new();
  }
  let Ok(list) = chats::load(root) else { return Vec::new() };
  list.iter().filter(|chat| chat_gone_folder(root, chat, now, live).is_some_and(|folder| still_gone(root, &folder, enabled))).map(|chat| chat.id.clone()).collect()
}

/// Deletes the transcript and edits of chat `id` when it is (still) a chat of a deleted workspace:
/// the bytes freed, or `None` when it is kept. The caller then drops its row from chats.json.
pub fn forget_chat(root: &Path, id: &str, now: u64, enabled: &dyn Fn() -> bool, live: &dyn Fn(&str) -> bool) -> Result<Option<u64>, String> {
  chats::check_id(id)?;
  let Some(chat) = chats::load(root)?.into_iter().find(|c| c.id == id) else { return Ok(None) };
  let Some(folder) = chat_gone_folder(root, &chat, now, live) else { return Ok(None) };
  if !still_gone(root, &folder, enabled) {
    return Ok(None);
  }
  let transcript = chats::transcript_path(root, id)?;
  let edits = chat_edits::chat_dir(root, id)?;
  let bytes = measure(&transcript) + measure(&edits);
  chats::delete_transcript(root, id)?;
  chat_edits::delete(root, id)?;
  Ok(Some(bytes))
}

// ---------------------------------------------------------------------------------------------
// Commands

fn now_ms() -> u64 {
  std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// The switch as the user settings file has it right now. It is application-scoped, so every
/// profile keeps it in the Default profile's file (`settings.set`).
fn setting_reader(app: &AppHandle) -> Result<impl Fn() -> bool + Send + 'static, String> {
  let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
  Ok(move || crate::settings::user_value(&config, SETTING) == Some(serde_json::Value::Bool(true)))
}

#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSweep {
  #[serde(flatten)]
  pub transcripts: SweepResult,
  /// Kingu chats of deleted workspaces, for the webview to forget one by one.
  pub chats: Vec<String>,
}

/// A non-empty absolute folder from Kingu's own environment.
fn env_dir(key: &str) -> Option<PathBuf> {
  std::env::var_os(key).filter(|v| !v.is_empty()).map(PathBuf::from).filter(|p| p.is_absolute())
}

/// `<data>/ai-accounts/<provider>`: one folder per account, the agent's own home (accounts/store.rs).
fn account_homes_dir(app: &AppHandle, provider: crate::accounts::store::Provider) -> Result<PathBuf, String> {
  Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(crate::accounts::store::DIR).join(provider.as_str()))
}

/// Sweeps the open folder: deletes Claude Code transcripts and Codex rollouts of its deleted
/// workspaces, in the user's own homes and every account's, and names its own chats of deleted
/// workspaces. Does nothing unless the setting is on.
#[tauri::command]
pub async fn workspace_cleanup_chat_sweep(app: AppHandle, ws: Workspace, agents: State<'_, Arc<AgentHost>>) -> Result<ChatSweep, String> {
  use crate::accounts::store::Provider;
  let Some(root) = ws.current() else { return Ok(ChatSweep::default()) };
  let enabled = setting_reader(&app)?;
  let (claude_accounts, codex_accounts) = (account_homes_dir(&app, Provider::Claude)?, account_homes_dir(&app, Provider::Codex)?);
  let agents = agents.inner().clone();
  tauri::async_runtime::spawn_blocking(move || {
    let live = |session: &str| agents.session_live(session);
    let mut transcripts = SweepResult::default();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from).filter(|p| p.is_absolute()) {
      let own: Vec<PathBuf> = [Some(home.join(".claude")), env_dir("CLAUDE_CONFIG_DIR")].into_iter().flatten().collect();
      for claude_home in claude_homes(&own, &claude_accounts) {
        transcripts.add(sweep_claude(&root, &claude_home, &now_ms, &enabled));
      }
      #[cfg(unix)]
      {
        let own_codex = env_dir("CODEX_HOME").unwrap_or_else(|| home.join(".codex"));
        transcripts.add(codex::sweep_codex(&root, &|| codex::codex_homes(&own_codex, &codex_accounts), &now_ms, &enabled, &live));
      }
      #[cfg(not(unix))]
      let _ = &codex_accounts;
    }
    let chats = orphaned_chats(&root, now_ms(), &enabled, &live);
    if transcripts.deleted > 0 || transcripts.failed > 0 {
      log::info!("workspace cleanup: {} chats of deleted workspaces removed, {} failed, {} bytes", transcripts.deleted, transcripts.failed, transcripts.freed_bytes);
    }
    Ok(ChatSweep { transcripts, chats })
  })
  .await
  .map_err(|e| e.to_string())?
}

/// Space Codex chat history takes (Orca `CodexHistoryDiskUsage`); each hard-linked rollout counts once.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexHistoryUsage {
  pub bytes: u64,
  pub rollouts: u64,
  /// False when the walk hit its budget or could not read something: `bytes` is then a lower bound.
  pub complete: bool,
}

/// What Codex's own chat history takes in the user's Codex home and every account's (Orca
/// `workspaceCleanup.codexHistoryDiskUsage`): file metadata only, nothing is opened. `None` where
/// it cannot be measured.
#[tauri::command]
pub async fn workspace_cleanup_codex_history_usage(app: AppHandle) -> Result<Option<CodexHistoryUsage>, String> {
  let accounts = account_homes_dir(&app, crate::accounts::store::Provider::Codex)?;
  tauri::async_runtime::spawn_blocking(move || {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from).filter(|p| p.is_absolute()) else { return Ok(None) };
    #[cfg(unix)]
    {
      let own = env_dir("CODEX_HOME").unwrap_or_else(|| home.join(".codex"));
      Ok(Some(codex::history_usage(&codex::usage_homes(&own, &accounts), codex::USAGE_MAX_ENTRIES, codex::USAGE_BUDGET)))
    }
    #[cfg(not(unix))]
    {
      let _ = (&home, &accounts);
      Ok(None)
    }
  })
  .await
  .map_err(|e| e.to_string())?
}

/// Deletes the saved transcript and edits of one Kingu chat of a deleted workspace, after proving
/// it again; `None` when the chat is kept.
#[tauri::command]
pub async fn workspace_cleanup_chat_forget(app: AppHandle, ws: Workspace, agents: State<'_, Arc<AgentHost>>, id: String) -> Result<Option<u64>, String> {
  let root = ws.root()?;
  let enabled = setting_reader(&app)?;
  let agents = agents.inner().clone();
  tauri::async_runtime::spawn_blocking(move || forget_chat(&root, &id, now_ms(), &enabled, &|session| agents.session_live(session))).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
  use super::*;

  const ON: &dyn Fn() -> bool = &|| true;
  const HOUR: u64 = GRACE_MS;

  /// Two hours from now, so files written by the test are past the grace hour.
  fn later() -> u64 {
    now_ms() + 2 * HOUR
  }

  struct Fixture {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    claude: PathBuf,
  }

  /// A project with `.kingu/worktrees`, tasks.json listing `tasks`, and an empty Claude home.
  fn fixture(tasks: &[&str]) -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(tmp.path()).unwrap();
    let (root, claude) = (base.join("proj"), base.join("claude"));
    std::fs::create_dir_all(root.join(".kingu/worktrees")).unwrap();
    std::fs::create_dir_all(claude.join("projects")).unwrap();
    write_tasks(&root, tasks);
    Fixture { _tmp: tmp, root, claude }
  }

  fn write_tasks(root: &Path, slugs: &[&str]) {
    let rows: Vec<String> = slugs.iter().map(|s| format!(r#"{{"slug":"{s}","title":"T","base":"main","created_at":5,"status":"done"}}"#)).collect();
    std::fs::write(root.join(".kingu/tasks.json"), format!(r#"{{"version":1,"tasks":[{}]}}"#, rows.join(","))).unwrap();
  }

  fn record(cwd: &Path) -> String {
    format!("{}\n", serde_json::json!({ "type": "user", "cwd": cwd, "message": { "content": "hi" } }))
  }

  /// A Claude transcript filed under `filed` (the folder the chat started in) with `body`.
  fn transcript(fx: &Fixture, filed: &Path, id: &str, body: &str) -> PathBuf {
    let dir = fx.claude.join("projects").join(crate::sessions::encode(filed));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("{id}.jsonl"));
    std::fs::write(&path, body).unwrap();
    path
  }

  fn sweep(fx: &Fixture) -> SweepResult {
    sweep_claude(&fx.root, &fx.claude, &later, ON)
  }

  #[test]
  fn deletes_a_claude_chat_of_a_deleted_workspace_with_its_companions() {
    let fx = fixture(&["kept"]);
    let gone = worktree_path(&fx.root, "gone");
    let chat = transcript(&fx, &gone, "s1", &record(&gone));
    let sub = chat.with_file_name("s1").join("subagents");
    std::fs::create_dir_all(&sub).unwrap();
    std::fs::write(sub.join("agent-1.jsonl"), record(&gone.join("src"))).unwrap();
    std::fs::create_dir_all(fx.claude.join("session-env/s1")).unwrap();
    std::fs::write(fx.claude.join("session-env/s1/env"), "x").unwrap();
    std::fs::create_dir_all(fx.claude.join("file-history/s1")).unwrap();
    let got = sweep(&fx);
    assert_eq!((got.deleted, got.failed), (1, 0));
    assert!(got.freed_bytes > 0);
    assert!(!chat.exists() && !chat.with_file_name("s1").exists() && !fx.claude.join("session-env/s1").exists());
    assert!(fx.claude.join("file-history/s1").exists(), "rewind backups are not chat history");
    assert!(chat.parent().unwrap().exists(), "only the session goes, never its project folder");
  }

  #[test]
  fn does_nothing_while_the_setting_is_off() {
    let fx = fixture(&[]);
    let gone = worktree_path(&fx.root, "gone");
    let chat = transcript(&fx, &gone, "s1", &record(&gone));
    assert_eq!(sweep_claude(&fx.root, &fx.claude, &later, &|| false), SweepResult::default());
    assert!(chat.exists());
  }

  #[test]
  fn stops_when_the_setting_is_turned_off_mid_run() {
    let fx = fixture(&[]);
    let gone = worktree_path(&fx.root, "gone");
    let (a, b) = (transcript(&fx, &gone, "a", &record(&gone)), transcript(&fx, &gone, "b", &record(&gone)));
    let asked = std::cell::Cell::new(0);
    // Asked at the start, per folder, and before each removal: off from the fourth ask on.
    let enabled = || {
      asked.set(asked.get() + 1);
      asked.get() <= 3
    };
    let got = sweep_claude(&fx.root, &fx.claude, &later, &enabled);
    assert_eq!(got.deleted, 1);
    assert!(!a.exists() && b.exists());
  }

  #[test]
  fn keeps_chats_of_a_workspace_that_still_exists_or_is_still_listed() {
    let fx = fixture(&["archived"]);
    let (live, archived) = (worktree_path(&fx.root, "live"), worktree_path(&fx.root, "archived"));
    std::fs::create_dir_all(&live).unwrap();
    let kept = [transcript(&fx, &live, "s1", &record(&live)), transcript(&fx, &archived, "s2", &record(&archived)), transcript(&fx, &fx.root, "s3", &record(&fx.root))];
    assert_eq!(sweep(&fx), SweepResult::default());
    assert!(kept.iter().all(|p| p.exists()));
  }

  #[test]
  fn a_listed_task_protects_its_folder_in_another_case_spelling() {
    if cfg!(target_os = "linux") {
      return;
    }
    let fx = fixture(&["gone"]);
    let spelled = fx.root.join(".kingu/worktrees/GONE");
    // Not a slug either way; the claim is what this guards.
    let chat = transcript(&fx, &spelled, "s1", &record(&spelled));
    assert_eq!(sweep(&fx), SweepResult::default());
    assert!(chat.exists());
  }

  #[test]
  fn keeps_everything_when_tasks_json_does_not_read_or_a_listed_worktree_is_a_link() {
    let fx = fixture(&[]);
    let gone = worktree_path(&fx.root, "gone");
    let chat = transcript(&fx, &gone, "s1", &record(&gone));
    std::fs::write(fx.root.join(".kingu/tasks.json"), "{ not json").unwrap();
    assert_eq!(sweep(&fx), SweepResult::default());
    write_tasks(&fx.root, &["linked"]);
    #[cfg(unix)]
    {
      std::os::unix::fs::symlink(&gone, worktree_path(&fx.root, "linked")).unwrap();
      assert_eq!(sweep(&fx), SweepResult::default());
    }
    assert!(chat.exists());
  }

  #[test]
  fn keeps_a_chat_written_in_the_last_hour() {
    let fx = fixture(&[]);
    let gone = worktree_path(&fx.root, "gone");
    let chat = transcript(&fx, &gone, "s1", &record(&gone));
    assert_eq!(sweep_claude(&fx.root, &fx.claude, &now_ms, ON), SweepResult::default());
    assert!(chat.exists());
  }

  #[test]
  fn keeps_a_chat_resumed_somewhere_else_or_with_no_recorded_folder() {
    let fx = fixture(&[]);
    let gone = worktree_path(&fx.root, "gone");
    // Started in the gone workspace, last written at the project root.
    let resumed = transcript(&fx, &gone, "s1", &format!("{}{}", record(&gone), record(&fx.root)));
    let blank = transcript(&fx, &gone, "s2", "{\"type\":\"summary\"}\n");
    // The last record's own cwd is the root; only a tool argument names the gone folder.
    let nested = transcript(&fx, &gone, "s3", &format!("{}\n", serde_json::json!({ "cwd": fx.root, "message": { "input": { "cwd": gone } } })));
    assert_eq!(sweep(&fx), SweepResult::default());
    assert!(resumed.exists() && blank.exists() && nested.exists());
  }

  #[test]
  fn keeps_chats_of_folders_kingu_never_made_a_workspace() {
    let fx = fixture(&[]);
    let base = fx.root.parent().unwrap().to_path_buf();
    // A gone folder outside the workspace parent, a gone project folder, and a nested gone folder
    // whose first missing name sits below a workspace that still exists.
    let live = worktree_path(&fx.root, "live");
    std::fs::create_dir_all(&live).unwrap();
    let elsewhere = [base.join("other/gone"), fx.root.join("gone"), live.join("gone")];
    let kept: Vec<PathBuf> = elsewhere.iter().enumerate().map(|(i, cwd)| transcript(&fx, &worktree_path(&fx.root, "gone"), &format!("s{i}"), &record(cwd))).collect();
    // A name Kingu cannot have created there.
    let odd = fx.root.join(".kingu/worktrees/Not A Slug");
    let odd_chat = transcript(&fx, &odd, "odd", &record(&odd));
    assert_eq!(sweep(&fx), SweepResult::default());
    assert!(kept.iter().all(|p| p.exists()) && odd_chat.exists());
  }

  #[test]
  fn keeps_everything_when_the_workspace_parent_is_missing_or_a_checkout() {
    let fx = fixture(&[]);
    let gone = worktree_path(&fx.root, "gone");
    let chat = transcript(&fx, &gone, "s1", &record(&gone));
    std::fs::create_dir(fx.root.join(".kingu/worktrees/.git")).unwrap();
    assert_eq!(sweep(&fx), SweepResult::default());
    // The whole parent gone (a moved project, an unmounted volume) proves nothing about `gone`.
    std::fs::remove_dir_all(fx.root.join(".kingu/worktrees")).unwrap();
    assert_eq!(sweep(&fx), SweepResult::default());
    assert!(chat.exists());
  }

  #[test]
  fn keeps_a_chat_whose_folder_has_a_lookalike_sibling() {
    let fx = fixture(&[]);
    let gone = worktree_path(&fx.root, "gone");
    let chat = transcript(&fx, &gone, "s1", &record(&gone));
    // Parsers trim the recorded cwd: this folder may be the one the chat ran in.
    std::fs::create_dir(fx.root.join(".kingu/worktrees/gone ")).unwrap();
    assert_eq!(sweep(&fx), SweepResult::default());
    assert!(chat.exists());
  }

  #[test]
  fn keeps_a_chat_whose_subagent_ran_elsewhere() {
    let fx = fixture(&[]);
    let gone = worktree_path(&fx.root, "gone");
    let chat = transcript(&fx, &gone, "s1", &record(&gone));
    let sub = chat.with_file_name("s1").join("subagents");
    std::fs::create_dir_all(&sub).unwrap();
    std::fs::write(sub.join("agent-1.jsonl"), record(&fx.root)).unwrap();
    assert_eq!(sweep(&fx), SweepResult::default());
    assert!(chat.exists() && sub.join("agent-1.jsonl").exists());
  }

  #[cfg(unix)]
  #[test]
  fn never_removes_through_a_link() {
    let fx = fixture(&[]);
    let gone = worktree_path(&fx.root, "gone");
    let chat = transcript(&fx, &gone, "s1", &record(&gone));
    let outside = fx.root.parent().unwrap().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("keep.txt"), "x").unwrap();
    // The session's companion folder is a link to somewhere else.
    std::os::unix::fs::symlink(&outside, chat.with_file_name("s1")).unwrap();
    let got = sweep(&fx);
    assert_eq!(got.deleted, 0);
    assert!(outside.join("keep.txt").exists() && chat.exists());
  }

  /// A Claude home with one idle chat of the deleted workspace `gone`; returns the transcript.
  fn claude_home_with_chat(fx: &Fixture, home: &Path) -> PathBuf {
    let gone = worktree_path(&fx.root, "gone");
    let dir = home.join("projects").join(crate::sessions::encode(&gone));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("s1.jsonl"), record(&gone)).unwrap();
    dir.join("s1.jsonl")
  }

  #[test]
  fn sweeps_the_claude_home_of_every_account_once() {
    let fx = fixture(&[]);
    let base = fx.root.parent().unwrap().to_path_buf();
    let accounts = base.join("ai-accounts/claude");
    let (first, second) = (accounts.join("0123456789ab"), accounts.join("ba9876543210"));
    let chats = [claude_home_with_chat(&fx, &fx.claude), claude_home_with_chat(&fx, &first), claude_home_with_chat(&fx, &second)];
    // Not account folders: another name, and a file named like an id.
    let stray = claude_home_with_chat(&fx, &accounts.join("not-an-account"));
    std::fs::write(accounts.join("aaaaaaaaaaaa"), "").unwrap();
    // Kingu's own CLAUDE_CONFIG_DIR can be an account's folder: swept once.
    let homes = claude_homes(&[fx.claude.clone(), second.clone(), PathBuf::from("relative")], &accounts);
    assert_eq!(homes, [fx.claude.clone(), second, first]);
    let mut got = SweepResult::default();
    for home in &homes {
      got.add(sweep_claude(&fx.root, home, &later, ON));
    }
    assert_eq!((got.deleted, got.failed), (3, 0));
    assert!(!chats.iter().any(|p| p.exists()) && stray.exists());
    assert!(claude_homes(&[], &base.join("none")).is_empty());
  }

  #[cfg(unix)]
  #[test]
  fn skips_a_claude_home_that_is_a_link_or_does_not_read() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let fx = fixture(&[]);
    let base = fx.root.parent().unwrap().to_path_buf();
    let accounts = base.join("ai-accounts/claude");
    let (plain, linked, linked_projects, unreadable) = (accounts.join("000000000001"), accounts.join("000000000002"), accounts.join("000000000003"), accounts.join("000000000004"));
    let elsewhere = base.join("elsewhere");
    let kept = [claude_home_with_chat(&fx, &elsewhere), claude_home_with_chat(&fx, &base.join("shared")), claude_home_with_chat(&fx, &unreadable)];
    let swept = claude_home_with_chat(&fx, &plain);
    // An account folder that is a link, and one whose `projects` is a link.
    symlink(&elsewhere, &linked).unwrap();
    std::fs::create_dir_all(&linked_projects).unwrap();
    symlink(base.join("shared/projects"), linked_projects.join("projects")).unwrap();
    std::fs::set_permissions(unreadable.join("projects"), std::fs::Permissions::from_mode(0o000)).unwrap();
    // SAFETY: geteuid has no preconditions.
    let root_user = unsafe { libc::geteuid() == 0 };
    let homes = claude_homes(&[linked.clone()], &accounts);
    std::fs::set_permissions(unreadable.join("projects"), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(homes, if root_user { vec![plain.clone(), unreadable.clone()] } else { vec![plain.clone()] });
    assert_eq!(sweep_claude(&fx.root, &plain, &later, ON).deleted, 1);
    assert!(!swept.exists() && kept.iter().all(|p| p.exists()));
    // The accounts folder itself as a link: no account home is taken from it.
    let accounts_link = base.join("accounts-link");
    symlink(&accounts, &accounts_link).unwrap();
    assert!(claude_homes(&[], &accounts_link).is_empty());
  }

  #[test]
  fn reads_the_last_cwd_past_long_records_and_chunk_boundaries() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("t.jsonl");
    let blob = format!("{}\n", serde_json::json!({ "type": "api", "data": "x".repeat(600 * 1024) }));
    std::fs::write(&path, format!("{}{}{blob}{blob}", record(Path::new("/first")), record(Path::new("/last")))).unwrap();
    assert_eq!(read_last_recorded_cwd(&path).unwrap().as_deref(), Some("/last"));
    std::fs::write(&path, "").unwrap();
    assert_eq!(read_last_recorded_cwd(&path).unwrap(), None);
    // A torn last line (a crash mid-write) is skipped; no trailing newline is fine.
    std::fs::write(&path, format!("{}{{\"cwd\":\"/to", record(Path::new("/whole")))).unwrap();
    assert_eq!(read_last_recorded_cwd(&path).unwrap().as_deref(), Some("/whole"));
    std::fs::write(&path, r#"{"cwd":"/only"}"#).unwrap();
    assert_eq!(read_last_recorded_cwd(&path).unwrap().as_deref(), Some("/only"));
  }

  fn write_chats(root: &Path, rows: &[(&str, &str, bool)]) {
    let rows: Vec<String> = rows
      .iter()
      .map(|(id, cwd, working)| {
        let cwd = if cwd.is_empty() { r#"{"kind":"folder"}"#.to_owned() } else { format!(r#"{{"kind":"task","slug":"{cwd}"}}"#) };
        format!(r#"{{"id":"{id}","title":"T","cwd":{cwd},"created_at":5,"updated_at":6,"working":{working}}}"#)
      })
      .collect();
    std::fs::write(root.join(".kingu/chats.json"), format!(r#"{{"version":1,"chats":[{}]}}"#, rows.join(","))).unwrap();
    std::fs::create_dir_all(root.join(".kingu/chats")).unwrap();
  }

  #[test]
  fn only_resting_chats_of_a_gone_unlisted_worktree_are_orphaned() {
    let fx = fixture(&["listed"]);
    std::fs::create_dir_all(worktree_path(&fx.root, "live")).unwrap();
    write_chats(&fx.root, &[("folder", "", false), ("live", "live", false), ("listed", "listed", false), ("busy", "gone", true), ("gone", "gone", false)]);
    let none = |_: &str| false;
    assert_eq!(orphaned_chats(&fx.root, later(), ON, &none), ["gone"]);
    assert!(orphaned_chats(&fx.root, later(), &|| false, &none).is_empty(), "off by default");
    // Used within the hour (`updated_at` 6 ms): kept.
    assert!(orphaned_chats(&fx.root, HOUR, ON, &none).is_empty());
  }

  #[test]
  fn forgetting_a_chat_proves_it_again_and_removes_only_its_own_files() {
    let fx = fixture(&[]);
    write_chats(&fx.root, &[("folder", "", false), ("gone", "gone", false)]);
    let chats_dir = fx.root.join(".kingu/chats");
    for id in ["folder", "gone"] {
      std::fs::write(chats_dir.join(format!("{id}.jsonl")), "{}\n").unwrap();
    }
    let none = |_: &str| false;
    assert_eq!(forget_chat(&fx.root, "folder", later(), ON, &none), Ok(None));
    assert_eq!(forget_chat(&fx.root, "gone", later(), &|| false, &none), Ok(None));
    assert_eq!(forget_chat(&fx.root, "gone", now_ms(), ON, &none), Ok(None), "its transcript was written within the hour");
    // The workspace came back before the removal.
    std::fs::create_dir_all(worktree_path(&fx.root, "gone")).unwrap();
    assert_eq!(forget_chat(&fx.root, "gone", later(), ON, &none), Ok(None));
    std::fs::remove_dir(worktree_path(&fx.root, "gone")).unwrap();
    assert!(chats_dir.join("gone.jsonl").exists());
    assert_eq!(forget_chat(&fx.root, "gone", later(), ON, &none), Ok(Some(3)));
    assert!(!chats_dir.join("gone.jsonl").exists() && chats_dir.join("folder.jsonl").exists());
  }

  #[test]
  fn a_chat_whose_agent_session_is_live_is_kept() {
    let fx = fixture(&[]);
    std::fs::write(
      fx.root.join(".kingu/chats.json"),
      r#"{"version":1,"chats":[{"id":"gone","title":"T","cwd":{"kind":"task","slug":"gone"},"session_id":"11111111-1111-4111-8111-111111111111","created_at":5}]}"#,
    )
    .unwrap();
    assert!(orphaned_chats(&fx.root, later(), ON, &|_| true).is_empty());
    assert_eq!(orphaned_chats(&fx.root, later(), ON, &|_| false), ["gone"]);
  }
}
