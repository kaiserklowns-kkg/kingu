//! Source Control inside the editor (VS Code's git extension: quick diff originals, staged
//! ranges, blame, file history and merge conflict versions). Like `git.rs`: the `git` CLI only,
//! non-interactive, paths checked with [`git::check_rel`] and passed after `--` or as `:<n>:./<rel>`
//! object names; index writes wait in the worktree lane of `git_queue`.
//!
//! - [`show_index`] / [`show_stage`]: the index (stage 0) or one merge stage (1 base, 2 current,
//!   3 incoming) of a file: the quick diff's original and the merge editor's inputs.
//! - [`stage_patch`]: `git.stageSelectedRanges`, `git.unstageSelectedRanges` and the quick diff
//!   peek's Stage. The webview computes the hunks from the index text to the new index text (its
//!   buffer may be unsaved); Rust checks they are only hunks, writes the file header itself and
//!   runs `git apply --cached`.
//! - [`blame`]: `git blame --porcelain` of the working tree file (parsed in the webview, which
//!   maps the lines of an unsaved buffer onto it).
//! - [`file_log`]: `git log --follow` of one file for the Timeline view and Git: View File History.
//! - [`commit_info`]: the full message and stats of a commit for the blame hover.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use crate::git::{self, check_rel, check_rev, run};
use crate::git_queue::{self, Scope};
use crate::i18n::msg::{FilesMsg, ScmEditorMsg};
use crate::tr;
use crate::workspace::Workspace;
use tauri::State;

/// Versions larger than this are not shown (as `git::show_at`).
const MAX_SHOW_BYTES: usize = 5 * 1024 * 1024;

/// The blob named `spec` (`:0:./a.ts`), `None` when it does not exist.
fn show_spec(root: &Path, spec: &str, rel: &str) -> Result<Option<String>, String> {
  if run(root, &["cat-file", "-e", spec]).is_err() {
    return Ok(None);
  }
  let size = run(root, &["cat-file", "-s", spec])?;
  if String::from_utf8_lossy(&size).trim().parse::<usize>().unwrap_or(0) > MAX_SHOW_BYTES {
    return Err(tr!(FilesMsg::FileTooLarge, path = rel, max = MAX_SHOW_BYTES));
  }
  Ok(Some(String::from_utf8_lossy(&run(root, &["cat-file", "blob", spec])?).into_owned()))
}

/// The staged version of `rel` (stage 0); `None` when the file is not in the index (untracked)
/// or is in conflict (only stages 1–3 exist then).
pub fn show_index(root: &Path, rel: &str) -> Result<Option<String>, String> {
  show_spec(root, &format!(":0:./{rel}"), rel)
}

/// One side of a conflicted file: 1 the merge base, 2 the current side (ours), 3 the incoming
/// side (theirs). Empty when that side does not have the file (added by one side only).
pub fn show_stage(root: &Path, rel: &str, stage: u8) -> Result<String, String> {
  if !(1..=3).contains(&stage) {
    return Err(tr!(ScmEditorMsg::BadStage, stage));
  }
  Ok(show_spec(root, &format!(":{stage}:./{rel}"), rel)?.unwrap_or_default())
}

/// Checks that `body` is nothing but unified diff hunks whose line counts match their headers,
/// so `git apply` can only read it as hunks of the header Rust writes (a stray `--- a/x` /
/// `+++ b/y` pair could otherwise name another file).
pub fn check_hunks(body: &str) -> Result<(), String> {
  let bad = || tr!(ScmEditorMsg::BadPatch);
  if !body.ends_with('\n') {
    return Err(bad());
  }
  let mut lines = body.split_inclusive('\n').peekable();
  let mut hunks = 0;
  while let Some(header) = lines.next() {
    let (old, new) = parse_hunk_header(header.trim_end_matches(['\n', '\r'])).ok_or_else(bad)?;
    let (mut old_left, mut new_left) = (old, new);
    while old_left > 0 || new_left > 0 {
      let line = lines.next().ok_or_else(bad)?;
      match line.as_bytes().first() {
        Some(b' ') if old_left > 0 && new_left > 0 => (old_left, new_left) = (old_left - 1, new_left - 1),
        Some(b'-') if old_left > 0 => old_left -= 1,
        Some(b'+') if new_left > 0 => new_left -= 1,
        _ => return Err(bad()),
      }
      if lines.peek().is_some_and(|l| l.starts_with('\\')) {
        lines.next();
      }
    }
    hunks += 1;
  }
  if hunks == 0 { Err(bad()) } else { Ok(()) }
}

/// `@@ -a,b +c,d @@ …` → (b, d); a missing count is 1.
fn parse_hunk_header(line: &str) -> Option<(usize, usize)> {
  let rest = line.strip_prefix("@@ -")?;
  let (ranges, _) = rest.split_once(" @@")?;
  let (old, new) = ranges.split_once(" +")?;
  let count = |r: &str| -> Option<usize> {
    let mut parts = r.splitn(2, ',');
    parts.next()?.parse::<usize>().ok()?;
    match parts.next() {
      Some(n) => n.parse().ok(),
      None => Some(1),
    }
  };
  Some((count(old)?, count(new)?))
}

/// A path as git writes it in a patch header: C-quoted when it has a quote, a backslash or a
/// control character.
fn patch_path(prefix: &str, path: &str) -> String {
  let full = format!("{prefix}{path}");
  if !full.chars().any(|c| c == '"' || c == '\\' || c.is_control()) {
    return full;
  }
  let mut out = String::from("\"");
  for c in full.chars() {
    match c {
      '"' => out.push_str("\\\""),
      '\\' => out.push_str("\\\\"),
      '\n' => out.push_str("\\n"),
      '\t' => out.push_str("\\t"),
      c if c.is_control() => out.push_str(&format!("\\{:03o}", c as u32)),
      c => out.push(c),
    }
  }
  out.push('"');
  out
}

/// The repository's top level and the workspace's path inside it (`""` or `sub/dir/`).
fn toplevel(root: &Path) -> Result<(PathBuf, String), String> {
  let top = run(root, &["rev-parse", "--show-toplevel"])?;
  let prefix = run(root, &["rev-parse", "--show-prefix"])?;
  Ok((PathBuf::from(String::from_utf8_lossy(&top).trim()), String::from_utf8_lossy(&prefix).trim().to_owned()))
}

/// Applies `hunks` (from the index version of `rel` to the new one) to the index only.
pub fn stage_patch(root: &Path, rel: &str, hunks: &str) -> Result<(), String> {
  check_rel(root, rel)?;
  check_hunks(hunks)?;
  if show_index(root, rel)?.is_none() {
    return Err(tr!(ScmEditorMsg::NotTracked, path = rel));
  }
  let (top, prefix) = toplevel(root)?;
  let a = patch_path(&format!("a/{prefix}"), rel);
  let b = patch_path(&format!("b/{prefix}"), rel);
  let patch = format!("diff --git {a} {b}\n--- {a}\n+++ {b}\n{hunks}");
  let _queue = git_queue::lock(root, Scope::Worktree, "apply --cached")?;
  let mut child = git::command()
    .arg("-C")
    .arg(&top)
    .args(["apply", "--cached", "--whitespace=nowarn", "-"])
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|e| format!("git: {e}"))?;
  if let Some(mut stdin) = child.stdin.take() {
    stdin.write_all(patch.as_bytes()).map_err(|e| format!("git apply: {e}"))?;
  }
  let out = child.wait_with_output().map_err(|e| format!("git: {e}"))?;
  if out.status.success() {
    Ok(())
  } else {
    Err(tr!(ScmEditorMsg::PatchFailed, error = String::from_utf8_lossy(&out.stderr).trim()))
  }
}

/// `git blame --porcelain` of the working tree file (`git.blame.ignoreWhitespace`: `-w`). Lines
/// changed on disk but not committed come back under the all-zero commit.
pub fn blame(root: &Path, rel: &str, ignore_whitespace: bool) -> Result<String, String> {
  check_rel(root, rel)?;
  let mut args = vec!["blame", "--porcelain"];
  if ignore_whitespace {
    args.push("-w");
  }
  args.extend(["--", rel]);
  Ok(String::from_utf8_lossy(&run(root, &args)?).into_owned())
}

/// One commit of a file's history.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct FileCommit {
  pub hash: String,
  pub short: String,
  pub author: String,
  pub email: String,
  /// Unix seconds (`git.timeline.date`: authored or committed).
  pub author_time: i64,
  pub commit_time: i64,
  /// Branch and tag names pointing at the commit.
  pub refs: Vec<String>,
  pub subject: String,
  pub body: String,
  /// The file's path in this commit (workspace-relative), and before it when the commit renamed it.
  pub path: String,
  pub orig_path: Option<String>,
  /// git's name-status letter (`A`, `M`, `D`, `R`); empty for merge commits.
  pub status: String,
}

/// Parses `git log --format=%x1e%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%ct%x1f%D%x1f%s%x1f%b%x1f
/// --name-status`. Paths are made relative to `prefix`; `rel` stands in when a commit lists none.
pub fn parse_file_log(text: &str, prefix: &str, rel: &str) -> Vec<FileCommit> {
  let strip = |p: &str| p.strip_prefix(prefix).unwrap_or(p).to_owned();
  let mut out: Vec<FileCommit> = Vec::new();
  for rec in text.split('\x1e') {
    let f: Vec<&str> = rec.split('\x1f').collect();
    if f.len() < 10 || f[0].trim().is_empty() {
      continue;
    }
    let refs = f[6].split(", ").map(|r| r.trim().trim_start_matches("HEAD -> ").to_owned()).filter(|r| !r.is_empty() && r != "HEAD").collect();
    // The name-status lines follow the last separator: `M\tpath` or `R100\told\tnew`.
    let change = f[9].lines().map(str::trim_end).find(|l| !l.is_empty()).map(|l| l.split('\t').collect::<Vec<_>>());
    let (status, path, orig_path) = match change.as_deref() {
      Some([s, old, new]) => (s.chars().next().map(String::from).unwrap_or_default(), strip(new), Some(strip(old))),
      Some([s, path]) => (s.chars().next().map(String::from).unwrap_or_default(), strip(path), None),
      // A merge commit lists no files: the path the later commit had before it.
      _ => (String::new(), out.last().map(|c| c.orig_path.clone().unwrap_or_else(|| c.path.clone())).unwrap_or_else(|| rel.to_owned()), None),
    };
    out.push(FileCommit {
      hash: f[0].trim().to_owned(),
      short: f[1].to_owned(),
      author: f[2].to_owned(),
      email: f[3].to_owned(),
      author_time: f[4].parse().unwrap_or(0),
      commit_time: f[5].parse().unwrap_or(0),
      refs,
      subject: f[7].to_owned(),
      body: f[8].trim().to_owned(),
      path,
      orig_path,
      status,
    });
  }
  out
}

/// The commits that changed `rel`, newest first, following renames (`git log --follow`).
pub fn file_log(root: &Path, rel: &str, limit: u32, skip: u32) -> Result<Vec<FileCommit>, String> {
  check_rel(root, rel)?;
  if run(root, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_err() {
    return Ok(Vec::new());
  }
  let (_, prefix) = toplevel(root)?;
  // `--follow` filters after `-n` / `--skip` count commits, so pages are cut here instead.
  let limit = limit.clamp(1, 500) as usize;
  let n = format!("-n{}", limit + skip as usize);
  let format = "--format=%x1e%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%ct%x1f%D%x1f%s%x1f%b%x1f";
  let out = run(root, &["log", "--follow", "--name-status", &n, format, "HEAD", "--", rel])?;
  Ok(parse_file_log(&String::from_utf8_lossy(&out), &prefix, rel).into_iter().skip(skip as usize).take(limit).collect())
}

/// A commit for the blame hover: its whole message and `--shortstat` counts.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct CommitInfo {
  pub hash: String,
  pub author: String,
  pub email: String,
  pub time: i64,
  pub message: String,
  pub files: u32,
  pub insertions: u32,
  pub deletions: u32,
}

/// ` 2 files changed, 5 insertions(+), 1 deletion(-)` → (2, 5, 1).
pub fn parse_shortstat(text: &str) -> (u32, u32, u32) {
  let mut stat = (0, 0, 0);
  for part in text.trim().split(", ") {
    let mut words = part.split_whitespace();
    let n = words.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    match words.next() {
      Some(w) if w.starts_with("file") => stat.0 = n,
      Some(w) if w.starts_with("insertion") => stat.1 = n,
      Some(w) if w.starts_with("deletion") => stat.2 = n,
      _ => {}
    }
  }
  stat
}

pub fn commit_info(root: &Path, hash: &str) -> Result<CommitInfo, String> {
  check_rev(hash)?;
  let out = run(root, &["show", "-s", "--format=%H%x1f%an%x1f%ae%x1f%at%x1f%B", "--end-of-options", hash])?;
  let text = String::from_utf8_lossy(&out);
  let f: Vec<&str> = text.splitn(5, '\x1f').collect();
  if f.len() < 5 {
    return Err(format!("git show {hash}: unexpected output"));
  }
  let stat = run(root, &["show", "--shortstat", "--format=", "--end-of-options", hash])?;
  let (files, insertions, deletions) = parse_shortstat(&String::from_utf8_lossy(&stat));
  Ok(CommitInfo {
    hash: f[0].to_owned(),
    author: f[1].to_owned(),
    email: f[2].to_owned(),
    time: f[3].trim().parse().unwrap_or(0),
    message: f[4].trim_end().to_owned(),
    files,
    insertions,
    deletions,
  })
}

// --- Tauri commands (the open folder's repository).

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

fn checked(ws: &Workspace, rel: &str) -> Result<PathBuf, String> {
  let root = ws.root()?;
  check_rel(&root, rel)?;
  Ok(root)
}

/// The index version of a file (quick diff, index ↔ working tree diffs); `None` when untracked or conflicted.
#[tauri::command]
pub async fn scm_show_index(ws: State<'_, Workspace>, rel: String) -> Result<Option<String>, String> {
  let root = checked(&ws, &rel)?;
  blocking(move || show_index(&root, &rel)).await
}

/// Stage 1, 2 or 3 of a conflicted file (the merge editor's base, current and incoming).
#[tauri::command]
pub async fn scm_show_stage(ws: State<'_, Workspace>, rel: String, stage: u8) -> Result<String, String> {
  let root = checked(&ws, &rel)?;
  blocking(move || show_stage(&root, &rel, stage)).await
}

/// Stages hunks of a file computed by the webview (stage / unstage selected ranges).
#[tauri::command]
pub async fn scm_stage_patch(ws: State<'_, Workspace>, rel: String, hunks: String) -> Result<(), String> {
  let root = checked(&ws, &rel)?;
  blocking(move || stage_patch(&root, &rel, &hunks)).await
}

#[tauri::command]
pub async fn scm_blame(ws: State<'_, Workspace>, rel: String, ignore_whitespace: Option<bool>) -> Result<String, String> {
  let root = checked(&ws, &rel)?;
  blocking(move || blame(&root, &rel, ignore_whitespace.unwrap_or(false))).await
}

#[tauri::command]
pub async fn scm_file_log(ws: State<'_, Workspace>, rel: String, limit: Option<u32>, skip: Option<u32>) -> Result<Vec<FileCommit>, String> {
  let root = checked(&ws, &rel)?;
  blocking(move || file_log(&root, &rel, limit.unwrap_or(50), skip.unwrap_or(0))).await
}

#[tauri::command]
pub async fn scm_commit_info(ws: State<'_, Workspace>, hash: String) -> Result<CommitInfo, String> {
  let root = ws.root()?;
  blocking(move || commit_info(&root, &hash)).await
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::process::Command;

  fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
  }

  fn write(repo: &Path, rel: &str, text: &str) {
    let p = repo.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
  }

  fn repo() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().canonicalize().unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    for (k, v) in [("user.name", "Ann"), ("user.email", "ann@example.com"), ("commit.gpgsign", "false")] {
      git(&repo, &["config", k, v]);
    }
    (tmp, repo)
  }

  fn commit_all(repo: &Path, msg: &str) {
    git(repo, &["add", "-A"]);
    git(repo, &["commit", "-q", "-m", msg]);
  }

  const TEN: &str = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n";

  #[test]
  fn reads_the_index_apart_from_head_and_the_working_tree() {
    let (_tmp, repo) = repo();
    write(&repo, "a.txt", "head\n");
    commit_all(&repo, "init");
    write(&repo, "a.txt", "staged\n");
    git(&repo, &["add", "a.txt"]);
    write(&repo, "a.txt", "working\n");
    write(&repo, "new.txt", "u\n");
    assert_eq!(show_index(&repo, "a.txt").unwrap().as_deref(), Some("staged\n"));
    assert_eq!(git::show_head(&repo, "a.txt").unwrap(), "head\n");
    assert_eq!(show_index(&repo, "new.txt").unwrap(), None, "untracked");
    assert_eq!(show_index(&repo, "missing.txt").unwrap(), None);
    assert!(show_stage(&repo, "a.txt", 0).is_err() && show_stage(&repo, "a.txt", 4).is_err());
  }

  #[test]
  fn checks_that_a_patch_is_only_hunks() {
    assert!(check_hunks("@@ -1,2 +1,2 @@\n a\n-b\n+c\n").is_ok());
    assert!(check_hunks("@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n").is_ok());
    assert!(check_hunks("@@ -0,0 +1 @@\n+x\n@@ -5,1 +6,0 @@\n-y\n").is_ok());
    for bad in [
      "",
      "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n",
      // Counts that leave a file header outside the hunk.
      "@@ -1 +1 @@\n-a\n+b\n--- a/other\n+++ b/other\n@@ -1 +1 @@\n-x\n+y\n",
      "@@ -1,2 +1,2 @@\n a\n-b\n",
      "@@ -1 +1 @@\n-a\n+b",
      "@@ -1 +1 @@\n?a\n+b\n",
    ] {
      assert!(check_hunks(bad).is_err(), "{bad:?}");
    }
  }

  #[test]
  fn stages_only_the_given_hunk_in_a_subfolder_and_with_odd_names() {
    let (_tmp, repo) = repo();
    for name in ["sub/a.txt", "sub/ไฟล์ ไทย.txt", "sub/q\"uote.txt"] {
      write(&repo, name, TEN);
    }
    commit_all(&repo, "init");
    let ws = repo.join("sub");
    for name in ["a.txt", "ไฟล์ ไทย.txt", "q\"uote.txt"] {
      write(&ws, name, &TEN.replace("2\n", "two\n").replace("9\n", "nine\n"));
      // The first change only (index → index with line 2 changed).
      stage_patch(&ws, name, "@@ -1,3 +1,3 @@\n 1\n-2\n+two\n 3\n").unwrap();
      assert_eq!(show_index(&ws, name).unwrap().unwrap(), TEN.replace("2\n", "two\n"), "{name}");
      // Unstaging it again is the reverse hunk, from the index text.
      stage_patch(&ws, name, "@@ -1,3 +1,3 @@\n 1\n-two\n+2\n 3\n").unwrap();
      assert_eq!(show_index(&ws, name).unwrap().unwrap(), TEN);
      assert_eq!(std::fs::read_to_string(ws.join(name)).unwrap(), TEN.replace("2\n", "two\n").replace("9\n", "nine\n"), "the working tree is left alone");
    }
    // A hunk that does not match the index fails without touching it.
    assert!(stage_patch(&ws, "a.txt", "@@ -1,1 +1,1 @@\n-nope\n+x\n").unwrap_err().contains("stage"));
    write(&ws, "u.txt", "x\n");
    assert!(stage_patch(&ws, "u.txt", "@@ -0,0 +1 @@\n+x\n").is_err(), "untracked files are staged whole");
    assert!(stage_patch(&ws, "../a.txt", "@@ -1 +1 @@\n-a\n+b\n").is_err());
  }

  #[test]
  fn stages_a_missing_final_newline() {
    let (_tmp, repo) = repo();
    write(&repo, "a.txt", "a\nb");
    commit_all(&repo, "init");
    write(&repo, "a.txt", "a\nb\nc\n");
    stage_patch(&repo, "a.txt", "@@ -1,2 +1,3 @@\n a\n-b\n\\ No newline at end of file\n+b\n+c\n").unwrap();
    assert_eq!(show_index(&repo, "a.txt").unwrap().unwrap(), "a\nb\nc\n");
  }

  #[test]
  fn blames_committed_and_uncommitted_lines() {
    let (_tmp, repo) = repo();
    write(&repo, "a.txt", "one\ntwo\n");
    commit_all(&repo, "first");
    git(&repo, &["-c", "user.name=Bo", "-c", "user.email=bo@example.com", "commit", "-q", "--allow-empty", "-m", "empty"]);
    write(&repo, "a.txt", "one\ntwo\nthree\n");
    git(&repo, &["add", "a.txt"]);
    git(&repo, &["-c", "user.name=Bo", "-c", "user.email=bo@example.com", "commit", "-q", "-m", "second\n\nbody"]);
    write(&repo, "a.txt", "one\nTWO\nthree\n");
    let out = blame(&repo, "a.txt", false).unwrap();
    assert!(out.contains("author Ann\n") && out.contains("author Bo\n"), "{out}");
    assert!(out.contains("summary first\n") && out.contains("summary second\n"));
    assert!(out.contains("0000000000000000000000000000000000000000 2 2 1\n"), "the edited line is not committed: {out}");
    assert!(blame(&repo, "nope.txt", false).is_err());
    let head = git(&repo, &["rev-parse", "HEAD"]).trim().to_owned();
    let info = commit_info(&repo, &head).unwrap();
    assert_eq!((info.author.as_str(), info.message.as_str(), info.files, info.insertions, info.deletions), ("Bo", "second\n\nbody", 1, 1, 0));
    assert!(commit_info(&repo, "--all").is_err());
  }

  #[test]
  fn follows_a_file_across_a_rename() {
    let (_tmp, repo) = repo();
    write(&repo, "old.txt", TEN);
    commit_all(&repo, "add");
    git(&repo, &["mv", "old.txt", "new.txt"]);
    commit_all(&repo, "rename");
    write(&repo, "new.txt", &TEN.replace("5\n", "five\n"));
    commit_all(&repo, "edit");
    write(&repo, "other.txt", "x\n");
    commit_all(&repo, "unrelated");
    let log = file_log(&repo, "new.txt", 50, 0).unwrap();
    let rows: Vec<(&str, &str, &str, Option<&str>)> = log.iter().map(|c| (c.subject.as_str(), c.status.as_str(), c.path.as_str(), c.orig_path.as_deref())).collect();
    assert_eq!(rows, [("edit", "M", "new.txt", None), ("rename", "R", "new.txt", Some("old.txt")), ("add", "A", "old.txt", None)]);
    assert_eq!(log[0].author, "Ann");
    assert_eq!(file_log(&repo, "new.txt", 1, 1).unwrap()[0].subject, "rename");
  }

  #[test]
  fn parses_file_log_records() {
    let text = "\x1eabc\x1fab\x1fAnn\x1fa@x\x1f10\x1f20\x1fHEAD -> main, tag: v1\x1fFix\x1fbody\nmore\n\x1f\n\nM\tws/a.ts\n\
                \x1edef\x1fde\x1fBo\x1fb@x\x1f5\x1f6\x1f\x1fMerge\x1f\x1f\n\
                \x1eghi\x1fgh\x1fBo\x1fb@x\x1f1\x1f2\x1f\x1fMove\x1f\x1f\n\nR090\tws/old.ts\tws/a.ts\n";
    let log = parse_file_log(text, "ws/", "a.ts");
    assert_eq!(log.len(), 3);
    assert_eq!((log[0].path.as_str(), log[0].refs.clone(), log[0].body.as_str()), ("a.ts", vec!["main".to_owned(), "tag: v1".to_owned()], "body\nmore"));
    assert_eq!((log[1].status.as_str(), log[1].path.as_str()), ("", "a.ts"));
    assert_eq!((log[2].path.as_str(), log[2].orig_path.as_deref()), ("a.ts", Some("old.ts")));
    assert_eq!(parse_shortstat(" 2 files changed, 5 insertions(+), 1 deletion(-)\n"), (2, 5, 1));
    assert_eq!(parse_shortstat(" 1 file changed, 3 deletions(-)"), (1, 0, 3));
  }

  /// A real merge of two branches that both changed line 2.
  fn conflicted(style: Option<&str>) -> (tempfile::TempDir, PathBuf) {
    let (tmp, repo) = repo();
    if let Some(s) = style {
      git(&repo, &["config", "merge.conflictStyle", s]);
    }
    write(&repo, "a.txt", "1\nbase\n3\n");
    commit_all(&repo, "base");
    git(&repo, &["checkout", "-q", "-b", "other"]);
    write(&repo, "a.txt", "1\ntheirs\n3\n");
    commit_all(&repo, "theirs");
    git(&repo, &["checkout", "-q", "main"]);
    write(&repo, "a.txt", "1\nours\n3\n");
    commit_all(&repo, "ours");
    let merge = Command::new("git").arg("-C").arg(&repo).args(["merge", "-q", "other"]).output().unwrap();
    assert!(!merge.status.success(), "the merge conflicts");
    (tmp, repo)
  }

  #[test]
  fn reads_the_three_sides_of_a_real_conflict() {
    let (_tmp, repo) = conflicted(None);
    assert_eq!(show_stage(&repo, "a.txt", 1).unwrap(), "1\nbase\n3\n");
    assert_eq!(show_stage(&repo, "a.txt", 2).unwrap(), "1\nours\n3\n");
    assert_eq!(show_stage(&repo, "a.txt", 3).unwrap(), "1\ntheirs\n3\n");
    assert_eq!(show_index(&repo, "a.txt").unwrap(), None, "no stage 0 while conflicted");
    let text = std::fs::read_to_string(repo.join("a.txt")).unwrap();
    assert_eq!(text, "1\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> other\n3\n");
    let st = git::status(&repo).unwrap().unwrap();
    assert!(st.entries.iter().any(|e| e.path == "a.txt" && e.conflict));

    let (_tmp3, repo3) = conflicted(Some("diff3"));
    let text = std::fs::read_to_string(repo3.join("a.txt")).unwrap();
    assert!(text.contains("<<<<<<< HEAD\nours\n||||||| ") && text.contains("\nbase\n=======\ntheirs\n>>>>>>> other\n"), "{text}");
    // Completing the merge: the resolved file staged leaves no conflict.
    write(&repo3, "a.txt", "1\nours\ntheirs\n3\n");
    git::stage(&repo3, &["a.txt".into()]).unwrap();
    assert!(git::status(&repo3).unwrap().unwrap().entries.iter().all(|e| !e.conflict));
  }
}
