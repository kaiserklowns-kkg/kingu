//! Chat memories (Cursor's Memories, Claude Code's `#` memory): "Remember this" on a chat message
//! adds one bullet to the open folder's `CLAUDE.local.md` (Claude Code reads it; personal, not
//! committed) or `AGENTS.md` (shared; Kingu's chat rules read it), under a `## Memories` heading
//! of its own. Settings › Memories lists the bullets of that section in both files and edits or
//! deletes one. Only the two files at the folder's root, never through a symlink; an edit or a
//! delete names the bullet's text as it was read, so a file changed meanwhile is not clobbered.

use std::path::{Path, PathBuf};

use crate::i18n::msg::ChatExtrasMsg;
use crate::tr;

/// The files a memory may go to.
pub const FILES: &[&str] = &["CLAUDE.local.md", "AGENTS.md"];
/// The section Kingu keeps its memories in.
pub const HEADING: &str = "## Memories";
/// One memory, in characters.
pub const MAX_MEMORY: usize = 1000;
/// A file Kingu rewrites (`write_atomic`'s cap too).
const MAX_FILE: u64 = 1024 * 1024;

/// One memory: its file, its position among that file's memories, and its text.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Memory {
  pub file: String,
  pub index: usize,
  pub text: String,
}

fn check_file(file: &str) -> Result<(), String> {
  if FILES.contains(&file) { Ok(()) } else { Err(tr!(ChatExtrasMsg::MemoryFile)) }
}

/// One line, trimmed, a leading bullet marker dropped, at most `MAX_MEMORY` characters.
pub fn clean(text: &str) -> Result<String, String> {
  let one = text.split_whitespace().collect::<Vec<_>>().join(" ");
  let one = one.strip_prefix("- ").or_else(|| one.strip_prefix("* ")).unwrap_or(&one).trim().to_owned();
  if one.is_empty() {
    return Err(tr!(ChatExtrasMsg::MemoryEmpty));
  }
  if one.chars().count() > MAX_MEMORY {
    return Err(tr!(ChatExtrasMsg::MemoryTooLong, max = MAX_MEMORY));
  }
  Ok(one)
}

/// The `## Memories` section's line range (after the heading, up to the next `#`/`##` heading).
fn section(lines: &[&str]) -> Option<(usize, usize)> {
  let start = lines.iter().position(|l| l.trim_end() == HEADING)?;
  let end = lines[start + 1..].iter().position(|l| l.starts_with("# ") || l.starts_with("## ")).map_or(lines.len(), |i| start + 1 + i);
  Some((start, end))
}

/// The memory bullets of `text`: (line index, text), in order.
pub fn bullets(text: &str) -> Vec<(usize, String)> {
  let lines: Vec<&str> = text.lines().collect();
  let Some((start, end)) = section(&lines) else { return Vec::new() };
  (start + 1..end)
    .filter_map(|i| {
      let l = lines[i];
      l.strip_prefix("- ").or_else(|| l.strip_prefix("* ")).map(|b| (i, b.trim().to_owned()))
    })
    .filter(|(_, b)| !b.is_empty())
    .collect()
}

/// `text` with `memory` added as the section's last bullet (the section is made at the end when missing).
pub fn with_added(text: &str, memory: &str) -> String {
  let lines: Vec<&str> = text.lines().collect();
  let bullet = format!("- {memory}");
  let Some((start, end)) = section(&lines) else {
    let mut out = text.trim_end().to_owned();
    if !out.is_empty() {
      out.push_str("\n\n");
    }
    return format!("{out}{HEADING}\n\n{bullet}\n");
  };
  // After the last non-blank line of the section (its last bullet, or the heading).
  let at = (start + 1..end).rev().find(|&i| !lines[i].trim().is_empty()).map_or(start + 1, |i| i + 1);
  let mut out: Vec<String> = lines.iter().map(|l| (*l).to_owned()).collect();
  if at == start + 1 {
    out.splice(at..at, [String::new(), bullet]);
  } else {
    out.insert(at, bullet);
  }
  out.join("\n") + "\n"
}

/// `text` with memory `index` replaced by `memory` (or removed when `None`); `expected` is its
/// text as it was read. `None` when it is not there any more.
pub fn with_changed(text: &str, index: usize, expected: &str, memory: Option<&str>) -> Option<String> {
  let (line, current) = bullets(text).into_iter().nth(index)?;
  if current != expected.trim() {
    return None;
  }
  let mut out: Vec<String> = text.lines().map(str::to_owned).collect();
  match memory {
    Some(m) => out[line] = format!("- {m}"),
    None => {
      out.remove(line);
    }
  }
  Some(out.join("\n") + "\n")
}

fn file_path(root: &Path, file: &str) -> Result<PathBuf, String> {
  check_file(file)?;
  Ok(root.join(file))
}

/// The file's text ("" when it does not exist); a symlink, a folder or a huge file is refused.
fn read(path: &Path, file: &str) -> Result<String, String> {
  match std::fs::symlink_metadata(path) {
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
    Err(e) => Err(format!("{file}: {e}")),
    Ok(m) if !m.is_file() => Err(tr!(ChatExtrasMsg::MemoryNotFile, file)),
    Ok(m) if m.len() > MAX_FILE => Err(tr!(ChatExtrasMsg::MemoryFileTooLarge, file)),
    Ok(_) => std::fs::read_to_string(path).map_err(|e| format!("{file}: {e}")),
  }
}

/// Every memory of the folder: `CLAUDE.local.md`'s, then `AGENTS.md`'s. A file Kingu cannot read is skipped.
pub fn list(root: &Path) -> Vec<Memory> {
  FILES
    .iter()
    .flat_map(|file| {
      let text = read(&root.join(file), file).unwrap_or_default();
      bullets(&text).into_iter().enumerate().map(|(index, (_, text))| Memory { file: (*file).to_owned(), index, text }).collect::<Vec<_>>()
    })
    .collect()
}

pub fn add(root: &Path, file: &str, text: &str) -> Result<Memory, String> {
  let path = file_path(root, file)?;
  let memory = clean(text)?;
  let current = read(&path, file)?;
  let next = with_added(&current, &memory);
  if next.len() as u64 > MAX_FILE {
    return Err(tr!(ChatExtrasMsg::MemoryFileTooLarge, file));
  }
  crate::settings::write_atomic(&path, &next)?;
  Ok(Memory { file: file.to_owned(), index: bullets(&next).len() - 1, text: memory })
}

/// Edits memory `index` of `file` (whose text was `expected`) to `text`, or deletes it (`None`).
pub fn change(root: &Path, file: &str, index: usize, expected: &str, text: Option<&str>) -> Result<(), String> {
  let path = file_path(root, file)?;
  let memory = text.map(clean).transpose()?;
  let current = read(&path, file)?;
  let next = with_changed(&current, index, expected, memory.as_deref()).ok_or_else(|| tr!(ChatExtrasMsg::MemoryStale, file))?;
  crate::settings::write_atomic(&path, &next)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn adds_under_its_own_heading() {
    assert_eq!(with_added("", "ใช้ tab"), "## Memories\n\n- ใช้ tab\n");
    let doc = "# Project\n\nRules.\n";
    let one = with_added(doc, "use tabs");
    assert_eq!(one, "# Project\n\nRules.\n\n## Memories\n\n- use tabs\n");
    let two = with_added(&one, "run bun test");
    assert_eq!(two, "# Project\n\nRules.\n\n## Memories\n\n- use tabs\n- run bun test\n");
    // A section followed by another one: the bullet goes at the end of the section.
    let mid = with_added("## Memories\n- a\n\n## Other\n- not a memory\n", "b");
    assert_eq!(mid, "## Memories\n- a\n- b\n\n## Other\n- not a memory\n");
    assert_eq!(bullets(&mid).into_iter().map(|(_, t)| t).collect::<Vec<_>>(), ["a", "b"]);
    assert_eq!(with_added("## Memories\n", "x"), "## Memories\n\n- x\n");
  }

  #[test]
  fn edits_and_deletes_only_what_was_read() {
    let doc = "intro\n\n## Memories\n\n- a\n- b\n";
    assert_eq!(with_changed(doc, 1, "b", Some("B")).unwrap(), "intro\n\n## Memories\n\n- a\n- B\n");
    assert_eq!(with_changed(doc, 0, "a", None).unwrap(), "intro\n\n## Memories\n\n- b\n");
    assert_eq!(with_changed(doc, 0, "changed", None), None);
    assert_eq!(with_changed(doc, 5, "a", None), None);
  }

  #[test]
  fn memories_are_one_clean_line() {
    assert_eq!(clean("  - run\n bun   test ").unwrap(), "run bun test");
    assert!(clean(" \n ").is_err());
    assert!(clean(&"x".repeat(MAX_MEMORY + 1)).is_err());
  }

  #[test]
  fn files_in_the_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    assert!(add(root, "../x.md", "a").is_err());
    add(root, "CLAUDE.local.md", "a").unwrap();
    let m = add(root, "AGENTS.md", "b").unwrap();
    assert_eq!(m, Memory { file: "AGENTS.md".into(), index: 0, text: "b".into() });
    assert_eq!(list(root).iter().map(|m| (m.file.as_str(), m.text.as_str())).collect::<Vec<_>>(), [("CLAUDE.local.md", "a"), ("AGENTS.md", "b")]);
    change(root, "AGENTS.md", 0, "b", Some("c")).unwrap();
    assert!(change(root, "AGENTS.md", 0, "b", None).is_err(), "stale");
    change(root, "AGENTS.md", 0, "c", None).unwrap();
    assert_eq!(std::fs::read_to_string(root.join("AGENTS.md")).unwrap(), "## Memories\n\n");
  }

  #[cfg(unix)]
  #[test]
  fn never_through_a_symlink() {
    let tmp = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    std::fs::write(other.path().join("t.md"), "x").unwrap();
    std::os::unix::fs::symlink(other.path().join("t.md"), tmp.path().join("AGENTS.md")).unwrap();
    assert!(add(tmp.path(), "AGENTS.md", "a").is_err());
    assert_eq!(std::fs::read_to_string(other.path().join("t.md")).unwrap(), "x");
  }
}
