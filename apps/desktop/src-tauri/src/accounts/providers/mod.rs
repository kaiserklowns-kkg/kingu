//! Plan usage of the providers beyond Claude and Codex (Orca's AI Provider Accounts sections and
//! status-bar usage): Gemini CLI, OpenCode Go, MiniMax, Grok, Cursor, Antigravity and the GLM
//! Coding Plan (ZCode). Each provider module turns its credential into an [`Usage`] snapshot the
//! way Orca does; this module polls them (every 15 minutes, backoff after errors, `Retry-After`)
//! and keeps the last good numbers on screen for a while after a failed refresh.
//!
//! Credentials Kingu itself keeps (API keys, session cookies) are Keychain items; the CLIs' own
//! logins are read where those CLIs keep them, never written except where Orca does (Gemini's
//! refreshed token, Antigravity's account switch). The webview only gets numbers and states.

pub mod antigravity;
pub mod cursor;
pub mod gemini;
pub mod grok;
pub mod minimax;
pub mod opencode_go;
pub mod zcode;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::secrets::SecretStore;
use super::usage::Window;

pub const POLL_MS: u64 = 15 * 60_000;
pub const MIN_MANUAL_MS: u64 = 30_000;
/// Last good numbers stay (with the error) this long after a failed refresh; 24 h when rate-limited.
const KEEP_GOOD_MS: u64 = 30 * 60_000;
const KEEP_GOOD_RATE_LIMITED_MS: u64 = 24 * 60 * 60_000;
const RETRY_AFTER_MAX_MS: u64 = 24 * 60 * 60_000;

/// The providers in Orca's order on the accounts page.
pub const PROVIDERS: [&str; 7] = ["gemini", "antigravity", "opencode-go", "minimax", "grok", "cursor", "zcode"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
  Ok,
  Error,
  /// Not set up (no credential, no CLI): the status bar shows nothing.
  Unavailable,
  /// Turned off.
  Idle,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Bucket {
  pub name: String,
  pub window: Window,
}

/// One provider's snapshot (Orca's ProviderRateLimits).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Usage {
  pub provider: String,
  pub status: Status,
  pub session: Option<Window>,
  pub weekly: Option<Window>,
  pub monthly: Option<Window>,
  /// Per-model or per-pool windows in the provider's order (Gemini models, Cursor pools …).
  pub buckets: Vec<Bucket>,
  pub plan: Option<String>,
  /// OpenCode Zen balance in USD.
  pub balance: Option<f64>,
  pub error: Option<String>,
  /// Orca's failureKind: missing-credentials, stale-token, no-subscription, server, network,
  /// parse, usage-unavailable, rate-limited, delegated-refresh-required, cli-unavailable.
  pub failure: Option<String>,
  /// Who the numbers belong to (an email and plan, a key fingerprint).
  pub provenance: Option<String>,
  /// Unix ms of the numbers shown.
  pub updated_at: Option<u64>,
  #[serde(skip)]
  pub retry_after_ms: Option<u64>,
}

impl Usage {
  pub fn new(provider: &str, status: Status) -> Self {
    Self {
      provider: provider.into(),
      status,
      session: None,
      weekly: None,
      monthly: None,
      buckets: Vec::new(),
      plan: None,
      balance: None,
      error: None,
      failure: None,
      provenance: None,
      updated_at: None,
      retry_after_ms: None,
    }
  }

  pub fn unavailable(provider: &str, error: impl Into<String>, failure: &str) -> Self {
    Self { error: Some(error.into()), failure: Some(failure.into()), ..Self::new(provider, Status::Unavailable) }
  }

  pub fn error(provider: &str, error: impl Into<String>, failure: &str) -> Self {
    Self { error: Some(error.into()), failure: Some(failure.into()), ..Self::new(provider, Status::Error) }
  }

  pub fn has_data(&self) -> bool {
    self.session.is_some() || self.weekly.is_some() || self.monthly.is_some() || !self.buckets.is_empty() || self.balance.is_some()
  }
}

/// What the providers read from Kingu's settings (sent by the webview with each refresh).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
  /// `kingu.usage.gemini.cliOAuth` (Orca's geminiCliOAuthEnabled, off by default).
  pub gemini_cli_oauth: bool,
  /// Antigravity usage starts `agy`; only when its status-bar item is on.
  pub antigravity: bool,
  pub opencode_workspace_id: String,
  /// `overseas` or `cn`.
  pub minimax_endpoint: String,
  pub minimax_group_id: String,
  pub minimax_models: String,
  /// `zai` or `bigmodel`.
  pub zcode_site: String,
}

// ---- outside world -----------------------------------------------------------------------------

pub struct Req<'a> {
  pub method: &'a str,
  pub url: String,
  pub headers: Vec<(&'a str, String)>,
  pub body: Option<String>,
  pub timeout: Duration,
}

impl<'a> Req<'a> {
  pub fn get(url: impl Into<String>) -> Self {
    Self { method: "GET", url: url.into(), headers: Vec::new(), body: None, timeout: Duration::from_secs(15) }
  }

  pub fn post(url: impl Into<String>, body: String) -> Self {
    Self { method: "POST", body: Some(body), ..Self::get(url) }
  }

  pub fn header(mut self, k: &'a str, v: impl Into<String>) -> Self {
    self.headers.push((k, v.into()));
    self
  }

  pub fn timeout(mut self, secs: u64) -> Self {
    self.timeout = Duration::from_secs(secs);
    self
  }
}

#[derive(Debug, Clone, Default)]
pub struct Resp {
  pub status: u16,
  pub body: String,
  pub content_type: String,
  pub retry_after: Option<String>,
}

impl Resp {
  pub fn ok(&self) -> bool {
    (200..300).contains(&self.status)
  }

  pub fn json(&self) -> Option<Value> {
    serde_json::from_str(&self.body).ok()
  }
}

pub trait Web: Send + Sync {
  fn send(&self, req: Req) -> Result<Resp, String>;
}

/// Through Kingu's proxy settings; redirects are not followed (they could carry a credential away).
pub struct ReqwestWeb {
  client: reqwest::blocking::Client,
}

impl ReqwestWeb {
  pub fn new() -> Result<Self, String> {
    let client = crate::net_proxy::client_builder()?
      .connect_timeout(Duration::from_secs(5))
      .redirect(reqwest::redirect::Policy::none())
      .build()
      .map_err(|e| e.to_string())?;
    Ok(Self { client })
  }
}

impl Web for ReqwestWeb {
  fn send(&self, req: Req) -> Result<Resp, String> {
    let mut b = match req.method {
      "POST" => self.client.post(&req.url),
      _ => self.client.get(&req.url),
    };
    b = b.timeout(req.timeout);
    for (k, v) in &req.headers {
      b = b.header(*k, v);
    }
    if let Some(body) = req.body {
      b = b.body(body);
    }
    let res = b.send().map_err(|e| e.without_url().to_string())?;
    let status = res.status().as_u16();
    let header = |k: &str| res.headers().get(k).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let content_type = header("content-type").unwrap_or_default();
    let retry_after = header("retry-after");
    Ok(Resp { status, body: res.text().unwrap_or_default(), content_type, retry_after })
  }
}

#[derive(Debug, Clone, Default)]
pub struct Output {
  pub code: Option<i32>,
  pub stdout: String,
  pub stderr: String,
  pub timed_out: bool,
}

/// Runs a local program (`security`, `sqlite3`, `agy`): with optional stdin and a deadline.
pub trait Runner: Send + Sync {
  fn run(&self, program: &str, args: &[&str], stdin: Option<&str>, timeout: Duration) -> Result<Output, String>;
  /// A program on the login shell's PATH.
  fn which(&self, program: &str) -> Option<PathBuf>;
}

pub struct SystemRunner;

impl Runner for SystemRunner {
  fn run(&self, program: &str, args: &[&str], stdin: Option<&str>, timeout: Duration) -> Result<Output, String> {
    use std::io::{Read, Write};
    use std::process::{Command, Stdio};
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(path) = crate::shell_env::path() {
      cmd.env("PATH", path);
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
      let _ = pipe.write_all(input.as_bytes());
    }
    // Read both pipes on threads so a chatty program cannot block on a full pipe.
    let mut out = child.stdout.take();
    let mut err = child.stderr.take();
    let read_out = std::thread::spawn(move || {
      let mut s = Vec::new();
      if let Some(o) = out.as_mut() {
        let _ = o.take(512 * 1024).read_to_end(&mut s);
      }
      s
    });
    let read_err = std::thread::spawn(move || {
      let mut s = Vec::new();
      if let Some(e) = err.as_mut() {
        let _ = e.take(64 * 1024).read_to_end(&mut s);
      }
      s
    });
    let deadline = std::time::Instant::now() + timeout;
    let mut timed_out = false;
    let code = loop {
      match child.try_wait().map_err(|e| e.to_string())? {
        Some(status) => break status.code(),
        None if std::time::Instant::now() >= deadline => {
          let _ = child.kill();
          let _ = child.wait();
          timed_out = true;
          break None;
        }
        None => std::thread::sleep(Duration::from_millis(25)),
      }
    };
    let stdout = String::from_utf8_lossy(&read_out.join().unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&read_err.join().unwrap_or_default()).into_owned();
    Ok(Output { code, stdout, stderr, timed_out })
  }

  fn which(&self, program: &str) -> Option<PathBuf> {
    let path = crate::shell_env::path().or_else(|| std::env::var_os("PATH"))?;
    std::env::split_paths(&path).map(|d| d.join(program)).find(|p| p.is_file())
  }
}

/// What a provider module gets for one fetch.
pub struct Ctx<'a> {
  pub web: &'a dyn Web,
  pub run: &'a dyn Runner,
  pub secrets: &'a dyn SecretStore,
  pub home: PathBuf,
  pub config: &'a Config,
  pub now: u64,
}

impl Ctx<'_> {
  pub fn secret(&self, name: &str) -> Option<String> {
    self.secrets.get(&secret_id(name)).filter(|s| !s.trim().is_empty())
  }
}

// ---- Kingu-kept credentials -------------------------------------------------------------------

/// The credentials Kingu keeps for these providers (Keychain items).
pub const CREDENTIALS: [&str; 5] = ["opencode-go:api-key", "opencode-go:cookie", "minimax:cookie", "minimax:api-key", "zcode:api-key"];

pub fn secret_id(name: &str) -> String {
  format!("provider:{name}")
}

pub fn credential_provider(name: &str) -> &str {
  name.split(':').next().unwrap_or(name)
}

// ---- polling ----------------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Slot {
  usage: Usage,
  /// When the last good numbers were fetched.
  good_at: Option<u64>,
  next_at: u64,
  last_try: u64,
  streak: u32,
}

pub struct Providers {
  web: Box<dyn Web>,
  run: Box<dyn Runner>,
  secrets: Box<dyn SecretStore>,
  home: PathBuf,
  slots: Mutex<BTreeMap<String, Slot>>,
  refreshing: Mutex<()>,
}

impl Providers {
  pub fn new(web: Box<dyn Web>, run: Box<dyn Runner>, secrets: Box<dyn SecretStore>, home: PathBuf) -> Self {
    Self { web, run, secrets, home, slots: Mutex::new(BTreeMap::new()), refreshing: Mutex::new(()) }
  }

  pub fn ctx<'a>(&'a self, config: &'a Config, now: u64) -> Ctx<'a> {
    Ctx { web: self.web.as_ref(), run: self.run.as_ref(), secrets: self.secrets.as_ref(), home: self.home.clone(), config, now }
  }

  pub fn secrets(&self) -> &dyn SecretStore {
    self.secrets.as_ref()
  }

  pub fn runner(&self) -> &dyn Runner {
    self.run.as_ref()
  }

  pub fn home(&self) -> &std::path::Path {
    &self.home
  }

  /// The snapshots on screen now.
  pub fn current(&self) -> Vec<Usage> {
    let slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
    PROVIDERS.iter().filter_map(|p| slots.get(*p).map(|s| s.usage.clone())).collect()
  }

  /// Drops a provider's numbers (its credential or settings changed) so the next refresh fetches.
  pub fn invalidate(&self, provider: &str) {
    self.slots.lock().unwrap_or_else(|e| e.into_inner()).remove(provider);
  }

  /// Fetches every provider that is due (all of them with `force`, at most every 30 s; only
  /// `only` when given) and returns the snapshots.
  pub fn refresh(&self, config: &Config, force: bool, only: Option<&str>, now: u64) -> Vec<Usage> {
    let _guard = self.refreshing.lock().unwrap_or_else(|e| e.into_inner());
    let ctx = self.ctx(config, now);
    for p in PROVIDERS {
      if only.is_some_and(|o| o != p) {
        continue;
      }
      let due = {
        let slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
        match slots.get(p) {
          None => true,
          Some(s) if force => now.saturating_sub(s.last_try) >= MIN_MANUAL_MS,
          Some(s) => now >= s.next_at,
        }
      };
      if !due {
        continue;
      }
      let fetched = fetch(p, &ctx);
      let mut slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
      let prev = slots.remove(p);
      slots.insert(p.to_owned(), settle(p, prev, fetched, now));
    }
    self.current()
  }
}

/// One provider's fetch.
pub fn fetch(provider: &str, ctx: &Ctx) -> Usage {
  let mut u = match provider {
    "gemini" => gemini::fetch(ctx),
    "antigravity" => antigravity::fetch(ctx),
    "opencode-go" => opencode_go::fetch(ctx),
    "minimax" => minimax::fetch(ctx),
    "grok" => grok::fetch(ctx),
    "cursor" => cursor::fetch(ctx),
    "zcode" => zcode::fetch(ctx),
    _ => Usage::new(provider, Status::Idle),
  };
  if u.status == Status::Ok {
    u.updated_at = Some(ctx.now);
  }
  u
}

/// The slot after a fetch: Orca's result policy and retry schedule.
fn settle(provider: &str, prev: Option<Slot>, mut fetched: Usage, now: u64) -> Slot {
  let streak = if fetched.status == Status::Error { prev.as_ref().map_or(0, |s| s.streak) + 1 } else { 0 };
  let mut good_at = prev.as_ref().and_then(|s| s.good_at);
  match fetched.status {
    Status::Ok => good_at = Some(now),
    Status::Error => {
      // Keep the last good numbers (with the new error) for a while.
      let keep = if fetched.failure.as_deref() == Some("rate-limited") { KEEP_GOOD_RATE_LIMITED_MS } else { KEEP_GOOD_MS };
      if let (Some(p), Some(at)) = (prev.as_ref(), good_at)
        && now.saturating_sub(at) < keep
        && p.usage.has_data()
      {
        let error = fetched.error.take();
        let failure = fetched.failure.take();
        fetched = Usage { status: Status::Error, error, failure, retry_after_ms: fetched.retry_after_ms, ..p.usage.clone() };
      } else {
        good_at = None;
      }
    }
    Status::Unavailable | Status::Idle => good_at = None,
  }
  let delay = match fetched.status {
    Status::Error => match provider {
      // OpenCode Go and MiniMax wait a flat 5 minutes; the others 30 s doubling up to 15 min.
      "opencode-go" | "minimax" => 5 * 60_000,
      _ => (30_000u64 << (streak.saturating_sub(1)).min(5)).min(POLL_MS),
    },
    _ => POLL_MS,
  };
  let delay = fetched.retry_after_ms.map_or(delay, |r| delay.max(r.min(RETRY_AFTER_MAX_MS)));
  Slot { usage: fetched, good_at, next_at: now + delay, last_try: now, streak }
}

// ---- shared parsing ----------------------------------------------------------------------------

pub fn clamp_pct(v: f64) -> f64 {
  if v.is_finite() { v.clamp(0.0, 100.0) } else { 0.0 }
}

pub fn window(used_percent: f64, window_minutes: u32, resets_at: Option<u64>) -> Window {
  Window { used_percent: clamp_pct(used_percent).round(), window_minutes, resets_at }
}

/// ISO-8601 / RFC 3339 → unix ms.
pub fn parse_iso(s: &str) -> Option<u64> {
  let t = time::OffsetDateTime::parse(s.trim(), &time::format_description::well_known::Rfc3339).ok()?;
  u64::try_from(t.unix_timestamp_nanos() / 1_000_000).ok()
}

/// A number that may come as a JSON string.
pub fn num(v: &Value) -> Option<f64> {
  match v {
    Value::Number(n) => n.as_f64(),
    Value::String(s) => s.trim().parse().ok(),
    _ => None,
  }
}

/// A timestamp that may be seconds, milliseconds (both possibly as strings) or ISO.
pub fn timestamp(v: &Value) -> Option<u64> {
  if let Some(n) = num(v).filter(|n| *n > 0.0) {
    return Some(if n <= 1e12 { (n * 1000.0) as u64 } else { n as u64 });
  }
  v.as_str().and_then(parse_iso)
}

/// `Retry-After` (seconds or an HTTP date we do not parse) → ms.
pub fn retry_after_ms(v: Option<&str>) -> Option<u64> {
  v.and_then(|s| s.trim().parse::<u64>().ok()).map(|s| s * 1000)
}

/// The payload of a JWT (unverified: only to read `sub`, `exp`, `email`).
pub fn jwt_payload(token: &str) -> Option<Value> {
  use base64::Engine;
  let part = token.split('.').nth(1)?;
  let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(part.trim_end_matches('=')).ok()?;
  serde_json::from_slice(&bytes).ok()
}

/// The first `n` hex digits of a value's SHA-256 (a fingerprint safe to show).
pub fn fingerprint(value: &str, n: usize) -> String {
  use sha2::{Digest, Sha256};
  Sha256::digest(value.as_bytes()).iter().map(|b| format!("{b:02x}")).collect::<String>()[..n].to_owned()
}

/// A JSON file of at most `max` bytes.
pub fn read_json(path: &std::path::Path, max: u64) -> Result<Option<Value>, String> {
  match std::fs::metadata(path) {
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(e) => Err(e.to_string()),
    Ok(m) if m.len() > max => Err("too large".into()),
    Ok(_) => {
      let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
      serde_json::from_str(&text).map(Some).map_err(|e| e.to_string())
    }
  }
}

#[cfg(test)]
pub mod fake {
  use std::collections::HashMap;
  use std::sync::Mutex;

  use super::*;

  /// Answers by URL prefix; records the requests.
  #[derive(Default)]
  pub struct FakeWeb {
    pub answers: Mutex<Vec<(String, Resp)>>,
    pub seen: Mutex<Vec<(String, String, Vec<(String, String)>, Option<String>)>>,
  }

  impl FakeWeb {
    pub fn answer(self, url: &str, status: u16, body: &str) -> Self {
      self.answers.lock().unwrap().push((url.into(), Resp { status, body: body.into(), content_type: "application/json".into(), retry_after: None }));
      self
    }
  }

  impl Web for FakeWeb {
    fn send(&self, req: Req) -> Result<Resp, String> {
      self.seen.lock().unwrap().push((req.method.into(), req.url.clone(), req.headers.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(), req.body.clone()));
      let answers = self.answers.lock().unwrap();
      answers.iter().find(|(u, _)| req.url.starts_with(u.as_str())).map(|(_, r)| r.clone()).ok_or_else(|| format!("no answer for {}", req.url))
    }
  }

  #[derive(Default)]
  pub struct FakeRunner {
    pub outputs: Mutex<HashMap<String, Output>>,
    pub found: Vec<String>,
  }

  impl Runner for FakeRunner {
    fn run(&self, program: &str, args: &[&str], _stdin: Option<&str>, _timeout: Duration) -> Result<Output, String> {
      let key = format!("{program} {}", args.join(" "));
      self.outputs.lock().unwrap().iter().find(|(k, _)| key.starts_with(k.as_str())).map(|(_, o)| o.clone()).ok_or_else(|| format!("not found: {key}"))
    }
    fn which(&self, program: &str) -> Option<PathBuf> {
      self.found.iter().any(|f| f == program).then(|| PathBuf::from(format!("/usr/local/bin/{program}")))
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn ok_usage(p: &str, pct: f64) -> Usage {
    Usage { session: Some(window(pct, 300, None)), ..Usage::new(p, Status::Ok) }
  }

  #[test]
  fn keeps_good_numbers_after_an_error_for_a_while() {
    let s = settle("grok", None, ok_usage("grok", 40.0), 0);
    assert_eq!(s.next_at, POLL_MS);
    let s = settle("grok", Some(s), Usage::error("grok", "boom", "server"), 60_000);
    assert_eq!(s.usage.status, Status::Error);
    assert_eq!(s.usage.session.as_ref().unwrap().used_percent, 40.0);
    assert_eq!(s.usage.error.as_deref(), Some("boom"));
    assert_eq!(s.next_at, 60_000 + 30_000);
    let s = settle("grok", Some(s), Usage::error("grok", "boom", "server"), 90_000);
    assert_eq!(s.next_at, 90_000 + 60_000);
    // Past 30 minutes the old numbers go.
    let s = settle("grok", Some(s), Usage::error("grok", "boom", "server"), KEEP_GOOD_MS + 1);
    assert!(s.usage.session.is_none());
  }

  #[test]
  fn flat_backoff_and_retry_after() {
    let s = settle("minimax", None, Usage::error("minimax", "x", "server"), 0);
    assert_eq!(s.next_at, 5 * 60_000);
    let mut u = Usage::error("cursor", "slow down", "rate-limited");
    u.retry_after_ms = Some(3_600_000);
    assert_eq!(settle("cursor", None, u, 0).next_at, 3_600_000);
  }

  #[test]
  fn parses_times_and_numbers() {
    assert_eq!(parse_iso("1970-01-01T00:00:01Z"), Some(1000));
    assert_eq!(timestamp(&serde_json::json!(1_700_000_000)), Some(1_700_000_000_000));
    assert_eq!(timestamp(&serde_json::json!("1700000000000")), Some(1_700_000_000_000));
    assert_eq!(num(&serde_json::json!("12.5")), Some(12.5));
    assert_eq!(window(120.4, 300, None).used_percent, 100.0);
  }

  #[test]
  fn reads_jwt_payloads() {
    use base64::Engine;
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"sub":"user_1","exp":10}"#);
    let jwt = format!("x.{payload}.y");
    assert_eq!(jwt_payload(&jwt).unwrap()["sub"], "user_1");
    assert_eq!(fingerprint("abc", 12), "ba7816bf8f01");
  }
}
