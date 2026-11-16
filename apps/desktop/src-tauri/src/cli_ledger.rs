//! The ledger of `kingu cleanup run` requests: a durable change that carries a request id, so a retry
//! (a lost answer, a script run twice) never removes workspaces twice. The first call with an id
//! runs; the same id while it runs is refused; the same id after it ran gets the first receipt back.
//! Kept in memory and bounded: removing a task is idempotent by itself (the next run only sees what
//! is left), so a restart losing the ledger can repeat a request, never remove something twice over.

use std::collections::{HashMap, VecDeque};

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
}

impl Ledger {
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
