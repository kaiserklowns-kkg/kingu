//! Agents: one git worktree per task, a Claude Agent SDK session running in it (via the agent
//! host sidecar), and its events streamed to the webview, including permission prompts.

pub mod events;
pub mod host;
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
  ws: State<'_, Workspace>,
  agents: State<'_, Arc<AgentHost>>,
  slug: String,
  prompt: String,
  model: Option<String>,
  permission_mode: Option<String>,
  resume: Option<String>,
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
  let cwd = worktree::worktree_path(&ws.root()?, &slug);
  if !cwd.is_dir() {
    return Err(format!("{slug}: no worktree, create it first"));
  }
  let cwd = cwd.to_str().ok_or("worktree path is not valid UTF-8")?.to_owned();
  let req = host::StartRequest { cwd, prompt, model: model.filter(|m| !m.trim().is_empty()), permission_mode, resume };
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
