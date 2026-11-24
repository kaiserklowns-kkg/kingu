//! GitLab issues as agent tasks (old Kingu's GitLab task source, over GitLab's REST API instead of
//! `glab`): a personal access token per GitLab host, kept only in the OS keychain, and
//! `/api/v4` for the user, a project's open issues, one issue with its latest comments and posting
//! a comment. The project is `kingu.gitlab.project` or the open folder's remote on that host. The
//! token never reaches the webview, logs or error messages. Parsing is pure (`parse_*`); issues
//! come back in the GitHub issue shape (`agent::issues::Issue`, `number` is the project's `iid`).

use serde_json::{json, Value};

use crate::agent::issues::{truncate, Issue, IssueComment, IssueDetail, IssueLabel, MAX_BODY, MAX_COMMENT, MAX_COMMENTS, MAX_LIMIT};
use crate::i18n::msg::TrackerMsg;
use crate::tr;
use crate::tracker_http::{common_error, json, text, valid_token, Http, Request, Transport};

pub const KEYCHAIN_SERVICE: &str = "dev.kingu.gitlab";
const SERVICE: &str = "GitLab";
const MAX_TOKEN: usize = 256;
const MAX_COMMENT_POST: usize = 16 * 1024;
/// Notes fetched per issue (newest first); system notes are dropped, the latest `MAX_COMMENTS` kept.
const NOTES_FETCHED: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Viewer {
  pub username: String,
  pub name: String,
  pub host: String,
}

/// A project's issues and the project they came from (`group/sub/app`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct IssueList {
  pub project: String,
  pub issues: Vec<Issue>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IssueQuery {
  pub project: String,
  /// Only issues assigned to the token's user.
  pub mine: bool,
  pub label: Option<String>,
  pub search: Option<String>,
  pub limit: u32,
}

/// `gitlab.com`, `gitlab.acme.dev:8443`: a host name with an optional port, no scheme or path.
pub fn valid_host(host: &str) -> bool {
  let (name, port) = host.split_once(':').unwrap_or((host, ""));
  !name.is_empty()
    && name.len() <= 253
    && name.split('.').all(|l| !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
    && (port.is_empty() || port.parse::<u16>().is_ok_and(|p| p > 0))
}

/// `group/sub/app`: path segments GitLab allows, no `.`/`..` segment.
pub fn valid_project(path: &str) -> bool {
  path.len() <= 255
    && path.split('/').count() >= 2
    && path.split('/').all(|s| !s.is_empty() && s != "." && s != ".." && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.')))
}

/// The key a task keeps for a GitLab issue: `group/app#12`.
pub fn valid_issue_key(key: &str) -> bool {
  key.rsplit_once('#').is_some_and(|(p, n)| valid_project(p) && !n.is_empty() && n.len() <= 12 && n.bytes().all(|b| b.is_ascii_digit()) && !n.starts_with('0'))
}

pub(crate) fn host_or_err(host: &str) -> Result<String, String> {
  let h = host.trim().trim_end_matches('/').to_ascii_lowercase();
  let h = h.strip_prefix("https://").unwrap_or(&h).to_owned();
  if valid_host(&h) { Ok(h) } else { Err(tr!(TrackerMsg::GitlabBadHost, host)) }
}

fn project_or_err(project: &str) -> Result<String, String> {
  let p = project.trim().trim_matches('/').trim_end_matches(".git");
  if valid_project(p) { Ok(p.to_owned()) } else { Err(tr!(TrackerMsg::GitlabBadProject, project)) }
}

/// The project path in a URL path segment: `group%2Fapp`.
fn encoded(project: &str) -> String {
  project.replace('/', "%2F")
}

/// The project of a git remote URL on `host` (ssh, scp-like or https), if it is one.
pub fn project_from_remote(remote: &str, host: &str) -> Option<String> {
  let remote = remote.trim();
  let host_name = host.split(':').next().unwrap_or(host);
  let path = if let Some(rest) = remote.strip_prefix("https://").or_else(|| remote.strip_prefix("http://")).or_else(|| remote.strip_prefix("ssh://")) {
    let (authority, path) = rest.split_once('/')?;
    let h = authority.rsplit('@').next()?;
    let (h_name, _) = h.split_once(':').unwrap_or((h, ""));
    if !(h == host || h_name.eq_ignore_ascii_case(host_name)) {
      return None;
    }
    path
  } else {
    // scp-like: git@gitlab.com:group/app.git
    let (authority, path) = remote.split_once(':')?;
    let h = authority.rsplit('@').next()?;
    if !h.eq_ignore_ascii_case(host_name) || path.starts_with('/') {
      return None;
    }
    path
  };
  let p = path.trim_matches('/').trim_end_matches(".git");
  valid_project(p).then(|| p.to_owned())
}

/// The data of a response, or a message the user can act on.
pub fn response(status: u16, body: &str) -> Result<Value, String> {
  match status {
    401 => return Err(tr!(TrackerMsg::GitlabAuthFailed)),
    403 => return Err(tr!(TrackerMsg::GitlabForbidden)),
    404 => return Err(tr!(TrackerMsg::GitlabNotFound)),
    _ => {}
  }
  if let Some(e) = common_error(SERVICE, status) {
    return Err(e);
  }
  let v = json(SERVICE, status, body)?;
  if !(200..300).contains(&status) {
    let message = v["message"].as_str().map(str::to_owned).or_else(|| v["error"].as_str().map(str::to_owned)).unwrap_or_else(|| v["message"].to_string());
    return Err(format!("GitLab: {message}"));
  }
  Ok(v)
}

fn call(t: &dyn Transport, req: Request) -> Result<Value, String> {
  let (status, body) = t.send(&req)?;
  response(status, &body)
}

pub fn parse_user(v: &Value, host: &str) -> Result<Viewer, String> {
  let username = text(v, "username");
  if username.is_empty() {
    return Err(tr!(TrackerMsg::NoViewer, service = SERVICE));
  }
  Ok(Viewer { name: [text(v, "name"), username.clone()].into_iter().find(|n| !n.is_empty()).unwrap_or_default(), username, host: host.to_owned() })
}

pub fn parse_issue(v: &Value) -> Result<Issue, String> {
  let number = v["iid"].as_u64().filter(|n| *n > 0).ok_or_else(|| tr!(TrackerMsg::NoIssueNumber, service = SERVICE))?;
  // `with_labels_details=true` gives objects with a `#rrggbb` colour; without it, plain names.
  let labels = v["labels"]
    .as_array()
    .map(|a| {
      a.iter()
        .map(|l| match l.as_str() {
          Some(name) => IssueLabel { name: name.to_owned(), color: String::new() },
          None => IssueLabel { name: text(l, "name"), color: text(l, "color").trim_start_matches('#').to_owned() },
        })
        .filter(|l| !l.name.is_empty())
        .collect()
    })
    .unwrap_or_default();
  let assignees = v["assignees"].as_array().map(|a| a.iter().map(|u| text(u, "username")).filter(|u| !u.is_empty()).collect()).unwrap_or_default();
  let (body, body_truncated) = truncate(v["description"].as_str().unwrap_or_default(), MAX_BODY);
  Ok(Issue {
    number,
    title: text(v, "title"),
    url: text(v, "web_url"),
    state: if text(v, "state") == "opened" { "OPEN".into() } else { "CLOSED".into() },
    labels,
    assignees,
    updated_at: text(v, "updated_at"),
    author: text(&v["author"], "username"),
    body,
    body_truncated,
  })
}

/// The list path for `q` (project already checked).
pub fn list_path(q: &IssueQuery) -> String {
  let mut query = url::form_urlencoded::Serializer::new(String::new());
  query
    .append_pair("state", "opened")
    .append_pair("order_by", "updated_at")
    .append_pair("sort", "desc")
    .append_pair("with_labels_details", "true")
    .append_pair("per_page", &q.limit.clamp(1, MAX_LIMIT.min(100)).to_string());
  // GitLab's default scope for a project's issues is every issue; `assigned_to_me` narrows it.
  if q.mine {
    query.append_pair("scope", "assigned_to_me");
  }
  if let Some(l) = q.label.as_deref().map(str::trim).filter(|l| !l.is_empty()) {
    query.append_pair("labels", l);
  }
  if let Some(s) = q.search.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
    query.append_pair("search", s);
  }
  format!("/projects/{}/issues?{}", encoded(&q.project), query.finish())
}

pub fn parse_list(v: &Value) -> Result<Vec<Issue>, String> {
  v.as_array().ok_or_else(|| tr!(TrackerMsg::NotIssueList, service = SERVICE))?.iter().map(parse_issue).collect()
}

/// Notes (newest first) → the latest `MAX_COMMENTS` people's comments, oldest first, and how many were left out.
pub fn parse_notes(v: &Value) -> (Vec<IssueComment>, usize) {
  let mut all: Vec<IssueComment> = v
    .as_array()
    .map(Vec::as_slice)
    .unwrap_or_default()
    .iter()
    .filter(|n| n["system"].as_bool() != Some(true))
    .map(|n| IssueComment { author: text(&n["author"], "username"), body: truncate(n["body"].as_str().unwrap_or_default(), MAX_COMMENT).0, created_at: text(n, "created_at") })
    .collect();
  all.sort_by(|a, b| a.created_at.cmp(&b.created_at));
  let skip = all.len().saturating_sub(MAX_COMMENTS);
  (all.split_off(skip), skip)
}

pub fn viewer(t: &dyn Transport, host: &str) -> Result<Viewer, String> {
  parse_user(&call(t, Request::get("/user"))?, host)
}

pub fn list(t: &dyn Transport, q: &IssueQuery) -> Result<Vec<Issue>, String> {
  parse_list(&call(t, Request::get(list_path(q)))?)
}

pub fn view(t: &dyn Transport, project: &str, iid: u64) -> Result<IssueDetail, String> {
  let base = format!("/projects/{}/issues/{iid}", encoded(project));
  let issue = parse_issue(&call(t, Request::get(base.clone()))?)?;
  let (comments, comments_omitted) = parse_notes(&call(t, Request::get(format!("{base}/notes?sort=desc&order_by=created_at&per_page={NOTES_FETCHED}")))?);
  Ok(IssueDetail { issue, comments, comments_omitted })
}

pub fn comment(t: &dyn Transport, project: &str, iid: u64, body: &str) -> Result<(), String> {
  if body.trim().is_empty() || body.len() > MAX_COMMENT_POST {
    return Err(tr!(TrackerMsg::CommentLength, max = MAX_COMMENT_POST));
  }
  call(t, Request::post(format!("/projects/{}/issues/{iid}/notes", encoded(project)), json!({ "body": body }))).map(|_| ())
}

/// Closes or reopens the issue (Orca's `GitLabIssueUpdate.state`, `state_event` in GitLab's API).
pub fn set_state(t: &dyn Transport, project: &str, iid: u64, open: bool) -> Result<Issue, String> {
  parse_issue(&call(t, Request::put(format!("/projects/{}/issues/{iid}", encoded(project)), json!({ "state_event": if open { "reopen" } else { "close" } })))?)
}

/// Assigns the issue to the signed-in user (`me`, its id from `/user`), or unassigns everyone
/// (GitLab: `assignee_ids` of `[0]`; Orca's `addAssignees` / `removeAssignees`).
pub fn assign(t: &dyn Transport, project: &str, iid: u64, me: bool) -> Result<Issue, String> {
  let ids = if me {
    let id = call(t, Request::get("/user"))?["id"].as_u64().ok_or_else(|| tr!(TrackerMsg::NoViewer, service = SERVICE))?;
    json!([id])
  } else {
    json!([0])
  };
  parse_issue(&call(t, Request::put(format!("/projects/{}/issues/{iid}", encoded(project)), json!({ "assignee_ids": ids })))?)
}

/// Members per page of `members/all`, and the most pages read (Orca reads every page).
const MEMBERS_PAGE: usize = 100;
const MEMBERS_PAGES: usize = 5;

/// The ids of the issue's assignees, as GitLab returns them.
fn assignee_ids(t: &dyn Transport, project: &str, iid: u64) -> Result<Vec<u64>, String> {
  let v = call(t, Request::get(format!("/projects/{}/issues/{iid}", encoded(project))))?;
  Ok(v["assignees"].as_array().map(Vec::as_slice).unwrap_or_default().iter().filter_map(|u| u["id"].as_u64()).collect())
}

/// The people who can be assigned the issue (Orca's `listAssignableUsers`: the project's
/// `members/all`, inherited group members included), its assignees marked: `id` is the user's
/// numeric id, `name` "Name (@username)", sorted by name. At most 500 members.
pub fn members(t: &dyn Transport, project: &str, iid: u64) -> Result<Vec<crate::tracker_http::StateChoice>, String> {
  let current = assignee_ids(t, project, iid)?;
  let mut out: Vec<crate::tracker_http::StateChoice> = Vec::new();
  for page in 1..=MEMBERS_PAGES {
    let v = call(t, Request::get(format!("/projects/{}/members/all?per_page={MEMBERS_PAGE}&page={page}", encoded(project))))?;
    let rows = v.as_array().map(Vec::as_slice).unwrap_or_default();
    for u in rows {
      let (Some(id), username) = (u["id"].as_u64().filter(|id| *id > 0), text(u, "username")) else { continue };
      if username.is_empty() || out.iter().any(|c| c.id == id.to_string()) {
        continue;
      }
      let name = text(u, "name");
      out.push(crate::tracker_http::StateChoice { id: id.to_string(), name: if name.is_empty() { format!("@{username}") } else { format!("{name} (@{username})") }, current: current.contains(&id), needs_fields: false });
    }
    if rows.len() < MEMBERS_PAGE {
      break;
    }
  }
  let key = |c: &crate::tracker_http::StateChoice| c.name.trim_start_matches('@').to_lowercase();
  out.sort_by(|a, b| key(a).cmp(&key(b)).then_with(|| a.id.cmp(&b.id)));
  Ok(out)
}

/// Adds user `user_id` to the issue's assignees or removes them (Orca's `addAssignees` /
/// `removeAssignees`; GitLab's REST API takes the whole `assignee_ids` list, `[0]` for nobody).
pub fn set_assignee(t: &dyn Transport, project: &str, iid: u64, user_id: u64, add: bool) -> Result<Issue, String> {
  if user_id == 0 {
    return Err(tr!(TrackerMsg::BadUser, service = SERVICE, user = user_id));
  }
  let mut ids = assignee_ids(t, project, iid)?;
  ids.retain(|id| *id != user_id);
  if add {
    ids.push(user_id);
  }
  ids.truncate(100);
  let ids = if ids.is_empty() { vec![0] } else { ids };
  parse_issue(&call(t, Request::put(format!("/projects/{}/issues/{iid}", encoded(project)), json!({ "assignee_ids": ids })))?)
}

/// Adds and removes labels (Orca's `addLabels` / `removeLabels`: GitLab's `add_labels` / `remove_labels`).
pub fn edit_labels(t: &dyn Transport, project: &str, iid: u64, add: &[String], remove: &[String]) -> Result<Issue, String> {
  let clean = |list: &[String]| -> Result<String, String> {
    list.iter().map(|l| crate::tracker_http::clean_label(l, &[',']).ok_or_else(|| tr!(TrackerMsg::BadLabel, label = l.clone()))).collect::<Result<Vec<_>, _>>().map(|v| v.join(","))
  };
  let mut body = serde_json::Map::new();
  let (a, r) = (clean(add)?, clean(remove)?);
  if !a.is_empty() {
    body.insert("add_labels".into(), Value::String(a));
  }
  if !r.is_empty() {
    body.insert("remove_labels".into(), Value::String(r));
  }
  parse_issue(&call(t, Request::put(format!("/projects/{}/issues/{iid}", encoded(project)), Value::Object(body)))?)
}

/// Only a page on the connected GitLab host opens from a task's GitLab link.
pub fn gitlab_url(url: &str, host: &str) -> Result<url::Url, String> {
  let u = url::Url::parse(url).map_err(|e| e.to_string())?;
  let authority = match (u.host_str(), u.port()) {
    (Some(h), Some(p)) => format!("{h}:{p}"),
    (Some(h), None) => h.to_owned(),
    _ => String::new(),
  };
  if u.scheme() == "https" && authority.eq_ignore_ascii_case(host) { Ok(u) } else { Err(tr!(TrackerMsg::OnlyHostLinks, host)) }
}

// ---------------------------------------------------------------------------------------------
// Keychain and commands

fn entry(host: &str) -> Result<keyring::Entry, String> {
  keyring::Entry::new(KEYCHAIN_SERVICE, host).map_err(|e| e.to_string())
}

pub(crate) fn stored_token(host: &str) -> Option<String> {
  entry(host).ok()?.get_password().ok()
}

fn client(host: &str, token: String) -> Result<Http, String> {
  Http::new(SERVICE, &format!("https://{host}/api/v4"), "PRIVATE-TOKEN", token)
}

/// A client with the stored token of `host` (also the merge requests in `agent/mr.rs`).
pub(crate) fn connected(host: &str) -> Result<Http, String> {
  client(host, stored_token(host).ok_or_else(|| tr!(TrackerMsg::GitlabNotConnected, host))?)
}

/// A client with `token` and a whole-request limit of `total` (Workspace Cleanup's bounded lookups).
pub(crate) fn client_with_timeout(host: &str, token: String, total: std::time::Duration) -> Result<Http, String> {
  Http::with_timeout(SERVICE, &format!("https://{host}/api/v4"), "PRIVATE-TOKEN", token, total)
}

/// `project`, or the open folder's remote on `host` (origin first).
fn resolve_project(ws: &crate::workspace::Workspace, host: &str, project: Option<String>) -> Result<String, String> {
  if let Some(p) = project.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
    return project_or_err(p);
  }
  let root = ws.root()?;
  let git = |args: &[&str]| crate::git::run(&root, args).map(|o| String::from_utf8_lossy(&o).into_owned());
  let remotes = git(&["remote"]).unwrap_or_default();
  let mut names: Vec<&str> = remotes.lines().map(str::trim).filter(|r| !r.is_empty()).collect();
  names.sort_by_key(|r| *r != "origin");
  names
    .into_iter()
    .find_map(|r| git(&["remote", "get-url", r]).ok().and_then(|u| project_from_remote(&u, host)))
    .ok_or_else(|| tr!(TrackerMsg::GitlabNoProject, host))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// The user the stored token of `host` belongs to, or none without one.
#[tauri::command]
pub async fn gitlab_status(host: String) -> Result<Option<Viewer>, String> {
  let host = host_or_err(&host)?;
  blocking(move || match stored_token(&host) {
    None => Ok(None),
    Some(token) => viewer(&client(&host, token)?, &host).map(Some),
  })
  .await
}

/// Checks the token with GitLab, then stores it in the keychain under the host.
#[tauri::command]
pub async fn gitlab_connect(host: String, token: String) -> Result<Viewer, String> {
  let host = host_or_err(&host)?;
  let token = token.trim().to_owned();
  if !valid_token(&token, MAX_TOKEN) {
    return Err(tr!(TrackerMsg::GitlabBadToken));
  }
  blocking(move || {
    let v = viewer(&client(&host, token.clone())?, &host)?;
    entry(&host)?.set_password(&token).map_err(|e| tr!(TrackerMsg::SaveSecretFailed, detail = e))?;
    log::info!("gitlab connected ({host})");
    Ok(v)
  })
  .await
}

#[tauri::command]
pub fn gitlab_disconnect(host: String) -> Result<(), String> {
  let host = host_or_err(&host)?;
  match entry(&host)?.delete_credential() {
    Ok(()) | Err(keyring::Error::NoEntry) => {
      log::info!("gitlab disconnected ({host})");
      Ok(())
    }
    Err(e) => Err(tr!(TrackerMsg::DeleteSecretFailed, detail = e)),
  }
}

#[tauri::command]
pub async fn gitlab_issues_list(
  ws: crate::workspace::Workspace,
  host: String,
  project: Option<String>,
  mine: Option<bool>,
  label: Option<String>,
  search: Option<String>,
  limit: Option<u32>,
) -> Result<IssueList, String> {
  let host = host_or_err(&host)?;
  let project = resolve_project(&ws, &host, project)?;
  let q = IssueQuery { project: project.clone(), mine: mine.unwrap_or(true), label, search, limit: limit.unwrap_or(50) };
  blocking(move || Ok(IssueList { issues: list(&connected(&host)?, &q)?, project })).await
}

/// `key`: `group/app#12`, as a task keeps it.
#[tauri::command]
pub async fn gitlab_issue_view(host: String, key: String) -> Result<IssueDetail, String> {
  let host = host_or_err(&host)?;
  let (project, iid) = split_key(&key)?;
  blocking(move || view(&connected(&host)?, &project, iid)).await
}

#[tauri::command]
pub async fn gitlab_issue_comment(host: String, key: String, body: String) -> Result<(), String> {
  let host = host_or_err(&host)?;
  let (project, iid) = split_key(&key)?;
  blocking(move || {
    comment(&connected(&host)?, &project, iid, &body)?;
    log::info!("commented on gitlab issue {project}#{iid}");
    Ok(())
  })
  .await
}

#[tauri::command]
pub async fn gitlab_issue_set_state(host: String, key: String, open: bool) -> Result<Issue, String> {
  let host = host_or_err(&host)?;
  let (project, iid) = split_key(&key)?;
  blocking(move || {
    let issue = set_state(&connected(&host)?, &project, iid, open)?;
    log::info!("{} gitlab issue {project}#{iid}", if open { "reopened" } else { "closed" });
    Ok(issue)
  })
  .await
}

#[tauri::command]
pub async fn gitlab_issue_assign(host: String, key: String, me: bool) -> Result<Issue, String> {
  let host = host_or_err(&host)?;
  let (project, iid) = split_key(&key)?;
  blocking(move || assign(&connected(&host)?, &project, iid, me)).await
}

#[tauri::command]
pub async fn gitlab_issue_members(host: String, key: String) -> Result<Vec<crate::tracker_http::StateChoice>, String> {
  let host = host_or_err(&host)?;
  let (project, iid) = split_key(&key)?;
  blocking(move || members(&connected(&host)?, &project, iid)).await
}

#[tauri::command]
pub async fn gitlab_issue_set_assignee(host: String, key: String, user_id: u64, add: bool) -> Result<Issue, String> {
  let host = host_or_err(&host)?;
  let (project, iid) = split_key(&key)?;
  blocking(move || set_assignee(&connected(&host)?, &project, iid, user_id, add)).await
}

#[tauri::command]
pub async fn gitlab_issue_labels(host: String, key: String, add: Vec<String>, remove: Vec<String>) -> Result<Issue, String> {
  let host = host_or_err(&host)?;
  let (project, iid) = split_key(&key)?;
  blocking(move || edit_labels(&connected(&host)?, &project, iid, &add, &remove)).await
}

#[tauri::command]
pub fn gitlab_issue_open(host: String, url: String) -> Result<(), String> {
  let host = host_or_err(&host)?;
  crate::system::open_web_url(gitlab_url(&url, &host)?.as_str())
}

fn split_key(key: &str) -> Result<(String, u64), String> {
  if !valid_issue_key(key) {
    return Err(tr!(TrackerMsg::BadIssueKey, service = SERVICE, key));
  }
  let (p, n) = key.rsplit_once('#').unwrap_or_default();
  Ok((p.to_owned(), n.parse().map_err(|_| tr!(TrackerMsg::BadIssueKey, service = SERVICE, key))?))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::tracker_http::fake::Fake;
  use crate::tracker_http::Method;

  fn issue(iid: u64) -> Value {
    json!({
      "iid": iid, "title": "แก้ login", "web_url": format!("https://gitlab.com/acme/app/-/issues/{iid}"), "state": "opened",
      "labels": [{ "name": "bug", "color": "#d9534f" }, { "name": "", "color": "" }], "assignees": [{ "username": "kawin" }],
      "updated_at": "2026-10-01T08:30:00.000Z", "author": { "username": "hubot" }, "description": null
    })
  }

  #[test]
  fn parses_issues_in_the_github_shape() {
    let list = parse_list(&json!([issue(12), { "iid": 3, "title": "x", "state": "closed", "labels": ["ops"], "web_url": "u" }])).unwrap();
    let a = &list[0];
    assert_eq!((a.number, a.state.as_str(), a.author.as_str(), a.body.as_str()), (12, "OPEN", "hubot", ""));
    assert_eq!(a.labels, [IssueLabel { name: "bug".into(), color: "d9534f".into() }]);
    assert_eq!(a.assignees, ["kawin"]);
    assert_eq!((list[1].state.as_str(), list[1].labels[0].name.as_str()), ("CLOSED", "ops"));
    assert!(parse_list(&json!({})).is_err());
    assert!(parse_list(&json!([{ "title": "no iid" }])).is_err());
  }

  #[test]
  fn builds_list_paths() {
    let q = IssueQuery { project: "acme/sub/app".into(), mine: true, label: Some(" bug ".into()), search: Some("log in".into()), limit: 999 };
    let p = list_path(&q);
    assert!(p.starts_with("/projects/acme%2Fsub%2Fapp/issues?state=opened&order_by=updated_at&sort=desc&with_labels_details=true&per_page=100"), "{p}");
    assert!(p.contains("&scope=assigned_to_me&labels=bug&search=log+in"), "{p}");
    let all = list_path(&IssueQuery { project: "a/b".into(), limit: 5, ..Default::default() });
    assert!(!all.contains("scope") && all.contains("per_page=5"));
  }

  #[test]
  fn keeps_the_latest_people_comments() {
    let mut notes: Vec<Value> = (0..MAX_COMMENTS + 2)
      .rev()
      .map(|i| json!({ "body": format!("c{i}"), "created_at": format!("2026-10-{:02}T00:00:00Z", i + 1), "author": { "username": "u" }, "system": false }))
      .collect();
    notes.insert(0, json!({ "body": "changed the label", "created_at": "2026-12-01T00:00:00Z", "system": true }));
    let (comments, omitted) = parse_notes(&Value::Array(notes));
    assert_eq!((comments.len(), omitted), (MAX_COMMENTS, 2));
    assert_eq!(comments[0].body, "c2");
  }

  #[test]
  fn view_and_comment_send_the_right_requests() {
    let t = Fake::new(&[(200, issue(12)), (200, json!([])), (201, json!({ "id": 1 }))]);
    let d = view(&t, "acme/app", 12).unwrap();
    assert_eq!((d.issue.number, d.comments.len()), (12, 0));
    comment(&t, "acme/app", 12, "Kingu เริ่มงานนี้ใน PR …").unwrap();
    let seen = t.requests();
    assert_eq!(seen[0].path, "/projects/acme%2Fapp/issues/12");
    assert!(seen[1].path.starts_with("/projects/acme%2Fapp/issues/12/notes?sort=desc"));
    assert_eq!((seen[2].method, seen[2].body.clone()), (Method::Post, Some(json!({ "body": "Kingu เริ่มงานนี้ใน PR …" }))));
    assert!(comment(&t, "acme/app", 12, " ").is_err());
    assert_eq!(t.requests().len(), 3);
  }

  #[test]
  fn explains_failures() {
    assert_eq!(response(401, "").unwrap_err(), tr!(TrackerMsg::GitlabAuthFailed));
    assert_eq!(response(404, "{}").unwrap_err(), tr!(TrackerMsg::GitlabNotFound));
    assert_eq!(response(400, r#"{"message":"labels is invalid"}"#).unwrap_err(), "GitLab: labels is invalid");
    assert!(response(500, "").unwrap_err().contains("500"));
    assert_eq!(response(200, "[1]").unwrap(), json!([1]));
  }

  #[test]
  fn finds_the_project_in_remotes() {
    let h = "gitlab.com";
    assert_eq!(project_from_remote("git@gitlab.com:acme/sub/app.git", h).as_deref(), Some("acme/sub/app"));
    assert_eq!(project_from_remote("https://gitlab.com/acme/app.git", h).as_deref(), Some("acme/app"));
    assert_eq!(project_from_remote("https://oauth2:tok@gitlab.com/acme/app", h).as_deref(), Some("acme/app"));
    assert_eq!(project_from_remote("ssh://git@gitlab.com:2222/acme/app.git", h).as_deref(), Some("acme/app"));
    assert_eq!(project_from_remote("git@github.com:acme/app.git", h), None);
    assert_eq!(project_from_remote("https://gitlab.com.evil.dev/acme/app", h), None);
    assert_eq!(project_from_remote("https://gitlab.com/../app", h), None);
  }

  #[test]
  fn validates_hosts_projects_keys_and_links() {
    assert!(valid_host("gitlab.com") && valid_host("git.acme.dev:8443"));
    assert!(!valid_host("") && !valid_host("gitlab.com/x") && !valid_host("a..b") && !valid_host("h:0") && !valid_host("h:x"));
    assert_eq!(host_or_err(" https://GitLab.com/ ").unwrap(), "gitlab.com");
    assert!(valid_project("acme/app") && valid_project("a.b/c_d/e-f") && !valid_project("app") && !valid_project("a/../b") && !valid_project("a//b"));
    assert_eq!(project_or_err("/acme/app.git").unwrap(), "acme/app");
    assert!(valid_issue_key("acme/app#12") && !valid_issue_key("acme/app#0") && !valid_issue_key("#12") && !valid_issue_key("acme/app#1a"));
    assert_eq!(split_key("acme/sub/app#7").unwrap(), ("acme/sub/app".into(), 7));
    assert!(gitlab_url("https://gitlab.com/acme/app/-/issues/1", "gitlab.com").is_ok());
    assert!(gitlab_url("https://git.acme.dev:8443/a/b/-/issues/1", "git.acme.dev:8443").is_ok());
    assert!(gitlab_url("https://gitlab.com.evil.dev/x", "gitlab.com").is_err());
    assert!(gitlab_url("http://gitlab.com/x", "gitlab.com").is_err());
  }

  #[test]
  fn closes_and_reopens_with_a_state_event() {
    let t = Fake::new(&[(200, issue(12)), (200, issue(12))]);
    set_state(&t, "acme/app", 12, false).unwrap();
    set_state(&t, "acme/app", 12, true).unwrap();
    let seen = t.requests();
    assert_eq!((seen[0].method, seen[0].path.as_str(), seen[0].body.clone()), (Method::Put, "/projects/acme%2Fapp/issues/12", Some(json!({ "state_event": "close" }))));
    assert_eq!(seen[1].body, Some(json!({ "state_event": "reopen" })));
  }

  #[test]
  fn assigns_to_me_by_user_id_or_unassigns_everyone() {
    let t = Fake::new(&[(200, json!({ "id": 7, "username": "k" })), (200, issue(12)), (200, issue(12))]);
    assign(&t, "acme/app", 12, true).unwrap();
    assign(&t, "acme/app", 12, false).unwrap();
    let seen = t.requests();
    assert_eq!(seen[1].body, Some(json!({ "assignee_ids": [7] })));
    assert_eq!(seen[2].body, Some(json!({ "assignee_ids": [0] })));
  }

  #[test]
  fn lists_project_members_with_assignees_marked_and_adds_or_removes_one() {
    let mut assigned = issue(12);
    assigned["assignees"] = json!([{ "id": 7, "username": "bo" }]);
    let full: Vec<Value> = (1..=100).map(|i| json!({ "id": 100 + i, "username": format!("u{i}"), "name": if i == 1 { "" } else { "Zed" } })).collect();
    let t = Fake::new(&[
      (200, assigned.clone()),
      (200, Value::Array(full)),
      (200, json!([{ "id": 7, "username": "bo", "name": "Bo Lee" }, { "id": 9, "username": "ann", "name": "Ann" }, { "id": 7, "username": "bo" }, { "username": "noid" }])),
    ]);
    let list = members(&t, "acme/app", 12).unwrap();
    assert_eq!(list.len(), 102);
    assert_eq!((list[0].id.as_str(), list[0].name.as_str(), list[0].current), ("9", "Ann (@ann)", false));
    assert!(list.iter().any(|c| c.id == "7" && c.name == "Bo Lee (@bo)" && c.current));
    assert!(list.iter().any(|c| c.name == "@u1"));
    let seen = t.requests();
    assert_eq!(seen[1].path, "/projects/acme%2Fapp/members/all?per_page=100&page=1");
    assert_eq!(seen[2].path, "/projects/acme%2Fapp/members/all?per_page=100&page=2");

    let t = Fake::new(&[(200, assigned.clone()), (200, issue(12)), (200, assigned), (200, issue(12))]);
    set_assignee(&t, "acme/app", 12, 9, true).unwrap();
    set_assignee(&t, "acme/app", 12, 7, false).unwrap();
    let seen = t.requests();
    assert_eq!((seen[1].method, seen[1].body.clone()), (Method::Put, Some(json!({ "assignee_ids": [7, 9] }))));
    assert_eq!(seen[3].body, Some(json!({ "assignee_ids": [0] })), "removing the last assignee leaves nobody");
    assert!(set_assignee(&t, "acme/app", 12, 0, true).is_err());
    assert_eq!(t.requests().len(), 4);
  }

  #[test]
  fn edits_labels_as_comma_lists() {
    let t = Fake::new(&[(200, issue(12))]);
    edit_labels(&t, "acme/app", 12, &["bug".into(), "ux".into()], &["old".into()]).unwrap();
    assert_eq!(t.requests()[0].body, Some(json!({ "add_labels": "bug,ux", "remove_labels": "old" })));
    assert!(edit_labels(&t, "acme/app", 12, &["a,b".into()], &[]).is_err());
  }
}
