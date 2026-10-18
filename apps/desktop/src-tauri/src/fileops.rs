//! Explorer file operations (VS Code: explorerService + fileActions): new file, new folder,
//! rename/move, delete to the Trash and reveal in Finder. Both ends of every operation stay
//! inside the workspace: paths are plain relative paths (no `..`, no absolute paths) and the
//! nearest existing ancestor must resolve inside the root, so a symlinked folder cannot lead out.
//! Nothing is ever overwritten: copies and imports that collide get VS Code's `name copy.ts`
//! naming (`explorer.incrementalNaming: simple`), moves that collide fail.

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

/// VS Code's `incrementFileName` (simple): `a.ts` → `a copy.ts` → `a copy 2.ts`; folders keep
/// their dots (`v1.2` → `v1.2 copy`).
pub fn increment_name(name: &str, is_dir: bool) -> String {
  let (stem, ext) = match name.rfind('.') {
    Some(i) if !is_dir && i > 0 => name.split_at(i),
    _ => (name, ""),
  };
  if let Some(i) = stem.rfind(" copy") {
    let (head, tail) = stem.split_at(i + " copy".len());
    if tail.is_empty() {
      return format!("{head} 2{ext}");
    }
    if let Some(digits) = tail.strip_prefix(' ')
      && !digits.is_empty()
      && digits.bytes().all(|b| b.is_ascii_digit())
      && let Ok(n) = digits.parse::<u64>()
    {
      return format!("{head} {}{ext}", n + 1);
    }
  }
  format!("{stem} copy{ext}")
}

/// `explorer.incrementalNaming`: how a pasted or dropped item that clashes with an existing name
/// is renamed. `Disabled` refuses the clash (the webview asks to replace it).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Naming {
  #[default]
  Simple,
  Smart,
  Disabled,
}

/// VS Code's `incrementFileName` with `smart` naming: the number in a name goes up
/// (`file.1.txt` → `file.2.txt`, `1.txt` → `2.txt`, `folder1` → `folder2`), else `.1` is added
/// (`file.txt` → `file.1.txt`).
pub fn increment_name_smart(name: &str, is_dir: bool) -> String {
  use regex::{Captures, Regex};
  use std::sync::LazyLock;
  // VS Code's MAX_SAFE_SMALL_INTEGER: past it the number is kept and `.1` appended.
  const MAX: u64 = 1 << 30;
  let bump = |digits: &str| -> Option<String> {
    let n: u64 = digits.parse().ok()?;
    (n < MAX).then(|| format!("{:0width$}", n + 1, width = digits.len()))
  };
  static SUFFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(.*[.\-_])(\d+)(\..*)$").unwrap());
  static PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(.*?)(\d+)([.\-_].*)(\..*)$").unwrap());
  static PREFIX_NO_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(.*?)(\d+)(\..*)$").unwrap());
  static TRAILING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d+)$").unwrap());
  static LEADING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\d+)(.*)$").unwrap());
  if !is_dir {
    // file.1.txt → file.2.txt
    if let Some(c) = SUFFIX.captures(name) {
      return bump(&c[2]).map_or_else(|| format!("{}{}.1{}", &c[1], &c[2], &c[3]), |n| format!("{}{n}{}", &c[1], &c[3]));
    }
    // 1.file.txt → 2.file.txt
    if let Some(c) = PREFIX.captures(name) {
      return bump(&c[2]).map_or_else(|| format!("{}{}{}.1{}", &c[1], &c[2], &c[3], &c[4]), |n| format!("{}{n}{}{}", &c[1], &c[3], &c[4]));
    }
    // 1.txt → 2.txt (VS Code's regex is unanchored: the last digits before the first dot after them).
    if let Some(c) = PREFIX_NO_NAME.captures(name).filter(|c| !c[3].is_empty()) {
      return bump(&c[2]).map_or_else(|| format!("{}{}.1{}", &c[1], &c[2], &c[3]), |n| format!("{}{n}{}", &c[1], &c[3]));
    }
    // file.txt → file.1.txt
    if let Some(dot) = name.rfind('.') {
      return format!("{}.1{}", &name[..dot], &name[dot..]);
    }
    // 123 → 124
    if let Some(c) = TRAILING.captures(name) {
      let digits = c[1].to_string();
      return match bump(&digits) {
        Some(n) => TRAILING.replace(name, |_: &Captures| n.clone()).into_owned(),
        None => format!("{name}.1"),
      };
    }
    // file → file1 (VS Code's `(.*)(\d*)$` never captures digits here, so it always appends 1).
    return format!("{name}1");
  }
  // folder.1 → folder.2
  if let Some(c) = TRAILING.captures(name) {
    let digits = c[1].to_string();
    return match bump(&digits) {
      Some(n) => TRAILING.replace(name, |_: &Captures| n.clone()).into_owned(),
      None => format!("{name}.1"),
    };
  }
  // 1.folder → 2.folder
  if let Some(c) = LEADING.captures(name) {
    return bump(&c[1]).map_or_else(|| format!("{}{}.1", &c[1], &c[2]), |n| format!("{n}{}", &c[2]));
  }
  format!("{name}.1")
}

/// An existing folder (or the root, `""`) to put things into, canonical and inside the workspace.
fn target_dir(root: &Path, dir: &str) -> Result<PathBuf, String> {
  let path = if dir.is_empty() { root.to_path_buf() } else { root.join(plain(dir)?).canonicalize().map_err(|e| format!("{dir}: {e}"))? };
  if !path.starts_with(root) {
    return Err(format!("{dir}: outside the workspace"));
  }
  if !path.is_dir() {
    return Err(format!("{dir}: not a folder"));
  }
  Ok(path)
}

/// `dir/name`, or the first free incremented name when it is taken (`naming`); with naming
/// disabled a taken name is an "already exists" error.
fn free_name(root: &Path, dir: &str, name: &str, is_dir: bool, naming: Naming) -> Result<String, String> {
  let mut name = name.to_string();
  for _ in 0..10_000 {
    let rel = if dir.is_empty() { name.clone() } else { format!("{dir}/{name}") };
    if root.join(&rel).symlink_metadata().is_err() {
      return Ok(rel);
    }
    name = match naming {
      Naming::Simple => increment_name(&name, is_dir),
      Naming::Smart => increment_name_smart(&name, is_dir),
      Naming::Disabled => return Err(format!("{rel}: already exists")),
    };
  }
  Err(format!("{name}: no free name"))
}

/// Copies a file, a folder (recursively) or a symlink (as a link) to `dst`, which must not exist.
fn copy_entry(src: &Path, dst: &Path) -> std::io::Result<()> {
  let meta = src.symlink_metadata()?;
  if meta.file_type().is_symlink() {
    #[cfg(unix)]
    return std::os::unix::fs::symlink(std::fs::read_link(src)?, dst);
    #[cfg(not(unix))]
    return std::fs::copy(src, dst).map(|_| ());
  }
  if meta.is_dir() {
    std::fs::create_dir(dst)?;
    for entry in std::fs::read_dir(src)? {
      let entry = entry?;
      copy_entry(&entry.path(), &dst.join(entry.file_name()))?;
    }
    return Ok(());
  }
  // `create_new`, then copy the bytes: never clobber something that appeared meanwhile.
  let mut out = std::fs::OpenOptions::new().write(true).create_new(true).open(dst)?;
  std::io::copy(&mut std::fs::File::open(src)?, &mut out)?;
  out.set_permissions(meta.permissions())
}

fn name_of(rel: &str) -> Result<&str, String> {
  Path::new(rel).file_name().and_then(|n| n.to_str()).ok_or_else(|| format!("{rel}: no name"))
}

/// Copies `from` into the folder `to_dir` (paste, ⌥-drag). A name already taken there becomes
/// `name copy` (or what `naming` says), so pasting into the same folder duplicates. Returns the new path.
pub fn copy(root: &Path, from: &str, to_dir: &str, naming: Naming) -> Result<String, String> {
  let src = check_existing(root, from)?;
  target_dir(root, to_dir)?;
  if !to_dir.is_empty() && Path::new(to_dir).starts_with(Path::new(from)) {
    return Err(format!("{from}: cannot copy a folder into itself"));
  }
  let rel = free_name(root, to_dir, name_of(from)?, src.is_dir(), naming)?;
  copy_entry(&src, &root.join(&rel)).map_err(|e| format!("{from} → {rel}: {e}"))?;
  Ok(rel)
}

/// Moves `from` into the folder `to_dir` (cut/paste, drag and drop). Fails when the name is
/// taken there; the webview asks and trashes the old one first if the user wants it replaced.
pub fn move_into(root: &Path, from: &str, to_dir: &str) -> Result<String, String> {
  target_dir(root, to_dir)?;
  let name = name_of(from)?;
  let to = if to_dir.is_empty() { name.to_string() } else { format!("{to_dir}/{name}") };
  if to == from {
    return Ok(to);
  }
  rename(root, from, &to)?;
  Ok(to)
}

/// Copies files dropped from Finder (absolute paths) into `to_dir`, with copy naming on
/// collisions. Returns the new paths; the first failure stops the rest.
pub fn import(root: &Path, sources: &[PathBuf], to_dir: &str, naming: Naming) -> Result<Vec<String>, String> {
  let dir_abs = target_dir(root, to_dir)?;
  let mut out = Vec::new();
  for src in sources {
    let name = src.file_name().and_then(|n| n.to_str()).ok_or_else(|| format!("{}: no name", src.display()))?;
    let real = src.canonicalize().map_err(|e| format!("{}: {e}", src.display()))?;
    if dir_abs.starts_with(&real) {
      return Err(format!("{}: cannot copy a folder into itself", src.display()));
    }
    let rel = free_name(root, to_dir, name, real.is_dir(), naming)?;
    copy_entry(src, &root.join(&rel)).map_err(|e| format!("{} → {rel}: {e}", src.display()))?;
    out.push(rel);
  }
  Ok(out)
}

/// Deletes larger than this (all files of a folder together) go to the Trash without an undo copy.
pub const UNDO_MAX_BYTES: u64 = 64 * 1024 * 1024;
/// Undo copies kept; older ones are dropped (the explorer's undo history is as long).
pub const UNDO_MAX_STEPS: usize = 50;

/// Bytes under `path` (symlinks count as nothing), stopping once past `limit`.
fn size_within(path: &Path, limit: u64) -> std::io::Result<Option<u64>> {
  let meta = path.symlink_metadata()?;
  if meta.file_type().is_symlink() {
    return Ok(Some(0));
  }
  if !meta.is_dir() {
    return Ok((meta.len() <= limit).then_some(meta.len()));
  }
  let mut total = 0;
  for entry in std::fs::read_dir(path)? {
    match size_within(&entry?.path(), limit - total)? {
      Some(n) => total += n,
      None => return Ok(None),
    }
  }
  Ok(Some(total))
}

/// A fresh undo token: hex, unique within this process and across restarts.
fn undo_token() -> String {
  use std::sync::atomic::{AtomicU64, Ordering};
  static SEQ: AtomicU64 = AtomicU64::new(0);
  let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
  format!("{nanos:x}{:04x}", SEQ.fetch_add(1, Ordering::Relaxed) & 0xffff)
}

fn check_token(token: &str) -> Result<(), String> {
  if token.is_empty() || token.len() > 48 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
    return Err("not an undo token".into());
  }
  Ok(())
}

/// Moves `rel` to the Trash (VS Code's default `files.enableTrash`), first keeping a copy in
/// `stash` so the delete can be undone (the Trash has no portable restore). Returns the token for
/// [`restore`], or `None` when the entry was too large to copy, in which case it is only trashed.
/// Old copies beyond [`UNDO_MAX_STEPS`] are dropped.
pub fn trash_with_undo(root: &Path, rel: &str, stash: &Path) -> Result<Option<String>, String> {
  delete_with_undo(root, rel, stash, |p| trash::delete(p).map_err(|e| e.to_string()))
}

fn delete_with_undo(root: &Path, rel: &str, stash: &Path, delete: impl FnOnce(&Path) -> Result<(), String>) -> Result<Option<String>, String> {
  let path = check_existing(root, rel)?;
  let token = match size_within(&path, UNDO_MAX_BYTES) {
    Ok(Some(_)) => {
      let token = undo_token();
      let dir = stash.join(&token);
      let kept = std::fs::create_dir_all(&dir).and_then(|_| copy_entry(&path, &dir.join("entry")));
      match kept {
        Ok(()) => Some(token),
        Err(e) => {
          let _ = std::fs::remove_dir_all(&dir);
          log::warn!("delete {rel}: no undo copy: {e}");
          None
        }
      }
    }
    _ => None,
  };
  if let Err(e) = delete(&path) {
    if let Some(t) = &token {
      let _ = std::fs::remove_dir_all(stash.join(t));
    }
    return Err(format!("{rel}: {e}"));
  }
  prune_stash(stash, UNDO_MAX_STEPS);
  Ok(token)
}

/// Undoes a [`trash_with_undo`]: puts the kept copy back at `rel`, which must be free again.
pub fn restore(root: &Path, rel: &str, token: &str, stash: &Path) -> Result<(), String> {
  check_token(token)?;
  let dst = check_new(root, rel)?;
  let dir = stash.join(token);
  let kept = dir.join("entry");
  kept.symlink_metadata().map_err(|_| format!("{rel}: the undo copy is gone"))?;
  create_parents(rel, &dst)?;
  if std::fs::rename(&kept, &dst).is_err() {
    // Another volume: copy, then drop the stash.
    copy_entry(&kept, &dst).map_err(|e| format!("{rel}: {e}"))?;
  }
  let _ = std::fs::remove_dir_all(&dir);
  Ok(())
}

/// Keeps the newest `keep` undo copies (tokens sort by time).
pub fn prune_stash(stash: &Path, keep: usize) {
  let Ok(read) = std::fs::read_dir(stash) else { return };
  let mut tokens: Vec<String> = read.filter_map(|e| e.ok()?.file_name().into_string().ok()).filter(|t| check_token(t).is_ok()).collect();
  // Same-length hex of the same clock: longer = later, then lexical.
  tokens.sort_by(|a, b| a.len().cmp(&b.len()).then_with(|| a.cmp(b)));
  let drop = tokens.len().saturating_sub(keep);
  for t in &tokens[..drop] {
    let _ = std::fs::remove_dir_all(stash.join(t));
  }
}

/// Deletes `rel` for good, for when `files.enableTrash` is off (a symlink is removed, never what
/// it points to).
pub fn delete_for_good(root: &Path, rel: &str) -> Result<(), String> {
  let path = check_existing(root, rel)?;
  let meta = path.symlink_metadata().map_err(|e| format!("{rel}: {e}"))?;
  let result = if meta.is_dir() { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
  result.map_err(|e| format!("{rel}: {e}"))
}

/// Shows `rel` selected in Finder (Explorer on Windows, the containing folder elsewhere).
pub fn reveal(root: &Path, rel: &str) -> Result<(), String> {
  let path = if rel.is_empty() { root.to_path_buf() } else { check_existing(root, rel)? };
  reveal_path(&path).map_err(|e| format!("reveal {rel}: {e}"))
}

/// `reveal` for a path the caller already checked (e.g. a snap folder outside the workspace).
pub fn reveal_path(path: &Path) -> Result<(), String> {
  let mut cmd;
  #[cfg(target_os = "macos")]
  {
    cmd = std::process::Command::new("open");
    cmd.arg("-R").arg(path);
  }
  #[cfg(target_os = "windows")]
  {
    cmd = std::process::Command::new("explorer");
    cmd.arg(format!("/select,{}", path.display()));
  }
  #[cfg(not(any(target_os = "macos", target_os = "windows")))]
  {
    cmd = std::process::Command::new("xdg-open");
    cmd.arg(path.parent().unwrap_or(path));
  }
  cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {

  #[test]
  fn delete_keeps_an_undo_copy_and_restores_it() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("ws");
    let stash = tmp.path().join("stash");
    std::fs::create_dir_all(root.join("src/deep")).unwrap();
    std::fs::write(root.join("src/deep/a.ts"), "one").unwrap();
    let root = root.canonicalize().unwrap();
    // Deleted outright rather than trashed, so the test leaves nothing in the user's Trash.
    let token = delete_with_undo(&root, "src", &stash, |p| std::fs::remove_dir_all(p).map_err(|e| e.to_string())).unwrap();
    let token = token.expect("small folders get an undo copy");
    assert!(!root.join("src").exists());
    restore(&root, "src", &token, &stash).unwrap();
    assert_eq!(std::fs::read_to_string(root.join("src/deep/a.ts")).unwrap(), "one");
    assert!(!stash.join(&token).exists());
    assert!(restore(&root, "src", &token, &stash).is_err(), "a token restores once");
  }

  #[test]
  fn restore_refuses_bad_tokens_and_taken_paths() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let stash = root.join(".stash");
    std::fs::create_dir_all(stash.join("abc1/entry")).unwrap();
    std::fs::write(root.join("x"), "").unwrap();
    assert!(restore(&root, "y", "../etc", &stash).is_err());
    assert!(restore(&root, "x", "abc1", &stash).unwrap_err().contains("already exists"));
    assert!(restore(&root, "../y", "abc1", &stash).is_err());
    restore(&root, "y", "abc1", &stash).unwrap();
    assert!(root.join("y").is_dir());
  }

  #[test]
  fn prunes_the_oldest_undo_copies() {
    let tmp = tempfile::tempdir().unwrap();
    for t in ["0a", "0b", "1a0", "ff", "not-a-token"] {
      std::fs::create_dir(tmp.path().join(t)).unwrap();
    }
    prune_stash(tmp.path(), 2);
    let mut left: Vec<String> = std::fs::read_dir(tmp.path()).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    left.sort();
    assert_eq!(left, ["1a0", "ff", "not-a-token"]);
  }

  #[test]
  fn size_stops_past_the_limit() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("a"), vec![0u8; 10]).unwrap();
    std::fs::write(tmp.path().join("b"), vec![0u8; 10]).unwrap();
    assert_eq!(size_within(tmp.path(), 100).unwrap(), Some(20));
    assert_eq!(size_within(tmp.path(), 15).unwrap(), None);
  }

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

  #[test]
  fn increments_names_like_vscode() {
    assert_eq!(increment_name("a.ts", false), "a copy.ts");
    assert_eq!(increment_name("a copy.ts", false), "a copy 2.ts");
    assert_eq!(increment_name("a copy 9.ts", false), "a copy 10.ts");
    assert_eq!(increment_name("Makefile", false), "Makefile copy");
    assert_eq!(increment_name(".env", false), ".env copy");
    assert_eq!(increment_name("v1.2", true), "v1.2 copy");
    assert_eq!(increment_name("src copy", true), "src copy 2");
    assert_eq!(increment_name("x.tar.gz", false), "x.tar copy.gz");
    assert_eq!(increment_name("a copy x.ts", false), "a copy x copy.ts");
  }

  #[test]
  fn increments_names_smartly_like_vscode() {
    let s = |n: &str| increment_name_smart(n, false);
    assert_eq!(s("file.1.txt"), "file.2.txt");
    assert_eq!(s("file-09.txt"), "file-10.txt");
    assert_eq!(s("1.file.txt"), "2.file.txt");
    assert_eq!(s("a12.b.txt"), "a13.b.txt");
    assert_eq!(s("01.txt"), "02.txt");
    assert_eq!(s("file.txt"), "file.1.txt");
    assert_eq!(s("123"), "124");
    assert_eq!(s("file"), "file1");
    assert_eq!(increment_name_smart("folder.1", true), "folder.2");
    assert_eq!(increment_name_smart("1.folder", true), "2.folder");
    assert_eq!(increment_name_smart("folder", true), "folder.1");
  }

  #[test]
  fn copy_naming_smart_and_disabled() {
    let (_tmp, root) = ws();
    assert_eq!(copy(&root, "src/a.txt", "src", Naming::Smart).unwrap(), "src/a.1.txt");
    assert_eq!(copy(&root, "src/a.txt", "src", Naming::Smart).unwrap(), "src/a.2.txt");
    assert!(copy(&root, "src/a.txt", "src", Naming::Disabled).unwrap_err().contains("already exists"));
    assert_eq!(copy(&root, "src/a.txt", "", Naming::Disabled).unwrap(), "a.txt");
  }

  #[test]
  fn deletes_for_good_without_following_out() {
    let (_tmp, root) = ws();
    std::fs::create_dir_all(root.join("gone/deep")).unwrap();
    std::fs::write(root.join("gone/deep/x.txt"), "x").unwrap();
    delete_for_good(&root, "gone").unwrap();
    assert!(!root.join("gone").exists());
    delete_for_good(&root, "src/a.txt").unwrap();
    assert!(!root.join("src/a.txt").exists());
    assert!(delete_for_good(&root, "missing").is_err());
    assert!(delete_for_good(&root, "../x").is_err());
  }

  #[test]
  fn copy_duplicates_with_copy_names() {
    let (_tmp, root) = ws();
    assert_eq!(copy(&root, "src/a.txt", "src", Naming::Simple).unwrap(), "src/a copy.txt");
    assert_eq!(copy(&root, "src/a.txt", "src", Naming::Simple).unwrap(), "src/a copy 2.txt");
    assert_eq!(copy(&root, "src/a.txt", "", Naming::Simple).unwrap(), "a.txt");
    assert_eq!(std::fs::read_to_string(root.join("src/a copy 2.txt")).unwrap(), "a");
    assert!(copy(&root, "src/a.txt", "src/a.txt", Naming::Simple).unwrap_err().contains("not a folder"));
    assert!(copy(&root, "src/a.txt", "..", Naming::Simple).is_err());
  }

  #[test]
  fn copy_folder_recursively() {
    let (_tmp, root) = ws();
    std::fs::create_dir_all(root.join("src/deep/er")).unwrap();
    std::fs::write(root.join("src/deep/er/x.rs"), "x").unwrap();
    std::fs::create_dir(root.join("dest")).unwrap();
    assert_eq!(copy(&root, "src", "dest", Naming::Simple).unwrap(), "dest/src");
    assert_eq!(std::fs::read_to_string(root.join("dest/src/deep/er/x.rs")).unwrap(), "x");
    assert_eq!(std::fs::read_to_string(root.join("dest/src/a.txt")).unwrap(), "a");
    assert_eq!(copy(&root, "src", "", Naming::Simple).unwrap(), "src copy");
    assert!(root.join("src copy/deep/er/x.rs").is_file());
    assert!(copy(&root, "src", "src/deep", Naming::Simple).unwrap_err().contains("into itself"));
  }

  #[test]
  fn move_across_folders_without_overwriting() {
    let (_tmp, root) = ws();
    std::fs::create_dir(root.join("other")).unwrap();
    assert_eq!(move_into(&root, "src/a.txt", "other").unwrap(), "other/a.txt");
    assert!(!root.join("src/a.txt").exists());
    std::fs::write(root.join("src/a.txt"), "new").unwrap();
    assert!(move_into(&root, "src/a.txt", "other").unwrap_err().contains("already exists"));
    assert_eq!(std::fs::read_to_string(root.join("other/a.txt")).unwrap(), "a");
    assert_eq!(move_into(&root, "other", "src").unwrap(), "src/other");
    assert!(root.join("src/other/a.txt").is_file());
    assert!(move_into(&root, "src", "src/other").unwrap_err().contains("into itself"));
    assert_eq!(move_into(&root, "src/a.txt", "src").unwrap(), "src/a.txt");
  }

  #[test]
  fn import_copies_external_files_in() {
    let (tmp, root) = ws();
    let outside = tmp.path().join("drop");
    std::fs::create_dir_all(outside.join("dir")).unwrap();
    std::fs::write(outside.join("dir/f.txt"), "f").unwrap();
    std::fs::write(outside.join("a.txt"), "outside").unwrap();
    let got = import(&root, &[outside.join("a.txt"), outside.join("dir")], "src", Naming::Simple).unwrap();
    assert_eq!(got, ["src/a copy.txt", "src/dir"]);
    assert_eq!(std::fs::read_to_string(root.join("src/a copy.txt")).unwrap(), "outside");
    assert_eq!(std::fs::read_to_string(root.join("src/a.txt")).unwrap(), "a");
    assert!(root.join("src/dir/f.txt").is_file());
    assert!(import(&root, &[root.join("src")], "src", Naming::Simple).unwrap_err().contains("into itself"));
  }
}
