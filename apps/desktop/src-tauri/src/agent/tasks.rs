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
/// Agent host run statuses (`RunStatus` in the webview's agent/events.ts).
pub const RUN_STATUSES: &[&str] = &["starting", "running", "waiting", "idle", "stopped", "failed", "done"];
const MAX_SESSION_ID: usize = 128;
const MAX_SUMMARY: usize = 2000;
const MAX_ISSUE_URL: usize = 2048;
/// What created a task other than you (Orca's automation / CLI workspace badges); the side bar can hide them.
pub const ORIGINS: &[&str] = &["automation"];

/// The issue a task was started from (its PR says `Fixes #number`, or `Fixes ENG-123` for Linear).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct IssueLink {
  pub number: u64,
  pub url: String,
  pub title: String,
  /// `github` or `linear`; links saved before Linear came are GitHub's.
  #[serde(default = "github")]
  pub provider: String,
  /// Linear's identifier (`ENG-123`); none for GitHub.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub key: Option<String>,
}

fn github() -> String {
  "github".into()
}

/// How the latest run (or turn) of a task ended, so the Agents view can show it after a restart.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct RunSummary {
  pub status: String,
  /// Unix milliseconds.
  pub at: u64,
  #[serde(default)]
  pub summary: Option<String>,
  #[serde(default)]
  pub error: Option<String>,
  #[serde(default)]
  pub cost_usd: Option<f64>,
  #[serde(default)]
  pub input_tokens: Option<u64>,
  #[serde(default)]
  pub output_tokens: Option<u64>,
  #[serde(default)]
  pub num_turns: Option<u32>,
  /// Unix milliseconds the run (agent process) started; identifies the run for team sync.
  /// Summaries saved before this field have none.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub started_at: Option<u64>,
}

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
  /// Claude session of the latest run; a follow-up resumes it (also after a restart).
  #[serde(default)]
  pub session_id: Option<String>,
  #[serde(default)]
  pub last_run: Option<RunSummary>,
  /// Older tasks.json files have no `issue`.
  #[serde(default)]
  pub issue: Option<IssueLink>,
  /// `automation` for a task an automation started; absent when you started it.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub origin: Option<String>,
}

/// Session ids go to the agent host as `resume`: keep them to plain id characters.
pub fn valid_session_id(id: &str) -> bool {
  !id.is_empty() && id.len() <= MAX_SESSION_ID && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
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
    if let Some(id) = &t.session_id
      && !valid_session_id(id)
    {
      return Err(format!("{}: invalid session id", t.slug));
    }
    if let Some(i) = &t.issue {
      let web = i.url.starts_with("https://") || i.url.starts_with("http://");
      let source = match (i.provider.as_str(), i.key.as_deref()) {
        ("github", None) => true,
        ("linear", Some(k)) => crate::linear::valid_identifier(k),
        _ => false,
      };
      if i.number == 0 || !web || !source || i.url.len() > MAX_ISSUE_URL || i.title.chars().count() > 1000 {
        return Err(format!("{}: invalid issue link", t.slug));
      }
    }
    if let Some(o) = &t.origin
      && !ORIGINS.contains(&o.as_str())
    {
      return Err(format!("{}: unknown origin {o}", t.slug));
    }
    if let Some(r) = &t.last_run {
      if !RUN_STATUSES.contains(&r.status.as_str()) {
        return Err(format!("{}: unknown run status {}", t.slug, r.status));
      }
      if [&r.summary, &r.error].into_iter().flatten().any(|s| s.len() > MAX_SUMMARY) {
        return Err(format!("{}: run summary larger than {MAX_SUMMARY} bytes", t.slug));
      }
      if r.cost_usd.is_some_and(|c| !c.is_finite() || c < 0.0) {
        return Err(format!("{}: invalid run cost", t.slug));
      }
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
      session_id: Some("0b5e-4c1d_9".into()),
      last_run: Some(RunSummary {
        status: "done".into(),
        at: 3,
        summary: Some("agent ทำงานเสร็จ".into()),
        error: None,
        cost_usd: Some(0.0123),
        input_tokens: Some(1200),
        output_tokens: Some(34),
        num_turns: Some(2),
        started_at: Some(1),
      }),
      issue: Some(IssueLink { number: 42, url: "https://github.com/acme/app/issues/42".into(), title: "แก้ login".into(), provider: "github".into(), key: None }),
      origin: Some("automation".into()),
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

  /// Rename (Orca's display name): only the title changes; slug, branch base and session stay.
  #[test]
  fn rename_changes_only_the_title() {
    let tmp = tempfile::tempdir().unwrap();
    save(tmp.path(), &[task("a"), task("b")]).unwrap();
    let mut list = load(tmp.path()).unwrap();
    list[0].title = "แก้หน้า login ใหม่".into();
    save(tmp.path(), &list).unwrap();
    let after = load(tmp.path()).unwrap();
    assert_eq!(after[0].title, "แก้หน้า login ใหม่");
    assert_eq!(TaskMeta { title: task("a").title, ..after[0].clone() }, task("a"));
    assert_eq!(after[1], task("b"));
    list[0].title = "ก".repeat(MAX_TITLE + 1);
    assert!(save(tmp.path(), &list).is_err(), "longer than {MAX_TITLE} characters");
    list[0].title = "ก".repeat(MAX_TITLE);
    assert!(save(tmp.path(), &list).is_ok(), "the limit counts characters, not bytes");
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
    assert_eq!((t.session_id.as_deref(), t.last_run.as_ref(), t.issue.as_ref(), t.origin.as_deref()), (None, None, None, None));
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
    assert!(bad(|t| t.session_id = Some("--resume; rm".into())));
    assert!(bad(|t| t.session_id = Some(String::new())));
    assert!(bad(|t| t.last_run.as_mut().unwrap().status = "weird".into()));
    assert!(bad(|t| t.last_run.as_mut().unwrap().summary = Some("x".repeat(MAX_SUMMARY + 1))));
    assert!(bad(|t| t.last_run.as_mut().unwrap().cost_usd = Some(f64::NAN)));
    assert!(bad(|t| t.issue.as_mut().unwrap().number = 0));
    assert!(bad(|t| t.issue.as_mut().unwrap().url = "javascript:alert(1)".into()));
    assert!(bad(|t| t.issue.as_mut().unwrap().provider = "jira".into()));
    assert!(bad(|t| t.issue.as_mut().unwrap().key = Some("ENG-1".into())));
    assert!(bad(|t| *t.issue.as_mut().unwrap() = IssueLink { provider: "linear".into(), key: Some("ENG 1".into()), ..t.issue.clone().unwrap() }));
    let mut linear = task("b");
    linear.issue = Some(IssueLink { number: 7, url: "https://linear.app/acme/issue/ENG-7/x".into(), title: "t".into(), provider: "linear".into(), key: Some("ENG-7".into()) });
    assert!(validate(&[linear]).is_ok());
    assert!(bad(|t| t.origin = Some("cli; rm".into())));
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
