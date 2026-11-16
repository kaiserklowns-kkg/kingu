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
  /// The project group it sits in (Orca's `projectGroupId`); `None`: ungrouped.
  #[serde(default)]
  pub group: Option<String>,
  /// Its place inside that group (Orca's `projectGroupOrder`); lower first.
  #[serde(default)]
  pub group_order: Option<f64>,
  /// The SSH host (ssh_hosts.rs target id) the folder lives on, Orca's `connectionId`; `None`: on
  /// this computer. `path` is then the host's own path, never read here (ssh_projects.rs).
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub host: Option<String>,
}

/// A named group of projects in the side bar (Orca's ProjectGroup, shared/project-groups.js).
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq)]
pub struct ProjectGroup {
  pub id: String,
  pub name: String,
  /// The folder it was imported from (Add Folder of Projects), if any.
  #[serde(default)]
  pub parent_path: Option<PathBuf>,
  #[serde(default)]
  pub parent_group_id: Option<String>,
  /// `manual` or `folder-scan`.
  #[serde(default = "manual")]
  pub created_from: String,
  #[serde(default)]
  pub tab_order: f64,
  #[serde(default)]
  pub is_collapsed: bool,
  #[serde(default)]
  pub color: Option<String>,
  #[serde(default)]
  pub created_at: u64,
  #[serde(default)]
  pub updated_at: u64,
}

fn manual() -> String {
  "manual".into()
}

/// Orca's `normalizeProjectGroupName`: trimmed, or this when empty.
pub const UNTITLED_GROUP: &str = "Untitled group";

pub fn group_name(name: &str) -> String {
  let t = name.trim();
  if t.is_empty() { UNTITLED_GROUP.to_string() } else { t.to_string() }
}

/// Orca's `normalizeProjectGroups` + `clearMissingProjectGroupMemberships`: duplicate ids dropped,
/// names normalized, sorted by `tab_order` then name, a parent that is itself or unknown cleared,
/// and projects pointing at a missing group made ungrouped.
fn normalize(data: &mut ProjectsData) {
  let mut seen = std::collections::HashSet::new();
  data.groups.retain(|g| !g.id.is_empty() && seen.insert(g.id.clone()));
  for g in &mut data.groups {
    g.name = group_name(&g.name);
    if !g.tab_order.is_finite() {
      g.tab_order = 0.0;
    }
  }
  data.groups.sort_by(|a, b| a.tab_order.total_cmp(&b.tab_order).then_with(|| a.name.cmp(&b.name)));
  for g in &mut data.groups {
    if g.parent_group_id.as_ref().is_some_and(|p| *p == g.id || !seen.contains(p)) {
      g.parent_group_id = None;
    }
  }
  for p in &mut data.projects {
    if p.group.as_ref().is_some_and(|g| !seen.contains(g)) {
      p.group = None;
    }
  }
}

/// Orca's `getProjectGroupSubtreeIds`: `root` and every group below it.
fn subtree(groups: &[ProjectGroup], root: &str) -> std::collections::HashSet<String> {
  let mut out = std::collections::HashSet::new();
  let mut todo = vec![root.to_string()];
  while let Some(id) = todo.pop() {
    if !out.insert(id.clone()) {
      continue;
    }
    todo.extend(groups.iter().filter(|g| g.parent_group_id.as_deref() == Some(id.as_str())).map(|g| g.id.clone()));
  }
  out
}

/// Orca's `getNextProjectGroupOrder`: one past the highest order among `group`'s projects (0 when none).
fn next_order(projects: &[Project], group: Option<&str>) -> f64 {
  projects.iter().filter(|p| p.group.as_deref() == group).filter_map(|p| p.group_order.filter(|o| o.is_finite())).fold(-1.0, f64::max) + 1.0
}

#[derive(serde::Serialize, serde::Deserialize, Default, Debug, Clone, PartialEq)]
struct ProjectsData {
  #[serde(default)]
  projects: Vec<Project>,
  #[serde(default)]
  groups: Vec<ProjectGroup>,
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
    data.projects.retain(|p| p.path.is_absolute() && seen.insert((p.host.clone(), p.path.clone())));
    data.projects.truncate(MAX_PROJECTS);
    normalize(&mut data);
    Self { file, data: Mutex::new(data) }
  }

  pub fn groups(&self) -> Vec<ProjectGroup> {
    self.data.lock().unwrap_or_else(|e| e.into_inner()).groups.clone()
  }

  /// Orca's `createProjectGroup`: a new group after the others (`tab_order` = highest + 1).
  pub fn create_group(&self, name: &str, parent_path: Option<PathBuf>, parent_group_id: Option<String>, created_from: &str) -> Result<ProjectGroup, String> {
    let now = now_ms();
    let mut made = None;
    self.update(|d| {
      let order = d.groups.iter().map(|g| g.tab_order).fold(-1.0, f64::max) + 1.0;
      let n = d.groups.len();
      let parent_group_id = parent_group_id.filter(|p| d.groups.iter().any(|g| g.id == *p));
      let g = ProjectGroup {
        id: format!("pg-{now:x}-{n:x}"),
        name: group_name(name),
        parent_path,
        parent_group_id,
        created_from: if created_from == "folder-scan" { "folder-scan".into() } else { "manual".into() },
        tab_order: order,
        is_collapsed: false,
        color: None,
        created_at: now,
        updated_at: now,
      };
      d.groups.push(g.clone());
      made = Some(g);
      Ok(())
    })?;
    made.ok_or_else(|| "group not created".into())
  }

  /// Orca's `updateProjectGroup`: name (normalized, the old one kept when blank), collapsed,
  /// order and colour; `None` for a group that doesn't exist.
  pub fn update_group(&self, id: &str, name: Option<&str>, collapsed: Option<bool>, tab_order: Option<f64>, color: Option<Option<String>>) -> Result<Option<ProjectGroup>, String> {
    let mut out = None;
    self.update(|d| {
      let Some(g) = d.groups.iter_mut().find(|g| g.id == id) else { return Ok(()) };
      if let Some(n) = name {
        let t = n.trim();
        if !t.is_empty() {
          g.name = t.to_string();
        }
      }
      if let Some(c) = collapsed {
        g.is_collapsed = c;
      }
      if let Some(o) = tab_order.filter(|o| o.is_finite()) {
        g.tab_order = o;
      }
      if let Some(c) = color {
        g.color = c;
      }
      g.updated_at = now_ms();
      out = Some(g.clone());
      Ok(())
    })?;
    Ok(out)
  }

  /// Orca's `deleteProjectGroup`: the group and every group below it go; their projects stay,
  /// ungrouped. False when there was no such group.
  pub fn delete_group(&self, id: &str) -> Result<bool, String> {
    let mut deleted = false;
    self.update(|d| {
      let gone = subtree(&d.groups, id);
      let before = d.groups.len();
      d.groups.retain(|g| !gone.contains(&g.id));
      deleted = d.groups.len() != before;
      for p in &mut d.projects {
        if p.group.as_ref().is_some_and(|g| gone.contains(g)) {
          p.group = None;
        }
      }
      Ok(())
    })?;
    Ok(deleted)
  }

  /// Orca's `moveProjectToGroup`: an unknown group means ungrouped; without `order` it goes last
  /// in that group.
  pub fn set_group(&self, dir: &Path, group: Option<&str>, order: Option<f64>) -> Result<(), String> {
    self.update(|d| {
      let group = group.filter(|g| d.groups.iter().any(|x| x.id == *g)).map(str::to_string);
      let Some(i) = d.projects.iter().position(|p| p.host.is_none() && p.path == dir) else { return Ok(()) };
      let others: Vec<Project> = d.projects.iter().enumerate().filter(|(j, _)| *j != i).map(|(_, p)| p.clone()).collect();
      let order = order.filter(|o| o.is_finite()).unwrap_or_else(|| next_order(&others, group.as_deref()));
      d.projects[i].group = group;
      d.projects[i].group_order = Some(order);
      Ok(())
    })
  }

  /// The projects on this computer (every reader of folders uses these).
  pub fn list(&self) -> Vec<Project> {
    self.data.lock().unwrap_or_else(|e| e.into_inner()).projects.iter().filter(|p| p.host.is_none()).cloned().collect()
  }

  /// The projects on SSH hosts.
  pub fn remote_list(&self) -> Vec<Project> {
    self.data.lock().unwrap_or_else(|e| e.into_inner()).projects.iter().filter(|p| p.host.is_some()).cloned().collect()
  }

  /// Adds the folder `path` of SSH host `host` (already resolved to its repository there). Orca's
  /// nested import rule (`projectGroups:importNested`): a folder is known when a project has the
  /// same connection and the same path, so the same path on two hosts is two projects.
  pub fn add_remote(&self, host: &str, path: &str) -> Result<Added, String> {
    let path = PathBuf::from(path);
    let mut found = None;
    self.update(|d| {
      if let Some(p) = d.projects.iter().find(|p| p.host.as_deref() == Some(host) && p.path == path) {
        found = Some(Added { project: p.clone(), existed: true });
        return Ok(());
      }
      if d.projects.len() >= MAX_PROJECTS {
        return Err(tr!(ProjectsMsg::TooMany, max = MAX_PROJECTS));
      }
      let project = Project { path: path.clone(), added_at: now_ms(), group: None, group_order: None, host: Some(host.to_string()) };
      d.projects.push(project.clone());
      found = Some(Added { project, existed: false });
      Ok(())
    })?;
    found.ok_or_else(|| "project not added".into())
  }

  pub fn remove_remote(&self, host: &str, path: &str) -> Result<(), String> {
    self.update(|d| {
      d.projects.retain(|p| !(p.host.as_deref() == Some(host) && p.path == Path::new(path)));
      Ok(())
    })
  }

  /// `root` when it is an added project of `host` (a webview may not run git in any folder).
  pub fn check_remote(&self, host: &str, root: &str) -> Result<(), String> {
    let known = self.data.lock().unwrap_or_else(|e| e.into_inner()).projects.iter().any(|p| p.host.as_deref() == Some(host) && p.path == Path::new(root));
    if known { Ok(()) } else { Err(tr!(ProjectsMsg::NotAdded, path = root)) }
  }

  /// Adds the folder `dir` (canonicalized; a linked worktree of an added repository is that
  /// repository) at the end; an added one stays where it is.
  pub fn add(&self, dir: &Path) -> Result<Added, String> {
    let path = canonical_dir(dir).map_err(|_| tr!(ProjectsMsg::NotAFolder, path = dir.display()))?;
    let main = main_checkout(&path);
    let mut found = None;
    self.update(|d| {
      if let Some(p) = d.projects.iter().find(|p| p.host.is_none() && (p.path == path || main.as_ref() == Some(&p.path))) {
        found = Some(Added { project: p.clone(), existed: true });
        return Ok(());
      }
      if d.projects.len() >= MAX_PROJECTS {
        return Err(tr!(ProjectsMsg::TooMany, max = MAX_PROJECTS));
      }
      let project = Project { path: path.clone(), added_at: now_ms(), group: None, group_order: None, host: None };
      d.projects.push(project.clone());
      found = Some(Added { project, existed: false });
      Ok(())
    })?;
    found.ok_or_else(|| "project not added".into())
  }

  /// Moves `dir` in front of `before` (to the end when `None`); a folder that is not added is
  /// left alone. The order is the side bar's manual project order (`kingu.projects.orderBy`).
  pub fn move_before(&self, dir: &Path, before: Option<&Path>) -> Result<(), String> {
    self.update(|d| {
      let Some(from) = d.projects.iter().position(|p| p.host.is_none() && p.path == dir) else {
        return Ok(());
      };
      let project = d.projects.remove(from);
      let to = before.and_then(|b| d.projects.iter().position(|p| p.host.is_none() && p.path == b)).unwrap_or(d.projects.len());
      d.projects.insert(to, project);
      Ok(())
    })
  }

  /// Removes `dir` (as given, or canonicalized: a folder that is gone can still be removed).
  pub fn remove(&self, dir: &Path) -> Result<(), String> {
    let canonical = dir.canonicalize().ok();
    self.update(|d| {
      d.projects.retain(|p| p.host.is_some() || (p.path != dir && canonical.as_ref() != Some(&p.path)));
      Ok(())
    })
  }

  /// `root` canonicalized, when it is an added project or the open folder `open`; the error
  /// otherwise (a webview may not read any folder it names).
  pub fn check(&self, root: &str, open: Option<&Path>) -> Result<PathBuf, String> {
    // A project whose folder was moved or deleted reads as that, not as "not added".
    let path = Path::new(root).canonicalize().map_err(|_| tr!(ProjectsMsg::NotAFolder, path = root))?;
    if open == Some(path.as_path()) || self.data.lock().unwrap_or_else(|e| e.into_inner()).projects.iter().any(|p| p.host.is_none() && p.path == path) {
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
pub fn projects_move(projects: State<'_, Projects>, path: String, before: Option<String>) -> Result<(), String> {
  projects.move_before(Path::new(&path), before.as_deref().map(Path::new))?;
  Ok(())
}

#[tauri::command]
pub fn projects_remove(projects: State<'_, Projects>, path: String) -> Result<(), String> {
  projects.remove(Path::new(&path))?;
  log::info!("project removed: {path}");
  Ok(())
}

#[tauri::command]
pub fn project_groups_list(projects: State<'_, Projects>) -> Vec<ProjectGroup> {
  projects.groups()
}

#[tauri::command]
pub fn project_groups_create(projects: State<'_, Projects>, name: String, parent_group_id: Option<String>) -> Result<ProjectGroup, String> {
  projects.create_group(&name, None, parent_group_id, "manual")
}

#[tauri::command]
pub fn project_groups_update(
  projects: State<'_, Projects>,
  id: String,
  name: Option<String>,
  collapsed: Option<bool>,
  tab_order: Option<f64>,
) -> Result<Option<ProjectGroup>, String> {
  projects.update_group(&id, name.as_deref(), collapsed, tab_order, None)
}

#[tauri::command]
pub fn project_groups_delete(projects: State<'_, Projects>, id: String) -> Result<bool, String> {
  projects.delete_group(&id)
}

#[tauri::command]
pub fn project_groups_move_project(projects: State<'_, Projects>, path: String, group: Option<String>, order: Option<f64>) -> Result<(), String> {
  projects.set_group(Path::new(&path), group.as_deref(), order)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn groups_follow_orcas_rules() {
    let (data, a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let file = data.path().join("projects.json");
    let p = Projects::load(file.clone());
    let pa = p.add(a.path()).unwrap().project.path;
    let pb = p.add(b.path()).unwrap().project.path;
    let g1 = p.create_group("  ", None, None, "manual").unwrap();
    assert_eq!(g1.name, UNTITLED_GROUP);
    let g2 = p.create_group("Work", None, None, "manual").unwrap();
    assert_eq!((g1.tab_order, g2.tab_order), (0.0, 1.0));
    let child = p.create_group("Child", None, Some(g2.id.clone()), "manual").unwrap();
    assert_eq!(child.parent_group_id.as_deref(), Some(g2.id.as_str()));
    // Last in the group unless an order is given; an unknown group means ungrouped.
    p.set_group(&pa, Some(&g2.id), None).unwrap();
    p.set_group(&pb, Some(&g2.id), None).unwrap();
    let orders: Vec<_> = p.list().iter().map(|x| x.group_order).collect();
    assert_eq!(orders, vec![Some(0.0), Some(1.0)]);
    p.set_group(&pb, Some("nope"), Some(5.0)).unwrap();
    assert_eq!(p.list()[1].group, None);
    // A blank rename keeps the name.
    assert_eq!(p.update_group(&g2.id, Some("   "), Some(true), None, None).unwrap().unwrap().name, "Work");
    assert!(p.update_group("missing", Some("x"), None, None, None).unwrap().is_none());
    // Deleting a group takes its sub-groups and leaves its projects ungrouped.
    p.set_group(&pb, Some(&child.id), None).unwrap();
    assert!(p.delete_group(&g2.id).unwrap());
    assert_eq!(p.groups().iter().map(|g| g.id.clone()).collect::<Vec<_>>(), vec![g1.id.clone()]);
    assert!(p.list().iter().all(|x| x.group.is_none()));
    assert!(!p.delete_group(&g2.id).unwrap());
    // Survives a reload.
    p.set_group(&pa, Some(&g1.id), None).unwrap();
    let r = Projects::load(file.clone());
    assert_eq!(r.list()[0].group.as_deref(), Some(g1.id.as_str()));
    // A project pointing at a missing group is ungrouped on load.
    let mut raw: serde_json::Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    raw["groups"] = serde_json::json!([]);
    std::fs::write(&file, serde_json::to_vec(&raw).unwrap()).unwrap();
    assert!(Projects::load(file).list().iter().all(|x| x.group.is_none()));
  }

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
  fn moves_a_project_in_front_of_another_or_to_the_end_and_saves_it() {
    let (data, a, b, c) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let file = data.path().join("projects.json");
    let p = Projects::load(file.clone());
    let (a, b, c) = (p.add(a.path()).unwrap().project.path, p.add(b.path()).unwrap().project.path, p.add(c.path()).unwrap().project.path);
    p.move_before(&c, Some(&a)).unwrap();
    assert_eq!(p.list().iter().map(|p| p.path.clone()).collect::<Vec<_>>(), vec![c.clone(), a.clone(), b.clone()]);
    p.move_before(&a, None).unwrap();
    assert_eq!(p.list().iter().map(|p| p.path.clone()).collect::<Vec<_>>(), vec![c.clone(), b.clone(), a.clone()]);
    // An unknown folder changes nothing.
    p.move_before(&data.path().join("missing"), Some(&b)).unwrap();
    assert_eq!(Projects::load(file).list().iter().map(|p| p.path.clone()).collect::<Vec<_>>(), vec![c, b, a]);
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

  #[test]
  fn remote_projects_are_kept_apart_from_local_ones() {
    let data = tempfile::tempdir().unwrap();
    let file = data.path().join("projects.json");
    let p = Projects::load(file.clone());
    let local = data.path().canonicalize().unwrap();
    let local_str = local.to_str().unwrap();
    p.add(&local).unwrap();
    // The same path on a host is another project; on two hosts, two projects.
    assert!(!p.add_remote("ssh-a", local_str).unwrap().existed);
    assert!(p.add_remote("ssh-a", local_str).unwrap().existed);
    assert!(!p.add_remote("ssh-b", local_str).unwrap().existed);
    assert_eq!(p.list().len(), 1);
    assert_eq!(p.remote_list().len(), 2);
    // Local readers never see the host's folders; the check is per host.
    assert!(p.check_remote("ssh-a", local_str).is_ok());
    assert!(p.check_remote("ssh-c", local_str).is_err());
    // Removing the local one leaves the remote ones, and the other way round; both survive a reload.
    p.remove_remote("ssh-b", local_str).unwrap();
    let again = Projects::load(file);
    assert_eq!(again.list().len(), 1);
    assert_eq!(again.remote_list().iter().map(|r| r.host.clone()).collect::<Vec<_>>(), vec![Some("ssh-a".to_string())]);
    again.remove(&local).unwrap();
    assert!(again.list().is_empty());
    assert_eq!(again.remote_list().len(), 1);
    assert!(again.check(local_str, None).is_err());
  }
}
