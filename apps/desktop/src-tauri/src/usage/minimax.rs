//! MiniMax Coding Plan usage, the way Orca reads it: `GET <site>/v1/api/openplatform/coding_plan/remains`
//! with the MiniMax API key a user saved (`Bearer`), else the platform session cookie they pasted
//! (it must carry `_token`; the group id is the setting, else the cookie's `minimax_group_id_v2`).
//! Sites: overseas `platform.minimax.io`, mainland `www.minimaxi.com` (`kingu.usage.minimax.endpoint`).
//! Body: `model_remains[] = {model_name, current_interval_remaining_percent, end_time,
//! current_weekly_remaining_percent, weekly_remains_time}`; the row shown is the first of
//! `kingu.usage.minimax.models` found, else the only one. An expired credential answers 200 with
//! `base_resp.status_code` 1004.

use serde_json::Value;

use super::io::{Http, Request};
use super::{ProviderUsage, Window, SESSION_MINUTES, WEEK_MINUTES};
use crate::accounts::secrets::SecretStore;
use crate::i18n::msg::UsageMsg;
use crate::tr;

const P: &str = "minimax";
const PATH: &str = "/v1/api/openplatform/coding_plan/remains";
const EXPIRED: i64 = 1004;

pub fn endpoint(site: &str) -> String {
  format!("{}{PATH}", if site == "cn" { "https://www.minimaxi.com" } else { "https://platform.minimax.io" })
}

fn referer(site: &str) -> &'static str {
  if site == "cn" { "https://platform.minimaxi.com/console/usage" } else { "https://platform.minimax.io/console/usage" }
}

/// MiniMax turns away clients that do not look like a browser (Orca sends Firefox's agent too).
fn user_agent() -> &'static str {
  if cfg!(target_os = "macos") {
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0"
  } else if cfg!(windows) {
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0"
  } else {
    "Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0"
  }
}

/// `a=1; b=2` (a `Cookie:` prefix allowed) or DevTools' `name: "value"` pairs, as name/value.
pub fn cookie_pairs(raw: &str) -> Vec<(String, String)> {
  let quoted = regex::Regex::new(r#"(?:^|[;\s])([A-Za-z0-9_.-]+)\s*:\s*["']([^"']+)["']"#).expect("static regex");
  let q: Vec<(String, String)> = quoted.captures_iter(raw).map(|c| (c[1].to_owned(), c[2].to_owned())).collect();
  if !q.is_empty() {
    return q;
  }
  raw.split(';')
    .filter_map(|part| {
      let part = part.trim();
      let part = part.strip_prefix("Cookie:").or_else(|| part.strip_prefix("cookie:")).unwrap_or(part).trim();
      let (k, v) = part.split_once('=')?;
      let (k, v) = (k.trim(), v.trim());
      (!k.is_empty() && !v.is_empty()).then(|| (k.to_owned(), v.to_owned()))
    })
    .collect()
}

fn num(v: &Value) -> Option<f64> {
  match v {
    Value::Number(n) => n.as_f64(),
    Value::String(s) if !s.trim().is_empty() => s.trim().parse().ok(),
    _ => None,
  }
  .filter(|n: &f64| n.is_finite())
}

/// One `model_remains` row: (model, session, weekly).
fn row(v: &Value, now: i64) -> Option<(String, Window, Option<Window>)> {
  let model = v.get("model_name")?.as_str()?.to_owned();
  let left = num(&v["current_interval_remaining_percent"])?;
  num(&v["start_time"])?;
  let end = num(&v["end_time"])?;
  let used = |left: f64| (100.0 - left).round().clamp(0.0, 100.0);
  let session = Window { used_percent: used(left), window_minutes: SESSION_MINUTES, resets_at: Some(end as i64) };
  let weekly = num(&v["current_weekly_remaining_percent"]).map(|l| Window {
    used_percent: used(l),
    window_minutes: WEEK_MINUTES,
    resets_at: num(&v["weekly_remains_time"]).map(|ms| now + ms as i64),
  });
  Some((model, session, weekly))
}

/// `kingu.usage.minimax.models`: comma separated, `general` when empty.
pub fn models(setting: &str) -> Vec<String> {
  let m: Vec<String> = setting.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned).collect();
  if m.is_empty() { vec!["general".into()] } else { m }
}

pub fn parse(status: u16, body: &str, by_key: bool, wanted: &[String], now: i64) -> ProviderUsage {
  let expired = || ProviderUsage::failed(P, "error", "stale-token", &if by_key { tr!(UsageMsg::MinimaxKeyExpired) } else { tr!(UsageMsg::MinimaxCookieExpired) });
  if matches!(status, 401 | 403) {
    return expired();
  }
  if !(200..300).contains(&status) {
    return ProviderUsage::failed(P, "error", if status == 429 { "rate-limited" } else { "server" }, &tr!(UsageMsg::RequestFailed, provider = "MiniMax", status = status));
  }
  let Some(v) = serde_json::from_str::<Value>(body).ok().filter(Value::is_object) else {
    return ProviderUsage::failed(P, "error", "parse", &tr!(UsageMsg::Unreadable, provider = "MiniMax"));
  };
  let code = v["base_resp"]["status_code"].as_i64().unwrap_or(0);
  if code == EXPIRED {
    return expired();
  }
  if code != 0 {
    // MiniMax's own words; they never echo the credential back.
    let msg = v["base_resp"]["status_msg"].as_str().map(str::to_owned).unwrap_or_else(|| tr!(UsageMsg::Unreadable, provider = "MiniMax"));
    return ProviderUsage::failed(P, "error", "usage-unavailable", &msg);
  }
  let rows: Vec<_> = v["model_remains"].as_array().map(|a| a.iter().filter_map(|r| row(r, now)).collect()).unwrap_or_default();
  let pick = wanted.iter().find_map(|m| rows.iter().find(|r| &r.0 == m)).or(if rows.len() == 1 { rows.first() } else { None });
  match pick {
    Some((_, s, w)) => ProviderUsage { session: Some(s.clone()), weekly: w.clone(), ..ProviderUsage::new(P) },
    None => ProviderUsage::failed(P, "error", "usage-unavailable", &tr!(UsageMsg::MinimaxNoModel)),
  }
}

pub struct Options<'a> {
  pub site: &'a str,
  pub group_id: &'a str,
  pub models: &'a str,
}

pub fn fetch(http: &dyn Http, secrets: &dyn SecretStore, o: &Options, now: i64) -> ProviderUsage {
  let url = endpoint(o.site);
  let wanted = models(o.models);
  let net = |kind: &str| ProviderUsage::failed(P, "error", kind, &tr!(UsageMsg::Network, provider = "MiniMax"));
  if let Some(key) = secrets.get("minimax.apiKey") {
    let req = Request::get(&url).header("Authorization", format!("Bearer {key}")).header("Accept", "application/json");
    return match http.send(&req) {
      Ok(r) => parse(r.status, &r.body, true, &wanted, now),
      Err(kind) => net(kind),
    };
  }
  let Some(raw) = secrets.get("minimax.cookie") else {
    return ProviderUsage::failed(P, "unavailable", "missing-credentials", &tr!(UsageMsg::MinimaxNotConfigured));
  };
  let pairs = cookie_pairs(&raw);
  let value = |name: &str| pairs.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone());
  if value("_token").is_none() {
    return ProviderUsage::failed(P, "error", "missing-credentials", &tr!(UsageMsg::MinimaxNoToken));
  }
  let cookie = pairs.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("; ");
  let mut req = Request::get(&url)
    .header("Accept", "application/json, text/plain, */*")
    .header("Accept-Language", "en-US,en;q=0.9")
    .header("Referer", referer(o.site))
    .header("User-Agent", user_agent())
    .header("Cookie", cookie);
  if let Some(g) = Some(o.group_id.trim().to_owned()).filter(|g| !g.is_empty()).or_else(|| value("minimax_group_id_v2")) {
    req = req.header("X-Group-Id", g);
  }
  match http.send(&req) {
    Ok(r) => parse(r.status, &r.body, false, &wanted, now),
    Err(kind) => net(kind),
  }
}

#[cfg(test)]
mod tests {
  use super::super::io::fake::FakeHttp;
  use super::*;
  use crate::accounts::secrets::fake::FakeSecrets;

  const BODY: &str = r#"{"base_resp":{"status_code":0},"model_remains":[
    {"model_name":"general","current_interval_remaining_percent":70,"start_time":1000,"end_time":1792609200000,"current_weekly_remaining_percent":"40","weekly_remains_time":3600000},
    {"model_name":"video","current_interval_remaining_percent":10,"start_time":1,"end_time":2}]}"#;

  fn opts() -> Options<'static> {
    Options { site: "overseas", group_id: "", models: "" }
  }

  #[test]
  fn picks_the_configured_model() {
    let u = parse(200, BODY, true, &models(""), 5);
    let s = u.session.unwrap();
    assert_eq!((s.used_percent, s.window_minutes, s.resets_at), (30.0, 300, Some(1_792_609_200_000)));
    let w = u.weekly.unwrap();
    assert_eq!((w.used_percent, w.resets_at), (60.0, Some(3_600_005)));
    assert_eq!(parse(200, BODY, true, &models("video, general"), 0).session.unwrap().used_percent, 90.0);
    assert_eq!(parse(200, BODY, true, &models("nope"), 0).failure_kind.as_deref(), Some("usage-unavailable"));
    assert_eq!(models(" a, ,b "), ["a", "b"]);
  }

  #[test]
  fn expiry_lives_in_the_payload() {
    assert_eq!(parse(200, r#"{"base_resp":{"status_code":1004,"status_msg":"login fail"}}"#, false, &[], 0).failure_kind.as_deref(), Some("stale-token"));
    let other = parse(200, r#"{"base_resp":{"status_code":2013,"status_msg":"invalid params"}}"#, false, &[], 0);
    assert_eq!((other.failure_kind.as_deref(), other.error.as_deref()), (Some("usage-unavailable"), Some("invalid params")));
    assert_eq!(parse(403, "", true, &[], 0).failure_kind.as_deref(), Some("stale-token"));
    assert_eq!(parse(502, "", true, &[], 0).failure_kind.as_deref(), Some("server"));
  }

  #[test]
  fn cookie_forms() {
    assert_eq!(cookie_pairs("Cookie: _token=t1; minimax_group_id_v2=g9"), [("_token".into(), "t1".into()), ("minimax_group_id_v2".into(), "g9".into())]);
    assert_eq!(cookie_pairs(r#"_token: "t2", other: 'x'"#)[0], ("_token".into(), "t2".into()));
  }

  #[test]
  fn key_first_then_cookie() {
    let s = FakeSecrets::default();
    s.set("minimax.apiKey", "mk").unwrap();
    s.set("minimax.cookie", "_token=t1").unwrap();
    let http = FakeHttp::new(vec![FakeHttp::ok(BODY)]);
    assert_eq!(fetch(&http, &s, &Options { site: "cn", ..opts() }, 0).status, "ok");
    assert_eq!(http.urls(), ["https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains"]);
    assert_eq!(http.header(0, "authorization").as_deref(), Some("Bearer mk"));
    assert_eq!(http.header(0, "cookie"), None);

    let s = FakeSecrets::default();
    s.set("minimax.cookie", "_token=t1; minimax_group_id_v2=g9").unwrap();
    let http = FakeHttp::new(vec![FakeHttp::ok(BODY)]);
    assert_eq!(fetch(&http, &s, &opts(), 0).status, "ok");
    assert_eq!(http.header(0, "x-group-id").as_deref(), Some("g9"));
    assert_eq!(http.header(0, "authorization"), None);
    let http = FakeHttp::new(vec![FakeHttp::ok(BODY)]);
    fetch(&http, &s, &Options { group_id: "g1", ..opts() }, 0);
    assert_eq!(http.header(0, "x-group-id").as_deref(), Some("g1"), "the setting wins");

    let s = FakeSecrets::default();
    s.set("minimax.cookie", "session=x").unwrap();
    let http = FakeHttp::new(vec![]);
    assert_eq!(fetch(&http, &s, &opts(), 0).failure_kind.as_deref(), Some("missing-credentials"));
    assert_eq!(fetch(&http, &FakeSecrets::default(), &opts(), 0).status, "unavailable");
    assert!(http.urls().is_empty());
  }
}
