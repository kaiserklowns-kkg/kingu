//! The rest of VS Code's git commands around branches and history (its git extension's
//! commands.ts): Merge Branch, Rebase Branch, Cherry Pick, Checkout (Detached), Create/Delete
//! Tag, Push Tags, Undo Last Commit, Add to .gitignore, Add/Remove/Rename Remote, a stash's
//! contents and Drop All Stashes, the commit message in an editor (`git.useEditorAsCommitInput`,
//! `git.verboseCommit`) and worktrees from the Source Control view.
//!
//! Like `git.rs`: the `git` CLI only, no shell, names checked first and revisions after
//! `--end-of-options`. Writes queue in `git_queue`; the Tauri commands also hold the window's one
//! operation slot ([`GitOps`]), as `git_remote.rs` does. Worktrees reuse the ADE's
//! `agent::worktree` listing and leave its task worktrees (`.kingu/worktrees/`) to it.

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use tauri::State;

use crate::git::{check_rel, check_rev, operation, run, Operation};
use crate::git_queue::{self, Scope};
use crate::git_remote::{check_branch_name, net_env, GitOps, NET_TIMEOUT};
use crate::i18n::msg::{GitMsg, ScmGraphMsg};
use crate::tr;
use crate::workspace::Workspace;

/// How a merge, rebase or cherry-pick ended: done, or stopped on conflicts for the user to
/// resolve (the Source Control view then shows its Merge Changes and Continue/Abort).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
  Done,
  Conflicts,
}

fn text(out: Vec<u8>) -> String {
  String::from_utf8_lossy(&out).trim().to_owned()
}

fn has_head(root: &Path) -> bool {
  run(root, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok()
}

fn no_operation(root: &Path) -> Result<(), String> {
  match operation(root) {
    Some(op) => Err(tr!(ScmGraphMsg::OperationInProgress, op = op_name(op))),
    None => Ok(()),
  }
}

fn op_name(op: Operation) -> &'static str {
  match op {
    Operation::Merge => "merge",
    Operation::Rebase => "rebase",
    Operation::CherryPick => "cherry-pick",
    Operation::Revert => "revert",
  }
}

/// A failed merge, rebase or cherry-pick that left `expect` in progress stopped on conflicts.
fn outcome(root: &Path, result: Result<Vec<u8>, String>, expect: Operation, verb: &str) -> Result<Outcome, String> {
  match result {
    Ok(_) => Ok(Outcome::Done),
    Err(_) if operation(root) == Some(expect) => Ok(Outcome::Conflicts),
    Err(e) => Err(tr!(ScmGraphMsg::OpFailed, op = verb, detail = e)),
  }
}

// ---------------------------------------------------------------------------------------------
// Merge, rebase, cherry-pick, checkout a commit

/// Git: Merge Branch… — merges `name` (a branch, remote branch or tag) into the current branch.
pub fn merge(root: &Path, name: &str) -> Result<Outcome, String> {
  check_rev(name)?;
  no_operation(root)?;
  let _queue = git_queue::lock(root, Scope::Repository, "merge")?;
  let result = run(root, &["-c", "core.editor=true", "merge", "--no-edit", "--end-of-options", name]);
  outcome(root, result, Operation::Merge, "merge")
}

/// Git: Rebase Branch… — replays the current branch onto `onto`.
pub fn rebase_onto(root: &Path, onto: &str) -> Result<Outcome, String> {
  check_rev(onto)?;
  no_operation(root)?;
  let _queue = git_queue::lock(root, Scope::Repository, "rebase")?;
  let result = run(root, &["-c", "core.editor=true", "rebase", "--end-of-options", onto]);
  outcome(root, result, Operation::Rebase, "rebase")
}

/// Cherry Pick (the graph's context menu); a merge commit takes its first parent's side.
pub fn cherry_pick(root: &Path, hash: &str) -> Result<Outcome, String> {
  check_rev(hash)?;
  no_operation(root)?;
  let _queue = git_queue::lock(root, Scope::Repository, "cherry-pick")?;
  let is_merge = run(root, &["rev-parse", "--verify", "--quiet", "--end-of-options", &format!("{hash}^2")]).is_ok();
  let mut args = vec!["-c", "core.editor=true", "cherry-pick"];
  if is_merge {
    args.extend(["-m", "1"]);
  }
  args.extend(["--end-of-options", hash]);
  let result = run(root, &args);
  outcome(root, result, Operation::CherryPick, "cherry-pick")
}

/// Checkout (Detached): HEAD at the commit, no branch.
pub fn checkout_detached(root: &Path, rev: &str) -> Result<(), String> {
  check_rev(rev)?;
  let _queue = git_queue::lock(root, Scope::Repository, "checkout --detach")?;
  run(root, &["switch", "--detach", rev]).map(|_| ()).map_err(|e| {
    if e.to_lowercase().contains("would be overwritten") { tr!(GitMsg::WouldOverwrite) } else { tr!(ScmGraphMsg::OpFailed, op = "checkout", detail = e) }
  })
}

// ---------------------------------------------------------------------------------------------
// Tags

/// A tag name the user typed (`git check-ref-format`, not an option).
pub fn check_tag_name(root: &Path, name: &str) -> Result<(), String> {
  let bad = name.is_empty() || name.len() > 255 || name.starts_with('-') || name.contains("@{") || name.chars().any(|c| c.is_whitespace() || c.is_control());
  if bad || run(root, &["check-ref-format", &format!("refs/tags/{name}")]).is_err() {
    return Err(tr!(ScmGraphMsg::InvalidTagName, name = format!("{name:?}")));
  }
  Ok(())
}

fn tag_exists(root: &Path, name: &str) -> bool {
  run(root, &["show-ref", "--verify", "--quiet", &format!("refs/tags/{name}")]).is_ok()
}

/// Git: Create Tag — annotated with a message, else lightweight; at `at` (default HEAD).
pub fn create_tag(root: &Path, name: &str, message: Option<&str>, at: Option<&str>) -> Result<(), String> {
  check_tag_name(root, name)?;
  if let Some(at) = at {
    check_rev(at)?;
  }
  if !has_head(root) && at.is_none() {
    return Err(tr!(ScmGraphMsg::NoCommit));
  }
  let _queue = git_queue::lock(root, Scope::Refs, "tag")?;
  if tag_exists(root, name) {
    return Err(tr!(ScmGraphMsg::TagExists, name));
  }
  let message = message.map(str::trim).filter(|m| !m.is_empty());
  let mut args = vec!["-c", "tag.gpgSign=false", "tag"];
  if let Some(m) = message {
    args.extend(["-a", "-m", m]);
  }
  args.push(name);
  if let Some(at) = at {
    args.push(at);
  }
  run(root, &args).map(|_| ()).map_err(|e| tr!(ScmGraphMsg::OpFailed, op = "tag", detail = e))
}

/// Git: Delete Tag.
pub fn delete_tag(root: &Path, name: &str) -> Result<(), String> {
  check_tag_name(root, name)?;
  let _queue = git_queue::lock(root, Scope::Refs, "tag -d")?;
  if !tag_exists(root, name) {
    return Err(tr!(ScmGraphMsg::TagNotFound, name));
  }
  run(root, &["tag", "-d", name]).map(|_| ()).map_err(|e| tr!(ScmGraphMsg::OpFailed, op = "tag -d", detail = e))
}

/// Git: Push Tags — every tag to `remote`.
pub fn push_tags(root: &Path, remote: &str, cancel: &AtomicBool) -> Result<(), String> {
  if !remotes(root)?.iter().any(|r| r.name == remote) {
    return Err(tr!(ScmGraphMsg::RemoteNotFound, name = remote));
  }
  let _queue = git_queue::lock(root, Scope::Refs, "push --tags")?;
  net_env(root, &["push", "--tags", "--", remote], &[], cancel, NET_TIMEOUT).map(|_| ())
}

// ---------------------------------------------------------------------------------------------
// Undo Last Commit, Add to .gitignore

/// Git: Undo Last Commit — `reset --soft HEAD~`: the commit goes, its changes stay staged. The
/// first commit leaves its files untracked. Returns the undone commit's message (VS Code puts it
/// back into the commit input).
pub fn undo_last_commit(root: &Path) -> Result<String, String> {
  if !has_head(root) {
    return Err(tr!(ScmGraphMsg::NoCommit));
  }
  no_operation(root)?;
  let _queue = git_queue::lock(root, Scope::Repository, "reset --soft")?;
  let message = text(run(root, &["log", "-1", "--format=%B", "HEAD"])?);
  if run(root, &["rev-parse", "--verify", "--quiet", "HEAD~1"]).is_ok() {
    run(root, &["reset", "--soft", "HEAD~1"])?;
  } else {
    run(root, &["update-ref", "-d", "HEAD"])?;
    run(root, &["rm", "--cached", "-r", "-q", "--", "."])?;
  }
  Ok(message)
}

/// One path as a `.gitignore` line that matches only it: `#`/`!` at the start, glob characters,
/// backslashes and trailing spaces are escaped.
pub fn ignore_line(rel: &str) -> String {
  let mut out = String::with_capacity(rel.len() + 2);
  for (i, c) in rel.chars().enumerate() {
    if matches!(c, '*' | '?' | '[' | '\\') || (i == 0 && matches!(c, '#' | '!')) {
      out.push('\\');
    }
    out.push(c);
  }
  let trailing = out.len() - out.trim_end_matches(' ').len();
  if trailing > 0 {
    out.truncate(out.len() - trailing);
    out.push_str(&"\\ ".repeat(trailing));
  }
  out
}

/// `.gitignore` text with `lines` appended (each once, on its own line).
pub fn append_ignores(existing: &str, lines: &[String]) -> String {
  let present: std::collections::HashSet<&str> = existing.lines().map(str::trim_end).collect();
  let mut out = existing.to_owned();
  let mut added = std::collections::HashSet::new();
  for l in lines {
    if present.contains(l.as_str()) || !added.insert(l.as_str()) {
      continue;
    }
    if !out.is_empty() && !out.ends_with('\n') {
      out.push('\n');
    }
    out.push_str(l);
    out.push('\n');
  }
  out
}

/// Git: Add to .gitignore — the repository's top-level `.gitignore` (VS Code's `git.ignore`).
/// `rels` are relative to `root` (where git runs). Returns the `.gitignore` path.
pub fn add_to_gitignore(root: &Path, rels: &[String]) -> Result<PathBuf, String> {
  for r in rels {
    check_rel(root, r)?;
  }
  let prefix = text(run(root, &["rev-parse", "--show-prefix"])?);
  let top = PathBuf::from(text(run(root, &["rev-parse", "--show-toplevel"])?));
  let file = top.join(".gitignore");
  let _queue = git_queue::lock(root, Scope::Worktree, "ignore")?;
  let existing = match std::fs::read_to_string(&file) {
    Ok(t) => t,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
    Err(e) => return Err(format!("{}: {e}", file.display())),
  };
  let lines: Vec<String> = rels.iter().map(|r| ignore_line(&format!("{prefix}{r}"))).collect();
  std::fs::write(&file, append_ignores(&existing, &lines)).map_err(|e| format!("{}: {e}", file.display()))?;
  Ok(file)
}

// ---------------------------------------------------------------------------------------------
// Remotes

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Remote {
  pub name: String,
  pub fetch_url: String,
  pub push_url: String,
}

/// Parses `git remote -v`: `origin\thttps://… (fetch)`.
pub fn parse_remotes(text: &str) -> Vec<Remote> {
  let mut out: Vec<Remote> = Vec::new();
  for line in text.lines() {
    let Some((name, rest)) = line.split_once('\t') else { continue };
    let (url, kind) = match rest.rsplit_once(' ') {
      Some((u, k)) => (u.to_owned(), k),
      None => (rest.to_owned(), "(fetch)"),
    };
    let i = match out.iter().position(|r| r.name == name) {
      Some(i) => i,
      None => {
        out.push(Remote { name: name.to_owned(), fetch_url: String::new(), push_url: String::new() });
        out.len() - 1
      }
    };
    if kind == "(push)" { out[i].push_url = url } else { out[i].fetch_url = url }
  }
  out
}

pub fn remotes(root: &Path) -> Result<Vec<Remote>, String> {
  Ok(parse_remotes(&String::from_utf8_lossy(&run(root, &["remote", "-v"])?)))
}

/// A remote name the user typed.
pub fn check_remote_name(root: &Path, name: &str) -> Result<(), String> {
  let bad = name.is_empty() || name.len() > 255 || name.starts_with('-') || name.contains('/') || name.chars().any(|c| c.is_whitespace() || c.is_control());
  if bad || run(root, &["check-ref-format", &format!("refs/remotes/{name}/x")]).is_err() {
    return Err(tr!(ScmGraphMsg::InvalidRemoteName, name = format!("{name:?}")));
  }
  Ok(())
}

/// A remote URL the user typed: not an option, one line. (Local paths are fine for a remote.)
pub fn check_remote_url(url: &str) -> Result<(), String> {
  if url.is_empty() || url.len() > 2048 || url.starts_with('-') || url.chars().any(|c| c.is_control()) {
    return Err(tr!(ScmGraphMsg::InvalidRemoteUrl, url = format!("{url:?}")));
  }
  Ok(())
}

/// Git: Add Remote.
pub fn add_remote(root: &Path, name: &str, url: &str) -> Result<(), String> {
  check_remote_name(root, name)?;
  let url = url.trim();
  check_remote_url(url)?;
  let _queue = git_queue::lock(root, Scope::Refs, "remote add")?;
  if remotes(root)?.iter().any(|r| r.name == name) {
    return Err(tr!(ScmGraphMsg::RemoteExists, name));
  }
  run(root, &["remote", "add", name, url]).map(|_| ()).map_err(|e| tr!(ScmGraphMsg::OpFailed, op = "remote add", detail = e))
}

/// Git: Remove Remote (its remote-tracking branches go too; nothing on the server changes).
pub fn remove_remote(root: &Path, name: &str) -> Result<(), String> {
  check_remote_name(root, name)?;
  let _queue = git_queue::lock(root, Scope::Refs, "remote remove")?;
  if !remotes(root)?.iter().any(|r| r.name == name) {
    return Err(tr!(ScmGraphMsg::RemoteNotFound, name));
  }
  run(root, &["remote", "remove", name]).map(|_| ()).map_err(|e| tr!(ScmGraphMsg::OpFailed, op = "remote remove", detail = e))
}

/// Git: Rename Remote.
pub fn rename_remote(root: &Path, from: &str, to: &str) -> Result<(), String> {
  check_remote_name(root, from)?;
  check_remote_name(root, to)?;
  let _queue = git_queue::lock(root, Scope::Refs, "remote rename")?;
  let list = remotes(root)?;
  if !list.iter().any(|r| r.name == from) {
    return Err(tr!(ScmGraphMsg::RemoteNotFound, name = from));
  }
  if list.iter().any(|r| r.name == to) {
    return Err(tr!(ScmGraphMsg::RemoteExists, name = to));
  }
  run(root, &["remote", "rename", from, to]).map(|_| ()).map_err(|e| tr!(ScmGraphMsg::OpFailed, op = "remote rename", detail = e))
}

// ---------------------------------------------------------------------------------------------
// Stash contents

/// A stash's files: its tracked changes against the commit it was made on, and the untracked
/// files it holds (its third parent).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct StashDetail {
  /// The stash commit, so the webview's diffs stay put when stashes are pushed or dropped.
  pub hash: String,
  pub files: Vec<crate::git_graph::ChangedFile>,
  pub untracked: Vec<String>,
}

fn stash_hash(root: &Path, index: u32) -> Result<String, String> {
  let sel = format!("stash@{{{index}}}");
  run(root, &["rev-parse", "--verify", "--quiet", &sel]).map(text).map_err(|_| tr!(ScmGraphMsg::StashNotFound, stash = sel))
}

/// Git: View Stash — what `stash@{index}` holds.
pub fn stash_show(root: &Path, index: u32) -> Result<StashDetail, String> {
  let hash = stash_hash(root, index)?;
  let files = crate::git_graph::changed_files(root, Some(&format!("{hash}^1")), &hash)?;
  let untracked = match run(root, &["rev-parse", "--verify", "--quiet", &format!("{hash}^3")]) {
    Ok(_) => String::from_utf8_lossy(&run(root, &["ls-tree", "-r", "-z", "--name-only", &format!("{hash}^3")])?).split('\0').filter(|s| !s.is_empty()).map(str::to_owned).collect(),
    Err(_) => Vec::new(),
  };
  Ok(StashDetail { hash, files, untracked })
}

/// The unified diff of `stash@{index}`, its untracked files as added (the multi-file diff).
pub fn stash_diff(root: &Path, index: u32) -> Result<String, String> {
  let hash = stash_hash(root, index)?;
  let mut out = String::from_utf8_lossy(&run(root, &["diff", "--no-color", "--no-ext-diff", "-M", &format!("{hash}^1"), &hash, "--"])?).into_owned();
  let third = format!("{hash}^3");
  if run(root, &["rev-parse", "--verify", "--quiet", &third]).is_ok() {
    out.push_str(&String::from_utf8_lossy(&run(root, &["diff-tree", "-p", "-r", "--root", "--no-color", "--no-ext-diff", "--no-commit-id", &third, "--"])?));
  }
  Ok(crate::git_graph::truncate_diff(out, crate::git_graph::DIFF_LIMIT))
}

/// Git: Drop All Stashes.
pub fn stash_clear(root: &Path) -> Result<(), String> {
  let _queue = git_queue::lock(root, Scope::Refs, "stash clear")?;
  run(root, &["stash", "clear"]).map(|_| ())
}

// ---------------------------------------------------------------------------------------------
// The commit message in an editor (git.useEditorAsCommitInput, git.verboseCommit)

/// git's scissors line: everything from it down is not part of the message.
pub const SCISSORS: &str = "# ------------------------ >8 ------------------------";

/// The `COMMIT_EDITMSG` text: the message so far (an amend's previous message), git's help
/// comments, and with `verbose` the staged diff below the scissors line.
pub fn editmsg_template(message: &str, branch: Option<&str>, verbose_diff: Option<&str>) -> String {
  let mut out = String::new();
  if !message.trim().is_empty() {
    out.push_str(message.trim_end());
    out.push('\n');
  }
  out.push_str("\n# Please enter the commit message for your changes. Lines starting\n# with '#' will be ignored, and an empty message aborts the commit.\n#\n");
  if let Some(b) = branch {
    out.push_str(&format!("# On branch {b}\n"));
  }
  out.push_str("# Save and close this editor to commit.\n");
  if let Some(diff) = verbose_diff {
    out.push_str(SCISSORS);
    out.push_str("\n# Do not modify or remove the line above.\n# Everything below it will be ignored.\n");
    out.push_str(diff);
  }
  out
}

/// The message in a `COMMIT_EDITMSG` text: cut at the scissors line, `#` lines dropped, trailing
/// whitespace and surrounding blank lines removed (git's `--cleanup=strip` after scissors).
pub fn editmsg_message(text: &str) -> String {
  let mut lines: Vec<&str> = Vec::new();
  for line in text.lines() {
    if line == SCISSORS {
      break;
    }
    if !line.starts_with('#') {
      lines.push(line.trim_end());
    }
  }
  let mut msg = String::new();
  let mut blank = false;
  for l in lines {
    if l.is_empty() {
      blank = !msg.is_empty();
      continue;
    }
    if blank {
      msg.push_str("\n\n");
      blank = false;
    } else if !msg.is_empty() {
      msg.push('\n');
    }
    msg.push_str(l);
  }
  msg
}

fn editmsg_path(root: &Path) -> Result<PathBuf, String> {
  Ok(PathBuf::from(text(run(root, &["rev-parse", "--absolute-git-dir"])?)).join("COMMIT_EDITMSG"))
}

/// Writes `COMMIT_EDITMSG` in the repository's git dir for an editor tab; returns its path.
pub fn editmsg_prepare(root: &Path, message: &str, amend: bool, verbose: bool) -> Result<PathBuf, String> {
  let path = editmsg_path(root)?;
  let message = if amend && message.trim().is_empty() && has_head(root) { text(run(root, &["log", "-1", "--format=%B", "HEAD"])?) } else { message.to_owned() };
  let branch = run(root, &["symbolic-ref", "--short", "-q", "HEAD"]).ok().map(text).filter(|b| !b.is_empty());
  let diff = if verbose {
    let base = if amend && run(root, &["rev-parse", "--verify", "--quiet", "HEAD~1"]).is_ok() { Some("HEAD~1") } else if has_head(root) && !amend { Some("HEAD") } else { None };
    let mut args = vec!["diff", "--cached", "--no-color", "--no-ext-diff", "-M"];
    if let Some(b) = base {
      args.push(b);
    }
    Some(crate::git_graph::truncate_diff(String::from_utf8_lossy(&run(root, &args)?).into_owned(), crate::git_graph::DIFF_LIMIT))
  } else {
    None
  };
  std::fs::write(&path, editmsg_template(&message, branch.as_deref(), diff.as_deref())).map_err(|e| format!("{}: {e}", path.display()))?;
  Ok(path)
}

/// The message the user left in `COMMIT_EDITMSG`; an empty one cancels the commit.
pub fn editmsg_read(root: &Path) -> Result<String, String> {
  let path = editmsg_path(root)?;
  let msg = editmsg_message(&std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?);
  if msg.is_empty() {
    return Err(tr!(ScmGraphMsg::EmptyCommitMessage));
  }
  Ok(msg)
}

// ---------------------------------------------------------------------------------------------
// Worktrees (VS Code's Worktrees submenu; the ADE's task worktrees stay the ADE's)

pub use crate::agent::worktree::WorktreeInfo;

/// Every worktree of the repository, the main one first (`git worktree list`).
pub fn worktrees(root: &Path) -> Result<Vec<WorktreeInfo>, String> {
  crate::agent::worktree::list(root)
}

fn same_path(a: &Path, b: &Path) -> bool {
  a == b || matches!((a.canonicalize(), b.canonicalize()), (Ok(x), Ok(y)) if x == y)
}

/// Git: Create Worktree — at `path` (absolute, missing or an empty folder), checking out
/// `branch`, or a new branch `new_branch` from `from` (default HEAD).
pub fn add_worktree(root: &Path, path: &str, branch: Option<&str>, new_branch: Option<&str>, from: Option<&str>) -> Result<WorktreeInfo, String> {
  let target = Path::new(path);
  if !target.is_absolute() || path.starts_with('-') || path.chars().any(char::is_control) {
    return Err(tr!(ScmGraphMsg::WorktreePathNotAbsolute, path));
  }
  if target.symlink_metadata().is_ok() && !(target.is_dir() && std::fs::read_dir(target).is_ok_and(|mut d| d.next().is_none())) {
    return Err(tr!(ScmGraphMsg::WorktreePathNotEmpty, path));
  }
  let mut args = vec!["worktree", "add"];
  if let Some(b) = new_branch {
    check_branch_name(root, b)?;
    args.extend(["-b", b]);
  }
  args.extend(["--", path]);
  match (new_branch, branch, from) {
    (Some(_), _, Some(f)) => {
      check_rev(f)?;
      args.push(f);
    }
    (None, Some(b), _) => {
      check_rev(b)?;
      args.push(b);
    }
    _ => {}
  }
  let _queue = git_queue::lock(root, Scope::Refs, "worktree add")?;
  run(root, &args).map_err(|e| tr!(ScmGraphMsg::OpFailed, op = "worktree add", detail = e))?;
  worktrees(root)?.into_iter().find(|w| same_path(Path::new(&w.path), target)).ok_or_else(|| tr!(ScmGraphMsg::WorktreeNotFound, path))
}

/// What deleting a worktree did: gone, or refused because it has changes (the webview asks
/// before Force Delete).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoveResult {
  Removed,
  HasChanges,
}

/// Git: Delete Worktree — never the main worktree or a task's.
pub fn remove_worktree(root: &Path, path: &str, force: bool) -> Result<RemoveResult, String> {
  let list = worktrees(root)?;
  let target = Path::new(path);
  let Some(i) = list.iter().position(|w| same_path(Path::new(&w.path), target)) else {
    return Err(tr!(ScmGraphMsg::WorktreeNotFound, path));
  };
  let row = &list[i];
  if i == 0 || row.bare {
    return Err(tr!(ScmGraphMsg::WorktreeIsMain, path));
  }
  if row.slug.is_some() {
    return Err(tr!(ScmGraphMsg::WorktreeIsTask, path));
  }
  if row.locked {
    return Err(tr!(ScmGraphMsg::WorktreeLocked, path));
  }
  let _queue = git_queue::lock(root, Scope::Refs, "worktree remove")?;
  let mut args = vec!["worktree", "remove"];
  if force {
    args.push("--force");
  }
  args.extend(["--", row.path.as_str()]);
  match run(root, &args) {
    Ok(_) => Ok(RemoveResult::Removed),
    Err(e) if !force && (e.contains("contains modified or untracked files") || e.contains("use --force")) => Ok(RemoveResult::HasChanges),
    Err(e) => Err(tr!(ScmGraphMsg::OpFailed, op = "worktree remove", detail = e)),
  }
}

// ---------------------------------------------------------------------------------------------
// Tauri commands: `repo` picks one of a multi-root workspace's repositories (git_repos.rs). Every
// write holds the window's one operation slot, so it cannot race a pull or a checkout.

async fn exclusive<T: Send + 'static>(ws: &Workspace, ops: &GitOps, repo: Option<&str>, f: impl FnOnce(&Path, &AtomicBool) -> Result<T, String> + Send + 'static) -> Result<T, String> {
  let dir = crate::git_repos::repo_or_root(ws, repo)?;
  let guard = ops.begin()?;
  tauri::async_runtime::spawn_blocking(move || f(&dir, guard.flag())).await.map_err(|e| e.to_string())?
}

async fn read<T: Send + 'static>(ws: &Workspace, repo: Option<&str>, f: impl FnOnce(&Path) -> Result<T, String> + Send + 'static) -> Result<T, String> {
  let dir = crate::git_repos::repo_or_root(ws, repo)?;
  crate::blocking(move || f(&dir)).await
}

#[tauri::command]
pub async fn git_merge_branch(ws: Workspace, ops: State<'_, GitOps>, name: String, repo: Option<String>) -> Result<Outcome, String> {
  exclusive(&ws, &ops, repo.as_deref(), move |root, _| merge(root, &name)).await
}

#[tauri::command]
pub async fn git_rebase_branch(ws: Workspace, ops: State<'_, GitOps>, onto: String, repo: Option<String>) -> Result<Outcome, String> {
  exclusive(&ws, &ops, repo.as_deref(), move |root, _| rebase_onto(root, &onto)).await
}

#[tauri::command]
pub async fn git_cherry_pick(ws: Workspace, ops: State<'_, GitOps>, hash: String, repo: Option<String>) -> Result<Outcome, String> {
  exclusive(&ws, &ops, repo.as_deref(), move |root, _| cherry_pick(root, &hash)).await
}

#[tauri::command]
pub async fn git_checkout_detached(ws: Workspace, ops: State<'_, GitOps>, rev: String, repo: Option<String>) -> Result<(), String> {
  exclusive(&ws, &ops, repo.as_deref(), move |root, _| checkout_detached(root, &rev)).await
}

#[tauri::command]
pub async fn git_tag_create(ws: Workspace, ops: State<'_, GitOps>, name: String, message: Option<String>, at: Option<String>, repo: Option<String>) -> Result<(), String> {
  exclusive(&ws, &ops, repo.as_deref(), move |root, _| create_tag(root, &name, message.as_deref(), at.as_deref())).await
}

#[tauri::command]
pub async fn git_tag_delete(ws: Workspace, ops: State<'_, GitOps>, name: String, repo: Option<String>) -> Result<(), String> {
  exclusive(&ws, &ops, repo.as_deref(), move |root, _| delete_tag(root, &name)).await
}

#[tauri::command]
pub async fn git_tags_push(ws: Workspace, ops: State<'_, GitOps>, remote: String, repo: Option<String>) -> Result<(), String> {
  exclusive(&ws, &ops, repo.as_deref(), move |root, cancel| push_tags(root, &remote, cancel)).await
}

#[tauri::command]
pub async fn git_undo_commit(ws: Workspace, ops: State<'_, GitOps>, repo: Option<String>) -> Result<String, String> {
  exclusive(&ws, &ops, repo.as_deref(), move |root, _| undo_last_commit(root)).await
}

/// `paths` are relative to the repository directory.
#[tauri::command]
pub async fn git_ignore_paths(ws: Workspace, paths: Vec<String>, repo: Option<String>) -> Result<String, String> {
  read(&ws, repo.as_deref(), move |root| add_to_gitignore(root, &paths).map(|p| p.display().to_string())).await
}

#[tauri::command]
pub async fn git_remote_list(ws: Workspace, repo: Option<String>) -> Result<Vec<Remote>, String> {
  read(&ws, repo.as_deref(), remotes).await
}

#[tauri::command]
pub async fn git_remote_add(ws: Workspace, ops: State<'_, GitOps>, name: String, url: String, repo: Option<String>) -> Result<(), String> {
  exclusive(&ws, &ops, repo.as_deref(), move |root, _| add_remote(root, &name, &url)).await
}

#[tauri::command]
pub async fn git_remote_remove(ws: Workspace, ops: State<'_, GitOps>, name: String, repo: Option<String>) -> Result<(), String> {
  exclusive(&ws, &ops, repo.as_deref(), move |root, _| remove_remote(root, &name)).await
}

#[tauri::command]
pub async fn git_remote_rename(ws: Workspace, ops: State<'_, GitOps>, from: String, to: String, repo: Option<String>) -> Result<(), String> {
  exclusive(&ws, &ops, repo.as_deref(), move |root, _| rename_remote(root, &from, &to)).await
}

#[tauri::command]
pub async fn git_stash_show(ws: Workspace, index: u32, repo: Option<String>) -> Result<StashDetail, String> {
  read(&ws, repo.as_deref(), move |root| stash_show(root, index)).await
}

#[tauri::command]
pub async fn git_stash_diff(ws: Workspace, index: u32, repo: Option<String>) -> Result<String, String> {
  read(&ws, repo.as_deref(), move |root| stash_diff(root, index)).await
}

#[tauri::command]
pub async fn git_stash_clear(ws: Workspace, ops: State<'_, GitOps>, repo: Option<String>) -> Result<(), String> {
  exclusive(&ws, &ops, repo.as_deref(), move |root, _| stash_clear(root)).await
}

/// Writes `COMMIT_EDITMSG` and lets the editor open it (an external file only Rust can name).
#[tauri::command]
pub async fn git_commit_editmsg_prepare(
  ws: Workspace,
  files: State<'_, crate::external::ExternalFiles>,
  message: String,
  amend: bool,
  verbose: bool,
  repo: Option<String>,
) -> Result<String, String> {
  let path = read(&ws, repo.as_deref(), move |root| editmsg_prepare(root, &message, amend, verbose)).await?;
  Ok(files.allow(&path).display().to_string())
}

#[tauri::command]
pub async fn git_commit_editmsg_read(ws: Workspace, repo: Option<String>) -> Result<String, String> {
  read(&ws, repo.as_deref(), editmsg_read).await
}

#[tauri::command]
pub async fn scm_worktree_list(ws: Workspace, repo: Option<String>) -> Result<Vec<WorktreeInfo>, String> {
  read(&ws, repo.as_deref(), worktrees).await
}

#[tauri::command]
pub async fn scm_worktree_add(
  ws: Workspace,
  ops: State<'_, GitOps>,
  path: String,
  branch: Option<String>,
  new_branch: Option<String>,
  from: Option<String>,
  repo: Option<String>,
) -> Result<WorktreeInfo, String> {
  exclusive(&ws, &ops, repo.as_deref(), move |root, _| add_worktree(root, &path, branch.as_deref(), new_branch.as_deref(), from.as_deref())).await
}

#[tauri::command]
pub async fn scm_worktree_remove(ws: Workspace, ops: State<'_, GitOps>, path: String, force: bool, repo: Option<String>) -> Result<RemoveResult, String> {
  exclusive(&ws, &ops, repo.as_deref(), move |root, _| remove_worktree(root, &path, force)).await
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::git::status;
  use std::process::Command;

  fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
  }

  fn write(repo: &Path, rel: &str, body: &str) {
    let p = repo.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, body).unwrap();
  }

  fn commit(repo: &Path, rel: &str, body: &str, msg: &str) -> String {
    write(repo, rel, body);
    git(repo, &["add", "-A"]);
    git(repo, &["commit", "-q", "-m", msg]);
    git(repo, &["rev-parse", "HEAD"])
  }

  fn configure(repo: &Path) {
    for (k, v) in [("user.name", "t"), ("user.email", "t@example.com"), ("commit.gpgsign", "false"), ("tag.gpgsign", "false")] {
      git(repo, &["config", k, v]);
    }
  }

  fn temp_repo() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().canonicalize().unwrap().join("repo");
    std::fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    configure(&repo);
    commit(&repo, "a.txt", "base\n", "init");
    (tmp, repo)
  }

  fn head(repo: &Path) -> String {
    git(repo, &["rev-parse", "HEAD"])
  }

  #[test]
  fn merges_a_branch_and_stops_on_conflicts() {
    let (_tmp, repo) = temp_repo();
    git(&repo, &["checkout", "-q", "-b", "feature"]);
    commit(&repo, "f.txt", "f\n", "feature work");
    git(&repo, &["checkout", "-q", "main"]);
    commit(&repo, "m.txt", "m\n", "main work");
    assert_eq!(merge(&repo, "feature").unwrap(), Outcome::Done);
    assert!(repo.join("f.txt").exists());
    assert_eq!(git(&repo, &["rev-list", "--parents", "-n1", "HEAD"]).split(' ').count(), 3, "a merge commit");

    git(&repo, &["checkout", "-q", "-b", "clash"]);
    commit(&repo, "a.txt", "clash\n", "clash");
    git(&repo, &["checkout", "-q", "main"]);
    commit(&repo, "a.txt", "main\n", "main edit");
    assert_eq!(merge(&repo, "clash").unwrap(), Outcome::Conflicts);
    assert_eq!(operation(&repo), Some(Operation::Merge));
    // Nothing else starts while it waits.
    assert!(merge(&repo, "feature").unwrap_err().contains("merge"));
    assert!(merge(&repo, "-x").is_err() && merge(&repo, "no-such-branch").is_err());
  }

  #[test]
  fn rebases_the_current_branch_onto_another() {
    let (_tmp, repo) = temp_repo();
    git(&repo, &["checkout", "-q", "-b", "topic"]);
    commit(&repo, "t.txt", "t\n", "topic");
    git(&repo, &["checkout", "-q", "main"]);
    let m = commit(&repo, "m.txt", "m\n", "main");
    git(&repo, &["checkout", "-q", "topic"]);
    assert_eq!(rebase_onto(&repo, "main").unwrap(), Outcome::Done);
    assert_eq!(git(&repo, &["rev-parse", "HEAD~1"]), m);
    assert!(repo.join("m.txt").exists() && repo.join("t.txt").exists());
  }

  #[test]
  fn cherry_picks_and_checks_out_detached() {
    let (_tmp, repo) = temp_repo();
    git(&repo, &["checkout", "-q", "-b", "other"]);
    let pick = commit(&repo, "p.txt", "p\n", "to pick");
    git(&repo, &["checkout", "-q", "main"]);
    assert_eq!(cherry_pick(&repo, &pick).unwrap(), Outcome::Done);
    assert!(repo.join("p.txt").exists());
    assert_eq!(git(&repo, &["log", "-1", "--format=%s"]), "to pick");
    // A conflicting pick stops for the user.
    git(&repo, &["checkout", "-q", "other"]);
    let clash = commit(&repo, "a.txt", "other\n", "other edit");
    git(&repo, &["checkout", "-q", "main"]);
    commit(&repo, "a.txt", "mine\n", "mine");
    assert_eq!(cherry_pick(&repo, &clash).unwrap(), Outcome::Conflicts);
    git(&repo, &["cherry-pick", "--abort"]);

    checkout_detached(&repo, &pick).unwrap();
    let st = status(&repo).unwrap().unwrap();
    assert!(st.detached && st.branch.is_none());
    assert_eq!(head(&repo), pick);
  }

  #[test]
  fn creates_lists_and_deletes_tags_and_pushes_them() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().canonicalize().unwrap();
    git(&dir, &["init", "-q", "--bare", "-b", "main", "origin.git"]);
    git(&dir, &["clone", "-q", "origin.git", "repo"]);
    let repo = dir.join("repo");
    configure(&repo);
    let first = commit(&repo, "a.txt", "a\n", "first");
    commit(&repo, "b.txt", "b\n", "second");

    create_tag(&repo, "v1", None, Some(&first)).unwrap();
    create_tag(&repo, "v2", Some("Release two"), None).unwrap();
    assert_eq!(git(&repo, &["rev-list", "-n1", "v1"]), first);
    assert_eq!(git(&repo, &["cat-file", "-t", "v2"]), "tag", "annotated");
    assert_eq!(git(&repo, &["cat-file", "-t", "v1"]), "commit", "lightweight");
    assert!(create_tag(&repo, "v1", None, None).unwrap_err().contains("already exists"));
    for bad in ["", "-x", "a b", "a..b", "x@{1}"] {
      assert!(create_tag(&repo, bad, None, None).is_err(), "{bad:?}");
    }

    let no = AtomicBool::new(false);
    assert!(push_tags(&repo, "nope", &no).is_err());
    push_tags(&repo, "origin", &no).unwrap();
    let remote_tags = git(&dir.join("origin.git"), &["tag"]);
    assert_eq!(remote_tags, "v1\nv2");

    delete_tag(&repo, "v1").unwrap();
    assert!(delete_tag(&repo, "v1").unwrap_err().contains("not found"));
    assert_eq!(git(&repo, &["tag"]), "v2");
  }

  #[test]
  fn undoes_the_last_commit_keeping_its_changes_staged() {
    let (_tmp, repo) = temp_repo();
    let init = head(&repo);
    commit(&repo, "n.txt", "n\n", "add n\n\nwith body");
    assert_eq!(undo_last_commit(&repo).unwrap(), "add n\n\nwith body");
    assert_eq!(head(&repo), init);
    let st = status(&repo).unwrap().unwrap();
    assert_eq!(st.entries.len(), 1);
    assert_eq!((st.entries[0].path.as_str(), st.entries[0].index.as_deref()), ("n.txt", Some("A")));

    // The first commit: no HEAD afterwards, its files untracked.
    git(&repo, &["reset", "-q", "--hard"]);
    std::fs::remove_file(repo.join("n.txt")).ok();
    assert_eq!(undo_last_commit(&repo).unwrap(), "init");
    assert!(!has_head(&repo));
    let st = status(&repo).unwrap().unwrap();
    assert!(st.entries.iter().all(|e| e.worktree.as_deref() == Some("?")), "{:?}", st.entries);
    assert!(undo_last_commit(&repo).unwrap_err().contains("no commit"));
  }

  #[test]
  fn escapes_gitignore_lines_and_appends_once() {
    assert_eq!(ignore_line("build/out.log"), "build/out.log");
    assert_eq!(ignore_line("#notes"), "\\#notes");
    assert_eq!(ignore_line("!keep"), "\\!keep");
    assert_eq!(ignore_line("a*b?[c].txt"), "a\\*b\\?\\[c].txt");
    assert_eq!(ignore_line("trail  "), "trail\\ \\ ");
    assert_eq!(append_ignores("node_modules", &["a.txt".into(), "a.txt".into(), "node_modules".into()]), "node_modules\na.txt\n");
    assert_eq!(append_ignores("", &["x".into()]), "x\n");
  }

  #[test]
  fn adds_paths_to_the_top_level_gitignore() {
    let (_tmp, repo) = temp_repo();
    write(&repo, "sub/secret.env", "x\n");
    write(&repo, "notes #1.txt", "x\n");
    let file = add_to_gitignore(&repo, &["sub/secret.env".into(), "notes #1.txt".into()]).unwrap();
    assert_eq!(file, repo.join(".gitignore"));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "sub/secret.env\nnotes #1.txt\n");
    let st = status(&repo).unwrap().unwrap();
    let paths: Vec<&str> = st.entries.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(paths, [".gitignore"]);
    // From a folder inside the repository the line is still relative to its top.
    let sub = repo.join("sub");
    write(&repo, "sub/other.log", "x\n");
    add_to_gitignore(&sub, &["other.log".into()]).unwrap();
    assert!(std::fs::read_to_string(&file).unwrap().ends_with("sub/other.log\n"));
    assert!(add_to_gitignore(&repo, &["../escape".into()]).is_err());
  }

  #[test]
  fn adds_renames_and_removes_remotes() {
    let (_tmp, repo) = temp_repo();
    assert!(remotes(&repo).unwrap().is_empty());
    add_remote(&repo, "origin", "https://example.com/a.git").unwrap();
    add_remote(&repo, "fork", " /srv/git/a.git ").unwrap();
    assert!(add_remote(&repo, "origin", "https://x").unwrap_err().contains("already exists"));
    for (name, url) in [("-x", "https://x"), ("a b", "https://x"), ("a/b", "https://x"), ("ok", "-u"), ("ok", "a\nb"), ("ok", "")] {
      assert!(add_remote(&repo, name, url).is_err(), "{name:?} {url:?}");
    }
    let list = remotes(&repo).unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list.iter().find(|r| r.name == "fork").unwrap().fetch_url, "/srv/git/a.git");
    rename_remote(&repo, "fork", "upstream").unwrap();
    assert!(rename_remote(&repo, "fork", "x").unwrap_err().contains("not found"));
    assert!(rename_remote(&repo, "upstream", "origin").unwrap_err().contains("already exists"));
    remove_remote(&repo, "origin").unwrap();
    let names: Vec<String> = remotes(&repo).unwrap().into_iter().map(|r| r.name).collect();
    assert_eq!(names, ["upstream"]);
    assert_eq!(
      parse_remotes("o\thttps://f (fetch)\no\thttps://p (push)\n"),
      vec![Remote { name: "o".into(), fetch_url: "https://f".into(), push_url: "https://p".into() }]
    );
  }

  #[test]
  fn shows_a_stash_with_its_untracked_files_and_clears_stashes() {
    let (_tmp, repo) = temp_repo();
    write(&repo, "a.txt", "changed\n");
    write(&repo, "new.txt", "brand new\n");
    git(&repo, &["stash", "push", "-u", "-m", "work"]);
    let d = stash_show(&repo, 0).unwrap();
    assert_eq!(d.hash, git(&repo, &["rev-parse", "stash@{0}"]));
    assert_eq!(d.files.iter().map(|f| (f.status.as_str(), f.path.as_str())).collect::<Vec<_>>(), [("M", "a.txt")]);
    assert_eq!(d.untracked, ["new.txt"]);
    let diff = stash_diff(&repo, 0).unwrap();
    assert!(diff.contains("+changed") && diff.contains("+brand new"), "{diff}");
    assert!(stash_show(&repo, 3).unwrap_err().contains("stash@{3}"));
    stash_clear(&repo).unwrap();
    assert!(stash_show(&repo, 0).is_err());
  }

  #[test]
  fn commit_message_editor_round_trip() {
    let t = editmsg_template("Subject\n\nBody", Some("main"), Some("diff --git a/x b/x\n+# not a comment\n"));
    assert!(t.starts_with("Subject\n\nBody\n\n# Please enter"));
    assert!(t.contains("# On branch main") && t.contains(SCISSORS));
    assert_eq!(editmsg_message(&t), "Subject\n\nBody");
    assert_eq!(editmsg_message("\n\n# only comments\n"), "");
    assert_eq!(editmsg_message("a  \n\n\n\nb\n# c\n"), "a\n\nb");

    let (_tmp, repo) = temp_repo();
    write(&repo, "a.txt", "staged change\n");
    git(&repo, &["add", "a.txt"]);
    let path = editmsg_prepare(&repo, "", false, true).unwrap();
    assert_eq!(path, repo.join(".git/COMMIT_EDITMSG"));
    let body = std::fs::read_to_string(&path).unwrap();
    assert!(body.contains(SCISSORS) && body.contains("+staged change"), "{body}");
    assert!(editmsg_read(&repo).unwrap_err().contains("empty"));
    std::fs::write(&path, format!("Fix it\n{body}")).unwrap();
    assert_eq!(editmsg_read(&repo).unwrap(), "Fix it");
    // Amend starts from the last message; without verbose there is no diff.
    let body = std::fs::read_to_string(editmsg_prepare(&repo, "", true, false).unwrap()).unwrap();
    assert!(body.starts_with("init\n") && !body.contains(SCISSORS));
  }

  #[test]
  fn creates_and_deletes_worktrees_but_not_the_main_or_a_tasks() {
    let (tmp, repo) = temp_repo();
    let base = tmp.path().canonicalize().unwrap();
    let wt = base.join("repo.worktrees/feature");
    let info = add_worktree(&repo, wt.to_str().unwrap(), None, Some("feature"), None).unwrap();
    assert_eq!(info.branch.as_deref(), Some("feature"));
    git(&repo, &["branch", "existing"]);
    let wt2 = base.join("second");
    add_worktree(&repo, wt2.to_str().unwrap(), Some("existing"), None, None).unwrap();
    let list = worktrees(&repo).unwrap();
    assert_eq!(list.len(), 3);
    assert!(add_worktree(&repo, "relative/path", None, Some("x"), None).is_err());
    assert!(add_worktree(&repo, repo.to_str().unwrap(), None, Some("y"), None).unwrap_err().contains("not an empty folder"));

    // A worktree with changes needs Force Delete.
    write(&wt, "dirty.txt", "x\n");
    assert_eq!(remove_worktree(&repo, wt.to_str().unwrap(), false).unwrap(), RemoveResult::HasChanges);
    assert_eq!(remove_worktree(&repo, wt.to_str().unwrap(), true).unwrap(), RemoveResult::Removed);
    assert!(!wt.exists());
    assert_eq!(remove_worktree(&repo, wt2.to_str().unwrap(), false).unwrap(), RemoveResult::Removed);
    assert!(remove_worktree(&repo, repo.to_str().unwrap(), true).unwrap_err().contains("main worktree"));
    assert!(remove_worktree(&repo, "/no/such/worktree", true).is_err());

    // A task's worktree belongs to the ADE.
    git(&repo, &["worktree", "add", "-q", "-b", "kingu/t", ".kingu/worktrees/t"]);
    let task = repo.join(".kingu/worktrees/t");
    assert!(remove_worktree(&repo, task.to_str().unwrap(), true).unwrap_err().contains("task"));
    assert!(task.exists());
  }
}
