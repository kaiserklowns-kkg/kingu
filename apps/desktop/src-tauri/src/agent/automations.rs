//! Automations (Orca-style): agent tasks that start on a schedule, kept per repository in
//! `<root>/.kingu/automations.json`. The webview owns the list, parses schedules and runs them
//! while Kingu is open; Rust validates the whole list and writes it atomically, like tasks.json.
//!
//! VS Code 1.145's triggers (`trigger`: manual, hourly, daily, weekdays, weekly, cron) keep their
//! five-field expression in `schedule` and the IANA zone it is evaluated in (`time_zone`); the
//! webview evaluates them (ade/automationCron.ts, a port of VS Code's
//! src/vs/platform/agentHost/common/automationCron.ts). Rust checks their shape only.

use crate::i18n::msg::AgentMsg;
use crate::tr;
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
/// VS Code's local automation intervals (`AutomationInterval` without `once` and `custom`).
pub const TRIGGERS: &[&str] = &["manual", "hourly", "daily", "weekdays", "weekly", "cron"];
const MAX_TIME_ZONE: usize = 64;

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
  /// Always `terminal`; kept for automations saved by an older Kingu.
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
  /// VS Code's trigger kind; `None` = Kingu's own schedule text. Left out of the file when unset,
  /// so an automation saved before triggers existed is written back unchanged.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub trigger: Option<String>,
  /// IANA time zone of a trigger's expression (`Asia/Bangkok`); `None` = the machine's own.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub time_zone: Option<String>,
}

/// A five-field cron shape: fields of digits, letters (month and weekday names), `*`, `,`, `-`, `/`.
fn cron_shaped(expression: &str) -> bool {
  let fields: Vec<_> = expression.split_whitespace().collect();
  fields.len() == 5 && fields.iter().all(|f| f.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '*' | ',' | '-' | '/')))
}

/// An IANA zone name: `Area/Location`, `UTC`, `Etc/GMT+7`.
fn zone_shaped(zone: &str) -> bool {
  !zone.is_empty()
    && zone.len() <= MAX_TIME_ZONE
    && !zone.starts_with('/')
    && !zone.contains("..")
    && zone.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '+'))
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
  let file: AutomationsFile = serde_json::from_str(&text).map_err(|e| tr!(AgentMsg::AutomationsUnreadable, path = path.display(), detail = e))?;
  if file.version > VERSION {
    return Err(tr!(AgentMsg::AutomationsNewer, path = path.display(), version = file.version));
  }
  validate(&file.automations).map_err(|e| format!("{}: {e}", path.display()))?;
  Ok(file.automations)
}

pub fn validate(list: &[Automation]) -> Result<(), String> {
  if list.len() > MAX_AUTOMATIONS {
    return Err(tr!(AgentMsg::TooManyAutomations, max = MAX_AUTOMATIONS));
  }
  let mut seen = HashSet::new();
  for a in list {
    validate_slug(&a.id).map_err(|e| tr!(AgentMsg::BadAutomationId, detail = e))?;
    if !seen.insert(a.id.as_str()) {
      return Err(tr!(AgentMsg::DuplicateAutomationId, id = a.id));
    }
    let name = a.name.trim();
    if name.is_empty() || a.name.chars().count() > MAX_NAME || a.name.chars().any(char::is_control) {
      return Err(tr!(AgentMsg::BadAutomationName, id = a.id, max = MAX_NAME));
    }
    if a.prompt.trim().is_empty() {
      return Err(tr!(AgentMsg::AutomationNoPrompt, id = a.id));
    }
    if a.prompt.len() > MAX_PROMPT {
      return Err(tr!(AgentMsg::AutomationPromptTooLong, id = a.id, max = MAX_PROMPT));
    }
    let schedule = a.schedule.trim();
    if schedule.is_empty() || a.schedule.len() > MAX_SCHEDULE || !a.schedule.chars().all(|c| c == ' ' || c.is_ascii_graphic()) {
      return Err(tr!(AgentMsg::AutomationBadSchedule, id = a.id));
    }
    if let Some(base) = &a.base {
      crate::git::check_rev(base).map_err(|e| tr!(AgentMsg::AutomationBadBranch, id = a.id, detail = e))?;
    }
    if let Some(mode) = &a.mode
      && !MODES.contains(&mode.as_str())
    {
      return Err(tr!(AgentMsg::AutomationUnknownMode, id = a.id, mode));
    }
    if let Some(trigger) = &a.trigger {
      if !TRIGGERS.contains(&trigger.as_str()) {
        return Err(tr!(AgentMsg::AutomationUnknownTrigger, id = a.id, trigger));
      }
      if trigger != "manual" && !cron_shaped(&a.schedule) {
        return Err(tr!(AgentMsg::AutomationBadSchedule, id = a.id));
      }
    }
    if let Some(zone) = &a.time_zone
      && !zone_shaped(zone)
    {
      return Err(tr!(AgentMsg::AutomationBadTimeZone, id = a.id));
    }
    if let Some(slug) = &a.last_task_slug {
      validate_slug(slug).map_err(|e| tr!(AgentMsg::AutomationBadLastTask, id = a.id, detail = e))?;
    }
    if let Some(skip) = &a.last_skip
      && (skip.reason.len() > MAX_REASON || skip.reason.chars().any(char::is_control))
    {
      return Err(tr!(AgentMsg::AutomationBadSkipReason, id = a.id, max = MAX_REASON));
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
      trigger: None,
      time_zone: None,
    }
  }

  fn cron(id: &str, expression: &str) -> Automation {
    Automation { schedule: expression.into(), trigger: Some("cron".into()), time_zone: Some("Asia/Bangkok".into()), ..automation(id) }
  }

  #[test]
  fn keeps_vscode_triggers_and_their_zone() {
    let tmp = tempfile::tempdir().unwrap();
    let manual = Automation { schedule: "manual".into(), trigger: Some("manual".into()), time_zone: None, ..automation("m") };
    let list = vec![cron("c", "0 9,17 * * MON-FRI"), Automation { schedule: "30 * * * *".into(), trigger: Some("hourly".into()), ..automation("h") }, manual];
    save(tmp.path(), &list).unwrap();
    assert_eq!(load(tmp.path()).unwrap(), list);
    let text = std::fs::read_to_string(tmp.path().join(".kingu/automations.json")).unwrap();
    assert!(text.contains(r#""trigger": "cron""#) && text.contains(r#""time_zone": "Asia/Bangkok""#));
  }

  #[test]
  fn an_older_automation_is_written_back_without_trigger_fields() {
    let tmp = tempfile::tempdir().unwrap();
    save(tmp.path(), &[automation("a")]).unwrap();
    let text = std::fs::read_to_string(tmp.path().join(".kingu/automations.json")).unwrap();
    assert!(!text.contains("trigger") && !text.contains("time_zone"), "{text}");
  }

  #[test]
  fn rejects_bad_triggers_expressions_and_zones() {
    let tmp = tempfile::tempdir().unwrap();
    let bad = |a: Automation| save(tmp.path(), &[a]).is_err();
    assert!(bad(Automation { trigger: Some("once".into()), ..cron("a", "0 9 * * *") }));
    assert!(bad(cron("a", "0 9 * *")), "four fields");
    assert!(bad(cron("a", "0 9 * * * *")), "a seconds field");
    assert!(bad(cron("a", "@daily")));
    assert!(bad(cron("a", "0 9 * * $(rm)")));
    assert!(bad(Automation { time_zone: Some("../etc/passwd".into()), ..cron("a", "0 9 * * *") }));
    assert!(bad(Automation { time_zone: Some("/UTC".into()), ..cron("a", "0 9 * * *") }));
    assert!(bad(Automation { time_zone: Some("Asia/Bangkok;x".into()), ..cron("a", "0 9 * * *") }));
    assert!(bad(Automation { time_zone: Some(String::new()), ..cron("a", "0 9 * * *") }));
    assert!(!bad(cron("a", "*/30 8-17 1,15 jan-jun 0-7/2")));
    assert!(!bad(Automation { time_zone: Some("Etc/GMT+7".into()), ..cron("a", "0 9 * * *") }));
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
