//! Unpacks a downloaded release (`.tar.gz`, `.zip`) into a staging folder. The archive's hash is
//! checked before this runs (fetch.rs), but nothing here trusts its entries: a name may not leave
//! the folder (`..`, absolute), nothing is written through a link, a link may only point inside
//! the folder, and devices, FIFOs and set-id bits are refused or dropped. Orca hands the archive
//! to the system `tar` / `unzip` (`main/node-runtime/runtime-archive-download.ts`
//! `extractRuntimeArchive`); Kingu reads it in-process so these rules hold on every host.

use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

const BLOCK: usize = 512;
const MAX_ENTRIES: usize = 400_000;
const MAX_NAME: usize = 4096;

#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
  /// An entry would be written, or a link would point, outside the folder.
  Escapes(String),
  /// A device, FIFO or other entry kind a release has no use for.
  Kind(String),
  TooLarge,
  Corrupt(String),
  Io(String),
}

impl std::fmt::Display for Refusal {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Refusal::Escapes(n) => write!(f, "entry {n:?} leaves the install folder"),
      Refusal::Kind(n) => write!(f, "entry {n:?} is not a file, folder or link"),
      Refusal::TooLarge => write!(f, "it unpacks to more than expected"),
      Refusal::Corrupt(d) => write!(f, "it is damaged ({d})"),
      Refusal::Io(d) => write!(f, "{d}"),
    }
  }
}

fn io_err(e: io::Error) -> Refusal {
  Refusal::Io(e.to_string())
}

/// An archive entry's name as a path under the folder: `./` and empty parts dropped; `..`, an
/// absolute path, a drive or a NUL refused. `Ok(None)` names the folder itself.
pub fn safe_rel(name: &str) -> Result<Option<PathBuf>, Refusal> {
  let escapes = || Refusal::Escapes(name.chars().take(200).collect());
  if name.len() > MAX_NAME || name.contains('\0') || name.starts_with('/') || name.starts_with('\\') {
    return Err(escapes());
  }
  let mut out = PathBuf::new();
  for part in name.split('/') {
    match part {
      "" | "." => {}
      ".." => return Err(escapes()),
      p if p.contains('\\') || p.contains(':') && cfg!(windows) => return Err(escapes()),
      p => out.push(p),
    }
  }
  // What the platform makes of it must still be plain names (a Windows drive or UNC prefix is not).
  if out.components().any(|c| !matches!(c, Component::Normal(_))) {
    return Err(escapes());
  }
  Ok((!out.as_os_str().is_empty()).then_some(out))
}

/// A link at `rel` pointing at `target` stays inside the folder: relative, any `..` only at its
/// start, and not climbing above the folder. With no entry ever written through a link, following
/// such links can only land inside.
fn link_stays_inside(rel: &Path, target: &str) -> bool {
  if target.is_empty() || target.contains('\0') || target.starts_with('/') || target.contains('\\') || target.len() > MAX_NAME {
    return false;
  }
  let mut depth = rel.components().count() as isize - 1;
  let mut descended = false;
  for part in target.split('/') {
    match part {
      "" | "." => {}
      ".." if descended => return false,
      ".." => {
        depth -= 1;
        if depth < 0 {
          return false;
        }
      }
      p if p.contains(':') && cfg!(windows) => return false,
      _ => descended = true,
    }
  }
  true
}

/// Makes `rel`'s parent folders under `root`, refusing when one of them exists as anything but a
/// real folder (so nothing is written through a link an earlier entry made).
fn parent_dirs(root: &Path, rel: &Path, name: &str) -> Result<(), Refusal> {
  let mut at = root.to_path_buf();
  let parts: Vec<_> = rel.components().collect();
  for part in &parts[..parts.len().saturating_sub(1)] {
    at.push(part);
    match fs::symlink_metadata(&at) {
      Ok(m) if m.is_dir() => {}
      Ok(_) => return Err(Refusal::Escapes(name.to_owned())),
      Err(e) if e.kind() == io::ErrorKind::NotFound => fs::create_dir(&at).map_err(io_err)?,
      Err(e) => return Err(io_err(e)),
    }
  }
  Ok(())
}

/// Clears `dest` for a new entry: an earlier regular file or link of the same name goes, a folder refuses.
fn make_way(dest: &Path, name: &str) -> Result<(), Refusal> {
  match fs::symlink_metadata(dest) {
    Ok(m) if m.is_dir() => Err(Refusal::Escapes(name.to_owned())),
    Ok(_) => fs::remove_file(dest).map_err(io_err),
    Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
    Err(e) => Err(io_err(e)),
  }
}

struct Budget {
  left: u64,
  entries: usize,
}

impl Budget {
  fn entry(&mut self) -> Result<(), Refusal> {
    self.entries += 1;
    if self.entries > MAX_ENTRIES { Err(Refusal::TooLarge) } else { Ok(()) }
  }
}

/// Writes one regular file (never through a link: `create_new` after `make_way`), executable when
/// the archive says so; set-id and sticky bits never carry over.
fn write_file(root: &Path, rel: &Path, name: &str, executable: bool, data: &mut dyn Read, size: Option<u64>, budget: &mut Budget) -> Result<(), Refusal> {
  parent_dirs(root, rel, name)?;
  let dest = root.join(rel);
  make_way(&dest, name)?;
  let mut options = fs::OpenOptions::new();
  options.write(true).create_new(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(if executable { 0o755 } else { 0o644 });
  }
  let _ = executable;
  let mut file = options.open(&dest).map_err(io_err)?;
  // One byte past the budget tells an oversized entry from one that just fits.
  let cap = size.unwrap_or(u64::MAX).min(budget.left.saturating_add(1));
  let copied = io::copy(&mut data.take(cap), &mut file).map_err(|e| Refusal::Corrupt(e.to_string()))?;
  if copied > budget.left {
    return Err(Refusal::TooLarge);
  }
  if size.is_some_and(|s| copied != s) {
    return Err(Refusal::Corrupt(format!("{name} is cut short")));
  }
  budget.left -= copied;
  Ok(())
}

fn write_dir(root: &Path, rel: &Path, name: &str) -> Result<(), Refusal> {
  parent_dirs(root, rel, name)?;
  let dest = root.join(rel);
  match fs::symlink_metadata(&dest) {
    Ok(m) if m.is_dir() => Ok(()),
    Ok(_) => Err(Refusal::Escapes(name.to_owned())),
    Err(_) => fs::create_dir(&dest).map_err(io_err),
  }
}

fn write_symlink(root: &Path, rel: &Path, name: &str, target: &str) -> Result<(), Refusal> {
  if !link_stays_inside(rel, target) {
    return Err(Refusal::Escapes(format!("{name} -> {}", target.chars().take(200).collect::<String>())));
  }
  parent_dirs(root, rel, name)?;
  let dest = root.join(rel);
  make_way(&dest, name)?;
  #[cfg(unix)]
  return std::os::unix::fs::symlink(target, &dest).map_err(io_err);
  // A Windows release ships no links; one is refused rather than written as something else.
  #[cfg(not(unix))]
  return Err(Refusal::Kind(name.to_owned()));
}

/// A hard link to a file an earlier entry wrote (never through a link, never to a folder).
fn write_hardlink(root: &Path, rel: &Path, name: &str, target: &str) -> Result<(), Refusal> {
  let Some(target_rel) = safe_rel(target)? else { return Err(Refusal::Escapes(name.to_owned())) };
  let mut at = root.to_path_buf();
  for part in target_rel.components() {
    at.push(part);
    let meta = fs::symlink_metadata(&at).map_err(|_| Refusal::Corrupt(format!("{name} links to a missing file")))?;
    if meta.file_type().is_symlink() {
      return Err(Refusal::Escapes(name.to_owned()));
    }
  }
  if !fs::symlink_metadata(&at).is_ok_and(|m| m.is_file()) {
    return Err(Refusal::Escapes(name.to_owned()));
  }
  parent_dirs(root, rel, name)?;
  let dest = root.join(rel);
  make_way(&dest, name)?;
  fs::hard_link(&at, &dest).map_err(io_err)
}

// ---- tar ------------------------------------------------------------------------------------

fn field(block: &[u8], at: usize, len: usize) -> &[u8] {
  let f = &block[at..at + len];
  &f[..f.iter().position(|&b| b == 0).unwrap_or(len)]
}

/// A header number: octal text, or GNU's base-256 when the first byte has its high bit set.
fn number(block: &[u8], at: usize, len: usize) -> Result<u64, Refusal> {
  let f = &block[at..at + len];
  if f[0] & 0x80 != 0 {
    let mut n: u64 = 0;
    for (i, &b) in f.iter().enumerate() {
      let b = if i == 0 { b & 0x7f } else { b };
      n = n.checked_mul(256).and_then(|n| n.checked_add(b as u64)).ok_or_else(|| Refusal::Corrupt("a size is out of range".into()))?;
    }
    return Ok(n);
  }
  let text = std::str::from_utf8(field(block, at, len)).map_err(|_| Refusal::Corrupt("a header number is unreadable".into()))?;
  let text = text.trim_matches(|c: char| c == ' ' || c == '\0');
  if text.is_empty() {
    return Ok(0);
  }
  u64::from_str_radix(text, 8).map_err(|_| Refusal::Corrupt("a header number is unreadable".into()))
}

fn checksum_ok(block: &[u8]) -> bool {
  let Ok(want) = number(block, 148, 8) else { return false };
  let sum: u64 = block.iter().enumerate().map(|(i, &b)| if (148..156).contains(&i) { 32 } else { b as u64 }).sum();
  sum == want
}

fn read_block(r: &mut dyn Read, block: &mut [u8; BLOCK]) -> Result<bool, Refusal> {
  let mut got = 0;
  while got < BLOCK {
    match r.read(&mut block[got..]) {
      Ok(0) if got == 0 => return Ok(false),
      Ok(0) => return Err(Refusal::Corrupt("it ends inside a header".into())),
      Ok(n) => got += n,
      Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
      Err(e) => return Err(Refusal::Corrupt(e.to_string())),
    }
  }
  Ok(true)
}

/// Reads an entry's whole (small) body: a long name or a pax record list.
fn read_small(r: &mut dyn Read, size: u64) -> Result<Vec<u8>, Refusal> {
  if size > 1024 * 1024 {
    return Err(Refusal::Corrupt("a name record is too long".into()));
  }
  let mut buf = vec![0u8; size as usize];
  r.read_exact(&mut buf).map_err(|e| Refusal::Corrupt(e.to_string()))?;
  skip(r, pad(size))?;
  Ok(buf)
}

fn pad(size: u64) -> u64 {
  (BLOCK as u64 - size % BLOCK as u64) % BLOCK as u64
}

fn skip(r: &mut dyn Read, n: u64) -> Result<(), Refusal> {
  let copied = io::copy(&mut r.take(n), &mut io::sink()).map_err(|e| Refusal::Corrupt(e.to_string()))?;
  if copied == n { Ok(()) } else { Err(Refusal::Corrupt("it ends inside a file".into())) }
}

fn text(bytes: &[u8]) -> Result<String, Refusal> {
  let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
  String::from_utf8(bytes[..end].to_vec()).map_err(|_| Refusal::Corrupt("a name is not UTF-8".into()))
}

/// pax records (`<len> key=value\n`): the keys a release needs.
fn pax(records: &[u8]) -> Result<(Option<String>, Option<String>, Option<u64>), Refusal> {
  let bad = || Refusal::Corrupt("a pax record is unreadable".into());
  let (mut path, mut link, mut size) = (None, None, None);
  let mut rest = records;
  while !rest.is_empty() {
    let space = rest.iter().position(|&b| b == b' ').ok_or_else(bad)?;
    let len: usize = std::str::from_utf8(&rest[..space]).ok().and_then(|s| s.parse().ok()).ok_or_else(bad)?;
    if len <= space + 1 || len > rest.len() {
      return Err(bad());
    }
    let record = &rest[space + 1..len];
    let record = record.strip_suffix(b"\n").unwrap_or(record);
    let eq = record.iter().position(|&b| b == b'=').ok_or_else(bad)?;
    // Only the keys used are decoded: others (`SCHILY.xattr.*`, as in Cursor's release) hold binary values.
    let value = || String::from_utf8(record[eq + 1..].to_vec()).map_err(|_| bad());
    match &record[..eq] {
      b"path" => path = Some(value()?),
      b"linkpath" => link = Some(value()?),
      b"size" => size = Some(value()?.parse().map_err(|_| bad())?),
      _ => {}
    }
    rest = &rest[len..];
  }
  Ok((path, link, size))
}

/// Unpacks a tar stream into `root` (an existing, empty folder), writing at most `max_bytes`.
pub fn unpack_tar(reader: &mut dyn Read, root: &Path, max_bytes: u64) -> Result<(), Refusal> {
  let mut budget = Budget { left: max_bytes, entries: 0 };
  let mut block = [0u8; BLOCK];
  let (mut long_name, mut long_link, mut pax_next): (Option<String>, Option<String>, (Option<String>, Option<String>, Option<u64>)) = (None, None, (None, None, None));
  loop {
    if !read_block(reader, &mut block)? {
      return Ok(());
    }
    if block.iter().all(|&b| b == 0) {
      return Ok(());
    }
    if !checksum_ok(&block) {
      return Err(Refusal::Corrupt("a header checksum is wrong".into()));
    }
    budget.entry()?;
    let kind = block[156];
    let header_size = number(&block, 124, 12)?;
    match kind {
      b'L' | b'K' => {
        let value = text(&read_small(reader, header_size)?)?;
        if kind == b'L' { long_name = Some(value) } else { long_link = Some(value) }
        continue;
      }
      b'x' => {
        pax_next = pax(&read_small(reader, header_size)?)?;
        continue;
      }
      // Global pax records carry nothing a release needs.
      b'g' => {
        skip(reader, header_size + pad(header_size))?;
        continue;
      }
      _ => {}
    }
    let (pax_path, pax_link, pax_size) = std::mem::take(&mut pax_next);
    let size = pax_size.unwrap_or(header_size);
    let name = match pax_path.or(long_name.take()) {
      Some(n) => n,
      None => {
        let base = text(field(&block, 0, 100))?;
        let prefix = if &block[257..262] == b"ustar" && block[262] == 0 { text(field(&block, 345, 155))? } else { String::new() };
        if prefix.is_empty() { base } else { format!("{prefix}/{base}") }
      }
    };
    let link = match pax_link.or(long_link.take()) {
      Some(l) => l,
      None => text(field(&block, 157, 100))?,
    };
    let mode = number(&block, 100, 8)?;
    let rel = safe_rel(&name)?;
    match kind {
      b'0' | 0 | b'7' if name.ends_with('/') => {
        if let Some(rel) = &rel {
          write_dir(root, rel, &name)?;
        }
        skip(reader, size + pad(size))?;
      }
      b'0' | 0 | b'7' => {
        let Some(rel) = rel else { return Err(Refusal::Escapes(name)) };
        write_file(root, &rel, &name, mode & 0o111 != 0, reader, Some(size), &mut budget)?;
        skip(reader, pad(size))?;
      }
      b'5' => {
        if let Some(rel) = &rel {
          write_dir(root, rel, &name)?;
        }
        skip(reader, size + pad(size))?;
      }
      b'2' => {
        let Some(rel) = rel else { return Err(Refusal::Escapes(name)) };
        write_symlink(root, &rel, &name, &link)?;
      }
      b'1' => {
        let Some(rel) = rel else { return Err(Refusal::Escapes(name)) };
        write_hardlink(root, &rel, &name, &link)?;
      }
      _ => return Err(Refusal::Kind(name)),
    }
  }
}

/// Unpacks `archive` (`.tar.gz`) into `root`.
pub fn unpack_tar_gz(archive: &Path, root: &Path, max_bytes: u64) -> Result<(), Refusal> {
  let file = fs::File::open(archive).map_err(io_err)?;
  let mut gz = flate2::read::GzDecoder::new(io::BufReader::new(file));
  unpack_tar(&mut gz, root, max_bytes)
}

/// Unpacks `archive` (`.zip`) into `root`.
pub fn unpack_zip(archive: &Path, root: &Path, max_bytes: u64) -> Result<(), Refusal> {
  let file = fs::File::open(archive).map_err(io_err)?;
  let mut zip = zip::ZipArchive::new(io::BufReader::new(file)).map_err(|e| Refusal::Corrupt(e.to_string()))?;
  let mut budget = Budget { left: max_bytes, entries: 0 };
  for i in 0..zip.len() {
    budget.entry()?;
    let mut entry = zip.by_index(i).map_err(|e| Refusal::Corrupt(e.to_string()))?;
    // A Windows-made archive may spell folders with `\`; read as a separator it cannot hide a climb.
    let name = entry.name().replace('\\', "/");
    let rel = safe_rel(&name)?;
    let mode = entry.unix_mode();
    if entry.is_dir() {
      if let Some(rel) = &rel {
        write_dir(root, rel, &name)?;
      }
      continue;
    }
    let Some(rel) = rel else { return Err(Refusal::Escapes(name)) };
    if entry.is_symlink() {
      let mut target = String::new();
      (&mut entry).take(MAX_NAME as u64 + 1).read_to_string(&mut target).map_err(|e| Refusal::Corrupt(e.to_string()))?;
      write_symlink(root, &rel, &name, &target)?;
      continue;
    }
    // Any other special file type in the mode's upper bits is not a release file.
    if mode.is_some_and(|m| m & 0o170000 != 0 && m & 0o170000 != 0o100000) {
      return Err(Refusal::Kind(name));
    }
    write_file(root, &rel, &name, mode.is_some_and(|m| m & 0o111 != 0), &mut entry, None, &mut budget)?;
  }
  Ok(())
}

#[cfg(all(test, unix))]
pub(crate) mod tests {
  use super::*;
  use std::io::Write;
  use std::os::unix::fs::PermissionsExt;

  /// One tar header + body, the way `tar` writes it.
  pub fn tar_entry(name: &str, kind: u8, mode: u32, link: &str, body: &[u8]) -> Vec<u8> {
    let mut h = [0u8; BLOCK];
    h[..name.len()].copy_from_slice(name.as_bytes());
    h[100..108].copy_from_slice(format!("{mode:07o}\0").as_bytes());
    h[108..116].copy_from_slice(b"0000000\0");
    h[116..124].copy_from_slice(b"0000000\0");
    h[124..136].copy_from_slice(format!("{:011o}\0", body.len()).as_bytes());
    h[136..148].copy_from_slice(b"00000000000\0");
    h[156] = kind;
    h[157..157 + link.len()].copy_from_slice(link.as_bytes());
    h[257..263].copy_from_slice(b"ustar\0");
    h[263..265].copy_from_slice(b"00");
    let sum: u32 = h.iter().enumerate().map(|(i, &b)| if (148..156).contains(&i) { 32 } else { b as u32 }).sum();
    h[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
    let mut out = h.to_vec();
    out.extend_from_slice(body);
    out.resize(out.len() + pad(body.len() as u64) as usize, 0);
    out
  }

  pub fn tar_of(entries: &[Vec<u8>]) -> Vec<u8> {
    let mut out: Vec<u8> = entries.concat();
    out.resize(out.len() + 2 * BLOCK, 0);
    out
  }

  pub fn gz(bytes: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    e.write_all(bytes).unwrap();
    e.finish().unwrap()
  }

  fn unpack(entries: &[Vec<u8>]) -> (tempfile::TempDir, Result<(), Refusal>) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("release");
    fs::create_dir(&root).unwrap();
    let r = unpack_tar(&mut tar_of(entries).as_slice(), &root, 1 << 20);
    (dir, r)
  }

  /// Nothing may exist beside the release folder after a refused archive.
  fn nothing_outside(dir: &tempfile::TempDir) {
    let names: Vec<_> = fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(names, ["release"]);
  }

  #[test]
  fn unpacks_files_folders_and_inner_links() {
    let (dir, r) = unpack(&[
      tar_entry("./", b'5', 0o755, "", b""),
      tar_entry("./dist-package/", b'5', 0o755, "", b""),
      tar_entry("./dist-package/cursor-agent", b'0', 0o4755, "", b"#!/bin/sh\necho 1.2.3\n"),
      tar_entry("dist-package/lib/data.json", b'0', 0o644, "", b"{}"),
      tar_entry("dist-package/lib/agent", b'2', 0o777, "../cursor-agent", b""),
      tar_entry("dist-package/copy", b'1', 0o644, "dist-package/lib/data.json", b""),
    ]);
    r.unwrap();
    let root = dir.path().join("release");
    let agent = root.join("dist-package/cursor-agent");
    assert_eq!(fs::read(&agent).unwrap(), b"#!/bin/sh\necho 1.2.3\n");
    assert_eq!(fs::metadata(&agent).unwrap().permissions().mode() & 0o7777, 0o755, "set-id bits never carry over");
    assert_eq!(fs::metadata(root.join("dist-package/lib/data.json")).unwrap().permissions().mode() & 0o777, 0o644);
    assert_eq!(fs::read_link(root.join("dist-package/lib/agent")).unwrap(), Path::new("../cursor-agent"));
    assert_eq!(fs::read(root.join("dist-package/copy")).unwrap(), b"{}");
  }

  #[test]
  fn long_names_come_from_gnu_and_pax_records() {
    let long = format!("{}/tool", "d".repeat(120));
    let pax_body = {
      let record = "path=pax/renamed\n";
      let len = record.len() + 3;
      format!("{len} {record}")
    };
    let (dir, r) = unpack(&[
      tar_entry("././@LongLink", b'L', 0o644, "", format!("{long}\0").as_bytes()),
      tar_entry("truncated", b'0', 0o755, "", b"x"),
      tar_entry("PaxHeader", b'x', 0o644, "", pax_body.as_bytes()),
      tar_entry("ignored", b'0', 0o644, "", b"y"),
    ]);
    r.unwrap();
    assert_eq!(fs::read(dir.path().join("release").join(&long)).unwrap(), b"x");
    assert_eq!(fs::read(dir.path().join("release/pax/renamed")).unwrap(), b"y");
  }

  #[test]
  fn binary_pax_values_of_unused_keys_are_skipped() {
    // As in Cursor 2026.11.22's release: code-signature xattrs with binary values beside a path.
    fn record(key: &str, value: &[u8]) -> Vec<u8> {
      let body = [key.as_bytes(), b"=", value, b"\n"].concat();
      let mut len = body.len() + 2;
      if (len.to_string().len() + 1 + body.len()) != len {
        len = len.to_string().len() + 1 + body.len();
      }
      [format!("{len} ").into_bytes(), body].concat()
    }
    let records = [record("SCHILY.xattr.com.apple.cs.CodeSignature", &[0xfa, 0xde, 0x0c, 0xc0, 0xff, 0x00]), record("path", b"pax/signed.node")].concat();
    let (dir, r) = unpack(&[tar_entry("PaxHeader", b'x', 0o644, "", &records), tar_entry("signed.node", b'0', 0o644, "", b"z")]);
    r.unwrap();
    assert_eq!(fs::read(dir.path().join("release/pax/signed.node")).unwrap(), b"z");
    // A used key whose value is not text still refuses the archive.
    let (_dir, r) = unpack(&[tar_entry("PaxHeader", b'x', 0o644, "", &record("path", &[0xff, 0xfe])), tar_entry("x", b'0', 0o644, "", b"z")]);
    assert!(matches!(r, Err(Refusal::Corrupt(_))), "{r:?}");
  }

  #[test]
  fn refuses_names_that_leave_the_folder() {
    for name in ["../evil", "a/../../evil", "/tmp/evil", "a/b/../../../evil"] {
      let (dir, r) = unpack(&[tar_entry(name, b'0', 0o755, "", b"x")]);
      assert!(matches!(r, Err(Refusal::Escapes(_))), "{name}: {r:?}");
      nothing_outside(&dir);
    }
    // The long-name records are checked like header names.
    let (dir, r) = unpack(&[tar_entry("././@LongLink", b'L', 0o644, "", b"../../evil\0"), tar_entry("x", b'0', 0o644, "", b"x")]);
    assert!(matches!(r, Err(Refusal::Escapes(_))), "{r:?}");
    nothing_outside(&dir);
    let (_, r) = unpack(&[tar_entry("PaxHeader", b'x', 0o644, "", b"19 path=../../evil\n"), tar_entry("x", b'0', 0o644, "", b"x")]);
    assert!(matches!(r, Err(Refusal::Escapes(_))), "{r:?}");
    assert_eq!(safe_rel("./a//b/./c").unwrap(), Some(PathBuf::from("a/b/c")));
    assert_eq!(safe_rel("./").unwrap(), None);
    assert!(safe_rel("a\\..\\b").is_err() && safe_rel("a\0b").is_err());
  }

  #[test]
  fn refuses_links_that_point_or_lead_outside() {
    for target in ["/etc/passwd", "../outside", "../../outside", "sub/../../outside", "a/../b", ""] {
      let (dir, r) = unpack(&[tar_entry("link", b'2', 0o777, target, b"")]);
      assert!(matches!(r, Err(Refusal::Escapes(_))), "{target:?}: {r:?}");
      nothing_outside(&dir);
    }
    // A link to the folder's parent, then a file "inside" it.
    let outside = tempfile::tempdir().unwrap();
    let escape = format!("../../{}", outside.path().file_name().unwrap().to_str().unwrap());
    let (_, r) = unpack(&[tar_entry("d", b'2', 0o777, &escape, b""), tar_entry("d/evil", b'0', 0o755, "", b"x")]);
    assert!(matches!(r, Err(Refusal::Escapes(_))), "{r:?}");
    assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
    // An inner link is never written through either: the entry is refused, the link's target untouched.
    let (dir, r) = unpack(&[tar_entry("real/", b'5', 0o755, "", b""), tar_entry("d", b'2', 0o777, "real", b""), tar_entry("d/file", b'0', 0o644, "", b"x")]);
    assert!(matches!(r, Err(Refusal::Escapes(_))), "{r:?}");
    assert!(!dir.path().join("release/real/file").exists());
    // A file entry replacing a link writes a new file, not through the link.
    let (dir, r) = unpack(&[tar_entry("keep", b'0', 0o644, "", b"kept"), tar_entry("l", b'2', 0o777, "keep", b""), tar_entry("l", b'0', 0o644, "", b"new")]);
    r.unwrap();
    assert_eq!(fs::read(dir.path().join("release/keep")).unwrap(), b"kept");
    assert_eq!(fs::read(dir.path().join("release/l")).unwrap(), b"new");
    // Hard links: only to a file this archive wrote.
    for target in ["../outside", "/etc/passwd", "missing", "d"] {
      let (_, r) = unpack(&[tar_entry("d/", b'5', 0o755, "", b""), tar_entry("h", b'1', 0o644, target, b"")]);
      assert!(r.is_err(), "{target}: {r:?}");
    }
    let (_, r) = unpack(&[tar_entry("f", b'0', 0o644, "", b"x"), tar_entry("l", b'2', 0o777, "f", b""), tar_entry("h", b'1', 0o644, "l", b"")]);
    assert!(matches!(r, Err(Refusal::Escapes(_))), "a hard link through a link: {r:?}");
  }

  #[test]
  fn refuses_devices_oversized_and_damaged_archives() {
    for kind in [b'3', b'4', b'6'] {
      let (_, r) = unpack(&[tar_entry("dev", kind, 0o644, "", b"")]);
      assert!(matches!(r, Err(Refusal::Kind(_))), "{r:?}");
    }
    let dir = tempfile::tempdir().unwrap();
    let big = tar_of(&[tar_entry("big", b'0', 0o644, "", &[7u8; 4096])]);
    assert_eq!(unpack_tar(&mut big.as_slice(), dir.path(), 4095), Err(Refusal::TooLarge));
    unpack_tar(&mut big.as_slice(), dir.path(), 4096).unwrap();
    let mut bad = tar_of(&[tar_entry("f", b'0', 0o644, "", b"x")]);
    bad[0] = b'g';
    assert!(matches!(unpack_tar(&mut bad.as_slice(), dir.path(), 1 << 20), Err(Refusal::Corrupt(_))), "a changed header fails its checksum");
    let cut = &tar_of(&[tar_entry("f", b'0', 0o644, "", &[1u8; 2000])])[..BLOCK + 700];
    assert!(matches!(unpack_tar(&mut &cut[..], dir.path(), 1 << 20), Err(Refusal::Corrupt(_))));
  }

  pub fn zip_of(build: impl FnOnce(&mut zip::ZipWriter<io::Cursor<Vec<u8>>>)) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(io::Cursor::new(Vec::new()));
    build(&mut zip);
    zip.finish().unwrap().into_inner()
  }

  fn unzip(bytes: &[u8]) -> (tempfile::TempDir, Result<(), Refusal>) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("release");
    fs::create_dir(&root).unwrap();
    let archive = dir.path().join("a.zip");
    fs::write(&archive, bytes).unwrap();
    let r = unpack_zip(&archive, &root, 1 << 20);
    fs::remove_file(&archive).unwrap();
    (dir, r)
  }

  #[test]
  fn zip_archives_follow_the_same_rules() {
    use zip::write::SimpleFileOptions as O;
    let (dir, r) = unzip(&zip_of(|z| {
      z.start_file("opencode", O::default().unix_permissions(0o755)).unwrap();
      z.write_all(b"binary").unwrap();
      z.add_directory("share/", O::default()).unwrap();
      z.start_file("share/notes.txt", O::default().unix_permissions(0o644)).unwrap();
      z.write_all(b"n").unwrap();
      z.add_symlink("share/oc", "../opencode", O::default()).unwrap();
    }));
    r.unwrap();
    let root = dir.path().join("release");
    assert_eq!(fs::metadata(root.join("opencode")).unwrap().permissions().mode() & 0o777, 0o755);
    assert_eq!(fs::metadata(root.join("share/notes.txt")).unwrap().permissions().mode() & 0o777, 0o644);
    assert_eq!(fs::read_link(root.join("share/oc")).unwrap(), Path::new("../opencode"));

    for name in ["../evil", "a/../../evil", "/abs", "a\\..\\..\\evil"] {
      let (dir, r) = unzip(&zip_of(|z| {
        z.start_file(name, O::default()).unwrap();
        z.write_all(b"x").unwrap();
      }));
      assert!(matches!(r, Err(Refusal::Escapes(_))), "{name}: {r:?}");
      nothing_outside(&dir);
    }
    for target in ["/etc/passwd", "../../outside"] {
      let (dir, r) = unzip(&zip_of(|z| z.add_symlink("link", target, O::default()).unwrap()));
      assert!(matches!(r, Err(Refusal::Escapes(_))), "{target}: {r:?}");
      nothing_outside(&dir);
    }
    let (_, r) = unzip(&zip_of(|z| {
      z.add_symlink("d", "..", O::default()).unwrap();
      z.start_file("d/evil", O::default()).unwrap();
      z.write_all(b"x").unwrap();
    }));
    assert!(matches!(r, Err(Refusal::Escapes(_))), "{r:?}");
    let bomb = zip_of(|z| {
      z.start_file("big", O::default().compression_method(zip::CompressionMethod::Deflated)).unwrap();
      z.write_all(&vec![0u8; 3 << 20]).unwrap();
    });
    assert_eq!(unzip(&bomb).1, Err(Refusal::TooLarge));
    assert!(matches!(unzip(b"not a zip").1, Err(Refusal::Corrupt(_))));
  }
}
