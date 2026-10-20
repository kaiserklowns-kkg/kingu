//! New projects (Orca's `repos:create`): a folder with `git init` and an empty initial commit, so
//! HEAD is on a branch and worktrees can fork from it; and `git init` for an open folder that is
//! not a repository yet (VS Code's Initialize Repository; the ADE also wants the first commit).

use std::path::{Path, PathBuf};


use crate::i18n::msg::WorkspaceMsg;
use crate::tr;
use crate::workspace::Workspace;

fn git(dir: &Path, args: &[&str]) -> Result<(), String> {
  crate::git::run(dir, args).map(|_| ())
}

/// Tests' initial commits must not depend on (or prompt through) the user's global git config.
#[cfg(test)]
const COMMIT_CONFIG: &[&str] = &["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"];
#[cfg(not(test))]
const COMMIT_CONFIG: &[&str] = &[];

/// The folder is the top of a repository already (a parent repository does not count).
fn is_repo_root(dir: &Path) -> bool {
  dir.join(".git").exists()
}

/// `git init` in `dir`, plus an empty "Initial commit" when `initial_commit`. A failed commit
/// removes the `.git` this created, so the folder is as it was (Orca).
pub fn init(dir: &Path, initial_commit: bool) -> Result<(), String> {
  init_with(dir, initial_commit, None)
}

/// [`init`] on `branch` (VS Code's `git.defaultBranchName`, `git init -b`); `None` keeps git's
/// own `init.defaultBranch`.
pub fn init_with(dir: &Path, initial_commit: bool, branch: Option<&str>) -> Result<(), String> {
  let branch = branch.map(str::trim).filter(|b| !b.is_empty());
  if !dir.is_absolute() || !dir.is_dir() {
    return Err(tr!(WorkspaceMsg::NotAFolder, path = dir.display()));
  }
  if is_repo_root(dir) {
    return Err(tr!(WorkspaceMsg::AlreadyRepo, path = dir.display()));
  }
  let mut args = vec!["init"];
  if let Some(b) = branch {
    if b.starts_with('-') || crate::git::run(dir, &["check-ref-format", "--branch", b]).is_err() {
      return Err(tr!(WorkspaceMsg::BadDefaultBranch, name = format!("{b:?}")));
    }
    args.extend(["-b", b]);
  }
  git(dir, &args).map_err(|e| tr!(WorkspaceMsg::InitFailed, detail = e))?;
  if !initial_commit {
    return Ok(());
  }
  let mut args = COMMIT_CONFIG.to_vec();
  args.extend(["commit", "--allow-empty", "-m", "Initial commit"]);
  if let Err(e) = git(dir, &args) {
    let _ = std::fs::remove_dir_all(dir.join(".git"));
    let lower = e.to_lowercase();
    return Err(if lower.contains("please tell me who you are") || lower.contains("user.name") || lower.contains("user.email") {
      tr!(WorkspaceMsg::IdentityHint)
    } else {
      tr!(WorkspaceMsg::FirstCommitFailed, detail = e)
    });
  }
  Ok(())
}

/// A project folder name: one path segment, not `.`/`..`, no control characters.
fn check_name(name: &str) -> Result<(), String> {
  if name.is_empty() {
    return Err(tr!(WorkspaceMsg::NameRequired));
  }
  if name.contains(['/', '\\']) || name == "." || name == ".." || name.starts_with('-') || name.chars().any(char::is_control) || name.len() > 255 {
    return Err(tr!(WorkspaceMsg::BadName, name = format!("{name:?}")));
  }
  Ok(())
}

/// Creates `<parent>/<name>` (an existing empty folder is fine, a non-empty one is refused), then
/// `git init` with an empty initial commit. A folder this created is removed again on failure.
pub fn create(parent: &Path, name: &str) -> Result<PathBuf, String> {
  let name = name.trim();
  check_name(name)?;
  if !parent.is_absolute() {
    return Err(tr!(WorkspaceMsg::ParentNotAbsolute));
  }
  std::fs::create_dir_all(parent).map_err(|e| tr!(WorkspaceMsg::CreateFolderFailed, path = parent.display(), detail = e))?;
  let target = parent.join(name);
  let created = match std::fs::create_dir(&target) {
    Ok(()) => true,
    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
      let empty = target.is_dir() && !target.is_symlink() && std::fs::read_dir(&target).is_ok_and(|mut d| d.next().is_none());
      if !empty {
        return Err(tr!(WorkspaceMsg::NotEmpty, name));
      }
      false
    }
    Err(e) => return Err(tr!(WorkspaceMsg::CreateFolderFailed, path = target.display(), detail = e)),
  };
  if let Err(e) = init(&target, true) {
    if created {
      let _ = std::fs::remove_dir_all(&target);
    }
    return Err(e);
  }
  log::info!("created project {}", target.display());
  Ok(target)
}

/// `git init` in the open folder (`initial_commit` from the ADE, which needs a branch to fork
/// worktrees from).
#[tauri::command]
pub async fn git_init(ws: Workspace, initial_commit: Option<bool>, default_branch: Option<String>) -> Result<(), String> {
  let root = ws.root()?;
  tauri::async_runtime::spawn_blocking(move || init_with(&root, initial_commit.unwrap_or(false), default_branch.as_deref())).await.map_err(|e| e.to_string())??;
  log::info!("git init in the open folder");
  Ok(())
}

/// Creates a new project under `parent`; returns its path to open.
#[tauri::command]
pub async fn project_create(parent: String, name: String) -> Result<String, String> {
  tauri::async_runtime::spawn_blocking(move || create(Path::new(&parent), &name).map(|p| p.display().to_string())).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
  use super::*;

  fn log(dir: &Path) -> String {
    String::from_utf8(crate::git::run(dir, &["log", "--format=%s"]).unwrap()).unwrap()
  }

  #[test]
  fn creates_a_project_with_an_initial_commit() {
    let tmp = tempfile::tempdir().unwrap();
    let parent = tmp.path().join("kingu/projects");
    let p = create(&parent, " demo ").unwrap();
    assert_eq!(p, parent.join("demo"));
    assert_eq!(log(&p).trim(), "Initial commit");
    assert!(create(&parent, "demo").unwrap_err().contains("not empty"));
    std::fs::create_dir(parent.join("empty")).unwrap();
    assert!(create(&parent, "empty").is_ok());
    for bad in ["", "a/b", "..", ".", "-x"] {
      assert!(create(&parent, bad).is_err(), "{bad:?}");
    }
    assert!(create(Path::new("rel"), "x").is_err());
  }

  #[test]
  fn inits_an_existing_folder_once() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("plain");
    std::fs::create_dir(&dir).unwrap();
    std::fs::write(dir.join("notes.txt"), "x").unwrap();
    init(&dir, false).unwrap();
    assert!(dir.join(".git").is_dir());
    assert!(crate::git::run(&dir, &["rev-parse", "--verify", "HEAD"]).is_err(), "no commit without initial_commit");
    assert!(init(&dir, false).unwrap_err().contains("already a git repository"));

    let trunk = tmp.path().join("trunk");
    std::fs::create_dir(&trunk).unwrap();
    assert!(init_with(&trunk, false, Some("-x")).unwrap_err().contains("git.defaultBranchName"));
    assert!(init_with(&trunk, false, Some("a b")).is_err());
    init_with(&trunk, false, Some("trunk")).unwrap();
    let head = crate::git::run(&trunk, &["symbolic-ref", "--short", "HEAD"]).unwrap();
    assert_eq!(String::from_utf8_lossy(&head).trim(), "trunk");

    let ade = tmp.path().join("ade");
    std::fs::create_dir(&ade).unwrap();
    std::fs::write(ade.join("keep.txt"), "x").unwrap();
    init(&ade, true).unwrap();
    assert_eq!(log(&ade).trim(), "Initial commit");
    let tracked = String::from_utf8(crate::git::run(&ade, &["ls-files"]).unwrap()).unwrap();
    assert!(tracked.is_empty(), "the initial commit is empty");
    assert!(init(&tmp.path().join("missing"), false).is_err());
  }
}
