//! Source Control Graph (VS Code's SCM history provider in the git extension): the commits of
//! HEAD, and of its upstream with `scm.graph.showIncomingChanges`, newest first in topological
//! order with their parents and the branches and tags pointing at them, a page at a time. The
//! webview lays out the lanes (src/lib/scm/graph.ts). Also the files a commit changed and the
//! unified diff between two revisions, for the graph's file lists and multi-file diffs.
//!
//! Read-only: nothing here queues (see `git_queue`), every revision is checked with
//! [`check_rev`] and passed after `--end-of-options`.

use std::path::Path;

use crate::git::{check_rev, run};
use crate::workspace::Workspace;

/// What a branch or tag label on a commit is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RefKind {
  /// A local branch.
  Branch,
  /// A remote-tracking branch (`origin/main`).
  Remote,
  Tag,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct GraphRef {
  /// Short name: `main`, `origin/main`, `v1.0`.
  pub name: String,
  pub kind: RefKind,
  /// The branch HEAD is on.
  pub current: bool,
}

/// One commit of the graph.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct GraphCommit {
  pub hash: String,
  /// First parent first; empty for a root commit.
  pub parents: Vec<String>,
  pub author: String,
  pub email: String,
  /// Unix seconds.
  pub author_time: i64,
  pub commit_time: i64,
  pub subject: String,
  /// The message after the subject (trimmed), for the hover.
  pub body: String,
  pub refs: Vec<GraphRef>,
}

/// The branch HEAD tracks, as the graph marks incoming and outgoing commits by it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Upstream {
  /// `origin/main`.
  pub name: String,
  pub hash: String,
}

/// One page of the graph, with what the webview needs to mark incoming and outgoing commits.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct GraphPage {
  pub commits: Vec<GraphCommit>,
  /// HEAD's commit; `None` before the first commit.
  pub head: Option<String>,
  /// HEAD's branch; `None` when detached.
  pub branch: Option<String>,
  pub upstream: Option<Upstream>,
  /// `git merge-base HEAD <upstream>`.
  pub merge_base: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GraphOptions {
  /// Commits per page (`scm.graph.pageSize`), 1..=1000.
  pub limit: u32,
  pub skip: u32,
  /// `scm.graph.showIncomingChanges`: the upstream's commits too.
  pub incoming: bool,
  /// Every branch, remote branch and tag, not only HEAD (and its upstream).
  pub all: bool,
}

const FORMAT: &str = "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%ct%x1f%D%x1f%s%x1f%b%x1e";

/// Parses `%D` of `git log --decorate=full`: `HEAD -> refs/heads/main, refs/remotes/origin/main,
/// tag: refs/tags/v1`. A remote's `HEAD` and the stash are left out.
pub fn parse_refs(text: &str) -> Vec<GraphRef> {
  let mut out = Vec::new();
  for item in text.split(", ").map(str::trim).filter(|s| !s.is_empty()) {
    let (current, full) = match item.strip_prefix("HEAD -> ") {
      Some(rest) => (true, rest),
      None => (false, item),
    };
    let (kind, name) = if let Some(t) = full.strip_prefix("tag: ") {
      (RefKind::Tag, t.strip_prefix("refs/tags/").unwrap_or(t))
    } else if let Some(b) = full.strip_prefix("refs/heads/") {
      (RefKind::Branch, b)
    } else if let Some(r) = full.strip_prefix("refs/remotes/") {
      if r.ends_with("/HEAD") {
        continue;
      }
      (RefKind::Remote, r)
    } else {
      // `HEAD` alone (detached), `refs/stash`, notes and other refs.
      continue;
    };
    out.push(GraphRef { name: name.to_owned(), kind, current });
  }
  out
}

/// Parses `git log` with [`FORMAT`].
pub fn parse_graph_log(text: &str) -> Vec<GraphCommit> {
  text
    .split('\x1e')
    .filter_map(|rec| {
      let mut f = rec.trim_start_matches('\n').split('\x1f');
      let hash = f.next()?.to_owned();
      if hash.is_empty() {
        return None;
      }
      let parents = f.next()?.split(' ').filter(|p| !p.is_empty()).map(str::to_owned).collect();
      let author = f.next()?.to_owned();
      let email = f.next()?.to_owned();
      let author_time = f.next()?.parse().ok()?;
      let commit_time = f.next()?.parse().ok()?;
      let refs = parse_refs(f.next()?);
      let subject = f.next().unwrap_or("").trim_end().to_owned();
      let body = f.next().unwrap_or("").trim().to_owned();
      Some(GraphCommit { hash, parents, author, email, author_time, commit_time, subject, body, refs })
    })
    .collect()
}

fn line(root: &Path, args: &[&str]) -> Option<String> {
  run(root, args).ok().map(|o| String::from_utf8_lossy(&o).trim().to_owned()).filter(|s| !s.is_empty())
}

/// HEAD's upstream (`origin/main`, its full ref and commit), when it has one that exists.
fn upstream(root: &Path) -> Option<(Upstream, String)> {
  let full = line(root, &["rev-parse", "--symbolic-full-name", "@{upstream}"])?;
  let hash = line(root, &["rev-parse", "--verify", "--quiet", "@{upstream}^{commit}"])?;
  let name = full.strip_prefix("refs/remotes/").or_else(|| full.strip_prefix("refs/heads/")).unwrap_or(&full).to_owned();
  Some((Upstream { name, hash }, full))
}

/// One page of the graph.
pub fn graph_log(root: &Path, opts: &GraphOptions) -> Result<GraphPage, String> {
  let Some(head) = line(root, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]) else {
    return Ok(GraphPage { commits: Vec::new(), head: None, branch: None, upstream: None, merge_base: None });
  };
  let branch = line(root, &["symbolic-ref", "--short", "-q", "HEAD"]);
  let up = branch.as_ref().and_then(|_| upstream(root));
  let merge_base = up.as_ref().and_then(|(u, _)| line(root, &["merge-base", "--end-of-options", &head, &u.hash]));
  let n = format!("-n{}", opts.limit.clamp(1, 1000));
  let skip = format!("--skip={}", opts.skip);
  let mut args = vec!["log", "--topo-order", "--decorate=full", FORMAT, &n, &skip];
  if opts.all {
    args.extend(["--branches", "--remotes", "--tags"]);
  }
  args.extend(["--end-of-options", "HEAD"]);
  if let (true, Some((_, full))) = (opts.incoming, &up) {
    args.push(full);
  }
  let out = run(root, &args)?;
  Ok(GraphPage { commits: parse_graph_log(&String::from_utf8_lossy(&out)), head: Some(head), branch, upstream: up.map(|(u, _)| u), merge_base })
}

/// A file a commit (or a range) changed.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ChangedFile {
  /// git's letter: `A`, `M`, `D`, `R`, `C`, `T`.
  pub status: String,
  /// Repository-relative path after the change.
  pub path: String,
  /// The path before a rename or copy.
  pub old_path: Option<String>,
}

/// Parses `--name-status -z`: `M\0a.ts\0R100\0old\0new\0`.
pub fn parse_name_status(text: &str) -> Vec<ChangedFile> {
  let mut out = Vec::new();
  let mut f = text.split('\0').filter(|s| !s.is_empty());
  while let Some(code) = f.next() {
    let status: String = code.chars().take(1).collect();
    let Some(first) = f.next() else { break };
    if status == "R" || status == "C" {
      let Some(second) = f.next() else { break };
      out.push(ChangedFile { status, path: second.to_owned(), old_path: Some(first.to_owned()) });
    } else {
      out.push(ChangedFile { status, path: first.to_owned(), old_path: None });
    }
  }
  out
}

fn is_root_commit(root: &Path, rev: &str) -> Result<bool, String> {
  Ok(run(root, &["rev-parse", "--verify", "--quiet", "--end-of-options", &format!("{rev}^1")]).is_err())
}

/// The files `to` changed against `from`, or (no `from`) against its first parent (everything,
/// for a root commit).
pub fn changed_files(root: &Path, from: Option<&str>, to: &str) -> Result<Vec<ChangedFile>, String> {
  check_rev(to)?;
  let out = match from {
    Some(from) => {
      check_rev(from)?;
      run(root, &["diff", "--name-status", "-z", "-M", "--end-of-options", from, to, "--"])?
    }
    None if is_root_commit(root, to)? => run(root, &["diff-tree", "-r", "-z", "-M", "--root", "--name-status", "--no-commit-id", "--end-of-options", to, "--"])?,
    None => {
      let parent = format!("{to}^1");
      run(root, &["diff", "--name-status", "-z", "-M", "--end-of-options", &parent, to, "--"])?
    }
  };
  Ok(parse_name_status(&String::from_utf8_lossy(&out)))
}

/// Multi-file diffs larger than this are cut (the combined diff view says so).
pub const DIFF_LIMIT: usize = 2 * 1024 * 1024;

/// Cuts `text` at `limit` bytes with the marker the combined diff view reads.
pub fn truncate_diff(mut text: String, limit: usize) -> String {
  if text.len() > limit {
    let mut cut = limit;
    while !text.is_char_boundary(cut) {
      cut -= 1;
    }
    text.truncate(cut);
    text.push_str("\n\\ kingu: diff truncated\n");
  }
  text
}

/// The unified diff of `to` against `from` (or its first parent, like [`changed_files`]).
pub fn diff_range(root: &Path, from: Option<&str>, to: &str) -> Result<String, String> {
  check_rev(to)?;
  let out = match from {
    Some(from) => {
      check_rev(from)?;
      run(root, &["diff", "--no-color", "--no-ext-diff", "-M", "--end-of-options", from, to, "--"])?
    }
    None if is_root_commit(root, to)? => run(root, &["diff-tree", "-p", "-r", "-M", "--root", "--no-color", "--no-ext-diff", "--no-commit-id", "--end-of-options", to, "--"])?,
    None => {
      let parent = format!("{to}^1");
      run(root, &["diff", "--no-color", "--no-ext-diff", "-M", "--end-of-options", &parent, to, "--"])?
    }
  };
  Ok(truncate_diff(String::from_utf8_lossy(&out).into_owned(), DIFF_LIMIT))
}

/// `git merge-base a b`, `None` when they share no history.
pub fn merge_base(root: &Path, a: &str, b: &str) -> Result<Option<String>, String> {
  check_rev(a)?;
  check_rev(b)?;
  Ok(line(root, &["merge-base", "--end-of-options", a, b]))
}

// ---------------------------------------------------------------------------------------------
// Tauri commands; `repo` picks one of a multi-root workspace's repositories (git_repos.rs).

#[tauri::command]
pub async fn scm_graph_log(ws: Workspace, options: Option<GraphOptions>, repo: Option<String>) -> Result<GraphPage, String> {
  let root = crate::git_repos::repo_or_root(&ws, repo.as_deref())?;
  let opts = options.unwrap_or(GraphOptions { limit: 50, ..Default::default() });
  crate::blocking(move || graph_log(&root, &opts)).await
}

#[tauri::command]
pub async fn scm_changed_files(ws: Workspace, from: Option<String>, to: String, repo: Option<String>) -> Result<Vec<ChangedFile>, String> {
  let root = crate::git_repos::repo_or_root(&ws, repo.as_deref())?;
  crate::blocking(move || changed_files(&root, from.as_deref(), &to)).await
}

#[tauri::command]
pub async fn scm_diff_range(ws: Workspace, from: Option<String>, to: String, repo: Option<String>) -> Result<String, String> {
  let root = crate::git_repos::repo_or_root(&ws, repo.as_deref())?;
  crate::blocking(move || diff_range(&root, from.as_deref(), &to)).await
}

#[tauri::command]
pub async fn scm_merge_base(ws: Workspace, a: String, b: String, repo: Option<String>) -> Result<Option<String>, String> {
  let root = crate::git_repos::repo_or_root(&ws, repo.as_deref())?;
  crate::blocking(move || merge_base(&root, &a, &b)).await
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::PathBuf;
  use std::process::Command;

  fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
  }

  fn commit(repo: &Path, rel: &str, text: &str, msg: &str) -> String {
    let p = repo.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
    git(repo, &["add", "-A"]);
    git(repo, &["commit", "-q", "-m", msg]);
    git(repo, &["rev-parse", "HEAD"])
  }

  fn init(dir: &Path) {
    git(dir, &["init", "-q", "-b", "main"]);
    for (k, v) in [("user.name", "Ann"), ("user.email", "ann@example.com"), ("commit.gpgsign", "false"), ("tag.gpgsign", "false")] {
      git(dir, &["config", k, v]);
    }
  }

  fn temp_repo() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().canonicalize().unwrap().join("repo");
    std::fs::create_dir(&repo).unwrap();
    init(&repo);
    (tmp, repo)
  }

  #[test]
  fn parses_decorations() {
    let refs = parse_refs("HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1.0, refs/stash");
    assert_eq!(
      refs,
      vec![
        GraphRef { name: "main".into(), kind: RefKind::Branch, current: true },
        GraphRef { name: "origin/main".into(), kind: RefKind::Remote, current: false },
        GraphRef { name: "v1.0".into(), kind: RefKind::Tag, current: false },
      ]
    );
    assert!(parse_refs("HEAD").is_empty());
    assert!(parse_refs("").is_empty());
  }

  #[test]
  fn parses_name_status() {
    let files = parse_name_status("M\0a.ts\0R087\0old name.ts\0new name.ts\0D\0gone.txt\0");
    assert_eq!(files.len(), 3);
    assert_eq!(files[1], ChangedFile { status: "R".into(), path: "new name.ts".into(), old_path: Some("old name.ts".into()) });
    assert_eq!((files[2].status.as_str(), files[2].path.as_str()), ("D", "gone.txt"));
  }

  #[test]
  fn empty_repository_has_an_empty_graph() {
    let (_tmp, repo) = temp_repo();
    let page = graph_log(&repo, &GraphOptions { limit: 10, ..Default::default() }).unwrap();
    assert!(page.commits.is_empty() && page.head.is_none());
  }

  #[test]
  fn reads_commits_with_parents_refs_and_pages() {
    let (_tmp, repo) = temp_repo();
    let a = commit(&repo, "a.txt", "a\n", "first");
    git(&repo, &["tag", "v1"]);
    git(&repo, &["checkout", "-q", "-b", "side"]);
    let s = commit(&repo, "s.txt", "s\n", "on side\n\nwith a body");
    git(&repo, &["checkout", "-q", "main"]);
    let b = commit(&repo, "b.txt", "b\n", "second");
    git(&repo, &["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    let m = git(&repo, &["rev-parse", "HEAD"]);

    let page = graph_log(&repo, &GraphOptions { limit: 50, ..Default::default() }).unwrap();
    assert_eq!(page.head.as_deref(), Some(m.as_str()));
    assert_eq!(page.branch.as_deref(), Some("main"));
    assert_eq!(page.upstream, None);
    let hashes: Vec<&str> = page.commits.iter().map(|c| c.hash.as_str()).collect();
    assert_eq!(hashes.len(), 4);
    assert_eq!(hashes[0], m);
    assert_eq!(*hashes.last().unwrap(), a);
    let merge = &page.commits[0];
    assert_eq!(merge.parents, vec![b.clone(), s.clone()]);
    assert_eq!(merge.refs, vec![GraphRef { name: "main".into(), kind: RefKind::Branch, current: true }]);
    let side = page.commits.iter().find(|c| c.hash == s).unwrap();
    assert_eq!((side.subject.as_str(), side.body.as_str(), side.author.as_str(), side.email.as_str()), ("on side", "with a body", "Ann", "ann@example.com"));
    assert!(side.refs.iter().any(|r| r.name == "side" && r.kind == RefKind::Branch && !r.current));
    let first = page.commits.last().unwrap();
    assert!(first.parents.is_empty());
    assert!(first.refs.iter().any(|r| r.name == "v1" && r.kind == RefKind::Tag));

    // Paging: two at a time, no commit twice.
    let p1 = graph_log(&repo, &GraphOptions { limit: 2, ..Default::default() }).unwrap();
    let p2 = graph_log(&repo, &GraphOptions { limit: 2, skip: 2, ..Default::default() }).unwrap();
    let paged: Vec<String> = p1.commits.iter().chain(&p2.commits).map(|c| c.hash.clone()).collect();
    assert_eq!(paged, hashes);

    // Every branch: a branch not merged into HEAD shows up too.
    git(&repo, &["branch", "other", &a]);
    git(&repo, &["checkout", "-q", "other"]);
    let o = commit(&repo, "o.txt", "o\n", "other work");
    git(&repo, &["checkout", "-q", "main"]);
    assert!(!graph_log(&repo, &GraphOptions { limit: 50, ..Default::default() }).unwrap().commits.iter().any(|c| c.hash == o));
    assert!(graph_log(&repo, &GraphOptions { limit: 50, all: true, ..Default::default() }).unwrap().commits.iter().any(|c| c.hash == o));
  }

  #[test]
  fn includes_incoming_commits_and_the_merge_base() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().canonicalize().unwrap();
    git(&dir, &["init", "-q", "--bare", "-b", "main", "origin.git"]);
    git(&dir, &["clone", "-q", "origin.git", "a"]);
    let a = dir.join("a");
    init(&a);
    let base = commit(&a, "x.txt", "x\n", "base");
    git(&a, &["push", "-q", "-u", "origin", "main"]);
    git(&dir, &["clone", "-q", "origin.git", "b"]);
    let b = dir.join("b");
    init(&b);
    let theirs = commit(&a, "y.txt", "y\n", "theirs");
    git(&a, &["push", "-q"]);
    let mine = commit(&b, "z.txt", "z\n", "mine");
    git(&b, &["fetch", "-q"]);

    let opts = GraphOptions { limit: 50, ..Default::default() };
    let page = graph_log(&b, &opts).unwrap();
    assert_eq!(page.upstream, Some(Upstream { name: "origin/main".into(), hash: theirs.clone() }));
    assert_eq!(page.merge_base.as_deref(), Some(base.as_str()));
    assert!(!page.commits.iter().any(|c| c.hash == theirs), "incoming commits only when asked");
    let page = graph_log(&b, &GraphOptions { incoming: true, ..opts }).unwrap();
    let hashes: Vec<&str> = page.commits.iter().map(|c| c.hash.as_str()).collect();
    assert!(hashes.contains(&theirs.as_str()) && hashes.contains(&mine.as_str()));
    assert_eq!(*hashes.last().unwrap(), base);
    let remote = page.commits.iter().find(|c| c.hash == theirs).unwrap();
    assert!(remote.refs.iter().any(|r| r.name == "origin/main" && r.kind == RefKind::Remote));
    assert_eq!(merge_base(&b, "HEAD", "origin/main").unwrap().as_deref(), Some(base.as_str()));
  }

  #[test]
  fn lists_changed_files_and_diffs_commits() {
    let (_tmp, repo) = temp_repo();
    let first = commit(&repo, "a.txt", "one\ntwo\nthree\nfour\nfive\n", "first");
    std::fs::rename(repo.join("a.txt"), repo.join("b.txt")).unwrap();
    std::fs::write(repo.join("c.txt"), "c\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "second"]);
    let second = git(&repo, &["rev-parse", "HEAD"]);

    let root_files = changed_files(&repo, None, &first).unwrap();
    assert_eq!(root_files, vec![ChangedFile { status: "A".into(), path: "a.txt".into(), old_path: None }]);
    let files = changed_files(&repo, None, &second).unwrap();
    assert!(files.contains(&ChangedFile { status: "R".into(), path: "b.txt".into(), old_path: Some("a.txt".into()) }), "{files:?}");
    assert!(files.contains(&ChangedFile { status: "A".into(), path: "c.txt".into(), old_path: None }));
    assert_eq!(changed_files(&repo, Some(&first), &second).unwrap(), files);

    let root_diff = diff_range(&repo, None, &first).unwrap();
    assert!(root_diff.contains("+++ b/a.txt") && root_diff.contains("+three"), "{root_diff}");
    let diff = diff_range(&repo, None, &second).unwrap();
    assert!(diff.contains("rename to b.txt") && diff.contains("+++ b/c.txt"), "{diff}");
    for bad in ["-p", "a..b", "HEAD:x"] {
      assert!(diff_range(&repo, None, bad).is_err() && changed_files(&repo, Some(bad), "HEAD").is_err(), "{bad}");
    }
    assert_eq!(truncate_diff("abcdef".into(), 3), "abc\n\\ kingu: diff truncated\n");
  }
}
