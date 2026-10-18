//! Landing a pull request from Kingu the way Orca does: merging it (`gh pr merge` after Orca's
//! preflight), the failed CI jobs' log tails for the "fix failing checks" prompt, and the review
//! threads (`gh api graphql`, Orca's query) with resolving one. `gh` never prompts here
//! (`GH_PROMPT_DISABLED`, `GIT_TERMINAL_PROMPT=0`, no stdin) and every call has a timeout.

use std::io::Read;
use std::path::Path;
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use super::review::{PR_FIELDS, PrStatus, parse_pr_status};

pub const GH_TIMEOUT: Duration = Duration::from_secs(60);
/// `gh pr merge` waits for GitHub to land the merge.
pub const MERGE_TIMEOUT: Duration = Duration::from_secs(180);

// ---------------------------------------------------------------------------------------------
// Running gh

/// Runs `gh` in `dir` until it exits or `timeout` passes. `tail` keeps only the last bytes of a
/// large stdout (job logs). Returns stdout.
pub fn gh_run(gh: &Path, dir: &Path, args: &[String], timeout: Duration, tail: Option<usize>) -> Result<String, String> {
  let what = args.iter().take(2).cloned().collect::<Vec<_>>().join(" ");
  let mut cmd = crate::shell_env::command(gh);
  cmd
    .current_dir(dir)
    .args(args)
    .env("GH_PROMPT_DISABLED", "1")
    .env("GIT_TERMINAL_PROMPT", "0")
    .env("NO_COLOR", "1")
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
  let mut child = cmd.spawn().map_err(|e| format!("gh: {e}"))?;
  let mut stdout = child.stdout.take();
  let out = std::thread::spawn(move || {
    let mut keep: Vec<u8> = Vec::new();
    let mut buf = [0u8; 64 * 1024];
    while let Some(Ok(n)) = stdout.as_mut().map(|p| p.read(&mut buf)) {
      if n == 0 {
        break;
      }
      keep.extend_from_slice(&buf[..n]);
      if let Some(cap) = tail
        && keep.len() > cap * 2
      {
        keep.drain(..keep.len() - cap);
      }
    }
    if let Some(cap) = tail
      && keep.len() > cap
    {
      keep.drain(..keep.len() - cap);
    }
    keep
  });
  let mut stderr = child.stderr.take();
  let err = std::thread::spawn(move || {
    let mut s = Vec::new();
    if let Some(p) = stderr.as_mut() {
      let _ = p.read_to_end(&mut s);
    }
    String::from_utf8_lossy(&s).into_owned()
  });
  let deadline = Instant::now() + timeout;
  let status = loop {
    match child.try_wait() {
      Ok(Some(s)) => break s,
      Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
      Ok(None) => {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("gh {what} ใช้เวลานานเกิน {} วินาที จึงหยุดไว้", timeout.as_secs()));
      }
      Err(e) => return Err(format!("gh: {e}")),
    }
  };
  let stdout = out.join().unwrap_or_default();
  let stderr = err.join().unwrap_or_default();
  if !status.success() {
    return Err(format!("gh {what}: {}", stderr.trim()));
  }
  Ok(String::from_utf8_lossy(&stdout).into_owned())
}

fn strings(args: &[&str]) -> Vec<String> {
  args.iter().map(|s| (*s).to_owned()).collect()
}

// ---------------------------------------------------------------------------------------------
// The PR's repository

/// `host/owner/repo` of a pull request, from its URL (`https://<host>/<owner>/<repo>/pull/<n>`),
/// so API calls reach the PR's own repository (a fork's PR lives in the upstream).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoRef {
  pub host: String,
  pub owner: String,
  pub repo: String,
}

fn plain(s: &str) -> bool {
  !s.is_empty() && !s.starts_with(['-', '.']) && s.len() <= 100 && s.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

impl RepoRef {
  pub fn from_pr_url(url: &str) -> Result<Self, String> {
    let bad = || format!("ลิงก์ PR ไม่ถูกต้อง: {url:?}");
    let rest = url.strip_prefix("https://").ok_or_else(bad)?;
    let mut parts = rest.split('/');
    let (Some(host), Some(owner), Some(repo), Some("pull"), Some(n)) = (parts.next(), parts.next(), parts.next(), parts.next(), parts.next()) else {
      return Err(bad());
    };
    let host_ok = !host.is_empty() && host.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b':')) && !host.starts_with('-');
    if !host_ok || !plain(owner) || !plain(repo) || n.parse::<u64>().is_err() {
      return Err(bad());
    }
    Ok(Self { host: host.to_ascii_lowercase(), owner: owner.to_owned(), repo: repo.to_owned() })
  }

  /// `owner/repo`, or `host/owner/repo` on GitHub Enterprise (gh's `--repo` form).
  pub fn slug(&self) -> String {
    if self.host == "github.com" { format!("{}/{}", self.owner, self.repo) } else { format!("{}/{}/{}", self.host, self.owner, self.repo) }
  }

  /// `gh api` arguments up to (not including) the endpoint.
  pub fn api(&self) -> Vec<String> {
    let mut a = vec!["api".to_owned()];
    if self.host != "github.com" {
      a.extend(["--hostname".to_owned(), self.host.clone()]);
    }
    a
  }

  fn rest(&self, path: &str) -> String {
    format!("repos/{}/{}/{path}", self.owner, self.repo)
  }
}

// ---------------------------------------------------------------------------------------------
// Merge

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeMethod {
  Merge,
  Squash,
  Rebase,
}

impl MergeMethod {
  pub fn parse(s: &str) -> Result<Self, String> {
    match s {
      "merge" => Ok(Self::Merge),
      "squash" => Ok(Self::Squash),
      "rebase" => Ok(Self::Rebase),
      _ => Err(format!("{s}: unknown merge method")),
    }
  }

  fn flag(self) -> &'static str {
    match self {
      Self::Merge => "--merge",
      Self::Squash => "--squash",
      Self::Rebase => "--rebase",
    }
  }
}

/// What the repository allows (`gh repo view`), for the merge menu (Orca's merge method settings).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct RepoMergeSettings {
  pub squash: bool,
  pub merge: bool,
  pub rebase: bool,
  /// `MERGE`, `SQUASH`, `REBASE` or empty.
  pub default: String,
}

pub fn parse_merge_settings(json: &str) -> Result<RepoMergeSettings, String> {
  let v: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("gh repo view: {e}"))?;
  let b = |k: &str| v[k].as_bool().unwrap_or(false);
  Ok(RepoMergeSettings { squash: b("squashMergeAllowed"), merge: b("mergeCommitAllowed"), rebase: b("rebaseMergeAllowed"), default: v["viewerDefaultMergeMethod"].as_str().unwrap_or_default().to_owned() })
}

pub fn merge_settings(gh: &Path, dir: &Path, repo: &RepoRef) -> Result<RepoMergeSettings, String> {
  let args = strings(&["repo", "view", &repo.slug(), "--json", "squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed,viewerDefaultMergeMethod"]);
  parse_merge_settings(&gh_run(gh, dir, &args, GH_TIMEOUT, None)?)
}

/// Why GitHub will not merge the PR now, checked right before merging (Orca's `getPRMergeBlocker`
/// plus the states its merge button is never offered in).
pub fn merge_blocker(pr: &PrStatus) -> Option<String> {
  if pr.state == "MERGED" {
    return Some("PR นี้ merge แล้ว".into());
  }
  if pr.state == "CLOSED" {
    return Some("PR นี้ถูกปิดแล้ว".into());
  }
  if pr.draft {
    return Some("PR นี้ยังเป็น draft ให้เปลี่ยนเป็น Ready for review บน GitHub ก่อน".into());
  }
  match pr.review.as_str() {
    "REVIEW_REQUIRED" => return Some("PR นี้ต้องได้รับการอนุมัติ (review) ก่อนจึงจะ merge ได้".into()),
    "CHANGES_REQUESTED" => return Some("ผู้รีวิวขอให้แก้ PR นี้ จึงยัง merge ไม่ได้".into()),
    _ => {}
  }
  if pr.mergeable == "CONFLICTING" {
    let base = if pr.base_ref.is_empty() { "base" } else { &pr.base_ref };
    return Some(format!("PR นี้มี conflict กับ {base} อัปเดต branch กับ {base} แล้วแก้ conflict ก่อน merge"));
  }
  None
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct MergeOutcome {
  /// The PR's head branch deleted on GitHub (the "delete branch" option).
  pub deleted_branch: Option<String>,
  /// Why the branch was kept or could not be deleted; the merge itself succeeded.
  pub branch_note: Option<String>,
}

/// A branch name inside a REST path: everything but `[A-Za-z0-9._/-]` percent-encoded.
fn path_escape(s: &str) -> String {
  s.bytes()
    .map(|b| if b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'/' | b'-') { (b as char).to_string() } else { format!("%{b:02X}") })
    .collect()
}

/// Merges PR `number` with `method` after re-reading it from GitHub. Like Orca, never
/// `--delete-branch` (gh also deletes the local branch, which the task worktree has checked out);
/// `delete_branch` deletes only the head branch on GitHub, and only when it is in the same
/// repository.
pub fn merge(gh: &Path, dir: &Path, pr_url: &str, number: u64, method: MergeMethod, delete_branch: bool) -> Result<MergeOutcome, String> {
  let repo = RepoRef::from_pr_url(pr_url)?;
  let fields = format!("{PR_FIELDS},isCrossRepository");
  let view = gh_run(gh, dir, &strings(&["pr", "view", &number.to_string(), "--repo", &repo.slug(), "--json", &fields]), GH_TIMEOUT, None)?;
  let pr = parse_pr_status(&view)?;
  if pr.number != number {
    return Err(format!("gh pr view ตอบ PR #{} แทน #{number}", pr.number));
  }
  if let Some(why) = merge_blocker(&pr) {
    return Err(why);
  }
  gh_run(gh, dir, &strings(&["pr", "merge", &number.to_string(), method.flag(), "--repo", &repo.slug()]), MERGE_TIMEOUT, None)?;
  log::info!("merged PR #{number} ({})", method.flag());
  if !delete_branch {
    return Ok(MergeOutcome { deleted_branch: None, branch_note: None });
  }
  let cross = serde_json::from_str::<serde_json::Value>(&view).ok().and_then(|v| v["isCrossRepository"].as_bool()).unwrap_or(true);
  let branch = pr.head_ref.clone();
  if cross || branch.is_empty() || branch.starts_with('-') || branch.contains("..") {
    return Ok(MergeOutcome { deleted_branch: None, branch_note: Some("ไม่ได้ลบ branch เพราะ branch อยู่ใน repository อื่น (fork)".into()) });
  }
  let mut args = repo.api();
  args.extend(strings(&["-X", "DELETE", &repo.rest(&format!("git/refs/heads/{}", path_escape(&branch)))]));
  Ok(match gh_run(gh, dir, &args, GH_TIMEOUT, None) {
    Ok(_) => MergeOutcome { deleted_branch: Some(branch), branch_note: None },
    // GitHub's own "automatically delete head branches" may have deleted it already.
    Err(e) if e.contains("Reference does not exist") || e.contains("HTTP 422") => MergeOutcome { deleted_branch: Some(branch), branch_note: None },
    Err(e) => MergeOutcome { deleted_branch: None, branch_note: Some(format!("merge แล้ว แต่ลบ branch {branch} บน GitHub ไม่ได้: {e}")) },
  })
}

// ---------------------------------------------------------------------------------------------
// Failed check logs (Orca: check-job-log-tails.ts + check-job-log-tail-slice.ts)

/// Failed jobs whose log is fetched per request (Orca's `PR_CHECK_LOG_TAIL_JOB_LIMIT`).
pub const LOG_JOB_LIMIT: usize = 5;
pub const LOG_TAIL_BYTES: usize = 16 * 1024;
const LOG_TAIL_LINES: usize = 200;
const LOG_RECENT_LINES: usize = 100;
const LOG_ERROR_CONTEXT: usize = 2;
const LOG_MAX_EARLIER: usize = 30;
const LOG_EARLIER_SEPARATOR: &str = "… earlier errors …";
/// The downloaded log is cut to its end before slicing; the excerpt only needs the tail.
const LOG_DOWNLOAD_TAIL: usize = 8 * 1024 * 1024;

static ERROR_LINE: LazyLock<regex::Regex> =
  LazyLock::new(|| regex::Regex::new(r"(?i)(?:##\[error\]|::error::|::error\b|\berror:|FAILED|exit code|ENOENT|EACCES|panic:|AssertionError)").unwrap());
static ANSI: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]").unwrap());

/// The last `max` bytes of `s`, starting on a character boundary.
fn tail_bytes(s: &str, max: usize) -> &str {
  if s.len() <= max {
    return s;
  }
  let mut start = s.len() - max;
  while !s.is_char_boundary(start) {
    start += 1;
  }
  &s[start..]
}

fn clean(s: &str) -> String {
  ANSI.replace_all(s, "").chars().filter(|&c| c == '\n' || c == '\t' || !c.is_control()).collect()
}

/// Orca's log excerpt: the last 100 lines plus up to 30 lines around earlier error markers (or
/// the last 200 lines when there are none), at most 16 KB, without ANSI escapes.
pub fn slice_log_tail(log: &str) -> String {
  let text = log.replace("\r\n", "\n").replace('\r', "\n");
  let lines: Vec<&str> = text.split('\n').collect();
  let recent_start = lines.len().saturating_sub(LOG_RECENT_LINES);
  let excerpt = if recent_start == 0 {
    tail_bytes(&lines.join("\n"), LOG_TAIL_BYTES).to_owned()
  } else {
    let mut earlier = std::collections::BTreeSet::new();
    'scan: for i in (0..recent_start).rev() {
      if !ERROR_LINE.is_match(&clean(lines[i])) {
        continue;
      }
      let from = i.saturating_sub(LOG_ERROR_CONTEXT);
      let to = (i + LOG_ERROR_CONTEXT).min(recent_start - 1);
      for j in (from..=to).rev() {
        earlier.insert(j);
        if earlier.len() == LOG_MAX_EARLIER {
          break 'scan;
        }
      }
    }
    if earlier.is_empty() {
      tail_bytes(&lines[lines.len().saturating_sub(LOG_TAIL_LINES)..].join("\n"), LOG_TAIL_BYTES).to_owned()
    } else {
      let mut prefix: Vec<&str> = earlier.iter().map(|&i| lines[i]).collect();
      prefix.push(LOG_EARLIER_SEPARATOR);
      let prefix = prefix.join("\n");
      if prefix.len() >= LOG_TAIL_BYTES {
        tail_bytes(&prefix, LOG_TAIL_BYTES).to_owned()
      } else {
        let budget = LOG_TAIL_BYTES - prefix.len() - 1;
        format!("{prefix}\n{}", tail_bytes(&lines[recent_start..].join("\n"), budget))
      }
    }
  };
  clean(tail_bytes(&excerpt, LOG_TAIL_BYTES))
}

/// A failed check whose log the webview wants (from `PrStatus.checks`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct CheckRef {
  pub name: String,
  pub url: Option<String>,
  pub run_id: Option<u64>,
  pub job_id: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct CheckLog {
  pub name: String,
  /// The failed jobs' log excerpts joined; `None` when there is no Actions log (a commit status).
  pub log_tail: Option<String>,
  pub error: Option<String>,
}

fn is_job_failure(state: &str) -> bool {
  matches!(state, "failure" | "failed" | "action_required" | "cancelled" | "stale" | "startup_failure" | "timed_out")
}

/// Failed job ids of workflow run `jobs` JSON, the ones named like the check first (Orca's
/// `mapWorkflowJobs`: an exact name match wins).
pub fn failed_jobs(json: &str, check_name: &str) -> Vec<u64> {
  let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return Vec::new() };
  let jobs: Vec<&serde_json::Value> = v["jobs"].as_array().map(|a| a.iter().collect()).unwrap_or_default();
  let job_name = check_name.rsplit(" / ").next().unwrap_or(check_name);
  let exact: Vec<&serde_json::Value> = jobs.iter().copied().filter(|j| j["name"].as_str() == Some(job_name)).collect();
  let pool = if exact.is_empty() { jobs } else { exact };
  pool
    .into_iter()
    .filter(|j| is_job_failure(j["conclusion"].as_str().or(j["status"].as_str()).unwrap_or_default()))
    .filter_map(|j| j["id"].as_u64().filter(|&id| id > 0))
    .collect()
}

fn job_log(gh: &Path, dir: &Path, repo: &RepoRef, job: u64) -> Result<String, String> {
  let mut args = repo.api();
  args.push(repo.rest(&format!("actions/jobs/{job}/logs")));
  gh_run(gh, dir, &args, GH_TIMEOUT, Some(LOG_DOWNLOAD_TAIL)).map(|log| slice_log_tail(&log))
}

/// Log excerpts of the failed GitHub Actions jobs behind `checks`, at most [`LOG_JOB_LIMIT`]
/// jobs in all. A check without a log (a commit status) or whose log cannot be read still gets
/// an entry, so the prompt lists it.
pub fn check_logs(gh: &Path, dir: &Path, pr_url: &str, checks: &[CheckRef]) -> Result<Vec<CheckLog>, String> {
  let repo = RepoRef::from_pr_url(pr_url)?;
  let mut budget = LOG_JOB_LIMIT;
  let mut out = Vec::new();
  for c in checks {
    let jobs = match (c.job_id, c.run_id) {
      (Some(job), _) => Ok(vec![job]),
      (None, Some(run)) => {
        let mut args = repo.api();
        args.push(repo.rest(&format!("actions/runs/{run}/jobs?per_page=100")));
        gh_run(gh, dir, &args, GH_TIMEOUT, None).map(|j| failed_jobs(&j, &c.name))
      }
      (None, None) => Ok(Vec::new()),
    };
    let mut tails = Vec::new();
    let mut error = None;
    match jobs {
      Ok(jobs) => {
        for job in jobs {
          if budget == 0 {
            break;
          }
          budget -= 1;
          match job_log(gh, dir, &repo, job) {
            Ok(t) if !t.trim().is_empty() => tails.push(t),
            Ok(_) => {}
            Err(e) => error = Some(e),
          }
        }
      }
      Err(e) => error = Some(e),
    }
    out.push(CheckLog { name: c.name.clone(), log_tail: (!tails.is_empty()).then(|| tails.join("\n\n")), error });
  }
  Ok(out)
}

// ---------------------------------------------------------------------------------------------
// Review threads (Orca: pr-review-threads-query.ts, resolve-review-thread.ts)

/// Orca's review-thread query (the thread part; resolution and thread ids are GraphQL-only).
pub const REVIEW_THREADS_QUERY: &str = "
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          line
          startLine
          originalLine
          originalStartLine
          comments(first: 100) {
            nodes {
              id
              databaseId
              author { __typename login }
              body
              createdAt
              url
              path
            }
          }
        }
      }
    }
  }
}";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ThreadComment {
  pub id: u64,
  pub author: String,
  pub body: String,
  pub created_at: String,
  pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ReviewThread {
  /// GraphQL node id (`PRRT_…`), what resolving takes.
  pub id: String,
  pub resolved: bool,
  /// GitHub nulls `line` once the commented code changed (Orca's `isOutdated`).
  pub outdated: bool,
  pub path: Option<String>,
  /// `line`, or `originalLine` for an outdated thread.
  pub line: Option<u64>,
  pub start_line: Option<u64>,
  pub comments: Vec<ThreadComment>,
}

/// gh can exit 0 with `data.repository: null` and an `errors` array (missing scopes, denial).
fn graphql_errors(v: &serde_json::Value) -> Option<String> {
  let errors = v["errors"].as_array().filter(|e| !e.is_empty())?;
  Some(errors.iter().filter_map(|e| e["message"].as_str()).collect::<Vec<_>>().join("; "))
}

pub fn parse_threads(json: &str) -> Result<Vec<ReviewThread>, String> {
  let v: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("gh api graphql: {e}"))?;
  let pr = &v["data"]["repository"]["pullRequest"];
  if pr.is_null() {
    return Err(format!("อ่าน review threads ไม่ได้: {}", graphql_errors(&v).unwrap_or_else(|| "ไม่พบ pull request".into())));
  }
  let nodes = pr["reviewThreads"]["nodes"].as_array().cloned().unwrap_or_default();
  Ok(
    nodes
      .iter()
      .filter_map(|t| {
        let id = t["id"].as_str()?.to_owned();
        let comments: Vec<ThreadComment> = t["comments"]["nodes"]
          .as_array()
          .map(|cs| {
            cs.iter()
              .map(|c| ThreadComment {
                id: c["databaseId"].as_u64().unwrap_or_default(),
                author: c["author"]["login"].as_str().unwrap_or("ghost").to_owned(),
                body: c["body"].as_str().unwrap_or_default().to_owned(),
                created_at: c["createdAt"].as_str().unwrap_or_default().to_owned(),
                url: c["url"].as_str().unwrap_or_default().to_owned(),
              })
              .collect()
          })
          .unwrap_or_default();
        let path = t["comments"]["nodes"][0]["path"].as_str().map(str::to_owned);
        Some(ReviewThread {
          id,
          resolved: t["isResolved"].as_bool().unwrap_or(false),
          outdated: t["line"].is_null(),
          path,
          line: t["line"].as_u64().or(t["originalLine"].as_u64()),
          start_line: t["startLine"].as_u64().or(t["originalStartLine"].as_u64()),
          comments,
        })
      })
      .collect(),
  )
}

pub fn review_threads(gh: &Path, dir: &Path, pr_url: &str, number: u64) -> Result<Vec<ReviewThread>, String> {
  let repo = RepoRef::from_pr_url(pr_url)?;
  let mut args = repo.api();
  args.extend(strings(&[
    "graphql",
    "-f",
    &format!("query={REVIEW_THREADS_QUERY}"),
    "-f",
    &format!("owner={}", repo.owner),
    "-f",
    &format!("repo={}", repo.repo),
    "-F",
    &format!("pr={number}"),
  ]));
  parse_threads(&gh_run(gh, dir, &args, GH_TIMEOUT, None)?)
}

/// A GraphQL node id as GitHub issues them (`PRRT_kwDO…`).
pub fn valid_node_id(id: &str) -> bool {
  !id.is_empty() && id.len() <= 200 && id.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'='))
}

/// Resolves (or reopens) review thread `id`; returns its new `isResolved`.
pub fn resolve_thread(gh: &Path, dir: &Path, pr_url: &str, id: &str, resolve: bool) -> Result<bool, String> {
  if !valid_node_id(id) {
    return Err(format!("thread id ไม่ถูกต้อง: {id:?}"));
  }
  let repo = RepoRef::from_pr_url(pr_url)?;
  let mutation = if resolve { "resolveReviewThread" } else { "unresolveReviewThread" };
  let query = format!("mutation($threadId: ID!) {{ {mutation}(input: {{ threadId: $threadId }}) {{ thread {{ isResolved }} }} }}");
  let mut args = repo.api();
  args.extend(strings(&["graphql", "-f", &format!("query={query}"), "-f", &format!("threadId={id}")]));
  let out = gh_run(gh, dir, &args, GH_TIMEOUT, None)?;
  let v: serde_json::Value = serde_json::from_str(&out).map_err(|e| format!("gh api graphql: {e}"))?;
  if let Some(e) = graphql_errors(&v) {
    return Err(format!("{mutation}: {e}"));
  }
  v["data"][mutation]["thread"]["isResolved"].as_bool().ok_or_else(|| format!("{mutation}: ไม่มีผลลัพธ์จาก GitHub"))
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::PathBuf;

  const PR_URL: &str = "https://github.com/acme/app/pull/12";

  /// A fake `gh`: logs each call's arguments (one per line, calls separated by `--`) and answers
  /// from fixture files picked by a `case` on the arguments.
  fn fake_gh(dir: &Path, cases: &str) -> (PathBuf, PathBuf) {
    let bin = dir.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let log = dir.join("calls.log");
    let gh = bin.join("gh");
    let script = format!(
      "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\" >> '{log}'; done\necho -- >> '{log}'\ncase \"$*\" in\n{cases}\n*) echo \"unexpected: $*\" >&2; exit 1;;\nesac\n",
      log = log.display()
    );
    std::fs::write(&gh, script).unwrap();
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    (gh, log)
  }

  fn fixture(dir: &Path, name: &str, text: &str) -> String {
    let p = dir.join(name);
    std::fs::write(&p, text).unwrap();
    p.display().to_string()
  }

  fn calls(log: &Path) -> Vec<Vec<String>> {
    let text = std::fs::read_to_string(log).unwrap_or_default();
    text.split("--\n").filter(|c| !c.is_empty()).map(|c| c.lines().map(str::to_owned).collect()).collect()
  }

  fn view_json(review: &str, mergeable: &str, draft: bool, cross: bool) -> String {
    format!(
      r#"{{"number":12,"url":"{PR_URL}","title":"t","state":"OPEN","isDraft":{draft},"reviewDecision":"{review}","mergeable":"{mergeable}","mergeStateStatus":"CLEAN","headRefName":"kingu/fix-login","baseRefName":"main","isCrossRepository":{cross},"statusCheckRollup":[]}}"#
    )
  }

  #[test]
  fn repo_ref_from_pr_urls() {
    let r = RepoRef::from_pr_url(PR_URL).unwrap();
    assert_eq!((r.slug(), r.api()), ("acme/app".to_owned(), vec!["api".to_owned()]));
    let e = RepoRef::from_pr_url("https://ghe.corp.io/team/svc/pull/3").unwrap();
    assert_eq!(e.slug(), "ghe.corp.io/team/svc");
    assert_eq!(e.api(), ["api", "--hostname", "ghe.corp.io"]);
    for bad in ["http://github.com/a/b/pull/1", "https://github.com/-a/b/pull/1", "https://github.com/a/b/issues/1", "https://github.com/a/../pull/1", "https://github.com/a/b/pull/x"] {
      assert!(RepoRef::from_pr_url(bad).is_err(), "{bad}");
    }
  }

  #[test]
  fn merges_with_the_chosen_method_and_deletes_the_remote_branch() {
    let tmp = tempfile::tempdir().unwrap();
    let view = fixture(tmp.path(), "view.json", &view_json("APPROVED", "MERGEABLE", false, false));
    let (gh, log) = fake_gh(tmp.path(), &format!("'pr view 12 '*) cat '{view}';;\n'pr merge 12 '*) echo merged;;\n'api -X DELETE '*) exit 0;;"));
    let out = merge(&gh, tmp.path(), PR_URL, 12, MergeMethod::Rebase, true).unwrap();
    assert_eq!(out, MergeOutcome { deleted_branch: Some("kingu/fix-login".into()), branch_note: None });
    let c = calls(&log);
    assert_eq!(c.len(), 3);
    assert_eq!(c[1], ["pr", "merge", "12", "--rebase", "--repo", "acme/app"]);
    assert!(!c[1].iter().any(|a| a == "--delete-branch"));
    assert_eq!(c[2], ["api", "-X", "DELETE", "repos/acme/app/git/refs/heads/kingu/fix-login"]);
  }

  #[test]
  fn merge_preflight_refuses_what_github_would_refuse() {
    let tmp = tempfile::tempdir().unwrap();
    for (review, mergeable, draft, want) in [
      ("REVIEW_REQUIRED", "MERGEABLE", false, "อนุมัติ"),
      ("CHANGES_REQUESTED", "MERGEABLE", false, "ขอให้แก้"),
      ("APPROVED", "CONFLICTING", false, "conflict กับ main"),
      ("", "MERGEABLE", true, "draft"),
    ] {
      let view = fixture(tmp.path(), "view.json", &view_json(review, mergeable, draft, false));
      let (gh, log) = fake_gh(tmp.path(), &format!("'pr view '*) cat '{view}';;\n'pr merge '*) exit 0;;"));
      let _ = std::fs::remove_file(&log);
      let err = merge(&gh, tmp.path(), PR_URL, 12, MergeMethod::Squash, false).unwrap_err();
      assert!(err.contains(want), "{err}");
      assert_eq!(calls(&log).len(), 1, "no merge after a blocker");
    }
  }

  #[test]
  fn keeps_a_fork_branch_and_reports_a_failed_merge() {
    let tmp = tempfile::tempdir().unwrap();
    let view = fixture(tmp.path(), "view.json", &view_json("APPROVED", "MERGEABLE", false, true));
    let (gh, log) = fake_gh(tmp.path(), &format!("'pr view '*) cat '{view}';;\n'pr merge '*) exit 0;;"));
    let out = merge(&gh, tmp.path(), PR_URL, 12, MergeMethod::Squash, true).unwrap();
    assert!(out.deleted_branch.is_none() && out.branch_note.unwrap().contains("fork"));
    assert_eq!(calls(&log).len(), 2);
    let (gh, _) = fake_gh(tmp.path(), &format!("'pr view '*) cat '{view}';;\n'pr merge '*) echo 'Pull request is not mergeable: base branch policy' >&2; exit 1;;"));
    assert!(merge(&gh, tmp.path(), PR_URL, 12, MergeMethod::Squash, false).unwrap_err().contains("base branch policy"));
    assert!(MergeMethod::parse("octopus").is_err());
  }

  #[test]
  fn reads_merge_settings() {
    let s = parse_merge_settings(r#"{"squashMergeAllowed":true,"mergeCommitAllowed":false,"rebaseMergeAllowed":true,"viewerDefaultMergeMethod":"REBASE"}"#).unwrap();
    assert_eq!(s, RepoMergeSettings { squash: true, merge: false, rebase: true, default: "REBASE".into() });
  }

  #[test]
  fn gh_times_out() {
    let tmp = tempfile::tempdir().unwrap();
    let (gh, _) = fake_gh(tmp.path(), "*) sleep 5;;");
    let err = gh_run(&gh, tmp.path(), &strings(&["pr", "view"]), Duration::from_millis(200), None).unwrap_err();
    assert!(err.contains("นานเกิน"), "{err}");
  }

  #[test]
  fn log_tail_keeps_recent_lines_and_earlier_errors() {
    let short = "\x1b[31mline 1\x1b[0m\r\nline 2";
    assert_eq!(slice_log_tail(short), "line 1\nline 2");
    let mut lines: Vec<String> = (0..400).map(|i| format!("step {i}")).collect();
    lines[50] = "##[error]Process completed with exit code 1".into();
    let out = slice_log_tail(&lines.join("\n"));
    let got: Vec<&str> = out.lines().collect();
    assert_eq!(&got[..6], ["step 48", "step 49", "##[error]Process completed with exit code 1", "step 51", "step 52", LOG_EARLIER_SEPARATOR]);
    assert_eq!(got.last(), Some(&"step 399"));
    assert_eq!(got.len(), 6 + 100);
    let plain_log: Vec<String> = (0..400).map(|i| format!("ok {i}")).collect();
    assert_eq!(slice_log_tail(&plain_log.join("\n")).lines().count(), 200);
    let huge = "ก".repeat(20_000);
    let cut = slice_log_tail(&huge);
    assert!(cut.len() <= LOG_TAIL_BYTES && cut.chars().all(|c| c == 'ก'));
  }

  #[test]
  fn fetches_failed_job_logs_by_job_or_run() {
    let tmp = tempfile::tempdir().unwrap();
    let log1 = fixture(tmp.path(), "job1.txt", "build ok\nerror: test failed\n");
    let jobs = fixture(tmp.path(), "jobs.json", r#"{"jobs":[{"id":5,"name":"lint","status":"completed","conclusion":"success"},{"id":6,"name":"test","status":"completed","conclusion":"failure"}]}"#);
    let log6 = fixture(tmp.path(), "job6.txt", "FAILED tests/a.rs");
    let (gh, log) = fake_gh(
      tmp.path(),
      &format!("'api repos/acme/app/actions/jobs/901/logs') cat '{log1}';;\n'api repos/acme/app/actions/runs/77/jobs?per_page=100') cat '{jobs}';;\n'api repos/acme/app/actions/jobs/6/logs') cat '{log6}';;"),
    );
    let checks = vec![
      CheckRef { name: "CI / build".into(), url: None, run_id: Some(70), job_id: Some(901) },
      CheckRef { name: "CI / test".into(), url: None, run_id: Some(77), job_id: None },
      CheckRef { name: "vercel".into(), url: Some("https://vercel.com/x".into()), run_id: None, job_id: None },
    ];
    let out = check_logs(&gh, tmp.path(), PR_URL, &checks).unwrap();
    assert_eq!(out[0].log_tail.as_deref(), Some("build ok\nerror: test failed\n"));
    assert_eq!(out[1].log_tail.as_deref(), Some("FAILED tests/a.rs"));
    assert_eq!((out[2].log_tail.as_deref(), out[2].error.as_deref()), (None, None));
    assert_eq!(calls(&log).len(), 3);
  }

  #[test]
  fn log_fetch_is_capped_and_errors_are_kept() {
    let tmp = tempfile::tempdir().unwrap();
    let (gh, log) = fake_gh(tmp.path(), "'api repos/acme/app/actions/jobs/'*) echo 'HTTP 410: logs expired' >&2; exit 1;;");
    let checks: Vec<CheckRef> = (1..=8).map(|i| CheckRef { name: format!("c{i}"), url: None, run_id: None, job_id: Some(i) }).collect();
    let out = check_logs(&gh, tmp.path(), PR_URL, &checks).unwrap();
    assert_eq!(out.len(), 8);
    assert!(out[0].error.as_deref().unwrap().contains("logs expired"));
    assert_eq!(calls(&log).len(), LOG_JOB_LIMIT);
  }

  #[test]
  fn picks_failed_jobs_matching_the_check_name() {
    let json = r#"{"jobs":[{"id":1,"name":"test","conclusion":"failure"},{"id":2,"name":"lint","conclusion":"timed_out"},{"id":3,"name":"test","conclusion":"success"}]}"#;
    assert_eq!(failed_jobs(json, "CI / test"), [1]);
    assert_eq!(failed_jobs(json, "CI / other"), [1, 2]);
    assert!(failed_jobs("nope", "x").is_empty());
  }

  #[test]
  fn lists_review_threads_and_resolves_one() {
    let tmp = tempfile::tempdir().unwrap();
    let threads = fixture(
      tmp.path(),
      "threads.json",
      r#"{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
        {"id":"PRRT_a1","isResolved":false,"line":10,"startLine":8,"originalLine":9,"originalStartLine":null,"comments":{"nodes":[
          {"id":"c1","databaseId":101,"author":{"__typename":"User","login":"reviewer"},"body":"ใช้ const","createdAt":"2026-10-01T00:00:00Z","url":"https://github.com/acme/app/pull/12#discussion_r101","path":"src/a.ts"},
          {"id":"c2","databaseId":102,"author":null,"body":"ok","createdAt":"2026-10-02T00:00:00Z","url":"u2","path":"src/a.ts"}]}},
        {"id":"PRRT_b2","isResolved":true,"line":null,"startLine":null,"originalLine":4,"originalStartLine":null,"comments":{"nodes":[]}}]}}}}}"#,
    );
    let resolved = fixture(tmp.path(), "resolved.json", r#"{"data":{"resolveReviewThread":{"thread":{"isResolved":true}}}}"#);
    let (gh, log) = fake_gh(tmp.path(), &format!("'api graphql -f query='*'reviewThreads'*) cat '{threads}';;\n'api graphql -f query=mutation'*) cat '{resolved}';;"));
    let t = review_threads(&gh, tmp.path(), PR_URL, 12).unwrap();
    assert_eq!(t.len(), 2);
    assert_eq!((t[0].id.as_str(), t[0].resolved, t[0].outdated, t[0].path.as_deref(), t[0].line, t[0].start_line), ("PRRT_a1", false, false, Some("src/a.ts"), Some(10), Some(8)));
    assert_eq!((t[0].comments[0].author.as_str(), t[0].comments[1].author.as_str()), ("reviewer", "ghost"));
    assert_eq!((t[1].outdated, t[1].line), (true, Some(4)));
    let first = &calls(&log)[0];
    assert_eq!(&first[..2], ["api", "graphql"]);
    assert!(first.contains(&"owner=acme".to_owned()) && first.contains(&"repo=app".to_owned()) && first.contains(&"pr=12".to_owned()));
    assert!(resolve_thread(&gh, tmp.path(), PR_URL, "PRRT_a1", true).unwrap());
    assert!(calls(&log)[1].contains(&"threadId=PRRT_a1".to_owned()));
    assert!(resolve_thread(&gh, tmp.path(), PR_URL, "x; rm -rf /", true).is_err());
  }

  #[test]
  fn graphql_errors_are_reported() {
    let err = parse_threads(r#"{"data":{"repository":null},"errors":[{"message":"Resource not accessible by integration"}]}"#).unwrap_err();
    assert!(err.contains("not accessible"), "{err}");
    assert!(parse_threads("{").is_err());
  }
}
