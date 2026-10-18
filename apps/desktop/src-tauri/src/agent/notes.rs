//! Review notes on diff lines (Orca's diff comments), per worktree, in
//! `<root>/.kingu/diff-notes.json`: `""` is the folder itself, any other key a task slug. The
//! webview owns each worktree's list; Rust validates it and replaces that worktree's list
//! atomically, so a save for one task never drops another task's notes.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use crate::settings::{kingu_file, read, write_atomic};

use super::worktree::validate_slug;

const FILE: &str = "diff-notes.json";
const VERSION: u32 = 1;
const MAX_NOTES: usize = 500;
const MAX_BODY: usize = 16 * 1024;
const MAX_PATH: usize = 4096;
const MAX_ID: usize = 64;

/// Mirrors the webview's `DiffNote` (diffNotes.ts), itself Orca's `DiffComment`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffNote {
  pub id: String,
  /// Relative to the worktree.
  pub file_path: String,
  /// Inclusive range start; absent for a single line.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub start_line: Option<u32>,
  /// The range end, or the only line; 0 is a note on the whole file.
  pub line_number: u32,
  pub body: String,
  /// Unix milliseconds.
  pub created_at: u64,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub updated_at: Option<u64>,
}

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct NotesFile {
  version: u32,
  worktrees: BTreeMap<String, Vec<DiffNote>>,
}

/// Serializes read-modify-write of the file across concurrent saves.
static LOCK: Mutex<()> = Mutex::new(());

fn path(root: &Path) -> Result<PathBuf, String> {
  kingu_file(root, FILE)
}

fn load_file(root: &Path) -> Result<NotesFile, String> {
  let path = path(root)?;
  let Some(text) = read(&path)? else { return Ok(NotesFile { version: VERSION, ..Default::default() }) };
  let file: NotesFile = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
  if file.version > VERSION {
    return Err(format!("{}: written by a newer Kingu (version {})", path.display(), file.version));
  }
  Ok(file)
}

/// `""` (the folder) or a task slug.
pub fn validate_key(key: &str) -> Result<(), String> {
  if key.is_empty() { Ok(()) } else { validate_slug(key) }
}

pub fn validate(notes: &[DiffNote]) -> Result<(), String> {
  if notes.len() > MAX_NOTES {
    return Err(format!("more than {MAX_NOTES} notes"));
  }
  let mut ids = std::collections::HashSet::new();
  for n in notes {
    if n.id.is_empty() || n.id.len() > MAX_ID || !n.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
      return Err("invalid note id".into());
    }
    if !ids.insert(n.id.as_str()) {
      return Err(format!("{}: duplicate note", n.id));
    }
    let rel = Path::new(&n.file_path);
    if n.file_path.is_empty() || n.file_path.len() > MAX_PATH || !rel.components().all(|c| matches!(c, Component::Normal(_))) {
      return Err(format!("{}: note path must be relative to the worktree", n.file_path));
    }
    if n.body.trim().is_empty() || n.body.len() > MAX_BODY {
      return Err(format!("{}: note must be 1-{MAX_BODY} bytes", n.id));
    }
    if let Some(start) = n.start_line
      && (start == 0 || start > n.line_number)
    {
      return Err(format!("{}: range start after its end", n.id));
    }
  }
  Ok(())
}

/// Every worktree's notes; empty when the file does not exist yet.
pub fn load(root: &Path) -> Result<BTreeMap<String, Vec<DiffNote>>, String> {
  Ok(load_file(root)?.worktrees)
}

/// Replaces worktree `key`'s notes (an empty list forgets the worktree).
pub fn save(root: &Path, key: &str, notes: &[DiffNote]) -> Result<(), String> {
  validate_key(key)?;
  validate(notes)?;
  let _guard = LOCK.lock().map_err(|_| "notes lock poisoned")?;
  let mut file = load_file(root)?;
  file.version = VERSION;
  if notes.is_empty() {
    if file.worktrees.remove(key).is_none() {
      return Ok(());
    }
  } else {
    file.worktrees.insert(key.to_owned(), notes.to_vec());
  }
  let text = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
  write_atomic(&path(root)?, &(text + "\n"))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn note(id: &str, line: u32) -> DiffNote {
    DiffNote {
      id: id.into(),
      file_path: "src/a.ts".into(),
      start_line: Some(line.saturating_sub(2).max(1)),
      line_number: line,
      body: "เปลี่ยนชื่อ \"x\"\nและเพิ่ม test".into(),
      created_at: 10,
      updated_at: None,
    }
  }

  #[test]
  fn saves_each_worktree_apart_and_round_trips() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(load(tmp.path()).unwrap().is_empty());
    save(tmp.path(), "task-a", &[note("n1", 5), note("n2", 9)]).unwrap();
    save(tmp.path(), "", &[note("f1", 1)]).unwrap();
    let all = load(tmp.path()).unwrap();
    assert_eq!(all["task-a"], [note("n1", 5), note("n2", 9)]);
    assert_eq!(all[""], [note("f1", 1)]);
    // A save of one worktree leaves the other alone; an empty list forgets the worktree.
    save(tmp.path(), "task-a", &[]).unwrap();
    let all = load(tmp.path()).unwrap();
    assert_eq!(all.keys().collect::<Vec<_>>(), [""]);
    let text = std::fs::read_to_string(tmp.path().join(".kingu/diff-notes.json")).unwrap();
    assert!(text.contains("\"filePath\": \"src/a.ts\"") && text.contains("\"lineNumber\": 1"), "camelCase like the webview: {text}");
    assert!(!text.contains("updatedAt"), "absent fields stay out");
  }

  #[test]
  fn reads_a_note_without_optional_fields() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir(tmp.path().join(".kingu")).unwrap();
    std::fs::write(
      tmp.path().join(".kingu/diff-notes.json"),
      r#"{"version":1,"worktrees":{"t":[{"id":"a","filePath":"x.rs","lineNumber":0,"body":"whole file","createdAt":1}]}}"#,
    )
    .unwrap();
    let n = &load(tmp.path()).unwrap()["t"][0];
    assert_eq!((n.start_line, n.line_number, n.updated_at), (None, 0, None));
  }

  #[test]
  fn rejects_bad_notes_and_keys() {
    let tmp = tempfile::tempdir().unwrap();
    let bad = |f: fn(&mut DiffNote)| {
      let mut n = note("n1", 5);
      f(&mut n);
      save(tmp.path(), "t", &[n]).is_err()
    };
    assert!(bad(|n| n.file_path = "../etc/passwd".into()));
    assert!(bad(|n| n.file_path = "/abs".into()));
    assert!(bad(|n| n.file_path = String::new()));
    assert!(bad(|n| n.body = "  \n".into()));
    assert!(bad(|n| n.body = "x".repeat(MAX_BODY + 1)));
    assert!(bad(|n| n.start_line = Some(6)));
    assert!(bad(|n| n.start_line = Some(0)));
    assert!(bad(|n| n.id = "a b".into()));
    assert!(save(tmp.path(), "t", &[note("n1", 5), note("n1", 6)]).is_err());
    assert!(save(tmp.path(), "../x", &[note("n1", 5)]).is_err());
    assert!(!tmp.path().join(".kingu/diff-notes.json").exists());
  }

  #[cfg(unix)]
  #[test]
  fn refuses_a_symlinked_kingu_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(outside.path(), tmp.path().join(".kingu")).unwrap();
    assert!(save(tmp.path(), "t", &[note("n1", 5)]).is_err());
    assert!(load(tmp.path()).is_err());
  }
}
