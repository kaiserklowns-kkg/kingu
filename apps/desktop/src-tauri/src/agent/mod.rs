//! Agents: one git worktree per task, a Claude Agent SDK session running in it (via the agent
//! host sidecar), and its events streamed to the webview, including permission prompts.
//! `tasks` persists task metadata and `review` drives the review / merge / PR flow of the
//! Agents view.

pub mod automations;
pub mod events;
pub mod hooks;
pub mod host;
pub mod review;
pub mod tasks;
pub mod worktree;

use std::sync::Arc;

use tauri::State;
use tauri::ipc::Channel;

use crate::workspace::Workspace;
pub use events::AgentEvent;
pub use host::AgentHost;

const PERMISSION_MODES: &[&str] = &["default", "acceptEdits", "plan"];

/// Runs the agent in the task's worktree; events stream over `on_event`. `resume` continues an
/// earlier session (its `session_id`); `model`/`permission_mode` come from the user's settings.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn agent_start(
  app: tauri::AppHandle,
  ws: State<'_, Workspace>,
  agents: State<'_, Arc<AgentHost>>,
  slug: String,
  prompt: String,
  model: Option<String>,
  permission_mode: Option<String>,
  resume: Option<String>,
  mcp_servers: Option<std::collections::BTreeMap<String, host::McpServer>>,
  plugins: Option<Vec<String>>,
  on_event: Channel<AgentEvent>,
) -> Result<u32, String> {
  worktree::validate_slug(&slug)?;
  if prompt.trim().is_empty() {
    return Err("prompt is empty".into());
  }
  if let Some(m) = permission_mode.as_deref()
    && !PERMISSION_MODES.contains(&m)
  {
    return Err(format!("{m}: unsupported permission mode"));
  }
  if let Some(id) = resume.as_deref()
    && !tasks::valid_session_id(id)
  {
    return Err("invalid session id to resume".into());
  }
  if let Some(servers) = &mcp_servers {
    host::validate_mcp_servers(servers)?;
  }
  let plugins = plugins.filter(|p| !p.is_empty());
  if let Some(dirs) = &plugins {
    crate::snap::validate_plugin_dirs(&crate::snap::plugins_dir(&app)?, dirs)?;
  }
  let cwd = worktree::worktree_path(&ws.root()?, &slug);
  if !cwd.is_dir() {
    return Err(format!("{slug}: no worktree, create it first"));
  }
  let cwd = cwd.to_str().ok_or("worktree path is not valid UTF-8")?.to_owned();
  let mcp_servers = mcp_servers.filter(|m| !m.is_empty());
  let req = host::StartRequest { cwd, prompt, model: model.filter(|m| !m.trim().is_empty()), permission_mode, resume, mcp_servers, plugins };
  let resuming = req.resume.is_some();
  let agents = agents.inner().clone();
  // Spawning the sidecar and its first answer can take a moment: keep it off the main thread.
  let id = tauri::async_runtime::spawn_blocking(move || {
    agents.start(
      req,
      Arc::new(move |ev| {
        let _ = on_event.send(ev);
      }),
    )
  })
  .await
  .map_err(|e| e.to_string())??;
  log::info!("agent run {id} started for task {slug}{}", if resuming { " (resumed)" } else { "" });
  Ok(id)
}

async fn on_host<T: Send + 'static>(
  agents: &State<'_, Arc<AgentHost>>,
  f: impl FnOnce(&AgentHost) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
  let agents = agents.inner().clone();
  tauri::async_runtime::spawn_blocking(move || f(&agents)).await.map_err(|e| e.to_string())?
}

/// Follow-up message to a running session.
#[tauri::command]
pub async fn agent_send(agents: State<'_, Arc<AgentHost>>, run_id: u32, text: String) -> Result<(), String> {
  if text.trim().is_empty() {
    return Err("message is empty".into());
  }
  on_host(&agents, move |a| a.send(run_id, &text)).await
}

/// Answers a `permission_request`: `allow`, `allow_always` (this session) or `deny` + message.
#[tauri::command]
pub async fn agent_answer_permission(
  agents: State<'_, Arc<AgentHost>>,
  run_id: u32,
  request_id: String,
  decision: String,
  message: Option<String>,
) -> Result<(), String> {
  on_host(&agents, move |a| a.answer_permission(run_id, &request_id, &decision, message.as_deref())).await
}

/// Stops the current turn; the session stays open for follow-ups.
#[tauri::command]
pub async fn agent_interrupt(agents: State<'_, Arc<AgentHost>>, run_id: u32) -> Result<(), String> {
  on_host(&agents, move |a| a.interrupt(run_id)).await
}

/// Ends the run; continue it later with `agent_start { resume }`.
#[tauri::command]
pub async fn agent_stop(agents: State<'_, Arc<AgentHost>>, run_id: u32) -> Result<(), String> {
  log::info!("agent run {run_id} stopping");
  on_host(&agents, move |a| a.stop(run_id)).await
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Task list of the open folder; empty with no folder open.
#[tauri::command]
pub fn tasks_load(ws: State<'_, Workspace>) -> Result<Vec<tasks::TaskMeta>, String> {
  ws.current().map_or(Ok(Vec::new()), |root| tasks::load(&root))
}

/// Automations of the open folder; empty with no folder open.
#[tauri::command]
pub fn automations_load(ws: State<'_, Workspace>) -> Result<Vec<automations::Automation>, String> {
  ws.current().map_or(Ok(Vec::new()), |root| automations::load(&root))
}

#[tauri::command]
pub fn automations_save(ws: State<'_, Workspace>, automations: Vec<automations::Automation>) -> Result<(), String> {
  automations::save(&ws.root()?, &automations)
}

#[tauri::command]
pub fn tasks_save(ws: State<'_, Workspace>, tasks: Vec<tasks::TaskMeta>) -> Result<(), String> {
  tasks::save(&ws.root()?, &tasks)
}

/// Local branches of the open folder's repository (base branch picker).
#[tauri::command]
pub async fn git_branches(ws: State<'_, Workspace>) -> Result<Vec<String>, String> {
  let root = ws.root()?;
  blocking(move || crate::git::local_branches(&root)).await
}

/// Files changed in the task worktree since it forked from `base`, committed or not.
#[tauri::command]
pub async fn worktree_diff_stat(ws: State<'_, Workspace>, slug: String, base: String) -> Result<review::DiffStat, String> {
  let dir = review::task_dir(&ws.root()?, &slug)?;
  blocking(move || review::diff_stat(&dir, &base)).await
}

/// Restores `paths` in the task worktree to their state at the fork point (the webview confirms).
#[tauri::command]
pub async fn worktree_reject(ws: State<'_, Workspace>, slug: String, base: String, paths: Vec<String>) -> Result<(), String> {
  let dir = review::task_dir(&ws.root()?, &slug)?;
  blocking(move || review::reject(&dir, &base, &paths)).await?;
  log::info!("task {slug}: rejected changes");
  Ok(())
}

#[tauri::command]
pub async fn worktree_commit(ws: State<'_, Workspace>, slug: String, message: String) -> Result<(), String> {
  let dir = review::task_dir(&ws.root()?, &slug)?;
  blocking(move || review::commit_all(&dir, &message)).await?;
  log::info!("task {slug}: committed");
  Ok(())
}

/// `mode`: `"ff"` (fast-forward only) or `"merge"` (always a merge commit). The webview confirms.
#[tauri::command]
pub async fn worktree_merge(ws: State<'_, Workspace>, slug: String, base: String, mode: String) -> Result<review::MergeResult, String> {
  let root = ws.root()?;
  let merge_commit = match mode.as_str() {
    "ff" => false,
    "merge" => true,
    _ => return Err(format!("unknown merge mode {mode}")),
  };
  blocking(move || review::merge_local(&root, &slug, &base, merge_commit)).await
}

/// Files of the task worktree for a quick open scoped to it (relative to the worktree).
#[tauri::command]
pub async fn worktree_list_files(ws: State<'_, Workspace>, slug: String) -> Result<Vec<String>, String> {
  let dir = review::task_dir(&ws.root()?, &slug)?;
  tauri::async_runtime::spawn_blocking(move || crate::fs::list_files(&dir, 20_000)).await.map_err(|e| e.to_string())
}

/// `rel` at revision `rev`, in the task worktree `slug` (or the open folder without one); empty
/// when the file does not exist there. Feeds the task diff tabs.
#[tauri::command]
pub async fn git_show_ref(ws: State<'_, Workspace>, slug: Option<String>, rev: String, rel: String) -> Result<String, String> {
  let root = ws.root()?;
  let dir = match slug {
    Some(s) => review::task_dir(&root, &s)?,
    None => root,
  };
  crate::git::check_rel(&dir, &rel)?;
  blocking(move || crate::git::show_at(&dir, &rev, &rel)).await
}

/// Whether `gh` is installed and logged in (never creates anything).
#[tauri::command]
pub async fn gh_status() -> Result<review::GhStatus, String> {
  blocking(|| Ok(review::gh_status(review::gh_bin()))).await
}

/// The task branch's pull request and its CI checks (`None` when there is no PR yet).
#[tauri::command]
pub async fn worktree_pr_status(ws: State<'_, Workspace>, slug: String) -> Result<Option<review::PrStatus>, String> {
  let dir = review::task_dir(&ws.root()?, &slug)?;
  let gh = review::gh_bin().ok_or("ไม่พบ gh: ติดตั้งด้วย `brew install gh` แล้ว `gh auth login`")?;
  blocking(move || review::pr_status(&gh, &dir, &slug)).await
}

/// Pushes the task branch and runs `gh pr create`; returns the PR URL.
#[tauri::command]
pub async fn worktree_pr_create(
  ws: State<'_, Workspace>,
  slug: String,
  base: String,
  title: String,
  body: String,
) -> Result<String, String> {
  let dir = review::task_dir(&ws.root()?, &slug)?;
  let gh = review::gh_bin().ok_or("ไม่พบ gh: ติดตั้งด้วย `brew install gh` แล้ว `gh auth login`")?;
  let url = blocking(move || review::pr_create(&gh, &dir, &slug, &base, &title, &body)).await?;
  log::info!("opened PR {url}");
  Ok(url)
}
