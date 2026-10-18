//! Per-change Keep / Undo of a working-set file (VS Code's ChatEditingCodeEditorIntegration: the
//! Keep / Undo bar of each change in the editor).
//!
//! - The hunks of a file are a minimal line diff (Myers) of its *base* against the file on disk.
//!   The base is the pending head entry's snapshot, advanced by the hunks kept so far
//!   (`Entry::base`); Restore checkpoint still goes back to the snapshot itself (`Entry::before`).
//! - Keep advances the base by that one hunk (a new snapshot blob). Undo writes the file with that
//!   hunk reversed. When the file then equals its base, its entries leave the working set (kept,
//!   or undone when nothing of it was kept).
//! - A file the agent created or deleted is one whole-file hunk: Keep / Undo of it are the file's.
//! - A hunk is named like `agent::hunks`: a hash of the path and its removed and added lines (so
//!   it survives edits elsewhere in the file), with `-n` on the n-th repeat.

use crate::git_queue::{self, Scope};
use crate::i18n::msg::AgentMsg;
use crate::tr;

use super::{Before, Entry, State, Store, keep, pending_heads, undo, write_atomic_bytes};

/// The changed middle of two files beyond this many edits is one hunk (the diff's memory is
/// quadratic in it).
const MAX_EDITS: usize = 2000;

/// One change of a file. Lines are 1-based; a count of 0 means an insertion (old side) or a
/// deletion (new side) placed after line `start` (git's `-U0` convention, as `agent::hunks`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct EditHunk {
  pub id: String,
  pub old_start: u32,
  pub old_lines: u32,
  pub new_start: u32,
  pub new_lines: u32,
  /// The base's lines the change replaced (without line ends), for the editor's deleted-lines zone.
  pub removed: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct FileEditHunks {
  /// Relative to the chat's cwd.
  pub path: String,
  /// Created or deleted by the agent: the only hunk is the whole file.
  pub whole_file: bool,
  /// Binary, or without a saved copy: no hunks.
  pub binary: bool,
  pub hunks: Vec<EditHunk>,
}

/// A change as 0-based line ranges: `a[a0..a0 + an]` became `b[b0..b0 + bn]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
  pub a0: usize,
  pub an: usize,
  pub b0: usize,
  pub bn: usize,
}

/// Lines with their line ends, so joining them gives the bytes back.
pub fn split_lines(x: &[u8]) -> Vec<&[u8]> {
  x.split_inclusive(|&c| c == b'\n').collect()
}

fn binary(x: &[u8]) -> bool {
  x[..x.len().min(8192)].contains(&0)
}

/// The changes between `a` and `b`, in order: a minimal line diff (Myers) of the middle left
/// after the common prefix and suffix, or that whole middle when it needs more than `MAX_EDITS`.
pub fn diff_lines(a: &[&[u8]], b: &[&[u8]]) -> Vec<Span> {
  let pre = a.iter().zip(b).take_while(|(x, y)| x == y).count();
  let suf = a[pre..].iter().rev().zip(b[pre..].iter().rev()).take_while(|(x, y)| x == y).count();
  let (ma, mb) = (&a[pre..a.len() - suf], &b[pre..b.len() - suf]);
  if ma.is_empty() && mb.is_empty() {
    return Vec::new();
  }
  let whole = || vec![Span { a0: pre, an: ma.len(), b0: pre, bn: mb.len() }];
  if ma.is_empty() || mb.is_empty() {
    return whole();
  }
  let Some((del, ins)) = myers(ma, mb) else { return whole() };
  // Walk both sides: unmarked lines pair up in order, marked runs between them are the changes.
  let mut out = Vec::new();
  let (mut i, mut j) = (0, 0);
  while i < ma.len() || j < mb.len() {
    if i < ma.len() && j < mb.len() && !del[i] && !ins[j] {
      i += 1;
      j += 1;
      continue;
    }
    let (i0, j0) = (i, j);
    while i < ma.len() && del[i] {
      i += 1;
    }
    while j < mb.len() && ins[j] {
      j += 1;
    }
    out.push(Span { a0: pre + i0, an: i - i0, b0: pre + j0, bn: j - j0 });
  }
  out
}

/// Which lines of `a` are deleted and of `b` inserted by a shortest edit script; `None` past
/// `MAX_EDITS`. Keeps the furthest-reaching row of each step (`2d + 1` entries) to walk back.
fn myers(a: &[&[u8]], b: &[&[u8]]) -> Option<(Vec<bool>, Vec<bool>)> {
  let (n, m) = (a.len() as isize, b.len() as isize);
  let max = (n + m) as usize;
  let off = max as isize + 1;
  let mut v = vec![0isize; 2 * max + 3];
  let mut rows: Vec<Vec<isize>> = Vec::new();
  let mut end = None;
  'steps: for d in 0..=max.min(MAX_EDITS) as isize {
    let mut k = -d;
    while k <= d {
      let i = (k + off) as usize;
      let mut x = if k == -d || (k != d && v[i - 1] < v[i + 1]) { v[i + 1] } else { v[i - 1] + 1 };
      let mut y = x - k;
      while x < n && y < m && a[x as usize] == b[y as usize] {
        x += 1;
        y += 1;
      }
      v[i] = x;
      if x >= n && y >= m {
        end = Some(d);
        rows.push(Vec::new());
        break 'steps;
      }
      k += 2;
    }
    rows.push(v[(off - d) as usize..=(off + d) as usize].to_vec());
  }
  let end = end?;
  let mut del = vec![false; a.len()];
  let mut ins = vec![false; b.len()];
  let (mut x, mut y) = (n, m);
  for d in (1..=end).rev() {
    let prev = &rows[(d - 1) as usize];
    let at = |k: isize| prev[(k + d - 1) as usize];
    let k = x - y;
    let down = k == -d || (k != d && at(k - 1) < at(k + 1));
    let pk = if down { k + 1 } else { k - 1 };
    let px = at(pk);
    let py = px - pk;
    if down {
      ins[py as usize] = true;
    } else {
      del[px as usize] = true;
    }
    (x, y) = (px, py);
  }
  Some((del, ins))
}

fn hash_id(parts: &[&[u8]]) -> String {
  use sha2::{Digest, Sha256};
  let mut h = Sha256::new();
  for p in parts {
    h.update((p.len() as u64).to_le_bytes());
    h.update(p);
  }
  h.finalize().iter().take(8).map(|b| format!("{b:02x}")).collect()
}

fn text(line: &[u8]) -> String {
  let l = line.strip_suffix(b"\n").unwrap_or(line);
  String::from_utf8_lossy(l.strip_suffix(b"\r").unwrap_or(l)).into_owned()
}

/// The hunks of `path` going from `a` to `b`.
pub fn hunks_of(path: &str, a: &[&[u8]], b: &[&[u8]]) -> Vec<(Span, EditHunk)> {
  let mut seen = std::collections::HashMap::<String, u32>::new();
  diff_lines(a, b)
    .into_iter()
    .map(|s| {
      let old = &a[s.a0..s.a0 + s.an];
      let new = &b[s.b0..s.b0 + s.bn];
      let (minus, plus) = (old.iter().map(|l| [b"-", *l].concat()), new.iter().map(|l| [b"+", *l].concat()));
      let lines: Vec<Vec<u8>> = minus.chain(plus).collect();
      let mut parts: Vec<&[u8]> = vec![path.as_bytes()];
      parts.extend(lines.iter().map(Vec::as_slice));
      let base = hash_id(&parts);
      let n = seen.entry(base.clone()).or_insert(0);
      *n += 1;
      let id = if *n == 1 { base } else { format!("{base}-{n}") };
      // git's -U0 numbering: an empty side names the line it follows.
      let start = |at: usize, len: usize| if len == 0 { at as u32 } else { at as u32 + 1 };
      let hunk = EditHunk {
        id,
        old_start: start(s.a0, s.an),
        old_lines: s.an as u32,
        new_start: start(s.b0, s.bn),
        new_lines: s.bn as u32,
        removed: old.iter().map(|l| text(l)).collect(),
      };
      (s, hunk)
    })
    .collect()
}

/// `a` with `a[s.a0..][..s.an]` replaced by `b[s.b0..][..s.bn]`.
pub fn splice(a: &[&[u8]], s: Span, b: &[&[u8]]) -> Vec<u8> {
  let mut out = Vec::new();
  for l in a[..s.a0].iter().chain(&b[s.b0..s.b0 + s.bn]).chain(&a[s.a0 + s.an..]) {
    out.extend_from_slice(l);
  }
  out
}

/// What the working set compares for `rel`: its pending head entry (index in `entries`), the base
/// bytes (`None` when it did not exist) and the file now (`None` when missing).
struct Sides {
  head: usize,
  base: Option<Vec<u8>>,
  now: Option<Vec<u8>>,
}

/// `Ok(None)`: not in the working set, or no saved copy / unreadable (no hunks to show).
fn sides(store: &Store, f: &super::EditsFile, rel: &str) -> Result<Option<Sides>, String> {
  let Some(head) = pending_heads(f).into_iter().find(|e| e.path == rel) else { return Ok(None) };
  let head = f.entries.iter().position(|e| std::ptr::eq(e, head)).ok_or("no entry")?;
  let base = match f.entries[head].working_base() {
    Before::File { hash, .. } => Some(store.get(hash)?),
    Before::Absent => None,
    Before::Unknown { .. } => return Ok(None),
  };
  let Ok(now) = store.current(rel) else { return Ok(None) };
  Ok(Some(Sides { head, base, now }))
}

fn listing(rel: &str, s: &Sides) -> (FileEditHunks, Vec<Span>) {
  let mut out = FileEditHunks { path: rel.to_owned(), ..Default::default() };
  let (base, now) = (s.base.as_deref().unwrap_or_default(), s.now.as_deref().unwrap_or_default());
  if binary(base) || binary(now) {
    out.binary = true;
    return (out, Vec::new());
  }
  let (a, b) = (if s.base.is_some() { split_lines(base) } else { Vec::new() }, if s.now.is_some() { split_lines(now) } else { Vec::new() });
  out.whole_file = s.base.is_none() || s.now.is_none();
  let (spans, hunks): (Vec<Span>, Vec<EditHunk>) = hunks_of(rel, &a, &b).into_iter().unzip();
  out.hunks = hunks;
  (out, spans)
}

/// The hunks of working-set file `rel` (relative to the chat's cwd); none when it is not in the
/// working set or has no saved copy.
pub fn file_hunks(store: &Store, rel: &str) -> Result<FileEditHunks, String> {
  let f = store.load()?;
  Ok(match sides(store, &f, rel)? {
    Some(s) => listing(rel, &s).0,
    None => FileEditHunks { path: rel.to_owned(), ..Default::default() },
  })
}

/// Marks every pending entry of `rel` settled once the file equals its base again.
fn settle(entries: &mut [Entry], rel: &str, state: State) {
  for e in entries.iter_mut().filter(|e| e.state == State::Pending && e.path == rel) {
    e.state = state;
    e.base = None;
  }
}

/// Keep hunk `id` of `rel`: the base takes that change. Returns the file's hunks after it.
pub fn keep_hunk(store: &Store, rel: &str, id: &str) -> Result<FileEditHunks, String> {
  let mut f = store.load()?;
  let s = sides(store, &f, rel)?.ok_or_else(|| tr!(AgentMsg::EditHunkGone, path = rel))?;
  let (list, spans) = listing(rel, &s);
  let i = list.hunks.iter().position(|h| h.id == id).ok_or_else(|| tr!(AgentMsg::EditHunkGone, path = rel))?;
  if list.whole_file {
    keep(store, Some(&[rel.to_owned()]))?;
    return file_hunks(store, rel);
  }
  let (base, now) = (s.base.as_deref().unwrap_or_default(), s.now.as_deref().unwrap_or_default());
  let next = splice(&split_lines(base), spans[i], &split_lines(now));
  if next == now {
    settle(&mut f.entries, rel, State::Kept);
  } else {
    match store.put(&next)? {
      b @ Before::File { .. } => f.entries[s.head].base = Some(b),
      _ => return Err(tr!(AgentMsg::EditHunkNoRoom, path = rel)),
    }
  }
  store.save(&f)?;
  file_hunks(store, rel)
}

/// Undo hunk `id` of `rel`: the file on disk gets that change reversed (under the worktree's git
/// queue lane). Returns the file's hunks after it.
pub fn undo_hunk(store: &Store, rel: &str, id: &str) -> Result<FileEditHunks, String> {
  let mut f = store.load()?;
  let s = sides(store, &f, rel)?.ok_or_else(|| tr!(AgentMsg::EditHunkGone, path = rel))?;
  let (list, spans) = listing(rel, &s);
  let i = list.hunks.iter().position(|h| h.id == id).ok_or_else(|| tr!(AgentMsg::EditHunkGone, path = rel))?;
  if list.whole_file {
    undo(store, Some(&[rel.to_owned()]))?;
    return file_hunks(store, rel);
  }
  let (base, now) = (s.base.as_deref().unwrap_or_default(), s.now.as_deref().unwrap_or_default());
  let sp = spans[i];
  let next = splice(&split_lines(now), Span { a0: sp.b0, an: sp.bn, b0: sp.a0, bn: sp.an }, &split_lines(base));
  let _queue = git_queue::lock(store.cwd(), Scope::Worktree, "undo an agent change")?;
  super::check_rel(store.cwd(), rel).map_err(|_| tr!(AgentMsg::EditPathOutside, path = rel))?;
  let full = store.cwd().join(rel);
  if !std::fs::symlink_metadata(&full).is_ok_and(|m| m.is_file()) {
    return Err(tr!(AgentMsg::EditHunkGone, path = rel));
  }
  write_atomic_bytes(&full, &next)?;
  if next == base {
    let kept_some = f.entries[s.head].base.is_some();
    settle(&mut f.entries, rel, if kept_some { State::Kept } else { State::Undone });
    store.save(&f)?;
  }
  file_hunks(store, rel)
}

#[cfg(test)]
mod tests {
  use super::super::{begin_request, original, record_snapshot, view};
  use super::*;
  use std::path::Path;

  fn lines(s: &str) -> Vec<&[u8]> {
    split_lines(s.as_bytes())
  }

  fn spans(a: &str, b: &str) -> Vec<(usize, usize, usize, usize)> {
    diff_lines(&lines(a), &lines(b)).into_iter().map(|s| (s.a0, s.an, s.b0, s.bn)).collect()
  }

  #[test]
  fn line_diff_is_minimal_and_ordered() {
    assert_eq!(spans("a\nb\nc\n", "a\nb\nc\n"), []);
    assert_eq!(spans("a\nb\nc\n", "a\nB\nc\n"), [(1, 1, 1, 1)]);
    assert_eq!(spans("a\nb\nc\nd\n", "a\nc\nd\ne\nf\n"), [(1, 1, 1, 0), (4, 0, 3, 2)]);
    assert_eq!(spans("", "x\n"), [(0, 0, 0, 1)]);
    assert_eq!(spans("x\ny\n", ""), [(0, 2, 0, 0)]);
    assert_eq!(spans("a\nx\nb\nx\nc\n", "a\nb\nc\n"), [(1, 1, 1, 0), (3, 1, 2, 0)]);
    // Two changes far apart with a moved line between them.
    assert_eq!(spans("1\n2\n3\n4\n5\n6\n", "1\nX\n3\n4\n5\nY\n"), [(1, 1, 1, 1), (5, 1, 5, 1)]);
    // The last line's missing newline is a change of that line.
    assert_eq!(spans("a\nb", "a\nb\n"), [(1, 1, 1, 1)]);
  }

  #[test]
  fn every_diff_rebuilds_both_sides() {
    // Pseudo-random edits: applying all hunks to a gives b, reversing them on b gives a.
    let mut seed = 7u64;
    let mut rnd = |n: u64| {
      seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
      (seed >> 33) % n
    };
    for _ in 0..200 {
      let a: Vec<String> = (0..rnd(12)).map(|_| format!("{}\n", rnd(4))).collect();
      let b: Vec<String> = (0..rnd(12)).map(|_| format!("{}\n", rnd(4))).collect();
      let (a, b) = (a.concat(), b.concat());
      let (la, lb) = (lines(&a), lines(&b));
      let ds = diff_lines(&la, &lb);
      // Apply back to front so earlier spans keep their positions.
      let mut out: Vec<u8> = a.clone().into_bytes();
      for s in ds.iter().rev() {
        out = splice(&split_lines(&out), *s, &lb);
      }
      assert_eq!(String::from_utf8(out).unwrap(), b, "{a:?} -> {b:?}");
      let mut back: Vec<u8> = b.clone().into_bytes();
      for s in ds.iter().rev() {
        back = splice(&split_lines(&back), Span { a0: s.b0, an: s.bn, b0: s.a0, bn: s.an }, &la);
      }
      assert_eq!(String::from_utf8(back).unwrap(), a);
      // Minimal: the edit count is what the line counter finds.
      let (added, removed) = super::super::line_counts(a.as_bytes(), b.as_bytes()).unwrap();
      assert_eq!(ds.iter().map(|s| s.bn as u64).sum::<u64>(), added);
      assert_eq!(ds.iter().map(|s| s.an as u64).sum::<u64>(), removed);
    }
  }

  #[test]
  fn hunks_use_git_numbering_and_stable_ids() {
    let h = hunks_of("f", &lines("a\nb\nc\n"), &lines("a\nc\nX\n"));
    let got: Vec<_> = h.iter().map(|(_, h)| (h.old_start, h.old_lines, h.new_start, h.new_lines, h.removed.clone())).collect();
    assert_eq!(got, [(2, 1, 1, 0, vec!["b".to_owned()]), (3, 0, 3, 1, vec![])]);
    // The same change elsewhere in the file keeps its id; a repeat gets `-2`.
    let again = hunks_of("f", &lines("z\na\nb\nc\n"), &lines("z\na\nc\nX\n"));
    assert_eq!(again[0].1.id, h[0].1.id);
    let twice = hunks_of("f", &lines("a\nx\nb\nx\n"), &lines("a\nb\n"));
    assert_eq!(twice[1].1.id, format!("{}-2", twice[0].1.id));
    assert_ne!(hunks_of("g", &lines("b\n"), &lines(""))[0].1.id, hunks_of("f", &lines("b\n"), &lines(""))[0].1.id);
  }

  fn setup(before: &str, after: &str) -> (tempfile::TempDir, std::path::PathBuf, Store) {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().canonicalize().unwrap();
    std::fs::write(root.join("a.txt"), before).unwrap();
    let store = Store::open(&root, "c", &root).unwrap();
    let r = begin_request(&store, 1).unwrap();
    record_snapshot(&store, r, root.join("a.txt").to_str().unwrap(), true, Some(before.as_bytes()), None).unwrap();
    std::fs::write(root.join("a.txt"), after).unwrap();
    (t, root, store)
  }

  fn read(root: &Path) -> String {
    std::fs::read_to_string(root.join("a.txt")).unwrap()
  }

  #[test]
  fn keep_one_hunk_advances_the_base_only() {
    let (_t, root, store) = setup("1\n2\n3\n4\n5\n", "1\nTWO\n3\n4\nFIVE\n");
    let h = file_hunks(&store, "a.txt").unwrap();
    assert_eq!(h.hunks.len(), 2);
    let after = keep_hunk(&store, "a.txt", &h.hunks[0].id).unwrap();
    assert_eq!(after.hunks.len(), 1);
    assert_eq!(after.hunks[0].id, h.hunks[1].id);
    assert_eq!(read(&root), "1\nTWO\n3\n4\nFIVE\n", "Keep does not write the file");
    assert_eq!(original(&store, "a.txt").unwrap(), "1\nTWO\n3\n4\n5\n", "the diff's left side has the kept change");
    let v = view(&store, String::new(), false).unwrap();
    assert_eq!((v.files[0].added, v.files[0].removed), (Some(1), Some(1)));
    // File Undo now goes back to the base: the kept change stays.
    undo(&store, Some(&["a.txt".into()])).unwrap();
    assert_eq!(read(&root), "1\nTWO\n3\n4\n5\n");
    assert!(view(&store, String::new(), false).unwrap().files.is_empty());
  }

  #[test]
  fn undo_one_hunk_rewrites_only_that_change() {
    let (_t, root, store) = setup("1\n2\n3\n4\n5\n", "1\nTWO\n3\n4\n5\nsix\n");
    let h = file_hunks(&store, "a.txt").unwrap();
    let after = undo_hunk(&store, "a.txt", &h.hunks[1].id).unwrap();
    assert_eq!(read(&root), "1\nTWO\n3\n4\n5\n");
    assert_eq!(after.hunks.len(), 1);
    // The last one: the file is back to its snapshot and leaves the working set as undone.
    undo_hunk(&store, "a.txt", &after.hunks[0].id).unwrap();
    assert_eq!(read(&root), "1\n2\n3\n4\n5\n");
    let f = store.load().unwrap();
    assert_eq!(f.entries[0].state, State::Undone);
    assert!(undo_hunk(&store, "a.txt", &h.hunks[0].id).unwrap_err().contains("no longer"));
  }

  #[test]
  fn keeping_the_last_hunk_keeps_the_file_and_checkpoints_still_restore_the_snapshot() {
    let (_t, root, store) = setup("a\nb\n", "a\nB\nc\n");
    let h = file_hunks(&store, "a.txt").unwrap();
    assert_eq!(h.hunks.len(), 1);
    assert!(keep_hunk(&store, "a.txt", &h.hunks[0].id).unwrap().hunks.is_empty());
    let f = store.load().unwrap();
    assert_eq!((f.entries[0].state, f.entries[0].base.clone()), (State::Kept, None));
    super::super::restore_checkpoint(&store, 0).unwrap();
    assert_eq!(read(&root), "a\nb\n");
  }

  #[test]
  fn mixed_keep_then_undo_settles_as_kept() {
    let (_t, root, store) = setup("1\n2\n3\n", "X\n2\nY\n");
    let h = file_hunks(&store, "a.txt").unwrap();
    keep_hunk(&store, "a.txt", &h.hunks[0].id).unwrap();
    undo_hunk(&store, "a.txt", &h.hunks[1].id).unwrap();
    assert_eq!(read(&root), "X\n2\n3\n");
    assert_eq!(store.load().unwrap().entries[0].state, State::Kept);
  }

  #[test]
  fn created_files_are_one_whole_file_hunk() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().canonicalize().unwrap();
    let store = Store::open(&root, "c", &root).unwrap();
    let r = begin_request(&store, 1).unwrap();
    record_snapshot(&store, r, root.join("n.txt").to_str().unwrap(), false, None, None).unwrap();
    std::fs::write(root.join("n.txt"), "x\ny\n").unwrap();
    let h = file_hunks(&store, "n.txt").unwrap();
    assert!(h.whole_file);
    assert_eq!((h.hunks[0].new_start, h.hunks[0].new_lines, h.hunks[0].old_lines), (1, 2, 0));
    undo_hunk(&store, "n.txt", &h.hunks[0].id).unwrap();
    assert!(!root.join("n.txt").exists(), "undo of the whole-file hunk deletes the new file");
    assert!(file_hunks(&store, "other.txt").unwrap().hunks.is_empty());
  }

  #[test]
  fn binary_files_have_no_hunks() {
    let (_t, _root, store) = setup("a\0b", "a\0c");
    let h = file_hunks(&store, "a.txt").unwrap();
    assert!(h.binary && h.hunks.is_empty());
  }
}
