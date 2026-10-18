//! File watcher on the workspace root (VS Code: the parcel/nsfw watcher behind IFileService).
//! Raw notify events are filtered (`.git/objects`, `node_modules`, `target` are noise), then
//! debounced into one batch of workspace-relative paths; the webview refreshes the Explorer,
//! Source Control and clean editors from it.

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
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

/// `files.watcherInclude`: extra folders inside the workspace to watch, for the ones the
/// recursive watch on the root misses (a symlinked folder: the OS reports its target's paths).
/// Each resolves to `(the real folder, its workspace-relative path)`; paths outside the
/// workspace, missing ones and ones the root watch already covers are dropped.
pub fn resolve_includes(root: &Path, raw: &[String]) -> Vec<(PathBuf, String)> {
  let real_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
  let mut out = Vec::new();
  for r in raw.iter().map(|r| r.trim()).filter(|r| !r.is_empty()) {
    let p = Path::new(r);
    let full = if p.is_absolute() { p.to_path_buf() } else { root.join(p) };
    let Ok(rel) = full.strip_prefix(root) else { continue };
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
      continue;
    }
    let Ok(real) = full.canonicalize() else { continue };
    if real.starts_with(&real_root) {
      continue;
    }
    let rel = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/");
    out.push((real, rel));
  }
  out
}

/// The workspace-relative path of an event: under the root, or under one of the included
/// folders (reported at their real path).
pub fn map_event(root: &Path, includes: &[(PathBuf, String)], path: &Path) -> Option<String> {
  if path.starts_with(root) {
    return relevant(root, path);
  }
  includes.iter().find(|(real, _)| path.starts_with(real)).and_then(|(real, rel)| {
    let inner = relevant(real, path)?;
    let joined = if inner.is_empty() { rel.clone() } else { format!("{rel}/{inner}") };
    // The joined path gets the same noise filter as a path under the root.
    relevant(Path::new("/"), &Path::new("/").join(&joined))
  })
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
  /// `files.watcherExclude`, compiled; read by the running watcher's callback.
  exclude: Arc<RwLock<Vec<regex::Regex>>>,
  /// `files.watcherInclude` as set, and what it resolved to for the watched root.
  include_raw: Mutex<Vec<String>>,
  includes: Arc<RwLock<Vec<(PathBuf, String)>>>,
  root: Mutex<Option<PathBuf>>,
}

impl FileWatcher {
  /// Replaces the `files.watcherExclude` globs (invalid ones are skipped); applies to the running watcher at once.
  pub fn set_exclude(&self, globs: &[String]) {
    let compiled = globs.iter().filter_map(|g| crate::glob::to_regex(g.trim())).collect();
    *self.exclude.write().unwrap_or_else(|e| e.into_inner()) = compiled;
  }

  /// Replaces the `files.watcherInclude` paths; the running watcher watches the new ones at once.
  pub fn set_include(&self, paths: &[String]) {
    *self.include_raw.lock().unwrap_or_else(|e| e.into_inner()) = paths.to_vec();
    let root = self.root.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let mut current = self.current.lock().unwrap_or_else(|e| e.into_inner());
    if let (Some(root), Some(w)) = (root, current.as_mut()) {
      self.rewatch_includes(&root, w);
    }
  }

  fn rewatch_includes(&self, root: &Path, w: &mut notify::RecommendedWatcher) {
    let raw = self.include_raw.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let next = resolve_includes(root, &raw);
    let mut includes = self.includes.write().unwrap_or_else(|e| e.into_inner());
    for (real, _) in includes.iter() {
      let _ = w.unwatch(real);
    }
    for (real, rel) in &next {
      match w.watch(real, RecursiveMode::Recursive) {
        Ok(()) => log::info!("also watching {rel} ({})", real.display()),
        Err(e) => log::warn!("watch {}: {e}", real.display()),
      }
    }
    *includes = next;
  }

  /// Replaces the watcher with one on `root` (none when `None`). `emit` gets each batch.
  pub fn watch(&self, root: Option<&Path>, emit: impl Fn(Vec<String>) + Send + 'static) -> Result<(), String> {
    let mut current = self.current.lock().unwrap_or_else(|e| e.into_inner());
    // Dropping the old watcher drops its sender, which ends its debounce thread.
    *current = None;
    *self.root.lock().unwrap_or_else(|e| e.into_inner()) = root.map(Path::to_path_buf);
    let Some(root) = root else { return Ok(()) };
    let root: PathBuf = root.to_path_buf();
    let (tx, rx) = channel::<String>();
    let event_root = root.clone();
    let exclude = Arc::clone(&self.exclude);
    let includes = Arc::clone(&self.includes);
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
      let Ok(ev) = res else { return };
      if matches!(ev.kind, EventKind::Access(_)) {
        return;
      }
      if ev.need_rescan() {
        let _ = tx.send(String::new());
      }
      for p in &ev.paths {
        if let Some(rel) = map_event(&event_root, &includes.read().unwrap_or_else(|e| e.into_inner()), p)
          && !crate::glob::is_excluded(&rel, &exclude.read().unwrap_or_else(|e| e.into_inner()))
        {
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
    self.rewatch_includes(&root, &mut watcher);
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
  fn includes_resolve_symlinked_folders_inside_the_workspace() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let root = base.join("ws");
    let outside = base.join("shared");
    std::fs::create_dir_all(root.join("plain")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, root.join("linked")).unwrap();
    let got = resolve_includes(&root, &["linked".into(), "plain".into(), "../shared".into(), "missing".into(), base.join("ws/linked").display().to_string()]);
    #[cfg(unix)]
    assert_eq!(got, [(outside.clone(), "linked".to_string()), (outside.clone(), "linked".to_string())]);
    assert_eq!(map_event(&root, &got, &root.join("plain/a.ts")).as_deref(), Some("plain/a.ts"));
    #[cfg(unix)]
    {
      assert_eq!(map_event(&root, &got, &outside.join("x/b.ts")).as_deref(), Some("linked/x/b.ts"));
      assert_eq!(map_event(&root, &got, &outside.join("node_modules/b.ts")), None);
    }
    assert_eq!(map_event(&root, &got, &base.join("elsewhere/c.ts")), None);
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
    std::fs::create_dir(root.join("dist")).unwrap();
    let (tx, rx) = channel();
    let w = FileWatcher::default();
    // files.watcherExclude, set before or while watching.
    w.set_exclude(&["**/dist".into(), "[".into()]);
    w.watch(Some(&root), move |b| {
      let _ = tx.send(b);
    })
    .unwrap();
    std::thread::sleep(Duration::from_millis(200));
    std::fs::write(root.join("node_modules/x.js"), "").unwrap();
    std::fs::write(root.join("dist/bundle.js"), "").unwrap();
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
    assert!(!seen.iter().any(|p| p.starts_with("dist")), "{seen:?}");
    w.watch(None, |_| {}).unwrap();
  }
}
