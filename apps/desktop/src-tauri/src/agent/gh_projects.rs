//! GitHub Projects (v2) items as agent tasks (old Kingu's project view, reduced to what a task
//! needs): the project named by `kingu.github.project` (`acme/3`, `@me/3`) is read through
//! `gh api graphql` (the same gh login as GitHub issues; it needs the `read:project` scope), and
//! its open issue items become rows with the project's Status. Pull requests and draft items are
//! left out: a task needs an issue it can link and close. One item is read, commented on and
//! opened by its URL with `gh issue …`, whatever repository it is in. Parsing is pure.

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::issues::{self, truncate, IssueDetail, IssueLabel, MAX_BODY, MAX_LIMIT};
use crate::i18n::msg::TrackerMsg;
use crate::tr;

/// Item pages read per list (100 items each); a bigger project shows its first 500 items.
const MAX_PAGES: usize = 5;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectRef {
  /// An organisation or user login, or `@me` for the gh user's own projects.
  pub owner: String,
  pub number: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ProjectSummary {
  /// `acme/3`: what `kingu.github.project` takes.
  pub id: String,
  pub owner: String,
  pub number: u64,
  pub title: String,
  pub url: String,
  pub closed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ProjectItem {
  pub item_id: String,
  /// `acme/app`.
  pub repo: String,
  pub number: u64,
  pub title: String,
  pub url: String,
  pub state: String,
  pub labels: Vec<IssueLabel>,
  pub assignees: Vec<String>,
  pub updated_at: String,
  pub author: String,
  pub body: String,
  pub body_truncated: bool,
  /// The project's Status field (`Todo`, `In Progress`); empty when unset.
  pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ProjectItems {
  pub title: String,
  pub url: String,
  pub items: Vec<ProjectItem>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ItemQuery {
  pub mine: bool,
  pub label: Option<String>,
  pub search: Option<String>,
  pub limit: u32,
}

impl ProjectRef {
  /// `acme/3`, `@me/3`, or a project URL (`https://github.com/orgs/acme/projects/3`).
  pub fn parse(s: &str) -> Result<Self, String> {
    let s = s.trim().trim_end_matches('/');
    let bad = || tr!(TrackerMsg::GhProjectBadRef, project = s);
    let (owner, number) = if let Some(rest) = s.strip_prefix("https://github.com/") {
      let parts: Vec<&str> = rest.split('/').collect();
      match parts.as_slice() {
        ["orgs" | "users", owner, "projects", n, ..] => (*owner, *n),
        _ => return Err(bad()),
      }
    } else {
      s.rsplit_once('/').ok_or_else(bad)?
    };
    let number: u64 = number.parse().ok().filter(|n| *n > 0).ok_or_else(bad)?;
    if !issues::valid_login(owner) {
      return Err(bad());
    }
    Ok(Self { owner: owner.to_owned(), number })
  }
}

/// `acme/app#42`: the key a task keeps for an issue reached through a project.
pub fn valid_issue_key(key: &str) -> bool {
  key.rsplit_once('#').is_some_and(|(repo, n)| {
    repo.split_once('/').is_some_and(|(o, r)| issues::valid_login(o) && o != "@me" && !r.is_empty() && r.len() <= 100 && r.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.')))
      && !n.is_empty()
      && n.len() <= 12
      && !n.starts_with('0')
      && n.bytes().all(|b| b.is_ascii_digit())
  })
}

/// An issue URL on github.com (or a GitHub Enterprise host): `https://<host>/<owner>/<repo>/issues/<n>`.
pub fn valid_issue_url(url: &str) -> bool {
  url::Url::parse(url).is_ok_and(|u| {
    let segs: Vec<&str> = u.path_segments().map(Iterator::collect).unwrap_or_default();
    u.scheme() == "https" && u.host_str().is_some() && u.query().is_none() && u.fragment().is_none() && segs.len() == 4 && segs[2] == "issues" && segs[3].parse::<u64>().is_ok_and(|n| n > 0)
  })
}

const ITEM_FIELDS: &str = "pageInfo { hasNextPage endCursor }
  nodes { id updatedAt fieldValueByName(name: \"Status\") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
    content { __typename ... on Issue { number title url state updatedAt body repository { nameWithOwner } author { login }
      assignees(first: 10) { nodes { login } } labels(first: 20) { nodes { name color } } } } }";

/// The GraphQL query reading one page of `p`'s items.
pub fn items_query(p: &ProjectRef) -> String {
  let project = format!("projectV2(number: $number) {{ title url items(first: 100, after: $after) {{ {ITEM_FIELDS} }} }}");
  if p.owner == "@me" {
    format!("query($number: Int!, $after: String) {{ viewer {{ login {project} }} }}")
  } else {
    format!("query($owner: String!, $number: Int!, $after: String) {{ viewer {{ login }} repositoryOwner(login: $owner) {{ ... on ProjectV2Owner {{ {project} }} }} }}")
  }
}

/// `gh api graphql` arguments (values as `-f`/`-F key=value`, never as options).
pub fn graphql_args(query: &str, vars: &[(&str, String)], typed: &[(&str, String)]) -> Vec<String> {
  let mut args = vec!["api".to_owned(), "graphql".to_owned(), "-f".to_owned(), format!("query={query}")];
  for (k, v) in vars {
    args.extend(["-f".to_owned(), format!("{k}={v}")]);
  }
  for (k, v) in typed {
    args.extend(["-F".to_owned(), format!("{k}={v}")]);
  }
  args
}

fn text(v: &Value, k: &str) -> String {
  v[k].as_str().unwrap_or_default().to_owned()
}

/// One page of a project's items.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Page {
  pub title: String,
  pub url: String,
  /// The gh user's login.
  pub viewer: String,
  /// Its issue items (pull requests and drafts left out).
  pub items: Vec<ProjectItem>,
  /// The cursor of the next page, if any.
  pub next: Option<String>,
}

pub fn parse_page(out: &str) -> Result<Page, String> {
  let v: Value = serde_json::from_str(out).map_err(|e| tr!(TrackerMsg::GhProjectUnreadable, detail = e))?;
  if let Some(err) = v["errors"].as_array().and_then(|a| a.first()) {
    return Err(graphql_error(err));
  }
  let data = &v["data"];
  let project = [&data["repositoryOwner"]["projectV2"], &data["viewer"]["projectV2"]].into_iter().find(|p| p.is_object()).ok_or_else(|| tr!(TrackerMsg::GhProjectNotFound))?;
  let conn = &project["items"];
  let items = conn["nodes"]
    .as_array()
    .map(Vec::as_slice)
    .unwrap_or_default()
    .iter()
    .filter(|n| n["content"]["__typename"] == "Issue")
    .filter_map(|n| {
      let c = &n["content"];
      let number = c["number"].as_u64()?;
      let (body, body_truncated) = truncate(c["body"].as_str().unwrap_or_default(), MAX_BODY);
      Some(ProjectItem {
        item_id: text(n, "id"),
        repo: text(&c["repository"], "nameWithOwner"),
        number,
        title: text(c, "title"),
        url: text(c, "url"),
        state: text(c, "state"),
        labels: c["labels"]["nodes"].as_array().map(|a| a.iter().map(|l| IssueLabel { name: text(l, "name"), color: text(l, "color") }).filter(|l| !l.name.is_empty()).collect()).unwrap_or_default(),
        assignees: c["assignees"]["nodes"].as_array().map(|a| a.iter().map(|u| text(u, "login")).filter(|l| !l.is_empty()).collect()).unwrap_or_default(),
        updated_at: [text(c, "updatedAt"), text(n, "updatedAt")].into_iter().max().unwrap_or_default(),
        author: text(&c["author"], "login"),
        body,
        body_truncated,
        status: text(&n["fieldValueByName"], "name"),
      })
    })
    .collect();
  let next = (conn["pageInfo"]["hasNextPage"].as_bool() == Some(true)).then(|| text(&conn["pageInfo"], "endCursor")).filter(|c| !c.is_empty());
  Ok(Page { title: text(project, "title"), url: text(project, "url"), viewer: text(&data["viewer"], "login"), items, next })
}

fn graphql_error(err: &Value) -> String {
  let kind = err["type"].as_str().unwrap_or_default();
  let message = err["message"].as_str().unwrap_or_default();
  if kind == "INSUFFICIENT_SCOPES" || message.contains("read:project") {
    tr!(TrackerMsg::GhProjectScope)
  } else if kind == "NOT_FOUND" {
    tr!(TrackerMsg::GhProjectNotFound)
  } else {
    format!("GitHub: {message}")
  }
}

/// gh's own error, with the missing `read:project` scope explained.
fn gh_failure(e: String) -> String {
  if e.contains("read:project") || e.contains("INSUFFICIENT_SCOPES") || e.contains("required scopes") { tr!(TrackerMsg::GhProjectScope) } else { e }
}

fn done(status: &str) -> bool {
  matches!(status.to_ascii_lowercase().as_str(), "done" | "closed" | "complete" | "completed")
}

/// Open issues not in a Done column, filtered and newest first.
pub fn select(items: Vec<ProjectItem>, viewer: &str, q: &ItemQuery) -> Vec<ProjectItem> {
  let search = q.search.as_deref().map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty());
  let label = q.label.as_deref().map(str::trim).filter(|l| !l.is_empty());
  let mut out: Vec<ProjectItem> = items
    .into_iter()
    .filter(|i| i.state == "OPEN" && !done(&i.status))
    .filter(|i| !q.mine || i.assignees.iter().any(|a| a.eq_ignore_ascii_case(viewer)))
    .filter(|i| label.is_none_or(|l| i.labels.iter().any(|x| x.name.eq_ignore_ascii_case(l))))
    .filter(|i| search.as_deref().is_none_or(|s| i.title.to_lowercase().contains(s) || format!("{}#{}", i.repo, i.number).to_lowercase().contains(s) || s.trim_start_matches('#') == i.number.to_string()))
    .collect();
  out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
  out.truncate(q.limit.clamp(1, MAX_LIMIT) as usize);
  out
}

pub fn parse_projects(out: &str) -> Result<Vec<ProjectSummary>, String> {
  let v: Value = serde_json::from_str(out).map_err(|e| tr!(TrackerMsg::GhProjectUnreadable, detail = e))?;
  if let Some(err) = v["errors"].as_array().and_then(|a| a.first()) {
    return Err(graphql_error(err));
  }
  let viewer = &v["data"]["viewer"];
  let mut owners = vec![(text(viewer, "login"), &viewer["projectsV2"])];
  for org in viewer["organizations"]["nodes"].as_array().map(Vec::as_slice).unwrap_or_default() {
    owners.push((text(org, "login"), &org["projectsV2"]));
  }
  Ok(owners
    .into_iter()
    .flat_map(|(owner, conn)| {
      conn["nodes"].as_array().cloned().unwrap_or_default().into_iter().filter_map(move |p| {
        let number = p["number"].as_u64()?;
        Some(ProjectSummary { id: format!("{owner}/{number}"), owner: owner.clone(), number, title: text(&p, "title"), url: text(&p, "url"), closed: p["closed"].as_bool() == Some(true) })
      })
    })
    .filter(|p| !p.closed && !p.owner.is_empty())
    .collect())
}

const PROJECTS_QUERY: &str = "query { viewer { login projectsV2(first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { number title url closed } }
  organizations(first: 30) { nodes { login projectsV2(first: 30, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { number title url closed } } } } } }";

pub fn projects(gh: &Path, dir: &Path) -> Result<Vec<ProjectSummary>, String> {
  let out = issues::run_gh(gh, dir, "gh api graphql", &graphql_args(PROJECTS_QUERY, &[], &[])).map_err(gh_failure)?;
  parse_projects(&out)
}

pub fn items(gh: &Path, dir: &Path, p: &ProjectRef, q: &ItemQuery) -> Result<ProjectItems, String> {
  let query = items_query(p);
  let (mut all, mut after, mut head) = (Vec::new(), None::<String>, None);
  for _ in 0..MAX_PAGES {
    let mut vars = Vec::new();
    if p.owner != "@me" {
      vars.push(("owner", p.owner.clone()));
    }
    if let Some(a) = &after {
      vars.push(("after", a.clone()));
    }
    let out = issues::run_gh(gh, dir, "gh api graphql", &graphql_args(&query, &vars, &[("number", p.number.to_string())])).map_err(gh_failure)?;
    let page = parse_page(&out)?;
    head.get_or_insert((page.title, page.url, page.viewer));
    all.extend(page.items);
    match page.next {
      Some(c) => after = Some(c),
      None => break,
    }
  }
  let (title, url, viewer) = head.unwrap_or_default();
  Ok(ProjectItems { items: select(all, &viewer, q), title, url })
}

fn url_or_err(url: &str) -> Result<(), String> {
  if valid_issue_url(url) { Ok(()) } else { Err(tr!(TrackerMsg::GhProjectBadUrl, url)) }
}

// ---------------------------------------------------------------------------------------------
// Commands: gh runs in the open folder, or the home folder when none is open.

fn gh_dir(ws: &crate::workspace::Workspace) -> PathBuf {
  ws.root().ok().or_else(|| std::env::var_os("HOME").map(PathBuf::from)).unwrap_or_else(|| PathBuf::from("/"))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// The open projects of the gh user and their organisations, for picking `kingu.github.project`.
#[tauri::command]
pub async fn gh_projects_list(ws: tauri::State<'_, crate::workspace::Workspace>) -> Result<Vec<ProjectSummary>, String> {
  let dir = gh_dir(&ws);
  let gh = super::review::gh_bin().ok_or_else(issues::gh_missing)?;
  blocking(move || projects(&gh, &dir)).await
}

/// The open issue items of `project` (`acme/3`).
#[tauri::command]
pub async fn gh_project_items(
  ws: tauri::State<'_, crate::workspace::Workspace>,
  project: String,
  mine: Option<bool>,
  label: Option<String>,
  search: Option<String>,
  limit: Option<u32>,
) -> Result<ProjectItems, String> {
  let p = ProjectRef::parse(&project)?;
  let dir = gh_dir(&ws);
  let gh = super::review::gh_bin().ok_or_else(issues::gh_missing)?;
  let q = ItemQuery { mine: mine.unwrap_or(false), label, search, limit: limit.unwrap_or(50) };
  blocking(move || items(&gh, &dir, &p, &q)).await
}

/// An item's issue with its latest comments, by URL (any repository).
#[tauri::command]
pub async fn gh_project_issue_view(ws: tauri::State<'_, crate::workspace::Workspace>, url: String) -> Result<IssueDetail, String> {
  url_or_err(&url)?;
  let dir = gh_dir(&ws);
  let gh = super::review::gh_bin().ok_or_else(issues::gh_missing)?;
  blocking(move || issues::parse_issue_view(&issues::run_gh(&gh, &dir, "gh issue view", &["issue".into(), "view".into(), url, format!("--json={}", issues::VIEW_FIELDS)])?)).await
}

#[tauri::command]
pub async fn gh_project_issue_comment(ws: tauri::State<'_, crate::workspace::Workspace>, url: String, body: String) -> Result<(), String> {
  url_or_err(&url)?;
  if body.trim().is_empty() || body.len() > 16 * 1024 {
    return Err(tr!(TrackerMsg::CommentLength, max = 16 * 1024));
  }
  let dir = gh_dir(&ws);
  let gh = super::review::gh_bin().ok_or_else(issues::gh_missing)?;
  blocking(move || issues::run_gh(&gh, &dir, "gh issue comment", &["issue".into(), "comment".into(), url, format!("--body={body}")]).map(|_| ())).await
}

#[tauri::command]
pub async fn gh_project_issue_open(ws: tauri::State<'_, crate::workspace::Workspace>, url: String) -> Result<(), String> {
  url_or_err(&url)?;
  let dir = gh_dir(&ws);
  let gh = super::review::gh_bin().ok_or_else(issues::gh_missing)?;
  blocking(move || issues::run_gh(&gh, &dir, "gh issue view --web", &["issue".into(), "view".into(), url, "--web".into()]).map(|_| ())).await
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn node(n: u64, state: &str, status: Option<&str>, assignee: &str, updated: &str) -> Value {
    json!({
      "id": format!("PVTI_{n}"), "updatedAt": "2026-01-01T00:00:00Z",
      "fieldValueByName": status.map(|s| json!({ "name": s })),
      "content": { "__typename": "Issue", "number": n, "title": format!("Fix login {n}"), "url": format!("https://github.com/acme/app/issues/{n}"),
        "state": state, "updatedAt": updated, "body": "Steps", "repository": { "nameWithOwner": "acme/app" }, "author": { "login": "hubot" },
        "assignees": { "nodes": [{ "login": assignee }] }, "labels": { "nodes": [{ "name": "bug", "color": "d73a4a" }] } }
    })
  }

  fn page(nodes: Vec<Value>, next: Option<&str>) -> String {
    json!({ "data": { "viewer": { "login": "kawin" }, "repositoryOwner": { "projectV2": { "title": "Roadmap", "url": "https://github.com/orgs/acme/projects/3",
      "items": { "pageInfo": { "hasNextPage": next.is_some(), "endCursor": next }, "nodes": nodes } } } } })
    .to_string()
  }

  #[test]
  fn parses_pages_keeping_issue_items() {
    let pr = json!({ "id": "PVTI_pr", "content": { "__typename": "PullRequest", "number": 9 } });
    let draft = json!({ "id": "PVTI_d", "content": { "__typename": "DraftIssue", "title": "idea" } });
    let p = parse_page(&page(vec![node(1, "OPEN", Some("Todo"), "kawin", "2026-10-01T00:00:00Z"), pr, draft], Some("Y3Vy"))).unwrap();
    assert_eq!((p.title.as_str(), p.url.as_str(), p.viewer.as_str(), p.next.as_deref()), ("Roadmap", "https://github.com/orgs/acme/projects/3", "kawin", Some("Y3Vy")));
    assert_eq!(p.items.len(), 1);
    let i = &p.items[0];
    assert_eq!((i.repo.as_str(), i.number, i.status.as_str(), i.updated_at.as_str()), ("acme/app", 1, "Todo", "2026-10-01T00:00:00Z"));
    let none = json!({ "data": { "viewer": { "login": "k" }, "repositoryOwner": null } }).to_string();
    assert_eq!(parse_page(&none).unwrap_err(), tr!(TrackerMsg::GhProjectNotFound));
    let scope = json!({ "errors": [{ "type": "INSUFFICIENT_SCOPES", "message": "needs read:project" }] }).to_string();
    assert_eq!(parse_page(&scope).unwrap_err(), tr!(TrackerMsg::GhProjectScope));
  }

  #[test]
  fn selects_open_unfinished_items() {
    let items = parse_page(&page(
      vec![
        node(1, "OPEN", Some("Todo"), "kawin", "2026-10-01T00:00:00Z"),
        node(2, "OPEN", Some("Done"), "kawin", "2026-10-02T00:00:00Z"),
        node(3, "CLOSED", None, "kawin", "2026-10-03T00:00:00Z"),
        node(4, "OPEN", None, "other", "2026-10-04T00:00:00Z"),
      ],
      None,
    ))
    .unwrap()
    .items;
    let all = select(items.clone(), "kawin", &ItemQuery { limit: 50, ..Default::default() });
    assert_eq!(all.iter().map(|i| i.number).collect::<Vec<_>>(), [4, 1]);
    let mine = select(items.clone(), "KAWIN", &ItemQuery { mine: true, limit: 50, ..Default::default() });
    assert_eq!(mine.iter().map(|i| i.number).collect::<Vec<_>>(), [1]);
    let found = select(items.clone(), "kawin", &ItemQuery { search: Some("#4".into()), label: Some("BUG".into()), limit: 50, ..Default::default() });
    assert_eq!(found.iter().map(|i| i.number).collect::<Vec<_>>(), [4]);
    assert_eq!(select(items, "kawin", &ItemQuery { limit: 1, ..Default::default() }).len(), 1);
  }

  #[test]
  fn builds_queries_and_args() {
    let org = ProjectRef::parse("acme/3").unwrap();
    assert!(items_query(&org).contains("repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectV2(number: $number)"));
    let me = ProjectRef::parse("@me/1").unwrap();
    assert!(items_query(&me).starts_with("query($number: Int!, $after: String) { viewer { login projectV2("));
    let args = graphql_args("query { x }", &[("owner", "acme".into())], &[("number", "3".into())]);
    assert_eq!(args, ["api", "graphql", "-f", "query=query { x }", "-f", "owner=acme", "-F", "number=3"]);
  }

  #[test]
  fn parses_project_refs_keys_and_urls() {
    assert_eq!(ProjectRef::parse(" https://github.com/orgs/acme/projects/3/views/1 ").unwrap(), ProjectRef { owner: "acme".into(), number: 3 });
    assert_eq!(ProjectRef::parse("https://github.com/users/kawin/projects/2").unwrap().owner, "kawin");
    assert!(ProjectRef::parse("acme").is_err() && ProjectRef::parse("acme/0").is_err() && ProjectRef::parse("-x/1").is_err() && ProjectRef::parse("a b/1").is_err());
    assert!(valid_issue_key("acme/app.js#42") && !valid_issue_key("acme#42") && !valid_issue_key("@me/x#1") && !valid_issue_key("acme/app#04"));
    assert!(valid_issue_url("https://github.com/acme/app/issues/42") && valid_issue_url("https://ghe.acme.dev/acme/app/issues/1"));
    assert!(!valid_issue_url("https://github.com/acme/app/pull/42") && !valid_issue_url("http://github.com/acme/app/issues/1") && !valid_issue_url("https://github.com/acme/app/issues/1?x=1"));
  }

  #[test]
  fn lists_the_viewers_and_organisations_projects() {
    let out = json!({ "data": { "viewer": { "login": "kawin", "projectsV2": { "nodes": [{ "number": 1, "title": "Mine", "url": "u1", "closed": false }, { "number": 2, "title": "Old", "url": "u2", "closed": true }] },
      "organizations": { "nodes": [{ "login": "acme", "projectsV2": { "nodes": [{ "number": 3, "title": "Roadmap", "url": "u3", "closed": false }] } }] } } } })
    .to_string();
    let list = parse_projects(&out).unwrap();
    assert_eq!(list.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["kawin/1", "acme/3"]);
  }
}
