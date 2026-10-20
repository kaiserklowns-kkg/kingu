//! The added projects (Orca's repos list): every folder the Agents side bar shows at once, each
//! with its tasks and agent status, while one of them is the open folder. Kept in
//! `<app data>/projects.json` in the order they were added. A folder is added from the palette
//! (Agents: Add Project…) or when it is opened (`kingu.projects.addOnOpen`), and removed from the
//! side bar. Commands that read another project than the open folder take its root explicitly
//! and check it here first ([`Projects::check`]): only an added project (or the open folder) is
//! read. Creating new project folders is project.rs.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::State;

use crate::i18n::msg::ProjectsMsg;
use crate::tr;
use crate::workspace::{Workspace, canonical_dir};

/// More than a side bar can show usefully; each one is polled for its tasks.
pub const MAX_PROJECTS: usize = 50;

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq)]
pub struct Project {
  pub path: PathBuf,
  /// Unix milliseconds.
  #[serde(default)]
  pub added_at: u64,
}

#[derive(serde::Serialize, serde::Deserialize, Default, Debug, Clone, PartialEq)]
struct ProjectsData {
  #[serde(default)]
  projects: Vec<Project>,
}

/// What `projects_add` did: the project, and whether it was there already.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
pub struct Added {
  pub project: Project,
  pub existed: bool,
}

/// `projects.json`. A missing or corrupt file reads as empty; writes go through a temporary file.
pub struct Projects {
  file: PathBuf,
  data: Mutex<ProjectsData>,
}

/// The main checkout of a linked worktree whose `.git` file is in `dir` itself (Orca adds a
/// linked worktree of a tracked repository as that repository); `None` for anything else.
fn main_checkout(dir: &Path) -> Option<PathBuf> {
  if !dir.join(".git").is_file() {
    return None;
  }
  let (common, git_dir) = crate::git_queue::repo_keys(dir);
  if common == git_dir || common.file_name()? != ".git" {
    return None;
  }
  common.parent().map(Path::to_path_buf).filter(|p| p != dir)
}

fn now_ms() -> u64 {
  std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Projects {
  pub fn load(file: PathBuf) -> Self {
    let mut data: ProjectsData = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let mut seen = std::collections::HashSet::new();
    data.projects.retain(|p| p.path.is_absolute() && seen.insert(p.path.clone()));
    data.projects.truncate(MAX_PROJECTS);
    Self { file, data: Mutex::new(data) }
  }

  pub fn list(&self) -> Vec<Project> {
    self.data.lock().unwrap_or_else(|e| e.into_inner()).projects.clone()
  }

  /// Adds the folder `dir` (canonicalized; a linked worktree of an added repository is that
  /// repository) at the end; an added one stays where it is.
  pub fn add(&self, dir: &Path) -> Result<Added, String> {
    let path = canonical_dir(dir).map_err(|_| tr!(ProjectsMsg::NotAFolder, path = dir.display()))?;
    let main = main_checkout(&path);
    let mut found = None;
    self.update(|d| {
      if let Some(p) = d.projects.iter().find(|p| p.path == path || main.as_ref() == Some(&p.path)) {
        found = Some(Added { project: p.clone(), existed: true });
        return Ok(());
      }
      if d.projects.len() >= MAX_PROJECTS {
        return Err(tr!(ProjectsMsg::TooMany, max = MAX_PROJECTS));
      }
      let project = Project { path: path.clone(), added_at: now_ms() };
      d.projects.push(project.clone());
      found = Some(Added { project, existed: false });
      Ok(())
    })?;
    found.ok_or_else(|| "project not added".into())
  }

  /// Removes `dir` (as given, or canonicalized: a folder that is gone can still be removed).
  pub fn remove(&self, dir: &Path) -> Result<(), String> {
    let canonical = dir.canonicalize().ok();
    self.update(|d| {
      d.projects.retain(|p| p.path != dir && canonical.as_ref() != Some(&p.path));
      Ok(())
    })
  }

  /// `root` canonicalized, when it is an added project or the open folder `open`; the error
  /// otherwise (a webview may not read any folder it names).
  pub fn check(&self, root: &str, open: Option<&Path>) -> Result<PathBuf, String> {
    // A project whose folder was moved or deleted reads as that, not as "not added".
    let path = Path::new(root).canonicalize().map_err(|_| tr!(ProjectsMsg::NotAFolder, path = root))?;
    if open == Some(path.as_path()) || self.data.lock().unwrap_or_else(|e| e.into_inner()).projects.iter().any(|p| p.path == path) {
      Ok(path)
    } else {
      Err(tr!(ProjectsMsg::NotAdded, path = root))
    }
  }

  fn update(&self, f: impl FnOnce(&mut ProjectsData) -> Result<(), String>) -> Result<(), String> {
    let mut data = self.data.lock().unwrap_or_else(|e| e.into_inner());
    let mut next = data.clone();
    f(&mut next)?;
    if next == *data {
      return Ok(());
    }
    let json = serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?;
    if let Some(dir) = self.file.parent() {
      std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let tmp = self.file.with_extension("json.tmp");
    std::fs::write(&tmp, json).and_then(|_| std::fs::rename(&tmp, &self.file)).map_err(|e| format!("{}: {e}", self.file.display()))?;
    *data = next;
    Ok(())
  }
}

/// The folder a command reads: `root` when given (checked: an added project or the open folder),
/// else the open folder (`None` with no folder open).
pub fn root_arg(ws: &Workspace, projects: &Projects, root: Option<String>) -> Result<Option<PathBuf>, String> {
  match root {
    Some(r) => projects.check(&r, ws.current().as_deref()).map(Some),
    None => Ok(ws.current()),
  }
}

#[tauri::command]
pub fn projects_list(projects: State<'_, Projects>) -> Vec<Project> {
  projects.list()
}

#[tauri::command]
pub fn projects_add(projects: State<'_, Projects>, path: String) -> Result<Added, String> {
  let added = projects.add(Path::new(&path))?;
  if !added.existed {
    log::info!("project added: {}", added.project.path.display());
  }
  Ok(added)
}

#[tauri::command]
pub fn projects_remove(projects: State<'_, Projects>, path: String) -> Result<(), String> {
  projects.remove(Path::new(&path))?;
  log::info!("project removed: {path}");
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn git(dir: &Path, args: &[&str]) {
    let out = std::process::Command::new("git").current_dir(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
  }

  #[test]
  fn adds_once_in_order_and_survives_a_reload() {
    let (data, a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let file = data.path().join("projects.json");
    let p = Projects::load(file.clone());
    assert!(p.list().is_empty());
    let first = p.add(a.path()).unwrap();
    assert!(!first.existed);
    assert_eq!(first.project.path, a.path().canonicalize().unwrap());
    p.add(b.path()).unwrap();
    // Again, through another spelling of the same folder.
    let again = p.add(&a.path().join(".")).unwrap();
    assert!(again.existed);
    assert_eq!(again.project, first.project);
    let reloaded = Projects::load(file);
    assert_eq!(reloaded.list().iter().map(|p| p.path.clone()).collect::<Vec<_>>(), vec![a.path().canonicalize().unwrap(), b.path().canonicalize().unwrap()]);
  }

  #[test]
  fn rejects_files_and_missing_folders_and_reads_a_corrupt_file_as_empty() {
    let data = tempfile::tempdir().unwrap();
    std::fs::write(data.path().join("f.txt"), "").unwrap();
    std::fs::write(data.path().join("projects.json"), "{not json").unwrap();
    let p = Projects::load(data.path().join("projects.json"));
    assert!(p.list().is_empty());
    assert!(p.add(&data.path().join("f.txt")).unwrap_err().contains("not a folder"));
    assert!(p.add(&data.path().join("missing")).is_err());
  }

  #[test]
  fn removes_by_path_even_when_the_folder_is_gone() {
    let data = tempfile::tempdir().unwrap();
    let a = data.path().join("a");
    std::fs::create_dir(&a).unwrap();
    let p = Projects::load(data.path().join("projects.json"));
    let added = p.add(&a).unwrap().project.path;
    std::fs::remove_dir(&a).unwrap();
    p.remove(&added).unwrap();
    assert!(p.list().is_empty());
  }

  #[test]
  fn only_added_projects_and_the_open_folder_pass_the_check() {
    let (data, a, b, open) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let p = Projects::load(data.path().join("projects.json"));
    p.add(a.path()).unwrap();
    let open_root = open.path().canonicalize().unwrap();
    assert_eq!(p.check(a.path().to_str().unwrap(), None).unwrap(), a.path().canonicalize().unwrap());
    assert!(p.check(b.path().to_str().unwrap(), Some(&open_root)).unwrap_err().contains("not an added project"));
    assert_eq!(p.check(open.path().to_str().unwrap(), Some(&open_root)).unwrap(), open_root);
    assert!(p.check("/definitely/not/here", None).unwrap_err().contains("not a folder"));
    // Inside an added project is not the project.
    std::fs::create_dir(a.path().join("sub")).unwrap();
    assert!(p.check(a.path().join("sub").to_str().unwrap(), None).is_err());

    let ws = Workspace::new(Some(open_root.clone()));
    assert_eq!(root_arg(&ws, &p, None).unwrap(), Some(open_root));
    assert!(root_arg(&ws, &p, Some(b.path().display().to_string())).is_err());
    assert_eq!(root_arg(&Workspace::new(None), &p, None).unwrap(), None);
  }

  #[test]
  fn a_linked_worktree_of_an_added_repository_is_that_repository() {
    let (data, repo) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let r = repo.path();
    git(r, &["init", "-q", "-b", "main"]);
    git(r, &["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"]);
    let wt = r.join("wt");
    git(r, &["worktree", "add", "-q", "-b", "side", wt.to_str().unwrap()]);
    assert_eq!(main_checkout(&wt), Some(r.canonicalize().unwrap()));
    assert_eq!(main_checkout(r), None);

    let p = Projects::load(data.path().join("projects.json"));
    // Not tracked yet: the worktree is a project of its own (Orca does the same).
    let alone = p.add(&wt).unwrap();
    assert!(!alone.existed);
    p.remove(&alone.project.path).unwrap();
    let main = p.add(r).unwrap().project;
    let wt_added = p.add(&wt).unwrap();
    assert!(wt_added.existed);
    assert_eq!(wt_added.project, main);
    assert_eq!(p.list().len(), 1);
  }

  #[test]
  fn stops_at_the_limit() {
    let data = tempfile::tempdir().unwrap();
    let p = Projects::load(data.path().join("projects.json"));
    for i in 0..MAX_PROJECTS {
      let d = data.path().join(format!("p{i}"));
      std::fs::create_dir(&d).unwrap();
      p.add(&d).unwrap();
    }
    let extra = data.path().join("extra");
    std::fs::create_dir(&extra).unwrap();
    assert!(p.add(&extra).unwrap_err().contains(&MAX_PROJECTS.to_string()));
  }
}
