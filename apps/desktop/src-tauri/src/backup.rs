//! Backups of unsaved editors (VS Code: IWorkingCopyBackupService, `workingCopyBackupService.ts`).
//! The workbench writes a dirty editor's text here a moment after each change and removes it once
//! the editor is saved or reverted, so unsaved work survives a crash, and with `files.hotExit` a
//! quit. Layout: `<app data>/Backups/<folder hash>/<key hash>`; like VS Code's backup files the
//! first line is a JSON header (the editor key and its metadata), the rest is the text.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, State};

use crate::textfile::hash;
use crate::workspace::Workspace;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct Header {
  /// The editor key (a workspace-relative path, or e.g. the user settings key).
  pub key: String,
  /// Whatever the workbench needs to restore it (encoding, the disk stat it was based on…).
  #[serde(default)]
  pub meta: serde_json::Value,
}

#[derive(Debug, serde::Serialize, PartialEq)]
pub struct Backup {
  #[serde(flatten)]
  pub header: Header,
  pub content: String,
}

/// The backup folder of one workspace folder (`None`: no folder open).
pub fn folder_dir(base: &Path, root: Option<&Path>) -> PathBuf {
  let id = root.map(|r| hash(r.to_string_lossy().as_bytes())).unwrap_or_else(|| "empty".into());
  base.join(&id[..id.len().min(16)])
}

fn file_for(dir: &Path, key: &str) -> PathBuf {
  dir.join(&hash(key.as_bytes())[..32])
}

pub fn write(dir: &Path, key: &str, meta: serde_json::Value, content: &str) -> Result<(), String> {
  std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
  let header = serde_json::to_string(&Header { key: key.into(), meta }).map_err(|e| e.to_string())?;
  // Through a temporary file so a crash mid-write keeps the previous backup.
  let file = file_for(dir, key);
  let tmp = file.with_extension("tmp");
  std::fs::write(&tmp, format!("{header}\n{content}")).map_err(|e| e.to_string())?;
  std::fs::rename(&tmp, &file).map_err(|e| e.to_string())
}

fn parse(text: &str) -> Option<Backup> {
  let (head, content) = text.split_once('\n')?;
  let header: Header = serde_json::from_str(head).ok()?;
  Some(Backup { header, content: content.into() })
}

pub fn read(dir: &Path, key: &str) -> Option<Backup> {
  parse(&std::fs::read_to_string(file_for(dir, key)).ok()?).filter(|b| b.header.key == key)
}

/// Every backup's header (VS Code: getBackups), sorted by key.
pub fn list(dir: &Path) -> Vec<Header> {
  let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
  let mut out: Vec<Header> = entries
    .flatten()
    .filter(|e| e.path().extension().is_none())
    .filter_map(|e| {
      use std::io::BufRead;
      let mut line = String::new();
      std::io::BufReader::new(std::fs::File::open(e.path()).ok()?).read_line(&mut line).ok()?;
      serde_json::from_str::<Header>(line.trim_end()).ok()
    })
    .collect();
  out.sort_by(|a, b| a.key.cmp(&b.key));
  out
}

pub fn discard(dir: &Path, key: Option<&str>) -> Result<(), String> {
  let result = match key {
    Some(k) => std::fs::remove_file(file_for(dir, k)),
    None => std::fs::remove_dir_all(dir),
  };
  match result {
    Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
    _ => Ok(()),
  }
}

fn dir_of(app: &AppHandle, ws: &Workspace) -> Result<PathBuf, String> {
  let base = app.path().app_data_dir().map_err(|e| e.to_string())?.join("Backups");
  Ok(folder_dir(&base, ws.current().as_deref()))
}

#[tauri::command]
pub fn backup_write(app: AppHandle, ws: State<'_, Workspace>, key: String, meta: serde_json::Value, content: String) -> Result<(), String> {
  write(&dir_of(&app, &ws)?, &key, meta, &content)
}

#[tauri::command]
pub fn backup_list(app: AppHandle, ws: State<'_, Workspace>) -> Result<Vec<Header>, String> {
  Ok(list(&dir_of(&app, &ws)?))
}

#[tauri::command]
pub fn backup_read(app: AppHandle, ws: State<'_, Workspace>, key: String) -> Result<Option<Backup>, String> {
  Ok(read(&dir_of(&app, &ws)?, &key))
}

/// Removes one backup, or with no key every backup of the open folder.
#[tauri::command]
pub fn backup_discard(app: AppHandle, ws: State<'_, Workspace>, key: Option<String>) -> Result<(), String> {
  discard(&dir_of(&app, &ws)?, key.as_deref())
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn write_list_read_discard() {
    let base = tempfile::tempdir().unwrap();
    let dir = folder_dir(base.path(), Some(Path::new("/work/project")));
    assert_ne!(dir, folder_dir(base.path(), Some(Path::new("/work/other"))));
    assert_eq!(list(&dir), vec![]);

    write(&dir, "src/a.ts", json!({ "encoding": "utf8", "mtime": 5 }), "let a = 1;\nไทย\n").unwrap();
    write(&dir, "b.txt", json!(null), "first line\nsecond").unwrap();
    // A newer backup of the same editor replaces the old one.
    write(&dir, "b.txt", json!({ "encoding": "windows874" }), "").unwrap();

    let keys: Vec<_> = list(&dir).into_iter().map(|h| h.key).collect();
    assert_eq!(keys, vec!["b.txt", "src/a.ts"]);
    let a = read(&dir, "src/a.ts").unwrap();
    assert_eq!(a.content, "let a = 1;\nไทย\n");
    assert_eq!(a.header.meta["mtime"], 5);
    assert_eq!(read(&dir, "b.txt").unwrap().content, "");
    assert!(read(&dir, "missing").is_none());

    discard(&dir, Some("b.txt")).unwrap();
    discard(&dir, Some("b.txt")).unwrap(); // already gone is fine
    assert_eq!(list(&dir).len(), 1);
    discard(&dir, None).unwrap();
    assert!(!dir.exists());
    discard(&dir, None).unwrap();
  }

  #[test]
  fn corrupt_files_are_skipped() {
    let base = tempfile::tempdir().unwrap();
    let dir = folder_dir(base.path(), None);
    write(&dir, "ok.txt", json!({}), "x").unwrap();
    std::fs::write(dir.join("junk"), "not json\nbody").unwrap();
    std::fs::write(dir.join("half.tmp"), "{}").unwrap();
    assert_eq!(list(&dir).into_iter().map(|h| h.key).collect::<Vec<_>>(), vec!["ok.txt"]);
  }
}
