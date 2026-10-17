//! File watcher on the workspace root (VS Code: the parcel/nsfw watcher behind IFileService).
//! Raw notify events are filtered (`.git/objects`, `node_modules`, `target` are noise), then
//! debounced into one batch of workspace-relative paths; the webview refreshes the Explorer,
//! Source Control and clean editors from it.

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::time::{Duration, Instant};

use notify::{EventKind, RecursiveMode, Watcher};

/// A batch closes once the file system has been quiet this long...
const QUIET: Duration = Duration::from_millis(150);
/// ...or this long after its first event, so a long `npm install` still shows progress.
const MAX_WAIT: Duration = Duration::from_millis(1000);

/// Folders whose churn never matters to the workbench (any depth).
const IGNORED_DIRS: &[&str] = &["node_modules", "target"];

/// The workspace-relative path for an event on `path`, or `None` when it is ignored.
/// The root itself maps to `""` (refresh everything).
pub fn relevant(root: &Path, path: &Path) -> Option<String> {
  let rel = path.strip_prefix(root).ok()?;
  let parts: Vec<_> = rel
    .components()
    .map(|c| match c {
      Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
      _ => None,
    })
    .collect::<Option<_>>()?;
  if parts.iter().any(|p| IGNORED_DIRS.contains(&p.as_str())) {
    return None;
  }
  if parts.first().map(String::as_str) == Some(".git") && parts.get(1).map(String::as_str) == Some("objects") {
    return None;
  }
  Some(parts.join("/"))
}

/// Collects one debounced batch: blocks for the first path, then gathers until quiet.
/// `None` once the sender is gone (the watcher was replaced).
pub fn next_batch(rx: &Receiver<String>, quiet: Duration, max_wait: Duration) -> Option<BTreeSet<String>> {
  let mut batch = BTreeSet::from([rx.recv().ok()?]);
  let deadline = Instant::now() + max_wait;
  loop {
    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() {
      return Some(batch);
    }
    match rx.recv_timeout(quiet.min(left)) {
      Ok(p) => {
        batch.insert(p);
      }
      Err(RecvTimeoutError::Timeout) => return Some(batch),
      Err(RecvTimeoutError::Disconnected) => return Some(batch),
    }
  }
}

#[derive(Default)]
pub struct FileWatcher {
  current: Mutex<Option<notify::RecommendedWatcher>>,
}

impl FileWatcher {
  /// Replaces the watcher with one on `root` (none when `None`). `emit` gets each batch.
  pub fn watch(&self, root: Option<&Path>, emit: impl Fn(Vec<String>) + Send + 'static) -> Result<(), String> {
    let mut current = self.current.lock().unwrap_or_else(|e| e.into_inner());
    // Dropping the old watcher drops its sender, which ends its debounce thread.
    *current = None;
    let Some(root) = root else { return Ok(()) };
    let root: PathBuf = root.to_path_buf();
    let (tx, rx) = channel::<String>();
    let event_root = root.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
      let Ok(ev) = res else { return };
      if matches!(ev.kind, EventKind::Access(_)) {
        return;
      }
      if ev.need_rescan() {
        let _ = tx.send(String::new());
      }
      for p in &ev.paths {
        if let Some(rel) = relevant(&event_root, p) {
          let _ = tx.send(rel);
        }
      }
    })
    .map_err(|e| format!("watch {}: {e}", root.display()))?;
    watcher.watch(&root, RecursiveMode::Recursive).map_err(|e| format!("watch {}: {e}", root.display()))?;
    std::thread::spawn(move || {
      while let Some(batch) = next_batch(&rx, QUIET, MAX_WAIT) {
        emit(batch.into_iter().collect());
      }
    });
    *current = Some(watcher);
    log::info!("watching {}", root.display());
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn filters_noise_and_relativizes() {
    let root = Path::new("/ws");
    let rel = |p: &str| relevant(root, Path::new(p));
    assert_eq!(rel("/ws/src/a.ts").as_deref(), Some("src/a.ts"));
    assert_eq!(rel("/ws").as_deref(), Some(""));
    assert_eq!(rel("/ws/.git/index").as_deref(), Some(".git/index"));
    assert_eq!(rel("/ws/.git/HEAD").as_deref(), Some(".git/HEAD"));
    assert_eq!(rel("/ws/.git/objects/ab/cdef"), None);
    assert_eq!(rel("/ws/node_modules/x/index.js"), None);
    assert_eq!(rel("/ws/apps/web/node_modules/x.js"), None);
    assert_eq!(rel("/ws/target/debug/app"), None);
    assert_eq!(rel("/ws/apps/desktop/src-tauri/target/x"), None);
    assert_eq!(rel("/ws/node_modules"), None);
    // Not a component match: a file merely named like an ignored folder prefix.
    assert_eq!(rel("/ws/targets.md").as_deref(), Some("targets.md"));
    assert_eq!(rel("/other/a.ts"), None);
  }

  #[test]
  fn debounces_into_one_sorted_batch() {
    let (tx, rx) = channel();
    for p in ["b", "a", "b", "c"] {
      tx.send(p.to_string()).unwrap();
    }
    let batch = next_batch(&rx, Duration::from_millis(20), Duration::from_secs(1)).unwrap();
    assert_eq!(batch.into_iter().collect::<Vec<_>>(), ["a", "b", "c"]);

    // A steady trickle is cut at `max_wait`.
    let sender = std::thread::spawn(move || {
      for i in 0..50 {
        if tx.send(format!("f{i}")).is_err() {
          break;
        }
        std::thread::sleep(Duration::from_millis(5));
      }
    });
    let started = Instant::now();
    let batch = next_batch(&rx, Duration::from_millis(50), Duration::from_millis(60)).unwrap();
    assert!(started.elapsed() < Duration::from_millis(200));
    assert!(!batch.is_empty() && batch.len() < 50);
    sender.join().unwrap();
    drop(rx);
  }

  #[test]
  fn batches_end_when_the_watcher_goes() {
    let (tx, rx) = channel::<String>();
    drop(tx);
    assert!(next_batch(&rx, Duration::from_millis(10), Duration::from_millis(10)).is_none());
  }

  #[test]
  fn watches_a_real_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    std::fs::create_dir(root.join("node_modules")).unwrap();
    let (tx, rx) = channel();
    let w = FileWatcher::default();
    w.watch(Some(&root), move |b| {
      let _ = tx.send(b);
    })
    .unwrap();
    std::thread::sleep(Duration::from_millis(200));
    std::fs::write(root.join("node_modules/x.js"), "").unwrap();
    std::fs::write(root.join("hello.txt"), "hi").unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut seen = Vec::new();
    while Instant::now() < deadline && !seen.iter().any(|p: &String| p == "hello.txt") {
      if let Ok(batch) = rx.recv_timeout(Duration::from_millis(200)) {
        seen.extend(batch);
      }
    }
    assert!(seen.iter().any(|p| p == "hello.txt"), "{seen:?}");
    assert!(!seen.iter().any(|p| p.starts_with("node_modules")), "{seen:?}");
    w.watch(None, |_| {}).unwrap();
  }
}
