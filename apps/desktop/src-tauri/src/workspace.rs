//! The workspace of each window (VS Code: IWorkspaceContextService, one per window) and the
//! recently opened folders (VS Code: IWorkspacesHistoryMainService).
//!
//! Every window has its own workspace: none, one folder, or several root folders (a multi-root
//! workspace, VS Code's `.code-workspace` `folders`). [`Workspaces`] keeps them by window label;
//! a command takes a [`Workspace`] argument, which Tauri fills with the calling window's
//! workspace (see the `CommandArg` impl), so the ~100 commands that resolve paths never look at
//! another window's folders.
//!
//! Paths from the webview: a relative path is inside the first root folder (the only one in a
//! single-folder window, so nothing changes there); a path inside another root folder is absolute.
//! [`Workspace::locate`] turns either into `(root, path relative to it)`, and
//! [`Workspace::qualify`] turns a root-relative result back into the webview's form.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use crate::i18n::msg::{FilesMsg, WorkspaceMsg};
use crate::search::Searches;
use crate::tr;
use crate::watcher::{FileWatcher, GitWatcher};

/// The label of the window Tauri creates from `tauri.conf.json`.
pub const MAIN_WINDOW: &str = "main";
/// Windows opened later are `window-1`, `window-2`, … (the capability lists `window-*`).
pub const WINDOW_PREFIX: &str = "window-";

/// One root folder of a workspace. `name` is the `.code-workspace` folder's `name`, else the
/// folder's own name; the Explorer shows it and Search's `./name/` picks the folder by it.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Folder {
  pub path: PathBuf,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub name: Option<String>,
}

impl Folder {
  pub fn new(path: PathBuf) -> Self {
    Self { path, name: None }
  }

  /// The name the workbench shows for the folder.
  pub fn label(&self) -> String {
    self.name.clone().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| self.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| self.path.display().to_string()))
  }
}

/// Where a window is on screen, in logical pixels (VS Code's IWindowUIState). `x`/`y`/`width`/
/// `height` are its normal bounds, kept while it is maximized or in full screen.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct WindowBounds {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
  #[serde(default, skip_serializing_if = "std::ops::Not::not")]
  pub maximized: bool,
  #[serde(default, skip_serializing_if = "std::ops::Not::not")]
  pub fullscreen: bool,
}

/// What a window has open: its folders, and the `.code-workspace` file they came from (`None`
/// for a single folder or an untitled multi-root workspace); and where the window was.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct WindowSession {
  #[serde(default)]
  pub folders: Vec<Folder>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub file: Option<PathBuf>,
  /// An untitled multi-root workspace's id (Duplicate Workspace, Add Folder to a single folder):
  /// it keeps the window's terminals and backups apart from another window on the same folders.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub untitled: Option<String>,
  /// An empty window's id (VS Code's empty workspace id): its page keeps its own layout and
  /// terminals under it, so a new empty window starts from the defaults and a restored one comes
  /// back as it was. `None` while the window has folders.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub empty: Option<String>,
  /// The window's place on screen (restored with it; `window.newWindowDimensions` for a new one).
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub bounds: Option<WindowBounds>,
}

impl WindowSession {
  /// The workspace's identity (VS Code's workspace id): the workspace file, an untitled
  /// workspace's id, or the single folder. `None` for an empty window.
  pub fn identity(&self) -> Option<String> {
    if let Some(f) = &self.file {
      return Some(f.display().to_string());
    }
    if let Some(u) = &self.untitled {
      return Some(format!("untitled:{u}"));
    }
    self.folders.first().map(|f| f.path.display().to_string())
  }

  /// What the window's own state (backups, the page's workspace storage) is kept under: the
  /// identity, else `empty:<id>` for an empty window (the page's workspaceStateKey).
  pub fn storage_key(&self) -> Option<String> {
    self.identity().or_else(|| self.empty.as_ref().map(|e| format!("empty:{e}")))
  }
}

/// One window's workspace and the per-window services that follow it.
#[derive(Default)]
pub struct WindowState {
  session: RwLock<WindowSession>,
  /// Find in Files, the ADE's Files › Contents and the Search Editor: one ripgrep slot each per window.
  pub searches: Arc<Searches>,
  pub worktree_searches: Arc<Searches>,
  pub editor_searches: Arc<Searches>,
  /// One file watcher per root folder.
  watchers: Mutex<Vec<(PathBuf, FileWatcher)>>,
  /// The first folder's repository (branches and worktrees for the ADE).
  pub git: GitWatcher,
  /// `files.watcherExclude` / `files.watcherInclude` as the window last set them.
  watch_exclude: Mutex<Vec<String>>,
  watch_include: Mutex<Vec<String>>,
  /// Files to open once the window's page has loaded (Open File with `window.openFilesInNewWindow`).
  pending_files: Mutex<Vec<String>>,
}

/// The calling window's workspace, as a command argument (`ws: Workspace`).
#[derive(Clone)]
pub struct Workspace {
  label: String,
  state: Arc<WindowState>,
}

impl<'de, R: tauri::Runtime> tauri::ipc::CommandArg<'de, R> for Workspace {
  fn from_command(command: tauri::ipc::CommandItem<'de, R>) -> Result<Self, tauri::ipc::InvokeError> {
    use tauri::Manager;
    let webview = command.message.webview_ref();
    Ok(webview.state::<Workspaces>().get(webview.label()))
  }
}

fn read<T: Clone>(lock: &RwLock<T>) -> T {
  lock.read().unwrap_or_else(|e| e.into_inner()).clone()
}

impl Workspace {
  /// A workspace outside any window (tests).
  #[cfg(test)]
  pub fn new(root: Option<PathBuf>) -> Self {
    let ws = Self { label: MAIN_WINDOW.into(), state: Arc::default() };
    ws.set_session(WindowSession { folders: root.into_iter().map(Folder::new).collect(), ..Default::default() });
    ws
  }

  /// The window this workspace belongs to.
  pub fn label(&self) -> &str {
    &self.label
  }

  pub fn state(&self) -> &Arc<WindowState> {
    &self.state
  }

  pub fn session(&self) -> WindowSession {
    read(&self.state.session)
  }

  pub fn set_session(&self, session: WindowSession) {
    *self.state.session.write().unwrap_or_else(|e| e.into_inner()) = session;
  }

  /// The window moved or was resized: its bounds change, its workspace does not.
  pub fn set_bounds(&self, bounds: WindowBounds) {
    self.state.session.write().unwrap_or_else(|e| e.into_inner()).bounds = Some(bounds);
  }

  /// The root folders, first one first.
  pub fn folders(&self) -> Vec<Folder> {
    self.session().folders
  }

  pub fn roots(&self) -> Vec<PathBuf> {
    self.folders().into_iter().map(|f| f.path).collect()
  }

  /// The first root folder, `None` when no folder is open (the Explorer shows its welcome view).
  /// Everything that works on "the folder" (git, tasks, the ADE, language servers) uses it.
  pub fn current(&self) -> Option<PathBuf> {
    self.state.session.read().unwrap_or_else(|e| e.into_inner()).folders.first().map(|f| f.path.clone())
  }

  /// The first root folder, or an error for commands that need a folder.
  pub fn root(&self) -> Result<PathBuf, String> {
    self.current().ok_or_else(|| tr!(FilesMsg::NoFolder))
  }

  /// See [`WindowSession::storage_key`].
  pub fn storage_key(&self) -> Option<String> {
    self.session().storage_key()
  }

  /// The root folder a webview path belongs to and the path relative to it (see the module docs).
  pub fn locate(&self, path: &str) -> Result<(PathBuf, String), String> {
    locate_in(&self.roots(), path)
  }

  /// `rel` (inside `root`) the way the webview names it: as is in the first folder, absolute in another.
  pub fn qualify(&self, root: &Path, rel: &str) -> String {
    qualify_in(&self.roots(), root, rel)
  }

  /// Resolves a webview path to an existing file or folder inside its root folder.
  pub fn resolve(&self, path: &str) -> Result<PathBuf, String> {
    let (root, rel) = self.locate(path)?;
    if rel.is_empty() {
      return Ok(root);
    }
    resolve_in(&root, &rel)
  }

  /// Files this window should open once its page is up (each handed out once).
  pub fn take_pending_files(&self) -> Vec<String> {
    std::mem::take(&mut *self.state.pending_files.lock().unwrap_or_else(|e| e.into_inner()))
  }

  pub fn set_pending_files(&self, files: Vec<String>) {
    *self.state.pending_files.lock().unwrap_or_else(|e| e.into_inner()) = files;
  }

  /// Replaces the file watchers with one per root folder (a root already watched keeps its
  /// watcher); `emit(root)` makes the batch callback of a new one. Errors are logged: a folder
  /// that cannot be watched still opens.
  pub fn rewatch<E>(&self, emit: impl Fn(&Path) -> E)
  where
    E: Fn(Vec<String>) + Send + 'static,
  {
    let roots = self.roots();
    let mut watchers = self.state.watchers.lock().unwrap_or_else(|e| e.into_inner());
    let mut old: Vec<(PathBuf, FileWatcher)> = std::mem::take(&mut *watchers);
    let exclude = self.state.watch_exclude.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let include = self.state.watch_include.lock().unwrap_or_else(|e| e.into_inner()).clone();
    for root in roots {
      if let Some(i) = old.iter().position(|(r, _)| *r == root) {
        watchers.push(old.swap_remove(i));
        continue;
      }
      let w = FileWatcher::default();
      w.set_exclude(&exclude);
      w.set_include(&include);
      if let Err(e) = w.watch(Some(&root), emit(&root)) {
        log::error!("{e}");
      }
      watchers.push((root, w));
    }
    // Dropping a watcher ends its debounce thread.
    drop(old);
  }

  /// `files.watcherExclude` for every root folder's watcher.
  pub fn set_watch_exclude(&self, globs: &[String]) {
    *self.state.watch_exclude.lock().unwrap_or_else(|e| e.into_inner()) = globs.to_vec();
    for (_, w) in self.state.watchers.lock().unwrap_or_else(|e| e.into_inner()).iter() {
      w.set_exclude(globs);
    }
  }

  /// `files.watcherInclude` for every root folder's watcher.
  pub fn set_watch_include(&self, paths: &[String]) {
    *self.state.watch_include.lock().unwrap_or_else(|e| e.into_inner()) = paths.to_vec();
    for (_, w) in self.state.watchers.lock().unwrap_or_else(|e| e.into_inner()).iter() {
      w.set_include(paths);
    }
  }

  /// Stops this window's searches and watchers (the window closed).
  pub fn shut_down(&self) {
    self.state.searches.cancel();
    self.state.worktree_searches.cancel();
    self.state.editor_searches.cancel();
    self.state.watchers.lock().unwrap_or_else(|e| e.into_inner()).clear();
    let _ = self.state.git.watch(None, || {});
  }
}

/// See [`Workspace::locate`]. The longest matching root wins (a root folder nested in another).
pub fn locate_in(roots: &[PathBuf], path: &str) -> Result<(PathBuf, String), String> {
  let primary = roots.first().ok_or_else(|| tr!(FilesMsg::NoFolder))?;
  let p = Path::new(path);
  if !p.is_absolute() {
    return Ok((primary.clone(), path.to_string()));
  }
  roots
    .iter()
    .filter(|r| p.starts_with(r))
    .max_by_key(|r| r.as_os_str().len())
    .map(|r| (r.clone(), rel_string(p.strip_prefix(r).unwrap_or(Path::new("")))))
    .ok_or_else(|| tr!(FilesMsg::OutsideWorkspace, path = path))
}

/// See [`Workspace::qualify`].
pub fn qualify_in(roots: &[PathBuf], root: &Path, rel: &str) -> String {
  if roots.first().is_some_and(|p| p == root) {
    return rel.to_string();
  }
  if rel.is_empty() { root.display().to_string() } else { root.join(rel).display().to_string() }
}

fn rel_string(p: &Path) -> String {
  p.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/")
}

/// Every window's workspace, by window label.
#[derive(Default)]
pub struct Workspaces {
  windows: RwLock<HashMap<String, Arc<WindowState>>>,
  /// Windows in the order they were last focused, most recent last.
  focus: Mutex<Vec<String>>,
  /// Closed windows: a late call from a closing page must not bring its workspace back.
  closed: Mutex<std::collections::HashSet<String>>,
  next: AtomicU32,
}

impl Workspaces {
  /// The workspace of window `label` (an empty one the first time; a closed window's is a
  /// throwaway that is not kept).
  pub fn get(&self, label: &str) -> Workspace {
    if let Some(state) = self.windows.read().unwrap_or_else(|e| e.into_inner()).get(label) {
      return Workspace { label: label.into(), state: state.clone() };
    }
    if self.closed.lock().unwrap_or_else(|e| e.into_inner()).contains(label) {
      return Workspace { label: label.into(), state: Arc::default() };
    }
    let mut windows = self.windows.write().unwrap_or_else(|e| e.into_inner());
    let state = windows.entry(label.into()).or_default().clone();
    Workspace { label: label.into(), state }
  }

  /// Forgets a closed window; its workspace is handed back to be shut down.
  pub fn remove(&self, label: &str) -> Option<Workspace> {
    self.focus.lock().unwrap_or_else(|e| e.into_inner()).retain(|l| l != label);
    self.closed.lock().unwrap_or_else(|e| e.into_inner()).insert(label.into());
    self.windows.write().unwrap_or_else(|e| e.into_inner()).remove(label).map(|state| Workspace { label: label.into(), state })
  }

  pub fn labels(&self) -> Vec<String> {
    let mut labels: Vec<String> = self.windows.read().unwrap_or_else(|e| e.into_inner()).keys().cloned().collect();
    labels.sort_by_key(|l| (l != MAIN_WINDOW, l.strip_prefix(WINDOW_PREFIX).and_then(|n| n.parse::<u32>().ok()), l.clone()));
    labels
  }

  pub fn all(&self) -> Vec<Workspace> {
    self.labels().into_iter().map(|l| self.get(&l)).collect()
  }

  /// A label for a new window.
  pub fn next_label(&self) -> String {
    format!("{WINDOW_PREFIX}{}", self.next.fetch_add(1, Ordering::Relaxed) + 1)
  }

  pub fn focused(&self, label: &str) {
    let mut focus = self.focus.lock().unwrap_or_else(|e| e.into_inner());
    focus.retain(|l| l != label);
    focus.push(label.into());
  }

  /// The window focused last (VS Code's "last active window"), else the main one, else any.
  pub fn last_active(&self) -> Option<Workspace> {
    let known = self.labels();
    let focus = self.focus.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let label = focus.iter().rev().find(|l| known.contains(l)).cloned().or_else(|| known.iter().find(|l| *l == MAIN_WINDOW).cloned()).or_else(|| known.first().cloned())?;
    Some(self.get(&label))
  }

  /// Windows by focus order, least recent first (how `window.restoreWindows` reopens them).
  pub fn by_focus(&self) -> Vec<Workspace> {
    let focus = self.focus.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let mut all = self.all();
    all.sort_by_key(|w| focus.iter().position(|l| l == w.label()).map_or(-1, |i| i as i64));
    all
  }

  /// The window whose workspace is exactly `folders` (Open Folder focuses it instead of opening
  /// the folder twice, like VS Code). An untitled or file workspace only matches by its file.
  pub fn window_with(&self, folders: &[PathBuf], file: Option<&Path>) -> Option<String> {
    self.all().into_iter().find(|w| {
      let s = w.session();
      match file {
        Some(f) => s.file.as_deref() == Some(f),
        None => s.file.is_none() && s.untitled.is_none() && !folders.is_empty() && s.folders.iter().map(|f| &f.path).eq(folders.iter()),
      }
    }).map(|w| w.label)
  }

  /// The window to hand a request from outside (the `kingu` CLI, a notification): the last
  /// active window whose folders hold `cwd`, else the last active one.
  pub fn for_path(&self, cwd: Option<&Path>) -> Option<Workspace> {
    if let Some(cwd) = cwd {
      let focus = self.focus.lock().unwrap_or_else(|e| e.into_inner()).clone();
      let mut holding: Vec<Workspace> = self.all().into_iter().filter(|w| w.roots().iter().any(|r| cwd.starts_with(r))).collect();
      holding.sort_by_key(|w| focus.iter().position(|l| l == w.label()).map_or(-1, |i| i as i64));
      if let Some(w) = holding.pop() {
        return Some(w);
      }
    }
    self.last_active()
  }
}

pub fn canonical_dir(dir: &Path) -> Result<PathBuf, String> {
  let root = dir.canonicalize().map_err(|e| format!("{}: {e}", dir.display()))?;
  if !root.is_dir() {
    return Err(tr!(FilesMsg::NotAFolder, path = dir.display()));
  }
  Ok(root)
}

/// Resolves `rel` inside `root`, rejecting anything that escapes it (`..`, symlinks out).
/// The path must exist.
pub fn resolve_in(root: &Path, rel: &str) -> Result<PathBuf, String> {
  let path = root.join(rel).canonicalize().map_err(|e| format!("{rel}: {e}"))?;
  if !path.starts_with(root) {
    return Err(tr!(FilesMsg::OutsideWorkspace, path = rel));
  }
  Ok(path)
}

/// The folder to open at startup: the last one if it still exists, else `KINGU_WORKSPACE`,
/// else none (welcome view).
pub fn startup_root(last: Option<&Path>, env: Option<OsString>) -> Option<PathBuf> {
  last
    .map(Path::to_path_buf)
    .into_iter()
    .chain(env.map(PathBuf::from))
    .find_map(|p| canonical_dir(&p).ok())
}

/// A saved window's folders as they open now: missing ones are left out (VS Code keeps them
/// greyed out; a window with none left opens empty). Each is canonicalized.
pub fn existing_folders(folders: &[Folder]) -> Vec<Folder> {
  let mut out: Vec<Folder> = Vec::new();
  for f in folders {
    if let Ok(path) = canonical_dir(&f.path)
      && !out.iter().any(|o| o.path == path)
    {
      out.push(Folder { path, name: f.name.clone() });
    }
  }
  out
}

/// Adds `add` (canonicalized, deduplicated) after the folders already open.
pub fn with_added(folders: &[Folder], add: &[PathBuf]) -> Result<Vec<Folder>, String> {
  let mut out = folders.to_vec();
  for p in add {
    let path = canonical_dir(p)?;
    if !out.iter().any(|f| f.path == path) {
      out.push(Folder::new(path));
    }
  }
  Ok(out)
}

/// Removes `remove` (a root folder's path) from the folders.
pub fn without(folders: &[Folder], remove: &Path) -> Result<Vec<Folder>, String> {
  if !folders.iter().any(|f| f.path == remove) {
    return Err(tr!(WorkspaceMsg::NotARootFolder, path = remove.display()));
  }
  Ok(folders.iter().filter(|f| f.path != remove).cloned().collect())
}

/// `window.restoreWindows`: which of the last session's windows open at startup, in the order
/// they open (the last active one last, so it ends up in front). `one` and unknown values keep
/// only the last active window; `folders` leaves out empty windows; `none` opens none.
pub fn windows_to_restore(setting: Option<&str>, windows: &[WindowSession]) -> Vec<WindowSession> {
  match setting.unwrap_or("all") {
    "none" => Vec::new(),
    "all" | "preserve" => windows.to_vec(),
    "folders" => windows.iter().filter(|w| !w.folders.is_empty()).cloned().collect(),
    _ => windows.last().cloned().into_iter().collect(),
  }
}

/// Workspace storage keys (the page's per-workspace state, see `storage_key`) no window can show
/// again, so their state can go (VS Code's unused workspace storage cleanup): an empty window or
/// an untitled workspace that no open window and no window to restore has (`live`), a folder or
/// workspace file that no longer exists. Anything else is kept.
pub fn stale_scopes(scopes: &[String], live: &std::collections::HashSet<String>, exists: impl Fn(&Path) -> bool) -> Vec<String> {
  scopes
    .iter()
    .filter(|s| !live.contains(*s))
    .filter(|s| if s.starts_with("empty:") || s.starts_with("untitled:") { true } else { s.starts_with('/') && !exists(Path::new(s.as_str())) })
    .cloned()
    .collect()
}

// ---------------------------------------------------------------------------------------------
// Recently opened folders and the last session's windows

/// VS Code keeps more, but the quick pick only needs a screenful.
pub const MAX_RECENT: usize = 20;

#[derive(serde::Serialize, serde::Deserialize, Default, Debug, Clone, PartialEq)]
pub struct RecentData {
  /// Most recent first.
  #[serde(default)]
  pub folders: Vec<PathBuf>,
  /// The folder open when the app last ran; `None` after "Close Folder". Kept for builds that
  /// only know one window; `windows` supersedes it.
  #[serde(default)]
  pub last: Option<PathBuf>,
  /// The windows open when the app last ran, the last active one last (`window.restoreWindows`).
  /// `None` in a file from a build before multiple windows: `last` is the one window then.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub windows: Option<Vec<WindowSession>>,
}

impl RecentData {
  /// The last session's windows, from `windows` or (older file) `last`.
  pub fn sessions(&self) -> Vec<WindowSession> {
    match &self.windows {
      Some(w) => w.clone(),
      None => self.last.iter().map(|p| WindowSession { folders: vec![Folder::new(p.clone())], ..Default::default() }).collect(),
    }
  }
}

/// `recent.json` in the app data directory. A missing or corrupt file reads as empty;
/// writes go through a temporary file so a crash never leaves half a file. Every window shares
/// it (one process), so all access goes through the mutex.
pub struct Recent {
  file: PathBuf,
  data: Mutex<RecentData>,
}

impl Recent {
  pub fn load(file: PathBuf) -> Self {
    let data = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    Self { file, data: Mutex::new(data) }
  }

  pub fn data(&self) -> RecentData {
    self.data.lock().unwrap_or_else(|e| e.into_inner()).clone()
  }

  /// Moves `dir` to the front and remembers it as the folder to reopen.
  pub fn opened(&self, dir: &Path) -> Result<(), String> {
    self.update(|d| {
      d.folders.retain(|f| f != dir);
      d.folders.insert(0, dir.to_path_buf());
      d.folders.truncate(MAX_RECENT);
      d.last = Some(dir.to_path_buf());
    })
  }

  pub fn closed(&self) -> Result<(), String> {
    self.update(|d| d.last = None)
  }

  pub fn remove(&self, dir: &Path) -> Result<(), String> {
    self.update(|d| d.folders.retain(|f| f != dir))
  }

  pub fn clear(&self) -> Result<(), String> {
    self.update(|d| d.folders.clear())
  }

  /// The open windows, to restore at the next start (least recently active first). `last`
  /// follows the last active window, for an older build.
  pub fn set_windows(&self, windows: Vec<WindowSession>) -> Result<(), String> {
    self.update(|d| {
      d.last = windows.last().and_then(|w| w.folders.first()).map(|f| f.path.clone());
      d.windows = Some(windows);
    })
  }

  fn update(&self, f: impl FnOnce(&mut RecentData)) -> Result<(), String> {
    let mut data = self.data.lock().unwrap_or_else(|e| e.into_inner());
    let before = data.clone();
    f(&mut data);
    if *data == before && self.file.exists() {
      return Ok(());
    }
    let json = serde_json::to_vec_pretty(&*data).map_err(|e| e.to_string())?;
    if let Some(dir) = self.file.parent() {
      std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let tmp = self.file.with_extension("json.tmp");
    std::fs::write(&tmp, json).and_then(|_| std::fs::rename(&tmp, &self.file)).map_err(|e| format!("{}: {e}", self.file.display()))
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn rejects_paths_outside_the_workspace() {
    let ws = Workspace::new(Some(std::env::current_dir().unwrap().canonicalize().unwrap()));
    assert!(ws.resolve("Cargo.toml").is_ok());
    // Enough `..` to reach `/` however deep the checkout is (e.g. inside a git worktree).
    let escape = format!("{}etc/hosts", "../".repeat(64));
    assert!(ws.resolve(&escape).unwrap_err().contains("outside"));
    assert!(ws.resolve("/etc/hosts").unwrap_err().contains("outside"));
  }

  #[test]
  fn switching_the_root_moves_every_resolve() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    std::fs::write(a.path().join("only-a.txt"), "").unwrap();
    std::fs::write(b.path().join("only-b.txt"), "").unwrap();
    let ws = Workspace::new(None);
    assert_eq!(ws.root().unwrap_err(), tr!(FilesMsg::NoFolder));
    assert!(ws.resolve("only-a.txt").is_err());

    let root_a = canonical_dir(a.path()).unwrap();
    ws.set_session(WindowSession { folders: vec![Folder::new(root_a.clone())], ..Default::default() });
    assert!(ws.resolve("only-a.txt").is_ok());

    ws.set_session(WindowSession { folders: vec![Folder::new(canonical_dir(b.path()).unwrap())], ..Default::default() });
    assert!(ws.resolve("only-a.txt").is_err());
    assert!(ws.resolve("only-b.txt").unwrap().starts_with(b.path().canonicalize().unwrap()));
    // The old root is now outside the workspace.
    assert!(ws.resolve(root_a.join("only-a.txt").to_str().unwrap()).is_err());

    ws.set_session(WindowSession::default());
    assert!(ws.current().is_none());
    assert!(ws.resolve("only-b.txt").is_err());
  }

  #[test]
  fn multi_root_paths_locate_and_qualify() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (ra, rb) = (canonical_dir(a.path()).unwrap(), canonical_dir(b.path()).unwrap());
    std::fs::create_dir(rb.join("src")).unwrap();
    std::fs::write(rb.join("src/b.ts"), "").unwrap();
    std::fs::write(ra.join("a.ts"), "").unwrap();
    let ws = Workspace::new(None);
    ws.set_session(WindowSession { folders: vec![Folder::new(ra.clone()), Folder { path: rb.clone(), name: Some("Lib".into()) }], ..Default::default() });
    // Relative: the first folder, as in a single-folder window.
    assert_eq!(ws.locate("a.ts").unwrap(), (ra.clone(), "a.ts".to_string()));
    let b_file = rb.join("src/b.ts").display().to_string();
    assert_eq!(ws.locate(&b_file).unwrap(), (rb.clone(), "src/b.ts".to_string()));
    assert_eq!(ws.locate(&rb.display().to_string()).unwrap(), (rb.clone(), String::new()));
    assert!(ws.resolve(&b_file).is_ok());
    assert!(ws.resolve(&rb.display().to_string()).is_ok());
    // An absolute path in the first folder is that folder's.
    assert_eq!(ws.locate(&ra.join("a.ts").display().to_string()).unwrap(), (ra.clone(), "a.ts".to_string()));
    assert_eq!(ws.qualify(&ra, "x/y.ts"), "x/y.ts");
    assert_eq!(ws.qualify(&rb, "src/b.ts"), b_file);
    assert_eq!(ws.qualify(&rb, ""), rb.display().to_string());
    assert_eq!(ws.folders()[1].label(), "Lib");
    // Escaping a secondary root is still refused.
    assert!(ws.resolve(&format!("{}/../{}", rb.display(), ra.file_name().unwrap().to_string_lossy())).is_err());
  }

  #[test]
  fn nested_roots_pick_the_innermost() {
    let roots = [PathBuf::from("/w"), PathBuf::from("/w/pkg")];
    assert_eq!(locate_in(&roots, "/w/pkg/a.ts").unwrap(), (PathBuf::from("/w/pkg"), "a.ts".into()));
    assert_eq!(locate_in(&roots, "/w/b.ts").unwrap(), (PathBuf::from("/w"), "b.ts".into()));
    assert!(locate_in(&[], "a").is_err());
  }

  #[test]
  fn adding_and_removing_folders() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let ra = canonical_dir(a.path()).unwrap();
    let rb = canonical_dir(b.path()).unwrap();
    let one = vec![Folder::new(ra.clone())];
    let two = with_added(&one, &[b.path().to_path_buf(), a.path().to_path_buf()]).unwrap();
    assert_eq!(two.iter().map(|f| f.path.clone()).collect::<Vec<_>>(), [ra.clone(), rb.clone()]);
    assert!(with_added(&one, &[a.path().join("missing")]).is_err());
    assert_eq!(without(&two, &ra).unwrap(), [Folder::new(rb.clone())]);
    assert!(without(&two, Path::new("/nope")).is_err());
    let gone = a.path().join("gone");
    assert_eq!(existing_folders(&[Folder::new(gone), Folder { path: rb.clone(), name: Some("B".into()) }, Folder::new(rb.clone())]), [Folder { path: rb, name: Some("B".into()) }]);
  }

  #[test]
  fn registry_keeps_a_workspace_per_window() {
    let tmp = tempfile::tempdir().unwrap();
    let root = canonical_dir(tmp.path()).unwrap();
    let all = Workspaces::default();
    let main = all.get(MAIN_WINDOW);
    let label = all.next_label();
    assert_eq!(label, "window-1");
    let other = all.get(&label);
    main.set_session(WindowSession { folders: vec![Folder::new(root.clone())], ..Default::default() });
    assert_eq!(all.get(MAIN_WINDOW).current(), Some(root.clone()));
    assert_eq!(other.current(), None);
    assert_eq!(all.labels(), ["main", "window-1"]);
    assert_eq!(all.window_with(std::slice::from_ref(&root), None).as_deref(), Some("main"));
    assert_eq!(all.window_with(&[PathBuf::from("/elsewhere")], None), None);
    // Last active: focus order, else main.
    assert_eq!(all.last_active().unwrap().label(), "main");
    all.focused("window-1");
    assert_eq!(all.last_active().unwrap().label(), "window-1");
    assert_eq!(all.for_path(Some(&root.join("src"))).unwrap().label(), "main");
    assert_eq!(all.for_path(Some(Path::new("/x"))).unwrap().label(), "window-1");
    assert_eq!(all.by_focus().iter().map(|w| w.label().to_string()).collect::<Vec<_>>(), ["main", "window-1"]);
    all.focused("main");
    assert_eq!(all.by_focus().iter().map(|w| w.label().to_string()).collect::<Vec<_>>(), ["window-1", "main"]);
    assert!(all.remove("window-1").is_some());
    assert_eq!(all.labels(), ["main"]);
    // A late call from the closed window does not bring it back.
    assert_eq!(all.get("window-1").current(), None);
    assert_eq!(all.labels(), ["main"]);
    assert_eq!(all.last_active().unwrap().label(), "main");
  }

  #[test]
  fn identity_follows_file_then_untitled_then_folder() {
    let mut s = WindowSession { folders: vec![Folder::new("/a".into())], ..Default::default() };
    assert_eq!(s.identity().as_deref(), Some("/a"));
    s.untitled = Some("7f".into());
    assert_eq!(s.identity().as_deref(), Some("untitled:7f"));
    s.file = Some("/w/x.code-workspace".into());
    assert_eq!(s.identity().as_deref(), Some("/w/x.code-workspace"));
    assert_eq!(WindowSession::default().identity(), None);
    // An empty window's own state: under its id.
    assert_eq!(WindowSession { empty: Some("e1".into()), ..Default::default() }.storage_key().as_deref(), Some("empty:e1"));
    assert_eq!(WindowSession::default().storage_key(), None);
    assert_eq!(s.storage_key(), s.identity());
  }

  #[test]
  fn restore_windows_setting() {
    let w = |p: &str| WindowSession { folders: if p.is_empty() { vec![] } else { vec![Folder::new(p.into())] }, ..Default::default() };
    let all = [w("/a"), w(""), w("/c")];
    assert_eq!(windows_to_restore(None, &all), all);
    assert_eq!(windows_to_restore(Some("preserve"), &all), all);
    assert_eq!(windows_to_restore(Some("folders"), &all), [w("/a"), w("/c")]);
    assert_eq!(windows_to_restore(Some("one"), &all), [w("/c")]);
    assert_eq!(windows_to_restore(Some("none"), &all), []);
    assert_eq!(windows_to_restore(Some("one"), &[]), []);
  }

  #[test]
  fn stale_workspace_storage() {
    let here = tempfile::tempdir().unwrap();
    let dir = here.path().display().to_string();
    let live: std::collections::HashSet<String> = ["empty:e1".to_string(), "untitled:u1".into(), "/gone/but/open".into()].into();
    let scopes: Vec<String> = ["empty:e1", "empty:e2", "untitled:u1", "untitled:u2", &dir, "/no/such/folder", "/gone/but/open", "C:weird"].map(String::from).into();
    assert_eq!(stale_scopes(&scopes, &live, Path::exists), ["empty:e2", "untitled:u2", "/no/such/folder"]);
  }

  #[test]
  fn startup_prefers_last_then_env() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let gone = a.path().join("gone");
    let canon = |p: &Path| p.canonicalize().unwrap();
    assert_eq!(startup_root(Some(a.path()), Some(b.path().into())), Some(canon(a.path())));
    assert_eq!(startup_root(Some(&gone), Some(b.path().into())), Some(canon(b.path())));
    assert_eq!(startup_root(None, Some(gone.clone().into())), None);
    assert_eq!(startup_root(None, None), None);
  }

  #[test]
  fn recent_folders_are_most_recent_first_deduped_and_capped() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("data/recent.json");
    let recent = Recent::load(file.clone());
    assert_eq!(recent.data(), RecentData::default());

    for i in 0..MAX_RECENT + 5 {
      recent.opened(Path::new(&format!("/p/{i}"))).unwrap();
    }
    recent.opened(Path::new("/p/10")).unwrap();
    let d = recent.data();
    assert_eq!(d.folders.len(), MAX_RECENT);
    assert_eq!(d.folders[0], Path::new("/p/10"));
    assert_eq!(d.folders.iter().filter(|f| *f == Path::new("/p/10")).count(), 1);
    assert_eq!(d.last.as_deref(), Some(Path::new("/p/10")));

    recent.remove(Path::new("/p/10")).unwrap();
    recent.closed().unwrap();
    // Survives a restart.
    let again = Recent::load(file.clone()).data();
    assert_eq!(again, recent.data());
    assert!(!again.folders.contains(&PathBuf::from("/p/10")));
    assert_eq!(again.last, None);

    recent.clear().unwrap();
    assert!(Recent::load(file).data().folders.is_empty());
  }

  #[test]
  fn windows_of_the_last_session_survive_a_restart() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("recent.json");
    // A file from a one-window build: `last` is that window.
    std::fs::write(&file, r#"{"folders":["/a"],"last":"/a"}"#).unwrap();
    let recent = Recent::load(file.clone());
    assert_eq!(recent.data().sessions(), [WindowSession { folders: vec![Folder::new("/a".into())], ..Default::default() }]);
    let two = vec![
      WindowSession { folders: vec![Folder::new("/a".into()), Folder { path: "/b".into(), name: Some("B".into()) }], file: Some("/w.code-workspace".into()), ..Default::default() },
      WindowSession { empty: Some("e1".into()), bounds: Some(WindowBounds { x: 10.0, y: 20.0, width: 1200.0, height: 800.0, maximized: true, fullscreen: false }), ..Default::default() },
    ];
    recent.set_windows(two.clone()).unwrap();
    let again = Recent::load(file).data();
    assert_eq!(again.sessions(), two);
    // The last active window is empty: an older build reopens nothing.
    assert_eq!(again.last, None);
  }

  #[test]
  fn corrupt_recent_file_reads_as_empty() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("recent.json");
    std::fs::write(&file, "{not json").unwrap();
    let recent = Recent::load(file.clone());
    assert_eq!(recent.data(), RecentData::default());
    recent.opened(Path::new("/x")).unwrap();
    assert_eq!(Recent::load(file).data().folders, [PathBuf::from("/x")]);
  }
}
