//! Per-hunk review of a task worktree file against the task's fork point (the same comparison
//! as `review::diff_stat` and the per-file reject): the hunks of `git diff -U0 <fork> -- <file>`,
//! and rejecting some of them by reverse-applying a patch made of just those hunks to the working
//! tree (`git apply -R --unidiff-zero`). Accepting a hunk is only a mark, kept with the file marks
//! in tasks.json (`accepted_hunks`). A hunk is named by a hash of its file and its removed and
//! added lines, so the mark survives edits elsewhere in the file.
//!
//! Files that were added or deleted since the fork point (untracked ones too) are one hunk that
//! covers the whole file; rejecting it is rejecting the file (`review::reject`).

use std::io::Write;
use std::path::Path;
use std::process::Stdio;

use sha2::{Digest, Sha256};

use crate::git::{self, check_rel};

use super::review::{self, merge_base};

/// Files larger than this are not split into hunks.
const MAX_DIFF_BYTES: usize = 8 * 1024 * 1024;
const MAX_IDS: usize = 10_000;

/// One change of a file. Lines are 1-based; a count of 0 means an insertion (old side) or a
/// deletion (new side) placed after line `start` (git's `-U0` convention).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Hunk {
  pub id: String,
  pub old_start: u32,
  pub old_lines: u32,
  pub new_start: u32,
  pub new_lines: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct FileHunks {
  pub path: String,
  /// Added or deleted since the fork point (or untracked): the only hunk is the whole file.
  pub whole_file: bool,
  /// Binary or too large: no hunks, review it as a file.
  pub binary: bool,
  pub hunks: Vec<Hunk>,
}

/// A hunk as git printed it: the `@@` line and the lines after it (`-`, `+`, `\ No newline…`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawHunk {
  pub old_start: u32,
  pub old_lines: u32,
  pub new_start: u32,
  pub new_lines: u32,
  pub lines: Vec<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ParsedDiff {
  pub new_file: bool,
  pub deleted_file: bool,
  pub binary: bool,
  /// The `--- ` and `+++ ` lines.
  pub old_name: Vec<u8>,
  pub new_name: Vec<u8>,
  pub hunks: Vec<RawHunk>,
}

/// `-12,3` / `+4` (count 1 when left out).
fn range(s: &str) -> Option<(u32, u32)> {
  match s.split_once(',') {
    Some((a, b)) => Some((a.parse().ok()?, b.parse().ok()?)),
    None => Some((s.parse().ok()?, 1)),
  }
}

/// `@@ -a,b +c,d @@ section` → (a, b, c, d).
pub fn parse_hunk_header(line: &str) -> Option<(u32, u32, u32, u32)> {
  let rest = line.strip_prefix("@@ -")?;
  let (ranges, _) = rest.split_once(" @@")?;
  let (old, new) = ranges.split_once(" +")?;
  let (a, b) = range(old)?;
  let (c, d) = range(new)?;
  Some((a, b, c, d))
}

/// Parses the `git diff` of one file (bytes: the file need not be UTF-8).
pub fn parse_diff(out: &[u8]) -> ParsedDiff {
  let mut d = ParsedDiff::default();
  let mut lines: Vec<&[u8]> = out.split(|&b| b == b'\n').collect();
  if lines.last().is_some_and(|l| l.is_empty()) {
    lines.pop();
  }
  for line in lines {
    if let Some(h) = d.hunks.last_mut()
      && matches!(line.first(), Some(b'-' | b'+' | b' ' | b'\\'))
    {
      h.lines.push(line.to_vec());
      continue;
    }
    if line.starts_with(b"@@ ") {
      if let Some((a, b, c, e)) = parse_hunk_header(&String::from_utf8_lossy(line)) {
        d.hunks.push(RawHunk { old_start: a, old_lines: b, new_start: c, new_lines: e, lines: vec![line.to_vec()] });
      }
    } else if line.starts_with(b"new file mode") {
      d.new_file = true;
    } else if line.starts_with(b"deleted file mode") {
      d.deleted_file = true;
    } else if line.starts_with(b"Binary files ") || line == b"GIT binary patch" {
      d.binary = true;
    } else if line.starts_with(b"--- ") {
      d.old_name = line.to_vec();
    } else if line.starts_with(b"+++ ") {
      d.new_name = line.to_vec();
    }
  }
  d
}

fn hash_id(parts: &[&[u8]]) -> String {
  let mut h = Sha256::new();
  for p in parts {
    h.update((p.len() as u64).to_le_bytes());
    h.update(p);
  }
  h.finalize().iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// Ids of `hunks`: a hash of the path and the hunk's lines (not its position), with `-n` added
/// to the n-th repeat of an identical hunk in the same file.
pub fn hunk_ids(path: &str, hunks: &[RawHunk]) -> Vec<String> {
  let mut seen: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
  hunks
    .iter()
    .map(|h| {
      let mut parts: Vec<&[u8]> = vec![path.as_bytes()];
      parts.extend(h.lines.iter().skip(1).map(Vec::as_slice));
      let base = hash_id(&parts);
      let n = seen.entry(base.clone()).or_insert(0);
      *n += 1;
      if *n == 1 { base } else { format!("{base}-{n}") }
    })
    .collect()
}

pub fn valid_id(id: &str) -> bool {
  !id.is_empty() && id.len() <= 32 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// A patch of one file holding only `hunks` (in file order), for `git apply --unidiff-zero`.
/// Mode and index lines are left out, so applying it changes contents only.
pub fn build_patch(path: &str, d: &ParsedDiff, hunks: &[&RawHunk]) -> Vec<u8> {
  let mut out = Vec::new();
  out.extend_from_slice(format!("diff --git a/{path} b/{path}\n").as_bytes());
  for name in [&d.old_name, &d.new_name] {
    out.extend_from_slice(name);
    out.push(b'\n');
  }
  for h in hunks {
    for line in &h.lines {
      out.extend_from_slice(line);
      out.push(b'\n');
    }
  }
  out
}

fn diff_of(dir: &Path, fork: &str, rel: &str) -> Result<Vec<u8>, String> {
  git::run(
    dir,
    &["diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", fork, "--", rel],
  )
}

fn is_untracked(dir: &Path, rel: &str) -> Result<bool, String> {
  Ok(!git::run(dir, &["ls-files", "--others", "--exclude-standard", "-z", "--", rel])?.is_empty())
}

/// The hunk of an untracked file: all of it, named by its contents.
fn untracked_hunks(dir: &Path, rel: &str) -> FileHunks {
  let bytes = std::fs::read(dir.join(rel)).ok().filter(|b| b.len() <= MAX_DIFF_BYTES && !b.contains(&0));
  let Some(bytes) = bytes else { return FileHunks { path: rel.to_owned(), whole_file: true, binary: true, hunks: vec![] } };
  let mut lines = bytes.iter().filter(|&&b| b == b'\n').count() as u32;
  if bytes.last().is_some_and(|&b| b != b'\n') {
    lines += 1;
  }
  let id = hash_id(&[rel.as_bytes(), b"untracked", &bytes]);
  let hunk = Hunk { id, old_start: 0, old_lines: 0, new_start: u32::from(lines > 0), new_lines: lines };
  FileHunks { path: rel.to_owned(), whole_file: true, binary: false, hunks: vec![hunk] }
}

/// The diff of `rel` against the fork point, parsed; `None` for an untracked file.
fn load(dir: &Path, fork: &str, rel: &str) -> Result<Option<ParsedDiff>, String> {
  if is_untracked(dir, rel)? {
    return Ok(None);
  }
  let out = diff_of(dir, fork, rel)?;
  let mut d = parse_diff(&out);
  if out.len() > MAX_DIFF_BYTES {
    d.binary = true;
  }
  Ok(Some(d))
}

fn to_file_hunks(rel: &str, d: &ParsedDiff) -> FileHunks {
  let binary = d.binary;
  let hunks = if binary {
    vec![]
  } else {
    hunk_ids(rel, &d.hunks)
      .into_iter()
      .zip(&d.hunks)
      .map(|(id, h)| Hunk { id, old_start: h.old_start, old_lines: h.old_lines, new_start: h.new_start, new_lines: h.new_lines })
      .collect()
  };
  FileHunks { path: rel.to_owned(), whole_file: d.new_file || d.deleted_file, binary, hunks }
}

/// The hunks of `rel` in the task worktree `dir` since it forked from `base`.
pub fn file_hunks(dir: &Path, base: &str, rel: &str) -> Result<FileHunks, String> {
  check_rel(dir, rel)?;
  let fork = merge_base(dir, base)?;
  Ok(match load(dir, &fork, rel)? {
    Some(d) => to_file_hunks(rel, &d),
    None => untracked_hunks(dir, rel),
  })
}

fn apply_reverse(dir: &Path, patch: &[u8]) -> Result<(), String> {
  let mut child = git::command()
    .arg("-C")
    .arg(dir)
    .args(["apply", "-R", "--unidiff-zero", "--whitespace=nowarn", "-"])
    .stdin(Stdio::piped())
    .stdout(Stdio::null())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|e| format!("git: {e}"))?;
  if let Some(mut stdin) = child.stdin.take() {
    stdin.write_all(patch).map_err(|e| format!("git apply: {e}"))?;
  }
  let out = child.wait_with_output().map_err(|e| format!("git apply: {e}"))?;
  if !out.status.success() {
    return Err(format!("git apply: {}", String::from_utf8_lossy(&out.stderr).trim()));
  }
  Ok(())
}

/// Rejects the hunks `ids` of `rel`: they go back to how they were at the fork point, the rest of
/// the file stays. An id that is not among the file's current hunks fails the whole call (the
/// file changed since the hunks were read). A whole-file hunk rejects the file. Returns how many
/// hunks were rejected.
pub fn reject_hunks(dir: &Path, base: &str, rel: &str, ids: &[String]) -> Result<usize, String> {
  check_rel(dir, rel)?;
  if ids.is_empty() {
    return Ok(0);
  }
  if ids.len() > MAX_IDS || !ids.iter().all(|i| valid_id(i)) {
    return Err("invalid hunk id".into());
  }
  let fork = merge_base(dir, base)?;
  let parsed = load(dir, &fork, rel)?;
  let current = match &parsed {
    Some(d) => to_file_hunks(rel, d),
    None => untracked_hunks(dir, rel),
  };
  if let Some(missing) = ids.iter().find(|id| !current.hunks.iter().any(|h| &h.id == *id)) {
    return Err(format!("{rel}: change {missing} is no longer in the file (refresh the diff)"));
  }
  match parsed {
    Some(d) if !current.whole_file => {
      let picked: Vec<&RawHunk> = current.hunks.iter().zip(&d.hunks).filter(|(h, _)| ids.contains(&h.id)).map(|(_, r)| r).collect();
      apply_reverse(dir, &build_patch(rel, &d, &picked))?;
      Ok(picked.len())
    }
    _ => {
      review::reject(dir, base, &[rel.to_owned()])?;
      Ok(1)
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::agent::worktree;
  use std::path::PathBuf;
  use std::process::Command;

  const DIFF: &str = "diff --git a/f.txt b/f.txt\nindex 1..2 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -2 +2 @@ x\n-two\n+TWO\n@@ -4,0 +5,2 @@\n+new1\n+new2\n@@ -9 +10,0 @@\n-nine\n\\ No newline at end of file\n";

  #[test]
  fn parses_hunk_headers() {
    assert_eq!(parse_hunk_header("@@ -2 +2 @@"), Some((2, 1, 2, 1)));
    assert_eq!(parse_hunk_header("@@ -4,0 +5,2 @@ fn x()"), Some((4, 0, 5, 2)));
    assert_eq!(parse_hunk_header("@@ -0,0 +1,3 @@"), Some((0, 0, 1, 3)));
    assert_eq!(parse_hunk_header("@@ bad @@"), None);
    assert_eq!(parse_hunk_header("+++ b/x"), None);
  }

  #[test]
  fn parses_a_file_diff_into_hunks() {
    let d = parse_diff(DIFF.as_bytes());
    assert!(!d.new_file && !d.deleted_file && !d.binary);
    assert_eq!(d.old_name, b"--- a/f.txt");
    assert_eq!(d.new_name, b"+++ b/f.txt");
    let ranges: Vec<_> = d.hunks.iter().map(|h| (h.old_start, h.old_lines, h.new_start, h.new_lines, h.lines.len())).collect();
    assert_eq!(ranges, [(2, 1, 2, 1, 3), (4, 0, 5, 2, 3), (9, 1, 10, 0, 3)]);
    assert_eq!(d.hunks[2].lines[2], b"\\ No newline at end of file");

    let added = parse_diff(b"diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ -0,0 +1 @@\n+x\n");
    assert!(added.new_file && added.hunks.len() == 1);
    let bin = parse_diff(b"diff --git a/b b/b\nindex 1..2 100644\nBinary files a/b and b/b differ\n");
    assert!(bin.binary && bin.hunks.is_empty());
  }

  #[test]
  fn ids_follow_contents_not_positions() {
    let d = parse_diff(DIFF.as_bytes());
    let ids = hunk_ids("f.txt", &d.hunks);
    assert_eq!(ids.len(), 3);
    assert!(ids.iter().all(|i| valid_id(i) && i.len() == 16));
    // The same change further down the file keeps its id; another file gets another one.
    let moved = DIFF.replace("@@ -2 +2 @@ x", "@@ -20 +30 @@ y");
    assert_eq!(hunk_ids("f.txt", &parse_diff(moved.as_bytes()).hunks)[0], ids[0]);
    assert_ne!(hunk_ids("g.txt", &d.hunks)[0], ids[0]);
    // A repeat of an identical hunk is numbered.
    let twice = DIFF.replace("@@ -4,0 +5,2 @@\n+new1\n+new2\n", "@@ -4 +4 @@\n-two\n+TWO\n");
    let ids2 = hunk_ids("f.txt", &parse_diff(twice.as_bytes()).hunks);
    assert_eq!(ids2[1], format!("{}-2", ids2[0]));
    assert!(!valid_id("") && !valid_id("../x") && !valid_id(&"a".repeat(33)));
  }

  #[test]
  fn builds_a_patch_of_the_picked_hunks_only() {
    let d = parse_diff(DIFF.as_bytes());
    let patch = build_patch("f.txt", &d, &[&d.hunks[0], &d.hunks[2]]);
    assert_eq!(
      String::from_utf8(patch).unwrap(),
      "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -2 +2 @@ x\n-two\n+TWO\n@@ -9 +10,0 @@\n-nine\n\\ No newline at end of file\n"
    );
  }

  fn git_ok(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
  }

  const BASE: &str = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n";

  /// main with `f.txt` (ten numbered lines) and `gone.txt`; a task worktree `t` forked from it.
  fn setup() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().canonicalize().unwrap();
    git_ok(&repo, &["init", "-q", "-b", "main"]);
    for (k, v) in [("user.name", "t"), ("user.email", "t@example.com"), ("commit.gpgsign", "false")] {
      git_ok(&repo, &["config", k, v]);
    }
    std::fs::write(repo.join(".gitignore"), ".kingu/\n").unwrap();
    std::fs::write(repo.join("f.txt"), BASE).unwrap();
    std::fs::write(repo.join("gone.txt"), "bye\n").unwrap();
    git_ok(&repo, &["add", "."]);
    git_ok(&repo, &["commit", "-q", "-m", "init"]);
    worktree::create(&repo, "t", Some("main"), None).unwrap();
    let wt = review::task_dir(&repo, "t").unwrap();
    (tmp, repo, wt)
  }

  fn read(wt: &Path, rel: &str) -> String {
    std::fs::read_to_string(wt.join(rel)).unwrap()
  }

  #[test]
  fn rejects_one_hunk_and_keeps_the_others() {
    let (_tmp, _repo, wt) = setup();
    // A committed change and two uncommitted ones: all count against the fork point.
    std::fs::write(wt.join("f.txt"), "1\nTWO\n3\n4\n5\n6\n7\n8\n9\n10\n").unwrap();
    git_ok(&wt, &["commit", "-qam", "agent"]);
    std::fs::write(wt.join("f.txt"), "1\nTWO\n3\n4\nnew\n5\n6\n7\n8\n10\n").unwrap();

    let fh = file_hunks(&wt, "main", "f.txt").unwrap();
    assert!(!fh.whole_file && !fh.binary);
    let ranges: Vec<_> = fh.hunks.iter().map(|h| (h.old_start, h.old_lines, h.new_start, h.new_lines)).collect();
    assert_eq!(ranges, [(2, 1, 2, 1), (4, 0, 5, 1), (9, 1, 9, 0)]);

    // Reject the middle insertion: the edit above and the deletion below stay.
    assert_eq!(reject_hunks(&wt, "main", "f.txt", &[fh.hunks[1].id.clone()]).unwrap(), 1);
    assert_eq!(read(&wt, "f.txt"), "1\nTWO\n3\n4\n5\n6\n7\n8\n10\n");
    let left = file_hunks(&wt, "main", "f.txt").unwrap();
    assert_eq!(left.hunks.iter().map(|h| h.id.as_str()).collect::<Vec<_>>(), [fh.hunks[0].id.as_str(), fh.hunks[2].id.as_str()]);

    // A stale id (already rejected) fails without touching the file.
    let err = reject_hunks(&wt, "main", "f.txt", &[fh.hunks[1].id.clone(), fh.hunks[0].id.clone()]).unwrap_err();
    assert!(err.contains("no longer"), "{err}");
    assert_eq!(read(&wt, "f.txt"), "1\nTWO\n3\n4\n5\n6\n7\n8\n10\n");

    // Two at once: the file is back to the base.
    reject_hunks(&wt, "main", "f.txt", &[left.hunks[0].id.clone(), left.hunks[1].id.clone()]).unwrap();
    assert_eq!(read(&wt, "f.txt"), BASE);
    assert!(file_hunks(&wt, "main", "f.txt").unwrap().hunks.is_empty());
  }

  #[test]
  fn handles_a_missing_final_newline() {
    let (_tmp, _repo, wt) = setup();
    std::fs::write(wt.join("f.txt"), "one\n2\n3\n4\n5\n6\n7\n8\n9\n10").unwrap();
    let fh = file_hunks(&wt, "main", "f.txt").unwrap();
    assert_eq!(fh.hunks.len(), 2);
    reject_hunks(&wt, "main", "f.txt", &[fh.hunks[1].id.clone()]).unwrap();
    assert_eq!(read(&wt, "f.txt"), "one\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
    reject_hunks(&wt, "main", "f.txt", &[file_hunks(&wt, "main", "f.txt").unwrap().hunks[0].id.clone()]).unwrap();
    assert_eq!(read(&wt, "f.txt"), BASE);
  }

  #[test]
  fn whole_files_are_one_hunk_and_reject_as_files() {
    let (_tmp, _repo, wt) = setup();
    std::fs::write(wt.join("new.txt"), "a\nb\n").unwrap();
    std::fs::remove_file(wt.join("gone.txt")).unwrap();
    std::fs::write(wt.join("added.txt"), "x\n").unwrap();
    git_ok(&wt, &["add", "added.txt"]);

    let un = file_hunks(&wt, "main", "new.txt").unwrap();
    assert!(un.whole_file);
    assert_eq!((un.hunks.len(), un.hunks[0].new_start, un.hunks[0].new_lines), (1, 1, 2));
    reject_hunks(&wt, "main", "new.txt", &[un.hunks[0].id.clone()]).unwrap();
    assert!(!wt.join("new.txt").exists());

    let del = file_hunks(&wt, "main", "gone.txt").unwrap();
    assert!(del.whole_file && del.hunks.len() == 1);
    reject_hunks(&wt, "main", "gone.txt", &[del.hunks[0].id.clone()]).unwrap();
    assert_eq!(read(&wt, "gone.txt"), "bye\n");

    let add = file_hunks(&wt, "main", "added.txt").unwrap();
    assert!(add.whole_file && add.hunks.len() == 1);
    reject_hunks(&wt, "main", "added.txt", &[add.hunks[0].id.clone()]).unwrap();
    assert!(!wt.join("added.txt").exists());
    assert!(git_ok(&wt, &["status", "--porcelain"]).is_empty());
  }

  #[test]
  fn binary_files_have_no_hunks_and_paths_stay_inside() {
    let (_tmp, _repo, wt) = setup();
    std::fs::write(wt.join("f.txt"), b"\0\x01binary").unwrap();
    let fh = file_hunks(&wt, "main", "f.txt").unwrap();
    assert!(fh.binary && fh.hunks.is_empty());
    assert!(file_hunks(&wt, "main", "../escape.txt").is_err());
    assert!(reject_hunks(&wt, "main", "/etc/passwd", &["00".into()]).is_err());
    assert!(reject_hunks(&wt, "main", "f.txt", &["not-hex!".into()]).unwrap_err().contains("invalid"));
    assert_eq!(reject_hunks(&wt, "main", "f.txt", &[]).unwrap(), 0);
  }
}
