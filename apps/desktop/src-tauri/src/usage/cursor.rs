//! Cursor's plan allowance, the way Orca reads it: the session token of the account this computer
//! is signed in to, from `cursor-agent`'s Keychain item (`cursor-access-token` / `cursor-user`),
//! else its older `~/.cursor/auth.json` (`accessToken`), else the Cursor IDE's `state.vscdb`
//! (`cursorAuth/accessToken`), preferring one that has not expired. The token is a JWT whose `sub`
//! makes the dashboard cookie `WorkosCursorSessionToken=<sub>::<jwt>`, sent only to cursor.com:
//! `GET /api/usage-summary` (plan pools over the billing cycle), else for request-quota plans
//! `GET /api/usage?user=<sub>`. Kingu never runs `cursor-agent login` or refreshes the token.

use std::path::PathBuf;

use base64::Engine;
use serde_json::Value;

use super::io::{Host, Http, Request};
use super::{parse_time, retry_at, Bucket, ProviderUsage, Window, MONTH_MINUTES};
use crate::i18n::msg::UsageMsg;
use crate::tr;

const P: &str = "cursor";
const ORIGIN: &str = "https://cursor.com";
pub const SUMMARY_URL: &str = "https://cursor.com/api/usage-summary";
const LEGACY_URL: &str = "https://cursor.com/api/usage";
const KEYCHAIN_SERVICE: &str = "cursor-access-token";
const KEYCHAIN_ACCOUNT: &str = "cursor-user";

#[derive(Debug, Clone, PartialEq)]
pub struct Session {
  pub raw: String,
  pub subject: String,
  pub expires_at: Option<i64>,
  /// `keychain`, `cli` or `desktop`.
  pub source: &'static str,
  pub plan: Option<String>,
}

/// The JWT's `sub` and `exp` (Unix ms); not verified, only read.
pub fn parse_token(raw: &str, source: &'static str) -> Option<Session> {
  let raw = raw.trim();
  let payload = raw.split('.').nth(1).filter(|p| !p.is_empty())?;
  let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
  let v: Value = serde_json::from_slice(&bytes).ok()?;
  let subject = v.get("sub")?.as_str()?.trim();
  if subject.is_empty() {
    return None;
  }
  let expires_at = v.get("exp").and_then(Value::as_f64).filter(|e| e.is_finite()).map(|e| (e * 1000.0) as i64);
  Some(Session { raw: raw.to_owned(), subject: subject.to_owned(), expires_at, source, plan: None })
}

fn expired(s: &Session, now: i64) -> bool {
  s.expires_at.is_some_and(|e| e <= now)
}

/// The URL-escaped `<sub>::<jwt>` cookie the dashboard sends.
pub fn cookie(s: &Session) -> String {
  let sub: String = url::form_urlencoded::byte_serialize(s.subject.as_bytes()).collect();
  format!("WorkosCursorSessionToken={sub}%3A%3A{}", s.raw)
}

fn roots(host: &dyn Host) -> Option<(PathBuf, PathBuf)> {
  let home = host.home()?;
  Some(if cfg!(target_os = "macos") {
    (home.join(".cursor"), home.join("Library/Application Support/Cursor"))
  } else if cfg!(windows) {
    let app = host.var("APPDATA").map(PathBuf::from).unwrap_or_else(|| home.join("AppData/Roaming"));
    (app.join("Cursor"), app.join("Cursor"))
  } else {
    let cfg = host.var("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".config"));
    (cfg.join("cursor"), cfg.join("Cursor"))
  })
}

/// Ok(None): not signed in anywhere. Err: a source could not be read and none gave a session.
pub fn read_session(host: &dyn Host, now: i64) -> Result<Option<Session>, ()> {
  let Some((cli, desktop)) = roots(host) else { return Ok(None) };
  let mut failed = false;
  let mut stale: Option<Session> = None;
  let mut take = |s: Option<Session>| -> Option<Session> {
    let s = s?;
    if expired(&s, now) {
      stale.get_or_insert(s);
      return None;
    }
    Some(s)
  };
  match host.keychain(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
    Ok(Some(t)) => {
      if let Some(s) = take(parse_token(&t, "keychain")) {
        return Ok(Some(s));
      }
    }
    Ok(None) => {}
    Err(()) => failed = true,
  }
  match host.read(&cli.join("auth.json")) {
    Ok(Some(text)) => {
      let token = serde_json::from_str::<Value>(&text).ok().and_then(|v| v.get("accessToken")?.as_str().map(str::to_owned));
      if let Some(s) = take(token.and_then(|t| parse_token(&t, "cli"))) {
        return Ok(Some(s));
      }
    }
    Ok(None) => {}
    Err(()) => failed = true,
  }
  // The IDE locks its database while it runs: a busy read is not reported.
  let db = desktop.join("User/globalStorage/state.vscdb");
  if let Ok(Some(t)) = host.item_table(&db, "cursorAuth/accessToken") {
    let plan = host.item_table(&db, "cursorAuth/stripeMembershipType").ok().flatten();
    if let Some(s) = take(parse_token(&t, "desktop").map(|s| Session { plan, ..s })) {
      return Ok(Some(s));
    }
  }
  match stale {
    Some(s) => Ok(Some(s)),
    None if failed => Err(()),
    None => Ok(None),
  }
}

fn num(v: &Value) -> Option<f64> {
  match v {
    Value::Number(n) => n.as_f64(),
    Value::String(s) if !s.trim().is_empty() => s.trim().parse().ok(),
    _ => None,
  }
  .filter(|n: &f64| n.is_finite())
}

/// Cursor mixes seconds and milliseconds.
fn ts(v: &Value) -> Option<i64> {
  match v {
    Value::Number(n) => n.as_f64().map(|x| if x > 1e12 { x as i64 } else { (x * 1000.0) as i64 }),
    Value::String(s) if s.trim().bytes().all(|b| b.is_ascii_digit()) => ts(&serde_json::json!(s.trim().parse::<f64>().ok()?)),
    _ => parse_time(v),
  }
}

fn pool_pct(pool: &Value, field: &str) -> Option<f64> {
  if !pool.is_object() {
    return None;
  }
  match (num(&pool["used"]), num(&pool["limit"])) {
    (Some(u), Some(l)) if l > 0.0 => Some(u / l * 100.0),
    _ => num(&pool[field]),
  }
}

pub struct Summary {
  pub monthly: Option<Window>,
  pub buckets: Vec<Bucket>,
  pub plan: Option<String>,
  pub unlimited: bool,
}

/// `/api/usage-summary`: the plan pool as the monthly window, the model pools as buckets.
pub fn map_summary(v: &Value) -> Summary {
  let (start, end) = (ts(&v["billingCycleStart"]), ts(&v["billingCycleEnd"]));
  let window_minutes = match (start, end) {
    (Some(s), Some(e)) if e > s => (((e - s) as f64 / 60_000.0).round() as u32).max(1),
    _ => MONTH_MINUTES,
  };
  let win = |pct: f64| Window { used_percent: pct.clamp(0.0, 100.0), window_minutes, resets_at: end };
  let bucket = |name: &str, pct: f64| {
    let w = win(pct);
    Bucket { name: name.to_owned(), used_percent: w.used_percent, window_minutes: w.window_minutes, resets_at: w.resets_at }
  };
  let plan = &v["individualUsage"]["plan"];
  // A team-billed account reports 0% pools it does not own.
  let plan_on = plan.is_object() && plan["enabled"] != false;
  let mut buckets = Vec::new();
  if plan_on {
    if let Some(p) = num(&plan["autoPercentUsed"]) {
      buckets.push(bucket("Cursor Models", p));
    }
    if let Some(p) = num(&plan["apiPercentUsed"]) {
      buckets.push(bucket("Other Models", p));
    }
  }
  let od = &v["individualUsage"]["onDemand"];
  if od["enabled"] == true
    && let Some(p) = pool_pct(od, "totalPercentUsed")
  {
    buckets.push(bucket("On-demand", p));
  }
  let pct = plan_on.then(|| num(&plan["totalPercentUsed"]).or_else(|| pool_pct(plan, "totalPercentUsed"))).flatten();
  Summary {
    monthly: pct.map(win),
    buckets,
    plan: v["membershipType"].as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned),
    unlimited: v["isUnlimited"] == true,
  }
}

/// Unix ms one calendar month after `ms` (UTC), the day clamped (Jan 31 → Feb 28/29).
fn add_month(ms: i64) -> i64 {
  let (days, rem) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
  // Civil from days (Howard Hinnant).
  let z = days + 719_468;
  let era = z.div_euclid(146_097);
  let doe = z - era * 146_097;
  let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let d = doy - (153 * mp + 2) / 5 + 1;
  let m = if mp < 10 { mp + 3 } else { mp - 9 };
  let y = yoe + era * 400 + i64::from(m <= 2);
  let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
  let leap = ny % 4 == 0 && (ny % 100 != 0 || ny % 400 == 0);
  let last = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][(nm - 1) as usize];
  let nd = d.min(last);
  let (y2, m2) = if nm <= 2 { (ny - 1, nm + 9) } else { (ny, nm - 3) };
  let era = y2.div_euclid(400);
  let yoe = y2 - era * 400;
  let doy = (153 * m2 + 2) / 5 + nd - 1;
  let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  (era * 146_097 + doe - 719_468) * 86_400_000 + rem
}

/// `/api/usage`: request quotas per model; `gpt-4` is the premium one, else the largest.
pub fn map_legacy(v: &Value) -> Option<Window> {
  let obj = v.as_object()?;
  let mut quotas: Vec<(&str, f64, f64)> = obj
    .iter()
    .filter_map(|(k, b)| {
      let limit = num(b.get("maxRequestUsage")?).filter(|l| *l > 0.0)?;
      Some((k.as_str(), num(b.get("numRequests")?)?, limit))
    })
    .collect();
  quotas.sort_by(|a, b| b.2.total_cmp(&a.2));
  let q = quotas.iter().find(|q| q.0 == "gpt-4").or(quotas.first())?;
  Some(Window { used_percent: (q.1 / q.2 * 100.0).clamp(0.0, 100.0), window_minutes: MONTH_MINUTES, resets_at: ts(&v["startOfMonth"]).map(add_month) })
}

fn get(http: &dyn Http, url: &str, s: &Session, now: i64) -> Result<Value, ProviderUsage> {
  let req = Request::get(url).header("Cookie", cookie(s)).header("Accept", "application/json").header("Origin", ORIGIN).header("Referer", format!("{ORIGIN}/dashboard"));
  let r = http.send(&req).map_err(|kind| ProviderUsage::failed(P, "error", kind, &tr!(UsageMsg::Network, provider = "Cursor")))?;
  match r.status {
    200..=299 => serde_json::from_str(&r.body).map_err(|_| ProviderUsage::failed(P, "error", "parse", &tr!(UsageMsg::Unreadable, provider = "Cursor"))),
    // A redirect is the dashboard sending a stale session to sign in.
    401 | 300..=399 => Err(ProviderUsage::failed(P, "error", "stale-token", &tr!(UsageMsg::CursorExpired))),
    429 => Err(ProviderUsage { retry_at_ms: retry_at(r.retry_after.as_deref(), now), ..ProviderUsage::failed(P, "error", "rate-limited", &tr!(UsageMsg::RateLimited, provider = "Cursor")) }),
    code => Err(ProviderUsage::failed(P, "error", "server", &tr!(UsageMsg::RequestFailed, provider = "Cursor", status = code))),
  }
}

pub fn fetch(http: &dyn Http, host: &dyn Host, now: i64) -> ProviderUsage {
  let s = match read_session(host, now) {
    Ok(Some(s)) => s,
    Ok(None) => return ProviderUsage::failed(P, "unavailable", "missing-credentials", &tr!(UsageMsg::CursorSignedOut)),
    Err(()) => return ProviderUsage::failed(P, "error", "keychain-unavailable", &tr!(UsageMsg::CursorUnreadable)),
  };
  // cursor-agent refreshes its own token when it runs; an expired one would only 401.
  if expired(&s, now) {
    return ProviderUsage::failed(P, "error", "stale-token", &tr!(UsageMsg::CursorExpired));
  }
  let summary = match get(http, SUMMARY_URL, &s, now) {
    Ok(v) => map_summary(&v),
    Err(u) => return u,
  };
  let plan_type = summary.plan.or(s.plan.clone());
  let base = ProviderUsage { plan_type: plan_type.clone(), ..ProviderUsage::new(P) };
  if summary.unlimited {
    return base;
  }
  if summary.monthly.is_some() || !summary.buckets.is_empty() {
    return ProviderUsage { monthly: summary.monthly, buckets: summary.buckets, ..base };
  }
  let user: String = url::form_urlencoded::byte_serialize(s.subject.as_bytes()).collect();
  match get(http, &format!("{LEGACY_URL}?user={user}"), &s, now) {
    Err(u) => u,
    Ok(v) => match map_legacy(&v) {
      Some(w) => ProviderUsage { monthly: Some(w), ..base },
      // A healthy account whose plan shows no quota (API-key or team billing).
      None => ProviderUsage { plan_type, ..ProviderUsage::failed(P, "unavailable", "usage-unavailable", &tr!(UsageMsg::CursorNoAllowance)) },
    },
  }
}

#[cfg(test)]
mod tests {
  use super::super::io::fake::{FakeHost, FakeHttp, HOME};
  use super::*;
  use serde_json::json;

  fn jwt(sub: &str, exp: i64) -> String {
    let e = |v: Value| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v.to_string());
    format!("{}.{}.sig", e(json!({"alg":"none"})), e(json!({"sub": sub, "exp": exp})))
  }

  const NOW: i64 = 1_800_000_000_000;

  fn cli_auth(token: &str) -> (String, String) {
    let dir = if cfg!(target_os = "macos") { format!("{HOME}/.cursor") } else { format!("{HOME}/.config/cursor") };
    (format!("{dir}/auth.json"), json!({ "accessToken": token }).to_string())
  }

  #[test]
  fn reads_the_jwt_and_builds_the_cookie() {
    let s = parse_token(&jwt("auth0|user_1", 1_900_000_000), "cli").unwrap();
    assert_eq!((s.subject.as_str(), s.expires_at), ("auth0|user_1", Some(1_900_000_000_000)));
    assert!(cookie(&s).starts_with("WorkosCursorSessionToken=auth0%7Cuser_1%3A%3Aey"));
    assert_eq!(parse_token("not-a-jwt", "cli"), None);
  }

  #[test]
  fn prefers_a_live_session() {
    let (path, text) = cli_auth(&jwt("u", 1_000));
    let mut host = FakeHost::new().file(&path, &text);
    host.keychain.insert((KEYCHAIN_SERVICE.into(), KEYCHAIN_ACCOUNT.into()), jwt("k", 1_900_000_000));
    assert_eq!(read_session(&host, NOW).unwrap().unwrap().source, "keychain");
    host.keychain.clear();
    let s = read_session(&host, NOW).unwrap().unwrap();
    assert!(expired(&s, NOW), "only an expired one: still returned, to say so");
    assert_eq!(read_session(&FakeHost::new(), NOW), Ok(None));
  }

  #[test]
  fn maps_summary_pools() {
    let v = json!({"billingCycleStart":"2026-10-01T00:00:00Z","billingCycleEnd":"2026-10-31T00:00:00Z","membershipType":"pro",
      "individualUsage":{"plan":{"enabled":true,"used":500,"limit":2000,"autoPercentUsed":10,"apiPercentUsed":"30"},"onDemand":{"enabled":true,"used":5,"limit":10}}});
    let m = map_summary(&v);
    let w = m.monthly.unwrap();
    assert_eq!((w.used_percent, w.window_minutes), (25.0, 30 * 1440));
    assert_eq!(m.buckets.iter().map(|b| (b.name.as_str(), b.used_percent)).collect::<Vec<_>>(), [("Cursor Models", 10.0), ("Other Models", 30.0), ("On-demand", 50.0)]);
    assert_eq!(m.plan.as_deref(), Some("pro"));
    let team = map_summary(&json!({"individualUsage":{"plan":{"enabled":false,"totalPercentUsed":0}}}));
    assert!(team.monthly.is_none() && team.buckets.is_empty());
  }

  #[test]
  fn legacy_quota_and_months() {
    let v = json!({"gpt-4":{"numRequests":50,"maxRequestUsage":500},"gpt-3.5":{"numRequests":1,"maxRequestUsage":9999},"startOfMonth":"2026-01-31T10:00:00Z"});
    let w = map_legacy(&v).unwrap();
    assert_eq!(w.used_percent, 10.0);
    assert_eq!(w.resets_at, parse_time(&json!("2026-02-28T10:00:00Z")));
    assert_eq!(add_month(parse_time(&json!("2024-12-15T00:00:00Z")).unwrap()), parse_time(&json!("2025-01-15T00:00:00Z")).unwrap());
    assert_eq!(map_legacy(&json!({"startOfMonth": 1})), None);
  }

  #[test]
  fn fetches_only_from_cursor_com() {
    let (path, text) = cli_auth(&jwt("u1", 1_900_000_000));
    let host = FakeHost::new().file(&path, &text);
    let http = FakeHttp::new(vec![FakeHttp::ok(r#"{"membershipType":"free"}"#), FakeHttp::ok(r#"{"gpt-4":{"numRequests":5,"maxRequestUsage":50}}"#)]);
    let u = fetch(&http, &host, NOW);
    assert_eq!((u.status.as_str(), u.monthly.map(|w| w.used_percent), u.plan_type.as_deref()), ("ok", Some(10.0), Some("free")));
    assert_eq!(http.urls(), [SUMMARY_URL.to_owned(), format!("{LEGACY_URL}?user=u1")]);
    assert!(http.header(0, "cookie").unwrap().starts_with("WorkosCursorSessionToken=u1%3A%3A"));
    let limited = FakeHttp::new(vec![Ok(super::super::io::Response { status: 429, retry_after: Some("60".into()), ..Default::default() })]);
    let u = fetch(&limited, &host, NOW);
    assert_eq!((u.failure_kind.as_deref(), u.retry_at_ms), (Some("rate-limited"), Some(NOW + 60_000)));
    // Expired: nothing is sent.
    let (path, text) = cli_auth(&jwt("u1", 1_000));
    let http = FakeHttp::new(vec![]);
    assert_eq!(fetch(&http, &FakeHost::new().file(&path, &text), NOW).failure_kind.as_deref(), Some("stale-token"));
    assert!(http.urls().is_empty());
    assert_eq!(fetch(&http, &FakeHost::new(), NOW).status, "unavailable");
  }
}
