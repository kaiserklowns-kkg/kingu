mod accounts;
mod agent;
mod dap;
mod fileops;
mod fs;
mod git;
mod glob;
mod git_remote;
mod lsp;
mod menu;
mod pty;
mod replace;
mod search;
mod settings;
mod shell_env;
mod snap;
mod snap_install;
mod snap_sandbox;
mod system;
mod team;
mod watcher;
mod window;
mod workspace;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

use workspace::{Recent, Workspace, resolve_in};

#[derive(serde::Serialize)]
struct AppInfo {
  name: &'static str,
  version: &'static str,
  os: &'static str,
  arch: &'static str,
  /// Root of the open folder, `""` when none is open.
  workspace: String,
}

#[tauri::command]
fn app_info(ws: State<'_, Workspace>) -> AppInfo {
  log::info!("app_info requested by webview");
  AppInfo {
    name: "Kingu",
    version: env!("CARGO_PKG_VERSION"),
    os: std::env::consts::OS,
    arch: std::env::consts::ARCH,
    workspace: ws.current().map(|r| r.display().to_string()).unwrap_or_default(),
  }
}

/// Status bar resources (memory, CPU, processes, terminals, keep-awake), polled by the webview.
#[tauri::command]
async fn system_stats(app: tauri::AppHandle, ptys: State<'_, pty::Ptys>, keep: State<'_, system::KeepAwake>) -> Result<system::Stats, String> {
  Ok(system::stats(ptys.terminals(), ptys.daemon_pid(), &system::webkit_pids(&app), &keep))
}

/// Listening TCP ports for the status bar's Ports popup.
#[tauri::command]
async fn system_ports(ptys: State<'_, pty::Ptys>) -> Result<Vec<system::Port>, String> {
  let daemon = ptys.daemon_pid();
  blocking(move || system::ports(daemon)).await
}

/// Stops a process Kingu started (Resource Manager / Ports "Stop Process").
#[tauri::command]
fn system_kill(ptys: State<'_, pty::Ptys>, pid: u32) -> Result<(), String> {
  system::kill(pid, ptys.daemon_pid())
}

/// Opens `http://localhost:<port>` in the default browser.
#[tauri::command]
fn open_local_url(url: String) -> Result<(), String> {
  system::open_local_url(&url)
}

/// Keeps the Mac awake (display and idle sleep) while on, like Orca's ☕ toggle.
#[tauri::command]
fn keep_awake_set(keep: State<'_, system::KeepAwake>, on: bool) -> Result<bool, String> {
  keep.set(on)
}

/// Webview errors and milestones, so they show up in the app log (WKWebView has no CDP).
#[tauri::command]
fn client_log(level: String, message: String) {
  match level.as_str() {
    "error" => log::error!("[webview] {message}"),
    _ => log::info!("[webview] {message}"),
  }
}

const MAX_OPEN_BYTES: u64 = 5 * 1024 * 1024;

#[tauri::command]
fn read_workspace_file(ws: State<'_, Workspace>, rel: String) -> Result<String, String> {
  let path = resolve_in(&ws.root()?, &rel)?;
  let len = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
  if len > MAX_OPEN_BYTES {
    return Err(format!("{rel}: larger than {MAX_OPEN_BYTES} bytes"));
  }
  std::fs::read_to_string(&path).map_err(|e| format!("{rel}: {e}"))
}

#[tauri::command]
fn fs_list_dir(ws: State<'_, Workspace>, rel: String) -> Result<Vec<fs::DirEntry>, String> {
  let root = ws.root()?;
  let dir = if rel.is_empty() { root.clone() } else { resolve_in(&root, &rel)? };
  let mut entries = fs::list_dir(&root, &dir)?;
  git::mark_ignored(&dir, &mut entries);
  Ok(entries)
}

const QUICK_OPEN_LIMIT: usize = 20_000;

#[tauri::command]
async fn fs_list_files(ws: State<'_, Workspace>) -> Result<Vec<String>, String> {
  let Some(root) = ws.current() else { return Ok(Vec::new()) };
  tauri::async_runtime::spawn_blocking(move || fs::list_files(&root, QUICK_OPEN_LIMIT))
    .await
    .map_err(|e| e.to_string())
}

/// Saves over an existing workspace file (the prototype has no "new file" yet).
#[tauri::command]
fn fs_write_file(ws: State<'_, Workspace>, rel: String, content: String) -> Result<(), String> {
  let path = resolve_in(&ws.root()?, &rel)?;
  if !path.is_file() {
    return Err(format!("{rel}: not a file"));
  }
  std::fs::write(&path, content).map_err(|e| format!("{rel}: {e}"))?;
  log::info!("saved {rel}");
  Ok(())
}

/// Current branch for the status bar; `None` outside a git repository.
#[tauri::command]
fn git_branch(ws: State<'_, Workspace>) -> Option<String> {
  let out = std::process::Command::new("git")
    .args(["rev-parse", "--abbrev-ref", "HEAD"])
    .current_dir(ws.current()?)
    .output()
    .ok()?;
  out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Paths from the webview, each checked to stay inside the workspace (they may be deleted files).
fn checked(root: &Path, paths: Vec<String>) -> Result<Vec<String>, String> {
  for p in &paths {
    git::check_rel(root, p)?;
  }
  Ok(paths)
}

/// Runs a git operation off the main thread (status can take a while in a large repository).
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// The repository a Source Control command acts on: the open folder, or the task worktree
/// `slug` (the ADE's right side bar works on the selected worktree).
fn repo_dir(ws: &Workspace, slug: Option<&str>) -> Result<PathBuf, String> {
  let root = ws.root()?;
  match slug {
    Some(s) => agent::review::task_dir(&root, s),
    None => Ok(root),
  }
}

/// Source Control view: branch, ahead/behind and changed files; `None` outside a repository.
#[tauri::command]
async fn git_status(ws: State<'_, Workspace>, slug: Option<String>) -> Result<Option<git::GitStatus>, String> {
  if slug.is_none() && ws.current().is_none() {
    return Ok(None);
  }
  let dir = repo_dir(&ws, slug.as_deref())?;
  blocking(move || git::status(&dir)).await
}

#[tauri::command]
async fn git_stage(ws: State<'_, Workspace>, paths: Vec<String>, slug: Option<String>) -> Result<(), String> {
  let dir = repo_dir(&ws, slug.as_deref())?;
  let paths = checked(&dir, paths)?;
  blocking(move || git::stage(&dir, &paths)).await
}

#[tauri::command]
async fn git_unstage(ws: State<'_, Workspace>, paths: Vec<String>, slug: Option<String>) -> Result<(), String> {
  let dir = repo_dir(&ws, slug.as_deref())?;
  let paths = checked(&dir, paths)?;
  blocking(move || git::unstage(&dir, &paths)).await
}

/// Deleting untracked files needs `delete_untracked`, set only after the user confirmed.
#[tauri::command]
async fn git_discard(ws: State<'_, Workspace>, paths: Vec<String>, delete_untracked: Option<bool>, slug: Option<String>) -> Result<(), String> {
  let dir = repo_dir(&ws, slug.as_deref())?;
  let paths = checked(&dir, paths)?;
  blocking(move || git::discard(&dir, &paths, delete_untracked.unwrap_or(false))).await
}

#[tauri::command]
async fn git_commit(ws: State<'_, Workspace>, message: String, amend: Option<bool>, slug: Option<String>) -> Result<(), String> {
  let dir = repo_dir(&ws, slug.as_deref())?;
  blocking(move || git::commit(&dir, &message, amend.unwrap_or(false))).await?;
  log::info!("committed{}", slug.map(|s| format!(" in task {s}")).unwrap_or_default());
  Ok(())
}

/// HEAD version of a file for the diff editor; empty when the file is not in HEAD.
#[tauri::command]
async fn git_show_head(ws: State<'_, Workspace>, rel: String) -> Result<String, String> {
  let root = ws.root()?;
  git::check_rel(&root, &rel)?;
  blocking(move || git::show_head(&root, &rel)).await
}

/// Terminal session `key`: re-attaches to its live shell (`run` is not typed again), else starts one.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
fn pty_spawn(
  ws: State<'_, Workspace>,
  ptys: State<'_, pty::Ptys>,
  accounts: State<'_, accounts::Accounts>,
  key: String,
  cols: u16,
  rows: u16,
  on_data: Channel<String>,
  slug: Option<String>,
  run: Option<Vec<String>>,
  terminal: Option<TerminalSettings>,
) -> Result<kingu_ptyd::Attached, String> {
  pty::validate_key(&key)?;
  // A task terminal starts in the task's worktree (the ADE's per-worktree terminals).
  // No folder open: the terminal starts in the home folder, like VS Code's empty window.
  let cwd = match slug {
    Some(slug) => {
      agent::worktree::validate_slug(&slug)?;
      let dir = agent::worktree::worktree_path(&ws.root()?, &slug);
      if !dir.is_dir() {
        return Err(format!("ไม่พบ worktree ของงาน {slug}"));
      }
      dir
    }
    None => {
      let folder = ws.current();
      let fallback = folder.clone().or_else(|| std::env::var_os("HOME").map(PathBuf::from)).unwrap_or_else(|| PathBuf::from("/"));
      pty::terminal_cwd(terminal.as_ref().and_then(|t| t.cwd.as_deref()), folder.as_deref(), fallback)
    }
  };
  let terminal = terminal.unwrap_or_default();
  // Only an agent CLI's terminal (`cli:` keys) gets the active AI account's env, never an
  // ordinary terminal, so an API key does not leak into every shell.
  let mut env = terminal.env;
  if let Some(program) = run.as_deref().and_then(<[String]>::first)
    && key.starts_with("cli:")
  {
    env.extend(accounts::env_for_program(&accounts, program)?);
  }
  let shell = terminal.shell.as_deref().filter(|s| !s.trim().is_empty());
  let attached = ptys.open(&key, &cwd, cols, rows, run.as_deref(), &env, shell, terminal.args.as_deref(), pty::channel_sink(on_data))?;
  if attached.spawned {
    log::info!("terminal {key} started ({cols}x{rows})");
  } else {
    log::info!("terminal {key} re-attached ({cols}x{rows})");
  }
  Ok(attached)
}

/// `terminal.integrated.*` for a new shell, read by the webview from the user's settings
/// (they are user-only, so a folder's workspace settings cannot pick the program that runs).
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct TerminalSettings {
  shell: Option<String>,
  args: Option<Vec<String>>,
  env: BTreeMap<String, String>,
  cwd: Option<String>,
}

/// `files.watcherExclude`.
#[tauri::command]
fn watcher_set_exclude(watcher: State<'_, watcher::FileWatcher>, globs: Vec<String>) {
  watcher.set_exclude(&globs);
}

#[tauri::command]
fn worktree_create(
  ws: State<'_, Workspace>,
  slug: String,
  base: Option<String>,
  prefix: Option<String>,
) -> Result<agent::worktree::WorktreeInfo, String> {
  agent::worktree::create(&ws.root()?, &slug, base.as_deref(), prefix.as_deref())
}

/// Before a task forks from `base`: fast-forward it from its upstream when safe
/// (`kingu.worktree.refreshBaseOnCreate`); returns what happened, for the status bar.
#[tauri::command]
async fn worktree_refresh_base(ws: State<'_, Workspace>, base: String) -> Result<Option<String>, String> {
  let root = ws.root()?;
  tauri::async_runtime::spawn_blocking(move || agent::worktree::refresh_base(&root, &base, std::time::Duration::from_secs(30)))
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn worktree_list(ws: State<'_, Workspace>) -> Result<Vec<agent::worktree::WorktreeInfo>, String> {
  // No folder open: no tasks to list (not an error in the Agent panel).
  ws.current().map_or(Ok(Vec::new()), |root| agent::worktree::list(&root))
}

/// `delete_branch`: `keep` (default), `safe` (`git branch -d`) or `force`; returns the branch a
/// safe delete kept because it is not merged.
#[tauri::command]
fn worktree_remove(
  ws: State<'_, Workspace>,
  slug: String,
  force: Option<bool>,
  delete_branch: Option<String>,
) -> Result<Option<String>, String> {
  let branch = agent::worktree::DeleteBranch::parse(delete_branch.as_deref())?;
  agent::worktree::remove(&ws.root()?, &slug, force.unwrap_or(false), branch)
}

/// Find in Files: streams ripgrep matches per file; a new search cancels the previous one.
#[tauri::command]
fn search_text(
  ws: State<'_, Workspace>,
  searches: State<'_, Arc<search::Searches>>,
  options: search::SearchOptions,
  on_event: Channel<search::SearchEvent>,
) -> Result<u32, String> {
  if options.query.is_empty() {
    searches.cancel();
    return Err("query is empty".into());
  }
  let rg = search::find_rg(std::env::var_os("KINGU_RG"), shell_env::path())?;
  searches.start(&rg, &ws.root()?, &options, move |ev| on_event.send(ev).is_ok())
}

/// Search: Replace. Rewrites the matches of the last search (refusing files changed since) and
/// returns edits for files the webview has open, which it applies to their editor models.
#[tauri::command]
async fn search_replace(ws: State<'_, Workspace>, request: replace::ReplaceRequest) -> Result<Vec<replace::FileResult>, String> {
  let root = ws.root()?;
  let results = blocking(move || replace::replace_all(&root, &request)).await?;
  let written: usize = results.iter().filter(|r| r.outcome == replace::Outcome::Written).map(|r| r.replaced).sum();
  log::info!("search_replace: {written} replacements written in {} files", results.len());
  Ok(results)
}

/// The ADE's right side bar (Files › Contents): its own ripgrep slot, so it never cancels the
/// IDE's Find in Files, run in the selected worktree so that worktree's ignore files apply.
#[derive(Default)]
struct WorktreeSearches(Arc<search::Searches>);

#[tauri::command]
fn worktree_search(
  ws: State<'_, Workspace>,
  searches: State<'_, WorktreeSearches>,
  slug: Option<String>,
  options: search::SearchOptions,
  on_event: Channel<search::SearchEvent>,
) -> Result<u32, String> {
  if options.query.is_empty() {
    searches.0.cancel();
    return Err("query is empty".into());
  }
  let dir = repo_dir(&ws, slug.as_deref())?;
  let rg = search::find_rg(std::env::var_os("KINGU_RG"), shell_env::path())?;
  searches.0.start(&rg, &dir, &options, move |ev| on_event.send(ev).is_ok())
}

#[tauri::command]
fn worktree_search_cancel(searches: State<'_, WorktreeSearches>) {
  searches.0.cancel();
}

#[tauri::command]
fn search_cancel(searches: State<'_, Arc<search::Searches>>) {
  searches.cancel();
}

/// Starts the language server for `language` in the workspace; server messages stream over `on_event`.
#[tauri::command]
fn lsp_start(
  ws: State<'_, Workspace>,
  servers: State<'_, lsp::Servers>,
  language: String,
  on_event: Channel<lsp::LspEvent>,
) -> Result<u32, String> {
  lsp::start_for(&servers, &ws.root()?, &language, on_event)
}

/// Whether the server for `language` can be started now (re-resolved on every call, so a server
/// installed meanwhile is found): its path, or the "ไม่ได้ติดตั้ง …" error.
#[tauri::command]
fn lsp_check(ws: State<'_, Workspace>, language: String) -> Result<String, String> {
  lsp::check(&language, &ws.root()?).map(|p| p.to_string_lossy().into_owned())
}

/// Install commands for the server of `language` that this machine's tools can run.
#[tauri::command]
fn lsp_install_methods(ws: State<'_, Workspace>, language: String) -> Result<lsp::InstallInfo, String> {
  lsp::install_info(&language, &ws.root()?)
}

// ---------------------------------------------------------------------------------------------
// Debugging (VS Code: debug adapters from extensions; Kingu: lldb-dap, dlv dap, debugpy)

/// Starts the debug adapter for a launch.json `type`; adapter messages stream over `on_event`.
/// `python` is the configuration's interpreter, preferred for debugpy.
#[tauri::command]
fn dap_start(
  ws: State<'_, Workspace>,
  sessions: State<'_, dap::Sessions>,
  debug_type: String,
  python: Option<String>,
  on_event: Channel<dap::DapEvent>,
) -> Result<u32, String> {
  dap::start_for(&sessions, &ws.root()?, &debug_type, python.as_deref().map(Path::new), on_event)
}

/// The adapter program for `debug_type`, or the "ไม่ได้ติดตั้ง …" error (re-resolved every call).
#[tauri::command]
async fn dap_check(ws: State<'_, Workspace>, debug_type: String, python: Option<String>) -> Result<String, String> {
  let root = ws.root()?;
  blocking(move || dap::check(&debug_type, python.as_deref().map(Path::new), &root).map(|(_, r)| r.program.to_string_lossy().into_owned())).await
}

#[tauri::command]
fn dap_install_methods(ws: State<'_, Workspace>, debug_type: String) -> Result<lsp::InstallInfo, String> {
  dap::install_info(&debug_type, &ws.root()?)
}

/// `${env:NAME}` in launch.json: the named variables of the environment debuggees get.
#[tauri::command]
fn debug_env(names: Vec<String>) -> std::collections::HashMap<String, String> {
  shell_env::vars_os()
    .into_iter()
    .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
    .filter(|(k, _)| names.contains(k))
    .collect()
}

/// A build step before a launch (e.g. `cargo build`), run in the workspace root and awaited.
#[tauri::command]
async fn debug_build(ws: State<'_, Workspace>, argv: Vec<String>) -> Result<dap::BuildResult, String> {
  let root = ws.root()?;
  blocking(move || dap::run_build(&argv, &root)).await
}

// ---------------------------------------------------------------------------------------------
// Open Folder (VS Code: workbench.action.files.openFolder, File: Open Recent)

/// Emitted with a debounced batch of changed paths under the open folder.
const FILES_CHANGED: &str = "workspace:files-changed";

#[derive(Clone, serde::Serialize)]
struct FilesChanged {
  root: String,
  /// Workspace-relative; `""` means "anything may have changed" (watcher rescan).
  paths: Vec<String>,
}

/// Makes `dir` the open folder (none for `None`). The old folder's language servers and running
/// search are stopped first and the watcher moves to the new root. Returns the canonical root.
fn switch_root(app: &AppHandle, dir: Option<&Path>) -> Result<Option<PathBuf>, String> {
  let root = dir.map(workspace::canonical_dir).transpose()?;
  app.state::<lsp::Servers>().stop_all();
  app.state::<dap::Sessions>().stop_all();
  app.state::<Arc<search::Searches>>().cancel();
  let ws = app.state::<Workspace>();
  match &root {
    Some(r) => {
      ws.open(r)?;
    }
    None => ws.close(),
  }
  let handle = app.clone();
  let label = root.as_ref().map(|r| r.display().to_string()).unwrap_or_default();
  let emit = move |paths| {
    let _ = handle.emit(FILES_CHANGED, FilesChanged { root: label.clone(), paths });
  };
  // A folder that cannot be watched (e.g. out of inotify handles) still opens.
  if let Err(e) = app.state::<watcher::FileWatcher>().watch(root.as_deref(), emit) {
    log::error!("{e}");
  }
  let recent = app.state::<Recent>();
  let saved = match &root {
    Some(r) => recent.opened(r),
    None => recent.closed(),
  };
  if let Err(e) = saved {
    log::error!("recent folders: {e}");
  }
  log::info!("workspace: {}", root.as_ref().map(|r| r.display().to_string()).unwrap_or_else(|| "(none)".into()));
  Ok(root)
}

#[tauri::command]
fn workspace_open(app: AppHandle, path: String) -> Result<String, String> {
  let root = switch_root(&app, Some(Path::new(&path)))?;
  Ok(root.map(|r| r.display().to_string()).unwrap_or_default())
}

#[tauri::command]
fn workspace_close(app: AppHandle) -> Result<(), String> {
  switch_root(&app, None).map(|_| ())
}

/// Recently opened folders, most recent first.
#[tauri::command]
fn workspace_recent(recent: State<'_, Recent>) -> Vec<String> {
  recent.data().folders.iter().map(|f| f.display().to_string()).collect()
}

#[tauri::command]
fn workspace_recent_remove(recent: State<'_, Recent>, path: String) -> Result<(), String> {
  recent.remove(Path::new(&path))
}

#[tauri::command]
fn workspace_recent_clear(recent: State<'_, Recent>) -> Result<(), String> {
  recent.clear()
}

// ---------------------------------------------------------------------------------------------
// Explorer file operations

#[tauri::command]
fn fs_create_file(ws: State<'_, Workspace>, rel: String) -> Result<(), String> {
  fileops::create_file(&ws.root()?, &rel)?;
  log::info!("created {rel}");
  Ok(())
}

#[tauri::command]
fn fs_create_dir(ws: State<'_, Workspace>, rel: String) -> Result<(), String> {
  fileops::create_dir(&ws.root()?, &rel)?;
  log::info!("created folder {rel}");
  Ok(())
}

#[tauri::command]
fn fs_rename(ws: State<'_, Workspace>, from: String, to: String) -> Result<(), String> {
  fileops::rename(&ws.root()?, &from, &to)?;
  log::info!("renamed {from} to {to}");
  Ok(())
}

/// Moves to the Trash; the webview confirms first.
#[tauri::command]
async fn fs_delete(ws: State<'_, Workspace>, rel: String) -> Result<(), String> {
  let root = ws.root()?;
  let r = rel.clone();
  blocking(move || fileops::trash(&root, &r)).await?;
  log::info!("moved {rel} to the Trash");
  Ok(())
}

#[tauri::command]
fn fs_reveal(ws: State<'_, Workspace>, rel: String) -> Result<(), String> {
  fileops::reveal(&ws.root()?, &rel)
}

/// Paste / ⌥-drag: copies `from` into the folder `to_dir`; returns the new path (`a copy.ts` on a clash).
#[tauri::command]
async fn fs_copy(ws: State<'_, Workspace>, from: String, to_dir: String) -> Result<String, String> {
  let root = ws.root()?;
  let rel = blocking(move || fileops::copy(&root, &from, &to_dir)).await?;
  log::info!("copied to {rel}");
  Ok(rel)
}

/// Cut/paste and drag and drop: moves `from` into the folder `to_dir`; returns the new path.
#[tauri::command]
fn fs_move(ws: State<'_, Workspace>, from: String, to_dir: String) -> Result<String, String> {
  let rel = fileops::move_into(&ws.root()?, &from, &to_dir)?;
  log::info!("moved {from} to {rel}");
  Ok(rel)
}

/// Files dropped on the window from Finder. Only these may be imported, so the webview cannot
/// copy an arbitrary file from outside the workspace into it.
#[derive(Default)]
struct DroppedPaths(std::sync::Mutex<Vec<PathBuf>>);

/// External drop (Finder → Explorer): copies the dropped `paths` into the folder `to_dir`.
#[tauri::command]
async fn fs_import(ws: State<'_, Workspace>, dropped: State<'_, DroppedPaths>, paths: Vec<String>, to_dir: String) -> Result<Vec<String>, String> {
  let root = ws.root()?;
  let allowed = dropped.0.lock().map_err(|e| e.to_string())?.clone();
  let sources: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
  if let Some(bad) = sources.iter().find(|p| !allowed.contains(p)) {
    return Err(format!("{}: not a dropped file", bad.display()));
  }
  let rels = blocking(move || fileops::import(&root, &sources, &to_dir)).await?;
  log::info!("imported {} dropped item(s)", rels.len());
  Ok(rels)
}

#[derive(serde::Serialize)]
struct SavedAs {
  /// Workspace-relative path, or None when the user saved outside the open folder.
  rel: Option<String>,
  path: String,
}

/// Save As (and the first save of an untitled editor): the native save dialog, then the write.
/// The dialog runs here so the webview never names a path outside the workspace itself.
#[tauri::command]
async fn fs_save_as(app: AppHandle, ws: State<'_, Workspace>, content: String, name: String, dir: Option<String>) -> Result<Option<SavedAs>, String> {
  use tauri_plugin_dialog::DialogExt;
  let root = ws.current();
  let start = match (&root, dir) {
    (Some(r), Some(d)) => resolve_in(r, &d).unwrap_or_else(|_| r.clone()),
    (Some(r), None) => r.clone(),
    (None, _) => app.path().home_dir().map_err(|e| e.to_string())?,
  };
  let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().set_directory(start).set_file_name(name).blocking_save_file())
    .await
    .map_err(|e| e.to_string())?;
  let Some(path) = picked.and_then(|p| p.into_path().ok()) else { return Ok(None) };
  std::fs::write(&path, content).map_err(|e| format!("{}: {e}", path.display()))?;
  log::info!("saved as {}", path.display());
  let real = path.canonicalize().unwrap_or_else(|_| path.clone());
  let rel = root.and_then(|r| real.strip_prefix(&r).ok().map(|p| p.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/")));
  Ok(Some(SavedAs { rel, path: path.display().to_string() }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_notification::init())
    .manage(Workspace::default())
    .manage(watcher::FileWatcher::default())
    .manage(window::CloseGuard::default())
    .manage(pty::Ptys::default())
    .manage(system::KeepAwake::default())
    .manage(Arc::new(agent::AgentHost::default()))
    .manage(Arc::new(search::Searches::default()))
    .manage(WorktreeSearches::default())
    .manage(lsp::Servers::default())
    .manage(dap::Sessions::default())
    .manage(git_remote::GitOps::default())
    .manage(menu::MenuState::default())
    .manage(DroppedPaths::default())
    .setup(|app| {
      shell_env::init();
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      // Reopen the last folder if it still exists, else KINGU_WORKSPACE, else the welcome view.
      let recent = Recent::load(app.path().app_data_dir()?.join("recent.json"));
      // window.restoreWindows: "none" starts empty (KINGU_WORKSPACE still opens).
      let restore = settings::user_value(&app.path().app_config_dir()?, "window.restoreWindows");
      let data = recent.data();
      let last = if restore.as_ref().and_then(|v| v.as_str()) == Some("none") { None } else { data.last.as_deref() };
      let start = workspace::startup_root(last, std::env::var_os("KINGU_WORKSPACE"));
      app.manage(recent);
      let data = app.path().app_data_dir()?;
      #[cfg(unix)]
      let (runtime, uid) = (
        std::env::var_os("XDG_RUNTIME_DIR").filter(|_| cfg!(target_os = "linux")).map(PathBuf::from),
        kingu_ptyd::peer::own_uid(),
      );
      #[cfg(not(unix))]
      let (runtime, uid) = (None, 0);
      pty::Ptys::init(app.handle(), pty::daemon_dir(&data, runtime, &std::env::temp_dir(), uid));
      team::install(app)?;
      accounts::install(app)?;
      menu::install(app.handle());
      if let Some(root) = start
        && let Err(e) = switch_root(app.handle(), Some(&root))
      {
        log::error!("reopen {}: {e}", root.display());
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      app_info,
      system_stats,
      system_ports,
      system_kill,
      open_local_url,
      keep_awake_set,
      client_log,
      read_workspace_file,
      fs_list_dir,
      fs_list_files,
      fs_write_file,
      fs_create_file,
      fs_create_dir,
      fs_rename,
      fs_delete,
      fs_reveal,
      fs_copy,
      fs_move,
      fs_import,
      fs_save_as,
      workspace_open,
      workspace_close,
      workspace_recent,
      workspace_recent_remove,
      workspace_recent_clear,
      git_branch,
      git_status,
      git_stage,
      git_unstage,
      git_discard,
      git_commit,
      git_show_head,
      git_remote::git_fetch,
      git_remote::git_pull,
      git_remote::git_push,
      git_remote::git_sync,
      git_remote::git_cancel,
      git_remote::git_refs,
      git_remote::git_checkout,
      git_remote::git_create_branch,
      git_remote::git_delete_branch,
      git_remote::git_stash_push,
      git_remote::git_stash_list,
      git_remote::git_stash_apply,
      git_remote::git_stash_drop,
      pty_spawn,
      pty::pty_write,
      pty::pty_resize,
      pty::pty_kill,
      pty::pty_attach,
      pty::pty_list,
      pty::pty_backend,
      worktree_create,
      worktree_refresh_base,
      worktree_list,
      worktree_remove,
      agent::agent_start,
      agent::hooks::agent_hook_settings,
      agent::hooks::agent_hook_file,
      agent::cli::agent_cli_found,
      agent::hooks::agent_hook_read,
      agent::hooks::agent_hook_clear,
      agent::agent_send,
      agent::agent_answer_permission,
      agent::agent_interrupt,
      agent::agent_stop,
      agent::tasks_load,
      agent::tasks_save,
      agent::automations_load,
      agent::automations_save,
      agent::git_branches,
      agent::worktree_diff_stat,
      agent::worktree_reject,
      agent::worktree_commit,
      agent::worktree_merge,
      agent::worktree_list_files,
      agent::git_show_ref,
      agent::gh_status,
      agent::worktree_pr_create,
      agent::worktree_pr_status,
      agent::scripts::worktree_script,
      agent::scripts::worktree_script_trust,
      agent::scripts::worktree_script_prepare,
      agent::scripts::worktree_archive_run,
      agent::gh_issues_list,
      agent::gh_issue_view,
      agent::gh_issue_comment,
      agent::gh_issue_open,
      search_text,
      search_cancel,
      worktree_search,
      worktree_search_cancel,
      search_replace,
      lsp_start,
      lsp_check,
      lsp_install_methods,
      lsp::lsp_send,
      lsp::lsp_stop,
      dap_start,
      dap_check,
      dap_install_methods,
      debug_build,
      debug_env,
      dap::dap_send,
      dap::dap_stop,
      settings::settings_read,
      settings::settings_write,
      watcher_set_exclude,
      window::window_close_guard,
      window::window_close_confirmed,
      snap::snap_list,
      snap::snap_trust,
      snap::snap_skill_plugins,
      snap_sandbox::snap_sandbox_info,
      snap_install::snap_install_git,
      snap_install::snap_install_folder,
      snap_install::snap_update_prepare,
      snap_install::snap_install_commit,
      snap_install::snap_install_cancel,
      snap_install::snap_uninstall,
      snap_install::snap_new,
      snap_install::snap_lock,
      snap_install::snap_reveal,
      snap_install::snap_manifest_read,
      snap_install::snap_manifest_write,
      accounts::ai_accounts_list,
      accounts::ai_account_add,
      accounts::ai_account_set_key,
      accounts::ai_account_remove,
      accounts::ai_account_set_active,
      accounts::ai_account_login_command,
      accounts::ai_usage_get,
      accounts::ai_usage_refresh,
      accounts::ai_usage_history,
      team::team_sign_in,
      team::team_sign_out,
      team::team_status,
      team::team_sync_task,
      team::team_sync_now,
      team::team_events_start,
      team::team_events_stop,
      team::snaps::team_snap_catalog,
      team::snaps::team_snap_approve,
      team::snaps::snap_install_team,
      menu::menu_set_model,
      menu::menu_set_checked,
      menu::menu_set_enabled,
      menu::window_titlebar_double_click,
      menu::app_quit
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      if let tauri::RunEvent::WindowEvent { event: tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }), .. } = &event
        && let Ok(mut dropped) = app.state::<DroppedPaths>().0.lock()
      {
        *dropped = paths.clone();
      }
      // Closing the window or a user quit (⌘Q) waits for the webview while it has something to ask.
      if let tauri::RunEvent::WindowEvent { event: tauri::WindowEvent::CloseRequested { api, .. }, .. } = &event
        && window::on_close_requested(app)
      {
        api.prevent_close();
      }
      if let tauri::RunEvent::ExitRequested { code: None, api, .. } = &event
        && window::on_close_requested(app)
      {
        api.prevent_exit();
      }
      if let tauri::RunEvent::Exit = event {
        app.state::<lsp::Servers>().stop_all();
        app.state::<dap::Sessions>().stop_all();
        app.state::<Arc<agent::AgentHost>>().shutdown();
      }
    });
}
