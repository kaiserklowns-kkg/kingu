//! One git worktree per task: `<repo>/.kingu/worktrees/<slug>` on branch `kingu/<slug>`.
//! Drives the `git` CLI directly (no shell), so arguments are never re-parsed.

use std::path::{Path, PathBuf};
use std::process::Command;

pub const MAX_SLUG_LEN: usize = 48;
const WORKTREES_DIR: &str = ".kingu/worktrees";
const BRANCH_PREFIX: &str = "kingu/";

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

pub fn branch_name(slug: &str) -> String {
  format!("{BRANCH_PREFIX}{slug}")
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

/// Creates the task worktree on a new branch from `base` (default `HEAD`).
pub fn create(repo: &Path, slug: &str, base: Option<&str>) -> Result<WorktreeInfo, String> {
  validate_slug(slug)?;
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
  let branch = branch_name(slug);
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

/// Removes the task worktree; with `delete_branch`, also deletes `kingu/<slug>`.
pub fn remove(repo: &Path, slug: &str, force: bool, delete_branch: bool) -> Result<(), String> {
  validate_slug(slug)?;
  let path = worktree_path(repo, slug);
  let path_str = path.to_str().ok_or("worktree path is not valid UTF-8")?;
  let mut args = vec!["worktree", "remove"];
  if force {
    args.push("--force");
  }
  args.extend(["--", path_str]);
  git(repo, &args)?;
  if delete_branch {
    git(repo, &["branch", "-D", "--", &branch_name(slug)])?;
  }
  log::info!("worktree {slug} removed");
  Ok(())
}

fn slug_of(path: &str, branch: Option<&str>) -> Option<String> {
  let slug = branch?.strip_prefix(BRANCH_PREFIX)?;
  let in_dir = Path::new(path).parent()?.ends_with(WORKTREES_DIR);
  (in_dir && Path::new(path).file_name()?.to_str()? == slug && validate_slug(slug).is_ok()).then(|| slug.to_owned())
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
    w.slug = slug_of(&w.path, w.branch.as_deref());
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
    let w = create(&repo, "fix-login", None).unwrap();
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

    assert!(create(&repo, "fix-login", None).unwrap_err().contains("already exists"));

    remove(&repo, "fix-login", false, true).unwrap();
    assert!(!path.exists());
    assert_eq!(list(&repo).unwrap().len(), 1);
    assert!(git(&repo, &["branch", "--list", "kingu/fix-login"]).unwrap().trim().is_empty());
  }

  #[test]
  fn creates_from_a_base_ref_and_rejects_bad_input() {
    let (_tmp, repo) = temp_repo();
    let main = git(&repo, &["rev-parse", "main"]).unwrap();
    let w = create(&repo, "from-main", Some("main")).unwrap();
    assert_eq!(w.head.as_deref(), Some(main.trim()));
    assert!(create(&repo, "nope", Some("no-such-ref")).unwrap_err().contains("not a commit"));
    assert!(create(&repo, "nope", Some("--orphan")).is_err());
    assert!(create(&repo, "../escape", None).is_err());
    assert!(remove(&repo, "missing", false, false).is_err());
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
