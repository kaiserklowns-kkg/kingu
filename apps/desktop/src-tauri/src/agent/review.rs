//! Reviewing a task worktree against its base branch: what changed (numstat + untracked files),
//! rejecting a file (restore it from the base), committing, merging into the base locally and
//! opening a pull request with `gh`. Every git call goes through `git::run` (no shell,
//! `--literal-pathspecs`, paths after `--`); revisions are checked with `git::check_rev` and
//! resolved to commit ids before use.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::git::{self, check_rel, check_rev};

use super::worktree::{task_branch, validate_slug, worktree_path};

/// Untracked files larger than this are counted as changed but not line-counted.
const MAX_COUNT_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct FileChange {
  /// Path in the worktree (the destination of a rename).
  pub path: String,
  /// Source of a rename or copy.
  pub orig_path: Option<String>,
  /// `M`, `A`, `D`, `R`, `C`, `T`, or `?` for untracked.
  pub status: String,
  /// Lines added / deleted; `None` for binary files.
  pub added: Option<u64>,
  pub deleted: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DiffStat {
  pub base: String,
  /// Commit the task forked from (`git merge-base <base> HEAD`); diffs are against it.
  pub merge_base: String,
  pub head: String,
  /// Commits on the task branch not in the base, and the other way round.
  pub ahead: u32,
  pub behind: u32,
  /// Uncommitted changes (tracked or untracked) in the worktree.
  pub dirty: bool,
  pub files: Vec<FileChange>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct MergeResult {
  pub commit: String,
  pub fast_forward: bool,
  /// Folder whose checkout was updated, `None` when only the branch ref moved.
  pub checkout: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct GhStatus {
  pub installed: bool,
  pub authenticated: bool,
  pub path: Option<String>,
  /// `gh auth status` output (or why it could not run), for the "how to log in" hint.
  pub detail: String,
}

fn text(out: Vec<u8>) -> String {
  String::from_utf8_lossy(&out).into_owned()
}

/// The task's worktree folder, refusing anything that is not a linked worktree (a `.git` file),
/// so git can never fall through to the enclosing repository.
pub fn task_dir(root: &Path, slug: &str) -> Result<PathBuf, String> {
  validate_slug(slug)?;
  let dir = worktree_path(root, slug);
  let meta = std::fs::symlink_metadata(&dir).map_err(|_| format!("{slug}: no worktree"))?;
  if !meta.is_dir() || !dir.join(".git").is_file() {
    return Err(format!("{slug}: not a task worktree"));
  }
  Ok(dir)
}

/// Commit id of `rev`, or an error naming it.
pub fn resolve_commit(dir: &Path, rev: &str) -> Result<String, String> {
  check_rev(rev)?;
  git::run(dir, &["rev-parse", "--verify", "--quiet", "--end-of-options", &format!("{rev}^{{commit}}")])
    .map(|o| text(o).trim().to_owned())
    .map_err(|_| format!("{rev}: not a commit"))
}

/// A local branch name (`main`, `feature/x`), checked by git's own rules.
fn check_branch(dir: &Path, name: &str) -> Result<(), String> {
  check_rev(name)?;
  git::run(dir, &["check-ref-format", "--branch", name]).map_err(|_| format!("{name}: invalid branch name"))?;
  git::run(dir, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{name}")]).map_err(|_| format!("{name}: no such local branch"))?;
  Ok(())
}

fn count(dir: &Path, range: &[&str]) -> Result<u32, String> {
  let mut args = vec!["rev-list", "--count"];
  args.extend_from_slice(range);
  Ok(text(git::run(dir, &args)?).trim().parse().unwrap_or(0))
}

pub fn merge_base(dir: &Path, base: &str) -> Result<String, String> {
  let base = resolve_commit(dir, base)?;
  let head = resolve_commit(dir, "HEAD")?;
  Ok(text(git::run(dir, &["merge-base", &base, &head])?).trim().to_owned())
}

/// A commit of the task branch (PR form prefill).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Commit {
  pub subject: String,
  pub body: String,
}

const MAX_COMMITS: usize = 200;

/// Commits on HEAD since it forked from `base`, oldest first (at most `MAX_COMMITS`, the newest).
pub fn commits_since(dir: &Path, base: &str) -> Result<Vec<Commit>, String> {
  let fork = merge_base(dir, base)?;
  let range = format!("{fork}..HEAD");
  let max = format!("--max-count={MAX_COMMITS}");
  let out = text(git::run(dir, &["log", "--no-merges", &max, "--format=%s%x1f%b%x1e", &range])?);
  let mut commits: Vec<Commit> = out
    .split('\x1e')
    .filter_map(|rec| {
      let rec = rec.trim_start_matches('\n');
      let (subject, body) = rec.split_once('\x1f')?;
      Some(Commit { subject: subject.trim().to_owned(), body: body.trim().to_owned() })
    })
    .collect();
  commits.reverse();
  Ok(commits)
}

/// Lines in an untracked file; `None` when binary (a NUL byte) or too large to read.
fn line_count(path: &Path) -> Option<u64> {
  let meta = std::fs::symlink_metadata(path).ok()?;
  if meta.file_type().is_symlink() {
    return Some(1);
  }
  if meta.len() > MAX_COUNT_BYTES {
    return None;
  }
  let bytes = std::fs::read(path).ok()?;
  if bytes.contains(&0) {
    return None;
  }
  let lines = bytes.iter().filter(|&&b| b == b'\n').count() as u64;
  Some(if bytes.last().is_some_and(|&b| b != b'\n') { lines + 1 } else { lines })
}

/// Parses `git diff --numstat -z`: `a\td\tpath\0`, or `a\td\t\0src\0dst\0` for a rename.
/// Binary files show `-` counts. Keyed by destination path.
pub fn parse_numstat(out: &str) -> BTreeMap<String, (Option<u64>, Option<u64>)> {
  let mut map = BTreeMap::new();
  let mut tokens = out.split('\0');
  while let Some(tok) = tokens.next() {
    let mut fields = tok.splitn(3, '\t');
    let (Some(a), Some(d), Some(path)) = (fields.next(), fields.next(), fields.next()) else { continue };
    let path = if path.is_empty() {
      let _src = tokens.next();
      match tokens.next() {
        Some(dst) => dst,
        None => continue,
      }
    } else {
      path
    };
    map.insert(path.to_owned(), (a.parse().ok(), d.parse().ok()));
  }
  map
}

/// Parses `git diff --name-status -z`: `X\0path\0`, or `R100\0src\0dst\0` for renames and copies.
pub fn parse_name_status(out: &str) -> Vec<(String, String, Option<String>)> {
  let mut list = Vec::new();
  let mut tokens = out.split('\0');
  while let Some(code) = tokens.next() {
    let Some(letter) = code.chars().next() else { continue };
    let Some(first) = tokens.next() else { break };
    if matches!(letter, 'R' | 'C') {
      let Some(dst) = tokens.next() else { break };
      list.push((letter.to_string(), dst.to_owned(), Some(first.to_owned())));
    } else {
      list.push((letter.to_string(), first.to_owned(), None));
    }
  }
  list
}

/// Everything that differs between the task's fork point and its working tree, committed or not,
/// plus untracked files (respecting `.gitignore`).
pub fn diff_stat(dir: &Path, base: &str) -> Result<DiffStat, String> {
  let mb = merge_base(dir, base)?;
  let head = resolve_commit(dir, "HEAD")?;
  let base_commit = resolve_commit(dir, base)?;
  let numstat = parse_numstat(&text(git::run(dir, &["diff", "--numstat", "-z", "-M", &mb, "--"])?));
  let mut files: Vec<FileChange> = parse_name_status(&text(git::run(dir, &["diff", "--name-status", "-z", "-M", &mb, "--"])?))
    .into_iter()
    .map(|(status, path, orig_path)| {
      let (added, deleted) = numstat.get(&path).copied().unwrap_or((None, None));
      FileChange { path, orig_path, status, added, deleted }
    })
    .collect();
  let untracked = text(git::run(dir, &["ls-files", "--others", "--exclude-standard", "-z"])?);
  for path in untracked.split('\0').filter(|p| !p.is_empty()) {
    let lines = line_count(&dir.join(path));
    files.push(FileChange { path: path.to_owned(), orig_path: None, status: "?".into(), added: lines, deleted: lines.map(|_| 0) });
  }
  files.sort_by(|a, b| a.path.cmp(&b.path));
  let dirty = !git::run(dir, &["status", "--porcelain", "-z"])?.is_empty();
  Ok(DiffStat {
    base: base.to_owned(),
    ahead: count(dir, &[&head, &format!("^{mb}")])?,
    behind: count(dir, &[&base_commit, &format!("^{head}")])?,
    merge_base: mb,
    head,
    dirty,
    files,
  })
}

/// Rejects changes: each path goes back to how it was at the fork point. A file that did not
/// exist there (added, untracked, a rename's destination) is removed from the index and disk.
pub fn reject(dir: &Path, base: &str, paths: &[String]) -> Result<(), String> {
  let mb = merge_base(dir, base)?;
  for p in paths {
    check_rel(dir, p)?;
  }
  for p in paths {
    if git::run(dir, &["cat-file", "-e", &format!("{mb}:./{p}")]).is_ok() {
      git::run(dir, &["restore", &format!("--source={mb}"), "--staged", "--worktree", "--", p])?;
    } else {
      git::run(dir, &["rm", "--cached", "-q", "--ignore-unmatch", "--", p])?;
      let full = dir.join(p);
      if std::fs::symlink_metadata(&full).is_ok() {
        std::fs::remove_file(&full).map_err(|e| format!("{p}: {e}"))?;
      }
    }
  }
  Ok(())
}

/// Stages everything in the worktree and commits it.
pub fn commit_all(dir: &Path, message: &str) -> Result<(), String> {
  git::stage(dir, &[".".into()])?;
  git::commit(dir, message, false)
}

fn clean(dir: &Path, untracked: bool) -> Result<bool, String> {
  let flag = if untracked { "--untracked-files=all" } else { "--untracked-files=no" };
  Ok(git::run(dir, &["status", "--porcelain", "-z", flag])?.is_empty())
}

/// Merges the task branch (`kingu/<slug>` by default) into the local branch `base`. Where `base` is checked out (the main
/// folder or another worktree) that checkout must have no tracked changes and runs `git merge`
/// (`--ff-only`, or `--no-ff` for a merge commit; a conflicting merge is aborted). When it is
/// not checked out anywhere, only a fast-forward is possible and just the ref moves.
pub fn merge_local(repo: &Path, slug: &str, base: &str, merge_commit: bool) -> Result<MergeResult, String> {
  let dir = task_dir(repo, slug)?;
  check_branch(repo, base)?;
  let branch = task_branch(&dir, slug)?;
  if base == branch {
    return Err("cannot merge a task into its own branch".into());
  }
  if !clean(&dir, true)? {
    return Err(format!("{slug}: มีการเปลี่ยนแปลงที่ยังไม่ commit, commit หรือทิ้งก่อน merge"));
  }
  let task = resolve_commit(repo, &format!("refs/heads/{branch}"))?;
  let old = resolve_commit(repo, &format!("refs/heads/{base}"))?;
  if count(repo, &[&task, &format!("^{old}")])? == 0 {
    return Err(format!("{branch}: ไม่มี commit ใหม่ให้ merge เข้า {base}"));
  }
  let ff_possible = git::run(repo, &["merge-base", "--is-ancestor", &old, &task]).is_ok();
  let target = super::worktree::list(repo)?.into_iter().find(|w| w.branch.as_deref() == Some(base) && !w.bare);
  match target {
    Some(w) => {
      let at = PathBuf::from(&w.path);
      if !clean(&at, false)? {
        return Err(format!("{}: {base} มีการแก้ไขที่ยังไม่ commit", w.path));
      }
      let msg = format!("Merge {branch} into {base}");
      let args: Vec<&str> =
        if merge_commit { vec!["merge", "--no-ff", "--no-edit", "-m", &msg, &task] } else { vec!["merge", "--ff-only", &task] };
      if let Err(e) = git::run(&at, &args) {
        let _ = git::run(&at, &["merge", "--abort"]);
        return Err(e);
      }
      let commit = resolve_commit(&at, "HEAD")?;
      log::info!("merged {branch} into {base} at {} ({commit})", w.path);
      Ok(MergeResult { fast_forward: commit == task, commit, checkout: Some(w.path) })
    }
    None if merge_commit => Err(format!("{base} ไม่ได้ checkout อยู่ที่ไหน: merge commit ต้อง checkout {base} ก่อน")),
    None if !ff_possible => Err(format!("{base} มี commit ใหม่: fast-forward ไม่ได้, checkout {base} แล้วใช้ merge commit")),
    None => {
      let msg = format!("kingu: fast-forward {base} to {branch}");
      git::run(repo, &["update-ref", "-m", &msg, &format!("refs/heads/{base}"), &task, &old])?;
      log::info!("fast-forwarded {base} to {branch} ({task})");
      Ok(MergeResult { commit: task, fast_forward: true, checkout: None })
    }
  }
}

/// `name` in a `PATH`-style list of folders.
pub fn find_on_path(name: &str, path: Option<OsString>) -> Option<PathBuf> {
  std::env::split_paths(&path?).map(|d| d.join(name)).find(|p| p.is_file())
}

/// The `gh` binary: `KINGU_GH_BIN`, else `gh` on the login-shell PATH (`shell_env`, since a GUI app
/// launched from Finder only has launchd's PATH), plus Homebrew's folders as a fallback.
pub fn gh_bin() -> Option<PathBuf> {
  if let Some(p) = std::env::var_os("KINGU_GH_BIN") {
    return Some(PathBuf::from(p));
  }
  let mut path = crate::shell_env::path().unwrap_or_default();
  if !path.is_empty() {
    path.push(":");
  }
  path.push("/opt/homebrew/bin:/usr/local/bin");
  find_on_path("gh", Some(path))
}

/// Installed and logged in? Runs `gh auth status` (exit 0 when a host is authenticated).
pub fn gh_status(bin: Option<PathBuf>) -> GhStatus {
  let Some(bin) = bin else {
    return GhStatus { installed: false, authenticated: false, path: None, detail: "gh not found".into() };
  };
  let path = Some(bin.display().to_string());
  match crate::shell_env::command(&bin).args(["auth", "status"]).output() {
    Ok(out) => {
      let detail = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)).trim().to_owned();
      GhStatus { installed: true, authenticated: out.status.success(), path, detail }
    }
    Err(e) => GhStatus { installed: false, authenticated: false, path, detail: e.to_string() },
  }
}

/// `gh pr create` arguments; `draft` from `kingu.pr.draft` (Orca's PR creation defaults).
pub fn pr_create_args(base: &str, branch: &str, title: &str, body: &str, draft: bool) -> Vec<String> {
  let mut args = vec!["pr".to_owned(), "create".to_owned(), format!("--base={base}"), format!("--head={branch}"), format!("--title={title}"), format!("--body={body}")];
  if draft {
    args.push("--draft".to_owned());
  }
  args
}

/// Pushes the task branch to `origin` and opens a pull request against `base`; returns its URL.
pub fn pr_create(gh: &Path, dir: &Path, slug: &str, base: &str, title: &str, body: &str, draft: bool) -> Result<String, String> {
  check_rev(base)?;
  if title.trim().is_empty() {
    return Err("PR title is empty".into());
  }
  git::run(dir, &["remote", "get-url", "origin"]).map_err(|_| "ไม่มี remote ชื่อ origin".to_owned())?;
  let branch = task_branch(dir, slug)?;
  git::run(dir, &["push", "-u", "origin", &format!("refs/heads/{branch}:refs/heads/{branch}")])?;
  let out = crate::shell_env::command(gh)
    .current_dir(dir)
    .args(pr_create_args(base, &branch, title, body, draft))
    .output()
    .map_err(|e| format!("gh: {e}"))?;
  if !out.status.success() {
    return Err(format!("gh pr create: {}", String::from_utf8_lossy(&out.stderr).trim()));
  }
  let url = String::from_utf8_lossy(&out.stdout).lines().rev().find(|l| l.starts_with("http")).unwrap_or_default().trim().to_owned();
  Ok(url)
}

/// One CI check of a pull request (a GitHub Actions run or a commit status).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct PrCheck {
  pub name: String,
  /// `pending`, `success`, `failure`, `neutral`, `skipped` or `cancelled`.
  pub state: &'static str,
  pub url: Option<String>,
}

/// The task branch's pull request as GitHub sees it (Orca's Checks panel).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct PrStatus {
  pub number: u64,
  pub url: String,
  pub title: String,
  /// `OPEN`, `CLOSED` or `MERGED`.
  pub state: String,
  pub draft: bool,
  /// `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED` or empty.
  pub review: String,
  /// `MERGEABLE`, `CONFLICTING` or `UNKNOWN`.
  pub mergeable: String,
  pub checks: Vec<PrCheck>,
}

/// `gh pr view --json` fields read by `parse_pr_status`.
pub const PR_FIELDS: &str = "number,url,title,state,isDraft,reviewDecision,mergeable,statusCheckRollup";

fn check_state(status: &str, conclusion: &str) -> &'static str {
  // CheckRun: status QUEUED/IN_PROGRESS/COMPLETED + conclusion; StatusContext: state only.
  match (status, conclusion) {
    (s, _) if !s.is_empty() && s != "COMPLETED" => "pending",
    (_, "SUCCESS") => "success",
    (_, "FAILURE" | "ERROR" | "TIMED_OUT" | "ACTION_REQUIRED" | "STARTUP_FAILURE") => "failure",
    (_, "CANCELLED") => "cancelled",
    (_, "SKIPPED" | "STALE") => "skipped",
    (_, "NEUTRAL") => "neutral",
    (_, "PENDING" | "EXPECTED" | "") => "pending",
    _ => "neutral",
  }
}

/// `gh pr view --json PR_FIELDS` output → the status Kingu shows.
pub fn parse_pr_status(json: &str) -> Result<PrStatus, String> {
  let v: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("gh pr view: {e}"))?;
  let text = |k: &str| v[k].as_str().unwrap_or_default().to_owned();
  let checks = v["statusCheckRollup"]
    .as_array()
    .map(|items| {
      items
        .iter()
        .map(|c| {
          let s = |k: &str| c[k].as_str().unwrap_or_default();
          if s("__typename") == "StatusContext" {
            PrCheck { name: s("context").to_owned(), state: check_state("", s("state")), url: c["targetUrl"].as_str().map(str::to_owned) }
          } else {
            let name = match (s("workflowName"), s("name")) {
              ("", n) => n.to_owned(),
              (w, n) => format!("{w} / {n}"),
            };
            PrCheck { name, state: check_state(s("status"), s("conclusion")), url: c["detailsUrl"].as_str().map(str::to_owned) }
          }
        })
        .collect()
    })
    .unwrap_or_default();
  Ok(PrStatus {
    number: v["number"].as_u64().ok_or("gh pr view: no PR number")?,
    url: text("url"),
    title: text("title"),
    state: text("state"),
    draft: v["isDraft"].as_bool().unwrap_or(false),
    review: text("reviewDecision"),
    mergeable: text("mergeable"),
    checks,
  })
}

/// `gh pr view` saying the branch has no pull request yet ("No pull requests found for branch …";
/// gh capitalises it differently across versions): not an error.
pub fn is_no_pr(stderr: &str) -> bool {
  let e = stderr.to_lowercase();
  e.contains("no pull requests found") || e.contains("no open pull requests")
}

/// The pull request of the task branch, or of the branch checked out in `dir` when `slug` is
/// `None` (the open folder itself), via `gh pr view`; `None` when the branch has none.
pub fn pr_status(gh: &Path, dir: &Path, slug: Option<&str>) -> Result<Option<PrStatus>, String> {
  let mut args = vec!["pr".to_owned(), "view".to_owned()];
  if let Some(slug) = slug {
    args.push(task_branch(dir, slug)?);
  }
  args.extend(["--json".to_owned(), PR_FIELDS.to_owned()]);
  let out = crate::shell_env::command(gh)
    .current_dir(dir)
    .env("GH_PROMPT_DISABLED", "1")
    .args(&args)
    .output()
    .map_err(|e| format!("gh: {e}"))?;
  if !out.status.success() {
    let err = String::from_utf8_lossy(&out.stderr);
    if is_no_pr(&err) {
      return Ok(None);
    }
    return Err(format!("gh pr view: {}", err.trim()));
  }
  parse_pr_status(&String::from_utf8_lossy(&out.stdout)).map(Some)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::process::Command;
  use crate::agent::worktree;

  fn git_ok(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
  }

  fn write(dir: &Path, rel: &str, text: &str) {
    let p = dir.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
  }

  /// main with keep.txt, edit.txt, gone.txt, old.txt (several lines so renames are detected);
  /// a task worktree `t` forked from it.
  fn setup() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().canonicalize().unwrap();
    git_ok(&repo, &["init", "-q", "-b", "main"]);
    for (k, v) in [("user.name", "t"), ("user.email", "t@example.com"), ("commit.gpgsign", "false")] {
      git_ok(&repo, &["config", k, v]);
    }
    write(&repo, ".gitignore", ".kingu/\n*.log\n");
    write(&repo, "keep.txt", "keep\n");
    write(&repo, "edit.txt", "one\ntwo\nthree\n");
    write(&repo, "gone.txt", "bye\n");
    write(&repo, "old.txt", "a\nb\nc\nd\ne\nf\n");
    git_ok(&repo, &["add", "."]);
    git_ok(&repo, &["commit", "-q", "-m", "init"]);
    worktree::create(&repo, "t", Some("main"), None).unwrap();
    let wt = task_dir(&repo, "t").unwrap();
    (tmp, repo, wt)
  }

  fn file<'a>(st: &'a DiffStat, path: &str) -> &'a FileChange {
    st.files.iter().find(|f| f.path == path).unwrap_or_else(|| panic!("{path} not in {:?}", st.files))
  }

  #[test]
  fn pr_create_arguments_keep_values_attached_and_add_draft() {
    let args = pr_create_args("main", "kingu/t", "--title", "-b", false);
    assert_eq!(args, ["pr", "create", "--base=main", "--head=kingu/t", "--title=--title", "--body=-b"]);
    assert_eq!(pr_create_args("main", "kingu/t", "x", "", true).last().map(String::as_str), Some("--draft"));
  }

  #[test]
  fn commits_since_lists_the_branch_commits_oldest_first() {
    let (_tmp, repo, wt) = setup();
    assert_eq!(commits_since(&wt, "main").unwrap(), []);
    write(&wt, "a.txt", "a\n");
    git_ok(&wt, &["add", "."]);
    git_ok(&wt, &["commit", "-q", "-m", "เพิ่ม a", "-m", "รายละเอียด\nบรรทัดสอง"]);
    write(&wt, "b.txt", "b\n");
    git_ok(&wt, &["add", "."]);
    git_ok(&wt, &["commit", "-q", "-m", "add b"]);
    // A commit on main after the fork is not the task's.
    write(&repo, "m.txt", "m\n");
    git_ok(&repo, &["add", "m.txt"]);
    git_ok(&repo, &["commit", "-q", "-m", "on main"]);
    let commits = commits_since(&wt, "main").unwrap();
    assert_eq!(
      commits,
      [
        Commit { subject: "เพิ่ม a".into(), body: "รายละเอียด\nบรรทัดสอง".into() },
        Commit { subject: "add b".into(), body: String::new() }
      ]
    );
    assert!(commits_since(&wt, "-x").is_err());
  }

  /// `gh pr create` with a fake `gh`: the branch is pushed to origin and gh gets the edited
  /// title, body, base and --draft as separate attached arguments; its URL comes back.
  #[cfg(unix)]
  #[test]
  fn pr_create_pushes_then_runs_gh_with_the_form_values() {
    use std::os::unix::fs::PermissionsExt;
    let (tmp, repo, wt) = setup();
    let remote = tmp.path().join("remote.git");
    git_ok(tmp.path(), &["init", "-q", "--bare", remote.to_str().unwrap()]);
    git_ok(&repo, &["remote", "add", "origin", remote.to_str().unwrap()]);
    write(&wt, "new.txt", "n\n");
    git_ok(&wt, &["add", "."]);
    git_ok(&wt, &["commit", "-q", "-m", "add new"]);
    let log = tmp.path().join("gh-args");
    let gh = tmp.path().join("gh");
    std::fs::write(&gh, format!("#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\" >> '{}'; done\necho https://github.com/acme/app/pull/7\n", log.display())).unwrap();
    std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
    let url = pr_create(&gh, &wt, "t", "main", "แก้ login", "Fixes #3\n\nรายละเอียด", true).unwrap();
    assert_eq!(url, "https://github.com/acme/app/pull/7");
    let args = std::fs::read_to_string(&log).unwrap();
    assert_eq!(args, "pr\ncreate\n--base=main\n--head=kingu/t\n--title=แก้ login\n--body=Fixes #3\n\nรายละเอียด\n--draft\n");
    assert_eq!(git_ok(&remote, &["log", "-1", "--format=%s", "kingu/t"]).trim(), "add new");
    assert!(pr_create(&gh, &wt, "t", "main", "  ", "", false).is_err(), "empty title");
  }

  #[test]
  fn diff_stat_covers_every_kind_of_change() {
    let (_tmp, _repo, wt) = setup();
    assert!(diff_stat(&wt, "main").unwrap().files.is_empty());

    write(&wt, "edit.txt", "one\nTWO\nthree\nfour\n"); // M +2 -1, uncommitted
    std::fs::remove_file(wt.join("gone.txt")).unwrap(); // D
    git_ok(&wt, &["mv", "old.txt", "new.txt"]); // R
    write(&wt, "added.txt", "x\ny\n");
    git_ok(&wt, &["add", "added.txt"]);
    git_ok(&wt, &["commit", "-q", "-m", "task work"]); // A, committed (with the rename)
    write(&wt, "dir/untracked.txt", "u1\nu2\nu3"); // ?, 3 lines without a final newline
    write(&wt, "bin.dat", "a\0b");
    write(&wt, "ignored.log", "nope\n");

    let st = diff_stat(&wt, "main").unwrap();
    let paths: Vec<_> = st.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, ["added.txt", "bin.dat", "dir/untracked.txt", "edit.txt", "gone.txt", "new.txt"]);
    let e = file(&st, "edit.txt");
    assert_eq!((e.status.as_str(), e.added, e.deleted), ("M", Some(2), Some(1)));
    let g = file(&st, "gone.txt");
    assert_eq!((g.status.as_str(), g.added, g.deleted), ("D", Some(0), Some(1)));
    let r = file(&st, "new.txt");
    assert_eq!((r.status.as_str(), r.orig_path.as_deref(), r.added, r.deleted), ("R", Some("old.txt"), Some(0), Some(0)));
    let a = file(&st, "added.txt");
    assert_eq!((a.status.as_str(), a.added, a.deleted), ("A", Some(2), Some(0)));
    let u = file(&st, "dir/untracked.txt");
    assert_eq!((u.status.as_str(), u.added, u.deleted), ("?", Some(3), Some(0)));
    assert_eq!(file(&st, "bin.dat").added, None, "binary files have no line counts");
    assert_eq!((st.ahead, st.behind), (1, 0));
    assert!(st.dirty);
    assert_eq!(st.merge_base, git_ok(&wt, &["rev-parse", "main"]).trim());
  }

  #[test]
  fn diff_stat_counts_commits_behind_and_rejects_bad_bases() {
    let (_tmp, repo, wt) = setup();
    write(&repo, "keep.txt", "main moved on\n");
    git_ok(&repo, &["commit", "-qam", "main work"]);
    let st = diff_stat(&wt, "main").unwrap();
    assert_eq!((st.ahead, st.behind), (0, 1));
    // Main's own change is not the task's: diffs are against the fork point.
    assert!(st.files.is_empty(), "{:?}", st.files);
    assert!(!st.dirty);
    assert!(diff_stat(&wt, "--output=/tmp/x").is_err());
    assert!(diff_stat(&wt, "nope").unwrap_err().contains("not a commit"));
  }

  #[test]
  fn reject_restores_files_from_the_base() {
    let (_tmp, _repo, wt) = setup();
    write(&wt, "edit.txt", "changed\n");
    std::fs::remove_file(wt.join("gone.txt")).unwrap();
    write(&wt, "added.txt", "x\n");
    git_ok(&wt, &["add", "added.txt"]);
    git_ok(&wt, &["commit", "-q", "-m", "add"]);
    write(&wt, "untracked.txt", "u\n");
    git_ok(&wt, &["mv", "old.txt", "new.txt"]);

    let all = ["edit.txt", "gone.txt", "added.txt", "untracked.txt", "new.txt", "old.txt"].map(String::from);
    assert!(reject(&wt, "main", &["../escape".into()]).is_err());
    reject(&wt, "main", &all).unwrap();
    assert_eq!(std::fs::read_to_string(wt.join("edit.txt")).unwrap(), "one\ntwo\nthree\n");
    assert_eq!(std::fs::read_to_string(wt.join("gone.txt")).unwrap(), "bye\n");
    assert_eq!(std::fs::read_to_string(wt.join("old.txt")).unwrap(), "a\nb\nc\nd\ne\nf\n");
    for gone in ["added.txt", "untracked.txt", "new.txt"] {
      assert!(!wt.join(gone).exists(), "{gone}");
    }
    let st = diff_stat(&wt, "main").unwrap();
    // The committed addition is now a staged deletion of it: nothing differs from the base.
    assert!(st.files.is_empty(), "{:?}", st.files);
  }

  #[test]
  fn commits_and_fast_forwards_main_checkout() {
    let (_tmp, repo, wt) = setup();
    assert!(merge_local(&repo, "t", "main", false).unwrap_err().contains("ไม่มี commit"));
    write(&wt, "feature.txt", "f\n");
    assert!(merge_local(&repo, "t", "main", false).unwrap_err().contains("commit"), "dirty worktree refused");
    commit_all(&wt, "add feature").unwrap();
    let task_head = git_ok(&wt, &["rev-parse", "HEAD"]);
    let r = merge_local(&repo, "t", "main", false).unwrap();
    assert!(r.fast_forward);
    assert_eq!(r.commit, task_head.trim());
    assert_eq!(std::fs::read_to_string(repo.join("feature.txt")).unwrap(), "f\n", "main checkout updated");
  }

  #[test]
  fn merge_commit_when_base_moved_and_conflicts_abort() {
    let (_tmp, repo, wt) = setup();
    write(&wt, "feature.txt", "f\n");
    commit_all(&wt, "feature").unwrap();
    write(&repo, "keep.txt", "main moved\n");
    git_ok(&repo, &["commit", "-qam", "main work"]);
    assert!(merge_local(&repo, "t", "main", false).is_err(), "not a fast-forward");
    let r = merge_local(&repo, "t", "main", true).unwrap();
    assert!(!r.fast_forward);
    assert_eq!(git_ok(&repo, &["log", "-1", "--format=%s"]).trim(), "Merge kingu/t into main");
    assert!(repo.join("feature.txt").is_file());

    // A conflicting change is aborted, leaving main clean.
    write(&wt, "keep.txt", "task side\n");
    commit_all(&wt, "conflict").unwrap();
    write(&repo, "keep.txt", "main side\n");
    git_ok(&repo, &["commit", "-qam", "main conflict"]);
    assert!(merge_local(&repo, "t", "main", true).is_err());
    assert_eq!(git_ok(&repo, &["status", "--porcelain", "--untracked-files=no"]), "");
    assert!(merge_local(&repo, "t", "no-such-branch", true).is_err());
  }

  #[test]
  fn fast_forwards_a_branch_that_is_not_checked_out() {
    let (_tmp, repo, wt) = setup();
    git_ok(&repo, &["branch", "release"]);
    write(&wt, "feature.txt", "f\n");
    commit_all(&wt, "feature").unwrap();
    assert!(merge_local(&repo, "t", "release", true).is_err(), "merge commit needs a checkout");
    let r = merge_local(&repo, "t", "release", false).unwrap();
    assert_eq!(r.checkout, None);
    assert_eq!(git_ok(&repo, &["rev-parse", "release"]).trim(), r.commit);
  }

  #[test]
  fn task_dir_refuses_non_worktrees() {
    let (_tmp, repo, _wt) = setup();
    std::fs::create_dir_all(worktree_path(&repo, "fake")).unwrap();
    assert!(task_dir(&repo, "fake").is_err());
    assert!(task_dir(&repo, "missing").is_err());
    assert!(task_dir(&repo, "../x").is_err());
  }

  /// The ADE's right side bar runs Source Control in the task worktree (`slug` on git_*):
  /// status, stage, commit and ignore marks there never touch the open folder's repository.
  #[test]
  fn source_control_runs_inside_the_task_worktree() {
    let (_tmp, repo, wt) = setup();
    write(&wt, "edit.txt", "one\nTWO\nthree\n");
    write(&wt, "new.txt", "n\n");
    write(&wt, "run.log", "x\n");
    let st = crate::git::status(&wt).unwrap().unwrap();
    assert_eq!(st.branch.as_deref(), Some("kingu/t"));
    let paths: Vec<&str> = st.entries.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(paths, ["edit.txt", "new.txt"]);
    assert!(crate::git::status(&repo).unwrap().unwrap().entries.is_empty());

    crate::git::check_rel(&wt, "new.txt").unwrap();
    crate::git::stage(&wt, &["edit.txt".into()]).unwrap();
    crate::git::commit(&wt, "edit", false).unwrap();
    let st = crate::git::status(&wt).unwrap().unwrap();
    assert_eq!(st.entries.len(), 1);
    assert_eq!(st.entries[0].worktree.as_deref(), Some("?"));
    assert_eq!(git_ok(&repo, &["log", "-1", "--format=%s", "kingu/t"]).trim(), "edit");
    assert_eq!(git_ok(&repo, &["log", "-1", "--format=%s", "main"]).trim(), "init");

    let mut entries = crate::fs::list_dir(&repo, &wt).unwrap();
    crate::git::mark_ignored(&wt, &mut entries);
    let ignored: Vec<&str> = entries.iter().filter(|e| e.ignored).map(|e| e.name.as_str()).collect();
    assert_eq!(ignored, ["run.log"]);
  }

  /// Source Control › Push in a task worktree publishes its own branch (to a local bare remote).
  #[test]
  fn push_from_the_task_worktree_publishes_its_branch() {
    let (tmp, repo, wt) = setup();
    let remote = tmp.path().join("remote.git");
    git_ok(tmp.path(), &["init", "-q", "--bare", remote.to_str().unwrap()]);
    git_ok(&repo, &["remote", "add", "origin", remote.to_str().unwrap()]);
    write(&wt, "new.txt", "n\n");
    crate::git::stage(&wt, &["new.txt".into()]).unwrap();
    crate::git::commit(&wt, "add new", false).unwrap();
    let cancel = std::sync::atomic::AtomicBool::new(false);
    let upstream = crate::git_remote::push(&wt, None, &cancel, std::time::Duration::from_secs(30)).unwrap();
    assert_eq!(upstream, "origin/kingu/t");
    assert_eq!(git_ok(&remote, &["log", "-1", "--format=%s", "kingu/t"]).trim(), "add new");
    assert!(git_ok(&remote, &["branch", "--list", "main"]).trim().is_empty());
  }

  /// Files › Contents runs ripgrep in the worktree: paths come back relative to it and the
  /// worktree's own `.gitignore` applies (its `.git` is a file, not a folder).
  #[test]
  fn content_search_in_a_worktree_uses_its_ignore_rules() {
    use crate::search::{SearchEvent, SearchOptions, Searches, find_rg};
    let Ok(rg) = find_rg(std::env::var_os("KINGU_RG"), std::env::var_os("PATH")) else {
      eprintln!("rg not found, skipping");
      return;
    };
    let (_tmp, _repo, wt) = setup();
    write(&wt, "run.log", "needle\n");
    write(&wt, "src/ไทย.txt", "needle ไทย\n");
    let searches = std::sync::Arc::new(Searches::default());
    let (tx, rx) = std::sync::mpsc::channel();
    let opts = SearchOptions { query: "needle".into(), ..Default::default() };
    searches.start(&rg, &wt, &opts, move |ev| tx.send(ev).is_ok()).unwrap();
    let mut files = Vec::new();
    for ev in rx {
      match ev {
        SearchEvent::File { path, .. } => files.push(path),
        SearchEvent::Done { .. } => break,
        SearchEvent::Error { message } => panic!("{message}"),
      }
    }
    assert_eq!(files, ["src/ไทย.txt"]);
  }

  #[test]
  fn parses_numstat_and_name_status() {
    let n = parse_numstat("1\t2\ta.txt\0-\t-\tbin\0\x30\t0\t\0old\0new\0");
    assert_eq!(n["a.txt"], (Some(1), Some(2)));
    assert_eq!(n["bin"], (None, None));
    assert_eq!(n["new"], (Some(0), Some(0)));
    let s = parse_name_status("M\0a.txt\0R087\0old\0new\0D\0gone\0");
    assert_eq!(s, [("M".into(), "a.txt".into(), None), ("R".into(), "new".into(), Some("old".into())), ("D".into(), "gone".into(), None)]);
  }

  #[test]
  fn finds_gh_on_a_path_without_running_it() {
    let tmp = tempfile::tempdir().unwrap();
    assert_eq!(find_on_path("gh", Some(tmp.path().as_os_str().to_owned())), None);
    std::fs::write(tmp.path().join("gh"), "").unwrap();
    assert_eq!(find_on_path("gh", Some(tmp.path().as_os_str().to_owned())), Some(tmp.path().join("gh")));
    assert_eq!(find_on_path("gh", None), None);
    let st = gh_status(None);
    assert!(!st.installed && !st.authenticated);
  }

  #[test]
  fn parses_pr_status_with_check_runs_and_statuses() {
    let json = r#"{"number":12,"url":"https://github.com/o/r/pull/12","title":"แก้บั๊ก","state":"OPEN","isDraft":false,
      "reviewDecision":"REVIEW_REQUIRED","mergeable":"MERGEABLE","statusCheckRollup":[
      {"__typename":"CheckRun","name":"test","workflowName":"CI","status":"COMPLETED","conclusion":"SUCCESS","detailsUrl":"https://x/1"},
      {"__typename":"CheckRun","name":"lint","workflowName":"","status":"IN_PROGRESS","conclusion":"","detailsUrl":"https://x/2"},
      {"__typename":"CheckRun","name":"e2e","workflowName":"CI","status":"COMPLETED","conclusion":"TIMED_OUT","detailsUrl":null},
      {"__typename":"StatusContext","context":"vercel","state":"PENDING","targetUrl":"https://v"},
      {"__typename":"StatusContext","context":"ci/legacy","state":"ERROR","targetUrl":null}]}"#;
    let pr = parse_pr_status(json).unwrap();
    assert_eq!((pr.number, pr.state.as_str(), pr.draft, pr.review.as_str(), pr.mergeable.as_str()), (12, "OPEN", false, "REVIEW_REQUIRED", "MERGEABLE"));
    let states: Vec<_> = pr.checks.iter().map(|c| (c.name.as_str(), c.state)).collect();
    assert_eq!(states, [("CI / test", "success"), ("lint", "pending"), ("CI / e2e", "failure"), ("vercel", "pending"), ("ci/legacy", "failure")]);
    assert_eq!(pr.checks[0].url.as_deref(), Some("https://x/1"));
    assert_eq!(pr.checks[2].url, None);
  }

  #[test]
  fn no_pr_yet_is_not_an_error() {
    assert!(is_no_pr("No pull requests found for branch \"kingu/x\"\n"));
    assert!(is_no_pr("no pull requests found for branch \"ui/batch4\""));
    assert!(!is_no_pr("HTTP 401: Bad credentials"));
  }

  #[test]
  fn pr_without_checks_and_bad_json() {
    let pr = parse_pr_status(r#"{"number":3,"url":"u","title":"t","state":"MERGED","isDraft":true,"reviewDecision":"","mergeable":"UNKNOWN","statusCheckRollup":null}"#).unwrap();
    assert!(pr.checks.is_empty() && pr.draft && pr.state == "MERGED");
    assert!(parse_pr_status("not json").is_err());
    assert!(parse_pr_status("{}").is_err());
  }

}
