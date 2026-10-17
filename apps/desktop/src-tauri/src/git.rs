//! Source Control (VS Code's git extension, minus the extension host): status, stage, unstage,
//! discard, commit and HEAD contents for diffs. Drives the `git` CLI directly (no shell), with
//! `--literal-pathspecs` and every path after `--`, so a file name is never read as an option
//! or pathspec magic. Paths are workspace-relative and `/`-separated; callers check them with
//! [`check_rel`] first.

use std::collections::HashSet;
use std::path::{Component, Path};
use std::process::Command;

/// HEAD contents larger than this are not shown in a diff (matches `read_workspace_file`).
const MAX_SHOW_BYTES: usize = 5 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct GitStatus {
  /// Branch name, `None` when detached.
  pub branch: Option<String>,
  /// Short commit id, `None` before the first commit.
  pub head: Option<String>,
  pub upstream: Option<String>,
  pub ahead: u32,
  pub behind: u32,
  pub entries: Vec<StatusEntry>,
}

/// One changed path. `index` / `worktree` are git's XY letters (`M`, `A`, `D`, `R`, `C`, `T`, `U`),
/// `None` when that side is unchanged. Untracked files have `worktree: Some("?")`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct StatusEntry {
  pub path: String,
  /// Source of a rename or copy.
  pub orig_path: Option<String>,
  pub index: Option<String>,
  pub worktree: Option<String>,
  pub conflict: bool,
}

/// Rejects anything that is not a plain relative path inside `root`: absolute paths, `..`,
/// and (for paths that exist, or their nearest existing ancestor) symlinks that leave the root.
/// Unlike `Workspace::resolve`, the path need not exist, since deleted files are still changes.
pub fn check_rel(root: &Path, rel: &str) -> Result<(), String> {
  if rel.is_empty() {
    return Err("empty path".into());
  }
  let path = Path::new(rel);
  if !path.components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir)) {
    return Err(format!("{rel}: outside the workspace"));
  }
  let full = root.join(path);
  let mut probe = full.clone();
  // A deleted file is checked through its nearest existing ancestor. The path itself may be a
  // symlink (git tracks the link, not its target), so it is judged by where the link lives.
  loop {
    if probe.symlink_metadata().is_ok() {
      let at = if probe == full && probe.is_symlink() { probe.parent().map(Path::to_path_buf) } else { Some(probe.clone()) };
      let real = at.and_then(|p| p.canonicalize().ok()).ok_or_else(|| format!("{rel}: cannot resolve"))?;
      return if real.starts_with(root) { Ok(()) } else { Err(format!("{rel}: outside the workspace")) };
    }
    if !probe.pop() || !probe.starts_with(root) {
      return Err(format!("{rel}: outside the workspace"));
    }
  }
}

fn run(root: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
  let out = Command::new("git")
    .arg("-C")
    .arg(root)
    .arg("--literal-pathspecs")
    .args(args)
    .output()
    .map_err(|e| format!("git: {e}"))?;
  if !out.status.success() {
    // `git commit` reports "nothing to commit" on stdout.
    let err = String::from_utf8_lossy(if out.stderr.is_empty() { &out.stdout } else { &out.stderr });
    return Err(format!("git {}: {}", args.first().unwrap_or(&""), err.trim()));
  }
  Ok(out.stdout)
}

fn run_paths(root: &Path, args: &[&str], paths: &[String]) -> Result<(), String> {
  if paths.is_empty() {
    return Ok(());
  }
  let mut all: Vec<&str> = args.to_vec();
  all.push("--");
  all.extend(paths.iter().map(String::as_str));
  run(root, &all).map(|_| ())
}

/// The workspace's path inside the repository (`""` at the top level, else `sub/dir/`);
/// `None` outside a repository.
fn prefix(root: &Path) -> Option<String> {
  run(root, &["rev-parse", "--show-prefix"]).ok().map(|o| String::from_utf8_lossy(&o).trim().to_owned())
}

fn has_head(root: &Path) -> bool {
  run(root, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok()
}

/// `None` outside a git repository.
pub fn status(root: &Path) -> Result<Option<GitStatus>, String> {
  let Some(prefix) = prefix(root) else { return Ok(None) };
  let out = run(root, &["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--", "."])?;
  Ok(Some(parse_status(&String::from_utf8_lossy(&out), &prefix)))
}

fn code(c: char) -> Option<String> {
  (c != '.').then(|| c.to_string())
}

/// Parses `git status --porcelain=v2 -z --branch`. Repository-relative paths are made relative
/// to `prefix` (the workspace's folder in the repository); paths outside it are dropped.
pub fn parse_status(text: &str, prefix: &str) -> GitStatus {
  let mut st = GitStatus { branch: None, head: None, upstream: None, ahead: 0, behind: 0, entries: Vec::new() };
  let strip = |p: &str| p.strip_prefix(prefix).map(str::to_owned);
  let mut records = text.split('\0');
  while let Some(rec) = records.next() {
    let Some((kind, rest)) = rec.split_once(' ') else { continue };
    match kind {
      "#" => {
        let (key, value) = rest.split_once(' ').unwrap_or((rest, ""));
        match key {
          "branch.oid" if value != "(initial)" => st.head = Some(value.chars().take(8).collect()),
          "branch.head" if value != "(detached)" => st.branch = Some(value.to_owned()),
          "branch.upstream" => st.upstream = Some(value.to_owned()),
          "branch.ab" => {
            for n in value.split(' ') {
              if let Some(a) = n.strip_prefix('+') {
                st.ahead = a.parse().unwrap_or(0);
              } else if let Some(b) = n.strip_prefix('-') {
                st.behind = b.parse().unwrap_or(0);
              }
            }
          }
          _ => {}
        }
      }
      // 1 XY sub mH mI mW hH hI path
      "1" | "2" | "u" => {
        let fields = match kind {
          "1" => 8,
          "2" => 9,
          _ => 10,
        };
        let parts: Vec<&str> = rest.splitn(fields, ' ').collect();
        if parts.len() != fields {
          continue;
        }
        let xy: Vec<char> = parts[0].chars().collect();
        // A rename's source follows as its own NUL-terminated record.
        let orig = if kind == "2" { records.next() } else { None };
        let Some(path) = strip(parts[fields - 1]) else { continue };
        let conflict = kind == "u";
        st.entries.push(StatusEntry {
          path,
          orig_path: orig.and_then(|o| strip(o).or_else(|| Some(o.to_owned()))),
          index: if conflict { Some("U".into()) } else { xy.first().copied().and_then(code) },
          worktree: if conflict { Some("U".into()) } else { xy.get(1).copied().and_then(code) },
          conflict,
        });
      }
      "?" => {
        if let Some(path) = strip(rest) {
          st.entries.push(StatusEntry { path, orig_path: None, index: None, worktree: Some("?".into()), conflict: false });
        }
      }
      _ => {}
    }
  }
  st
}

/// `git add -A`, so deletions are staged too.
pub fn stage(root: &Path, paths: &[String]) -> Result<(), String> {
  run_paths(root, &["add", "-A"], paths)
}

/// `git restore --staged`; before the first commit there is no HEAD, so `git rm --cached`.
pub fn unstage(root: &Path, paths: &[String]) -> Result<(), String> {
  if has_head(root) {
    run_paths(root, &["restore", "--staged"], paths)
  } else {
    run_paths(root, &["rm", "--cached", "-r", "-q", "--ignore-unmatch"], paths)
  }
}

/// Throws away working-tree changes (back to the index, like VS Code's "Discard Changes").
/// Untracked files are deleted, which cannot be undone, so that needs `delete_untracked`.
pub fn discard(root: &Path, paths: &[String], delete_untracked: bool) -> Result<(), String> {
  let Some(st) = status(root)? else { return Err("not a git repository".into()) };
  let untracked: HashSet<&str> =
    st.entries.iter().filter(|e| e.worktree.as_deref() == Some("?")).map(|e| e.path.as_str()).collect();
  let (new, tracked): (Vec<String>, Vec<String>) = paths.iter().cloned().partition(|p| untracked.contains(p.as_str()));
  if !new.is_empty() && !delete_untracked {
    return Err(format!("{}: untracked, deleting needs confirmation", new.join(", ")));
  }
  run_paths(root, &["restore", "--worktree"], &tracked)?;
  // `git clean` only ever removes untracked files, so a racing `git add` cannot lose staged work.
  run_paths(root, &["clean", "-f", "-q"], &new)
}

pub fn commit(root: &Path, message: &str, amend: bool) -> Result<(), String> {
  if message.trim().is_empty() {
    return Err("commit message is empty".into());
  }
  // `git diff --cached --quiet` fails when something is staged (git's own message is a page of status).
  if !amend && has_head(root) && run(root, &["diff", "--cached", "--quiet"]).is_ok() {
    return Err("nothing staged to commit".into());
  }
  let mut args = vec!["commit", "-q", "--cleanup=strip", "-m", message];
  if amend {
    args.push("--amend");
  }
  run(root, &args).map(|_| ())
}

/// The HEAD version of `rel` for the diff editor; empty for files not in HEAD (added, untracked,
/// or no commit yet).
pub fn show_head(root: &Path, rel: &str) -> Result<String, String> {
  let spec = format!("HEAD:./{rel}");
  if run(root, &["cat-file", "-e", &spec]).is_err() {
    return Ok(String::new());
  }
  let size = run(root, &["cat-file", "-s", &spec])?;
  if String::from_utf8_lossy(&size).trim().parse::<usize>().unwrap_or(0) > MAX_SHOW_BYTES {
    return Err(format!("{rel}: larger than {MAX_SHOW_BYTES} bytes"));
  }
  Ok(String::from_utf8_lossy(&run(root, &["cat-file", "blob", &spec])?).into_owned())
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::PathBuf;

  fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(ok.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&ok.stderr));
  }

  fn write(repo: &Path, rel: &str, text: &str) {
    let p = repo.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
  }

  /// A repo with one commit: a.txt, b.txt, old.txt, sub/c.txt.
  fn temp_repo() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().canonicalize().unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    for (k, v) in [("user.name", "t"), ("user.email", "t@example.com"), ("commit.gpgsign", "false")] {
      git(&repo, &["config", k, v]);
    }
    for f in ["a.txt", "b.txt", "old.txt", "sub/c.txt"] {
      write(&repo, f, &format!("{f}\n"));
    }
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "init"]);
    (tmp, repo)
  }

  fn entry<'a>(st: &'a GitStatus, path: &str) -> &'a StatusEntry {
    st.entries.iter().find(|e| e.path == path).unwrap_or_else(|| panic!("{path} not in {:?}", st.entries))
  }

  fn codes(e: &StatusEntry) -> (Option<&str>, Option<&str>) {
    (e.index.as_deref(), e.worktree.as_deref())
  }

  #[test]
  fn reports_staged_unstaged_renamed_and_untracked() {
    let (_tmp, repo) = temp_repo();
    write(&repo, "a.txt", "changed\n"); // unstaged M
    write(&repo, "b.txt", "staged\n");
    git(&repo, &["add", "b.txt"]); // staged M
    write(&repo, "b.txt", "staged then edited\n"); // and unstaged M
    std::fs::remove_file(repo.join("sub/c.txt")).unwrap(); // unstaged D
    git(&repo, &["mv", "old.txt", "new name.txt"]); // staged R, with a space
    write(&repo, "added.txt", "x\n");
    git(&repo, &["add", "added.txt"]); // staged A
    write(&repo, "dir/untracked.txt", "u\n"); // untracked, listed per file

    let st = status(&repo).unwrap().unwrap();
    assert_eq!(st.branch.as_deref(), Some("main"));
    assert!(st.head.is_some());
    assert_eq!((st.ahead, st.behind), (0, 0));
    assert_eq!(st.entries.len(), 6, "{:?}", st.entries);
    assert_eq!(codes(entry(&st, "a.txt")), (None, Some("M")));
    assert_eq!(codes(entry(&st, "b.txt")), (Some("M"), Some("M")));
    assert_eq!(codes(entry(&st, "sub/c.txt")), (None, Some("D")));
    assert_eq!(codes(entry(&st, "added.txt")), (Some("A"), None));
    assert_eq!(codes(entry(&st, "dir/untracked.txt")), (None, Some("?")));
    let renamed = entry(&st, "new name.txt");
    assert_eq!(codes(renamed), (Some("R"), None));
    assert_eq!(renamed.orig_path.as_deref(), Some("old.txt"));
  }

  #[test]
  fn parses_branch_headers_conflicts_and_prefix() {
    let text = "# branch.oid (initial)\0# branch.head (detached)\0# branch.upstream origin/main\0# branch.ab +3 -2\0\
                u UU N... 100644 100644 100644 100644 h1 h2 h3 ws/conf.txt\0\
                2 R. N... 100644 100644 100644 h h R100 ws/to.txt\0ws/from.txt\0\
                1 .M N... 100644 100644 100644 h h other/x.txt\0? ws/new.txt\0";
    let st = parse_status(text, "ws/");
    assert_eq!((st.branch, st.head), (None, None));
    assert_eq!(st.upstream.as_deref(), Some("origin/main"));
    assert_eq!((st.ahead, st.behind), (3, 2));
    let paths: Vec<_> = st.entries.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(paths, ["conf.txt", "to.txt", "new.txt"]);
    assert!(st.entries[0].conflict);
    assert_eq!(st.entries[1].orig_path.as_deref(), Some("from.txt"));
  }

  #[test]
  fn stages_unstages_and_commits() {
    let (_tmp, repo) = temp_repo();
    write(&repo, "a.txt", "changed\n");
    std::fs::remove_file(repo.join("b.txt")).unwrap();
    write(&repo, "n.txt", "new\n");
    let all = ["a.txt", "b.txt", "n.txt"].map(String::from);

    stage(&repo, &all).unwrap();
    let st = status(&repo).unwrap().unwrap();
    assert_eq!(codes(entry(&st, "a.txt")), (Some("M"), None));
    assert_eq!(codes(entry(&st, "b.txt")), (Some("D"), None));
    assert_eq!(codes(entry(&st, "n.txt")), (Some("A"), None));

    unstage(&repo, &all[..1]).unwrap();
    let st = status(&repo).unwrap().unwrap();
    assert_eq!(codes(entry(&st, "a.txt")), (None, Some("M")));

    assert!(commit(&repo, "  \n", false).is_err());
    commit(&repo, "second", false).unwrap();
    let st = status(&repo).unwrap().unwrap();
    assert_eq!(st.entries.len(), 1, "only the unstaged a.txt is left: {:?}", st.entries);
    assert_eq!(show_head(&repo, "n.txt").unwrap(), "new\n");

    commit(&repo, "second, amended", true).unwrap();
    let log = Command::new("git").arg("-C").arg(&repo).args(["log", "--format=%s"]).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&log.stdout), "second, amended\ninit\n");
    assert!(commit(&repo, "nothing staged", false).unwrap_err().contains("nothing"));
  }

  #[test]
  fn unstages_before_the_first_commit() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().canonicalize().unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    write(&repo, "a.txt", "a\n");
    stage(&repo, &["a.txt".into()]).unwrap();
    assert_eq!(codes(entry(&status(&repo).unwrap().unwrap(), "a.txt")), (Some("A"), None));
    unstage(&repo, &["a.txt".into()]).unwrap();
    assert_eq!(codes(entry(&status(&repo).unwrap().unwrap(), "a.txt")), (None, Some("?")));
    assert_eq!(show_head(&repo, "a.txt").unwrap(), "");
  }

  #[test]
  fn discards_and_needs_a_flag_to_delete_untracked() {
    let (_tmp, repo) = temp_repo();
    write(&repo, "a.txt", "changed\n");
    write(&repo, "u.txt", "u\n");
    let both = ["a.txt", "u.txt"].map(String::from);
    assert!(discard(&repo, &both, false).unwrap_err().contains("u.txt"));
    assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "changed\n", "nothing discarded on refusal");
    discard(&repo, &both, true).unwrap();
    assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "a.txt\n");
    assert!(!repo.join("u.txt").exists());
    assert!(status(&repo).unwrap().unwrap().entries.is_empty());
  }

  #[test]
  fn shows_head_and_treats_paths_literally() {
    let (_tmp, repo) = temp_repo();
    write(&repo, "a.txt", "changed\n");
    assert_eq!(show_head(&repo, "a.txt").unwrap(), "a.txt\n");
    assert_eq!(show_head(&repo, "sub/c.txt").unwrap(), "sub/c.txt\n");
    assert_eq!(show_head(&repo, "missing.txt").unwrap(), "");
    // Pathspec magic would stage every file; literally it matches nothing.
    assert!(stage(&repo, &[":(glob)*".into()]).is_err());
    assert_eq!(codes(entry(&status(&repo).unwrap().unwrap(), "a.txt")), (None, Some("M")));
  }

  #[test]
  fn outside_a_repository_is_none() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().canonicalize().unwrap();
    // Only meaningful when the temp dir is not itself inside some repository.
    if prefix(&dir).is_none() {
      assert_eq!(status(&dir).unwrap(), None);
    }
  }

  #[test]
  fn checks_relative_paths() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    write(&root, "a/b.txt", "");
    assert!(check_rel(&root, "a/b.txt").is_ok());
    assert!(check_rel(&root, "a/deleted.txt").is_ok());
    assert!(check_rel(&root, "gone/dir/x.txt").is_ok());
    for bad in ["", "../x", "a/../../x", "/etc/hosts"] {
      assert!(check_rel(&root, bad).is_err(), "{bad}");
    }
    #[cfg(unix)]
    {
      let outside = tempfile::tempdir().unwrap();
      std::os::unix::fs::symlink(outside.path(), root.join("link")).unwrap();
      assert!(check_rel(&root, "link/x.txt").is_err());
      // The link itself lives in the workspace (git tracks links, not their targets).
      assert!(check_rel(&root, "link").is_ok());
    }
  }
}
