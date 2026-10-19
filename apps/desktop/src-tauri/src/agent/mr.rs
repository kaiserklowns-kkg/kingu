//! GitLab merge requests in the ADE's PR flow, over GitLab's REST API with the token `gitlab.rs`
//! keeps in the Keychain: creating one (draft, target branch, a stacked parent's branch), its
//! status (state, mergeability, approvals), the head pipeline's jobs as checks, merging, failed
//! job logs and discussions as review threads. The PR commands in `agent/mod.rs` ask [`forge`]
//! which service the folder's `origin` is on and come here for GitLab, so the webview calls the
//! same commands either way. A merge request reads back in gh's `pr view --json` shape (`raw`,
//! what the Checks side bar renders) and as Kingu's [`PrStatus`] parsed from that, so every view
//! treats it like a pull request. A fork's merge requests go into the project it was forked from
//! ([`Route`]). The Checks tab's own actions (close, reopen, ready, auto-merge, title, comments,
//! replies) are here too, for `agent/forge.rs`. Parsing is pure; the tests replay recorded API
//! responses (`fixtures/gitlab`).

use std::path::Path;

use serde_json::{json, Value};

use crate::gitlab;
use crate::i18n::msg::{AgentMsg, ForgeMsg, MrMsg, TrackerMsg};
use crate::tr;
use crate::tracker_http::{common_error, text, Request, Transport};

use super::pr::{merge_blocker, slice_log_tail, CheckLog, CheckRef, MergeMethod, MergeOutcome, RepoMergeSettings, ReviewThread, ThreadComment, LOG_JOB_LIMIT};
use super::review::{pr_status_of, GhStatus, WorktreePr};

const GITLAB_COM: &str = "gitlab.com";
/// Merge requests of one source branch looked at (an open one wins over newer closed ones).
const BRANCH_MRS: u32 = 20;
const MAX_TITLE: usize = 255;
const MAX_DESCRIPTION: usize = 1_000_000;
/// A job log is cut to its end before slicing; the excerpt only needs the tail.
const TRACE_TAIL: usize = 8 * 1024 * 1024;

/// A GitLab project on a host: `gitlab.com` + `group/sub/app`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Project {
  pub host: String,
  pub path: String,
}

impl Project {
  fn api(&self, rest: &str) -> String {
    format!("/projects/{}{rest}", self.path.replace('/', "%2F"))
  }

  fn mr(&self, iid: u64, rest: &str) -> String {
    self.api(&format!("/merge_requests/{iid}{rest}"))
  }
}

/// Where a folder's merge requests go: from its own project (`source`, `origin`) into `target`,
/// the project it was forked from when it is a fork (as `gh pr create` targets a fork's parent),
/// else itself. The ids are GitLab's numeric project ids, which the create request takes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Route {
  pub source: Project,
  pub source_id: u64,
  pub target: Project,
  pub target_id: u64,
}

impl Route {
  pub fn is_fork(&self) -> bool {
    self.source_id != self.target_id
  }
}

/// Where a folder's pull requests live.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Forge {
  /// GitHub (or anything else): `gh`.
  Github,
  Gitlab(Project),
}

/// Hosts a GitLab remote may be on: gitlab.com and `kingu.gitlab.host` (a self-hosted GitLab,
/// set when connecting to it).
pub fn gitlab_hosts(configured: Option<&str>) -> Vec<String> {
  let mut hosts = vec![GITLAB_COM.to_owned()];
  if let Some(h) = configured.and_then(|h| gitlab::host_or_err(h).ok())
    && h != GITLAB_COM
  {
    hosts.push(h);
  }
  hosts
}

/// The GitLab project of remote URL `remote` on one of `hosts` (a configured host with a port
/// keeps it, the API is reached there).
pub fn project_of_remote(remote: &str, hosts: &[String]) -> Option<Project> {
  hosts.iter().find_map(|h| gitlab::project_from_remote(remote, h).map(|path| Project { host: h.clone(), path }))
}

/// Which service the PRs of the repository in `dir` live on, from its `origin` remote.
pub fn forge(dir: &Path) -> Forge {
  let Ok(out) = crate::git::run(dir, &["remote", "get-url", "origin"]) else { return Forge::Github };
  let configured = crate::system::config_dir().and_then(|d| crate::settings::user_value(d, "kingu.gitlab.host"));
  let hosts = gitlab_hosts(configured.as_ref().and_then(Value::as_str));
  project_of_remote(&String::from_utf8_lossy(&out), &hosts).map_or(Forge::Github, Forge::Gitlab)
}

/// The route of `source` from its project as `GET /projects/:id` returns it. A parent the token
/// may not see is left out of that response, so the fork then targets itself.
pub fn parse_route(source: &Project, v: &Value) -> Result<Route, String> {
  let source_id = v["id"].as_u64().ok_or_else(|| tr!(ForgeMsg::NoProjectId, project = source.path))?;
  let parent = &v["forked_from_project"];
  let target = match (parent["id"].as_u64(), parent["path_with_namespace"].as_str().filter(|p| gitlab::valid_project(p))) {
    (Some(id), Some(path)) if id != source_id => Some((Project { host: source.host.clone(), path: path.to_owned() }, id)),
    _ => None,
  };
  let (target, target_id) = target.unwrap_or_else(|| (source.clone(), source_id));
  Ok(Route { source: source.clone(), source_id, target, target_id })
}

pub fn route(t: &dyn Transport, p: &Project) -> Result<Route, String> {
  parse_route(p, &call(t, Request::get(p.api("")))?)
}

/// `gh_status` for a GitLab folder: always "installed"; signed in when a token for its host is stored.
pub fn status(p: &Project) -> GhStatus {
  let authenticated = gitlab::stored_token(&p.host).is_some();
  let detail = if authenticated { tr!(MrMsg::Connected, host = p.host) } else { tr!(TrackerMsg::GitlabNotConnected, host = p.host) };
  GhStatus { installed: true, authenticated, path: None, detail, provider: "gitlab" }
}

/// `https://<host>/<group/app>/-/merge_requests/<iid>` → the project and iid; only on `expected`'s
/// host, so the token never goes to a host the folder is not on.
pub fn parse_url(url: &str, expected: &Project) -> Result<(Project, u64), String> {
  let bad = || tr!(MrMsg::BadUrl, url = format!("{url:?}"));
  let u = url::Url::parse(url).map_err(|_| bad())?;
  let host = match (u.host_str(), u.port()) {
    (Some(h), Some(p)) => format!("{h}:{p}"),
    (Some(h), None) => h.to_owned(),
    _ => return Err(bad()),
  };
  if u.scheme() != "https" {
    return Err(bad());
  }
  if !host.eq_ignore_ascii_case(&expected.host) {
    return Err(tr!(MrMsg::OtherHost, host, expected = expected.host));
  }
  let (path, iid) = u.path().trim_start_matches('/').split_once("/-/merge_requests/").ok_or_else(bad)?;
  let iid = iid.split('/').next().and_then(|n| n.parse::<u64>().ok()).filter(|n| *n > 0).ok_or_else(bad)?;
  if !gitlab::valid_project(path) {
    return Err(bad());
  }
  Ok((Project { host: expected.host.clone(), path: path.to_owned() }, iid))
}

// ---------------------------------------------------------------------------------------------
// Responses

/// GitLab's error text: `message` as a string, a list or field errors (`{"title":["is too long"]}`), or `error`.
pub fn error_text(body: &str) -> String {
  let Ok(v) = serde_json::from_str::<Value>(body) else { return body.trim().chars().take(300).collect() };
  let m = if v["message"].is_null() { &v["error"] } else { &v["message"] };
  match m {
    Value::String(s) => s.clone(),
    Value::Array(a) => a.iter().map(|x| x.as_str().map_or_else(|| x.to_string(), str::to_owned)).collect::<Vec<_>>().join("; "),
    Value::Object(o) => o
      .iter()
      .map(|(k, errs)| {
        let errs = errs.as_array().map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")).unwrap_or_else(|| errs.to_string());
        format!("{k} {errs}")
      })
      .collect::<Vec<_>>()
      .join("; "),
    _ => body.trim().chars().take(300).collect(),
  }
}

/// The data of a response, or a message the user can act on.
pub fn answer(status: u16, body: &str) -> Result<Value, String> {
  match status {
    403 => Err(tr!(MrMsg::Forbidden)),
    404 => Err(tr!(MrMsg::NotFound)),
    // Merge: 405 not mergeable now, 406 conflicts, 409 the `sha` moved, 422 failed.
    405 | 406 | 422 => Err(tr!(MrMsg::NotMergeable, detail = error_text(body))),
    409 if body.contains("SHA") => Err(tr!(MrMsg::HeadMoved)),
    400 | 409 => Err(format!("GitLab: {}", error_text(body))),
    _ => gitlab::response(status, body),
  }
}

fn call(t: &dyn Transport, req: Request) -> Result<Value, String> {
  let (status, body) = t.send(&req)?;
  answer(status, &body)
}

// ---------------------------------------------------------------------------------------------
// Status in gh's shape

/// `Draft: x`, `[Draft] x`, `(Draft) x` → `x` (GitLab marks drafts in the title).
pub fn strip_draft(title: &str) -> &str {
  let t = title.trim_start();
  for prefix in ["draft:", "[draft]", "(draft)"] {
    if t.len() >= prefix.len() && t.is_char_boundary(prefix.len()) && t[..prefix.len()].eq_ignore_ascii_case(prefix) {
      return t[prefix.len()..].trim_start();
    }
  }
  title
}

/// `OPEN` / `MERGED` / `CLOSED` (a locked MR is closed for Kingu).
fn state_of(mr: &Value) -> &'static str {
  match mr["state"].as_str().unwrap_or_default() {
    "opened" => "OPEN",
    "merged" => "MERGED",
    _ => "CLOSED",
  }
}

/// gh's `mergeable` and `mergeStateStatus` from GitLab's `detailed_merge_status`.
pub fn merge_states(mr: &Value) -> (&'static str, &'static str) {
  let detailed = mr["detailed_merge_status"].as_str().unwrap_or_default();
  if mr["has_conflicts"].as_bool() == Some(true) || matches!(detailed, "conflict" | "broken_status") {
    return ("CONFLICTING", "DIRTY");
  }
  match detailed {
    "mergeable" => ("MERGEABLE", "CLEAN"),
    "unchecked" | "checking" | "preparing" | "approvals_syncing" => ("UNKNOWN", "UNKNOWN"),
    "need_rebase" => ("MERGEABLE", "BEHIND"),
    "draft_status" => ("MERGEABLE", "DRAFT"),
    // Older GitLab: only `merge_status`.
    "" => match mr["merge_status"].as_str().unwrap_or_default() {
      "can_be_merged" => ("MERGEABLE", "CLEAN"),
      "cannot_be_merged" => ("CONFLICTING", "DIRTY"),
      _ => ("UNKNOWN", "UNKNOWN"),
    },
    // not_approved, ci_must_pass, ci_still_running, discussions_not_resolved, blocked_status, …
    _ => ("MERGEABLE", "BLOCKED"),
  }
}

/// gh's `reviewDecision` from the MR and its approvals (`Value::Null` when they could not be read).
pub fn review_decision(mr: &Value, approvals: &Value) -> &'static str {
  let detailed = mr["detailed_merge_status"].as_str().unwrap_or_default();
  if detailed == "requested_changes" {
    return "CHANGES_REQUESTED";
  }
  if approvals["approvals_left"].as_u64().is_some_and(|n| n > 0) || detailed == "not_approved" {
    return "REVIEW_REQUIRED";
  }
  if approvals["approved_by"].as_array().is_some_and(|a| !a.is_empty()) {
    return "APPROVED";
  }
  ""
}

/// A pipeline job as a gh check run: `stage / name`, its status and conclusion, the job page.
pub fn job_check(job: &Value) -> Value {
  let allow_failure = job["allow_failure"].as_bool() == Some(true);
  let (status, conclusion) = match job["status"].as_str().unwrap_or_default() {
    "created" | "pending" | "waiting_for_resource" | "preparing" | "scheduled" | "waiting_for_callback" => ("QUEUED", ""),
    "running" | "canceling" => ("IN_PROGRESS", ""),
    "success" => ("COMPLETED", "SUCCESS"),
    "failed" if allow_failure => ("COMPLETED", "NEUTRAL"),
    "failed" => ("COMPLETED", "FAILURE"),
    "canceled" => ("COMPLETED", "CANCELLED"),
    "skipped" => ("COMPLETED", "SKIPPED"),
    // A manual job waits for someone to start it; it is no failure.
    _ => ("COMPLETED", "NEUTRAL"),
  };
  json!({
    "__typename": "CheckRun",
    "workflowName": text(job, "stage"),
    "name": text(job, "name"),
    "status": status,
    "conclusion": conclusion,
    "detailsUrl": text(job, "web_url"),
  })
}

/// The merge request as `gh pr view --json` would report a pull request: the fields
/// `review::PR_FIELDS` and `PR_VIEW_FIELDS` name, plus `headRefOid` and `isCrossRepository`.
pub fn gh_json(mr: &Value, approvals: &Value, jobs: &Value) -> Value {
  let (mergeable, merge_state) = merge_states(mr);
  // GitLab lists the newest job first; gh lists checks in pipeline order.
  let mut checks: Vec<Value> = jobs.as_array().map(|a| a.iter().map(job_check).collect()).unwrap_or_default();
  checks.reverse();
  json!({
    "number": mr["iid"],
    "url": text(mr, "web_url"),
    "title": strip_draft(mr["title"].as_str().unwrap_or_default()),
    "state": state_of(mr),
    "isDraft": mr["draft"].as_bool().or(mr["work_in_progress"].as_bool()).unwrap_or(false),
    "reviewDecision": review_decision(mr, approvals),
    "mergeable": mergeable,
    "mergeStateStatus": merge_state,
    "headRefName": text(mr, "source_branch"),
    "headRefOid": text(mr, "sha"),
    "baseRefName": text(mr, "target_branch"),
    "isCrossRepository": mr["source_project_id"] != mr["target_project_id"],
    "statusCheckRollup": checks,
    "author": { "login": text(&mr["author"], "username") },
    "createdAt": text(mr, "created_at"),
    "autoMergeRequest": if mr["merge_when_pipeline_succeeds"].as_bool() == Some(true) { json!({ "enabledAt": text(mr, "updated_at") }) } else { Value::Null },
    "provider": "gitlab",
  })
}

/// The merge request of `branch` to show: an open one, else the most recently updated; only one
/// from `source_id` (another fork's branch of the same name is someone else's work).
pub fn pick_for_branch(list: &Value, source_id: u64) -> Option<u64> {
  let list: Vec<&Value> = list.as_array()?.iter().filter(|m| m["source_project_id"].as_u64() == Some(source_id)).collect();
  let open = list.iter().find(|m| m["state"] == "opened");
  open.or_else(|| list.first()).and_then(|m| m["iid"].as_u64())
}

/// The merge request of `branch`, looked up in the route's target (where a fork's MR lives).
pub fn find(t: &dyn Transport, r: &Route, branch: &str) -> Result<Option<u64>, String> {
  let query = url::form_urlencoded::Serializer::new(String::new())
    .append_pair("source_branch", branch)
    .append_pair("order_by", "updated_at")
    .append_pair("sort", "desc")
    .append_pair("per_page", &BRANCH_MRS.to_string())
    .finish();
  Ok(pick_for_branch(&call(t, Request::get(r.target.api(&format!("/merge_requests?{query}"))))?, r.source_id))
}

/// One merge request with its approvals and head pipeline's jobs. Approvals and jobs are extras:
/// when GitLab will not give them (an older server, no access to pipelines), the MR still shows.
pub fn view(t: &dyn Transport, p: &Project, iid: u64) -> Result<WorktreePr, String> {
  let mr = call(t, Request::get(p.mr(iid, "")))?;
  let approvals = call(t, Request::get(p.mr(iid, "/approvals"))).unwrap_or_else(|e| {
    log::info!("gitlab approvals of !{iid}: {e}");
    Value::Null
  });
  let jobs = match mr["head_pipeline"]["id"].as_u64() {
    Some(pipeline) => call(t, Request::get(pipeline_jobs_path(p, &mr, pipeline))).unwrap_or_else(|e| {
      log::info!("gitlab jobs of pipeline {pipeline}: {e}");
      Value::Null
    }),
    None => Value::Null,
  };
  let raw = gh_json(&mr, &approvals, &jobs);
  Ok(WorktreePr { status: pr_status_of(&raw)?, raw })
}

/// The jobs of the MR's head pipeline: a fork's MR may run its pipeline in the fork's project.
fn pipeline_jobs_path(p: &Project, mr: &Value, pipeline: u64) -> String {
  let rest = format!("/pipelines/{pipeline}/jobs?per_page=100");
  match mr["head_pipeline"]["project_id"].as_u64() {
    Some(id) if Some(id) != mr["target_project_id"].as_u64() => format!("/projects/{id}{rest}"),
    _ => p.api(&rest),
  }
}

/// The merge request of the task branch (`slug`), or of the branch checked out in `dir`.
pub fn worktree_mr(t: &dyn Transport, r: &Route, dir: &Path, slug: Option<&str>) -> Result<Option<WorktreePr>, String> {
  let branch = match slug {
    Some(slug) => super::worktree::task_branch(dir, slug)?,
    None => match super::worktree::current_branch(dir)? {
      Some(b) => b,
      None => return Ok(None),
    },
  };
  match find(t, r, &branch)? {
    Some(iid) => view(t, &r.target, iid).map(Some),
    None => Ok(None),
  }
}

// ---------------------------------------------------------------------------------------------
// Create

/// `title` with GitLab's `Draft:` mark when `draft` (kept as it is when already marked).
fn draft_title(title: &str, draft: bool) -> String {
  let title = title.trim();
  if draft && strip_draft(title) == title { format!("Draft: {title}") } else { title.to_owned() }
}

/// The create request: GitLab marks a draft with a `Draft:` title; `target` without `origin/`. It
/// is sent to the source project; a fork's names its parent as `target_project_id`.
pub fn create_body(r: &Route, source: &str, target: &str, title: &str, body: &str, draft: bool) -> Value {
  let mut v = json!({
    "source_branch": source,
    "target_branch": target.strip_prefix("origin/").unwrap_or(target),
    "title": draft_title(title, draft),
    "description": body,
    "remove_source_branch": false,
  });
  if r.is_fork() {
    v["target_project_id"] = json!(r.target_id);
  }
  v
}

/// Opens the merge request (the branch is already pushed); returns its URL.
pub fn create(t: &dyn Transport, r: &Route, source: &str, target: &str, title: &str, body: &str, draft: bool) -> Result<String, String> {
  if title.trim().is_empty() {
    return Err(tr!(MrMsg::EmptyTitle));
  }
  let v = call(t, Request::post(r.source.api("/merge_requests"), create_body(r, source, target, &truncate(title, MAX_TITLE), &truncate(body, MAX_DESCRIPTION), draft)))?;
  let url = text(&v, "web_url");
  if url.is_empty() { Err(tr!(MrMsg::NoLink)) } else { Ok(url) }
}

fn truncate(s: &str, max: usize) -> String {
  crate::agent::issues::truncate(s, max).0
}

/// Pushes the task branch (and a stacked parent's branch first) and opens its merge request.
#[allow(clippy::too_many_arguments)]
pub fn push_and_create(t: &dyn Transport, r: &Route, dir: &Path, slug: &str, base: &str, title: &str, body: &str, draft: bool, stacked: bool) -> Result<String, String> {
  crate::git::check_rev(base)?;
  if title.trim().is_empty() {
    return Err(tr!(MrMsg::EmptyTitle));
  }
  if stacked {
    super::review::push_stack_base(dir, base)?;
  }
  let branch = super::review::push_task_branch(dir, slug)?;
  create(t, r, &branch, base, title, body, draft)
}

// ---------------------------------------------------------------------------------------------
// Merge

pub fn parse_settings(v: &Value) -> RepoMergeSettings {
  let squash_option = v["squash_option"].as_str().unwrap_or("default_off");
  // GitLab's project merge method decides what an unsquashed merge does.
  let rebases = matches!(v["merge_method"].as_str(), Some("rebase_merge" | "ff"));
  let plain = squash_option != "always";
  RepoMergeSettings {
    squash: squash_option != "never",
    merge: plain && !rebases,
    rebase: plain && rebases,
    default: match (squash_option, rebases) {
      ("always" | "default_on", _) => "SQUASH",
      (_, true) => "REBASE",
      _ => "MERGE",
    }
    .to_owned(),
  }
}

pub fn merge_settings(t: &dyn Transport, p: &Project) -> Result<RepoMergeSettings, String> {
  Ok(parse_settings(&call(t, Request::get(p.api("")))?))
}

/// Merges after re-reading the MR (the same preflight as a GitHub PR), pinned to the head commit
/// it was read at. `delete_branch` removes the source branch on GitLab, never a fork's.
pub fn merge(t: &dyn Transport, p: &Project, iid: u64, method: MergeMethod, delete_branch: bool) -> Result<MergeOutcome, String> {
  let pr = view(t, p, iid)?;
  if pr.status.number != iid {
    return Err(tr!(AgentMsg::PrViewWrongNumber, got = pr.status.number, number = iid));
  }
  if pr.status.state == "OPEN" && pr.status.draft {
    return Err(tr!(MrMsg::Draft));
  }
  if let Some(why) = merge_blocker(&pr.status) {
    return Err(why);
  }
  let cross = pr.raw["isCrossRepository"].as_bool().unwrap_or(true);
  let branch = pr.status.head_ref.clone();
  let remove = delete_branch && !cross && !branch.is_empty();
  let mut body = json!({ "squash": method == MergeMethod::Squash, "should_remove_source_branch": remove });
  if let Some(sha) = pr.raw["headRefOid"].as_str().filter(|s| !s.is_empty()) {
    body["sha"] = json!(sha);
  }
  let v = call(t, Request::put(p.mr(iid, "/merge"), body))?;
  let state = text(&v, "state");
  if state != "merged" {
    return Err(tr!(MrMsg::NotMerged, state));
  }
  log::info!("merged GitLab MR !{iid} ({method:?})");
  Ok(match (delete_branch, remove) {
    (false, _) => MergeOutcome { deleted_branch: None, branch_note: None },
    (true, true) => MergeOutcome { deleted_branch: Some(branch), branch_note: None },
    (true, false) => MergeOutcome { deleted_branch: None, branch_note: Some(tr!(AgentMsg::ForkBranchKept)) },
  })
}

// ---------------------------------------------------------------------------------------------
// Failed job logs

fn job_trace(t: &dyn Transport, p: &Project, job: u64) -> Result<String, String> {
  let (status, body) = t.send(&Request::get(p.api(&format!("/jobs/{job}/trace"))))?;
  if (200..300).contains(&status) {
    let start = body.len().saturating_sub(TRACE_TAIL);
    let start = (start..=body.len()).find(|&i| body.is_char_boundary(i)).unwrap_or(body.len());
    return Ok(slice_log_tail(&body[start..]));
  }
  if let Some(e) = common_error("GitLab", status) {
    return Err(e);
  }
  if matches!(status, 401 | 403 | 404) {
    return answer(status, &body).and(Err(tr!(MrMsg::LogUnavailable, status)));
  }
  // A redirect to object storage is not followed (it could carry the token elsewhere).
  Err(tr!(MrMsg::LogUnavailable, status))
}

/// The project and job id of a job page (`https://<host>/<group/app>/-/jobs/<id>`): a fork's
/// pipeline runs in the fork. Only on `p`'s host.
pub fn job_of_url(url: &str, p: &Project) -> Option<(Project, u64)> {
  let (host, path) = url.strip_prefix("https://")?.split_once('/')?;
  let (path, rest) = path.split_once("/-/jobs/")?;
  let job = rest.split(['/', '?', '#']).next()?.parse::<u64>().ok().filter(|n| *n > 0)?;
  (host.eq_ignore_ascii_case(&p.host) && gitlab::valid_project(path)).then(|| (Project { host: p.host.clone(), path: path.to_owned() }, job))
}

/// The failed log excerpt of the job behind a check's link (the Checks tab's details).
pub fn job_log(t: &dyn Transport, p: &Project, url: &str) -> Result<String, String> {
  let (project, job) = job_of_url(url, p).ok_or_else(|| tr!(ForgeMsg::NoCheckDetails))?;
  job_trace(t, &project, job)
}

/// Log excerpts of the failed jobs behind `checks` (their job ids come from the job URLs), at most
/// [`LOG_JOB_LIMIT`] logs in all; every check gets an entry so the prompt lists it.
pub fn check_logs(t: &dyn Transport, p: &Project, checks: &[CheckRef]) -> Vec<CheckLog> {
  let mut budget = LOG_JOB_LIMIT;
  checks
    .iter()
    .map(|c| {
      let (mut log_tail, mut error) = (None, None);
      if let Some(job) = c.job_id
        && budget > 0
      {
        budget -= 1;
        let project = c.url.as_deref().and_then(|u| job_of_url(u, p)).map_or_else(|| p.clone(), |(project, _)| project);
        match job_trace(t, &project, job) {
          Ok(tail) if !tail.trim().is_empty() => log_tail = Some(tail),
          Ok(_) => {}
          Err(e) => error = Some(e),
        }
      }
      CheckLog { name: c.name.clone(), log_tail, error }
    })
    .collect()
}

// ---------------------------------------------------------------------------------------------
// Discussions as review threads

/// Resolvable discussions (diff threads and threaded comments) as review threads; plain comments
/// and system notes are left out, like GitHub's conversation is.
pub fn parse_discussions(v: &Value, mr_url: &str) -> Vec<ReviewThread> {
  let base = mr_url.split('#').next().unwrap_or(mr_url);
  v.as_array()
    .map(Vec::as_slice)
    .unwrap_or_default()
    .iter()
    .filter_map(|d| {
      let id = d["id"].as_str()?.to_owned();
      let notes: Vec<&Value> = d["notes"].as_array()?.iter().filter(|n| n["system"].as_bool() != Some(true)).collect();
      let first = *notes.first()?;
      if d["individual_note"].as_bool() == Some(true) || first["resolvable"].as_bool() != Some(true) {
        return None;
      }
      let position = &first["position"];
      let path = position["new_path"].as_str().or(position["old_path"].as_str()).map(str::to_owned);
      let line = position["new_line"].as_u64().or(position["old_line"].as_u64());
      let start = &position["line_range"]["start"];
      let start_line = start["new_line"].as_u64().or(start["old_line"].as_u64()).filter(|s| Some(*s) != line);
      let comments = notes
        .iter()
        .map(|n| {
          let id = n["id"].as_u64().unwrap_or_default();
          ThreadComment { id, author: text(&n["author"], "username"), body: text(n, "body"), created_at: text(n, "created_at"), url: format!("{base}#note_{id}") }
        })
        .collect();
      Some(ReviewThread {
        id,
        resolved: notes.iter().filter(|n| n["resolvable"].as_bool() == Some(true)).all(|n| n["resolved"].as_bool() == Some(true)),
        // GitLab keeps a diff note on the line it was written for; it has no "outdated" flag.
        outdated: false,
        path,
        line,
        start_line,
        comments,
      })
    })
    .collect()
}

pub fn threads(t: &dyn Transport, p: &Project, iid: u64, mr_url: &str) -> Result<Vec<ReviewThread>, String> {
  Ok(parse_discussions(&call(t, Request::get(p.mr(iid, "/discussions?per_page=100")))?, mr_url))
}

/// A discussion id as GitLab issues them (40 hex digits).
pub fn valid_discussion_id(id: &str) -> bool {
  !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Resolves (or reopens) discussion `id`; returns its new state.
pub fn resolve(t: &dyn Transport, p: &Project, iid: u64, id: &str, resolved: bool) -> Result<bool, String> {
  if !valid_discussion_id(id) {
    return Err(tr!(MrMsg::BadDiscussion, id = format!("{id:?}")));
  }
  let v = call(t, Request::put(p.mr(iid, &format!("/discussions/{id}")), json!({ "resolved": resolved })))?;
  let notes = v["notes"].as_array().map(Vec::as_slice).unwrap_or_default();
  Ok(notes.iter().filter(|n| n["resolvable"].as_bool() == Some(true)).all(|n| n["resolved"].as_bool() == Some(true)) && !notes.is_empty())
}

/// Review threads in the shape of GitHub's GraphQL `reviewThreads` nodes, which the Checks tab
/// renders (GitLab notes take no reactions there yet, so none are listed).
pub fn thread_nodes(threads: &[ReviewThread]) -> Value {
  threads
    .iter()
    .map(|t| {
      let comments: Vec<Value> = t
        .comments
        .iter()
        .map(|c| json!({ "id": null, "databaseId": c.id, "author": { "login": c.author }, "body": c.body, "createdAt": c.created_at, "url": c.url, "reactionGroups": [] }))
        .collect();
      json!({ "id": t.id, "isResolved": t.resolved, "path": t.path.clone().unwrap_or_default(), "line": t.line, "comments": { "nodes": comments } })
    })
    .collect()
}

// ---------------------------------------------------------------------------------------------
// The Checks tab: state, title, comments

/// The merge request of the branch checked out in `dir` (the Checks tab acts on the selected
/// worktree's branch): its project and iid.
pub fn branch_mr(t: &dyn Transport, r: &Route, dir: &Path) -> Result<(Project, u64), String> {
  let branch = super::worktree::current_branch(dir)?.ok_or_else(|| tr!(ForgeMsg::NoBranch))?;
  let iid = find(t, r, &branch)?.ok_or_else(|| tr!(ForgeMsg::NoMergeRequest, branch))?;
  Ok((r.target.clone(), iid))
}

/// Closes or reopens the merge request.
pub fn set_open(t: &dyn Transport, p: &Project, iid: u64, open: bool) -> Result<(), String> {
  call(t, Request::put(p.mr(iid, ""), json!({ "state_event": if open { "reopen" } else { "close" } }))).map(drop)
}

/// Out of draft: GitLab keeps the draft mark in the title, so the title loses its `Draft:`.
pub fn mark_ready(t: &dyn Transport, p: &Project, iid: u64) -> Result<(), String> {
  let mr = call(t, Request::get(p.mr(iid, "")))?;
  let title = mr["title"].as_str().unwrap_or_default();
  let ready = strip_draft(title);
  if ready == title {
    return Ok(());
  }
  call(t, Request::put(p.mr(iid, ""), json!({ "title": ready }))).map(drop)
}

/// A new title (the Checks tab shows it without the draft mark, so a draft keeps its `Draft:`).
pub fn edit_title(t: &dyn Transport, p: &Project, iid: u64, title: &str) -> Result<(), String> {
  if title.trim().is_empty() {
    return Err(tr!(MrMsg::EmptyTitle));
  }
  let mr = call(t, Request::get(p.mr(iid, "")))?;
  let draft = mr["draft"].as_bool().or(mr["work_in_progress"].as_bool()).unwrap_or(false);
  call(t, Request::put(p.mr(iid, ""), json!({ "title": draft_title(&truncate(title, MAX_TITLE), draft) }))).map(drop)
}

/// Merge when the pipeline succeeds (GitLab's auto-merge), or stop waiting for it.
pub fn set_auto_merge(t: &dyn Transport, p: &Project, iid: u64, on: bool, squash: bool) -> Result<(), String> {
  if !on {
    return call(t, Request::post(p.mr(iid, "/cancel_merge_when_pipeline_succeeds"), json!({}))).map(drop);
  }
  // `auto_merge` is the newer name of `merge_when_pipeline_succeeds`; older servers ignore it.
  call(t, Request::put(p.mr(iid, "/merge"), json!({ "merge_when_pipeline_succeeds": true, "auto_merge": true, "squash": squash }))).map(drop)
}

/// The conversation in the shape of `gh pr view --json comments,reviews`: the comments outside
/// review threads (plain comments, and notes of discussions that cannot be resolved), oldest first.
pub fn conversation(discussions: &Value, mr_url: &str) -> Value {
  let base = mr_url.split('#').next().unwrap_or(mr_url);
  let comments: Vec<Value> = discussions
    .as_array()
    .map(Vec::as_slice)
    .unwrap_or_default()
    .iter()
    .filter(|d| {
      let first = d["notes"].as_array().and_then(|n| n.iter().find(|n| n["system"].as_bool() != Some(true)));
      d["individual_note"].as_bool() == Some(true) || first.is_some_and(|n| n["resolvable"].as_bool() != Some(true))
    })
    .flat_map(|d| d["notes"].as_array().map(Vec::as_slice).unwrap_or_default())
    .filter(|n| n["system"].as_bool() != Some(true))
    .map(|n| {
      let id = n["id"].as_u64().unwrap_or_default();
      json!({ "id": null, "author": { "login": text(&n["author"], "username") }, "body": text(n, "body"), "createdAt": text(n, "created_at"), "url": format!("{base}#note_{id}"), "reactionGroups": [] })
    })
    .collect();
  json!({ "comments": comments, "reviews": [] })
}

pub fn comments(t: &dyn Transport, p: &Project, iid: u64, mr_url: &str) -> Result<Value, String> {
  Ok(conversation(&call(t, Request::get(p.mr(iid, "/discussions?per_page=100")))?, mr_url))
}

pub fn comment(t: &dyn Transport, p: &Project, iid: u64, body: &str) -> Result<(), String> {
  call(t, Request::post(p.mr(iid, "/notes"), json!({ "body": body }))).map(drop)
}

/// A reply inside discussion `id`.
pub fn reply(t: &dyn Transport, p: &Project, iid: u64, id: &str, body: &str) -> Result<(), String> {
  if !valid_discussion_id(id) {
    return Err(tr!(MrMsg::BadDiscussion, id = format!("{id:?}")));
  }
  call(t, Request::post(p.mr(iid, &format!("/discussions/{id}/notes")), json!({ "body": body }))).map(drop)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::tracker_http::fake::Fake;
  use crate::tracker_http::Method;

  fn fixture(name: &str) -> Value {
    let text = match name {
      "mr" => include_str!("fixtures/gitlab/mr.json"),
      "mr_list" => include_str!("fixtures/gitlab/mr_list.json"),
      "approvals" => include_str!("fixtures/gitlab/approvals.json"),
      "pipeline_jobs" => include_str!("fixtures/gitlab/pipeline_jobs.json"),
      "discussions" => include_str!("fixtures/gitlab/discussions.json"),
      "project" => include_str!("fixtures/gitlab/project.json"),
      "merged" => include_str!("fixtures/gitlab/merged.json"),
      "created" => include_str!("fixtures/gitlab/created.json"),
      "fork_project" => include_str!("fixtures/gitlab/fork_project.json"),
      "fork_mr_list" => include_str!("fixtures/gitlab/fork_mr_list.json"),
      _ => unreachable!(),
    };
    serde_json::from_str(text).unwrap()
  }

  fn project() -> Project {
    Project { host: "gitlab.com".into(), path: "acme/sub/app".into() }
  }

  /// The folder's origin is the project itself.
  fn own() -> Route {
    parse_route(&project(), &fixture("project")).unwrap()
  }

  /// The folder's origin is kawin's fork of acme/sub/app.
  fn fork() -> Route {
    parse_route(&Project { host: "gitlab.com".into(), path: "kawin/app".into() }, &fixture("fork_project")).unwrap()
  }

  /// The MR ready to merge: approved, out of draft, mergeable.
  fn ready_mr() -> Value {
    let mut mr = fixture("mr");
    mr["draft"] = json!(false);
    mr["work_in_progress"] = json!(false);
    mr["title"] = json!("แก้ login ค้างหลัง OAuth");
    mr["detailed_merge_status"] = json!("mergeable");
    mr["head_pipeline"] = Value::Null;
    mr
  }

  const MR_URL: &str = "https://gitlab.com/acme/sub/app/-/merge_requests/12";

  #[test]
  fn finds_gitlab_remotes_on_gitlab_com_and_the_configured_host() {
    let hosts = gitlab_hosts(Some(" https://Git.Acme.dev:8443/ "));
    assert_eq!(hosts, ["gitlab.com", "git.acme.dev:8443"]);
    assert_eq!(gitlab_hosts(Some("bad host")), ["gitlab.com"]);
    assert_eq!(gitlab_hosts(Some("gitlab.com")), ["gitlab.com"]);
    assert_eq!(project_of_remote("git@gitlab.com:acme/sub/app.git\n", &hosts), Some(project()));
    assert_eq!(project_of_remote("git@git.acme.dev:team/svc.git", &hosts), Some(Project { host: "git.acme.dev:8443".into(), path: "team/svc".into() }));
    assert_eq!(project_of_remote("https://github.com/acme/app.git", &hosts), None);
    assert_eq!(project_of_remote("https://gitlab.com.evil.dev/acme/app", &hosts), None);
  }

  #[test]
  fn detects_the_forge_from_origin() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    crate::git::run(dir, &["init", "-q"]).unwrap();
    assert_eq!(forge(dir), Forge::Github, "no origin");
    crate::git::run(dir, &["remote", "add", "origin", "git@gitlab.com:acme/sub/app.git"]).unwrap();
    assert_eq!(forge(dir), Forge::Gitlab(project()));
    crate::git::run(dir, &["remote", "set-url", "origin", "git@github.com:acme/app.git"]).unwrap();
    assert_eq!(forge(dir), Forge::Github);
  }

  #[test]
  fn reads_merge_request_links_only_on_the_folders_host() {
    let p = project();
    assert_eq!(parse_url(MR_URL, &p).unwrap(), (p.clone(), 12));
    assert_eq!(parse_url("https://gitlab.com/acme/sub/app/-/merge_requests/12/diffs#note_1", &p).unwrap().1, 12);
    let e = parse_url("https://gitlab.evil.dev/acme/sub/app/-/merge_requests/12", &p).unwrap_err();
    assert!(e.contains("gitlab.evil.dev"), "{e}");
    for bad in ["http://gitlab.com/acme/app/-/merge_requests/1", "https://gitlab.com/acme/app/-/issues/1", "https://gitlab.com/acme/../-/merge_requests/1", "https://gitlab.com/a/b/-/merge_requests/0", "nope"] {
      assert!(parse_url(bad, &p).is_err(), "{bad}");
    }
    let own = Project { host: "git.acme.dev:8443".into(), path: "team/svc".into() };
    assert!(parse_url("https://git.acme.dev:8443/team/svc/-/merge_requests/3", &own).is_ok());
  }

  #[test]
  fn shows_a_merge_request_like_a_pull_request() {
    let raw = gh_json(&fixture("mr"), &fixture("approvals"), &fixture("pipeline_jobs"));
    let st = pr_status_of(&raw).unwrap();
    assert_eq!((st.number, st.url.as_str(), st.title.as_str(), st.state.as_str(), st.draft), (12, MR_URL, "แก้ login ค้างหลัง OAuth", "OPEN", true));
    assert_eq!((st.review.as_str(), st.mergeable.as_str(), st.merge_state.as_str()), ("REVIEW_REQUIRED", "MERGEABLE", "DRAFT"));
    assert_eq!((st.head_ref.as_str(), st.base_ref.as_str()), ("kingu/fix-login", "main"));
    let checks: Vec<(&str, &str, Option<u64>)> = st.checks.iter().map(|c| (c.name.as_str(), c.state, c.job_id)).collect();
    assert_eq!(
      checks,
      [
        ("test / e2e", "pending", Some(8833105)),
        ("deploy / review-app", "neutral", Some(8833104)),
        ("test / lint", "neutral", Some(8833103)),
        ("build / compile", "success", Some(8833101)),
        ("test / unit", "failure", Some(8833102)),
      ]
    );
    assert_eq!((raw["author"]["login"].as_str(), raw["isCrossRepository"].as_bool(), raw["headRefOid"].as_str()), (Some("kawin"), Some(false), Some("9f2c1e7a4b0d8c3e5f6a7b8c9d0e1f2a3b4c5d6e")));
    assert!(raw["autoMergeRequest"].is_null());
  }

  #[test]
  fn maps_merge_and_review_states() {
    let with = |k: &str, v: Value| {
      let mut mr = fixture("mr");
      mr[k] = v;
      mr
    };
    assert_eq!(merge_states(&with("detailed_merge_status", json!("mergeable"))), ("MERGEABLE", "CLEAN"));
    assert_eq!(merge_states(&with("has_conflicts", json!(true))), ("CONFLICTING", "DIRTY"));
    assert_eq!(merge_states(&with("detailed_merge_status", json!("checking"))), ("UNKNOWN", "UNKNOWN"));
    assert_eq!(merge_states(&with("detailed_merge_status", json!("need_rebase"))), ("MERGEABLE", "BEHIND"));
    assert_eq!(merge_states(&with("detailed_merge_status", json!("ci_must_pass"))), ("MERGEABLE", "BLOCKED"));
    let old = json!({ "merge_status": "cannot_be_merged" });
    assert_eq!(merge_states(&old), ("CONFLICTING", "DIRTY"));
    let mr = fixture("mr");
    assert_eq!(review_decision(&mr, &json!({ "approvals_left": 0, "approved_by": [{ "user": { "username": "r" } }] })), "APPROVED");
    assert_eq!(review_decision(&mr, &Value::Null), "");
    assert_eq!(review_decision(&with("detailed_merge_status", json!("requested_changes")), &Value::Null), "CHANGES_REQUESTED");
    assert_eq!(strip_draft("[Draft] x"), "x");
    assert_eq!(strip_draft("Drafting y"), "Drafting y");
    assert_eq!(state_of(&json!({ "state": "locked" })), "CLOSED");
  }

  #[test]
  fn reads_the_task_branchs_merge_request() {
    let t = Fake::new(&[(200, fixture("mr_list")), (200, fixture("mr")), (200, fixture("approvals")), (200, fixture("pipeline_jobs"))]);
    let iid = find(&t, &own(), "kingu/fix-login").unwrap();
    assert_eq!(iid, Some(12), "the open MR wins over a newer closed one, and another fork's branch of the name is not ours");
    let pr = view(&t, &project(), 12).unwrap();
    assert_eq!(pr.status.checks.len(), 5);
    let seen: Vec<String> = t.requests().into_iter().map(|r| r.path).collect();
    assert_eq!(seen[0], "/projects/acme%2Fsub%2Fapp/merge_requests?source_branch=kingu%2Ffix-login&order_by=updated_at&sort=desc&per_page=20");
    assert_eq!(&seen[1..], ["/projects/acme%2Fsub%2Fapp/merge_requests/12", "/projects/acme%2Fsub%2Fapp/merge_requests/12/approvals", "/projects/acme%2Fsub%2Fapp/pipelines/1490311/jobs?per_page=100"]);
    assert_eq!(pick_for_branch(&json!([]), 61204), None);
  }

  #[test]
  fn shows_the_merge_request_without_approvals_or_jobs_it_may_not_read() {
    let t = Fake::new(&[(200, fixture("mr")), (403, json!({ "message": "403 Forbidden" })), (403, json!({ "message": "403 Forbidden" }))]);
    let pr = view(&t, &project(), 12).unwrap();
    assert_eq!((pr.status.review.as_str(), pr.status.checks.len()), ("", 0));
    let t = Fake::new(&[(404, json!({ "message": "404 Not found" }))]);
    assert_eq!(view(&t, &project(), 12).unwrap_err(), tr!(MrMsg::NotFound));
  }

  #[test]
  fn creates_a_draft_merge_request_into_the_target_branch() {
    let t = Fake::new(&[(201, fixture("created"))]);
    let url = create(&t, &own(), "kingu/fix-login", "origin/main", "แก้ login ค้างหลัง OAuth", "Fixes #3\n\nรายละเอียด", true).unwrap();
    assert_eq!(url, MR_URL);
    let req = &t.requests()[0];
    assert_eq!((req.method, req.path.as_str()), (Method::Post, "/projects/acme%2Fsub%2Fapp/merge_requests"));
    let body = req.body.as_ref().unwrap();
    assert_eq!(body["title"], "Draft: แก้ login ค้างหลัง OAuth");
    assert_eq!((body["source_branch"].as_str(), body["target_branch"].as_str()), (Some("kingu/fix-login"), Some("main")));
    assert!(body.get("target_project_id").is_none(), "not a fork: the MR stays in the project");
    assert_eq!(create_body(&own(), "a", "parent/task", "Draft: x", "", true)["title"], "Draft: x");
    assert_eq!(create_body(&own(), "a", "kingu/parent", "x", "", false)["target_branch"], "kingu/parent");
    assert!(create(&t, &own(), "a", "main", "  ", "", false).is_err());
    let t = Fake::new(&[(409, json!({ "message": ["Another open merge request already exists for this source branch: !12"] }))]);
    let e = create(&t, &own(), "kingu/fix-login", "main", "x", "", false).unwrap_err();
    assert_eq!(e, "GitLab: Another open merge request already exists for this source branch: !12");
  }

  #[test]
  fn pushes_the_branch_then_creates() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let (repo, remote) = (root.join("repo"), root.join("remote.git"));
    let git = |dir: &Path, args: &[&str]| crate::git::run(dir, args).unwrap();
    std::fs::create_dir_all(&repo).unwrap();
    git(&root, &["init", "-q", "--bare", remote.to_str().unwrap()]);
    git(&repo, &["init", "-q", "-b", "main"]);
    for (k, v) in [("user.name", "t"), ("user.email", "t@example.com"), ("commit.gpgsign", "false")] {
      git(&repo, &["config", k, v]);
    }
    std::fs::write(repo.join("a.txt"), "a\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "init"]);
    git(&repo, &["remote", "add", "origin", remote.to_str().unwrap()]);
    crate::agent::worktree::create(&repo, "t", Some("main"), None).unwrap();
    let wt = super::super::review::task_dir(&repo, "t").unwrap();
    let branch = super::super::worktree::task_branch(&wt, "t").unwrap();
    let t = Fake::new(&[(201, fixture("created"))]);
    assert_eq!(push_and_create(&t, &own(), &wt, "t", "main", "x", "", false, false).unwrap(), MR_URL);
    assert!(!git(&remote, &["branch", "--list", &branch]).is_empty(), "the task branch is on origin");
    assert_eq!(t.requests()[0].body.as_ref().unwrap()["source_branch"], json!(branch));
    assert!(push_and_create(&t, &own(), &wt, "t", "--evil", "x", "", false, false).is_err());
    assert_eq!(t.requests().len(), 1);
  }

  #[test]
  fn a_fork_routes_its_merge_requests_into_the_parent() {
    let r = fork();
    assert!(r.is_fork());
    assert_eq!((r.source.path.as_str(), r.source_id, r.target.path.as_str(), r.target_id), ("kawin/app", 70321, "acme/sub/app", 61204));
    assert_eq!(r.target.host, "gitlab.com", "the parent is on the fork's host");
    let own = own();
    assert!(!own.is_fork());
    assert_eq!((own.target, own.target_id), (project(), 61204));
    // A parent the token cannot see (or a bad path) leaves the fork targeting itself.
    let mut hidden = fixture("fork_project");
    hidden["forked_from_project"]["path_with_namespace"] = json!("../evil");
    assert!(!parse_route(&r.source, &hidden).unwrap().is_fork());
    assert_eq!(parse_route(&project(), &json!({})).unwrap_err(), tr!(ForgeMsg::NoProjectId, project = "acme/sub/app"));
    let t = Fake::new(&[(200, fixture("fork_project"))]);
    assert_eq!(route(&t, &r.source).unwrap(), r);
    assert_eq!(t.requests()[0].path, "/projects/kawin%2Fapp");
  }

  #[test]
  fn a_forks_merge_request_is_created_in_the_fork_into_the_parent() {
    let mut created = fixture("created");
    created["source_project_id"] = json!(70321);
    created["web_url"] = json!("https://gitlab.com/acme/sub/app/-/merge_requests/15");
    let t = Fake::new(&[(201, created)]);
    let url = create(&t, &fork(), "kingu/fix-login", "origin/main", "แก้ login", "", false).unwrap();
    assert_eq!(url, "https://gitlab.com/acme/sub/app/-/merge_requests/15");
    let req = &t.requests()[0];
    assert_eq!((req.method, req.path.as_str()), (Method::Post, "/projects/kawin%2Fapp/merge_requests"), "source_project_id is the project posted to");
    let body = req.body.as_ref().unwrap();
    assert_eq!((body["target_project_id"].as_u64(), body["source_branch"].as_str(), body["target_branch"].as_str()), (Some(61204), Some("kingu/fix-login"), Some("main")));
  }

  #[test]
  fn a_forks_merge_request_is_read_from_the_parent() {
    let mut mr = fixture("mr");
    mr["iid"] = json!(15);
    mr["source_project_id"] = json!(70321);
    mr["head_pipeline"]["project_id"] = json!(70321);
    let t = Fake::new(&[(200, fixture("fork_mr_list")), (200, mr), (200, fixture("approvals")), (200, fixture("pipeline_jobs"))]);
    let r = fork();
    let iid = find(&t, &r, "kingu/fix-login").unwrap();
    assert_eq!(iid, Some(15), "the parent's own branch of the same name is not the fork's MR");
    let pr = view(&t, &r.target, 15).unwrap();
    assert_eq!(pr.raw["isCrossRepository"], true);
    let seen: Vec<String> = t.requests().into_iter().map(|r| r.path).collect();
    assert!(seen[0].starts_with("/projects/acme%2Fsub%2Fapp/merge_requests?source_branch=kingu%2Ffix-login"), "{}", seen[0]);
    assert_eq!(seen[1], "/projects/acme%2Fsub%2Fapp/merge_requests/15");
    assert_eq!(seen[3], "/projects/70321/pipelines/1490311/jobs?per_page=100", "the fork's pipeline runs in the fork");
    assert_eq!(pick_for_branch(&fixture("fork_mr_list"), 99), None);
  }

  #[test]
  fn reads_a_jobs_log_from_its_page_in_the_fork() {
    let p = project();
    assert_eq!(job_of_url("https://gitlab.com/kawin/app/-/jobs/8833102", &p), Some((Project { host: "gitlab.com".into(), path: "kawin/app".into() }, 8833102)));
    assert_eq!(job_of_url("https://gitlab.com/acme/sub/app/-/jobs/7/raw", &p).map(|j| j.1), Some(7));
    for bad in ["https://gitlab.evil.dev/acme/app/-/jobs/1", "http://gitlab.com/acme/app/-/jobs/1", "https://gitlab.com/acme/app/-/pipelines/1", "https://gitlab.com/../-/jobs/1", "https://gitlab.com/a/b/-/jobs/x"] {
      assert_eq!(job_of_url(bad, &p), None, "{bad}");
    }
    struct Trace;
    impl Transport for Trace {
      fn send(&self, req: &Request) -> Result<(u16, String), String> {
        assert_eq!(req.path, "/projects/kawin%2Fapp/jobs/5/trace");
        Ok((200, "error: boom\n".into()))
      }
    }
    assert_eq!(job_log(&Trace, &p, "https://gitlab.com/kawin/app/-/jobs/5").unwrap(), "error: boom\n");
    assert_eq!(job_log(&Trace, &p, "https://github.com/a/b/actions/runs/1").unwrap_err(), tr!(ForgeMsg::NoCheckDetails));
    let checks = [CheckRef { name: "test".into(), url: Some("https://gitlab.com/kawin/app/-/jobs/5".into()), run_id: None, job_id: Some(5) }];
    assert_eq!(check_logs(&Trace, &p, &checks)[0].log_tail.as_deref(), Some("error: boom\n"));
  }

  #[test]
  fn the_checks_tab_changes_state_title_and_auto_merge() {
    let p = project();
    let t = Fake::new(&[(200, json!({})), (200, json!({}))]);
    set_open(&t, &p, 12, false).unwrap();
    set_open(&t, &p, 12, true).unwrap();
    let seen = t.requests();
    assert_eq!((seen[0].method, seen[0].path.as_str(), seen[0].body.clone()), (Method::Put, "/projects/acme%2Fsub%2Fapp/merge_requests/12", Some(json!({ "state_event": "close" }))));
    assert_eq!(seen[1].body, Some(json!({ "state_event": "reopen" })));
    // Ready: the title loses its draft mark; an MR already out of draft is left alone.
    let t = Fake::new(&[(200, fixture("mr")), (200, json!({})), (200, ready_mr())]);
    mark_ready(&t, &p, 12).unwrap();
    mark_ready(&t, &p, 12).unwrap();
    let seen = t.requests();
    assert_eq!(seen.len(), 3);
    assert_eq!(seen[1].body, Some(json!({ "title": "แก้ login ค้างหลัง OAuth" })));
    // A draft's new title keeps the mark.
    let t = Fake::new(&[(200, fixture("mr")), (200, json!({})), (200, ready_mr()), (200, json!({}))]);
    edit_title(&t, &p, 12, " ชื่อใหม่ ").unwrap();
    edit_title(&t, &p, 12, "ชื่อใหม่").unwrap();
    let seen = t.requests();
    assert_eq!((seen[1].body.clone(), seen[3].body.clone()), (Some(json!({ "title": "Draft: ชื่อใหม่" })), Some(json!({ "title": "ชื่อใหม่" }))));
    assert_eq!(edit_title(&t, &p, 12, " ").unwrap_err(), tr!(MrMsg::EmptyTitle));
    let t = Fake::new(&[(200, json!({})), (200, json!({}))]);
    set_auto_merge(&t, &p, 12, true, true).unwrap();
    set_auto_merge(&t, &p, 12, false, false).unwrap();
    let seen = t.requests();
    assert_eq!((seen[0].method, seen[0].path.as_str()), (Method::Put, "/projects/acme%2Fsub%2Fapp/merge_requests/12/merge"));
    assert_eq!(seen[0].body, Some(json!({ "merge_when_pipeline_succeeds": true, "auto_merge": true, "squash": true })));
    assert_eq!((seen[1].method, seen[1].path.as_str()), (Method::Post, "/projects/acme%2Fsub%2Fapp/merge_requests/12/cancel_merge_when_pipeline_succeeds"));
  }

  #[test]
  fn the_checks_tab_reads_and_writes_comments() {
    let c = conversation(&fixture("discussions"), MR_URL);
    let list = c["comments"].as_array().unwrap();
    assert_eq!(list.len(), 1, "threads and system notes are not conversation comments");
    assert_eq!((list[0]["author"]["login"].as_str(), list[0]["body"].as_str(), list[0]["url"].as_str()), (Some("reviewer"), Some("ดูแล้วโอเค"), Some("https://gitlab.com/acme/sub/app/-/merge_requests/12#note_2101")));
    assert_eq!(c["reviews"], json!([]));
    let nodes = thread_nodes(&parse_discussions(&fixture("discussions"), MR_URL));
    assert_eq!(nodes[0]["id"], "3f8d2c1b0a9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c");
    assert_eq!((nodes[0]["isResolved"].as_bool(), nodes[0]["path"].as_str(), nodes[0]["line"].as_u64()), (Some(false), Some("src/auth.ts"), Some(42)));
    assert_eq!(nodes[0]["comments"]["nodes"][1]["author"]["login"], "kawin");
    assert_eq!((nodes[2]["path"].as_str(), nodes[2]["line"].is_null()), (Some(""), true));
    let id = "3f8d2c1b0a9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c";
    let t = Fake::new(&[(200, fixture("discussions")), (201, json!({})), (201, json!({}))]);
    assert_eq!(comments(&t, &project(), 12, MR_URL).unwrap(), c);
    comment(&t, &project(), 12, "ขอบคุณ").unwrap();
    reply(&t, &project(), 12, id, "แก้แล้ว").unwrap();
    let seen = t.requests();
    assert_eq!(seen[0].path, "/projects/acme%2Fsub%2Fapp/merge_requests/12/discussions?per_page=100");
    assert_eq!((seen[1].method, seen[1].path.as_str(), seen[1].body.clone()), (Method::Post, "/projects/acme%2Fsub%2Fapp/merge_requests/12/notes", Some(json!({ "body": "ขอบคุณ" }))));
    assert_eq!(seen[2].path, format!("/projects/acme%2Fsub%2Fapp/merge_requests/12/discussions/{id}/notes"));
    assert!(reply(&t, &project(), 12, "PRRT_x", "y").is_err());
    assert_eq!(t.requests().len(), 3);
  }

  #[test]
  fn merges_pinned_to_the_head_and_removes_the_source_branch() {
    let t = Fake::new(&[(200, ready_mr()), (200, json!({ "approvals_left": 0, "approved_by": [{}] })), (200, fixture("merged"))]);
    let out = merge(&t, &project(), 12, MergeMethod::Squash, true).unwrap();
    assert_eq!(out, MergeOutcome { deleted_branch: Some("kingu/fix-login".into()), branch_note: None });
    let req = &t.requests()[2];
    assert_eq!((req.method, req.path.as_str()), (Method::Put, "/projects/acme%2Fsub%2Fapp/merge_requests/12/merge"));
    assert_eq!(req.body, Some(json!({ "squash": true, "should_remove_source_branch": true, "sha": "9f2c1e7a4b0d8c3e5f6a7b8c9d0e1f2a3b4c5d6e" })));
  }

  #[test]
  fn merge_preflight_and_failures() {
    // Draft: refused before any merge request.
    let t = Fake::new(&[(200, fixture("mr")), (200, Value::Null), (200, json!([]))]);
    assert_eq!(merge(&t, &project(), 12, MergeMethod::Merge, false).unwrap_err(), tr!(MrMsg::Draft));
    assert_eq!(t.requests().len(), 3);
    // Needs approval.
    let t = Fake::new(&[(200, ready_mr()), (200, fixture("approvals"))]);
    assert_eq!(merge(&t, &project(), 12, MergeMethod::Merge, false).unwrap_err(), tr!(AgentMsg::PrReviewRequired));
    // GitLab refuses: the head moved, or a pipeline must pass.
    let t = Fake::new(&[(200, ready_mr()), (200, Value::Null), (409, json!({ "message": "SHA does not match HEAD of source branch: 1234" }))]);
    assert_eq!(merge(&t, &project(), 12, MergeMethod::Merge, false).unwrap_err(), tr!(MrMsg::HeadMoved));
    let t = Fake::new(&[(200, ready_mr()), (200, Value::Null), (405, json!({ "message": "405 Method Not Allowed" }))]);
    assert!(merge(&t, &project(), 12, MergeMethod::Merge, false).unwrap_err().contains("405 Method Not Allowed"));
    // A fork's branch is kept.
    let mut fork = ready_mr();
    fork["source_project_id"] = json!(99);
    let t = Fake::new(&[(200, fork), (200, Value::Null), (200, fixture("merged"))]);
    let out = merge(&t, &project(), 12, MergeMethod::Rebase, true).unwrap();
    assert_eq!(out.branch_note, Some(tr!(AgentMsg::ForkBranchKept)));
    assert_eq!(t.requests()[2].body.as_ref().unwrap()["should_remove_source_branch"], false);
    // Accepted but not merged.
    let t = Fake::new(&[(200, ready_mr()), (200, Value::Null), (200, json!({ "state": "opened" }))]);
    assert_eq!(merge(&t, &project(), 12, MergeMethod::Merge, false).unwrap_err(), tr!(MrMsg::NotMerged, state = "opened"));
  }

  #[test]
  fn merge_settings_follow_the_project() {
    let s = parse_settings(&fixture("project"));
    assert_eq!(s, RepoMergeSettings { squash: true, merge: true, rebase: false, default: "SQUASH".into() });
    let ff = parse_settings(&json!({ "merge_method": "ff", "squash_option": "never" }));
    assert_eq!(ff, RepoMergeSettings { squash: false, merge: false, rebase: true, default: "REBASE".into() });
    let always = parse_settings(&json!({ "merge_method": "merge", "squash_option": "always" }));
    assert_eq!((always.squash, always.merge, always.rebase, always.default.as_str()), (true, false, false, "SQUASH"));
    let t = Fake::new(&[(200, fixture("project"))]);
    merge_settings(&t, &project()).unwrap();
    assert_eq!(t.requests()[0].path, "/projects/acme%2Fsub%2Fapp");
  }

  #[test]
  fn fetches_failed_job_logs() {
    struct Traces;
    impl Transport for Traces {
      fn send(&self, req: &Request) -> Result<(u16, String), String> {
        Ok(match req.path.as_str() {
          "/projects/acme%2Fsub%2Fapp/jobs/8833102/trace" => (200, "\x1b[0K$ bun test\r\nerror: expected 2, got 3\n".into()),
          "/projects/acme%2Fsub%2Fapp/jobs/7/trace" => (302, String::new()),
          _ => (404, r#"{"message":"404 Not found"}"#.into()),
        })
      }
    }
    let checks = vec![
      CheckRef { name: "test / unit".into(), url: None, run_id: None, job_id: Some(8833102) },
      CheckRef { name: "test / old".into(), url: None, run_id: None, job_id: Some(7) },
      CheckRef { name: "external".into(), url: None, run_id: None, job_id: None },
    ];
    let out = check_logs(&Traces, &project(), &checks);
    assert_eq!(out[0].log_tail.as_deref(), Some("$ bun test\nerror: expected 2, got 3\n"));
    assert_eq!(out[1].error, Some(tr!(MrMsg::LogUnavailable, status = 302)));
    assert_eq!((out[2].log_tail.as_deref(), out[2].error.as_deref()), (None, None));
    let many: Vec<CheckRef> = (1..=8).map(|i| CheckRef { name: format!("c{i}"), url: None, run_id: None, job_id: Some(1000 + i) }).collect();
    let capped = check_logs(&Traces, &project(), &many);
    assert_eq!(capped.iter().filter(|c| c.error.is_some()).count(), LOG_JOB_LIMIT);
  }

  #[test]
  fn discussions_become_review_threads() {
    let t = parse_discussions(&fixture("discussions"), &format!("{MR_URL}#top"));
    assert_eq!(t.len(), 3, "plain comments and system notes are left out");
    let a = &t[0];
    assert_eq!((a.id.as_str(), a.resolved, a.path.as_deref(), a.line, a.start_line), ("3f8d2c1b0a9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c", false, Some("src/auth.ts"), Some(42), Some(40)));
    assert_eq!(a.comments.len(), 2);
    assert_eq!((a.comments[0].author.as_str(), a.comments[0].url.as_str()), ("reviewer", "https://gitlab.com/acme/sub/app/-/merge_requests/12#note_2102"));
    assert_eq!((t[1].resolved, t[1].line, t[1].path.as_deref()), (true, Some(7), Some("src/log.ts")));
    assert_eq!((t[2].path.as_deref(), t[2].line, t[2].comments[0].body.as_str()), (None, None, "ต้องเพิ่ม test ก่อน merge"));
  }

  #[test]
  fn lists_and_resolves_discussions() {
    let id = "3f8d2c1b0a9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c";
    let resolved = json!({ "id": id, "notes": [{ "id": 2102, "resolvable": true, "resolved": true }, { "id": 2103, "resolvable": true, "resolved": true }] });
    let t = Fake::new(&[(200, fixture("discussions")), (200, resolved)]);
    assert_eq!(threads(&t, &project(), 12, MR_URL).unwrap().len(), 3);
    assert!(resolve(&t, &project(), 12, id, true).unwrap());
    let seen = t.requests();
    assert_eq!(seen[0].path, "/projects/acme%2Fsub%2Fapp/merge_requests/12/discussions?per_page=100");
    assert_eq!((seen[1].method, seen[1].path.clone(), seen[1].body.clone()), (Method::Put, format!("/projects/acme%2Fsub%2Fapp/merge_requests/12/discussions/{id}"), Some(json!({ "resolved": true }))));
    assert!(resolve(&t, &project(), 12, "PRRT_x/../y", true).is_err());
    assert_eq!(t.requests().len(), 2);
  }

  #[test]
  fn explains_gitlab_errors() {
    assert_eq!(error_text(r#"{"message":{"title":["is too long (maximum is 255 characters)"]}}"#), "title is too long (maximum is 255 characters)");
    assert_eq!(error_text(r#"{"error":"target_branch is missing"}"#), "target_branch is missing");
    assert_eq!(error_text("<html>"), "<html>");
    assert_eq!(answer(403, "{}").unwrap_err(), tr!(MrMsg::Forbidden));
    assert_eq!(answer(401, "{}").unwrap_err(), tr!(TrackerMsg::GitlabAuthFailed));
    assert!(answer(503, "").unwrap_err().contains("503"));
  }

  #[test]
  fn a_gitlab_folder_reports_its_connection() {
    let st = status(&Project { host: "gitlab.invalid".into(), path: "a/b".into() });
    assert_eq!((st.installed, st.provider), (true, "gitlab"));
    if !st.authenticated {
      assert_eq!(st.detail, tr!(TrackerMsg::GitlabNotConnected, host = "gitlab.invalid"));
    }
  }
}
