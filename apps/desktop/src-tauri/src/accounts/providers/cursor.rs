//! Cursor plan usage (Orca's cursor-fetcher): the sign-in already on this computer — the macOS
//! Keychain item cursor-agent keeps, `~/.cursor/auth.json`, then Cursor IDE's `state.vscdb` — read
//! only. Its JWT's subject makes the dashboard session cookie for `api/usage-summary` (the two
//! plan pools and on-demand spend, reset with the billing cycle), with `api/usage` as the old form.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use super::{Bucket, Ctx, Req, Status, Usage, fingerprint, jwt_payload, num, read_json, retry_after_ms, timestamp, window};
use crate::i18n::msg::ProvidersMsg;
use crate::tr;

const P: &str = "cursor";
const SUMMARY_URL: &str = "https://cursor.com/api/usage-summary";
const LEGACY_URL: &str = "https://cursor.com/api/usage";

#[derive(Debug, Clone, PartialEq)]
pub struct Login {
  pub token: String,
  /// keychain, cli or desktop.
  pub source: &'static str,
  pub email: Option<String>,
  pub display_name: Option<String>,
  pub membership: Option<String>,
}

impl Login {
  pub fn subject(&self) -> Option<String> {
    jwt_payload(&self.token)?["sub"].as_str().map(str::to_owned)
  }

  pub fn expires(&self) -> Option<u64> {
    jwt_payload(&self.token)?["exp"].as_u64().map(|s| s * 1000)
  }

  pub fn fresh(&self, now: u64) -> bool {
    self.expires().is_none_or(|e| e > now)
  }
}

fn cli_identity(home: &Path) -> (Option<String>, Option<String>) {
  let v = read_json(&home.join(".cursor/cli-config.json"), 1 << 20).ok().flatten().unwrap_or(Value::Null);
  (v["authInfo"]["email"].as_str().map(str::to_owned), v["authInfo"]["displayName"].as_str().map(str::to_owned))
}

/// Every sign-in found, in Orca's order, plus the first read error.
pub fn logins(ctx: &Ctx) -> (Vec<Login>, Option<String>) {
  let mut out = Vec::new();
  let mut error = None;
  let (email, display_name) = cli_identity(&ctx.home);
  if cfg!(target_os = "macos") {
    match ctx.run.run("/usr/bin/security", &["find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w"], None, Duration::from_secs(5)) {
      Ok(o) if o.code == Some(0) && !o.stdout.trim().is_empty() => {
        out.push(Login { token: o.stdout.trim().into(), source: "keychain", email: email.clone(), display_name: display_name.clone(), membership: None })
      }
      Ok(o) if o.code == Some(44) => {}
      Ok(_) | Err(_) => error = Some(tr!(ProvidersMsg::CursorKeychain)),
    }
  }
  match read_json(&ctx.home.join(".cursor/auth.json"), 1 << 20) {
    Ok(Some(v)) => {
      if let Some(t) = v["accessToken"].as_str().filter(|t| !t.is_empty()) {
        out.push(Login { token: t.into(), source: "cli", email: email.clone(), display_name: display_name.clone(), membership: None });
      }
    }
    Ok(None) => {}
    Err(e) if e.contains("expected") || e.contains("EOF") => error = error.or(Some(tr!(ProvidersMsg::CursorAuthInvalid))),
    Err(_) => error = error.or(Some(tr!(ProvidersMsg::CursorAuthUnreadable))),
  }
  let db = ctx.home.join("Library/Application Support/Cursor/User/globalStorage/state.vscdb");
  if db.is_file() {
    let sql = "SELECT key, CAST(value AS TEXT) AS value FROM ItemTable WHERE key IN ('cursorAuth/accessToken','cursorAuth/cachedEmail','cursorAuth/stripeMembershipType')";
    // The IDE may hold the file locked; its errors are not worth showing.
    if let Ok(o) = ctx.run.run("/usr/bin/sqlite3", &["-readonly", "-json", "-cmd", ".timeout 250", &db.display().to_string(), sql], None, Duration::from_secs(10))
      && let Ok(rows) = serde_json::from_str::<Vec<Value>>(o.stdout.trim())
    {
      let get = |k: &str| rows.iter().find(|r| r["key"] == k).and_then(|r| r["value"].as_str()).map(str::to_owned).filter(|v| !v.is_empty());
      if let Some(token) = get("cursorAuth/accessToken") {
        out.push(Login { token, source: "desktop", email: get("cursorAuth/cachedEmail"), display_name: None, membership: get("cursorAuth/stripeMembershipType") });
      }
    }
  }
  (out, error)
}

/// The first live sign-in, else the first expired one (so the user is told to sign in again).
pub fn best(logins: Vec<Login>, now: u64) -> Option<Login> {
  let first = logins.first().cloned();
  logins.into_iter().find(|l| l.subject().is_some() && l.fresh(now)).or(first)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorStatus {
  pub signed_in: bool,
  pub email: Option<String>,
  pub display_name: Option<String>,
  pub credential_source: Option<String>,
  pub plan_type: Option<String>,
  pub token_fresh: bool,
  pub error: Option<String>,
}

pub fn status(ctx: &Ctx) -> CursorStatus {
  let (all, error) = logins(ctx);
  match best(all, ctx.now) {
    None => CursorStatus { signed_in: false, email: None, display_name: None, credential_source: None, plan_type: None, token_fresh: false, error },
    Some(l) => CursorStatus {
      signed_in: true,
      token_fresh: l.fresh(ctx.now),
      credential_source: Some(l.source.into()),
      email: l.email,
      display_name: l.display_name,
      plan_type: l.membership,
      error,
    },
  }
}

pub fn fetch(ctx: &Ctx) -> Usage {
  let Some(login) = best(logins(ctx).0, ctx.now) else { return Usage::unavailable(P, tr!(ProvidersMsg::CursorNoLogin), "missing-credentials") };
  let Some(sub) = login.subject() else { return Usage::error(P, tr!(ProvidersMsg::CursorExpired), "stale-token") };
  if !login.fresh(ctx.now) {
    return Usage::error(P, tr!(ProvidersMsg::CursorExpired), "stale-token");
  }
  let cookie = format!("WorkosCursorSessionToken={}%3A%3A{}", urlencoding_component(&sub), login.token);
  let get = |url: String| ctx.web.send(Req::get(url).header("Cookie", cookie.clone()).header("Accept", "application/json").header("Origin", "https://cursor.com").header("Referer", "https://cursor.com/dashboard").timeout(10));
  let provenance = fingerprint(&sub, 12);
  let res = match get(SUMMARY_URL.into()) {
    Ok(r) => r,
    Err(_) => return Usage::error(P, tr!(ProvidersMsg::CursorRequestFailed), "network"),
  };
  match res.status {
    401 => return Usage::error(P, tr!(ProvidersMsg::CursorExpired), "stale-token"),
    429 => return Usage { retry_after_ms: retry_after_ms(res.retry_after.as_deref()), ..Usage::error(P, tr!(ProvidersMsg::CursorRateLimited), "rate-limited") },
    s if !(200..300).contains(&s) => return Usage::error(P, tr!(ProvidersMsg::CursorHttp, status = s), "server"),
    _ => {}
  }
  let Some(v) = res.json() else { return Usage::error(P, tr!(ProvidersMsg::CursorParse), "parse") };
  let mut u = parse_summary(&v);
  u.provenance = Some(provenance.clone());
  if u.plan.is_none() {
    u.plan = login.membership.clone();
  }
  if v["isUnlimited"] == true || u.monthly.is_some() || !u.buckets.is_empty() {
    return u;
  }
  // The old per-model request counts.
  match get(format!("{LEGACY_URL}?user={}", urlencoding_component(&sub))) {
    Ok(r) if r.ok() => match r.json().and_then(|v| parse_legacy(&v)) {
      Some(m) => Usage { monthly: Some(m), provenance: Some(provenance), ..u },
      None => Usage::unavailable(P, tr!(ProvidersMsg::CursorNoAllowance), "usage-unavailable"),
    },
    _ => Usage::unavailable(P, tr!(ProvidersMsg::CursorNoAllowance), "usage-unavailable"),
  }
}

fn urlencoding_component(s: &str) -> String {
  url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>().replace('+', "%20")
}

/// The billing-cycle windows: "Cursor Models", "Other Models", "On-demand", and the plan total.
pub fn parse_summary(v: &Value) -> Usage {
  let start = timestamp(&v["billingCycleStart"]);
  let end = timestamp(&v["billingCycleEnd"]);
  let minutes = match (start, end) {
    (Some(s), Some(e)) if e > s => ((e - s) / 60_000) as u32,
    _ => 43200,
  };
  let w = |pct: f64| window(pct, minutes, end);
  let plan = &v["individualUsage"]["plan"];
  let on_demand = &v["individualUsage"]["onDemand"];
  let mut buckets = Vec::new();
  if plan["enabled"] != false {
    if let Some(p) = num(&plan["autoPercentUsed"]) {
      buckets.push(Bucket { name: "Cursor Models".into(), window: w(p) });
    }
    if let Some(p) = num(&plan["apiPercentUsed"]) {
      buckets.push(Bucket { name: "Other Models".into(), window: w(p) });
    }
  }
  if on_demand["enabled"] == true {
    let pct = match (num(&on_demand["used"]), num(&on_demand["limit"])) {
      (Some(u), Some(l)) if l > 0.0 => Some(u / l * 100.0),
      _ => num(&on_demand["totalPercentUsed"]),
    };
    if let Some(p) = pct {
      buckets.push(Bucket { name: "On-demand".into(), window: w(p) });
    }
  }
  let monthly = num(&plan["totalPercentUsed"])
    .or_else(|| match (num(&plan["used"]), num(&plan["limit"])) {
      (Some(u), Some(l)) if l > 0.0 => Some(u / l * 100.0),
      _ => None,
    })
    .map(w);
  let unlimited = v["isUnlimited"] == true;
  Usage {
    monthly: if unlimited { None } else { monthly },
    buckets: if unlimited { Vec::new() } else { buckets },
    plan: v["membershipType"].as_str().map(str::to_owned),
    ..Usage::new(P, Status::Ok)
  }
}

/// `{ "<model>": {numRequests, maxRequestUsage}, startOfMonth }`: gpt-4, else the biggest allowance.
pub fn parse_legacy(v: &Value) -> Option<super::super::usage::Window> {
  let obj = v.as_object()?;
  let pick = obj.get("gpt-4").filter(|m| num(&m["maxRequestUsage"]).is_some_and(|x| x > 0.0)).or_else(|| {
    obj.values().filter(|m| num(&m["maxRequestUsage"]).is_some_and(|x| x > 0.0)).max_by(|a, b| num(&a["maxRequestUsage"]).unwrap_or(0.0).total_cmp(&num(&b["maxRequestUsage"]).unwrap_or(0.0)))
  })?;
  let pct = num(&pick["numRequests"]).unwrap_or(0.0) / num(&pick["maxRequestUsage"])? * 100.0;
  let resets = v["startOfMonth"].as_str().and_then(super::parse_iso).map(next_month);
  Some(window(pct, 43200, resets))
}

/// The same day and time one month later (UTC), the day clamped to that month.
fn next_month(ms: u64) -> u64 {
  let Ok(t) = time::OffsetDateTime::from_unix_timestamp((ms / 1000) as i64) else { return ms };
  let (y, m) = if t.month() == time::Month::December { (t.year() + 1, time::Month::January) } else { (t.year(), t.month().next()) };
  let day = t.day().min(m.length(y));
  time::Date::from_calendar_date(y, m, day).ok().map(|d| (d.with_time(t.time()).assume_utc().unix_timestamp() as u64) * 1000).unwrap_or(ms)
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn reads_the_summary_pools() {
    let u = parse_summary(&json!({
      "billingCycleStart": "1970-01-01T00:00:00Z", "billingCycleEnd": "1970-01-31T00:00:00Z", "membershipType": "pro",
      "individualUsage": { "plan": { "enabled": true, "autoPercentUsed": 25, "apiPercentUsed": "0", "totalPercentUsed": 20 }, "onDemand": { "enabled": true, "used": 5, "limit": 20 } }
    }));
    assert_eq!(u.buckets.iter().map(|b| (b.name.as_str(), b.window.used_percent)).collect::<Vec<_>>(), vec![("Cursor Models", 25.0), ("Other Models", 0.0), ("On-demand", 25.0)]);
    assert_eq!(u.monthly.as_ref().unwrap().window_minutes, 30 * 1440);
    assert_eq!(u.plan.as_deref(), Some("pro"));
    assert!(parse_summary(&json!({ "isUnlimited": true, "individualUsage": { "plan": { "totalPercentUsed": 5 } } })).monthly.is_none());
  }

  #[test]
  fn reads_the_old_request_counts() {
    let w = parse_legacy(&json!({ "gpt-4": { "numRequests": 50, "maxRequestUsage": 500 }, "startOfMonth": "2024-01-31T00:00:00Z" })).unwrap();
    assert_eq!(w.used_percent, 10.0);
    assert_eq!(w.resets_at, super::super::parse_iso("2024-02-29T00:00:00Z"));
  }

  #[test]
  fn prefers_a_live_login() {
    use base64::Engine;
    let jwt = |exp: u64| format!("h.{}.s", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(format!(r#"{{"sub":"u","exp":{exp}}}"#)));
    let login = |t: String, source| Login { token: t, source, email: None, display_name: None, membership: None };
    let picked = best(vec![login(jwt(1), "keychain"), login(jwt(4_000_000_000), "cli")], 5_000).unwrap();
    assert_eq!(picked.source, "cli");
    assert_eq!(best(vec![login(jwt(1), "keychain")], 5_000).unwrap().source, "keychain");
  }
}
