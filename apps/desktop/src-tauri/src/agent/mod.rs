//! Agents: one git worktree per task, a Claude Agent SDK session running in it (via the agent
//! host sidecar), and its events streamed to the webview, including permission prompts.
//! `tasks` persists task metadata and `review` drives the review / merge / PR flow of the
//! Agents view.

pub mod ai_text;
pub mod automations;
pub mod chat_edits;
pub mod chats;
pub mod cli;
pub mod events;
pub mod hooks;
pub mod hunks;
pub mod host;
pub mod issues;
pub mod kingu_yaml;
pub mod notes;
pub mod open_in;
pub mod pr;
pub mod review;
pub mod rules;
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

use chats::PERMISSION_MODES;

/// Where a run goes: the task worktree `slug` (the ADE), or an explicit `cwd` the webview chose
/// (a chat): the open folder or one of its task worktrees (`chats::resolve_cwd`). `root`, when
/// given, must still be the open folder, so a chat never runs against a folder opened since.
fn run_dir(open_root: &std::path::Path, root: Option<&str>, slug: Option<&str>, cwd: Option<&str>) -> Result<std::path::PathBuf, String> {
  if let Some(r) = root {
    let same = std::fs::canonicalize(r).is_ok_and(|r| r == open_root);
    if !same {
      return Err(crate::tr!(crate::i18n::msg::AgentMsg::ChatFolderChanged, path = r));
    }
  }
  match (cwd, slug) {
    (Some(dir), _) => chats::resolve_cwd(open_root, std::path::Path::new(dir)),
    (None, Some(slug)) => {
      worktree::validate_slug(slug)?;
      let dir = worktree::worktree_path(open_root, slug);
      if !dir.is_dir() {
        return Err(format!("{slug}: no worktree, create it first"));
      }
      Ok(dir)
    }
    (None, None) => Err(crate::tr!(crate::i18n::msg::AgentMsg::NoAgentCwd)),
  }
}

/// Runs the agent and streams its events over `on_event`. Where: the task worktree `slug` (the
/// ADE's calls), or `cwd` (`run_dir`). `chat_id`: the run belongs to that chat of `root`; its
/// events are appended to the chat's transcript and only one run of a chat is live at a time.
/// `resume` continues an earlier session (its `session_id`), refused while a live run holds it.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn agent_start(
  app: tauri::AppHandle,
  ws: State<'_, Workspace>,
  agents: State<'_, Arc<AgentHost>>,
  slug: Option<String>,
  root: Option<String>,
  cwd: Option<String>,
  chat_id: Option<String>,
  prompt: String,
  model: Option<String>,
  permission_mode: Option<String>,
  resume: Option<String>,
  mcp_servers: Option<std::collections::BTreeMap<String, host::McpServer>>,
  plugins: Option<Vec<String>>,
  images: Option<Vec<String>>,
  safety_checks: Option<bool>,
  rules: Option<Vec<String>>,
  on_event: Channel<AgentEvent>,
) -> Result<u32, String> {
  if let Some(id) = chat_id.as_deref() {
    chats::check_id(id)?;
  }
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
  let open_root = ws.root()?;
  let dir = run_dir(&open_root, root.as_deref(), slug.as_deref(), cwd.as_deref())?;
  let cwd = dir.to_str().ok_or("worktree path is not valid UTF-8")?.to_owned();
  // A chat's rules files (kingu.chat.rules.enabled): `rules` are its attached files.
  let system_prompt_append = match rules {
    Some(files) => {
      let (root, dir) = (open_root.clone(), dir.clone());
      tauri::async_runtime::spawn_blocking(move || rules::system_append(&rules::discover(&root, &dir, &files))).await.map_err(|e| e.to_string())?
    }
    None => None,
  };
  let transcript = match chat_id.as_deref() {
    Some(id) => Some(chats::Transcript::new(&open_root, id)?),
    None => None,
  };
  let owner = chat_id.as_deref().map(|id| format!("chat:{}:{id}", open_root.display()));
  let mcp_servers = mcp_servers.filter(|m| !m.is_empty());
  let account = {
    use tauri::Manager;
    app.state::<crate::accounts::Accounts>().agent_env(crate::accounts::store::Provider::Claude)?
  };
  let edits = chat_id.as_ref().map(|id| {
    use tauri::Manager;
    (app.state::<Arc<chat_edits::ChatEdits>>().inner().clone(), open_root.clone(), id.clone(), dir.clone())
  });
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
    snapshots: edits.is_some(),
    safety_checks: safety_checks.filter(|on| !on),
    system_prompt_append,
    owner,
  };
  let resuming = req.resume.is_some();
  let agents = agents.inner().clone();
  let what = match (&chat_id, &slug) {
    (Some(id), _) => format!("chat {id}"),
    (None, Some(slug)) => format!("task {slug}"),
    (None, None) => "folder".into(),
  };
  // Spawning the sidecar and its first answer can take a moment: keep it off the main thread.
  let id = tauri::async_runtime::spawn_blocking(move || {
    agents.start(
      req,
      Arc::new(move |ev| {
        // A chat's edits first: snapshots are stored (not passed on), checkpoints added.
        let events = match &edits {
          Some((edits, root, id, cwd)) => edits.on_event(root, id, cwd, ev),
          None if matches!(ev, AgentEvent::FileSnapshot { .. }) => Vec::new(),
          None => vec![ev],
        };
        for ev in events {
          // Transcript first, so a chat reopened right after an event has it.
          if let Some(t) = &transcript
            && let Err(e) = t.append(&ev)
          {
            log::warn!("chat transcript: {e}");
          }
          let _ = on_event.send(ev);
        }
      }),
    )
  })
  .await
  .map_err(|e| e.to_string())??;
  log::info!("agent run {id} started for {what}{}", if resuming { " (resumed)" } else { "" });
  Ok(id)
}

/// Changes a live run's model and/or permission mode from its next response on.
#[tauri::command]
pub async fn agent_set_options(agents: State<'_, Arc<AgentHost>>, run_id: u32, model: Option<String>, permission_mode: Option<String>) -> Result<(), String> {
  if let Some(m) = permission_mode.as_deref()
    && !PERMISSION_MODES.contains(&m)
  {
    return Err(format!("{m}: unsupported permission mode"));
  }
  let model = model.filter(|m| !m.trim().is_empty());
  if model.as_deref().is_some_and(|m| m.len() > 128 || !m.chars().all(|c| c.is_ascii_graphic())) {
    return Err("invalid model".into());
  }
  on_host(&agents, move |a| a.set_options(run_id, model.as_deref(), permission_mode.as_deref())).await
}

/// Chats of the open folder; empty with no folder open.
#[tauri::command]
pub fn chats_load(ws: State<'_, Workspace>) -> Result<Vec<chats::ChatMeta>, String> {
  ws.current().map_or(Ok(Vec::new()), |root| chats::load(&root))
}

#[tauri::command]
pub fn chats_save(ws: State<'_, Workspace>, chats: Vec<chats::ChatMeta>) -> Result<(), String> {
  chats::save(&ws.root()?, &chats)
}

/// The chat's saved events (newest `chats::MAX_LOADED_EVENTS`), to rebuild its timeline.
#[tauri::command]
pub async fn chat_transcript_load(ws: State<'_, Workspace>, id: String) -> Result<Vec<AgentEvent>, String> {
  let root = ws.root()?;
  blocking(move || chats::load_transcript(&root, &id)).await
}

/// Deletes the chat's transcript (the webview drops it from chats.json). Refused while it runs.
#[tauri::command]
pub async fn chat_transcript_delete(ws: State<'_, Workspace>, agents: State<'_, Arc<AgentHost>>, id: String, session_id: Option<String>) -> Result<(), String> {
  if session_id.as_deref().is_some_and(|s| agents.session_live(s)) {
    return Err(crate::tr!(crate::i18n::msg::AgentMsg::ChatBusy));
  }
  let root = ws.root()?;
  blocking(move || {
    chats::delete_transcript(&root, &id)?;
    chat_edits::delete(&root, &id)
  })
  .await
}

/// The chat's edits store, with its cwd checked to still be the open folder or one of its task
/// worktrees; `None` before the chat changed any file.
fn edits_store(root: &std::path::Path, id: &str) -> Result<Option<chat_edits::Store>, String> {
  chat_edits::Store::existing(root, id, |cwd| chats::resolve_cwd(root, cwd))
}

/// The chat's working set (files changed and not yet kept or undone) and its requests.
#[tauri::command]
pub async fn chat_edits_list(ws: State<'_, Workspace>, edits: State<'_, Arc<chat_edits::ChatEdits>>, id: String) -> Result<Option<chat_edits::View>, String> {
  let root = ws.root()?;
  let edits = edits.inner().clone();
  blocking(move || {
    edits.with(&root, &id, false, |running| {
      let Some(store) = edits_store(&root, &id)? else { return Ok(None) };
      let prefix = store.cwd().strip_prefix(&root).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
      chat_edits::view(&store, prefix, running).map(Some)
    })
  })
  .await
}

/// The working set's "before" of `path` (relative to the chat's cwd), for its diff.
#[tauri::command]
pub async fn chat_edits_original(ws: State<'_, Workspace>, edits: State<'_, Arc<chat_edits::ChatEdits>>, id: String, path: String) -> Result<String, String> {
  let root = ws.root()?;
  let edits = edits.inner().clone();
  blocking(move || {
    edits.with(&root, &id, false, |_| {
      let store = edits_store(&root, &id)?.ok_or_else(|| crate::tr!(crate::i18n::msg::AgentMsg::EditNotRestorable, path = path.clone()))?;
      chat_edits::original(&store, &path)
    })
  })
  .await
}

/// Keep: `paths` (all with none) leave the working set as they are.
#[tauri::command]
pub async fn chat_edits_keep(ws: State<'_, Workspace>, edits: State<'_, Arc<chat_edits::ChatEdits>>, id: String, paths: Option<Vec<String>>) -> Result<usize, String> {
  let root = ws.root()?;
  let edits = edits.inner().clone();
  blocking(move || {
    edits.with(&root, &id, false, |_| match edits_store(&root, &id)? {
      Some(store) => chat_edits::keep(&store, paths.as_deref()),
      None => Ok(0),
    })
  })
  .await
}

/// Undo: `paths` (all with none) go back to before the agent changed them. Refused while the
/// chat's turn runs; the webview asks first about files with unsaved editor changes.
#[tauri::command]
pub async fn chat_edits_undo(ws: State<'_, Workspace>, edits: State<'_, Arc<chat_edits::ChatEdits>>, id: String, paths: Option<Vec<String>>) -> Result<chat_edits::Report, String> {
  let root = ws.root()?;
  let edits = edits.inner().clone();
  let report = blocking(move || {
    edits.with(&root, &id, true, |_| match edits_store(&root, &id)? {
      Some(store) => chat_edits::undo(&store, paths.as_deref()),
      None => Ok(chat_edits::Report::default()),
    })
  })
  .await?;
  log::info!("chat edits: undid {} file(s), deleted {}", report.restored.len(), report.deleted.len());
  Ok(report)
}

/// The changes (hunks) of working-set file `path` (relative to the chat's cwd): its base against
/// the file on disk, for the editor's Keep / Undo per change.
#[tauri::command]
pub async fn chat_edits_hunks(ws: State<'_, Workspace>, edits: State<'_, Arc<chat_edits::ChatEdits>>, id: String, path: String) -> Result<chat_edits::FileEditHunks, String> {
  let root = ws.root()?;
  let edits = edits.inner().clone();
  blocking(move || {
    edits.with(&root, &id, false, |_| match edits_store(&root, &id)? {
      Some(store) => chat_edits::file_hunks(&store, &path),
      None => Ok(chat_edits::FileEditHunks { path: path.clone(), ..Default::default() }),
    })
  })
  .await
}

/// Keep (`keep`) or Undo one change of `path`; returns the file's changes after it. Refused while
/// the chat's turn runs; Undo writes the file under the git queue lane like file Undo.
#[tauri::command]
pub async fn chat_edits_hunk(
  ws: State<'_, Workspace>,
  edits: State<'_, Arc<chat_edits::ChatEdits>>,
  id: String,
  path: String,
  hunk: String,
  keep: bool,
) -> Result<chat_edits::FileEditHunks, String> {
  let root = ws.root()?;
  let edits = edits.inner().clone();
  let out = blocking(move || {
    edits.with(&root, &id, true, |_| {
      let store = edits_store(&root, &id)?.ok_or_else(|| crate::tr!(crate::i18n::msg::AgentMsg::EditHunkGone, path = path.clone()))?;
      if keep { chat_edits::keep_hunk(&store, &path, &hunk) } else { chat_edits::undo_hunk(&store, &path, &hunk) }
    })
  })
  .await?;
  log::info!("chat edits: {} one change, {} left", if keep { "kept" } else { "undid" }, out.hunks.len());
  Ok(out)
}

/// Restore checkpoint: undoes the changes of request `request` and every later one.
#[tauri::command]
pub async fn chat_edits_restore(ws: State<'_, Workspace>, edits: State<'_, Arc<chat_edits::ChatEdits>>, id: String, request: u32) -> Result<chat_edits::Report, String> {
  let root = ws.root()?;
  let edits = edits.inner().clone();
  let report = blocking(move || {
    edits.with(&root, &id, true, |_| match edits_store(&root, &id)? {
      Some(store) => chat_edits::restore_checkpoint(&store, request),
      None => Err(crate::tr!(crate::i18n::msg::AgentMsg::EditNoRequest, index = request + 1)),
    })
  })
  .await?;
  log::info!("chat edits: restored checkpoint {request} ({} file(s))", report.restored.len() + report.deleted.len());
  Ok(report)
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
/// An AskUserQuestion request is answered with `allow` + `answers` (question text → answer).
#[tauri::command]
pub async fn agent_answer_permission(
  agents: State<'_, Arc<AgentHost>>,
  run_id: u32,
  request_id: String,
  decision: String,
  message: Option<String>,
  answers: Option<std::collections::HashMap<String, String>>,
) -> Result<(), String> {
  on_host(&agents, move |a| a.answer_permission(run_id, &request_id, &decision, message.as_deref(), answers.as_ref())).await
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

/// Applies the webview's task changes to tasks.json as it is on disk now (another window's
/// edits are kept) and returns the stored list.
#[tauri::command]
pub async fn tasks_update(ws: State<'_, Workspace>, changes: Vec<tasks::TaskChange>) -> Result<Vec<tasks::TaskMeta>, String> {
  let root = ws.root()?;
  blocking(move || tasks::update(&root, &changes)).await
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

/// The hunks of one file of the task worktree since it forked from `base` (per-hunk review).
#[tauri::command]
pub async fn worktree_hunks(ws: State<'_, Workspace>, slug: String, base: String, path: String) -> Result<hunks::FileHunks, String> {
  let dir = review::task_dir(&ws.root()?, &slug)?;
  blocking(move || hunks::file_hunks(&dir, &base, &path)).await
}

/// Restores the hunks `ids` of `path` in the task worktree to the fork point; the rest of the file stays.
#[tauri::command]
pub async fn worktree_reject_hunks(ws: State<'_, Workspace>, slug: String, base: String, path: String, ids: Vec<String>) -> Result<usize, String> {
  let dir = review::task_dir(&ws.root()?, &slug)?;
  let n = blocking(move || hunks::reject_hunks(&dir, &base, &path, &ids)).await?;
  log::info!("task {slug}: rejected {n} hunk(s)");
  Ok(n)
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

/// The worktree's pull request, parsed and as gh reports it (`None` when there is none yet); an
/// empty `slug` is the open folder itself. The one PR read every view of a worktree shares.
#[tauri::command]
pub async fn worktree_pr(ws: State<'_, Workspace>, slug: String) -> Result<Option<review::WorktreePr>, String> {
  let root = ws.root()?;
  let gh = review::gh_bin().ok_or_else(issues::gh_missing)?;
  if slug.is_empty() {
    return blocking(move || review::worktree_pr(&gh, &root, None)).await;
  }
  let dir = review::task_dir(&root, &slug)?;
  blocking(move || review::worktree_pr(&gh, &dir, Some(&slug))).await
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
  let gh = review::gh_bin().ok_or_else(issues::gh_missing)?;
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
  let gh = review::gh_bin().ok_or_else(issues::gh_missing)?;
  let q = issues::IssueQuery { state: state.unwrap_or_else(|| "open".into()), assignee, label, search, limit: limit.unwrap_or(50) };
  blocking(move || issues::list(&gh, &root, &q)).await
}

/// One issue with its latest comments (`gh issue view`).
#[tauri::command]
pub async fn gh_issue_view(ws: State<'_, Workspace>, number: u64) -> Result<issues::IssueDetail, String> {
  let root = ws.root()?;
  let gh = review::gh_bin().ok_or_else(issues::gh_missing)?;
  blocking(move || issues::view(&gh, &root, number)).await
}

/// Comments on an issue (only when `kingu.issues.commentOnPr` is on; the webview decides).
#[tauri::command]
pub async fn gh_issue_comment(ws: State<'_, Workspace>, number: u64, body: String) -> Result<(), String> {
  let root = ws.root()?;
  let gh = review::gh_bin().ok_or_else(issues::gh_missing)?;
  blocking(move || issues::comment(&gh, &root, number, &body)).await?;
  log::info!("commented on issue #{number}");
  Ok(())
}

/// Opens the issue on GitHub in the default browser.
#[tauri::command]
pub async fn gh_issue_open(ws: State<'_, Workspace>, number: u64) -> Result<(), String> {
  let root = ws.root()?;
  let gh = review::gh_bin().ok_or_else(issues::gh_missing)?;
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
  let gh = review::gh_bin().ok_or_else(issues::gh_missing)?;
  let method = pr::MergeMethod::parse(&method)?;
  blocking(move || pr::merge(&gh, &dir, &url, number, method, delete_branch.unwrap_or(false))).await
}

/// Merge methods the PR's repository allows and the viewer's default (`gh repo view`).
#[tauri::command]
pub async fn gh_merge_settings(ws: State<'_, Workspace>, slug: String, url: String) -> Result<pr::RepoMergeSettings, String> {
  let dir = pr_dir(&ws, &slug)?;
  let gh = review::gh_bin().ok_or_else(issues::gh_missing)?;
  let repo = pr::RepoRef::from_pr_url(&url)?;
  blocking(move || pr::merge_settings(&gh, &dir, &repo)).await
}

/// Log excerpts of failed checks' GitHub Actions jobs, for the "fix failing checks" prompt.
#[tauri::command]
pub async fn worktree_pr_check_logs(ws: State<'_, Workspace>, slug: String, url: String, checks: Vec<pr::CheckRef>) -> Result<Vec<pr::CheckLog>, String> {
  let dir = pr_dir(&ws, &slug)?;
  let gh = review::gh_bin().ok_or_else(issues::gh_missing)?;
  blocking(move || pr::check_logs(&gh, &dir, &url, &checks)).await
}

/// Review threads of the PR (resolved ones included; the webview filters).
#[tauri::command]
pub async fn worktree_pr_threads(ws: State<'_, Workspace>, slug: String, url: String, number: u64) -> Result<Vec<pr::ReviewThread>, String> {
  let dir = pr_dir(&ws, &slug)?;
  let gh = review::gh_bin().ok_or_else(issues::gh_missing)?;
  blocking(move || pr::review_threads(&gh, &dir, &url, number)).await
}

/// Resolves (or, with `resolve: false`, reopens) a review thread; returns its new state.
#[tauri::command]
pub async fn gh_resolve_thread(ws: State<'_, Workspace>, slug: String, url: String, thread_id: String, resolve: bool) -> Result<bool, String> {
  let dir = pr_dir(&ws, &slug)?;
  let gh = review::gh_bin().ok_or_else(issues::gh_missing)?;
  let done = blocking(move || pr::resolve_thread(&gh, &dir, &url, &thread_id, resolve)).await?;
  log::info!("review thread {}", if done { "resolved" } else { "reopened" });
  Ok(done)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn run_dir_takes_a_task_slug_or_a_checked_cwd() {
    let tmp = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(tmp.path()).unwrap();
    let wt = root.join(".kingu/worktrees/fix-login");
    std::fs::create_dir_all(&wt).unwrap();
    let r = root.to_str().unwrap();
    // The ADE's calls: a slug, no cwd.
    assert_eq!(run_dir(&root, None, Some("fix-login"), None).unwrap(), wt);
    assert!(run_dir(&root, None, Some("gone"), None).unwrap_err().contains("no worktree"));
    assert!(run_dir(&root, None, Some("../x"), None).is_err());
    // Chats: the folder or a task worktree, while that folder is still the open one.
    assert_eq!(run_dir(&root, Some(r), None, Some(r)).unwrap(), root);
    assert_eq!(run_dir(&root, Some(r), None, Some(wt.to_str().unwrap())).unwrap(), wt);
    assert!(run_dir(&root, Some(r), Some("fix-login"), Some("/")).unwrap_err().contains("only in the open folder"), "cwd wins over slug");
    let other = tempfile::tempdir().unwrap();
    assert!(run_dir(&root, Some(other.path().to_str().unwrap()), None, Some(r)).unwrap_err().contains("open folder changed"));
    assert!(run_dir(&root, None, None, None).is_err());
  }
}
