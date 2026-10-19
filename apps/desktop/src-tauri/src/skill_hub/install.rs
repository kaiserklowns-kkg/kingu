//! Installing, updating and removing Kingu-managed skills (`<app config>/skills/<name>`).
//!
//! Install is two steps, like snaps, so the user reviews exactly what lands: `prepare` fetches
//! the link into `<app cache>/skill-staging/<token>/src` (a shallow clone with hooks, submodules
//! and LFS off, a download through Kingu's proxy settings, an archive extracted with every path
//! checked, or a copy of a local folder), finds the skills in it and returns each with its files,
//! flags and SKILL.md; `commit` reads the chosen one again, refuses it unless it still hashes to
//! what the user was shown, and swaps it into place with renames. Nothing in a skill runs here.
//!
//! Where an installed skill came from is `<name>/.kingu-skill.json` (hidden, so not part of the
//! skill's hash nor copied into agent plugins); Update fetches the same place again.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::i18n::msg::SkillMsg;
use crate::snap_install::{GitSpec, is_commit};
use crate::tr;
use super::package::{self, FileEntry, Flag, MAX_ARCHIVE_BYTES, MAX_ARCHIVE_ENTRIES, SKILL_FILE, is_skill_name, read_skill_dir};
use super::source::{GitLink, Link, parse_link};

pub const ORIGIN_FILE: &str = ".kingu-skill.json";
const STAGED_META: &str = "staged.json";
const STAGING_TTL: Duration = Duration::from_secs(60 * 60);
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_DOWNLOAD_BYTES: u64 = 32 * 1024 * 1024;
/// Skills found in one source, and how deep below the linked folder they are looked for.
const MAX_CANDIDATES: usize = 100;
const MAX_SEARCH_DEPTH: usize = 4;
/// The review shows SKILL.md up to this much.
const MAX_PREVIEW_BYTES: usize = 64 * 1024;

/// Serializes changes to the skills dir (install, update, remove).
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

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OriginKind {
  Git,
  Archive,
  File,
  Folder,
}

/// `<name>/.kingu-skill.json`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Origin {
  pub kind: OriginKind,
  /// The git repository or the archive's https URL.
  #[serde(default)]
  pub url: Option<String>,
  #[serde(default, rename = "ref")]
  pub git_ref: Option<String>,
  /// The commit a git install got.
  #[serde(default)]
  pub commit: Option<String>,
  /// SHA-256 of the downloaded or local archive.
  #[serde(default)]
  pub archive_sha256: Option<String>,
  /// A local archive or folder.
  #[serde(default)]
  pub local: Option<String>,
  /// The skill's folder inside the repository, archive or local folder (`""` for its root).
  #[serde(default)]
  pub path: String,
  /// The skill's content hash when installed (`package::content_hash`).
  #[serde(default)]
  pub hash: String,
  #[serde(default)]
  pub installed_at: u64,
}

impl Origin {
  fn blank(kind: OriginKind) -> Self {
    Self { kind, url: None, git_ref: None, commit: None, archive_sha256: None, local: None, path: String::new(), hash: String::new(), installed_at: 0 }
  }

  /// Replacing an installed skill is allowed only from the same place (same repo or file).
  fn same_source(&self, other: &Origin) -> bool {
    self.kind == other.kind && ((self.url.is_some() && self.url == other.url) || (self.local.is_some() && self.local == other.local))
  }
}

/// The origin record of an installed skill; `None` when missing, a symlink, too big or corrupt.
pub fn read_origin(skill_dir: &Path) -> Option<Origin> {
  let file = skill_dir.join(ORIGIN_FILE);
  let meta = std::fs::symlink_metadata(&file).ok()?;
  if !meta.is_file() || meta.len() > 64 * 1024 {
    return None;
  }
  serde_json::from_slice(&std::fs::read(file).ok()?).ok()
}

// ---------------------------------------------------------------------------------------------
// Staging

/// A skill found in a staged source, as the review shows it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
  /// Folder relative to the linked folder (`""`: the linked folder is the skill).
  pub rel: String,
  pub name: String,
  pub description: String,
  pub allowed_tools: Option<String>,
  pub files: Vec<FileEntry>,
  pub flags: Vec<Flag>,
  pub hash: String,
  /// SKILL.md, cut at `MAX_PREVIEW_BYTES`.
  pub skill_md: String,
  pub truncated: bool,
  /// Why it cannot be installed (it is still listed so the user sees what was found).
  pub error: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
  pub token: String,
  pub origin: Origin,
  pub candidates: Vec<Candidate>,
  /// Installed skills with a candidate's name (what an install would replace).
  pub existing: Vec<String>,
}

/// What `commit` needs from staging besides the files: the origin minus the candidate's folder.
#[derive(Serialize, Deserialize)]
struct Staged {
  origin: Origin,
  /// The linked folder inside `src`.
  base: String,
}

fn is_token(s: &str) -> bool {
  !s.is_empty() && s.len() <= 64 && s.bytes().all(|c| c.is_ascii_hexdigit())
}

fn prune_staging(staging: &Path) {
  let Ok(read) = std::fs::read_dir(staging) else { return };
  for entry in read.flatten() {
    let old = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > STAGING_TTL);
    if old {
      let _ = std::fs::remove_dir_all(entry.path());
    }
  }
}

fn preview(text: &str) -> (String, bool) {
  if text.len() <= MAX_PREVIEW_BYTES {
    return (text.to_string(), false);
  }
  let mut end = MAX_PREVIEW_BYTES;
  while !text.is_char_boundary(end) {
    end -= 1;
  }
  (text[..end].to_string(), true)
}

fn candidate(dir: &Path, rel: String) -> Candidate {
  match read_skill_dir(dir) {
    Ok(s) => {
      let (skill_md, truncated) = preview(&s.skill_md);
      Candidate { rel, name: s.front.name, description: s.front.description, allowed_tools: s.front.allowed_tools, files: s.files, flags: s.flags, hash: s.hash, skill_md, truncated, error: None }
    }
    Err(e) => {
      let folder = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
      let text = std::fs::read_to_string(dir.join(SKILL_FILE)).unwrap_or_default();
      let (name, description) = package::summary(&text, &folder);
      let (skill_md, truncated) = preview(&text);
      Candidate { rel, name, description, allowed_tools: None, files: Vec::new(), flags: Vec::new(), hash: String::new(), skill_md, truncated, error: Some(e) }
    }
  }
}

/// Folders below `dir` that hold a SKILL.md (not looking inside a skill, hidden folders or
/// `node_modules`), by path.
fn find_skills(dir: &Path, prefix: &str, depth: usize, out: &mut Vec<String>) {
  if depth > MAX_SEARCH_DEPTH || out.len() >= MAX_CANDIDATES {
    return;
  }
  let Ok(read) = std::fs::read_dir(dir) else { return };
  let mut entries: Vec<_> = read.flatten().collect();
  entries.sort_by_key(|e| e.file_name());
  for entry in entries {
    let name = entry.file_name().to_string_lossy().into_owned();
    if name.starts_with('.') || name == "node_modules" || !std::fs::symlink_metadata(entry.path()).is_ok_and(|m| m.is_dir()) {
      continue;
    }
    let rel = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
    if std::fs::symlink_metadata(entry.path().join(SKILL_FILE)).is_ok_and(|m| m.is_file()) {
      if out.len() < MAX_CANDIDATES {
        out.push(rel);
      }
    } else {
      find_skills(&entry.path(), &rel, depth + 1, out);
    }
  }
}

/// The linked folder itself when it is a skill, else the skills below it.
pub fn candidates(base: &Path) -> Result<Vec<Candidate>, String> {
  match std::fs::symlink_metadata(base) {
    Ok(m) if m.is_dir() && !m.file_type().is_symlink() => {}
    _ => return Err(tr!(SkillMsg::LinkedFolderMissing)),
  }
  if std::fs::symlink_metadata(base.join(SKILL_FILE)).is_ok() {
    return Ok(vec![candidate(base, String::new())]);
  }
  let mut rels = Vec::new();
  find_skills(base, "", 0, &mut rels);
  if rels.is_empty() {
    return Err(tr!(SkillMsg::NoSkillFound, file = SKILL_FILE));
  }
  Ok(rels.into_iter().map(|rel| candidate(&base.join(&rel), rel)).collect())
}

/// Joins `/`-separated parts that `package::entry_path` already checked (or `""`).
fn join_rel(a: &str, b: &str) -> String {
  match (a.is_empty(), b.is_empty()) {
    (true, _) => b.to_string(),
    (_, true) => a.to_string(),
    _ => format!("{a}/{b}"),
  }
}

fn checked_rel(rel: &str) -> Result<&str, String> {
  if rel.is_empty() || package::entry_path(rel).as_deref() == Some(rel) {
    Ok(rel)
  } else {
    Err(tr!(SkillMsg::InstallDataInvalid))
  }
}

/// Validates the staged source and lists its skills; records the origin for `commit`.
fn finish_stage(token: String, dir: &Path, origin: Origin, base: &str, skills_dir: &Path) -> Result<Prepared, String> {
  let base_dir = dir.join("src").join(checked_rel(base)?);
  let candidates = candidates(&base_dir)?;
  let meta = serde_json::to_string(&Staged { origin: origin.clone(), base: base.to_string() }).map_err(|e| e.to_string())?;
  std::fs::write(dir.join(STAGED_META), meta).map_err(|e| tr!(SkillMsg::WriteFailed, path = STAGED_META, detail = e))?;
  let existing = candidates.iter().filter(|c| is_skill_name(&c.name) && skills_dir.join(&c.name).exists()).map(|c| c.name.clone()).collect();
  Ok(Prepared { token, origin, candidates, existing })
}

/// Runs `f` on a fresh staging folder; the folder is removed when it fails.
fn staged(staging: &Path, f: impl FnOnce(&str, &Path) -> Result<Prepared, String>) -> Result<Prepared, String> {
  prune_staging(staging);
  let token = unique();
  let dir = staging.join(&token);
  std::fs::create_dir_all(&dir).map_err(|e| tr!(SkillMsg::CreateFailed, path = dir.display(), detail = e))?;
  let result = f(&token, &dir);
  if result.is_err() {
    let _ = std::fs::remove_dir_all(&dir);
  }
  result
}

/// Fetches one reading of a git link into `<dir>/src`; returns the commit.
fn fetch_git(dir: &Path, link: &GitLink, timeout: Duration) -> Result<String, String> {
  let _ = std::fs::remove_dir_all(dir.join("src"));
  match link.git_ref.as_deref() {
    Some(commit) if is_commit(commit) => {
      crate::snap_install::fetch_commit(dir, &GitSpec { url: link.url.clone(), git_ref: None }, commit, timeout)?;
      Ok(commit.to_string())
    }
    _ => crate::snap_install::clone(dir, &GitSpec { url: link.url.clone(), git_ref: link.git_ref.clone() }, timeout),
  }
}

/// Copies `from` (a local folder) into `to`: every regular file, `.git` and hidden entries left
/// out, symlinks and special files refused, within the archive limits.
fn copy_tree(from: &Path, to: &Path, prefix: &str, count: &mut (usize, u64)) -> Result<(), String> {
  if prefix.split('/').count() > package::MAX_DEPTH + 4 {
    return Err(tr!(SkillMsg::TooDeep, max = package::MAX_DEPTH + 4));
  }
  std::fs::create_dir_all(to).map_err(|e| tr!(SkillMsg::CreateFailed, path = to.display(), detail = e))?;
  let mut entries: Vec<_> = std::fs::read_dir(from).map_err(|e| tr!(SkillMsg::ReadFailed, path = from.display(), detail = e))?.flatten().collect();
  entries.sort_by_key(|e| e.file_name());
  for entry in entries {
    let name = entry.file_name().to_string_lossy().into_owned();
    if name.starts_with('.') || name == "node_modules" {
      continue;
    }
    let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
    let meta = std::fs::symlink_metadata(entry.path()).map_err(|e| tr!(SkillMsg::ReadFailed, path = rel, detail = e))?;
    if meta.file_type().is_symlink() {
      return Err(tr!(SkillMsg::Symlink, path = rel));
    }
    if meta.is_dir() {
      copy_tree(&entry.path(), &to.join(&name), &rel, count)?;
    } else if meta.is_file() {
      count.0 += 1;
      count.1 += meta.len();
      if count.0 > MAX_ARCHIVE_ENTRIES || count.1 > MAX_ARCHIVE_BYTES {
        return Err(tr!(SkillMsg::ArchiveTooBig, files = MAX_ARCHIVE_ENTRIES, mb = MAX_ARCHIVE_BYTES / 1024 / 1024));
      }
      std::fs::copy(entry.path(), to.join(&name)).map_err(|e| tr!(SkillMsg::CopyFailed, path = rel, detail = e))?;
    } else {
      return Err(tr!(SkillMsg::NotPlain, path = rel));
    }
  }
  Ok(())
}

/// GETs an archive URL through Kingu's proxy settings, at most `MAX_DOWNLOAD_BYTES`.
pub fn download(url: &str, timeout: Duration) -> Result<Vec<u8>, String> {
  let client = crate::net_proxy::client_builder()?.timeout(timeout).build().map_err(|e| tr!(SkillMsg::DownloadFailed, url, detail = e))?;
  let response = client.get(url).send().map_err(|e| tr!(SkillMsg::DownloadFailed, url, detail = e))?;
  if !response.status().is_success() {
    return Err(tr!(SkillMsg::DownloadFailed, url, detail = response.status()));
  }
  // Redirects may only stay on https.
  if response.url().scheme() != "https" {
    return Err(tr!(SkillMsg::LinkNotHttps, url = response.url().as_str()));
  }
  if response.content_length().is_some_and(|n| n > MAX_DOWNLOAD_BYTES) {
    return Err(tr!(SkillMsg::DownloadTooBig, mb = MAX_DOWNLOAD_BYTES / 1024 / 1024));
  }
  let mut bytes = Vec::new();
  response.take(MAX_DOWNLOAD_BYTES + 1).read_to_end(&mut bytes).map_err(|e| tr!(SkillMsg::DownloadFailed, url, detail = e))?;
  if bytes.len() as u64 > MAX_DOWNLOAD_BYTES {
    return Err(tr!(SkillMsg::DownloadTooBig, mb = MAX_DOWNLOAD_BYTES / 1024 / 1024));
  }
  Ok(bytes)
}

fn read_local_archive(path: &str) -> Result<Vec<u8>, String> {
  match std::fs::symlink_metadata(path) {
    Ok(m) if m.is_file() && m.len() <= MAX_DOWNLOAD_BYTES => {}
    Ok(m) if m.is_file() => return Err(tr!(SkillMsg::DownloadTooBig, mb = MAX_DOWNLOAD_BYTES / 1024 / 1024)),
    _ => return Err(tr!(SkillMsg::FileNotFound, path)),
  }
  std::fs::read(path).map_err(|e| tr!(SkillMsg::ReadFailed, path, detail = e))
}

/// Fetches a link into staging and lists the skills at (or below) the linked folder: a git
/// reading's own folder, `base` for the other links. `fetch` downloads archive URLs (a stand-in
/// in tests).
pub fn prepare_link(staging: &Path, skills_dir: &Path, link: &Link, base: &str, timeout: Duration, fetch: &dyn Fn(&str) -> Result<Vec<u8>, String>) -> Result<Prepared, String> {
  staged(staging, |token, dir| match link {
    Link::Git(readings) => {
      let mut last = None;
      for reading in readings {
        match fetch_git(dir, reading, timeout) {
          Ok(commit) => {
            let origin = Origin { url: Some(reading.url.clone()), git_ref: reading.git_ref.clone(), commit: Some(commit), ..Origin::blank(OriginKind::Git) };
            return finish_stage(token.to_string(), dir, origin, &reading.path, skills_dir);
          }
          Err(e) => last = Some(e),
        }
      }
      Err(last.unwrap_or_else(|| tr!(SkillMsg::LinkEmpty)))
    }
    Link::Archive { url } => {
      let bytes = fetch(url)?;
      package::extract_zip(&bytes, &dir.join("src"))?;
      let origin = Origin { url: Some(url.clone()), archive_sha256: Some(crate::snap::sha256_hex(&bytes)), ..Origin::blank(OriginKind::Archive) };
      finish_stage(token.to_string(), dir, origin, base, skills_dir)
    }
    Link::LocalArchive { path } => {
      let bytes = read_local_archive(path)?;
      package::extract_zip(&bytes, &dir.join("src"))?;
      let origin = Origin { local: Some(path.clone()), archive_sha256: Some(crate::snap::sha256_hex(&bytes)), ..Origin::blank(OriginKind::File) };
      finish_stage(token.to_string(), dir, origin, base, skills_dir)
    }
    Link::LocalFolder { path } => {
      match std::fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() && !m.file_type().is_symlink() => {}
        _ => return Err(tr!(SkillMsg::FolderMissing, path)),
      }
      copy_tree(Path::new(path), &dir.join("src"), "", &mut (0, 0))?;
      let origin = Origin { local: Some(path.clone()), ..Origin::blank(OriginKind::Folder) };
      finish_stage(token.to_string(), dir, origin, base, skills_dir)
    }
  })
}

pub fn prepare(staging: &Path, skills_dir: &Path, input: &str, timeout: Duration) -> Result<Prepared, String> {
  prepare_link(staging, skills_dir, &parse_link(input)?, "", timeout, &|url| download(url, timeout))
}

/// The staged source must hold skill `name` exactly at the linked folder (an update or a team
/// install), else the staging is dropped.
fn single(staging: &Path, p: Prepared, name: &str) -> Result<Prepared, String> {
  if let [c] = p.candidates.as_slice()
    && c.rel.is_empty()
    && c.name == name
  {
    return Ok(p);
  }
  cancel(staging, &p.token);
  Err(tr!(SkillMsg::SkillGoneFromSource, name))
}

/// Fetches installed skill `name` again from where it came from.
pub fn prepare_update(staging: &Path, skills_dir: &Path, name: &str, timeout: Duration, fetch: &dyn Fn(&str) -> Result<Vec<u8>, String>) -> Result<Prepared, String> {
  let origin = read_origin(&installed_dir(skills_dir, name)?).ok_or_else(|| tr!(SkillMsg::NoOrigin, name))?;
  let missing = || tr!(SkillMsg::NoOrigin, name);
  let link = match origin.kind {
    // A pinned commit stays pinned; a branch or the default branch moves on.
    OriginKind::Git => Link::Git(vec![GitLink { url: origin.url.clone().ok_or_else(missing)?, git_ref: origin.git_ref.clone(), path: origin.path.clone() }]),
    OriginKind::Archive => Link::Archive { url: origin.url.clone().ok_or_else(missing)? },
    OriginKind::File => Link::LocalArchive { path: origin.local.clone().ok_or_else(missing)? },
    OriginKind::Folder => Link::LocalFolder { path: origin.local.clone().ok_or_else(missing)? },
  };
  let gone = tr!(SkillMsg::LinkedFolderMissing);
  let p = prepare_link(staging, skills_dir, &link, &origin.path, timeout, fetch).map_err(|e| if e == gone { tr!(SkillMsg::SkillGoneFromSource, name) } else { e })?;
  single(staging, p, name)
}

/// Stages exactly `commit` of `url` and keeps the skill at `path` only if it is `name` and
/// hashes to `hash` (a skill the team shared). `git_ref` is the branch later updates follow.
#[allow(clippy::too_many_arguments)]
pub fn prepare_pinned(staging: &Path, skills_dir: &Path, url: &str, git_ref: Option<&str>, path: &str, commit: &str, name: &str, hash: &str, timeout: Duration) -> Result<Prepared, String> {
  if !is_commit(commit) || !crate::snap_install::is_sha256(hash) || !is_skill_name(name) || checked_rel(path).is_err() {
    return Err(tr!(SkillMsg::InstallDataInvalid));
  }
  let spec = crate::snap_install::parse_git_source(url)?;
  let link = Link::Git(vec![GitLink { url: spec.url, git_ref: Some(commit.to_string()), path: path.to_string() }]);
  let mut p = single(staging, prepare_link(staging, skills_dir, &link, "", timeout, &|_| Err(String::new()))?, name)?;
  let refuse = |p: &Prepared, e: String| {
    cancel(staging, &p.token);
    Err(e)
  };
  let c = &p.candidates[0];
  if let Some(e) = &c.error {
    return refuse(&p, tr!(SkillMsg::InstallBroken, name, detail = e));
  }
  if c.hash != hash {
    let got = c.hash.get(..12).unwrap_or_default().to_string();
    return refuse(&p, tr!(SkillMsg::HashMismatch, name, got, shared = hash.get(..12).unwrap_or_default()));
  }
  p.origin.git_ref = git_ref.map(String::from);
  let staged = Staged { origin: p.origin.clone(), base: path.to_string() };
  let meta = serde_json::to_string(&staged).map_err(|e| e.to_string())?;
  if let Err(e) = std::fs::write(staging.join(&p.token).join(STAGED_META), meta) {
    return refuse(&p, tr!(SkillMsg::WriteFailed, path = STAGED_META, detail = e));
  }
  Ok(p)
}

pub fn cancel(staging: &Path, token: &str) {
  if is_token(token) {
    let _ = std::fs::remove_dir_all(staging.join(token));
  }
}

/// Installs the candidate at `rel` of staged `token` into `skills_dir/<name>`. `hash` is what the
/// user reviewed; `replace` allows replacing an installed skill from the same source (an update).
pub fn commit(staging: &Path, skills_dir: &Path, token: &str, rel: &str, hash: &str, replace: bool) -> Result<String, String> {
  if !is_token(token) {
    return Err(tr!(SkillMsg::InstallDataInvalid));
  }
  let rel = checked_rel(rel)?;
  let dir = staging.join(token);
  let staged: Staged = std::fs::read(dir.join(STAGED_META)).ok().and_then(|b| serde_json::from_slice(&b).ok()).ok_or_else(|| tr!(SkillMsg::StagingGone))?;
  let base = checked_rel(&staged.base)?;
  let from = dir.join("src").join(base).join(rel);
  let skill = read_skill_dir(&from)?;
  if skill.hash != hash {
    return Err(tr!(SkillMsg::ChangedWhileWaiting, name = skill.front.name));
  }
  let name = skill.front.name.clone();
  let origin = Origin { path: join_rel(base, rel), hash: skill.hash.clone(), installed_at: now_secs(), ..staged.origin };
  let result = {
    let _guard = INSTALL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    install_dir(skills_dir, &name, &from, &skill.files, &origin, replace)
  };
  let _ = std::fs::remove_dir_all(&dir);
  result.map(|()| name)
}

/// Copies the skill beside the old one, then swaps with renames, so an agent starting meanwhile
/// sees the old skill or the new one, never a mix.
fn install_dir(skills_dir: &Path, name: &str, from: &Path, files: &[FileEntry], origin: &Origin, replace: bool) -> Result<(), String> {
  std::fs::create_dir_all(skills_dir).map_err(|e| tr!(SkillMsg::CreateFailed, path = skills_dir.display(), detail = e))?;
  let target = skills_dir.join(name);
  let exists = match std::fs::symlink_metadata(&target) {
    Ok(m) if m.file_type().is_symlink() || !m.is_dir() => return Err(tr!(SkillMsg::TargetNotFolder, path = target.display())),
    Ok(_) => true,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
    Err(e) => return Err(tr!(SkillMsg::ReadFailed, path = target.display(), detail = e)),
  };
  if exists {
    if !replace {
      return Err(tr!(SkillMsg::AlreadyInstalled, name));
    }
    if !read_origin(&target).is_some_and(|o| o.same_source(origin)) {
      return Err(tr!(SkillMsg::InstalledElsewhere, name));
    }
  }
  let stamp = unique();
  let tmp = skills_dir.join(format!(".tmp-{name}-{stamp}"));
  let build = || -> Result<(), String> {
    package::copy_files(from, &tmp, files)?;
    let text = serde_json::to_string_pretty(origin).map_err(|e| e.to_string())?;
    std::fs::write(tmp.join(ORIGIN_FILE), text + "\n").map_err(|e| tr!(SkillMsg::WriteFailed, path = ORIGIN_FILE, detail = e))
  };
  if let Err(e) = build() {
    let _ = std::fs::remove_dir_all(&tmp);
    return Err(e);
  }
  if !exists {
    return std::fs::rename(&tmp, &target).map_err(|e| {
      let _ = std::fs::remove_dir_all(&tmp);
      tr!(SkillMsg::MoveFailed, detail = e)
    });
  }
  let old = skills_dir.join(format!(".old-{name}-{stamp}"));
  std::fs::rename(&target, &old).map_err(|e| {
    let _ = std::fs::remove_dir_all(&tmp);
    tr!(SkillMsg::MoveFailed, detail = e)
  })?;
  if let Err(e) = std::fs::rename(&tmp, &target) {
    let _ = std::fs::rename(&old, &target);
    let _ = std::fs::remove_dir_all(&tmp);
    return Err(tr!(SkillMsg::MoveFailed, detail = e));
  }
  let _ = std::fs::remove_dir_all(&old);
  Ok(())
}

/// Hands installed skill `name` to `trash` (the system Trash in the app, a stand-in in tests).
pub fn remove(skills_dir: &Path, name: &str, trash: impl FnOnce(&Path) -> Result<(), String>) -> Result<(), String> {
  if !is_skill_name(name) {
    return Err(tr!(SkillMsg::NameInvalid, name));
  }
  let path = skills_dir.join(name);
  std::fs::symlink_metadata(&path).map_err(|_| tr!(SkillMsg::NotInstalled, name))?;
  let _guard = INSTALL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  trash(&path)
}

/// The installed skill folder `skills_dir/<name>` (a real folder).
pub fn installed_dir(skills_dir: &Path, name: &str) -> Result<PathBuf, String> {
  if !is_skill_name(name) {
    return Err(tr!(SkillMsg::NameInvalid, name));
  }
  let dir = skills_dir.join(name);
  match std::fs::symlink_metadata(&dir) {
    Ok(m) if m.is_dir() && !m.file_type().is_symlink() => Ok(dir),
    _ => Err(tr!(SkillMsg::NotInstalled, name)),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::skill_hub::package::tests::skill;
  use std::io::Write;

  fn zip_of(entries: &[(&str, &str)]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, text) in entries {
      zip.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
      zip.write_all(text.as_bytes()).unwrap();
    }
    zip.finish().unwrap().into_inner()
  }

  const PDF: &str = "---\nname: pdf\ndescription: PDF help\n---\n# PDF\n";

  fn no_fetch(_: &str) -> Result<Vec<u8>, String> {
    Err("offline".into())
  }

  #[test]
  fn installs_a_local_archive_and_updates_it() {
    let tmp = tempfile::tempdir().unwrap();
    let (staging, skills) = (tmp.path().join("staging"), tmp.path().join("skills"));
    let file = tmp.path().join("pdf.skill");
    std::fs::write(&file, zip_of(&[("pdf/SKILL.md", PDF), ("pdf/ref.md", "v1")])).unwrap();
    let link = Link::LocalArchive { path: file.display().to_string() };
    let p = prepare_link(&staging, &skills, &link, "", FETCH_TIMEOUT, &no_fetch).unwrap();
    assert_eq!(p.candidates.len(), 1);
    let c = &p.candidates[0];
    assert_eq!((c.rel.as_str(), c.name.as_str(), c.error.as_ref()), ("pdf", "pdf", None));
    assert!(p.existing.is_empty());
    // A wrong hash (the review was of other content) is refused.
    assert_eq!(commit(&staging, &skills, &p.token, &c.rel, "0".repeat(64).as_str(), false), Err(tr!(SkillMsg::ChangedWhileWaiting, name = "pdf")));
    assert_eq!(commit(&staging, &skills, &p.token, &c.rel, &c.hash, false).unwrap(), "pdf");
    assert!(!staging.join(&p.token).exists());
    let origin = read_origin(&skills.join("pdf")).unwrap();
    assert_eq!((origin.kind, origin.path.as_str(), origin.hash.as_str()), (OriginKind::File, "pdf", c.hash.as_str()));
    assert_eq!(std::fs::read_to_string(skills.join("pdf/ref.md")).unwrap(), "v1");

    // Installing again without replace is refused; an update replaces it.
    let again = prepare_link(&staging, &skills, &link, "", FETCH_TIMEOUT, &no_fetch).unwrap();
    assert_eq!(again.existing, ["pdf"]);
    assert_eq!(commit(&staging, &skills, &again.token, "pdf", &again.candidates[0].hash, false), Err(tr!(SkillMsg::AlreadyInstalled, name = "pdf")));
    std::fs::write(&file, zip_of(&[("pdf/SKILL.md", PDF), ("pdf/ref.md", "v2")])).unwrap();
    let u = prepare_update(&staging, &skills, "pdf", FETCH_TIMEOUT, &no_fetch).unwrap();
    assert_eq!(u.candidates.len(), 1);
    assert_ne!(u.candidates[0].hash, c.hash);
    commit(&staging, &skills, &u.token, "", &u.candidates[0].hash, true).unwrap();
    assert_eq!(std::fs::read_to_string(skills.join("pdf/ref.md")).unwrap(), "v2");
    assert_eq!(read_origin(&skills.join("pdf")).unwrap().path, "pdf");

    remove(&skills, "pdf", |p| std::fs::remove_dir_all(p).map_err(|e| e.to_string())).unwrap();
    assert!(!skills.join("pdf").exists());
    assert_eq!(remove(&skills, "pdf", |_| Ok(())), Err(tr!(SkillMsg::NotInstalled, name = "pdf")));
  }

  #[test]
  fn replacing_needs_the_same_source() {
    let tmp = tempfile::tempdir().unwrap();
    let (staging, skills) = (tmp.path().join("staging"), tmp.path().join("skills"));
    for (n, folder) in ["a", "b"].iter().enumerate() {
      let dir = tmp.path().join(folder).join("pdf");
      skill(&dir, "pdf", "PDF help");
      let p = prepare_link(&staging, &skills, &Link::LocalFolder { path: dir.display().to_string() }, "", FETCH_TIMEOUT, &no_fetch).unwrap();
      let result = commit(&staging, &skills, &p.token, "", &p.candidates[0].hash, true);
      if n == 0 {
        assert_eq!(result.unwrap(), "pdf");
      } else {
        assert_eq!(result, Err(tr!(SkillMsg::InstalledElsewhere, name = "pdf")));
      }
    }
  }

  #[test]
  fn lists_every_skill_of_a_repo_like_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    skill(&repo.join("skills/pdf"), "pdf", "PDF help");
    skill(&repo.join("skills/docs/writing"), "writing", "Write docs");
    std::fs::create_dir_all(repo.join("skills/broken")).unwrap();
    std::fs::write(repo.join("skills/broken/SKILL.md"), "no front matter").unwrap();
    skill(&repo.join(".hidden/x"), "x", "hidden");
    skill(&repo.join("node_modules/y"), "y", "deps");
    let p = prepare_link(&tmp.path().join("staging"), &tmp.path().join("skills"), &Link::LocalFolder { path: repo.display().to_string() }, "", FETCH_TIMEOUT, &no_fetch).unwrap();
    let found: Vec<_> = p.candidates.iter().map(|c| (c.rel.as_str(), c.name.as_str(), c.error.is_some())).collect();
    assert_eq!(found, [("skills/broken", "broken", true), ("skills/docs/writing", "writing", false), ("skills/pdf", "pdf", false)]);
    // A broken candidate cannot be committed.
    assert!(commit(&tmp.path().join("staging"), &tmp.path().join("skills"), &p.token, "skills/broken", "", false).is_err());
  }

  #[test]
  fn downloads_through_the_fetcher_and_records_the_sha() {
    let tmp = tempfile::tempdir().unwrap();
    let bytes = zip_of(&[("SKILL.md", PDF)]);
    let fetched = bytes.clone();
    let link = Link::Archive { url: "https://example.com/pdf.skill".into() };
    let p = prepare_link(&tmp.path().join("staging"), &tmp.path().join("skills"), &link, "", FETCH_TIMEOUT, &move |_| Ok(fetched.clone())).unwrap();
    assert_eq!(p.origin.archive_sha256.as_deref(), Some(crate::snap::sha256_hex(&bytes).as_str()));
    assert_eq!(p.candidates[0].rel, "");
    assert_eq!(prepare_link(&tmp.path().join("staging"), &tmp.path().join("skills"), &link, "", FETCH_TIMEOUT, &no_fetch).unwrap_err(), "offline");
  }

  #[test]
  fn refuses_bad_install_data() {
    let tmp = tempfile::tempdir().unwrap();
    let (staging, skills) = (tmp.path().join("staging"), tmp.path().join("skills"));
    assert_eq!(commit(&staging, &skills, "../x", "", "", false), Err(tr!(SkillMsg::InstallDataInvalid)));
    assert_eq!(commit(&staging, &skills, "abc", "../x", "", false), Err(tr!(SkillMsg::InstallDataInvalid)));
    assert_eq!(commit(&staging, &skills, "abc", "", "", false), Err(tr!(SkillMsg::StagingGone)));
    assert_eq!(remove(&skills, "../x", |_| Ok(())), Err(tr!(SkillMsg::NameInvalid, name = "../x")));
  }

  #[test]
  fn clones_a_local_repo_at_a_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    skill(&repo.join("skills/pdf"), "pdf", "PDF help");
    let git = |args: &[&str]| assert!(std::process::Command::new("git").args(args).current_dir(&repo).env("GIT_CONFIG_GLOBAL", "/dev/null").output().unwrap().status.success());
    git(&["init", "-q", "-b", "main"]);
    git(&["add", "."]);
    git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x"]);
    let link = super::super::source::parse_link(&format!("{}#main:skills/pdf", repo.display())).unwrap();
    let p = prepare_link(&tmp.path().join("staging"), &tmp.path().join("skills"), &link, "", FETCH_TIMEOUT, &no_fetch).unwrap();
    assert_eq!(p.origin.kind, OriginKind::Git);
    assert!(p.origin.commit.as_deref().is_some_and(is_commit));
    assert_eq!(p.candidates[0].name, "pdf");
    let name = commit(&tmp.path().join("staging"), &tmp.path().join("skills"), &p.token, "", &p.candidates[0].hash, false).unwrap();
    assert_eq!(read_origin(&tmp.path().join("skills").join(name)).unwrap().path, "skills/pdf");
  }
}
