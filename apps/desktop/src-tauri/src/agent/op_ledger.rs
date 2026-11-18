//! Operation ledger and claim for agent-session mutations (start, resume, handoff, follow-up):
//! the same request sent twice runs once. Ported from Orca's host authority
//! (`src/shared/agent-session/agent-session-host-authority.ts`: operation id = 13-digit ms
//! timestamp + 32 hex, future skew, admission age, replay window) and its ledger
//! (`src/shared/agent-session/lifecycle/agent-session-operation-ledger.ts`: evaluate → admit →
//! claim (CAS `pending` → `unknown`) → settle; tombstones expire only by the replay window) and
//! mutation envelope (`agent-session-mutation-envelope.ts`: canonical payload fingerprint).
//!
//! Rules (MECHANICS.md "Agent Supervisor"):
//! - A row is keyed by caller (the session's owner binding) + operation id. The same id with the
//!   same fingerprint replays the recorded outcome; with another fingerprint it is refused
//!   (`conflict`), so a changed payload can never ride on an old id.
//! - `begin` evaluates, admits and claims under one lock: only the winner runs the effect. The
//!   row holds `unknown` while the effect runs; a duplicate arriving then is told so and runs
//!   nothing. A settled success/failure is never downgraded to `unknown`.
//! - Ids dated more than `FUTURE_SKEW_MS` ahead are invalid (they could look new again after
//!   their tombstone expired); ids older than `MAX_NEW_AGE_MS` are refused unless a row exists.
//! - Rows are never capped by count, only pruned once expired. Loaded rows still `pending` or
//!   `unknown` stay `unknown`: the host may have died mid-effect, so a retry must not re-run it.
// Not called by the app yet (only by its own tests): the wiring lands with the supervisor work.
#![allow(dead_code)]

use std::collections::BTreeMap;

use serde_json::Value;
use sha2::{Digest, Sha256};

pub const FUTURE_SKEW_MS: u64 = 5 * 60 * 1000;
pub const MAX_NEW_AGE_MS: u64 = 24 * 60 * 60 * 1000;
const MAX_ID_LEN: usize = 128;

pub const CODE_INVALID: &str = "agent_session_operation_invalid";
pub const CODE_CONFLICT: &str = "agent_session_operation_conflict";
pub const CODE_EXPIRED: &str = "agent_session_operation_expired";
/// Not an Orca code: the operation was already claimed and its effect is running (or the host
/// died while it ran). The caller must not run it again.
pub const CODE_IN_FLIGHT: &str = "agent_session_operation_in_flight";

/// The timestamp of an operation id `<13 digits>-<32 lowercase hex>`, else none.
pub fn op_timestamp(id: &str) -> Option<u64> {
  let (ts, rand) = id.split_once('-')?;
  if ts.len() != 13 || !ts.bytes().all(|b| b.is_ascii_digit()) || rand.len() != 32 || !rand.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
    return None;
  }
  ts.parse().ok()
}

/// A fresh operation id for `now_ms`.
pub fn new_operation_id(now_ms: u64) -> String {
  format!("{now_ms:013}-{}", random_hex32())
}

fn random_hex32() -> String {
  let bytes = crate::mobile::random_bytes(16).unwrap_or_else(|_| {
    use std::hash::{BuildHasher, Hasher};
    let mut out = Vec::with_capacity(16);
    for i in 0..2u64 {
      let mut h = std::collections::hash_map::RandomState::new().build_hasher();
      h.write_u64(i ^ crate::mobile::now_ms());
      out.extend_from_slice(&h.finish().to_le_bytes());
    }
    out
  });
  bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// sha256 hex of `value` with object keys sorted (Orca `canonicalAgentSessionDigest`); nulls and
/// absent fields hash the same, so both sides of a retry agree.
pub fn fingerprint(value: &Value) -> String {
  fn canon(v: &Value, out: &mut String) {
    match v {
      Value::Object(m) => {
        let mut keys: Vec<&String> = m.iter().filter(|(_, v)| !v.is_null()).map(|(k, _)| k).collect();
        keys.sort();
        out.push('{');
        for (i, k) in keys.iter().enumerate() {
          if i > 0 {
            out.push(',');
          }
          out.push_str(&Value::String((*k).clone()).to_string());
          out.push(':');
          canon(&m[*k], out);
        }
        out.push('}');
      }
      Value::Array(a) => {
        out.push('[');
        for (i, x) in a.iter().enumerate() {
          if i > 0 {
            out.push(',');
          }
          canon(x, out);
        }
        out.push(']');
      }
      other => out.push_str(&other.to_string()),
    }
  }
  let mut s = String::new();
  canon(value, &mut s);
  crate::snap::sha256_hex(s.as_bytes())
}

/// The worktree scope digest of a session (Orca `worktreeScopeDigest`): sha256 of its folder.
pub fn scope_digest(worktree: &str) -> String {
  let mut h = Sha256::new();
  h.update(b"kingu-worktree-scope\0");
  h.update(worktree.as_bytes());
  h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Outcome {
  Pending,
  Succeeded {
    #[serde(default)]
    value: Value,
  },
  Failed {
    code: String,
    #[serde(default)]
    message: String,
  },
  /// The effect may or may not have happened: replay this instead of running it again.
  Unknown,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Row {
  pub caller: String,
  pub operation_id: String,
  pub fingerprint: String,
  /// Worktree scope digest of the session the operation targets.
  pub scope: String,
  pub op_ts: u64,
  pub recorded_at: u64,
  pub expires_at: u64,
  pub outcome: Outcome,
}

/// What `begin` decided.
#[derive(Debug, Clone, PartialEq)]
pub enum Begin {
  /// This caller won the claim: run the effect, then `settle`.
  Run,
  /// Already settled: answer with this outcome, run nothing.
  Replay(Outcome),
  /// Refused with an Orca-style code; run nothing.
  Refused(&'static str),
}

#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
pub struct Ledger {
  rows: BTreeMap<String, Row>,
}

/// NUL never occurs in a caller key or an operation id, so no pair forges another's key.
fn key(caller: &str, op: &str) -> String {
  format!("{caller}\0{op}")
}

impl Ledger {
  /// Rows read back after a restart: whatever was in progress becomes `unknown`.
  pub fn reconciled(mut self, now: u64) -> Self {
    self.prune(now);
    for r in self.rows.values_mut() {
      if r.outcome == Outcome::Pending {
        r.outcome = Outcome::Unknown;
      }
    }
    self
  }

  pub fn len(&self) -> usize {
    self.rows.len()
  }

  pub fn is_empty(&self) -> bool {
    self.rows.is_empty()
  }

  pub fn get(&self, caller: &str, op: &str) -> Option<&Row> {
    self.rows.get(&key(caller, op))
  }

  pub fn prune(&mut self, now: u64) {
    self.rows.retain(|_, r| r.expires_at > now);
  }

  /// Evaluate + admit + claim in one step (the caller holds the ledger's lock).
  pub fn begin(&mut self, caller: &str, op: &str, fingerprint: &str, scope: &str, now: u64) -> Begin {
    self.prune(now);
    if caller.is_empty() || op.len() > MAX_ID_LEN {
      return Begin::Refused(CODE_INVALID);
    }
    let Some(ts) = op_timestamp(op).filter(|ts| *ts <= now + FUTURE_SKEW_MS) else {
      return Begin::Refused(CODE_INVALID);
    };
    let k = key(caller, op);
    if let Some(row) = self.rows.get(&k) {
      if row.fingerprint != fingerprint || row.scope != scope {
        return Begin::Refused(CODE_CONFLICT);
      }
      return match &row.outcome {
        // Admitted but never claimed cannot happen here (admit and claim share this lock);
        // treat it like a running effect.
        Outcome::Pending | Outcome::Unknown => Begin::Refused(CODE_IN_FLIGHT),
        settled => Begin::Replay(settled.clone()),
      };
    }
    if now.saturating_sub(ts) > MAX_NEW_AGE_MS {
      return Begin::Refused(CODE_EXPIRED);
    }
    self.rows.insert(
      k,
      Row {
        caller: caller.to_owned(),
        operation_id: op.to_owned(),
        fingerprint: fingerprint.to_owned(),
        scope: scope.to_owned(),
        op_ts: ts,
        recorded_at: now,
        expires_at: now.max(ts) + MAX_NEW_AGE_MS + FUTURE_SKEW_MS,
        // Claimed: `unknown` records that the effect may run from here on.
        outcome: Outcome::Unknown,
      },
    );
    Begin::Run
  }

  /// Records the effect's outcome. A settled outcome is never replaced by `unknown`.
  pub fn settle(&mut self, caller: &str, op: &str, outcome: Outcome) {
    if let Some(row) = self.rows.get_mut(&key(caller, op)) {
      let settled = matches!(row.outcome, Outcome::Succeeded { .. } | Outcome::Failed { .. });
      if !(settled && matches!(outcome, Outcome::Unknown | Outcome::Pending)) {
        row.outcome = outcome;
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  const NOW: u64 = 1_763_000_000_000;

  fn id(ts: u64) -> String {
    format!("{ts:013}-{}", "ab".repeat(16))
  }

  #[test]
  fn ids_parse_only_in_the_orca_shape() {
    assert_eq!(op_timestamp(&id(NOW)), Some(NOW));
    let fresh = new_operation_id(NOW);
    assert_eq!(op_timestamp(&fresh), Some(NOW));
    for bad in ["", "123-abc", &format!("{NOW}-{}", "AB".repeat(16)), &format!("{NOW}0-{}", "ab".repeat(16)), &format!("{NOW}-{}", "ab".repeat(15))] {
      assert_eq!(op_timestamp(bad), None, "{bad}");
    }
    assert_ne!(new_operation_id(NOW), new_operation_id(NOW));
  }

  #[test]
  fn fingerprints_ignore_key_order_and_nulls() {
    assert_eq!(fingerprint(&json!({"a": 1, "b": [1, {"y": 2, "x": null}]})), fingerprint(&json!({"b": [1, {"y": 2}], "a": 1})));
    assert_ne!(fingerprint(&json!({"a": 1})), fingerprint(&json!({"a": 2})));
    assert_ne!(scope_digest("/a"), scope_digest("/b"));
  }

  #[test]
  fn one_winner_then_replay() {
    let mut l = Ledger::default();
    let op = id(NOW);
    assert_eq!(l.begin("chat:x", &op, "f", "s", NOW), Begin::Run);
    // While the effect runs: the duplicate runs nothing.
    assert_eq!(l.begin("chat:x", &op, "f", "s", NOW + 1), Begin::Refused(CODE_IN_FLIGHT));
    l.settle("chat:x", &op, Outcome::Succeeded { value: json!(7) });
    assert_eq!(l.begin("chat:x", &op, "f", "s", NOW + 2), Begin::Replay(Outcome::Succeeded { value: json!(7) }));
    // A settled outcome is never erased by a late `unknown`.
    l.settle("chat:x", &op, Outcome::Unknown);
    assert!(matches!(l.get("chat:x", &op).unwrap().outcome, Outcome::Succeeded { .. }));
    // Another caller has its own row.
    assert_eq!(l.begin("chat:y", &op, "f", "s", NOW), Begin::Run);
  }

  #[test]
  fn changed_payload_or_scope_is_a_conflict() {
    let mut l = Ledger::default();
    let op = id(NOW);
    assert_eq!(l.begin("c", &op, "f", "s", NOW), Begin::Run);
    assert_eq!(l.begin("c", &op, "g", "s", NOW), Begin::Refused(CODE_CONFLICT));
    assert_eq!(l.begin("c", &op, "f", "other", NOW), Begin::Refused(CODE_CONFLICT));
  }

  #[test]
  fn future_and_old_ids_are_refused() {
    let mut l = Ledger::default();
    assert_eq!(l.begin("c", &id(NOW + FUTURE_SKEW_MS + 1), "f", "s", NOW), Begin::Refused(CODE_INVALID));
    assert_eq!(l.begin("c", "nope", "f", "s", NOW), Begin::Refused(CODE_INVALID));
    assert_eq!(l.begin("c", &id(NOW - MAX_NEW_AGE_MS - 1), "f", "s", NOW), Begin::Refused(CODE_EXPIRED));
    assert_eq!(l.begin("", &id(NOW), "f", "s", NOW), Begin::Refused(CODE_INVALID));
  }

  #[test]
  fn rows_live_for_the_replay_window_then_go() {
    let mut l = Ledger::default();
    let op = id(NOW);
    l.begin("c", &op, "f", "s", NOW);
    l.settle("c", &op, Outcome::Failed { code: "x".into(), message: "no".into() });
    let expires = l.get("c", &op).unwrap().expires_at;
    assert_eq!(expires, NOW + MAX_NEW_AGE_MS + FUTURE_SKEW_MS);
    // Still answered at the edge of admission age (the tombstone outlives it).
    assert!(matches!(l.begin("c", &op, "f", "s", NOW + MAX_NEW_AGE_MS + 1), Begin::Replay(Outcome::Failed { .. })));
    l.prune(expires);
    assert!(l.is_empty());
  }

  #[test]
  fn a_restart_keeps_in_flight_rows_unknown() {
    let mut l = Ledger::default();
    let op = id(NOW);
    l.begin("c", &op, "f", "s", NOW);
    let text = serde_json::to_string(&l).unwrap();
    let mut back: Ledger = serde_json::from_str::<Ledger>(&text).unwrap().reconciled(NOW + 10);
    assert_eq!(back.begin("c", &op, "f", "s", NOW + 11), Begin::Refused(CODE_IN_FLIGHT));
  }
}
