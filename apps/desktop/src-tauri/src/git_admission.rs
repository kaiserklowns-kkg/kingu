//! Admission control for every git child process Kingu starts (Orca's `GitAdmissionScheduler`,
//! `src/shared/git/admission/*`). `git_queue` keeps two *writes* to one repository from colliding;
//! this module keeps *all* git (reads, status polls, fetches) from swamping the machine when many
//! worktrees refresh at once.
//!
//! - **Classes.** `network` (fetch, pull, push, clone, ls-remote, `submodule update`,
//!   `remote update`) and `general` (everything else) have separate budgets, so a slow fetch never
//!   holds up a status read and fifty status reads never hold up a push.
//! - **Budgets.** Orca's numbers: general `max(2, min(4, cpus - 4))` base slots + 2 headroom,
//!   network 3 + 1, and per remote route (a WSL distro or UNC server) 2 + 1. Headroom slots are
//!   only for `Interactive` work, so a click is never stuck behind a full queue of polls.
//! - **Tiers.** `Interactive` (the user waits: a click, a commit), `Status` (Orca's default: a
//!   status read for something on screen), `Background` (auto-fetch, update checks). The queue
//!   grants the lowest effective tier first, then the oldest; a waiter is promoted one tier per
//!   [`AGING`] so background work cannot starve.
//! - **Abort and timeout.** A waiter gives up when its cancel flag is set (Source Control's
//!   Cancel) or after its wait limit; git reads run with Orca's [`READ_TIMEOUT`] (see `git::run`).
//!
//! The tier comes from the thread (Orca uses `AsyncLocalStorage`): [`scoped`] sets it for a
//! block; `git_queue` raises an unset tier to `Interactive` while a write holds its lanes. A
//! thread that already holds a grant is not queued again (no self-deadlock on nested calls).
//! `KINGU_GIT_ADMISSION_DISABLED=1` turns admission off (Orca: `ORCA_GIT_ADMISSION_DISABLED`).

use std::cell::Cell;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Orca `GIT_ADMISSION_AGING_MS`: a queued waiter moves up one tier per this much waiting.
pub const AGING: Duration = Duration::from_secs(15);
/// Orca `GIT_READ_TIMEOUT_MS`: a read-only git command is killed after this long.
pub const READ_TIMEOUT: Duration = Duration::from_secs(120);
/// How long a git command waits for a slot before it fails. Orca has no such limit (it relies on
/// abort signals); **estimated** for Kingu as `git_queue::WAIT_TIMEOUT`, longer than any network
/// operation may run, so a waiter only gives up when something is truly stuck.
pub const WAIT_LIMIT: Duration = crate::git_queue::WAIT_TIMEOUT;
/// How often a waiter looks at its cancel flag (**estimated**).
const CANCEL_POLL: Duration = Duration::from_millis(50);

/// Who waits for the result (Orca's `GitAdmissionTier`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Tier {
  Interactive = 0,
  Status = 1,
  Background = 2,
}

impl Tier {
  /// A webview command's `background` flag: `Background`, else Orca's default `Status`.
  pub fn from_background(background: Option<bool>) -> Tier {
    if background == Some(true) { Tier::Background } else { Tier::Status }
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Class {
  General,
  Network,
}

impl Class {
  fn key(self) -> &'static str {
    match self {
      Class::General => "general",
      Class::Network => "network",
    }
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Slot {
  Base,
  Headroom,
}

/// Capacities (Orca's `AdmissionSchedulerConfig`).
#[derive(Clone, Copy, Debug)]
pub struct Config {
  pub general_cap: usize,
  pub network_cap: usize,
  pub general_headroom: usize,
  pub network_headroom: usize,
  pub route_cap: usize,
  pub route_headroom: usize,
  pub aging: Duration,
}

impl Default for Config {
  fn default() -> Self {
    let cpus = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    Self {
      // Orca GENERAL_CAP = max(2, min(4, availableParallelism - 4)).
      general_cap: 4.min(cpus.saturating_sub(4)).max(2),
      network_cap: 3,
      general_headroom: 2,
      network_headroom: 1,
      route_cap: 2,
      route_headroom: 1,
      aging: AGING,
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Classification (Orca `src/shared/git/commands/git-command-classification.ts`)

/// Global options that take a value and come before the subcommand.
const GLOBAL_WITH_VALUE: &[&str] = &["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"];

fn subcommand_index(args: &[&str]) -> Option<usize> {
  let mut i = 0;
  while i < args.len() {
    let a = args[i];
    if GLOBAL_WITH_VALUE.contains(&a) {
      i += 2;
      continue;
    }
    if a.starts_with('-') {
      i += 1;
      continue;
    }
    return Some(i);
  }
  None
}

/// Network only when the command's main phase is a remote transfer.
pub fn classify(args: &[&str]) -> Class {
  let Some(i) = subcommand_index(args) else { return Class::General };
  let sub = args[i];
  if matches!(sub, "fetch" | "pull" | "push" | "clone" | "ls-remote") {
    return Class::Network;
  }
  let action = args[i + 1..].iter().find(|a| !a.starts_with('-')).copied();
  if matches!((sub, action), ("submodule", Some("update")) | ("remote", Some("update"))) {
    return Class::Network;
  }
  Class::General
}

/// A read-only command (Orca's `isWslDirectGitReadCommand`, the subset Kingu runs): these get
/// [`READ_TIMEOUT`].
pub fn is_read(args: &[&str]) -> bool {
  const ALWAYS: &[&str] = &[
    "blame", "cat-file", "check-attr", "check-ref-format", "check-ignore", "describe", "diff", "diff-tree", "for-each-ref", "log", "ls-files", "ls-tree", "merge-base", "name-rev", "rev-list", "rev-parse", "show", "show-ref", "status", "var",
  ];
  let Some(i) = subcommand_index(args) else { return false };
  let sub = args[i];
  let rest = &args[i + 1..];
  if ALWAYS.contains(&sub) {
    return true;
  }
  let action = rest.iter().find(|a| !a.starts_with('-')).copied();
  match sub {
    "config" => rest.iter().any(|a| matches!(a.split('=').next().unwrap_or(""), "--get" | "--get-all" | "--get-regexp" | "--get-urlmatch" | "--list" | "-l")),
    "remote" => matches!(action, None | Some("get-url")) || (action == Some("show") && rest.contains(&"-n")),
    "worktree" => action == Some("list"),
    "stash" => action == Some("list"),
    _ => false,
  }
}

/// Orca `uncRouteKey`: commands on a WSL distro or a UNC server share that route's budget.
pub fn route_key(cwd: &Path) -> Option<String> {
  let s = cwd.to_string_lossy();
  let rest = s.strip_prefix("\\\\").or_else(|| s.strip_prefix("//"))?;
  let mut parts = rest.split(['\\', '/']);
  let server = parts.next()?.to_lowercase();
  if server.is_empty() {
    return None;
  }
  if server == "wsl$" || server == "wsl.localhost" {
    let distro = parts.next().map(|d| d.trim().to_lowercase()).filter(|d| !d.is_empty())?;
    return Some(format!("wsl:{distro}"));
  }
  Some(format!("unc:{server}"))
}

// ---------------------------------------------------------------------------------------------
// Thread tier

thread_local! {
  static TIER: Cell<Option<Tier>> = const { Cell::new(None) };
  /// Grants this thread holds: a nested acquire passes straight through.
  static HOLDING: Cell<u32> = const { Cell::new(0) };
}

/// The tier git started on this thread runs at (`Status` when none was set, as in Orca).
pub fn current_tier() -> Tier {
  TIER.with(Cell::get).unwrap_or(Tier::Status)
}

/// Restores the previous tier when dropped.
pub struct TierGuard(Option<Tier>);

impl Drop for TierGuard {
  fn drop(&mut self) {
    TIER.with(|t| t.set(self.0));
  }
}

/// Runs git started on this thread at `tier` until the guard drops.
pub fn scoped(tier: Tier) -> TierGuard {
  TierGuard(TIER.with(|t| t.replace(Some(tier))))
}

/// [`scoped`] only when no tier was set (a write the user waits for, unless it was explicitly
/// marked background).
pub fn scoped_default(tier: Tier) -> TierGuard {
  let old = TIER.with(Cell::get);
  if old.is_none() {
    TIER.with(|t| t.set(Some(tier)));
  }
  TierGuard(old)
}

/// `f` with git at `tier`.
pub fn with_tier<T>(tier: Tier, f: impl FnOnce() -> T) -> T {
  let _g = scoped(tier);
  f()
}

// ---------------------------------------------------------------------------------------------
// Scheduler

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Budget {
  pub base_capacity: usize,
  pub headroom_capacity: usize,
  pub base_used: usize,
  pub headroom_used: usize,
}

struct Waiter {
  id: u64,
  tier: Tier,
  class: Class,
  enqueued: Instant,
  keys: Vec<String>,
  granted: Option<Slot>,
  label: String,
}

#[derive(Default)]
struct State {
  budgets: HashMap<String, Budget>,
  /// Queued and granted-but-not-yet-picked-up waiters.
  waiters: Vec<Waiter>,
  next_id: u64,
}

pub struct Scheduler {
  cfg: Config,
  state: Mutex<State>,
  changed: Condvar,
}

/// Why a command did not get a slot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refused {
  Cancelled,
  TimedOut { waited: Duration },
}

/// What the queue holds right now (logs and tests).
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
  pub queued: usize,
  pub queued_tiers: Vec<Tier>,
  pub budgets: std::collections::BTreeMap<String, Budget>,
}

/// One admitted git command; dropping it frees the slot and lets the next waiter in.
pub struct Grant {
  inner: Option<(&'static Scheduler, Vec<String>, Slot, Class)>,
  /// How long it queued (Orca's `queueWaitMs`; long waits are logged by `acquire`).
  #[allow(dead_code)]
  pub queue_wait: Duration,
}

impl Drop for Grant {
  fn drop(&mut self) {
    HOLDING.with(|h| h.set(h.get().saturating_sub(1)));
    if let Some((s, keys, slot, class)) = self.inner.take() {
      s.release(&keys, slot, class);
    }
  }
}

impl Scheduler {
  pub fn new(cfg: Config) -> Self {
    Self { cfg, state: Mutex::default(), changed: Condvar::new() }
  }

  fn lock(&self) -> std::sync::MutexGuard<'_, State> {
    self.state.lock().unwrap_or_else(|e| e.into_inner())
  }

  fn budget<'a>(cfg: &Config, budgets: &'a mut HashMap<String, Budget>, key: &str) -> &'a mut Budget {
    budgets.entry(key.to_owned()).or_insert_with(|| {
      let (base, headroom) = if key.starts_with("route:") {
        (cfg.route_cap, cfg.route_headroom)
      } else if key == "network" {
        (cfg.network_cap, cfg.network_headroom)
      } else {
        (cfg.general_cap, cfg.general_headroom)
      };
      Budget { base_capacity: base, headroom_capacity: headroom, ..Budget::default() }
    })
  }

  fn fits(cfg: &Config, budgets: &mut HashMap<String, Budget>, keys: &[String], slot: Slot) -> bool {
    keys.iter().all(|k| {
      let b = Self::budget(cfg, budgets, k);
      match slot {
        Slot::Base => b.base_used < b.base_capacity,
        Slot::Headroom => b.headroom_used < b.headroom_capacity,
      }
    })
  }

  fn effective_tier(&self, w: &Waiter, now: Instant) -> u64 {
    let promotions = (now.saturating_duration_since(w.enqueued).as_millis() / self.cfg.aging.as_millis().max(1)) as u64;
    (w.tier as u64).saturating_sub(promotions)
  }

  /// Grants every queued waiter of `class` that fits, best first (lowest effective tier, then oldest).
  fn drain(&self, st: &mut State, class: Class) -> bool {
    let now = Instant::now();
    let mut any = false;
    loop {
      let State { budgets, waiters, .. } = st;
      let mut best: Option<(usize, Slot, (u64, Instant, u64))> = None;
      for (i, w) in waiters.iter().enumerate() {
        if w.granted.is_some() || w.class != class {
          continue;
        }
        let slot = if Self::fits(&self.cfg, budgets, &w.keys, Slot::Base) {
          Slot::Base
        } else if w.tier == Tier::Interactive && Self::fits(&self.cfg, budgets, &w.keys, Slot::Headroom) {
          Slot::Headroom
        } else {
          continue;
        };
        let rank = (self.effective_tier(w, now), w.enqueued, w.id);
        if best.as_ref().is_none_or(|(_, _, r)| rank < *r) {
          best = Some((i, slot, rank));
        }
      }
      let Some((i, slot, _)) = best else { break };
      let keys = waiters[i].keys.clone();
      for k in &keys {
        let b = Self::budget(&self.cfg, budgets, k);
        match slot {
          Slot::Base => b.base_used += 1,
          Slot::Headroom => b.headroom_used += 1,
        }
      }
      waiters[i].granted = Some(slot);
      any = true;
    }
    any
  }

  fn prune(st: &mut State, keys: &[String]) {
    for k in keys.iter().filter(|k| k.starts_with("route:")) {
      let idle = st.budgets.get(k).is_some_and(|b| b.base_used == 0 && b.headroom_used == 0);
      if idle && !st.waiters.iter().any(|w| w.keys.contains(k)) {
        st.budgets.remove(k);
      }
    }
  }

  fn release(&'static self, keys: &[String], slot: Slot, class: Class) {
    let mut st = self.lock();
    for k in keys {
      if let Some(b) = st.budgets.get_mut(k) {
        match slot {
          Slot::Base => b.base_used = b.base_used.saturating_sub(1),
          Slot::Headroom => b.headroom_used = b.headroom_used.saturating_sub(1),
        }
      }
    }
    Self::prune(&mut st, keys);
    self.drain(&mut st, class);
    drop(st);
    self.changed.notify_all();
  }

  /// Waits for a slot for `args` run in `cwd` at `tier`; gives up when `cancel` is set or after `limit`.
  pub fn acquire(&'static self, args: &[&str], cwd: &Path, tier: Tier, cancel: Option<&AtomicBool>, limit: Duration) -> Result<Grant, Refused> {
    let passthrough = || {
      HOLDING.with(|h| h.set(h.get() + 1));
      Ok(Grant { inner: None, queue_wait: Duration::ZERO })
    };
    if HOLDING.with(Cell::get) > 0 {
      return passthrough();
    }
    if cancel.is_some_and(|c| c.load(Ordering::SeqCst)) {
      return Err(Refused::Cancelled);
    }
    let class = classify(args);
    let mut keys = vec![class.key().to_owned()];
    if let Some(route) = route_key(cwd) {
      keys.push(format!("route:{}:{route}", class.key()));
    }
    let enqueued = Instant::now();
    let deadline = enqueued + limit;
    let mut st = self.lock();
    let id = st.next_id;
    st.next_id += 1;
    let label = args.get(subcommand_index(args).unwrap_or(0)).copied().unwrap_or("").to_owned();
    st.waiters.push(Waiter { id, tier, class, enqueued, keys: keys.clone(), granted: None, label });
    if self.drain(&mut st, class) {
      self.changed.notify_all();
    }
    loop {
      let pos = st.waiters.iter().position(|w| w.id == id).expect("a waiter leaves the queue only through its own thread");
      if let Some(slot) = st.waiters[pos].granted {
        let w = st.waiters.remove(pos);
        let queue_wait = enqueued.elapsed();
        if queue_wait >= Duration::from_secs(1) {
          log::info!("git admission: {} ({:?}, {:?}) waited {} ms", w.label, w.tier, w.class, queue_wait.as_millis());
        }
        HOLDING.with(|h| h.set(h.get() + 1));
        return Ok(Grant { inner: Some((self, keys, slot, class)), queue_wait });
      }
      let now = Instant::now();
      let cancelled = cancel.is_some_and(|c| c.load(Ordering::SeqCst));
      if cancelled || now >= deadline {
        st.waiters.remove(pos);
        Self::prune(&mut st, &keys);
        return Err(if cancelled { Refused::Cancelled } else { Refused::TimedOut { waited: now - enqueued } });
      }
      let wait = (deadline - now).min(CANCEL_POLL);
      st = self.changed.wait_timeout(st, wait).unwrap_or_else(|e| e.into_inner()).0;
      // Aging can make a different waiter the best one without any release.
      if self.drain(&mut st, class) {
        self.changed.notify_all();
      }
    }
  }

  pub fn snapshot(&self) -> Snapshot {
    let st = self.lock();
    let queued: Vec<&Waiter> = st.waiters.iter().filter(|w| w.granted.is_none()).collect();
    Snapshot { queued: queued.len(), queued_tiers: queued.iter().map(|w| w.tier).collect(), budgets: st.budgets.iter().map(|(k, v)| (k.clone(), *v)).collect() }
  }
}

fn disabled() -> bool {
  static OFF: OnceLock<bool> = OnceLock::new();
  *OFF.get_or_init(|| std::env::var("KINGU_GIT_ADMISSION_DISABLED").is_ok_and(|v| v == "1"))
}

/// The app's scheduler.
pub fn scheduler() -> &'static Scheduler {
  static S: OnceLock<Scheduler> = OnceLock::new();
  S.get_or_init(|| Scheduler::new(Config::default()))
}

/// Admits one git command at this thread's tier (see the module docs). The error is the message
/// to show (in the UI language).
pub fn admit(args: &[&str], cwd: &Path, cancel: Option<&AtomicBool>) -> Result<Grant, String> {
  if disabled() {
    // Dropping a grant always counts one down.
    HOLDING.with(|h| h.set(h.get() + 1));
    return Ok(Grant { inner: None, queue_wait: Duration::ZERO });
  }
  let op = args.get(subcommand_index(args).unwrap_or(0)).copied().unwrap_or("git");
  scheduler().acquire(args, cwd, current_tier(), cancel, WAIT_LIMIT).map_err(|r| match r {
    Refused::Cancelled => crate::tr!(crate::i18n::msg::GitMsg::Cancelled, op),
    Refused::TimedOut { waited } => {
      log::warn!("git admission: {op} gave up after {}s; {:?}", waited.as_secs(), scheduler().snapshot());
      crate::tr!(crate::i18n::msg::GitMsg::AdmissionTimeout, op, secs = waited.as_secs())
    }
  })
}

/// `cmd.output()`, but the child is killed after `limit` (`None` when it ran to the end; `Some`
/// with the output so far when it was killed). On Unix the exit is observed with `waitid(WNOWAIT)`
/// before the child is reaped, so the watchdog can never signal a recycled pid.
pub fn output_limited(cmd: &mut std::process::Command, limit: Duration) -> std::io::Result<(std::process::Output, bool)> {
  use std::io::Read;
  use std::process::Stdio;
  use std::sync::Arc;
  let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
  let read = |pipe: Option<Box<dyn Read + Send>>| {
    std::thread::spawn(move || {
      let mut buf = Vec::new();
      if let Some(mut p) = pipe {
        let _ = p.read_to_end(&mut buf);
      }
      buf
    })
  };
  let out = read(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
  let err = read(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
  // (exited, killed): the watchdog only kills while the child is not known to have exited.
  let flags = Arc::new((Mutex::new((false, false)), Condvar::new()));
  let pid = child.id();
  let watchdog = {
    let flags = flags.clone();
    std::thread::spawn(move || {
      let (m, cv) = &*flags;
      let st = m.lock().unwrap_or_else(|e| e.into_inner());
      let (mut st, _) = cv.wait_timeout_while(st, limit, |s| !s.0).unwrap_or_else(|e| e.into_inner());
      if !st.0 {
        st.1 = true;
        #[cfg(unix)]
        // SAFETY: the child is not reaped yet (see below), so `pid` is still ours.
        unsafe {
          libc::kill(pid as i32, libc::SIGKILL);
        }
        #[cfg(not(unix))]
        let _ = pid;
      }
    })
  };
  #[cfg(unix)]
  // SAFETY: plain waitid on our own child, leaving it waitable (WNOWAIT) for `child.wait()`.
  unsafe {
    let mut info: libc::siginfo_t = std::mem::zeroed();
    while libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOWAIT) != 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {}
  }
  #[cfg(not(unix))]
  let status_early = child.wait();
  let killed = {
    let (m, cv) = &*flags;
    let mut st = m.lock().unwrap_or_else(|e| e.into_inner());
    st.0 = true;
    cv.notify_all();
    st.1
  };
  #[cfg(unix)]
  let status = child.wait()?;
  #[cfg(not(unix))]
  let status = status_early?;
  let _ = watchdog.join();
  let stdout = out.join().unwrap_or_default();
  let stderr = err.join().unwrap_or_default();
  Ok((std::process::Output { status, stdout, stderr }, killed))
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::Arc;

  #[test]
  fn output_limited_kills_a_slow_child_and_keeps_a_fast_one() {
    let (o, killed) = output_limited(std::process::Command::new("sh").args(["-c", "echo hi"]), Duration::from_secs(5)).unwrap();
    assert!(!killed && o.status.success() && o.stdout == b"hi\n");
    let start = Instant::now();
    let (o, killed) = output_limited(std::process::Command::new("sh").args(["-c", "exec sleep 5"]), Duration::from_millis(100)).unwrap();
    assert!(killed && !o.status.success());
    assert!(start.elapsed() < Duration::from_secs(3));
  }
  use std::sync::mpsc;

  fn leaked(cfg: Config) -> &'static Scheduler {
    Box::leak(Box::new(Scheduler::new(cfg)))
  }

  fn small() -> Config {
    Config { general_cap: 1, network_cap: 1, general_headroom: 1, network_headroom: 0, route_cap: 1, route_headroom: 0, aging: Duration::from_secs(3600) }
  }

  const LONG: Duration = Duration::from_secs(10);

  #[test]
  fn classifies_like_orca() {
    assert_eq!(classify(&["fetch", "--all"]), Class::Network);
    assert_eq!(classify(&["-c", "protocol.ext.allow=never", "ls-remote", "--", "u"]), Class::Network);
    assert_eq!(classify(&["submodule", "update", "--init"]), Class::Network);
    assert_eq!(classify(&["remote", "update"]), Class::Network);
    assert_eq!(classify(&["status", "--porcelain=v2"]), Class::General);
    assert_eq!(classify(&["remote", "-v"]), Class::General);
    assert_eq!(classify(&[]), Class::General);
    assert!(is_read(&["--literal-pathspecs", "status"]));
    assert!(is_read(&["config", "--get", "user.name"]));
    assert!(is_read(&["worktree", "list", "--porcelain"]));
    assert!(is_read(&["remote"]));
    assert!(!is_read(&["remote", "show", "origin"]));
    assert!(is_read(&["remote", "show", "-n", "origin"]));
    assert!(!is_read(&["worktree", "remove", "list"]));
    assert!(!is_read(&["commit", "-m", "x"]));
    assert!(!is_read(&["config", "user.name", "x"]));
  }

  #[test]
  fn routes_wsl_and_unc_paths() {
    assert_eq!(route_key(Path::new("\\\\wsl.localhost\\Ubuntu\\home\\a")).as_deref(), Some("wsl:ubuntu"));
    assert_eq!(route_key(Path::new("\\\\wsl$\\Debian\\x")).as_deref(), Some("wsl:debian"));
    assert_eq!(route_key(Path::new("\\\\NAS\\share\\repo")).as_deref(), Some("unc:nas"));
    assert_eq!(route_key(Path::new("/Users/a/repo")), None);
  }

  #[test]
  fn default_budgets_follow_orca() {
    let c = Config::default();
    assert!((2..=4).contains(&c.general_cap));
    assert_eq!((c.network_cap, c.general_headroom, c.network_headroom, c.route_cap, c.route_headroom), (3, 2, 1, 2, 1));
    assert_eq!(c.aging, Duration::from_secs(15));
  }

  #[test]
  fn classes_have_separate_budgets() {
    let s = leaked(small());
    let _g = s.acquire(&["status"], Path::new("/r"), Tier::Status, None, LONG).unwrap();
    // General is full, but a fetch still runs.
    let _n = s.acquire(&["fetch"], Path::new("/r"), Tier::Status, None, LONG).unwrap();
    // A background status read waits for the general slot and times out.
    let r = std::thread::spawn(move || s.acquire(&["status"], Path::new("/r"), Tier::Background, None, Duration::from_millis(150)).map(|_| ())).join().unwrap();
    assert!(matches!(r, Err(Refused::TimedOut { .. })), "{r:?}");
  }

  #[test]
  fn interactive_work_uses_headroom_and_jumps_the_queue() {
    let s = leaked(small());
    let held = s.acquire(&["status"], Path::new("/r"), Tier::Status, None, LONG).unwrap();
    // Headroom: an interactive command runs at once while the base slot is busy.
    let head = std::thread::spawn(move || s.acquire(&["commit"], Path::new("/r"), Tier::Interactive, None, LONG).map(|g| g.queue_wait)).join().unwrap().unwrap();
    assert!(head < Duration::from_secs(1));
    // Two background waiters queue first, then a status one; the status one is admitted first.
    let order = Arc::new(Mutex::new(Vec::new()));
    let (tx, rx) = mpsc::channel();
    let spawn = |tier: Tier, name: &'static str, delay: u64| {
      let order = order.clone();
      let tx = tx.clone();
      std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(delay));
        let g = s.acquire(&["status"], Path::new("/r"), tier, None, LONG).unwrap();
        order.lock().unwrap().push(name);
        tx.send(()).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        drop(g);
      })
    };
    let ts = [spawn(Tier::Background, "bg1", 0), spawn(Tier::Background, "bg2", 30), spawn(Tier::Status, "status", 60)];
    let start = Instant::now();
    while s.snapshot().queued < 3 {
      assert!(start.elapsed() < LONG);
      std::thread::sleep(Duration::from_millis(5));
    }
    drop(held);
    for _ in 0..3 {
      rx.recv_timeout(LONG).unwrap();
    }
    for t in ts {
      t.join().unwrap();
    }
    assert_eq!(*order.lock().unwrap(), ["status", "bg1", "bg2"]);
    let snap = s.snapshot();
    assert_eq!(snap.queued, 0);
    assert!(snap.budgets.values().all(|b| b.base_used == 0 && b.headroom_used == 0), "{snap:?}");
  }

  #[test]
  fn aging_promotes_a_waiting_background_command() {
    let s = leaked(Config { aging: Duration::from_millis(100), ..small() });
    let held = s.acquire(&["status"], Path::new("/r"), Tier::Status, None, LONG).unwrap();
    let order = Arc::new(Mutex::new(Vec::new()));
    let o1 = order.clone();
    let bg = std::thread::spawn(move || {
      let _g = s.acquire(&["status"], Path::new("/r"), Tier::Background, None, LONG).unwrap();
      o1.lock().unwrap().push("bg");
    });
    std::thread::sleep(Duration::from_millis(350));
    let o2 = order.clone();
    let st = std::thread::spawn(move || {
      let _g = s.acquire(&["status"], Path::new("/r"), Tier::Status, None, LONG).unwrap();
      o2.lock().unwrap().push("status");
    });
    while s.snapshot().queued < 2 {
      std::thread::sleep(Duration::from_millis(5));
    }
    drop(held);
    bg.join().unwrap();
    st.join().unwrap();
    // Waited more than two aging periods: background (2) is now 0 and older than the status one.
    assert_eq!(*order.lock().unwrap(), ["bg", "status"]);
  }

  #[test]
  fn cancel_leaves_the_queue() {
    let s = leaked(small());
    let _held = s.acquire(&["fetch"], Path::new("/r"), Tier::Status, None, LONG).unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let c = cancel.clone();
    let t = std::thread::spawn(move || s.acquire(&["fetch"], Path::new("/r"), Tier::Interactive, Some(&c), LONG).map(|_| ()));
    while s.snapshot().queued < 1 {
      std::thread::sleep(Duration::from_millis(5));
    }
    cancel.store(true, Ordering::SeqCst);
    assert_eq!(t.join().unwrap(), Err(Refused::Cancelled));
    assert_eq!(s.snapshot().queued, 0);
  }

  #[test]
  fn nested_acquire_on_one_thread_passes_through() {
    let s = leaked(small());
    let _outer = s.acquire(&["status"], Path::new("/r"), Tier::Status, None, LONG).unwrap();
    // The base slot is taken; without pass-through this would time out.
    let inner = s.acquire(&["status"], Path::new("/r"), Tier::Background, None, Duration::from_millis(50));
    assert!(inner.is_ok());
  }

  #[test]
  fn route_budgets_limit_one_remote_host() {
    let s = leaked(Config { general_cap: 4, ..small() });
    let wsl = Path::new("\\\\wsl$\\Ubuntu\\r");
    let _a = s.acquire(&["status"], wsl, Tier::Status, None, LONG).unwrap();
    // The distro's route (cap 1) is full; a local read still fits the general budget.
    let local = std::thread::spawn(move || s.acquire(&["status"], Path::new("/r"), Tier::Status, None, Duration::from_millis(100)).map(|_| ())).join().unwrap();
    assert!(local.is_ok());
    let other = std::thread::spawn(move || s.acquire(&["status"], Path::new("\\\\wsl$\\Ubuntu\\s"), Tier::Status, None, Duration::from_millis(100)).map(|_| ())).join().unwrap();
    assert!(matches!(other, Err(Refused::TimedOut { .. })));
  }

  #[test]
  fn thread_tier_scopes_nest() {
    assert_eq!(current_tier(), Tier::Status);
    with_tier(Tier::Background, || {
      assert_eq!(current_tier(), Tier::Background);
      // A write inside background work keeps the explicit tier.
      let _w = scoped_default(Tier::Interactive);
      assert_eq!(current_tier(), Tier::Background);
    });
    let _w = scoped_default(Tier::Interactive);
    assert_eq!(current_tier(), Tier::Interactive);
  }
}
