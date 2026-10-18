//! Remotes and branches (VS Code's git extension: Fetch, Pull, Push, Sync, Publish Branch,
//! Checkout to…, Create Branch, Stash, Delete Branch). Like `git.rs` it drives the `git` CLI with
//! no shell, every user-supplied name validated first.
//!
//! Network operations never prompt: `GIT_TERMINAL_PROMPT=0`, no askpass helper, ssh in
//! `BatchMode`, so a missing credential fails fast instead of hanging an invisible prompt. The
//! webview then offers to rerun the command in a terminal, where the user can authenticate.
//! Only one operation runs at a time ([`GitOps`]); it can be cancelled and times out.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::State;

use crate::git::{check_rev, run};
use crate::workspace::Workspace;

/// How long a network operation may run before it is killed.
pub const NET_TIMEOUT: Duration = Duration::from_secs(120);

/// Start of the message for an authentication failure; the webview keys "Open in Terminal" on it.
pub const AUTH_FAILED: &str = "ยืนยันตัวตนกับ remote ไม่สำเร็จ";

// ---------------------------------------------------------------------------------------------
// One operation at a time

/// The running remote/branch operation, if any, as its cancel flag.
#[derive(Default, Clone)]
pub struct GitOps(Arc<Mutex<Option<Arc<AtomicBool>>>>);

/// Held for the length of an operation; dropping it frees the slot.
pub struct OpGuard {
  slot: Arc<Mutex<Option<Arc<AtomicBool>>>>,
  cancel: Arc<AtomicBool>,
}

impl GitOps {
  pub fn begin(&self) -> Result<OpGuard, String> {
    let mut slot = self.0.lock().map_err(|e| e.to_string())?;
    if slot.is_some() {
      return Err("มีคำสั่ง git อื่นกำลังทำงานอยู่ รอให้เสร็จก่อน".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    *slot = Some(cancel.clone());
    Ok(OpGuard { slot: self.0.clone(), cancel })
  }

  /// Cancels the running operation; false when none runs.
  pub fn cancel(&self) -> bool {
    match self.0.lock().ok().and_then(|s| s.clone()) {
      Some(flag) => {
        flag.store(true, Ordering::SeqCst);
        true
      }
      None => false,
    }
  }
}

impl OpGuard {
  pub fn flag(&self) -> &AtomicBool {
    &self.cancel
  }
}

impl Drop for OpGuard {
  fn drop(&mut self) {
    if let Ok(mut slot) = self.slot.lock() {
      *slot = None;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Non-interactive network git

/// `ssh -o BatchMode=yes`, keeping the user's own ssh command (`GIT_SSH_COMMAND`,
/// `core.sshCommand` or `GIT_SSH`) so their ssh config, keys and agent still apply.
pub fn ssh_command(user_env: Option<&str>, core_ssh: Option<&str>, git_ssh: Option<&str>) -> String {
  let base = [user_env, core_ssh]
    .into_iter()
    .flatten()
    .map(str::trim)
    .find(|s| !s.is_empty())
    .map(str::to_owned)
    .or_else(|| git_ssh.map(str::trim).filter(|s| !s.is_empty()).map(|p| format!("'{}'", p.replace('\'', r"'\''"))))
    .unwrap_or_else(|| "ssh".into());
  format!("{base} -o BatchMode=yes")
}

fn ssh_for(root: &Path) -> String {
  let core = run(root, &["config", "--get", "core.sshCommand"]).ok().map(|o| String::from_utf8_lossy(&o).trim().to_owned());
  ssh_command(std::env::var("GIT_SSH_COMMAND").ok().as_deref(), core.as_deref(), std::env::var("GIT_SSH").ok().as_deref())
}

/// Typical git / ssh / credential-helper output for a missing or rejected credential.
pub fn is_auth_failure(stderr: &str) -> bool {
  const PATTERNS: [&str; 14] = [
    "authentication failed",
    "could not read username",
    "could not read password",
    "terminal prompts disabled",
    "permission denied (publickey",
    "permission denied, please try again",
    "host key verification failed",
    "invalid username or password",
    "http basic: access denied",
    "the requested url returned error: 401",
    "the requested url returned error: 403",
    "no supported authentication methods",
    "bad credentials",
    "invalid credentials",
  ];
  let lower = stderr.to_lowercase();
  PATTERNS.iter().any(|p| lower.contains(p))
}

/// Why a network operation stopped early.
#[derive(Debug, PartialEq, Eq)]
enum Stopped {
  Cancelled,
  TimedOut,
}

struct NetOutput {
  ok: bool,
  stdout: String,
  stderr: String,
}

/// Kills git and everything it started (ssh, credential helpers): they share its process group,
/// and a leftover ssh would keep the output pipes open.
fn kill_tree(child: &mut std::process::Child) {
  #[cfg(unix)]
  // SAFETY: plain syscall on the group this function's caller created for the child.
  unsafe {
    libc::kill(-(child.id() as i32), libc::SIGKILL);
  }
  let _ = child.kill();
  let _ = child.wait();
}

fn spawn_reader(pipe: Option<impl Read + Send + 'static>) -> std::thread::JoinHandle<String> {
  std::thread::spawn(move || {
    let mut buf = Vec::new();
    if let Some(mut p) = pipe {
      let _ = p.read_to_end(&mut buf);
    }
    String::from_utf8_lossy(&buf).into_owned()
  })
}

/// Runs git with no way to prompt, until it exits, `cancel` is set or `timeout` passes.
fn run_net(root: &Path, args: &[&str], env: &[(&str, &str)], cancel: &AtomicBool, timeout: Duration) -> Result<NetOutput, Stopped> {
  run_net_streaming(root, args, env, cancel, timeout, &mut |_| {})
}

/// [`run_net`] handing each chunk of stderr to `on_err` as it arrives (clone progress).
fn run_net_streaming(
  root: &Path,
  args: &[&str],
  env: &[(&str, &str)],
  cancel: &AtomicBool,
  timeout: Duration,
  on_err: &mut dyn FnMut(&str),
) -> Result<NetOutput, Stopped> {
  let mut cmd: Command = crate::git::command();
  cmd.envs(env.iter().copied());
  cmd
    .arg("-C")
    .arg(root)
    .args(args)
    .env("GIT_TERMINAL_PROMPT", "0")
    // Empty, so git neither runs an askpass helper (core.askPass, SSH_ASKPASS) nor prompts.
    .env("GIT_ASKPASS", "")
    .env("SSH_ASKPASS_REQUIRE", "never")
    .env("GCM_INTERACTIVE", "never")
    .env("GIT_MERGE_AUTOEDIT", "no")
    .env("GIT_SSH_COMMAND", ssh_for(root))
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
  #[cfg(unix)]
  {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
  }
  let mut child = match cmd.spawn() {
    Ok(c) => c,
    Err(e) => return Ok(NetOutput { ok: false, stdout: String::new(), stderr: format!("git: {e}") }),
  };
  let out = spawn_reader(child.stdout.take());
  let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
  let mut pipe = child.stderr.take();
  let err = std::thread::spawn(move || {
    let mut buf = [0u8; 8192];
    while let Some(Ok(n)) = pipe.as_mut().map(|p| p.read(&mut buf)) {
      if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
        break;
      }
    }
  });
  let mut stderr = Vec::new();
  let mut drain = |stderr: &mut Vec<u8>| {
    while let Ok(chunk) = rx.try_recv() {
      on_err(&String::from_utf8_lossy(&chunk));
      stderr.extend_from_slice(&chunk);
    }
  };
  let deadline = Instant::now() + timeout;
  let result = loop {
    drain(&mut stderr);
    match child.try_wait() {
      Ok(Some(status)) => break Ok(status.success()),
      Ok(None) => {}
      Err(e) => {
        kill_tree(&mut child);
        let _ = (out.join(), err.join());
        return Ok(NetOutput { ok: false, stdout: String::new(), stderr: format!("git: {e}") });
      }
    }
    if cancel.load(Ordering::SeqCst) {
      kill_tree(&mut child);
      break Err(Stopped::Cancelled);
    }
    if Instant::now() >= deadline {
      kill_tree(&mut child);
      break Err(Stopped::TimedOut);
    }
    std::thread::sleep(Duration::from_millis(40));
  };
  let stdout = out.join().unwrap_or_default();
  let _ = err.join();
  drain(&mut stderr);
  let stderr = String::from_utf8_lossy(&stderr).into_owned();
  result.map(|ok| NetOutput { ok, stdout, stderr })
}

/// A network git command with the user-facing error for each way it can fail.
fn net(root: &Path, args: &[&str], cancel: &AtomicBool, timeout: Duration) -> Result<String, String> {
  net_env(root, args, &[], cancel, timeout)
}

/// `net` with extra environment variables (the snap installer restricts protocols and LFS).
/// The operation name in messages is the first argument that is not a `-c key=value` option.
pub(crate) fn net_env(root: &Path, args: &[&str], env: &[(&str, &str)], cancel: &AtomicBool, timeout: Duration) -> Result<String, String> {
  let mut rest = args;
  while let [flag, _, tail @ ..] = rest {
    if *flag != "-c" {
      break;
    }
    rest = tail;
  }
  let op = rest.first().copied().unwrap_or("");
  net_result(op, run_net(root, args, env, cancel, timeout), timeout)
}

fn net_result(op: &str, result: Result<NetOutput, Stopped>, timeout: Duration) -> Result<String, String> {
  match result {
    Err(Stopped::Cancelled) => Err(format!("ยกเลิก git {op} แล้ว")),
    Err(Stopped::TimedOut) => Err(format!("git {op} ใช้เวลานานเกิน {} วินาที จึงหยุดไว้", timeout.as_secs())),
    Ok(o) if o.ok => Ok(o.stdout),
    Ok(o) => {
      let msg = if o.stderr.trim().is_empty() { o.stdout.trim() } else { o.stderr.trim() };
      Err(net_error(op, msg))
    }
  }
}

/// Thai explanation for the common failures, git's own output after it.
pub fn net_error(op: &str, stderr: &str) -> String {
  let lower = stderr.to_lowercase();
  let why = if is_auth_failure(stderr) {
    format!("{AUTH_FAILED}: Kingu ไม่ถามรหัสผ่านเอง เปิดใน Terminal เพื่อยืนยันตัวตนแล้วลองใหม่")
  } else if lower.contains("not possible to fast-forward") || lower.contains("diverging branches") {
    "pull แบบ fast-forward ไม่ได้ เพราะ branch แยกทางกับ upstream แล้ว (ใช้ Git: Pull (Rebase) หรือ merge เอง)".into()
  } else if lower.contains("would be overwritten") {
    "การแก้ไขที่ยังไม่ commit จะถูกเขียนทับ ให้ commit หรือ stash ก่อน".into()
  } else if lower.contains("[rejected]") || lower.contains("updates were rejected") {
    "push ถูกปฏิเสธ เพราะ remote มี commit ที่ยังไม่มีในเครื่อง ให้ pull ก่อน".into()
  } else if lower.contains("could not resolve host") || lower.contains("unable to access") || lower.contains("connection timed out") {
    "ติดต่อ remote ไม่ได้ ตรวจการเชื่อมต่อเครือข่าย".into()
  } else if lower.contains("conflict") {
    "มี conflict ให้แก้ใน Source Control แล้ว commit".into()
  } else {
    format!("git {op} ไม่สำเร็จ")
  };
  if stderr.is_empty() { why } else { format!("{why}\n{stderr}") }
}

// ---------------------------------------------------------------------------------------------
// Names

/// A branch name the user typed: not an option, not `@{…}` shorthand, and valid for
/// `git check-ref-format --branch`.
pub fn check_branch_name(root: &Path, name: &str) -> Result<(), String> {
  let bad = name.is_empty()
    || name.len() > 255
    || name.starts_with('-')
    || name == "HEAD"
    || name.contains("@{")
    || name.chars().any(|c| c.is_whitespace() || c.is_control());
  if bad || run(root, &["check-ref-format", "--branch", name]).is_err() {
    return Err(format!("ชื่อ branch ไม่ถูกต้อง: {name:?}"));
  }
  Ok(())
}

fn current_branch(root: &Path) -> Option<String> {
  run(root, &["symbolic-ref", "--short", "-q", "HEAD"]).ok().map(|o| String::from_utf8_lossy(&o).trim().to_owned()).filter(|s| !s.is_empty())
}

fn ref_exists(root: &Path, full: &str) -> bool {
  run(root, &["show-ref", "--verify", "--quiet", full]).is_ok()
}

fn config(root: &Path, key: &str) -> Option<String> {
  run(root, &["config", "--get", key]).ok().map(|o| String::from_utf8_lossy(&o).trim().to_owned()).filter(|s| !s.is_empty())
}

// ---------------------------------------------------------------------------------------------
// Fetch, pull, push

/// Fetch flags (VS Code: `git.autofetch: "all"` fetches every remote, `git.pruneOnFetch`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FetchOptions {
  pub all: bool,
  pub prune: bool,
}

pub fn fetch_args(opts: &FetchOptions) -> Vec<&'static str> {
  let mut args = vec!["fetch"];
  if opts.all {
    args.push("--all");
  }
  if opts.prune {
    args.push("--prune");
  }
  args
}

pub fn fetch(root: &Path, opts: &FetchOptions, cancel: &AtomicBool, timeout: Duration) -> Result<(), String> {
  net(root, &fetch_args(opts), cancel, timeout).map(|_| ())
}

/// Pull flags (VS Code: Pull (Rebase) and `git.rebaseWhenSync`, `git.pullTags`, `git.autoStash`,
/// `git.fetchOnPull`, `git.replaceTagsWhenPull`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PullOptions {
  pub rebase: bool,
  pub tags: bool,
  pub auto_stash: bool,
  /// Fetch every remote and branch first.
  pub fetch_all: bool,
  /// On a tag conflict, take the remote's tags and pull again.
  pub replace_tags: bool,
}

/// `--ff-only` (never a surprise merge commit) unless `rebase`; `--no-rebase` so a `pull.rebase`
/// config cannot override the ff-only default.
pub fn pull_args(opts: &PullOptions) -> Vec<&'static str> {
  let mut args = vec!["pull"];
  if opts.tags {
    args.push("--tags");
  }
  if opts.auto_stash {
    args.push("--autostash");
  }
  if opts.rebase {
    args.push("--rebase");
  } else {
    args.extend(["--no-rebase", "--ff-only"]);
  }
  args
}

/// git's refusal to move a local tag that differs from the remote's.
fn is_tag_conflict(err: &str) -> bool {
  err.contains("would clobber existing tag")
}

pub fn pull(root: &Path, opts: &PullOptions, cancel: &AtomicBool, timeout: Duration) -> Result<(), String> {
  let Some(branch) = current_branch(root) else {
    return Err("HEAD ไม่ได้อยู่บน branch (detached) จึง pull ไม่ได้".into());
  };
  if config(root, &format!("branch.{branch}.merge")).is_none() {
    return Err(format!("branch {branch} ยังไม่มี upstream ให้ Publish Branch ก่อน"));
  }
  if opts.fetch_all {
    net(root, &["fetch", "--all"], cancel, timeout)?;
  }
  match net(root, &pull_args(opts), cancel, timeout) {
    Err(e) if opts.replace_tags && is_tag_conflict(&e) => {
      net(root, &["fetch", "--tags", "--force"], cancel, timeout)?;
      net(root, &pull_args(opts), cancel, timeout).map(|_| ())
    }
    Err(e) if is_tag_conflict(&e) => Err(format!("tag ในเครื่องขัดกับ tag ของ remote เปิด git.replaceTagsWhenPull เพื่อใช้ tag ของ remote แทน\n{e}")),
    r => r.map(|_| ()),
  }
}

/// How Push (Force) forces (VS Code's ForcePushMode, from `git.useForcePushWithLease` and
/// `git.useForcePushIfIncludes`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ForcePush {
  Force,
  WithLease,
  WithLeaseIfIncludes,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PushOptions {
  pub force: Option<ForcePush>,
  /// `git.followTagsWhenSync`: push annotated tags too.
  pub follow_tags: bool,
}

pub fn push_flags(opts: &PushOptions) -> Vec<&'static str> {
  let mut flags = vec!["push"];
  match opts.force {
    Some(ForcePush::Force) => flags.push("--force"),
    Some(ForcePush::WithLease) => flags.push("--force-with-lease"),
    Some(ForcePush::WithLeaseIfIncludes) => flags.extend(["--force-with-lease", "--force-if-includes"]),
    None => {}
  }
  if opts.follow_tags {
    flags.push("--follow-tags");
  }
  flags
}

/// Pushes the current branch to its upstream; with no upstream, publishes it to `remote`
/// (default `origin`) with `-u` (VS Code's Publish Branch). Returns the upstream pushed to.
pub fn push(root: &Path, remote: Option<&str>, opts: &PushOptions, cancel: &AtomicBool, timeout: Duration) -> Result<String, String> {
  let Some(branch) = current_branch(root) else {
    return Err("HEAD ไม่ได้อยู่บน branch (detached) สร้าง branch ก่อนแล้วจึง push".into());
  };
  let tracked = config(root, &format!("branch.{branch}.remote")).zip(config(root, &format!("branch.{branch}.merge")));
  match (tracked, remote) {
    (Some((r, merge)), None) if r != "." => {
      let spec = format!("refs/heads/{branch}:{merge}");
      let mut args = push_flags(opts);
      args.extend(["--", &r, &spec]);
      net(root, &args, cancel, timeout)?;
      Ok(format!("{r}/{}", merge.strip_prefix("refs/heads/").unwrap_or(&merge)))
    }
    _ => {
      let remotes = crate::git::remotes(root)?;
      let r = remote.unwrap_or("origin");
      if !remotes.iter().any(|x| x == r) {
        return Err(if remotes.is_empty() {
          "repository นี้ยังไม่มี remote ให้เพิ่มด้วย git remote add ก่อน".into()
        } else {
          format!("ไม่มี remote ชื่อ {r}")
        });
      }
      let spec = format!("refs/heads/{branch}:refs/heads/{branch}");
      let mut args = push_flags(opts);
      args.extend(["-u", "--", r, &spec]);
      net(root, &args, cancel, timeout)?;
      Ok(format!("{r}/{branch}"))
    }
  }
}

/// Pull, then push when there is anything to push (VS Code's Sync Changes).
pub fn sync(root: &Path, pull_opts: &PullOptions, push_opts: &PushOptions, cancel: &AtomicBool, timeout: Duration) -> Result<(), String> {
  pull(root, pull_opts, cancel, timeout)?;
  let ahead = run(root, &["rev-list", "--count", "@{upstream}..HEAD"]).map(|o| String::from_utf8_lossy(&o).trim().to_owned());
  if ahead.as_deref().is_ok_and(|n| n != "0") {
    push(root, None, push_opts, cancel, timeout)?;
  }
  Ok(())
}

// ---------------------------------------------------------------------------------------------
// Branches

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct BranchRef {
  /// `main`, or `origin/main` for a remote branch.
  pub name: String,
  pub remote: bool,
  /// Checked out here.
  pub current: bool,
  pub upstream: Option<String>,
  /// Checked out in another worktree (a task worktree under `.kingu/`): git refuses to check it
  /// out here too.
  pub worktree: Option<String>,
  pub commit: String,
  pub subject: String,
  /// A tag (Checkout to… lists them with `git.checkoutType`); checked out detached.
  pub tag: bool,
  /// Commit (or tag) date, seconds since the epoch, for `git.branchSortOrder: committerdate`.
  pub date: i64,
}

/// `git for-each-ref` fields; the hash is `hash_len` long (`git.commitShortHashLength`), a tag's
/// the commit it points at.
fn ref_format(hash_len: u8) -> String {
  let n = hash_len.clamp(4, 40);
  format!(
    "--format=%(refname)%00%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(worktreepath)%00%(if)%(*objectname)%(then)%(*objectname:short={n})%(else)%(objectname:short={n})%(end)%00%(subject)%00%(creatordate:unix)"
  )
}

/// Parses `git for-each-ref` with [`ref_format`]. `here` is this worktree's top level, so a
/// branch checked out here is not reported as used by another worktree.
pub fn parse_refs(text: &str, here: &Path) -> Vec<BranchRef> {
  let mut out = Vec::new();
  for line in text.lines() {
    let f: Vec<&str> = line.split('\0').collect();
    if f.len() < 7 {
      continue;
    }
    let remote = f[0].starts_with("refs/remotes/");
    let tag = f[0].starts_with("refs/tags/");
    // `origin/HEAD` points at another remote branch.
    if remote && f[0].ends_with("/HEAD") {
      continue;
    }
    let current = f[2] == "*";
    let other = (!f[4].is_empty() && !current && !same_path(Path::new(f[4]), here)).then(|| f[4].to_owned());
    out.push(BranchRef {
      name: f[1].to_owned(),
      remote,
      current,
      upstream: (!f[3].is_empty()).then(|| f[3].to_owned()),
      worktree: other,
      commit: f[5].to_owned(),
      subject: f[6].to_owned(),
      tag,
      date: f.get(7).and_then(|d| d.parse().ok()).unwrap_or(0),
    });
  }
  out
}

fn same_path(a: &Path, b: &Path) -> bool {
  a == b || matches!((a.canonicalize(), b.canonicalize()), (Ok(x), Ok(y)) if x == y)
}

fn toplevel(root: &Path) -> Result<std::path::PathBuf, String> {
  let out = run(root, &["rev-parse", "--show-toplevel"])?;
  Ok(std::path::PathBuf::from(String::from_utf8_lossy(&out).trim()))
}

/// Local then remote branches, each sorted by name (tests; the webview asks [`refs`]).
#[cfg(test)]
pub fn branches(root: &Path) -> Result<Vec<BranchRef>, String> {
  refs(root, 7, false)
}

/// Local then remote branches, then tags with `tags`, each sorted by name.
pub fn refs(root: &Path, hash_len: u8, tags: bool) -> Result<Vec<BranchRef>, String> {
  let format = ref_format(hash_len);
  let mut args = vec!["for-each-ref", format.as_str(), "refs/heads", "refs/remotes"];
  if tags {
    args.push("refs/tags");
  }
  let out = run(root, &args)?;
  Ok(parse_refs(&String::from_utf8_lossy(&out), &toplevel(root)?))
}

/// git's "already used by worktree at '<path>'" (and older "already checked out at"), in Thai.
fn worktree_error(name: &str, stderr: &str) -> Option<String> {
  let lower = stderr.to_lowercase();
  let at = ["used by worktree at", "checked out at"].into_iter().find_map(|k| lower.find(k).map(|i| i + k.len()))?;
  let path = stderr[at..].trim().trim_matches(|c| c == '\'' || c == '"').lines().next().unwrap_or("").trim_end_matches('\'').to_owned();
  Some(format!("branch {name} ถูก check out อยู่ใน worktree อื่น ({path}) git จึงไม่ยอมให้ใช้ที่นี่อีก"))
}

fn branch_error(what: &str, name: &str, e: &str) -> String {
  if let Some(msg) = worktree_error(name, e) {
    return msg;
  }
  let lower = e.to_lowercase();
  if lower.contains("would be overwritten") {
    return format!("{what} {name} ไม่ได้: การแก้ไขที่ยังไม่ commit จะถูกเขียนทับ ให้ commit หรือ stash ก่อน\n{e}");
  }
  if lower.contains("already exists") {
    return format!("มี branch ชื่อ {name} อยู่แล้ว");
  }
  format!("{what} {name} ไม่สำเร็จ\n{e}")
}

/// Switches to local branch `name`; a remote branch `origin/x` checks out (creating when needed)
/// the local `x` tracking it. Returns the local branch now checked out.
#[cfg(test)]
pub fn checkout(root: &Path, name: &str, remote: bool) -> Result<String, String> {
  checkout_with(root, name, remote, &CheckoutOptions::default(), &AtomicBool::new(false))
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CheckoutOptions {
  /// `name` is a tag: check it out detached.
  pub tag: bool,
  /// `git.pullBeforeCheckout`: fast-forward a local branch with no outgoing commits from its
  /// upstream first.
  pub pull_before: bool,
}

/// `git fetch <remote> <merge>:refs/heads/<branch>`: fast-forwards a branch that is not checked
/// out (git refuses anything but a fast-forward without `+`). Skipped when the branch has
/// commits its upstream lacks, or no upstream.
pub fn fast_forward_branch(root: &Path, branch: &str, cancel: &AtomicBool, timeout: Duration) -> Result<bool, String> {
  let (Some(remote), Some(merge)) = (config(root, &format!("branch.{branch}.remote")), config(root, &format!("branch.{branch}.merge"))) else {
    return Ok(false);
  };
  if remote == "." {
    return Ok(false);
  }
  let outgoing = run(root, &["rev-list", "--count", &format!("{branch}@{{upstream}}..refs/heads/{branch}")]).map(|o| String::from_utf8_lossy(&o).trim().to_owned());
  if outgoing.as_deref().is_ok_and(|n| n != "0") {
    return Ok(false);
  }
  net(root, &["fetch", "--", &remote, &format!("{merge}:refs/heads/{branch}")], cancel, timeout)?;
  Ok(true)
}

pub fn checkout_with(root: &Path, name: &str, remote: bool, opts: &CheckoutOptions, cancel: &AtomicBool) -> Result<String, String> {
  check_rev(name).map_err(|_| format!("ชื่อ branch ไม่ถูกต้อง: {name:?}"))?;
  if opts.tag {
    if !ref_exists(root, &format!("refs/tags/{name}")) {
      return Err(format!("ไม่พบ tag {name}"));
    }
    run(root, &["switch", "--detach", &format!("refs/tags/{name}")]).map_err(|e| branch_error("check out", name, &e))?;
    return Ok(name.to_owned());
  }
  if !remote {
    if !ref_exists(root, &format!("refs/heads/{name}")) {
      return Err(format!("ไม่พบ branch {name}"));
    }
    if opts.pull_before && current_branch(root).as_deref() != Some(name) {
      // Like VS Code, a failed fast-forward (offline, diverged) does not stop the checkout.
      if let Err(e) = fast_forward_branch(root, name, cancel, NET_TIMEOUT) {
        log::warn!("git.pullBeforeCheckout {name}: {e}");
      }
    }
    run(root, &["switch", "--no-guess", name]).map_err(|e| branch_error("check out", name, &e))?;
    return Ok(name.to_owned());
  }
  if !ref_exists(root, &format!("refs/remotes/{name}")) {
    return Err(format!("ไม่พบ remote branch {name}"));
  }
  let remotes = crate::git::remotes(root)?;
  let local = remotes
    .iter()
    .filter_map(|r| name.strip_prefix(r.as_str()).and_then(|rest| rest.strip_prefix('/')))
    .min_by_key(|rest| rest.len())
    .ok_or_else(|| format!("{name}: ไม่ใช่ branch ของ remote ที่รู้จัก"))?
    .to_owned();
  check_branch_name(root, &local)?;
  if ref_exists(root, &format!("refs/heads/{local}")) {
    let upstream = run(root, &["rev-parse", "--abbrev-ref", &format!("{local}@{{upstream}}")]).ok();
    if upstream.map(|o| String::from_utf8_lossy(&o).trim().to_owned()).as_deref() != Some(name) {
      return Err(format!("มี branch {local} อยู่แล้วแต่ไม่ได้ track {name} ให้เลือก {local} แทน"));
    }
    run(root, &["switch", "--no-guess", &local]).map_err(|e| branch_error("check out", &local, &e))?;
  } else {
    run(root, &["switch", "-c", &local, "--track", name]).map_err(|e| branch_error("check out", name, &e))?;
  }
  Ok(local)
}

/// `git switch -c name [from]` (Create Branch / Create Branch From…).
pub fn create_branch(root: &Path, name: &str, from: Option<&str>) -> Result<(), String> {
  check_branch_name(root, name)?;
  let mut args = vec!["switch", "-c", name];
  if let Some(from) = from {
    check_rev(from).map_err(|_| format!("ไม่รู้จัก {from:?}"))?;
    args.push(from);
  }
  run(root, &args).map(|_| ()).map_err(|e| branch_error("สร้าง branch", name, &e))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeleteResult {
  Deleted,
  /// `-d` refused: commits only on this branch would be lost; the webview asks before `force`.
  NotMerged,
}

pub fn delete_branch(root: &Path, name: &str, force: bool) -> Result<DeleteResult, String> {
  check_rev(name).map_err(|_| format!("ชื่อ branch ไม่ถูกต้อง: {name:?}"))?;
  if !ref_exists(root, &format!("refs/heads/{name}")) {
    return Err(format!("ไม่พบ branch {name}"));
  }
  if current_branch(root).as_deref() == Some(name) {
    return Err(format!("ลบ branch ปัจจุบัน ({name}) ไม่ได้ ให้ check out branch อื่นก่อน"));
  }
  match run(root, &["branch", if force { "-D" } else { "-d" }, "--", name]) {
    Ok(_) => Ok(DeleteResult::Deleted),
    Err(e) if !force && e.contains("not fully merged") => Ok(DeleteResult::NotMerged),
    Err(e) => Err(worktree_error(name, &e).unwrap_or_else(|| format!("ลบ branch {name} ไม่สำเร็จ\n{e}"))),
  }
}

// ---------------------------------------------------------------------------------------------
// Stash

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Stash {
  pub index: u32,
  /// The message, or git's `WIP on <branch>: <commit>` default.
  pub message: String,
  pub branch: Option<String>,
  /// Relative age, e.g. `2 hours ago`.
  pub when: String,
}

/// `git stash` takes no paths here, and with `--literal-pathspecs` (which [`run`] adds) git 2.56
/// silently leaves untracked files out of `stash push --include-untracked`.
fn run_unliteral(root: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
  let out = crate::git::command().arg("-C").arg(root).args(args).stdin(Stdio::null()).output().map_err(|e| format!("git: {e}"))?;
  if !out.status.success() {
    let err = String::from_utf8_lossy(if out.stderr.is_empty() { &out.stdout } else { &out.stderr });
    return Err(format!("git {}: {}", args.first().unwrap_or(&""), err.trim()));
  }
  Ok(out.stdout)
}

fn stash_top(root: &Path) -> Option<String> {
  run(root, &["rev-parse", "-q", "--verify", "refs/stash"]).ok().map(|o| String::from_utf8_lossy(&o).trim().to_owned())
}

/// `git stash push`, untracked files included when `include_untracked` (VS Code's Stash
/// (Include Untracked)).
pub fn stash_push(root: &Path, message: Option<&str>, include_untracked: bool) -> Result<(), String> {
  let before = stash_top(root);
  let mut args = vec!["stash", "push"];
  if include_untracked {
    args.push("--include-untracked");
  }
  let message = message.map(str::trim).filter(|m| !m.is_empty());
  if let Some(m) = message {
    args.extend(["-m", m]);
  }
  run_unliteral(root, &args).map_err(|e| format!("stash ไม่สำเร็จ\n{e}"))?;
  if stash_top(root) == before {
    return Err("ไม่มีการเปลี่ยนแปลงให้ stash".into());
  }
  Ok(())
}

pub fn parse_stash_list(text: &str) -> Vec<Stash> {
  text
    .lines()
    .filter_map(|line| {
      let mut f = line.split('\0');
      let (sel, subject, when) = (f.next()?, f.next()?, f.next().unwrap_or(""));
      let index = sel.strip_prefix("stash@{")?.strip_suffix('}')?.parse().ok()?;
      let branch = ["WIP on ", "On "]
        .iter()
        .find_map(|p| subject.strip_prefix(p))
        .and_then(|rest| rest.split_once(':'))
        .map(|(b, _)| b.to_owned());
      let message = match subject.strip_prefix("On ").and_then(|r| r.split_once(": ")) {
        Some((_, m)) => m.to_owned(),
        None => subject.to_owned(),
      };
      Some(Stash { index, message, branch, when: when.to_owned() })
    })
    .collect()
}

pub fn stash_list(root: &Path) -> Result<Vec<Stash>, String> {
  let out = run_unliteral(root, &["stash", "list", "--format=%gd%x00%gs%x00%cr"])?;
  Ok(parse_stash_list(&String::from_utf8_lossy(&out)))
}

/// `git stash apply|pop stash@{index}`. A pop that conflicts keeps the stash (git's behaviour).
pub fn stash_apply(root: &Path, index: u32, pop: bool) -> Result<(), String> {
  let sel = format!("stash@{{{index}}}");
  run_unliteral(root, &["stash", if pop { "pop" } else { "apply" }, &sel]).map(|_| ()).map_err(|e| {
    let lower = e.to_lowercase();
    if lower.contains("conflict") {
      format!("นำ stash กลับมาแล้วแต่มี conflict ให้แก้ใน Source Control{}\n{e}", if pop { " (stash ยังเก็บไว้)" } else { "" })
    } else if lower.contains("would be overwritten") || lower.contains("already exists") {
      format!("นำ stash กลับมาไม่ได้: ไฟล์ที่แก้ไขอยู่จะถูกเขียนทับ ให้ commit หรือ stash ก่อน\n{e}")
    } else {
      format!("นำ {sel} กลับมาไม่สำเร็จ\n{e}")
    }
  })
}

pub fn stash_drop(root: &Path, index: u32) -> Result<(), String> {
  run_unliteral(root, &["stash", "drop", &format!("stash@{{{index}}}")]).map(|_| ()).map_err(|e| format!("ลบ stash ไม่สำเร็จ\n{e}"))
}

// ---------------------------------------------------------------------------------------------
// Clone (Orca: repo-clone-lifecycle.ts, repo-clone-path.ts)

/// A clone may move a large repository; Cancel stops it sooner.
pub const CLONE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// A repository URL the user may clone: https, ssh or scp-like `user@host:path`, checked like the
/// snap installer's sources. Local paths and `file://` are refused for user input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloneUrl {
  url: String,
  protocols: &'static str,
}

impl CloneUrl {
  pub fn parse(input: &str) -> Result<Self, String> {
    let input = input.trim();
    let bad = || format!("URL ของ repository ไม่ถูกต้องหรือไม่รองรับ: {input:?} (ใช้ https://…, ssh://… หรือ git@host:owner/repo.git)");
    if input.contains('#') {
      return Err(bad());
    }
    let spec = crate::snap_install::parse_git_source(input).map_err(|_| bad())?;
    if spec.url.to_ascii_lowercase().starts_with("file:") || spec.url.starts_with('/') {
      return Err(bad());
    }
    Ok(Self { url: spec.url, protocols: "https:ssh" })
  }

  /// A local repository URL (`file://`), which only tests may clone.
  #[cfg(test)]
  pub fn local_for_test(url: &str) -> Self {
    Self { url: url.to_owned(), protocols: "file" }
  }

  pub fn as_str(&self) -> &str {
    &self.url
  }
}

/// The folder git would clone into: the URL's last path segment without `.git` (Orca's
/// `deriveCloneRepoNameFromUrl`), never `.`, `..` or anything but one plain name.
pub fn clone_repo_name(url: &str) -> Result<String, String> {
  let source = url.trim_end_matches('/');
  let source = source.strip_suffix(".git").unwrap_or(source);
  let name = source.rsplit(['/', ':']).next().unwrap_or_default();
  if name.is_empty() || name == "." || name == ".." || name.starts_with('-') || name.contains('\\') || name.chars().any(char::is_control) {
    return Err("ตั้งชื่อโฟลเดอร์จาก URL นี้ไม่ได้".into());
  }
  Ok(name.to_owned())
}

/// Progress git prints while cloning (`Receiving objects:  42% (…)`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct CloneProgress {
  pub phase: String,
  pub percent: u8,
}

/// Progress lines in a chunk of `git clone --progress` stderr (Orca: `^([\w\s]+):\s+(\d+)%`);
/// `carry` keeps a line cut by the chunk boundary for the next call. Lines end with `\r` while
/// git redraws them, `\n` when done.
pub fn parse_clone_progress(carry: &mut String, chunk: &str) -> Vec<CloneProgress> {
  carry.push_str(chunk);
  let mut out = Vec::new();
  while let Some(i) = carry.find(['\r', '\n']) {
    let line: String = carry.drain(..=i).collect();
    let line = line.trim_end_matches(['\r', '\n']);
    let line = line.strip_prefix("remote: ").unwrap_or(line);
    let Some((phase, rest)) = line.split_once(':') else { continue };
    if phase.is_empty() || !phase.chars().all(|c| c.is_alphanumeric() || c == ' ' || c == '_') {
      continue;
    }
    let Some((pct, _)) = rest.split_once('%') else { continue };
    if let Ok(p) = pct.trim().parse::<u8>() {
      out.push(CloneProgress { phase: phase.trim().to_owned(), percent: p.min(100) });
    }
  }
  out
}

/// Empties a folder that was empty before a failed clone into it.
fn empty_dir(dir: &Path) {
  if let Ok(entries) = std::fs::read_dir(dir) {
    for e in entries.flatten() {
      let p = e.path();
      let _ = if p.is_dir() && !p.is_symlink() { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
    }
  }
}

/// Clones `url` into `<dest>/<repo name>` without prompting (Orca's clone: `--progress`, the URL
/// after `--`); `dest` is created when missing. A folder this created is removed again when the
/// clone fails or is cancelled; an existing one must be empty. Returns the clone's path.
pub fn clone_repo(url: &CloneUrl, dest: &Path, cancel: &AtomicBool, timeout: Duration, progress: &mut dyn FnMut(CloneProgress)) -> Result<std::path::PathBuf, String> {
  if !dest.is_absolute() {
    return Err("โฟลเดอร์ปลายทางต้องเป็น path เต็ม".into());
  }
  let name = clone_repo_name(url.as_str())?;
  std::fs::create_dir_all(dest).map_err(|e| format!("สร้างโฟลเดอร์ {} ไม่ได้: {e}", dest.display()))?;
  let target = dest.join(&name);
  let created = match std::fs::create_dir(&target) {
    Ok(()) => true,
    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
      let empty = target.is_dir() && !target.is_symlink() && std::fs::read_dir(&target).is_ok_and(|mut d| d.next().is_none());
      if !empty {
        return Err(format!("มี {} อยู่แล้วและไม่ว่าง เลือกโฟลเดอร์ปลายทางอื่น", target.display()));
      }
      false
    }
    Err(e) => return Err(format!("สร้างโฟลเดอร์ {} ไม่ได้: {e}", target.display())),
  };
  let target_str = target.to_str().ok_or("path ปลายทางไม่ใช่ UTF-8")?;
  let env = [("GIT_ALLOW_PROTOCOL", url.protocols)];
  let mut carry = String::new();
  let result = run_net_streaming(dest, &["clone", "--progress", "--", url.as_str(), target_str], &env, cancel, timeout, &mut |chunk| {
    for p in parse_clone_progress(&mut carry, chunk) {
      progress(p);
    }
  });
  match net_result("clone", result, timeout) {
    Ok(_) => Ok(target),
    Err(e) => {
      if created {
        let _ = std::fs::remove_dir_all(&target);
      } else {
        empty_dir(&target);
      }
      Err(e)
    }
  }
}

/// The clone slot: one clone at a time, apart from the open folder's operations ([`GitOps`]).
#[derive(Default, Clone)]
pub struct CloneOps(pub GitOps);

/// Clones `url` into `<destination>/<repo>`; progress streams over `on_progress`. Returns the
/// path to open.
#[tauri::command]
pub async fn git_clone(ops: State<'_, CloneOps>, url: String, destination: String, on_progress: tauri::ipc::Channel<CloneProgress>) -> Result<String, String> {
  let url = CloneUrl::parse(&url)?;
  let guard = ops.0.begin().map_err(|_| "กำลัง clone อยู่แล้ว รอให้เสร็จหรือยกเลิกก่อน".to_owned())?;
  let dest = std::path::PathBuf::from(destination);
  let path = tauri::async_runtime::spawn_blocking(move || {
    clone_repo(&url, &dest, guard.flag(), CLONE_TIMEOUT, &mut |p| {
      let _ = on_progress.send(p);
    })
  })
  .await
  .map_err(|e| e.to_string())??;
  log::info!("cloned into {}", path.display());
  Ok(path.display().to_string())
}

#[tauri::command]
pub fn git_clone_cancel(ops: State<'_, CloneOps>) -> bool {
  ops.0.cancel()
}

// ---------------------------------------------------------------------------------------------
// Tauri commands. Every operation targets the open folder, or (fetch, pull, push and sync, from
// the ADE's right side bar) a task worktree `slug`, and holds the single-operation slot, so a
// checkout cannot race a pull.

async fn exclusive<T: Send + 'static>(
  ws: &Workspace,
  ops: &GitOps,
  f: impl FnOnce(&Path, &AtomicBool) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
  exclusive_in(ws, ops, None, f).await
}

async fn exclusive_in<T: Send + 'static>(
  ws: &Workspace,
  ops: &GitOps,
  slug: Option<&str>,
  f: impl FnOnce(&Path, &AtomicBool) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
  let root = ws.root()?;
  let dir = match slug {
    Some(s) => crate::agent::review::task_dir(&root, s)?,
    None => root,
  };
  let guard = ops.begin()?;
  tauri::async_runtime::spawn_blocking(move || f(&dir, guard.flag())).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_fetch(ws: State<'_, Workspace>, ops: State<'_, GitOps>, options: Option<FetchOptions>, slug: Option<String>) -> Result<(), String> {
  let opts = options.unwrap_or_default();
  exclusive_in(&ws, &ops, slug.as_deref(), move |root, c| fetch(root, &opts, c, NET_TIMEOUT)).await
}

/// `rebase` is kept for older callers; `options` carries VS Code's pull settings.
#[tauri::command]
pub async fn git_pull(ws: State<'_, Workspace>, ops: State<'_, GitOps>, rebase: Option<bool>, options: Option<PullOptions>, slug: Option<String>) -> Result<(), String> {
  let mut opts = options.unwrap_or_default();
  opts.rebase |= rebase.unwrap_or(false);
  exclusive_in(&ws, &ops, slug.as_deref(), move |root, c| pull(root, &opts, c, NET_TIMEOUT)).await
}

/// Pushes, or publishes to `remote` when the branch has no upstream. Returns the upstream.
#[tauri::command]
pub async fn git_push(ws: State<'_, Workspace>, ops: State<'_, GitOps>, remote: Option<String>, options: Option<PushOptions>, slug: Option<String>) -> Result<String, String> {
  let opts = options.unwrap_or_default();
  exclusive_in(&ws, &ops, slug.as_deref(), move |root, c| push(root, remote.as_deref(), &opts, c, NET_TIMEOUT)).await
}

#[tauri::command]
pub async fn git_sync(
  ws: State<'_, Workspace>,
  ops: State<'_, GitOps>,
  rebase: Option<bool>,
  options: Option<PullOptions>,
  push_options: Option<PushOptions>,
  slug: Option<String>,
) -> Result<(), String> {
  let mut opts = options.unwrap_or_default();
  opts.rebase |= rebase.unwrap_or(false);
  let push_opts = push_options.unwrap_or_default();
  exclusive_in(&ws, &ops, slug.as_deref(), move |root, c| sync(root, &opts, &push_opts, c, NET_TIMEOUT)).await
}

/// Cancels the running operation (the status bar's progress item).
#[tauri::command]
pub fn git_cancel(ops: State<'_, GitOps>) -> bool {
  ops.cancel()
}

#[tauri::command]
pub async fn git_refs(ws: State<'_, Workspace>, hash_length: Option<u8>, tags: Option<bool>) -> Result<Vec<BranchRef>, String> {
  let root = ws.root()?;
  tauri::async_runtime::spawn_blocking(move || refs(&root, hash_length.unwrap_or(7), tags.unwrap_or(false))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_checkout(ws: State<'_, Workspace>, ops: State<'_, GitOps>, name: String, remote: bool, options: Option<CheckoutOptions>) -> Result<String, String> {
  let opts = options.unwrap_or_default();
  exclusive(&ws, &ops, move |root, c| checkout_with(root, &name, remote, &opts, c)).await
}

#[tauri::command]
pub async fn git_create_branch(ws: State<'_, Workspace>, ops: State<'_, GitOps>, name: String, from: Option<String>) -> Result<(), String> {
  exclusive(&ws, &ops, move |root, _| create_branch(root, &name, from.as_deref())).await
}

#[tauri::command]
pub async fn git_delete_branch(ws: State<'_, Workspace>, ops: State<'_, GitOps>, name: String, force: bool) -> Result<DeleteResult, String> {
  exclusive(&ws, &ops, move |root, _| delete_branch(root, &name, force)).await
}

#[tauri::command]
pub async fn git_stash_push(
  ws: State<'_, Workspace>,
  ops: State<'_, GitOps>,
  message: Option<String>,
  include_untracked: bool,
) -> Result<(), String> {
  exclusive(&ws, &ops, move |root, _| stash_push(root, message.as_deref(), include_untracked)).await
}

#[tauri::command]
pub async fn git_stash_list(ws: State<'_, Workspace>) -> Result<Vec<Stash>, String> {
  let root = ws.root()?;
  tauri::async_runtime::spawn_blocking(move || stash_list(&root)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_stash_apply(ws: State<'_, Workspace>, ops: State<'_, GitOps>, index: u32, pop: bool) -> Result<(), String> {
  exclusive(&ws, &ops, move |root, _| stash_apply(root, index, pop)).await
}

#[tauri::command]
pub async fn git_stash_drop(ws: State<'_, Workspace>, ops: State<'_, GitOps>, index: u32) -> Result<(), String> {
  exclusive(&ws, &ops, move |root, _| stash_drop(root, index)).await
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::git::status;
  use std::path::PathBuf;

  fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
  }

  fn write(repo: &Path, rel: &str, text: &str) {
    let p = repo.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
  }

  fn commit(repo: &Path, rel: &str, text: &str) {
    write(repo, rel, text);
    git(repo, &["add", "--", rel]);
    git(repo, &["commit", "-q", "-m", rel]);
  }

  fn clone(tmp: &Path, name: &str) -> PathBuf {
    git(tmp, &["clone", "-q", "origin.git", name]);
    let repo = tmp.join(name);
    for (k, v) in [("user.name", "t"), ("user.email", "t@example.com"), ("commit.gpgsign", "false")] {
      git(&repo, &["config", k, v]);
    }
    repo
  }

  /// A bare `origin` with one commit on `main`, and two clones of it.
  fn setup() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().canonicalize().unwrap();
    git(&dir, &["init", "-q", "--bare", "-b", "main", "origin.git"]);
    let a = clone(&dir, "a");
    git(&a, &["switch", "-q", "-c", "main"]);
    commit(&a, "a.txt", "a\n");
    git(&a, &["push", "-q", "-u", "origin", "main"]);
    let b = clone(&dir, "b");
    (tmp, a, b)
  }

  fn no() -> AtomicBool {
    AtomicBool::new(false)
  }

  fn ab(repo: &Path) -> (u32, u32) {
    let st = status(repo).unwrap().unwrap();
    (st.ahead, st.behind)
  }

  const T: Duration = Duration::from_secs(60);

  #[test]
  fn counts_ahead_behind_and_fetches_and_pulls_fast_forward() {
    let (_tmp, a, b) = setup();
    let st = status(&a).unwrap().unwrap();
    assert_eq!(st.upstream.as_deref(), Some("origin/main"));
    assert_eq!(st.remotes, ["origin"]);
    assert!(!st.detached && !st.upstream_gone);

    commit(&a, "two.txt", "2\n");
    commit(&a, "three.txt", "3\n");
    assert_eq!(ab(&a), (2, 0));
    assert_eq!(push(&a, None, &PushOptions::default(), &no(), T).unwrap(), "origin/main");
    assert_eq!(ab(&a), (0, 0));

    assert_eq!(ab(&b), (0, 0), "b has not fetched yet");
    fetch(&b, &FetchOptions::default(), &no(), T).unwrap();
    assert_eq!(ab(&b), (0, 2));
    pull(&b, &PullOptions::default(), &no(), T).unwrap();
    assert_eq!(ab(&b), (0, 0));
    assert!(b.join("three.txt").exists());
  }

  #[test]
  fn ff_only_pull_refuses_divergence_and_rebase_sync_resolves_it() {
    let (_tmp, a, b) = setup();
    commit(&a, "from-a.txt", "a\n");
    push(&a, None, &PushOptions::default(), &no(), T).unwrap();
    commit(&b, "from-b.txt", "b\n");
    let err = pull(&b, &PullOptions::default(), &no(), T).unwrap_err();
    assert!(err.contains("fast-forward"), "{err}");
    sync(&b, &PullOptions { rebase: true, ..Default::default() }, &PushOptions::default(), &no(), T).unwrap();
    assert_eq!(ab(&b), (0, 0));
    fetch(&a, &FetchOptions::default(), &no(), T).unwrap();
    assert_eq!(ab(&a), (0, 1));
  }

  #[test]
  fn publishes_a_branch_and_checks_out_a_remote_branch_as_tracking() {
    let (_tmp, a, b) = setup();
    create_branch(&b, "feature/x", None).unwrap();
    commit(&b, "x.txt", "x\n");
    let st = status(&b).unwrap().unwrap();
    assert_eq!((st.branch.as_deref(), st.upstream.as_deref()), (Some("feature/x"), None));
    assert!(pull(&b, &PullOptions::default(), &no(), T).unwrap_err().contains("upstream"));
    assert!(push(&b, Some("nope"), &PushOptions::default(), &no(), T).unwrap_err().contains("nope"));
    assert_eq!(push(&b, None, &PushOptions::default(), &no(), T).unwrap(), "origin/feature/x");
    assert_eq!(status(&b).unwrap().unwrap().upstream.as_deref(), Some("origin/feature/x"));

    fetch(&a, &FetchOptions::default(), &no(), T).unwrap();
    let refs = branches(&a).unwrap();
    let remote = refs.iter().find(|r| r.name == "origin/feature/x").expect("remote branch listed");
    assert!(remote.remote && !remote.current);
    assert!(!refs.iter().any(|r| r.name.ends_with("HEAD")), "{refs:?}");
    assert_eq!(checkout(&a, "origin/feature/x", true).unwrap(), "feature/x");
    let st = status(&a).unwrap().unwrap();
    assert_eq!((st.branch.as_deref(), st.upstream.as_deref()), (Some("feature/x"), Some("origin/feature/x")));
    assert!(a.join("x.txt").exists());

    // Again from main: the existing tracking branch is reused.
    checkout(&a, "main", false).unwrap();
    assert_eq!(checkout(&a, "origin/feature/x", true).unwrap(), "feature/x");
    assert!(checkout(&a, "missing", false).unwrap_err().contains("missing"));
  }

  #[test]
  fn creates_branches_from_a_ref_and_validates_names() {
    let (_tmp, a, _b) = setup();
    commit(&a, "two.txt", "2\n");
    create_branch(&a, "from-main", Some("origin/main")).unwrap();
    assert!(!a.join("two.txt").exists(), "branched from origin/main, before two.txt");
    assert!(create_branch(&a, "from-main", None).unwrap_err().contains("อยู่แล้ว"));
    for bad in ["", "-x", "--force", "a..b", "HEAD", "@{-1}", "a b", "x.lock", "a~1", "a:b", "/x", "bad\n"] {
      assert!(create_branch(&a, bad, None).is_err(), "{bad:?}");
      assert!(check_branch_name(&a, bad).is_err(), "{bad:?}");
    }
    assert!(create_branch(&a, "ok", Some("-p")).is_err());
    assert!(checkout(&a, "-f", false).is_err());
    check_branch_name(&a, "kingu/task-1").unwrap();
  }

  #[test]
  fn checkout_is_refused_when_local_changes_would_be_overwritten() {
    let (_tmp, a, _b) = setup();
    create_branch(&a, "other", None).unwrap();
    commit(&a, "a.txt", "other\n");
    checkout(&a, "main", false).unwrap();
    write(&a, "a.txt", "dirty\n");
    let err = checkout(&a, "other", false).unwrap_err();
    assert!(err.contains("commit หรือ stash"), "{err}");
    assert_eq!(std::fs::read_to_string(a.join("a.txt")).unwrap(), "dirty\n");
  }

  #[test]
  fn stashes_with_untracked_files_lists_and_pops() {
    let (_tmp, a, _b) = setup();
    write(&a, "a.txt", "changed\n");
    write(&a, "new.txt", "untracked\n");
    stash_push(&a, Some("  my work "), true).unwrap();
    let st = status(&a).unwrap().unwrap();
    assert!(st.entries.is_empty(), "{:?}", st.entries);
    assert!(!a.join("new.txt").exists());
    let list = stash_list(&a).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!((list[0].index, list[0].message.as_str(), list[0].branch.as_deref()), (0, "my work", Some("main")));
    assert!(stash_push(&a, None, true).unwrap_err().contains("ไม่มีการเปลี่ยนแปลง"));

    stash_apply(&a, 0, true).unwrap();
    assert_eq!(std::fs::read_to_string(a.join("new.txt")).unwrap(), "untracked\n");
    assert_eq!(std::fs::read_to_string(a.join("a.txt")).unwrap(), "changed\n");
    assert!(stash_list(&a).unwrap().is_empty());

    // Apply keeps the entry; drop removes it. Without untracked the new file stays.
    stash_push(&a, None, false).unwrap();
    assert!(a.join("new.txt").exists());
    stash_apply(&a, 0, false).unwrap();
    assert_eq!(stash_list(&a).unwrap().len(), 1);
    stash_drop(&a, 0).unwrap();
    assert!(stash_list(&a).unwrap().is_empty());
    assert!(stash_drop(&a, 0).is_err());
  }

  #[test]
  fn deletes_merged_branches_and_reports_unmerged_ones() {
    let (_tmp, a, _b) = setup();
    git(&a, &["branch", "merged"]);
    assert_eq!(delete_branch(&a, "merged", false).unwrap(), DeleteResult::Deleted);
    create_branch(&a, "unmerged", None).unwrap();
    commit(&a, "u.txt", "u\n");
    assert!(delete_branch(&a, "unmerged", false).unwrap_err().contains("ปัจจุบัน"));
    checkout(&a, "main", false).unwrap();
    assert_eq!(delete_branch(&a, "unmerged", false).unwrap(), DeleteResult::NotMerged);
    assert!(branches(&a).unwrap().iter().any(|r| r.name == "unmerged"));
    assert_eq!(delete_branch(&a, "unmerged", true).unwrap(), DeleteResult::Deleted);
    assert!(delete_branch(&a, "unmerged", false).is_err());
    assert!(delete_branch(&a, "-D", false).is_err());
  }

  #[test]
  fn branches_used_by_a_task_worktree_are_marked_and_refused() {
    let (_tmp, a, _b) = setup();
    git(&a, &["worktree", "add", "-q", "-b", "kingu/t1", ".kingu/worktrees/t1"]);
    let refs = branches(&a).unwrap();
    let t1 = refs.iter().find(|r| r.name == "kingu/t1").unwrap();
    assert!(t1.worktree.as_deref().is_some_and(|p| p.ends_with(".kingu/worktrees/t1")), "{t1:?}");
    let main = refs.iter().find(|r| r.name == "main").unwrap();
    assert!(main.current && main.worktree.is_none(), "{main:?}");

    let err = checkout(&a, "kingu/t1", false).unwrap_err();
    assert!(err.contains("worktree อื่น") && err.contains(".kingu/worktrees/t1"), "{err}");
    let err = delete_branch(&a, "kingu/t1", true).unwrap_err();
    assert!(err.contains("worktree อื่น"), "{err}");
  }

  #[test]
  fn net_args_follow_the_settings() {
    assert_eq!(fetch_args(&FetchOptions::default()), ["fetch"]);
    assert_eq!(fetch_args(&FetchOptions { all: true, prune: true }), ["fetch", "--all", "--prune"]);
    assert_eq!(pull_args(&PullOptions::default()), ["pull", "--no-rebase", "--ff-only"]);
    let all = PullOptions { rebase: true, tags: true, auto_stash: true, fetch_all: true, replace_tags: true };
    assert_eq!(pull_args(&all), ["pull", "--tags", "--autostash", "--rebase"]);
    assert_eq!(push_flags(&PushOptions::default()), ["push"]);
    assert_eq!(push_flags(&PushOptions { force: Some(ForcePush::Force), follow_tags: true }), ["push", "--force", "--follow-tags"]);
    assert_eq!(push_flags(&PushOptions { force: Some(ForcePush::WithLease), follow_tags: false }), ["push", "--force-with-lease"]);
    assert_eq!(push_flags(&PushOptions { force: Some(ForcePush::WithLeaseIfIncludes), follow_tags: false }), ["push", "--force-with-lease", "--force-if-includes"]);
  }

  #[test]
  fn pulls_with_autostash_and_force_pushes_with_lease() {
    let (_tmp, a, b) = setup();
    commit(&a, "two.txt", "2\n");
    push(&a, None, &PushOptions::default(), &no(), T).unwrap();
    write(&b, "a.txt", "local edit\n");
    // a.txt is not touched upstream, but a dirty tree is stashed and restored around the pull.
    pull(&b, &PullOptions { rebase: true, auto_stash: true, ..Default::default() }, &no(), T).unwrap();
    assert!(b.join("two.txt").exists());
    assert_eq!(std::fs::read_to_string(b.join("a.txt")).unwrap(), "local edit\n");

    // b rewrites history: a plain push is rejected, a lease push wins.
    git(&b, &["reset", "-q", "--hard", "HEAD~1"]);
    commit(&b, "rewritten.txt", "r\n");
    assert!(push(&b, None, &PushOptions::default(), &no(), T).is_err());
    push(&b, None, &PushOptions { force: Some(ForcePush::WithLease), follow_tags: false }, &no(), T).unwrap();
    fetch(&a, &FetchOptions { all: true, prune: true }, &no(), T).unwrap();
    assert_eq!(ab(&a), (1, 1));
  }

  #[test]
  fn sync_follows_tags_and_pull_replaces_conflicting_tags() {
    let (_tmp, a, b) = setup();
    commit(&a, "two.txt", "2\n");
    git(&a, &["tag", "-a", "v1", "-m", "v1"]);
    sync(&a, &PullOptions::default(), &PushOptions { force: None, follow_tags: true }, &no(), T).unwrap();
    // b has its own v1 on another commit: pulling tags conflicts until replace_tags.
    git(&b, &["tag", "v1"]);
    let tags = PullOptions { tags: true, ..Default::default() };
    let err = pull(&b, &tags, &no(), T).unwrap_err();
    assert!(err.contains("git.replaceTagsWhenPull"), "{err}");
    pull(&b, &PullOptions { replace_tags: true, ..tags }, &no(), T).unwrap();
    let v1 = git(&b, &["rev-parse", "v1^{commit}"]);
    assert_eq!(v1, git(&b, &["rev-parse", "HEAD"]));
  }

  #[test]
  fn lists_tags_with_dates_and_hash_length_and_checks_them_out_detached() {
    let (_tmp, a, _b) = setup();
    git(&a, &["tag", "-a", "v1", "-m", "release"]);
    let list = refs(&a, 10, true).unwrap();
    let v1 = list.iter().find(|r| r.name == "v1").expect("tag listed");
    assert!(v1.tag && !v1.remote && v1.date > 0);
    assert_eq!(v1.commit.len(), 10);
    assert_eq!(v1.commit, git(&a, &["rev-parse", "--short=10", "HEAD"]).trim());
    assert!(!refs(&a, 7, false).unwrap().iter().any(|r| r.tag));
    commit(&a, "two.txt", "2\n");
    let opts = CheckoutOptions { tag: true, pull_before: false };
    assert_eq!(checkout_with(&a, "v1", false, &opts, &no()).unwrap(), "v1");
    assert!(status(&a).unwrap().unwrap().detached);
    assert!(!a.join("two.txt").exists());
  }

  #[test]
  fn pull_before_checkout_fast_forwards_the_branch() {
    let (_tmp, a, b) = setup();
    git(&b, &["switch", "-q", "-c", "side"]);
    commit(&a, "two.txt", "2\n");
    push(&a, None, &PushOptions::default(), &no(), T).unwrap();
    fetch(&b, &FetchOptions::default(), &no(), T).unwrap();
    let before = git(&b, &["rev-parse", "main"]);
    checkout_with(&b, "main", false, &CheckoutOptions { tag: false, pull_before: true }, &no()).unwrap();
    assert_ne!(git(&b, &["rev-parse", "main"]), before);
    assert!(b.join("two.txt").exists());
  }

  #[test]
  fn detects_auth_failures() {
    for s in [
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      "git@github.com: Permission denied (publickey).\r\nfatal: Could not read from remote repository.",
      "remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://gitlab.com/x.git/'",
      "fatal: unable to access 'https://x/': The requested URL returned error: 403",
      "Host key verification failed.",
      "remote: Invalid username or password.",
    ] {
      assert!(is_auth_failure(s), "{s}");
      assert!(net_error("push", s).starts_with(AUTH_FAILED), "{s}");
    }
    for s in ["fatal: 'origin' does not appear to be a git repository", "! [rejected] main -> main (fetch first)", ""] {
      assert!(!is_auth_failure(s), "{s}");
    }
    assert!(net_error("push", "! [rejected] main -> main (fetch first)").contains("pull ก่อน"));
  }

  #[test]
  fn ssh_command_keeps_the_users_own() {
    assert_eq!(ssh_command(None, None, None), "ssh -o BatchMode=yes");
    assert_eq!(ssh_command(Some("ssh -i ~/.ssh/k"), Some("other"), None), "ssh -i ~/.ssh/k -o BatchMode=yes");
    assert_eq!(ssh_command(Some(" "), Some("ssh -F cfg"), None), "ssh -F cfg -o BatchMode=yes");
    assert_eq!(ssh_command(None, None, Some("/opt/my ssh")), "'/opt/my ssh' -o BatchMode=yes");
  }

  #[test]
  fn one_operation_at_a_time() {
    let ops = GitOps::default();
    assert!(!ops.cancel());
    let g = ops.begin().unwrap();
    assert!(ops.begin().is_err());
    assert!(ops.cancel());
    assert!(g.flag().load(Ordering::SeqCst));
    drop(g);
    let g = ops.begin().unwrap();
    assert!(!g.flag().load(Ordering::SeqCst));
  }

  #[test]
  fn parses_stash_list() {
    let list = parse_stash_list("stash@{0}\0On main: fix: a\0a minute ago\nstash@{12}\0WIP on kingu/t1: abc123 subject\0two days ago\nbogus\n");
    assert_eq!(list.len(), 2);
    assert_eq!((list[0].message.as_str(), list[0].branch.as_deref()), ("fix: a", Some("main")));
    assert_eq!((list[1].index, list[1].branch.as_deref()), (12, Some("kingu/t1")));
    assert_eq!(list[1].message, "WIP on kingu/t1: abc123 subject");
  }

  /// A fake ssh (`core.sshCommand`) that records its arguments, then runs `body`.
  #[cfg(unix)]
  fn fake_ssh(dir: &Path, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let script = dir.join("fake-ssh");
    std::fs::write(&script, format!("#!/bin/sh\necho \"$@\" > \"{}\"\n{body}\n", dir.join("ssh-args").display())).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    script
  }

  #[cfg(unix)]
  #[test]
  fn network_git_runs_in_batch_mode_and_reports_auth_failure() {
    if std::env::var_os("GIT_SSH_COMMAND").is_some() {
      return; // The user's own override wins over core.sshCommand by design.
    }
    let (tmp, a, _b) = setup();
    let dir = tmp.path().canonicalize().unwrap();
    let ssh = fake_ssh(&dir, "echo 'git@example.invalid: Permission denied (publickey).' >&2\nexit 255");
    git(&a, &["config", "core.sshCommand", ssh.to_str().unwrap()]);
    git(&a, &["remote", "add", "ssh", "ssh://git@example.invalid/x.git"]);
    let err = net(&a, &["fetch", "ssh"], &no(), T).unwrap_err();
    assert!(err.starts_with(AUTH_FAILED), "{err}");
    let args = std::fs::read_to_string(dir.join("ssh-args")).unwrap();
    assert!(args.contains("BatchMode=yes"), "{args}");
  }

  #[cfg(unix)]
  #[test]
  fn network_git_times_out_and_cancels() {
    if std::env::var_os("GIT_SSH_COMMAND").is_some() {
      return;
    }
    let (tmp, a, _b) = setup();
    let dir = tmp.path().canonicalize().unwrap();
    let ssh = fake_ssh(&dir, "sleep 30");
    git(&a, &["config", "core.sshCommand", ssh.to_str().unwrap()]);
    git(&a, &["remote", "add", "ssh", "ssh://git@example.invalid/x.git"]);

    let started = Instant::now();
    let err = net(&a, &["fetch", "ssh"], &no(), Duration::from_millis(500)).unwrap_err();
    assert!(err.contains("เกิน"), "{err}");
    assert!(started.elapsed() < Duration::from_secs(10), "the sleeping ssh was killed too");

    let cancel = Arc::new(AtomicBool::new(false));
    let c = cancel.clone();
    let t = std::thread::spawn(move || {
      std::thread::sleep(Duration::from_millis(300));
      c.store(true, Ordering::SeqCst);
    });
    let started = Instant::now();
    let err = net(&a, &["fetch", "ssh"], &cancel, T).unwrap_err();
    t.join().unwrap();
    assert!(err.contains("ยกเลิก"), "{err}");
    assert!(started.elapsed() < Duration::from_secs(10));
  }
  #[test]
  fn clone_urls_accept_https_and_ssh_only() {
    for ok in ["https://github.com/acme/app.git", "ssh://git@github.com/acme/app", "git@github.com:acme/app.git", "  https://gitlab.com/g/sub/app  "] {
      assert!(CloneUrl::parse(ok).is_ok(), "{ok}");
    }
    for bad in [
      "file:///tmp/repo",
      "FILE:///tmp/repo",
      "/tmp/repo",
      "http://github.com/a/b",
      "git://github.com/a/b",
      "ext::sh -c touch% /tmp/pwned",
      "-uhttps://x/y",
      "https://github.com/a/b#main",
      "https://-oProxy/x",
      "",
      "../repo",
    ] {
      assert!(CloneUrl::parse(bad).is_err(), "{bad}");
    }
  }

  #[test]
  fn clone_folder_name_comes_from_the_url() {
    assert_eq!(clone_repo_name("https://github.com/acme/app.git").unwrap(), "app");
    assert_eq!(clone_repo_name("git@github.com:acme/my-lib").unwrap(), "my-lib");
    assert_eq!(clone_repo_name("git@host:repo.git").unwrap(), "repo");
    assert_eq!(clone_repo_name("https://h/x/tool/").unwrap(), "tool");
    assert!(clone_repo_name("https://h/..").is_err());
    assert!(clone_repo_name("https://h/.git").is_err());
  }

  #[test]
  fn parses_clone_progress_across_chunks() {
    let mut carry = String::new();
    let mut all = parse_clone_progress(&mut carry, "Cloning into 'app'...\nremote: Counting objects:  50% (1/2)\rremote: Counting objects: 100% (2/2), done.\nReceiving obj");
    all.extend(parse_clone_progress(&mut carry, "ects:  42% (5/12)\rResolving deltas: 100% (3/3), done.\nwarning: x/y: odd 10% thing\n"));
    let got: Vec<(&str, u8)> = all.iter().map(|p| (p.phase.as_str(), p.percent)).collect();
    assert_eq!(got, [("Counting objects", 50), ("Counting objects", 100), ("Receiving objects", 42), ("Resolving deltas", 100)]);
  }

  #[test]
  fn clones_a_local_bare_repository_and_cleans_up_failures() {
    let (tmp, _a, _b) = setup();
    let tmp = tmp.path().canonicalize().unwrap();
    std::fs::rename(tmp.join("origin.git"), tmp.join("app.git")).unwrap();
    let url = CloneUrl::local_for_test(&format!("file://{}/app.git", tmp.display()));
    assert!(CloneUrl::parse(url.as_str()).is_err(), "user input may not clone file://");

    let dest = tmp.join("projects/nested");
    let mut seen = Vec::new();
    let path = clone_repo(&url, &dest, &no(), T, &mut |p| seen.push(p)).unwrap();
    assert_eq!(path, dest.join("app"));
    assert_eq!(std::fs::read_to_string(path.join("a.txt")).unwrap(), "a\n");
    assert!(seen.iter().all(|p| p.percent <= 100));

    let err = clone_repo(&url, &dest, &no(), T, &mut |_| {}).unwrap_err();
    assert!(err.contains("ไม่ว่าง"), "{err}");

    let missing = CloneUrl::local_for_test(&format!("file://{}/missing.git", tmp.display()));
    assert!(clone_repo(&missing, &dest, &no(), T, &mut |_| {}).is_err());
    assert!(!dest.join("missing").exists(), "a failed clone leaves no folder behind");

    std::fs::create_dir(dest.join("empty")).unwrap();
    let to_empty = CloneUrl::local_for_test(&format!("file://{}/empty.git", tmp.display()));
    assert!(clone_repo(&to_empty, &dest, &no(), T, &mut |_| {}).is_err());
    assert!(dest.join("empty").is_dir(), "an existing empty folder is kept");

    // Only the allowed protocols run, whatever the URL says.
    let http = CloneUrl { url: "https://example.invalid/x.git".into(), protocols: "file" };
    assert!(clone_repo(&http, &dest, &no(), T, &mut |_| {}).is_err());
    assert!(!dest.join("x").exists());
    assert!(clone_repo(&url, Path::new("relative"), &no(), T, &mut |_| {}).is_err());
  }

  #[test]
  fn cancelling_a_clone_removes_its_folder() {
    let (tmp, _a, _b) = setup();
    let tmp = tmp.path().canonicalize().unwrap();
    let url = CloneUrl::local_for_test(&format!("file://{}/origin.git", tmp.display()));
    let dest = tmp.join("out");
    let err = clone_repo(&url, &dest, &AtomicBool::new(true), T, &mut |_| {}).unwrap_err();
    assert!(err.contains("ยกเลิก"), "{err}");
    assert!(!dest.join("origin").exists());
  }

}
