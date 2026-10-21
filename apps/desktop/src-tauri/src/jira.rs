//! Jira issues as agent tasks (old Kingu's Jira source, Jira Cloud's REST API v3): the site URL,
//! account email and API token are kept together only in the OS keychain (Basic auth, like the
//! Atlassian docs), then `/search/jql` lists issues for a preset filter narrowed by
//! `kingu.jira.jql`, one issue is read with its latest comments, and a comment can be posted. The
//! token never reaches the webview, logs or error messages. Descriptions and comments come as
//! Atlassian Document Format and are turned into Markdown here (`adf_to_markdown`).

use base64::Engine;
use serde_json::{json, Value};

use crate::agent::issues::{truncate, IssueComment, IssueLabel, MAX_BODY, MAX_COMMENT, MAX_COMMENTS, MAX_LIMIT};
use crate::i18n::msg::TrackerMsg;
use crate::tr;
use crate::tracker_http::{common_error, json, text, valid_token, Http, Request, Transport};

pub const KEYCHAIN_SERVICE: &str = "dev.kingu.jira";
const KEYCHAIN_ACCOUNT: &str = "credentials";
const SERVICE: &str = "Jira";
const MAX_TOKEN: usize = 1024;
const MAX_JQL: usize = 2000;
const MAX_COMMENT_POST: usize = 16 * 1024;
const FIELDS: [&str; 10] = ["summary", "status", "priority", "issuetype", "project", "labels", "assignee", "reporter", "updated", "description"];

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Viewer {
  pub name: String,
  pub email: String,
  /// `https://acme.atlassian.net`.
  pub site: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct JiraIssue {
  /// `ENG-123`.
  pub key: String,
  /// The number after the project key.
  pub number: u64,
  pub title: String,
  /// `<site>/browse/ENG-123`.
  pub url: String,
  /// The status name (`In Progress`) and its category (`new`, `indeterminate`, `done`).
  pub state: String,
  pub state_category: String,
  pub priority: String,
  pub issue_type: String,
  pub project: String,
  /// Jira labels have no colour.
  pub labels: Vec<IssueLabel>,
  /// Display names.
  pub assignees: Vec<String>,
  /// ISO 8601.
  pub updated_at: String,
  pub author: String,
  /// Markdown, cut at `MAX_BODY` bytes.
  pub body: String,
  pub body_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct JiraIssueDetail {
  #[serde(flatten)]
  pub issue: JiraIssue,
  pub comments: Vec<IssueComment>,
  pub comments_omitted: usize,
}

/// Which issues to list; every filter leaves out issues whose status is in the Done category.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IssueQuery {
  /// `assigned` (to me), `reported` (by me) or `open` (anyone's).
  pub filter: String,
  /// `kingu.jira.jql`: more JQL ANDed in (`project = ENG`), without ORDER BY.
  pub jql: Option<String>,
  pub label: Option<String>,
  pub search: Option<String>,
  pub limit: u32,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Credentials {
  site: String,
  email: String,
  token: String,
}

/// `https://acme.atlassian.net` from what the user typed (scheme optional, path dropped).
pub fn normalize_site(site: &str) -> Result<String, String> {
  let raw = site.trim();
  let with_scheme = if raw.contains("://") { raw.to_owned() } else { format!("https://{raw}") };
  let u = url::Url::parse(&with_scheme).map_err(|_| tr!(TrackerMsg::JiraBadSite, site))?;
  match u.host_str() {
    Some(h) if u.scheme() == "https" && h.contains('.') && u.username().is_empty() && u.password().is_none() => {
      Ok(u.origin().ascii_serialization())
    }
    _ => Err(tr!(TrackerMsg::JiraBadSite, site)),
  }
}

pub fn valid_email(email: &str) -> bool {
  email.len() <= 254 && email.split_once('@').is_some_and(|(a, d)| !a.is_empty() && d.contains('.')) && !email.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// `ENG-123`: an uppercase project key, a dash and the number.
pub fn valid_key(key: &str) -> bool {
  key.split_once('-').is_some_and(|(p, n)| {
    p.len() <= 32
      && p.bytes().next().is_some_and(|b| b.is_ascii_uppercase())
      && p.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
      && !n.is_empty()
      && n.len() <= 12
      && !n.starts_with('0')
      && n.bytes().all(|b| b.is_ascii_digit())
  })
}

fn key_or_err(key: &str) -> Result<(), String> {
  if valid_key(key) { Ok(()) } else { Err(tr!(TrackerMsg::BadIssueKey, service = SERVICE, key)) }
}

pub fn auth_header(email: &str, token: &str) -> String {
  format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{email}:{token}")))
}

/// A JQL string literal.
pub fn jql_string(s: &str) -> String {
  format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The JQL of `q`.
pub fn jql_for(q: &IssueQuery) -> Result<String, String> {
  let mut clauses = vec![match q.filter.as_str() {
    "assigned" => "assignee = currentUser()".to_owned(),
    "reported" => "reporter = currentUser()".to_owned(),
    "open" => String::new(),
    f => return Err(tr!(TrackerMsg::BadFilter, service = SERVICE, filter = f)),
  }];
  clauses.push("statusCategory != Done".into());
  let extra = q.jql.as_deref().map(str::trim).filter(|j| !j.is_empty());
  if let Some(j) = extra {
    if j.len() > MAX_JQL || j.to_ascii_lowercase().contains("order by") {
      return Err(tr!(TrackerMsg::JiraBadJql));
    }
    clauses.push(format!("({j})"));
  } else if q.filter == "open" {
    // Jira Cloud refuses an unbounded search; recent work stands in for "everything open".
    clauses.push("updated >= -180d".into());
  }
  if let Some(l) = q.label.as_deref().map(str::trim).filter(|l| !l.is_empty()) {
    clauses.push(format!("labels = {}", jql_string(l)));
  }
  if let Some(s) = q.search.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
    clauses.push(if valid_key(&s.to_ascii_uppercase()) { format!("key = {}", s.to_ascii_uppercase()) } else { format!("text ~ {}", jql_string(s)) });
  }
  Ok(format!("{} ORDER BY updated DESC", clauses.into_iter().filter(|c| !c.is_empty()).collect::<Vec<_>>().join(" AND ")))
}

/// The JSON of a response, or a message the user can act on.
pub fn response(status: u16, body: &str) -> Result<Value, String> {
  match status {
    401 => return Err(tr!(TrackerMsg::JiraAuthFailed)),
    403 => return Err(tr!(TrackerMsg::JiraForbidden)),
    404 => return Err(tr!(TrackerMsg::JiraNotFound)),
    _ => {}
  }
  if let Some(e) = common_error(SERVICE, status) {
    return Err(e);
  }
  if status == 204 || (body.trim().is_empty() && (200..300).contains(&status)) {
    return Ok(Value::Null);
  }
  let v = json(SERVICE, status, body)?;
  if !(200..300).contains(&status) {
    let messages: Vec<String> = v["errorMessages"]
      .as_array()
      .map(|a| a.iter().filter_map(|m| m.as_str().map(str::to_owned)).collect::<Vec<_>>())
      .unwrap_or_default()
      .into_iter()
      .chain(v["errors"].as_object().map(|o| o.values().filter_map(|m| m.as_str().map(str::to_owned)).collect::<Vec<_>>()).unwrap_or_default())
      .collect();
    return Err(format!("Jira: {}", if messages.is_empty() { format!("HTTP {status}") } else { messages.join("; ") }));
  }
  Ok(v)
}

fn call(t: &dyn Transport, req: Request) -> Result<Value, String> {
  let (status, body) = t.send(&req)?;
  response(status, &body)
}

pub fn parse_viewer(v: &Value, site: &str) -> Result<Viewer, String> {
  let name = text(v, "displayName");
  if name.is_empty() && text(v, "accountId").is_empty() {
    return Err(tr!(TrackerMsg::NoViewer, service = SERVICE));
  }
  Ok(Viewer { name, email: text(v, "emailAddress"), site: site.to_owned() })
}

pub fn parse_issue(v: &Value, site: &str) -> Result<JiraIssue, String> {
  let key = text(v, "key");
  if !valid_key(&key) {
    return Err(tr!(TrackerMsg::NoIssueNumber, service = SERVICE));
  }
  let f = &v["fields"];
  let number = key.rsplit('-').next().and_then(|n| n.parse().ok()).unwrap_or(0);
  let description = match &f["description"] {
    Value::String(s) => s.clone(),
    Value::Null => String::new(),
    doc => adf_to_markdown(doc),
  };
  let (body, body_truncated) = truncate(&description, MAX_BODY);
  Ok(JiraIssue {
    url: format!("{site}/browse/{key}"),
    number,
    title: text(f, "summary"),
    state: text(&f["status"], "name"),
    state_category: text(&f["status"]["statusCategory"], "key"),
    priority: text(&f["priority"], "name"),
    issue_type: text(&f["issuetype"], "name"),
    project: text(&f["project"], "key"),
    labels: f["labels"].as_array().map(|a| a.iter().filter_map(|l| l.as_str()).filter(|l| !l.is_empty()).map(|l| IssueLabel { name: l.to_owned(), color: String::new() }).collect()).unwrap_or_default(),
    assignees: Some(text(&f["assignee"], "displayName")).filter(|a| !a.is_empty()).into_iter().collect(),
    updated_at: text(f, "updated"),
    author: text(&f["reporter"], "displayName"),
    body,
    body_truncated,
    key,
  })
}

pub fn parse_search(v: &Value, site: &str) -> Result<Vec<JiraIssue>, String> {
  v["issues"].as_array().ok_or_else(|| tr!(TrackerMsg::NotIssueList, service = SERVICE))?.iter().map(|i| parse_issue(i, site)).collect()
}

/// A comment page (newest first) → comments oldest first and how many older ones were left out.
pub fn parse_comments(v: &Value) -> (Vec<IssueComment>, usize) {
  let mut comments: Vec<IssueComment> = v["comments"]
    .as_array()
    .map(Vec::as_slice)
    .unwrap_or_default()
    .iter()
    .take(MAX_COMMENTS)
    .map(|c| {
      let body = match &c["body"] {
        Value::String(s) => s.clone(),
        doc => adf_to_markdown(doc),
      };
      IssueComment { author: [text(&c["author"], "displayName")].into_iter().find(|a| !a.is_empty()).unwrap_or_else(|| "Jira".into()), body: truncate(&body, MAX_COMMENT).0, created_at: text(c, "created") }
    })
    .collect();
  comments.sort_by(|a, b| a.created_at.cmp(&b.created_at));
  let total = v["total"].as_u64().map_or(comments.len(), |t| t as usize);
  let omitted = total.saturating_sub(comments.len());
  (comments, omitted)
}

pub fn viewer(t: &dyn Transport, site: &str) -> Result<Viewer, String> {
  parse_viewer(&call(t, Request::get("/rest/api/3/myself"))?, site)
}

pub fn list(t: &dyn Transport, site: &str, q: &IssueQuery) -> Result<Vec<JiraIssue>, String> {
  let jql = jql_for(q)?;
  let body = json!({ "jql": jql, "maxResults": q.limit.clamp(1, MAX_LIMIT.min(100)), "fields": FIELDS });
  parse_search(&call(t, Request::post("/rest/api/3/search/jql", body))?, site)
}

pub fn view(t: &dyn Transport, site: &str, key: &str) -> Result<JiraIssueDetail, String> {
  key_or_err(key)?;
  let issue = parse_issue(&call(t, Request::get(format!("/rest/api/3/issue/{key}?fields={}", FIELDS.join(","))))?, site)?;
  let (comments, comments_omitted) = parse_comments(&call(t, Request::get(format!("/rest/api/3/issue/{key}/comment?orderBy=-created&maxResults={MAX_COMMENTS}")))?);
  Ok(JiraIssueDetail { issue, comments, comments_omitted })
}

pub fn comment(t: &dyn Transport, key: &str, body: &str) -> Result<(), String> {
  key_or_err(key)?;
  if body.trim().is_empty() || body.len() > MAX_COMMENT_POST {
    return Err(tr!(TrackerMsg::CommentLength, max = MAX_COMMENT_POST));
  }
  call(t, Request::post(format!("/rest/api/3/issue/{key}/comment"), json!({ "body": text_to_adf(body) }))).map(|_| ())
}

/// Plain text as an ADF document: one paragraph per line, URLs left as text (Jira links them).
pub fn text_to_adf(s: &str) -> Value {
  let content: Vec<Value> = s.lines().map(|l| if l.is_empty() { json!({ "type": "paragraph", "content": [] }) } else { json!({ "type": "paragraph", "content": [{ "type": "text", "text": l }] }) }).collect();
  json!({ "type": "doc", "version": 1, "content": content })
}

/// Atlassian Document Format → Markdown for prompts: blocks, lists, code, quotes, links, marks
/// and mentions; media becomes a placeholder (attachments are not downloaded).
pub fn adf_to_markdown(doc: &Value) -> String {
  let mut out = String::new();
  blocks(doc["content"].as_array().map(Vec::as_slice).unwrap_or_default(), &mut out, "");
  out.trim().to_owned()
}

fn blocks(nodes: &[Value], out: &mut String, indent: &str) {
  for n in nodes {
    block(n, out, indent);
  }
}

fn block(n: &Value, out: &mut String, indent: &str) {
  let children = n["content"].as_array().map(Vec::as_slice).unwrap_or_default();
  match n["type"].as_str().unwrap_or_default() {
    "paragraph" => {
      out.push_str(indent);
      out.push_str(&inline(children));
      out.push_str("\n\n");
    }
    "heading" => {
      let level = n["attrs"]["level"].as_u64().unwrap_or(1).clamp(1, 6) as usize;
      out.push_str(&format!("{indent}{} {}\n\n", "#".repeat(level), inline(children)));
    }
    "bulletList" | "orderedList" => {
      let ordered = n["type"] == "orderedList";
      for (i, item) in children.iter().enumerate() {
        let marker = if ordered { format!("{}. ", i + 1) } else { "- ".into() };
        let mut inner = String::new();
        blocks(item["content"].as_array().map(Vec::as_slice).unwrap_or_default(), &mut inner, "");
        let pad = " ".repeat(marker.len());
        for (j, line) in inner.trim_end().lines().filter(|l| !l.trim().is_empty()).enumerate() {
          out.push_str(indent);
          out.push_str(if j == 0 { &marker } else { &pad });
          out.push_str(line);
          out.push('\n');
        }
      }
      out.push('\n');
    }
    "codeBlock" => {
      let lang = n["attrs"]["language"].as_str().unwrap_or_default();
      let code: String = children.iter().filter_map(|c| c["text"].as_str()).collect();
      out.push_str(&format!("{indent}```{lang}\n{code}\n{indent}```\n\n"));
    }
    "blockquote" => {
      let mut inner = String::new();
      blocks(children, &mut inner, "");
      for line in inner.trim_end().lines() {
        out.push_str(&format!("{indent}> {line}\n"));
      }
      out.push('\n');
    }
    "rule" => out.push_str(&format!("{indent}---\n\n")),
    "table" => {
      for row in children {
        let cells: Vec<String> = row["content"]
          .as_array()
          .map(Vec::as_slice)
          .unwrap_or_default()
          .iter()
          .map(|cell| {
            let mut inner = String::new();
            blocks(cell["content"].as_array().map(Vec::as_slice).unwrap_or_default(), &mut inner, "");
            inner.split_whitespace().collect::<Vec<_>>().join(" ")
          })
          .collect();
        out.push_str(&format!("{indent}| {} |\n", cells.join(" | ")));
      }
      out.push('\n');
    }
    "mediaSingle" | "mediaGroup" | "media" => out.push_str(&format!("{indent}*[{}]*\n\n", media_name(n))),
    // panels, expands, list items reached directly: their content.
    _ if !children.is_empty() => {
      if children.iter().all(|c| c["content"].is_null() && c["type"] != "rule") {
        out.push_str(indent);
        out.push_str(&inline(children));
        out.push_str("\n\n");
      } else {
        blocks(children, out, indent);
      }
    }
    _ => {
      let s = inline(std::slice::from_ref(n));
      if !s.is_empty() {
        out.push_str(&format!("{indent}{s}\n\n"));
      }
    }
  }
}

fn media_name(n: &Value) -> String {
  let attrs = if n["attrs"]["alt"].is_string() || n["attrs"]["id"].is_string() { &n["attrs"] } else { &n["content"][0]["attrs"] };
  attrs["alt"].as_str().or_else(|| attrs["name"].as_str()).filter(|s| !s.is_empty()).unwrap_or("image").replace(['[', ']'], "")
}

fn inline(nodes: &[Value]) -> String {
  let mut s = String::new();
  for n in nodes {
    match n["type"].as_str().unwrap_or_default() {
      "text" => {
        let mut t = n["text"].as_str().unwrap_or_default().to_owned();
        let mut link = None;
        for m in n["marks"].as_array().map(Vec::as_slice).unwrap_or_default() {
          match m["type"].as_str().unwrap_or_default() {
            "code" => t = format!("`{t}`"),
            "strong" => t = format!("**{t}**"),
            "em" => t = format!("*{t}*"),
            "strike" => t = format!("~~{t}~~"),
            "link" => link = m["attrs"]["href"].as_str().map(str::to_owned),
            _ => {}
          }
        }
        match link {
          Some(href) if href.starts_with("http") => s.push_str(&format!("[{t}]({href})")),
          _ => s.push_str(&t),
        }
      }
      "hardBreak" => s.push('\n'),
      "mention" => s.push_str(n["attrs"]["text"].as_str().unwrap_or("@someone")),
      "emoji" => s.push_str(n["attrs"]["text"].as_str().or_else(|| n["attrs"]["shortName"].as_str()).unwrap_or_default()),
      "inlineCard" | "blockCard" => s.push_str(n["attrs"]["url"].as_str().unwrap_or_default()),
      "status" | "date" => s.push_str(n["attrs"]["text"].as_str().or_else(|| n["attrs"]["timestamp"].as_str()).unwrap_or_default()),
      "mediaInline" | "media" => s.push_str(&format!("*[{}]*", media_name(n))),
      _ => s.push_str(&inline(n["content"].as_array().map(Vec::as_slice).unwrap_or_default())),
    }
  }
  s
}

/// Only a page on the connected Jira site opens from a task's Jira link.
pub fn jira_url(url: &str, site: &str) -> Result<url::Url, String> {
  let u = url::Url::parse(url).map_err(|e| e.to_string())?;
  if u.scheme() == "https" && u.origin().ascii_serialization() == site { Ok(u) } else { Err(tr!(TrackerMsg::OnlyHostLinks, host = site)) }
}

// ---------------------------------------------------------------------------------------------
// Keychain and commands

fn entry() -> Result<keyring::Entry, String> {
  keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|e| e.to_string())
}

fn stored() -> Option<Credentials> {
  serde_json::from_str(&entry().ok()?.get_password().ok()?).ok()
}

fn client(c: &Credentials) -> Result<Http, String> {
  Http::new(SERVICE, &c.site, "Authorization", auth_header(&c.email, &c.token))
}

fn connected() -> Result<(Http, String), String> {
  let c = stored().ok_or_else(|| tr!(TrackerMsg::JiraNotConnected))?;
  Ok((client(&c)?, c.site))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// The connected Jira user and site, or none without stored credentials.
#[tauri::command]
pub async fn jira_status() -> Result<Option<Viewer>, String> {
  blocking(|| match stored() {
    None => Ok(None),
    Some(c) => viewer(&client(&c)?, &c.site).map(Some),
  })
  .await
}

/// Checks the credentials with Jira, then stores them in the keychain.
#[tauri::command]
pub async fn jira_connect(site: String, email: String, token: String) -> Result<Viewer, String> {
  let site = normalize_site(&site)?;
  let email = email.trim().to_owned();
  let token = token.trim().to_owned();
  if !valid_email(&email) {
    return Err(tr!(TrackerMsg::JiraBadEmail));
  }
  if !valid_token(&token, MAX_TOKEN) {
    return Err(tr!(TrackerMsg::JiraBadToken));
  }
  blocking(move || {
    let c = Credentials { site, email, token };
    let v = viewer(&client(&c)?, &c.site)?;
    let secret = serde_json::to_string(&c).map_err(|e| e.to_string())?;
    entry()?.set_password(&secret).map_err(|e| tr!(TrackerMsg::SaveSecretFailed, detail = e))?;
    log::info!("jira connected ({})", c.site);
    Ok(v)
  })
  .await
}

#[tauri::command]
pub fn jira_disconnect() -> Result<(), String> {
  match entry()?.delete_credential() {
    Ok(()) | Err(keyring::Error::NoEntry) => {
      log::info!("jira disconnected");
      Ok(())
    }
    Err(e) => Err(tr!(TrackerMsg::DeleteSecretFailed, detail = e)),
  }
}

/// `filter`: `assigned` (default), `reported` or `open`; `jql`: `kingu.jira.jql`.
#[tauri::command]
pub async fn jira_issues_list(filter: Option<String>, jql: Option<String>, label: Option<String>, search: Option<String>, limit: Option<u32>) -> Result<Vec<JiraIssue>, String> {
  let q = IssueQuery { filter: filter.unwrap_or_else(|| "assigned".into()), jql, label, search, limit: limit.unwrap_or(50) };
  blocking(move || {
    let (t, site) = connected()?;
    list(&t, &site, &q)
  })
  .await
}

#[tauri::command]
pub async fn jira_issue_view(key: String) -> Result<JiraIssueDetail, String> {
  blocking(move || {
    let (t, site) = connected()?;
    view(&t, &site, &key)
  })
  .await
}

#[tauri::command]
pub async fn jira_issue_comment(key: String, body: String) -> Result<(), String> {
  blocking(move || {
    comment(&connected()?.0, &key, &body)?;
    log::info!("commented on jira issue {key}");
    Ok(())
  })
  .await
}

#[tauri::command]
pub fn jira_issue_open(url: String) -> Result<(), String> {
  let site = stored().ok_or_else(|| tr!(TrackerMsg::JiraNotConnected))?.site;
  crate::system::open_web_url(jira_url(&url, &site)?.as_str())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::tracker_http::fake::Fake;
  use crate::tracker_http::Method;

  const SITE: &str = "https://acme.atlassian.net";

  fn issue(key: &str) -> Value {
    json!({
      "key": key,
      "fields": {
        "summary": "แก้ login", "status": { "name": "In Progress", "statusCategory": { "key": "indeterminate" } },
        "priority": { "name": "High" }, "issuetype": { "name": "Bug" }, "project": { "key": "ENG" }, "labels": ["web", ""],
        "assignee": { "displayName": "Kawin" }, "reporter": { "displayName": "Hubot" }, "updated": "2026-10-01T08:30:00.000+0700",
        "description": { "type": "doc", "version": 1, "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Steps" }] }] }
      }
    })
  }

  #[test]
  fn parses_search_results() {
    let list = parse_search(&json!({ "issues": [issue("ENG-123")], "isLast": true }), SITE).unwrap();
    let i = &list[0];
    assert_eq!((i.key.as_str(), i.number, i.url.as_str()), ("ENG-123", 123, "https://acme.atlassian.net/browse/ENG-123"));
    assert_eq!((i.state.as_str(), i.state_category.as_str(), i.priority.as_str(), i.issue_type.as_str()), ("In Progress", "indeterminate", "High", "Bug"));
    assert_eq!((i.labels.len(), i.assignees.as_slice(), i.author.as_str(), i.body.as_str()), (1, ["Kawin".to_owned()].as_slice(), "Hubot", "Steps"));
    let mut bare = issue("OPS-7");
    bare["fields"]["assignee"] = Value::Null;
    bare["fields"]["description"] = Value::Null;
    let b = parse_issue(&bare, SITE).unwrap();
    assert_eq!((b.assignees.len(), b.body.as_str()), (0, ""));
    assert!(parse_search(&json!({}), SITE).is_err());
    assert!(parse_issue(&json!({ "key": "eng-1" }), SITE).is_err());
  }

  #[test]
  fn builds_jql() {
    let q = |filter: &str| IssueQuery { filter: filter.into(), limit: 50, ..Default::default() };
    assert_eq!(jql_for(&q("assigned")).unwrap(), "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC");
    assert_eq!(jql_for(&q("open")).unwrap(), "statusCategory != Done AND updated >= -180d ORDER BY updated DESC");
    let full = IssueQuery { filter: "reported".into(), jql: Some(" project = ENG ".into()), label: Some("a\"b".into()), search: Some("log \\in".into()), limit: 5 };
    assert_eq!(jql_for(&full).unwrap(), r#"reporter = currentUser() AND statusCategory != Done AND (project = ENG) AND labels = "a\"b" AND text ~ "log \\in" ORDER BY updated DESC"#);
    let by_key = IssueQuery { filter: "open".into(), jql: Some("project = ENG".into()), search: Some("eng-12".into()), ..Default::default() };
    assert!(jql_for(&by_key).unwrap().contains("AND key = ENG-12 ORDER"));
    assert!(jql_for(&IssueQuery { filter: "open".into(), jql: Some("project = X order by created".into()), ..Default::default() }).is_err());
    assert!(jql_for(&q("weird")).is_err());
  }

  #[test]
  fn converts_adf_to_markdown() {
    let doc = json!({ "type": "doc", "version": 1, "content": [
      { "type": "heading", "attrs": { "level": 2 }, "content": [{ "type": "text", "text": "Steps" }] },
      { "type": "paragraph", "content": [
        { "type": "text", "text": "Open " }, { "type": "text", "text": "login", "marks": [{ "type": "code" }] },
        { "type": "text", "text": " then " }, { "type": "text", "text": "docs", "marks": [{ "type": "link", "attrs": { "href": "https://x.dev" } }] },
        { "type": "hardBreak" }, { "type": "mention", "attrs": { "text": "@Kawin" } }
      ] },
      { "type": "orderedList", "content": [
        { "type": "listItem", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "one", "marks": [{ "type": "strong" }] }] }] },
        { "type": "listItem", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "two" }] }, { "type": "bulletList", "content": [
          { "type": "listItem", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "nested" }] }] }
        ] }] }
      ] },
      { "type": "codeBlock", "attrs": { "language": "rust" }, "content": [{ "type": "text", "text": "fn main() {}" }] },
      { "type": "blockquote", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "quoted" }] }] },
      { "type": "mediaSingle", "content": [{ "type": "media", "attrs": { "id": "x", "alt": "shot.png" } }] },
      { "type": "panel", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "note" }] }] }
    ] });
    let md = adf_to_markdown(&doc);
    assert_eq!(
      md,
      "## Steps\n\nOpen `login` then [docs](https://x.dev)\n@Kawin\n\n1. **one**\n2. two\n   - nested\n\n```rust\nfn main() {}\n```\n\n> quoted\n\n*[shot.png]*\n\nnote"
    );
    assert_eq!(adf_to_markdown(&json!({})), "");
  }

  #[test]
  fn reads_comments_and_posts_adf() {
    let page = json!({ "total": 25, "comments": [
      { "author": { "displayName": "B" }, "body": { "type": "doc", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "newer" }] }] }, "created": "2026-10-02T00:00:00.000+0000" },
      { "author": null, "body": "older", "created": "2026-10-01T00:00:00.000+0000" }
    ] });
    let t = Fake::new(&[(200, issue("ENG-1")), (200, page), (201, json!({ "id": "1" }))]);
    let d = view(&t, SITE, "ENG-1").unwrap();
    assert_eq!((d.comments[0].body.as_str(), d.comments[0].author.as_str(), d.comments[1].body.as_str(), d.comments_omitted), ("older", "Jira", "newer", 23));
    comment(&t, "ENG-1", "Kingu เริ่มงานนี้ใน PR …\nline 2").unwrap();
    let seen = t.requests();
    assert!(seen[0].path.starts_with("/rest/api/3/issue/ENG-1?fields=summary,"));
    assert_eq!(seen[2].method, Method::Post);
    assert_eq!(seen[2].body.as_ref().unwrap()["body"]["content"][1]["content"][0]["text"], "line 2");
    assert!(view(&t, SITE, "ENG-1/../x").is_err() && comment(&t, "ENG-1", "").is_err());
    assert_eq!(t.requests().len(), 3);
  }

  #[test]
  fn search_posts_jql_and_explains_failures() {
    let t = Fake::new(&[(200, json!({ "issues": [] })), (400, json!({ "errorMessages": ["Field 'x' does not exist"], "errors": {} }))]);
    let q = IssueQuery { filter: "assigned".into(), limit: 500, ..Default::default() };
    assert!(list(&t, SITE, &q).unwrap().is_empty());
    assert_eq!(list(&t, SITE, &q).unwrap_err(), "Jira: Field 'x' does not exist");
    let req = &t.requests()[0];
    assert_eq!((req.path.as_str(), req.body.as_ref().unwrap()["maxResults"].as_u64()), ("/rest/api/3/search/jql", Some(100)));
    assert_eq!(response(401, "").unwrap_err(), tr!(TrackerMsg::JiraAuthFailed));
    assert_eq!(response(404, "").unwrap_err(), tr!(TrackerMsg::JiraNotFound));
    assert_eq!(response(204, "").unwrap(), Value::Null);
  }

  #[test]
  fn validates_sites_keys_and_links() {
    assert_eq!(normalize_site("acme.atlassian.net/jira/your-work").unwrap(), SITE);
    assert_eq!(normalize_site(" https://acme.atlassian.net/ ").unwrap(), SITE);
    assert!(normalize_site("http://acme.atlassian.net").is_err() && normalize_site("https://u:p@acme.atlassian.net").is_err() && normalize_site("localhost").is_err());
    assert!(valid_email("k@acme.dev") && !valid_email("k acme@x.dev") && !valid_email("@x.dev") && !valid_email("k@local"));
    assert!(valid_key("ENG-123") && valid_key("A1_B-7") && !valid_key("eng-1") && !valid_key("ENG-01") && !valid_key("1EN-1") && !valid_key("ENG-"));
    assert_eq!(auth_header("k@acme.dev", "tok"), "Basic a0BhY21lLmRldjp0b2s=");
    assert!(jira_url("https://acme.atlassian.net/browse/ENG-1", SITE).is_ok());
    assert!(jira_url("https://acme.atlassian.net.evil.dev/browse/ENG-1", SITE).is_err());
    assert_eq!(jql_string(r#"a"b\c"#), r#""a\"b\\c""#);
  }
}
