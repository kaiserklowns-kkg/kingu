//! Source Control (VS Code's git extension, minus the extension host): status, stage, unstage,
//! discard, commit and HEAD contents for diffs. Drives the `git` CLI directly (no shell), with
//! `--literal-pathspecs` and every path after `--`, so a file name is never read as an option
//! or pathspec magic. Paths are workspace-relative and `/`-separated; callers check them with
//! [`check_rel`] first.

use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use std::sync::RwLock;

use crate::git_queue::{self, Scope};

/// `git.path` (VS Code: a path, or a list tried in order; `null` finds `git` on PATH). Read by Rust
/// itself from the user settings file (it picks a program to run, so never from the webview or a
/// repository's own settings).
static GIT_PROGRAM: RwLock<Option<PathBuf>> = RwLock::new(None);

/// The first `git.path` candidate that is an existing absolute file, else `None` (`git` from PATH).
pub fn pick_git_path(setting: Option<&serde_json::Value>) -> Option<PathBuf> {
  let candidates: Vec<&str> = match setting? {
    serde_json::Value::String(s) => vec![s.as_str()],
    serde_json::Value::Array(list) => list.iter().filter_map(|v| v.as_str()).collect(),
    _ => vec![],
  };
  candidates.into_iter().map(str::trim).filter(|c| !c.is_empty()).map(PathBuf::from).find(|p| p.is_absolute() && p.is_file())
}

/// Re-reads `git.path` from the user settings in `config_dir`.
pub fn load_git_path(config_dir: &Path) {
  let picked = pick_git_path(crate::settings::user_value(config_dir, "git.path").as_ref());
  if let Ok(mut slot) = GIT_PROGRAM.write() {
    *slot = picked;
  }
}

/// The git executable: `git.path` when set, else `git` from the login-shell PATH.
pub fn program() -> OsString {
  GIT_PROGRAM.read().ok().and_then(|p| p.clone()).map(PathBuf::into_os_string).unwrap_or_else(|| "git".into())
}

/// `crate::shell_env::command` for [`program`].
pub fn command() -> std::process::Command {
  crate::shell_env::command(program())
}

/// HEAD contents larger than this are not shown in a diff (matches `read_workspace_file`).
const MAX_SHOW_BYTES: usize = 5 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct GitStatus {
  /// Branch name, `None` when detached.
  pub branch: Option<String>,
  /// Short commit id, `None` before the first commit.
  pub head: Option<String>,
  /// Tracking branch (`origin/main`), `None` when the branch has none (Publish Branch).
  pub upstream: Option<String>,
  /// Commits on HEAD not on the upstream / on the upstream not on HEAD (git's `branch.ab`, the
  /// same counts as `git rev-list --left-right --count @{upstream}...HEAD`).
  pub ahead: u32,
  pub behind: u32,
  /// HEAD is a commit, not a branch.
  pub detached: bool,
  /// The upstream is configured but its remote branch no longer exists (deleted, then pruned).
  pub upstream_gone: bool,
  /// Configured remotes (`git remote`), for Publish Branch.
  pub remotes: Vec<String>,
  /// The merge, rebase, cherry-pick or revert waiting for its conflicts (see [`operation`]).
  pub operation: Option<Operation>,
  pub entries: Vec<StatusEntry>,
}

/// A multi-step git operation stopped half-way, usually on conflicts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Operation {
  Merge,
  Rebase,
  CherryPick,
  Revert,
}

impl Operation {
  fn verb(self) -> &'static str {
    match self {
      Operation::Merge => "merge",
      Operation::Rebase => "rebase",
      Operation::CherryPick => "cherry-pick",
      Operation::Revert => "revert",
    }
  }
}

/// One changed path. `index` / `worktree` are git's XY letters (`M`, `A`, `D`, `R`, `C`, `T`, `U`),
/// `None` when that side is unchanged. Untracked files have `worktree: Some("?")`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct StatusEntry {
  pub path: String,
  /// Source of a rename or copy.
  pub orig_path: Option<String>,
  pub index: Option<String>,
  pub worktree: Option<String>,
  pub conflict: bool,
}

/// Rejects anything that is not a plain relative path inside `root`: absolute paths, `..`,
/// and (for paths that exist, or their nearest existing ancestor) symlinks that leave the root.
/// Unlike `Workspace::resolve`, the path need not exist, since deleted files are still changes.
pub fn check_rel(root: &Path, rel: &str) -> Result<(), String> {
  if rel.is_empty() {
    return Err("empty path".into());
  }
  let path = Path::new(rel);
  if !path.components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir)) {
    return Err(format!("{rel}: outside the workspace"));
  }
  let full = root.join(path);
  let mut probe = full.clone();
  // A deleted file is checked through its nearest existing ancestor. The path itself may be a
  // symlink (git tracks the link, not its target), so it is judged by where the link lives.
  loop {
    if probe.symlink_metadata().is_ok() {
      let at = if probe == full && probe.is_symlink() { probe.parent().map(Path::to_path_buf) } else { Some(probe.clone()) };
      let real = at.and_then(|p| p.canonicalize().ok()).ok_or_else(|| format!("{rel}: cannot resolve"))?;
      return if real.starts_with(root) { Ok(()) } else { Err(format!("{rel}: outside the workspace")) };
    }
    if !probe.pop() || !probe.starts_with(root) {
      return Err(format!("{rel}: outside the workspace"));
    }
  }
}

/// Sets `ignored` on the entries of `dir` that its repository's ignore rules match. Runs in `dir`,
/// so a task worktree under `.kingu/` uses its own rules. Outside a repository nothing is marked.
pub fn mark_ignored(dir: &Path, entries: &mut [crate::fs::DirEntry]) {
  use std::io::Write;
  if entries.is_empty() {
    return;
  }
  let Ok(mut child) = command()
    .arg("-C")
    .arg(dir)
    .args(["check-ignore", "--stdin", "-z"])
    .stdin(std::process::Stdio::piped())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::null())
    .spawn()
  else {
    return;
  };
  if let Some(mut stdin) = child.stdin.take() {
    for e in entries.iter() {
      let _ = stdin.write_all(e.name.as_bytes());
      let _ = stdin.write_all(b"\0");
    }
  }
  // Exit 1 means nothing matched, 128 not a repository: both leave the entries as they are.
  let Ok(out) = child.wait_with_output() else { return };
  let ignored: std::collections::HashSet<&[u8]> = out.stdout.split(|b| *b == 0).filter(|s| !s.is_empty()).collect();
  for e in entries.iter_mut() {
    e.ignored = ignored.contains(e.name.as_bytes());
  }
  mark_untracked_dirs(dir, entries);
}

/// Sets `untracked` on the folders of `dir` that hold no tracked file: `ls-files --others
/// --directory` names such a folder as `name/` (a folder with some tracked files lists its new
/// files one by one instead).
fn mark_untracked_dirs(dir: &Path, entries: &mut [crate::fs::DirEntry]) {
  let names: Vec<&str> = entries.iter().filter(|e| e.is_dir && !e.ignored).map(|e| e.name.as_str()).collect();
  if names.is_empty() {
    return;
  }
  let mut args = vec!["ls-files", "-z", "--others", "--directory", "--exclude-standard", "--"];
  args.extend(names);
  let Ok(out) = run(dir, &args) else { return };
  let untracked: std::collections::HashSet<&[u8]> = out.split(|b| *b == 0).filter_map(|s| s.strip_suffix(b"/")).collect();
  for e in entries.iter_mut() {
    e.untracked = e.is_dir && untracked.contains(e.name.as_bytes());
  }
}

pub(crate) fn run(root: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
  let out = command()
    .arg("-C")
    .arg(root)
    .arg("--literal-pathspecs")
    // Reads (status above all, run on every watcher event) must not take the index lock to
    // refresh it, or they collide with a commit or stage running beside them; writes are queued
    // in `git_queue`. Only optional locks are skipped: a write still locks what it writes.
    .arg("--no-optional-locks")
    .args(args)
    .output()
    .map_err(|e| format!("git: {e}"))?;
  if !out.status.success() {
    // `git commit` reports "nothing to commit" on stdout.
    let err = String::from_utf8_lossy(if out.stderr.is_empty() { &out.stdout } else { &out.stderr });
    return Err(format!("git {}: {}", args.first().unwrap_or(&""), err.trim()));
  }
  Ok(out.stdout)
}

fn run_paths(root: &Path, args: &[&str], paths: &[String]) -> Result<(), String> {
  if paths.is_empty() {
    return Ok(());
  }
  let mut all: Vec<&str> = args.to_vec();
  all.push("--");
  all.extend(paths.iter().map(String::as_str));
  run(root, &all).map(|_| ())
}

/// The workspace's path inside the repository (`""` at the top level, else `sub/dir/`);
/// `None` outside a repository.
fn prefix(root: &Path) -> Option<String> {
  run(root, &["rev-parse", "--show-prefix"]).ok().map(|o| String::from_utf8_lossy(&o).trim().to_owned())
}

fn has_head(root: &Path) -> bool {
  run(root, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok()
}

/// How `git status` runs (VS Code: `git.similarityThreshold`, `git.ignoreSubmodules`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StatusOptions {
  /// Rename detection threshold in percent (git's default is 50).
  pub similarity_threshold: u8,
  pub ignore_submodules: bool,
}

impl Default for StatusOptions {
  fn default() -> Self {
    Self { similarity_threshold: 50, ignore_submodules: false }
  }
}

/// The `git status` arguments for `opts`.
pub fn status_args(opts: &StatusOptions) -> Vec<String> {
  let mut args: Vec<String> = ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"].map(String::from).to_vec();
  if opts.ignore_submodules {
    args.push("--ignore-submodules".into());
  }
  if opts.similarity_threshold != 50 {
    args.push(format!("--find-renames={}%", opts.similarity_threshold.min(100)));
  }
  args.extend(["--".into(), ".".into()]);
  args
}

/// `None` outside a git repository.
pub fn status(root: &Path) -> Result<Option<GitStatus>, String> {
  status_with(root, &StatusOptions::default())
}

pub fn status_with(root: &Path, opts: &StatusOptions) -> Result<Option<GitStatus>, String> {
  let Some(prefix) = prefix(root) else { return Ok(None) };
  let args = status_args(opts);
  let out = run(root, &args.iter().map(String::as_str).collect::<Vec<_>>())?;
  let mut st = parse_status(&String::from_utf8_lossy(&out), &prefix);
  // Task worktrees inside the folder are their own checkouts (the ADE shows each one); git sees
  // them as untracked nested repositories of the main one.
  st.entries.retain(|e| !in_task_worktree(&e.path));
  st.remotes = remotes(root)?;
  st.operation = operation(root);
  Ok(Some(st))
}

/// A workspace-relative path in `.kingu/worktrees/` (a task's checkout, not the folder's file).
pub fn in_task_worktree(rel: &str) -> bool {
  rel == ".kingu/worktrees" || rel.starts_with(".kingu/worktrees/")
}

/// The operation in progress, read from the markers git leaves in this worktree's git dir
/// (a linked worktree has its own, under `.git/worktrees/<name>`). A rebase wins over the
/// cherry-pick it runs internally.
pub fn operation(root: &Path) -> Option<Operation> {
  let out = run(root, &["rev-parse", "--absolute-git-dir"]).ok()?;
  let dir = std::path::PathBuf::from(String::from_utf8_lossy(&out).trim());
  operation_in(&dir)
}

fn operation_in(git_dir: &Path) -> Option<Operation> {
  if git_dir.join("rebase-merge").is_dir() || git_dir.join("rebase-apply").is_dir() {
    Some(Operation::Rebase)
  } else if git_dir.join("MERGE_HEAD").is_file() {
    Some(Operation::Merge)
  } else if git_dir.join("CHERRY_PICK_HEAD").is_file() {
    Some(Operation::CherryPick)
  } else if git_dir.join("REVERT_HEAD").is_file() {
    Some(Operation::Revert)
  } else {
    None
  }
}

/// Aborts the operation in progress; returns which one.
pub fn abort_operation(root: &Path) -> Result<Operation, String> {
  let op = operation(root).ok_or("No merge, rebase, cherry-pick or revert is in progress.")?;
  let _queue = git_queue::lock(root, Scope::Repository, op.verb())?;
  run(root, &[op.verb(), "--abort"])?;
  Ok(op)
}

/// Continues the operation in progress once its conflicts are resolved and staged, keeping git's
/// prepared message (no editor: `core.editor=true` accepts it as is). Unresolved paths stop it
/// before git is asked.
pub fn continue_operation(root: &Path) -> Result<Operation, String> {
  let op = operation(root).ok_or("No merge, rebase, cherry-pick or revert is in progress.")?;
  let out = run(root, &["diff", "--name-only", "--diff-filter=U", "-z"])?;
  let unresolved = out.split(|b| *b == 0).filter(|s| !s.is_empty()).count();
  if unresolved > 0 {
    return Err(format!("{unresolved} file(s) still have conflicts. Resolve and stage them first."));
  }
  let _queue = git_queue::lock(root, Scope::Repository, op.verb())?;
  run(root, &["-c", "core.editor=true", op.verb(), "--continue"])?;
  Ok(op)
}

/// `git remote`: configured remote names.
pub fn remotes(root: &Path) -> Result<Vec<String>, String> {
  let out = run(root, &["remote"])?;
  Ok(String::from_utf8_lossy(&out).lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_owned).collect())
}

fn code(c: char) -> Option<String> {
  (c != '.').then(|| c.to_string())
}

/// Parses `git status --porcelain=v2 -z --branch`. Repository-relative paths are made relative
/// to `prefix` (the workspace's folder in the repository); paths outside it are dropped.
pub fn parse_status(text: &str, prefix: &str) -> GitStatus {
  let mut st = GitStatus {
    branch: None,
    head: None,
    upstream: None,
    ahead: 0,
    behind: 0,
    detached: false,
    upstream_gone: false,
    remotes: Vec::new(),
    operation: None,
    entries: Vec::new(),
  };
  let mut has_ab = false;
  let strip = |p: &str| p.strip_prefix(prefix).map(str::to_owned);
  let mut records = text.split('\0');
  while let Some(rec) = records.next() {
    let Some((kind, rest)) = rec.split_once(' ') else { continue };
    match kind {
      "#" => {
        let (key, value) = rest.split_once(' ').unwrap_or((rest, ""));
        match key {
          "branch.oid" if value != "(initial)" => st.head = Some(value.chars().take(8).collect()),
          "branch.head" if value != "(detached)" => st.branch = Some(value.to_owned()),
          "branch.upstream" => st.upstream = Some(value.to_owned()),
          "branch.ab" => {
            has_ab = true;
            for n in value.split(' ') {
              if let Some(a) = n.strip_prefix('+') {
                st.ahead = a.parse().unwrap_or(0);
              } else if let Some(b) = n.strip_prefix('-') {
                st.behind = b.parse().unwrap_or(0);
              }
            }
          }
          _ => {}
        }
      }
      // 1 XY sub mH mI mW hH hI path
      "1" | "2" | "u" => {
        let fields = match kind {
          "1" => 8,
          "2" => 9,
          _ => 10,
        };
        let parts: Vec<&str> = rest.splitn(fields, ' ').collect();
        if parts.len() != fields {
          continue;
        }
        let xy: Vec<char> = parts[0].chars().collect();
        // A rename's source follows as its own NUL-terminated record.
        let orig = if kind == "2" { records.next() } else { None };
        let Some(path) = strip(parts[fields - 1]) else { continue };
        let conflict = kind == "u";
        st.entries.push(StatusEntry {
          path,
          orig_path: orig.and_then(|o| strip(o).or_else(|| Some(o.to_owned()))),
          index: if conflict { Some("U".into()) } else { xy.first().copied().and_then(code) },
          worktree: if conflict { Some("U".into()) } else { xy.get(1).copied().and_then(code) },
          conflict,
        });
      }
      "?" => {
        if let Some(path) = strip(rest) {
          st.entries.push(StatusEntry { path, orig_path: None, index: None, worktree: Some("?".into()), conflict: false });
        }
      }
      _ => {}
    }
  }
  st.detached = st.branch.is_none() && st.head.is_some();
  // git leaves out `branch.ab` when the upstream ref is missing.
  st.upstream_gone = st.upstream.is_some() && !has_ab;
  st
}

/// `git add -A`, so deletions are staged too.
pub fn stage(root: &Path, paths: &[String]) -> Result<(), String> {
  git_queue::with(root, Scope::Worktree, "add", || run_paths(root, &["add", "-A"], paths))
}

/// `git restore --staged`; before the first commit there is no HEAD, so `git rm --cached`.
pub fn unstage(root: &Path, paths: &[String]) -> Result<(), String> {
  let _queue = git_queue::lock(root, Scope::Worktree, "restore --staged")?;
  if has_head(root) {
    run_paths(root, &["restore", "--staged"], paths)
  } else {
    run_paths(root, &["rm", "--cached", "-r", "-q", "--ignore-unmatch"], paths)
  }
}

/// Throws away working-tree changes (back to the index, like VS Code's "Discard Changes").
/// Untracked files are deleted, which cannot be undone, so that needs `delete_untracked`.
///
/// `to_trash` (VS Code's `git.discardUntrackedChangesToTrash`) moves untracked files to the trash
/// instead of deleting them.
pub fn discard(root: &Path, paths: &[String], delete_untracked: bool, to_trash: bool) -> Result<(), String> {
  let _queue = git_queue::lock(root, Scope::Worktree, "restore")?;
  let Some(st) = status(root)? else { return Err("not a git repository".into()) };
  let untracked: HashSet<&str> =
    st.entries.iter().filter(|e| e.worktree.as_deref() == Some("?")).map(|e| e.path.as_str()).collect();
  let (new, tracked): (Vec<String>, Vec<String>) = paths.iter().cloned().partition(|p| untracked.contains(p.as_str()));
  if !new.is_empty() && !delete_untracked {
    return Err(format!("{}: untracked, deleting needs confirmation", new.join(", ")));
  }
  run_paths(root, &["restore", "--worktree"], &tracked)?;
  if to_trash {
    for rel in &new {
      check_rel(root, rel)?;
      trash::delete(root.join(rel)).map_err(|e| format!("{rel}: {e}"))?;
    }
    return Ok(());
  }
  // `git clean` only ever removes untracked files, so a racing `git add` cannot lose staged work.
  run_paths(root, &["clean", "-f", "-q"], &new)
}

/// Commit flags from VS Code's git settings and commands.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CommitOptions {
  pub amend: bool,
  /// `git.alwaysSignOff`: `--signoff`.
  pub signoff: bool,
  /// `git.enableCommitSigning`: `-S` (GPG, X.509 or SSH, per git's own config).
  pub sign: bool,
  /// Commit (No Verify), allowed by `git.allowNoVerifyCommit`: skips the pre-commit and commit-msg hooks.
  pub no_verify: bool,
  /// Commit Empty: `--allow-empty`.
  pub empty: bool,
}

/// The `git commit` arguments for `opts` (before `-m`).
pub fn commit_flags(opts: &CommitOptions) -> Vec<&'static str> {
  let mut flags = vec!["commit", "-q", "--cleanup=strip"];
  for (on, flag) in [(opts.amend, "--amend"), (opts.signoff, "--signoff"), (opts.sign, "-S"), (opts.no_verify, "--no-verify"), (opts.empty, "--allow-empty")] {
    if on {
      flags.push(flag);
    }
  }
  flags
}

pub fn commit(root: &Path, message: &str, opts: &CommitOptions) -> Result<(), String> {
  if message.trim().is_empty() {
    return Err("commit message is empty".into());
  }
  let _queue = git_queue::lock(root, Scope::Repository, "commit")?;
  // `git diff --cached --quiet` fails when something is staged (git's own message is a page of status).
  if !opts.amend && !opts.empty && has_head(root) && run(root, &["diff", "--cached", "--quiet"]).is_ok() {
    return Err("nothing staged to commit".into());
  }
  let mut args = commit_flags(opts);
  args.extend(["-m", message]);
  run(root, &args).map(|_| ())
}

/// `git.requireGitUserConfig`: whether `user.name` and `user.email` are set for `root`.
pub fn user_configured(root: &Path) -> bool {
  ["user.name", "user.email"].iter().all(|k| run(root, &["config", "--get", k]).is_ok_and(|o| !String::from_utf8_lossy(&o).trim().is_empty()))
}

/// The HEAD version of `rel` for the diff editor; empty for files not in HEAD (added, untracked,
/// or no commit yet).
pub fn show_head(root: &Path, rel: &str) -> Result<String, String> {
  show_at(root, "HEAD", rel)
}

/// Rejects revisions that could be read as an option, a range or a `rev:path` spec. Plain refs,
/// commit ids and `~`/`^` suffixes pass; callers still resolve them with `--end-of-options`.
pub fn check_rev(rev: &str) -> Result<(), String> {
  let bad = rev.is_empty()
    || rev.len() > 255
    || rev.starts_with('-')
    || rev.contains("..")
    || rev.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, ':' | '\\' | '*' | '?' | '['));
  if bad { Err(format!("{rev:?}: invalid revision")) } else { Ok(()) }
}

/// Local branch names (`refs/heads`), sorted by git.
pub fn local_branches(root: &Path) -> Result<Vec<String>, String> {
  let out = run(root, &["for-each-ref", "--format=%(refname:short)", "refs/heads"])?;
  Ok(String::from_utf8_lossy(&out).lines().map(str::to_owned).filter(|l| !l.is_empty()).collect())
}

/// `+added -deleted` per path for the working tree (`unstaged`) and the index (`staged`);
/// binary files are left out.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct NumStat {
  pub unstaged: std::collections::HashMap<String, (u32, u32)>,
  pub staged: std::collections::HashMap<String, (u32, u32)>,
}

pub fn parse_numstat(text: &str) -> std::collections::HashMap<String, (u32, u32)> {
  text
    .lines()
    .filter_map(|l| {
      let mut f = l.splitn(3, '\t');
      let (a, d, path) = (f.next()?.parse().ok()?, f.next()?.parse().ok()?, f.next()?);
      // Renames read `old => new` or `dir/{old => new}`; keep the new path.
      let path = match (path.find('{'), path.find(" => ")) {
        (Some(open), Some(_)) => {
          let close = path.find('}')?;
          let inner = &path[open + 1..close];
          let new = inner.split(" => ").nth(1)?;
          format!("{}{}{}", &path[..open], new, &path[close + 1..]).replace("//", "/")
        }
        (None, Some(arrow)) => path[arrow + 4..].to_owned(),
        _ => path.to_owned(),
      };
      Some((path, (a, d)))
    })
    .collect()
}

pub fn numstat(root: &Path) -> Result<NumStat, String> {
  let unstaged = run(root, &["diff", "--numstat"])?;
  let staged = if has_head(root) { run(root, &["diff", "--cached", "--numstat"])? } else { Vec::new() };
  Ok(NumStat { unstaged: parse_numstat(&String::from_utf8_lossy(&unstaged)), staged: parse_numstat(&String::from_utf8_lossy(&staged)) })
}

/// Source Control remote actions, each on its own (Orca's dropdown): push (optionally force with
/// lease), pull (optionally fast-forward only), fetch, and rebase onto a remote base.
pub fn push(root: &Path, force_with_lease: bool) -> Result<(), String> {
  let _queue = git_queue::lock(root, Scope::Refs, "push")?;
  let mut args = vec!["push", "-q"];
  if force_with_lease {
    args.push("--force-with-lease");
  }
  run_remote(root, &args)
}

pub fn pull(root: &Path, ff_only: bool) -> Result<(), String> {
  let _queue = git_queue::lock(root, Scope::Repository, "pull")?;
  run_remote(root, &["pull", "-q", "--no-edit", if ff_only { "--ff-only" } else { "--no-rebase" }])
}

pub fn rebase(root: &Path, base: &str) -> Result<(), String> {
  check_rev(base)?;
  let _queue = git_queue::lock(root, Scope::Repository, "rebase")?;
  run_remote(root, &["fetch", "-q"])?;
  run(root, &["rebase", "-q", "--end-of-options", base]).map(|_| ())
}

/// One commit of the Commits panel.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Commit {
  pub hash: String,
  pub short: String,
  pub subject: String,
  pub author: String,
  /// Unix seconds.
  pub time: i64,
  /// Branch and tag names pointing at this commit.
  pub refs: Vec<String>,
}

pub fn parse_log(text: &str) -> Vec<Commit> {
  text
    .split('\x1e')
    .filter_map(|rec| {
      let mut f = rec.trim_start_matches('\n').split('\x1f');
      let hash = f.next()?.to_owned();
      if hash.is_empty() {
        return None;
      }
      let short = f.next()?.to_owned();
      let author = f.next()?.to_owned();
      let time = f.next()?.parse().ok()?;
      let refs = f.next()?.split(", ").map(|r| r.trim().trim_start_matches("HEAD -> ").to_owned()).filter(|r| !r.is_empty() && r != "HEAD").collect();
      let subject = f.next().unwrap_or("").trim_end().to_owned();
      Some(Commit { hash, short, subject, author, time, refs })
    })
    .collect()
}

/// The latest `limit` commits of HEAD; empty before the first commit.
pub fn log(root: &Path, limit: u32) -> Result<Vec<Commit>, String> {
  if !has_head(root) {
    return Ok(Vec::new());
  }
  let n = format!("-n{}", limit.clamp(1, 500));
  let out = run(root, &["log", &n, "--format=%H%x1f%h%x1f%an%x1f%at%x1f%D%x1f%s%x1e", "HEAD"])?;
  Ok(parse_log(&String::from_utf8_lossy(&out)))
}

/// Network operations must fail rather than wait for a password nobody can type.
fn run_remote(root: &Path, args: &[&str]) -> Result<(), String> {
  let out = crate::shell_env::command("git")
    .env("GIT_TERMINAL_PROMPT", "0")
    .arg("-C")
    .arg(root)
    .args(args)
    .output()
    .map_err(|e| format!("git: {e}"))?;
  if out.status.success() {
    return Ok(());
  }
  let err = String::from_utf8_lossy(if out.stderr.is_empty() { &out.stdout } else { &out.stderr });
  Err(format!("git {}: {}", args.first().unwrap_or(&""), err.trim()))
}

/// `rel` as of revision `rev` (for diffs against a task's base); empty when the file is not there.
pub fn show_at(root: &Path, rev: &str, rel: &str) -> Result<String, String> {
  check_rev(rev)?;
  let spec = format!("{rev}:./{rel}");
  if run(root, &["cat-file", "-e", &spec]).is_err() {
    return Ok(String::new());
  }
  let size = run(root, &["cat-file", "-s", &spec])?;
  if String::from_utf8_lossy(&size).trim().parse::<usize>().unwrap_or(0) > MAX_SHOW_BYTES {
    return Err(format!("{rel}: larger than {MAX_SHOW_BYTES} bytes"));
  }
  Ok(String::from_utf8_lossy(&run(root, &["cat-file", "blob", &spec])?).into_owned())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_log() {
    let c = parse_log("abc\x1fab\x1fAnn\x1f100\x1fHEAD -> main, origin/main, tag: v1\x1fFix it\x1e\ndef\x1fde\x1fBo\x1f90\x1f\x1fInit\x1e");
    assert_eq!(c.len(), 2);
    assert_eq!(c[0].refs, vec!["main", "origin/main", "tag: v1"]);
    assert_eq!((c[1].short.as_str(), c[1].subject.as_str(), c[1].time), ("de", "Init", 90));
  }

  #[test]
  fn parses_numstat() {
    let m = parse_numstat("3\t1\tsrc/a.ts\n-\t-\timg.png\n2\t0\tsrc/{old => new}/b.ts\n1\t1\tx.rs => y.rs\n");
    assert_eq!(m.get("src/a.ts"), Some(&(3, 1)));
    assert_eq!(m.get("src/new/b.ts"), Some(&(2, 0)));
    assert_eq!(m.get("y.rs"), Some(&(1, 1)));
    assert!(!m.contains_key("img.png"));
  }
  use std::process::Command;
  use std::path::PathBuf;

  fn sh_git(dir: &Path, args: &[&str]) -> bool {
    Command::new("git").arg("-C").arg(dir).args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"]).args(args).output().unwrap().status.success()
  }

  #[test]
  fn reads_the_operation_markers() {
    let tmp = tempfile::tempdir().unwrap();
    let d = tmp.path();
    assert_eq!(operation_in(d), None);
    std::fs::write(d.join("CHERRY_PICK_HEAD"), "x").unwrap();
    assert_eq!(operation_in(d), Some(Operation::CherryPick));
    std::fs::write(d.join("MERGE_HEAD"), "x").unwrap();
    assert_eq!(operation_in(d), Some(Operation::Merge));
    std::fs::create_dir(d.join("rebase-merge")).unwrap();
    assert_eq!(operation_in(d), Some(Operation::Rebase));
  }

  #[test]
  fn continues_a_merge_only_once_conflicts_are_resolved() {
    let tmp = tempfile::tempdir().unwrap();
    let d = tmp.path();
    assert!(sh_git(d, &["init", "-q", "-b", "main"]));
    std::fs::write(d.join("a.txt"), "base\n").unwrap();
    assert!(sh_git(d, &["add", "."]) && sh_git(d, &["commit", "-qm", "base"]));
    assert!(sh_git(d, &["checkout", "-qb", "other"]));
    std::fs::write(d.join("a.txt"), "other\n").unwrap();
    assert!(sh_git(d, &["commit", "-qam", "other"]));
    assert!(sh_git(d, &["checkout", "-q", "main"]));
    std::fs::write(d.join("a.txt"), "main\n").unwrap();
    assert!(sh_git(d, &["commit", "-qam", "main"]));
    assert!(!sh_git(d, &["merge", "-q", "other"]));
    assert_eq!(operation(d), Some(Operation::Merge));
    assert!(continue_operation(d).unwrap_err().contains("1 file(s) still have conflicts"));
    std::fs::write(d.join("a.txt"), "both\n").unwrap();
    assert!(sh_git(d, &["add", "a.txt"]));
    // `continue_operation` commits through `run`, so the repository needs its own identity.
    assert!(sh_git(d, &["config", "user.name", "t"]) && sh_git(d, &["config", "user.email", "t@t"]) && sh_git(d, &["config", "commit.gpgsign", "false"]));
    assert_eq!(continue_operation(d), Ok(Operation::Merge));
    assert_eq!(operation(d), None);
  }

  #[test]
  fn marks_ignored_entries_of_a_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    assert!(Command::new("git").arg("-C").arg(dir).args(["init", "-q"]).status().unwrap().success());
    std::fs::write(dir.join(".gitignore"), "target/\n*.log\n").unwrap();
    std::fs::create_dir(dir.join("target")).unwrap();
    std::fs::create_dir(dir.join("src")).unwrap();
    std::fs::write(dir.join("run.log"), "").unwrap();
    std::fs::write(dir.join("a.ts"), "").unwrap();
    let mut entries = crate::fs::list_dir(dir, dir).unwrap();
    mark_ignored(dir, &mut entries);
    let ignored: Vec<&str> = entries.iter().filter(|e| e.ignored).map(|e| e.name.as_str()).collect();
    assert_eq!(ignored, ["target", "run.log"]);

    // A folder with nothing tracked is untracked; one with a tracked file is not, even with new files.
    std::fs::create_dir(dir.join("new dir")).unwrap();
    std::fs::write(dir.join("new dir/x.ts"), "").unwrap();
    std::fs::write(dir.join("src/old.ts"), "").unwrap();
    git(dir, &["add", "src/old.ts"]);
    git(dir, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x"]);
    std::fs::write(dir.join("src/new.ts"), "").unwrap();
    let mut entries = crate::fs::list_dir(dir, dir).unwrap();
    mark_ignored(dir, &mut entries);
    let untracked: Vec<&str> = entries.iter().filter(|e| e.untracked).map(|e| e.name.as_str()).collect();
    assert_eq!(untracked, ["new dir"]);

    // Outside a repository nothing is marked.
    let plain = tempfile::tempdir().unwrap();
    std::fs::write(plain.path().join("x.log"), "").unwrap();
    let mut entries = crate::fs::list_dir(plain.path(), plain.path()).unwrap();
    mark_ignored(plain.path(), &mut entries);
    assert!(entries.iter().all(|e| !e.ignored));
  }

  #[test]
  fn folder_status_leaves_task_worktrees_out() {
    let (_tmp, repo) = temp_repo();
    git(&repo, &["worktree", "add", "-q", "-b", "kingu/t", ".kingu/worktrees/t"]);
    write(&repo, ".kingu/worktrees/t/agent.txt", "x\n");
    write(&repo, ".kingu/settings.json", "{}\n");
    write(&repo, "mine.txt", "x\n");
    let paths: Vec<String> = status(&repo).unwrap().unwrap().entries.into_iter().map(|e| e.path).collect();
    assert_eq!(paths, [".kingu/settings.json", "mine.txt"]);
    // The task's own status still sees its change.
    let task: Vec<String> = status(&repo.join(".kingu/worktrees/t")).unwrap().unwrap().entries.into_iter().map(|e| e.path).collect();
    assert_eq!(task, ["agent.txt"]);
    assert!(in_task_worktree(".kingu/worktrees/t/x") && !in_task_worktree(".kingu/worktreesx"));
  }

  fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(ok.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&ok.stderr));
  }

  fn write(repo: &Path, rel: &str, text: &str) {
    let p = repo.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
  }

  /// A repo with one commit: a.txt, b.txt, old.txt, sub/c.txt.
  fn temp_repo() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().canonicalize().unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    for (k, v) in [("user.name", "t"), ("user.email", "t@example.com"), ("commit.gpgsign", "false")] {
      git(&repo, &["config", k, v]);
    }
    for f in ["a.txt", "b.txt", "old.txt", "sub/c.txt"] {
      write(&repo, f, &format!("{f}\n"));
    }
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "init"]);
    (tmp, repo)
  }

  fn entry<'a>(st: &'a GitStatus, path: &str) -> &'a StatusEntry {
    st.entries.iter().find(|e| e.path == path).unwrap_or_else(|| panic!("{path} not in {:?}", st.entries))
  }

  fn codes(e: &StatusEntry) -> (Option<&str>, Option<&str>) {
    (e.index.as_deref(), e.worktree.as_deref())
  }

  #[test]
  fn reports_staged_unstaged_renamed_and_untracked() {
    let (_tmp, repo) = temp_repo();
    write(&repo, "a.txt", "changed\n"); // unstaged M
    write(&repo, "b.txt", "staged\n");
    git(&repo, &["add", "b.txt"]); // staged M
    write(&repo, "b.txt", "staged then edited\n"); // and unstaged M
    std::fs::remove_file(repo.join("sub/c.txt")).unwrap(); // unstaged D
    git(&repo, &["mv", "old.txt", "new name.txt"]); // staged R, with a space
    write(&repo, "added.txt", "x\n");
    git(&repo, &["add", "added.txt"]); // staged A
    write(&repo, "dir/untracked.txt", "u\n"); // untracked, listed per file

    let st = status(&repo).unwrap().unwrap();
    assert_eq!(st.branch.as_deref(), Some("main"));
    assert!(st.head.is_some());
    assert_eq!((st.ahead, st.behind), (0, 0));
    assert_eq!(st.entries.len(), 6, "{:?}", st.entries);
    assert_eq!(codes(entry(&st, "a.txt")), (None, Some("M")));
    assert_eq!(codes(entry(&st, "b.txt")), (Some("M"), Some("M")));
    assert_eq!(codes(entry(&st, "sub/c.txt")), (None, Some("D")));
    assert_eq!(codes(entry(&st, "added.txt")), (Some("A"), None));
    assert_eq!(codes(entry(&st, "dir/untracked.txt")), (None, Some("?")));
    let renamed = entry(&st, "new name.txt");
    assert_eq!(codes(renamed), (Some("R"), None));
    assert_eq!(renamed.orig_path.as_deref(), Some("old.txt"));
  }

  #[test]
  fn parses_branch_headers_conflicts_and_prefix() {
    let text = "# branch.oid (initial)\0# branch.head (detached)\0# branch.upstream origin/main\0# branch.ab +3 -2\0\
                u UU N... 100644 100644 100644 100644 h1 h2 h3 ws/conf.txt\0\
                2 R. N... 100644 100644 100644 h h R100 ws/to.txt\0ws/from.txt\0\
                1 .M N... 100644 100644 100644 h h other/x.txt\0? ws/new.txt\0";
    let st = parse_status(text, "ws/");
    assert_eq!((st.branch, st.head), (None, None));
    assert_eq!(st.upstream.as_deref(), Some("origin/main"));
    assert_eq!((st.ahead, st.behind), (3, 2));
    assert!(!st.detached, "no commit yet");
    assert!(!st.upstream_gone);
    let gone = parse_status("# branch.oid abc\0# branch.head (detached)\0# branch.upstream origin/x\0", "");
    assert!(gone.detached && gone.upstream_gone);
    let paths: Vec<_> = st.entries.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(paths, ["conf.txt", "to.txt", "new.txt"]);
    assert!(st.entries[0].conflict);
    assert_eq!(st.entries[1].orig_path.as_deref(), Some("from.txt"));
  }

  #[test]
  fn stages_unstages_and_commits() {
    let (_tmp, repo) = temp_repo();
    write(&repo, "a.txt", "changed\n");
    std::fs::remove_file(repo.join("b.txt")).unwrap();
    write(&repo, "n.txt", "new\n");
    let all = ["a.txt", "b.txt", "n.txt"].map(String::from);

    stage(&repo, &all).unwrap();
    let st = status(&repo).unwrap().unwrap();
    assert_eq!(codes(entry(&st, "a.txt")), (Some("M"), None));
    assert_eq!(codes(entry(&st, "b.txt")), (Some("D"), None));
    assert_eq!(codes(entry(&st, "n.txt")), (Some("A"), None));

    unstage(&repo, &all[..1]).unwrap();
    let st = status(&repo).unwrap().unwrap();
    assert_eq!(codes(entry(&st, "a.txt")), (None, Some("M")));

    let plain = CommitOptions::default();
    assert!(commit(&repo, "  \n", &plain).is_err());
    commit(&repo, "second", &plain).unwrap();
    let st = status(&repo).unwrap().unwrap();
    assert_eq!(st.entries.len(), 1, "only the unstaged a.txt is left: {:?}", st.entries);
    assert_eq!(show_head(&repo, "n.txt").unwrap(), "new\n");

    commit(&repo, "second, amended", &CommitOptions { amend: true, ..plain }).unwrap();
    let log = Command::new("git").arg("-C").arg(&repo).args(["log", "--format=%s"]).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&log.stdout), "second, amended\ninit\n");
    assert!(commit(&repo, "nothing staged", &plain).unwrap_err().contains("nothing"));

    // git.alwaysSignOff and Commit Empty (git.confirmEmptyCommits asks first, in the webview).
    commit(&repo, "empty", &CommitOptions { empty: true, signoff: true, ..plain }).unwrap();
    let body = Command::new("git").arg("-C").arg(&repo).args(["log", "-1", "--format=%B"]).output().unwrap();
    assert!(String::from_utf8_lossy(&body.stdout).contains("Signed-off-by: t <t@example.com>"), "{}", String::from_utf8_lossy(&body.stdout));
  }

  #[test]
  fn commit_flags_follow_the_settings() {
    assert_eq!(commit_flags(&CommitOptions::default()), ["commit", "-q", "--cleanup=strip"]);
    let all = CommitOptions { amend: true, signoff: true, sign: true, no_verify: true, empty: true };
    assert_eq!(commit_flags(&all), ["commit", "-q", "--cleanup=strip", "--amend", "--signoff", "-S", "--no-verify", "--allow-empty"]);
  }

  #[test]
  fn no_verify_skips_the_pre_commit_hook() {
    let (_tmp, repo) = temp_repo();
    let hook = repo.join(".git/hooks/pre-commit");
    std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
    std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    write(&repo, "a.txt", "changed\n");
    stage(&repo, &["a.txt".into()]).unwrap();
    assert!(commit(&repo, "hooked", &CommitOptions::default()).is_err());
    commit(&repo, "skipped", &CommitOptions { no_verify: true, ..Default::default() }).unwrap();
  }

  #[test]
  fn status_args_follow_the_settings() {
    let base = ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--", "."];
    assert_eq!(status_args(&StatusOptions::default()), base);
    let args = status_args(&StatusOptions { similarity_threshold: 80, ignore_submodules: true });
    assert_eq!(args[5..7], ["--ignore-submodules", "--find-renames=80%"]);
  }

  #[test]
  fn similarity_threshold_changes_rename_detection() {
    let (_tmp, repo) = temp_repo();
    std::fs::rename(repo.join("a.txt"), repo.join("moved.txt")).unwrap();
    // 9 of 10 lines kept: a rename at 50%, a delete + add at 95%.
    let text: String = (0..10).map(|i| format!("line {i}\n")).collect();
    write(&repo, "moved.txt", &text);
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "ten"]);
    std::fs::rename(repo.join("moved.txt"), repo.join("again.txt")).unwrap();
    write(&repo, "again.txt", &text.replace("line 9", "changed"));
    git(&repo, &["add", "-A"]);
    let renamed = |t| status_with(&repo, &StatusOptions { similarity_threshold: t, ignore_submodules: false }).unwrap().unwrap().entries.iter().any(|e| e.orig_path.is_some());
    assert!(renamed(50));
    assert!(!renamed(95));
  }

  #[test]
  fn reads_user_configuration_and_git_path() {
    let (_tmp, repo) = temp_repo();
    assert!(user_configured(&repo));
    git(&repo, &["config", "user.email", ""]);
    assert!(!user_configured(&repo));
    let file = repo.join("a.txt");
    let list = serde_json::json!(["relative/git", "/no/such/git", file.to_str().unwrap()]);
    assert_eq!(pick_git_path(Some(&list)), Some(file.clone()));
    assert_eq!(pick_git_path(Some(&serde_json::json!(null))), None);
    assert_eq!(pick_git_path(Some(&serde_json::json!("/no/such/git"))), None);
    assert_eq!(pick_git_path(None), None);
  }

  #[test]
  fn unstages_before_the_first_commit() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().canonicalize().unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    write(&repo, "a.txt", "a\n");
    stage(&repo, &["a.txt".into()]).unwrap();
    assert_eq!(codes(entry(&status(&repo).unwrap().unwrap(), "a.txt")), (Some("A"), None));
    unstage(&repo, &["a.txt".into()]).unwrap();
    assert_eq!(codes(entry(&status(&repo).unwrap().unwrap(), "a.txt")), (None, Some("?")));
    assert_eq!(show_head(&repo, "a.txt").unwrap(), "");
  }

  #[test]
  fn discards_and_needs_a_flag_to_delete_untracked() {
    let (_tmp, repo) = temp_repo();
    write(&repo, "a.txt", "changed\n");
    write(&repo, "u.txt", "u\n");
    let both = ["a.txt", "u.txt"].map(String::from);
    assert!(discard(&repo, &both, false, false).unwrap_err().contains("u.txt"));
    assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "changed\n", "nothing discarded on refusal");
    discard(&repo, &both, true, false).unwrap();
    assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "a.txt\n");
    assert!(!repo.join("u.txt").exists());
    assert!(status(&repo).unwrap().unwrap().entries.is_empty());
  }

  #[test]
  fn shows_head_and_treats_paths_literally() {
    let (_tmp, repo) = temp_repo();
    write(&repo, "a.txt", "changed\n");
    assert_eq!(show_head(&repo, "a.txt").unwrap(), "a.txt\n");
    assert_eq!(show_head(&repo, "sub/c.txt").unwrap(), "sub/c.txt\n");
    assert_eq!(show_head(&repo, "missing.txt").unwrap(), "");
    assert_eq!(show_at(&repo, "main", "sub/c.txt").unwrap(), "sub/c.txt\n");
    for bad in ["", "-p", "a..b", "HEAD:x", "a b", "main\n"] {
      assert!(show_at(&repo, bad, "a.txt").is_err(), "{bad:?}");
    }
    assert_eq!(local_branches(&repo).unwrap(), ["main"]);
    // Pathspec magic would stage every file; literally it matches nothing.
    assert!(stage(&repo, &[":(glob)*".into()]).is_err());
    assert_eq!(codes(entry(&status(&repo).unwrap().unwrap(), "a.txt")), (None, Some("M")));
  }

  #[test]
  fn outside_a_repository_is_none() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().canonicalize().unwrap();
    // Only meaningful when the temp dir is not itself inside some repository.
    if prefix(&dir).is_none() {
      assert_eq!(status(&dir).unwrap(), None);
    }
  }

  #[test]
  fn checks_relative_paths() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    write(&root, "a/b.txt", "");
    assert!(check_rel(&root, "a/b.txt").is_ok());
    assert!(check_rel(&root, "a/deleted.txt").is_ok());
    assert!(check_rel(&root, "gone/dir/x.txt").is_ok());
    for bad in ["", "../x", "a/../../x", "/etc/hosts"] {
      assert!(check_rel(&root, bad).is_err(), "{bad}");
    }
    #[cfg(unix)]
    {
      let outside = tempfile::tempdir().unwrap();
      std::os::unix::fs::symlink(outside.path(), root.join("link")).unwrap();
      assert!(check_rel(&root, "link/x.txt").is_err());
      // The link itself lives in the workspace (git tracks links, not their targets).
      assert!(check_rel(&root, "link").is_ok());
    }
  }
}
