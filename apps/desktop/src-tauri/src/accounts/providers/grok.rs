//! Grok (xAI) credit usage (Orca's grok-fetcher): the Grok CLI's own sign-in in
//! `$GROK_HOME/auth.json` (read only; Kingu never runs `grok login`), then the CLI proxy's
//! `billing?format=credits` for the weekly credit percent, and `billing` for a monthly limit.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use super::{Ctx, Req, Status, Usage, num, parse_iso, window};
use crate::i18n::msg::ProvidersMsg;
use crate::tr;

const P: &str = "grok";
const FRESH_MS: u64 = 5 * 60_000;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Auth {
  pub key: String,
  pub user_id: Option<String>,
  pub email: Option<String>,
  pub team_id: Option<String>,
  pub expires_at: Option<u64>,
}

pub fn auth_file(home: &Path) -> PathBuf {
  std::env::var_os("GROK_HOME").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| home.join(".grok")).join("auth.json")
}

/// The sign-in to use: a fresh `https://auth.x.ai` entry first, then an expired one, then any other issuer.
pub fn pick_auth(v: &Value, now: u64) -> Option<Auth> {
  let obj = v.as_object()?;
  let entry = |e: &Value| -> Option<Auth> {
    let key = e["key"].as_str().filter(|k| !k.is_empty())?;
    Some(Auth {
      key: key.into(),
      user_id: e["user_id"].as_str().map(str::to_owned),
      email: e["email"].as_str().map(str::to_owned),
      team_id: e["team_id"].as_str().map(str::to_owned),
      expires_at: e["expires_at"].as_str().and_then(parse_iso),
    })
  };
  let preferred: Vec<Auth> = obj.iter().filter(|(k, _)| *k == "https://auth.x.ai" || k.starts_with("https://auth.x.ai::")).filter_map(|(_, e)| entry(e)).collect();
  let list = if preferred.is_empty() { obj.values().filter_map(entry).collect() } else { preferred };
  list.iter().find(|a| fresh(a, now)).or(list.first()).cloned()
}

pub fn fresh(a: &Auth, now: u64) -> bool {
  a.expires_at.is_none_or(|e| e > now + FRESH_MS)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokStatus {
  pub signed_in: bool,
  pub email: Option<String>,
  pub team_id: Option<String>,
  pub token_fresh: bool,
  pub error: Option<String>,
}

fn read(home: &Path) -> Result<Option<Value>, String> {
  super::read_json(&auth_file(home), 1 << 20).map_err(|e| if e.contains("expected") || e.contains("EOF") { tr!(ProvidersMsg::GrokAuthInvalid) } else { tr!(ProvidersMsg::GrokAuthUnreadable) })
}

pub fn status(home: &Path, now: u64) -> GrokStatus {
  match read(home) {
    Err(e) => GrokStatus { signed_in: false, email: None, team_id: None, token_fresh: false, error: Some(e) },
    Ok(v) => match v.as_ref().and_then(|v| pick_auth(v, now)) {
      None => GrokStatus { signed_in: false, email: None, team_id: None, token_fresh: false, error: None },
      Some(a) => GrokStatus { signed_in: true, token_fresh: fresh(&a, now), email: a.email, team_id: a.team_id, error: None },
    },
  }
}

fn base() -> String {
  std::env::var("GROK_CLI_CHAT_PROXY_BASE_URL").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| "https://cli-chat-proxy.grok.com/v1".into()).trim_end_matches('/').to_owned()
}

pub fn fetch(ctx: &Ctx) -> Usage {
  let auth = match read(&ctx.home) {
    Err(e) => return Usage::error(P, e, "parse"),
    Ok(v) => v.as_ref().and_then(|v| pick_auth(v, ctx.now)),
  };
  let Some(auth) = auth else { return Usage::unavailable(P, tr!(ProvidersMsg::GrokSignedOut), "missing-credentials") };
  if !fresh(&auth, ctx.now) {
    return Usage::error(P, tr!(ProvidersMsg::GrokExpired), "delegated-refresh-required");
  }
  let get = |path: &str| {
    let mut req = Req::get(format!("{}{path}", base())).header("Authorization", format!("Bearer {}", auth.key)).header("X-XAI-Token-Auth", "xai-grok-cli").header("Accept", "application/json").timeout(10);
    if let Some(u) = &auth.user_id {
      req = req.header("x-userid", u.clone());
    }
    ctx.web.send(req)
  };
  let first = match get("/billing?format=credits") {
    Err(e) => return Usage::error(P, e, "network"),
    Ok(r) if r.status == 401 || r.status == 403 => return Usage::error(P, tr!(ProvidersMsg::GrokUnauthorized, status = r.status), "stale-token"),
    Ok(r) if !r.ok() => return Usage::error(P, tr!(ProvidersMsg::GrokFailed, status = r.status), "server"),
    Ok(r) => r.json().unwrap_or(Value::Null),
  };
  let provenance = format!("{} ({})", auth.email.clone().or(auth.user_id.clone()).unwrap_or_else(|| "Grok account".into()), config_of(&first).map(|c| c["subscriptionTier"].as_str().unwrap_or("").to_owned()).unwrap_or_default());
  let Some(cfg) = config_of(&first) else { return Usage::unavailable(P, tr!(ProvidersMsg::GrokNoConfig), "usage-unavailable") };
  let mut u = parse_billing(cfg);
  if u.monthly.is_none()
    && let Ok(r) = get("/billing")
    && r.ok()
    && let Some(v) = r.json()
    && let Some(c) = config_of(&v)
  {
    u.monthly = parse_billing(c).monthly;
  }
  if u.weekly.is_none() && u.monthly.is_none() {
    let money = ["monthlyLimit", "used", "onDemandCap", "onDemandUsed", "prepaidBalance"].iter().any(|k| cfg[*k].is_object());
    let msg = if money { tr!(ProvidersMsg::GrokNoPercent) } else { tr!(ProvidersMsg::GrokNoCredits) };
    return Usage::unavailable(P, msg, "usage-unavailable");
  }
  Usage { provenance: Some(provenance.trim_end_matches(" ()").to_owned()), ..u }
}

fn config_of(v: &Value) -> Option<&Value> {
  if v["config"].is_object() {
    return Some(&v["config"]);
  }
  let flat = ["creditUsagePercent", "currentPeriod", "billingPeriodEnd", "monthlyLimit", "used"].iter().any(|k| !v[*k].is_null());
  flat.then_some(v)
}

/// The weekly credit percent and a monthly `used / monthlyLimit` window.
pub fn parse_billing(c: &Value) -> Usage {
  let money = |k: &str| num(&c[k]["val"]);
  let resets = c["currentPeriod"]["end"].as_str().or(c["billingPeriodEnd"].as_str()).and_then(parse_iso);
  let monthly = match (money("used"), money("monthlyLimit")) {
    (Some(used), Some(limit)) if limit > 0.0 => Some(window(used / limit * 100.0, 43200, resets)),
    _ => None,
  };
  let weekly_period = c["currentPeriod"]["type"] == "USAGE_PERIOD_TYPE_WEEKLY"
    && c["currentPeriod"]["start"] == c["billingPeriodStart"]
    && c["currentPeriod"]["end"] == c["billingPeriodEnd"];
  let any_zero_money = ["monthlyLimit", "used", "onDemandCap", "onDemandUsed", "prepaidBalance"].iter().any(|k| money(k) == Some(0.0));
  let weekly = match num(&c["creditUsagePercent"]) {
    Some(pct) => Some(window(pct, 10080, resets)),
    None if !any_zero_money && monthly.is_none() && weekly_period => Some(window(0.0, 10080, resets)),
    None => None,
  };
  Usage { weekly, monthly, plan: c["subscriptionTier"].as_str().map(str::to_owned), ..Usage::new(P, Status::Ok) }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn picks_the_fresh_xai_sign_in() {
    let v = json!({
      "https://other": { "key": "o" },
      "https://auth.x.ai::1": { "key": "old", "expires_at": "1970-01-01T00:00:00Z" },
      "https://auth.x.ai::2": { "key": "new", "email": "a@b", "expires_at": "2100-01-01T00:00:00Z" }
    });
    assert_eq!(pick_auth(&v, 0).unwrap().key, "new");
    assert_eq!(pick_auth(&json!({ "https://other": { "key": "o" } }), 0).unwrap().key, "o");
    assert!(pick_auth(&json!({ "x": { "key": "" } }), 0).is_none());
  }

  #[test]
  fn reads_credits_and_monthly_use() {
    let u = parse_billing(&json!({ "creditUsagePercent": 42.4, "currentPeriod": { "end": "1970-01-01T00:00:02Z" }, "subscriptionTier": "SuperGrok" }));
    assert_eq!(u.weekly.as_ref().unwrap().used_percent, 42.0);
    assert_eq!(u.weekly.unwrap().resets_at, Some(2000));
    assert_eq!(u.plan.as_deref(), Some("SuperGrok"));
    let m = parse_billing(&json!({ "used": { "val": "25" }, "monthlyLimit": { "val": 100 } }));
    assert_eq!(m.monthly.unwrap().used_percent, 25.0);
    assert!(m.weekly.is_none());
  }
}
