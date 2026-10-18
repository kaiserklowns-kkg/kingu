//! Cross-agent stats (old Kingu's `kinguUsageOverview.ts`): tokens and estimated cost per local
//! day, agent and model, summed from every session's transcript, and the sessions that cost the
//! most. Each session's usage is kept in 15-minute buckets, so any real time zone (all are whole
//! quarter hours from UTC) splits it into days exactly.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use super::read::Tokens;
use super::{Agent, VaultSession, pricing};

const SLOT_MS: i64 = 15 * 60 * 1000;
const DAY_MS: i64 = 86_400_000;
const TOP: usize = 10;

/// A day, agent and model.
type Cell = (i64, Agent, Option<String>);

#[derive(Debug, Clone, PartialEq)]
pub struct Bucket {
  /// Start of the 15-minute slot, Unix ms.
  pub slot: i64,
  pub model: Option<String>,
  pub tokens: Tokens,
}

#[derive(Default)]
pub struct Buckets(HashMap<(i64, Option<String>), Tokens>);

impl Buckets {
  pub fn add(&mut self, at: i64, model: Option<String>, tokens: &Tokens) {
    self.0.entry((at.div_euclid(SLOT_MS) * SLOT_MS, model)).or_default().add(tokens);
  }
  pub fn into_vec(self) -> Vec<Bucket> {
    let mut v: Vec<Bucket> = self.0.into_iter().map(|((slot, model), tokens)| Bucket { slot, model, tokens }).collect();
    v.sort_by(|a, b| (a.slot, &a.model).cmp(&(b.slot, &b.model)));
    v
  }
}

/// `YYYY-MM-DD` of day number `days` since 1970-01-01 (Howard Hinnant's civil_from_days).
pub fn civil(days: i64) -> String {
  let z = days + 719_468;
  let era = z.div_euclid(146_097);
  let doe = z - era * 146_097;
  let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let d = doy - (153 * mp + 2) / 5 + 1;
  let m = if mp < 10 { mp + 3 } else { mp - 9 };
  let y = yoe + era * 400 + i64::from(m <= 2);
  format!("{y:04}-{m:02}-{d:02}")
}

/// One day's tokens on one agent and model.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
  /// Local `YYYY-MM-DD`.
  pub day: String,
  pub agent: Agent,
  /// `None`: the transcript named no model.
  pub model: Option<String>,
  pub tokens: Tokens,
  /// Estimated US dollars; `None` for a model the price table does not know.
  pub cost: Option<f64>,
  pub sessions: u32,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopSession {
  pub agent: Agent,
  pub path: String,
  pub title: String,
  pub cwd: Option<String>,
  pub updated: i64,
  pub tokens: Tokens,
  /// The priced part; `partial` when some of its tokens ran on an unpriced model.
  pub cost: f64,
  pub partial: bool,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
  pub rows: Vec<Row>,
  pub top: Vec<TopSession>,
  /// Local `YYYY-MM-DD` of today, so the webview fills empty days the same way.
  pub today: String,
  /// Sessions with any usage, out of those listed.
  pub sessions_with_usage: usize,
  pub sessions_total: usize,
  /// Models whose tokens are counted but not priced.
  pub unpriced: Vec<String>,
}

fn now_ms() -> i64 {
  std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// Stats of `sessions` (each one's buckets from `usage`), in the zone `tz_offset_min` east of UTC,
/// for the last `days` local days (all with `None`).
pub fn stats(sessions: &[VaultSession], usage: impl Fn(&VaultSession) -> Arc<Vec<Bucket>>, tz_offset_min: i32, days: Option<u32>) -> Stats {
  stats_at(sessions, usage, tz_offset_min, days, now_ms())
}

pub fn stats_at(sessions: &[VaultSession], usage: impl Fn(&VaultSession) -> Arc<Vec<Bucket>>, tz_offset_min: i32, days: Option<u32>, now: i64) -> Stats {
  let offset = i64::from(tz_offset_min.clamp(-14 * 60, 14 * 60)) * 60_000;
  let day_of = |t: i64| (t + offset).div_euclid(DAY_MS);
  let today = day_of(now);
  let first = days.map(|d| today - i64::from(d.max(1)) + 1);
  let mut cells: BTreeMap<Cell, (Tokens, HashSet<usize>)> = BTreeMap::new();
  let mut top = Vec::new();
  let mut with_usage = 0;
  let mut unpriced = std::collections::BTreeSet::new();
  for (i, s) in sessions.iter().enumerate() {
    let buckets = usage(s);
    let mut tokens = Tokens::default();
    let (mut cost, mut partial) = (0.0, false);
    for b in buckets.iter() {
      let day = day_of(b.slot);
      if first.is_some_and(|f| day < f) {
        continue;
      }
      let cell = cells.entry((day, s.agent, b.model.clone())).or_default();
      cell.0.add(&b.tokens);
      cell.1.insert(i);
      tokens.add(&b.tokens);
      match b.model.as_deref().and_then(|m| pricing::cost(m, &b.tokens)) {
        Some(c) => cost += c,
        None => {
          partial = true;
          unpriced.insert(b.model.clone().unwrap_or_default());
        }
      }
    }
    if !tokens.is_zero() {
      with_usage += 1;
      top.push(TopSession { agent: s.agent, path: s.path.clone(), title: s.title.clone(), cwd: s.cwd.clone(), updated: s.updated, tokens, cost, partial });
    }
  }
  top.sort_by(|a, b| b.cost.total_cmp(&a.cost).then((b.tokens.input + b.tokens.output).cmp(&(a.tokens.input + a.tokens.output))));
  top.truncate(TOP);
  let rows = cells
    .into_iter()
    .map(|((day, agent, model), (tokens, ids))| Row { day: civil(day), agent, cost: model.as_deref().and_then(|m| pricing::cost(m, &tokens)), model, tokens, sessions: ids.len() as u32 })
    .collect();
  Stats { rows, top, today: civil(today), sessions_with_usage: with_usage, sessions_total: sessions.len(), unpriced: unpriced.into_iter().collect() }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn civil_dates() {
    assert_eq!(civil(0), "1970-01-01");
    assert_eq!(civil(20_744), "2026-10-18");
    assert_eq!(civil(11_016), "2000-02-29");
  }

  fn session(agent: Agent, path: &str) -> VaultSession {
    VaultSession { agent, id: path.into(), path: path.into(), title: path.into(), preview: None, cwd: None, cwd_exists: false, branch: None, model: None, created: 0, updated: 0, size: 0, resume: None }
  }

  #[test]
  fn days_are_local_and_unpriced_models_are_named() {
    // 2026-10-18T23:30Z is the 19th in Bangkok (+07:00).
    let late = 20_744 * DAY_MS + 23 * 3_600_000 + 30 * 60_000;
    let mut b = Buckets::default();
    let t = Tokens { input: 1_000_000, output: 0, cache_read: 0, cache_write: 0 };
    b.add(late, Some("claude-sonnet-4-5".into()), &t);
    b.add(late - DAY_MS * 3, Some("mystery-1".into()), &t);
    let buckets = Arc::new(b.into_vec());
    let sessions = [session(Agent::Claude, "/a")];
    let now = late + 60_000;
    let s = stats_at(&sessions, |_| buckets.clone(), 7 * 60, None, now);
    assert_eq!(s.today, "2026-10-19");
    assert_eq!(s.rows.iter().map(|r| r.day.as_str()).collect::<Vec<_>>(), ["2026-10-16", "2026-10-19"]);
    assert_eq!(s.rows[1].cost, Some(3.0));
    assert_eq!(s.rows[0].cost, None);
    assert_eq!(s.unpriced, ["mystery-1"]);
    assert_eq!((s.top[0].cost, s.top[0].partial), (3.0, true));
    let week = stats_at(&sessions, |_| buckets.clone(), 7 * 60, Some(2), now);
    assert_eq!(week.rows.len(), 1, "only the last two local days");
  }
}
