//! Grok CLI's plan usage, the way Orca reads it: the session in `$GROK_HOME/auth.json` (default
//! `~/.grok`; the `https://auth.x.ai` entry first, another issuer only when that one is absent),
//! sent only to xAI's CLI proxy (`GROK_CLI_CHAT_PROXY_BASE_URL`, default
//! `https://cli-chat-proxy.grok.com/v1`): `GET /billing?format=credits` for the weekly credits
//! (`creditUsagePercent`), else a monthly budget (`used` / `monthlyLimit`), from `/billing` when
//! the credits view has neither. Kingu never runs `grok login` or refreshes the token: an expired
//! one waits for the next `grok` run.

use std::path::PathBuf;

use serde_json::Value;

use super::io::{Host, Http, Request};
use super::{parse_time, ProviderUsage, Window, MONTH_MINUTES, WEEK_MINUTES};
use crate::i18n::msg::UsageMsg;
use crate::tr;

const P: &str = "grok";
const ISSUER: &str = "https://auth.x.ai";
const SKEW_MS: i64 = 5 * 60_000;

#[derive(Debug, Clone, PartialEq)]
pub struct Session {
  pub token: String,
  pub user_id: Option<String>,
  pub expires_at: Option<i64>,
}

fn session(v: &Value) -> Option<Session> {
  let token = v.get("key")?.as_str().filter(|k| !k.is_empty())?.to_owned();
  Some(Session { token, user_id: v["user_id"].as_str().map(str::to_owned), expires_at: v.get("expires_at").and_then(parse_time) })
}

fn fresh(s: &Session, now: i64) -> bool {
  s.expires_at.is_none_or(|e| e - now > SKEW_MS)
}

/// `Ok(None)`: signed out (no file, or no token in it). `Err`: unreadable.
pub fn read_session(text: &str, now: i64) -> Result<Option<Session>, ()> {
  let v: Value = serde_json::from_str(text).map_err(|_| ())?;
  let obj = v.as_object().ok_or(())?;
  let (mut preferred_seen, mut expired, mut other) = (false, None, None);
  for (k, e) in obj {
    let preferred = k == ISSUER || k.starts_with(&format!("{ISSUER}::"));
    preferred_seen |= preferred;
    let Some(s) = session(e) else { continue };
    if preferred {
      if fresh(&s, now) {
        return Ok(Some(s));
      }
      expired.get_or_insert(s);
    } else {
      other.get_or_insert(s);
    }
  }
  Ok(expired.or(if preferred_seen { None } else { other }))
}

fn money(v: &Value) -> Option<f64> {
  match &v["val"] {
    Value::Number(n) => n.as_f64(),
    Value::String(s) => s.trim().parse().ok(),
    _ => None,
  }
  .filter(|n: &f64| n.is_finite())
}

fn period_end(c: &Value) -> Option<i64> {
  c["currentPeriod"]["end"].as_str().or(c["billingPeriodEnd"].as_str()).and_then(|s| parse_time(&Value::String(s.to_owned())))
}

pub fn monthly(c: &Value) -> Option<Window> {
  let (limit, used) = (money(&c["monthlyLimit"])?, money(&c["used"])?);
  (limit > 0.0).then(|| Window { used_percent: (used / limit * 100.0).clamp(0.0, 100.0), window_minutes: MONTH_MINUTES, resets_at: period_end(c) })
}

fn same_time(a: &Value, b: &Value) -> bool {
  matches!((parse_time(a), parse_time(b)), (Some(x), Some(y)) if x == y)
}

fn weekly_pct(c: &Value) -> Option<f64> {
  match &c["creditUsagePercent"] {
    Value::Number(n) => return n.as_f64().filter(|x| x.is_finite()),
    Value::Null => {}
    _ => return None,
  }
  // No percent: zero only when the period is confirmed weekly and the spend fields do not say
  // the percent was merely left out (Orca's rule).
  let scalars = ["onDemandCap", "onDemandUsed", "prepaidBalance", "monthlyLimit", "used"];
  let unreported = if money(&c["onDemandCap"]) == Some(0.0) {
    ["onDemandUsed", "used"].iter().any(|k| money(&c[*k]).unwrap_or(0.0) > 0.0)
  } else {
    scalars.iter().any(|k| money(&c[*k]) == Some(0.0))
  };
  if unreported || monthly(c).is_some() {
    return None;
  }
  let p = &c["currentPeriod"];
  (p["type"] == "USAGE_PERIOD_TYPE_WEEKLY" && same_time(&p["start"], &c["billingPeriodStart"]) && same_time(&p["end"], &c["billingPeriodEnd"])).then_some(0.0)
}

pub fn weekly(c: &Value) -> Option<Window> {
  Some(Window { used_percent: weekly_pct(c)?.clamp(0.0, 100.0), window_minutes: WEEK_MINUTES, resets_at: period_end(c) })
}

const FLAT: [&str; 10] = ["creditUsagePercent", "currentPeriod", "billingPeriodStart", "billingPeriodEnd", "subscriptionTier", "monthlyLimit", "used", "onDemandCap", "onDemandUsed", "prepaidBalance"];

fn config(v: &Value) -> Option<&Value> {
  if v["config"].is_object() {
    return Some(&v["config"]);
  }
  FLAT.iter().any(|k| !v[*k].is_null()).then_some(v)
}

fn base_url(host: &dyn Host) -> String {
  host.var("GROK_CLI_CHAT_PROXY_BASE_URL").map(|u| u.trim_end_matches('/').to_owned()).unwrap_or_else(|| "https://cli-chat-proxy.grok.com/v1".into())
}

fn billing(http: &dyn Http, url: &str, s: &Session) -> Result<Value, ProviderUsage> {
  let mut req = Request::get(url).header("Authorization", format!("Bearer {}", s.token)).header("X-XAI-Token-Auth", "xai-grok-cli").header("Accept", "application/json");
  if let Some(id) = &s.user_id {
    req = req.header("x-userid", id.clone());
  }
  let r = http.send(&req).map_err(|kind| ProviderUsage::failed(P, "error", kind, &tr!(UsageMsg::Network, provider = "Grok")))?;
  match r.status {
    200..=299 => Ok(serde_json::from_str::<Value>(&r.body).ok().filter(Value::is_object).unwrap_or(Value::Object(Default::default()))),
    401 | 403 => Err(ProviderUsage::failed(P, "error", "stale-token", &tr!(UsageMsg::KeyRejected, provider = "Grok"))),
    code => Err(ProviderUsage::failed(P, "error", if code == 429 { "rate-limited" } else { "server" }, &tr!(UsageMsg::RequestFailed, provider = "Grok", status = code))),
  }
}

fn home(host: &dyn Host) -> Option<PathBuf> {
  host.var("GROK_HOME").map(PathBuf::from).filter(|p| p.is_absolute()).or_else(|| Some(host.home()?.join(".grok")))
}

pub fn fetch(http: &dyn Http, host: &dyn Host, now: i64) -> ProviderUsage {
  let signed_out = || ProviderUsage::failed(P, "unavailable", "missing-credentials", &tr!(UsageMsg::GrokSignedOut));
  let s = match home(host).map(|h| host.read(&h.join("auth.json"))) {
    Some(Ok(Some(text))) => match read_session(&text, now) {
      Ok(Some(s)) => s,
      Ok(None) => return signed_out(),
      Err(()) => return ProviderUsage::failed(P, "error", "parse", &tr!(UsageMsg::GrokUnreadable)),
    },
    Some(Err(())) => return ProviderUsage::failed(P, "error", "parse", &tr!(UsageMsg::GrokUnreadable)),
    _ => return signed_out(),
  };
  if !fresh(&s, now) {
    return ProviderUsage::failed(P, "error", "delegated-refresh-required", &tr!(UsageMsg::GrokExpired));
  }
  let base = base_url(host);
  let credits = match billing(http, &format!("{base}/billing?format=credits"), &s) {
    Ok(v) => v,
    Err(u) => return u,
  };
  let Some(c) = config(&credits) else {
    return ProviderUsage::failed(P, "unavailable", "usage-unavailable", &tr!(UsageMsg::GrokNoQuota));
  };
  let tier = c["subscriptionTier"].as_str().map(str::trim).filter(|t| !t.is_empty()).map(str::to_owned);
  let ok = |weekly: Option<Window>, monthly: Option<Window>| ProviderUsage { weekly, monthly, plan_type: tier.clone(), ..ProviderUsage::new(P) };
  if let Some(w) = weekly(c) {
    return ok(Some(w), None);
  }
  if let Some(m) = monthly(c) {
    return ok(None, Some(m));
  }
  let plain = match billing(http, &format!("{base}/billing"), &s) {
    Ok(v) => v,
    Err(u) => return u,
  };
  let pc = if plain["config"].is_object() { &plain["config"] } else { &plain };
  match monthly(pc) {
    Some(m) => ok(None, Some(m)),
    None => ProviderUsage::failed(P, "unavailable", "usage-unavailable", &tr!(UsageMsg::GrokNoQuota)),
  }
}

#[cfg(test)]
mod tests {
  use super::super::io::fake::{FakeHost, FakeHttp, HOME};
  use super::*;
  use serde_json::json;

  const NOW: i64 = 1_792_000_000_000;

  #[test]
  fn picks_the_xai_session() {
    let text = json!({
      "https://other.example": {"key": "o1"},
      "https://auth.x.ai::client": {"key": "x1", "user_id": "u9", "expires_at": "2026-12-01T00:00:00Z"}
    })
    .to_string();
    let s = read_session(&text, NOW).unwrap().unwrap();
    assert_eq!((s.token.as_str(), s.user_id.as_deref()), ("x1", Some("u9")));
    // Another issuer is used only when there is no xAI entry at all.
    assert_eq!(read_session(r#"{"https://other.example":{"key":"o1"}}"#, NOW).unwrap().unwrap().token, "o1");
    assert_eq!(read_session(r#"{"https://auth.x.ai":{},"https://o":{"key":"o1"}}"#, NOW).unwrap(), None);
    assert!(read_session("[", NOW).is_err());
  }

  #[test]
  fn weekly_or_monthly() {
    let c = json!({"creditUsagePercent": 37.5, "currentPeriod": {"end": "2026-10-25T00:00:00Z"}});
    assert_eq!(weekly(&c).map(|w| (w.used_percent, w.window_minutes)), Some((37.5, WEEK_MINUTES)));
    let c = json!({"monthlyLimit": {"val": "200"}, "used": {"val": 50}, "billingPeriodEnd": "2026-11-01T00:00:00Z"});
    assert_eq!((weekly(&c), monthly(&c).map(|m| m.used_percent)), (None, Some(25.0)));
    let confirmed = json!({"currentPeriod": {"type": "USAGE_PERIOD_TYPE_WEEKLY", "start": "2026-10-18T00:00:00Z", "end": "2026-10-25T00:00:00Z"}, "billingPeriodStart": "2026-10-18T00:00:00Z", "billingPeriodEnd": "2026-10-25T00:00:00Z"});
    assert_eq!(weekly(&confirmed).map(|w| w.used_percent), Some(0.0));
    let mut spent = confirmed.clone();
    spent["onDemandCap"] = json!({"val": "0"});
    spent["onDemandUsed"] = json!({"val": "3"});
    assert_eq!(weekly(&spent), None, "spend past a zero cap is not zero usage");
    let mut zero = confirmed.clone();
    zero["prepaidBalance"] = json!({"val": 0});
    assert_eq!(weekly(&zero), None);
  }

  #[test]
  fn fetches_with_the_cli_headers() {
    let host = FakeHost::new().file(&format!("{HOME}/.grok/auth.json"), r#"{"https://auth.x.ai":{"key":"tok","user_id":"u1"}}"#);
    let http = FakeHttp::new(vec![FakeHttp::ok(r#"{"config":{"subscriptionTier":"SuperGrok"}}"#), FakeHttp::ok(r#"{"monthlyLimit":{"val":"10"},"used":{"val":"9"}}"#)]);
    let u = fetch(&http, &host, NOW);
    assert_eq!((u.status.as_str(), u.monthly.map(|m| m.used_percent), u.plan_type.as_deref()), ("ok", Some(90.0), Some("SuperGrok")));
    assert_eq!(http.urls(), ["https://cli-chat-proxy.grok.com/v1/billing?format=credits", "https://cli-chat-proxy.grok.com/v1/billing"]);
    assert_eq!(http.header(0, "authorization").as_deref(), Some("Bearer tok"));
    assert_eq!(http.header(0, "x-xai-token-auth").as_deref(), Some("xai-grok-cli"));
    assert_eq!(http.header(0, "x-userid").as_deref(), Some("u1"));
  }

  #[test]
  fn never_refreshes() {
    let expired = FakeHost::new().file(&format!("{HOME}/.grok/auth.json"), r#"{"https://auth.x.ai":{"key":"t","expires_at":"2020-01-01T00:00:00Z"}}"#);
    let http = FakeHttp::new(vec![]);
    assert_eq!(fetch(&http, &expired, NOW).failure_kind.as_deref(), Some("delegated-refresh-required"));
    assert_eq!(fetch(&http, &FakeHost::new(), NOW).status, "unavailable");
    assert!(http.urls().is_empty());
    let host = FakeHost::new().file(&format!("{HOME}/.grok/auth.json"), r#"{"https://auth.x.ai":{"key":"t"}}"#);
    assert_eq!(fetch(&FakeHttp::new(vec![FakeHttp::status(401)]), &host, NOW).failure_kind.as_deref(), Some("stale-token"));
  }
}
