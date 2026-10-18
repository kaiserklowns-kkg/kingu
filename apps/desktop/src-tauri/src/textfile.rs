//! Reading and saving text files the way VS Code's text file service does
//! (`workbench/services/textfile/common/encoding.ts`, `textFileService.ts`):
//! - BOM detection, then UTF-16 without BOM and binary content from the zero bytes in the first
//!   512 bytes; `files.autoGuessEncoding` guesses legacy encodings (chardetng in place of
//!   jschardet). An explicit encoding ("Reopen with Encoding") wins over what is detected.
//! - Saving encodes with the file's encoding; UTF-8 with BOM and UTF-16 always get a BOM.
//! - A save carries the mtime and SHA-256 the editor loaded; when the file on disk has changed
//!   since, the save is refused as a conflict (VS Code's "file is newer" error).

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use encoding_rs::Encoding;
use sha2::{Digest, Sha256};

/// VS Code's encoding ids (SUPPORTED_ENCODINGS keys) that encoding_rs implements. ISO 8859-1,
/// 8859-9 and 8859-11 decode as their WHATWG supersets (Windows 1252, 1254 and 874).
const ENCODINGS: &[(&str, &Encoding)] = &[
  ("utf8", encoding_rs::UTF_8),
  ("utf8bom", encoding_rs::UTF_8),
  ("utf16le", encoding_rs::UTF_16LE),
  ("utf16be", encoding_rs::UTF_16BE),
  ("windows1252", encoding_rs::WINDOWS_1252),
  ("iso88591", encoding_rs::WINDOWS_1252),
  ("iso88593", encoding_rs::ISO_8859_3),
  ("iso885915", encoding_rs::ISO_8859_15),
  ("macroman", encoding_rs::MACINTOSH),
  ("windows1256", encoding_rs::WINDOWS_1256),
  ("iso88596", encoding_rs::ISO_8859_6),
  ("windows1257", encoding_rs::WINDOWS_1257),
  ("iso88594", encoding_rs::ISO_8859_4),
  ("iso885914", encoding_rs::ISO_8859_14),
  ("windows1250", encoding_rs::WINDOWS_1250),
  ("iso88592", encoding_rs::ISO_8859_2),
  ("windows1251", encoding_rs::WINDOWS_1251),
  ("cp866", encoding_rs::IBM866),
  ("iso88595", encoding_rs::ISO_8859_5),
  ("koi8r", encoding_rs::KOI8_R),
  ("koi8u", encoding_rs::KOI8_U),
  ("iso885913", encoding_rs::ISO_8859_13),
  ("windows1253", encoding_rs::WINDOWS_1253),
  ("iso88597", encoding_rs::ISO_8859_7),
  ("windows1255", encoding_rs::WINDOWS_1255),
  ("iso88598", encoding_rs::ISO_8859_8),
  ("iso885910", encoding_rs::ISO_8859_10),
  ("iso885916", encoding_rs::ISO_8859_16),
  ("windows1254", encoding_rs::WINDOWS_1254),
  ("iso88599", encoding_rs::WINDOWS_1254),
  ("windows1258", encoding_rs::WINDOWS_1258),
  ("gbk", encoding_rs::GBK),
  ("gb18030", encoding_rs::GB18030),
  ("gb2312", encoding_rs::GBK),
  ("cp950", encoding_rs::BIG5),
  ("big5hkscs", encoding_rs::BIG5),
  ("shiftjis", encoding_rs::SHIFT_JIS),
  ("eucjp", encoding_rs::EUC_JP),
  ("euckr", encoding_rs::EUC_KR),
  ("windows874", encoding_rs::WINDOWS_874),
  ("iso885911", encoding_rs::WINDOWS_874),
];

const UTF8_BOM: &[u8] = &[0xEF, 0xBB, 0xBF];
const UTF16LE_BOM: &[u8] = &[0xFF, 0xFE];
const UTF16BE_BOM: &[u8] = &[0xFE, 0xFF];

/// VS Code: ZERO_BYTE_DETECTION_BUFFER_MAX_LEN.
const ZERO_BYTE_DETECTION_LEN: usize = 512;
/// VS Code: AUTO_ENCODING_GUESS_MAX_BYTES.
const GUESS_MAX_BYTES: usize = 512 * 128;

/// Files above this ask before opening. VS Code uses 10 MB where the file crosses a process or
/// network boundary (web, remote); here every byte crosses the webview IPC.
pub const LARGE_FILE_LIMIT: u64 = 10 * 1024 * 1024;
/// Never read more than this into the webview, even after "Open Anyway" (VS Code's local
/// confirmation limit).
pub const MAX_FILE_SIZE: u64 = 1024 * 1024 * 1024;

pub fn encoding_for(id: &str) -> Option<&'static Encoding> {
  ENCODINGS.iter().find(|(k, _)| *k == id).map(|(_, e)| *e)
}

fn id_for(encoding: &'static Encoding) -> &'static str {
  ENCODINGS.iter().find(|(_, e)| *e == encoding).map(|(k, _)| *k).unwrap_or("utf8")
}

/// VS Code's detectEncodingByBOMFromBuffer.
pub fn detect_bom(buf: &[u8]) -> Option<&'static str> {
  if buf.starts_with(UTF8_BOM) {
    Some("utf8bom")
  } else if buf.starts_with(UTF16BE_BOM) {
    Some("utf16be")
  } else if buf.starts_with(UTF16LE_BOM) {
    Some("utf16le")
  } else {
    None
  }
}

#[derive(Debug, PartialEq)]
pub struct Detected {
  pub encoding: Option<&'static str>,
  pub seems_binary: bool,
}

/// VS Code's detectEncodingFromBuffer: a BOM, else zero bytes in the first 512 bytes mean UTF-16
/// (when they all sit on one side of each byte pair) or binary content.
pub fn detect(buf: &[u8], auto_guess: bool) -> Detected {
  let mut encoding = detect_bom(buf);
  let mut seems_binary = false;
  if encoding.is_none() {
    let (mut could_be_le, mut could_be_be, mut has_zero) = (true, true, false);
    for (i, &b) in buf.iter().take(ZERO_BYTE_DETECTION_LEN).enumerate() {
      let odd = i % 2 == 1;
      let zero = b == 0;
      has_zero |= zero;
      if could_be_le && (odd && !zero || !odd && zero) {
        could_be_le = false;
      }
      if could_be_be && (odd && zero || !odd && !zero) {
        could_be_be = false;
      }
      if zero && !could_be_le && !could_be_be {
        break;
      }
    }
    if has_zero {
      if could_be_le {
        encoding = Some("utf16le");
      } else if could_be_be {
        encoding = Some("utf16be");
      } else {
        seems_binary = true;
      }
    }
  }
  if auto_guess && !seems_binary && encoding.is_none() {
    encoding = guess(buf);
  }
  Detected { encoding, seems_binary }
}

/// `files.autoGuessEncoding`. Like VS Code's jschardet use, pure ASCII guesses nothing (the
/// configured encoding applies) and valid UTF-8 stays UTF-8.
pub fn guess(buf: &[u8]) -> Option<&'static str> {
  let sample = &buf[..buf.len().min(GUESS_MAX_BYTES)];
  if sample.is_ascii() {
    return None;
  }
  match std::str::from_utf8(sample) {
    Ok(_) => return Some("utf8"),
    // The sample may end inside a character.
    Err(e) if e.error_len().is_none() && sample.len() < buf.len() => return Some("utf8"),
    Err(_) => {}
  }
  let mut detector = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Deny);
  detector.feed(sample, sample.len() == buf.len());
  let guessed = detector.guess(None, chardetng::Utf8Detection::Allow);
  ENCODINGS.iter().any(|(_, e)| *e == guessed).then(|| id_for(guessed))
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct Stat {
  /// Milliseconds since the epoch.
  pub mtime: u64,
  pub size: u64,
  /// SHA-256 of the bytes on disk, hex.
  pub hash: String,
  /// The file's permissions say it cannot be written (`files.readonlyFromPermissions`).
  #[serde(default)]
  pub readonly: bool,
}

pub fn hash(bytes: &[u8]) -> String {
  Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn mtime_of(meta: &std::fs::Metadata) -> u64 {
  meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64)
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadOptions {
  /// "Reopen with Encoding", or the encoding of a restored backup.
  pub encoding: Option<String>,
  /// `files.encoding`.
  #[serde(default)]
  pub default_encoding: Option<String>,
  /// `files.autoGuessEncoding`.
  #[serde(default)]
  pub auto_guess: bool,
  /// "Open Anyway" on the binary placeholder.
  #[serde(default)]
  pub accept_binary: bool,
  /// `workbench.editorLargeFileConfirmation` in bytes: larger files ask first (default
  /// LARGE_FILE_LIMIT; never above MAX_FILE_SIZE).
  #[serde(default)]
  pub large_file_limit: Option<u64>,
  /// "Open Anyway" on the large file placeholder.
  #[serde(default)]
  pub accept_large: bool,
}

#[derive(Debug, serde::Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ReadResult {
  #[serde(rename_all = "camelCase")]
  Text {
    content: String,
    encoding: String,
    /// Bytes that are invalid in `encoding` became U+FFFD; saving would not give them back.
    lossy: bool,
    stat: Stat,
  },
  Binary { size: u64 },
  TooLarge { size: u64, limit: u64 },
}

/// VS Code's getPreferredReadEncoding: the requested encoding (keeping a detected UTF-8 BOM),
/// else the detected one, else `files.encoding` (UTF-8 with BOM only when a BOM was seen).
pub fn read_encoding(requested: Option<&str>, detected: Option<&'static str>, configured: &str) -> String {
  match (requested, detected) {
    (Some("utf8"), Some("utf8bom")) => "utf8bom".into(),
    (Some(e), _) if encoding_for(e).is_some() => e.into(),
    (_, Some(d)) => d.into(),
    _ if configured == "utf8bom" => "utf8".into(),
    _ if encoding_for(configured).is_some() => configured.into(),
    _ => "utf8".into(),
  }
}

/// Decodes `bytes`, dropping the BOM that belongs to `encoding`. Returns the text and whether
/// any byte was malformed.
pub fn decode(bytes: &[u8], encoding: &str) -> (String, bool) {
  let enc = encoding_for(encoding).unwrap_or(encoding_rs::UTF_8);
  let bom: &[u8] = match encoding {
    "utf8" | "utf8bom" => UTF8_BOM,
    "utf16le" => UTF16LE_BOM,
    "utf16be" => UTF16BE_BOM,
    _ => &[],
  };
  let body = if !bom.is_empty() && bytes.starts_with(bom) { &bytes[bom.len()..] } else { bytes };
  let (text, errors) = enc.decode_without_bom_handling(body);
  (text.into_owned(), errors)
}

pub fn decode_file(bytes: &[u8], opts: &ReadOptions) -> ReadResult {
  let size = bytes.len() as u64;
  let detected = detect(bytes, opts.auto_guess && opts.encoding.is_none());
  if detected.seems_binary && !opts.accept_binary && opts.encoding.is_none() {
    return ReadResult::Binary { size };
  }
  let encoding = read_encoding(opts.encoding.as_deref(), detected.encoding, opts.default_encoding.as_deref().unwrap_or("utf8"));
  let (content, lossy) = decode(bytes, &encoding);
  ReadResult::Text { content, encoding, lossy, stat: Stat { mtime: 0, size, hash: hash(bytes), readonly: false } }
}

pub fn read(path: &Path, opts: &ReadOptions) -> Result<ReadResult, String> {
  let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
  if meta.is_dir() {
    return Err("is a directory".into());
  }
  let size = meta.len();
  let confirm = opts.large_file_limit.unwrap_or(LARGE_FILE_LIMIT).clamp(1, MAX_FILE_SIZE);
  if size > MAX_FILE_SIZE || (size > confirm && !opts.accept_large) {
    return Ok(ReadResult::TooLarge { size, limit: if size > MAX_FILE_SIZE { MAX_FILE_SIZE } else { confirm } });
  }
  let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
  let mut result = decode_file(&bytes, opts);
  if let ReadResult::Text { stat, .. } = &mut result {
    stat.mtime = mtime_of(&meta);
    stat.readonly = meta.permissions().readonly();
  }
  Ok(result)
}

#[derive(Debug, PartialEq)]
pub enum EncodeError {
  /// A character `encoding` cannot represent (encoding_rs would write an HTML entity).
  Unmappable(char),
}

/// Encodes `text` for saving; UTF-8 with BOM and UTF-16 get a BOM (VS Code's getPreferredWriteEncoding).
pub fn encode(text: &str, encoding: &str) -> Result<Vec<u8>, EncodeError> {
  match encoding {
    "utf8" => Ok(text.as_bytes().to_vec()),
    "utf8bom" => Ok([UTF8_BOM, text.as_bytes()].concat()),
    "utf16le" => Ok(UTF16LE_BOM.iter().copied().chain(text.encode_utf16().flat_map(u16::to_le_bytes)).collect()),
    "utf16be" => Ok(UTF16BE_BOM.iter().copied().chain(text.encode_utf16().flat_map(u16::to_be_bytes)).collect()),
    other => {
      let enc = encoding_for(other).unwrap_or(encoding_rs::UTF_8);
      let (bytes, _, unmappable) = enc.encode(text);
      if unmappable {
        let bad = text.chars().find(|c| enc.encode(c.encode_utf8(&mut [0; 4])).2).unwrap_or('\u{FFFD}');
        return Err(EncodeError::Unmappable(bad));
      }
      Ok(bytes.into_owned())
    }
  }
}

/// What the editor loaded (or last saved): a save checks the file on disk still matches.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct Expected {
  pub mtime: u64,
  pub hash: String,
}

#[derive(Debug, serde::Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WriteResult {
  Saved { stat: Stat },
  /// The file changed on disk since `expected`; nothing was written.
  Conflict { stat: Stat },
  /// `encoding` cannot represent `ch`; nothing was written.
  Unencodable { ch: String },
}

/// The disk changed since `expected`: a newer mtime alone (a `touch`, a checkout of the same
/// content) is not a conflict, different content is.
pub fn conflict(path: &Path, expected: &Expected) -> Result<Option<Stat>, String> {
  let Ok(meta) = std::fs::metadata(path) else { return Ok(None) }; // deleted: saving recreates it
  let mtime = mtime_of(&meta);
  if mtime == expected.mtime {
    return Ok(None);
  }
  let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
  let h = hash(&bytes);
  Ok((h != expected.hash).then_some(Stat { mtime, size: bytes.len() as u64, hash: h, readonly: meta.permissions().readonly() }))
}

pub fn write(path: &Path, text: &str, encoding: &str, expected: Option<&Expected>) -> Result<WriteResult, String> {
  if let Some(exp) = expected
    && let Some(stat) = conflict(path, exp)?
  {
    return Ok(WriteResult::Conflict { stat });
  }
  let bytes = match encode(text, encoding) {
    Ok(b) => b,
    Err(EncodeError::Unmappable(ch)) => return Ok(WriteResult::Unencodable { ch: ch.to_string() }),
  };
  std::fs::write(path, &bytes).map_err(|e| e.to_string())?;
  let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
  Ok(WriteResult::Saved { stat: Stat { mtime: mtime_of(&meta), size: bytes.len() as u64, hash: hash(&bytes), readonly: meta.permissions().readonly() } })
}

/// `rel` inside `root` for a save: the file itself, or (deleted on disk) its parent folder joined
/// with a plain file name.
pub fn resolve_for_write(root: &Path, rel: &str) -> Result<PathBuf, String> {
  if let Ok(p) = crate::workspace::resolve_in(root, rel) {
    return if p.is_dir() { Err(format!("{rel}: is a directory")) } else { Ok(p) };
  }
  let rel_path = Path::new(rel);
  let name = rel_path.file_name().filter(|n| *n != ".." && *n != ".").ok_or_else(|| format!("{rel}: invalid path"))?;
  let parent = rel_path.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
  let dir = if parent.is_empty() { root.to_path_buf() } else { crate::workspace::resolve_in(root, &parent)? };
  if !dir.is_dir() {
    return Err(format!("{rel}: folder not found"));
  }
  Ok(dir.join(name))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn text_of(r: ReadResult) -> (String, String, bool) {
    match r {
      ReadResult::Text { content, encoding, lossy, .. } => (content, encoding, lossy),
      other => panic!("{other:?}"),
    }
  }

  fn opts(auto_guess: bool) -> ReadOptions {
    ReadOptions { auto_guess, ..Default::default() }
  }

  #[test]
  fn utf8_and_bom_round_trip() {
    let s = "สวัสดี hello\n";
    assert_eq!(text_of(decode_file(s.as_bytes(), &opts(false))), (s.into(), "utf8".into(), false));
    let with_bom = encode(s, "utf8bom").unwrap();
    assert!(with_bom.starts_with(UTF8_BOM));
    let (text, enc, _) = text_of(decode_file(&with_bom, &opts(false)));
    assert_eq!((text.as_str(), enc.as_str()), (s, "utf8bom"));
    assert_eq!(encode(&text, &enc).unwrap(), with_bom);
    // Reopening a BOM file as UTF-8 keeps the BOM (VS Code's getPreferredReadEncoding).
    let reopened = decode_file(&with_bom, &ReadOptions { encoding: Some("utf8".into()), ..Default::default() });
    assert_eq!(text_of(reopened).1, "utf8bom");
  }

  #[test]
  fn utf16_with_and_without_bom() {
    let s = "a=1\nไทย\n";
    for enc in ["utf16le", "utf16be"] {
      let bytes = encode(s, enc).unwrap();
      assert_eq!(detect(&bytes, false).encoding, Some(enc));
      let (text, got, lossy) = text_of(decode_file(&bytes, &opts(false)));
      assert_eq!((text.as_str(), got.as_str(), lossy), (s, enc, false));
      assert_eq!(encode(&text, &got).unwrap(), bytes);
    }
    // No BOM: ASCII in UTF-16 has every other byte zero.
    let le: Vec<u8> = "hello world".encode_utf16().flat_map(u16::to_le_bytes).collect();
    let be: Vec<u8> = "hello world".encode_utf16().flat_map(u16::to_be_bytes).collect();
    assert_eq!(detect(&le, false), Detected { encoding: Some("utf16le"), seems_binary: false });
    assert_eq!(detect(&be, false), Detected { encoding: Some("utf16be"), seems_binary: false });
    assert_eq!(text_of(decode_file(&le, &opts(false))).0, "hello world");
  }

  #[test]
  fn binary_detection() {
    let png = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, b'I', b'H', b'D', b'R', 0, 0];
    assert!(detect(&png, true).seems_binary);
    assert_eq!(decode_file(&png, &opts(true)), ReadResult::Binary { size: png.len() as u64 });
    // "Open Anyway" decodes it anyway.
    let opened = decode_file(&png, &ReadOptions { accept_binary: true, ..Default::default() });
    assert!(matches!(opened, ReadResult::Text { .. }));
    // A zero byte past the first 512 bytes is not looked at (as in VS Code).
    let mut late = vec![b'a'; 600];
    late[550] = 0;
    assert!(!detect(&late, false).seems_binary);
    assert!(!detect(b"plain text", false).seems_binary);
  }

  #[test]
  fn thai_windows_874_round_trip_and_guess() {
    let s = "ภาษาไทยเป็นภาษาราชการของประเทศไทย ใช้อักษรไทยในการเขียน และมีวรรณยุกต์ห้าเสียง\n";
    let bytes = encode(s, "windows874").unwrap();
    assert_ne!(bytes, s.as_bytes());
    // Without guessing it is not UTF-8: decoded lossily, which the editor reports.
    assert!(text_of(decode_file(&bytes, &opts(false))).2);
    let (text, enc, lossy) = text_of(decode_file(&bytes, &opts(true)));
    assert_eq!((text.as_str(), enc.as_str(), lossy), (s, "windows874", false));
    assert_eq!(encode(&text, &enc).unwrap(), bytes);
    // Reopen with Encoding.
    let reopened = decode_file(&bytes, &ReadOptions { encoding: Some("windows874".into()), ..Default::default() });
    assert_eq!(text_of(reopened).0, s);
  }

  #[test]
  fn shift_jis_round_trip_and_guess() {
    let s = "日本語のテキストです。これはシフトJISで保存されたファイルの例です。漢字とひらがなとカタカナ。\n";
    let bytes = encode(s, "shiftjis").unwrap();
    let (text, enc, lossy) = text_of(decode_file(&bytes, &opts(true)));
    assert_eq!((text.as_str(), enc.as_str(), lossy), (s, "shiftjis", false));
    assert_eq!(encode(&text, &enc).unwrap(), bytes);
  }

  #[test]
  fn guess_leaves_ascii_and_utf8_alone() {
    assert_eq!(guess(b"just ascii"), None);
    assert_eq!(guess("ไทย".as_bytes()), Some("utf8"));
    // ASCII falls back to files.encoding.
    let r = decode_file(b"abc", &ReadOptions { auto_guess: true, default_encoding: Some("windows1252".into()), ..Default::default() });
    assert_eq!(text_of(r).1, "windows1252");
    // files.encoding utf8bom without a BOM on disk reads as plain UTF-8.
    assert_eq!(read_encoding(None, None, "utf8bom"), "utf8");
    assert_eq!(read_encoding(Some("nope"), None, "nope"), "utf8");
  }

  #[test]
  fn unencodable_characters_are_refused() {
    assert_eq!(encode("ไทย", "windows1252"), Err(EncodeError::Unmappable('ไ')));
    assert_eq!(encode("abc", "windows1252").unwrap(), b"abc");
  }

  #[test]
  fn large_files_ask_first() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("big.txt");
    let f = std::fs::File::create(&p).unwrap();
    f.set_len(LARGE_FILE_LIMIT + 1).unwrap();
    assert_eq!(read(&p, &opts(false)).unwrap(), ReadResult::TooLarge { size: LARGE_FILE_LIMIT + 1, limit: LARGE_FILE_LIMIT });
    // set_len fills with zero bytes, so once allowed it is binary.
    let r = read(&p, &ReadOptions { accept_large: true, ..Default::default() }).unwrap();
    assert_eq!(r, ReadResult::Binary { size: LARGE_FILE_LIMIT + 1 });
    // workbench.editorLargeFileConfirmation moves the limit either way.
    let r = read(&p, &ReadOptions { large_file_limit: Some(LARGE_FILE_LIMIT * 2), ..Default::default() }).unwrap();
    assert_eq!(r, ReadResult::Binary { size: LARGE_FILE_LIMIT + 1 });
    let small = 1024 * 1024;
    let r = read(&p, &ReadOptions { large_file_limit: Some(small), ..Default::default() }).unwrap();
    assert_eq!(r, ReadResult::TooLarge { size: LARGE_FILE_LIMIT + 1, limit: small });
  }

  #[test]
  fn read_reports_readonly_permissions() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("ro.txt");
    std::fs::write(&p, "x").unwrap();
    let stat_of = |p: &Path| match read(p, &opts(false)).unwrap() {
      ReadResult::Text { stat, .. } => stat,
      other => panic!("{other:?}"),
    };
    assert!(!stat_of(&p).readonly);
    let mut perms = std::fs::metadata(&p).unwrap().permissions();
    perms.set_readonly(true);
    std::fs::set_permissions(&p, perms).unwrap();
    assert!(stat_of(&p).readonly);
  }

  #[test]
  fn save_conflict_check() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("a.txt");
    std::fs::write(&p, "one").unwrap();
    let ReadResult::Text { stat, .. } = read(&p, &opts(false)).unwrap() else { panic!() };
    let expected = Expected { mtime: stat.mtime, hash: stat.hash.clone() };
    // Unchanged on disk: saves, and the new stat is what the next save expects.
    let WriteResult::Saved { stat: saved } = write(&p, "two", "utf8", Some(&expected)).unwrap() else { panic!() };
    assert_eq!(saved.hash, hash(b"two"));
    // Someone else writes: the old expectation is now a conflict and nothing is written.
    let after = Expected { mtime: saved.mtime, hash: saved.hash.clone() };
    std::fs::write(&p, "external change").unwrap();
    let old = Expected { mtime: saved.mtime.saturating_sub(5000), hash: saved.hash.clone() };
    match write(&p, "mine", "utf8", Some(&old)).unwrap() {
      WriteResult::Conflict { stat } => assert_eq!(stat.hash, hash(b"external change")),
      other => panic!("{other:?}"),
    }
    assert_eq!(std::fs::read_to_string(&p).unwrap(), "external change");
    // A newer mtime with the same content is not a conflict.
    std::fs::write(&p, "two").unwrap();
    let touched = Expected { mtime: 1, hash: after.hash };
    assert!(conflict(&p, &touched).unwrap().is_none());
    // Overwrite (no expectation) always writes.
    assert!(matches!(write(&p, "forced", "utf8", None).unwrap(), WriteResult::Saved { .. }));
    // Deleted on disk: saving recreates the file.
    std::fs::remove_file(&p).unwrap();
    assert!(matches!(write(&p, "back", "utf8", Some(&old)).unwrap(), WriteResult::Saved { .. }));
    assert_eq!(std::fs::read_to_string(&p).unwrap(), "back");
  }

  #[test]
  fn write_paths_stay_inside_the_root() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    std::fs::create_dir(root.join("src")).unwrap();
    std::fs::write(root.join("src/a.rs"), "").unwrap();
    assert_eq!(resolve_for_write(&root, "src/a.rs").unwrap(), root.join("src/a.rs"));
    assert_eq!(resolve_for_write(&root, "src/gone.rs").unwrap(), root.join("src/gone.rs"));
    assert!(resolve_for_write(&root, "../x").is_err());
    assert!(resolve_for_write(&root, "src/..").is_err());
    assert!(resolve_for_write(&root, "missing/x.rs").is_err());
    assert!(resolve_for_write(&root, "src").is_err());
  }
}
