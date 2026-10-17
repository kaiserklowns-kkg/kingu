mod agent;
mod pty;

use std::path::{Path, PathBuf};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(Workspace::from_env())
    .manage(pty::Ptys::default())
    .manage(agent::Agents::default())
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
      pty_spawn,
      pty::pty_write,
      pty::pty_resize,
      pty::pty_kill,
      worktree_create,
      worktree_list,
      worktree_remove,
      agent_start,
      agent::agent_stop
    ])
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
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
