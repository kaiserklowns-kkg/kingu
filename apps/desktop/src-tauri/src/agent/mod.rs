//! Agent runner spike: one git worktree per task, a coding-agent CLI running in it,
//! and its output normalized into events for the webview.

pub mod events;
pub mod runner;
pub mod worktree;

use tauri::State;

pub use events::AgentEvent;
pub use runner::Agents;

#[tauri::command]
pub fn agent_stop(agents: State<'_, Agents>, id: u32) -> Result<(), String> {
  agents.stop(id)
}
