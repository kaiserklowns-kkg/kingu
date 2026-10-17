//! Explorer file operations (VS Code: explorerService + fileActions): new file, new folder,
//! rename/move, delete to the Trash and reveal in Finder. Both ends of every operation stay
//! inside the workspace: paths are plain relative paths (no `..`, no absolute paths) and the
//! nearest existing ancestor must resolve inside the root, so a symlinked folder cannot lead out.
//! Nothing is ever overwritten.

use std::path::{Component, Path, PathBuf};

/// A workspace-relative path made only of normal components.
fn plain(rel: &str) -> Result<&Path, String> {
  let path = Path::new(rel);
  if rel.is_empty() || !path.components().all(|c| matches!(c, Component::Normal(_))) {
    return Err(format!("{rel}: not a valid path inside the workspace"));
  }
  Ok(path)
}

/// The canonical form of `path`'s parent directory, which must lie inside `root`.
fn parent_inside(root: &Path, rel: &str, path: &Path) -> Result<PathBuf, String> {
  let parent = path.parent().ok_or_else(|| format!("{rel}: no parent"))?;
  let real = parent.canonicalize().map_err(|e| format!("{rel}: {e}"))?;
  if !real.starts_with(root) {
    return Err(format!("{rel}: outside the workspace"));
  }
  Ok(real)
}

/// An existing entry. The entry itself may be a symlink (rename and delete act on the link,
/// not its target), so it is judged by the folder it lives in.
pub fn check_existing(root: &Path, rel: &str) -> Result<PathBuf, String> {
  let full = root.join(plain(rel)?);
  full.symlink_metadata().map_err(|e| format!("{rel}: {e}"))?;
  let parent = parent_inside(root, rel, &full)?;
  Ok(parent.join(full.file_name().ok_or_else(|| format!("{rel}: no name"))?))
}

/// A path that does not exist yet; missing parent folders are allowed (VS Code accepts
/// `a/b/c.txt` in the new-file box) but the nearest existing one must be a folder inside the root.
pub fn check_new(root: &Path, rel: &str) -> Result<PathBuf, String> {
  let full = root.join(plain(rel)?);
  if full.symlink_metadata().is_ok() {
    return Err(format!("{rel}: already exists"));
  }
  let mut probe = full.clone();
  loop {
    if !probe.pop() {
      return Err(format!("{rel}: outside the workspace"));
    }
    if probe.symlink_metadata().is_ok() {
      let real = probe.canonicalize().map_err(|e| format!("{rel}: {e}"))?;
      if !real.starts_with(root) {
        return Err(format!("{rel}: outside the workspace"));
      }
      if !real.is_dir() {
        return Err(format!("{rel}: {} is not a folder", probe.display()));
      }
      return Ok(full);
    }
  }
}

fn create_parents(rel: &str, path: &Path) -> Result<(), String> {
  match path.parent() {
    Some(p) => std::fs::create_dir_all(p).map_err(|e| format!("{rel}: {e}")),
    None => Ok(()),
  }
}

pub fn create_file(root: &Path, rel: &str) -> Result<(), String> {
  let path = check_new(root, rel)?;
  create_parents(rel, &path)?;
  // `create_new` fails if something appeared since the check: never overwrite.
  std::fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|e| format!("{rel}: {e}"))?;
  Ok(())
}

pub fn create_dir(root: &Path, rel: &str) -> Result<(), String> {
  let path = check_new(root, rel)?;
  create_parents(rel, &path)?;
  std::fs::create_dir(&path).map_err(|e| format!("{rel}: {e}"))
}

/// Renames or moves `from` to `to`. A case-only rename (`a.txt` → `A.txt`) is allowed even though
/// a case-insensitive file system reports the target as existing.
pub fn rename(root: &Path, from: &str, to: &str) -> Result<(), String> {
  let src = check_existing(root, from)?;
  if from == to {
    return Ok(());
  }
  plain(to)?;
  if Path::new(to).starts_with(Path::new(from)) {
    return Err(format!("{to}: cannot move a folder into itself"));
  }
  let case_only = from.to_lowercase() == to.to_lowercase() && same_entry(&src, &root.join(to));
  let dst = if case_only {
    let full = root.join(to);
    parent_inside(root, to, &full)?;
    full
  } else {
    check_new(root, to)?
  };
  create_parents(to, &dst)?;
  std::fs::rename(&src, &dst).map_err(|e| format!("{from} → {to}: {e}"))
}

fn same_entry(a: &Path, b: &Path) -> bool {
  #[cfg(unix)]
  {
    use std::os::unix::fs::MetadataExt;
    match (a.symlink_metadata(), b.symlink_metadata()) {
      (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
      _ => false,
    }
  }
  #[cfg(not(unix))]
  {
    let _ = (a, b);
    false
  }
}

/// Moves `rel` to the Trash (VS Code's default `files.enableTrash`).
pub fn trash(root: &Path, rel: &str) -> Result<(), String> {
  let path = check_existing(root, rel)?;
  trash::delete(&path).map_err(|e| format!("{rel}: {e}"))
}

/// Shows `rel` selected in Finder (Explorer on Windows, the containing folder elsewhere).
pub fn reveal(root: &Path, rel: &str) -> Result<(), String> {
  let path = if rel.is_empty() { root.to_path_buf() } else { check_existing(root, rel)? };
  let mut cmd;
  #[cfg(target_os = "macos")]
  {
    cmd = std::process::Command::new("open");
    cmd.arg("-R").arg(&path);
  }
  #[cfg(target_os = "windows")]
  {
    cmd = std::process::Command::new("explorer");
    cmd.arg(format!("/select,{}", path.display()));
  }
  #[cfg(not(any(target_os = "macos", target_os = "windows")))]
  {
    cmd = std::process::Command::new("xdg-open");
    cmd.arg(path.parent().unwrap_or(root));
  }
  cmd.spawn().map(|_| ()).map_err(|e| format!("reveal {rel}: {e}"))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn ws() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("ws");
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join("src/a.txt"), "a").unwrap();
    std::fs::write(tmp.path().join("secret.txt"), "s").unwrap();
    let root = root.canonicalize().unwrap();
    (tmp, root)
  }

  #[test]
  fn rejects_escaping_and_odd_paths() {
    let (_tmp, root) = ws();
    for bad in ["", "..", "../secret.txt", "src/../../secret.txt", "/etc/hosts", "./src/a.txt"] {
      assert!(check_new(&root, bad).is_err(), "new {bad}");
      assert!(check_existing(&root, bad).is_err(), "existing {bad}");
    }
  }

  #[test]
  fn new_paths_must_not_exist_and_may_nest() {
    let (_tmp, root) = ws();
    assert!(check_new(&root, "src/a.txt").unwrap_err().contains("already exists"));
    assert!(check_new(&root, "src").unwrap_err().contains("already exists"));
    assert_eq!(check_new(&root, "src/b.txt").unwrap(), root.join("src/b.txt"));
    assert!(check_new(&root, "x/y/z.txt").is_ok());
    assert!(check_new(&root, "src/a.txt/under-a-file").unwrap_err().contains("not a folder"));
  }

  #[cfg(unix)]
  #[test]
  fn symlinks_cannot_lead_out() {
    let (tmp, root) = ws();
    std::os::unix::fs::symlink(tmp.path(), root.join("out")).unwrap();
    std::os::unix::fs::symlink(root.join("src"), root.join("in")).unwrap();
    assert!(check_new(&root, "out/new.txt").unwrap_err().contains("outside"));
    assert!(check_existing(&root, "out/secret.txt").unwrap_err().contains("outside"));
    assert!(rename(&root, "src/a.txt", "out/stolen.txt").unwrap_err().contains("outside"));
    assert!(!tmp.path().join("stolen.txt").exists());
    // The link itself lives inside, so it can be renamed or deleted; a link inside is fine too.
    assert!(check_existing(&root, "out").is_ok());
    assert!(check_new(&root, "in/new.txt").is_ok());
  }

  #[test]
  fn create_refuses_to_overwrite() {
    let (_tmp, root) = ws();
    create_file(&root, "src/new.ts").unwrap();
    assert!(root.join("src/new.ts").is_file());
    assert!(create_file(&root, "src/a.txt").is_err());
    assert_eq!(std::fs::read_to_string(root.join("src/a.txt")).unwrap(), "a");
    create_dir(&root, "lib/deep").unwrap();
    assert!(root.join("lib/deep").is_dir());
    assert!(create_dir(&root, "lib").is_err());
    create_file(&root, "nested/dir/file.md").unwrap();
    assert!(root.join("nested/dir/file.md").is_file());
  }

  #[test]
  fn rename_moves_without_overwriting() {
    let (_tmp, root) = ws();
    std::fs::write(root.join("b.txt"), "b").unwrap();
    assert!(rename(&root, "src/a.txt", "b.txt").unwrap_err().contains("already exists"));
    assert_eq!(std::fs::read_to_string(root.join("b.txt")).unwrap(), "b");
    rename(&root, "src/a.txt", "moved/a2.txt").unwrap();
    assert_eq!(std::fs::read_to_string(root.join("moved/a2.txt")).unwrap(), "a");
    assert!(rename(&root, "moved", "moved/inner").unwrap_err().contains("into itself"));
    assert!(rename(&root, "missing.txt", "x.txt").is_err());
    assert!(rename(&root, "b.txt", "../b.txt").is_err());
  }

  #[test]
  fn case_only_rename() {
    let (_tmp, root) = ws();
    rename(&root, "src/a.txt", "src/A.txt").unwrap();
    let names: Vec<_> = std::fs::read_dir(root.join("src")).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(names, ["A.txt"]);
  }
}
