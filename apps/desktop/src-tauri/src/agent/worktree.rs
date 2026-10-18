//! One git worktree per task: `<repo>/.kingu/worktrees/<slug>` on branch `<prefix><slug>`
//! (`kingu.worktree.branchPrefix`, default `kingu/`). The folder makes it a task; its branch is
//! whatever is checked out there, so changing the prefix never loses an existing task.
//! Drives the `git` CLI directly (no shell), so arguments are never re-parsed.

use crate::git_queue::{self, Scope};
use crate::i18n::msg::{AgentMsg, WorktreeMsg};
use crate::tr;
use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

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
  if ok { Ok(()) } else { Err(tr!(AgentMsg::BadBranchPrefix, prefix)) }
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
  current_branch(dir)?.ok_or_else(|| tr!(AgentMsg::DetachedWorktree, slug))
}

pub(super) fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
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
  git(repo, &["check-ref-format", "--branch", &branch]).map_err(|_| tr!(AgentMsg::BadBranchName, branch))?;
  let path_str = path.to_str().ok_or("worktree path is not valid UTF-8")?;
  exclude_kingu_logged(repo);
  let _queue = git_queue::lock(repo, Scope::Refs, "worktree add")?;
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
  let _queue = git_queue::lock(repo, Scope::Refs, "fetch (refresh base)")?;
  crate::git_remote::net_env(repo, &["fetch", "--quiet", "--no-tags", "--", &remote, &merge], &[], &cancel, timeout)?;
  let fetched = git(repo, &["rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"])?.trim().to_owned();
  let local = git(repo, &["rev-parse", &format!("refs/heads/{base}")])?.trim().to_owned();
  if local == fetched {
    return Ok(None);
  }
  if git(repo, &["merge-base", "--is-ancestor", &local, &fetched]).is_err() {
    return Ok(Some(tr!(AgentMsg::BaseNotFastForward, base, remote)));
  }
  let short = &fetched[..fetched.len().min(8)];
  match list(repo)?.into_iter().find(|w| w.branch.as_deref() == Some(base) && !w.bare) {
    Some(w) => {
      let at = Path::new(&w.path);
      let _checkout = git_queue::lock(at, Scope::Repository, "merge --ff-only (refresh base)")?;
      if !git(at, &["status", "--porcelain", "--untracked-files=no"])?.trim().is_empty() {
        return Ok(Some(tr!(AgentMsg::BaseDirty, base, path = w.path)));
      }
      git(at, &["merge", "--ff-only", "--quiet", &fetched])?;
    }
    None => {
      git(repo, &["update-ref", "-m", &format!("kingu: fast-forward {base} from {remote}"), &format!("refs/heads/{base}"), &fetched, &local])?;
    }
  }
  log::info!("refreshed {base} from {remote} to {fetched}");
  Ok(Some(tr!(AgentMsg::BaseUpdated, base, remote, short)))
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
  let _queue = git_queue::lock(repo, Scope::Refs, "worktree remove")?;
  // Nothing may be staging or rejecting inside the worktree while it goes away.
  let _tree = if path.exists() { Some(git_queue::lock(&path, Scope::Worktree, "worktree remove")?) } else { None };
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

// ---------------------------------------------------------------------------------------------
// `.kingu/` stays out of git status

/// The line that starts Kingu's block in `info/exclude` (written once per repository).
const EXCLUDE_MARK: &str = "# Kingu: task worktrees and local state (shared .kingu files stay visible)";

/// `.kingu/` holds task worktrees and machine-local state (tasks.json, chats.json …), but also
/// files a team may commit: settings.json, snaps/ and the older `<kind>.sh` scripts. Its children
/// are excluded and those are let back in, so a repository that shares them still sees them.
/// `prefix` is the folder's path below the repository's top level (`""` or `"apps/web/"`).
pub fn exclude_rules(prefix: &str) -> Vec<String> {
  let at = format!("/{}.kingu/", escape_glob(prefix));
  vec![format!("{at}*"), format!("!{at}settings.json"), format!("!{at}snaps/"), format!("!{at}*.sh")]
}

/// A literal path inside a gitignore pattern: glob characters, backslashes and trailing spaces escaped.
fn escape_glob(s: &str) -> String {
  let mut out = String::with_capacity(s.len());
  for c in s.chars() {
    if matches!(c, '*' | '?' | '[' | ']' | '\\') {
      out.push('\\');
    }
    out.push(c);
  }
  let kept = out.trim_end_matches(' ').len();
  let spaces = out.len() - kept;
  out.truncate(kept);
  out.push_str(&"\\ ".repeat(spaces));
  out
}

fn excluded_roots() -> &'static Mutex<HashSet<PathBuf>> {
  static DONE: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
  DONE.get_or_init(Default::default)
}

/// Keeps `<root>/.kingu/` out of `git status` without touching the user's `.gitignore` (Orca
/// writes nothing into the checkout at all): Kingu's rules go into the repository's own
/// `info/exclude` in the git common dir, which every worktree reads and nobody commits. Nothing
/// is written when `.kingu/` is ignored already (a `.gitignore` entry, or our block from an
/// earlier run). Checked once per folder per run. True when the rules were added.
pub fn exclude_kingu(root: &Path) -> Result<bool, String> {
  let key = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
  if excluded_roots().lock().unwrap_or_else(|e| e.into_inner()).contains(&key) {
    return Ok(false);
  }
  let added = add_exclude(root)?;
  excluded_roots().lock().unwrap_or_else(|e| e.into_inner()).insert(key);
  Ok(added)
}

/// [`exclude_kingu`] where a failure must not stop what Kingu is doing (it is only logged).
pub fn exclude_kingu_logged(root: &Path) {
  match exclude_kingu(root) {
    Ok(true) => log::info!("added .kingu/ to info/exclude of {}", root.display()),
    Ok(false) => {}
    Err(e) => log::warn!("info/exclude for {}: {e}", root.display()),
  }
}

/// [`exclude_kingu_logged`] on a thread of its own, for writers that must not wait on git (the
/// tasks.json save); nothing is started once the folder was checked.
pub fn exclude_kingu_soon(root: &Path) {
  let key = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
  if excluded_roots().lock().unwrap_or_else(|e| e.into_inner()).contains(&key) {
    return;
  }
  let root = root.to_path_buf();
  std::thread::spawn(move || exclude_kingu_logged(&root));
}

fn add_exclude(root: &Path) -> Result<bool, String> {
  // Not a repository (or no git): there is no status to keep it out of.
  let Ok(out) = git(root, &["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-prefix"]) else { return Ok(false) };
  let mut lines = out.lines();
  let common = PathBuf::from(lines.next().unwrap_or_default().trim());
  let prefix = lines.next().unwrap_or_default().trim().to_owned();
  if common.as_os_str().is_empty() {
    return Ok(false);
  }
  // check-ignore exits 0 when the path is ignored (--no-index: whether or not it is tracked).
  if git(root, &["check-ignore", "-q", "--no-index", "--", ".kingu/tasks.json"]).is_ok() {
    return Ok(false);
  }
  // git itself never writes info/exclude; the short wait only keeps two Kingu writers apart.
  let _queue = git_queue::lock_for(root, Scope::Refs, "info/exclude", std::time::Duration::from_secs(5))?;
  let file = common.join("info").join("exclude");
  let text = match std::fs::read_to_string(&file) {
    Ok(t) => t,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
    Err(e) => return Err(format!("{}: {e}", file.display())),
  };
  let rules = exclude_rules(&prefix);
  if text.lines().any(|l| l.trim() == rules[0]) {
    return Ok(false);
  }
  let mut block = String::new();
  if !text.is_empty() && !text.ends_with('\n') {
    block.push('\n');
  }
  block.push_str(EXCLUDE_MARK);
  block.push('\n');
  for r in &rules {
    block.push_str(r);
    block.push('\n');
  }
  std::fs::create_dir_all(common.join("info")).map_err(|e| format!("{}: {e}", file.display()))?;
  let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&file).map_err(|e| format!("{}: {e}", file.display()))?;
  f.write_all(block.as_bytes()).map_err(|e| format!("{}: {e}", file.display()))?;
  Ok(true)
}

// ---------------------------------------------------------------------------------------------
// First-work branch rename (Orca's autoRenameBranchFromWork)

/// The branch has been published: an upstream, a push remote, or a remote branch of its name.
fn published(dir: &Path, branch: &str) -> bool {
  let has = |key: &str| git(dir, &["config", "--get", &format!("branch.{branch}.{key}")]).is_ok_and(|v| !v.trim().is_empty());
  if has("remote") || has("merge") || has("pushRemote") {
    return true;
  }
  git(dir, &["for-each-ref", "--format=%(refname:lstrip=3)", "refs/remotes"]).is_ok_and(|out| out.lines().any(|l| l == branch))
}

/// Orca's first-work rename: the task branch `from` becomes `<prefix><leaf>` (`-2`, `-3` … when
/// that name is taken), only while the task worktree still has it checked out and it was never
/// pushed (renaming a published branch would orphan the remote one and its PR). The worktree
/// folder keeps its name, so terminals and agents running there are not disturbed. Returns the
/// branch's name now.
pub fn rename_branch(repo: &Path, slug: &str, from: &str, leaf: &str, prefix: &str) -> Result<String, String> {
  validate_slug(slug)?;
  validate_slug(leaf)?;
  validate_prefix(prefix)?;
  let dir = worktree_path(repo, slug);
  let _queue = git_queue::lock(&dir, Scope::Repository, "branch -m")?;
  if current_branch(&dir)?.as_deref() != Some(from) {
    return Err(tr!(WorktreeMsg::BranchMoved, branch = from));
  }
  if published(&dir, from) {
    return Err(tr!(WorktreeMsg::BranchPublished, branch = from));
  }
  let taken = |name: &str| git(&dir, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{name}")]).is_ok();
  let to = (1..=100)
    .map(|n| if n == 1 { format!("{prefix}{leaf}") } else { format!("{prefix}{leaf}-{n}") })
    .find(|c| c == from || !taken(c))
    .ok_or_else(|| tr!(AgentMsg::BadBranchName, branch = format!("{prefix}{leaf}")))?;
  if to == from {
    return Ok(to);
  }
  git(&dir, &["check-ref-format", "--branch", &to]).map_err(|_| tr!(AgentMsg::BadBranchName, branch = to))?;
  git(&dir, &["branch", "-m", from, &to])?;
  log::info!("task {slug}: branch {from} renamed to {to}");
  Ok(to)
}

/// The pull request a task branch was checked out from (`branch.<b>.kinguPr`, written when a task
/// starts from a PR, or gh's own `refs/pull/<n>/head` upstream), so its PR is found by number.
pub fn pr_number_of(dir: &Path, branch: &str) -> Option<u64> {
  let get = |key: &str| git(dir, &["config", "--get", &format!("branch.{branch}.{key}")]).ok().map(|v| v.trim().to_owned());
  if let Some(n) = get("kinguPr").and_then(|v| v.parse().ok()) {
    return Some(n);
  }
  get("merge")?.strip_prefix("refs/pull/")?.strip_suffix("/head")?.parse().ok()
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
    assert!(refresh_base(&clone, "main", t).unwrap().unwrap().contains("Updated main"));
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
    assert!(refresh_base(&clone, "main", t).unwrap().unwrap().contains("uncommitted"));
    run(&clone, &["checkout", "-q", "--", "a.txt"]);
    commit(&clone, "local.txt");
    let local = git(&clone, &["rev-parse", "main"]).unwrap();
    assert!(refresh_base(&clone, "main", t).unwrap().unwrap().contains("cannot fast-forward"));
    assert_eq!(git(&clone, &["rev-parse", "main"]).unwrap(), local);
  }

  /// A repository whose .gitignore does not mention `.kingu/`.
  fn bare_repo() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().canonicalize().unwrap();
    run(&repo, &["init", "-q", "-b", "main"]);
    commit(&repo, "a.txt");
    (tmp, repo)
  }

  #[test]
  fn keeps_kingu_out_of_git_status_through_info_exclude() {
    let (_tmp, repo) = bare_repo();
    create(&repo, "t", None, None).unwrap();
    std::fs::write(repo.join(".kingu/tasks.json"), "{}").unwrap();
    assert_eq!(git(&repo, &["status", "--porcelain"]).unwrap(), "", "worktrees and tasks.json are excluded");
    // The user's .gitignore is untouched; the rules are in the common dir's info/exclude, once.
    assert!(!repo.join(".gitignore").exists());
    let exclude = std::fs::read_to_string(repo.join(".git/info/exclude")).unwrap();
    assert_eq!(exclude.matches(EXCLUDE_MARK).count(), 1);
    excluded_roots().lock().unwrap().clear();
    assert!(!exclude_kingu(&repo).unwrap(), "already there");
    assert_eq!(std::fs::read_to_string(repo.join(".git/info/exclude")).unwrap(), exclude);
    // Shared files still show; the task worktree's own status is its own.
    std::fs::write(repo.join(".kingu/settings.json"), "{}").unwrap();
    assert_eq!(git(&repo, &["status", "--porcelain", "--untracked-files=all"]).unwrap().trim(), "?? .kingu/settings.json");
    std::fs::write(worktree_path(&repo, "t").join("b.txt"), "b").unwrap();
    assert_eq!(git(&worktree_path(&repo, "t"), &["status", "--porcelain"]).unwrap().trim(), "?? b.txt");

    // A folder below the top level gets rules for its own .kingu/.
    let sub = repo.join("apps/web");
    std::fs::create_dir_all(sub.join(".kingu")).unwrap();
    std::fs::write(sub.join(".kingu/chats.json"), "{}").unwrap();
    assert!(exclude_kingu(&sub).unwrap());
    assert_eq!(git(&repo, &["status", "--porcelain", "--untracked-files=all"]).unwrap().trim(), "?? .kingu/settings.json");

    // Already ignored by the repository: nothing written.
    let (_tmp2, other) = temp_repo();
    assert!(!exclude_kingu(&other).unwrap());
    assert!(!std::fs::read_to_string(other.join(".git/info/exclude")).unwrap_or_default().contains(EXCLUDE_MARK));
    // Not a repository: nothing to do.
    let plain = tempfile::tempdir().unwrap();
    assert!(!exclude_kingu(plain.path()).unwrap());
  }

  #[test]
  fn exclude_rules_escape_the_folder_path() {
    assert_eq!(exclude_rules(""), ["/.kingu/*", "!/.kingu/settings.json", "!/.kingu/snaps/", "!/.kingu/*.sh"]);
    assert_eq!(exclude_rules("a*b/[x]/")[0], "/a\\*b/\\[x\\]/.kingu/*");
  }

  #[test]
  fn renames_an_unpublished_task_branch_once() {
    let (_tmp, repo) = bare_repo();
    create(&repo, "please-fix-the-login", None, None).unwrap();
    let dir = worktree_path(&repo, "please-fix-the-login");
    run(&repo, &["branch", "kingu/fix-login"]);
    // Taken names get a number; the folder stays.
    let to = rename_branch(&repo, "please-fix-the-login", "kingu/please-fix-the-login", "fix-login", "kingu/").unwrap();
    assert_eq!(to, "kingu/fix-login-2");
    assert_eq!(current_branch(&dir).unwrap().as_deref(), Some("kingu/fix-login-2"));
    assert!(dir.is_dir());
    // Renaming to its own name is a no-op; a branch that moved on is left alone.
    assert_eq!(rename_branch(&repo, "please-fix-the-login", "kingu/fix-login-2", "fix-login", "kingu/").unwrap(), "kingu/fix-login-2");
    let e = crate::i18n::with_locale(crate::i18n::Locale::En, || rename_branch(&repo, "please-fix-the-login", "kingu/please-fix-the-login", "x", "kingu/").unwrap_err());
    assert!(e.contains("no longer on"), "{e}");
    // A published branch keeps its name.
    run(&dir, &["config", "branch.kingu/fix-login-2.remote", "origin"]);
    let e = crate::i18n::with_locale(crate::i18n::Locale::En, || rename_branch(&repo, "please-fix-the-login", "kingu/fix-login-2", "other", "kingu/").unwrap_err());
    assert!(e.contains("already pushed"), "{e}");
    assert!(rename_branch(&repo, "please-fix-the-login", "kingu/fix-login-2", "Bad Name", "kingu/").is_err());
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
