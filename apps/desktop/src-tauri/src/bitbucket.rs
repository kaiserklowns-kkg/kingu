//! Bitbucket Cloud pull requests (Orca's `bitbucket:connect` / `:status` / `:disconnect` and its
//! Bitbucket hosted-review provider): a folder whose `origin` is on bitbucket.org gets its task
//! pull request found, shown with its build statuses, and created through Bitbucket's REST API,
//! answering in gh's shapes so the Source Control and Checks views treat it like a GitHub PR.
//!
//! Rules from Orca 1.4.253 (MECHANICS.md › Bitbucket): an access token (`Authorization: Bearer`)
//! or an email with an API token (`Basic`), base URL `https://api.bitbucket.org/2.0` unless set;
//! environment variables win over the stored credential; connecting checks `GET /user`. The stored
//! credential lives only in the OS keychain and never reaches the webview, logs or errors.

use base64::Engine;
use serde_json::{json, Value};

use crate::agent::review::{pr_status_of, WorktreePr};
use crate::i18n::msg::BitbucketMsg;
use crate::tr;
use crate::tracker_http::{common_error, Http, Request, Transport};

/// Orca `PVt`/`Eye`: the default API root.
pub const DEFAULT_BASE_URL: &str = "https://api.bitbucket.org/2.0";
/// Orca's PR states searched for a branch (`kye`).
pub const PR_STATES: [&str; 4] = ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"];
/// Orca: build statuses read per commit (`pagelen: 100`).
const STATUS_PAGE: u32 = 100;
const KEYCHAIN_SERVICE: &str = "dev.kingu.bitbucket";
const KEYCHAIN_ACCOUNT: &str = "bitbucket.org";
const MAX_SECRET: usize = 512;
/// Environment variables (Orca's are `ORCA_BITBUCKET_*`).
pub const ENV_ACCESS_TOKEN: &str = "KINGU_BITBUCKET_ACCESS_TOKEN";
pub const ENV_EMAIL: &str = "KINGU_BITBUCKET_EMAIL";
pub const ENV_API_TOKEN: &str = "KINGU_BITBUCKET_API_TOKEN";
pub const ENV_BASE_URL: &str = "KINGU_BITBUCKET_API_BASE_URL";

/// A Bitbucket repository: `workspace/repo_slug`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Repo {
  pub workspace: String,
  pub slug: String,
}

impl Repo {
  /// Orca `Lg`: both parts URL-encoded.
  fn path(&self) -> String {
    format!("/repositories/{}/{}", enc(&self.workspace), enc(&self.slug))
  }
}

fn enc(s: &str) -> String {
  url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>().replace('+', "%20")
}

fn dec(s: &str) -> String {
  url::form_urlencoded::parse(format!("x={s}").as_bytes()).next().map(|(_, v)| v.into_owned()).unwrap_or_else(|| s.to_string())
}

/// Orca `sg`: the last two path parts (`.git` and trailing `/` dropped) are workspace and repo.
fn repo_of_path(path: &str) -> Option<Repo> {
  let p = path.trim_end_matches('/');
  let p = p.strip_suffix(".git").or_else(|| p.strip_suffix(".GIT")).unwrap_or(p);
  let parts: Vec<&str> = p.split('/').map(str::trim).filter(|s| !s.is_empty()).collect();
  if parts.len() < 2 {
    return None;
  }
  Some(Repo { workspace: dec(parts[parts.len() - 2]), slug: dec(parts[parts.len() - 1]) })
}

/// Orca `uye`: `git@bitbucket.org:ws/repo.git` (optionally `ssh.bitbucket.org`), or an http(s)
/// or ssh URL whose host is bitbucket.org.
pub fn parse_remote(remote: &str) -> Option<Repo> {
  let r = remote.trim();
  if !r.contains("://") {
    let (_, rest) = r.split_once('@').unwrap_or(("", r));
    let (host, path) = rest.split_once(':')?;
    let host = host.to_ascii_lowercase();
    return (host == "bitbucket.org" || host == "ssh.bitbucket.org").then(|| repo_of_path(path)).flatten();
  }
  let u = url::Url::parse(r).ok()?;
  let host = u.host_str()?.to_ascii_lowercase();
  (host == "bitbucket.org" || host.ends_with(".bitbucket.org")).then(|| repo_of_path(u.path())).flatten()
}

// ---------------------------------------------------------------------------------------------
// Credentials

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, Default)]
pub struct Credential {
  /// `token` or `basic`.
  pub auth_mode: String,
  #[serde(default)]
  pub access_token: Option<String>,
  #[serde(default)]
  pub email: Option<String>,
  #[serde(default)]
  pub api_token: Option<String>,
  #[serde(default)]
  pub base_url: Option<String>,
  #[serde(default)]
  pub account: Option<String>,
}

fn trimmed(v: Option<String>) -> Option<String> {
  v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

impl Credential {
  /// Orca `dg`: an access token, or both an email and an API token.
  pub fn usable(&self) -> bool {
    self.access_token.is_some() || (self.email.is_some() && self.api_token.is_some())
  }

  /// Orca `fg`: `Bearer <token>`, else `Basic base64(email:apiToken)`.
  pub fn auth_header(&self) -> Option<String> {
    if let Some(t) = &self.access_token {
      return Some(format!("Bearer {t}"));
    }
    match (&self.email, &self.api_token) {
      (Some(e), Some(t)) => Some(format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{e}:{t}")))),
      _ => None,
    }
  }

  pub fn base(&self) -> String {
    self.base_url.clone().unwrap_or_else(|| DEFAULT_BASE_URL.to_string()).trim_end_matches('/').to_string()
  }

  /// Orca `PVt`: only the fields of the chosen mode are kept, each trimmed.
  pub fn from_input(auth_mode: &str, access_token: Option<String>, email: Option<String>, api_token: Option<String>, base_url: Option<String>) -> Result<Self, String> {
    let token_mode = auth_mode == "token";
    let c = Credential {
      auth_mode: if token_mode { "token".into() } else { "basic".into() },
      access_token: if token_mode { trimmed(access_token) } else { None },
      email: if token_mode { None } else { trimmed(email) },
      api_token: if token_mode { None } else { trimmed(api_token) },
      base_url: trimmed(base_url),
      account: None,
    };
    if !c.usable() {
      return Err(if token_mode { tr!(BitbucketMsg::AccessTokenRequired) } else { tr!(BitbucketMsg::EmailAndApiTokenRequired) });
    }
    for s in [&c.access_token, &c.email, &c.api_token].into_iter().flatten() {
      if s.len() > MAX_SECRET || s.chars().any(char::is_control) {
        return Err(if token_mode { tr!(BitbucketMsg::AccessTokenRequired) } else { tr!(BitbucketMsg::EmailAndApiTokenRequired) });
      }
    }
    if let Some(b) = &c.base_url
      && !b.starts_with("https://")
    {
      return Err(tr!(BitbucketMsg::BadBaseUrl));
    }
    Ok(c)
  }
}

/// Orca `ug`/`XC`: the environment's credential, when it has a usable one.
fn from_env() -> Option<Credential> {
  let get = |k: &str| trimmed(std::env::var(k).ok());
  let c = Credential {
    auth_mode: if get(ENV_ACCESS_TOKEN).is_some() { "token".into() } else { "basic".into() },
    access_token: get(ENV_ACCESS_TOKEN),
    email: get(ENV_EMAIL),
    api_token: get(ENV_API_TOKEN),
    base_url: get(ENV_BASE_URL),
    account: None,
  };
  c.usable().then_some(c)
}

fn entry() -> Result<keyring::Entry, String> {
  keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|e| e.to_string())
}

fn stored() -> Option<Credential> {
  let text = entry().ok()?.get_password().ok()?;
  serde_json::from_str::<Credential>(&text).ok().filter(Credential::usable)
}

/// The credential in use: the environment's first (Orca's order), else the stored one.
pub fn credential() -> Option<(Credential, &'static str)> {
  from_env().map(|c| (c, "environment")).or_else(|| stored().map(|c| (c, "stored")))
}

/// Orca `Oye` (provider chunk): every Bitbucket API request gets 5 000 ms.
pub const REQUEST_TIMEOUT_MS: u64 = 5000;
/// Orca `NVt` (out/main/index.js, app.asar offset 0x3c6914): the connect check gets 6 000 ms.
pub const CONNECT_CHECK_TIMEOUT_MS: u64 = 6000;
/// Orca `bye`/`Bye`: creating a pull request may take up to 60 000 ms.
pub const CREATE_TIMEOUT_MS: u64 = 60000;

fn client(c: &Credential, timeout_ms: u64) -> Result<Http, String> {
  Http::with_timeout("Bitbucket", &c.base(), "Authorization", c.auth_header().ok_or_else(|| tr!(BitbucketMsg::NotConnected))?, std::time::Duration::from_millis(timeout_ms))
}

/// A client for the credential in use, with Orca's request time limit.
pub fn connected() -> Result<Http, String> {
  let (c, _) = credential().ok_or_else(|| tr!(BitbucketMsg::NotConnected))?;
  client(&c, REQUEST_TIMEOUT_MS)
}

/// A client for `c` with a whole-request limit of `total` (a caller that read the credential once).
pub fn client_with_timeout(c: &Credential, total: std::time::Duration) -> Result<Http, String> {
  client(c, total.as_millis() as u64)
}

/// The same, with Orca's longer limit for creating a pull request.
pub fn connected_for_create() -> Result<Http, String> {
  let (c, _) = credential().ok_or_else(|| tr!(BitbucketMsg::NotConnected))?;
  client(&c, CREATE_TIMEOUT_MS)
}

/// Orca `pg`: username, else display name, else account id.
pub fn account_of(user: &Value) -> Option<String> {
  ["username", "display_name", "account_id"].iter().find_map(|k| user[*k].as_str().map(str::to_string))
}

/// Orca `mg`: `GET /user`; 401/403 → rejected, anything else that fails → unreachable.
pub fn verify(t: &dyn Transport) -> Result<Value, String> {
  match t.send(&Request::get("/user")) {
    Ok((200..=299, body)) => serde_json::from_str(&body).map_err(|_| tr!(BitbucketMsg::Unreachable)),
    Ok((401 | 403, _)) => Err(tr!(BitbucketMsg::Rejected)),
    _ => Err(tr!(BitbucketMsg::Unreachable)),
  }
}

fn get(t: &dyn Transport, path: String) -> Result<Value, String> {
  match t.send(&Request::get(path))? {
    (200..=299, body) => serde_json::from_str(&body).map_err(|_| tr!(BitbucketMsg::Failed, status = 200)),
    (401 | 403, _) => Err(tr!(BitbucketMsg::NotConnected)),
    (status, _) => Err(common_error("Bitbucket", status).unwrap_or_else(|| tr!(BitbucketMsg::Failed, status))),
  }
}

// ---------------------------------------------------------------------------------------------
// Pull requests

/// Orca `Mye`: `\` and `"` escaped inside a BBQL string.
fn bbql(s: &str) -> String {
  s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Orca `Lye`'s query: the newest PR (any of `PR_STATES`) whose source branch is `branch`.
pub fn branch_query(repo: &Repo, branch: &str) -> String {
  let states = PR_STATES.iter().map(|s| format!("state = \"{s}\"")).collect::<Vec<_>>().join(" OR ");
  let q = format!("source.branch.name = \"{}\" AND ({states})", bbql(branch));
  let mut path = format!("{}/pullrequests?pagelen=1&sort=-updated_on&q={}", repo.path(), enc(&q));
  for s in PR_STATES {
    path.push_str(&format!("&state={s}"));
  }
  path
}

/// The newest merged PRs whose source branch is `branch` (Workspace Cleanup).
pub fn merged_query(repo: &Repo, branch: &str) -> String {
  let q = format!("source.branch.name = \"{}\" AND state = \"MERGED\"", bbql(branch));
  format!("{}/pullrequests?pagelen=5&sort=-updated_on&q={}&state=MERGED", repo.path(), enc(&q))
}

/// The source commit of the first merged PR of `branch` opened from this repo itself; a fork's
/// same-named branch is a different branch.
pub fn pick_merged_head(list: &Value, repo: &Repo, branch: &str) -> Option<String> {
  let full = format!("{}/{}", repo.workspace, repo.slug);
  list["values"]
    .as_array()?
    .iter()
    .filter(|pr| {
      pr["state"] == "MERGED"
        && pr["source"]["branch"]["name"] == branch
        && pr["source"]["repository"]["full_name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(&full))
    })
    .find_map(|pr| pr["source"]["commit"]["hash"].as_str().map(str::trim).filter(|h| !h.is_empty()).map(str::to_owned))
}

/// The source commit `branch`'s newest merged PR had (Workspace Cleanup's fallback when the base
/// moved on after the merge).
pub fn merged_head(t: &dyn Transport, repo: &Repo, branch: &str) -> Result<Option<String>, String> {
  Ok(pick_merged_head(&get(t, merged_query(repo, branch))?, repo, branch))
}

/// Orca `rg`: MERGED → merged, DECLINED / SUPERSEDED → closed, anything else open; in gh's words.
pub fn gh_state(state: &str) -> &'static str {
  match state.trim().to_ascii_uppercase().as_str() {
    "MERGED" => "MERGED",
    "DECLINED" | "SUPERSEDED" => "CLOSED",
    _ => "OPEN",
  }
}

/// Orca `cye`: a build status as gh's StatusContext state.
pub fn gh_check_state(state: &str) -> &'static str {
  match state.trim().to_ascii_uppercase().as_str() {
    "SUCCESSFUL" => "SUCCESS",
    "FAILED" | "ERROR" => "FAILURE",
    "STOPPED" => "CANCELLED",
    "INPROGRESS" | "PENDING" => "PENDING",
    _ => "NEUTRAL",
  }
}

/// Orca `ig`: the overall build state (any failed → failure, any running → pending, all
/// successful → success, else neutral; none at all → neutral).
pub fn rollup(states: &[&str]) -> &'static str {
  let up: Vec<String> = states.iter().map(|s| s.trim().to_ascii_uppercase()).collect();
  if up.is_empty() {
    "neutral"
  } else if up.iter().any(|s| matches!(s.as_str(), "FAILED" | "STOPPED" | "ERROR")) {
    "failure"
  } else if up.iter().any(|s| matches!(s.as_str(), "INPROGRESS" | "PENDING")) {
    "pending"
  } else if up.iter().all(|s| s == "SUCCESSFUL") {
    "success"
  } else {
    "neutral"
  }
}

/// A Bitbucket PR and its build statuses in the shape `gh pr view --json` gives (Orca `ag` reports
/// `mergeable: UNKNOWN`; Bitbucket has no review decision in this answer).
pub fn gh_json(pr: &Value, statuses: &Value) -> Value {
  let checks: Vec<Value> = statuses["values"]
    .as_array()
    .map(|v| {
      v.iter()
        .map(|s| {
          json!({
            "__typename": "StatusContext",
            "context": s["name"].as_str().or(s["key"].as_str()).unwrap_or("build"),
            "state": gh_check_state(s["state"].as_str().unwrap_or_default()),
            "targetUrl": s["url"],
          })
        })
        .collect()
    })
    .unwrap_or_default();
  json!({
    "number": pr["id"],
    "url": pr["links"]["html"]["href"],
    "title": pr["title"],
    "state": gh_state(pr["state"].as_str().unwrap_or_default()),
    "isDraft": pr["draft"].as_bool().unwrap_or(false),
    "reviewDecision": "",
    "mergeable": "UNKNOWN",
    "mergeStateStatus": "",
    "headRefName": pr["source"]["branch"]["name"],
    "baseRefName": pr["destination"]["branch"]["name"],
    "statusCheckRollup": checks,
    // Orca's overall build state for the PR (`ig`), alongside the per-check list.
    "checksState": rollup(&statuses["values"].as_array().map(|v| v.iter().filter_map(|s| s["state"].as_str()).collect::<Vec<_>>()).unwrap_or_default()),
    "author": { "login": pr["author"]["display_name"] },
    "createdAt": pr["created_on"],
  })
}

/// Orca `Pye`: the build statuses of the PR's head commit (none without one).
fn statuses(t: &dyn Transport, repo: &Repo, pr: &Value) -> Value {
  match pr["source"]["commit"]["hash"].as_str().map(str::trim).filter(|h| !h.is_empty()) {
    Some(hash) => get(t, format!("{}/commit/{}/statuses/build?pagelen={STATUS_PAGE}", repo.path(), enc(hash))).unwrap_or_else(|e| {
      log::info!("bitbucket statuses of {hash}: {e}");
      Value::Null
    }),
    None => Value::Null,
  }
}

/// The pull request of `branch`, with its build statuses; `None` when it has none.
pub fn branch_pr(t: &dyn Transport, repo: &Repo, branch: &str) -> Result<Option<WorktreePr>, String> {
  let list = get(t, branch_query(repo, branch))?;
  let Some(pr) = list["values"].as_array().and_then(|v| v.first()) else { return Ok(None) };
  if pr["id"].as_u64().is_none() || pr["links"]["html"]["href"].as_str().is_none() {
    return Ok(None);
  }
  let raw = gh_json(pr, &statuses(t, repo, pr));
  Ok(Some(WorktreePr { status: pr_status_of(&raw)?, raw }))
}

/// Orca `Kye`: the create request (`title`, `description`, source and destination branch).
pub fn create_body(source: &str, target: &str, title: &str, body: &str) -> Value {
  json!({
    "title": title.trim(),
    "description": body,
    "source": { "branch": { "name": source } },
    "destination": { "branch": { "name": target.strip_prefix("origin/").unwrap_or(target) } },
  })
}

/// Opens the pull request (the branch is already pushed); returns its URL. Orca `Kye`/`Wye`:
/// title and both branches required, base ≠ head (any case), 401/403 → not connected, a body
/// mentioning an existing PR → already exists, 400/422 → rejected.
pub fn create(t: &dyn Transport, repo: &Repo, source: &str, target: &str, title: &str, body: &str) -> Result<String, String> {
  let base = target.strip_prefix("origin/").unwrap_or(target).trim();
  if title.trim().is_empty() || base.is_empty() || source.trim().is_empty() {
    return Err(tr!(BitbucketMsg::TitleRequired));
  }
  if base.eq_ignore_ascii_case(source.trim()) {
    return Err(tr!(BitbucketMsg::SameBranch));
  }
  let (status, text) = t.send(&Request::post(format!("{}/pullrequests", repo.path()), create_body(source, base, title, body)))?;
  let low = text.to_ascii_lowercase();
  match status {
    200..=299 => {
      let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
      if let Some(url) = v["links"]["html"]["href"].as_str() {
        return Ok(url.to_string());
      }
      // Orca: no URL in the answer → look the branch's PR up again.
      branch_pr(t, repo, source)?.map(|p| p.status.url).ok_or_else(|| tr!(BitbucketMsg::Failed, status))
    }
    401 | 403 => Err(tr!(BitbucketMsg::NotConnected)),
    _ if low.contains("already exists") || low.contains("already a pull request") => Err(tr!(BitbucketMsg::AlreadyExists)),
    400 | 422 => Err(tr!(BitbucketMsg::Validation)),
    _ => Err(common_error("Bitbucket", status).unwrap_or_else(|| tr!(BitbucketMsg::Failed, status))),
  }
}

// ---------------------------------------------------------------------------------------------
// Commands

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Status {
  pub configured: bool,
  /// `environment`, `stored` or `none`.
  pub source: &'static str,
  pub account: Option<String>,
  pub auth_mode: Option<String>,
  pub email: Option<String>,
  pub base_url: Option<String>,
}

/// Orca `LVt`: what is configured (no network call; secrets are never returned).
#[tauri::command]
pub fn bitbucket_status() -> Status {
  match credential() {
    Some((c, source)) => Status { configured: true, source, account: c.account, auth_mode: Some(c.auth_mode), email: c.email, base_url: c.base_url },
    None => Status { configured: false, source: "none", account: None, auth_mode: None, email: None, base_url: None },
  }
}

/// Orca `FVt`: checks the credential with `GET /user`, then keeps it in the keychain.
#[tauri::command]
pub async fn bitbucket_connect(auth_mode: String, access_token: Option<String>, email: Option<String>, api_token: Option<String>, base_url: Option<String>) -> Result<Status, String> {
  let mut c = Credential::from_input(&auth_mode, access_token, email, api_token, base_url)?;
  tauri::async_runtime::spawn_blocking(move || {
    let user = verify(&client(&c, CONNECT_CHECK_TIMEOUT_MS)?)?;
    c.account = account_of(&user);
    let text = serde_json::to_string(&c).map_err(|e| e.to_string())?;
    entry()?.set_password(&text).map_err(|e| tr!(BitbucketMsg::SaveFailed, detail = e))?;
    log::info!("bitbucket connected");
    Ok(Status { configured: true, source: "stored", account: c.account, auth_mode: Some(c.auth_mode), email: c.email, base_url: c.base_url })
  })
  .await
  .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn bitbucket_disconnect() -> Result<(), String> {
  match entry()?.delete_credential() {
    Ok(()) | Err(keyring::Error::NoEntry) => {
      log::info!("bitbucket disconnected");
      Ok(())
    }
    Err(e) => Err(e.to_string()),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::tracker_http::fake::Fake;

  fn repo() -> Repo {
    Repo { workspace: "acme".into(), slug: "web-app".into() }
  }

  #[test]
  fn reads_bitbucket_remotes_only() {
    assert_eq!(parse_remote("git@bitbucket.org:acme/web-app.git"), Some(repo()));
    assert_eq!(parse_remote("git@ssh.bitbucket.org:acme/web-app.git"), Some(repo()));
    assert_eq!(parse_remote("https://me@bitbucket.org/acme/web-app.git"), Some(repo()));
    assert_eq!(parse_remote("https://bitbucket.org/acme/web-app/"), Some(repo()));
    assert_eq!(parse_remote("ssh://git@bitbucket.org/acme/web%20app"), Some(Repo { workspace: "acme".into(), slug: "web app".into() }));
    assert_eq!(parse_remote("git@github.com:acme/web-app.git"), None);
    assert_eq!(parse_remote("https://bitbucket.org/acme"), None);
    assert_eq!(parse_remote("https://evilbitbucket.org/acme/x"), None);
  }

  #[test]
  fn credentials_follow_orcas_rules() {
    let t = Credential::from_input("token", Some(" abc ".into()), Some("ignored@x".into()), None, None).unwrap();
    assert_eq!((t.access_token.as_deref(), t.email.as_deref()), (Some("abc"), None));
    assert_eq!(t.auth_header().unwrap(), "Bearer abc");
    assert_eq!(t.base(), DEFAULT_BASE_URL);
    let b = Credential::from_input("basic", None, Some("me@x.io".into()), Some("tok".into()), Some("https://bb.example/2.0/".into())).unwrap();
    assert_eq!(b.auth_header().unwrap(), format!("Basic {}", base64::engine::general_purpose::STANDARD.encode("me@x.io:tok")));
    assert_eq!(b.base(), "https://bb.example/2.0");
    assert!(Credential::from_input("token", None, None, None, None).is_err());
    assert!(Credential::from_input("basic", None, Some("me@x.io".into()), None, None).is_err());
    assert!(Credential::from_input("token", Some("t".into()), None, None, Some("http://x".into())).is_err());
    assert_eq!(account_of(&json!({"display_name": "Me", "account_id": "1"})).as_deref(), Some("Me"));
  }

  #[test]
  fn states_and_rollup() {
    assert_eq!((gh_state("MERGED"), gh_state("DECLINED"), gh_state("SUPERSEDED"), gh_state("OPEN"), gh_state("")), ("MERGED", "CLOSED", "CLOSED", "OPEN", "OPEN"));
    assert_eq!(gh_check_state("SUCCESSFUL"), "SUCCESS");
    assert_eq!(gh_check_state("STOPPED"), "CANCELLED");
    assert_eq!(gh_check_state("whatever"), "NEUTRAL");
    assert_eq!(rollup(&[]), "neutral");
    assert_eq!(rollup(&["SUCCESSFUL", "STOPPED"]), "failure");
    assert_eq!(rollup(&["SUCCESSFUL", "INPROGRESS"]), "pending");
    assert_eq!(rollup(&["SUCCESSFUL", "successful"]), "success");
    assert_eq!(rollup(&["SUCCESSFUL", "OTHER"]), "neutral");
  }

  #[test]
  fn branch_query_matches_orca() {
    let q = branch_query(&repo(), "feat/\"x\"");
    assert!(q.starts_with("/repositories/acme/web-app/pullrequests?pagelen=1&sort=-updated_on&q="));
    assert!(q.ends_with("&state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED"));
    let decoded = dec(q.split("q=").nth(1).unwrap().split('&').next().unwrap());
    assert_eq!(decoded, r#"source.branch.name = "feat/\"x\"" AND (state = "OPEN" OR state = "MERGED" OR state = "DECLINED" OR state = "SUPERSEDED")"#);
  }

  #[test]
  fn finds_the_branch_pr_with_its_checks() {
    let pr = json!({"id": 7, "title": "Fix", "state": "OPEN", "draft": false, "links": {"html": {"href": "https://bitbucket.org/acme/web-app/pull-requests/7"}},
      "source": {"branch": {"name": "kingu/fix"}, "commit": {"hash": "abc123"}}, "destination": {"branch": {"name": "main"}}, "author": {"display_name": "Me"}});
    let t = Fake::new(&[(200, json!({"values": [pr]})), (200, json!({"values": [{"name": "ci", "state": "FAILED", "url": "https://ci/1"}, {"key": "lint", "state": "SUCCESSFUL"}]}))]);
    let got = branch_pr(&t, &repo(), "kingu/fix").unwrap().unwrap();
    assert_eq!((got.status.number, got.status.state.as_str(), got.status.base_ref.as_str()), (7, "OPEN", "main"));
    assert_eq!(got.status.checks.iter().map(|c| (c.name.as_str(), c.state)).collect::<Vec<_>>(), vec![("ci", "failure"), ("lint", "success")]);
    assert_eq!(t.requests()[1].path, "/repositories/acme/web-app/commit/abc123/statuses/build?pagelen=100");
    let none = Fake::new(&[(200, json!({"values": []}))]);
    assert!(branch_pr(&none, &repo(), "x").unwrap().is_none());
  }

  #[test]
  fn creates_and_maps_errors() {
    let t = Fake::new(&[(201, json!({"links": {"html": {"href": "https://bitbucket.org/acme/web-app/pull-requests/8"}}}))]);
    assert_eq!(create(&t, &repo(), "kingu/x", "origin/main", "Title", "Body").unwrap(), "https://bitbucket.org/acme/web-app/pull-requests/8");
    let sent = &t.requests()[0];
    assert_eq!(sent.path, "/repositories/acme/web-app/pullrequests");
    assert_eq!(sent.body.as_ref().unwrap()["destination"]["branch"]["name"], "main");
    assert_eq!(create(&t, &repo(), "main", "MAIN", "T", "").unwrap_err(), tr!(BitbucketMsg::SameBranch));
    assert_eq!(create(&t, &repo(), "x", "main", "  ", "").unwrap_err(), tr!(BitbucketMsg::TitleRequired));
    let t = Fake::new(&[(401, json!({}))]);
    assert_eq!(create(&t, &repo(), "x", "main", "T", "").unwrap_err(), tr!(BitbucketMsg::NotConnected));
    let t = Fake::new(&[(400, json!({"error": {"message": "There is already a pull request open"}}))]);
    assert_eq!(create(&t, &repo(), "x", "main", "T", "").unwrap_err(), tr!(BitbucketMsg::AlreadyExists));
    let t = Fake::new(&[(400, json!({"error": {"message": "bad"}}))]);
    assert_eq!(create(&t, &repo(), "x", "main", "T", "").unwrap_err(), tr!(BitbucketMsg::Validation));
  }

  fn merged(branch: &str, full_name: &str, hash: Value) -> Value {
    json!({"id": 9, "state": "MERGED", "source": {"branch": {"name": branch}, "commit": {"hash": hash}, "repository": {"full_name": full_name}}})
  }

  #[test]
  fn merged_query_asks_for_merged_prs_of_the_branch_newest_first() {
    let q = merged_query(&Repo { workspace: "acme".into(), slug: "web app".into() }, "feat/\"x\"");
    assert_eq!(
      q,
      "/repositories/acme/web%20app/pullrequests?pagelen=5&sort=-updated_on&q=source.branch.name%20%3D%20%22feat%2F%5C%22x%5C%22%22%20AND%20state%20%3D%20%22MERGED%22&state=MERGED"
    );
  }

  #[test]
  fn only_a_merged_pr_from_this_repo_with_a_hash_gives_a_head() {
    let pick = |v: Value| pick_merged_head(&v, &repo(), "feat");
    assert_eq!(pick(json!({"values": [merged("feat", "ACME/Web-App", json!(" abc123 "))]})).as_deref(), Some("abc123"));
    let open = json!({"id": 1, "state": "OPEN", "source": {"branch": {"name": "feat"}, "commit": {"hash": "abc"}, "repository": {"full_name": "acme/web-app"}}});
    assert_eq!(pick(json!({"values": [open]})), None);
    assert_eq!(pick(json!({"values": [merged("feat", "mallory/web-app", json!("abc"))]})), None);
    assert_eq!(pick(json!({"values": [merged("other", "acme/web-app", json!("abc"))]})), None);
    assert_eq!(pick(json!({"values": [merged("feat", "acme/web-app", json!(""))]})), None);
    assert_eq!(pick(json!({"values": [merged("feat", "acme/web-app", Value::Null)]})), None);
    assert_eq!(pick(json!({"values": [merged("feat", "mallory/web-app", json!("x")), merged("feat", "acme/web-app", json!("def"))]})).as_deref(), Some("def"));
    assert_eq!(pick(json!({"values": []})), None);
    assert_eq!(pick(json!({"values": {}})), None);
    assert_eq!(pick(json!([merged("feat", "acme/web-app", json!("abc"))])), None);
  }

  #[test]
  fn merged_head_asks_once_and_errors_are_errors() {
    let t = Fake::new(&[(200, json!({"values": [merged("kingu/x", "acme/web-app", json!("abc123"))]}))]);
    assert_eq!(merged_head(&t, &repo(), "kingu/x").unwrap().as_deref(), Some("abc123"));
    assert_eq!(t.requests().len(), 1);
    assert_eq!(t.requests()[0].path, merged_query(&repo(), "kingu/x"));
    assert_eq!(merged_head(&Fake::new(&[(200, json!({"values": []}))]), &repo(), "x").unwrap(), None);
    assert!(merged_head(&Fake::new(&[(404, json!({}))]), &repo(), "x").is_err());
    assert!(merged_head(&Fake::new(&[(401, json!({}))]), &repo(), "x").is_err());
  }

  #[test]
  fn verify_maps_rejected_and_unreachable() {
    assert_eq!(verify(&Fake::new(&[(401, json!({}))])).unwrap_err(), tr!(BitbucketMsg::Rejected));
    assert_eq!(verify(&Fake::new(&[(500, json!({}))])).unwrap_err(), tr!(BitbucketMsg::Unreachable));
    assert_eq!(verify(&Fake::new(&[(200, json!({"username": "me"}))])).unwrap()["username"], "me");
  }
}
