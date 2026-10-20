//! Windows and their workspaces (VS Code: the windows main service + IWorkspaceEditingService):
//! New Window, opening a folder or a `.code-workspace` file into a window, Add/Remove Folder,
//! Close Folder, and `window.restoreWindows`.
//!
//! Each window's workspace lives in [`Workspaces`]; changing it here moves that window's file
//! watchers (one per root folder), stops that window's language servers, debug sessions and
//! searches when its first folder changes, and saves the open windows for the next start.
//! Events about a window's folders go only to that window (`emit_to`).

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, Manager};

use crate::workspace::{self, Folder, Recent, WindowSession, Workspace, Workspaces};

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
    open_files: Vec::new(),
  }
}

/// A fresh id for an untitled multi-root workspace.
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
pub fn set_session(app: &AppHandle, ws: &Workspace, next: WindowSession) {
  let old = ws.session();
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
  let ws = workspaces.get(&label);
  set_session(app, &ws, session);
  ws.set_pending_files(files);
  let mut builder = tauri::WebviewWindowBuilder::from_config(app, &config).map_err(|e| e.to_string())?;
  // Cascade from the active window, like a new document window on macOS.
  if let Some(active) = workspaces.last_active().filter(|w| w.label() != label).and_then(|w| app.get_webview_window(w.label()))
    && let (Ok(pos), Ok(scale)) = (active.outer_position(), active.scale_factor())
  {
    let p = pos.to_logical::<f64>(scale);
    builder = builder.position(p.x + 28.0, p.y + 28.0);
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
  let mut sessions: Vec<WindowSession> = workspace::windows_to_restore(setting, &data.sessions())
    .into_iter()
    .map(|s| WindowSession { folders: workspace::existing_folders(&s.folders), ..s })
    .collect();
  let main_session = sessions.pop().filter(|s| !s.folders.is_empty()).or_else(|| workspace::startup_root(None, std::env::var_os("KINGU_WORKSPACE")).map(|r| WindowSession { folders: vec![Folder::new(r)], ..Default::default() }));
  let main = app.state::<Workspaces>().get(workspace::MAIN_WINDOW);
  for s in sessions {
    if let Err(e) = open_window(app, s, Vec::new()) {
      log::error!("restore window: {e}");
    }
  }
  set_session(app, &main, main_session.unwrap_or_default());
  app.state::<Workspaces>().focused(workspace::MAIN_WINDOW);
  focus(app, workspace::MAIN_WINDOW);
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
  set_session(&app, &ws, WindowSession { folders, file, untitled });
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
  let session = WindowSession { folders, file, untitled };
  open_window(&app, session, o.files)
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
