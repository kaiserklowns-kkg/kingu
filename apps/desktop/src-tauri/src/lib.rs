mod agent;
mod fs;
mod git;
mod lsp;
mod pty;
mod replace;
mod search;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::State;
use tauri::ipc::Channel;

#[derive(serde::Serialize)]
struct AppInfo {
  name: &'static str,
  version: &'static str,
  os: &'static str,
  arch: &'static str,
  workspace: String,
}

struct Workspace {
  root: PathBuf,
}

impl Workspace {
  /// `KINGU_WORKSPACE`, else this repository (Phase 0 has no folder picker yet).
  fn from_env() -> Self {
    let root = std::env::var_os("KINGU_WORKSPACE")
      .map(PathBuf::from)
      .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."));
    Self { root: root.canonicalize().unwrap_or(root) }
  }

  /// Resolves `rel` inside the workspace, rejecting anything that escapes it (`..`, symlinks out).
  fn resolve(&self, rel: &str) -> Result<PathBuf, String> {
    let path = self.root.join(rel).canonicalize().map_err(|e| format!("{rel}: {e}"))?;
    if !path.starts_with(&self.root) {
      return Err(format!("{rel}: outside the workspace"));
    }
    Ok(path)
  }
}

#[tauri::command]
fn app_info(ws: State<'_, Workspace>) -> AppInfo {
  log::info!("app_info requested by webview");
  AppInfo {
    name: "Kingu",
    version: env!("CARGO_PKG_VERSION"),
    os: std::env::consts::OS,
    arch: std::env::consts::ARCH,
    workspace: ws.root.display().to_string(),
  }
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
  let path = ws.resolve(&rel)?;
  let len = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
  if len > MAX_OPEN_BYTES {
    return Err(format!("{rel}: larger than {MAX_OPEN_BYTES} bytes"));
  }
  std::fs::read_to_string(&path).map_err(|e| format!("{rel}: {e}"))
}

#[tauri::command]
fn fs_list_dir(ws: State<'_, Workspace>, rel: String) -> Result<Vec<fs::DirEntry>, String> {
  let dir = if rel.is_empty() { ws.root.clone() } else { ws.resolve(&rel)? };
  fs::list_dir(&ws.root, &dir)
}

const QUICK_OPEN_LIMIT: usize = 20_000;

#[tauri::command]
async fn fs_list_files(ws: State<'_, Workspace>) -> Result<Vec<String>, String> {
  let root = ws.root.clone();
  tauri::async_runtime::spawn_blocking(move || fs::list_files(&root, QUICK_OPEN_LIMIT))
    .await
    .map_err(|e| e.to_string())
}

/// Saves over an existing workspace file (the prototype has no "new file" yet).
#[tauri::command]
fn fs_write_file(ws: State<'_, Workspace>, rel: String, content: String) -> Result<(), String> {
  let path = ws.resolve(&rel)?;
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
    .current_dir(&ws.root)
    .output()
    .ok()?;
  out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Paths from the webview, each checked to stay inside the workspace (they may be deleted files).
fn checked(ws: &Workspace, paths: Vec<String>) -> Result<Vec<String>, String> {
  for p in &paths {
    git::check_rel(&ws.root, p)?;
  }
  Ok(paths)
}

/// Runs a git operation off the main thread (status can take a while in a large repository).
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Source Control view: branch, ahead/behind and changed files; `None` outside a repository.
#[tauri::command]
async fn git_status(ws: State<'_, Workspace>) -> Result<Option<git::GitStatus>, String> {
  let root = ws.root.clone();
  blocking(move || git::status(&root)).await
}

#[tauri::command]
async fn git_stage(ws: State<'_, Workspace>, paths: Vec<String>) -> Result<(), String> {
  let (root, paths) = (ws.root.clone(), checked(&ws, paths)?);
  blocking(move || git::stage(&root, &paths)).await
}

#[tauri::command]
async fn git_unstage(ws: State<'_, Workspace>, paths: Vec<String>) -> Result<(), String> {
  let (root, paths) = (ws.root.clone(), checked(&ws, paths)?);
  blocking(move || git::unstage(&root, &paths)).await
}

/// Deleting untracked files needs `delete_untracked`, set only after the user confirmed.
#[tauri::command]
async fn git_discard(ws: State<'_, Workspace>, paths: Vec<String>, delete_untracked: Option<bool>) -> Result<(), String> {
  let (root, paths) = (ws.root.clone(), checked(&ws, paths)?);
  blocking(move || git::discard(&root, &paths, delete_untracked.unwrap_or(false))).await
}

#[tauri::command]
async fn git_commit(ws: State<'_, Workspace>, message: String, amend: Option<bool>) -> Result<(), String> {
  let root = ws.root.clone();
  blocking(move || git::commit(&root, &message, amend.unwrap_or(false))).await?;
  log::info!("committed");
  Ok(())
}

/// HEAD version of a file for the diff editor; empty when the file is not in HEAD.
#[tauri::command]
async fn git_show_head(ws: State<'_, Workspace>, rel: String) -> Result<String, String> {
  git::check_rel(&ws.root, &rel)?;
  let root = ws.root.clone();
  blocking(move || git::show_head(&root, &rel)).await
}

#[tauri::command]
fn pty_spawn(
  ws: State<'_, Workspace>,
  ptys: State<'_, pty::Ptys>,
  cols: u16,
  rows: u16,
  on_data: Channel<String>,
) -> Result<u32, String> {
  let id = pty::spawn_shell(&ptys, &ws.root, cols, rows, on_data)?;
  log::info!("terminal {id} started ({cols}x{rows})");
  Ok(id)
}

#[tauri::command]
fn worktree_create(
  ws: State<'_, Workspace>,
  slug: String,
  base: Option<String>,
) -> Result<agent::worktree::WorktreeInfo, String> {
  agent::worktree::create(&ws.root, &slug, base.as_deref())
}

#[tauri::command]
fn worktree_list(ws: State<'_, Workspace>) -> Result<Vec<agent::worktree::WorktreeInfo>, String> {
  agent::worktree::list(&ws.root)
}

#[tauri::command]
fn worktree_remove(
  ws: State<'_, Workspace>,
  slug: String,
  force: Option<bool>,
  delete_branch: Option<bool>,
) -> Result<(), String> {
  agent::worktree::remove(&ws.root, &slug, force.unwrap_or(false), delete_branch.unwrap_or(false))
}

/// Runs Claude Code headless in the task's worktree; events stream over `on_event`.
#[tauri::command]
fn agent_start(
  ws: State<'_, Workspace>,
  agents: State<'_, agent::Agents>,
  slug: String,
  prompt: String,
  on_event: Channel<agent::AgentEvent>,
) -> Result<u32, String> {
  agent::worktree::validate_slug(&slug)?;
  if prompt.trim().is_empty() {
    return Err("prompt is empty".into());
  }
  let cwd = agent::worktree::worktree_path(&ws.root, &slug);
  if !cwd.is_dir() {
    return Err(format!("{slug}: no worktree, create it first"));
  }
  let env = agent::runner::allowed_env(std::env::vars_os());
  let launch = agent::runner::claude_launch(agents.claude_bin.clone(), &prompt, cwd, env);
  let id = agents.start(
    launch,
    std::sync::Arc::new(move |ev| {
      let _ = on_event.send(ev);
    }),
  )?;
  log::info!("agent run {id} started for task {slug}");
  Ok(id)
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
  let rg = search::find_rg(std::env::var_os("KINGU_RG"), std::env::var_os("PATH"))?;
  searches.start(&rg, &ws.root, &options, move |ev| on_event.send(ev).is_ok())
}

/// Search: Replace. Rewrites the matches of the last search (refusing files changed since) and
/// returns edits for files the webview has open, which it applies to their editor models.
#[tauri::command]
async fn search_replace(ws: State<'_, Workspace>, request: replace::ReplaceRequest) -> Result<Vec<replace::FileResult>, String> {
  let root = ws.root.clone();
  let results = blocking(move || replace::replace_all(&root, &request)).await?;
  let written: usize = results.iter().filter(|r| r.outcome == replace::Outcome::Written).map(|r| r.replaced).sum();
  log::info!("search_replace: {written} replacements written in {} files", results.len());
  Ok(results)
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
  lsp::start_for(&servers, &ws.root, &language, on_event)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(Workspace::from_env())
    .manage(pty::Ptys::default())
    .manage(agent::Agents::default())
    .manage(Arc::new(search::Searches::default()))
    .manage(lsp::Servers::default())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      app_info,
      client_log,
      read_workspace_file,
      fs_list_dir,
      fs_list_files,
      fs_write_file,
      git_branch,
      git_status,
      git_stage,
      git_unstage,
      git_discard,
      git_commit,
      git_show_head,
      pty_spawn,
      pty::pty_write,
      pty::pty_resize,
      pty::pty_kill,
      worktree_create,
      worktree_list,
      worktree_remove,
      agent_start,
      agent::agent_stop,
      search_text,
      search_cancel,
      search_replace,
      lsp_start,
      lsp::lsp_send,
      lsp::lsp_stop
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      if let tauri::RunEvent::Exit = event {
        tauri::Manager::state::<lsp::Servers>(app).stop_all();
      }
    });
}

#[cfg(test)]
mod tests {
  use super::Workspace;

  #[test]
  fn rejects_paths_outside_the_workspace() {
    let ws = Workspace { root: std::env::current_dir().unwrap().canonicalize().unwrap() };
    assert!(ws.resolve("Cargo.toml").is_ok());
    // Enough `..` to reach `/` however deep the checkout is (e.g. inside a git worktree).
    let escape = format!("{}etc/hosts", "../".repeat(64));
    assert!(ws.resolve(&escape).unwrap_err().contains("outside"));
  }
}
