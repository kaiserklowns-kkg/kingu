//! One git operation at a time per repository, across both sides of the app: the IDE's Source
//! Control (commit, stage, stash, checkout, pull, push …) and the ADE's task actions (create and
//! remove worktrees, refresh the base, commit, reject, merge, push a PR) wait for each other here
//! instead of failing on `index.lock` or "cannot lock ref" (VS Code's agent host keeps the same
//! per-key queues, `SequencerByKey`, for its git state).
//!
//! Keys. A repository's worktrees share one git common dir (refs, packed-refs, config, objects)
//! but each has its own index and HEAD. So there are two kinds of lane:
//! - the **repository** lane, keyed by the canonical git common dir: anything that writes refs
//!   (commit, merge, rebase, checkout, branch, stash, fetch, pull, push, `worktree add/remove`,
//!   `update-ref`);
//! - the **worktree** lane, keyed by that worktree's own git dir (`.git` for the main checkout,
//!   `.git/worktrees/<name>` for a task): anything that writes its index or files.
//!
//! [`Scope::Worktree`] takes only the worktree lane (stage, unstage, discard, reject, hunk
//! `git apply -R`), so staging in a task worktree keeps working while the main folder pushes.
//! [`Scope::Refs`] takes only the repository lane (fetch, push, branch create/delete, stash drop,
//! moving a branch that is not checked out). [`Scope::Repository`] takes both, repository first
//! (commit, pull, merge, rebase, checkout, stash push/apply, abort/continue).
//!
//! Lock order is always repository lane, then worktree lane, and a thread holding only a worktree
//! lane never asks for a repository lane, so two operations cannot wait on each other. Lanes are
//! re-entrant per thread: a locked operation may call another (commit-all stages then commits;
//! a merge locks the checkout it merges in).
//!
//! A waiting operation stays pending (the webview keeps showing it busy) and reports itself
//! through [`set_notifier`] (the status bar's "waiting for git"). After [`WAIT_TIMEOUT`] it gives
//! up with a message naming the operation it waited for. Read-only commands do not queue; they
//! run with `--no-optional-locks` (see `git::run`) so they never take the index lock themselves.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread::ThreadId;
use std::time::{Duration, Instant};

use crate::i18n::msg::GitMsg;
use crate::tr;

/// How long an operation waits for the one ahead of it: longer than a network operation may run
/// (`git_remote::NET_TIMEOUT`), so a commit queued behind a slow push still runs.
pub const WAIT_TIMEOUT: Duration = Duration::from_secs(150);

/// Which lanes an operation holds (see the module docs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
  /// The worktree's index and files only.
  Worktree,
  /// The shared refs only.
  Refs,
  /// Both.
  Repository,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Key {
  Common(PathBuf),
  Tree(PathBuf),
}

#[derive(Default)]
struct State {
  holder: Option<ThreadId>,
  depth: u32,
  /// What the holder is doing (`commit`, `merge kingu/foo`), for waiters' messages.
  label: String,
}

#[derive(Default)]
struct Lane {
  state: Mutex<State>,
  freed: Condvar,
}

fn lanes() -> &'static Mutex<HashMap<Key, Arc<Lane>>> {
  static LANES: OnceLock<Mutex<HashMap<Key, Arc<Lane>>>> = OnceLock::new();
  LANES.get_or_init(Default::default)
}

fn lane(key: &Key) -> Arc<Lane> {
  let mut map = lanes().lock().unwrap_or_else(|e| e.into_inner());
  map.entry(key.clone()).or_default().clone()
}

thread_local! {
  /// Lanes this thread holds (with repeats while re-entered), to check the lock order.
  static HELD: RefCell<Vec<Key>> = const { RefCell::new(Vec::new()) };
}

/// What the status bar hears: an operation started or stopped waiting behind `running`.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct QueueEvent {
  /// The repository's common dir.
  pub repo: String,
  /// The operation that waits.
  pub op: String,
  /// The operation it waits for.
  pub running: String,
  pub waiting: bool,
}

type Notifier = Box<dyn Fn(QueueEvent) + Send + Sync>;
static NOTIFIER: OnceLock<Notifier> = OnceLock::new();

/// Installs the waiting notifier (the app emits it as the `git-queue` event). First call wins.
pub fn set_notifier(f: impl Fn(QueueEvent) + Send + Sync + 'static) {
  let _ = NOTIFIER.set(Box::new(f));
}

fn notify(e: QueueEvent) {
  if let Some(f) = NOTIFIER.get() {
    f(e);
  }
}

/// `(common dir, worktree git dir)` of the repository containing `dir`, found by walking up to the
/// nearest `.git` (a folder in the main checkout, a `gitdir:` file in a linked worktree) without
/// running git. Outside a repository both are `dir` itself (git will fail on its own).
pub fn repo_keys(dir: &Path) -> (PathBuf, PathBuf) {
  let start = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
  let mut at = Some(start.as_path());
  while let Some(d) = at {
    let dot = d.join(".git");
    if dot.is_dir() {
      let g = dot.canonicalize().unwrap_or(dot);
      return (g.clone(), g);
    }
    if dot.is_file()
      && let Some(git_dir) = std::fs::read_to_string(&dot).ok().and_then(|t| t.lines().find_map(|l| l.strip_prefix("gitdir:").map(|p| d.join(p.trim()))))
    {
        let git_dir = git_dir.canonicalize().unwrap_or(git_dir);
        let common = std::fs::read_to_string(git_dir.join("commondir"))
          .ok()
          .map(|c| git_dir.join(c.trim()))
          .and_then(|c| c.canonicalize().ok())
          .unwrap_or_else(|| git_dir.clone());
      return (common, git_dir);
    }
    at = d.parent();
  }
  (start.clone(), start)
}

/// Lanes held for one operation; dropping it lets the next one in.
pub struct QueueGuard {
  held: Vec<(Key, Arc<Lane>)>,
}

impl Drop for QueueGuard {
  fn drop(&mut self) {
    for (key, lane) in self.held.drain(..).rev() {
      let mut st = lane.state.lock().unwrap_or_else(|e| e.into_inner());
      st.depth = st.depth.saturating_sub(1);
      if st.depth == 0 {
        st.holder = None;
        st.label.clear();
        lane.freed.notify_all();
      }
      HELD.with(|h| {
        let mut h = h.borrow_mut();
        if let Some(i) = h.iter().rposition(|k| *k == key) {
          h.remove(i);
        }
      });
    }
  }
}

fn acquire(key: &Key, label: &str, repo: &Path, deadline: Instant, timeout: Duration) -> Result<Arc<Lane>, String> {
  let lane = lane(key);
  let me = std::thread::current().id();
  {
    let mut st = lane.state.lock().unwrap_or_else(|e| e.into_inner());
    if st.holder == Some(me) {
      st.depth += 1;
    } else {
      let mut announced: Option<String> = None;
      while st.holder.is_some() {
        if announced.is_none() {
          let running = st.label.clone();
          notify(QueueEvent { repo: repo.display().to_string(), op: label.to_owned(), running: running.clone(), waiting: true });
          announced = Some(running);
        }
        let now = Instant::now();
        if now >= deadline {
          let running = st.label.clone();
          drop(st);
          notify(QueueEvent { repo: repo.display().to_string(), op: label.to_owned(), running: running.clone(), waiting: false });
          log::warn!("git queue: {label} gave up waiting for {running} after {}s", timeout.as_secs());
          return Err(tr!(GitMsg::QueueTimeout, op = label, running, secs = timeout.as_secs()));
        }
        st = lane.freed.wait_timeout(st, deadline - now).unwrap_or_else(|e| e.into_inner()).0;
      }
      st.holder = Some(me);
      st.depth = 1;
      st.label = label.to_owned();
      if let Some(running) = announced {
        notify(QueueEvent { repo: repo.display().to_string(), op: label.to_owned(), running, waiting: false });
      }
    }
  }
  HELD.with(|h| h.borrow_mut().push(key.clone()));
  Ok(lane)
}

/// Takes the lanes `scope` needs for the repository containing `dir`, waiting up to `timeout`.
pub fn lock_for(dir: &Path, scope: Scope, label: &str, timeout: Duration) -> Result<QueueGuard, String> {
  let (common, tree) = repo_keys(dir);
  let deadline = Instant::now() + timeout;
  let common_key = Key::Common(common.clone());
  let tree_key = Key::Tree(tree);
  let mut keys = Vec::new();
  if scope != Scope::Worktree {
    // Lock order: a thread that holds a worktree lane must already hold the repository lane
    // before it asks for it again, else two operations could wait on each other.
    let (holds_tree, holds_common) = HELD.with(|h| {
      let h = h.borrow();
      (h.iter().any(|k| matches!(k, Key::Tree(_))), h.contains(&common_key))
    });
    if holds_tree && !holds_common {
      debug_assert!(false, "git queue: {label} asks for the repository lane while holding a worktree lane");
      return Err(format!("git queue: {label} cannot wait for the repository while it holds a worktree"));
    }
    keys.push(common_key);
  }
  if scope != Scope::Refs {
    keys.push(tree_key);
  }
  let mut guard = QueueGuard { held: Vec::new() };
  for key in keys {
    // On a timeout the guard drops what was already taken.
    let lane = acquire(&key, label, &common, deadline, timeout)?;
    guard.held.push((key, lane));
  }
  Ok(guard)
}

/// [`lock_for`] with [`WAIT_TIMEOUT`].
pub fn lock(dir: &Path, scope: Scope, label: &str) -> Result<QueueGuard, String> {
  lock_for(dir, scope, label, WAIT_TIMEOUT)
}

/// Runs `f` holding the lanes `scope` needs for `dir`'s repository.
pub fn with<T>(dir: &Path, scope: Scope, label: &str, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
  let _guard = lock(dir, scope, label)?;
  f()
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::process::Command;
  use std::sync::atomic::{AtomicU32, Ordering};

  fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
      .arg("-C")
      .arg(dir)
      .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
      .args(args)
      .output()
      .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
  }

  fn repo() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("r");
    std::fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("a.txt"), "a\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "init"]);
    (tmp, repo)
  }

  #[test]
  fn worktrees_share_the_repository_key_but_not_the_worktree_key() {
    let (_tmp, repo) = repo();
    git(&repo, &["worktree", "add", "-q", "-b", "kingu/t", ".kingu/worktrees/t"]);
    let wt = repo.join(".kingu/worktrees/t");
    std::fs::create_dir_all(repo.join("sub/dir")).unwrap();
    let (c1, t1) = repo_keys(&repo.join("sub/dir"));
    let (c2, t2) = repo_keys(&wt);
    assert_eq!(c1, c2);
    assert_eq!(c1, repo.join(".git").canonicalize().unwrap());
    assert_ne!(t1, t2);
    assert!(t2.ends_with(".git/worktrees/t"), "{t2:?}");
  }

  #[test]
  fn concurrent_index_writers_never_hit_index_lock() {
    let (_tmp, repo) = repo();
    let errors = Arc::new(AtomicU32::new(0));
    let threads: Vec<_> = (0..8)
      .map(|i| {
        let repo = repo.clone();
        let errors = errors.clone();
        std::thread::spawn(move || {
          for j in 0..4 {
            let name = format!("f{i}-{j}.txt");
            std::fs::write(repo.join(&name), format!("{i}{j}\n")).unwrap();
            // Half commit (repository scope), half only stage (worktree scope): both write the index.
            let r = if j % 2 == 0 {
              crate::git::stage(&repo, std::slice::from_ref(&name)).and_then(|_| crate::git::commit(&repo, &format!("c {name}"), &Default::default()))
            } else {
              crate::git::stage(&repo, std::slice::from_ref(&name))
            };
            if let Err(e) = r {
              // A commit can find nothing staged when another thread's commit took its file.
              if !e.contains("nothing staged") {
                eprintln!("{e}");
                errors.fetch_add(1, Ordering::SeqCst);
              }
            }
          }
        })
      })
      .collect();
    for t in threads {
      t.join().unwrap();
    }
    assert_eq!(errors.load(Ordering::SeqCst), 0, "a git command failed on a lock");
  }

  #[test]
  fn a_waiting_operation_times_out_naming_the_running_one() {
    let (_tmp, repo) = repo();
    let (tx, rx) = std::sync::mpsc::channel();
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let r2 = repo.clone();
    let holder = std::thread::spawn(move || {
      let _g = lock(&r2, Scope::Repository, "merge kingu/t").unwrap();
      tx.send(()).unwrap();
      let _ = done_rx.recv();
    });
    rx.recv().unwrap();
    let start = Instant::now();
    let err = crate::i18n::with_locale(crate::i18n::Locale::En, || lock_for(&repo, Scope::Worktree, "stage", Duration::from_millis(200)).err().unwrap());
    assert!(start.elapsed() >= Duration::from_millis(200));
    assert!(err.contains("merge kingu/t") && err.contains("stage"), "{err}");
    // A refs-only operation is not blocked by a worktree-only one, and vice versa.
    done_tx.send(()).unwrap();
    holder.join().unwrap();
    assert!(lock_for(&repo, Scope::Refs, "fetch", Duration::from_millis(50)).is_ok());
  }

  #[test]
  fn worktree_operations_run_beside_a_refs_operation_and_lanes_are_reentrant() {
    let (_tmp, repo) = repo();
    git(&repo, &["worktree", "add", "-q", "-b", "kingu/u", ".kingu/worktrees/u"]);
    let wt = repo.join(".kingu/worktrees/u");
    let _push = lock(&repo, Scope::Refs, "push").unwrap();
    // Another thread can stage in the task worktree (and in the main checkout) meanwhile …
    let (r, w) = (repo.clone(), wt.clone());
    std::thread::spawn(move || {
      lock_for(&w, Scope::Worktree, "stage", Duration::from_millis(100)).unwrap();
      lock_for(&r, Scope::Worktree, "stage", Duration::from_millis(100)).unwrap();
      // … but not commit there.
      assert!(lock_for(&w, Scope::Repository, "commit", Duration::from_millis(100)).is_err());
    })
    .join()
    .unwrap();
    // The holder itself can nest: repository then the task worktree.
    let _nested = lock(&wt, Scope::Repository, "merge").unwrap();
    let _again = lock(&repo, Scope::Repository, "commit").unwrap();
  }

  #[test]
  fn waiters_are_announced() {
    let (_tmp, repo) = repo();
    let seen: Arc<Mutex<Vec<QueueEvent>>> = Default::default();
    let sink = seen.clone();
    set_notifier(move |e| sink.lock().unwrap().push(e));
    let g = lock(&repo, Scope::Repository, "pull").unwrap();
    let r = repo.clone();
    let t = std::thread::spawn(move || lock_for(&r, Scope::Worktree, "stage (announced)", Duration::from_secs(5)).map(|_| ()));
    let start = Instant::now();
    while !seen.lock().unwrap().iter().any(|e| e.op == "stage (announced)" && e.waiting) {
      assert!(start.elapsed() < Duration::from_secs(5), "no waiting event");
      std::thread::yield_now();
    }
    drop(g);
    t.join().unwrap().unwrap();
    let events = seen.lock().unwrap();
    let mine: Vec<_> = events.iter().filter(|e| e.op == "stage (announced)").collect();
    assert_eq!(mine.len(), 2);
    assert!(mine[0].waiting && !mine[1].waiting && mine[0].running == "pull");
  }
}
