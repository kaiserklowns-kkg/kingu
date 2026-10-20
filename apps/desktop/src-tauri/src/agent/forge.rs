//! The code host behind Source Control's PR composer and the Checks tab, from the folder's
//! `origin`: GitHub through `gh`, GitLab through its REST API (`mr.rs`). The webview calls the
//! same `forge_*` commands either way, and a merge request answers in gh's shapes, so every view
//! treats it like a pull request. A GitLab fork's merge requests go into the project it was forked
//! from ([`mr::Route`], read once per project). What GitLab has no counterpart for in Kingu yet
//! (reactions) answers with a translated "not on GitLab yet".

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

use crate::git_queue;
use crate::i18n::msg::{ForgeMsg, MrMsg};
use crate::tr;
use crate::tracker_http::Http;
use crate::workspace::Workspace;

use super::mr::{self, Forge, Project, Route};
use super::pr::MergeMethod;
use super::{blocking, issues, review};

/// A comment longer than this is refused before it reaches either host.
const MAX_COMMENT: usize = 60_000;
/// Lines of a failed GitHub Actions log the Checks tab shows.
const LOG_LINES: usize = 150;
const REACTIONS: [&str; 8] = ["THUMBS_UP", "THUMBS_DOWN", "LAUGH", "CONFUSED", "HEART", "HOORAY", "ROCKET", "EYES"];

/// The GitLab connection of project `p` and where its merge requests go. A project's fork parent
/// does not change while Kingu runs, so the route is read once per project.
pub fn gitlab(p: &Project) -> Result<(Http, Route), String> {
  static ROUTES: OnceLock<Mutex<HashMap<Project, Route>>> = OnceLock::new();
  let t = crate::gitlab::connected(&p.host)?;
  let routes = ROUTES.get_or_init(Mutex::default);
  if let Some(r) = routes.lock().unwrap_or_else(|e| e.into_inner()).get(p).cloned() {
    return Ok((t, r));
  }
  let r = mr::route(&t, p)?;
  routes.lock().unwrap_or_else(|e| e.into_inner()).insert(p.clone(), r.clone());
  Ok((t, r))
}

/// The repository a command acts on: the open folder, or task worktree `slug`.
fn repo_dir(ws: &Workspace, slug: Option<&str>) -> Result<PathBuf, String> {
  let root = ws.root()?;
  match slug.filter(|s| !s.is_empty()) {
    Some(s) => review::task_dir(&root, s),
    None => Ok(root),
  }
}

/// Runs `gh` in `dir`; its stderr becomes the error.
fn gh(dir: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
  let bin = review::gh_bin().ok_or_else(issues::gh_missing)?;
  let out = crate::shell_env::command(&bin).current_dir(dir).env("GH_PROMPT_DISABLED", "1").args(args).output().map_err(|e| format!("gh: {e}"))?;
  if !out.status.success() {
    return Err(format!("gh {}: {}", args.first().unwrap_or(&""), String::from_utf8_lossy(&out.stderr).trim()));
  }
  Ok(out.stdout)
}

/// The merge request the Checks tab shows: `number` when the webview knows it, else the one of
/// the branch checked out in `dir`.
fn gitlab_mr(t: &Http, r: &Route, dir: &Path, number: Option<u64>) -> Result<(Project, u64), String> {
  match number.filter(|n| *n > 0) {
    Some(iid) => Ok((r.target.clone(), iid)),
    None => mr::branch_mr(t, r, dir),
  }
}

fn mr_url(p: &Project, iid: u64) -> String {
  format!("https://{}/{}/-/merge_requests/{iid}", p.host, p.path)
}

/// Pushes the checked-out branch to `origin`, setting its upstream.
fn push_head(dir: &Path) -> Result<(), String> {
  git_queue::with(dir, git_queue::Scope::Refs, "push", || crate::git::run(dir, &["push", "-q", "-u", "origin", "HEAD"])).map(drop).map_err(|e| tr!(ForgeMsg::PushFailed, detail = e))
}

/// The comment as it may be sent: not empty, not huge.
fn check_comment(body: &str) -> Result<(), String> {
  if body.trim().is_empty() {
    return Err(tr!(ForgeMsg::CommentEmpty));
  }
  if body.len() > MAX_COMMENT {
    return Err(tr!(ForgeMsg::CommentTooLarge));
  }
  Ok(())
}

/// The run id in a GitHub Actions details URL (`…/actions/runs/<run>/…`).
pub fn actions_run(url: &str) -> Option<&str> {
  url.split("/actions/runs/").nth(1).and_then(|r| r.split(['/', '?']).next()).filter(|r| !r.is_empty() && r.chars().all(|c| c.is_ascii_digit()))
}

/// The review thread nodes of gh's GraphQL answer.
pub fn github_thread_nodes(v: &Value) -> Value {
  match &v["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"] {
    Value::Array(a) => Value::Array(a.clone()),
    _ => Value::Array(Vec::new()),
  }
}

/// The last `n` lines of `text`.
fn tail_lines(text: &str, n: usize) -> String {
  let lines: Vec<&str> = text.lines().collect();
  lines[lines.len().saturating_sub(n)..].join("\n")
}

/// Source Control's PR composer: pushes the checked-out branch (setting its upstream) and opens a
/// pull request, or on GitLab a merge request (into a fork's parent); returns its URL.
#[tauri::command]
pub async fn forge_pr_create(ws: Workspace, slug: Option<String>, base: String, title: String, body: String, draft: bool) -> Result<String, String> {
  let dir = repo_dir(&ws, slug.as_deref())?;
  crate::git::check_rev(&base)?;
  blocking(move || match mr::forge(&dir) {
    Forge::Gitlab(p) => {
      if title.trim().is_empty() {
        return Err(tr!(MrMsg::EmptyTitle));
      }
      let branch = super::worktree::current_branch(&dir)?.ok_or_else(|| tr!(ForgeMsg::NoBranch))?;
      let (t, r) = gitlab(&p)?;
      push_head(&dir)?;
      mr::create(&t, &r, &branch, &base, &title, &body, draft)
    }
    Forge::Github => {
      if title.trim().is_empty() {
        return Err(tr!(ForgeMsg::PrEmptyTitle));
      }
      push_head(&dir)?;
      let mut args = vec!["pr", "create", "--base", base.as_str(), "--title", title.trim(), "--body", body.as_str()];
      if draft {
        args.push("--draft");
      }
      let out = gh(&dir, &args)?;
      Ok(String::from_utf8_lossy(&out).lines().rev().find(|l| l.starts_with("http")).unwrap_or_default().trim().to_owned())
    }
  })
  .await
}

/// Checks tab actions on the branch's PR: `merge` (with `squash` / `merge` / `rebase`), `auto` /
/// `disableAuto` (merge when checks pass), `close`, `reopen`, `ready` (out of draft).
#[tauri::command]
pub async fn forge_pr_action(ws: Workspace, slug: Option<String>, number: Option<u64>, action: String, method: Option<String>) -> Result<(), String> {
  let dir = repo_dir(&ws, slug.as_deref())?;
  let method = MergeMethod::parse(method.as_deref().unwrap_or("squash")).unwrap_or(MergeMethod::Squash);
  blocking(move || match mr::forge(&dir) {
    Forge::Gitlab(p) => {
      let (t, r) = gitlab(&p)?;
      let (p, iid) = gitlab_mr(&t, &r, &dir, number)?;
      match action.as_str() {
        "merge" => mr::merge(&t, &p, iid, method, false).map(drop),
        "auto" => mr::set_auto_merge(&t, &p, iid, true, method == MergeMethod::Squash),
        "disableAuto" => mr::set_auto_merge(&t, &p, iid, false, false),
        "close" => mr::set_open(&t, &p, iid, false),
        "reopen" => mr::set_open(&t, &p, iid, true),
        "ready" => mr::mark_ready(&t, &p, iid),
        other => Err(tr!(ForgeMsg::UnknownAction, action = other)),
      }
    }
    Forge::Github => {
      let flag = match method {
        MergeMethod::Merge => "--merge",
        MergeMethod::Rebase => "--rebase",
        MergeMethod::Squash => "--squash",
      };
      let args: Vec<&str> = match action.as_str() {
        "merge" => vec!["pr", "merge", flag],
        "auto" => vec!["pr", "merge", "--auto", flag],
        "disableAuto" => vec!["pr", "merge", "--disable-auto"],
        "close" => vec!["pr", "close"],
        "reopen" => vec!["pr", "reopen"],
        "ready" => vec!["pr", "ready"],
        other => return Err(tr!(ForgeMsg::UnknownAction, action = other)),
      };
      gh(&dir, &args).map(drop)
    }
  })
  .await
}

#[tauri::command]
pub async fn forge_pr_edit_title(ws: Workspace, slug: Option<String>, number: Option<u64>, title: String) -> Result<(), String> {
  let dir = repo_dir(&ws, slug.as_deref())?;
  blocking(move || match mr::forge(&dir) {
    Forge::Gitlab(p) => {
      let (t, r) = gitlab(&p)?;
      let (p, iid) = gitlab_mr(&t, &r, &dir, number)?;
      mr::edit_title(&t, &p, iid, &title)
    }
    Forge::Github if title.trim().is_empty() => Err(tr!(ForgeMsg::PrEmptyTitle)),
    Forge::Github => gh(&dir, &["pr", "edit", "--title", title.trim()]).map(drop),
  })
  .await
}

/// The PR's conversation comments and reviews (`gh pr view --json comments,reviews`; a merge
/// request's comments outside review threads, in that shape).
#[tauri::command]
pub async fn forge_pr_comments(ws: Workspace, slug: Option<String>, number: Option<u64>) -> Result<Value, String> {
  let dir = repo_dir(&ws, slug.as_deref())?;
  blocking(move || match mr::forge(&dir) {
    Forge::Gitlab(p) => {
      let (t, r) = gitlab(&p)?;
      let (p, iid) = gitlab_mr(&t, &r, &dir, number)?;
      mr::comments(&t, &p, iid, &mr_url(&p, iid))
    }
    Forge::Github => serde_json::from_slice(&gh(&dir, &["pr", "view", "--json", "comments,reviews"])?).map_err(|e| e.to_string()),
  })
  .await
}

#[tauri::command]
pub async fn forge_pr_comment(ws: Workspace, slug: Option<String>, number: Option<u64>, body: String) -> Result<(), String> {
  let dir = repo_dir(&ws, slug.as_deref())?;
  check_comment(&body)?;
  blocking(move || match mr::forge(&dir) {
    Forge::Gitlab(p) => {
      let (t, r) = gitlab(&p)?;
      let (p, iid) = gitlab_mr(&t, &r, &dir, number)?;
      mr::comment(&t, &p, iid, &body)
    }
    Forge::Github => gh(&dir, &["pr", "comment", "--body", &body]).map(drop),
  })
  .await
}

/// The failed log of a check from its details URL: a GitHub Actions run's failed steps (last
/// lines), or a GitLab job's log tail.
#[tauri::command]
pub async fn forge_check_log(ws: Workspace, slug: Option<String>, url: String) -> Result<String, String> {
  let dir = repo_dir(&ws, slug.as_deref())?;
  blocking(move || match mr::forge(&dir) {
    Forge::Gitlab(p) => mr::job_log(&crate::gitlab::connected(&p.host)?, &p, &url),
    Forge::Github => {
      let run = actions_run(&url).ok_or_else(|| tr!(ForgeMsg::NoCheckDetails))?;
      let out = gh(&dir, &["run", "view", run, "--log-failed"])?;
      Ok(tail_lines(&String::from_utf8_lossy(&out), LOG_LINES))
    }
  })
  .await
}

/// Review threads of the branch's PR as GitHub's GraphQL `reviewThreads` nodes (a merge
/// request's resolvable discussions, in that shape).
#[tauri::command]
pub async fn forge_review_threads(ws: Workspace, slug: Option<String>, number: u64) -> Result<Value, String> {
  let dir = repo_dir(&ws, slug.as_deref())?;
  blocking(move || match mr::forge(&dir) {
    Forge::Gitlab(p) => {
      let (t, r) = gitlab(&p)?;
      let (p, iid) = gitlab_mr(&t, &r, &dir, Some(number))?;
      Ok(mr::thread_nodes(&mr::threads(&t, &p, iid, &mr_url(&p, iid))?))
    }
    Forge::Github => {
      let query = "query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$n){reviewThreads(first:100){nodes{id isResolved path line comments(first:50){nodes{id databaseId body createdAt author{login} reactionGroups{content viewerHasReacted reactors{totalCount}}}}}}}}}";
      let out = gh(&dir, &["api", "graphql", "-F", "owner={owner}", "-F", "repo={repo}", "-F", &format!("n={number}"), "-f", &format!("query={query}")])?;
      Ok(github_thread_nodes(&serde_json::from_slice(&out).map_err(|e| e.to_string())?))
    }
  })
  .await
}

/// Replies inside a review thread (a GitLab discussion).
#[tauri::command]
pub async fn forge_reply_thread(ws: Workspace, slug: Option<String>, number: Option<u64>, thread: String, body: String) -> Result<(), String> {
  let dir = repo_dir(&ws, slug.as_deref())?;
  check_comment(&body)?;
  blocking(move || match mr::forge(&dir) {
    Forge::Gitlab(p) => {
      let (t, r) = gitlab(&p)?;
      let (p, iid) = gitlab_mr(&t, &r, &dir, number)?;
      mr::reply(&t, &p, iid, &thread, &body)
    }
    Forge::Github => {
      let query = "mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}";
      gh(&dir, &["api", "graphql", "-f", &format!("id={thread}"), "-f", &format!("body={body}"), "-f", &format!("query={query}")]).map(drop)
    }
  })
  .await
}

/// Adds or removes a reaction (THUMBS_UP, HEART, …) on a comment by its node id; GitHub only.
#[tauri::command]
pub async fn forge_react(ws: Workspace, slug: Option<String>, subject: String, content: String, remove: bool) -> Result<(), String> {
  let dir = repo_dir(&ws, slug.as_deref())?;
  if !REACTIONS.contains(&content.as_str()) {
    return Err(tr!(ForgeMsg::UnknownReaction, content));
  }
  blocking(move || match mr::forge(&dir) {
    Forge::Gitlab(_) => Err(tr!(ForgeMsg::ReactionsNotOnGitlab)),
    Forge::Github => {
      let m = if remove { "removeReaction" } else { "addReaction" };
      let query = format!("mutation($id:ID!,$c:ReactionContent!){{{m}(input:{{subjectId:$id,content:$c}}){{reaction{{content}}}}}}");
      gh(&dir, &["api", "graphql", "-f", &format!("id={subject}"), "-f", &format!("c={content}"), "-f", &format!("query={query}")]).map(drop)
    }
  })
  .await
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn reads_an_actions_run_and_the_log_tail() {
    assert_eq!(actions_run("https://github.com/a/b/actions/runs/123/job/456"), Some("123"));
    assert_eq!(actions_run("https://github.com/a/b/actions/runs/123?check_suite_focus=true"), Some("123"));
    assert_eq!(actions_run("https://gitlab.com/a/b/-/jobs/5"), None);
    assert_eq!(actions_run("https://github.com/a/b/actions/runs/12x"), None);
    assert_eq!(tail_lines("a\nb\nc", 2), "b\nc");
    assert_eq!(tail_lines("a", 5), "a");
  }

  #[test]
  fn github_review_threads_come_out_as_nodes() {
    let v = json!({ "data": { "repository": { "pullRequest": { "reviewThreads": { "nodes": [{ "id": "PRRT_1", "isResolved": false }] } } } } });
    assert_eq!(github_thread_nodes(&v), json!([{ "id": "PRRT_1", "isResolved": false }]));
    assert_eq!(github_thread_nodes(&json!({ "data": { "repository": null } })), json!([]));
  }

  #[test]
  fn comments_must_be_sendable() {
    assert_eq!(check_comment("  \n").unwrap_err(), tr!(ForgeMsg::CommentEmpty));
    assert_eq!(check_comment(&"x".repeat(MAX_COMMENT + 1)).unwrap_err(), tr!(ForgeMsg::CommentTooLarge));
    assert!(check_comment("ขอบคุณ").is_ok());
  }

  #[test]
  fn links_a_merge_request() {
    let p = Project { host: "git.acme.dev:8443".into(), path: "team/svc".into() };
    assert_eq!(mr_url(&p, 3), "https://git.acme.dev:8443/team/svc/-/merge_requests/3");
  }

  #[test]
  fn a_task_worktree_or_the_folder_is_pushed_to_origin() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let (repo, remote) = (root.join("repo"), root.join("remote.git"));
    let git = |dir: &Path, args: &[&str]| crate::git::run(dir, args).unwrap();
    std::fs::create_dir_all(&repo).unwrap();
    git(&root, &["init", "-q", "--bare", remote.to_str().unwrap()]);
    git(&repo, &["init", "-q", "-b", "feature"]);
    for (k, v) in [("user.name", "t"), ("user.email", "t@example.com"), ("commit.gpgsign", "false")] {
      git(&repo, &["config", k, v]);
    }
    std::fs::write(repo.join("a.txt"), "a\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "init"]);
    assert!(push_head(&repo).unwrap_err().starts_with(&tr!(ForgeMsg::PushFailed, detail = "")), "no origin yet");
    git(&repo, &["remote", "add", "origin", remote.to_str().unwrap()]);
    push_head(&repo).unwrap();
    assert!(!git(&remote, &["branch", "--list", "feature"]).is_empty());
    assert_eq!(String::from_utf8_lossy(&git(&repo, &["rev-parse", "--abbrev-ref", "feature@{upstream}"])).trim(), "origin/feature");
  }
}
