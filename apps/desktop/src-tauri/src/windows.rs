//! Windows and their workspaces (VS Code: the windows main service + IWorkspaceEditingService):
//! New Window, opening a folder or a `.code-workspace` file into a window, Add/Remove Folder,
//! Close Folder, and `window.restoreWindows`.
//!
//! Each window's workspace lives in [`Workspaces`]; changing it here moves that window's file
//! watchers (one per root folder), stops that window's language servers, debug sessions and
//! searches when its first folder changes, and saves the open windows for the next start.
//! Events about a window's folders go only to that window (`emit_to`).
//!
//! Each window also keeps its place on screen ([`WindowBounds`]): a restored window opens where
//! it was, a new one where `window.newWindowDimensions` says (VS Code's windowsStateHandler).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, Emitter, Manager};

use crate::workspace::{self, Folder, Recent, WindowBounds, WindowSession, Workspace, Workspaces};

/// Emitted to a window with a debounced batch of changed paths under one of its root folders.
pub const FILES_CHANGED: &str = "workspace:files-changed";
/// Emitted to a window when its first folder's repository changed a branch ref, HEAD or its worktrees.
pub const WORKTREES_CHANGED: &str = "ade:worktrees-changed";

#[derive(Clone, serde::Serialize)]
struct FilesChanged {
  /// The root folder the paths are relative to.
  root: String,
  /// Relative to `root`; `""` means "anything may have changed" (watcher rescan).
  paths: Vec<String>,
}

#[derive(Clone, serde::Serialize)]
struct WorktreesChanged {
  root: String,
}

/// A window's workspace as its page sees it.
#[derive(serde::Serialize)]
pub struct WorkspaceState {
  /// The window's label (`main`, `window-1`, …).
  pub window: String,
  pub folders: Vec<FolderInfo>,
  /// The `.code-workspace` file, if the folders came from one.
  pub file: Option<String>,
  /// An untitled multi-root workspace's id.
  pub untitled: Option<String>,
  /// The workspace's identity (terminals and backups are kept per identity).
  pub identity: Option<String>,
  /// An empty window's id: its layout and terminals are kept under it.
  pub empty: Option<String>,
  /// Files to open now (each handed out once).
  pub open_files: Vec<String>,
}

#[derive(serde::Serialize)]
pub struct FolderInfo {
  pub path: String,
  /// The name the Explorer shows.
  pub name: String,
}

/// A folder as the page names it: a path and an optional display name.
#[derive(Clone, Debug, serde::Deserialize)]
pub struct FolderArg {
  pub path: String,
  #[serde(default)]
  pub name: Option<String>,
}

fn state_of(ws: &Workspace) -> WorkspaceState {
  let s = ws.session();
  WorkspaceState {
    window: ws.label().into(),
    folders: s.folders.iter().map(|f| FolderInfo { path: f.path.display().to_string(), name: f.label() }).collect(),
    file: s.file.as_ref().map(|f| f.display().to_string()),
    untitled: s.untitled.clone(),
    identity: s.identity(),
    empty: s.empty.clone(),
    open_files: Vec::new(),
  }
}

/// A fresh id for an untitled multi-root workspace or an empty window.
fn untitled_id() -> String {
  use std::sync::atomic::{AtomicU64, Ordering};
  static SEQ: AtomicU64 = AtomicU64::new(0);
  let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
  let seed = format!("{nanos}:{}:{}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed));
  crate::snap::sha256_hex(seed.as_bytes())[..16].to_string()
}

/// Gives window `ws` the workspace `next`. When its first folder changes, the window's language
/// servers, debug sessions and searches stop (they ran in the old folder) and the git watcher
/// moves; other root folders only add or drop their file watcher.
pub fn set_session(app: &AppHandle, ws: &Workspace, mut next: WindowSession) {
  let old = ws.session();
  // The window stays where it is; an empty one gets its own id (a fresh one after Close Folder).
  next.bounds = next.bounds.or(old.bounds);
  next.empty = empty_id(&old, &next);
  let old_primary = old.folders.first().map(|f| f.path.clone());
  let new_primary = next.folders.first().map(|f| f.path.clone());
  let primary_changed = old_primary != new_primary;
  if primary_changed {
    app.state::<crate::lsp::Servers>().stop_window(ws.label());
    app.state::<crate::dap::Sessions>().stop_window(ws.label());
    ws.state().searches.cancel();
  }
  ws.set_session(next);
  let label = ws.label().to_string();
  ws.rewatch(|root| {
    let handle = app.clone();
    let label = label.clone();
    let root = root.display().to_string();
    move |paths| {
      let _ = handle.emit_to(label.as_str(), FILES_CHANGED, FilesChanged { root: root.clone(), paths });
    }
  });
  if primary_changed {
    // The ADE follows branch switches and worktrees added or removed outside Kingu.
    let common = new_primary.as_deref().map(|r| crate::git_queue::repo_keys(r).0).filter(|c| c.join("HEAD").is_file());
    let handle = app.clone();
    let root_label = new_primary.as_ref().map(|r| r.display().to_string()).unwrap_or_default();
    let emit_git = move || {
      let _ = handle.emit_to(label.as_str(), WORKTREES_CHANGED, WorktreesChanged { root: root_label.clone() });
    };
    if let Err(e) = ws.state().git.watch(common.as_deref(), emit_git) {
      log::warn!("{e}");
    }
    // A folder Kingu wrote into before: its .kingu/ stays out of git status from now on.
    if let Some(r) = new_primary.as_deref().filter(|r| r.join(".kingu").is_dir()) {
      crate::agent::worktree::exclude_kingu_soon(r);
    }
  }
  // Open Recent lists folders opened on their own (a workspace file is listed as a recent file).
  let now = ws.session();
  if let (Some(recent), [only], None, None) = (app.try_state::<Recent>(), now.folders.as_slice(), &now.file, &now.untitled)
    && primary_changed
    && let Err(e) = recent.opened(&only.path)
  {
    log::error!("recent folders: {e}");
  }
  save_windows(app);
  log::info!(
    "window {}: {}",
    ws.label(),
    if ws.folders().is_empty() { "(no folder)".to_string() } else { ws.folders().iter().map(|f| f.path.display().to_string()).collect::<Vec<_>>().join(", ") }
  );
}

/// The id an empty window keeps its page state under: the one it came with, the one it had while
/// already empty, else a new one; `None` once it has folders.
fn empty_id(old: &WindowSession, next: &WindowSession) -> Option<String> {
  if !next.folders.is_empty() {
    return None;
  }
  next.empty.clone().or_else(|| old.empty.clone().filter(|_| old.folders.is_empty())).or_else(|| Some(untitled_id()))
}

/// Remembers the open windows for `window.restoreWindows` (not while quitting: the windows going
/// away then are the ones to restore).
pub fn save_windows(app: &AppHandle) {
  if app.try_state::<crate::window::CloseGuard>().is_some_and(|g| g.quitting()) {
    return;
  }
  let Some(recent) = app.try_state::<Recent>() else { return };
  let sessions: Vec<WindowSession> = app.state::<Workspaces>().by_focus().iter().map(Workspace::session).collect();
  if let Err(e) = recent.set_windows(sessions) {
    log::error!("recent windows: {e}");
  }
}

/// A single folder (canonical) as a window's whole workspace.
fn single(dir: &Path) -> Result<WindowSession, String> {
  Ok(WindowSession { folders: vec![Folder::new(workspace::canonical_dir(dir)?)], ..Default::default() })
}

/// Folders from the page (a `.code-workspace` file's, or a multi-selection): existing ones,
/// canonicalized, without duplicates.
fn folders_of(args: &[FolderArg]) -> Vec<Folder> {
  workspace::existing_folders(&args.iter().map(|a| Folder { path: PathBuf::from(&a.path), name: a.name.clone() }).collect::<Vec<_>>())
}

/// Shows window `label` in front.
pub fn focus(app: &AppHandle, label: &str) -> bool {
  match app.get_webview_window(label) {
    Some(w) => {
      let _ = w.unminimize();
      let _ = w.show();
      let _ = w.set_focus();
      true
    }
    None => false,
  }
}

/// Opens a new window with `session` (set before its page loads, so the page starts in it).
/// `files` open in it once its page is up. Returns the window's label.
pub fn open_window(app: &AppHandle, session: WindowSession, files: Vec<String>) -> Result<String, String> {
  let workspaces = app.state::<Workspaces>();
  let label = workspaces.next_label();
  let mut config = app.config().app.windows.first().cloned().ok_or("no window configuration")?;
  config.label = label.clone();
  // The main window starts hidden until restore() has put it in place; this one opens in place.
  config.visible = true;
  let ws = workspaces.get(&label);
  set_session(app, &ws, session);
  ws.set_pending_files(files);
  let mut builder = tauri::WebviewWindowBuilder::from_config(app, &config).map_err(|e| e.to_string())?;
  if let Some(b) = ws.session().bounds {
    let b = placed(b, &monitors(app), (config.width, config.height));
    builder = builder.inner_size(b.width, b.height).maximized(b.maximized).fullscreen(b.fullscreen);
    if b.x.is_finite() {
      builder = builder.position(b.x, b.y);
    }
  }
  if let Err(e) = builder.build() {
    if let Some(gone) = workspaces.remove(&label) {
      gone.shut_down();
    }
    return Err(e.to_string());
  }
  workspaces.focused(&label);
  save_windows(app);
  log::info!("opened window {label}");
  Ok(label)
}

/// A window closed (not a quit): its workspace and services go, and it is no longer restored.
pub fn on_destroyed(app: &AppHandle, label: &str) {
  app.state::<crate::window::CloseGuard>().forget(label);
  app.state::<crate::lsp::Servers>().stop_window(label);
  app.state::<crate::dap::Sessions>().stop_window(label);
  app.state::<crate::pty::Ptys>().forget_window(label);
  let workspaces = app.state::<Workspaces>();
  // The last window closing ends the app: it stays in the session to restore.
  if workspaces.labels().len() <= 1 {
    app.state::<crate::window::CloseGuard>().start_quit();
  }
  if let Some(ws) = workspaces.remove(label) {
    ws.shut_down();
  }
  save_windows(app);
}

/// At startup: the last session's windows per `window.restoreWindows` (the main window takes the
/// last active one), else `KINGU_WORKSPACE`, else an empty main window.
pub fn restore(app: &AppHandle, setting: Option<&str>, data: &workspace::RecentData) {
  // Full screen comes back only with window.restoreFullscreen (VS Code).
  let fullscreen = window_setting(app, "window.restoreFullscreen").and_then(|v| v.as_bool()) == Some(true);
  let mut sessions: Vec<WindowSession> = workspace::windows_to_restore(setting, &data.sessions())
    .into_iter()
    .map(|s| WindowSession {
      folders: workspace::existing_folders(&s.folders),
      bounds: s.bounds.map(|b| WindowBounds { fullscreen: b.fullscreen && fullscreen, ..b }),
      ..s
    })
    .collect();
  // The main window takes the last active one; an empty one gives way to KINGU_WORKSPACE.
  let last = sessions.pop();
  let mut main_session = match last {
    Some(s) if !s.folders.is_empty() => s,
    last => workspace::startup_root(None, std::env::var_os("KINGU_WORKSPACE"))
      .map(|r| WindowSession { folders: vec![Folder::new(r)], bounds: last.as_ref().and_then(|l| l.bounds), ..Default::default() })
      .or(last)
      .unwrap_or_default(),
  };
  // The first window opens where the last active one was, even when no window is restored (VS Code).
  if main_session.bounds.is_none() {
    main_session.bounds = data.sessions().last().and_then(|s| s.bounds).map(|b| WindowBounds { fullscreen: b.fullscreen && fullscreen, ..b });
  }
  let main = app.state::<Workspaces>().get(workspace::MAIN_WINDOW);
  for s in sessions {
    if let Err(e) = open_window(app, s, Vec::new()) {
      log::error!("restore window: {e}");
    }
  }
  if let (Some(b), Some(w)) = (main_session.bounds, app.get_webview_window(workspace::MAIN_WINDOW)) {
    let size = app.config().app.windows.first().map_or((1440.0, 900.0), |c| (c.width, c.height));
    apply_bounds(&w, placed(b, &monitors(app), size));
  }
  set_session(app, &main, main_session);
  app.state::<Workspaces>().focused(workspace::MAIN_WINDOW);
  focus(app, workspace::MAIN_WINDOW);
}

// ---------------------------------------------------------------------------------------------
// Window bounds

/// A display's area, in logical pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
}

impl Rect {
  fn contains(&self, x: f64, y: f64) -> bool {
    x >= self.x && y >= self.y && x < self.x + self.width && y < self.y + self.height
  }
}

/// How far into a window its title bar must still be on a display for its saved place to be kept.
const GRIP: f64 = 48.0;
/// VS Code's cascade step for a new window that would sit right on another one.
const CASCADE: f64 = 30.0;
/// Smaller saved sizes are not trusted (a window is at least tauri.conf.json's minimum anyway).
const MIN_SIZE: f64 = 100.0;

/// The displays, in logical pixels (empty when the OS does not say).
fn monitors(app: &AppHandle) -> Vec<Rect> {
  app
    .available_monitors()
    .unwrap_or_default()
    .iter()
    .map(|m| {
      let f = m.scale_factor();
      let (p, s) = (m.position().to_logical::<f64>(f), m.size().to_logical::<f64>(f));
      Rect { x: p.x, y: p.y, width: s.width, height: s.height }
    })
    .collect()
}

/// Saved bounds made safe to open with on `displays`: kept while the top of the window is still
/// on one of them (a display that went away, or a changed arrangement, leaves it off screen),
/// else the window keeps its size (at most the first display's) and the OS places it (`x`/`y`
/// are NaN then). An unusable size becomes `fallback`; unknown displays keep the bounds.
pub fn placed(b: WindowBounds, displays: &[Rect], fallback: (f64, f64)) -> WindowBounds {
  let mut b = b;
  if !(b.width.is_finite() && b.height.is_finite() && b.width >= MIN_SIZE && b.height >= MIN_SIZE) {
    (b.width, b.height) = fallback;
  }
  let Some(first) = displays.first() else { return b };
  let top = [(b.x + GRIP, b.y + 8.0), (b.x + b.width / 2.0, b.y + 8.0), (b.x + b.width - GRIP, b.y + 8.0)];
  if b.x.is_finite() && b.y.is_finite() && displays.iter().any(|d| top.iter().any(|&(x, y)| d.contains(x, y))) {
    return b;
  }
  WindowBounds { x: f64::NAN, y: f64::NAN, width: b.width.min(first.width), height: b.height.min(first.height), ..b }
}

/// Where a new window opens (VS Code's `window.newWindowDimensions`): `default` at the default
/// `size`, centered on `display` (the active window's); `inherit` the active window's place and
/// `offset` the same moved clear of the others; `maximized` / `fullscreen` that way. `default`
/// and `offset` never open exactly on another window's row or column (`others`: their top-left
/// corners), they cascade instead. `None`: no display to place it on (the OS decides).
pub fn new_window_bounds(setting: Option<&str>, active: Option<WindowBounds>, display: Option<Rect>, size: (f64, f64), others: &[(f64, f64)]) -> Option<WindowBounds> {
  let centered = display.map(|d| {
    let (w, h) = (size.0.min(d.width), size.1.min(d.height));
    WindowBounds { x: (d.x + (d.width - w) / 2.0).round(), y: (d.y + (d.height - h) / 2.0).round(), width: w, height: h, maximized: false, fullscreen: false }
  });
  let (state, no_overlap) = match (setting.unwrap_or("default"), active) {
    ("maximized", _) => (centered.map(|b| WindowBounds { maximized: true, ..b }), false),
    ("fullscreen", _) => (centered.map(|b| WindowBounds { fullscreen: true, ..b }), false),
    // A window in full screen passes on only that (VS Code #19331).
    ("inherit" | "offset", Some(a)) if a.fullscreen => (centered.map(|b| WindowBounds { fullscreen: true, ..b }), false),
    (s @ ("inherit" | "offset"), Some(a)) => (Some(a), s == "offset"),
    _ => (centered, true),
  };
  let mut b = state?;
  if no_overlap {
    while others.iter().any(|&(x, y)| x == b.x || y == b.y) {
      b.x += CASCADE;
      b.y += CASCADE;
    }
  }
  Some(b)
}

fn apply_bounds(w: &tauri::WebviewWindow, b: WindowBounds) {
  let _ = w.set_size(tauri::LogicalSize::new(b.width, b.height));
  if b.x.is_finite() {
    let _ = w.set_position(tauri::LogicalPosition::new(b.x, b.y));
  }
  if b.maximized {
    let _ = w.maximize();
  }
  if b.fullscreen {
    let _ = w.set_fullscreen(true);
  }
}

/// A user setting about windows, read from the user's settings file (before any page runs).
fn window_setting(app: &AppHandle, key: &str) -> Option<serde_json::Value> {
  crate::settings::user_value(&app.path().app_config_dir().ok()?, key)
}

/// A window's bounds as the OS has them now; a maximized or full screen one keeps the normal
/// bounds it had before (`last`).
fn current_bounds(w: &tauri::WebviewWindow, last: Option<WindowBounds>) -> Option<WindowBounds> {
  let scale = w.scale_factor().ok()?;
  let maximized = w.is_maximized().unwrap_or(false);
  let fullscreen = w.is_fullscreen().unwrap_or(false);
  if (maximized || fullscreen)
    && let Some(l) = last
  {
    return Some(WindowBounds { maximized, fullscreen, ..l });
  }
  let p = w.outer_position().ok()?.to_logical::<f64>(scale);
  let s = w.inner_size().ok()?.to_logical::<f64>(scale);
  // JSON has no NaN: such bounds would make the whole recent file unreadable.
  Some(WindowBounds { x: p.x, y: p.y, width: s.width, height: s.height, maximized, fullscreen }).filter(|b| [b.x, b.y, b.width, b.height].iter().all(|v| v.is_finite()))
}

/// Bumped by every move or resize: the windows are saved once they stop.
static BOUNDS_GENERATION: AtomicU64 = AtomicU64::new(0);
const BOUNDS_SAVE_DELAY: std::time::Duration = std::time::Duration::from_millis(600);

/// Window `label` moved or was resized: its bounds follow, saved once the moving stops.
pub fn on_moved(app: &AppHandle, label: &str) {
  let workspaces = app.state::<Workspaces>();
  if !workspaces.labels().iter().any(|l| l == label) {
    return;
  }
  let ws = workspaces.get(label);
  let Some(w) = app.get_webview_window(label) else { return };
  let last = ws.session().bounds;
  let Some(b) = current_bounds(&w, last) else { return };
  if last == Some(b) {
    return;
  }
  ws.set_bounds(b);
  let mine = BOUNDS_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
  let app = app.clone();
  std::thread::spawn(move || {
    std::thread::sleep(BOUNDS_SAVE_DELAY);
    if BOUNDS_GENERATION.load(Ordering::SeqCst) == mine {
      save_windows(&app);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Commands

/// The calling window's workspace, and the files it should open (Open File in a new window).
#[tauri::command]
pub fn workspace_state(ws: Workspace) -> WorkspaceState {
  let open_files = ws.take_pending_files();
  WorkspaceState { open_files, ..state_of(&ws) }
}

/// This window's root folders (`${workspaceFolder:name}` in tasks and launch configurations).
#[tauri::command]
pub fn workspace_folders(ws: Workspace) -> Vec<FolderInfo> {
  state_of(&ws).folders
}

/// Open Folder in this window: `path` becomes its only folder. Returns the canonical root.
#[tauri::command]
pub fn workspace_open(app: AppHandle, ws: Workspace, path: String) -> Result<String, String> {
  let session = single(Path::new(&path))?;
  let root = session.folders[0].path.display().to_string();
  set_session(&app, &ws, session);
  Ok(root)
}

/// Opens a `.code-workspace` file's folders (`file`) or a multi-selection of folders (untitled
/// workspace when there are several) in this window. Folders that no longer exist are left out.
#[tauri::command]
pub fn workspace_open_folders(app: AppHandle, ws: Workspace, folders: Vec<FolderArg>, file: Option<String>) -> Result<WorkspaceState, String> {
  let folders = folders_of(&folders);
  let file = file.map(PathBuf::from);
  let untitled = (file.is_none() && folders.len() > 1).then(untitled_id);
  set_session(&app, &ws, WindowSession { folders, file, untitled, ..Default::default() });
  Ok(state_of(&ws))
}

/// Close Folder / Close Workspace: the window stays, empty.
#[tauri::command]
pub fn workspace_close(app: AppHandle, ws: Workspace) {
  set_session(&app, &ws, WindowSession::default());
  if let Err(e) = app.state::<Recent>().closed() {
    log::error!("recent folders: {e}");
  }
}

/// Add Folder to Workspace: a single folder becomes an untitled multi-root workspace (VS Code's
/// "Untitled (Workspace)"); an empty window simply opens the folder.
#[tauri::command]
pub fn workspace_add_folders(app: AppHandle, ws: Workspace, paths: Vec<String>) -> Result<WorkspaceState, String> {
  let mut s = ws.session();
  let add: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
  s.folders = workspace::with_added(&s.folders, &add)?;
  if s.folders.len() > 1 && s.file.is_none() && s.untitled.is_none() {
    s.untitled = Some(untitled_id());
  }
  set_session(&app, &ws, s);
  Ok(state_of(&ws))
}

/// Remove Folder from Workspace. Removing the first folder makes the next one first (its
/// language servers start over); removing the last one leaves the window empty.
#[tauri::command]
pub fn workspace_remove_folder(app: AppHandle, ws: Workspace, path: String) -> Result<WorkspaceState, String> {
  let mut s = ws.session();
  s.folders = workspace::without(&s.folders, Path::new(&path))?;
  if s.folders.is_empty() {
    s = WindowSession::default();
  }
  set_session(&app, &ws, s);
  Ok(state_of(&ws))
}

/// Save Workspace As / opening a workspace file: the window's workspace is now `file` (`null`:
/// back to untitled).
#[tauri::command]
pub fn workspace_set_file(app: AppHandle, ws: Workspace, file: Option<String>) -> WorkspaceState {
  let mut s = ws.session();
  s.file = file.map(PathBuf::from);
  if s.file.is_some() {
    s.untitled = None;
  } else if s.folders.len() > 1 && s.untitled.is_none() {
    s.untitled = Some(untitled_id());
  }
  ws.set_session(s);
  save_windows(&app);
  state_of(&ws)
}

/// What a new window opens.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct NewWindow {
  /// Its folders (none: an empty window).
  pub folders: Vec<FolderArg>,
  /// The `.code-workspace` file the folders come from.
  pub file: Option<String>,
  /// Files to open in it (Open File with `window.openFilesInNewWindow`).
  pub files: Vec<String>,
  /// Duplicate Workspace in New Window: a new untitled workspace even for the same folders.
  pub duplicate: bool,
}

/// New Window (⇧⌘N), Open Folder in a new window, Duplicate Workspace in New Window. A window that
/// already has exactly these folders (or this workspace file) comes to the front instead, like
/// VS Code. Returns the window's label.
#[tauri::command]
pub async fn window_new(app: AppHandle, options: Option<NewWindow>) -> Result<String, String> {
  let o = options.unwrap_or_default();
  let folders = folders_of(&o.folders);
  // A duplicate is a new untitled workspace with the same folders.
  let file = o.file.filter(|_| !o.duplicate).map(PathBuf::from);
  if !o.duplicate
    && (file.is_some() || !folders.is_empty())
    && let Some(label) = app.state::<Workspaces>().window_with(&folders.iter().map(|f| f.path.clone()).collect::<Vec<_>>(), file.as_deref())
  {
    focus(&app, &label);
    return Ok(label);
  }
  let untitled = (file.is_none() && (folders.len() > 1 || (o.duplicate && !folders.is_empty()))).then(untitled_id);
  let mut session = WindowSession { folders, file, untitled, ..Default::default() };
  session.bounds = new_bounds(&app, &session);
  open_window(&app, session, o.files)
}

/// A new window's place: where this folder or workspace file was last time (VS Code's known
/// workspace), else what `window.newWindowDimensions` says next to the active window.
fn new_bounds(app: &AppHandle, session: &WindowSession) -> Option<WindowBounds> {
  if let Some(id) = session.identity().filter(|_| session.untitled.is_none())
    && let Some(b) = app.try_state::<Recent>().and_then(|r| r.data().sessions().into_iter().find(|s| s.identity().as_deref() == Some(id.as_str())).and_then(|s| s.bounds))
  {
    return Some(WindowBounds { fullscreen: false, ..b });
  }
  let workspaces = app.state::<Workspaces>();
  let active = workspaces.last_active().and_then(|w| app.get_webview_window(w.label()).and_then(|win| current_bounds(&win, w.session().bounds)));
  let displays = monitors(app);
  let display = active.and_then(|a| displays.iter().copied().find(|d| d.contains(a.x + a.width / 2.0, a.y + a.height / 2.0))).or(displays.first().copied());
  let others: Vec<(f64, f64)> = workspaces.all().iter().filter_map(|w| w.session().bounds).map(|b| (b.x, b.y)).collect();
  let size = app.config().app.windows.first().map_or((1440.0, 900.0), |c| (c.width, c.height));
  let setting = window_setting(app, "window.newWindowDimensions");
  new_window_bounds(setting.as_ref().and_then(|v| v.as_str()), active, display, size, &others)
}

/// Before opening `path` in this window: when another window already has exactly that folder,
/// it comes to the front instead (true).
#[tauri::command]
pub fn window_focus_folder(app: AppHandle, ws: Workspace, path: String) -> bool {
  let Ok(root) = workspace::canonical_dir(Path::new(&path)) else { return false };
  match app.state::<Workspaces>().window_with(&[root], None) {
    Some(label) if label != ws.label() => focus(&app, &label),
    _ => false,
  }
}

/// How many windows are open (Close Window on the last one quits on Windows/Linux like VS Code).
#[tauri::command]
pub fn window_count(app: AppHandle) -> usize {
  app.state::<Workspaces>().labels().len()
}

#[cfg(test)]
mod tests {
  use super::*;

  const MAIN: Rect = Rect { x: 0.0, y: 0.0, width: 1728.0, height: 1117.0 };
  const SIDE: Rect = Rect { x: 1728.0, y: 0.0, width: 1920.0, height: 1080.0 };

  fn at(x: f64, y: f64, width: f64, height: f64) -> WindowBounds {
    WindowBounds { x, y, width, height, maximized: false, fullscreen: false }
  }

  #[test]
  fn a_saved_place_is_kept_while_it_is_on_a_display() {
    assert_eq!(placed(at(100.0, 50.0, 1200.0, 800.0), &[MAIN], (1440.0, 900.0)), at(100.0, 50.0, 1200.0, 800.0));
    // Mostly off the left edge, its title bar still reachable.
    assert_eq!(placed(at(-1000.0, 40.0, 1200.0, 800.0), &[MAIN], (1440.0, 900.0)).x, -1000.0);
    assert_eq!(placed(at(2000.0, 40.0, 1200.0, 800.0), &[MAIN, SIDE], (1440.0, 900.0)).x, 2000.0);
    // Unknown displays: as saved.
    assert_eq!(placed(at(9000.0, 40.0, 1200.0, 800.0), &[], (1440.0, 900.0)).x, 9000.0);
  }

  #[test]
  fn a_place_on_a_display_that_went_away_is_left_to_the_os() {
    let b = placed(at(2000.0, 40.0, 1900.0, 1060.0), &[MAIN], (1440.0, 900.0));
    assert!(b.x.is_nan() && b.y.is_nan());
    assert_eq!((b.width, b.height), (1728.0, 1060.0));
    assert!(placed(at(100.0, -900.0, 1200.0, 800.0), &[MAIN], (1440.0, 900.0)).x.is_nan());
    // A broken size: the default one.
    let tiny = placed(at(10.0, 10.0, 0.0, f64::NAN), &[MAIN], (1440.0, 900.0));
    assert_eq!((tiny.x, tiny.width, tiny.height), (10.0, 1440.0, 900.0));
    let max = placed(WindowBounds { maximized: true, ..at(5000.0, 0.0, 1200.0, 800.0) }, &[MAIN], (1440.0, 900.0));
    assert!(max.maximized && max.x.is_nan());
  }

  #[test]
  fn new_window_dimensions() {
    let active = at(100.0, 80.0, 1200.0, 800.0);
    let size = (1440.0, 900.0);
    // default: centered on the display at the default size, clear of the open windows.
    assert_eq!(new_window_bounds(None, Some(active), Some(MAIN), size, &[]), Some(at(144.0, 109.0, 1440.0, 900.0)));
    assert_eq!(new_window_bounds(Some("default"), Some(active), Some(MAIN), size, &[(144.0, 0.0)]), Some(at(174.0, 139.0, 1440.0, 900.0)));
    assert_eq!(new_window_bounds(None, None, Some(Rect { x: 0.0, y: 0.0, width: 1280.0, height: 800.0 }), size, &[]), Some(at(0.0, 0.0, 1280.0, 800.0)));
    // inherit: the active window's place exactly; offset: the same, cascaded off it.
    assert_eq!(new_window_bounds(Some("inherit"), Some(active), Some(MAIN), size, &[(100.0, 80.0)]), Some(active));
    assert_eq!(new_window_bounds(Some("offset"), Some(active), Some(MAIN), size, &[(100.0, 80.0)]), Some(at(130.0, 110.0, 1200.0, 800.0)));
    // Without an active window they fall back to default.
    assert_eq!(new_window_bounds(Some("offset"), None, Some(MAIN), size, &[]), Some(at(144.0, 109.0, 1440.0, 900.0)));
    let inherited = new_window_bounds(Some("inherit"), Some(WindowBounds { fullscreen: true, ..active }), Some(MAIN), size, &[]).unwrap();
    assert!(inherited.fullscreen && inherited.width == 1440.0);
    assert!(new_window_bounds(Some("maximized"), Some(active), Some(MAIN), size, &[(144.0, 109.0)]).unwrap().maximized);
    assert!(new_window_bounds(Some("fullscreen"), None, Some(MAIN), size, &[]).unwrap().fullscreen);
    // No display known: the OS places it.
    assert_eq!(new_window_bounds(None, Some(active), None, size, &[]), None);
  }

  #[test]
  fn an_empty_window_keeps_one_id_until_it_opens_a_folder() {
    let folder = WindowSession { folders: vec![Folder::new("/a".into())], ..Default::default() };
    let empty = WindowSession { empty: Some("e1".into()), ..Default::default() };
    // Restored with its id, or still empty: the same id.
    assert_eq!(empty_id(&WindowSession::default(), &empty).as_deref(), Some("e1"));
    assert_eq!(empty_id(&empty, &WindowSession::default()).as_deref(), Some("e1"));
    // A new empty window, or Close Folder: a new id.
    assert_eq!(empty_id(&WindowSession::default(), &WindowSession::default()).map(|id| id.len()), Some(16));
    assert_ne!(empty_id(&folder, &WindowSession::default()).as_deref(), Some("e1"));
    assert_eq!(empty_id(&empty, &folder), None);
  }
}
