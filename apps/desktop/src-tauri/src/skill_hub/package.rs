//! What a skill is, wherever it comes from: a folder holding `SKILL.md` (Claude Code's skill
//! format) whose YAML front matter names it and says when to use it. Reading a skill folder
//! checks it the same way for every source (a clone, an extracted archive, an installed skill):
//! no symlinks or special files, a size, file-count and depth budget, and a `SKILL.md` with a
//! valid `name` and a `description`. What is allowed but worth a look before installing (scripts,
//! executables, binaries, pre-approved tools) is reported as flags for the review.
//!
//! Archives (`.skill` / `.zip`) are extracted entry by entry with every path checked as plain
//! names (no absolute paths, `..`, backslashes or drive letters: no zip slip), symlink entries
//! refused and the uncompressed size counted as it is written, not as the archive claims.

use std::io::{Read, Write};
use std::path::Path;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::i18n::msg::SkillMsg;
use crate::tr;

pub const SKILL_FILE: &str = "SKILL.md";
/// Per skill: skills are prompts, references and small helper scripts, not payloads.
pub const MAX_FILES: usize = 256;
pub const MAX_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_DEPTH: usize = 8;
const MAX_SKILL_MD: u64 = 256 * 1024;
/// Claude Code's limits for the front matter.
const MAX_NAME_CHARS: usize = 64;
const MAX_DESCRIPTION_CHARS: usize = 1024;
/// A whole archive (several skills, a repo snapshot): entries and uncompressed bytes.
pub const MAX_ARCHIVE_ENTRIES: usize = 4000;
pub const MAX_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;

/// A skill name as Claude Code accepts it: `a-z`, `0-9` and `-`, starting with a letter or digit.
pub fn is_skill_name(s: &str) -> bool {
  !s.is_empty()
    && s.len() <= MAX_NAME_CHARS
    && !s.starts_with('-')
    && !s.ends_with('-')
    && !s.contains("--")
    && s.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

// ---------------------------------------------------------------------------------------------
// Front matter

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct FrontMatter {
  pub name: String,
  pub description: String,
  /// `allowed-tools`: tools the skill may use without asking while it is active.
  pub allowed_tools: Option<String>,
}

/// The `---` block at the top of `text` (a BOM and `\r\n` allowed), without the fences.
fn front_matter_block(text: &str) -> Option<&str> {
  let text = text.strip_prefix('\u{feff}').unwrap_or(text);
  let rest = text.strip_prefix("---\n").or_else(|| text.strip_prefix("---\r\n"))?;
  let mut offset = 0;
  for line in rest.split_inclusive('\n') {
    if line.trim_end() == "---" {
      return Some(&rest[..offset]);
    }
    offset += line.len();
  }
  None
}

fn scalar(v: &yaml_rust2::Yaml) -> Option<String> {
  use yaml_rust2::Yaml;
  match v {
    Yaml::String(s) | Yaml::Real(s) => Some(s.clone()),
    Yaml::Integer(i) => Some(i.to_string()),
    Yaml::Boolean(b) => Some(b.to_string()),
    Yaml::Array(items) => Some(items.iter().filter_map(scalar).collect::<Vec<_>>().join(", ")),
    _ => None,
  }
}

/// Parses SKILL.md's front matter: `name` (a valid skill name) and `description` are required.
pub fn parse_front_matter(text: &str) -> Result<FrontMatter, String> {
  let block = front_matter_block(text).ok_or_else(|| tr!(SkillMsg::NoFrontMatter))?;
  let docs = yaml_rust2::YamlLoader::load_from_str(block).map_err(|e| tr!(SkillMsg::FrontMatterInvalid, detail = e))?;
  let doc = docs.into_iter().next().unwrap_or(yaml_rust2::Yaml::Null);
  if doc.as_hash().is_none() {
    return Err(tr!(SkillMsg::FrontMatterInvalid, detail = "not a mapping"));
  }
  let get = |key: &str| scalar(&doc[key]).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
  let name = get("name").ok_or_else(|| tr!(SkillMsg::NameMissing))?;
  if !is_skill_name(&name) {
    return Err(tr!(SkillMsg::NameInvalid, name));
  }
  let description = get("description").ok_or_else(|| tr!(SkillMsg::DescriptionMissing))?;
  if description.chars().count() > MAX_DESCRIPTION_CHARS {
    return Err(tr!(SkillMsg::DescriptionTooLong, max = MAX_DESCRIPTION_CHARS));
  }
  Ok(FrontMatter { name, description, allowed_tools: get("allowed-tools") })
}

/// `name` and `description` for listing a skill that may not be valid (another tool's folder):
/// whatever the front matter has, falling back to the folder name.
pub fn summary(text: &str, folder: &str) -> (String, String) {
  if let Ok(f) = parse_front_matter(text) {
    return (f.name, f.description);
  }
  let doc = front_matter_block(text).and_then(|b| yaml_rust2::YamlLoader::load_from_str(b).ok()).and_then(|d| d.into_iter().next());
  let get = |key: &str| doc.as_ref().and_then(|d| scalar(&d[key])).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
  (get("name").unwrap_or_else(|| folder.to_string()), get("description").unwrap_or_default())
}

// ---------------------------------------------------------------------------------------------
// Reading a skill folder

/// Something in a skill worth a look before installing it; never a reason to refuse.
#[derive(Serialize, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Flag {
  /// The file has an executable bit.
  Executable { path: String },
  /// A script by its extension or `#!` line (`.sh`, `.py`, `.js`, …).
  Script { path: String },
  /// A compiled program or library (ELF, Mach-O, PE).
  Binary { path: String },
  /// `allowed-tools` in the front matter: these run without asking while the skill is active.
  AllowedTools { tools: String },
  /// The folder's name is not the skill's name (it installs under the skill's name).
  Renamed { folder: String },
  /// Hidden files and folders are left out (`.git`, `.DS_Store`, …).
  HiddenSkipped { count: usize },
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
  pub path: String,
  pub size: u64,
  pub executable: bool,
}

/// A checked skill folder.
#[derive(Clone, Debug, PartialEq)]
pub struct SkillDir {
  pub front: FrontMatter,
  pub files: Vec<FileEntry>,
  pub flags: Vec<Flag>,
  /// SHA-256 over every file's path, size and bytes (see `content_hash`).
  pub hash: String,
  pub skill_md: String,
}

struct Budget {
  files: usize,
  bytes: u64,
  hidden: usize,
}

const SCRIPT_EXTENSIONS: [&str; 16] = ["sh", "bash", "zsh", "fish", "py", "js", "mjs", "cjs", "ts", "rb", "pl", "php", "ps1", "bat", "cmd", "lua"];
const BINARY_EXTENSIONS: [&str; 7] = ["exe", "dll", "so", "dylib", "bin", "jar", "wasm"];

#[cfg(unix)]
fn is_executable(meta: &std::fs::Metadata) -> bool {
  use std::os::unix::fs::PermissionsExt;
  meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_meta: &std::fs::Metadata) -> bool {
  false
}

/// What the start of a file and its name say about it.
fn classify(rel: &str, head: &[u8], executable: bool, flags: &mut Vec<Flag>) {
  let ext = rel.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
  let magic = head.starts_with(b"\x7fELF")
    || head.starts_with(b"MZ")
    || [[0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe]].iter().any(|m| head.starts_with(m));
  if magic || BINARY_EXTENSIONS.contains(&ext.as_str()) {
    flags.push(Flag::Binary { path: rel.to_string() });
  } else if head.starts_with(b"#!") || SCRIPT_EXTENSIONS.contains(&ext.as_str()) {
    flags.push(Flag::Script { path: rel.to_string() });
  }
  if executable {
    flags.push(Flag::Executable { path: rel.to_string() });
  }
}

/// Every regular file under `dir` in name order. Hidden entries are skipped (and counted); a
/// symlink, a special file or going over the budget is an error.
fn walk(dir: &Path, prefix: &str, depth: usize, budget: &mut Budget, out: &mut Vec<FileEntry>) -> Result<(), String> {
  if depth > MAX_DEPTH {
    return Err(tr!(SkillMsg::TooDeep, max = MAX_DEPTH));
  }
  let mut entries: Vec<_> = std::fs::read_dir(dir).map_err(|e| tr!(SkillMsg::ReadFailed, path = dir.display(), detail = e))?.flatten().collect();
  entries.sort_by_key(|e| e.file_name());
  for entry in entries {
    let name = entry.file_name().to_string_lossy().into_owned();
    if name.starts_with('.') {
      budget.hidden += 1;
      continue;
    }
    let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
    let meta = std::fs::symlink_metadata(entry.path()).map_err(|e| tr!(SkillMsg::ReadFailed, path = rel, detail = e))?;
    if meta.file_type().is_symlink() {
      return Err(tr!(SkillMsg::Symlink, path = rel));
    }
    if meta.is_dir() {
      walk(&entry.path(), &rel, depth + 1, budget, out)?;
    } else if meta.is_file() {
      budget.files += 1;
      budget.bytes += meta.len();
      if budget.files > MAX_FILES || budget.bytes > MAX_BYTES {
        return Err(tr!(SkillMsg::TooBig, files = MAX_FILES, mb = MAX_BYTES / 1024 / 1024));
      }
      out.push(FileEntry { path: rel, size: meta.len(), executable: is_executable(&meta) });
    } else {
      return Err(tr!(SkillMsg::NotPlain, path = rel));
    }
  }
  Ok(())
}

/// The files of `dir` without checking SKILL.md (copying an installed skill).
pub fn files_of(dir: &Path) -> Result<Vec<FileEntry>, String> {
  let mut out = Vec::new();
  walk(dir, "", 0, &mut Budget { files: 0, bytes: 0, hidden: 0 }, &mut out)?;
  Ok(out)
}

/// SHA-256 over each file's path, size and bytes, in `files` order (name order from `walk`).
pub fn content_hash(dir: &Path, files: &[FileEntry]) -> Result<String, String> {
  let mut h = Sha256::new();
  for f in files {
    let bytes = std::fs::read(dir.join(&f.path)).map_err(|e| tr!(SkillMsg::ReadFailed, path = f.path, detail = e))?;
    h.update(b"\0kingu-skill\0");
    h.update(f.path.as_bytes());
    h.update(b"\0");
    h.update((bytes.len() as u64).to_le_bytes());
    h.update(&bytes);
  }
  Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Reads and checks the skill folder `dir` (a real folder, not a symlink).
pub fn read_skill_dir(dir: &Path) -> Result<SkillDir, String> {
  match std::fs::symlink_metadata(dir) {
    Ok(m) if m.file_type().is_symlink() => return Err(tr!(SkillMsg::Symlink, path = dir.display())),
    Ok(m) if m.is_dir() => {}
    _ => return Err(tr!(SkillMsg::FolderMissing, path = dir.display())),
  }
  let md = dir.join(SKILL_FILE);
  match std::fs::symlink_metadata(&md) {
    Ok(m) if m.is_file() && m.len() <= MAX_SKILL_MD => {}
    Ok(m) if m.is_file() => return Err(tr!(SkillMsg::SkillMdTooBig, kb = MAX_SKILL_MD / 1024)),
    Ok(_) => return Err(tr!(SkillMsg::SkillMdNotPlain)),
    Err(_) => return Err(tr!(SkillMsg::SkillMdMissing)),
  }
  let bytes = std::fs::read(&md).map_err(|e| tr!(SkillMsg::ReadFailed, path = SKILL_FILE, detail = e))?;
  let skill_md = String::from_utf8(bytes).map_err(|_| tr!(SkillMsg::SkillMdNotUtf8))?;
  let front = parse_front_matter(&skill_md)?;
  let mut budget = Budget { files: 0, bytes: 0, hidden: 0 };
  let mut files = Vec::new();
  walk(dir, "", 0, &mut budget, &mut files)?;
  let mut flags = Vec::new();
  for f in &files {
    let mut head = [0u8; 4];
    let n = std::fs::File::open(dir.join(&f.path)).and_then(|mut file| file.read(&mut head)).unwrap_or(0);
    classify(&f.path, &head[..n], f.executable, &mut flags);
  }
  if let Some(tools) = &front.allowed_tools {
    flags.push(Flag::AllowedTools { tools: tools.clone() });
  }
  let folder = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
  if folder != front.name {
    flags.push(Flag::Renamed { folder });
  }
  if budget.hidden > 0 {
    flags.push(Flag::HiddenSkipped { count: budget.hidden });
  }
  let hash = content_hash(dir, &files)?;
  Ok(SkillDir { front, files, flags, hash, skill_md })
}

/// Copies `files` of `from` into `to`, keeping the executable bit (a skill may ship a script).
pub fn copy_files(from: &Path, to: &Path, files: &[FileEntry]) -> Result<(), String> {
  std::fs::create_dir_all(to).map_err(|e| tr!(SkillMsg::CreateFailed, path = to.display(), detail = e))?;
  for f in files {
    let dst = to.join(&f.path);
    if let Some(parent) = dst.parent() {
      std::fs::create_dir_all(parent).map_err(|e| tr!(SkillMsg::CreateFailed, path = parent.display(), detail = e))?;
    }
    std::fs::copy(from.join(&f.path), &dst).map_err(|e| tr!(SkillMsg::CopyFailed, path = f.path, detail = e))?;
  }
  Ok(())
}

// ---------------------------------------------------------------------------------------------
// Archives

/// An archive entry's path as plain `/`-separated names: no absolute path, drive letter,
/// backslash, NUL, control character, `.` or `..` part. Directories may end in `/`.
pub fn entry_path(name: &str) -> Option<String> {
  let trimmed = name.strip_suffix('/').unwrap_or(name);
  if trimmed.is_empty() || trimmed.len() > 1024 || trimmed.starts_with('/') || trimmed.contains('\\') || trimmed.chars().any(char::is_control) {
    return None;
  }
  let parts: Vec<&str> = trimmed.split('/').collect();
  if parts.len() > MAX_DEPTH + 4 || parts.iter().any(|p| p.is_empty() || *p == "." || *p == ".." || p.len() > 255) {
    return None;
  }
  // `C:` (a drive) or `name:stream` (an NTFS alternate data stream).
  if parts.iter().any(|p| p.contains(':')) {
    return None;
  }
  Some(trimmed.to_string())
}

/// Extracts the zip archive `bytes` into `to` (which must not exist yet). macOS metadata
/// (`__MACOSX/`, `.DS_Store`) is dropped; anything unsafe fails the whole extraction.
pub fn extract_zip(bytes: &[u8], to: &Path) -> Result<(), String> {
  let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| tr!(SkillMsg::ArchiveInvalid, detail = e))?;
  if archive.len() > MAX_ARCHIVE_ENTRIES {
    return Err(tr!(SkillMsg::ArchiveTooBig, files = MAX_ARCHIVE_ENTRIES, mb = MAX_ARCHIVE_BYTES / 1024 / 1024));
  }
  std::fs::create_dir(to).map_err(|e| tr!(SkillMsg::CreateFailed, path = to.display(), detail = e))?;
  let mut total: u64 = 0;
  for i in 0..archive.len() {
    let mut entry = archive.by_index(i).map_err(|e| tr!(SkillMsg::ArchiveInvalid, detail = e))?;
    let raw = entry.name().to_string();
    let rel = entry_path(&raw).ok_or_else(|| tr!(SkillMsg::ArchiveUnsafePath, path = format!("{raw:?}")))?;
    if rel == "__MACOSX" || rel.starts_with("__MACOSX/") || rel.rsplit('/').next() == Some(".DS_Store") {
      continue;
    }
    if entry.is_symlink() {
      return Err(tr!(SkillMsg::ArchiveSymlink, path = rel));
    }
    if entry.encrypted() {
      return Err(tr!(SkillMsg::ArchiveEncrypted));
    }
    let dst = to.join(&rel);
    if entry.is_dir() {
      std::fs::create_dir_all(&dst).map_err(|e| tr!(SkillMsg::CreateFailed, path = rel, detail = e))?;
      continue;
    }
    if let Some(parent) = dst.parent() {
      std::fs::create_dir_all(parent).map_err(|e| tr!(SkillMsg::CreateFailed, path = rel, detail = e))?;
    }
    // A name twice (or a file where a folder was) is refused rather than overwritten.
    let mut out = std::fs::OpenOptions::new().write(true).create_new(true).open(&dst).map_err(|e| tr!(SkillMsg::WriteFailed, path = rel, detail = e))?;
    let left = MAX_ARCHIVE_BYTES - total;
    let written = std::io::copy(&mut (&mut entry).take(left + 1), &mut out).map_err(|e| tr!(SkillMsg::ArchiveInvalid, detail = e))?;
    total += written;
    if written > left {
      return Err(tr!(SkillMsg::ArchiveTooBig, files = MAX_ARCHIVE_ENTRIES, mb = MAX_ARCHIVE_BYTES / 1024 / 1024));
    }
    #[cfg(unix)]
    if entry.unix_mode().is_some_and(|m| m & 0o111 != 0) {
      use std::os::unix::fs::PermissionsExt;
      let _ = std::fs::set_permissions(&dst, std::fs::Permissions::from_mode(0o755));
    }
  }
  Ok(())
}

/// Writes the skill folder `dir` as a `.skill` archive (a zip holding `<name>/…`, as Claude's
/// apps export skills) to `dest`.
pub fn write_archive(dir: &Path, name: &str, dest: &Path) -> Result<(), String> {
  let files = files_of(dir)?;
  let tmp = dest.with_extension("kingu-tmp");
  let write = || -> Result<(), String> {
    let file = std::fs::File::create(&tmp).map_err(|e| tr!(SkillMsg::WriteFailed, path = tmp.display(), detail = e))?;
    let mut zip = zip::ZipWriter::new(file);
    let fail = |e: zip::result::ZipError| tr!(SkillMsg::WriteFailed, path = dest.display(), detail = e);
    for f in &files {
      let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(if f.executable { 0o755 } else { 0o644 });
      zip.start_file(format!("{name}/{}", f.path), options).map_err(fail)?;
      let bytes = std::fs::read(dir.join(&f.path)).map_err(|e| tr!(SkillMsg::ReadFailed, path = f.path, detail = e))?;
      zip.write_all(&bytes).map_err(|e| tr!(SkillMsg::WriteFailed, path = dest.display(), detail = e))?;
    }
    zip.finish().map_err(fail)?;
    std::fs::rename(&tmp, dest).map_err(|e| tr!(SkillMsg::WriteFailed, path = dest.display(), detail = e))
  };
  let result = write();
  if result.is_err() {
    let _ = std::fs::remove_file(&tmp);
  }
  result
}

#[cfg(test)]
pub(crate) mod tests {
  use super::*;

  pub(crate) fn skill(dir: &Path, name: &str, description: &str) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join(SKILL_FILE), format!("---\nname: {name}\ndescription: {description}\n---\n\n# {name}\n")).unwrap();
  }

  fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, bytes) in entries {
      zip.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
      zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
  }

  #[test]
  fn skill_names() {
    for ok in ["pdf", "go-style", "a1", "x".repeat(64).as_str()] {
      assert!(is_skill_name(ok), "{ok}");
    }
    for bad in ["", "-a", "a-", "a--b", "Go", "a_b", "a.b", "a/b", "x".repeat(65).as_str()] {
      assert!(!is_skill_name(bad), "{bad}");
    }
  }

  #[test]
  fn front_matter_fields() {
    let f = parse_front_matter("---\nname: pdf\ndescription: \"Fill PDF forms: when the user asks\"\nallowed-tools: [Read, Bash(python:*)]\n---\nbody").unwrap();
    assert_eq!(f, FrontMatter { name: "pdf".into(), description: "Fill PDF forms: when the user asks".into(), allowed_tools: Some("Read, Bash(python:*)".into()) });
    // A folded block, CRLF line ends and a BOM.
    let f = parse_front_matter("\u{feff}---\r\nname: notes\r\ndescription: >\r\n  Two\r\n  lines\r\n---\r\n").unwrap();
    assert_eq!((f.name.as_str(), f.description.as_str(), f.allowed_tools), ("notes", "Two lines", None));
  }

  #[test]
  fn front_matter_errors() {
    assert_eq!(parse_front_matter("# no front matter"), Err(tr!(SkillMsg::NoFrontMatter)));
    assert_eq!(parse_front_matter("---\nname: a\n"), Err(tr!(SkillMsg::NoFrontMatter)));
    assert_eq!(parse_front_matter("---\ndescription: x\n---\n"), Err(tr!(SkillMsg::NameMissing)));
    assert_eq!(parse_front_matter("---\nname: Bad Name\ndescription: x\n---\n"), Err(tr!(SkillMsg::NameInvalid, name = "Bad Name")));
    assert_eq!(parse_front_matter("---\nname: a\n---\n"), Err(tr!(SkillMsg::DescriptionMissing)));
    let long = format!("---\nname: a\ndescription: {}\n---\n", "x".repeat(1025));
    assert_eq!(parse_front_matter(&long), Err(tr!(SkillMsg::DescriptionTooLong, max = 1024)));
    assert!(parse_front_matter("---\nname: [a\n---\n").is_err());
    assert!(parse_front_matter("---\n- a\n---\n").is_err());
  }

  #[test]
  fn summary_falls_back() {
    assert_eq!(summary("---\nname: x\ndescription: d\n---\n", "f"), ("x".into(), "d".into()));
    assert_eq!(summary("---\nname: Not Valid\n---\n", "f"), ("Not Valid".into(), String::new()));
    assert_eq!(summary("plain", "folder"), ("folder".into(), String::new()));
  }

  #[test]
  fn reads_and_flags_a_skill() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("pdf-tools");
    skill(&dir, "pdf", "PDF help");
    std::fs::create_dir_all(dir.join("scripts")).unwrap();
    std::fs::write(dir.join("scripts/fill.py"), "print(1)").unwrap();
    std::fs::write(dir.join("tool"), b"\x7fELF....").unwrap();
    std::fs::write(dir.join(".DS_Store"), "x").unwrap();
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      std::fs::set_permissions(dir.join("tool"), std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let s = read_skill_dir(&dir).unwrap();
    assert_eq!(s.front.name, "pdf");
    assert_eq!(s.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["SKILL.md", "scripts/fill.py", "tool"]);
    assert!(s.flags.contains(&Flag::Script { path: "scripts/fill.py".into() }));
    assert!(s.flags.contains(&Flag::Binary { path: "tool".into() }));
    #[cfg(unix)]
    assert!(s.flags.contains(&Flag::Executable { path: "tool".into() }));
    assert!(s.flags.contains(&Flag::Renamed { folder: "pdf-tools".into() }));
    assert!(s.flags.contains(&Flag::HiddenSkipped { count: 1 }));
    // The hash follows the content, not the hidden files.
    let before = s.hash.clone();
    std::fs::write(dir.join(".DS_Store"), "changed").unwrap();
    assert_eq!(read_skill_dir(&dir).unwrap().hash, before);
    std::fs::write(dir.join("scripts/fill.py"), "print(2)").unwrap();
    assert_ne!(read_skill_dir(&dir).unwrap().hash, before);
  }

  #[test]
  fn refuses_bad_folders() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("a");
    std::fs::create_dir_all(&dir).unwrap();
    assert_eq!(read_skill_dir(&dir), Err(tr!(SkillMsg::SkillMdMissing)));
    skill(&dir, "a", "x");
    #[cfg(unix)]
    {
      std::os::unix::fs::symlink("/etc/passwd", dir.join("passwd")).unwrap();
      assert_eq!(read_skill_dir(&dir), Err(tr!(SkillMsg::Symlink, path = "passwd")));
      std::fs::remove_file(dir.join("passwd")).unwrap();
      std::os::unix::fs::symlink(&dir, tmp.path().join("link")).unwrap();
      assert!(read_skill_dir(&tmp.path().join("link")).is_err());
    }
    for i in 0..MAX_FILES {
      std::fs::write(dir.join(format!("f{i}")), "x").unwrap();
    }
    assert_eq!(read_skill_dir(&dir), Err(tr!(SkillMsg::TooBig, files = MAX_FILES, mb = MAX_BYTES / 1024 / 1024)));
  }

  #[test]
  fn entry_paths() {
    assert_eq!(entry_path("pdf/SKILL.md").as_deref(), Some("pdf/SKILL.md"));
    assert_eq!(entry_path("pdf/").as_deref(), Some("pdf"));
    for bad in ["", "/etc/passwd", "../x", "a/../../x", "a/./b", "a//b", "a\\..\\b", "C:/x", "C:x", "a/b:stream", "a\0b", "a\nb"] {
      assert_eq!(entry_path(bad), None, "{bad:?}");
    }
  }

  #[test]
  fn extracts_a_zip() {
    let tmp = tempfile::tempdir().unwrap();
    let bytes = zip_of(&[("pdf/SKILL.md", b"---\nname: pdf\ndescription: d\n---\n"), ("pdf/ref/a.md", b"a"), ("__MACOSX/pdf/._SKILL.md", b"x")]);
    let to = tmp.path().join("out");
    extract_zip(&bytes, &to).unwrap();
    assert!(to.join("pdf/ref/a.md").is_file());
    assert!(!to.join("__MACOSX").exists());
    assert_eq!(read_skill_dir(&to.join("pdf")).unwrap().front.name, "pdf");
  }

  #[test]
  fn refuses_zip_slip() {
    let tmp = tempfile::tempdir().unwrap();
    for (i, name) in ["../evil.md", "a/../../evil.md", "/abs/evil.md", "a\\..\\..\\evil.md", "C:/evil.md"].into_iter().enumerate() {
      let to = tmp.path().join(format!("out-{i}"));
      let err = extract_zip(&zip_of(&[("ok.md", b"x"), (name, b"evil")]), &to).unwrap_err();
      assert_eq!(err, tr!(SkillMsg::ArchiveUnsafePath, path = format!("{name:?}")));
      assert!(!tmp.path().join("evil.md").exists());
    }
  }

  #[test]
  fn refuses_zip_symlinks_and_duplicates() {
    let tmp = tempfile::tempdir().unwrap();
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    zip.add_symlink("link", "/etc/passwd", zip::write::SimpleFileOptions::default()).unwrap();
    let bytes = zip.finish().unwrap().into_inner();
    assert_eq!(extract_zip(&bytes, &tmp.path().join("a")), Err(tr!(SkillMsg::ArchiveSymlink, path = "link")));
    // A file where a folder must go (or a name twice) fails instead of overwriting.
    assert!(extract_zip(&zip_of(&[("a/x", b"1"), ("a/x/y", b"2")]), &tmp.path().join("b")).is_err());
  }

  #[test]
  fn refuses_bombs() {
    let tmp = tempfile::tempdir().unwrap();
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("big", options).unwrap();
    let chunk = vec![0u8; 1024 * 1024];
    for _ in 0..=(MAX_ARCHIVE_BYTES / chunk.len() as u64) {
      zip.write_all(&chunk).unwrap();
    }
    let bytes = zip.finish().unwrap().into_inner();
    assert!(bytes.len() < 1024 * 1024);
    assert!(matches!(extract_zip(&bytes, &tmp.path().join("a")), Err(e) if e == tr!(SkillMsg::ArchiveTooBig, files = MAX_ARCHIVE_ENTRIES, mb = MAX_ARCHIVE_BYTES / 1024 / 1024)));
  }

  #[test]
  fn archive_round_trip() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("notes");
    skill(&dir, "notes", "Take notes");
    std::fs::create_dir_all(dir.join("ref")).unwrap();
    std::fs::write(dir.join("ref/style.md"), "be brief").unwrap();
    let dest = tmp.path().join("notes.skill");
    write_archive(&dir, "notes", &dest).unwrap();
    let out = tmp.path().join("out");
    extract_zip(&std::fs::read(&dest).unwrap(), &out).unwrap();
    assert_eq!(read_skill_dir(&out.join("notes")).unwrap().hash, read_skill_dir(&dir).unwrap().hash);
  }
}
