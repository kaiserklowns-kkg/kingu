//! OpenCode Go usage (Orca's opencode-go-usage-*): an API key first — the one saved in Kingu,
//! else OpenCode's own (its `credential` table, `auth.json`, then `OPENCODE_API_KEY`) — against
//! `zen/go/v1/usage`; else (or when the key is refused) the console session cookie: workspace
//! discovery, then `console/api/go/status` meters per workspace and the Zen balance.

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{Ctx, Req, Status, Usage, num, read_json, window};
use crate::i18n::msg::ProvidersMsg;
use crate::tr;

const P: &str = "opencode-go";
const USAGE_URL: &str = "https://opencode.ai/zen/go/v1/usage";
const SERVER_ID: &str = "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f";
const STATUS_URL: &str = "https://opencode.ai/console/api/go/status";
const BILLING_URL: &str = "https://opencode.ai/console/api/billing/status";

fn data_dirs(home: &Path) -> Vec<PathBuf> {
  let mut out = Vec::new();
  if let Some(d) = std::env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty()) {
    out.push(PathBuf::from(d).join("opencode"));
  }
  out.push(home.join(".local/share/opencode"));
  out.push(home.join("Library/Application Support/opencode"));
  out
}

/// OpenCode's saved Go key: its database (v2), else `auth.json`, else `OPENCODE_API_KEY`.
fn opencode_key(ctx: &Ctx) -> Option<String> {
  for dir in data_dirs(&ctx.home) {
    let db = dir.join("opencode.db");
    if db.is_file() {
      let sql = "SELECT value FROM credential WHERE integration_id='opencode-go' ORDER BY active DESC, time_created DESC LIMIT 8";
      if let Ok(out) = ctx.run.run("/usr/bin/sqlite3", &["-readonly", "-json", "-cmd", ".timeout 1500", &db.display().to_string(), sql], None, std::time::Duration::from_secs(5))
        && let Ok(rows) = serde_json::from_str::<Vec<Value>>(out.stdout.trim())
        && let Some(key) = rows.iter().filter_map(|r| r["value"].as_str().and_then(|v| serde_json::from_str::<Value>(v).ok())).find_map(|v| (v["type"] == "key" || v["type"] == "api").then(|| v["key"].as_str().map(str::to_owned)).flatten())
      {
        return Some(key);
      }
    }
    if let Ok(Some(v)) = read_json(&dir.join("auth.json"), 1 << 20)
      && let Some(key) = v["opencode-go"]["key"].as_str().filter(|k| !k.is_empty())
    {
      return Some(key.into());
    }
  }
  std::env::var("OPENCODE_API_KEY").ok().filter(|k| !k.trim().is_empty())
}

enum KeyResult {
  Ok(Usage),
  NoSubscription,
  Unauthorized,
  Failed(String),
}

fn by_key(ctx: &Ctx, key: &str) -> KeyResult {
  let res = match ctx.web.send(Req::get(USAGE_URL).header("Authorization", format!("Bearer {key}")).header("Accept", "application/json")) {
    Ok(r) => r,
    Err(e) => return KeyResult::Failed(e),
  };
  let kind = res.json().and_then(|v| v["error"]["type"].as_str().map(str::to_owned));
  if res.status == 403 || kind.as_deref() == Some("EntitlementError") {
    return KeyResult::NoSubscription;
  }
  if res.status == 401 || kind.as_deref() == Some("AuthError") || (res.ok() && res.content_type.contains("text/html")) {
    return KeyResult::Unauthorized;
  }
  if !res.ok() {
    return KeyResult::Failed(tr!(ProvidersMsg::OpencodeGoFailed, status = res.status));
  }
  match res.json().and_then(|v| parse_key_usage(&v)) {
    Some(u) => KeyResult::Ok(u),
    None => KeyResult::Failed(tr!(ProvidersMsg::OpencodeGoParse)),
  }
}

/// `{usage: {rolling, weekly, monthly?: {percent, resetsAt}}}`.
pub fn parse_key_usage(v: &Value) -> Option<Usage> {
  let u = &v["usage"];
  let w = |x: &Value, minutes: u32| -> Option<super::super::usage::Window> { Some(window(num(&x["percent"])?, minutes, x["resetsAt"].as_str().and_then(super::parse_iso))) };
  Some(Usage { session: Some(w(&u["rolling"], 300)?), weekly: Some(w(&u["weekly"], 10080)?), monthly: w(&u["monthly"], 43200), ..Usage::new(P, Status::Ok) })
}

/// Only the auth cookies of a pasted Cookie header (a bare token becomes `auth=<token>`).
pub fn auth_cookies(raw: &str) -> Option<String> {
  let raw = raw.trim().trim_start_matches("Cookie:").trim();
  if raw.starts_with("Fe26.2**") || (!raw.is_empty() && raw.chars().all(|c| c.is_ascii_alphanumeric() || ".-_".contains(c))) {
    return Some(format!("auth={raw}"));
  }
  let keep: Vec<&str> = raw.split(';').map(str::trim).filter(|p| matches!(p.split('=').next(), Some("auth" | "__Host-auth" | "__Host-console_session"))).collect();
  (!keep.is_empty()).then(|| keep.join("; "))
}

pub fn workspace_ids(js: &str) -> Vec<String> {
  let re = regex::Regex::new(r#"\bid\s*:\s*["']((?:org|wrk|wk)_[a-zA-Z0-9]+)["']"#).expect("regex");
  let mut out: Vec<String> = Vec::new();
  for c in re.captures_iter(js) {
    if !out.contains(&c[1].to_owned()) {
      out.push(c[1].to_owned());
    }
  }
  out
}

fn by_cookie(ctx: &Ctx, raw: &str) -> Usage {
  let Some(cookie) = auth_cookies(raw) else { return Usage::error(P, tr!(ProvidersMsg::OpencodeGoNoAuthCookie), "missing-credentials") };
  let override_id = ctx.config.opencode_workspace_id.trim();
  let ids = if !override_id.is_empty() {
    if !regex::Regex::new(r"^(org|wrk|wk)_[A-Za-z0-9]+$").expect("regex").is_match(override_id) {
      return Usage::error(P, tr!(ProvidersMsg::OpencodeGoBadWorkspace), "missing-credentials");
    }
    vec![override_id.to_owned()]
  } else {
    let req = Req::get(format!("https://opencode.ai/_server?id={SERVER_ID}"))
      .header("Cookie", cookie.clone())
      .header("X-Server-Id", SERVER_ID)
      .header("X-Server-Instance", format!("server-fn:{}", crate::accounts::managed::new_uuid()))
      .header("Accept", "text/javascript, application/json;q=0.9, */*;q=0.8")
      .header("Origin", "https://opencode.ai")
      .header("Referer", "https://opencode.ai");
    match ctx.web.send(req) {
      Err(e) => return Usage::error(P, e, "network"),
      Ok(r) if !r.ok() => return Usage::error(P, tr!(ProvidersMsg::OpencodeGoWorkspacesFailed, status = r.status), "server"),
      Ok(r) => {
        let ids = workspace_ids(&r.body);
        if ids.is_empty() {
          return Usage::error(P, tr!(ProvidersMsg::OpencodeGoNoWorkspace), "missing-credentials");
        }
        ids
      }
    }
  };
  let mut last = Usage::error(P, tr!(ProvidersMsg::OpencodeGoParseAny), "parse");
  for id in ids {
    let console = |url: &str, page: &str, secs| {
      Req::get(url)
        .header("Cookie", cookie.clone())
        .header("Accept", "application/json")
        .header("Origin", "https://opencode.ai")
        .header("Referer", format!("https://opencode.ai/console/{id}/{page}"))
        .header("x-org-id", id.clone())
        .timeout(secs)
    };
    let balance = ctx.web.send(console(BILLING_URL, "billing", 5)).ok().filter(|r| r.ok()).and_then(|r| r.json()).and_then(|v| num(&v["balanceMicroCents"])).map(|n| n / 100_000_000.0);
    match ctx.web.send(console(STATUS_URL, "go", 15)) {
      Err(e) => last = Usage::error(P, e, "network"),
      Ok(r) if r.status == 401 => last = Usage::error(P, tr!(ProvidersMsg::OpencodeGo401), "stale-token"),
      Ok(r) if !r.ok() => last = Usage::error(P, tr!(ProvidersMsg::OpencodeGoUsageFailed, status = r.status), "server"),
      Ok(r) => match r.json() {
        Some(v) if v.is_null() || v["access"].is_null() => {
          if balance.is_some() {
            return Usage { balance, ..Usage::new(P, Status::Ok) };
          }
          last = Usage::error(P, tr!(ProvidersMsg::OpencodeGoNoSubscription), "no-subscription");
        }
        Some(v) => match parse_meters(&v) {
          Some(u) => return Usage { balance, ..u },
          None => last = Usage::error(P, tr!(ProvidersMsg::OpencodeGoParse), "parse"),
        },
        None => last = Usage::error(P, tr!(ProvidersMsg::OpencodeGoParse), "parse"),
      },
    }
  }
  last
}

/// `{access: {meters: {fiveHour, week, month?: {usedMicroCents, limitMicroCents, resetsAt}}}}`.
pub fn parse_meters(v: &Value) -> Option<Usage> {
  let m = &v["access"]["meters"];
  let w = |x: &Value, minutes: u32| -> Option<super::super::usage::Window> {
    let (used, limit) = (num(&x["usedMicroCents"])?, num(&x["limitMicroCents"])?);
    (limit > 0.0).then(|| window(used / limit * 100.0, minutes, x["resetsAt"].as_str().and_then(super::parse_iso)))
  };
  Some(Usage { session: Some(w(&m["fiveHour"], 300)?), weekly: Some(w(&m["week"], 10080)?), monthly: w(&m["month"], 43200), ..Usage::new(P, Status::Ok) })
}

pub fn fetch(ctx: &Ctx) -> Usage {
  let cookie = ctx.secret("opencode-go:cookie");
  let key = ctx.secret("opencode-go:api-key").or_else(|| opencode_key(ctx));
  let Some(key) = key else {
    return match cookie {
      Some(c) => by_cookie(ctx, &c),
      None => Usage::unavailable(P, tr!(ProvidersMsg::OpencodeGoNone), "missing-credentials"),
    };
  };
  let keyed = by_key(ctx, &key);
  if let KeyResult::Ok(u) = keyed {
    return u;
  }
  if let Some(c) = &cookie {
    let u = by_cookie(ctx, c);
    if u.status == Status::Ok {
      return u;
    }
  }
  match keyed {
    KeyResult::NoSubscription => Usage::error(P, tr!(ProvidersMsg::OpencodeGoNoSubscription), "no-subscription"),
    KeyResult::Unauthorized => Usage::error(P, tr!(ProvidersMsg::OpencodeGoKeyRejected), "stale-token"),
    KeyResult::Failed(e) => Usage::error(P, e, "server"),
    KeyResult::Ok(u) => u,
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn parses_both_usage_shapes() {
    let u = parse_key_usage(&json!({ "usage": { "rolling": { "percent": 12.4, "resetsAt": "1970-01-01T00:00:01Z" }, "weekly": { "percent": "50" } } })).unwrap();
    assert_eq!((u.session.as_ref().unwrap().used_percent, u.session.unwrap().resets_at), (12.0, Some(1000)));
    assert_eq!(u.weekly.unwrap().window_minutes, 10080);
    assert!(parse_key_usage(&json!({ "usage": { "rolling": { "percent": 1 } } })).is_none());
    let m = parse_meters(&json!({ "access": { "meters": { "fiveHour": { "usedMicroCents": "25", "limitMicroCents": 100 }, "week": { "usedMicroCents": 1, "limitMicroCents": 4 } } } })).unwrap();
    assert_eq!(m.session.unwrap().used_percent, 25.0);
  }

  #[test]
  fn keeps_only_auth_cookies_and_finds_workspaces() {
    assert_eq!(auth_cookies("Cookie: a=1; auth=x; __Host-console_session=y; b=2").as_deref(), Some("auth=x; __Host-console_session=y"));
    assert_eq!(auth_cookies("Fe26.2**abc").as_deref(), Some("auth=Fe26.2**abc"));
    assert_eq!(auth_cookies("a=1; b=2"), None);
    assert_eq!(workspace_ids(r#"[{id:"wrk_A1"},{id: 'org_b2'},{id:"wrk_A1"}]"#), vec!["wrk_A1", "org_b2"]);
  }
}
