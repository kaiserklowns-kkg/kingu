//! Workspace Space (Orca's `workspaceSpace:analyze` / `:cancel`): how much disk each git worktree of a
//! project takes, so the user can see which tasks are worth cleaning up.
//!
//! Rules taken from Orca 1.4.253 (MECHANICS.md, "Workspace Space"):
//! - every worktree `git worktree list` reports, except prunable and bare ones;
//! - a worktree's size comes from `du -k -d 1 <path>` (kilobytes, one level deep), stopped after
//!   `DU_TIMEOUT` or once its output passes `DU_OUTPUT_CAP`;
//! - its top-level items are ranked largest first; past `TOP_ITEMS_MAX` the smallest are folded into
//!   one "Other" row (the first `TOP_ITEMS_MAX - 1` stay);
//! - the main worktree is never reclaimable (removing it removes the project), every other one is
//!   reclaimable in full;
//! - rows are sorted largest first, then by name.
//!
//! Read only: nothing is deleted here (removal goes through the Clean Up Tasks dialog).

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::agent::worktree::{self, WorktreeInfo};
use crate::projects;
use crate::workspace::Workspace;

/// Orca `Csn`: `du` gets two minutes per worktree.
const DU_TIMEOUT: Duration = Duration::from_secs(120);
/// Orca `wsn`: 16 MiB of `du` output at most.
const DU_OUTPUT_CAP: usize = 16777216;
/// Orca's worker: 48 rows, the 48th becoming "Other" when there are more.
pub const TOP_ITEMS_MAX: usize = 48;
/// Orca `Dsn`: progress events at most every 100 ms.
const PROGRESS_EVERY: Duration = Duration::from_millis(100);

static RUNNING: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
  pub name: String,
  pub path: String,
  /// `directory`, `file` or `other` (the folded "Other" row).
  pub kind: &'static str,
  pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
  pub path: String,
  pub branch: Option<String>,
  /// Task slug for a Kingu worktree.
  pub slug: Option<String>,
  pub is_main: bool,
  /// `ok`, `missing`, `permission-denied` or `error`.
  pub status: &'static str,
  pub error: Option<String>,
  pub size_bytes: u64,
  pub reclaimable_bytes: u64,
  pub top_items: Vec<Item>,
  pub omitted_item_count: usize,
  pub omitted_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
  pub scanned_at: u64,
  pub total_bytes: u64,
  pub reclaimable_bytes: u64,
  pub worktree_count: usize,
  pub scanned_count: usize,
  pub unavailable_count: usize,
  pub rows: Vec<Row>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
  scanned: usize,
  total: usize,
  current: Option<String>,
}

/// `du -k -d 1` output: `<kilobytes>\t<path>` per line. Returns the root's total (the line whose
/// path is `root`, else the largest) and each direct child's size in bytes.
pub fn parse_du(output: &str, root: &Path) -> (u64, Vec<(PathBuf, u64)>) {
  let mut total = None;
  let mut largest = 0;
  let mut children = Vec::new();
  for line in output.lines() {
    let Some((kb, path)) = line.split_once('\t') else { continue };
    let Ok(kb) = kb.trim().parse::<u64>() else { continue };
    let bytes = kb.saturating_mul(1024);
    let path = PathBuf::from(path.trim_end_matches('/'));
    largest = largest.max(bytes);
    if path == root {
      total = Some(bytes);
    } else if path.parent() == Some(root) {
      children.push((path, bytes));
    }
  }
  (total.unwrap_or(largest), children)
}

/// Largest first, then by name; past `TOP_ITEMS_MAX` the rest fold into one `other` row.
/// Returns the items, how many were folded and their bytes.
pub fn rank_items(mut items: Vec<Item>) -> (Vec<Item>, usize, u64) {
  items.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes).then_with(|| a.name.cmp(&b.name)));
  if items.len() <= TOP_ITEMS_MAX {
    return (items, 0, 0);
  }
  let rest = items.split_off(TOP_ITEMS_MAX - 1);
  let bytes = rest.iter().map(|i| i.size_bytes).sum();
  let count = rest.len();
  items.push(Item { name: "Other".into(), path: String::new(), kind: "other", size_bytes: bytes });
  (items, count, bytes)
}

/// Rows largest first, then by path.
pub fn sort_rows(rows: &mut [Row]) {
  rows.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes).then_with(|| a.path.cmp(&b.path)));
}

pub fn summarize(rows: Vec<Row>, scanned_at: u64) -> Analysis {
  let scanned_count = rows.iter().filter(|r| r.status == "ok").count();
  Analysis {
    scanned_at,
    total_bytes: rows.iter().map(|r| r.size_bytes).sum(),
    reclaimable_bytes: rows.iter().map(|r| r.reclaimable_bytes).sum(),
    worktree_count: rows.len(),
    scanned_count,
    unavailable_count: rows.len() - scanned_count,
    rows,
  }
}

/// Orca's error buckets: missing folder, no permission, anything else.
fn classify(e: &std::io::Error) -> &'static str {
  match e.kind() {
    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory => "missing",
    std::io::ErrorKind::PermissionDenied => "permission-denied",
    _ => "error",
  }
}

/// Bytes a file takes on disk (what `du` counts), else its length.
fn file_bytes(meta: &std::fs::Metadata) -> u64 {
  #[cfg(unix)]
  {
    use std::os::unix::fs::MetadataExt;
    meta.blocks().saturating_mul(512)
  }
  #[cfg(not(unix))]
  {
    meta.len()
  }
}

fn run_du(path: &Path) -> Result<String, String> {
  let mut child = Command::new("du")
    .args(["-k", "-d", "1"])
    .arg(path)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .spawn()
    .map_err(|e| format!("du: {e}"))?;
  let mut stdout = child.stdout.take().ok_or("du: no output")?;
  let reader = std::thread::spawn(move || {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
      match stdout.read(&mut chunk) {
        Ok(0) | Err(_) => break,
        Ok(n) => {
          buf.extend_from_slice(&chunk[..n]);
          if buf.len() > DU_OUTPUT_CAP {
            return Err("du output exceeded the scan limit".to_string());
          }
        }
      }
    }
    Ok(buf)
  });
  let started = Instant::now();
  loop {
    if CANCEL.load(Ordering::Relaxed) {
      let _ = child.kill();
      let _ = child.wait();
      return Err("cancelled".into());
    }
    if started.elapsed() > DU_TIMEOUT {
      let _ = child.kill();
      let _ = child.wait();
      return Err(format!("du timed out after {}s", DU_TIMEOUT.as_secs()));
    }
    if reader.is_finished() {
      break;
    }
    if let Ok(Some(_)) = child.try_wait() {
      if reader.is_finished() {
        break;
      }
    }
    std::thread::sleep(Duration::from_millis(20));
  }
  let out = match reader.join() {
    Ok(Ok(out)) => out,
    Ok(Err(e)) => {
      let _ = child.kill();
      let _ = child.wait();
      return Err(e);
    }
    Err(_) => return Err("du reader failed".into()),
  };
  // du exits 1 when some entries could not be read; the sizes it printed still count.
  let _ = child.wait();
  Ok(String::from_utf8_lossy(&out).into_owned())
}

fn measure(info: &WorktreeInfo, is_main: bool) -> Row {
  let mut row = Row {
    path: info.path.clone(),
    branch: info.branch.clone(),
    slug: info.slug.clone(),
    is_main,
    status: "ok",
    error: None,
    size_bytes: 0,
    reclaimable_bytes: 0,
    top_items: Vec::new(),
    omitted_item_count: 0,
    omitted_bytes: 0,
  };
  let root = Path::new(&info.path);
  let entries = match std::fs::read_dir(root) {
    Ok(entries) => entries,
    Err(e) => {
      row.status = classify(&e);
      row.error = Some(e.to_string());
      return row;
    }
  };
  let du = match run_du(root) {
    Ok(out) => out,
    Err(e) => {
      row.status = "error";
      row.error = Some(e);
      return row;
    }
  };
  let (total, dirs) = parse_du(&du, root);
  let mut items = Vec::new();
  for entry in entries.flatten() {
    let Ok(meta) = std::fs::symlink_metadata(entry.path()) else { continue };
    let path = entry.path();
    let name = entry.file_name().to_string_lossy().into_owned();
    let (kind, size) = if meta.is_dir() {
      ("directory", dirs.iter().find(|(p, _)| *p == path).map_or(0, |(_, b)| *b))
    } else {
      ("file", file_bytes(&meta))
    };
    items.push(Item { name, path: path.to_string_lossy().into_owned(), kind, size_bytes: size });
  }
  let (top, omitted, omitted_bytes) = rank_items(items);
  row.size_bytes = total;
  row.reclaimable_bytes = if is_main { 0 } else { total };
  row.top_items = top;
  row.omitted_item_count = omitted;
  row.omitted_bytes = omitted_bytes;
  row
}

fn display_name(info: &WorktreeInfo) -> String {
  info.slug.clone().or_else(|| info.branch.clone()).unwrap_or_else(|| {
    Path::new(&info.path).file_name().map_or_else(|| info.path.clone(), |n| n.to_string_lossy().into_owned())
  })
}

/// Measures every worktree of `root` one after another (Orca measures one local worktree at a
/// time), reporting progress through `emit`. `Err("cancelled")` once `cancel` was asked.
pub fn analyze(root: &Path, mut emit: impl FnMut(usize, usize, Option<String>)) -> Result<Analysis, String> {
  let scanned_at = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
  let list: Vec<WorktreeInfo> = worktree::list(root)?;
  // `git worktree list` names the main worktree first.
  let main = list.first().map(|w| w.path.clone());
  let todo: Vec<WorktreeInfo> = list.into_iter().filter(|w| !w.prunable && !w.bare).collect();
  let total = todo.len();
  let mut rows = Vec::with_capacity(total);
  let mut last = Instant::now() - PROGRESS_EVERY;
  emit(0, total, None);
  for (i, info) in todo.iter().enumerate() {
    if CANCEL.load(Ordering::Relaxed) {
      return Err("cancelled".into());
    }
    if last.elapsed() >= PROGRESS_EVERY {
      emit(i, total, Some(display_name(info)));
      last = Instant::now();
    }
    let row = measure(info, main.as_deref() == Some(info.path.as_str()));
    if row.error.as_deref() == Some("cancelled") {
      return Err("cancelled".into());
    }
    rows.push(row);
  }
  emit(total, total, None);
  sort_rows(&mut rows);
  Ok(summarize(rows, scanned_at))
}

#[tauri::command]
pub async fn workspace_space_analyze(
  app: AppHandle,
  window: tauri::WebviewWindow,
  ws: Workspace,
  projects: State<'_, projects::Projects>,
  root: Option<String>,
) -> Result<Analysis, String> {
  let Some(root) = projects::root_arg(&ws, &projects, root)? else {
    return Ok(summarize(Vec::new(), 0));
  };
  if RUNNING.swap(true, Ordering::SeqCst) {
    return Err("A workspace space scan is already running.".into());
  }
  CANCEL.store(false, Ordering::SeqCst);
  // Progress goes to the window that asked (another window may show another project).
  let label = window.label().to_string();
  let result = tauri::async_runtime::spawn_blocking(move || {
    analyze(&root, |scanned, total, current| {
      let _ = app.emit_to(label.as_str(), "workspace-space-progress", Progress { scanned, total, current });
    })
  })
  .await
  .map_err(|e| e.to_string());
  RUNNING.store(false, Ordering::SeqCst);
  result?
}

/// True when a running scan was asked to stop.
#[tauri::command]
pub fn workspace_space_cancel() -> bool {
  RUNNING.load(Ordering::SeqCst) && !CANCEL.swap(true, Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn item(name: &str, size: u64) -> Item {
    Item { name: name.into(), path: format!("/w/{name}"), kind: "directory", size_bytes: size }
  }

  #[test]
  fn du_output_gives_total_and_children() {
    let out = "120\t/w/repo/node_modules\n8\t/w/repo/src\n4\t/w/repo/.git/\n140\t/w/repo\n";
    let (total, children) = parse_du(out, Path::new("/w/repo"));
    assert_eq!(total, 140 * 1024);
    assert_eq!(children.len(), 3);
    assert_eq!(children[0], (PathBuf::from("/w/repo/node_modules"), 120 * 1024));
    assert_eq!(children[2].0, PathBuf::from("/w/repo/.git"));
  }

  #[test]
  fn du_without_root_line_uses_largest() {
    let (total, _) = parse_du("10\t/a/x\nbad line\n30\t/elsewhere\n", Path::new("/a"));
    assert_eq!(total, 30 * 1024);
  }

  #[test]
  fn ranks_largest_first_then_name() {
    let (items, omitted, bytes) = rank_items(vec![item("b", 5), item("a", 5), item("c", 9)]);
    assert_eq!(items.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), ["c", "a", "b"]);
    assert_eq!((omitted, bytes), (0, 0));
  }

  #[test]
  fn folds_past_48_into_other() {
    let items: Vec<Item> = (0..50).map(|i| item(&format!("d{i:02}"), 100 - i)).collect();
    let (top, omitted, bytes) = rank_items(items);
    assert_eq!(top.len(), TOP_ITEMS_MAX);
    assert_eq!(omitted, 3);
    // d47, d48, d49 are 53 + 52 + 51.
    assert_eq!(bytes, 156);
    assert_eq!(top.last().unwrap().kind, "other");
    assert_eq!(top.last().unwrap().size_bytes, 156);
  }

  #[test]
  fn exactly_48_items_are_kept() {
    let (top, omitted, _) = rank_items((0..48).map(|i| item(&format!("d{i:02}"), 1)).collect());
    assert_eq!((top.len(), omitted), (48, 0));
  }

  #[test]
  fn summary_counts_and_main_is_not_reclaimable() {
    let row = |path: &str, size: u64, main: bool, status: &'static str| Row {
      path: path.into(),
      branch: None,
      slug: None,
      is_main: main,
      status,
      error: None,
      size_bytes: size,
      reclaimable_bytes: if main { 0 } else { size },
      top_items: vec![],
      omitted_item_count: 0,
      omitted_bytes: 0,
    };
    let mut rows = vec![row("/a", 10, true, "ok"), row("/b", 30, false, "ok"), row("/c", 0, false, "missing")];
    sort_rows(&mut rows);
    assert_eq!(rows[0].path, "/b");
    let a = summarize(rows, 1);
    assert_eq!((a.total_bytes, a.reclaimable_bytes), (40, 30));
    assert_eq!((a.worktree_count, a.scanned_count, a.unavailable_count), (3, 2, 1));
  }

  #[test]
  fn measures_a_real_folder() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("big")).unwrap();
    std::fs::write(dir.path().join("big/blob"), vec![7u8; 200_000]).unwrap();
    std::fs::write(dir.path().join("small.txt"), b"hi").unwrap();
    let root = dir.path().canonicalize().unwrap();
    let info = WorktreeInfo {
      path: root.to_string_lossy().into_owned(),
      head: None,
      branch: Some("kingu/x".into()),
      slug: Some("x".into()),
      bare: false,
      detached: false,
      locked: false,
      prunable: false,
    };
    let row = measure(&info, false);
    assert_eq!(row.status, "ok", "{:?}", row.error);
    assert!(row.size_bytes >= 200_000);
    assert_eq!(row.reclaimable_bytes, row.size_bytes);
    assert_eq!(row.top_items[0].name, "big");
    assert!(row.top_items[0].size_bytes >= 200_000);
    assert!(measure(&info, true).reclaimable_bytes == 0);
  }

  #[test]
  fn missing_folder_is_reported() {
    let info = WorktreeInfo {
      path: "/definitely/not/here/kingu".into(),
      head: None,
      branch: None,
      slug: Some("gone".into()),
      bare: false,
      detached: false,
      locked: false,
      prunable: false,
    };
    assert_eq!(measure(&info, false).status, "missing");
  }
}
