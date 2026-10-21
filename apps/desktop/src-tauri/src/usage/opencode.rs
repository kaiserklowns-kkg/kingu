//! OpenCode Go's plan usage, the way Orca reads it:
//! 1. With an OpenCode Go API key: `GET https://opencode.ai/zen/go/v1/usage` (`Bearer`), body
//!    `{usage: {rolling, weekly, monthly: {percent, resetsAt}}}`. The key is the one saved in
//!    Kingu (Keychain), else OpenCode's own (`OPENCODE_AUTH_CONTENT`, then
//!    OpenCode 2's `opencode.db` `credential` table, else `$XDG_DATA_HOME/opencode/auth.json` →
//!    `opencode-go: {type: api, key}`), else
//!    `OPENCODE_API_KEY`.
//! 2. With the opencode.ai session cookie a user pasted (only its auth cookies are sent): the
//!    console's workspaces (`/_server` server function) unless a workspace id is set, then
//!    `/console/api/go/status` per workspace (`x-org-id`), meters in micro-cents.
//!
//! Not read (Orca does): OpenCode 2's SQLite credential table, and the Zen pay-as-you-go balance.

use serde_json::Value;

use super::io::{Host, Http, Request};
use super::{parse_time, ProviderUsage, Window, MONTH_MINUTES, SESSION_MINUTES, WEEK_MINUTES};
use crate::accounts::secrets::SecretStore;
use crate::i18n::msg::UsageMsg;
use crate::tr;

const P: &str = "opencode";
pub const BASE: &str = "https://opencode.ai";
pub const USAGE_URL: &str = "https://opencode.ai/zen/go/v1/usage";
const STATUS_URL: &str = "https://opencode.ai/console/api/go/status";
/// The console's server-function id for the workspaces list (Orca's constant).
const WORKSPACES_ID: &str = "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f";
const AUTH_COOKIES: [&str; 3] = ["auth", "__Host-auth", "__Host-console_session"];

fn pct_window(v: &Value, minutes: u32) -> Option<Window> {
  let pct = v.get("percent")?.as_f64().filter(|p| p.is_finite())?;
  Some(Window { used_percent: pct.clamp(0.0, 100.0), window_minutes: minutes, resets_at: v.get("resetsAt").and_then(parse_time) })
}

/// `GET /zen/go/v1/usage`: session (rolling) and weekly are required.
pub fn parse_api(body: &str) -> Option<(Window, Window, Option<Window>)> {
  let v: Value = serde_json::from_str(body).ok()?;
  let u = v.get("usage").filter(|u| u.is_object())?;
  Some((pct_window(&u["rolling"], SESSION_MINUTES)?, pct_window(&u["weekly"], WEEK_MINUTES)?, pct_window(&u["monthly"], MONTH_MINUTES)))
}

fn num(v: &Value) -> Option<f64> {
  match v {
    Value::Number(n) => n.as_f64(),
    Value::String(s) => s.trim().parse().ok(),
    _ => None,
  }
  .filter(|n: &f64| n.is_finite())
}

fn meter(v: &Value, minutes: u32) -> Option<Window> {
  let used = num(v.get("usedMicroCents")?)?;
  let limit = num(v.get("limitMicroCents")?)?.max(0.0);
  (limit > 0.0).then(|| Window { used_percent: (used / limit * 100.0).clamp(0.0, 100.0), window_minutes: minutes, resets_at: v.get("resetsAt").and_then(parse_time) })
}

/// `/console/api/go/status`: `{access: {meters: {fiveHour, week, month}}}`.
pub fn parse_status(body: &str) -> Option<(Window, Window, Option<Window>)> {
  let v: Value = serde_json::from_str(body).ok()?;
  let m = v.get("access")?.get("meters")?;
  Some((meter(&m["fiveHour"], SESSION_MINUTES)?, meter(&m["week"], WEEK_MINUTES)?, meter(&m["month"], MONTH_MINUTES)))
}

/// A bare token becomes `auth=<token>`; only the auth cookies are kept.
pub fn auth_cookies(raw: &str) -> String {
  let raw = raw.trim().trim_start_matches("Cookie:").trim();
  let header = if raw.contains(';') || AUTH_COOKIES.iter().any(|n| raw.starts_with(&format!("{n}="))) {
    raw.to_owned()
  } else if !raw.is_empty() && (raw.starts_with("Fe26.2**") || raw.bytes().all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b))) {
    format!("auth={raw}")
  } else {
    raw.to_owned()
  };
  header
    .split(';')
    .filter_map(|pair| {
      let (k, v) = pair.trim().split_once('=')?;
      (AUTH_COOKIES.contains(&k.trim()) && !v.trim().is_empty()).then(|| format!("{}={}", k.trim(), v.trim()))
    })
    .collect::<Vec<_>>()
    .join("; ")
}

fn valid_workspace(id: &str) -> bool {
  let rest = ["org_", "wrk_", "wk_"].iter().find_map(|p| id.strip_prefix(p));
  rest.is_some_and(|r| !r.is_empty() && r.bytes().all(|b| b.is_ascii_alphanumeric()))
}

/// `id: "org_…"` occurrences in the server function's answer, in order, once each.
pub fn workspace_ids(text: &str) -> Vec<String> {
  let re = regex::Regex::new(r#"\bid\s*:\s*["']((?:org|wrk|wk)_[A-Za-z0-9]+)["']"#).expect("static regex");
  let mut out: Vec<String> = Vec::new();
  for c in re.captures_iter(text) {
    let id = c[1].to_owned();
    if !out.contains(&id) {
      out.push(id);
    }
  }
  out
}

fn key_in(v: &Value) -> Option<String> {
  let e = v.get("opencode-go")?;
  (e.get("type")?.as_str()? == "api").then_some(())?;
  e.get("key")?.as_str().map(str::trim).filter(|k| !k.is_empty()).map(str::to_owned)
}

/// OpenCode 2's saved Go key: its `credential` table (`{type: "key"|"api", key}`), newest active first.
fn db_key(host: &dyn Host, db: &std::path::Path) -> Option<String> {
  host.read(db).ok().flatten()?;
  let sql = "SELECT value FROM credential WHERE integration_id='opencode-go' ORDER BY active DESC, time_created DESC LIMIT 8";
  let db = db.display().to_string();
  let out = host.run(std::path::Path::new("/usr/bin/sqlite3"), &["-readonly", "-json", "-cmd", ".timeout 1500", &db, sql], std::time::Duration::from_secs(5)).ok()?;
  let rows: Vec<Value> = serde_json::from_str(out.stdout.trim()).ok()?;
  rows.iter().filter_map(|r| r.get("value")?.as_str().and_then(|v| serde_json::from_str::<Value>(v).ok())).find_map(|v| {
    matches!(v.get("type")?.as_str()?, "key" | "api").then_some(())?;
    v.get("key")?.as_str().map(str::trim).filter(|k| !k.is_empty()).map(str::to_owned)
  })
}

/// The API key and where it came from (`settings`, `opencode-auth-content`, `opencode-db`, `opencode-auth-file`, `environment`).
pub fn api_key(host: &dyn Host, secrets: &dyn SecretStore) -> Option<(String, &'static str)> {
  if let Some(k) = secrets.get("opencode.apiKey") {
    return Some((k, "settings"));
  }
  if let Some(inline) = host.var("OPENCODE_AUTH_CONTENT").and_then(|c| serde_json::from_str::<Value>(&c).ok()) {
    if let Some(k) = key_in(&inline) {
      return Some((k, "opencode-auth-content"));
    }
  } else {
    let data = host.var("XDG_DATA_HOME").map(std::path::PathBuf::from).or_else(|| host.home().map(|h| h.join(".local/share")));
    if let Some(k) = data.as_ref().and_then(|d| db_key(host, &d.join("opencode/opencode.db"))) {
      return Some((k, "opencode-db"));
    }
    let file = data.and_then(|d| host.read(&d.join("opencode/auth.json")).ok().flatten());
    if let Some(k) = file.and_then(|t| serde_json::from_str::<Value>(&t).ok()).as_ref().and_then(key_in) {
      return Some((k, "opencode-auth-file"));
    }
  }
  host.var("OPENCODE_API_KEY").map(|k| (k, "environment"))
}

fn ok(session: Window, weekly: Window, monthly: Option<Window>) -> ProviderUsage {
  ProviderUsage { session: Some(session), weekly: Some(weekly), monthly, ..ProviderUsage::new(P) }
}

fn with_key(http: &dyn Http, key: &str) -> ProviderUsage {
  let req = Request::get(USAGE_URL).header("Authorization", format!("Bearer {key}")).header("Accept", "application/json");
  let res = match http.send(&req) {
    Ok(r) => r,
    Err(kind) => return ProviderUsage::failed(P, "error", kind, &tr!(UsageMsg::Network, provider = "OpenCode Go")),
  };
  let error_type = serde_json::from_str::<Value>(&res.body).ok().and_then(|v| v["error"]["type"].as_str().map(str::to_owned));
  let rejected = || ProviderUsage::failed(P, "error", "stale-token", &tr!(UsageMsg::OpencodeKeyRejected));
  if error_type.as_deref() == Some("EntitlementError") || res.status == 403 {
    return ProviderUsage::failed(P, "error", "no-subscription", &tr!(UsageMsg::OpencodeNoSubscription));
  }
  if error_type.as_deref() == Some("AuthError") || res.status == 401 || (300..400).contains(&res.status) {
    return rejected();
  }
  if !(200..300).contains(&res.status) {
    return ProviderUsage::failed(P, "error", if res.status == 429 { "rate-limited" } else { "server" }, &tr!(UsageMsg::RequestFailed, provider = "OpenCode Go", status = res.status));
  }
  match parse_api(&res.body) {
    Some((s, w, m)) => ok(s, w, m),
    // A key sent to the sign-in page answers HTML.
    None if res.content_type.as_deref().is_some_and(|c| c.contains("text/html")) => rejected(),
    None => ProviderUsage::failed(P, "error", "parse", &tr!(UsageMsg::Unreadable, provider = "OpenCode Go")),
  }
}

fn console_headers<'a>(req: Request<'a>, cookie: &str, referer: String) -> Request<'a> {
  req.header("Cookie", cookie).header("Origin", BASE).header("Referer", referer)
}

fn with_cookie(http: &dyn Http, cookie: &str, workspace: Option<&str>, now: i64) -> ProviderUsage {
  let net = |kind: &str| ProviderUsage::failed(P, "error", kind, &tr!(UsageMsg::Network, provider = "OpenCode Go"));
  let ids = match workspace.map(str::trim).filter(|w| !w.is_empty()) {
    Some(w) if valid_workspace(w) => vec![w.to_owned()],
    Some(_) => return ProviderUsage::failed(P, "error", "parse", &tr!(UsageMsg::OpencodeBadWorkspace)),
    None => {
      let url = format!("{BASE}/_server?id={WORKSPACES_ID}");
      let req = console_headers(Request::get(&url), cookie, BASE.to_owned())
        .header("X-Server-Id", WORKSPACES_ID)
        .header("X-Server-Instance", instance_id(now))
        .header("Accept", "text/javascript, application/json;q=0.9, */*;q=0.8");
      match http.send(&req) {
        Err(kind) => return net(kind),
        Ok(r) if !(200..300).contains(&r.status) => return ProviderUsage::failed(P, "error", "server", &tr!(UsageMsg::RequestFailed, provider = "OpenCode Go", status = r.status)),
        Ok(r) => workspace_ids(&r.body),
      }
    }
  };
  if ids.is_empty() {
    return ProviderUsage::failed(P, "error", "usage-unavailable", &tr!(UsageMsg::OpencodeNoWorkspace));
  }
  let mut last = None;
  for id in ids {
    let req = console_headers(Request::get(STATUS_URL), cookie, format!("{BASE}/console/{id}/go")).header("Accept", "application/json").header("x-org-id", id.clone());
    match http.send(&req) {
      Err(kind) => last = Some(net(kind)),
      Ok(r) if r.status == 401 => last = Some(ProviderUsage::failed(P, "error", "stale-token", &tr!(UsageMsg::OpencodeCookieRejected))),
      Ok(r) if !(200..300).contains(&r.status) => last = Some(ProviderUsage::failed(P, "error", "server", &tr!(UsageMsg::RequestFailed, provider = "OpenCode Go", status = r.status))),
      Ok(r) => match parse_status(&r.body) {
        Some((s, w, m)) => return ok(s, w, m),
        None => last = Some(ProviderUsage::failed(P, "error", "parse", &tr!(UsageMsg::Unreadable, provider = "OpenCode Go"))),
      },
    }
  }
  last.unwrap_or_else(|| ProviderUsage::failed(P, "error", "parse", &tr!(UsageMsg::Unreadable, provider = "OpenCode Go")))
}

/// Orca's order: the key first, the cookie as the fallback (and for accounts the key cannot read).
pub fn fetch(http: &dyn Http, host: &dyn Host, secrets: &dyn SecretStore, workspace: Option<&str>, now: i64) -> ProviderUsage {
  let cookie = secrets.get("opencode.cookie").map(|c| auth_cookies(&c));
  let Some((key, _source)) = api_key(host, secrets) else {
    return match cookie {
      Some(c) if c.is_empty() => ProviderUsage::failed(P, "error", "missing-credentials", &tr!(UsageMsg::OpencodeNoAuthCookie)),
      Some(c) => with_cookie(http, &c, workspace, now),
      None => ProviderUsage::failed(P, "unavailable", "missing-credentials", &tr!(UsageMsg::OpencodeNotConfigured)),
    };
  };
  let by_key = with_key(http, &key);
  match cookie {
    Some(c) if by_key.status != "ok" && !c.is_empty() => {
      let by_cookie = with_cookie(http, &c, workspace, now);
      if by_cookie.status == "ok" { by_cookie } else { by_key }
    }
    _ => by_key,
  }
}

/// A per-request instance id for the console's server functions (not a secret).
fn instance_id(now: i64) -> String {
  use sha2::Digest;
  let d = sha2::Sha256::digest(format!("{now}:{}", std::process::id()).as_bytes());
  format!("server-fn:{}", d[..16].iter().map(|b| format!("{b:02x}")).collect::<String>())
}

#[cfg(test)]
mod tests {
  use super::super::io::fake::{FakeHost, FakeHttp, HOME};
  use super::*;
  use crate::accounts::secrets::fake::FakeSecrets;

  const API: &str = r#"{"usage":{"rolling":{"status":"ok","percent":12,"resetsAt":"2026-10-21T19:00:00Z"},"weekly":{"percent":40.5},"monthly":{"percent":3}}}"#;
  const STATUS: &str = r#"{"access":{"meters":{"fiveHour":{"usedMicroCents":"250","limitMicroCents":"1000","resetsAt":"2026-10-21T19:00:00Z"},"week":{"usedMicroCents":500,"limitMicroCents":1000}}}}"#;

  fn secrets(pairs: &[(&str, &str)]) -> FakeSecrets {
    let s = FakeSecrets::default();
    for (k, v) in pairs {
      s.set(k, v).unwrap();
    }
    s
  }

  #[test]
  fn parses_both_payloads() {
    let (s, w, m) = parse_api(API).unwrap();
    assert_eq!((s.used_percent, s.window_minutes, s.resets_at), (12.0, 300, Some(1_792_609_200_000)));
    assert_eq!((w.used_percent, m.unwrap().window_minutes), (40.5, MONTH_MINUTES));
    assert!(parse_api(r#"{"usage":{"rolling":{"percent":1}}}"#).is_none(), "weekly is required");
    let (s, w, m) = parse_status(STATUS).unwrap();
    assert_eq!((s.used_percent, w.used_percent, m), (25.0, 50.0, None));
    assert!(parse_status(r#"{"access":null}"#).is_none());
  }

  #[test]
  fn cookies_and_workspaces() {
    assert_eq!(auth_cookies("Fe26.2**abc"), "auth=Fe26.2**abc");
    assert_eq!(auth_cookies("Cookie: theme=dark; __Host-console_session=s1; auth=a1; _ga=x"), "__Host-console_session=s1; auth=a1");
    assert_eq!(auth_cookies("theme=dark"), "");
    assert_eq!(workspace_ids(r#"[{id:"wrk_A1",name:"x"},{id: 'org_B2'},{id:"wrk_A1"},{id:"bad_1"}]"#), ["wrk_A1", "org_B2"]);
    assert!(valid_workspace("org_abc") && !valid_workspace("org_") && !valid_workspace("x_1"));
  }

  #[test]
  fn key_sources_in_order() {
    let host = FakeHost::new().file(&format!("{HOME}/.local/share/opencode/auth.json"), r#"{"opencode-go":{"type":"api","key":" k-file "}}"#).var("OPENCODE_API_KEY", "k-env");
    assert_eq!(api_key(&host, &secrets(&[("opencode.apiKey", "k-set")])), Some(("k-set".into(), "settings")));
    assert_eq!(api_key(&host, &secrets(&[])), Some(("k-file".into(), "opencode-auth-file")));
    let inline = FakeHost::new().var("OPENCODE_AUTH_CONTENT", r#"{"opencode-go":{"type":"api","key":"k-inline"}}"#);
    assert_eq!(api_key(&inline, &secrets(&[])), Some(("k-inline".into(), "opencode-auth-content")));
    assert_eq!(api_key(&FakeHost::new().var("OPENCODE_API_KEY", "k-env"), &secrets(&[])), Some(("k-env".into(), "environment")));
    assert_eq!(api_key(&FakeHost::new(), &secrets(&[])), None);
  }

  #[test]
  fn fetches_with_the_key_only_to_opencode() {
    let http = FakeHttp::new(vec![FakeHttp::ok(API)]);
    let u = fetch(&http, &FakeHost::new(), &secrets(&[("opencode.apiKey", "k1")]), None, 0);
    assert_eq!((u.status.as_str(), u.weekly.map(|w| w.used_percent)), ("ok", Some(40.5)));
    assert_eq!(http.urls(), [USAGE_URL]);
    assert_eq!(http.header(0, "authorization").as_deref(), Some("Bearer k1"));
  }

  #[test]
  fn key_verdicts() {
    let s = secrets(&[("opencode.apiKey", "k1")]);
    let no_sub = FakeHttp::new(vec![Ok(super::super::io::Response { status: 400, body: r#"{"error":{"type":"EntitlementError"}}"#.into(), ..Default::default() })]);
    assert_eq!(fetch(&no_sub, &FakeHost::new(), &s, None, 0).failure_kind.as_deref(), Some("no-subscription"));
    assert_eq!(fetch(&FakeHttp::new(vec![FakeHttp::status(401)]), &FakeHost::new(), &s, None, 0).failure_kind.as_deref(), Some("stale-token"));
    let html = FakeHttp::new(vec![Ok(super::super::io::Response { status: 200, body: "<html>".into(), content_type: Some("text/html".into()), ..Default::default() })]);
    assert_eq!(fetch(&html, &FakeHost::new(), &s, None, 0).failure_kind.as_deref(), Some("stale-token"));
    assert_eq!(fetch(&FakeHttp::new(vec![]), &FakeHost::new(), &s, None, 0).failure_kind.as_deref(), Some("network"));
  }

  #[test]
  fn falls_back_to_the_cookie() {
    let s = secrets(&[("opencode.cookie", "theme=1; __Host-console_session=c1")]);
    let http = FakeHttp::new(vec![FakeHttp::ok(r#"[{id:"wrk_1"},{id:"wrk_2"}]"#), FakeHttp::status(500), FakeHttp::ok(STATUS)]);
    let u = fetch(&http, &FakeHost::new(), &s, None, 0);
    assert_eq!(u.status, "ok");
    let urls = http.urls();
    assert!(urls[0].starts_with("https://opencode.ai/_server?id="));
    assert_eq!(&urls[1..], [STATUS_URL, STATUS_URL]);
    assert_eq!(http.header(2, "x-org-id").as_deref(), Some("wrk_2"));
    assert_eq!(http.header(2, "cookie").as_deref(), Some("__Host-console_session=c1"), "only the auth cookie is sent");
    // A workspace id skips the lookup.
    let http = FakeHttp::new(vec![FakeHttp::ok(STATUS)]);
    assert_eq!(fetch(&http, &FakeHost::new(), &s, Some("org_9"), 0).status, "ok");
    assert_eq!(http.urls(), [STATUS_URL]);
    assert_eq!(fetch(&FakeHttp::new(vec![]), &FakeHost::new(), &s, Some("nope"), 0).status, "error");
    // Nothing set up: unavailable, nothing sent.
    let http = FakeHttp::new(vec![]);
    assert_eq!(fetch(&http, &FakeHost::new(), &secrets(&[]), None, 0).status, "unavailable");
    assert!(http.urls().is_empty());
  }
}
