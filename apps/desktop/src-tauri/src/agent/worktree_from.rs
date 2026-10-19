//! Task worktrees on a branch that already exists, Orca's "Reuse branch" and PR start point
//! (`pr-start-point.ts`): an existing local branch is checked out as it is; a remote one (or a
//! branch only origin has, fetched first) gets a local branch tracking it; a GitHub pull request
//! is fetched from origin (`refs/pull/<n>/head` for a fork's PR, which origin always serves) onto
//! a local branch named like its head, whose push goes where gh's `pr checkout` would send it.
//! Also the first-work branch rename command. Every git write waits in the repository's git
//! queue; network steps have a timeout.

use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use tauri::State;

use crate::git_queue::{self, Scope};
use crate::git_remote::{NET_TIMEOUT, check_branch_name, net_env};
use crate::i18n::msg::{AgentMsg, ForgeMsg, WorktreeMsg};
use crate::tr;
use crate::workspace::Workspace;

use super::pr::{GH_TIMEOUT, RepoRef, gh_run};
use super::worktree::{WorktreeInfo, exclude_kingu_logged, git, list, validate_slug, worktree_path};

/// `gh pr view/list --json` fields of a pull request to start a task from.
const PR_HEAD_FIELDS: &str = "number,title,url,state,isDraft,headRefName,baseRefName,isCrossRepository,headRepositoryOwner,headRepository,maintainerCanModify,author,updatedAt";
pub const MAX_PR_LIST: u32 = 100;

fn ref_exists(repo: &Path, full: &str) -> bool {
  git(repo, &["show-ref", "--verify", "--quiet", full]).is_ok()
}

fn config(repo: &Path, key: &str) -> Option<String> {
  git(repo, &["config", "--get", key]).ok().map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

/// git's "already used by worktree at '<path>'" (older: "is already checked out at"), explained.
fn other_worktree(branch: &str, err: &str) -> Option<String> {
  let lower = err.to_lowercase();
  let at = ["used by worktree at", "checked out at"].into_iter().find_map(|k| lower.find(k).map(|i| i + k.len()))?;
  let path = err[at..].trim().lines().next().unwrap_or("").trim().trim_matches(['\'', '"']).to_owned();
  Some(tr!(WorktreeMsg::BranchInOtherWorktree, branch, path))
}

/// `git worktree add` with errors explained; then the new worktree as `git worktree list` has it.
fn add(repo: &Path, slug: &str, branch: &str, args: &[&str]) -> Result<WorktreeInfo, String> {
  git(repo, &[&["worktree", "add"][..], args].concat()).map_err(|e| other_worktree(branch, &e).unwrap_or(e))?;
  list(repo)?.into_iter().find(|w| w.slug.as_deref() == Some(slug)).ok_or_else(|| format!("{slug}: worktree created but not listed"))
}

/// A new worktree's folder: a valid slug whose folder does not exist yet.
fn new_path(repo: &Path, slug: &str) -> Result<String, String> {
  validate_slug(slug)?;
  let path = worktree_path(repo, slug);
  if path.exists() {
    return Err(format!("{}: already exists", path.display()));
  }
  path.to_str().map(str::to_owned).ok_or_else(|| "worktree path is not valid UTF-8".into())
}

/// `(remote, branch)` of a remote-tracking name (`origin/feature/x` → `origin`, `feature/x`), by
/// the longest configured remote it starts with.
pub fn split_remote<'a>(name: &'a str, remotes: &[String]) -> Option<(&'a str, &'a str)> {
  remotes
    .iter()
    .filter_map(|r| name.strip_prefix(r.as_str()).and_then(|rest| rest.strip_prefix('/')).filter(|rest| !rest.is_empty()).map(|rest| (&name[..r.len()], rest)))
    .min_by_key(|(_, rest)| rest.len())
}

fn fetch(repo: &Path, refspec: &str, timeout: Duration) -> Result<String, String> {
  net_env(repo, &["fetch", "--quiet", "--no-tags", "origin", refspec], &[], &AtomicBool::new(false), timeout)
}

/// A task worktree on the existing branch `name` (Orca's "Reuse branch"): a local branch as it is;
/// a remote branch (`origin/x`) through a local `x` tracking it (an existing `x` must already
/// track it); a name no ref has yet is looked for on origin (a branch pushed from elsewhere).
pub fn create_from_branch(repo: &Path, slug: &str, name: &str, timeout: Duration) -> Result<WorktreeInfo, String> {
  let path = new_path(repo, slug)?;
  check_branch_name(repo, name)?;
  exclude_kingu_logged(repo);
  let _queue = git_queue::lock(repo, Scope::Refs, "worktree add")?;
  if ref_exists(repo, &format!("refs/heads/{name}")) {
    let w = add(repo, slug, name, &["--", &path, name])?;
    log::info!("worktree {slug} created at {path} on {name}");
    return Ok(w);
  }
  let remotes = crate::git::remotes(repo)?;
  let (remote_ref, local) = match split_remote(name, &remotes) {
    Some((_, rest)) if ref_exists(repo, &format!("refs/remotes/{name}")) => (name.to_owned(), rest.to_owned()),
    _ => {
      let tracking = format!("origin/{name}");
      if !remotes.iter().any(|r| r == "origin") {
        return Err(tr!(WorktreeMsg::BranchNotFound, branch = name));
      }
      if !ref_exists(repo, &format!("refs/remotes/{tracking}")) {
        fetch(repo, &format!("+refs/heads/{name}:refs/remotes/{tracking}"), timeout).map_err(|e| {
          log::info!("fetch {tracking}: {e}");
          tr!(WorktreeMsg::BranchNotFound, branch = name)
        })?;
      }
      (tracking, name.to_owned())
    }
  };
  check_branch_name(repo, &local)?;
  let w = if ref_exists(repo, &format!("refs/heads/{local}")) {
    let upstream = git(repo, &["rev-parse", "--abbrev-ref", &format!("{local}@{{upstream}}")]).map(|u| u.trim().to_owned()).unwrap_or_default();
    if upstream != remote_ref {
      return Err(tr!(WorktreeMsg::LocalNotTracking, local, remote = remote_ref));
    }
    add(repo, slug, &local, &["--", &path, &local])?
  } else {
    add(repo, slug, &local, &["--track", "-b", &local, "--", &path, &remote_ref])?
  };
  log::info!("worktree {slug} created at {path} on {local} tracking {remote_ref}");
  Ok(w)
}

// ---------------------------------------------------------------------------------------------
// Pull requests

/// A pull request to start a task from (`gh pr view/list --json PR_HEAD_FIELDS`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PrHead {
  pub number: u64,
  pub title: String,
  pub url: String,
  /// `OPEN`, `CLOSED` or `MERGED`.
  pub state: String,
  pub draft: bool,
  pub head_ref: String,
  pub base_ref: String,
  /// The head branch lives in a fork.
  pub cross_repo: bool,
  /// The fork's owner and repository name (empty for a same-repository PR or a deleted fork).
  pub head_owner: String,
  pub head_repo: String,
  /// The fork lets maintainers push to the PR branch.
  pub maintainer_can_modify: bool,
  pub author: String,
  /// ISO 8601.
  pub updated_at: String,
}

fn pr_head_of(v: &serde_json::Value) -> Result<PrHead, String> {
  let text = |v: &serde_json::Value, k: &str| v[k].as_str().unwrap_or_default().to_owned();
  let number = v["number"].as_u64().ok_or_else(|| tr!(AgentMsg::IssueNoNumber))?;
  Ok(PrHead {
    number,
    title: text(v, "title"),
    url: text(v, "url"),
    state: text(v, "state"),
    draft: v["isDraft"].as_bool().unwrap_or(false),
    head_ref: text(v, "headRefName"),
    base_ref: text(v, "baseRefName"),
    cross_repo: v["isCrossRepository"].as_bool().unwrap_or(false),
    head_owner: text(&v["headRepositoryOwner"], "login"),
    head_repo: text(&v["headRepository"], "name"),
    maintainer_can_modify: v["maintainerCanModify"].as_bool().unwrap_or(false),
    author: text(&v["author"], "login"),
    updated_at: text(v, "updatedAt"),
  })
}

pub fn parse_pr_head(json: &str) -> Result<PrHead, String> {
  let v: serde_json::Value = serde_json::from_str(json).map_err(|e| tr!(AgentMsg::GhUnreadable, op = "gh pr view", detail = e))?;
  pr_head_of(&v)
}

pub fn parse_pr_heads(json: &str) -> Result<Vec<PrHead>, String> {
  let v: serde_json::Value = serde_json::from_str(json).map_err(|e| tr!(AgentMsg::GhUnreadable, op = "gh pr list", detail = e))?;
  v.as_array().ok_or_else(|| tr!(AgentMsg::GhNotAList))?.iter().map(pr_head_of).collect()
}

/// What the user typed for a PR: `123`, `#123`, or its GitHub link (`…/pull/123/files#…` too),
/// with the link's repository.
pub fn parse_pr_ref(input: &str) -> Result<(u64, Option<RepoRef>), String> {
  let s = input.trim();
  let bad = || tr!(WorktreeMsg::BadPrRef, input = format!("{s:?}"));
  if let Some(n) = s.strip_prefix('#').unwrap_or(s).parse::<u64>().ok().filter(|n| *n > 0) {
    return Ok((n, None));
  }
  let url = s.split(['?', '#']).next().unwrap_or_default();
  let repo = RepoRef::from_pr_url(url).map_err(|_| bad())?;
  let n = url.split('/').nth(6).and_then(|n| n.parse::<u64>().ok()).filter(|n| *n > 0).ok_or_else(bad)?;
  Ok((n, Some(repo)))
}

/// `(host, owner, repo)` of a GitHub remote URL: `https://host/o/r(.git)`, `ssh://git@host[:22]/o/r`,
/// `git@host:o/r.git`. Lowercase host; owner and repo as written.
pub fn remote_repo(url: &str) -> Option<(String, String, String)> {
  let url = url.trim().trim_end_matches('/');
  let (host, path) = if let Some((_, rest)) = url.split_once("://") {
    let (auth, path) = rest.split_once('/')?;
    let host = auth.rsplit('@').next()?.split(':').next()?;
    (host, path)
  } else {
    let (auth, path) = url.split_once(':')?;
    (auth.rsplit('@').next()?, path)
  };
  let path = path.strip_suffix(".git").unwrap_or(path);
  let (owner, repo) = path.split_once('/')?;
  (!host.is_empty() && !owner.is_empty() && !repo.is_empty() && !repo.contains('/')).then(|| (host.to_ascii_lowercase(), owner.to_owned(), repo.to_owned()))
}

/// origin's URL with the fork's `owner/repo` in place of origin's (same host and protocol), where
/// a maintainer pushes the PR branch.
pub fn fork_url(origin: &str, owner: &str, repo: &str) -> Option<String> {
  let (_, o, r) = remote_repo(origin)?;
  let trimmed = origin.trim().trim_end_matches('/');
  let git = trimmed.ends_with(".git");
  let tail = format!("{o}/{r}{}", if git { ".git" } else { "" });
  let start = trimmed.strip_suffix(tail.as_str())?;
  Some(format!("{start}{owner}/{repo}{}", if git { ".git" } else { "" }))
}

/// Whether an existing local branch may be used for the PR.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Claim {
  /// No such branch.
  Free,
  /// This PR's branch from an earlier checkout (its local commits are kept).
  Mine,
  /// Someone else's: never moved.
  Other,
}

/// The local branch for PR `number`: its head's name like Orca and gh (`feature/x`), else, when
/// that is another branch (a fork's `main`), `pr-<n>-<head>` (`-2` … if needed).
pub fn pick_pr_branch(head: &str, number: u64, claim: impl Fn(&str) -> Claim) -> Option<(String, Claim)> {
  let first = std::iter::once(head.to_owned());
  let rest = (1..=20).map(|i| if i == 1 { format!("pr-{number}-{head}") } else { format!("pr-{number}-{head}-{i}") });
  first.chain(rest).find_map(|name| match claim(&name) {
    Claim::Other => None,
    c => Some((name, c)),
  })
}

/// Origin's URL must name the PR's repository (a PR link of another repository would fetch the
/// wrong `refs/pull/<n>`).
fn check_repository(repo: &Path, pr: Option<&RepoRef>) -> Result<String, String> {
  let origin = config(repo, "remote.origin.url").ok_or_else(|| tr!(AgentMsg::NoOrigin))?;
  if let Some(pr) = pr {
    let same = remote_repo(&origin).is_some_and(|(h, o, r)| h == pr.host && o.eq_ignore_ascii_case(&pr.owner) && r.eq_ignore_ascii_case(&pr.repo));
    if !same {
      return Err(tr!(WorktreeMsg::PrOtherRepository, url = format!("https://{}/{}/{}", pr.host, pr.owner, pr.repo), origin));
    }
  }
  Ok(origin)
}

/// A task worktree on pull request `pr`'s head. Same repository: origin's head branch, tracked.
/// A fork: `refs/pull/<n>/head` from origin; the branch pushes to the fork when its owner lets
/// maintainers edit, else it tracks the pull ref like `gh pr checkout`. Either way
/// `branch.<b>.kinguPr` records the number, so the PR is found exactly (`pr_number_of`).
pub fn create_from_pr(repo: &Path, slug: &str, pr: &PrHead, timeout: Duration) -> Result<WorktreeInfo, String> {
  let path = new_path(repo, slug)?;
  let n = pr.number;
  if pr.head_ref.is_empty() || pr.head_ref.starts_with('-') {
    return Err(tr!(WorktreeMsg::PrNoHead, number = n));
  }
  let origin = check_repository(repo, None)?;
  exclude_kingu_logged(repo);
  let _queue = git_queue::lock(repo, Scope::Refs, "worktree add (pull request)")?;
  let pull_ref = format!("refs/kingu/pr/{n}");
  let fetch_pull = || fetch(repo, &format!("+refs/pull/{n}/head:{pull_ref}"), timeout).map(|_| pull_ref.clone());
  // Same repository: the branch itself (a deleted head branch still has its pull ref).
  let (head_ref, tracking) = if pr.cross_repo {
    (fetch_pull(), false)
  } else {
    let tracking = format!("refs/remotes/origin/{}", pr.head_ref);
    match fetch(repo, &format!("+refs/heads/{}:{tracking}", pr.head_ref), timeout) {
      Ok(_) => (Ok(tracking), true),
      Err(e) => {
        log::info!("fetch {}: {e}; trying refs/pull/{n}/head", pr.head_ref);
        (fetch_pull(), false)
      }
    }
  };
  let head_ref = head_ref.map_err(|e| tr!(WorktreeMsg::PrFetchFailed, number = n, detail = e))?;
  let head = git(repo, &["rev-parse", "--verify", "--quiet", &format!("{head_ref}^{{commit}}")])?.trim().to_owned();
  let claim = |name: &str| {
    if check_branch_name(repo, name).is_err() {
      return Claim::Other;
    }
    if !ref_exists(repo, &format!("refs/heads/{name}")) {
      return Claim::Free;
    }
    let ours = config(repo, &format!("branch.{name}.kinguPr")).as_deref() == Some(n.to_string().as_str())
      || config(repo, &format!("branch.{name}.merge")).as_deref() == Some(format!("refs/pull/{n}/head").as_str())
      || (tracking && git(repo, &["rev-parse", "--abbrev-ref", &format!("{name}@{{upstream}}")]).is_ok_and(|u| u.trim() == format!("origin/{}", pr.head_ref)));
    if ours { Claim::Mine } else { Claim::Other }
  };
  let (branch, claimed) = pick_pr_branch(&pr.head_ref, n, claim).ok_or_else(|| tr!(AgentMsg::BadBranchName, branch = pr.head_ref.clone()))?;
  let w = if claimed == Claim::Free {
    add(repo, slug, &branch, &["-b", &branch, "--", &path, &head])?
  } else {
    // An earlier checkout of the PR: fast-forward it when it only lags behind; local commits stay.
    let tip = git(repo, &["rev-parse", &format!("refs/heads/{branch}")])?.trim().to_owned();
    if tip != head && git(repo, &["merge-base", "--is-ancestor", &tip, &head]).is_ok() && super::worktree::list(repo)?.iter().all(|w| w.branch.as_deref() != Some(branch.as_str())) {
      git(repo, &["update-ref", "-m", &format!("kingu: pull request #{n}"), &format!("refs/heads/{branch}"), &head, &tip])?;
    }
    add(repo, slug, &branch, &["--", &path, &branch])?
  };
  let set = |key: &str, value: &str| git(repo, &["config", &format!("branch.{branch}.{key}"), value]).map(|_| ());
  if tracking {
    set("remote", "origin")?;
    set("merge", &format!("refs/heads/{}", pr.head_ref))?;
  } else if let Some(fork) = (pr.cross_repo && pr.maintainer_can_modify && !pr.head_owner.is_empty() && !pr.head_repo.is_empty()).then(|| fork_url(&origin, &pr.head_owner, &pr.head_repo)).flatten() {
    set("remote", &fork)?;
    set("merge", &format!("refs/heads/{}", pr.head_ref))?;
  } else {
    set("remote", "origin")?;
    set("merge", &format!("refs/pull/{n}/head"))?;
  }
  set("kinguPr", &n.to_string())?;
  log::info!("worktree {slug} created at {path} on {branch} for pull request #{n} ({head})");
  Ok(w)
}

/// gh's failure (`gh_run`: "gh pr view: <stderr>") as a message the user can act on.
fn gh_failed(op: &str, e: &str) -> String {
  super::issues::gh_error(op, e.split_once(": ").map_or(e, |(_, rest)| rest))
}

/// `gh`, for a folder whose pull requests are on GitHub: starting from a GitLab merge request
/// (`refs/merge-requests/<iid>/head`) is not built yet, so a GitLab folder is told so.
fn gh_bin(root: &Path) -> Result<std::path::PathBuf, String> {
  if let super::mr::Forge::Gitlab(_) = super::mr::forge(root) {
    return Err(tr!(ForgeMsg::PrStartNotOnGitlab));
  }
  super::review::gh_bin().ok_or_else(super::issues::gh_missing)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// The pull request `input` names (`123`, `#123` or its link) in the open folder's repository.
pub fn pr_lookup(gh: &Path, repo: &Path, input: &str) -> Result<PrHead, String> {
  let (n, link) = parse_pr_ref(input)?;
  check_repository(repo, link.as_ref())?;
  let out = gh_run(gh, repo, &["pr".into(), "view".into(), n.to_string(), format!("--json={PR_HEAD_FIELDS}")], GH_TIMEOUT, None).map_err(|e| gh_failed("gh pr view", &e))?;
  parse_pr_head(&out)
}

/// Open pull requests of the open folder's repository, newest first (`search`: gh's query).
pub fn pr_list(gh: &Path, repo: &Path, search: Option<&str>, limit: u32) -> Result<Vec<PrHead>, String> {
  let mut args = vec!["pr".to_owned(), "list".to_owned(), "--state=open".to_owned(), format!("--limit={}", limit.clamp(1, MAX_PR_LIST)), format!("--json={PR_HEAD_FIELDS}")];
  if let Some(s) = search.map(str::trim).filter(|s| !s.is_empty()) {
    args.push(format!("--search={s}"));
  }
  let out = gh_run(gh, repo, &args, GH_TIMEOUT, None).map_err(|e| gh_failed("gh pr list", &e))?;
  parse_pr_heads(&out)
}

/// New task worktree `slug` on the existing branch `branch` (local, `origin/x`, or only on origin).
#[tauri::command]
pub async fn worktree_create_from_branch(ws: State<'_, Workspace>, slug: String, branch: String) -> Result<WorktreeInfo, String> {
  let root = ws.root()?;
  blocking(move || create_from_branch(&root, &slug, &branch, NET_TIMEOUT)).await
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PrStart {
  pub worktree: WorktreeInfo,
  pub pr: PrHead,
}

/// New task worktree `slug` on pull request `pr` (number or link) of the open folder's repository.
#[tauri::command]
pub async fn worktree_create_from_pr(ws: State<'_, Workspace>, slug: String, pr: String) -> Result<PrStart, String> {
  let root = ws.root()?;
  let gh = gh_bin(&root)?;
  blocking(move || {
    let pr = pr_lookup(&gh, &root, &pr)?;
    let worktree = create_from_pr(&root, &slug, &pr, NET_TIMEOUT)?;
    Ok(PrStart { worktree, pr })
  })
  .await
}

#[tauri::command]
pub async fn gh_pr_lookup(ws: State<'_, Workspace>, input: String) -> Result<PrHead, String> {
  let root = ws.root()?;
  let gh = gh_bin(&root)?;
  blocking(move || pr_lookup(&gh, &root, &input)).await
}

#[tauri::command]
pub async fn gh_pr_list(ws: State<'_, Workspace>, search: Option<String>, limit: Option<u32>) -> Result<Vec<PrHead>, String> {
  let root = ws.root()?;
  let gh = gh_bin(&root)?;
  blocking(move || pr_list(&gh, &root, search.as_deref(), limit.unwrap_or(30))).await
}

/// The first-work rename of task `slug`'s branch `from` to `<prefix><leaf>` (`worktree::rename_branch`).
#[tauri::command]
pub async fn worktree_rename_branch(ws: State<'_, Workspace>, slug: String, from: String, leaf: String, prefix: String) -> Result<String, String> {
  let root = ws.root()?;
  blocking(move || super::worktree::rename_branch(&root, &slug, &from, &leaf, &prefix)).await
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::PathBuf;
  use std::process::Command;

  fn run(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
      .arg("-C")
      .arg(dir)
      .args(["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"])
      .args(args)
      .output()
      .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
  }

  fn commit(dir: &Path, file: &str) -> String {
    std::fs::write(dir.join(file), file).unwrap();
    run(dir, &["add", "."]);
    run(dir, &["commit", "-qm", file]);
    run(dir, &["rev-parse", "HEAD"])
  }

  /// `origin` (with branches `feature/x`, and a fork PR's `refs/pull/7/head`) and its clone.
  fn origin_and_clone() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let origin = base.join("origin");
    std::fs::create_dir(&origin).unwrap();
    run(&origin, &["init", "-q", "-b", "main"]);
    commit(&origin, "a.txt");
    run(&origin, &["checkout", "-q", "-b", "feature/x"]);
    commit(&origin, "x.txt");
    run(&origin, &["checkout", "-q", "-b", "fork-main", "main"]);
    let fork_tip = commit(&origin, "fork.txt");
    run(&origin, &["update-ref", "refs/pull/7/head", &fork_tip]);
    run(&origin, &["checkout", "-q", "main"]);
    let clone = base.join("clone");
    run(&base, &["clone", "-q", origin.to_str().unwrap(), clone.to_str().unwrap()]);
    (tmp, origin, clone)
  }

  const T: Duration = Duration::from_secs(30);

  #[test]
  fn starts_from_local_remote_and_origin_only_branches() {
    let (_tmp, origin, clone) = origin_and_clone();
    run(&clone, &["branch", "mine"]);
    let w = create_from_branch(&clone, "mine", "mine", T).unwrap();
    assert_eq!(w.branch.as_deref(), Some("mine"));
    // A remote-tracking branch: a local branch tracking it.
    let w = create_from_branch(&clone, "fx", "origin/feature/x", T).unwrap();
    assert_eq!(w.branch.as_deref(), Some("feature/x"));
    assert_eq!(run(&worktree_path(&clone, "fx"), &["rev-parse", "--abbrev-ref", "@{upstream}"]), "origin/feature/x");
    // Pushed after the clone: fetched from origin first.
    run(&origin, &["branch", "later", "feature/x"]);
    let w = create_from_branch(&clone, "later", "later", T).unwrap();
    assert_eq!(w.branch.as_deref(), Some("later"));
    assert_eq!(run(&worktree_path(&clone, "later"), &["rev-parse", "--abbrev-ref", "@{upstream}"]), "origin/later");
    // Unknown, already checked out, folder taken, or a local branch tracking something else.
    let e = crate::i18n::with_locale(crate::i18n::Locale::En, || create_from_branch(&clone, "nope", "no-such-branch", T).unwrap_err());
    assert!(e.contains("neither here nor on origin"), "{e}");
    let e = crate::i18n::with_locale(crate::i18n::Locale::En, || create_from_branch(&clone, "again", "mine", T).unwrap_err());
    assert!(e.contains("already checked out"), "{e}");
    assert!(create_from_branch(&clone, "mine", "main", T).unwrap_err().contains("already exists"));
    run(&clone, &["branch", "fork-main", "main"]);
    let e = crate::i18n::with_locale(crate::i18n::Locale::En, || create_from_branch(&clone, "fm", "origin/fork-main", T).unwrap_err());
    assert!(e.contains("does not track"), "{e}");
    assert!(create_from_branch(&clone, "bad", "--orphan", T).is_err());
    // .kingu/ stays out of the clone's status.
    assert_eq!(run(&clone, &["status", "--porcelain"]), "");
  }

  fn pr(number: u64, head: &str, cross: bool) -> PrHead {
    PrHead {
      number,
      title: "t".into(),
      url: format!("https://github.com/acme/app/pull/{number}"),
      state: "OPEN".into(),
      draft: false,
      head_ref: head.into(),
      base_ref: "main".into(),
      cross_repo: cross,
      head_owner: if cross { "alice".into() } else { String::new() },
      head_repo: if cross { "app".into() } else { String::new() },
      maintainer_can_modify: cross,
      author: "alice".into(),
      updated_at: String::new(),
    }
  }

  #[test]
  fn starts_from_a_same_repository_pull_request() {
    let (_tmp, origin, clone) = origin_and_clone();
    let w = create_from_pr(&clone, "pr-3", &pr(3, "feature/x", false), T).unwrap();
    assert_eq!(w.branch.as_deref(), Some("feature/x"));
    let dir = worktree_path(&clone, "pr-3");
    assert_eq!(run(&dir, &["rev-parse", "HEAD"]), run(&origin, &["rev-parse", "feature/x"]));
    assert_eq!(run(&dir, &["rev-parse", "--abbrev-ref", "@{upstream}"]), "origin/feature/x");
    assert_eq!(crate::agent::worktree::pr_number_of(&dir, "feature/x"), Some(3));
  }

  #[test]
  fn starts_from_a_fork_pull_request_without_moving_a_local_branch_of_its_name() {
    let (_tmp, origin, clone) = origin_and_clone();
    // origin as GitHub names it, still fetched from the local folder.
    run(&clone, &["config", &format!("url.{}.insteadOf", origin.display()), "https://github.com/acme/app"]);
    run(&clone, &["config", "remote.origin.url", "https://github.com/acme/app"]);
    let local_main = run(&clone, &["rev-parse", "main"]);
    // The fork's head branch is called `main`, which the clone has (and has checked out).
    let w = create_from_pr(&clone, "fork", &pr(7, "main", true), T).unwrap();
    assert_eq!(w.branch.as_deref(), Some("pr-7-main"));
    let dir = worktree_path(&clone, "fork");
    assert_eq!(run(&dir, &["rev-parse", "HEAD"]), run(&origin, &["rev-parse", "refs/pull/7/head"]));
    assert_eq!(run(&clone, &["rev-parse", "main"]), local_main);
    // Maintainers may edit: it pushes to the fork (origin's URL with the fork's owner).
    let origin_url = run(&clone, &["config", "remote.origin.url"]);
    assert_eq!(run(&clone, &["config", "branch.pr-7-main.remote"]), fork_url(&origin_url, "alice", "app").unwrap());
    assert_eq!(run(&clone, &["config", "branch.pr-7-main.merge"]), "refs/heads/main");
    assert_eq!(crate::agent::worktree::pr_number_of(&dir, "pr-7-main"), Some(7));
    // A second task for the same PR reuses its branch once the first worktree is gone.
    crate::agent::worktree::remove(&clone, "fork", false, crate::agent::worktree::DeleteBranch::Keep).unwrap();
    let w = create_from_pr(&clone, "fork-2", &pr(7, "main", true), T).unwrap();
    assert_eq!(w.branch.as_deref(), Some("pr-7-main"));
    // An unknown PR fails with the fetch error.
    let e = crate::i18n::with_locale(crate::i18n::Locale::En, || create_from_pr(&clone, "nope", &pr(99, "nope", true), T).unwrap_err());
    assert!(e.contains("#99"), "{e}");
    assert!(create_from_pr(&clone, "bad", &pr(5, "-x", false), T).is_err());
  }

  #[test]
  fn reads_pr_references_and_remote_urls() {
    assert_eq!(parse_pr_ref(" 42 ").unwrap().0, 42);
    assert_eq!(parse_pr_ref("#7").unwrap(), (7, None));
    let (n, r) = parse_pr_ref("https://github.com/acme/app/pull/12/files?w=1#diff").unwrap();
    assert_eq!((n, r.unwrap().slug()), (12, "acme/app".to_owned()));
    for bad in ["", "0", "#", "abc", "https://github.com/acme/app/issues/3", "-1", "https://github.com/acme/app/pull/x"] {
      assert!(parse_pr_ref(bad).is_err(), "{bad}");
    }
    let gh = Some(("github.com".to_owned(), "acme".to_owned(), "app".to_owned()));
    for url in ["https://github.com/acme/app.git", "https://x@GitHub.com/acme/app/", "git@github.com:acme/app.git", "ssh://git@github.com:22/acme/app"] {
      assert_eq!(remote_repo(url), gh, "{url}");
    }
    assert_eq!(remote_repo("/local/path"), None);
    assert_eq!(fork_url("git@github.com:acme/app.git", "alice", "app2").as_deref(), Some("git@github.com:alice/app2.git"));
    assert_eq!(fork_url("https://github.com/acme/app", "alice", "app").as_deref(), Some("https://github.com/alice/app"));
    assert_eq!(split_remote("origin/feature/x", &["origin".into(), "up".into()]), Some(("origin", "feature/x")));
    assert_eq!(split_remote("feature/x", &["origin".into()]), None);
    assert_eq!(split_remote("origin/", &["origin".into()]), None);
  }

  #[test]
  fn picks_the_pr_branch_name() {
    let free = |_: &str| Claim::Free;
    assert_eq!(pick_pr_branch("fix", 3, free), Some(("fix".into(), Claim::Free)));
    let taken = |n: &str| if n == "main" { Claim::Other } else { Claim::Free };
    assert_eq!(pick_pr_branch("main", 3, taken).unwrap().0, "pr-3-main");
    let mine = |n: &str| if n == "main" { Claim::Other } else if n == "pr-3-main" { Claim::Mine } else { Claim::Free };
    assert_eq!(pick_pr_branch("main", 3, mine), Some(("pr-3-main".into(), Claim::Mine)));
    assert_eq!(pick_pr_branch("main", 3, |_| Claim::Other), None);
  }

  #[test]
  fn parses_gh_pull_requests() {
    let json = r#"[{"number":7,"title":"Fix","url":"https://github.com/acme/app/pull/7","state":"OPEN","isDraft":true,
      "headRefName":"main","baseRefName":"main","isCrossRepository":true,"headRepositoryOwner":{"id":"U","login":"alice"},
      "headRepository":{"id":"R","name":"app"},"maintainerCanModify":true,"author":{"login":"alice"},"updatedAt":"2026-10-01T00:00:00Z"},
      {"number":8,"title":"Same","url":"u","state":"OPEN","headRefName":"feat","headRepositoryOwner":null,"headRepository":null}]"#;
    let prs = parse_pr_heads(json).unwrap();
    assert_eq!((prs[0].number, prs[0].draft, prs[0].cross_repo, prs[0].head_owner.as_str(), prs[0].head_repo.as_str()), (7, true, true, "alice", "app"));
    assert_eq!((prs[1].head_ref.as_str(), prs[1].cross_repo, prs[1].head_owner.as_str(), prs[1].maintainer_can_modify), ("feat", false, "", false));
    assert!(parse_pr_heads("{}").is_err());
    assert_eq!(parse_pr_head(r#"{"number":3,"headRefName":"x"}"#).unwrap().head_ref, "x");
  }
}
