//! Kingu Home (the empty editor area): the agent chats to pick up again across every recently
//! opened folder, not only this window's. Each folder's `.kingu/chats.json` is read as it is on
//! disk; the webview puts the open folder's live chats in their place (`home.ts`).
//!
//! Only folders from `recent.json` are read (never a path the page names), and only what the
//! home shows of a chat leaves Rust: no prompt, session or tools.

use std::path::{Path, PathBuf};

use tauri::State;

use super::chats;
use crate::workspace::Recent;

/// Chats taken from one folder, at most (the home shows a handful in all).
const PER_FOLDER: usize = 10;

/// One chat as the home lists it (`HomeChat` in home.ts).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct HomeChat {
  pub root: String,
  pub id: String,
  pub title: String,
  pub runtime: String,
  pub agent: Option<String>,
  pub created_at: u64,
  pub updated_at: u64,
  /// The last run's status (`RunSummary::status`), if it ran.
  pub status: Option<String>,
  /// A turn was running when the folder's list was last saved.
  pub working: bool,
}

/// The folder's chats, newest first, without side chats; none when it has no chats.json or it
/// does not read.
fn folder_chats(root: &Path) -> Vec<HomeChat> {
  let Ok(mut list) = chats::load(root) else { return Vec::new() };
  list.retain(|c| c.side_of.is_none());
  list.sort_by_key(|c| std::cmp::Reverse(c.updated_at.max(c.created_at)));
  list
    .into_iter()
    .take(PER_FOLDER)
    .map(|c| HomeChat {
      root: root.display().to_string(),
      id: c.id,
      title: c.title,
      runtime: c.runtime,
      agent: c.agent,
      created_at: c.created_at,
      updated_at: c.updated_at,
      status: c.last_run.map(|r| r.status),
      working: c.working,
    })
    .collect()
}

pub fn recent_chats(folders: &[PathBuf]) -> Vec<HomeChat> {
  folders.iter().filter(|f| f.is_dir()).flat_map(|f| folder_chats(f)).collect()
}

/// The recently opened folders' chats (each folder's newest `PER_FOLDER`); the webview sorts
/// and cuts them.
#[tauri::command]
pub async fn home_recent_chats(recent: State<'_, Recent>) -> Result<Vec<HomeChat>, String> {
  let folders = recent.data().folders;
  tauri::async_runtime::spawn_blocking(move || recent_chats(&folders)).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn write(root: &Path, json: &str) {
    std::fs::create_dir_all(root.join(".kingu")).unwrap();
    std::fs::write(root.join(".kingu/chats.json"), json).unwrap();
  }

  #[test]
  fn reads_each_folder_newest_first_without_side_chats() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    write(
      a.path(),
      r#"{"version":1,"chats":[
        {"id":"old","title":"Old","cwd":{"kind":"folder"},"created_at":1,"updated_at":2},
        {"id":"new","title":"New","cwd":{"kind":"folder"},"created_at":3,"updated_at":9,"last_run":{"status":"failed","at":9}},
        {"id":"side","title":"Side","cwd":{"kind":"folder"},"created_at":10,"side_of":"new"}
      ]}"#,
    );
    let missing = a.path().join("gone");
    let got = recent_chats(&[a.path().to_path_buf(), b.path().to_path_buf(), missing]);
    let ids: Vec<_> = got.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, ["new", "old"]);
    assert_eq!(got[0].status.as_deref(), Some("failed"));
    assert_eq!(got[0].root, a.path().display().to_string());
    assert_eq!(got[0].runtime, "claude");
  }

  #[test]
  fn a_corrupt_list_reads_as_no_chats() {
    let a = tempfile::tempdir().unwrap();
    write(a.path(), "{not json");
    assert!(recent_chats(&[a.path().to_path_buf()]).is_empty());
  }
}
