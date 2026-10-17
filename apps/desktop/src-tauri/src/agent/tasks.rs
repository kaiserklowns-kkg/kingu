//! Task metadata (title, prompt, base, agent, status…) in `<root>/.kingu/tasks.json`, so the
//! Agents view survives restarts. The webview owns the list and its reducers; Rust validates the
//! whole list and writes it atomically through the same guarded `.kingu` path as settings.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::settings::{kingu_file, read, write_atomic};

use super::worktree::validate_slug;

const FILE: &str = "tasks.json";
const VERSION: u32 = 1;
pub const STATUSES: &[&str] = &["running", "waiting", "review", "done", "failed"];
const MAX_TASKS: usize = 500;
const MAX_TITLE: usize = 200;
const MAX_PROMPT: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct TaskMeta {
  pub slug: String,
  pub title: String,
  #[serde(default)]
  pub prompt: String,
  /// Branch the task forked from and merges back into.
  pub base: String,
  /// Unix milliseconds.
  pub created_at: u64,
  #[serde(default)]
  pub updated_at: u64,
  #[serde(default = "default_agent")]
  pub agent: String,
  #[serde(default)]
  pub model: Option<String>,
  pub status: String,
  #[serde(default)]
  pub pr_url: Option<String>,
  /// Files the user accepted in review.
  #[serde(default)]
  pub accepted: Vec<String>,
  #[serde(default)]
  pub merged_at: Option<u64>,
}

fn default_agent() -> String {
  "claude-code".into()
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct TasksFile {
  version: u32,
  tasks: Vec<TaskMeta>,
}

pub fn path(root: &Path) -> Result<PathBuf, String> {
  kingu_file(root, FILE)
}

/// Empty when the file does not exist yet.
pub fn load(root: &Path) -> Result<Vec<TaskMeta>, String> {
  let path = path(root)?;
  let Some(text) = read(&path)? else { return Ok(Vec::new()) };
  let file: TasksFile = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
  if file.version > VERSION {
    return Err(format!("{}: written by a newer Kingu (version {})", path.display(), file.version));
  }
  Ok(file.tasks)
}

pub fn validate(tasks: &[TaskMeta]) -> Result<(), String> {
  if tasks.len() > MAX_TASKS {
    return Err(format!("more than {MAX_TASKS} tasks"));
  }
  let mut seen = HashSet::new();
  for t in tasks {
    validate_slug(&t.slug)?;
    if !seen.insert(t.slug.as_str()) {
      return Err(format!("{}: duplicate task", t.slug));
    }
    if t.title.trim().is_empty() || t.title.chars().count() > MAX_TITLE {
      return Err(format!("{}: title must be 1-{MAX_TITLE} characters", t.slug));
    }
    if t.prompt.len() > MAX_PROMPT {
      return Err(format!("{}: prompt larger than {MAX_PROMPT} bytes", t.slug));
    }
    crate::git::check_rev(&t.base)?;
    if !STATUSES.contains(&t.status.as_str()) {
      return Err(format!("{}: unknown status {}", t.slug, t.status));
    }
  }
  Ok(())
}

pub fn save(root: &Path, tasks: &[TaskMeta]) -> Result<(), String> {
  validate(tasks)?;
  let text = serde_json::to_string_pretty(&TasksFile { version: VERSION, tasks: tasks.to_vec() }).map_err(|e| e.to_string())?;
  write_atomic(&path(root)?, &(text + "\n"))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn task(slug: &str) -> TaskMeta {
    TaskMeta {
      slug: slug.into(),
      title: format!("งาน {slug}"),
      prompt: "do it".into(),
      base: "main".into(),
      created_at: 1,
      updated_at: 2,
      agent: "claude-code".into(),
      model: Some("opus".into()),
      status: "review".into(),
      pr_url: None,
      accepted: vec!["a.txt".into()],
      merged_at: None,
    }
  }

  #[test]
  fn round_trips_and_starts_empty() {
    let tmp = tempfile::tempdir().unwrap();
    assert_eq!(load(tmp.path()).unwrap(), []);
    let tasks = vec![task("a"), task("b")];
    save(tmp.path(), &tasks).unwrap();
    assert_eq!(load(tmp.path()).unwrap(), tasks);
    let names: Vec<_> = std::fs::read_dir(tmp.path().join(".kingu")).unwrap().flatten().map(|e| e.file_name()).collect();
    assert_eq!(names, ["tasks.json"], "no temp file left behind");
  }

  #[test]
  fn fills_defaults_for_older_files() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir(tmp.path().join(".kingu")).unwrap();
    std::fs::write(
      tmp.path().join(".kingu/tasks.json"),
      r#"{"version":1,"tasks":[{"slug":"x","title":"X","base":"main","created_at":5,"status":"done"}]}"#,
    )
    .unwrap();
    let t = &load(tmp.path()).unwrap()[0];
    assert_eq!((t.agent.as_str(), t.updated_at, t.accepted.len()), ("claude-code", 0, 0));
  }

  #[test]
  fn rejects_invalid_lists() {
    let tmp = tempfile::tempdir().unwrap();
    let bad = |f: fn(&mut TaskMeta)| {
      let mut t = task("a");
      f(&mut t);
      save(tmp.path(), &[t]).is_err()
    };
    assert!(bad(|t| t.slug = "../x".into()));
    assert!(bad(|t| t.title = " ".into()));
    assert!(bad(|t| t.status = "weird".into()));
    assert!(bad(|t| t.base = "-x".into()));
    assert!(save(tmp.path(), &[task("a"), task("a")]).is_err());
    assert!(!tmp.path().join(".kingu/tasks.json").exists());
  }

  #[cfg(unix)]
  #[test]
  fn refuses_a_symlinked_kingu_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(outside.path(), tmp.path().join(".kingu")).unwrap();
    assert!(save(tmp.path(), &[task("a")]).is_err());
    assert!(load(tmp.path()).is_err());
  }
}
