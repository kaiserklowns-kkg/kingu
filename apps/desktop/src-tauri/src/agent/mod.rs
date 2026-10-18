//! Agents: one git worktree per task, a Claude Agent SDK session running in it (via the agent
//! host sidecar), and its events streamed to the webview, including permission prompts.
//! `tasks` persists task metadata and `review` drives the review / merge / PR flow of the
//! Agents view.

pub mod automations;
pub mod cli;
pub mod events;
pub mod hooks;
pub mod host;
pub mod issues;
pub mod notes;
pub mod pr;
pub mod review;
pub mod scripts;
pub mod status_hooks;
pub mod tasks;
pub mod trust;
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
  images: Option<Vec<String>>,
  on_event: Channel<AgentEvent>,
) -> Result<u32, String> {
  worktree::validate_slug(&slug)?;
  let images = images.unwrap_or_default();
  crate::attachments::check_images(&images)?;
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
  let account = {
    use tauri::Manager;
    app.state::<crate::accounts::Accounts>().agent_env(crate::accounts::store::Provider::Claude)?
  };
  let req = host::StartRequest {
    cwd,
    prompt,
    model: model.filter(|m| !m.trim().is_empty()),
    permission_mode,
    resume,
    mcp_servers,
    plugins,
    env: (!account.set.is_empty()).then_some(host::SecretEnv(account.set)),
    unset_env: account.unset,
    images,
  };
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

/// Follow-up message to a running session, with attached image files.
#[tauri::command]
pub async fn agent_send(agents: State<'_, Arc<AgentHost>>, run_id: u32, text: String, images: Option<Vec<String>>) -> Result<(), String> {
  if text.trim().is_empty() {
    return Err("message is empty".into());
  }
  let images = images.unwrap_or_default();
  crate::attachments::check_images(&images)?;
  on_host(&agents, move |a| a.send(run_id, &text, &images)).await
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

/// Review notes of every worktree of the open folder (`""` = the folder); empty with no folder open.
#[tauri::command]
pub fn diff_notes_load(ws: State<'_, Workspace>) -> Result<std::collections::BTreeMap<String, Vec<notes::DiffNote>>, String> {
  ws.current().map_or(Ok(Default::default()), |root| notes::load(&root))
}

/// Replaces the review notes of worktree `key` (`""` = the folder, else a task slug).
#[tauri::command]
pub fn diff_notes_save(ws: State<'_, Workspace>, key: String, notes: Vec<notes::DiffNote>) -> Result<(), String> {
  notes::save(&ws.root()?, &key, &notes)
}

/// Commits on the task branch since it forked from `base`, oldest first (prefills the PR form).
#[tauri::command]
pub async fn worktree_commits(ws: State<'_, Workspace>, slug: String, base: String) -> Result<Vec<review::Commit>, String> {
  let dir = review::task_dir(&ws.root()?, &slug)?;
  blocking(move || review::commits_since(&dir, &base)).await
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

const DIFF_TEXT_LIMIT: usize = 2 * 1024 * 1024;

/// Unified diff of a task worktree since its fork point (combined diff view).
#[tauri::command]
pub async fn worktree_diff_text(ws: State<'_, Workspace>, slug: String, base: String) -> Result<String, String> {
  let dir = review::task_dir(&ws.root()?, &slug)?;
  blocking(move || {
    let mb = review::merge_base(&dir, &base)?;
    review::diff_text(&dir, &mb, DIFF_TEXT_LIMIT)
  })
  .await
}

/// Unified diff of the open folder's working tree against HEAD (combined diff view).
#[tauri::command]
pub async fn git_diff_text(ws: State<'_, Workspace>) -> Result<String, String> {
  let root = ws.root()?;
  blocking(move || review::diff_text(&root, "HEAD", DIFF_TEXT_LIMIT)).await
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

/// The task branch's pull request and its CI checks (`None` when there is no PR yet). An empty
/// `slug` is the open folder itself: the PR of its checked-out branch (the ADE's Checks tab).
#[tauri::command]
pub async fn worktree_pr_status(ws: State<'_, Workspace>, slug: String) -> Result<Option<review::PrStatus>, String> {
  let root = ws.root()?;
  let gh = review::gh_bin().ok_or(issues::GH_MISSING)?;
  if slug.is_empty() {
    return blocking(move || review::pr_status(&gh, &root, None)).await;
  }
  let dir = review::task_dir(&root, &slug)?;
  blocking(move || review::pr_status(&gh, &dir, Some(&slug))).await
}

/// Pushes the task branch and runs `gh pr create`; returns the PR URL.
#[tauri::command]
pub async fn worktree_pr_create(
  ws: State<'_, Workspace>,
  slug: String,
  base: String,
  title: String,
  body: String,
  draft: Option<bool>,
  open: Option<bool>,
) -> Result<String, String> {
  let dir = review::task_dir(&ws.root()?, &slug)?;
  let gh = review::gh_bin().ok_or(issues::GH_MISSING)?;
  let draft = draft.unwrap_or(false);
  let url = blocking(move || {
    let url = review::pr_create(&gh, &dir, &slug, &base, &title, &body, draft)?;
    // kingu.pr.openAfterCreate: best effort, the PR exists either way.
    if open.unwrap_or(false) && url.starts_with("https://") {
      let shown = crate::shell_env::command(&gh).current_dir(&dir).args(["pr", "view", &url, "--web"]).output();
      if !shown.as_ref().is_ok_and(|o| o.status.success()) {
        log::warn!("gh pr view --web {url} failed");
      }
    }
    Ok(url)
  })
  .await?;
  log::info!("opened PR {url}");
  Ok(url)
}

/// Issues of the open folder's GitHub repository (`gh issue list`). `assignee`: `@me` or none.
#[tauri::command]
pub async fn gh_issues_list(
  ws: State<'_, Workspace>,
  state: Option<String>,
  assignee: Option<String>,
  label: Option<String>,
  search: Option<String>,
  limit: Option<u32>,
) -> Result<Vec<issues::Issue>, String> {
  let root = ws.root()?;
  let gh = review::gh_bin().ok_or(issues::GH_MISSING)?;
  let q = issues::IssueQuery { state: state.unwrap_or_else(|| "open".into()), assignee, label, search, limit: limit.unwrap_or(50) };
  blocking(move || issues::list(&gh, &root, &q)).await
}

/// One issue with its latest comments (`gh issue view`).
#[tauri::command]
pub async fn gh_issue_view(ws: State<'_, Workspace>, number: u64) -> Result<issues::IssueDetail, String> {
  let root = ws.root()?;
  let gh = review::gh_bin().ok_or(issues::GH_MISSING)?;
  blocking(move || issues::view(&gh, &root, number)).await
}

/// Comments on an issue (only when `kingu.issues.commentOnPr` is on; the webview decides).
#[tauri::command]
pub async fn gh_issue_comment(ws: State<'_, Workspace>, number: u64, body: String) -> Result<(), String> {
  let root = ws.root()?;
  let gh = review::gh_bin().ok_or(issues::GH_MISSING)?;
  blocking(move || issues::comment(&gh, &root, number, &body)).await?;
  log::info!("commented on issue #{number}");
  Ok(())
}

/// Opens the issue on GitHub in the default browser.
#[tauri::command]
pub async fn gh_issue_open(ws: State<'_, Workspace>, number: u64) -> Result<(), String> {
  let root = ws.root()?;
  let gh = review::gh_bin().ok_or(issues::GH_MISSING)?;
  blocking(move || issues::open_web(&gh, &root, number)).await
}

/// Where a PR command runs: the task worktree `slug`, or the open folder for `''` (the ADE's
/// Checks tab of the folder itself).
fn pr_dir(ws: &Workspace, slug: &str) -> Result<std::path::PathBuf, String> {
  let root = ws.root()?;
  if slug.is_empty() { Ok(root) } else { review::task_dir(&root, slug) }
}

/// Merges the PR (`merge`, `squash` or `rebase`) after re-checking it on GitHub (Orca's merge);
/// `delete_branch` also deletes its head branch on GitHub. The webview confirms first.
#[tauri::command]
pub async fn worktree_pr_merge(
  ws: State<'_, Workspace>,
  slug: String,
  url: String,
  number: u64,
  method: String,
  delete_branch: Option<bool>,
) -> Result<pr::MergeOutcome, String> {
  let dir = pr_dir(&ws, &slug)?;
  let gh = review::gh_bin().ok_or(issues::GH_MISSING)?;
  let method = pr::MergeMethod::parse(&method)?;
  blocking(move || pr::merge(&gh, &dir, &url, number, method, delete_branch.unwrap_or(false))).await
}

/// Merge methods the PR's repository allows and the viewer's default (`gh repo view`).
#[tauri::command]
pub async fn gh_merge_settings(ws: State<'_, Workspace>, slug: String, url: String) -> Result<pr::RepoMergeSettings, String> {
  let dir = pr_dir(&ws, &slug)?;
  let gh = review::gh_bin().ok_or(issues::GH_MISSING)?;
  let repo = pr::RepoRef::from_pr_url(&url)?;
  blocking(move || pr::merge_settings(&gh, &dir, &repo)).await
}

/// Log excerpts of failed checks' GitHub Actions jobs, for the "fix failing checks" prompt.
#[tauri::command]
pub async fn worktree_pr_check_logs(ws: State<'_, Workspace>, slug: String, url: String, checks: Vec<pr::CheckRef>) -> Result<Vec<pr::CheckLog>, String> {
  let dir = pr_dir(&ws, &slug)?;
  let gh = review::gh_bin().ok_or(issues::GH_MISSING)?;
  blocking(move || pr::check_logs(&gh, &dir, &url, &checks)).await
}

/// Review threads of the PR (resolved ones included; the webview filters).
#[tauri::command]
pub async fn worktree_pr_threads(ws: State<'_, Workspace>, slug: String, url: String, number: u64) -> Result<Vec<pr::ReviewThread>, String> {
  let dir = pr_dir(&ws, &slug)?;
  let gh = review::gh_bin().ok_or(issues::GH_MISSING)?;
  blocking(move || pr::review_threads(&gh, &dir, &url, number)).await
}

/// Resolves (or, with `resolve: false`, reopens) a review thread; returns its new state.
#[tauri::command]
pub async fn gh_resolve_thread(ws: State<'_, Workspace>, slug: String, url: String, thread_id: String, resolve: bool) -> Result<bool, String> {
  let dir = pr_dir(&ws, &slug)?;
  let gh = review::gh_bin().ok_or(issues::GH_MISSING)?;
  let done = blocking(move || pr::resolve_thread(&gh, &dir, &url, &thread_id, resolve)).await?;
  log::info!("review thread {}", if done { "resolved" } else { "reopened" });
  Ok(done)
}
