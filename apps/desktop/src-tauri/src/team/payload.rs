//! The task metadata the desktop syncs to the team server (`PUT /v1/tasks/{id}/sync`).
//! Validated here with the same rules as the server, so bad payloads fail fast in the app
//! instead of sitting in the outbox. Metadata only: anything that looks like file contents,
//! a diff or a credential is rejected.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

pub const MAX_FIELD_BYTES: usize = 2048;
pub const MAX_TITLE_CHARS: usize = 300;
const MAX_LINES: u32 = 100_000_000;
const MAX_FILES: u32 = 1_000_000;
pub const STATUSES: [&str; 6] = ["backlog", "running", "needs_input", "review", "done", "failed"];

static CLIENT_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9._:-]{1,128}$").unwrap());
static UUID: LazyLock<Regex> =
  LazyLock::new(|| Regex::new(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$").unwrap());
static TIMESTAMP: LazyLock<Regex> =
  LazyLock::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$").unwrap());
static SECRET: LazyLock<Regex> = LazyLock::new(|| {
  Regex::new(
    r"(?i)(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|kgu_[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.)",
  )
  .unwrap()
});
const CONTENT_MARKERS: [&str; 6] = ["diff --git", "@@ -", "+++ b/", "--- a/", "-----BEGIN", "\0"];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiffStats {
  pub additions: u32,
  pub deletions: u32,
  pub files_changed: u32,
}

/// One task state from the webview. Field names match the server's JSON.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskSync {
  pub client_task_id: String,
  pub title: String,
  pub status: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub branch: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub agent: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub model: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub diff_stats: Option<DiffStats>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub started_at: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub finished_at: Option<String>,
  /// RFC 3339 client time of this state; the server ignores states older than the stored one.
  pub updated_at: String,
}

fn screen(field: &str, v: &str) -> Result<(), String> {
  if v.len() > MAX_FIELD_BYTES {
    return Err(format!("{field}: longer than {MAX_FIELD_BYTES} bytes (looks like file contents)"));
  }
  if v.chars().any(char::is_control) {
    return Err(format!("{field}: must be a single line without control characters"));
  }
  if CONTENT_MARKERS.iter().any(|m| v.contains(m)) {
    return Err(format!("{field}: looks like a diff or key material"));
  }
  if SECRET.is_match(v) {
    return Err(format!("{field}: looks like a credential"));
  }
  Ok(())
}

fn text(field: &str, v: &str, max_chars: usize) -> Result<(), String> {
  screen(field, v)?;
  if v.trim().is_empty() {
    return Err(format!("{field}: must not be blank"));
  }
  if v.chars().count() > max_chars {
    return Err(format!("{field}: at most {max_chars} characters"));
  }
  Ok(())
}

/// Subset of `git check-ref-format`, matching the server.
fn git_ref(field: &str, v: &str) -> Result<(), String> {
  text(field, v, 255)?;
  let bad = v.starts_with('-')
    || v.starts_with('/')
    || v.ends_with('/')
    || v.ends_with('.')
    || v.ends_with(".lock")
    || v.contains("..")
    || v.contains("//")
    || v.contains("@{")
    || v.contains([' ', '~', '^', ':', '?', '*', '[', '\\'])
    || v == "@";
  if bad { Err(format!("{field}: not a valid git ref name")) } else { Ok(()) }
}

fn timestamp(field: &str, v: &str) -> Result<(), String> {
  if TIMESTAMP.is_match(v) { Ok(()) } else { Err(format!("{field}: must be an RFC 3339 timestamp")) }
}

pub fn valid_project_id(v: &str) -> bool {
  UUID.is_match(v)
}

impl TaskSync {
  pub fn validate(&self) -> Result<(), String> {
    if !CLIENT_ID.is_match(&self.client_task_id) {
      return Err("client_task_id: must match [A-Za-z0-9._:-]{1,128}".into());
    }
    text("title", &self.title, MAX_TITLE_CHARS)?;
    if !STATUSES.contains(&self.status.as_str()) {
      return Err(format!("status: must be one of {}", STATUSES.join(", ")));
    }
    if let Some(b) = &self.branch {
      git_ref("branch", b)?;
    }
    if let Some(a) = &self.agent {
      text("agent", a, 100)?;
    }
    if let Some(m) = &self.model {
      text("model", m, 200)?;
    }
    if let Some(d) = &self.diff_stats
      && (d.additions > MAX_LINES || d.deletions > MAX_LINES || d.files_changed > MAX_FILES)
    {
      return Err("diff_stats: out of range".into());
    }
    timestamp("updated_at", &self.updated_at)?;
    if let Some(s) = &self.started_at {
      timestamp("started_at", s)?;
    }
    if let Some(f) = &self.finished_at {
      timestamp("finished_at", f)?;
    }
    // Same-format UTC timestamps compare lexically.
    if let (Some(s), Some(f)) = (&self.started_at, &self.finished_at)
      && s.ends_with('Z')
      && f.ends_with('Z')
      && f < s
    {
      return Err("finished_at: must not be before started_at".into());
    }
    Ok(())
  }

  /// The JSON body for `PUT /v1/tasks/{client_task_id}/sync`.
  pub fn wire_body(&self, project_id: &str) -> serde_json::Value {
    let mut v = serde_json::to_value(self).expect("TaskSync serializes");
    let obj = v.as_object_mut().expect("object");
    obj.remove("client_task_id");
    obj.insert("project_id".into(), project_id.into());
    v
  }
}

#[cfg(test)]
pub(crate) fn sample(id: &str, status: &str, updated_at: &str) -> TaskSync {
  TaskSync {
    client_task_id: id.into(),
    title: "Add login page".into(),
    status: status.into(),
    branch: Some("kingu/add-login".into()),
    agent: Some("claude-code".into()),
    model: Some("opus".into()),
    diff_stats: Some(DiffStats { additions: 12, deletions: 3, files_changed: 2 }),
    started_at: Some("2026-10-17T09:00:00Z".into()),
    finished_at: None,
    updated_at: updated_at.into(),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn with(f: impl FnOnce(&mut TaskSync)) -> Result<(), String> {
    let mut t = sample("task-1", "running", "2026-10-17T10:00:00Z");
    f(&mut t);
    t.validate()
  }

  #[test]
  fn accepts_metadata() {
    assert_eq!(with(|_| {}), Ok(()));
    assert_eq!(with(|t| t.title = "เพิ่มหน้าเข้าสู่ระบบ".into()), Ok(()));
    assert_eq!(with(|t| t.updated_at = "2026-10-17T10:00:00.123+07:00".into()), Ok(()));
    assert_eq!(with(|t| (t.branch, t.agent, t.model, t.diff_stats) = (None, None, None, None)), Ok(()));
  }

  #[test]
  fn rejects_bad_fields() {
    type Mutation = Box<dyn FnOnce(&mut TaskSync)>;
    let bad: Vec<(&str, Mutation)> = vec![
      ("client id", Box::new(|t| t.client_task_id = "has space".into())),
      ("blank title", Box::new(|t| t.title = "   ".into())),
      ("long title", Box::new(|t| t.title = "a".repeat(301))),
      ("status", Box::new(|t| t.status = "wip".into())),
      ("branch", Box::new(|t| t.branch = Some("a..b".into()))),
      ("timestamp", Box::new(|t| t.updated_at = "yesterday".into())),
      ("order", Box::new(|t| t.finished_at = Some("2026-10-17T08:00:00Z".into()))),
      ("stats", Box::new(|t| t.diff_stats = Some(DiffStats { additions: u32::MAX, ..Default::default() }))),
    ];
    for (name, f) in bad {
      assert!(with(f).is_err(), "{name} should be rejected");
    }
  }

  #[test]
  fn rejects_content_and_secrets() {
    let content = [
      "x".repeat(MAX_FIELD_BYTES + 1),
      "line 1\nline 2".into(),
      "diff --git a/x b/x".into(),
      "-----BEGIN OPENSSH PRIVATE KEY-----".into(),
      format!("ghp_{}", "a".repeat(36)),
      format!("kgu_{}", "A".repeat(43)),
      format!("AKIA{}", "A".repeat(16)),
    ];
    for c in content {
      assert!(with(|t| t.model = Some(c.clone())).is_err(), "{c:.40} should be rejected");
    }
  }

  #[test]
  fn rejects_unknown_fields() {
    let json = r#"{"client_task_id":"a","title":"t","status":"done","updated_at":"2026-10-17T10:00:00Z","diff":"+x"}"#;
    assert!(serde_json::from_str::<TaskSync>(json).is_err());
    let nested = r#"{"client_task_id":"a","title":"t","status":"done","updated_at":"2026-10-17T10:00:00Z","diff_stats":{"additions":1,"deletions":0,"files_changed":1,"patch":"x"}}"#;
    assert!(serde_json::from_str::<TaskSync>(nested).is_err());
  }

  #[test]
  fn wire_body_moves_id_to_path() {
    let body = sample("task-1", "done", "2026-10-17T10:00:00Z").wire_body("11111111-1111-1111-1111-111111111111");
    assert!(body.get("client_task_id").is_none());
    assert_eq!(body["project_id"], "11111111-1111-1111-1111-111111111111");
    assert_eq!(body["diff_stats"]["additions"], 12);
    assert!(body.get("finished_at").is_none());
  }
}
