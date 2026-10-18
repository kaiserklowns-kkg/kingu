//! Plan usage (rate-limit windows), fetched the way Orca does:
//! - Claude: `GET https://api.anthropic.com/api/oauth/usage` with the Claude Code OAuth token,
//!   headers `anthropic-beta: oauth-2025-04-20`. Body: `five_hour` / `seven_day` (and per-model
//!   `seven_day_*`) = `{utilization: 0..100, resets_at: ISO-8601}`.
//! - Codex: `GET https://chatgpt.com/backend-api/wham/usage` with the ChatGPT token from
//!   `auth.json` (+ `ChatGPT-Account-Id`). Body: `plan_type`, `rate_limit.primary_window` /
//!   `secondary_window` = `{used_percent, limit_window_seconds, reset_at: unix seconds}`.
//!   Orca asks `codex app-server` (`account/rateLimits/read`) first and uses this as the fallback.
//!
//! Polling follows Orca: every 15 minutes, a manual refresh at most every 30 s, backoff after
//! errors, and a 429 waits for `Retry-After`. Expired tokens are not refreshed here (that would
//! rotate the CLI's refresh token under it): the CLI refreshes them the next time it runs.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::creds::{Secret, Token};
use crate::i18n::msg::AccountsMsg;
use crate::tr;

pub const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
pub const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";

pub const SESSION_MINUTES: u32 = 300;
pub const WEEK_MINUTES: u32 = 10080;

pub const POLL_MS: u64 = 15 * 60_000;
pub const MIN_MANUAL_MS: u64 = 30_000;
const ERROR_BASE_MS: u64 = 5 * 60_000;
const ERROR_MAX_MS: u64 = 60 * 60_000;
const STALE_RECHECK_MS: u64 = 2 * 60_000;
const RETRY_AFTER_MAX_MS: u64 = 24 * 60 * 60_000;
/// Last good numbers stay on screen (marked stale) this long after a failed refresh.
const KEEP_GOOD_MS: u64 = 30 * 60_000;
const KEEP_GOOD_RATE_LIMITED_MS: u64 = 24 * 60 * 60_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Window {
  pub used_percent: f64,
  pub window_minutes: u32,
  /// Unix ms.
  pub resets_at: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Usage {
  /// The 5-hour window.
  pub session: Option<Window>,
  /// The 7-day window.
  pub weekly: Option<Window>,
  /// Per-model weekly windows (Claude's `seven_day_opus` …), by model name.
  #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
  pub models: BTreeMap<String, Window>,
  pub plan: Option<String>,
}

fn clamp_pct(v: f64) -> f64 {
  v.clamp(0.0, 100.0)
}

/// Unix ms from seconds, ms, a numeric string or an ISO-8601 date.
pub fn parse_time(v: &Value) -> Option<u64> {
  let n = match v {
    Value::Number(n) => n.as_f64()?,
    Value::String(s) if s.trim().parse::<f64>().is_ok() => s.trim().parse::<f64>().ok()?,
    Value::String(s) => return parse_iso8601(s.trim()),
    _ => return None,
  };
  if !n.is_finite() || n <= 0.0 {
    return None;
  }
  Some(if n > 1e10 { n as u64 } else { (n * 1000.0) as u64 })
}

/// `YYYY-MM-DDTHH:MM:SS[.frac](Z|±HH:MM)` → unix ms.
pub fn parse_iso8601(s: &str) -> Option<u64> {
  let b = s.as_bytes();
  if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') || b[13] != b':' || b[16] != b':' {
    return None;
  }
  let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
  let (y, mo, d, h, mi, se) = (num(0..4)?, num(5..7)?, num(8..10)?, num(11..13)?, num(14..16)?, num(17..19)?);
  if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
    return None;
  }
  let mut i = 19;
  let mut ms = 0i64;
  if b.get(i) == Some(&b'.') {
    i += 1;
    let start = i;
    while b.get(i).is_some_and(u8::is_ascii_digit) {
      i += 1;
    }
    let frac = s.get(start..i)?;
    ms = format!("{:0<3}", &frac[..frac.len().min(3)]).parse().ok()?;
  }
  let offset_min = match b.get(i) {
    None => 0,
    Some(b'Z' | b'z') if i + 1 == b.len() => 0,
    Some(&sign @ (b'+' | b'-')) if b.len() == i + 6 && b[i + 3] == b':' => {
      let m = num(i + 1..i + 3)? * 60 + num(i + 4..i + 6)?;
      if sign == b'+' { m } else { -m }
    }
    _ => return None,
  };
  // Days from civil (Howard Hinnant).
  let (y2, m2) = if mo <= 2 { (y - 1, mo + 9) } else { (y, mo - 3) };
  let era = y2.div_euclid(400);
  let yoe = y2 - era * 400;
  let doy = (153 * m2 + 2) / 5 + d - 1;
  let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  let days = era * 146_097 + doe - 719_468;
  let secs = days * 86_400 + h * 3600 + mi * 60 + se - offset_min * 60;
  u64::try_from(secs * 1000 + ms).ok()
}

fn claude_window(v: &Value, minutes: u32) -> Option<Window> {
  let pct = v["utilization"].as_f64().or_else(|| v["used_percentage"].as_f64())?;
  Some(Window { used_percent: clamp_pct(pct), window_minutes: minutes, resets_at: parse_time(&v["resets_at"]) })
}

/// The body of `/api/oauth/usage`.
pub fn parse_claude(body: &str) -> Result<Usage, String> {
  let v: Value = serde_json::from_str(body).map_err(|e| tr!(AccountsMsg::BadUsageData, detail = e))?;
  if !v.is_object() {
    return Err(tr!(AccountsMsg::UsageUnreadable));
  }
  let mut models = BTreeMap::new();
  if let Some(obj) = v.as_object() {
    for (k, w) in obj {
      if let Some(model) = k.strip_prefix("seven_day_")
        && !model.is_empty()
        && let Some(win) = claude_window(w, WEEK_MINUTES)
      {
        models.insert(model.to_owned(), win);
      }
    }
  }
  Ok(Usage { session: claude_window(&v["five_hour"], SESSION_MINUTES), weekly: claude_window(&v["seven_day"], WEEK_MINUTES), models, plan: None })
}

/// The body of `wham/usage`. Windows are told apart by length (5 h / 7 d, ±1 min), else
/// primary = session and secondary = weekly (Orca's rule).
pub fn parse_codex(body: &str) -> Result<Usage, String> {
  let v: Value = serde_json::from_str(body).map_err(|e| tr!(AccountsMsg::BadUsageData, detail = e))?;
  let Some(plan) = v["plan_type"].as_str() else { return Err(tr!(AccountsMsg::NoPlanType)) };
  let window = |w: &Value| -> Option<Window> {
    let pct = w["used_percent"].as_f64()?;
    let minutes = w["limit_window_seconds"].as_f64().filter(|s| *s > 0.0).map(|s| (s / 60.0).ceil() as u32);
    Some(Window { used_percent: clamp_pct(pct), window_minutes: minutes.unwrap_or(0), resets_at: parse_time(&w["reset_at"]) })
  };
  let rl = &v["rate_limit"];
  let (primary, secondary) = (window(&rl["primary_window"]), window(&rl["secondary_window"]));
  let near = |w: &Window, m: u32| w.window_minutes.abs_diff(m) <= 1;
  let (mut session, mut weekly) = (None, None);
  for w in [&primary, &secondary].into_iter().flatten() {
    if near(w, SESSION_MINUTES) && session.is_none() {
      session = Some(w.clone());
    } else if near(w, WEEK_MINUTES) && weekly.is_none() {
      weekly = Some(w.clone());
    }
  }
  if session.is_none() && let Some(p) = primary.filter(|w| !near(w, WEEK_MINUTES)) {
    session = Some(Window { window_minutes: if p.window_minutes == 0 { SESSION_MINUTES } else { p.window_minutes }, ..p });
  }
  if weekly.is_none() && let Some(s) = secondary.filter(|w| !near(w, SESSION_MINUTES)) {
    weekly = Some(Window { window_minutes: if s.window_minutes == 0 { WEEK_MINUTES } else { s.window_minutes }, ..s });
  }
  Ok(Usage { session, weekly, models: BTreeMap::new(), plan: Some(plan.to_owned()) })
}

// ---- errors ----------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Failure {
  /// Not signed in to this provider (no token).
  NotSignedIn,
  /// Signed in with an API key: no plan limits exist.
  ApiKey,
  /// The token expired or was revoked: the CLI must run (or log in) again.
  StaleToken,
  MissingScope,
  RateLimited,
  Server,
  Network,
  Parse,
  KeychainUnavailable,
}

impl Failure {
  pub fn message(&self, provider_title: &str) -> String {
    match self {
      Self::NotSignedIn => tr!(AccountsMsg::NotSignedIn, provider = provider_title),
      Self::ApiKey => tr!(AccountsMsg::ApiKeyBilling),
      Self::StaleToken => tr!(AccountsMsg::StaleToken, provider = provider_title),
      Self::MissingScope => tr!(AccountsMsg::MissingScope),
      Self::RateLimited => tr!(AccountsMsg::RateLimited),
      Self::Server => tr!(AccountsMsg::ServerDown, provider = provider_title),
      Self::Network => tr!(AccountsMsg::Network),
      Self::Parse => tr!(AccountsMsg::UsageUnreadable),
      Self::KeychainUnavailable => tr!(AccountsMsg::KeychainUnavailable),
    }
  }

  /// Failures that are a state, not an error worth retrying soon.
  fn is_terminal(&self) -> bool {
    matches!(self, Self::NotSignedIn | Self::ApiKey | Self::MissingScope)
  }
}

/// Orca's mapping: 429 → rate limited, 401 → stale, 403 → missing scope if it says
/// `user:profile` else stale, 5xx → server.
pub fn classify(status: u16, body: &str) -> Failure {
  match status {
    429 => Failure::RateLimited,
    401 => Failure::StaleToken,
    403 if body.contains("user:profile") => Failure::MissingScope,
    403 => Failure::StaleToken,
    500..=599 => Failure::Server,
    _ => Failure::Parse,
  }
}

/// `Retry-After` as seconds or an HTTP date is not parsed (only seconds; dates are rare here),
/// capped at a day.
pub fn retry_after_ms(header: Option<&str>) -> Option<u64> {
  let s: f64 = header?.trim().parse().ok()?;
  (s.is_finite() && s > 0.0).then(|| ((s * 1000.0) as u64).min(RETRY_AFTER_MAX_MS))
}

// ---- HTTP ------------------------------------------------------------------------------------

pub struct Response {
  pub status: u16,
  pub body: String,
  pub retry_after: Option<String>,
}

pub trait Http: Send + Sync {
  fn get(&self, url: &str, headers: &[(&str, String)]) -> Result<Response, String>;
}

pub struct ReqwestHttp {
  client: reqwest::blocking::Client,
}

impl ReqwestHttp {
  pub fn new() -> Result<Self, String> {
    let client = crate::net_proxy::client_builder()?
      .timeout(Duration::from_secs(10))
      .connect_timeout(Duration::from_secs(5))
      // A redirect could carry the bearer token elsewhere.
      .redirect(reqwest::redirect::Policy::none())
      .build()
      .map_err(|e| e.to_string())?;
    Ok(Self { client })
  }
}

impl Http for ReqwestHttp {
  fn get(&self, url: &str, headers: &[(&str, String)]) -> Result<Response, String> {
    let mut req = self.client.get(url);
    for (k, v) in headers {
      req = req.header(*k, v);
    }
    let res = req.send().map_err(|e| e.without_url().to_string())?;
    let status = res.status().as_u16();
    let retry_after = res.headers().get("retry-after").and_then(|v| v.to_str().ok()).map(str::to_owned);
    let body = res.text().unwrap_or_default();
    Ok(Response { status, body, retry_after })
  }
}

#[derive(Debug, Clone)]
pub struct Endpoints {
  pub claude: String,
  pub codex: String,
}

impl Default for Endpoints {
  fn default() -> Self {
    Self { claude: CLAUDE_USAGE_URL.into(), codex: CODEX_USAGE_URL.into() }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Api {
  Claude,
  Codex,
}

/// Outcome of one fetch: usage, or a failure with an optional retry delay.
#[derive(Debug, Clone, PartialEq)]
pub enum Fetched {
  Ok(Usage),
  Failed(Failure, Option<u64>),
}

/// One request with the token. The headers are Orca's (the endpoints are the CLIs' own).
pub fn fetch(http: &dyn Http, endpoints: &Endpoints, api: Api, token: &Secret, account_id: Option<&str>) -> Fetched {
  let (url, headers) = match api {
    Api::Claude => (
      endpoints.claude.as_str(),
      vec![
        ("Authorization", format!("Bearer {}", token.0)),
        ("anthropic-beta", "oauth-2025-04-20".to_owned()),
        ("User-Agent", "claude-code/2.1.0".to_owned()),
      ],
    ),
    Api::Codex => {
      let mut h = vec![
        ("Authorization", format!("Bearer {}", token.0)),
        ("User-Agent", "codex-cli".to_owned()),
        ("OpenAI-Beta", "codex-1".to_owned()),
        ("originator", "Codex Desktop".to_owned()),
      ];
      if let Some(id) = account_id {
        h.push(("ChatGPT-Account-Id", id.to_owned()));
      }
      (endpoints.codex.as_str(), h)
    }
  };
  match http.get(url, &headers) {
    Err(_) => Fetched::Failed(Failure::Network, None),
    Ok(r) if (200..300).contains(&r.status) => {
      let parsed = match api {
        Api::Claude => parse_claude(&r.body),
        Api::Codex => parse_codex(&r.body),
      };
      parsed.map_or(Fetched::Failed(Failure::Parse, None), Fetched::Ok)
    }
    Ok(r) => {
      let f = classify(r.status, &r.body);
      let wait = if f == Failure::RateLimited { retry_after_ms(r.retry_after.as_deref()) } else { None };
      Fetched::Failed(f, wait)
    }
  }
}

// ---- schedule and state per subject ----------------------------------------------------------

/// Polling state of one usage subject (a provider's login: an account, or the user's own).
#[derive(Debug, Clone, Default)]
pub struct Poll {
  pub last_good: Option<(Usage, u64)>,
  pub failure: Option<Failure>,
  pub last_attempt: Option<u64>,
  pub next_due: u64,
  pub streak: u32,
  /// Fingerprint of the token last tried: a new one is tried at once (the CLI refreshed it).
  pub fingerprint: Option<String>,
  /// The plan the login names (Claude's `subscriptionType`), when the usage body has none.
  pub plan: Option<String>,
}

impl Poll {
  pub fn due(&self, now: u64, force: bool) -> bool {
    if force {
      return self.last_attempt.is_none_or(|t| now.saturating_sub(t) >= MIN_MANUAL_MS);
    }
    now >= self.next_due
  }

  /// Applies what the credentials say before any request. Returns the token to send, if any.
  pub fn before_fetch(&mut self, token: Token, now: u64) -> Option<(Secret, Option<String>)> {
    self.last_attempt = Some(now);
    match token {
      Token::OAuth { token, expires_at, account_id, plan } => {
        self.plan = plan;
        let fp = token.fingerprint();
        let changed = self.fingerprint.as_deref() != Some(fp.as_str());
        self.fingerprint = Some(fp);
        // A token the provider already refused is not sent again until the CLI replaces it.
        if !changed && self.failure == Some(Failure::StaleToken) {
          self.next_due = now + STALE_RECHECK_MS;
          return None;
        }
        if expires_at.is_some_and(|t| t <= now) {
          self.fail(Failure::StaleToken, None, now);
          return None;
        }
        Some((token, account_id))
      }
      Token::ApiKey => {
        self.settle(Failure::ApiKey, now);
        None
      }
      Token::None => {
        self.settle(Failure::NotSignedIn, now);
        None
      }
      Token::Unavailable => {
        self.fail(Failure::KeychainUnavailable, None, now);
        None
      }
    }
  }

  /// A state that is not an error: check again at the normal pace, forget old numbers.
  fn settle(&mut self, f: Failure, now: u64) {
    self.last_good = None;
    self.failure = Some(f);
    self.streak = 0;
    self.next_due = now + POLL_MS;
  }

  pub fn apply(&mut self, fetched: Fetched, now: u64) -> bool {
    match fetched {
      Fetched::Ok(u) => {
        self.last_good = Some((u, now));
        self.failure = None;
        self.streak = 0;
        self.next_due = now + POLL_MS;
        true
      }
      Fetched::Failed(f, wait) => {
        self.fail(f, wait, now);
        false
      }
    }
  }

  fn fail(&mut self, f: Failure, wait: Option<u64>, now: u64) {
    if f.is_terminal() {
      return self.settle(f, now);
    }
    self.streak = self.streak.saturating_add(1);
    let backoff = match f {
      Failure::StaleToken => STALE_RECHECK_MS,
      Failure::RateLimited => wait.unwrap_or(KEEP_GOOD_MS),
      _ => (ERROR_BASE_MS << (self.streak - 1).min(4)).min(ERROR_MAX_MS),
    };
    self.next_due = now + backoff;
    let keep = if f == Failure::RateLimited { KEEP_GOOD_RATE_LIMITED_MS } else { KEEP_GOOD_MS };
    if self.last_good.as_ref().is_some_and(|(_, at)| now.saturating_sub(*at) > keep) {
      self.last_good = None;
    }
    self.failure = Some(f);
  }

  /// `ok`, `stale` (old numbers after a failed refresh), `error`, `unavailable` (not signed in),
  /// `api_key`, `idle` (not fetched yet).
  pub fn status(&self) -> &'static str {
    match (&self.failure, &self.last_good) {
      (None, Some(_)) => "ok",
      (None, None) => "idle",
      (Some(Failure::NotSignedIn), _) => "unavailable",
      (Some(Failure::ApiKey), _) => "api_key",
      (Some(_), Some(_)) => "stale",
      (Some(_), None) => "error",
    }
  }
}

// ---- history ---------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Sample {
  pub t: u64,
  pub session: Option<f64>,
  pub weekly: Option<f64>,
}

const HISTORY_MAX: usize = 500;
const HISTORY_MIN_GAP_MS: u64 = 10 * 60_000;

/// Samples per subject key, newest last. A sample is kept when the numbers moved or 10 min passed.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct History(pub BTreeMap<String, Vec<Sample>>);

impl History {
  pub fn record(&mut self, key: &str, u: &Usage, now: u64) -> bool {
    let s = Sample { t: now, session: u.session.as_ref().map(|w| w.used_percent), weekly: u.weekly.as_ref().map(|w| w.used_percent) };
    let list = self.0.entry(key.to_owned()).or_default();
    if let Some(last) = list.last()
      && last.session == s.session
      && last.weekly == s.weekly
      && now.saturating_sub(last.t) < HISTORY_MIN_GAP_MS
    {
      return false;
    }
    list.push(s);
    if list.len() > HISTORY_MAX {
      list.drain(..list.len() - HISTORY_MAX);
    }
    true
  }

  pub fn load(path: &std::path::Path) -> Self {
    std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
  }
}

#[cfg(test)]
mod tests {
  use std::io::{BufRead, BufReader, Write};
  use std::net::TcpListener;

  use super::*;

  /// Shaped like a real `/api/oauth/usage` answer (values made up).
  const CLAUDE_FIXTURE: &str = r#"{
    "five_hour": {"utilization": 23.0, "resets_at": "2026-10-18T15:00:00.358254+00:00"},
    "seven_day": {"utilization": 71.0, "resets_at": "2026-10-21T19:00:00+00:00"},
    "seven_day_oauth_apps": null,
    "seven_day_opus": {"utilization": 12.5, "resets_at": null},
    "extra_usage": {"is_enabled": false, "monthly_limit": null, "used_credits": null, "utilization": null}
  }"#;

  const CODEX_FIXTURE: &str = r#"{
    "plan_type": "plus",
    "rate_limit": {
      "allowed": true, "limit_reached": false,
      "primary_window": {"used_percent": 42, "limit_window_seconds": 18000, "reset_after_seconds": 3600, "reset_at": 1760800000},
      "secondary_window": {"used_percent": 8, "limit_window_seconds": 604800, "reset_after_seconds": 400000, "reset_at": 1761200000}
    }
  }"#;

  #[test]
  fn iso_dates() {
    assert_eq!(parse_iso8601("1970-01-01T00:00:00Z"), Some(0));
    assert_eq!(parse_iso8601("2026-10-21T19:00:00+00:00"), Some(1_792_609_200_000));
    assert_eq!(parse_iso8601("2026-10-21T21:00:00+02:00"), Some(1_792_609_200_000));
    assert_eq!(parse_iso8601("2026-10-18T15:00:00.358254+00:00"), Some(1_792_335_600_358));
    assert_eq!(parse_iso8601("2024-02-29T00:00:00Z"), Some(1_709_164_800_000));
    for bad in ["", "2026-13-01T00:00:00Z", "2026-10-21", "2026-10-21T19:00:00+0000", "garbage-here-T00:00:00"] {
      assert_eq!(parse_iso8601(bad), None, "{bad}");
    }
    assert_eq!(parse_time(&serde_json::json!(1_760_800_000)), Some(1_760_800_000_000));
    assert_eq!(parse_time(&serde_json::json!(1_760_800_000_000u64)), Some(1_760_800_000_000));
    assert_eq!(parse_time(&serde_json::json!("1760800000")), Some(1_760_800_000_000));
    assert_eq!(parse_time(&Value::Null), None);
  }

  #[test]
  fn claude_body() {
    let u = parse_claude(CLAUDE_FIXTURE).unwrap();
    assert_eq!(u.session, Some(Window { used_percent: 23.0, window_minutes: 300, resets_at: Some(1_792_335_600_358) }));
    assert_eq!(u.weekly.as_ref().unwrap().used_percent, 71.0);
    assert_eq!(u.weekly.as_ref().unwrap().window_minutes, 10080);
    assert_eq!(u.models.keys().collect::<Vec<_>>(), ["opus"]);
    assert_eq!(u.models["opus"].resets_at, None);
    let u = parse_claude(r#"{"five_hour":{"utilization":140},"seven_day":null}"#).unwrap();
    assert_eq!(u.session.unwrap().used_percent, 100.0);
    assert!(u.weekly.is_none());
    assert!(parse_claude("[]").is_err() && parse_claude("<html>").is_err());
  }

  #[test]
  fn codex_body() {
    let u = parse_codex(CODEX_FIXTURE).unwrap();
    assert_eq!(u.plan.as_deref(), Some("plus"));
    assert_eq!(u.session, Some(Window { used_percent: 42.0, window_minutes: 300, resets_at: Some(1_760_800_000_000) }));
    assert_eq!(u.weekly.as_ref().map(|w| (w.used_percent, w.window_minutes)), Some((8.0, 10080)));
    // Swapped windows are told apart by length.
    let swapped = r#"{"plan_type":"pro","rate_limit":{"primary_window":{"used_percent":5,"limit_window_seconds":604800},"secondary_window":{"used_percent":60,"limit_window_seconds":18000}}}"#;
    let u = parse_codex(swapped).unwrap();
    assert_eq!((u.session.unwrap().used_percent, u.weekly.unwrap().used_percent), (60.0, 5.0));
    // Unknown lengths: primary is the session.
    let odd = r#"{"plan_type":"team","rate_limit":{"primary_window":{"used_percent":5}}}"#;
    assert_eq!(parse_codex(odd).unwrap().session.unwrap().window_minutes, 300);
    assert!(parse_codex(r#"{"rate_limit":{}}"#).is_err());
  }

  #[test]
  fn http_errors() {
    assert_eq!(classify(429, ""), Failure::RateLimited);
    assert_eq!(classify(401, ""), Failure::StaleToken);
    assert_eq!(classify(403, r#"{"error":{"message":"requires user:profile scope"}}"#), Failure::MissingScope);
    assert_eq!(classify(403, ""), Failure::StaleToken);
    assert_eq!(classify(503, ""), Failure::Server);
    assert_eq!(retry_after_ms(Some("120")), Some(120_000));
    assert_eq!(retry_after_ms(Some("9999999")), Some(RETRY_AFTER_MAX_MS));
    assert_eq!(retry_after_ms(Some("soon")), None);
  }

  fn oauth(t: &str, expires_at: Option<u64>) -> Token {
    Token::OAuth { token: Secret(t.into()), expires_at, plan: None, account_id: None }
  }

  #[test]
  fn schedule_and_backoff() {
    let mut p = Poll::default();
    assert!(p.due(0, false));
    assert_eq!(p.status(), "idle");
    let (tok, _) = p.before_fetch(oauth("a", None), 0).unwrap();
    assert_eq!(tok.0, "a");
    assert!(p.apply(Fetched::Ok(parse_claude(CLAUDE_FIXTURE).unwrap()), 0));
    assert_eq!(p.status(), "ok");
    assert!(!p.due(POLL_MS - 1, false));
    assert!(p.due(POLL_MS, false));
    assert!(!p.due(MIN_MANUAL_MS - 1, true), "manual refresh is spaced 30 s");
    assert!(p.due(MIN_MANUAL_MS, true));

    // Errors back off 5, 10, 20 … min, capped at an hour; the last numbers stay (stale) for 30 min.
    let t = 1_000_000;
    p.before_fetch(oauth("a", None), t);
    p.apply(Fetched::Failed(Failure::Server, None), t);
    assert_eq!((p.next_due - t, p.status()), (5 * 60_000, "stale"));
    p.apply(Fetched::Failed(Failure::Network, None), t);
    assert_eq!(p.next_due - t, 10 * 60_000);
    for _ in 0..6 {
      p.apply(Fetched::Failed(Failure::Network, None), t);
    }
    assert_eq!(p.next_due - t, 60 * 60_000);
    p.apply(Fetched::Failed(Failure::Network, None), KEEP_GOOD_MS + 1);
    assert_eq!(p.status(), "error", "too old to show");

    // 429 waits for Retry-After.
    let mut p = Poll::default();
    p.apply(Fetched::Failed(Failure::RateLimited, Some(90_000)), 10);
    assert_eq!(p.next_due, 90_010);
  }

  #[test]
  fn expired_tokens_are_not_sent_until_the_cli_refreshes_them() {
    let mut p = Poll::default();
    assert!(p.before_fetch(oauth("old", Some(50)), 100).is_none());
    assert_eq!(p.failure, Some(Failure::StaleToken));
    assert_eq!(p.next_due, 100 + STALE_RECHECK_MS);
    assert!(p.before_fetch(oauth("old", Some(50)), 200).is_none());
    // The CLI ran and stored a new token: it is used at once.
    assert!(p.before_fetch(oauth("new", Some(10_000_000)), 300).is_some());
  }

  #[test]
  fn signed_out_and_api_key_are_states() {
    let mut p = Poll::default();
    assert!(p.before_fetch(Token::None, 0).is_none());
    assert_eq!((p.status(), p.next_due), ("unavailable", POLL_MS));
    assert!(p.before_fetch(Token::ApiKey, 0).is_none());
    assert_eq!(p.status(), "api_key");
    assert!(p.before_fetch(Token::Unavailable, 0).is_none());
    assert_eq!(p.status(), "error");
  }

  #[test]
  fn history_samples() {
    let u = parse_claude(CLAUDE_FIXTURE).unwrap();
    let mut h = History::default();
    assert!(h.record("claude:system", &u, 0));
    assert!(!h.record("claude:system", &u, 60_000), "unchanged within 10 min");
    assert!(h.record("claude:system", &u, HISTORY_MIN_GAP_MS));
    let mut moved = u.clone();
    moved.session.as_mut().unwrap().used_percent = 30.0;
    assert!(h.record("claude:system", &moved, HISTORY_MIN_GAP_MS + 1));
    assert_eq!(h.0["claude:system"].len(), 3);
    for i in 0..HISTORY_MAX as u64 + 10 {
      h.record("k", &u, i * HISTORY_MIN_GAP_MS);
    }
    assert_eq!(h.0["k"].len(), HISTORY_MAX);
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("h.json");
    std::fs::write(&path, serde_json::to_string(&h).unwrap()).unwrap();
    assert_eq!(History::load(&path), h);
  }

  /// A one-request HTTP server on loopback that answers `status`/`body` and returns the request head.
  fn serve(status: u16, body: &'static str, extra: &'static str) -> (String, std::thread::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/usage", listener.local_addr().unwrap());
    let handle = std::thread::spawn(move || {
      let (stream, _) = listener.accept().unwrap();
      let mut reader = BufReader::new(stream.try_clone().unwrap());
      let mut head = Vec::new();
      loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        if line.trim_end().is_empty() {
          break;
        }
        head.push(line.trim_end().to_owned());
      }
      let mut stream = stream;
      write!(stream, "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
      head
    });
    (base, handle)
  }

  fn has_header(head: &[String], name: &str, value: &str) -> bool {
    head.iter().any(|l| l.split_once(':').is_some_and(|(k, v)| k.eq_ignore_ascii_case(name) && v.trim() == value))
  }

  #[test]
  fn fetch_claude_against_a_local_server() {
    let (url, server) = serve(200, CLAUDE_FIXTURE, "");
    let endpoints = Endpoints { claude: url, codex: String::new() };
    let r = fetch(&ReqwestHttp::new().unwrap(), &endpoints, Api::Claude, &Secret("tok-1".into()), None);
    assert!(matches!(&r, Fetched::Ok(u) if u.weekly.as_ref().unwrap().used_percent == 71.0));
    let head = server.join().unwrap();
    assert_eq!(head[0], "GET /usage HTTP/1.1");
    assert!(has_header(&head, "authorization", "Bearer tok-1"));
    assert!(has_header(&head, "anthropic-beta", "oauth-2025-04-20"));
  }

  #[test]
  fn fetch_codex_against_a_local_server() {
    let (url, server) = serve(200, CODEX_FIXTURE, "");
    let endpoints = Endpoints { claude: String::new(), codex: url };
    let r = fetch(&ReqwestHttp::new().unwrap(), &endpoints, Api::Codex, &Secret("at".into()), Some("acc-1"));
    assert!(matches!(&r, Fetched::Ok(u) if u.plan.as_deref() == Some("plus")));
    let head = server.join().unwrap();
    assert!(has_header(&head, "authorization", "Bearer at"));
    assert!(has_header(&head, "chatgpt-account-id", "acc-1"));
  }

  #[test]
  fn fetch_rate_limited_and_unreachable() {
    let (url, server) = serve(429, "{}", "Retry-After: 60\r\n");
    let endpoints = Endpoints { claude: url, codex: String::new() };
    let http = ReqwestHttp::new().unwrap();
    assert_eq!(fetch(&http, &endpoints, Api::Claude, &Secret("t".into()), None), Fetched::Failed(Failure::RateLimited, Some(60_000)));
    server.join().unwrap();
    let dead = Endpoints { claude: "http://127.0.0.1:1/usage".into(), codex: String::new() };
    assert_eq!(fetch(&http, &dead, Api::Claude, &Secret("t".into()), None), Fetched::Failed(Failure::Network, None));
  }
}
