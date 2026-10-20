//! The Testing view's helpers (VS Code gets test controllers from extensions; Kingu drives each
//! stack's own test command). Test runs go through task terminals; this module is the collect step
//! (`cargo test -- --list`, `go test -list`, `pytest --collect-only`) and the JSON report files
//! jest and vitest write, which only Kingu's own report directory may hand back.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use crate::dap::{BuildResult, run_build};

/// A collect command (`argv`) in `cwd`, awaited, with stdout and stderr.
pub fn collect(argv: &[String], cwd: &Path) -> Result<BuildResult, String> {
  run_build(argv, cwd)
}

/// Where report files go: a per-user directory under the temp dir.
pub fn report_dir() -> PathBuf {
  #[cfg(unix)]
  let user = unsafe { libc::getuid() };
  #[cfg(not(unix))]
  let user = 0;
  std::env::temp_dir().join(format!("kingu-test-reports-{user}"))
}

static NEXT: AtomicU32 = AtomicU32::new(0);

/// A fresh report path in `dir` (created, private to the user).
pub fn new_report(dir: &Path) -> Result<String, String> {
  std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
  }
  let n = NEXT.fetch_add(1, Ordering::Relaxed);
  let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
  Ok(dir.join(format!("{}-{stamp}-{n}.json", std::process::id())).to_string_lossy().into_owned())
}

const MAX_REPORT: u64 = 64 * 1024 * 1024;

fn plain_name(name: &str) -> bool {
  !name.is_empty() && name.ends_with(".json") && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') && !name.starts_with('.')
}

/// Reads and deletes a report written to a path from [`new_report`]; `None` when the runner
/// wrote none (it crashed or was cancelled). Any other path is refused.
pub fn take_report(dir: &Path, path: &str) -> Result<Option<String>, String> {
  let p = Path::new(path);
  let name = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
  if p.parent() != Some(dir) || !plain_name(name) {
    return Err(format!("not a test report: {path}"));
  }
  let meta = match std::fs::symlink_metadata(p) {
    Ok(m) => m,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(e) => return Err(e.to_string()),
  };
  if !meta.is_file() || meta.len() > MAX_REPORT {
    let _ = std::fs::remove_file(p);
    return Err(format!("not a test report: {path}"));
  }
  let text = std::fs::read_to_string(p).map_err(|e| e.to_string());
  let _ = std::fs::remove_file(p);
  text.map(Some)
}

fn coverage_name(name: &str) -> bool {
  name.starts_with("cov-") && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// A fresh, empty directory in `dir` for a runner that writes its coverage as `<dir>/lcov.info`
/// (bun, jest, vitest).
pub fn new_coverage_dir(dir: &Path) -> Result<String, String> {
  let report = new_report(dir)?;
  let name = Path::new(&report).file_stem().and_then(|n| n.to_str()).unwrap_or_default().to_string();
  let path = dir.join(format!("cov-{name}"));
  std::fs::create_dir(&path).map_err(|e| e.to_string())?;
  Ok(path.to_string_lossy().into_owned())
}

/// Reads `lcov.info` from a directory made by [`new_coverage_dir`] and removes the directory;
/// `None` when the runner wrote no coverage. Any other path is refused.
pub fn take_coverage(dir: &Path, path: &str) -> Result<Option<String>, String> {
  let p = Path::new(path);
  let name = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
  if p.parent() != Some(dir) || !coverage_name(name) {
    return Err(format!("not a coverage directory: {path}"));
  }
  match std::fs::symlink_metadata(p) {
    Ok(m) if m.is_dir() => {}
    Ok(_) => return Err(format!("not a coverage directory: {path}")),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(e) => return Err(e.to_string()),
  }
  let file = p.join("lcov.info");
  let text = match std::fs::symlink_metadata(&file) {
    Ok(m) if m.is_file() && m.len() <= MAX_REPORT => std::fs::read_to_string(&file).map(Some).map_err(|e| e.to_string()),
    Ok(_) => Err(format!("not a coverage report: {}", file.display())),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(e) => Err(e.to_string()),
  };
  let _ = std::fs::remove_dir_all(p);
  text
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn reports_are_read_once_and_only_from_the_report_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("reports");
    let path = new_report(&dir).unwrap();
    assert!(Path::new(&path).starts_with(&dir));
    // Nothing written yet: no report.
    assert_eq!(take_report(&dir, &path).unwrap(), None);
    std::fs::write(&path, r#"{"numTotalTests":1}"#).unwrap();
    assert_eq!(take_report(&dir, &path).unwrap().as_deref(), Some(r#"{"numTotalTests":1}"#));
    assert!(!Path::new(&path).exists(), "read once");
    // Elsewhere, traversal, or not a .json name.
    let outside = tmp.path().join("x.json");
    std::fs::write(&outside, "{}").unwrap();
    assert!(take_report(&dir, &outside.to_string_lossy()).is_err());
    assert!(take_report(&dir, &format!("{}/../x.json", dir.display())).is_err());
    assert!(take_report(&dir, &dir.join("secret.txt").to_string_lossy()).is_err());
    assert!(outside.exists(), "a refused path is left alone");
    // Two reports never share a name.
    assert_ne!(new_report(&dir).unwrap(), new_report(&dir).unwrap());
  }

  #[test]
  fn coverage_directories_are_read_once_and_only_from_the_report_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("reports");
    let cov = new_coverage_dir(&dir).unwrap();
    assert!(Path::new(&cov).is_dir());
    // The runner wrote nothing.
    assert_eq!(take_coverage(&dir, &cov).unwrap(), None);
    assert!(!Path::new(&cov).exists(), "removed after reading");
    let cov = new_coverage_dir(&dir).unwrap();
    std::fs::write(Path::new(&cov).join("lcov.info"), "SF:a.ts\nDA:1,1\nend_of_record\n").unwrap();
    assert_eq!(take_coverage(&dir, &cov).unwrap().as_deref(), Some("SF:a.ts\nDA:1,1\nend_of_record\n"));
    assert!(!Path::new(&cov).exists());
    // Not one of ours: refused and left alone.
    let other = dir.join("keep");
    std::fs::create_dir(&other).unwrap();
    assert!(take_coverage(&dir, &other.to_string_lossy()).is_err());
    assert!(take_coverage(&dir, &tmp.path().join("cov-x").to_string_lossy()).is_err());
    assert!(take_coverage(&dir, &format!("{}/../cov-x", dir.display())).is_err());
    assert!(other.exists());
  }

  #[test]
  fn collects_a_listing() {
    let tmp = tempfile::tempdir().unwrap();
    let out = collect(&["sh".into(), "-c".into(), "echo 'a::b: test'; echo 'c: test'".into()], tmp.path()).unwrap();
    assert!(out.success && out.output.contains("a::b: test"), "{out:?}");
  }
}
