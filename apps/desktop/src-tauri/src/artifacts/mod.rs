//! Artifacts (old Kingu's / Orca's "Artifacts"): pages an agent makes for the user, an HTML or
//! Markdown file with optional assets, kept in the project and opened in a sandboxed preview.
//!
//! - Store: `<project>/.kingu/artifacts/<id>/artifact.json` (title, format, versions) and one
//!   folder per version, `v<N>/`, holding the page (`index.html` or `index.md`) and its assets
//!   at their relative names. `.kingu/` stays out of git status through `info/exclude`
//!   (agent/worktree.rs). Ids are 16 random lowercase hex digits; versions count from 1 and are
//!   never rewritten.
//! - Publishing: only through Rust, from the `kingu` command's `artifact.publish` request
//!   (cli_server.rs), which is also how the agent host's `artifact_publish` MCP tool publishes.
//!   The request names files on disk; they are copied in, checked here (regular files, sizes,
//!   names that stay inside the version folder).
//! - Preview: preview.rs serves a version over the `kingu-artifact:` scheme to a sandboxed iframe
//!   with a CSP of its own. Export and team share: bundle.rs inlines the assets into one file.

pub mod bundle;
pub mod preview;
pub mod team;

use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::i18n::msg::ArtifactMsg;
use crate::projects::{Projects, root_arg};
use crate::tr;
use crate::workspace::Workspace;

/// `<project>/.kingu/artifacts`.
pub const STORE: [&str; 2] = [".kingu", "artifacts"];
pub const META_FILE: &str = "artifact.json";
/// Sent to the window after a publish or a delete: `{ root, id }`.
pub const CHANGED_EVENT: &str = "artifacts://changed";

pub const MAX_TITLE: usize = 200;
pub const MAX_DESCRIPTION: usize = 1000;
pub const MAX_ENTRY_BYTES: u64 = 5 * 1024 * 1024;
pub const MAX_ASSET_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: u64 = 25 * 1024 * 1024;
/// Files per version, the page included.
pub const MAX_FILES: usize = 100;
pub const MAX_VERSIONS: u32 = 200;
const MAX_NAME: usize = 200;
const MAX_DEPTH: usize = 8;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Format {
  Html,
  Markdown,
}

impl Format {
  /// The page's name inside a version folder.
  pub fn entry(self) -> &'static str {
    match self {
      Format::Html => "index.html",
      Format::Markdown => "index.md",
    }
  }
}

/// `.html` / `.htm` / `.md` / `.markdown` (any case).
pub fn format_of(path: &Path) -> Option<Format> {
  match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
    "html" | "htm" => Some(Format::Html),
    "md" | "markdown" => Some(Format::Markdown),
    _ => None,
  }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct FileEntry {
  pub path: String,
  pub size: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Version {
  pub version: u32,
  /// Unix ms.
  pub created_at: u64,
  pub format: Format,
  /// The page: `index.html` or `index.md`.
  pub entry: String,
  /// Every file of the version, the page first.
  pub files: Vec<FileEntry>,
  /// `agent` (the agent host's tool) or `cli` (`kingu artifact publish`).
  #[serde(default)]
  pub source: String,
}

/// Where a version went on the team server (artifacts/team.rs).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Shared {
  pub server: String,
  pub version: u32,
  pub shared_at: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Meta {
  pub id: String,
  pub title: String,
  #[serde(default)]
  pub description: Option<String>,
  pub created_at: u64,
  pub updated_at: u64,
  /// Oldest first; never empty.
  pub versions: Vec<Version>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub shared: Option<Shared>,
}

impl Meta {
  pub fn latest(&self) -> &Version {
    self.versions.last().expect("an artifact has a version")
  }

  pub fn version(&self, n: u32) -> Option<&Version> {
    self.versions.iter().find(|v| v.version == n)
  }
}

fn now_ms() -> u64 {
  std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// 16 lowercase hex digits from the OS random source.
pub fn new_id() -> Result<String, String> {
  kingu_cli::protocol::new_token().map(|t| t[..16].to_owned())
}

pub fn valid_id(id: &str) -> bool {
  id.len() == 16 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn check_id(id: &str) -> Result<(), String> {
  if valid_id(id) { Ok(()) } else { Err(tr!(ArtifactMsg::BadId, id)) }
}

/// A file's name inside an artifact: a relative path of plain segments (no `.`, `..`, empty or
/// hidden-dot-only segments, no backslash, colon or control characters), at most 8 deep. The
/// same rule as the agent host's (apps/agent-host/src/artifacts.ts).
pub fn safe_name(name: &str) -> Result<String, String> {
  let bad = || tr!(ArtifactMsg::BadName, name);
  if name.is_empty() || name.len() > MAX_NAME || name.starts_with('/') || name.chars().any(|c| c.is_control() || c == '\\' || c == ':') {
    return Err(bad());
  }
  let segments: Vec<&str> = name.split('/').collect();
  if segments.len() > MAX_DEPTH || segments.iter().any(|s| s.is_empty() || *s == "." || *s == "..") {
    return Err(bad());
  }
  Ok(name.to_owned())
}

/// `<root>/.kingu/artifacts`, created when `create`; refused when it resolves outside `root`
/// (a symlinked `.kingu` or `artifacts` must not make Kingu write elsewhere).
pub fn store_dir(root: &Path, create: bool) -> Result<PathBuf, String> {
  let dir = STORE.iter().fold(root.to_path_buf(), |p, s| p.join(s));
  if create {
    std::fs::create_dir_all(&dir).map_err(|e| tr!(ArtifactMsg::WriteFailed, path = dir.display(), detail = e))?;
  } else if !dir.exists() {
    return Ok(dir);
  }
  let real_root = root.canonicalize().map_err(|e| tr!(ArtifactMsg::ReadFailed, path = root.display(), detail = e))?;
  let real = dir.canonicalize().map_err(|e| tr!(ArtifactMsg::ReadFailed, path = dir.display(), detail = e))?;
  if real != real_root.join(STORE[0]).join(STORE[1]) {
    return Err(tr!(ArtifactMsg::StoreOutside));
  }
  Ok(dir)
}

pub fn artifact_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
  check_id(id)?;
  Ok(store_dir(root, false)?.join(id))
}

pub fn version_dir(root: &Path, id: &str, version: u32) -> Result<PathBuf, String> {
  Ok(artifact_dir(root, id)?.join(format!("v{version}")))
}

/// The artifact's metadata.
pub fn load(root: &Path, id: &str) -> Result<Meta, String> {
  let file = artifact_dir(root, id)?.join(META_FILE);
  let bytes = match std::fs::read(&file) {
    Ok(b) => b,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(tr!(ArtifactMsg::NotFound, id)),
    Err(e) => return Err(tr!(ArtifactMsg::ReadFailed, path = file.display(), detail = e)),
  };
  let meta: Meta = serde_json::from_slice(&bytes).map_err(|e| tr!(ArtifactMsg::Unreadable, id, detail = e))?;
  if meta.id != id || meta.versions.is_empty() {
    return Err(tr!(ArtifactMsg::Unreadable, id, detail = "id or versions"));
  }
  Ok(meta)
}

/// Every readable artifact of the project, the most recently updated first.
pub fn list(root: &Path) -> Result<Vec<Meta>, String> {
  let dir = store_dir(root, false)?;
  let Ok(entries) = std::fs::read_dir(&dir) else { return Ok(Vec::new()) };
  let mut out: Vec<Meta> = entries
    .flatten()
    .filter_map(|e| e.file_name().to_str().map(str::to_owned))
    .filter(|n| valid_id(n))
    .filter_map(|id| load(root, &id).map_err(|e| log::warn!("artifact {id}: {e}")).ok())
    .collect();
  out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| a.id.cmp(&b.id)));
  Ok(out)
}

fn save_meta(dir: &Path, meta: &Meta) -> Result<(), String> {
  let file = dir.join(META_FILE);
  let tmp = dir.join(format!("{META_FILE}.tmp-{}", std::process::id()));
  let json = serde_json::to_vec_pretty(meta).map_err(|e| e.to_string())?;
  std::fs::write(&tmp, json)
    .and_then(|()| std::fs::rename(&tmp, &file))
    .map_err(|e| {
      let _ = std::fs::remove_file(&tmp);
      tr!(ArtifactMsg::WriteFailed, path = file.display(), detail = e)
    })
}

/// What `artifact.publish` asks for (cli_server.rs checks the request's shape first).
#[derive(Debug, Clone, Default)]
pub struct Publish {
  pub title: Option<String>,
  pub description: Option<String>,
  /// The page: an .html or .md file.
  pub file: PathBuf,
  /// Assets: (source file, name inside the artifact).
  pub assets: Vec<(PathBuf, String)>,
  /// A new version of this artifact instead of a new one.
  pub id: Option<String>,
  pub source: String,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Published {
  pub id: String,
  pub version: u32,
  pub title: String,
  pub format: Format,
  pub root: String,
  /// The stored page.
  pub path: String,
}

/// A regular file (not a symlink) of at most `max` bytes: its size.
fn regular_file(path: &Path, max: u64) -> Result<u64, String> {
  let meta = std::fs::symlink_metadata(path).map_err(|e| tr!(ArtifactMsg::ReadFailed, path = path.display(), detail = e))?;
  if !meta.file_type().is_file() {
    return Err(tr!(ArtifactMsg::NotAFile, path = path.display()));
  }
  if meta.len() > max {
    return Err(tr!(ArtifactMsg::FileTooLarge, path = path.display(), max = max / (1024 * 1024)));
  }
  Ok(meta.len())
}

/// The page's own title: `<title>` of HTML, the first `# ` heading of Markdown.
pub fn title_in(text: &str, format: Format) -> Option<String> {
  let found = match format {
    Format::Html => {
      let lower = text.to_ascii_lowercase();
      let start = lower.find("<title")?;
      let open = start + lower[start..].find('>')? + 1;
      let end = open + lower[open..].find("</title")?;
      decode_entities(&text[open..end])
    }
    Format::Markdown => text.lines().map(str::trim).find_map(|l| l.strip_prefix("# ").map(str::to_owned))?,
  };
  let t = found.split_whitespace().collect::<Vec<_>>().join(" ");
  (!t.is_empty()).then(|| t.chars().take(MAX_TITLE).collect())
}

fn decode_entities(s: &str) -> String {
  s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&")
}

/// The title to store: given, else the page's own, else the file name without its extension.
fn resolve_title(given: Option<&str>, text: &str, format: Format, file: &Path) -> Result<String, String> {
  let given = given.map(|t| t.split_whitespace().collect::<Vec<_>>().join(" ")).filter(|t| !t.is_empty());
  let title = given
    .or_else(|| title_in(text, format))
    .or_else(|| file.file_stem().and_then(|s| s.to_str()).map(str::to_owned))
    .filter(|t| !t.is_empty())
    .ok_or_else(|| tr!(ArtifactMsg::TitleRequired))?;
  if title.chars().count() > MAX_TITLE {
    return Err(tr!(ArtifactMsg::TitleTooLong, max = MAX_TITLE));
  }
  Ok(title)
}

/// Serializes publishes in this process (a version number is taken once).
fn publish_lock() -> &'static Mutex<()> {
  static LOCK: Mutex<()> = Mutex::new(());
  &LOCK
}

/// Copies the page and its assets into a new version folder and records it. A new artifact
/// unless `p.id` names one of this project.
pub fn publish(root: &Path, p: &Publish) -> Result<Published, String> {
  let format = format_of(&p.file).ok_or_else(|| tr!(ArtifactMsg::BadEntry, path = p.file.display()))?;
  let entry_size = regular_file(&p.file, MAX_ENTRY_BYTES)?;
  let description = p.description.as_deref().map(str::trim).filter(|d| !d.is_empty()).map(str::to_owned);
  if description.as_ref().is_some_and(|d| d.chars().count() > MAX_DESCRIPTION) {
    return Err(tr!(ArtifactMsg::DescriptionTooLong, max = MAX_DESCRIPTION));
  }
  if p.assets.len() + 1 > MAX_FILES {
    return Err(tr!(ArtifactMsg::TooManyAssets, max = MAX_FILES));
  }
  let entry = format.entry();
  let mut names = std::collections::HashSet::from([entry.to_owned()]);
  let mut total = entry_size;
  let mut files = vec![FileEntry { path: entry.to_owned(), size: entry_size }];
  for (src, name) in &p.assets {
    let name = safe_name(name)?;
    if !names.insert(name.clone()) || names.iter().any(|n| n != &name && (name.starts_with(&format!("{n}/")) || n.starts_with(&format!("{name}/")))) {
      return Err(tr!(ArtifactMsg::DuplicateName, name));
    }
    let size = regular_file(src, MAX_ASSET_BYTES)?;
    total += size;
    if total > MAX_TOTAL_BYTES {
      return Err(tr!(ArtifactMsg::TotalTooLarge, max = MAX_TOTAL_BYTES / (1024 * 1024)));
    }
    files.push(FileEntry { path: name, size });
  }
  let text = std::fs::read(&p.file).map_err(|e| tr!(ArtifactMsg::ReadFailed, path = p.file.display(), detail = e))?;
  let text = String::from_utf8_lossy(&text);

  let _guard = publish_lock().lock().unwrap_or_else(|e| e.into_inner());
  let store = store_dir(root, true)?;
  // Kept out of git status before anything lands there (once per folder per run; publishes never run on the UI thread).
  crate::agent::worktree::exclude_kingu_logged(root);
  let now = now_ms();
  let (id, mut meta) = match &p.id {
    Some(id) => {
      check_id(id)?;
      let meta = load(root, id)?;
      if meta.latest().version >= MAX_VERSIONS {
        return Err(tr!(ArtifactMsg::TooManyVersions, id, max = MAX_VERSIONS));
      }
      (id.clone(), meta)
    }
    None => {
      let id = new_id()?;
      let title = resolve_title(p.title.as_deref(), &text, format, &p.file)?;
      (id.clone(), Meta { id, title, description: None, created_at: now, updated_at: now, versions: Vec::new(), shared: None })
    }
  };
  if p.id.is_some() && p.title.as_deref().is_some_and(|t| !t.trim().is_empty()) {
    meta.title = resolve_title(p.title.as_deref(), &text, format, &p.file)?;
  }
  if description.is_some() {
    meta.description = description;
  }
  let version = meta.versions.last().map_or(1, |v| v.version + 1);
  let dir = store.join(&id);
  let vdir = dir.join(format!("v{version}"));
  std::fs::create_dir_all(&dir).map_err(|e| tr!(ArtifactMsg::WriteFailed, path = dir.display(), detail = e))?;
  // `create_dir` fails when the folder exists: a version is written once.
  std::fs::create_dir(&vdir).map_err(|e| tr!(ArtifactMsg::WriteFailed, path = vdir.display(), detail = e))?;
  let copied = (|| {
    copy_into(&vdir, entry, &p.file)?;
    for (src, name) in &p.assets {
      copy_into(&vdir, name, src)?;
    }
    Ok::<(), String>(())
  })();
  if let Err(e) = copied {
    let _ = std::fs::remove_dir_all(&vdir);
    return Err(e);
  }
  meta.versions.push(Version { version, created_at: now, format, entry: entry.to_owned(), files, source: p.source.clone() });
  meta.updated_at = now;
  if let Err(e) = save_meta(&dir, &meta) {
    let _ = std::fs::remove_dir_all(&vdir);
    return Err(e);
  }
  log::info!("published artifact {id} v{version} ({})", p.source);
  Ok(Published { id, version, title: meta.title, format, root: root.display().to_string(), path: vdir.join(entry).display().to_string() })
}

/// Copies `src` to `<vdir>/<name>` (a new file; `name` was checked by [`safe_name`]).
fn copy_into(vdir: &Path, name: &str, src: &Path) -> Result<(), String> {
  let to = vdir.join(name);
  if let Some(parent) = to.parent() {
    std::fs::create_dir_all(parent).map_err(|e| tr!(ArtifactMsg::WriteFailed, path = parent.display(), detail = e))?;
  }
  let mut from = std::fs::File::open(src).map_err(|e| tr!(ArtifactMsg::ReadFailed, path = src.display(), detail = e))?;
  let mut out = std::fs::OpenOptions::new().write(true).create_new(true).open(&to).map_err(|e| tr!(ArtifactMsg::WriteFailed, path = to.display(), detail = e))?;
  std::io::copy(&mut from, &mut out).map_err(|e| tr!(ArtifactMsg::WriteFailed, path = to.display(), detail = e))?;
  Ok(())
}

/// A file of a stored version, read only when it is one the version lists and a regular file
/// inside the version folder.
pub fn read_file(root: &Path, id: &str, version: u32, name: &str) -> Result<Vec<u8>, String> {
  let meta = load(root, id)?;
  let v = meta.version(version).ok_or_else(|| tr!(ArtifactMsg::VersionNotFound, id, version))?;
  let name = safe_name(name)?;
  if !v.files.iter().any(|f| f.path == name) {
    return Err(tr!(ArtifactMsg::NotAFile, path = name));
  }
  let dir = version_dir(root, id, version)?;
  read_inside(&dir, &name)
}

/// `<dir>/<name>` when it is a regular file whose real path stays in `dir`.
pub fn read_inside(dir: &Path, name: &str) -> Result<Vec<u8>, String> {
  let path = dir.join(name);
  if path.components().any(|c| matches!(c, Component::ParentDir)) {
    return Err(tr!(ArtifactMsg::BadName, name));
  }
  regular_file(&path, MAX_ASSET_BYTES.max(MAX_ENTRY_BYTES))?;
  let real_dir = dir.canonicalize().map_err(|e| tr!(ArtifactMsg::ReadFailed, path = dir.display(), detail = e))?;
  let real = path.canonicalize().map_err(|e| tr!(ArtifactMsg::ReadFailed, path = path.display(), detail = e))?;
  if !real.starts_with(&real_dir) {
    return Err(tr!(ArtifactMsg::BadName, name));
  }
  std::fs::read(&real).map_err(|e| tr!(ArtifactMsg::ReadFailed, path = path.display(), detail = e))
}

/// Removes the artifact and all its versions.
pub fn delete(root: &Path, id: &str) -> Result<(), String> {
  load(root, id)?;
  let dir = artifact_dir(root, id)?;
  std::fs::remove_dir_all(&dir).map_err(|e| tr!(ArtifactMsg::WriteFailed, path = dir.display(), detail = e))?;
  log::info!("deleted artifact {id}");
  Ok(())
}

/// Records where a version was shared.
pub fn mark_shared(root: &Path, id: &str, shared: Shared) -> Result<Meta, String> {
  let _guard = publish_lock().lock().unwrap_or_else(|e| e.into_inner());
  let mut meta = load(root, id)?;
  meta.shared = Some(shared);
  save_meta(&artifact_dir(root, id)?, &meta)?;
  Ok(meta)
}

/// The project a publish from `cwd` goes to: the deepest open project (the open folder or an
/// added one) containing it, so a task worktree's agent publishes into its project. None when
/// `cwd` is in none of them (Kingu never writes into a folder the user did not open).
pub fn project_for(cwd: &Path, open: &[PathBuf]) -> Option<PathBuf> {
  let cwd = cwd.canonicalize().ok()?;
  open.iter().filter_map(|p| p.canonicalize().ok()).filter(|p| cwd.starts_with(p)).max_by_key(|p| p.components().count())
}

/// The open folder and the added projects.
pub fn open_projects(ws: &Workspace, projects: &Projects) -> Vec<PathBuf> {
  ws.current().into_iter().chain(projects.list().into_iter().map(|p| p.path)).collect()
}

pub fn notify_changed(app: &AppHandle, root: &str, id: &str) {
  let _ = app.emit(CHANGED_EVENT, serde_json::json!({ "root": root, "id": id }));
}

// ---------------------------------------------------------------------------------------------
// Commands

fn root_of(ws: &Workspace, projects: &Projects, root: Option<String>) -> Result<PathBuf, String> {
  root_arg(ws, projects, root)?.ok_or_else(|| tr!(crate::i18n::msg::CliMsg::NoFolder))
}

/// The project's artifacts (`root`: an added project; default the open folder).
#[tauri::command]
pub async fn artifacts_list(ws: State<'_, Workspace>, projects: State<'_, Projects>, root: Option<String>) -> Result<Vec<Meta>, String> {
  let root = root_of(&ws, &projects, root)?;
  crate::snap_install::blocking(move || list(&root)).await
}

#[tauri::command]
pub fn artifact_get(ws: State<'_, Workspace>, projects: State<'_, Projects>, root: Option<String>, id: String) -> Result<Meta, String> {
  load(&root_of(&ws, &projects, root)?, &id)
}

/// A version's page as text (Markdown is rendered by the webview before it is previewed).
#[tauri::command]
pub fn artifact_read_entry(ws: State<'_, Workspace>, projects: State<'_, Projects>, root: Option<String>, id: String, version: u32) -> Result<String, String> {
  let root = root_of(&ws, &projects, root)?;
  let meta = load(&root, &id)?;
  let v = meta.version(version).ok_or_else(|| tr!(ArtifactMsg::VersionNotFound, id, version))?;
  let bytes = read_file(&root, &id, version, &v.entry)?;
  Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
pub fn artifact_delete(app: AppHandle, ws: State<'_, Workspace>, projects: State<'_, Projects>, root: Option<String>, id: String) -> Result<(), String> {
  let root = root_of(&ws, &projects, root)?;
  delete(&root, &id)?;
  notify_changed(&app, &root.display().to_string(), &id);
  Ok(())
}

/// One self-contained HTML file of a version (assets inlined; `html`: the page to use instead of
/// the stored one, the webview's rendering of a Markdown page).
pub fn bundle_version(root: &Path, id: &str, version: u32, html: Option<String>) -> Result<(Meta, String), String> {
  let meta = load(root, id)?;
  let v = meta.version(version).ok_or_else(|| tr!(ArtifactMsg::VersionNotFound, id, version))?.clone();
  let dir = version_dir(root, id, version)?;
  let page = match html {
    Some(h) => h,
    None => String::from_utf8_lossy(&read_inside(&dir, &v.entry)?).into_owned(),
  };
  let listed: std::collections::HashSet<&str> = v.files.iter().map(|f| f.path.as_str()).collect();
  let out = bundle::bundle(&page, |name| if listed.contains(name) { read_inside(&dir, name).ok() } else { None });
  Ok((meta, out))
}

/// Export: the native save dialog, then the bundled page. The dialog runs here so the webview
/// never names the path. The path written, or None when the user cancelled.
#[tauri::command]
pub async fn artifact_export(app: AppHandle, ws: State<'_, Workspace>, projects: State<'_, Projects>, root: Option<String>, id: String, version: u32, html: Option<String>) -> Result<Option<String>, String> {
  use tauri_plugin_dialog::DialogExt;
  let root = root_of(&ws, &projects, root)?;
  let (meta, page) = crate::snap_install::blocking({
    let root = root.clone();
    move || bundle_version(&root, &id, version, html)
  })
  .await?;
  let name = format!("{}.html", export_name(&meta.title));
  let start = {
    use tauri::Manager;
    app.path().download_dir().or_else(|_| app.path().home_dir()).ok()
  };
  let picked = tauri::async_runtime::spawn_blocking(move || {
    let d = app.dialog().file().set_file_name(name).add_filter("HTML", &["html"]);
    let d = match start {
      Some(s) => d.set_directory(s),
      None => d,
    };
    d.blocking_save_file()
  })
  .await
  .map_err(|e| e.to_string())?;
  let Some(path) = picked.and_then(|p| p.into_path().ok()) else { return Ok(None) };
  std::fs::write(&path, page).map_err(|e| tr!(ArtifactMsg::WriteFailed, path = path.display(), detail = e))?;
  log::info!("exported an artifact to {}", path.display());
  Ok(Some(path.display().to_string()))
}

/// A file name from a title: letters, digits (any script), `-` and `_`; the rest become `-`.
pub fn export_name(title: &str) -> String {
  let mut out = String::new();
  for c in title.chars() {
    if c.is_alphanumeric() || c == '-' || c == '_' {
      out.push(c);
    } else if !out.ends_with('-') {
      out.push('-');
    }
  }
  let name: String = out.trim_matches('-').chars().take(80).collect();
  if name.is_empty() { "artifact".into() } else { name }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn write(dir: &Path, name: &str, text: &str) -> PathBuf {
    let p = dir.join(name);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(&p, text).unwrap();
    p
  }

  fn publish_simple(root: &Path, src: &Path, id: Option<String>) -> Result<Published, String> {
    let page = write(src, "report.html", "<html><head><title> Q3 &amp; sales </title></head><body><img src=\"img/a.png\"></body></html>");
    let img = write(src, "img/a.png", "PNG");
    publish(root, &Publish { file: page, assets: vec![(img, "img/a.png".into())], id, source: "cli".into(), ..Default::default() })
  }

  #[test]
  fn ids_and_names_are_safe() {
    let id = new_id().unwrap();
    assert!(valid_id(&id) && id.len() == 16);
    assert!(!valid_id("0123456789ABCDEF") && !valid_id("../../etc") && !valid_id("0123456789abcde"));
    for ok in ["a.png", "img/a.png", "fonts/x-y_z.woff2", "ภาพ/รูป.png", ".well-known/x"] {
      assert_eq!(safe_name(ok).unwrap(), ok);
    }
    for bad in ["", "/etc/passwd", "../x", "a/../../x", "a//b", "./a", "a/.", "a\\b", "c:x", "a\nb", &"x/".repeat(9), &"y".repeat(201)] {
      assert!(safe_name(bad).is_err(), "{bad:?}");
    }
    assert!(artifact_dir(Path::new("/p"), "../x").is_err());
    assert_eq!(format_of(Path::new("a.HTM")), Some(Format::Html));
    assert_eq!(format_of(Path::new("a.markdown")), Some(Format::Markdown));
    assert_eq!(format_of(Path::new("a.txt")), None);
  }

  #[test]
  fn publishes_versions_with_metadata() {
    let (root, src) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let first = publish_simple(root.path(), src.path(), None).unwrap();
    assert_eq!((first.version, first.title.as_str(), first.format), (1, "Q3 & sales", Format::Html));
    let meta = load(root.path(), &first.id).unwrap();
    let v = meta.latest();
    assert_eq!(v.entry, "index.html");
    assert_eq!(v.files.iter().map(|f| (f.path.as_str(), f.size)).collect::<Vec<_>>(), [("index.html", 91), ("img/a.png", 3)]);
    assert_eq!(read_file(root.path(), &first.id, 1, "img/a.png").unwrap(), b"PNG");
    assert!(Path::new(&first.path).ends_with(format!(".kingu/artifacts/{}/v1/index.html", first.id)));
    // A file the version does not list is never read, nor a path out of it.
    assert!(read_file(root.path(), &first.id, 1, "artifact.json").is_err());
    assert!(read_file(root.path(), &first.id, 1, "../artifact.json").is_err());

    // A second version keeps the first; a new title replaces the old.
    let md = write(src.path(), "notes.md", "# Notes\n\nhi");
    let second = publish(root.path(), &Publish { file: md, title: Some("Notes v2".into()), description: Some(" d ".into()), id: Some(first.id.clone()), source: "agent".into(), ..Default::default() }).unwrap();
    assert_eq!((second.id.as_str(), second.version, second.format), (first.id.as_str(), 2, Format::Markdown));
    let meta = load(root.path(), &first.id).unwrap();
    assert_eq!((meta.title.as_str(), meta.description.as_deref(), meta.versions.len()), ("Notes v2", Some("d"), 2));
    assert_eq!(meta.version(1).unwrap().format, Format::Html);
    assert_eq!(meta.latest().source, "agent");
    assert!(version_dir(root.path(), &first.id, 1).unwrap().join("index.html").is_file());

    let other = publish_simple(root.path(), src.path(), None).unwrap();
    assert_ne!(other.id, first.id);
    let listed: Vec<String> = list(root.path()).unwrap().into_iter().map(|m| m.id).collect();
    assert_eq!(listed.len(), 2);
    delete(root.path(), &first.id).unwrap();
    assert!(load(root.path(), &first.id).is_err());
    assert!(publish_simple(root.path(), src.path(), Some("ffffffffffffffff".into())).is_err());
  }

  #[test]
  fn refuses_bad_files_names_and_sizes() {
    let (root, src) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let page = write(src.path(), "p.html", "<p>x</p>");
    let txt = write(src.path(), "p.txt", "x");
    let base = Publish { file: page.clone(), source: "cli".into(), ..Default::default() };
    assert!(publish(root.path(), &Publish { file: txt, ..base.clone() }).is_err());
    assert!(publish(root.path(), &Publish { assets: vec![(page.clone(), "../evil".into())], ..base.clone() }).is_err());
    assert!(publish(root.path(), &Publish { assets: vec![(page.clone(), "index.html".into())], ..base.clone() }).is_err());
    assert!(publish(root.path(), &Publish { assets: vec![(page.clone(), "a".into()), (page.clone(), "a/b".into())], ..base.clone() }).is_err());
    assert!(publish(root.path(), &Publish { assets: vec![(src.path().to_path_buf(), "dir".into())], ..base.clone() }).is_err());
    assert!(publish(root.path(), &Publish { title: Some("ก".repeat(MAX_TITLE + 1)), ..base.clone() }).is_err());
    let big = src.path().join("big.html");
    std::fs::File::create(&big).unwrap().set_len(MAX_ENTRY_BYTES + 1).unwrap();
    assert!(publish(root.path(), &Publish { file: big, ..base.clone() }).is_err());
    // Nothing half-written was left behind.
    assert!(list(root.path()).unwrap().is_empty());
    // The file name is the title when the page has none.
    assert_eq!(publish(root.path(), &base).unwrap().title, "p");
  }

  #[cfg(unix)]
  #[test]
  fn never_follows_symlinks_out() {
    let (root, src, outside) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let secret = write(outside.path(), "secret", "s3cr3t");
    let link = src.path().join("link.png");
    std::os::unix::fs::symlink(&secret, &link).unwrap();
    let page = write(src.path(), "p.html", "<p>x</p>");
    assert!(publish(root.path(), &Publish { file: page.clone(), assets: vec![(link, "a.png".into())], source: "cli".into(), ..Default::default() }).is_err());
    // A store that points outside the project is refused.
    std::fs::create_dir_all(root.path().join(".kingu")).unwrap();
    std::os::unix::fs::symlink(outside.path(), root.path().join(".kingu/artifacts")).unwrap();
    assert!(publish(root.path(), &Publish { file: page, source: "cli".into(), ..Default::default() }).unwrap_err().contains("outside"));
    assert!(list(root.path()).is_err());
    // A symlink planted in a version folder is not read.
    let dir = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(&secret, dir.path().join("x.png")).unwrap();
    assert!(read_inside(dir.path(), "x.png").is_err());
  }

  #[test]
  fn stays_out_of_git_status() {
    let (root, src) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let git = |args: &[&str]| std::process::Command::new("git").args(args).current_dir(root.path()).output().unwrap();
    if !git(&["init", "-q"]).status.success() {
      return; // no git here
    }
    publish_simple(root.path(), src.path(), None).unwrap();
    let status = git(&["status", "--porcelain", "--untracked-files=all"]);
    assert_eq!(String::from_utf8_lossy(&status.stdout), "");
  }

  #[test]
  fn finds_the_project_of_a_folder() {
    let a = tempfile::tempdir().unwrap();
    let wt = a.path().join(".kingu/worktrees/fix");
    std::fs::create_dir_all(&wt).unwrap();
    let b = tempfile::tempdir().unwrap();
    let open = vec![b.path().to_path_buf(), a.path().to_path_buf()];
    assert_eq!(project_for(&wt, &open), Some(a.path().canonicalize().unwrap()));
    assert_eq!(project_for(a.path(), &open), Some(a.path().canonicalize().unwrap()));
    assert_eq!(project_for(Path::new("/"), &open), None);
    // A nested project wins over the one around it.
    let inner = a.path().join("apps/web");
    std::fs::create_dir_all(&inner).unwrap();
    assert_eq!(project_for(&inner.join("."), &[a.path().to_path_buf(), inner.clone()]), Some(inner.canonicalize().unwrap()));
  }

  #[test]
  fn titles_and_export_names() {
    assert_eq!(title_in("<TITLE>a\n b</TITLE>", Format::Html).as_deref(), Some("a b"));
    assert_eq!(title_in("<p>no</p>", Format::Html), None);
    assert_eq!(title_in("intro\n# รายงาน Q3\n## x", Format::Markdown).as_deref(), Some("รายงาน Q3"));
    assert_eq!(export_name("รายงาน: Q3/2026 (final)"), "รายงาน-Q3-2026-final");
    assert_eq!(export_name("../.."), "artifact");
  }
}
