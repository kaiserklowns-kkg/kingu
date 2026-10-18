//! One git worktree per task: `<repo>/.kingu/worktrees/<slug>` on branch `<prefix><slug>`
//! (`kingu.worktree.branchPrefix`, default `kingu/`). The folder makes it a task; its branch is
//! whatever is checked out there, so changing the prefix never loses an existing task.
//! Drives the `git` CLI directly (no shell), so arguments are never re-parsed.

use std::path::{Path, PathBuf};
use std::process::Command;

pub const MAX_SLUG_LEN: usize = 48;
const WORKTREES_DIR: &str = ".kingu/worktrees";
pub const DEFAULT_BRANCH_PREFIX: &str = "kingu/";
const MAX_PREFIX_LEN: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct WorktreeInfo {
  pub path: String,
  /// Commit checked out, if any (absent for a bare entry).
  pub head: Option<String>,
  /// Short branch name (`kingu/foo`), absent when detached or bare.
  pub branch: Option<String>,
  /// Task slug when this is a Kingu-managed worktree.
  pub slug: Option<String>,
  pub bare: bool,
  pub detached: bool,
  pub locked: bool,
  pub prunable: bool,
}

/// Lowercase a-z, 0-9 and '-', 1..=48 chars, no leading/trailing or doubled '-'.
pub fn validate_slug(slug: &str) -> Result<(), String> {
  if slug.is_empty() || slug.len() > MAX_SLUG_LEN {
    return Err(format!("slug must be 1-{MAX_SLUG_LEN} characters"));
  }
  if !slug.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
    return Err(format!("{slug}: slug may only contain a-z, 0-9 and '-'"));
  }
  if slug.starts_with('-') || slug.ends_with('-') || slug.contains("--") {
    return Err(format!("{slug}: slug must not start/end with '-' or contain '--'"));
  }
  Ok(())
}

pub fn worktree_path(repo: &Path, slug: &str) -> PathBuf {
  repo.join(WORKTREES_DIR).join(slug)
}

/// A branch prefix (`kingu/`, `feature/`, `bright-`, or empty): ASCII letters, digits and `._/-`,
/// not starting with `-`, `/` or `.`, no `..` or `//`; git checks the full name too.
pub fn validate_prefix(prefix: &str) -> Result<(), String> {
  let ok = prefix.len() <= MAX_PREFIX_LEN
    && prefix.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'/' | b'-'))
    && !prefix.starts_with(['-', '/', '.'])
    && !prefix.contains("..")
    && !prefix.contains("//")
    && !prefix.contains("/.");
  if ok { Ok(()) } else { Err(format!("branch prefix \"{prefix}\" ไม่ถูกต้อง (ใช้ได้เฉพาะ a-z A-Z 0-9 . _ / -)")) }
}

/// The branch checked out in a worktree (`None`: detached).
pub fn current_branch(dir: &Path) -> Result<Option<String>, String> {
  let out = Command::new("git")
    .arg("-C")
    .arg(dir)
    .args(["symbolic-ref", "--quiet", "--short", "HEAD"])
    .output()
    .map_err(|e| format!("git: {e}"))?;
  let name = String::from_utf8_lossy(&out.stdout).trim().to_owned();
  Ok((out.status.success() && !name.is_empty()).then_some(name))
}

/// The task's branch, refusing a detached worktree (nothing to merge, push or delete).
pub fn task_branch(dir: &Path, slug: &str) -> Result<String, String> {
  current_branch(dir)?.ok_or_else(|| format!("worktree {slug} ไม่ได้อยู่บน branch (detached HEAD)"))
}

fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
  let out = Command::new("git")
    .arg("-C")
    .arg(repo)
    .args(args)
    .output()
    .map_err(|e| format!("git: {e}"))?;
  if !out.status.success() {
    let err = String::from_utf8_lossy(&out.stderr);
    return Err(format!("git {}: {}", args.first().unwrap_or(&""), err.trim()));
  }
  Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Creates the task worktree on a new branch `<prefix><slug>` (default prefix `kingu/`) from
/// `base` (default `HEAD`).
pub fn create(repo: &Path, slug: &str, base: Option<&str>, prefix: Option<&str>) -> Result<WorktreeInfo, String> {
  validate_slug(slug)?;
  let prefix = prefix.unwrap_or(DEFAULT_BRANCH_PREFIX);
  validate_prefix(prefix)?;
  let base = base.map(str::trim).filter(|b| !b.is_empty()).unwrap_or("HEAD");
  if base.starts_with('-') {
    return Err(format!("{base}: invalid base ref"));
  }
  // Resolve first so a bad ref fails clearly, and the branch starts from a fixed commit.
  let commit = git(repo, &["rev-parse", "--verify", "--quiet", "--end-of-options", &format!("{base}^{{commit}}")])
    .map_err(|_| format!("{base}: not a commit"))?;
  let commit = commit.trim();
  let path = worktree_path(repo, slug);
  if path.exists() {
    return Err(format!("{}: already exists", path.display()));
  }
  let branch = format!("{prefix}{slug}");
  git(repo, &["check-ref-format", "--branch", &branch]).map_err(|_| format!("{branch}: ชื่อ branch ไม่ถูกต้อง"))?;
  let path_str = path.to_str().ok_or("worktree path is not valid UTF-8")?;
  git(repo, &["worktree", "add", "-b", &branch, "--", path_str, commit])?;
  log::info!("worktree {slug} created at {path_str} from {base} ({commit})");
  list(repo)?
    .into_iter()
    .find(|w| w.slug.as_deref() == Some(slug))
    .ok_or_else(|| format!("{slug}: worktree created but not listed"))
}

pub fn list(repo: &Path) -> Result<Vec<WorktreeInfo>, String> {
  Ok(parse_porcelain(&git(repo, &["worktree", "list", "--porcelain"])?))
}

/// Orca's "Keep Local Main Up to Date" (`kingu.worktree.refreshBaseOnCreate`): fetches the local
/// branch `base` from its upstream and fast-forwards it when that is safe (no local commits; where
/// it is checked out, no tracked changes). Returns what happened for the status bar; `None` when
/// there is nothing to do (not a local branch, no upstream, already up to date).
pub fn refresh_base(repo: &Path, base: &str, timeout: std::time::Duration) -> Result<Option<String>, String> {
  if base.starts_with('-') || git(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{base}")]).is_err() {
    return Ok(None);
  }
  let config = |key: &str| git(repo, &["config", "--get", &format!("branch.{base}.{key}")]).map(|v| v.trim().to_owned()).unwrap_or_default();
  let (remote, merge) = (config("remote"), config("merge"));
  if remote.is_empty() || remote == "." || remote.starts_with('-') || !merge.starts_with("refs/") {
    return Ok(None);
  }
  let cancel = std::sync::atomic::AtomicBool::new(false);
  crate::git_remote::net_env(repo, &["fetch", "--quiet", "--no-tags", "--", &remote, &merge], &[], &cancel, timeout)?;
  let fetched = git(repo, &["rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"])?.trim().to_owned();
  let local = git(repo, &["rev-parse", &format!("refs/heads/{base}")])?.trim().to_owned();
  if local == fetched {
    return Ok(None);
  }
  if git(repo, &["merge-base", "--is-ancestor", &local, &fetched]).is_err() {
    return Ok(Some(format!("{base} มี commit ที่ไม่อยู่บน {remote} จึงไม่ได้อัปเดต (fast-forward ไม่ได้)")));
  }
  let short = &fetched[..fetched.len().min(8)];
  match list(repo)?.into_iter().find(|w| w.branch.as_deref() == Some(base) && !w.bare) {
    Some(w) => {
      let at = Path::new(&w.path);
      if !git(at, &["status", "--porcelain", "--untracked-files=no"])?.trim().is_empty() {
        return Ok(Some(format!("{base} มีการแก้ไขที่ยังไม่ commit ที่ {} จึงไม่ได้อัปเดต", w.path)));
      }
      git(at, &["merge", "--ff-only", "--quiet", &fetched])?;
    }
    None => {
      git(repo, &["update-ref", "-m", &format!("kingu: fast-forward {base} from {remote}"), &format!("refs/heads/{base}"), &fetched, &local])?;
    }
  }
  log::info!("refreshed {base} from {remote} to {fetched}");
  Ok(Some(format!("อัปเดต {base} จาก {remote} แล้ว ({short})")))
}

/// What removing a task does with its branch (`kingu.worktree.deleteBranchOnRemove`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeleteBranch {
  Keep,
  /// `git branch -d`: only when git sees it merged (into its upstream or HEAD), like Orca.
  Safe,
  /// `git branch -D`.
  Force,
}

impl DeleteBranch {
  pub fn parse(s: Option<&str>) -> Result<Self, String> {
    match s {
      None | Some("keep") => Ok(Self::Keep),
      Some("safe") => Ok(Self::Safe),
      Some("force") => Ok(Self::Force),
      Some(other) => Err(format!("unknown branch removal {other}")),
    }
  }
}

/// Removes the task worktree and, per `branch`, the branch it had checked out. Returns the branch
/// a safe delete kept because git does not see it merged.
pub fn remove(repo: &Path, slug: &str, force: bool, branch: DeleteBranch) -> Result<Option<String>, String> {
  validate_slug(slug)?;
  let path = worktree_path(repo, slug);
  let path_str = path.to_str().ok_or("worktree path is not valid UTF-8")?;
  let name = if branch == DeleteBranch::Keep { None } else { current_branch(&path).ok().flatten() };
  let mut args = vec!["worktree", "remove"];
  if force {
    args.push("--force");
  }
  args.extend(["--", path_str]);
  git(repo, &args)?;
  log::info!("worktree {slug} removed");
  let Some(name) = name else {
    return Ok(None);
  };
  if branch == DeleteBranch::Force {
    git(repo, &["branch", "-D", "--", &name])?;
    return Ok(None);
  }
  match git(repo, &["branch", "-d", "--", &name]) {
    Ok(_) => Ok(None),
    Err(e) if e.contains("not fully merged") => Ok(Some(name)),
    Err(e) => Err(e),
  }
}

fn slug_of(path: &str) -> Option<String> {
  let path = Path::new(path);
  let slug = path.file_name()?.to_str()?;
  (path.parent()?.ends_with(WORKTREES_DIR) && validate_slug(slug).is_ok()).then(|| slug.to_owned())
}

pub fn parse_porcelain(text: &str) -> Vec<WorktreeInfo> {
  let mut out = Vec::new();
  for block in text.split("\n\n") {
    let mut w = WorktreeInfo {
      path: String::new(),
      head: None,
      branch: None,
      slug: None,
      bare: false,
      detached: false,
      locked: false,
      prunable: false,
    };
    for line in block.lines() {
      let (key, value) = line.split_once(' ').unwrap_or((line, ""));
      match key {
        "worktree" => w.path = value.to_owned(),
        "HEAD" => w.head = Some(value.to_owned()),
        "branch" => w.branch = Some(value.strip_prefix("refs/heads/").unwrap_or(value).to_owned()),
        "bare" => w.bare = true,
        "detached" => w.detached = true,
        "locked" => w.locked = true,
        "prunable" => w.prunable = true,
        _ => {}
      }
    }
    if w.path.is_empty() {
      continue;
    }
    w.slug = if w.bare { None } else { slug_of(&w.path) };
    out.push(w);
  }
  out
}

#[cfg(test)]
mod tests {
  use super::*;

  fn run(dir: &Path, args: &[&str]) {
    let ok = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(ok.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&ok.stderr));
  }

  fn temp_repo() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().canonicalize().unwrap();
    run(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join(".gitignore"), ".kingu/\n").unwrap();
    run(&repo, &["add", "."]);
    run(
      &repo,
      &["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"],
    );
    (tmp, repo)
  }

  #[test]
  fn validates_slugs() {
    for ok in ["a", "fix-login", "task-42", &"a".repeat(48)] {
      assert!(validate_slug(ok).is_ok(), "{ok}");
    }
    for bad in ["", "Fix", "a_b", "a b", "../x", "-a", "a-", "a--b", "งาน", &"a".repeat(49), "a/b"] {
      assert!(validate_slug(bad).is_err(), "{bad}");
    }
  }

  #[test]
  fn creates_lists_and_removes_a_worktree() {
    let (_tmp, repo) = temp_repo();
    let w = create(&repo, "fix-login", None, None).unwrap();
    assert_eq!(w.slug.as_deref(), Some("fix-login"));
    assert_eq!(w.branch.as_deref(), Some("kingu/fix-login"));
    let path = worktree_path(&repo, "fix-login");
    assert!(path.join(".gitignore").is_file());
    assert_eq!(Path::new(&w.path).canonicalize().unwrap(), path.canonicalize().unwrap());

    let all = list(&repo).unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].branch.as_deref(), Some("main"));
    assert_eq!(all[0].slug, None);

    // .kingu/ is ignored, so the main checkout stays clean.
    let status = git(&repo, &["status", "--porcelain"]).unwrap();
    assert_eq!(status, "");

    assert!(create(&repo, "fix-login", None, None).unwrap_err().contains("already exists"));

    assert_eq!(remove(&repo, "fix-login", false, DeleteBranch::Safe).unwrap(), None);
    assert!(!path.exists());
    assert_eq!(list(&repo).unwrap().len(), 1);
    assert!(git(&repo, &["branch", "--list", "kingu/fix-login"]).unwrap().trim().is_empty());
  }

  #[test]
  fn creates_from_a_base_ref_and_rejects_bad_input() {
    let (_tmp, repo) = temp_repo();
    let main = git(&repo, &["rev-parse", "main"]).unwrap();
    let w = create(&repo, "from-main", Some("main"), None).unwrap();
    assert_eq!(w.head.as_deref(), Some(main.trim()));
    assert!(create(&repo, "nope", Some("no-such-ref"), None).unwrap_err().contains("not a commit"));
    assert!(create(&repo, "nope", Some("--orphan"), None).is_err());
    assert!(create(&repo, "../escape", None, None).is_err());
    assert!(remove(&repo, "missing", false, DeleteBranch::Keep).is_err());
  }

  #[test]
  fn uses_the_branch_prefix_and_finds_tasks_by_folder() {
    let (_tmp, repo) = temp_repo();
    run(&repo, &["branch", "develop"]);
    let develop = git(&repo, &["rev-parse", "develop"]).unwrap();
    let w = create(&repo, "custom", Some("develop"), Some("feature/")).unwrap();
    assert_eq!(w.branch.as_deref(), Some("feature/custom"));
    assert_eq!(w.slug.as_deref(), Some("custom"));
    assert_eq!(w.head.as_deref(), Some(develop.trim()));
    let dir = worktree_path(&repo, "custom");
    assert_eq!(task_branch(&dir, "custom").unwrap(), "feature/custom");
    let flat = create(&repo, "flat", None, Some("")).unwrap();
    assert_eq!(flat.branch.as_deref(), Some("flat"));
    // A worktree on a default-prefix branch is still a task after the prefix changes.
    create(&repo, "old", None, None).unwrap();
    let slugs: Vec<_> = list(&repo).unwrap().into_iter().filter_map(|w| w.slug).collect();
    assert_eq!(slugs, ["custom", "flat", "old"]);
    for bad in ["-x/", "/x", "../", "a//b", "a b/", "x~", ".hidden/", "a/.b/"] {
      assert!(validate_prefix(bad).is_err(), "{bad}");
      assert!(create(&repo, "nope", None, Some(bad)).is_err(), "{bad}");
    }
    // Allowed by the character rules, refused by git as a ref name.
    assert!(create(&repo, "nope", None, Some("x.lock/")).is_err());
    // Unmerged: a safe delete keeps it, a forced one does not.
    std::fs::write(dir.join("new.txt"), "x").unwrap();
    run(&dir, &["add", "."]);
    run(&dir, &["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "work"]);
    let flat_dir = worktree_path(&repo, "flat");
    assert_eq!(remove(&repo, "custom", false, DeleteBranch::Safe).unwrap().as_deref(), Some("feature/custom"));
    assert!(!git(&repo, &["branch", "--list", "feature/custom"]).unwrap().trim().is_empty());
    run(&flat_dir, &["checkout", "-q", "feature/custom"]);
    assert_eq!(remove(&repo, "flat", false, DeleteBranch::Force).unwrap(), None);
    assert!(git(&repo, &["branch", "--list", "feature/custom"]).unwrap().trim().is_empty());
    let old = worktree_path(&repo, "old");
    run(&old, &["checkout", "-q", "--detach"]);
    assert!(task_branch(&old, "old").unwrap_err().contains("detached"));
    // Removing a detached task worktree with delete_branch keeps every branch.
    remove(&repo, "old", false, DeleteBranch::Force).unwrap();
    assert!(!git(&repo, &["branch", "--list", "kingu/old"]).unwrap().trim().is_empty());
  }

  fn commit(dir: &Path, file: &str) {
    std::fs::write(dir.join(file), file).unwrap();
    run(dir, &["add", "."]);
    run(dir, &["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", file]);
  }

  #[test]
  fn refreshes_the_base_from_its_upstream_only_when_safe() {
    let t = std::time::Duration::from_secs(30);
    let (tmp, origin) = temp_repo();
    let clone = tmp.path().canonicalize().unwrap().join("clone");
    run(&origin, &["clone", "-q", origin.to_str().unwrap(), clone.to_str().unwrap()]);
    run(&origin, &["branch", "develop"]);
    run(&clone, &["fetch", "-q", "origin", "develop:develop"]);
    run(&clone, &["branch", "-q", "--set-upstream-to=origin/develop", "develop"]);

    // Up to date, not a local branch, no upstream: nothing to do.
    assert_eq!(refresh_base(&clone, "main", t).unwrap(), None);
    assert_eq!(refresh_base(&clone, "nope", t).unwrap(), None);
    run(&clone, &["branch", "local-only"]);
    assert_eq!(refresh_base(&clone, "local-only", t).unwrap(), None);

    // main checked out in the clone: fast-forwarded there.
    commit(&origin, "a.txt");
    let new_main = git(&origin, &["rev-parse", "main"]).unwrap();
    assert!(refresh_base(&clone, "main", t).unwrap().unwrap().contains("อัปเดต main"));
    assert_eq!(git(&clone, &["rev-parse", "main"]).unwrap(), new_main);
    assert!(clone.join("a.txt").is_file());

    // develop not checked out anywhere: only its ref moves.
    run(&origin, &["checkout", "-q", "develop"]);
    commit(&origin, "b.txt");
    refresh_base(&clone, "develop", t).unwrap().unwrap();
    assert_eq!(git(&clone, &["rev-parse", "develop"]).unwrap(), git(&origin, &["rev-parse", "develop"]).unwrap());

    // Local commits on main, or tracked changes where it is checked out: left alone.
    run(&origin, &["checkout", "-q", "main"]);
    commit(&origin, "c.txt");
    std::fs::write(clone.join("a.txt"), "edited").unwrap();
    assert!(refresh_base(&clone, "main", t).unwrap().unwrap().contains("ยังไม่ commit"));
    run(&clone, &["checkout", "-q", "--", "a.txt"]);
    commit(&clone, "local.txt");
    let local = git(&clone, &["rev-parse", "main"]).unwrap();
    assert!(refresh_base(&clone, "main", t).unwrap().unwrap().contains("fast-forward ไม่ได้"));
    assert_eq!(git(&clone, &["rev-parse", "main"]).unwrap(), local);
  }

  #[test]
  fn parses_porcelain_output() {
    let text = "worktree /r\nHEAD abc\nbranch refs/heads/main\n\n\
                worktree /r/.kingu/worktrees/t1\nHEAD def\nbranch refs/heads/kingu/t1\nlocked\n\n\
                worktree /r/other\nHEAD 123\ndetached\n\n";
    let all = parse_porcelain(text);
    assert_eq!(all.len(), 3);
    assert_eq!(all[1].slug.as_deref(), Some("t1"));
    assert!(all[1].locked);
    assert!(all[2].detached && all[2].branch.is_none() && all[2].slug.is_none());
  }
}
