//! Linear issues as agent tasks (Orca's Linear tasks): a personal API key kept only in the OS
//! keychain, and Linear's GraphQL API over HTTPS for the viewer, issue lists, one issue with its
//! latest comments, and posting a comment. The key never reaches the webview, logs or error
//! messages. Response parsing is pure (`parse_*`) and failures become Thai messages saying what
//! to fix. Issue text is cut to the same bounds as GitHub issues (`agent::issues`).

use std::time::Duration;

use serde_json::{json, Value};

use crate::agent::issues::{truncate, IssueComment, IssueLabel, MAX_BODY, MAX_COMMENT, MAX_COMMENTS, MAX_LIMIT};

pub const ENDPOINT: &str = "https://api.linear.app/graphql";
pub const KEYCHAIN_SERVICE: &str = "dev.kingu.linear";
const KEYCHAIN_ACCOUNT: &str = "api-key";
const MAX_KEY: usize = 256;
const MAX_COMMENT_POST: usize = 16 * 1024;
/// Comments fetched per issue; the latest `MAX_COMMENTS` are kept.
const COMMENTS_FETCHED: usize = 100;
pub const NOT_CONNECTED: &str = "ยังไม่ได้เชื่อมต่อ Linear: รันคำสั่ง Linear: Connect แล้ววาง personal API key";
const AUTH_FAILED: &str = "Linear ไม่รับ API key นี้ (ถูกเพิกถอนหรือไม่ถูกต้อง): เชื่อมต่อใหม่ด้วย Linear: Connect";

const ISSUE_FIELDS: &str = "id identifier number title url branchName description priority priorityLabel updatedAt
  state { name type color } team { key } assignee { displayName } labels(first: 50) { nodes { name color } }";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Viewer {
  pub name: String,
  pub email: String,
  pub organization: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct LinearIssue {
  /// Linear's UUID.
  pub id: String,
  /// `ENG-123`.
  pub identifier: String,
  pub number: u64,
  pub title: String,
  pub url: String,
  /// The workflow state's name (`In Progress`) and type (`backlog`, `unstarted`, `started`, `completed`, `canceled`, `triage`).
  pub state: String,
  pub state_type: String,
  pub state_color: String,
  /// 0 none, 1 urgent … 4 low.
  pub priority: u8,
  pub priority_label: String,
  pub team: String,
  pub assignee: Option<String>,
  /// Colours without `#`, like GitHub's.
  pub labels: Vec<IssueLabel>,
  /// ISO 8601.
  pub updated_at: String,
  /// Linear's suggested git branch (`kawin/eng-123-fix-login`); Linear links a PR whose branch contains the identifier.
  pub branch_name: String,
  /// Markdown, cut at `MAX_BODY` bytes.
  pub description: String,
  pub description_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct LinearIssueDetail {
  #[serde(flatten)]
  pub issue: LinearIssue,
  pub comments: Vec<IssueComment>,
  pub comments_omitted: usize,
}

/// Which issues to list. `assigned` and `created` are the viewer's; `open` is everyone's.
/// All three leave out completed and canceled issues.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IssueQuery {
  pub filter: String,
  /// A team key (`ENG`) to narrow to, or none for every team.
  pub team: Option<String>,
  pub search: Option<String>,
  pub limit: u32,
}

/// POSTs one GraphQL request with the API key; the HTTP status and body.
pub trait Transport: Send + Sync {
  fn post(&self, key: &str, body: &Value) -> Result<(u16, String), String>;
}

pub struct Http {
  client: reqwest::blocking::Client,
  endpoint: String,
}

impl Http {
  pub fn new() -> Result<Self, String> {
    Self::with_endpoint(ENDPOINT)
  }

  pub fn with_endpoint(endpoint: &str) -> Result<Self, String> {
    let client = crate::net_proxy::client_builder()?
      .timeout(Duration::from_secs(20))
      .connect_timeout(Duration::from_secs(5))
      // A redirect could carry the key to another host.
      .redirect(reqwest::redirect::Policy::none())
      .user_agent(concat!("kingu-desktop/", env!("CARGO_PKG_VERSION")))
      .build()
      .map_err(|e| e.to_string())?;
    Ok(Self { client, endpoint: endpoint.to_owned() })
  }
}

impl Transport for Http {
  fn post(&self, key: &str, body: &Value) -> Result<(u16, String), String> {
    // Personal API keys go as the bare Authorization value; OAuth tokens would need `Bearer`.
    let res = self.client.post(&self.endpoint).header("Authorization", key).json(body).send().map_err(|e| {
      let e = e.without_url();
      if e.is_timeout() { "Linear ไม่ตอบภายในเวลาที่กำหนด".to_owned() } else { format!("เชื่อมต่อ Linear ไม่ได้ ตรวจสอบอินเทอร์เน็ต ({e})") }
    })?;
    let status = res.status().as_u16();
    Ok((status, res.text().unwrap_or_default()))
  }
}

pub fn valid_key(key: &str) -> bool {
  !key.is_empty() && key.len() <= MAX_KEY && key.bytes().all(|b| b.is_ascii_graphic())
}

/// `ENG-123`: a team key, a dash and the issue number.
pub fn valid_identifier(id: &str) -> bool {
  id.len() <= 32
    && id.split_once('-').is_some_and(|(team, n)| {
      !team.is_empty() && team.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') && !n.is_empty() && n.len() <= 12 && n.bytes().all(|b| b.is_ascii_digit())
    })
}

fn valid_uuid(id: &str) -> bool {
  id.len() == 36 && id.bytes().enumerate().all(|(i, b)| if matches!(i, 8 | 13 | 18 | 23) { b == b'-' } else { b.is_ascii_hexdigit() })
}

fn valid_team(key: &str) -> bool {
  !key.is_empty() && key.len() <= 16 && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// The `data` of a GraphQL response, or a message the user can act on.
pub fn response_data(status: u16, body: &str) -> Result<Value, String> {
  if matches!(status, 401 | 403) {
    return Err(AUTH_FAILED.into());
  }
  if status == 429 {
    return Err("Linear จำกัดจำนวนคำขอชั่วคราว ลองใหม่ในอีกสักครู่".into());
  }
  if status >= 500 {
    return Err(format!("Linear ขัดข้อง (HTTP {status}) ลองใหม่ภายหลัง"));
  }
  let v: Value = serde_json::from_str(body).map_err(|_| format!("Linear: อ่านผลไม่ได้ (HTTP {status})"))?;
  if let Some(err) = v["errors"].as_array().and_then(|a| a.first()) {
    let code = err["extensions"]["code"].as_str().unwrap_or_default().to_ascii_uppercase();
    let message = err["message"].as_str().unwrap_or("ล้มเหลว");
    return Err(match code.as_str() {
      "AUTHENTICATION_ERROR" | "FORBIDDEN" => AUTH_FAILED.into(),
      "RATELIMITED" => "Linear จำกัดจำนวนคำขอชั่วคราว ลองใหม่ในอีกสักครู่".into(),
      _ if message.to_lowercase().contains("entity not found") => "ไม่พบ issue นี้ใน Linear (หรือไม่มีสิทธิ์เข้าถึง)".into(),
      _ => format!("Linear: {message}"),
    });
  }
  if !(200..300).contains(&status) {
    return Err(format!("Linear: HTTP {status}"));
  }
  match v.get("data") {
    Some(d) if !d.is_null() => Ok(d.clone()),
    _ => Err("Linear: ผลไม่มีข้อมูล".into()),
  }
}

fn request(t: &dyn Transport, key: &str, query: &str, variables: Value) -> Result<Value, String> {
  let (status, body) = t.post(key, &json!({ "query": query, "variables": variables }))?;
  response_data(status, &body)
}

fn text(v: &Value, k: &str) -> String {
  v[k].as_str().unwrap_or_default().to_owned()
}

pub fn parse_viewer(data: &Value) -> Result<Viewer, String> {
  let v = &data["viewer"];
  if v.is_null() {
    return Err("Linear: ไม่พบข้อมูลผู้ใช้".into());
  }
  let name = [text(v, "displayName"), text(v, "name")].into_iter().find(|n| !n.is_empty()).unwrap_or_default();
  Ok(Viewer { name, email: text(v, "email"), organization: text(&data["organization"], "name") })
}

pub fn parse_issue(v: &Value) -> Result<LinearIssue, String> {
  let identifier = text(v, "identifier");
  let id = text(v, "id");
  if id.is_empty() || !valid_identifier(&identifier) {
    return Err("Linear: issue ไม่มี identifier".into());
  }
  let number = v["number"].as_u64().or_else(|| identifier.rsplit('-').next()?.parse().ok()).unwrap_or(0);
  let labels = v["labels"]["nodes"]
    .as_array()
    .map(|a| {
      a.iter()
        .map(|l| IssueLabel { name: text(l, "name"), color: text(l, "color").trim_start_matches('#').to_owned() })
        .filter(|l| !l.name.is_empty())
        .collect()
    })
    .unwrap_or_default();
  let (description, description_truncated) = truncate(v["description"].as_str().unwrap_or_default(), MAX_BODY);
  Ok(LinearIssue {
    id,
    identifier,
    number,
    title: text(v, "title"),
    url: text(v, "url"),
    state: text(&v["state"], "name"),
    state_type: text(&v["state"], "type"),
    state_color: text(&v["state"], "color").trim_start_matches('#').to_owned(),
    priority: v["priority"].as_u64().map_or(0, |p| p.min(4) as u8),
    priority_label: text(v, "priorityLabel"),
    team: text(&v["team"], "key"),
    assignee: v["assignee"]["displayName"].as_str().filter(|s| !s.is_empty()).map(str::to_owned),
    labels,
    updated_at: text(v, "updatedAt"),
    branch_name: text(v, "branchName"),
    description,
    description_truncated,
  })
}

fn done(i: &LinearIssue) -> bool {
  matches!(i.state_type.as_str(), "completed" | "canceled")
}

fn nodes(conn: &Value) -> Result<Vec<LinearIssue>, String> {
  conn["nodes"].as_array().ok_or("Linear: ผลไม่ใช่รายการ issue")?.iter().map(parse_issue).collect()
}

/// The list query and its variables for `q`.
pub fn list_request(q: &IssueQuery) -> Result<(String, Value), String> {
  let first = q.limit.clamp(1, MAX_LIMIT);
  let team = q.team.as_deref().map(str::trim).filter(|t| !t.is_empty());
  if let Some(t) = team.filter(|t| !valid_team(t)) {
    return Err(format!("team key ของ Linear ไม่ถูกต้อง: {t}"));
  }
  if let Some(term) = q.search.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
    // searchIssues takes no state filter of its own: finished issues are dropped after parsing.
    let mut filter = json!({});
    if let Some(t) = team {
      filter["team"] = json!({ "key": { "eq": t } });
    }
    let query = format!("query KinguLinearSearch($term: String!, $first: Int, $filter: IssueFilter) {{ searchIssues(term: $term, first: $first, filter: $filter) {{ nodes {{ {ISSUE_FIELDS} }} }} }}");
    return Ok((query, json!({ "term": term, "first": first, "filter": filter })));
  }
  let mut filter = json!({ "state": { "type": { "nin": ["completed", "canceled"] } } });
  if let Some(t) = team {
    filter["team"] = json!({ "key": { "eq": t } });
  }
  let vars = json!({ "first": first, "filter": filter, "orderBy": "updatedAt" });
  let head = "($first: Int, $filter: IssueFilter, $orderBy: PaginationOrderBy)";
  let args = "(first: $first, filter: $filter, orderBy: $orderBy)";
  let query = match q.filter.as_str() {
    "assigned" => format!("query KinguLinearAssigned{head} {{ viewer {{ assignedIssues{args} {{ nodes {{ {ISSUE_FIELDS} }} }} }} }}"),
    "created" => format!("query KinguLinearCreated{head} {{ viewer {{ createdIssues{args} {{ nodes {{ {ISSUE_FIELDS} }} }} }} }}"),
    "open" => format!("query KinguLinearIssues{head} {{ issues{args} {{ nodes {{ {ISSUE_FIELDS} }} }} }}"),
    f => return Err(format!("ตัวกรอง issue ของ Linear ไม่ถูกต้อง: {f}")),
  };
  Ok((query, vars))
}

/// The issues out of a list response's `data`, finished ones left out.
pub fn parse_list(data: &Value) -> Result<Vec<LinearIssue>, String> {
  let conn = [&data["searchIssues"], &data["viewer"]["assignedIssues"], &data["viewer"]["createdIssues"], &data["issues"]]
    .into_iter()
    .find(|c| !c.is_null())
    .ok_or("Linear: ผลไม่มีรายการ issue")?;
  Ok(nodes(conn)?.into_iter().filter(|i| !done(i)).collect())
}

/// One issue with its latest `MAX_COMMENTS` comments, oldest first.
pub fn parse_view(data: &Value) -> Result<LinearIssueDetail, String> {
  let v = &data["issue"];
  if v.is_null() {
    return Err("ไม่พบ issue นี้ใน Linear (หรือไม่มีสิทธิ์เข้าถึง)".into());
  }
  let issue = parse_issue(v)?;
  let mut all: Vec<IssueComment> = v["comments"]["nodes"]
    .as_array()
    .map(Vec::as_slice)
    .unwrap_or_default()
    .iter()
    .map(|c| {
      let user = &c["user"];
      let author = [text(user, "displayName"), text(user, "name")].into_iter().find(|n| !n.is_empty()).unwrap_or_else(|| "Linear".into());
      IssueComment { author, body: truncate(c["body"].as_str().unwrap_or_default(), MAX_COMMENT).0, created_at: text(c, "createdAt") }
    })
    .collect();
  // ISO 8601 UTC strings sort by time.
  all.sort_by(|a, b| a.created_at.cmp(&b.created_at));
  let skip = all.len().saturating_sub(MAX_COMMENTS);
  Ok(LinearIssueDetail { issue, comments: all.split_off(skip), comments_omitted: skip })
}

fn issue_ref(id: &str) -> Result<(), String> {
  if valid_identifier(id) || valid_uuid(id) { Ok(()) } else { Err(format!("รหัส issue ของ Linear ไม่ถูกต้อง: {id}")) }
}

pub fn viewer(t: &dyn Transport, key: &str) -> Result<Viewer, String> {
  parse_viewer(&request(t, key, "query KinguLinearViewer { viewer { name displayName email } organization { name } }", json!({}))?)
}

pub fn list(t: &dyn Transport, key: &str, q: &IssueQuery) -> Result<Vec<LinearIssue>, String> {
  let (query, vars) = list_request(q)?;
  parse_list(&request(t, key, &query, vars)?)
}

/// `id`: the identifier (`ENG-123`) or UUID.
pub fn view(t: &dyn Transport, key: &str, id: &str) -> Result<LinearIssueDetail, String> {
  issue_ref(id)?;
  let query = format!(
    "query KinguLinearIssue($id: String!, $comments: Int) {{ issue(id: $id) {{ {ISSUE_FIELDS} comments(first: $comments) {{ nodes {{ body createdAt user {{ name displayName }} }} }} }} }}"
  );
  parse_view(&request(t, key, &query, json!({ "id": id, "comments": COMMENTS_FETCHED }))?)
}

pub fn comment(t: &dyn Transport, key: &str, id: &str, body: &str) -> Result<(), String> {
  issue_ref(id)?;
  if body.trim().is_empty() || body.len() > MAX_COMMENT_POST {
    return Err(format!("ข้อความ comment ต้องยาว 1-{MAX_COMMENT_POST} bytes"));
  }
  // Tasks keep the identifier; commentCreate is given the issue's UUID.
  let uuid = if valid_uuid(id) {
    id.to_owned()
  } else {
    let data = request(t, key, "query KinguLinearIssueId($id: String!) { issue(id: $id) { id } }", json!({ "id": id }))?;
    data["issue"]["id"].as_str().filter(|u| valid_uuid(u)).ok_or("ไม่พบ issue นี้ใน Linear (หรือไม่มีสิทธิ์เข้าถึง)")?.to_owned()
  };
  let data = request(
    t,
    key,
    "mutation KinguLinearComment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }",
    json!({ "input": { "issueId": uuid, "body": body } }),
  )?;
  if data["commentCreate"]["success"].as_bool() == Some(true) { Ok(()) } else { Err("Linear ไม่ได้บันทึก comment".into()) }
}

/// Only a Linear page opens from a task's Linear link.
pub fn linear_url(url: &str) -> Result<url::Url, String> {
  let u = url::Url::parse(url).map_err(|e| e.to_string())?;
  if u.scheme() == "https" && u.host_str() == Some("linear.app") { Ok(u) } else { Err("เปิดได้เฉพาะลิงก์ https://linear.app".into()) }
}

// ---------------------------------------------------------------------------------------------
// Keychain and commands

fn entry() -> Result<keyring::Entry, String> {
  keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|e| e.to_string())
}

fn stored_key() -> Option<String> {
  entry().ok()?.get_password().ok()
}

fn key_or_err() -> Result<String, String> {
  stored_key().ok_or_else(|| NOT_CONNECTED.to_owned())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// The connected Linear user, or none without a stored key.
#[tauri::command]
pub async fn linear_status() -> Result<Option<Viewer>, String> {
  blocking(|| match stored_key() {
    None => Ok(None),
    Some(key) => viewer(&Http::new()?, &key).map(Some),
  })
  .await
}

/// Checks the key against Linear, then stores it in the keychain.
#[tauri::command]
pub async fn linear_connect(api_key: String) -> Result<Viewer, String> {
  let key = api_key.trim().to_owned();
  if !valid_key(&key) {
    return Err("API key ไม่ถูกต้อง: สร้างได้ที่ Linear > Settings > Security & access > Personal API keys".into());
  }
  blocking(move || {
    let v = viewer(&Http::new()?, &key)?;
    entry()?.set_password(&key).map_err(|e| format!("บันทึก API key ลง Keychain ไม่สำเร็จ: {e}"))?;
    log::info!("linear connected ({})", v.organization);
    Ok(v)
  })
  .await
}

#[tauri::command]
pub fn linear_disconnect() -> Result<(), String> {
  match entry()?.delete_credential() {
    Ok(()) | Err(keyring::Error::NoEntry) => {
      log::info!("linear disconnected");
      Ok(())
    }
    Err(e) => Err(format!("ลบ API key จาก Keychain ไม่สำเร็จ: {e}")),
  }
}

/// `filter`: `assigned` (default), `created` or `open`.
#[tauri::command]
pub async fn linear_issues_list(filter: Option<String>, team: Option<String>, search: Option<String>, limit: Option<u32>) -> Result<Vec<LinearIssue>, String> {
  let q = IssueQuery { filter: filter.unwrap_or_else(|| "assigned".into()), team, search, limit: limit.unwrap_or(50) };
  blocking(move || list(&Http::new()?, &key_or_err()?, &q)).await
}

#[tauri::command]
pub async fn linear_issue_view(id: String) -> Result<LinearIssueDetail, String> {
  blocking(move || view(&Http::new()?, &key_or_err()?, &id)).await
}

/// Comments on an issue (only when `kingu.issues.commentOnPr` is on; the webview decides).
#[tauri::command]
pub async fn linear_issue_comment(id: String, body: String) -> Result<(), String> {
  blocking(move || {
    comment(&Http::new()?, &key_or_err()?, &id, &body)?;
    log::info!("commented on linear issue {id}");
    Ok(())
  })
  .await
}

#[tauri::command]
pub fn linear_issue_open(url: String) -> Result<(), String> {
  crate::system::open_web_url(linear_url(&url)?.as_str())
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::{BufRead, BufReader, Read, Write};
  use std::net::TcpListener;
  use std::sync::Mutex;

  /// Answers each request with the next canned response and records the bodies.
  struct Fake {
    replies: Mutex<Vec<(u16, String)>>,
    seen: Mutex<Vec<(String, Value)>>,
  }

  impl Fake {
    fn new(replies: &[(u16, Value)]) -> Self {
      Self { replies: Mutex::new(replies.iter().rev().map(|(s, v)| (*s, v.to_string())).collect()), seen: Mutex::default() }
    }
  }

  impl Transport for Fake {
    fn post(&self, key: &str, body: &Value) -> Result<(u16, String), String> {
      self.seen.lock().unwrap().push((key.to_owned(), body.clone()));
      Ok(self.replies.lock().unwrap().pop().expect("unexpected request"))
    }
  }

  const UUID: &str = "0b7c5e0e-1111-4222-8333-944455556666";

  fn node(identifier: &str, state_type: &str) -> Value {
    json!({
      "id": UUID, "identifier": identifier, "number": 123, "title": "แก้ login บน Safari",
      "url": format!("https://linear.app/acme/issue/{identifier}/fix-login"), "branchName": "kawin/eng-123-fix-login",
      "description": "Steps…", "priority": 2, "priorityLabel": "High", "updatedAt": "2026-10-01T08:30:00.000Z",
      "state": { "name": "In Progress", "type": state_type, "color": "#f2c94c" }, "team": { "key": "ENG" },
      "assignee": { "displayName": "kawin" }, "labels": { "nodes": [{ "name": "bug", "color": "#eb5757" }, { "name": "", "color": "" }] }
    })
  }

  #[test]
  fn parses_issues_and_drops_finished_ones() {
    let data = json!({ "viewer": { "assignedIssues": { "nodes": [node("ENG-123", "started"), node("ENG-9", "completed"), node("ENG-8", "canceled")] } } });
    let list = parse_list(&data).unwrap();
    assert_eq!(list.len(), 1);
    let i = &list[0];
    assert_eq!((i.identifier.as_str(), i.number, i.team.as_str(), i.state.as_str()), ("ENG-123", 123, "ENG", "In Progress"));
    assert_eq!((i.priority, i.priority_label.as_str(), i.assignee.as_deref(), i.state_color.as_str()), (2, "High", Some("kawin"), "f2c94c"));
    assert_eq!(i.labels, [IssueLabel { name: "bug".into(), color: "eb5757".into() }]);
    let mut bare = node("OPS-7", "backlog");
    bare["number"] = Value::Null;
    bare["assignee"] = Value::Null;
    bare["description"] = Value::Null;
    let b = &parse_list(&json!({ "issues": { "nodes": [bare] } })).unwrap()[0];
    assert_eq!((b.number, b.assignee.as_ref(), b.description.as_str()), (7, None, ""));
    assert!(parse_list(&json!({})).is_err());
    assert!(parse_list(&json!({ "issues": { "nodes": [{ "id": "x", "identifier": "nope" }] } })).is_err());
  }

  #[test]
  fn keeps_the_latest_comments_oldest_first() {
    let mut issue = node("ENG-1", "started");
    let comments: Vec<_> = (0..MAX_COMMENTS + 2)
      .rev()
      .map(|i| json!({ "body": format!("c{i}"), "createdAt": format!("2026-10-{:02}T00:00:00.000Z", i + 1), "user": { "displayName": format!("u{i}") } }))
      .chain([json!({ "body": "bot", "createdAt": "2026-09-01T00:00:00.000Z", "user": null })])
      .collect();
    issue["comments"] = json!({ "nodes": comments });
    let d = parse_view(&json!({ "issue": issue })).unwrap();
    assert_eq!((d.comments.len(), d.comments_omitted), (MAX_COMMENTS, 3));
    assert_eq!((d.comments[0].body.as_str(), d.comments.last().unwrap().author.as_str()), ("c2", &*format!("u{}", MAX_COMMENTS + 1)));
    assert!(parse_view(&json!({ "issue": null })).is_err());
  }

  #[test]
  fn builds_list_queries_per_filter() {
    let q = |filter: &str| IssueQuery { filter: filter.into(), limit: 1000, ..Default::default() };
    let (query, vars) = list_request(&q("assigned")).unwrap();
    assert!(query.contains("assignedIssues(first: $first"));
    assert_eq!(vars["first"], 200);
    assert_eq!(vars["filter"]["state"]["type"]["nin"], json!(["completed", "canceled"]));
    assert!(list_request(&q("created")).unwrap().0.contains("createdIssues"));
    assert!(list_request(&q("open")).unwrap().0.contains(" issues(first"));
    assert!(list_request(&q("weird")).is_err());
    let (query, vars) = list_request(&IssueQuery { filter: "open".into(), team: Some(" ENG ".into()), search: Some(" login ".into()), limit: 5 }).unwrap();
    assert!(query.contains("searchIssues(term: $term"));
    assert_eq!((vars["term"].as_str(), vars["filter"]["team"]["key"]["eq"].as_str()), (Some("login"), Some("ENG")));
    assert!(list_request(&IssueQuery { filter: "open".into(), team: Some("EN G".into()), ..Default::default() }).is_err());
  }

  #[test]
  fn explains_failures_without_the_key() {
    assert_eq!(response_data(401, "").unwrap_err(), AUTH_FAILED);
    let gql = |code: &str, msg: &str| json!({ "errors": [{ "message": msg, "extensions": { "code": code } }], "data": null }).to_string();
    assert_eq!(response_data(400, &gql("AUTHENTICATION_ERROR", "Authentication required")).unwrap_err(), AUTH_FAILED);
    assert!(response_data(400, &gql("RATELIMITED", "x")).unwrap_err().contains("จำกัดจำนวนคำขอ"));
    assert!(response_data(200, &gql("INVALID_INPUT", "Entity not found: Issue")).unwrap_err().contains("ไม่พบ issue"));
    assert_eq!(response_data(200, &gql("", "odd")).unwrap_err(), "Linear: odd");
    assert!(response_data(502, "<html>").unwrap_err().contains("HTTP 502"));
    assert!(response_data(200, "not json").is_err());
    assert_eq!(response_data(200, r#"{"data":{"a":1}}"#).unwrap(), json!({ "a": 1 }));
  }

  #[test]
  fn requests_carry_the_key_and_refuse_bad_input_before_sending() {
    let t = Fake::new(&[
      (200, json!({ "data": { "viewer": { "name": "Kawin T", "displayName": "kawin", "email": "k@example.com" }, "organization": { "name": "Acme" } } })),
      (200, json!({ "data": { "issue": { "id": UUID } } })),
      (200, json!({ "data": { "commentCreate": { "success": true } } })),
    ]);
    assert_eq!(viewer(&t, "lin_api_x").unwrap(), Viewer { name: "kawin".into(), email: "k@example.com".into(), organization: "Acme".into() });
    comment(&t, "lin_api_x", "ENG-1", "Kingu เริ่มงานนี้ใน PR …").unwrap();
    let seen = t.seen.lock().unwrap();
    assert_eq!(seen[0].0, "lin_api_x");
    assert_eq!(seen[1].1["variables"]["id"], "ENG-1");
    assert_eq!(seen[2].1["variables"]["input"], json!({ "issueId": UUID, "body": "Kingu เริ่มงานนี้ใน PR …" }));
    drop(seen);
    assert!(comment(&t, "k", "ENG-1", "  ").is_err());
    assert!(view(&t, "k", "ENG-1 OR 1").is_err());
    assert!(view(&t, "k", "../x").is_err());
    assert_eq!(t.seen.lock().unwrap().len(), 3);
  }

  #[test]
  fn validates_keys_ids_and_links() {
    assert!(valid_key("lin_api_abc123"));
    assert!(!valid_key("") && !valid_key("a b") && !valid_key(&"a".repeat(MAX_KEY + 1)));
    assert!(valid_identifier("ENG-123") && valid_identifier("A1_B-7"));
    assert!(!valid_identifier("ENG") && !valid_identifier("-1") && !valid_identifier("ENG-") && !valid_identifier("ENG-1a"));
    assert!(issue_ref(UUID).is_ok() && !valid_uuid("0b7c5e0e_1111-4222-8333-944455556666"));
    assert!(linear_url("https://linear.app/acme/issue/ENG-1/x").is_ok());
    assert!(linear_url("https://linear.app.evil.com/x").is_err());
    assert!(linear_url("http://linear.app/x").is_err());
    assert!(linear_url("javascript:alert(1)").is_err());
  }

  #[test]
  fn http_transport_sends_the_bare_key_and_json() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/graphql", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
      let (stream, _) = listener.accept().unwrap();
      let mut reader = BufReader::new(stream.try_clone().unwrap());
      let (mut len, mut auth, mut line) = (0usize, String::new(), String::new());
      reader.read_line(&mut line).unwrap();
      let request_line = line.trim_end().to_owned();
      loop {
        line.clear();
        reader.read_line(&mut line).unwrap();
        let Some((k, v)) = line.trim_end().split_once(':') else { break };
        match k.to_ascii_lowercase().as_str() {
          "content-length" => len = v.trim().parse().unwrap(),
          "authorization" => auth = v.trim().to_owned(),
          _ => {}
        }
      }
      let mut body = vec![0; len];
      reader.read_exact(&mut body).unwrap();
      let payload = r#"{"data":{"viewer":{"name":"K","displayName":"","email":"e"},"organization":{"name":"Acme"}}}"#;
      let mut stream = stream;
      write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}", payload.len()).unwrap();
      (request_line, auth, String::from_utf8(body).unwrap())
    });
    let v = viewer(&Http::with_endpoint(&endpoint).unwrap(), "lin_api_secret").unwrap();
    assert_eq!((v.name.as_str(), v.organization.as_str()), ("K", "Acme"));
    let (request_line, auth, body) = server.join().unwrap();
    assert_eq!((request_line.as_str(), auth.as_str()), ("POST /graphql HTTP/1.1", "lin_api_secret"));
    assert!(serde_json::from_str::<Value>(&body).unwrap()["query"].as_str().unwrap().contains("viewer"));
  }
}
