//! The catalogs, one file per area (keeps parallel work from colliding). A new area: add the
//! file, `mod` + `pub use` it here and list its enum in `all()`.

mod accounts;
mod artifacts;
mod agent;
mod arkai;
mod chat_extras;
mod cli;
mod core;
mod forge;
mod git;
mod linear;
mod local_ai;
mod lsp;
mod merge_requests;
mod projects;
mod mcp;
mod runtime;
mod skill;
mod snap;
mod team;
mod trackers;
mod workspace;
mod worktree;

pub use accounts::AccountsMsg;
pub use artifacts::ArtifactMsg;
pub use agent::AgentMsg;
pub use arkai::ArkaiMsg;
pub use chat_extras::ChatExtrasMsg;
pub use cli::CliMsg;
pub use core::CoreMsg;
pub use forge::ForgeMsg;
pub use git::GitMsg;
pub use linear::LinearMsg;
pub use local_ai::LocalAiMsg;
pub use lsp::LspMsg;
pub use merge_requests::MrMsg;
pub use projects::ProjectsMsg;
pub use mcp::McpMsg;
pub use runtime::RuntimeMsg;
pub use skill::SkillMsg;
pub use snap::SnapMsg;
pub use team::TeamMsg;
pub use trackers::TrackerMsg;
pub use workspace::WorkspaceMsg;
pub use worktree::WorktreeMsg;

#[cfg(test)]
use super::{Locale, Message};

/// (id, English, Thai).
#[cfg(test)]
pub type Entry = (&'static str, &'static str, &'static str);

#[cfg(test)]
fn entry<M: Message>(m: M) -> Entry {
  (m.id(), m.text(Locale::En), m.text(Locale::Th))
}

/// Every message of every area: (id, English, Thai).
#[cfg(test)]
pub fn all() -> Vec<Entry> {
  let mut out = Vec::new();
  out.extend(AccountsMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(ArtifactMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(AgentMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(ArkaiMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(ChatExtrasMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(CliMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(CoreMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(ForgeMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(GitMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(LinearMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(LocalAiMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(LspMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(MrMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(ProjectsMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(McpMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(RuntimeMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(SkillMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(SnapMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(TeamMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(TrackerMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(WorkspaceMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(WorktreeMsg::ALL.iter().map(|&m| entry(m)));
  out
}

/// Errors the webview recognises by their text (`src/lib/i18n/rustErrors.ts`): the entry there
/// must be the start of each listed message, in both languages.
#[cfg(test)]
pub fn frontend_matched() -> Vec<(&'static str, Vec<Entry>)> {
  vec![
    ("ghMissing", vec![entry(AgentMsg::GhMissing)]),
    ("remoteAuthFailed", vec![entry(GitMsg::AuthFailed)]),
    (
      "notInstalled",
      [LspMsg::NotExecutable, LspMsg::NotOnPath, LspMsg::NoDebugpy, LspMsg::NoPython, LspMsg::AdapterNotOnPath].into_iter().map(entry).collect(),
    ),
    ("worktreeOrphan", vec![entry(WorktreeMsg::RemoveOrphan)]),
  ]
}
