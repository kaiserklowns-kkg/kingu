//! Agent runner spike: one git worktree per task, a coding-agent CLI running in it,
//! and its output normalized into events for the webview. `tasks` persists task metadata and
//! `review` drives the review / merge / PR flow of the Agents view.

pub mod events;
pub mod review;
pub mod runner;
pub mod tasks;
pub mod worktree;

use tauri::State;

use crate::workspace::Workspace;

pub use events::AgentEvent;
pub use runner::Agents;

#[tauri::command]
pub fn agent_stop(agents: State<'_, Agents>, id: u32) -> Result<(), String> {
  agents.stop(id)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Task list of the open folder; empty with no folder open.
#[tauri::command]
pub fn tasks_load(ws: State<'_, Workspace>) -> Result<Vec<tasks::TaskMeta>, String> {
  ws.current().map_or(Ok(Vec::new()), |root| tasks::load(&root))
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
