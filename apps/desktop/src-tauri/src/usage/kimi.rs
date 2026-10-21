//! Kimi Code's plan usage, the way Orca reads it: the access token in
//! `$KIMI_CODE_HOME/credentials/kimi-code.json` (default `~/.kimi-code`), sent only to
//! `GET <KIMI_CODE_BASE_URL or https://api.kimi.com/coding/v1>/usages` — the same read the CLI's
//! own `/usage` makes, never the completion endpoint. The top-level `usage` is the weekly quota,
//! `limits[]` the rolling windows (the one nearest 5 hours is the session). The CLI rotates its
//! token every 15 minutes; Kingu never refreshes it (that would sign a running `kimi` out).

use std::path::PathBuf;

use serde_json::Value;

use super::io::{Host, Http, Request};
use super::{parse_time, ProviderUsage, Window, SESSION_MINUTES, WEEK_MINUTES};
use crate::i18n::msg::UsageMsg;
use crate::tr;

const P: &str = "kimi";

fn num(v: &Value) -> Option<f64> {
  match v {
    Value::Number(n) => n.as_f64(),
    Value::String(s) => s.trim().parse().ok(),
    _ => None,
  }
  .filter(|n: &f64| n.is_finite())
}

fn minutes(w: &Value) -> Option<u32> {
  let d = num(&w["duration"])?;
  let unit = w["timeUnit"].as_str().unwrap_or("").to_uppercase();
  let m = if unit.contains("MINUTE") {
    d
  } else if unit.contains("HOUR") {
    d * 60.0
  } else if unit.contains("DAY") {
    d * 1440.0
  } else if unit.contains("SECOND") {
    (d / 60.0).round()
  } else {
    d
  };
  Some(m.max(0.0) as u32)
}

fn window(d: &Value, window_minutes: u32) -> Option<Window> {
  let limit = num(&d["limit"]).filter(|l| *l > 0.0)?;
  let used = num(&d["used"]).or_else(|| Some(limit - num(&d["remaining"])?))?;
  let reset = if d["resetTime"].is_null() { &d["resetAt"] } else { &d["resetTime"] };
  Some(Window { used_percent: (used / limit * 100.0).clamp(0.0, 100.0), window_minutes, resets_at: parse_time(reset) })
}

pub fn parse(body: &str) -> ProviderUsage {
  let v: Value = serde_json::from_str(body).ok().filter(Value::is_object).unwrap_or(Value::Object(Default::default()));
  let weekly = window(&v["usage"], WEEK_MINUTES);
  let mut session: Option<Window> = None;
  for l in v["limits"].as_array().into_iter().flatten() {
    let m = minutes(&l["window"]).unwrap_or(SESSION_MINUTES);
    let Some(w) = window(&l["detail"], m) else { continue };
    if session.as_ref().is_none_or(|s| m.abs_diff(SESSION_MINUTES) < s.window_minutes.abs_diff(SESSION_MINUTES)) {
      session = Some(w);
    }
  }
  if session.is_none() && weekly.is_none() {
    return ProviderUsage::failed(P, "error", "parse", &tr!(UsageMsg::Unreadable, provider = "Kimi"));
  }
  ProviderUsage { session, weekly, ..ProviderUsage::new(P) }
}

fn home(host: &dyn Host) -> Option<PathBuf> {
  host.var("KIMI_CODE_HOME").map(PathBuf::from).or_else(|| Some(host.home()?.join(".kimi-code")))
}

pub fn fetch(http: &dyn Http, host: &dyn Host, now: i64) -> ProviderUsage {
  let unreadable = || ProviderUsage::failed(P, "error", "parse", &tr!(UsageMsg::KimiUnreadable));
  let text = match home(host).map(|h| host.read(&h.join("credentials/kimi-code.json"))) {
    Some(Ok(Some(t))) => t,
    Some(Err(())) => return unreadable(),
    _ => return ProviderUsage::failed(P, "unavailable", "missing-credentials", &tr!(UsageMsg::KimiSignedOut)),
  };
  let Some(creds) = serde_json::from_str::<Value>(&text).ok().filter(Value::is_object) else { return unreadable() };
  let Some(token) = creds["access_token"].as_str().filter(|t| !t.is_empty()) else { return unreadable() };
  // `expires_at` is in seconds; a token about to lapse is not sent.
  if creds["expires_at"].as_f64().is_none_or(|e| e - (now / 1000) as f64 <= 5.0) {
    return ProviderUsage::failed(P, "error", "delegated-refresh-required", &tr!(UsageMsg::KimiExpired));
  }
  let base = host.var("KIMI_CODE_BASE_URL").unwrap_or_else(|| "https://api.kimi.com/coding/v1".into());
  let url = format!("{}/usages", base.trim_end_matches('/'));
  let req = Request::get(&url).header("Authorization", format!("Bearer {token}")).header("Accept", "application/json");
  match http.send(&req) {
    Err(kind) => ProviderUsage::failed(P, "error", kind, &tr!(UsageMsg::Network, provider = "Kimi")),
    Ok(r) if matches!(r.status, 401 | 403) => ProviderUsage::failed(P, "error", "stale-token", &tr!(UsageMsg::KeyRejected, provider = "Kimi")),
    Ok(r) if !(200..300).contains(&r.status) => ProviderUsage::failed(P, "error", if r.status == 429 { "rate-limited" } else { "server" }, &tr!(UsageMsg::RequestFailed, provider = "Kimi", status = r.status)),
    Ok(r) => parse(&r.body),
  }
}

#[cfg(test)]
mod tests {
  use super::super::io::fake::{FakeHost, FakeHttp, HOME};
  use super::*;

  const NOW: i64 = 1_792_000_000_000;
  const BODY: &str = r#"{"usage":{"limit":"1000","used":"250","resetTime":"2026-10-25T00:00:00Z"},
    "limits":[{"window":{"duration":1,"timeUnit":"TIME_UNIT_DAY"},"detail":{"limit":10,"remaining":9}},
              {"window":{"duration":300,"timeUnit":"TIME_UNIT_MINUTE"},"detail":{"limit":100,"remaining":40}}]}"#;

  fn creds(expires: i64) -> FakeHost {
    FakeHost::new().file(&format!("{HOME}/.kimi-code/credentials/kimi-code.json"), &format!(r#"{{"access_token":"kt","refresh_token":"r","expires_at":{expires}}}"#))
  }

  #[test]
  fn maps_windows() {
    let u = parse(BODY);
    assert_eq!(u.weekly.as_ref().map(|w| (w.used_percent, w.window_minutes)), Some((25.0, WEEK_MINUTES)));
    assert_eq!(u.session.map(|w| (w.used_percent, w.window_minutes)), Some((60.0, 300)), "the window nearest 5 h");
    assert_eq!(parse("{}").status, "error");
  }

  #[test]
  fn reads_the_cli_token_and_never_refreshes() {
    let http = FakeHttp::new(vec![FakeHttp::ok(BODY)]);
    assert_eq!(fetch(&http, &creds(NOW / 1000 + 600), NOW).status, "ok");
    assert_eq!(http.urls(), ["https://api.kimi.com/coding/v1/usages"]);
    assert_eq!(http.header(0, "authorization").as_deref(), Some("Bearer kt"));
    let http = FakeHttp::new(vec![]);
    assert_eq!(fetch(&http, &creds(NOW / 1000 + 2), NOW).failure_kind.as_deref(), Some("delegated-refresh-required"));
    assert_eq!(fetch(&http, &FakeHost::new(), NOW).status, "unavailable");
    assert!(http.urls().is_empty());
    let custom = creds(NOW / 1000 + 600).var("KIMI_CODE_BASE_URL", "https://staging.example/v1/");
    let http = FakeHttp::new(vec![FakeHttp::status(401)]);
    assert_eq!(fetch(&http, &custom, NOW).failure_kind.as_deref(), Some("stale-token"));
    assert_eq!(http.urls(), ["https://staging.example/v1/usages"]);
  }
}
