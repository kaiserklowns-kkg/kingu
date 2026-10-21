//! Workspace Trust (VS Code's workspaceTrust.ts): the folders the user trusts, kept in
//! `<config dir>/workspace-trust.json`, and which workspaces were asked about already
//! (`security.workspace.trust.startupPrompt: once`). Trusting a folder trusts everything under it;
//! a workspace is trusted when each of its root folders is (and its `.code-workspace` file, when
//! it has one). The webview resolves trust for its window (workspaceTrust.ts) and gates tasks,
//! debugging and restricted settings; Rust reads the same file for what it decides alone: a
//! language server from a folder's `node_modules/.bin` only starts in a trusted workspace.
//! `security.workspace.trust.enabled: false` (user settings) trusts everything.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::workspace::Workspace;

pub const FILE: &str = "workspace-trust.json";
/// Sent to every window when the list changes (another window may have trusted a parent folder).
pub const CHANGED_EVENT: &str = "workspace-trust://changed";
const ENABLED_KEY: &str = "security.workspace.trust.enabled";
/// Workspaces asked about are remembered up to this many (oldest dropped).
const MAX_PROMPTED: usize = 500;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct TrustData {
  /// Trusted folders (and `.code-workspace` files), absolute paths.
  pub folders: Vec<String>,
  /// Workspace identities the startup prompt was shown for (`startupPrompt: once`).
  pub prompted: Vec<String>,
}

/// `path` is `entry` or inside it (whole components; `/a/bc` is not inside `/a/b`).
pub fn is_within(path: &Path, entry: &Path) -> bool {
  path.starts_with(entry)
}

/// The trusted entry that covers `path` (itself or the nearest trusted parent), if any.
pub fn trusted_by<'a>(path: &Path, trusted: &'a [String]) -> Option<&'a str> {
  trusted.iter().filter(|t| !t.is_empty() && is_within(path, Path::new(t.as_str()))).max_by_key(|t| t.len()).map(String::as_str)
}

/// A workspace with folders: each root, and the workspace file, must be trusted. None for an
/// empty window (its trust is `security.workspace.trust.emptyWindow`, decided by the webview).
pub fn workspace_trusted(roots: &[PathBuf], file: Option<&Path>, trusted: &[String]) -> Option<bool> {
  if roots.is_empty() {
    return None;
  }
  Some(roots.iter().map(PathBuf::as_path).chain(file).all(|p| trusted_by(p, trusted).is_some()))
}

/// Absolute, without repeats, in the order given; relative and empty entries are dropped.
pub fn normalize(folders: &[String]) -> Vec<String> {
  let mut out: Vec<String> = Vec::new();
  for f in folders {
    let t = f.trim();
    let t = if t.len() > 1 { t.trim_end_matches('/') } else { t };
    if Path::new(t).is_absolute() && !out.iter().any(|o| o == t) {
      out.push(t.to_owned());
    }
  }
  out
}

pub fn load(config_dir: &Path) -> TrustData {
  crate::settings::read(&config_dir.join(FILE)).ok().flatten().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save(config_dir: &Path, data: &TrustData) -> Result<(), String> {
  let text = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
  crate::settings::write_atomic(&config_dir.join(FILE), &text)
}

/// Whether Workspace Trust is on (`security.workspace.trust.enabled`, user settings only).
pub fn enabled(config_dir: &Path) -> bool {
  crate::settings::user_value(config_dir, ENABLED_KEY).and_then(|v| v.as_bool()).unwrap_or(true)
}

/// Whether window `ws` may use what its folders bring along (language servers in node_modules).
/// An empty window has no folders to take anything from.
pub fn ws_trusted(config_dir: Option<&Path>, ws: &Workspace) -> bool {
  let Some(dir) = config_dir else { return false };
  if !enabled(dir) {
    return true;
  }
  let session = ws.session();
  let roots: Vec<PathBuf> = session.folders.iter().map(|f| f.path.clone()).collect();
  workspace_trusted(&roots, session.file.as_deref(), &load(dir).folders).unwrap_or(true)
}

/// The folders whose `node_modules/.bin` may provide a language server: all of them when the
/// window is trusted, none in Restricted Mode.
pub fn local_tool_roots(ws: &Workspace, roots: Vec<PathBuf>) -> Vec<PathBuf> {
  if ws_trusted(crate::system::config_dir(), ws) { roots } else { Vec::new() }
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
  app.path().app_config_dir().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workspace_trust_read(app: AppHandle) -> Result<TrustData, String> {
  Ok(load(&config_dir(&app)?))
}

/// Replaces the trusted folders (the Workspace Trust editor and the trust prompt edit the list
/// the page read) and tells every window.
#[tauri::command]
pub fn workspace_trust_set(app: AppHandle, folders: Vec<String>) -> Result<TrustData, String> {
  let dir = config_dir(&app)?;
  let mut data = load(&dir);
  data.folders = normalize(&folders);
  save(&dir, &data)?;
  log::info!("workspace trust: {} trusted folders", data.folders.len());
  let _ = app.emit(CHANGED_EVENT, ());
  Ok(data)
}

/// The startup prompt was shown for workspace `identity` (`startupPrompt: once`).
#[tauri::command]
pub fn workspace_trust_prompted(app: AppHandle, identity: String) -> Result<(), String> {
  let dir = config_dir(&app)?;
  let mut data = load(&dir);
  if data.prompted.contains(&identity) {
    return Ok(());
  }
  data.prompted.push(identity);
  let extra = data.prompted.len().saturating_sub(MAX_PROMPTED);
  data.prompted.drain(..extra);
  save(&dir, &data)
}

// ---------------------------------------------------------------------------------------------
// Trusted Domains (outgoing link protection, the webview's trustedDomains.ts): a JSON-with-comments
// list in `<config dir>/trusted-domains.json`, edited in an editor tab like VS Code's file.

pub const DOMAINS_FILE: &str = "trusted-domains.json";

#[derive(Debug, Serialize)]
pub struct DomainsFile {
  pub path: String,
  /// None: no file yet (nothing trusted but localhost).
  pub content: Option<String>,
}

#[tauri::command]
pub fn trusted_domains_read(app: AppHandle) -> Result<DomainsFile, String> {
  let path = config_dir(&app)?.join(DOMAINS_FILE);
  Ok(DomainsFile { content: crate::settings::read(&path)?, path: path.display().to_string() })
}

/// Writes the list (the page edits the text, so comments stay).
#[tauri::command]
pub fn trusted_domains_write(app: AppHandle, content: String) -> Result<(), String> {
  crate::settings::write_atomic(&config_dir(&app)?.join(DOMAINS_FILE), &content)
}

/// Manage Trusted Domains: the file (created from `template` when missing), allowed to open as an
/// editor outside the workspace. Returns its path.
#[tauri::command]
pub fn trusted_domains_open(app: AppHandle, template: String) -> Result<String, String> {
  let path = config_dir(&app)?.join(DOMAINS_FILE);
  if crate::settings::read(&path)?.is_none() {
    crate::settings::write_atomic(&path, &template)?;
  }
  Ok(app.state::<crate::external::ExternalFiles>().allow(&path).display().to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn list(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
  }

  #[test]
  fn a_trusted_folder_trusts_everything_under_it() {
    let trusted = list(&["/Users/k/TrustedRepos", "/Users/k/TrustedRepos/kingu", "/work/app"]);
    assert_eq!(trusted_by(Path::new("/Users/k/TrustedRepos/kingu/src"), &trusted), Some("/Users/k/TrustedRepos/kingu"));
    assert_eq!(trusted_by(Path::new("/Users/k/TrustedRepos/other"), &trusted), Some("/Users/k/TrustedRepos"));
    assert_eq!(trusted_by(Path::new("/work/app"), &trusted), Some("/work/app"));
    // Whole components only, and never upwards.
    assert_eq!(trusted_by(Path::new("/work/application"), &trusted), None);
    assert_eq!(trusted_by(Path::new("/work"), &trusted), None);
    assert_eq!(trusted_by(Path::new("/x"), &list(&[""])), None);
  }

  #[test]
  fn a_multi_root_workspace_needs_every_folder_and_its_file() {
    let trusted = list(&["/repos", "/w/x.code-workspace"]);
    let roots = [PathBuf::from("/repos/a"), PathBuf::from("/repos/b")];
    assert_eq!(workspace_trusted(&roots, None, &trusted), Some(true));
    assert_eq!(workspace_trusted(&roots, Some(Path::new("/w/x.code-workspace")), &trusted), Some(true));
    assert_eq!(workspace_trusted(&roots, Some(Path::new("/w/y.code-workspace")), &trusted), Some(false));
    assert_eq!(workspace_trusted(&[PathBuf::from("/repos/a"), PathBuf::from("/tmp/c")], None, &trusted), Some(false));
    assert_eq!(workspace_trusted(&[], None, &trusted), None);
  }

  #[test]
  fn keeps_absolute_folders_once() {
    assert_eq!(normalize(&list(&["/a/", " /b ", "rel", "", "/a", "/"])), list(&["/a", "/b", "/"]));
  }

  #[test]
  fn reads_and_writes_the_trust_file() {
    let tmp = tempfile::tempdir().unwrap();
    assert_eq!(load(tmp.path()), TrustData::default());
    let data = TrustData { folders: list(&["/a"]), prompted: list(&["/a"]) };
    save(tmp.path(), &data).unwrap();
    assert_eq!(load(tmp.path()), data);
    std::fs::write(tmp.path().join(FILE), "not json").unwrap();
    assert_eq!(load(tmp.path()), TrustData::default());
    // Only the user's settings turn it off.
    assert!(enabled(tmp.path()));
    std::fs::write(tmp.path().join("settings.json"), r#"{ "security.workspace.trust.enabled": false }"#).unwrap();
    assert!(!enabled(tmp.path()));
  }
}
