//! MiniMax Coding Plan usage (Orca's minimax-fetcher): `coding_plan/remains` on the chosen
//! endpoint, with the saved API key (it wins) or the console session cookie, which needs `_token`
//! and a browser User-Agent. The configured model's interval is the 5-hour session; its weekly
//! remainder, when present, the week.

use serde_json::Value;

use super::{Ctx, Req, Status, Usage, num, window};
use crate::i18n::msg::ProvidersMsg;
use crate::tr;

const P: &str = "minimax";
const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0";

pub fn remains_url(cn: bool) -> &'static str {
  if cn { "https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains" } else { "https://platform.minimax.io/v1/api/openplatform/coding_plan/remains" }
}

pub fn console_url(cn: bool) -> &'static str {
  if cn { "https://platform.minimaxi.com/console/usage" } else { "https://platform.minimax.io/console/usage" }
}

/// `name=value` pairs of a pasted Cookie header (also Chromium's `name:"value"` export form).
pub fn cookie_pairs(raw: &str) -> Vec<(String, String)> {
  raw.trim()
    .trim_start_matches("Cookie:")
    .split(';')
    .filter_map(|p| {
      let p = p.trim();
      let (k, v) = p.split_once('=').or_else(|| p.split_once(':'))?;
      Some((k.trim().to_owned(), v.trim().trim_matches('"').to_owned()))
    })
    .filter(|(k, _)| !k.is_empty())
    .collect()
}

pub fn fetch(ctx: &Ctx) -> Usage {
  let cn = ctx.config.minimax_endpoint == "cn";
  let key = ctx.secret("minimax:api-key");
  let cookie = ctx.secret("minimax:cookie");
  let (req, source) = if let Some(key) = key {
    (Req::get(remains_url(cn)).header("Authorization", format!("Bearer {key}")).header("Accept", "application/json").timeout(10), "api-key")
  } else if let Some(raw) = cookie {
    let pairs = cookie_pairs(&raw);
    if !pairs.iter().any(|(k, _)| k == "_token") {
      return Usage::error(P, tr!(ProvidersMsg::MinimaxNoToken), "missing-credentials");
    }
    let group = Some(ctx.config.minimax_group_id.trim().to_owned()).filter(|g| !g.is_empty()).or_else(|| pairs.iter().find(|(k, _)| k == "minimax_group_id_v2").map(|(_, v)| v.clone()));
    let header = pairs.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("; ");
    let mut req = Req::get(remains_url(cn))
      .header("Cookie", header)
      .header("Accept", "application/json, text/plain, */*")
      .header("Accept-Language", "en-US,en;q=0.9")
      .header("Referer", console_url(cn))
      .header("User-Agent", UA);
    if let Some(g) = group {
      req = req.header("X-Group-Id", g);
    }
    (req, "session-cookie")
  } else {
    return Usage::unavailable(P, tr!(ProvidersMsg::MinimaxNotConfigured), "missing-credentials");
  };
  let expired = || if source == "api-key" { tr!(ProvidersMsg::MinimaxKeyExpired) } else { tr!(ProvidersMsg::MinimaxCookieExpired) };
  let res = match ctx.web.send(req) {
    Ok(r) => r,
    Err(e) => return Usage::error(P, e, "network"),
  };
  if res.status == 401 || res.status == 403 {
    return Usage::error(P, expired(), "stale-token");
  }
  if !res.ok() {
    return Usage::error(P, tr!(ProvidersMsg::MinimaxFailed, status = res.status), "server");
  }
  let Some(v) = res.json() else { return Usage::error(P, tr!(ProvidersMsg::MinimaxBadResponse), "parse") };
  let code = v["base_resp"]["status_code"].as_i64().unwrap_or(0);
  if code == 1004 {
    return Usage::error(P, expired(), "stale-token");
  }
  if code != 0 {
    return Usage::error(P, v["base_resp"]["status_msg"].as_str().map(str::to_owned).unwrap_or_else(|| tr!(ProvidersMsg::MinimaxError)), "usage-unavailable");
  }
  parse(&v, &ctx.config.minimax_models, ctx.now)
}

pub fn parse(v: &Value, models: &str, now: u64) -> Usage {
  let wanted: Vec<String> = models.split(',').map(|m| m.trim().to_owned()).filter(|m| !m.is_empty()).collect();
  let wanted = if wanted.is_empty() { vec!["general".to_owned()] } else { wanted };
  let list = v["model_remains"].as_array().cloned().unwrap_or_default();
  let entry = wanted.iter().find_map(|w| list.iter().find(|m| m["model_name"].as_str() == Some(w.as_str()))).or_else(|| (list.len() == 1).then(|| &list[0]));
  let Some(m) = entry else { return Usage::error(P, tr!(ProvidersMsg::MinimaxNoModel), "usage-unavailable") };
  let session = num(&m["current_interval_remaining_percent"]).map(|r| window(100.0 - r, 300, super::timestamp(&m["end_time"])));
  let weekly = num(&m["current_weekly_remaining_percent"]).map(|r| window(100.0 - r, 10080, num(&m["weekly_remains_time"]).map(|ms| now + ms as u64)));
  Usage { session, weekly, ..Usage::new(P, Status::Ok) }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn parses_cookies_and_remains() {
    let pairs = cookie_pairs("Cookie: _token=abc; minimax_group_id_v2:\"g1\"");
    assert_eq!(pairs, vec![("_token".to_owned(), "abc".to_owned()), ("minimax_group_id_v2".to_owned(), "g1".to_owned())]);
    let v = json!({ "base_resp": { "status_code": 0 }, "model_remains": [
      { "model_name": "general", "current_interval_remaining_percent": 70, "end_time": 5000, "current_weekly_remaining_percent": 90, "weekly_remains_time": 1000 }
    ]});
    let u = parse(&v, "", 100);
    assert_eq!(u.session.as_ref().unwrap().used_percent, 30.0);
    assert_eq!(u.session.unwrap().resets_at, Some(5_000_000));
    assert_eq!(u.weekly.unwrap().resets_at, Some(1100));
    assert_eq!(parse(&json!({ "model_remains": [{"model_name": "a"}, {"model_name": "b"}] }), "general", 0).status, Status::Error);
  }
}
