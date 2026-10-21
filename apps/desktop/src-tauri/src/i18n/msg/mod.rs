//! The catalogs, one file per area (keeps parallel work from colliding). A new area: add the
//! file, `mod` + `pub use` it here and list its enum in `all()`.

mod accounts;
mod artifacts;
mod agent;
mod arkai;
mod chat_extras;
mod cli;
mod core;
mod files;
mod forge;
mod git;
mod ide_tasks;
mod kingu_yaml;
mod linear;
mod local_ai;
mod local_history;
mod profiles;
mod providers;
mod lsp;
mod merge_requests;
mod projects;
mod mcp;
mod runtime;
mod scm;
mod scm_editor;
mod skill;
mod snap;
mod snippets;
mod system;
mod tasks;
mod team;
mod trackers;
mod usage;
mod voice;
mod workspace;
mod worktree;

pub use accounts::AccountsMsg;
pub use providers::ProvidersMsg;
pub use artifacts::ArtifactMsg;
pub use agent::AgentMsg;
pub use arkai::ArkaiMsg;
pub use chat_extras::ChatExtrasMsg;
pub use cli::CliMsg;
pub use core::CoreMsg;
pub use files::FilesMsg;
pub use forge::ForgeMsg;
pub use git::GitMsg;
pub use ide_tasks::IdeTasksMsg;
pub use kingu_yaml::KinguYamlMsg;
pub use linear::LinearMsg;
pub use local_ai::LocalAiMsg;
pub use local_history::LocalHistoryMsg;
pub use profiles::ProfilesMsg;
pub use lsp::LspMsg;
pub use merge_requests::MrMsg;
pub use projects::ProjectsMsg;
pub use mcp::McpMsg;
pub use runtime::RuntimeMsg;
pub use scm::ScmMsg;
pub use scm_editor::ScmEditorMsg;
pub use skill::SkillMsg;
pub use snap::SnapMsg;
pub use snippets::SnippetsMsg;
pub use system::SystemMsg;
pub use tasks::TasksMsg;
pub use team::TeamMsg;
pub use trackers::TrackerMsg;
pub use usage::UsageMsg;
pub use voice::VoiceMsg;
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
  out.extend(ProvidersMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(ArtifactMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(AgentMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(ArkaiMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(ChatExtrasMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(CliMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(CoreMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(FilesMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(ForgeMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(GitMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(IdeTasksMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(KinguYamlMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(LinearMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(LocalAiMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(LocalHistoryMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(ProfilesMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(LspMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(MrMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(ProjectsMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(McpMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(RuntimeMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(ScmMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(ScmEditorMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(SkillMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(SnapMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(SnippetsMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(SystemMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(TasksMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(TeamMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(TrackerMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(UsageMsg::ALL.iter().map(|&m| entry(m)));
  out.extend(VoiceMsg::ALL.iter().map(|&m| entry(m)));
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
      [LspMsg::NotExecutable, LspMsg::NotOnPath, LspMsg::NoDebugpy, LspMsg::NoPython, LspMsg::AdapterNotOnPath, LspMsg::NoJsDebug, LspMsg::NoNode].into_iter().map(entry).collect(),
    ),
    ("worktreeOrphan", vec![entry(WorktreeMsg::RemoveOrphan)]),
    ("fileExists", vec![entry(FilesMsg::Exists)]),
  ]
}
