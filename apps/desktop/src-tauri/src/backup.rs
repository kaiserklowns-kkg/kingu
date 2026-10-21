//! Backups of unsaved editors (VS Code: IWorkingCopyBackupService, `workingCopyBackupService.ts`).
//! The workbench writes a dirty editor's text here a moment after each change and removes it once
//! the editor is saved or reverted, so unsaved work survives a crash, and with `files.hotExit` a
//! quit. Layout: `<app data>/Backups/<workspace hash>/<key hash>`; like VS Code's backup files the
//! first line is a JSON header (the editor key and its metadata), the rest is the text. Each
//! workspace's folder also says whose it is (`workspace.json`, VS Code's workspaces.json), so at
//! startup [`sweep`] can bring back empty windows with backups, turn the backups of a folder that
//! went away into an empty window's, and delete folders left without backups.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::textfile::hash;
use crate::workspace::{WindowSession, Workspace};

/// The owner file of a backup folder (it has an extension, so [`list`] skips it).
const OWNER: &str = "workspace.json";
/// The folder an older build kept every empty window's backups in.
const LEGACY_EMPTY: &str = "empty";

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

/// The backup folder of one workspace, by its storage key (`None`: an older build's empty window).
/// A single folder's key is its path, so its backups stay where they were.
pub fn folder_dir(base: &Path, key: Option<&str>) -> PathBuf {
  let id = key.map(|k| hash(k.as_bytes())).unwrap_or_else(|| LEGACY_EMPTY.into());
  base.join(&id[..id.len().min(16)])
}

/// Records whose backups `dir` holds (once: a storage key always names the same workspace).
pub fn write_owner(dir: &Path, session: &WindowSession) -> Result<(), String> {
  let file = dir.join(OWNER);
  if file.exists() {
    return Ok(());
  }
  std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
  let owner = WindowSession { bounds: None, ..session.clone() };
  std::fs::write(file, serde_json::to_vec(&owner).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

fn read_owner(dir: &Path) -> Option<WindowSession> {
  serde_json::from_slice(&std::fs::read(dir.join(OWNER)).ok()?).ok()
}

/// At startup, before any window writes (VS Code's backupMainService validation): a folder
/// without backups goes; an empty window's backups come back with their window (returned, to
/// open); the backups of a folder or workspace file that no longer exists, of an untitled
/// workspace no window of the last session had (`known`: their storage keys), and of an older
/// build's shared empty window become a new empty window's (`new_id`), so unsaved work survives.
pub fn sweep(base: &Path, known: &HashSet<String>, exists: impl Fn(&Path) -> bool, mut new_id: impl FnMut() -> String) -> Vec<WindowSession> {
  let Ok(entries) = std::fs::read_dir(base) else { return Vec::new() };
  let mut dirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
  dirs.sort();
  let mut empty = Vec::new();
  for dir in dirs {
    if list(&dir).is_empty() {
      if let Err(e) = std::fs::remove_dir_all(&dir) {
        log::warn!("stale backup {}: {e}", dir.display());
      }
      continue;
    }
    let owner = read_owner(&dir);
    let gone = match &owner {
      // An older build's folder without an owner file stays where it is (it is found by its key).
      None => dir.file_name().is_some_and(|n| n == LEGACY_EMPTY),
      Some(s) if s.folders.is_empty() => s.empty.is_none(),
      Some(s) => match (&s.file, &s.untitled) {
        (Some(f), _) => !exists(f),
        (None, Some(_)) => !s.storage_key().is_some_and(|k| known.contains(&k)) || !s.folders.iter().any(|f| exists(&f.path)),
        (None, None) => !exists(&s.folders[0].path),
      },
    };
    if !gone {
      if let Some(s) = owner.filter(|s| s.folders.is_empty()) {
        empty.push(s);
      }
      continue;
    }
    // Into a new empty window's folder.
    let session = WindowSession { empty: Some(new_id()), ..Default::default() };
    let to = folder_dir(base, session.storage_key().as_deref());
    let moved = std::fs::rename(&dir, &to).map_err(|e| e.to_string()).and_then(|_| {
      let _ = std::fs::remove_file(to.join(OWNER));
      write_owner(&to, &session)
    });
    match moved {
      Ok(()) => empty.push(session),
      Err(e) => log::warn!("backup {}: {e}", dir.display()),
    }
  }
  empty
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

pub fn base_dir(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("Backups"))
}

fn dir_of(app: &AppHandle, ws: &Workspace) -> Result<PathBuf, String> {
  // Per workspace (the folder itself for a single folder, as before); each empty window its own.
  Ok(folder_dir(&base_dir(app)?, ws.storage_key().as_deref()))
}

#[tauri::command]
pub fn backup_write(app: AppHandle, ws: Workspace, key: String, meta: serde_json::Value, content: String) -> Result<(), String> {
  let dir = dir_of(&app, &ws)?;
  write(&dir, &key, meta, &content)?;
  write_owner(&dir, &ws.session())
}

#[tauri::command]
pub fn backup_list(app: AppHandle, ws: Workspace) -> Result<Vec<Header>, String> {
  Ok(list(&dir_of(&app, &ws)?))
}

#[tauri::command]
pub fn backup_read(app: AppHandle, ws: Workspace, key: String) -> Result<Option<Backup>, String> {
  Ok(read(&dir_of(&app, &ws)?, &key))
}

/// Removes one backup, or with no key every backup of the open folder.
#[tauri::command]
pub fn backup_discard(app: AppHandle, ws: Workspace, key: Option<String>) -> Result<(), String> {
  discard(&dir_of(&app, &ws)?, key.as_deref())
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn write_list_read_discard() {
    let base = tempfile::tempdir().unwrap();
    let dir = folder_dir(base.path(), Some("/work/project"));
    assert_ne!(dir, folder_dir(base.path(), Some("/work/other")));
    // Where an older build kept this folder's backups.
    assert_eq!(dir, base.path().join(&hash(b"/work/project")[..16]));
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

  fn folder(path: &Path) -> WindowSession {
    WindowSession { folders: vec![crate::workspace::Folder::new(path.into())], ..Default::default() }
  }

  #[test]
  fn sweep_restores_empty_windows_and_rescues_backups_of_folders_gone() {
    let base = tempfile::tempdir().unwrap();
    let b = base.path();
    let here = tempfile::tempdir().unwrap();
    let save = |s: &WindowSession, key: &str| {
      let dir = folder_dir(b, s.storage_key().as_deref());
      write(&dir, key, json!(null), "text").unwrap();
      write_owner(&dir, s).unwrap();
      dir
    };
    let empty = WindowSession { empty: Some("e1".into()), ..Default::default() };
    save(&empty, "untitled:Untitled-1");
    let kept = save(&folder(here.path()), "a.ts");
    let gone = save(&folder(Path::new("/no/such/folder")), "b.ts");
    let untitled = WindowSession { untitled: Some("u1".into()), ..folder(here.path()) };
    save(&untitled, "c.ts");
    // An older build's shared empty window, and a folder left without backups.
    write(&folder_dir(b, None), "untitled:Untitled-2", json!(null), "x").unwrap();
    let stale = folder_dir(b, Some("/old"));
    write_owner(&stale, &folder(Path::new("/old"))).unwrap();

    let mut ids = (1..).map(|i| format!("n{i}"));
    let known: HashSet<String> = [untitled.storage_key().unwrap()].into();
    let restored = sweep(b, &known, |p| p.exists(), || ids.next().unwrap());
    let mut keys: Vec<_> = restored.iter().map(|s| s.storage_key().unwrap()).collect();
    keys.sort();
    assert_eq!(keys, ["empty:e1", "empty:n1", "empty:n2"]);
    assert!(kept.is_dir() && !gone.exists() && !stale.exists() && !folder_dir(b, None).exists());
    // The rescued backups are the new empty windows' now.
    let rescued: Vec<String> = restored.iter().filter(|s| s.empty.as_deref() != Some("e1")).flat_map(|s| list(&folder_dir(b, s.storage_key().as_deref()))).map(|h| h.key).collect();
    assert_eq!(rescued.len(), 2);
    assert!(rescued.contains(&"b.ts".to_string()) && rescued.contains(&"untitled:Untitled-2".to_string()));
    assert_eq!(read_owner(&folder_dir(b, Some("empty:n1"))).and_then(|s| s.empty).as_deref(), Some("n1"));
    assert_eq!(list(&folder_dir(b, untitled.storage_key().as_deref())).len(), 1);

    // An untitled workspace no window of the last session had: rescued too.
    let again = sweep(b, &HashSet::new(), |p| p.exists(), || "n9".into());
    assert!(again.iter().any(|s| s.empty.as_deref() == Some("n9")));
    assert!(!folder_dir(b, untitled.storage_key().as_deref()).exists());
    assert!(kept.is_dir());
  }
}
