//! Automations (Orca-style): agent tasks that start on a schedule, kept per repository in
//! `<root>/.kingu/automations.json`. The webview owns the list, parses schedules and runs them
//! while Kingu is open; Rust validates the whole list and writes it atomically, like tasks.json.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::settings::{kingu_file, read, write_atomic};

use super::worktree::validate_slug;

const FILE: &str = "automations.json";
const VERSION: u32 = 1;
const MAX_AUTOMATIONS: usize = 100;
const MAX_NAME: usize = 100;
const MAX_PROMPT: usize = 64 * 1024;
const MAX_SCHEDULE: usize = 120;
const MAX_REASON: usize = 500;
pub const MODES: &[&str] = &["terminal", "timeline"];

/// A due run that did not start (the previous run still working, or missed with catch-up off).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Skip {
  /// Unix milliseconds.
  pub at: u64,
  pub reason: String,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Automation {
  pub id: String,
  pub name: String,
  pub prompt: String,
  /// `daily HH:MM`, `weekdays HH:MM`, `weekly mon,fri HH:MM`, `every 30m` or 5-field cron;
  /// parsed by the webview (ade/schedule.ts).
  pub schedule: String,
  /// Branch to fork from; `None` = the folder's current branch when it runs.
  #[serde(default)]
  pub base: Option<String>,
  /// `terminal` | `timeline`; `None` = `kingu.agent.runMode` when it runs.
  #[serde(default)]
  pub mode: Option<String>,
  #[serde(default)]
  pub enabled: bool,
  /// Run once on start when a run was due while Kingu was closed.
  #[serde(default = "yes")]
  pub catch_up: bool,
  /// Unix milliseconds (all timestamps below too).
  pub created_at: u64,
  /// When it was last enabled: due times before it never run.
  #[serde(default)]
  pub enabled_at: Option<u64>,
  #[serde(default)]
  pub last_run_at: Option<u64>,
  #[serde(default)]
  pub last_task_slug: Option<String>,
  /// The latest due time already handled (run or skipped): never handled twice.
  #[serde(default)]
  pub last_due_at: Option<u64>,
  /// Informational, refreshed by the webview.
  #[serde(default)]
  pub next_run_at: Option<u64>,
  #[serde(default)]
  pub last_skip: Option<Skip>,
}

fn yes() -> bool {
  true
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct AutomationsFile {
  version: u32,
  automations: Vec<Automation>,
}

pub fn path(root: &Path) -> Result<PathBuf, String> {
  kingu_file(root, FILE)
}

/// Empty when the file does not exist yet.
pub fn load(root: &Path) -> Result<Vec<Automation>, String> {
  let path = path(root)?;
  let Some(text) = read(&path)? else { return Ok(Vec::new()) };
  let file: AutomationsFile = serde_json::from_str(&text).map_err(|e| format!("{}: อ่านไม่ได้ ({e})", path.display()))?;
  if file.version > VERSION {
    return Err(format!("{}: เขียนโดย Kingu รุ่นใหม่กว่า (version {})", path.display(), file.version));
  }
  validate(&file.automations).map_err(|e| format!("{}: {e}", path.display()))?;
  Ok(file.automations)
}

pub fn validate(list: &[Automation]) -> Result<(), String> {
  if list.len() > MAX_AUTOMATIONS {
    return Err(format!("มี automation ได้ไม่เกิน {MAX_AUTOMATIONS} รายการ"));
  }
  let mut seen = HashSet::new();
  for a in list {
    validate_slug(&a.id).map_err(|e| format!("id ของ automation ไม่ถูกต้อง: {e}"))?;
    if !seen.insert(a.id.as_str()) {
      return Err(format!("{}: id ซ้ำ", a.id));
    }
    let name = a.name.trim();
    if name.is_empty() || a.name.chars().count() > MAX_NAME || a.name.chars().any(char::is_control) {
      return Err(format!("{}: ชื่อต้องยาว 1-{MAX_NAME} ตัวอักษรและไม่มีอักขระควบคุม", a.id));
    }
    if a.prompt.trim().is_empty() {
      return Err(format!("{}: ต้องมีคำสั่งให้ agent", a.id));
    }
    if a.prompt.len() > MAX_PROMPT {
      return Err(format!("{}: คำสั่งยาวเกิน {MAX_PROMPT} ไบต์", a.id));
    }
    let schedule = a.schedule.trim();
    if schedule.is_empty() || a.schedule.len() > MAX_SCHEDULE || !a.schedule.chars().all(|c| c == ' ' || c.is_ascii_graphic()) {
      return Err(format!("{}: ตารางเวลาไม่ถูกต้อง", a.id));
    }
    if let Some(base) = &a.base {
      crate::git::check_rev(base).map_err(|e| format!("{}: branch ไม่ถูกต้อง ({e})", a.id))?;
    }
    if let Some(mode) = &a.mode
      && !MODES.contains(&mode.as_str())
    {
      return Err(format!("{}: ไม่รู้จักโหมด {mode}", a.id));
    }
    if let Some(slug) = &a.last_task_slug {
      validate_slug(slug).map_err(|e| format!("{}: งานล่าสุดไม่ถูกต้อง ({e})", a.id))?;
    }
    if let Some(skip) = &a.last_skip
      && (skip.reason.len() > MAX_REASON || skip.reason.chars().any(char::is_control))
    {
      return Err(format!("{}: เหตุผลที่ข้ามยาวเกิน {MAX_REASON} ไบต์หรือมีอักขระควบคุม", a.id));
    }
  }
  Ok(())
}

pub fn save(root: &Path, list: &[Automation]) -> Result<(), String> {
  validate(list)?;
  let file = AutomationsFile { version: VERSION, automations: list.to_vec() };
  let text = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
  write_atomic(&path(root)?, &(text + "\n"))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn automation(id: &str) -> Automation {
    Automation {
      id: id.into(),
      name: format!("รีวิว dependency {id}"),
      prompt: "ตรวจ dependency ที่ล้าสมัย".into(),
      schedule: "weekly mon,thu 09:00".into(),
      base: Some("main".into()),
      mode: Some("terminal".into()),
      enabled: true,
      catch_up: false,
      created_at: 1,
      enabled_at: Some(2),
      last_run_at: Some(3),
      last_task_slug: Some("deps-review".into()),
      last_due_at: Some(3),
      next_run_at: Some(4),
      last_skip: Some(Skip { at: 5, reason: "งานก่อนหน้ายังทำงานอยู่".into() }),
    }
  }

  #[test]
  fn round_trips_and_starts_empty() {
    let tmp = tempfile::tempdir().unwrap();
    assert_eq!(load(tmp.path()).unwrap(), []);
    let list = vec![automation("a"), automation("b")];
    save(tmp.path(), &list).unwrap();
    assert_eq!(load(tmp.path()).unwrap(), list);
    let names: Vec<_> = std::fs::read_dir(tmp.path().join(".kingu")).unwrap().flatten().map(|e| e.file_name()).collect();
    assert_eq!(names, ["automations.json"], "no temp file left behind");
  }

  #[test]
  fn defaults_are_safe() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir(tmp.path().join(".kingu")).unwrap();
    std::fs::write(
      tmp.path().join(".kingu/automations.json"),
      r#"{"version":1,"automations":[{"id":"x","name":"X","prompt":"p","schedule":"daily 09:00","created_at":5}]}"#,
    )
    .unwrap();
    let a = &load(tmp.path()).unwrap()[0];
    assert!(!a.enabled, "a new automation is off until the user enables it");
    assert!(a.catch_up);
    assert_eq!((a.base.as_deref(), a.mode.as_deref(), a.last_run_at, a.last_due_at), (None, None, None, None));
  }

  #[test]
  fn rejects_invalid_lists() {
    let tmp = tempfile::tempdir().unwrap();
    let bad = |f: fn(&mut Automation)| {
      let mut a = automation("a");
      f(&mut a);
      save(tmp.path(), &[a]).is_err()
    };
    assert!(bad(|a| a.id = "../x".into()));
    assert!(bad(|a| a.id = String::new()));
    assert!(bad(|a| a.name = "  ".into()));
    assert!(bad(|a| a.name = "x".repeat(MAX_NAME + 1)));
    assert!(bad(|a| a.name = "a\nb".into()));
    assert!(bad(|a| a.prompt = " ".into()));
    assert!(bad(|a| a.prompt = "x".repeat(MAX_PROMPT + 1)));
    assert!(bad(|a| a.schedule = String::new()));
    assert!(bad(|a| a.schedule = "daily\n09:00".into()));
    assert!(bad(|a| a.schedule = "x".repeat(MAX_SCHEDULE + 1)));
    assert!(bad(|a| a.base = Some("-x".into())));
    assert!(bad(|a| a.mode = Some("shell".into())));
    assert!(bad(|a| a.last_task_slug = Some("Bad Slug".into())));
    assert!(bad(|a| a.last_skip = Some(Skip { at: 1, reason: "x".repeat(MAX_REASON + 1) })));
    assert!(save(tmp.path(), &[automation("a"), automation("a")]).is_err());
    let many: Vec<_> = (0..=MAX_AUTOMATIONS).map(|i| automation(&format!("a{i}"))).collect();
    assert!(save(tmp.path(), &many).is_err());
    assert!(!tmp.path().join(".kingu/automations.json").exists());
  }

  #[test]
  fn refuses_newer_or_invalid_files() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir(tmp.path().join(".kingu")).unwrap();
    let file = tmp.path().join(".kingu/automations.json");
    std::fs::write(&file, r#"{"version":2,"automations":[]}"#).unwrap();
    assert!(load(tmp.path()).is_err());
    std::fs::write(&file, r#"{"version":1,"automations":[{"id":"x","name":"X","prompt":"p","schedule":"daily 09:00","created_at":5,"mode":"rm -rf"}]}"#).unwrap();
    assert!(load(tmp.path()).is_err());
    std::fs::write(&file, "not json").unwrap();
    assert!(load(tmp.path()).is_err());
  }

  #[cfg(unix)]
  #[test]
  fn refuses_a_symlinked_kingu_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(outside.path(), tmp.path().join(".kingu")).unwrap();
    assert!(save(tmp.path(), &[automation("a")]).is_err());
    assert!(load(tmp.path()).is_err());
  }
}
