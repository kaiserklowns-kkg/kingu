//! GitHub issues as agent tasks (Orca's "Tasks from GitHub"): list and read the open folder's
//! issues and comment on one, all through `gh` run in the folder root with prompts disabled and a
//! timeout. Parsing is pure (`parse_issues`, `parse_issue_view`) and errors become Thai messages
//! saying what to fix (`gh` missing, not logged in, no GitHub remote).

use std::io::Read;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

pub const GH_MISSING: &str = "ไม่พบ gh: ติดตั้งด้วย `brew install gh` แล้ว `gh auth login`";
const TIMEOUT: Duration = Duration::from_secs(30);
/// Issue bodies go into prompts and the webview: keep them bounded.
pub const MAX_BODY: usize = 8 * 1024;
pub const MAX_COMMENT: usize = 2 * 1024;
/// `gh issue view` lists every comment; the latest ones are kept.
pub const MAX_COMMENTS: usize = 20;
pub const MAX_LIMIT: u32 = 200;
const MAX_COMMENT_POST: usize = 16 * 1024;
const LIST_FIELDS: &str = "number,title,url,state,labels,assignees,updatedAt,author,body";
const VIEW_FIELDS: &str = "number,title,url,state,labels,assignees,updatedAt,author,body,comments";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct IssueLabel {
  pub name: String,
  /// Hex colour without `#` (may be empty).
  pub color: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Issue {
  pub number: u64,
  pub title: String,
  pub url: String,
  /// `OPEN` or `CLOSED`.
  pub state: String,
  pub labels: Vec<IssueLabel>,
  /// Logins.
  pub assignees: Vec<String>,
  /// ISO 8601.
  pub updated_at: String,
  pub author: String,
  /// Empty for an issue without a body; cut at `MAX_BODY` bytes.
  pub body: String,
  pub body_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct IssueComment {
  pub author: String,
  pub body: String,
  pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct IssueDetail {
  #[serde(flatten)]
  pub issue: Issue,
  pub comments: Vec<IssueComment>,
  /// Older comments left out (beyond `MAX_COMMENTS`).
  pub comments_omitted: usize,
}

/// `gh issue list` filters. `assignee`: `@me` or a login, `None` for anyone.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IssueQuery {
  pub state: String,
  pub assignee: Option<String>,
  pub label: Option<String>,
  pub search: Option<String>,
  pub limit: u32,
}

/// At most `max` bytes, cut on a character boundary; whether anything was cut.
pub fn truncate(s: &str, max: usize) -> (String, bool) {
  if s.len() <= max {
    return (s.to_owned(), false);
  }
  let mut end = max;
  while !s.is_char_boundary(end) {
    end -= 1;
  }
  (s[..end].to_owned(), true)
}

fn text(v: &serde_json::Value, k: &str) -> String {
  v[k].as_str().unwrap_or_default().to_owned()
}

fn login(v: &serde_json::Value) -> String {
  v["login"].as_str().unwrap_or_default().to_owned()
}

fn issue_of(v: &serde_json::Value) -> Result<Issue, String> {
  let number = v["number"].as_u64().ok_or("gh: issue ไม่มีหมายเลข")?;
  let labels = v["labels"]
    .as_array()
    .map(|a| a.iter().map(|l| IssueLabel { name: text(l, "name"), color: text(l, "color") }).filter(|l| !l.name.is_empty()).collect())
    .unwrap_or_default();
  let assignees = v["assignees"].as_array().map(|a| a.iter().map(login).filter(|l| !l.is_empty()).collect()).unwrap_or_default();
  let (body, body_truncated) = truncate(v["body"].as_str().unwrap_or_default(), MAX_BODY);
  Ok(Issue {
    number,
    title: text(v, "title"),
    url: text(v, "url"),
    state: text(v, "state"),
    labels,
    assignees,
    updated_at: text(v, "updatedAt"),
    author: login(&v["author"]),
    body,
    body_truncated,
  })
}

/// `gh issue list --json LIST_FIELDS` output.
pub fn parse_issues(json: &str) -> Result<Vec<Issue>, String> {
  let v: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("gh issue list: อ่านผลไม่ได้ ({e})"))?;
  v.as_array().ok_or("gh issue list: ผลไม่ใช่รายการ")?.iter().map(issue_of).collect()
}

/// `gh issue view --json VIEW_FIELDS` output; keeps the latest `MAX_COMMENTS` comments.
pub fn parse_issue_view(json: &str) -> Result<IssueDetail, String> {
  let v: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("gh issue view: อ่านผลไม่ได้ ({e})"))?;
  let issue = issue_of(&v)?;
  let all = v["comments"].as_array().map(Vec::as_slice).unwrap_or_default();
  let skip = all.len().saturating_sub(MAX_COMMENTS);
  let comments = all[skip..]
    .iter()
    .map(|c| IssueComment { author: login(&c["author"]), body: truncate(c["body"].as_str().unwrap_or_default(), MAX_COMMENT).0, created_at: text(c, "createdAt") })
    .collect();
  Ok(IssueDetail { issue, comments, comments_omitted: skip })
}

/// What went wrong, from gh's stderr, as a message the user can act on.
pub fn gh_error(op: &str, stderr: &str) -> String {
  let e = stderr.to_lowercase();
  if e.contains("gh auth login") || e.contains("not logged in") || e.contains("authentication required") || e.contains("http 401") || e.contains("bad credentials") {
    "gh ยังไม่ได้เข้าสู่ระบบ: รัน `gh auth login` ในเทอร์มินัล".into()
  } else if e.contains("no git remotes")
    || e.contains("none of the git remotes")
    || e.contains("not a git repository")
    || e.contains("could not determine base repo")
    || e.contains("unable to determine")
  {
    "โฟลเดอร์นี้ไม่มี remote ที่ชี้ไป GitHub (เช่น origin บน github.com)".into()
  } else if e.contains("could not resolve to a repository") || e.contains("http 404") {
    "ไม่พบ repository หรือ issue นี้บน GitHub (หรือไม่มีสิทธิ์เข้าถึง)".into()
  } else if e.contains("disabled issues") || e.contains("issues are disabled") {
    "repository นี้ปิด Issues ไว้".into()
  } else if e.contains("error connecting") || e.contains("could not connect") || e.contains("no such host") || e.contains("timeout") {
    "เชื่อมต่อ GitHub ไม่ได้ ตรวจสอบอินเทอร์เน็ต".into()
  } else {
    let first = stderr.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("ล้มเหลว");
    format!("{op}: {first}")
  }
}

fn kill_tree(child: &mut std::process::Child) {
  #[cfg(unix)]
  // SAFETY: plain syscall on the process group created for this child (`process_group(0)`).
  unsafe {
    libc::kill(-(child.id() as i32), libc::SIGKILL);
  }
  let _ = child.kill();
  let _ = child.wait();
}

fn reader(pipe: Option<impl Read + Send + 'static>) -> std::thread::JoinHandle<String> {
  std::thread::spawn(move || {
    let mut buf = Vec::new();
    if let Some(mut p) = pipe {
      let _ = p.read_to_end(&mut buf);
    }
    String::from_utf8_lossy(&buf).into_owned()
  })
}

/// Runs `gh args…` in `dir` without prompts; stdout on success, else a user-facing error.
fn run_gh(gh: &Path, dir: &Path, op: &str, args: &[String]) -> Result<String, String> {
  let mut cmd = crate::shell_env::command(gh);
  cmd
    .current_dir(dir)
    .args(args)
    .env("GH_PROMPT_DISABLED", "1")
    .env("GH_NO_UPDATE_NOTIFIER", "1")
    .env("NO_COLOR", "1")
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
  #[cfg(unix)]
  {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
  }
  let mut child = cmd.spawn().map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { GH_MISSING.to_owned() } else { format!("gh: {e}") })?;
  let out = reader(child.stdout.take());
  let err = reader(child.stderr.take());
  let deadline = Instant::now() + TIMEOUT;
  let ok = loop {
    match child.try_wait() {
      Ok(Some(status)) => break status.success(),
      Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(40)),
      Ok(None) => {
        kill_tree(&mut child);
        let _ = (out.join(), err.join());
        return Err(format!("{op}: gh ไม่ตอบภายใน {} วินาที", TIMEOUT.as_secs()));
      }
      Err(e) => {
        kill_tree(&mut child);
        return Err(format!("gh: {e}"));
      }
    }
  };
  let stdout = out.join().unwrap_or_default();
  let stderr = err.join().unwrap_or_default();
  if ok { Ok(stdout) } else { Err(gh_error(op, &stderr)) }
}

fn valid_login(s: &str) -> bool {
  s == "@me" || (!s.is_empty() && s.len() <= 39 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') && !s.starts_with('-'))
}

/// `gh issue list` arguments for `q` (values as `--flag=value`, so none can pass for an option).
pub fn list_args(q: &IssueQuery) -> Result<Vec<String>, String> {
  if !matches!(q.state.as_str(), "open" | "closed" | "all") {
    return Err(format!("สถานะ issue ไม่ถูกต้อง: {}", q.state));
  }
  let mut args = vec!["issue".into(), "list".into(), format!("--state={}", q.state), format!("--limit={}", q.limit.clamp(1, MAX_LIMIT)), format!("--json={LIST_FIELDS}")];
  if let Some(a) = q.assignee.as_deref().filter(|a| !a.is_empty()) {
    if !valid_login(a) {
      return Err(format!("ชื่อผู้รับผิดชอบไม่ถูกต้อง: {a}"));
    }
    args.push(format!("--assignee={a}"));
  }
  if let Some(l) = q.label.as_deref().map(str::trim).filter(|l| !l.is_empty()) {
    args.push(format!("--label={l}"));
  }
  if let Some(s) = q.search.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
    args.push(format!("--search={s}"));
  }
  Ok(args)
}

pub fn list(gh: &Path, dir: &Path, q: &IssueQuery) -> Result<Vec<Issue>, String> {
  let out = run_gh(gh, dir, "gh issue list", &list_args(q)?)?;
  parse_issues(&out)
}

pub fn view(gh: &Path, dir: &Path, number: u64) -> Result<IssueDetail, String> {
  let out = run_gh(gh, dir, "gh issue view", &["issue".into(), "view".into(), number.to_string(), format!("--json={VIEW_FIELDS}")])?;
  parse_issue_view(&out)
}

pub fn comment(gh: &Path, dir: &Path, number: u64, body: &str) -> Result<(), String> {
  if body.trim().is_empty() || body.len() > MAX_COMMENT_POST {
    return Err(format!("ข้อความ comment ต้องยาว 1-{MAX_COMMENT_POST} bytes"));
  }
  run_gh(gh, dir, "gh issue comment", &["issue".into(), "comment".into(), number.to_string(), format!("--body={body}")]).map(|_| ())
}

/// Opens the issue in the browser (`gh issue view --web`), whatever host the repository is on.
pub fn open_web(gh: &Path, dir: &Path, number: u64) -> Result<(), String> {
  run_gh(gh, dir, "gh issue view --web", &["issue".into(), "view".into(), number.to_string(), "--web".into()]).map(|_| ())
}

#[cfg(test)]
mod tests {
  use super::*;

  const LIST: &str = r#"[
    {"assignees":[{"id":"MDQ6","login":"octocat","name":"The Octocat"}],
     "author":{"id":"U_1","is_bot":false,"login":"hubot","name":"Hubot"},
     "body":"Login fails on Safari.\n\nSteps: …",
     "labels":[{"id":"LA_1","name":"bug","description":"Something is broken","color":"d73a4a"},{"id":"LA_2","name":"good first issue","description":"","color":"7057ff"}],
     "number":42,"state":"OPEN","title":"แก้ login บน Safari","updatedAt":"2026-10-01T08:30:00Z",
     "url":"https://github.com/acme/app/issues/42"},
    {"assignees":[],"author":{"login":"app/dependabot","is_bot":true},"body":null,"labels":[],
     "number":7,"state":"OPEN","title":"Bump x","updatedAt":"2026-09-01T00:00:00Z","url":"https://github.com/acme/app/issues/7"}
  ]"#;

  #[test]
  fn parses_issue_lists_with_labels_assignees_and_null_body() {
    let issues = parse_issues(LIST).unwrap();
    assert_eq!(issues.len(), 2);
    let a = &issues[0];
    assert_eq!((a.number, a.title.as_str(), a.state.as_str()), (42, "แก้ login บน Safari", "OPEN"));
    assert_eq!(a.labels, [IssueLabel { name: "bug".into(), color: "d73a4a".into() }, IssueLabel { name: "good first issue".into(), color: "7057ff".into() }]);
    assert_eq!((a.assignees.as_slice(), a.author.as_str()), (["octocat".to_owned()].as_slice(), "hubot"));
    assert_eq!((a.updated_at.as_str(), a.url.as_str()), ("2026-10-01T08:30:00Z", "https://github.com/acme/app/issues/42"));
    let b = &issues[1];
    assert_eq!((b.body.as_str(), b.body_truncated, b.labels.len(), b.assignees.len()), ("", false, 0, 0));
    assert_eq!(parse_issues("[]").unwrap(), []);
    assert!(parse_issues("{}").is_err());
    assert!(parse_issues("not json").is_err());
    assert!(parse_issues(r#"[{"title":"no number"}]"#).is_err());
  }

  #[test]
  fn truncates_long_bodies_on_a_char_boundary() {
    let body = "ก".repeat(MAX_BODY); // 3 bytes each
    let json = serde_json::json!([{ "number": 1, "title": "t", "body": body }]).to_string();
    let i = &parse_issues(&json).unwrap()[0];
    assert!(i.body_truncated);
    assert!(i.body.len() <= MAX_BODY && i.body.chars().all(|c| c == 'ก'));
    assert_eq!(truncate("abc", 3), ("abc".into(), false));
    assert_eq!(truncate("aก", 2), ("a".into(), true));
  }

  #[test]
  fn parses_an_issue_view_keeping_the_latest_comments() {
    let comments: Vec<_> =
      (0..MAX_COMMENTS + 3).map(|i| serde_json::json!({ "author": { "login": format!("u{i}") }, "body": format!("c{i}"), "createdAt": "2026-10-02T00:00:00Z" })).collect();
    let json = serde_json::json!({ "number": 3, "title": "T", "url": "u", "state": "OPEN", "body": "b", "labels": [], "assignees": [], "author": { "login": "me" }, "comments": comments }).to_string();
    let d = parse_issue_view(&json).unwrap();
    assert_eq!((d.issue.number, d.comments.len(), d.comments_omitted), (3, MAX_COMMENTS, 3));
    assert_eq!((d.comments[0].author.as_str(), d.comments[0].body.as_str()), ("u3", "c3"));
    let none = parse_issue_view(r#"{"number":4,"title":"x","body":null}"#).unwrap();
    assert_eq!((none.comments.len(), none.comments_omitted, none.issue.body.as_str()), (0, 0, ""));
  }

  #[test]
  fn explains_gh_failures_in_thai() {
    assert!(gh_error("gh issue list", "To get started with GitHub CLI, please run:  gh auth login").contains("gh auth login"));
    assert!(gh_error("gh issue list", "no git remotes found").contains("remote"));
    assert!(gh_error("gh issue list", "none of the git remotes configured for this repository point to a known GitHub host").contains("remote"));
    assert!(gh_error("gh issue list", "failed to run git: fatal: not a git repository").contains("remote"));
    assert!(gh_error("gh issue list", "GraphQL: Could not resolve to a Repository with the name 'a/b'.").contains("ไม่พบ repository"));
    assert!(gh_error("gh issue list", "the 'acme/app' repository has disabled issues").contains("ปิด Issues"));
    assert_eq!(gh_error("gh issue list", "\n  something odd\nmore"), "gh issue list: something odd");
  }

  #[test]
  fn builds_list_arguments_and_refuses_bad_filters() {
    let q = IssueQuery { state: "open".into(), assignee: Some("@me".into()), label: Some(" bug ".into()), search: Some("--web login".into()), limit: 1000 };
    assert_eq!(
      list_args(&q).unwrap(),
      ["issue", "list", "--state=open", "--limit=200", &format!("--json={LIST_FIELDS}"), "--assignee=@me", "--label=bug", "--search=--web login"]
    );
    let any = IssueQuery { state: "all".into(), limit: 0, ..Default::default() };
    assert_eq!(list_args(&any).unwrap().len(), 5);
    assert!(list_args(&IssueQuery { state: "weird".into(), limit: 5, ..Default::default() }).is_err());
    assert!(list_args(&IssueQuery { state: "open".into(), assignee: Some("-x".into()), limit: 5, ..Default::default() }).is_err());
    assert!(list_args(&IssueQuery { state: "open".into(), assignee: Some("a b".into()), limit: 5, ..Default::default() }).is_err());
  }

  #[test]
  fn refuses_empty_comments_without_running_gh() {
    let missing = Path::new("/nonexistent/gh");
    assert!(comment(missing, Path::new("/"), 1, "  ").is_err());
    assert_eq!(list(missing, Path::new("/"), &IssueQuery { state: "open".into(), limit: 5, ..Default::default() }).unwrap_err(), GH_MISSING);
  }
}
