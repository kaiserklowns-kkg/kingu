//! The ledger of `kingu cleanup run` requests: a durable change that carries a request id, so a retry
//! (a lost answer, a script run twice) never removes workspaces twice. The first call with an id
//! runs; the same id while it runs is refused; the same id after it ran gets the first receipt back.
//! Finished receipts are kept in a file (the last `KEEP`), so a retry after Kingu restarted still gets
//! the first receipt. A run that was still going when Kingu quit is not remembered: removing a task
//! is idempotent by itself (the next run only sees what is left), so repeating it can never remove
//! something twice over. A file that cannot be read or written is ignored, never an error.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;

use serde_json::Value;

/// Receipts kept; the oldest go first.
pub const KEEP: usize = 64;

#[derive(Debug, Clone, PartialEq)]
enum State {
  Running,
  Done(Value),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Begin {
  /// First time: the caller runs it and then calls `finish` (or `abort`).
  New,
  /// Another call with this id is still running.
  Running,
  /// It already ran: the first receipt.
  Replay(Value),
}

#[derive(Debug, Default)]
pub struct Ledger {
  order: VecDeque<String>,
  map: HashMap<String, State>,
  file: Option<PathBuf>,
}

impl Ledger {
  /// Keeps finished receipts in `path` from now on, and loads the ones already there. The first
  /// call wins: later calls (every run asks) change nothing.
  pub fn open(&mut self, path: PathBuf) {
    if self.file.is_some() {
      return;
    }
    if let Ok(text) = std::fs::read_to_string(&path)
      && let Ok(rows) = serde_json::from_str::<Vec<(String, Value)>>(&text)
    {
      for (id, receipt) in rows {
        if !self.map.contains_key(&id) {
          self.order.push_back(id.clone());
        }
        self.map.insert(id, State::Done(receipt));
      }
      self.trim();
    }
    self.file = Some(path);
  }

  fn save(&self) {
    let Some(path) = &self.file else { return };
    let rows: Vec<(&String, &Value)> = self.order.iter().filter_map(|id| match self.map.get(id) { Some(State::Done(v)) => Some((id, v)), _ => None }).collect();
    let Ok(text) = serde_json::to_string(&rows) else { return };
    if let Some(dir) = path.parent() {
      let _ = std::fs::create_dir_all(dir);
    }
    // Written beside it and renamed, so a crash never leaves half a file.
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, text).is_ok() {
      let _ = std::fs::rename(&tmp, path);
    }
  }

  pub fn begin(&mut self, id: &str) -> Begin {
    match self.map.get(id) {
      Some(State::Running) => Begin::Running,
      Some(State::Done(v)) => Begin::Replay(v.clone()),
      None => {
        self.map.insert(id.to_owned(), State::Running);
        self.order.push_back(id.to_owned());
        self.trim();
        Begin::New
      }
    }
  }

  pub fn finish(&mut self, id: &str, receipt: Value) {
    if self.map.contains_key(id) {
      self.map.insert(id.to_owned(), State::Done(receipt));
      self.save();
    }
  }

  /// The run failed before it did anything the receipt should remember: the id may be tried again.
  pub fn abort(&mut self, id: &str) {
    if matches!(self.map.get(id), Some(State::Running)) {
      self.map.remove(id);
      self.order.retain(|o| o != id);
    }
  }

  /// A finished run's receipt.
  pub fn receipt(&self, id: &str) -> Option<Value> {
    match self.map.get(id) {
      Some(State::Done(v)) => Some(v.clone()),
      _ => None,
    }
  }

  /// Drops the oldest finished entries past `KEEP` (a running one is never dropped).
  fn trim(&mut self) {
    while self.map.len() > KEEP {
      let Some(pos) = self.order.iter().position(|id| matches!(self.map.get(id), Some(State::Done(_)))) else { break };
      if let Some(id) = self.order.remove(pos) {
        self.map.remove(&id);
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn the_same_id_runs_once_and_then_replays_its_receipt() {
    let mut l = Ledger::default();
    assert_eq!(l.begin("a"), Begin::New);
    assert_eq!(l.begin("a"), Begin::Running, "a second call while it runs does not start another");
    assert_eq!(l.receipt("a"), None);
    l.finish("a", json!({ "removed": ["x"] }));
    assert_eq!(l.begin("a"), Begin::Replay(json!({ "removed": ["x"] })));
    assert_eq!(l.receipt("a"), Some(json!({ "removed": ["x"] })));
  }

  #[test]
  fn an_aborted_run_may_be_tried_again_but_a_finished_one_may_not() {
    let mut l = Ledger::default();
    l.begin("a");
    l.abort("a");
    assert_eq!(l.begin("a"), Begin::New);
    l.finish("a", json!(1));
    l.abort("a");
    assert_eq!(l.begin("a"), Begin::Replay(json!(1)), "abort never erases a receipt");
  }

  #[test]
  fn finished_receipts_survive_a_restart_but_a_running_one_does_not() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("sub").join("cleanup-runs.json");
    let mut first = Ledger::default();
    first.open(file.clone());
    assert_eq!(first.begin("done"), Begin::New);
    first.finish("done", json!({ "removed": ["x"] }));
    assert_eq!(first.begin("going"), Begin::New);
    // A new process: the finished one replays, the one that was running starts over.
    let mut second = Ledger::default();
    second.open(file);
    assert_eq!(second.begin("done"), Begin::Replay(json!({ "removed": ["x"] })));
    assert_eq!(second.begin("going"), Begin::New);
  }

  #[test]
  fn an_unreadable_or_missing_file_is_ignored_and_the_first_open_wins() {
    let dir = tempfile::tempdir().unwrap();
    let bad = dir.path().join("bad.json");
    std::fs::write(&bad, "not json").unwrap();
    let mut l = Ledger::default();
    l.open(bad.clone());
    assert_eq!(l.begin("a"), Begin::New);
    l.finish("a", json!(1));
    // The file is rewritten as soon as a receipt is kept; another path asked later changes nothing.
    l.open(dir.path().join("other.json"));
    assert!(!dir.path().join("other.json").exists());
    let mut again = Ledger::default();
    again.open(bad);
    assert_eq!(again.receipt("a"), Some(json!(1)));
    let mut none = Ledger::default();
    none.open(dir.path().join("missing").join("x.json"));
    assert_eq!(none.begin("b"), Begin::New);
  }

  #[test]
  fn the_file_keeps_only_the_newest_receipts() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("r.json");
    let mut l = Ledger::default();
    l.open(file.clone());
    for i in 0..KEEP + 5 {
      let id = format!("r{i}");
      l.begin(&id);
      l.finish(&id, json!(i));
    }
    let mut loaded = Ledger::default();
    loaded.open(file);
    assert!(loaded.map.len() <= KEEP);
    assert_eq!(loaded.receipt("r0"), None);
    assert_eq!(loaded.receipt(&format!("r{}", KEEP + 4)), Some(json!(KEEP + 4)));
  }

  #[test]
  fn the_oldest_receipts_go_first_and_a_running_one_stays() {
    let mut l = Ledger::default();
    assert_eq!(l.begin("running"), Begin::New);
    for i in 0..KEEP + 5 {
      let id = format!("r{i}");
      l.begin(&id);
      l.finish(&id, json!(i));
    }
    assert!(l.map.len() <= KEEP);
    assert_eq!(l.begin("running"), Begin::Running);
    assert_eq!(l.receipt("r0"), None);
    assert_eq!(l.receipt(&format!("r{}", KEEP + 4)), Some(json!(KEEP + 4)));
  }
}
