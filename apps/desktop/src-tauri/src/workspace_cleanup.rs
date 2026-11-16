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
//! - `unknown_base`: no default branch could be found, so neither can be told;
//! - `last_activity_at`: the newest of the HEAD commit, the worktree's HEAD and index files.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::agent::worktree::{self, WorktreeInfo};
use crate::projects;
use crate::workspace::Workspace;

static RUNNING: AtomicBool = AtomicBool::new(false);

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

fn mtime_ms(path: &Path) -> u64 {
  std::fs::metadata(path)
    .and_then(|m| m.modified())
    .ok()
    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
    .map_or(0, |d| d.as_millis() as u64)
}

fn inspect(info: &WorktreeInfo, is_main: bool, base: Option<&str>) -> Candidate {
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
  let total = todo.len();
  let mut candidates = Vec::with_capacity(total);
  emit(0, total, None);
  for (i, info) in todo.iter().enumerate() {
    emit(i, total, Some(display_name(info)));
    candidates.push(inspect(info, main.as_deref() == Some(info.path.as_str()), base.as_deref()));
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
  fn a_missing_folder_has_no_git_proof() {
    let c = inspect(&info(Path::new("/nonexistent/kingu-cleanup"), "x"), false, Some("main"));
    assert_eq!((c.checked_at, c.clean), (None, None));
    assert_eq!(c.error.as_deref(), Some("folder missing"));
  }
}
