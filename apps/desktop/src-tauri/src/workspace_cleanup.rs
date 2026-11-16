//! Workspace Cleanup scanner (Orca 1.4.259's cleanup scan): the Git facts about every worktree of a
//! project that the cleanup evaluator needs (`src/lib/ade/workspaceCleanupEvaluation.ts`). Read only:
//! nothing is deleted here, and the decision (which rule matched, what protects a workspace) is made
//! by the one evaluator in the frontend so the dialog, the CLI and an automatic run cannot disagree.
//!
//! What Git can say, per worktree (the frontend adds what only it knows: the active workspace, live
//! agents and terminals, pinned):
//! - `clean`: no tracked change and no untracked file (`git status --porcelain`); `None` when Git
//!   could not say, which the evaluator treats as "never removable";
//! - `ignored_files`: ignored files such as `.env` exist (kept when `keepWhen` is `any-local-files`);
//! - `unpushed`: commits no remote has (`rev-list HEAD --not --remotes`); a project with no remote
//!   counts as unpushed, so a local-only branch is never removed as if it were published;
//! - `merged` / `unchanged`: HEAD is contained in the default branch; `unchanged` when the branch
//!   never had a commit of its own (its reflog only says it was created), else `merged`. Squash
//!   merges are not detected from Git alone;
//! - `squash_merged`: HEAD is not in the default branch, but everything the branch changed is there
//!   with the same content (a squash or rebase merge, or a cherry-pick): then the branch has nothing
//!   left to lose, so it counts as `merged` and its commits as published. Git alone sees this by
//!   content (every file the branch touched is identical in the base); a later change to one of
//!   those files on the base makes it look unmerged, which only ever keeps a workspace;
//! - `pr_merged`: Git cannot see the merge (the base moved on), but GitHub says a PR for this branch
//!   was merged and its head commit is exactly this worktree's HEAD (`gh pr list --state merged`).
//!   Any later commit differs from the PR head and keeps the workspace. No `gh`, no login, a
//!   non-GitHub remote, an error or a timeout all mean "no information", never a failure;
//! - `unknown_base`: no default branch could be found, so neither can be told;
//! - `last_activity_at`: the newest of the HEAD commit, the worktree's HEAD and index files.
//!
//! Sizes are a separate, slower read (`workspace_cleanup_sizes`: `du -sk` per worktree, one after
//! another, two minutes each at most), so the dialog shows the Git facts at once and the sizes as
//! they arrive. A worktree that cannot be measured has no size, which the size filter treats as
//! "unmeasured", never as empty.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::agent::worktree::{self, WorktreeInfo};
use crate::projects;
use crate::workspace::Workspace;

static RUNNING: AtomicBool = AtomicBool::new(false);
static MEASURING: AtomicBool = AtomicBool::new(false);

/// `du` gets two minutes per worktree (Workspace Space's limit).
const DU_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
  pub path: String,
  pub branch: Option<String>,
  pub head: Option<String>,
  pub slug: Option<String>,
  pub is_main: bool,
  pub detached: bool,
  pub locked: bool,
  /// Milliseconds since the epoch when Git was asked; `None` when it was not (missing folder).
  pub checked_at: Option<u64>,
  pub clean: Option<bool>,
  pub ignored_files: bool,
  pub unpushed: bool,
  pub merged: bool,
  pub unchanged: bool,
  pub squash_merged: bool,
  /// A merged GitHub PR whose head commit is this worktree's HEAD (sets `merged`, clears `unpushed`).
  pub pr_merged: bool,
  pub unknown_base: bool,
  pub base: Option<String>,
  pub error: Option<String>,
  /// Milliseconds since the epoch.
  pub last_activity_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scan {
  pub scanned_at: u64,
  pub candidates: Vec<Candidate>,
}

/// One worktree's disk use; `size_bytes` is `None` when it could not be measured.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Size {
  pub path: String,
  pub size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
  scanned: usize,
  total: usize,
  current: Option<String>,
}

fn now_ms() -> u64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
  let out = Command::new("git")
    .arg("-C")
    .arg(dir)
    // A scan must not take the index lock a running agent's git needs.
    .env("GIT_OPTIONAL_LOCKS", "0")
    .args(args)
    .output()
    .map_err(|e| format!("git: {e}"))?;
  if !out.status.success() {
    return Err(format!("git {}: {}", args.first().unwrap_or(&""), String::from_utf8_lossy(&out.stderr).trim()));
  }
  Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn git_ok(dir: &Path, args: &[&str]) -> bool {
  Command::new("git").arg("-C").arg(dir).env("GIT_OPTIONAL_LOCKS", "0").args(args).output().is_ok_and(|o| o.status.success())
}

/// The ref a branch is compared with: `origin/HEAD`'s target, else the first of the usual names that exists.
pub fn find_base(repo: &Path) -> Option<String> {
  if let Ok(out) = git(repo, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]) {
    let name = out.trim();
    if !name.is_empty() {
      return Some(name.to_owned());
    }
  }
  ["origin/main", "origin/master", "main", "master"]
    .into_iter()
    .find(|candidate| git_ok(repo, &["rev-parse", "--verify", "--quiet", &format!("{candidate}^{{commit}}")]))
    .map(str::to_owned)
}

/// True when a branch reflog's messages show no commit of its own: every entry is its creation.
/// An empty log (expired, or a detached HEAD) says nothing, so it is not "unchanged".
pub fn only_created(reflog_messages: &str) -> bool {
  let mut any = false;
  for line in reflog_messages.lines().map(str::trim).filter(|l| !l.is_empty()) {
    any = true;
    if !line.starts_with("branch: Created from") {
      return false;
    }
  }
  any
}

/// Files per `git diff` call (the command line has a limit).
const PATHSPEC_CHUNK: usize = 200;
/// A branch touching more files than this is not compared (it is not a small squash-merged change).
const PATHSPEC_MAX: usize = 4000;

/// True when every file the branch changed since it forked from `base` has the same content in
/// `base` now (`git diff --name-only base...HEAD`, then `git diff --quiet base HEAD -- <files>`).
pub fn content_in_base(dir: &Path, base: &str) -> bool {
  let Ok(list) = git(dir, &["diff", "--name-only", "--no-renames", "-z", &format!("{base}...HEAD")]) else { return false };
  let files: Vec<&str> = list.split('\0').filter(|f| !f.is_empty()).collect();
  if files.len() > PATHSPEC_MAX {
    return false;
  }
  files.chunks(PATHSPEC_CHUNK).all(|chunk| {
    let mut args = vec!["diff", "--quiet", "--no-renames", base, "HEAD", "--"];
    args.extend(chunk.iter().copied());
    git_ok(dir, &args)
  })
}

fn mtime_ms(path: &Path) -> u64 {
  std::fs::metadata(path)
    .and_then(|m| m.modified())
    .ok()
    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
    .map_or(0, |d| d.as_millis() as u64)
}

/// Total time one scan may spend asking GitHub; later candidates are skipped once it is used up.
const GH_BUDGET: Duration = Duration::from_secs(8);
/// One `gh` call's limit (a slow network must not stall the scan).
const GH_CALL_TIMEOUT: Duration = Duration::from_secs(4);

/// True when `json` (`gh pr list --json number,headRefOid`) lists a PR whose head commit is
/// `head`. Anything unexpected (bad JSON, no list, no match) is false: only ever "keep".
pub fn pr_head_matches(json: &str, head: &str) -> bool {
  let head = head.trim();
  if head.is_empty() {
    return false;
  }
  let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return false };
  v.as_array().is_some_and(|list| list.iter().any(|pr| pr.get("headRefOid").and_then(|o| o.as_str()).is_some_and(|o| o.eq_ignore_ascii_case(head))))
}

/// Asks GitHub (through `fetch`, which returns the `gh` JSON for a branch) whether a merged PR's
/// head is `head`. Injected so tests need no `gh`.
pub fn pr_merged_at(branch: &str, head: &str, fetch: &mut dyn FnMut(&str) -> Option<String>) -> bool {
  fetch(branch).is_some_and(|json| pr_head_matches(&json, head))
}

/// The real lookup: `gh pr list --head <branch> --state merged` in the worktree, within what is
/// left of `budget`. `None` for any failure.
fn gh_merged_prs(gh: &Path, dir: &Path, branch: &str, budget: &mut Duration) -> Option<String> {
  let timeout = (*budget).min(GH_CALL_TIMEOUT);
  if timeout.is_zero() {
    return None;
  }
  let start = Instant::now();
  let args: Vec<String> = ["pr", "list", "--head", branch, "--state", "merged", "--json", "number,headRefOid", "--limit", "5"].iter().map(|s| (*s).to_owned()).collect();
  let out = crate::agent::pr::gh_run(gh, dir, &args, timeout, None).ok();
  *budget = budget.saturating_sub(start.elapsed());
  out
}

fn inspect(info: &WorktreeInfo, is_main: bool, base: Option<&str>) -> Candidate {
  inspect_with(info, is_main, base, &mut |_| None)
}

/// `inspect`, with `fetch` answering the GitHub question for a branch not merged by Git.
fn inspect_with(info: &WorktreeInfo, is_main: bool, base: Option<&str>, fetch: &mut dyn FnMut(&str) -> Option<String>) -> Candidate {
  let dir = Path::new(&info.path);
  let mut c = Candidate {
    path: info.path.clone(),
    branch: info.branch.clone(),
    head: info.head.clone(),
    slug: info.slug.clone(),
    is_main,
    detached: info.detached,
    locked: info.locked,
    checked_at: None,
    clean: None,
    ignored_files: false,
    unpushed: false,
    merged: false,
    unchanged: false,
    squash_merged: false,
    pr_merged: false,
    unknown_base: base.is_none(),
    base: base.map(str::to_owned),
    error: None,
    last_activity_at: mtime_ms(dir),
  };
  if !dir.is_dir() {
    c.error = Some("folder missing".into());
    return c;
  }
  match git(dir, &["status", "--porcelain=v1", "--untracked-files=normal"]) {
    Ok(out) => {
      c.checked_at = Some(now_ms());
      c.clean = Some(out.trim().is_empty());
    }
    Err(e) => {
      c.error = Some(e);
      return c;
    }
  }
  c.ignored_files =
    git(dir, &["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory"]).map_or(true, |out| !out.trim().is_empty());
  // No remote at all: every commit counts as unpushed. A git failure also counts, never the other way.
  c.unpushed = git(dir, &["rev-list", "--count", "HEAD", "--not", "--remotes"]).map_or(true, |out| out.trim() != "0");
  if let Some(base) = base {
    if git_ok(dir, &["merge-base", "--is-ancestor", "HEAD", base]) {
      let log = c.branch.as_deref().map(|b| git(dir, &["reflog", "show", "--format=%gs", &format!("refs/heads/{b}")]).unwrap_or_default());
      if log.as_deref().is_some_and(only_created) {
        c.unchanged = true;
      } else {
        c.merged = true;
      }
    } else if content_in_base(dir, base) {
      // Squash / rebase merged: nothing on the branch is missing from the base, so no commit of it
      // is unpublished work either.
      c.merged = true;
      c.squash_merged = true;
      c.unpushed = false;
    }
  }
  if !c.merged && !c.unchanged && !c.detached {
    // Safety: only the exact PR head counts. A commit made after the PR was merged differs, so
    // that unpublished work keeps the workspace.
    let head = git(dir, &["rev-parse", "HEAD"]).ok();
    if let (Some(branch), Some(head)) = (c.branch.clone(), head) {
      if pr_merged_at(&branch, &head, fetch) {
        c.merged = true;
        c.pr_merged = true;
        c.unpushed = false;
      }
    }
  }
  let commit = git(dir, &["log", "-1", "--format=%ct"]).ok().and_then(|s| s.trim().parse::<u64>().ok()).map_or(0, |s| s * 1000);
  let gitdir = git(dir, &["rev-parse", "--absolute-git-dir"]).ok().map(|s| PathBuf::from(s.trim()));
  let files = gitdir.map_or(0, |g| mtime_ms(&g.join("HEAD")).max(mtime_ms(&g.join("index"))));
  c.last_activity_at = c.last_activity_at.max(commit).max(files);
  c
}

fn display_name(info: &WorktreeInfo) -> String {
  info.slug.clone().or_else(|| info.branch.clone()).unwrap_or_else(|| {
    Path::new(&info.path).file_name().map_or_else(|| info.path.clone(), |n| n.to_string_lossy().into_owned())
  })
}

/// Every worktree of `root` (the main one first, flagged), one after another.
pub fn scan(root: &Path, mut emit: impl FnMut(usize, usize, Option<String>)) -> Result<Scan, String> {
  let list = worktree::list(root)?;
  let main = list.first().map(|w| w.path.clone());
  let todo: Vec<WorktreeInfo> = list.into_iter().filter(|w| !w.prunable && !w.bare).collect();
  let base = find_base(root);
  let gh = crate::agent::review::gh_bin();
  let mut budget = GH_BUDGET;
  let total = todo.len();
  let mut candidates = Vec::with_capacity(total);
  emit(0, total, None);
  for (i, info) in todo.iter().enumerate() {
    emit(i, total, Some(display_name(info)));
    let dir = PathBuf::from(&info.path);
    let mut fetch = |branch: &str| gh.as_deref().and_then(|g| gh_merged_prs(g, &dir, branch, &mut budget));
    candidates.push(inspect_with(info, main.as_deref() == Some(info.path.as_str()), base.as_deref(), &mut fetch));
  }
  emit(total, total, None);
  Ok(Scan { scanned_at: now_ms(), candidates })
}

#[tauri::command]
pub async fn workspace_cleanup_scan(
  app: AppHandle,
  window: tauri::WebviewWindow,
  ws: Workspace,
  projects: State<'_, projects::Projects>,
  root: Option<String>,
) -> Result<Scan, String> {
  let Some(root) = projects::root_arg(&ws, &projects, root)? else {
    return Ok(Scan { scanned_at: now_ms(), candidates: Vec::new() });
  };
  if RUNNING.swap(true, Ordering::SeqCst) {
    return Err("A workspace cleanup scan is already running.".into());
  }
  let label = window.label().to_string();
  let result = tauri::async_runtime::spawn_blocking(move || {
    scan(&root, |scanned, total, current| {
      let _ = app.emit_to(label.as_str(), "workspace-cleanup-progress", Progress { scanned, total, current });
    })
  })
  .await
  .map_err(|e| e.to_string());
  RUNNING.store(false, Ordering::SeqCst);
  result?
}

/// `du -sk` output (`<kilobytes>\t<path>`): the bytes, or `None` when it does not parse.
pub fn parse_du_total(output: &str) -> Option<u64> {
  let kb = output.lines().next()?.split_whitespace().next()?.parse::<u64>().ok()?;
  Some(kb.saturating_mul(1024))
}

/// Disk use of `path` (`du -sk`), stopped after `timeout`.
fn measure(path: &Path, timeout: Duration) -> Option<u64> {
  let mut child = Command::new("du").arg("-sk").arg(path).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
  let mut stdout = child.stdout.take()?;
  // `du -sk` prints one line; read it on another thread so a full pipe never blocks the wait.
  let reader = std::thread::spawn(move || {
    let mut text = String::new();
    let _ = stdout.read_to_string(&mut text);
    text
  });
  let start = Instant::now();
  loop {
    match child.try_wait() {
      Ok(Some(_)) => break,
      Ok(None) if start.elapsed() < timeout => std::thread::sleep(Duration::from_millis(50)),
      _ => {
        let _ = child.kill();
        let _ = child.wait();
        let _ = reader.join();
        return None;
      }
    }
  }
  parse_du_total(&reader.join().ok()?)
}

/// Sizes of every task worktree of `root` (the main checkout is never removable, so it is skipped).
pub fn sizes(root: &Path, timeout: Duration, mut emit: impl FnMut(usize, usize, Option<String>)) -> Result<Vec<Size>, String> {
  let list = worktree::list(root)?;
  let main = list.first().map(|w| w.path.clone());
  let todo: Vec<WorktreeInfo> = list.into_iter().filter(|w| !w.prunable && !w.bare && main.as_deref() != Some(w.path.as_str())).collect();
  let total = todo.len();
  let mut out = Vec::with_capacity(total);
  emit(0, total, None);
  for (i, info) in todo.iter().enumerate() {
    emit(i, total, Some(display_name(info)));
    out.push(Size { path: info.path.clone(), size_bytes: measure(Path::new(&info.path), timeout) });
  }
  emit(total, total, None);
  Ok(out)
}

#[tauri::command]
pub async fn workspace_cleanup_sizes(
  app: AppHandle,
  window: tauri::WebviewWindow,
  ws: Workspace,
  projects: State<'_, projects::Projects>,
  root: Option<String>,
) -> Result<Vec<Size>, String> {
  let Some(root) = projects::root_arg(&ws, &projects, root)? else { return Ok(Vec::new()) };
  if MEASURING.swap(true, Ordering::SeqCst) {
    return Err("Workspace sizes are already being measured.".into());
  }
  let label = window.label().to_string();
  let result = tauri::async_runtime::spawn_blocking(move || {
    sizes(&root, DU_TIMEOUT, |scanned, total, current| {
      let _ = app.emit_to(label.as_str(), "workspace-cleanup-size-progress", Progress { scanned, total, current });
    })
  })
  .await
  .map_err(|e| e.to_string());
  MEASURING.store(false, Ordering::SeqCst);
  result?
}

#[cfg(test)]
mod tests {
  use super::*;

  fn run(dir: &Path, args: &[&str]) {
    let out = Command::new("git").arg("-C").arg(dir).args(args).env("GIT_AUTHOR_NAME", "t").env("GIT_AUTHOR_EMAIL", "t@t").env("GIT_COMMITTER_NAME", "t").env("GIT_COMMITTER_EMAIL", "t@t").output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
  }

  fn repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    run(dir.path(), &["init", "-q", "-b", "main"]);
    std::fs::write(dir.path().join("a.txt"), "a").unwrap();
    run(dir.path(), &["add", "."]);
    run(dir.path(), &["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
    dir
  }

  fn info(dir: &Path, branch: &str) -> WorktreeInfo {
    WorktreeInfo { path: dir.to_string_lossy().into_owned(), head: None, branch: Some(branch.into()), slug: None, bare: false, detached: false, locked: false, prunable: false }
  }

  #[test]
  fn a_branch_that_only_says_it_was_created_has_no_work_of_its_own() {
    assert!(only_created("branch: Created from HEAD\n"));
    assert!(only_created("branch: Created from origin/main\nbranch: Created from main\n"));
    assert!(!only_created("branch: Created from HEAD\ncommit: fix\n"));
    assert!(!only_created(""), "an empty log proves nothing");
  }

  #[test]
  fn base_falls_back_to_the_usual_names() {
    let dir = repo();
    assert_eq!(find_base(dir.path()).as_deref(), Some("main"));
    let none = tempfile::tempdir().unwrap();
    run(none.path(), &["init", "-q", "-b", "trunk"]);
    assert_eq!(find_base(none.path()), None);
  }

  #[test]
  fn a_clean_worktree_on_the_base_is_merged_and_unpushed_without_a_remote() {
    let dir = repo();
    let c = inspect(&info(dir.path(), "main"), false, Some("main"));
    assert_eq!((c.clean, c.ignored_files, c.unchanged, c.merged, c.unknown_base), (Some(true), false, false, true, false));
    // No remote: the commit counts as unpushed, so it is never offered as published work.
    assert!(c.unpushed);
    assert!(c.checked_at.is_some() && c.last_activity_at > 0);
  }

  /// main with a.txt; a branch `feat` that adds b.txt and edits a.txt.
  fn feature() -> tempfile::TempDir {
    let dir = repo();
    run(dir.path(), &["checkout", "-q", "-b", "feat"]);
    std::fs::write(dir.path().join("b.txt"), "b\n").unwrap();
    std::fs::write(dir.path().join("a.txt"), "a2").unwrap();
    run(dir.path(), &["add", "."]);
    run(dir.path(), &["-c", "commit.gpgsign=false", "commit", "-q", "-m", "feat"]);
    dir
  }

  /// Main gets the same change as one new commit (what a squash merge leaves): `feat` is not an ancestor of it.
  fn squash_into_main(dir: &Path) {
    run(dir, &["checkout", "-q", "main"]);
    std::fs::write(dir.join("b.txt"), "b\n").unwrap();
    std::fs::write(dir.join("a.txt"), "a2").unwrap();
    run(dir, &["add", "."]);
    run(dir, &["-c", "commit.gpgsign=false", "commit", "-q", "-m", "squash feat"]);
    run(dir, &["checkout", "-q", "feat"]);
  }

  #[test]
  fn a_squash_merged_branch_is_merged_by_content_and_its_commits_are_not_unpublished() {
    let dir = feature();
    // Not merged yet: the base lacks b.txt.
    assert!(!content_in_base(dir.path(), "main"));
    let before = inspect(&info(dir.path(), "feat"), false, Some("main"));
    assert_eq!((before.merged, before.squash_merged, before.unpushed), (false, false, true));
    squash_into_main(dir.path());
    assert!(content_in_base(dir.path(), "main"));
    let after = inspect(&info(dir.path(), "feat"), false, Some("main"));
    assert_eq!((after.merged, after.squash_merged, after.unpushed, after.clean), (true, true, false, Some(true)));
  }

  #[test]
  fn a_later_change_to_a_touched_file_on_the_base_only_ever_keeps_the_branch() {
    let dir = feature();
    squash_into_main(dir.path());
    run(dir.path(), &["checkout", "-q", "main"]);
    std::fs::write(dir.path().join("a.txt"), "a3").unwrap();
    run(dir.path(), &["add", "."]);
    run(dir.path(), &["-c", "commit.gpgsign=false", "commit", "-q", "-m", "later"]);
    run(dir.path(), &["checkout", "-q", "feat"]);
    assert!(!content_in_base(dir.path(), "main"));
    let c = inspect(&info(dir.path(), "feat"), false, Some("main"));
    assert_eq!((c.merged, c.squash_merged, c.unpushed), (false, false, true));
  }

  #[test]
  fn a_deleted_file_counts_when_the_base_deleted_it_too() {
    let dir = repo();
    std::fs::write(dir.path().join("gone.txt"), "x").unwrap();
    run(dir.path(), &["add", "."]);
    run(dir.path(), &["-c", "commit.gpgsign=false", "commit", "-q", "-m", "gone"]);
    run(dir.path(), &["checkout", "-q", "-b", "feat"]);
    run(dir.path(), &["rm", "-q", "gone.txt"]);
    run(dir.path(), &["-c", "commit.gpgsign=false", "commit", "-q", "-m", "rm"]);
    assert!(!content_in_base(dir.path(), "main"), "main still has the file");
    run(dir.path(), &["checkout", "-q", "main"]);
    run(dir.path(), &["rm", "-q", "gone.txt"]);
    run(dir.path(), &["-c", "commit.gpgsign=false", "commit", "-q", "-m", "rm too"]);
    run(dir.path(), &["checkout", "-q", "feat"]);
    assert!(content_in_base(dir.path(), "main"));
  }

  #[test]
  fn untracked_and_ignored_files_are_told_apart() {
    let dir = repo();
    std::fs::write(dir.path().join(".gitignore"), ".env\n").unwrap();
    run(dir.path(), &["add", "."]);
    run(dir.path(), &["-c", "commit.gpgsign=false", "commit", "-q", "-m", "ignore"]);
    std::fs::write(dir.path().join(".env"), "SECRET=1").unwrap();
    let c = inspect(&info(dir.path(), "main"), false, Some("main"));
    assert_eq!((c.clean, c.ignored_files), (Some(true), true));
    std::fs::write(dir.path().join("new.txt"), "x").unwrap();
    assert_eq!(inspect(&info(dir.path(), "main"), false, Some("main")).clean, Some(false));
  }

  #[test]
  fn du_output_is_kilobytes_of_the_first_line() {
    assert_eq!(parse_du_total("120\t/w/repo\n"), Some(122_880));
    assert_eq!(parse_du_total("0\t/w/empty"), Some(0));
    assert_eq!(parse_du_total(""), None);
    assert_eq!(parse_du_total("du: cannot read\n"), None);
  }

  #[test]
  fn a_folder_is_measured_and_a_missing_one_is_not() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("big.bin"), vec![1u8; 300_000]).unwrap();
    let bytes = measure(dir.path(), Duration::from_secs(30)).unwrap();
    assert!(bytes >= 300_000, "{bytes}");
    assert_eq!(measure(Path::new("/nonexistent/kingu-cleanup-size"), Duration::from_secs(30)), None);
  }

  #[test]
  fn sizes_skip_the_main_checkout_and_list_every_task_worktree() {
    let repo = repo();
    let tree = tempfile::tempdir().unwrap();
    let wt = tree.path().join("wt");
    run(repo.path(), &["worktree", "add", "-q", "-b", "side", wt.to_str().unwrap()]);
    std::fs::write(wt.join("x.bin"), vec![2u8; 100_000]).unwrap();
    let got = sizes(repo.path(), Duration::from_secs(30), |_, _, _| {}).unwrap();
    assert_eq!(got.len(), 1);
    assert!(got[0].path.ends_with("/wt") && got[0].size_bytes.unwrap() >= 100_000, "{got:?}");
  }

  #[test]
  fn only_a_merged_pr_with_this_exact_head_counts() {
    let json = r#"[{"number":7,"headRefOid":"abc123"},{"number":3,"headRefOid":"def456"}]"#;
    assert!(pr_head_matches(json, "abc123"));
    assert!(pr_head_matches(json, "def456\n"));
    assert!(!pr_head_matches(json, "zzz999"), "later commits are unpublished work");
    assert!(!pr_head_matches("[]", "abc123"));
    assert!(!pr_head_matches("not json", "abc123"));
    assert!(!pr_head_matches("{\"headRefOid\":\"abc123\"}", "abc123"));
    assert!(!pr_head_matches(json, ""));
  }

  #[test]
  fn a_pr_merged_branch_is_recognised_when_the_base_moved_on_but_not_after_new_commits() {
    let dir = feature();
    squash_into_main(dir.path());
    run(dir.path(), &["checkout", "-q", "main"]);
    std::fs::write(dir.path().join("a.txt"), "a3").unwrap();
    run(dir.path(), &["add", "."]);
    run(dir.path(), &["-c", "commit.gpgsign=false", "commit", "-q", "-m", "later"]);
    run(dir.path(), &["checkout", "-q", "feat"]);
    let head = git(dir.path(), &["rev-parse", "HEAD"]).unwrap().trim().to_owned();
    let json = format!(r#"[{{"number":1,"headRefOid":"{head}"}}]"#);
    let c = inspect_with(&info(dir.path(), "feat"), false, Some("main"), &mut |b| (b == "feat").then(|| json.clone()));
    assert_eq!((c.merged, c.pr_merged, c.squash_merged, c.unpushed), (true, true, false, false));
    // No answer from GitHub: unchanged behaviour.
    let none = inspect_with(&info(dir.path(), "feat"), false, Some("main"), &mut |_| None);
    assert_eq!((none.merged, none.pr_merged, none.unpushed), (false, false, true));
    // A commit after the PR head keeps the workspace.
    std::fs::write(dir.path().join("c.txt"), "c").unwrap();
    run(dir.path(), &["add", "."]);
    run(dir.path(), &["-c", "commit.gpgsign=false", "commit", "-q", "-m", "after"]);
    let after = inspect_with(&info(dir.path(), "feat"), false, Some("main"), &mut |_| Some(json.clone()));
    assert_eq!((after.merged, after.pr_merged, after.unpushed), (false, false, true));
  }

  #[test]
  fn a_missing_folder_has_no_git_proof() {
    let c = inspect(&info(Path::new("/nonexistent/kingu-cleanup"), "x"), false, Some("main"));
    assert_eq!((c.checked_at, c.clean), (None, None));
    assert_eq!(c.error.as_deref(), Some("folder missing"));
  }
}
