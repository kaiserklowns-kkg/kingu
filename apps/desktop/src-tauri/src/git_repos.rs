//! The git repositories of a multi-root workspace (VS Code's git extension Model: one repository
//! per workspace folder, nested ones found by scanning, a repository above a folder only when
//! `git.openRepositoryInParentFolders` allows it).
//!
//! A repository is named by the directory git runs in (`dir`) and every path of it is relative to
//! that directory, the same as the first folder's repository has always been: a folder inside a
//! repository whose top level is above it runs git in the folder, so its status is the folder's
//! part of that repository.

use std::path::{Path, PathBuf};

use crate::workspace::{Workspace, locate_in};

/// How a repository was found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RepoKind {
  /// The workspace folder is the repository's top level.
  Folder,
  /// A repository inside a folder (`git.autoRepositoryDetection` scanning, `git.scanRepositories`).
  Nested,
  /// The folder is inside a repository whose top level is above it.
  Parent,
  /// A repository holding an open editor's file (`git.autoRepositoryDetection: openEditors`).
  Editor,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct RepoInfo {
  /// Where git runs; status paths are relative to it.
  pub dir: PathBuf,
  /// The workspace folder holding `dir`.
  pub folder: PathBuf,
  /// `git rev-parse --show-toplevel` (differs from `dir` for a parent folder's repository).
  pub toplevel: PathBuf,
  pub kind: RepoKind,
}

/// A folder inside a repository above it that `git.openRepositoryInParentFolders: prompt` asks about.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ParentRepo {
  pub folder: PathBuf,
  pub toplevel: PathBuf,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct Detection {
  pub repositories: Vec<RepoInfo>,
  /// Parent repositories waiting for the user's answer (`prompt`).
  pub parents: Vec<ParentRepo>,
}

/// VS Code's `git.autoRepositoryDetection`: `true`, `false`, `"subFolders"` or `"openEditors"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoDetect {
  All,
  Off,
  SubFolders,
  OpenEditors,
}

impl<'de> serde::Deserialize<'de> for AutoDetect {
  fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
    Ok(match serde_json::Value::deserialize(d)? {
      serde_json::Value::Bool(false) => AutoDetect::Off,
      serde_json::Value::String(s) if s == "subFolders" => AutoDetect::SubFolders,
      serde_json::Value::String(s) if s == "openEditors" => AutoDetect::OpenEditors,
      _ => AutoDetect::All,
    })
  }
}

impl AutoDetect {
  fn folders(self) -> bool {
    matches!(self, AutoDetect::All | AutoDetect::SubFolders)
  }
  fn editors(self) -> bool {
    matches!(self, AutoDetect::All | AutoDetect::OpenEditors)
  }
}

/// The git.* settings that pick repositories, as the webview read them.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DetectOptions {
  pub auto_repository_detection: AutoDetect,
  /// `git.repositoryScanMaxDepth`: folder levels below a workspace folder to look in; -1 = no limit.
  pub repository_scan_max_depth: i32,
  /// `git.repositoryScanIgnoredFolders`: folder names never scanned.
  pub repository_scan_ignored_folders: Vec<String>,
  /// `git.scanRepositories`: more folders to look in (absolute, or relative to each workspace folder).
  pub scan_repositories: Vec<String>,
  /// `git.ignoredRepositories`: repositories never opened (absolute, or relative to a workspace folder).
  pub ignored_repositories: Vec<String>,
  /// `git.openRepositoryInParentFolders`: `always`, `never` or `prompt`.
  pub open_repository_in_parent_folders: String,
  /// Top levels the user agreed to open from the prompt this session.
  pub allowed_parents: Vec<PathBuf>,
  /// The open editors' files (webview paths), for `openEditors`.
  pub open_editors: Vec<String>,
}

impl Default for DetectOptions {
  fn default() -> Self {
    Self {
      auto_repository_detection: AutoDetect::All,
      repository_scan_max_depth: 1,
      repository_scan_ignored_folders: vec!["node_modules".into()],
      scan_repositories: Vec::new(),
      ignored_repositories: Vec::new(),
      open_repository_in_parent_folders: "prompt".into(),
      allowed_parents: Vec::new(),
      open_editors: Vec::new(),
    }
  }
}

/// Whether `dir` holds a repository's `.git` (a folder, or a file for a worktree or submodule).
pub fn has_git(dir: &Path) -> bool {
  std::fs::symlink_metadata(dir.join(".git")).is_ok()
}

/// The top level of the repository holding `dir`, `None` outside one.
fn toplevel(dir: &Path) -> Option<PathBuf> {
  let out = crate::git::run(dir, &["rev-parse", "--show-toplevel"]).ok()?;
  let top = PathBuf::from(String::from_utf8_lossy(&out).trim());
  Some(top.canonicalize().unwrap_or(top))
}

/// Never scanned: Kingu's task worktrees are the ADE's, `.git` is git's own.
fn skipped(name: &str, ignored: &[String]) -> bool {
  name == ".git" || ignored.iter().any(|i| i == name)
}

/// Repositories below `dir` (not `dir` itself), at most `depth` levels down (-1: any depth), in
/// path order. A repository's own subfolders are scanned too (VS Code finds nested ones there).
fn scan(dir: &Path, depth: i32, ignored: &[String], out: &mut Vec<PathBuf>) {
  if depth == 0 {
    return;
  }
  let Ok(read) = std::fs::read_dir(dir) else { return };
  let mut subdirs: Vec<PathBuf> = read
    .flatten()
    .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
    .filter(|e| !skipped(&e.file_name().to_string_lossy(), ignored))
    .map(|e| e.path())
    .collect();
  subdirs.sort();
  for sub in subdirs {
    if sub.ends_with(".kingu/worktrees") {
      continue;
    }
    if has_git(&sub) {
      out.push(sub.clone());
    }
    scan(&sub, depth - 1, ignored, out);
  }
}

/// `p` absolute, or relative to `folder`.
fn under(folder: &Path, p: &str) -> PathBuf {
  let path = Path::new(p);
  if path.is_absolute() { path.to_path_buf() } else { folder.join(path) }
}

/// The repositories of a workspace with folders `roots` (each canonical), in discovery order:
/// each folder's own repository, then the ones found below it, then those of open editors.
/// `toplevel_of` answers `git rev-parse --show-toplevel` (tests pass a fake).
pub fn detect_with(roots: &[PathBuf], opts: &DetectOptions, toplevel_of: &dyn Fn(&Path) -> Option<PathBuf>) -> Detection {
  let mut found = Detection::default();
  let ignored: Vec<PathBuf> = roots.iter().flat_map(|r| opts.ignored_repositories.iter().map(move |p| under(r, p))).collect();
  let add = |found: &mut Detection, info: RepoInfo| {
    if !ignored.contains(&info.dir) && !ignored.contains(&info.toplevel) && !found.repositories.iter().any(|r| r.dir == info.dir) {
      found.repositories.push(info);
    }
  };
  let canon = |p: PathBuf| p.canonicalize().unwrap_or(p);
  let mut parents = Vec::new();
  for root in roots {
    if opts.auto_repository_detection.folders() {
      match toplevel_of(root) {
        Some(top) if top == *root => add(&mut found, RepoInfo { dir: root.clone(), folder: root.clone(), toplevel: top, kind: RepoKind::Folder }),
        Some(top) => parents.push(ParentRepo { folder: root.clone(), toplevel: top }),
        None => {}
      }
    }
    let mut nested = Vec::new();
    if opts.auto_repository_detection.folders() {
      scan(root, opts.repository_scan_max_depth, &opts.repository_scan_ignored_folders, &mut nested);
    }
    // git.scanRepositories: each path is a repository itself or holds some.
    for p in &opts.scan_repositories {
      let dir = canon(under(root, p));
      if !dir.starts_with(root) || !dir.is_dir() {
        continue;
      }
      if has_git(&dir) && dir != *root {
        nested.push(dir.clone());
      }
      scan(&dir, opts.repository_scan_max_depth, &opts.repository_scan_ignored_folders, &mut nested);
    }
    for dir in nested {
      let dir = canon(dir);
      // Another root folder inside this one is that folder's own repository.
      if roots.contains(&dir) && dir != *root {
        continue;
      }
      add(&mut found, RepoInfo { folder: root.clone(), toplevel: dir.clone(), dir, kind: RepoKind::Nested });
    }
  }
  // A folder inside a repository above it: none when that repository is open already (a root
  // folder nested in another root that is the repository).
  for p in parents {
    if found.repositories.iter().any(|r| r.dir == p.toplevel) {
      continue;
    }
    let open = match opts.open_repository_in_parent_folders.as_str() {
      "always" => true,
      "never" => false,
      _ => opts.allowed_parents.contains(&p.toplevel),
    };
    if open {
      add(&mut found, RepoInfo { dir: p.folder.clone(), folder: p.folder, toplevel: p.toplevel, kind: RepoKind::Parent });
    } else if opts.open_repository_in_parent_folders != "never" && !ignored.contains(&p.toplevel) {
      found.parents.push(p);
    }
  }
  if opts.auto_repository_detection.editors() {
    for key in &opts.open_editors {
      let Ok((root, rel)) = locate_in(roots, key) else { continue };
      let (dir, _) = file_repo(&root, &rel);
      if dir != root && !found.repositories.iter().any(|r| r.dir == dir) {
        add(&mut found, RepoInfo { folder: root.clone(), toplevel: dir.clone(), dir, kind: RepoKind::Editor });
      }
    }
  }
  found
}

pub fn detect(roots: &[PathBuf], opts: &DetectOptions) -> Detection {
  detect_with(roots, opts, &toplevel)
}

/// The repository directory of `rel` (inside root folder `root`) and the path relative to it:
/// the innermost folder below `root` holding a `.git`, else `root` itself (git finds the
/// folder's repository from there, also one above it).
pub fn file_repo(root: &Path, rel: &str) -> (PathBuf, String) {
  let parts: Vec<&str> = rel.split('/').filter(|p| !p.is_empty()).collect();
  for n in (1..parts.len()).rev() {
    let dir = parts[..n].iter().fold(root.to_path_buf(), |d, p| d.join(p));
    if has_git(&dir) {
      return (dir, parts[n..].join("/"));
    }
  }
  (root.to_path_buf(), rel.to_string())
}

/// The repository and repository-relative path of webview path `key` (a file of any root folder),
/// checked to stay inside it.
pub fn locate_file(ws: &Workspace, key: &str) -> Result<(PathBuf, String), String> {
  let (root, rel) = ws.locate(key)?;
  let (dir, rel) = file_repo(&root, &rel);
  crate::git::check_rel(&dir, &rel)?;
  Ok((dir, rel))
}

/// The repository a Source Control command names (`repo`, a webview path of the directory git runs
/// in), else the first folder. It must be a folder of the workspace or inside one.
pub fn repo_or_root(ws: &Workspace, repo: Option<&str>) -> Result<PathBuf, String> {
  match repo.filter(|r| !r.is_empty()) {
    Some(r) => {
      let dir = ws.resolve(r)?;
      if !dir.is_dir() {
        return Err(crate::tr!(crate::i18n::msg::ScmMsg::NotARepository));
      }
      Ok(dir)
    }
    None => ws.root(),
  }
}

#[tauri::command]
pub async fn git_repositories(ws: Workspace, options: Option<DetectOptions>) -> Result<Detection, String> {
  let roots = ws.roots();
  let opts = options.unwrap_or_default();
  crate::blocking(move || Ok(detect(&roots, &opts))).await
}

#[cfg(test)]
mod tests {
  use super::*;

  fn mkrepo(dir: &Path) {
    std::fs::create_dir_all(dir.join(".git")).unwrap();
  }

  /// A fake `rev-parse --show-toplevel`: the nearest ancestor (or itself) holding `.git`.
  fn fake_top(dir: &Path) -> Option<PathBuf> {
    dir.ancestors().find(|d| has_git(d)).map(Path::to_path_buf)
  }

  fn dirs(d: &Detection) -> Vec<(PathBuf, RepoKind)> {
    d.repositories.iter().map(|r| (r.dir.clone(), r.kind)).collect()
  }

  #[test]
  fn one_repository_per_folder_and_nested_ones() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let (a, b) = (base.join("a"), base.join("b"));
    mkrepo(&a);
    mkrepo(&b);
    mkrepo(&a.join("libs/deep"));
    mkrepo(&a.join("vendor"));
    mkrepo(&a.join("node_modules/pkg"));
    mkrepo(&a.join(".kingu/worktrees/task"));
    std::fs::create_dir_all(b.join("src")).unwrap();
    let roots = [a.clone(), b.clone()];
    let opts = DetectOptions::default();
    // Depth 1: `vendor` only (`libs/deep` is two levels down, node_modules is ignored).
    assert_eq!(dirs(&detect_with(&roots, &opts, &fake_top)), [(a.clone(), RepoKind::Folder), (a.join("vendor"), RepoKind::Nested), (b.clone(), RepoKind::Folder)]);
    let deep = DetectOptions { repository_scan_max_depth: -1, ..DetectOptions::default() };
    assert_eq!(
      dirs(&detect_with(&roots, &deep, &fake_top)),
      [(a.clone(), RepoKind::Folder), (a.join("libs/deep"), RepoKind::Nested), (a.join("vendor"), RepoKind::Nested), (b.clone(), RepoKind::Folder)]
    );
    let off = DetectOptions { auto_repository_detection: AutoDetect::Off, ..DetectOptions::default() };
    assert!(detect_with(&roots, &off, &fake_top).repositories.is_empty());
    let ignored = DetectOptions { ignored_repositories: vec!["vendor".into(), b.display().to_string()], ..DetectOptions::default() };
    assert_eq!(dirs(&detect_with(&roots, &ignored, &fake_top)), [(a.clone(), RepoKind::Folder)]);
    // git.scanRepositories reaches below the depth limit.
    let scan = DetectOptions { scan_repositories: vec!["libs".into()], ..DetectOptions::default() };
    assert!(dirs(&detect_with(&roots, &scan, &fake_top)).contains(&(a.join("libs/deep"), RepoKind::Nested)));
  }

  #[test]
  fn parent_folder_repositories_follow_the_setting() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    mkrepo(&base);
    let pkg = base.join("pkg");
    std::fs::create_dir_all(&pkg).unwrap();
    let roots = [pkg.clone()];
    let prompt = detect_with(&roots, &DetectOptions::default(), &fake_top);
    assert!(prompt.repositories.is_empty());
    assert_eq!(prompt.parents, [ParentRepo { folder: pkg.clone(), toplevel: base.clone() }]);
    let allowed = DetectOptions { allowed_parents: vec![base.clone()], ..DetectOptions::default() };
    let open = detect_with(&roots, &allowed, &fake_top);
    assert_eq!(open.repositories, [RepoInfo { dir: pkg.clone(), folder: pkg.clone(), toplevel: base.clone(), kind: RepoKind::Parent }]);
    assert!(open.parents.is_empty());
    let always = DetectOptions { open_repository_in_parent_folders: "always".into(), ..DetectOptions::default() };
    assert_eq!(dirs(&detect_with(&roots, &always, &fake_top)), [(pkg.clone(), RepoKind::Parent)]);
    let never = detect_with(&roots, &DetectOptions { open_repository_in_parent_folders: "never".into(), ..DetectOptions::default() }, &fake_top);
    assert!(never.repositories.is_empty() && never.parents.is_empty());
    // The repository is a root folder itself: the nested root is covered by it, nothing to ask.
    let both = detect_with(&[base.clone(), pkg.clone()], &DetectOptions::default(), &fake_top);
    assert_eq!(dirs(&both), [(base.clone(), RepoKind::Folder)]);
    assert!(both.parents.is_empty());
  }

  #[test]
  fn open_editors_add_their_repository() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    mkrepo(&root.join("x/y/inner"));
    std::fs::create_dir_all(root.join("x/y/inner/src")).unwrap();
    let opts = DetectOptions { auto_repository_detection: AutoDetect::OpenEditors, open_editors: vec!["x/y/inner/src/a.ts".into(), "/elsewhere/b.ts".into()], ..DetectOptions::default() };
    assert_eq!(dirs(&detect_with(std::slice::from_ref(&root), &opts, &fake_top)), [(root.join("x/y/inner"), RepoKind::Editor)]);
    // subFolders does not look at editors (and depth 1 does not reach x/y/inner).
    let sub = DetectOptions { auto_repository_detection: AutoDetect::SubFolders, ..opts };
    assert!(detect_with(std::slice::from_ref(&root), &sub, &fake_top).repositories.is_empty());
  }

  #[test]
  fn auto_detect_reads_vscode_values() {
    let read = |v: &str| serde_json::from_str::<AutoDetect>(v).unwrap();
    assert_eq!(read("true"), AutoDetect::All);
    assert_eq!(read("false"), AutoDetect::Off);
    assert_eq!(read("\"subFolders\""), AutoDetect::SubFolders);
    assert_eq!(read("\"openEditors\""), AutoDetect::OpenEditors);
    assert_eq!(read("\"bogus\""), AutoDetect::All);
    let opts: DetectOptions = serde_json::from_str(r#"{"autoRepositoryDetection":"subFolders","repositoryScanMaxDepth":2}"#).unwrap();
    assert_eq!(opts.auto_repository_detection, AutoDetect::SubFolders);
    assert_eq!(opts.repository_scan_max_depth, 2);
    assert_eq!(opts.repository_scan_ignored_folders, ["node_modules"]);
  }

  #[test]
  fn files_belong_to_the_innermost_repository() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    mkrepo(&root.join("libs/a"));
    assert_eq!(file_repo(&root, "libs/a/src/x.ts"), (root.join("libs/a"), "src/x.ts".into()));
    assert_eq!(file_repo(&root, "libs/b.ts"), (root.clone(), "libs/b.ts".into()));
    assert_eq!(file_repo(&root, "top.ts"), (root.clone(), "top.ts".into()));
    // The repository folder itself is not a file of the inner repository.
    assert_eq!(file_repo(&root, "libs/a"), (root.clone(), "libs/a".into()));
  }

  #[test]
  fn commands_name_a_repository_inside_the_workspace() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let ra = a.path().canonicalize().unwrap();
    let rb = b.path().canonicalize().unwrap();
    mkrepo(&rb.join("sub"));
    std::fs::write(rb.join("sub/f.ts"), "").unwrap();
    let ws = Workspace::new(None);
    ws.set_session(crate::workspace::WindowSession {
      folders: vec![crate::workspace::Folder::new(ra.clone()), crate::workspace::Folder::new(rb.clone())],
      ..Default::default()
    });
    assert_eq!(repo_or_root(&ws, None).unwrap(), ra);
    assert_eq!(repo_or_root(&ws, Some(&rb.display().to_string())).unwrap(), rb);
    assert!(repo_or_root(&ws, Some("/")).is_err());
    let key = rb.join("sub/f.ts").display().to_string();
    assert_eq!(locate_file(&ws, &key).unwrap(), (rb.join("sub"), "f.ts".into()));
    assert!(locate_file(&ws, "/etc/hosts").is_err());
  }
}
