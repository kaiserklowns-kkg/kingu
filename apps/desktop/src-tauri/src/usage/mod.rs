//! Agent usage limits for the status bar, read the way Orca reads them: Claude's session and
//! weekly windows from Anthropic's OAuth usage endpoint with Claude Code's own sign-in (Keychain,
//! else `~/.claude/.credentials.json`), Codex's from ChatGPT's usage endpoint with
//! `~/.codex/auth.json`, and Gemini CLI's quota (Orca's Gemini provider) from Google's Code
//! Assist endpoints with `~/.gemini/oauth_creds.json` when `kingu.usage.gemini` is on. Tokens are
//! only ever sent to the service that issued them, never logged, and never refreshed here (the
//! CLI refreshes its own; Orca can also refresh Gemini's with the CLI's bundled OAuth client).
//!
//! Orca's other providers each live in a file of their own (opencode, minimax, zcode, cursor,
//! grok, kimi, antigravity), through the [`io`] seams; the credentials a user pastes for them
//! (cookies, API keys) are in the Keychain ([`secrets`]).

pub mod antigravity;
pub mod cursor;
pub mod grok;
pub mod io;
pub mod kimi;
pub mod minimax;
pub mod opencode;
pub mod secrets;
pub mod zcode;

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
pub const GEMINI_PROJECT_URL: &str = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
pub const GEMINI_QUOTA_URL: &str = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
/// Gemini's quotas reset daily.
const GEMINI_WINDOW_MINUTES: u32 = 1440;
const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Window {
  /// 0–100.
  pub used_percent: f64,
  pub window_minutes: u32,
  /// Unix ms.
  pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
  pub provider: String,
  /// `ok`, `error` or `unavailable`.
  pub status: String,
  pub session: Option<Window>,
  pub weekly: Option<Window>,
  /// A 30-day (or billing-cycle) window: OpenCode Go, Grok, Cursor and ZCode report one.
  pub monthly: Option<Window>,
  /// Named pools (Cursor's model pools, Antigravity's model groups).
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub buckets: Vec<Bucket>,
  pub plan_type: Option<String>,
  pub error: Option<String>,
  /// Orca's failure kinds: `missing-credentials`, `stale-token`, `rate-limited`, `network`, …
  pub failure_kind: Option<String>,
  /// Unix ms before which a rate-limited provider should not be asked again.
  pub retry_at_ms: Option<i64>,
  pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
  pub name: String,
  pub used_percent: f64,
  pub window_minutes: u32,
  pub resets_at: Option<i64>,
}

pub const SESSION_MINUTES: u32 = 300;
pub const WEEK_MINUTES: u32 = 10_080;
pub const MONTH_MINUTES: u32 = 43_200;

pub(crate) fn now_ms() -> i64 {
  std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

impl ProviderUsage {
  pub(crate) fn new(provider: &str) -> Self {
    Self {
      provider: provider.into(),
      status: "ok".into(),
      session: None,
      weekly: None,
      monthly: None,
      buckets: Vec::new(),
      plan_type: None,
      error: None,
      failure_kind: None,
      retry_at_ms: None,
      updated_at: now_ms(),
    }
  }
  pub(crate) fn failed(provider: &str, status: &str, kind: &str, message: &str) -> Self {
    Self { status: status.into(), error: Some(message.into()), failure_kind: Some(kind.into()), ..Self::new(provider) }
  }
}

/// Seconds, milliseconds, a numeric string or an ISO date, as Unix ms.
pub(crate) fn parse_time(v: &Value) -> Option<i64> {
  let n = match v {
    Value::Number(n) => n.as_f64(),
    Value::String(s) => s.parse::<f64>().ok().or_else(|| chrono_like(s)),
    _ => None,
  }?;
  Some(if n > 1e10 { n as i64 } else { (n * 1000.0) as i64 })
}

/// `2026-10-18T12:00:00Z` (with optional fraction and offset) as Unix seconds.
fn chrono_like(s: &str) -> Option<f64> {
  let (date, rest) = s.split_once('T')?;
  let mut d = date.split('-').map(|p| p.parse::<i64>().ok());
  let (y, m, day) = (d.next()??, d.next()??, d.next()??);
  let (time, offset) = match rest.find(['Z', '+']).or_else(|| rest.rfind('-')) {
    Some(i) => (&rest[..i], &rest[i..]),
    None => (rest, "Z"),
  };
  let mut t = time.split(':');
  let (hh, mm) = (t.next()?.parse::<i64>().ok()?, t.next()?.parse::<i64>().ok()?);
  let ss = t.next().and_then(|x| x.parse::<f64>().ok()).unwrap_or(0.0);
  let off = if offset == "Z" || offset.is_empty() {
    0
  } else {
    let sign = if offset.starts_with('-') { -1 } else { 1 };
    let mut o = offset[1..].split(':');
    sign * (o.next()?.parse::<i64>().ok()? * 3600 + o.next().and_then(|x| x.parse::<i64>().ok()).unwrap_or(0) * 60)
  };
  // Days from the civil date (Howard Hinnant's algorithm).
  let (y2, m2) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
  let era = y2.div_euclid(400);
  let yoe = y2 - era * 400;
  let doy = (153 * m2 + 2) / 5 + day - 1;
  let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
  Some((days * 86_400 + hh * 3600 + mm * 60 - off) as f64 + ss)
}

/// One of Claude's windows (`five_hour`, `seven_day`): `utilization` is already 0–100.
fn claude_window(v: Option<&Value>, minutes: u32) -> Option<Window> {
  let v = v?;
  let used = v.get("utilization").or_else(|| v.get("used_percentage")).and_then(Value::as_f64)?;
  Some(Window { used_percent: used.clamp(0.0, 100.0), window_minutes: minutes, resets_at: v.get("resets_at").and_then(parse_time) })
}

pub fn parse_claude(body: &Value) -> ProviderUsage {
  ProviderUsage {
    session: claude_window(body.get("five_hour"), 300),
    weekly: claude_window(body.get("seven_day"), 10_080),
    ..ProviderUsage::new("claude")
  }
}

/// The Keychain item Claude Code keeps its sign-in in: suffixed by a hash of the config dir when
/// `CLAUDE_CONFIG_DIR` points elsewhere.
fn keychain_service() -> String {
  match std::env::var("CLAUDE_CONFIG_DIR") {
    Ok(dir) if !dir.is_empty() => {
      use sha2::Digest;
      let hex = format!("{:x}", sha2::Sha256::digest(dir.as_bytes()));
      format!("Claude Code-credentials-{}", &hex[..8])
    }
    _ => "Claude Code-credentials".into(),
  }
}

fn keychain_account() -> String {
  let user = std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_default();
  if !user.is_empty() && user.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) { user } else { "claude-code-user".into() }
}

fn claude_config_dir() -> Option<PathBuf> {
  match std::env::var("CLAUDE_CONFIG_DIR") {
    Ok(dir) if !dir.is_empty() => Some(PathBuf::from(dir)),
    _ => dirs_home().map(|h| h.join(".claude")),
  }
}

fn dirs_home() -> Option<PathBuf> {
  std::env::var_os("HOME").map(PathBuf::from)
}

/// `{ claudeAiOauth: { accessToken, refreshToken } }` → (token, has refresh token).
fn oauth_from(text: &str) -> Option<(Option<String>, bool)> {
  let v: Value = serde_json::from_str(text.trim()).ok()?;
  let o = v.get("claudeAiOauth")?;
  Some((o.get("accessToken").and_then(Value::as_str).map(str::to_owned), o.get("refreshToken").and_then(Value::as_str).is_some()))
}

fn claude_credentials() -> Option<(Option<String>, bool)> {
  if cfg!(target_os = "macos") {
    let out = std::process::Command::new("/usr/bin/security")
      .args(["find-generic-password", "-s", &keychain_service(), "-a", &keychain_account(), "-w"])
      .output()
      .ok();
    if let Some(found) = out.filter(|o| o.status.success()).and_then(|o| oauth_from(&String::from_utf8_lossy(&o.stdout)))
      && found.0.is_some()
    {
      return Some(found);
    }
  }
  let file = claude_config_dir()?.join(".credentials.json");
  oauth_from(&std::fs::read_to_string(file).ok()?)
}

fn client() -> Result<reqwest::blocking::Client, String> {
  reqwest::blocking::Client::builder().timeout(TIMEOUT).build().map_err(|e| e.to_string())
}

/// `Retry-After` in seconds or as an HTTP date is not parsed for dates; seconds, capped at 24h.
fn retry_after(res: &reqwest::blocking::Response) -> Option<i64> {
  let secs = res.headers().get("retry-after")?.to_str().ok()?.trim().parse::<i64>().ok()?;
  Some(now_ms() + secs.clamp(0, 86_400) * 1000)
}

fn network_kind(e: &reqwest::Error) -> &'static str {
  if e.is_timeout() || e.is_connect() || e.is_request() { "network" } else { "unknown" }
}

pub fn fetch_claude() -> ProviderUsage {
  const P: &str = "claude";
  let Some((token, refreshable)) = claude_credentials() else {
    return ProviderUsage::failed(P, "unavailable", "missing-credentials", "No subscription plan — API key billing");
  };
  let Some(token) = token else {
    return if refreshable {
      ProviderUsage::failed(P, "error", "refreshable-credentials-without-token", "Claude sign-in is being refreshed.")
    } else {
      ProviderUsage::failed(P, "unavailable", "missing-credentials", "No subscription plan — API key billing")
    };
  };
  let res = client().and_then(|c| {
    c.get(CLAUDE_USAGE_URL)
      .bearer_auth(token)
      .header("anthropic-beta", "oauth-2025-04-20")
      .header("User-Agent", "claude-code/2.1.0")
      .send()
      .map_err(|e| format!("{}:{e}", network_kind(&e)))
  });
  let res = match res {
    Ok(r) => r,
    Err(e) => {
      let (kind, _) = e.split_once(':').unwrap_or(("unknown", ""));
      return ProviderUsage::failed(P, "error", kind, "Claude usage is unavailable.");
    }
  };
  let code = res.status().as_u16();
  match code {
    200..=299 => match res.json::<Value>() {
      Ok(body) => parse_claude(&body),
      Err(_) => ProviderUsage::failed(P, "error", "parse", "Claude usage is unavailable."),
    },
    429 => ProviderUsage { retry_at_ms: retry_after(&res), ..ProviderUsage::failed(P, "error", "rate-limited", "Claude usage is rate limited right now.") },
    401 | 403 => {
      let text = res.text().unwrap_or_default();
      if code == 403 && text.contains("user:profile") {
        ProviderUsage::failed(P, "error", "missing-scope", text.trim())
      } else {
        ProviderUsage::failed(P, "error", "stale-token", "Claude usage updates the next time Claude runs.")
      }
    }
    500.. => ProviderUsage::failed(P, "error", "server", "Claude usage is unavailable."),
    _ => ProviderUsage::failed(P, "error", "usage-unavailable", "Claude usage is unavailable."),
  }
}

fn codex_home() -> Option<PathBuf> {
  match std::env::var("CODEX_HOME") {
    Ok(dir) if !dir.is_empty() => Some(PathBuf::from(dir)),
    _ => dirs_home().map(|h| h.join(".codex")),
  }
}

/// A Codex window by its length: about 5 hours is the session, about a week the weekly one.
fn codex_window(v: Option<&Value>) -> Option<(Window, u32)> {
  let v = v?;
  let used = v.get("used_percent").and_then(Value::as_f64)?;
  let minutes = (v.get("limit_window_seconds").and_then(Value::as_f64).unwrap_or(0.0) / 60.0).round() as u32;
  Some((Window { used_percent: used.clamp(0.0, 100.0), window_minutes: minutes, resets_at: v.get("reset_at").and_then(parse_time) }, minutes))
}

pub fn parse_codex(body: &Value) -> ProviderUsage {
  let mut u = ProviderUsage::new("codex");
  u.plan_type = body.get("plan_type").and_then(Value::as_str).map(str::to_owned);
  let limits = body.get("rate_limit");
  for key in ["primary_window", "secondary_window"] {
    if let Some((w, minutes)) = codex_window(limits.and_then(|l| l.get(key))) {
      if minutes.abs_diff(300) <= 1 {
        u.session = Some(w);
      } else if minutes.abs_diff(10_080) <= 1 {
        u.weekly = Some(w);
      } else if u.session.is_none() {
        u.session = Some(w);
      }
    }
  }
  u
}

pub fn fetch_codex() -> ProviderUsage {
  const P: &str = "codex";
  let auth: Option<Value> = codex_home().and_then(|h| std::fs::read_to_string(h.join("auth.json")).ok()).and_then(|t| serde_json::from_str(&t).ok());
  let tokens = auth.as_ref().and_then(|a| a.get("tokens"));
  let Some(token) = tokens.and_then(|t| t.get("access_token")).and_then(Value::as_str) else {
    return ProviderUsage::failed(P, "unavailable", "missing-credentials", "Codex not signed in");
  };
  let mut req = match client() {
    Ok(c) => c.get(CODEX_USAGE_URL),
    Err(e) => return ProviderUsage::failed(P, "error", "unknown", &e),
  };
  req = req.bearer_auth(token).header("User-Agent", "codex-cli").header("OpenAI-Beta", "codex-1").header("originator", "Codex Desktop");
  if let Some(account) = tokens.and_then(|t| t.get("account_id")).and_then(Value::as_str) {
    req = req.header("ChatGPT-Account-Id", account);
  }
  match req.send() {
    Ok(res) if res.status().is_success() => match res.json::<Value>() {
      Ok(body) => parse_codex(&body),
      Err(_) => ProviderUsage::failed(P, "error", "parse", "Unable to fetch usage"),
    },
    Ok(res) if res.status().as_u16() == 429 => ProviderUsage { retry_at_ms: retry_after(&res), ..ProviderUsage::failed(P, "error", "rate-limited", "Codex usage is rate limited right now.") },
    Ok(res) if matches!(res.status().as_u16(), 401 | 403) => ProviderUsage::failed(P, "error", "stale-token", "Your ChatGPT session could not be refreshed. Please sign in again."),
    Ok(res) => ProviderUsage::failed(P, "error", "usage-unavailable", &format!("Unable to fetch usage (HTTP {})", res.status().as_u16())),
    Err(e) => ProviderUsage::failed(P, "error", network_kind(&e), "Codex usage could not be refreshed because the network request failed."),
  }
}

// ---------------------------------------------------------------------------------------------
// Gemini

/// POSTs JSON with a bearer token: the status and the response text (a seam for tests).
pub trait JsonPost {
  fn post(&self, url: &str, token: &str, body: &Value) -> Result<(u16, String), &'static str>;
}

struct LivePost;

impl JsonPost for LivePost {
  fn post(&self, url: &str, token: &str, body: &Value) -> Result<(u16, String), &'static str> {
    let c = client().map_err(|_| "unknown")?;
    let res = c.post(url).bearer_auth(token).json(body).send().map_err(|e| network_kind(&e))?;
    let code = res.status().as_u16();
    Ok((code, res.text().unwrap_or_default()))
  }
}

/// `~/.gemini/oauth_creds.json`: the access token and when it expires (Unix ms), if it says.
pub fn gemini_token(text: &str) -> Option<(String, Option<i64>)> {
  let v: Value = serde_json::from_str(text.trim()).ok()?;
  let token = v.get("access_token").and_then(Value::as_str).filter(|t| !t.is_empty())?;
  Some((token.to_owned(), v.get("expiry_date").and_then(Value::as_f64).map(|n| n as i64)))
}

/// Orca's names for Gemini models; others lose `gemini-` and are title-cased.
pub fn gemini_model_name(id: &str) -> String {
  const KNOWN: &[(&str, &str)] = &[
    ("gemini-2.5-pro", "Pro"),
    ("gemini-2.5-flash", "Flash"),
    ("gemini-2.5-flash-lite", "Flash Lite"),
    ("gemini-3.1-pro", "3.1 Pro"),
    ("gemini-3.1-flash", "3.1 Flash"),
    ("gemini-3.1-flash-lite", "3.1 Flash Lite"),
    ("gemini-3.0-pro", "3.0 Pro"),
    ("gemini-3.0-flash", "3.0 Flash"),
    ("gemini-2.0-pro", "2.0 Pro"),
    ("gemini-2.0-flash", "2.0 Flash"),
    ("gemini-2.0-flash-lite", "2.0 Flash Lite"),
    ("gemini-1.5-pro", "1.5 Pro"),
    ("gemini-1.5-flash", "1.5 Flash"),
    ("gemini-exp", "Exp"),
    ("gemini-experimental", "Exp"),
  ];
  if let Some((_, n)) = KNOWN.iter().find(|(k, _)| *k == id) {
    return (*n).into();
  }
  id.trim_start_matches("gemini-").split('-').filter(|s| !s.is_empty()).map(|s| s[..1].to_uppercase() + &s[1..]).collect::<Vec<_>>().join(" ")
}

/// The quota buckets (`{ buckets: [{ remainingFraction, resetTime, modelId }] }`): one per model
/// (Orca's names; the same percent and reset only once, a known model first), and the most used
/// one as the daily session window.
pub fn parse_gemini(body: &Value) -> ProviderUsage {
  let list = body.get("buckets").and_then(Value::as_array).or_else(|| body.as_array()).cloned().unwrap_or_default();
  let mut best: Option<Window> = None;
  let mut buckets: Vec<(bool, Bucket)> = Vec::new();
  for b in &list {
    let Some(left) = b.get("remainingFraction").and_then(Value::as_f64).filter(|f| f.is_finite()) else { continue };
    let used = ((1.0 - left) * 100.0).clamp(0.0, 100.0).round();
    let w = Window { used_percent: used, window_minutes: GEMINI_WINDOW_MINUTES, resets_at: b.get("resetTime").and_then(parse_time) };
    if best.as_ref().is_none_or(|x| w.used_percent > x.used_percent) {
      best = Some(w.clone());
    }
    let Some(id) = b.get("modelId").and_then(Value::as_str) else { continue };
    let name = gemini_model_name(id);
    let known = name != id;
    let bucket = Bucket { name, used_percent: w.used_percent, window_minutes: w.window_minutes, resets_at: w.resets_at };
    match buckets.iter().position(|(_, x)| x.used_percent == bucket.used_percent && x.resets_at == bucket.resets_at) {
      Some(i) if (known && !buckets[i].0) || (known == buckets[i].0 && bucket.name.len() < buckets[i].1.name.len()) => buckets[i] = (known, bucket),
      Some(_) => {}
      None => buckets.push((known, bucket)),
    }
  }
  ProviderUsage { session: best, buckets: buckets.into_iter().map(|(_, b)| b).collect(), ..ProviderUsage::new("gemini") }
}

fn gemini_failed_http(code: u16) -> ProviderUsage {
  const P: &str = "gemini";
  match code {
    401 | 403 => ProviderUsage::failed(P, "error", "stale-token", "Gemini usage updates the next time Gemini CLI runs."),
    429 => ProviderUsage::failed(P, "error", "rate-limited", "Gemini usage is rate limited right now."),
    500.. => ProviderUsage::failed(P, "error", "server", "Gemini usage is unavailable."),
    _ => ProviderUsage::failed(P, "error", "usage-unavailable", &format!("Gemini quota fetch failed (HTTP {code})")),
  }
}

/// Gemini's quota with the CLI's own sign-in (`creds`: the oauth_creds.json text), at `now` (Unix ms).
pub fn fetch_gemini_with(post: &dyn JsonPost, creds: Option<&str>, now: i64) -> ProviderUsage {
  const P: &str = "gemini";
  let Some((token, expires)) = creds.and_then(gemini_token) else {
    return ProviderUsage::failed(P, "unavailable", "missing-credentials", "Gemini CLI not signed in");
  };
  if expires.is_some_and(|e| e <= now) {
    return ProviderUsage::failed(P, "error", "stale-token", "Gemini usage updates the next time Gemini CLI runs.");
  }
  let net = |kind: &str| ProviderUsage::failed(P, "error", kind, "Gemini usage could not be refreshed because the network request failed.");
  let project = match post.post(GEMINI_PROJECT_URL, &token, &serde_json::json!({ "metadata": { "ideType": "GEMINI_CLI", "pluginType": "GEMINI" } })) {
    Ok((200..=299, text)) => serde_json::from_str::<Value>(&text).ok().and_then(|v| v.get("cloudaicompanionProject").and_then(Value::as_str).map(str::to_owned)),
    Ok((code, _)) => return gemini_failed_http(code),
    Err(kind) => return net(kind),
  };
  let Some(project) = project else {
    return ProviderUsage::failed(P, "unavailable", "no-subscription", "No Gemini Code Assist project for this sign-in");
  };
  match post.post(GEMINI_QUOTA_URL, &token, &serde_json::json!({ "project": project })) {
    Ok((200..=299, text)) => match serde_json::from_str::<Value>(&text) {
      Ok(body) => parse_gemini(&body),
      Err(_) => ProviderUsage::failed(P, "error", "parse", "Gemini usage is unavailable."),
    },
    Ok((code, _)) => gemini_failed_http(code),
    Err(kind) => net(kind),
  }
}

fn gemini_home() -> Option<PathBuf> {
  match std::env::var("GEMINI_CLI_HOME") {
    Ok(dir) if !dir.is_empty() => Some(PathBuf::from(dir).join(".gemini")),
    _ => dirs_home().map(|h| h.join(".gemini")),
  }
}

pub fn fetch_gemini() -> ProviderUsage {
  let creds = gemini_home().and_then(|h| std::fs::read_to_string(h.join("oauth_creds.json")).ok());
  fetch_gemini_with(&LivePost, creds.as_deref(), now_ms())
}

/// Which agent CLIs are on the login PATH (Orca shows a provider's usage only when its agent is installed).
pub fn detect() -> Vec<String> {
  let path = crate::shell_env::path().or_else(|| std::env::var_os("PATH"));
  let dirs: Vec<PathBuf> = path.map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
  let home = dirs_home();
  let extra = home.iter().flat_map(|h| [h.join(".local/bin"), h.join(".claude/local")]);
  let all: Vec<PathBuf> = dirs.into_iter().chain(extra).collect();
  // (provider, program): Orca gates these providers' items on their CLI being installed.
  let cli = [("claude", "claude"), ("codex", "codex"), ("gemini", "gemini"), ("kimi", "kimi"), ("antigravity", "agy"), ("grok", "grok"), ("zcode", "zcode")];
  cli.into_iter().filter(|(_, bin)| all.iter().any(|d| is_file(&d.join(bin)))).map(|(p, _)| p.to_owned()).collect()
}

fn is_file(p: &Path) -> bool {
  p.is_file()
}

/// `Retry-After` in seconds as an absolute Unix ms (capped at a day); HTTP dates are not parsed.
pub(crate) fn retry_at(header: Option<&str>, now: i64) -> Option<i64> {
  let secs = header?.trim().parse::<i64>().ok()?;
  Some(now + secs.clamp(0, 86_400) * 1000)
}

/// The non-secret settings Orca's extra providers read, as the webview sends them.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
  /// `kingu.usage.opencode.workspaceId`.
  pub opencode_workspace_id: String,
  /// `kingu.usage.minimax.endpoint`: `overseas` or `cn`.
  pub minimax_endpoint: String,
  /// `kingu.usage.minimax.groupId`.
  pub minimax_group_id: String,
  /// `kingu.usage.minimax.models`.
  pub minimax_models: String,
  /// `kingu.usage.zcode.site`: `zai` or `bigmodel`.
  pub zcode_site: String,
}

/// One of Orca's other providers, with the live network, host and Keychain.
pub fn fetch_more(provider: &str, o: &Options) -> Option<ProviderUsage> {
  let (http, host, secrets) = (io::LiveHttp, io::LiveHost, secrets::UsageKeychain);
  fetch_more_with(provider, o, &http, &host, &secrets, now_ms())
}

pub fn fetch_more_with(provider: &str, o: &Options, http: &dyn io::Http, host: &dyn io::Host, secrets: &dyn crate::accounts::secrets::SecretStore, now: i64) -> Option<ProviderUsage> {
  Some(match provider {
    "opencode" => opencode::fetch(http, host, secrets, Some(o.opencode_workspace_id.as_str()), now),
    "minimax" => minimax::fetch(http, secrets, &minimax::Options { site: &o.minimax_endpoint, group_id: &o.minimax_group_id, models: &o.minimax_models }, now),
    "zcode" => zcode::fetch(http, host, secrets, &o.zcode_site, now),
    "cursor" => cursor::fetch(http, host, now),
    "grok" => grok::fetch(http, host, now),
    "kimi" => kimi::fetch(http, host, now),
    "antigravity" => antigravity::fetch(host),
    _ => return None,
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn maps_claude_windows() {
    let u = parse_claude(&json!({"five_hour": {"utilization": 71.4, "resets_at": "2026-10-18T12:00:00Z"}, "seven_day": {"utilization": 12, "resets_at": null}}));
    let s = u.session.unwrap();
    assert_eq!((s.used_percent, s.window_minutes, s.resets_at), (71.4, 300, Some(1_792_324_800_000)));
    assert_eq!(u.weekly.unwrap().resets_at, None);
    assert_eq!(u.status, "ok");
  }

  #[test]
  fn parses_times() {
    assert_eq!(parse_time(&json!(1_792_324_800)), Some(1_792_324_800_000));
    assert_eq!(parse_time(&json!(1_792_324_800_000_i64)), Some(1_792_324_800_000));
    assert_eq!(parse_time(&json!("2026-10-18T19:00:00.5+07:00")), Some(1_792_324_800_500));
  }

  #[test]
  fn classifies_codex_windows() {
    let u = parse_codex(&json!({"plan_type": "plus", "rate_limit": {
      "primary_window": {"used_percent": 30, "limit_window_seconds": 18000, "reset_at": 1_792_324_800},
      "secondary_window": {"used_percent": 60, "limit_window_seconds": 604800, "reset_at": 1_792_324_800}}}));
    assert_eq!(u.session.unwrap().used_percent, 30.0);
    assert_eq!(u.weekly.unwrap().window_minutes, 10_080);
    assert_eq!(u.plan_type.as_deref(), Some("plus"));
  }

  struct FakePost(std::sync::Mutex<Vec<(String, String, Value)>>, Vec<Result<(u16, String), &'static str>>);

  impl JsonPost for FakePost {
    fn post(&self, url: &str, token: &str, body: &Value) -> Result<(u16, String), &'static str> {
      let mut seen = self.0.lock().unwrap();
      seen.push((url.into(), token.into(), body.clone()));
      self.1.get(seen.len() - 1).cloned().unwrap_or(Err("network"))
    }
  }

  fn fake(replies: Vec<Result<(u16, String), &'static str>>) -> FakePost {
    FakePost(std::sync::Mutex::default(), replies)
  }

  const CREDS: &str = r#"{"access_token":"ya29.t","refresh_token":"r","expiry_date":2000}"#;

  #[test]
  fn maps_gemini_buckets_to_the_most_used() {
    let u = parse_gemini(&json!({"buckets": [
      {"remainingFraction": 0.9, "resetTime": "2026-10-18T12:00:00Z", "modelId": "gemini-2.5-flash"},
      {"remainingFraction": 0.25, "resetTime": "2026-10-18T12:00:00Z", "modelId": "gemini-2.5-pro"},
      {"remainingFraction": "x", "modelId": "bad"}]}));
    let s = u.session.unwrap();
    assert_eq!((s.used_percent, s.window_minutes, s.resets_at), (75.0, 1440, Some(1_792_324_800_000)));
    assert_eq!(u.weekly, None);
    assert_eq!(parse_gemini(&json!({})).session, None);
  }

  #[test]
  fn fetches_gemini_quota_with_the_clis_token() {
    let post = fake(vec![Ok((200, r#"{"cloudaicompanionProject":"proj-1"}"#.into())), Ok((200, r#"{"buckets":[{"remainingFraction":0.5,"resetTime":"2026-10-18T12:00:00Z","modelId":"gemini-2.5-pro"}]}"#.into()))]);
    let u = fetch_gemini_with(&post, Some(CREDS), 1000);
    assert_eq!((u.status.as_str(), u.session.map(|w| w.used_percent)), ("ok", Some(50.0)));
    let seen = post.0.lock().unwrap();
    assert_eq!((seen[0].0.as_str(), seen[0].1.as_str()), (GEMINI_PROJECT_URL, "ya29.t"));
    assert_eq!((seen[1].0.as_str(), &seen[1].2), (GEMINI_QUOTA_URL, &json!({"project": "proj-1"})));
  }

  #[test]
  fn gemini_failures_never_refresh_tokens() {
    let none = fake(vec![]);
    assert_eq!(fetch_gemini_with(&none, None, 0).failure_kind.as_deref(), Some("missing-credentials"));
    assert_eq!(fetch_gemini_with(&none, Some(CREDS), 5000).failure_kind.as_deref(), Some("stale-token"), "expired: wait for the CLI");
    assert!(none.0.lock().unwrap().is_empty(), "nothing was sent");
    let denied = fake(vec![Ok((401, String::new()))]);
    assert_eq!(fetch_gemini_with(&denied, Some(CREDS), 0).failure_kind.as_deref(), Some("stale-token"));
    let limited = fake(vec![Ok((200, r#"{"cloudaicompanionProject":"p"}"#.into())), Ok((429, String::new()))]);
    assert_eq!(fetch_gemini_with(&limited, Some(CREDS), 0).failure_kind.as_deref(), Some("rate-limited"));
    let no_project = fake(vec![Ok((200, "{}".into()))]);
    assert_eq!(fetch_gemini_with(&no_project, Some(CREDS), 0).status, "unavailable");
    assert_eq!(fetch_gemini_with(&fake(vec![]), Some(CREDS), 0).failure_kind.as_deref(), Some("network"));
    assert_eq!(gemini_token(r#"{"access_token":""}"#), None);
  }

  #[test]
  fn reads_oauth_blob() {
    assert_eq!(oauth_from(r#"{"claudeAiOauth":{"accessToken":"t","refreshToken":"r"}}"#), Some((Some("t".into()), true)));
    assert_eq!(oauth_from("{}"), None);
  }

  #[test]
  fn names_gemini_model_buckets() {
    let u = parse_gemini(&json!({"buckets": [
      {"remainingFraction": 0.25, "modelId": "gemini-2.5-pro"},
      {"remainingFraction": 0.9, "modelId": "gemini-2.5-flash-preview-x"},
      {"remainingFraction": 0.9, "modelId": "gemini-2.5-flash"}
    ]}));
    assert_eq!(u.buckets.iter().map(|b| b.name.as_str()).collect::<Vec<_>>(), vec!["Pro", "Flash"]);
    assert_eq!(gemini_model_name("gemini-9-ultra"), "9 Ultra");
  }

}
