//! Durable outbox of task and run states waiting to reach the team server. Persisted as JSON
//! under the app data dir (temp file + rename, so a crash never leaves half a file), coalesced per
//! task (and per run) so only the newest state of each is kept, and bounded.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::payload::{RunSync, TaskSync};

/// Hard cap on queued tasks; the oldest are dropped first.
pub const MAX_ENTRIES: usize = 1000;
const BASE_BACKOFF_MS: u64 = 1_000;
const MAX_BACKOFF_MS: u64 = 5 * 60 * 1000;

/// What an entry delivers. Stored as `"task": {...}` or `"run": {...}` next to the entry's own
/// fields, so outbox files written before runs existed still load.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Item {
  #[serde(rename = "task")]
  Task(TaskSync),
  #[serde(rename = "run")]
  Run(RunSync),
}

impl Item {
  pub fn validate(&self) -> Result<(), String> {
    match self {
      Item::Task(t) => t.validate(),
      Item::Run(r) => r.validate(),
    }
  }

  /// Client time of this state (newest wins).
  pub fn updated_at(&self) -> &str {
    match self {
      Item::Task(t) => &t.updated_at,
      Item::Run(r) => &r.updated_at,
    }
  }

  /// Coalescing key: the task, or the task's run.
  fn key(&self) -> (&str, Option<&str>) {
    match self {
      Item::Task(t) => (&t.client_task_id, None),
      Item::Run(r) => (&r.client_task_id, Some(&r.client_run_id)),
    }
  }

  pub fn is_run(&self) -> bool {
    matches!(self, Item::Run(_))
  }

  /// For logs: ids only.
  pub fn label(&self) -> String {
    match self.key() {
      (task, None) => task.to_owned(),
      (task, Some(run)) => format!("{task} run {run}"),
    }
  }
}

impl From<TaskSync> for Item {
  fn from(t: TaskSync) -> Self {
    Item::Task(t)
  }
}

impl From<RunSync> for Item {
  fn from(r: RunSync) -> Self {
    Item::Run(r)
  }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entry {
  /// Normalized server base URL (see `client::normalize_server_url`).
  pub server: String,
  pub project: String,
  #[serde(flatten)]
  pub item: Item,
  #[serde(default)]
  pub attempts: u32,
  /// Unix ms before which the entry is not retried.
  #[serde(default)]
  pub next_attempt_ms: u64,
  #[serde(default)]
  pub last_error: Option<String>,
}

impl Entry {
  pub fn new(server: String, project: String, item: impl Into<Item>) -> Self {
    Self { server, project, item: item.into(), attempts: 0, next_attempt_ms: 0, last_error: None }
  }

  fn same_key(&self, other: &Entry) -> bool {
    self.server == other.server && self.project == other.project && self.item.key() == other.item.key()
  }

  /// `other` is this very state (not a newer one of the same task or run).
  fn same_state(&self, other: &Entry) -> bool {
    self.same_key(other) && self.item == other.item
  }

  #[cfg(test)]
  pub fn task(&self) -> &TaskSync {
    match &self.item {
      Item::Task(t) => t,
      Item::Run(_) => panic!("not a task entry"),
    }
  }
}

/// Exponential backoff: 1s, 2s, 4s, ... capped at 5 minutes.
pub fn backoff_ms(attempts: u32) -> u64 {
  let exp = attempts.saturating_sub(1).min(20);
  (BASE_BACKOFF_MS << exp).min(MAX_BACKOFF_MS)
}

#[derive(Debug, Default)]
pub struct Outbox {
  path: Option<PathBuf>,
  entries: Vec<Entry>,
}

#[derive(Serialize, Deserialize)]
struct File {
  version: u32,
  entries: Vec<Entry>,
}

impl Outbox {
  /// Loads `path`, starting empty if it is missing. A corrupt file is moved aside rather than
  /// silently overwritten.
  pub fn load(path: PathBuf) -> Self {
    let entries = match std::fs::read(&path) {
      Ok(bytes) => match serde_json::from_slice::<File>(&bytes) {
        Ok(f) => f.entries.into_iter().filter(|e| e.item.validate().is_ok()).collect(),
        Err(e) => {
          log::warn!("team outbox {} unreadable ({e}); moving aside", path.display());
          let _ = std::fs::rename(&path, path.with_extension("json.corrupt"));
          Vec::new()
        }
      },
      Err(_) => Vec::new(),
    };
    Self { path: Some(path), entries }
  }

  #[cfg(test)]
  pub fn in_memory() -> Self {
    Self::default()
  }

  #[cfg(test)]
  pub fn len(&self) -> usize {
    self.entries.len()
  }

  #[cfg(test)]
  pub fn entries(&self) -> &[Entry] {
    &self.entries
  }

  pub fn pending_for(&self, server: &str) -> usize {
    self.entries.iter().filter(|e| e.server == server).count()
  }

  /// Queues a task or run state. A newer state replaces a queued older one for the same task or
  /// run (and resets its backoff); an older state than the queued one is ignored. Returns false if
  /// ignored.
  pub fn enqueue(&mut self, entry: Entry) -> bool {
    if let Some(existing) = self.entries.iter_mut().find(|e| e.same_key(&entry)) {
      if entry.item.updated_at() < existing.item.updated_at() {
        return false;
      }
      *existing = entry;
      return true;
    }
    self.entries.push(entry);
    if self.entries.len() > MAX_ENTRIES {
      let drop = self.entries.len() - MAX_ENTRIES;
      log::warn!("team outbox full; dropping {drop} oldest states");
      self.entries.drain(..drop);
    }
    true
  }

  /// Entries whose retry time has come: tasks before runs (a run needs its task on the server),
  /// oldest first within each.
  pub fn due(&self, now_ms: u64) -> Vec<Entry> {
    let mut due: Vec<Entry> = self.entries.iter().filter(|e| e.next_attempt_ms <= now_ms).cloned().collect();
    due.sort_by_key(|e| (e.item.is_run(), e.next_attempt_ms));
    due
  }

  /// Soonest retry time, if anything is queued.
  pub fn next_due_ms(&self) -> Option<u64> {
    self.entries.iter().map(|e| e.next_attempt_ms).min()
  }

  /// The server accepted `sent`. Removes it unless a newer state was queued meanwhile.
  pub fn complete(&mut self, sent: &Entry) {
    self.entries.retain(|e| !e.same_state(sent));
  }

  /// Sending `sent` failed. Retryable failures back off; permanent ones (validation, 4xx) are
  /// dropped so one bad state cannot block the queue.
  pub fn fail(&mut self, sent: &Entry, now_ms: u64, error: &str, retryable: bool) {
    let Some(i) = self.entries.iter().position(|e| e.same_state(sent)) else { return };
    if !retryable {
      log::warn!("team sync dropped {}: {error}", sent.item.label());
      self.entries.remove(i);
      return;
    }
    let e = &mut self.entries[i];
    e.attempts = e.attempts.saturating_add(1);
    e.next_attempt_ms = now_ms + backoff_ms(e.attempts);
    e.last_error = Some(error.chars().take(200).collect());
  }

  /// Defers every entry for `server` (e.g. not signed in) without counting an attempt.
  pub fn defer_server(&mut self, server: &str, until_ms: u64) {
    for e in self.entries.iter_mut().filter(|e| e.server == server) {
      e.next_attempt_ms = e.next_attempt_ms.max(until_ms);
    }
  }

  /// Makes everything due now (manual "sync now", or after signing in).
  pub fn retry_all_now(&mut self) {
    for e in &mut self.entries {
      e.next_attempt_ms = 0;
    }
  }

  pub fn save(&self) -> std::io::Result<()> {
    let Some(path) = &self.path else { return Ok(()) };
    let bytes = serde_json::to_vec_pretty(&File { version: 1, entries: self.entries.clone() })?;
    write_atomic(path, &bytes)
  }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
  use std::io::Write;
  if let Some(dir) = path.parent() {
    std::fs::create_dir_all(dir)?;
  }
  let tmp = path.with_extension("json.tmp");
  {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
      use std::os::unix::fs::OpenOptionsExt;
      opts.mode(0o600);
    }
    let mut f = opts.open(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
  }
  std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
  use super::super::payload::{sample, sample_run};
  use super::*;

  const S: &str = "https://team.example.com";
  const P: &str = "11111111-1111-1111-1111-111111111111";

  fn entry(id: &str, status: &str, at: &str) -> Entry {
    Entry::new(S.into(), P.into(), sample(id, status, at))
  }

  #[test]
  fn coalesces_per_task_keeping_newest() {
    let mut o = Outbox::in_memory();
    assert!(o.enqueue(entry("a", "running", "2026-10-17T10:00:00Z")));
    assert!(o.enqueue(entry("b", "running", "2026-10-17T10:00:00Z")));
    assert!(o.enqueue(entry("a", "review", "2026-10-17T10:01:00Z")));
    assert!(!o.enqueue(entry("a", "running", "2026-10-17T09:59:00Z")), "older state ignored");
    assert_eq!(o.len(), 2);
    assert_eq!(o.entries()[0].task().status, "review");
  }

  fn run_entry(task: &str, run: &str, at: &str) -> Entry {
    Entry::new(S.into(), P.into(), sample_run(task, run, at))
  }

  #[test]
  fn runs_coalesce_per_run_and_go_after_tasks() {
    let mut o = Outbox::in_memory();
    assert!(o.enqueue(run_entry("a", "r1", "2026-10-17T10:00:00Z")));
    assert!(o.enqueue(entry("a", "running", "2026-10-17T10:00:00Z")));
    assert!(o.enqueue(run_entry("a", "r2", "2026-10-17T10:00:00Z")));
    let mut newer = run_entry("a", "r1", "2026-10-17T10:01:00Z");
    if let Item::Run(r) = &mut newer.item {
      r.cost_usd = Some(1.5);
    }
    assert!(o.enqueue(newer));
    assert!(!o.enqueue(run_entry("a", "r1", "2026-10-17T09:00:00Z")), "older run state ignored");
    assert_eq!(o.len(), 3, "task + two runs; a run does not replace its task");
    let due = o.due(0);
    assert!(!due[0].item.is_run(), "the task goes first");
    let r1 = due.iter().find_map(|e| match &e.item {
      Item::Run(r) if r.client_run_id == "r1" => Some(r),
      _ => None,
    });
    assert_eq!(r1.unwrap().cost_usd, Some(1.5));
  }

  #[test]
  fn reads_outbox_files_from_before_runs() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("team-outbox.json");
    let old = serde_json::json!({"version": 1, "entries": [{
      "server": S, "project": P, "attempts": 2, "next_attempt_ms": 5, "last_error": "503",
      "task": {"client_task_id": "a", "title": "t", "status": "running", "updated_at": "2026-10-17T10:00:00Z"}
    }]});
    std::fs::write(&path, serde_json::to_vec(&old).unwrap()).unwrap();
    let o = Outbox::load(path.clone());
    assert_eq!(o.len(), 1);
    assert_eq!((o.entries()[0].task().client_task_id.as_str(), o.entries()[0].attempts), ("a", 2));
    // Runs round-trip next to tasks.
    let mut o = o;
    o.enqueue(run_entry("a", "r1", "2026-10-17T10:00:00Z"));
    o.save().unwrap();
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(text.contains("\"run\"") && text.contains("\"task\""));
    assert_eq!(Outbox::load(path).entries(), o.entries());
  }

  #[test]
  fn backoff_grows_and_caps() {
    assert_eq!(backoff_ms(1), 1_000);
    assert_eq!(backoff_ms(2), 2_000);
    assert_eq!(backoff_ms(5), 16_000);
    assert_eq!(backoff_ms(30), MAX_BACKOFF_MS);
  }

  #[test]
  fn retry_schedule_and_completion() {
    let mut o = Outbox::in_memory();
    o.enqueue(entry("a", "running", "2026-10-17T10:00:00Z"));
    let sent = o.due(0).remove(0);
    o.fail(&sent, 10_000, "connection refused", true);
    assert!(o.due(10_500).is_empty(), "backing off");
    assert_eq!(o.next_due_ms(), Some(11_000));
    let sent = o.due(11_000).remove(0);
    assert_eq!(sent.attempts, 1);
    o.fail(&sent, 11_000, "503", true);
    assert_eq!(o.entries()[0].attempts, 2);
    assert_eq!(o.next_due_ms(), Some(13_000));
    o.retry_all_now();
    let sent = o.due(0).remove(0);
    o.complete(&sent);
    assert_eq!(o.len(), 0);
  }

  #[test]
  fn newer_state_survives_completion_of_older() {
    let mut o = Outbox::in_memory();
    o.enqueue(entry("a", "running", "2026-10-17T10:00:00Z"));
    let in_flight = o.due(0).remove(0);
    o.enqueue(entry("a", "done", "2026-10-17T10:05:00Z"));
    o.complete(&in_flight);
    assert_eq!(o.len(), 1);
    assert_eq!(o.entries()[0].task().status, "done");
    // A failure report for the stale in-flight state doesn't touch the newer one either.
    o.fail(&in_flight, 0, "x", false);
    assert_eq!(o.len(), 1);
  }

  #[test]
  fn permanent_failures_are_dropped() {
    let mut o = Outbox::in_memory();
    o.enqueue(entry("a", "running", "2026-10-17T10:00:00Z"));
    let sent = o.due(0).remove(0);
    o.fail(&sent, 0, "422 content_not_allowed", false);
    assert_eq!(o.len(), 0);
  }

  #[test]
  fn bounded() {
    let mut o = Outbox::in_memory();
    for i in 0..MAX_ENTRIES + 5 {
      o.enqueue(entry(&format!("t{i}"), "running", "2026-10-17T10:00:00Z"));
    }
    assert_eq!(o.len(), MAX_ENTRIES);
    assert_eq!(o.entries()[0].task().client_task_id, "t5");
  }

  #[test]
  fn persists_and_reloads() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("team-outbox.json");
    let mut o = Outbox::load(path.clone());
    o.enqueue(entry("a", "running", "2026-10-17T10:00:00Z"));
    let sent = o.due(0).remove(0);
    o.fail(&sent, 5_000, "offline", true);
    o.save().unwrap();
    let back = Outbox::load(path.clone());
    assert_eq!(back.entries(), o.entries());
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }
    assert!(!path.with_extension("json.tmp").exists());
  }

  #[test]
  fn corrupt_file_is_moved_aside() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("team-outbox.json");
    std::fs::write(&path, b"{not json").unwrap();
    let o = Outbox::load(path.clone());
    assert_eq!(o.len(), 0);
    assert!(path.with_extension("json.corrupt").exists());
  }

  #[test]
  fn invalid_entries_are_dropped_on_load() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("team-outbox.json");
    let mut o = Outbox::load(path.clone());
    o.enqueue(entry("ok", "running", "2026-10-17T10:00:00Z"));
    let mut bad = entry("bad", "running", "2026-10-17T10:00:00Z");
    if let Item::Task(t) = &mut bad.item {
      t.title = "diff --git a/x b/x".into();
    }
    o.entries.push(bad);
    let mut bad_run = run_entry("bad", "r", "2026-10-17T10:00:00Z");
    if let Item::Run(r) = &mut bad_run.item {
      r.cost_usd = Some(-1.0);
    }
    o.entries.push(bad_run);
    o.save().unwrap();
    assert_eq!(Outbox::load(path).len(), 1);
  }
}
