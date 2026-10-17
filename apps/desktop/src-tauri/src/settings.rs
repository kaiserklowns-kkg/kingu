//! Settings files, like VS Code's user `settings.json` and workspace `.vscode/settings.json`:
//! user settings live in the app config dir, workspace settings in `<workspace>/.kingu/settings.json`.
//! The webview names a scope, never a path. Writes go to a temp file in the same directory and
//! are renamed over the target, so a crash never leaves a half-written settings file.

use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, State};

use crate::workspace::Workspace;

const FILE: &str = "settings.json";
const WORKSPACE_DIR: &str = ".kingu";
const MAX_BYTES: usize = 1024 * 1024;

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct SettingsFile {
  pub path: String,
  /// `None` when the file does not exist yet.
  pub content: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Scope {
  User,
  Workspace,
}

impl Scope {
  pub fn parse(s: &str) -> Result<Self, String> {
    match s {
      "user" => Ok(Self::User),
      "workspace" => Ok(Self::Workspace),
      _ => Err(format!("unknown settings scope: {s}")),
    }
  }
}

/// `<config_dir>/settings.json`.
pub fn user_path(config_dir: &Path) -> PathBuf {
  config_dir.join(FILE)
}

/// `<root>/.kingu/settings.json`, refusing a `.kingu` or `settings.json` that is a symlink
/// (it could point outside the workspace) or a `.kingu` that is not a directory.
pub fn workspace_path(root: &Path) -> Result<PathBuf, String> {
  kingu_file(root, FILE)
}

/// `<root>/.kingu/<name>` for Kingu's own per-folder files (settings, tasks), with the same guards.
pub fn kingu_file(root: &Path, name: &str) -> Result<PathBuf, String> {
  let dir = root.join(WORKSPACE_DIR);
  if let Ok(meta) = std::fs::symlink_metadata(&dir)
    && (meta.file_type().is_symlink() || !meta.is_dir())
  {
    return Err(format!("{}: not a directory", dir.display()));
  }
  let file = dir.join(name);
  if let Ok(meta) = std::fs::symlink_metadata(&file)
    && !meta.is_file()
  {
    return Err(format!("{}: not a regular file", file.display()));
  }
  Ok(file)
}

pub fn read(path: &Path) -> Result<Option<String>, String> {
  match std::fs::read(path) {
    Ok(bytes) if bytes.len() > MAX_BYTES => Err(format!("{}: larger than {MAX_BYTES} bytes", path.display())),
    Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| format!("{}: not UTF-8", path.display())),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(e) => Err(format!("{}: {e}", path.display())),
  }
}

/// Writes `content` to a sibling temp file, syncs it, then renames it over `path`.
pub fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
  if content.len() > MAX_BYTES {
    return Err(format!("settings larger than {MAX_BYTES} bytes"));
  }
  let dir = path.parent().ok_or("settings path has no parent")?;
  let name = path.file_name().and_then(|n| n.to_str()).unwrap_or(FILE);
  std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
  let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
  let result = (|| {
    let mut f = std::fs::File::create(&tmp)?;
    f.write_all(content.as_bytes())?;
    f.sync_all()?;
    std::fs::rename(&tmp, path)
  })();
  if let Err(e) = result {
    let _ = std::fs::remove_file(&tmp);
    return Err(format!("{}: {e}", path.display()));
  }
  Ok(())
}

fn path_for(app: &AppHandle, ws: &Workspace, scope: Scope) -> Result<PathBuf, String> {
  match scope {
    Scope::User => Ok(user_path(&app.path().app_config_dir().map_err(|e| e.to_string())?)),
    Scope::Workspace => workspace_path(&ws.root()?),
  }
}

#[tauri::command]
pub fn settings_read(app: AppHandle, ws: State<'_, Workspace>, scope: String) -> Result<SettingsFile, String> {
  let scope = Scope::parse(&scope)?;
  // No folder open: there are no workspace settings (not an error, which would keep the last
  // folder's values).
  if scope == Scope::Workspace && ws.current().is_none() {
    return Ok(SettingsFile { path: String::new(), content: None });
  }
  let path = path_for(&app, &ws, scope)?;
  Ok(SettingsFile { content: read(&path)?, path: path.display().to_string() })
}

#[tauri::command]
pub fn settings_write(app: AppHandle, ws: State<'_, Workspace>, scope: String, content: String) -> Result<(), String> {
  let path = path_for(&app, &ws, Scope::parse(&scope)?)?;
  write_atomic(&path, &content)?;
  log::info!("saved {scope} settings");
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_only_known_scopes() {
    assert_eq!(Scope::parse("user").unwrap(), Scope::User);
    assert_eq!(Scope::parse("workspace").unwrap(), Scope::Workspace);
    assert!(Scope::parse("../etc").is_err());
  }

  #[test]
  fn missing_file_reads_as_none_and_write_creates_dirs() {
    let tmp = tempfile::tempdir().unwrap();
    let path = workspace_path(tmp.path()).unwrap();
    assert_eq!(path, tmp.path().join(".kingu/settings.json"));
    assert_eq!(read(&path).unwrap(), None);
    write_atomic(&path, "{ \"editor.fontSize\": 14 }").unwrap();
    assert_eq!(read(&path).unwrap().as_deref(), Some("{ \"editor.fontSize\": 14 }"));
    write_atomic(&path, "{}").unwrap();
    assert_eq!(read(&path).unwrap().as_deref(), Some("{}"));
    // No temp files left behind.
    let names: Vec<_> = std::fs::read_dir(path.parent().unwrap()).unwrap().flatten().map(|e| e.file_name()).collect();
    assert_eq!(names, ["settings.json"]);
  }

  #[cfg(unix)]
  #[test]
  fn refuses_symlinked_settings_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(outside.path(), tmp.path().join(".kingu")).unwrap();
    assert!(workspace_path(tmp.path()).is_err());
  }

  #[test]
  fn refuses_oversized_content() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(write_atomic(&tmp.path().join("settings.json"), &" ".repeat(MAX_BYTES + 1)).is_err());
  }
}
