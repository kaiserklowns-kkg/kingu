//! Orca's browser cookie import (docs/browser/profiles "Cookie import and Google sign-in";
//! Orca src/main/browser/cookies/**): cookies from Google Chrome or Microsoft Edge (a profile of
//! theirs), or from a JSON cookie file, go into one Kingu browser profile. Only the domains in the
//! import are replaced; other sign-ins in the profile stay. Google cookies are never imported
//! (Google ties its sign-ins to the browser they were made in).
//!
//! Secrets: cookie values and the browser's "Safe Storage" key stay in memory, are never logged
//! and go only into the chosen profile's WebKit data store (the same store
//! `super::profile_store` gives its tabs). The source database is read from a private temporary
//! copy (the browser keeps it locked while it runs), removed when the import ends.
// Reading and writing the cookie stores is macOS only (WebKit data stores per profile); the
// parsing and policy below are shared and tested everywhere.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::collections::BTreeSet;
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::AppHandle;

// ---- sources ----------------------------------------------------------------------------------

/// A Chromium browser Orca imports from (its CHROMIUM_BROWSERS, Chrome and Edge here).
struct Chromium {
  id: &'static str,
  label: &'static str,
  keychain_service: &'static str,
  keychain_account: &'static str,
  /// Under ~/Library/Application Support.
  mac_root: &'static str,
}

const CHROMIUM: [Chromium; 2] = [
  Chromium { id: "chrome", label: "Google Chrome", keychain_service: "Chrome Safe Storage", keychain_account: "Chrome", mac_root: "Google/Chrome" },
  Chromium { id: "edge", label: "Microsoft Edge", keychain_service: "Microsoft Edge Safe Storage", keychain_account: "Microsoft Edge", mac_root: "Microsoft Edge" },
];

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct BrowserProfile {
  pub name: String,
  pub directory: String,
}

#[derive(Serialize, Debug)]
pub struct CookieSource {
  pub browser: &'static str,
  pub label: &'static str,
  pub profiles: Vec<BrowserProfile>,
}

fn browser_root(b: &Chromium) -> Option<PathBuf> {
  let home = std::env::var_os("HOME")?;
  Some(PathBuf::from(home).join("Library/Application Support").join(b.mac_root))
}

/// A profile directory name from the browser's own metadata becomes a path segment: no separators.
fn safe_profile_directory(d: &str) -> bool {
  !d.is_empty() && d != "." && !d.contains(['\0', '/', '\\']) && !d.contains("..")
}

/// Chromium 96+ keeps Network/Cookies; older profiles keep Cookies at the profile root.
fn cookies_db(profile_dir: &Path) -> Option<PathBuf> {
  [profile_dir.join("Network").join("Cookies"), profile_dir.join("Cookies")].into_iter().find(|p| p.is_file())
}

/// The browser's profiles (Local State's info_cache: directory and display name), Default first.
fn discover_profiles(root: &Path) -> Vec<BrowserProfile> {
  let fallback = || vec![BrowserProfile { name: "Default".into(), directory: "Default".into() }];
  let Ok(text) = std::fs::read_to_string(root.join("Local State")) else { return fallback() };
  let Ok(state) = serde_json::from_str::<Value>(&text) else { return fallback() };
  let Some(cache) = state.pointer("/profile/info_cache").and_then(Value::as_object) else { return fallback() };
  let mut out: Vec<BrowserProfile> = cache
    .iter()
    .filter(|(dir, _)| safe_profile_directory(dir))
    .map(|(dir, info)| BrowserProfile { name: info.get("name").and_then(Value::as_str).unwrap_or(dir).to_owned(), directory: dir.clone() })
    .collect();
  out.sort_by_key(|p| p.directory != "Default");
  if out.is_empty() {
    fallback()
  } else {
    out
  }
}

fn detect_sources() -> Vec<CookieSource> {
  if !cfg!(target_os = "macos") {
    return Vec::new();
  }
  CHROMIUM
    .iter()
    .filter_map(|b| {
      let root = browser_root(b)?;
      let profiles: Vec<BrowserProfile> = discover_profiles(&root).into_iter().filter(|p| cookies_db(&root.join(&p.directory)).is_some()).collect();
      (!profiles.is_empty()).then_some(CookieSource { browser: b.id, label: b.label, profiles })
    })
    .collect()
}

// ---- results ----------------------------------------------------------------------------------

/// Why an import did nothing: a code the UI translates (Orca's BROWSER_COOKIE_IMPORT_FAILURE_COPY).
#[derive(Serialize, Debug, PartialEq)]
pub struct Failure {
  pub code: &'static str,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub browser: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub profile: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub count: Option<usize>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub detail: Option<String>,
}

impl Failure {
  fn new(code: &'static str) -> Self {
    Failure { code, browser: None, profile: None, count: None, detail: None }
  }
  fn browser(code: &'static str, browser: &str) -> Self {
    Failure { browser: Some(browser.to_owned()), ..Failure::new(code) }
  }
}

/// What an import did. `skipped` counts cookies left out for other reasons than the ones named.
#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
  pub total: usize,
  pub imported: usize,
  pub skipped: usize,
  pub google_skipped: usize,
  pub partition_skipped: usize,
  pub undecryptable: usize,
  /// Cookies of the imported domains that were in the profile before and were replaced.
  pub replaced: usize,
  pub domains: usize,
}

// ---- cookies and policy -----------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SameSite {
  Unspecified,
  NoRestriction,
  Lax,
  Strict,
}

/// 0=None, 1=Lax, 2=Strict; Chromium's -1 and anything else is unspecified.
fn db_same_site(raw: i64) -> SameSite {
  match raw {
    0 => SameSite::NoRestriction,
    1 => SameSite::Lax,
    2 => SameSite::Strict,
    _ => SameSite::Unspecified,
  }
}

/// A decrypted cookie on its way into the profile. Its value never appears in Debug output.
#[derive(Clone, PartialEq)]
pub struct ImportCookie {
  pub name: String,
  pub value: String,
  /// As the source has it: a leading dot is a domain cookie, none a host-only cookie.
  pub domain: String,
  pub path: String,
  pub secure: bool,
  pub http_only: bool,
  pub same_site: SameSite,
  /// Unix seconds; None is a session cookie.
  pub expires: Option<f64>,
}

impl fmt::Debug for ImportCookie {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.debug_struct("ImportCookie").field("name", &self.name).field("domain", &self.domain).field("path", &self.path).field("value", &"<redacted>").finish()
  }
}

impl ImportCookie {
  /// `__Host-` cookies are host-only at `/` whatever the source says.
  fn host_only(&self) -> bool {
    self.name.starts_with("__Host-") || !self.domain.starts_with('.')
  }
  /// The NSHTTPCookie domain: `.example.com` for a domain cookie, `example.com` for host-only.
  fn store_domain(&self) -> Option<String> {
    let d = normalize_domain(&self.domain)?;
    Some(if self.host_only() { d } else { format!(".{d}") })
  }
  fn store_path(&self) -> &str {
    if self.name.starts_with("__Host-") || self.path.is_empty() {
      "/"
    } else {
      &self.path
    }
  }
}

/// Lowercase host without leading dots, or None for anything that is not a plain host name.
pub fn normalize_domain(domain: &str) -> Option<String> {
  let d = domain.trim().trim_start_matches('.').to_ascii_lowercase();
  let bracketed = d.starts_with('[') && d.ends_with(']');
  if d.is_empty() || !d.is_ascii() || d.contains(['/', '\\', '@', '?', '#', '%', ' ']) || (!bracketed && d.contains(':')) || d.ends_with('.') || d.contains("..") {
    return None;
  }
  Some(d)
}

fn is_google_domain(domain: &str) -> bool {
  normalize_domain(domain).is_some_and(|d| d == "google.com" || d.ends_with(".google.com"))
}

/// Google sign-ins are not imported (Orca's isNonTransplantableCookieDomain, which also covers its
/// source-bound SIDCC / __Secure-*PSIDCC / __Secure-STRP / AEC cookies): google.com and its
/// subdomains, whatever the name. YouTube stays eligible.
pub fn is_google_excluded(_name: &str, domain: &str) -> bool {
  is_google_domain(domain)
}

/// The domains an import replaces (Orca's importedDomainScope): exact hosts, their parents (for
/// domain cookies) and everything under them.
#[derive(Debug, Default, Clone)]
pub struct Scope {
  exact: BTreeSet<String>,
  ancestors: BTreeSet<String>,
  descendant_roots: BTreeSet<String>,
}

fn suffixes(domain: &str) -> impl Iterator<Item = &str> {
  std::iter::once(domain).chain(domain.match_indices('.').map(move |(i, _)| &domain[i + 1..]))
}

impl Scope {
  pub fn of<'a>(domains: impl IntoIterator<Item = &'a str>) -> Scope {
    let mut s = Scope::default();
    for d in domains.into_iter().filter_map(normalize_domain) {
      if !s.exact.insert(d.clone()) {
        continue;
      }
      if d.contains('.') {
        s.descendant_roots.insert(d.clone());
      }
      // Orca stops at the registrable domain (public suffix list); without one, every parent
      // with a dot. A cookie can't be set on a public suffix, so the extra parents match nothing.
      for p in suffixes(&d).filter(|p| p.contains('.')) {
        s.ancestors.insert(p.to_owned());
      }
    }
    s
  }

  pub fn contains(&self, domain: &str, host_only: bool) -> bool {
    self.exact.contains(domain) || (!host_only && self.ancestors.contains(domain)) || suffixes(domain).any(|p| self.descendant_roots.contains(p))
  }

  /// Whether a cookie already in the profile (its NSHTTPCookie domain) is replaced by the import.
  /// Google cookies are never touched.
  pub fn replaces(&self, store_domain: &str) -> bool {
    if is_google_domain(store_domain) {
      return false;
    }
    normalize_domain(store_domain).is_some_and(|d| self.contains(&d, !store_domain.starts_with('.')))
  }
}

fn now_secs() -> f64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

/// What survives the policy, and the counts of what did not.
#[derive(Debug, Default)]
struct Planned {
  cookies: Vec<ImportCookie>,
  google: usize,
  partition: usize,
  undecryptable: usize,
  other: usize,
}

impl Planned {
  /// Policy shared by every source: a usable domain, not Google, not expired.
  fn admit(&mut self, c: ImportCookie, now: f64) {
    if is_google_excluded(&c.name, &c.domain) {
      self.google += 1;
    } else if c.name.trim().is_empty() || normalize_domain(&c.domain).is_none() || c.expires.is_some_and(|e| e <= now) {
      self.other += 1;
    } else {
      self.cookies.push(c);
    }
  }
}

// ---- Chromium decryption ----------------------------------------------------------------------

/// PBKDF2-HMAC-SHA1, 16 bytes (Chromium's os_crypt key derivation on macOS and Linux).
fn pbkdf2_sha1_16(password: &[u8], salt: &[u8], iterations: u32) -> [u8; 16] {
  use hmac::{KeyInit, Mac};
  type H = hmac::Hmac<sha1::Sha1>;
  let mac = |data: &[&[u8]]| {
    let mut m = <H as KeyInit>::new_from_slice(password).expect("HMAC takes any key length");
    for d in data {
      m.update(d);
    }
    m.finalize().into_bytes()
  };
  let mut u = mac(&[salt, &1u32.to_be_bytes()]);
  let mut t = u;
  for _ in 1..iterations {
    u = mac(&[&u]);
    t.iter_mut().zip(u.iter()).for_each(|(a, b)| *a ^= b);
  }
  let mut out = [0u8; 16];
  out.copy_from_slice(&t[..16]);
  out
}

/// The macOS cookie key from the browser's "Safe Storage" Keychain password (Orca's getMacEncryptionKey).
fn mac_key(password: &str) -> [u8; 16] {
  pbkdf2_sha1_16(password.as_bytes(), b"saltysalt", 1003)
}

/// AES-128-CBC with Chromium's IV of 16 spaces and PKCS#7 padding.
fn aes128_cbc_decrypt(key: &[u8; 16], data: &[u8]) -> Option<Vec<u8>> {
  use aes::cipher::{BlockCipherDecrypt, KeyInit};
  if data.is_empty() || !data.len().is_multiple_of(16) {
    return None;
  }
  let cipher = aes::Aes128::new_from_slice(key).ok()?;
  let mut prev = [b' '; 16];
  let mut out = Vec::with_capacity(data.len());
  for chunk in data.chunks(16) {
    let mut block = aes::Block::default();
    block.copy_from_slice(chunk);
    cipher.decrypt_block(&mut block);
    out.extend(block.iter().zip(prev.iter()).map(|(a, b)| a ^ b));
    prev.copy_from_slice(chunk);
  }
  let pad = *out.last()? as usize;
  if pad == 0 || pad > 16 || out[out.len() - pad..].iter().any(|&b| b as usize != pad) {
    return None;
  }
  out.truncate(out.len() - pad);
  Some(out)
}

const HASH_PREFIX: usize = 32;

/// Cookies DB schema 24+ prefixes the plaintext with SHA-256(host_key); older builds may carry a
/// 32-byte binary prefix too (Orca's heuristic: 8+ unprintable bytes in it).
fn strip_hash_prefix(plain: Vec<u8>, host_key: &str) -> Vec<u8> {
  use sha2::{Digest, Sha256};
  let exact = plain.len() >= HASH_PREFIX && plain[..HASH_PREFIX] == Sha256::digest(host_key.as_bytes())[..];
  let binary = plain.len() > HASH_PREFIX && plain[..HASH_PREFIX].iter().filter(|&&b| !(0x20..=0x7e).contains(&b)).count() >= 8;
  if exact || binary {
    plain[HASH_PREFIX..].to_vec()
  } else {
    plain
  }
}

/// A `v10` value (the only version macOS Chromium writes); anything else is undecryptable.
fn decrypt_value(encrypted: &[u8], key: &[u8; 16], host_key: &str) -> Option<Vec<u8>> {
  let body = encrypted.strip_prefix(b"v10")?;
  aes128_cbc_decrypt(key, body).map(|p| strip_hash_prefix(p, host_key))
}

/// Raw bytes as a string, byte for byte (Orca keeps Chromium values as latin1).
fn latin1(bytes: &[u8]) -> String {
  bytes.iter().map(|&b| b as char).collect()
}

/// Chromium's microseconds since 1601 to Unix seconds; 0 is a session cookie.
fn chromium_time(ts: i64) -> Option<f64> {
  (ts > 0).then(|| (ts / 1_000_000 - 11_644_473_600).max(0) as f64)
}

/// A row of Chromium's `cookies` table.
#[derive(Default)]
struct Row {
  host_key: String,
  name: String,
  value: Vec<u8>,
  encrypted: Vec<u8>,
  path: String,
  expires_utc: i64,
  secure: bool,
  http_only: bool,
  same_site: i64,
  /// A CHIPS cookie (top_frame_site_key): WebKit's cookie API cannot keep its partition, and
  /// Orca never widens one into an unpartitioned cookie, so it is skipped.
  partitioned: bool,
}

fn needs_key(rows: &[Row]) -> bool {
  rows.iter().any(|r| !r.encrypted.is_empty() && !is_google_excluded(&r.name, &r.host_key))
}

fn plan_rows(rows: Vec<Row>, key: Option<&[u8; 16]>, now: f64) -> Planned {
  let mut p = Planned::default();
  for r in rows {
    if is_google_excluded(&r.name, &r.host_key) {
      p.google += 1;
      continue;
    }
    let value = if r.encrypted.is_empty() {
      latin1(&r.value)
    } else {
      match key.and_then(|k| decrypt_value(&r.encrypted, k, &r.host_key)) {
        Some(v) => latin1(&v),
        None => {
          p.undecryptable += 1;
          continue;
        }
      }
    };
    if r.partitioned {
      p.partition += 1;
      continue;
    }
    let c = ImportCookie { name: r.name, value, domain: r.host_key, path: r.path, secure: r.secure, http_only: r.http_only, same_site: db_same_site(r.same_site), expires: chromium_time(r.expires_utc) };
    p.admit(c, now);
  }
  p
}

// ---- reading the source database --------------------------------------------------------------

/// A private copy of the browser's cookie database (and its WAL), removed on drop.
struct Snapshot {
  dir: PathBuf,
  db: PathBuf,
}

impl Drop for Snapshot {
  fn drop(&mut self) {
    let _ = std::fs::remove_dir_all(&self.dir);
  }
}

#[derive(PartialEq, Debug)]
struct FileState(u64, Option<SystemTime>);

fn file_state(p: &Path) -> Option<FileState> {
  std::fs::metadata(p).ok().map(|m| FileState(m.len(), m.modified().ok()))
}

enum SnapshotError {
  Denied,
  Failed,
}

/// Copies the database and its WAL until a copy is taken while neither changed (Orca's
/// createChromiumCookieSnapshot): cookies may live only in the WAL while the browser runs.
fn snapshot(source: &Path, temp_root: &Path) -> Result<Snapshot, SnapshotError> {
  let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
  let dir = temp_root.join(format!("kingu-cookie-import-{}-{nanos}", std::process::id()));
  std::fs::create_dir(&dir).map_err(|_| SnapshotError::Failed)?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
  }
  let snap = Snapshot { db: dir.join("Cookies"), dir };
  let wal = PathBuf::from(format!("{}-wal", source.display()));
  let snap_wal = PathBuf::from(format!("{}-wal", snap.db.display()));
  for _ in 0..5 {
    let (db_before, wal_before) = (file_state(source), file_state(&wal));
    if db_before.is_none() {
      return Err(SnapshotError::Failed);
    }
    let _ = std::fs::remove_file(&snap_wal);
    if let Err(e) = std::fs::copy(source, &snap.db) {
      return Err(if e.kind() == std::io::ErrorKind::PermissionDenied { SnapshotError::Denied } else { SnapshotError::Failed });
    }
    if wal_before.is_some() && std::fs::copy(&wal, &snap_wal).is_err() {
      continue;
    }
    if file_state(source) == db_before && file_state(&wal) == wal_before {
      return Ok(snap);
    }
  }
  Err(SnapshotError::Failed)
}

fn sqlite_json(db: &Path, sql: &str) -> Option<Vec<Map<String, Value>>> {
  // The private copy, not the browser's file: no -readonly, so SQLite can read its WAL.
  let out = Command::new(crate::accounts::managed::SQLITE).args(["-json", "-cmd", ".timeout 1500"]).arg(db).arg(sql).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
  if !out.status.success() {
    return None;
  }
  let text = String::from_utf8_lossy(&out.stdout);
  if text.trim().is_empty() {
    return Some(Vec::new());
  }
  serde_json::from_str(&text).ok()
}

fn hex_bytes(v: Option<&Value>) -> Vec<u8> {
  let s = v.and_then(Value::as_str).unwrap_or("");
  (0..s.len() / 2).filter_map(|i| u8::from_str_radix(s.get(2 * i..2 * i + 2)?, 16).ok()).collect()
}

fn read_rows(db: &Path) -> Option<Vec<Row>> {
  let columns: BTreeSet<String> = sqlite_json(db, "SELECT name FROM pragma_table_info('cookies')")?.into_iter().filter_map(|r| r.get("name").and_then(Value::as_str).map(str::to_owned)).collect();
  if !columns.contains("host_key") || !columns.contains("encrypted_value") {
    return None;
  }
  let same_site = if columns.contains("samesite") { "samesite" } else { "-1" };
  let partition = if columns.contains("top_frame_site_key") { "top_frame_site_key" } else { "''" };
  let sql = format!(
    "SELECT host_key AS d, name AS n, hex(value) AS v, hex(encrypted_value) AS e, path AS p, expires_utc AS x, is_secure AS s, is_httponly AS h, {same_site} AS ss, ({partition} IS NOT NULL AND {partition} != '') AS pk FROM cookies ORDER BY rowid"
  );
  let str_of = |r: &Map<String, Value>, k: &str| r.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
  let int_of = |r: &Map<String, Value>, k: &str| r.get(k).and_then(Value::as_i64).unwrap_or(0);
  Some(
    sqlite_json(db, &sql)?
      .into_iter()
      .map(|r| Row {
        host_key: str_of(&r, "d"),
        name: str_of(&r, "n"),
        value: hex_bytes(r.get("v")),
        encrypted: hex_bytes(r.get("e")),
        path: str_of(&r, "p"),
        expires_utc: int_of(&r, "x"),
        secure: int_of(&r, "s") == 1,
        http_only: int_of(&r, "h") == 1,
        same_site: r.get("ss").and_then(Value::as_i64).unwrap_or(-1),
        partitioned: int_of(&r, "pk") == 1,
      })
      .collect(),
  )
}

/// The browser's Safe Storage password from the login Keychain (macOS asks the user first).
fn keychain_password(service: &str, account: &str) -> Option<String> {
  let mut child = Command::new("/usr/bin/security").args(["find-generic-password", "-s", service, "-a", account, "-w"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
  // Room for the user to answer the Keychain prompt (Orca waits 30 s).
  let deadline = Instant::now() + Duration::from_secs(90);
  loop {
    match child.try_wait() {
      Ok(Some(status)) => {
        let mut out = String::new();
        std::io::Read::read_to_string(&mut child.stdout.take()?, &mut out).ok()?;
        let pw = out.trim_end_matches(['\n', '\r']).to_owned();
        return (status.success() && !pw.is_empty()).then_some(pw);
      }
      Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
      _ => {
        let _ = child.kill();
        let _ = child.wait();
        return None;
      }
    }
  }
}

fn plan_browser(browser: &str, directory: Option<&str>) -> Result<(Planned, usize), Failure> {
  let b = CHROMIUM.iter().find(|b| b.id == browser).ok_or_else(|| Failure::new("browserNotFound"))?;
  let root = browser_root(b).filter(|r| r.is_dir()).ok_or_else(|| Failure::new("browserNotFound"))?;
  let directory = directory.unwrap_or("Default");
  if !safe_profile_directory(directory) {
    return Err(Failure::new("invalidBrowserProfile"));
  }
  let db = cookies_db(&root.join(directory)).ok_or_else(|| Failure { profile: Some(directory.to_owned()), ..Failure::new("browserProfileDatabaseMissing") })?;
  let snap = snapshot(&db, &std::env::temp_dir()).map_err(|e| match e {
    SnapshotError::Denied => Failure::browser("macFullDiskAccess", b.label),
    SnapshotError::Failed => Failure::browser("databaseCopyFailed", b.label),
  })?;
  let rows = read_rows(&snap.db).ok_or_else(|| Failure::browser("readFailed", b.label))?;
  drop(snap);
  if rows.is_empty() {
    return Err(Failure::browser("noCookies", b.label));
  }
  let total = rows.len();
  let key = if needs_key(&rows) {
    let pw = keychain_password(b.keychain_service, b.keychain_account).ok_or_else(|| Failure::browser("encryptionKeyDenied", b.label))?;
    Some(mac_key(&pw))
  } else {
    None
  };
  Ok((plan_rows(rows, key.as_ref(), now_secs()), total))
}

// ---- cookie files -----------------------------------------------------------------------------

fn file_same_site(v: Option<&Value>) -> SameSite {
  match v {
    Some(Value::Number(n)) => db_same_site(n.as_i64().unwrap_or(-1)),
    Some(Value::String(s)) => match s.to_ascii_lowercase().as_str() {
      "lax" => SameSite::Lax,
      "strict" => SameSite::Strict,
      "none" | "no_restriction" => SameSite::NoRestriction,
      _ => SameSite::Unspecified,
    },
    _ => SameSite::Unspecified,
  }
}

fn truthy(v: Option<&Value>) -> bool {
  matches!(v, Some(Value::Bool(true))) || v.and_then(Value::as_i64) == Some(1)
}

/// One entry of a cookie file (Orca's validateCookieEntry): None when a field is missing or invalid.
fn file_entry(e: &Map<String, Value>) -> Option<(ImportCookie, bool)> {
  let domain = e.get("domain")?.as_str()?.trim();
  let name = e.get("name")?.as_str()?.trim();
  let value = e.get("value")?.as_str()?;
  if domain.is_empty() || name.is_empty() || normalize_domain(domain).is_none() {
    return None;
  }
  let partitioned = e.get("partitionKey").is_some_and(|p| !p.is_null());
  let c = ImportCookie {
    name: name.to_owned(),
    // Orca strips unprintable characters from file values before writing them.
    value: value.chars().filter(|c| (' '..='~').contains(c)).collect(),
    domain: domain.to_owned(),
    path: e.get("path").and_then(Value::as_str).unwrap_or("/").to_owned(),
    secure: truthy(e.get("secure")),
    http_only: truthy(e.get("httpOnly")),
    same_site: file_same_site(e.get("sameSite")),
    expires: e.get("expirationDate").and_then(Value::as_f64).filter(|&x| x > 0.0),
  };
  Some((c, partitioned))
}

/// A JSON array of cookie objects (Chrome-extension exports: domain, name, value, path, secure,
/// httpOnly, sameSite, expirationDate).
fn plan_file_text(text: &str, now: f64) -> Result<(Planned, usize), Failure> {
  let parsed: Value = serde_json::from_str(text).map_err(|_| Failure::new("fileInvalidJson"))?;
  let entries = parsed.as_array().ok_or_else(|| Failure::new("fileNotArray"))?;
  if entries.is_empty() {
    return Err(Failure::new("fileEmpty"));
  }
  let valid: Vec<(ImportCookie, bool)> = entries.iter().filter_map(|e| file_entry(e.as_object()?)).collect();
  if valid.is_empty() {
    return Err(Failure { count: Some(entries.len()), ..Failure::new("fileNoValidCookies") });
  }
  let mut p = Planned { other: entries.len() - valid.len(), ..Planned::default() };
  for (c, partitioned) in valid {
    if partitioned && !is_google_excluded(&c.name, &c.domain) {
      p.partition += 1;
    } else {
      p.admit(c, now);
    }
  }
  Ok((p, entries.len()))
}

fn plan_file(path: &str) -> Result<(Planned, usize), Failure> {
  let text = std::fs::read_to_string(path).map_err(|_| Failure::new("fileUnreadable"))?;
  plan_file_text(&text, now_secs())
}

// ---- writing into the profile -----------------------------------------------------------------

/// Which cookies the profile ends up with: the planned ones, and the scope they replace.
fn finish(planned: Planned, total: usize, write: impl FnOnce(Scope, Vec<ImportCookie>) -> Result<(usize, usize, usize), String>) -> Result<Summary, Failure> {
  let Planned { cookies, google, partition, undecryptable, other } = planned;
  let domains: BTreeSet<String> = cookies.iter().filter_map(|c| normalize_domain(&c.domain)).collect();
  let mut summary = Summary { total, google_skipped: google, partition_skipped: partition, undecryptable, skipped: other, ..Summary::default() };
  if cookies.is_empty() {
    return Ok(summary);
  }
  let scope = Scope::of(domains.iter().map(String::as_str));
  let (imported, rejected, replaced) = write(scope, cookies).map_err(|detail| Failure { detail: Some(detail), ..Failure::new("writeFailed") })?;
  summary.imported = imported;
  summary.skipped += rejected;
  summary.replaced = replaced;
  summary.domains = domains.len();
  Ok(summary)
}

#[cfg(target_os = "macos")]
mod webkit {
  //! The profile's WKWebsiteDataStore, chosen exactly as wry chooses a tab's store
  //! (`data_store_identifier` on macOS 14+, else the default store). wry's own `set_cookie`
  //! cannot be used: the cookie crate drops a domain cookie's leading dot, which would turn every
  //! domain cookie into a host-only one.
  use std::cell::{Cell, RefCell};
  use std::ptr::NonNull;
  use std::rc::Rc;
  use std::sync::mpsc;
  use std::time::Duration;

  use block2::RcBlock;
  use objc2::rc::Retained;
  use objc2::runtime::AnyObject;
  use objc2::MainThreadMarker;
  use objc2_foundation::{ns_string, NSArray, NSDate, NSHTTPCookie, NSHTTPCookieDomain, NSHTTPCookieExpires, NSHTTPCookieName, NSHTTPCookiePath, NSHTTPCookieSecure, NSHTTPCookieValue, NSHTTPCookieVersion, NSMutableDictionary, NSProcessInfo, NSString, NSUUID};
  use objc2_web_kit::{WKHTTPCookieStore, WKWebsiteDataStore};

  use super::{ImportCookie, SameSite, Scope};

  /// (imported, rejected, replaced)
  type Outcome = (usize, usize, usize);

  fn data_store(id: Option<[u8; 16]>, mtm: MainThreadMarker) -> Retained<WKWebsiteDataStore> {
    let custom = NSProcessInfo::processInfo().operatingSystemVersion().majorVersion >= 14;
    match id {
      // SAFETY: WebKit on the main thread (mtm); custom stores exist from macOS 14.
      Some(id) if custom => unsafe { WKWebsiteDataStore::dataStoreForIdentifier(&NSUUID::from_bytes(id), mtm) },
      _ => unsafe { WKWebsiteDataStore::defaultDataStore(mtm) },
    }
  }

  fn ns_cookie(c: &ImportCookie) -> Option<Retained<NSHTTPCookie>> {
    let domain = c.store_domain()?;
    let props = NSMutableDictionary::<NSString, AnyObject>::new();
    // SAFETY: the NSHTTPCookie* keys are Foundation's constant strings; values are NSString/NSDate
    // as NSHTTPCookie documents.
    unsafe {
      props.insert(NSHTTPCookieName, &*NSString::from_str(&c.name));
      props.insert(NSHTTPCookieValue, &*NSString::from_str(&c.value));
      props.insert(NSHTTPCookieDomain, &*NSString::from_str(&domain));
      props.insert(NSHTTPCookiePath, &*NSString::from_str(c.store_path()));
      props.insert(NSHTTPCookieVersion, ns_string!("0"));
      if let Some(e) = c.expires {
        props.insert(NSHTTPCookieExpires, &*NSDate::dateWithTimeIntervalSince1970(e));
      }
      // Present means set: only add the flags that are on.
      if c.secure {
        props.insert(NSHTTPCookieSecure, ns_string!("TRUE"));
      }
      if c.http_only {
        props.insert(ns_string!("HttpOnly"), ns_string!("TRUE"));
      }
      match c.same_site {
        SameSite::Lax => props.insert(ns_string!("SameSite"), ns_string!("lax")),
        SameSite::Strict => props.insert(ns_string!("SameSite"), ns_string!("strict")),
        SameSite::NoRestriction | SameSite::Unspecified => {}
      }
      NSHTTPCookie::cookieWithProperties(&props)
    }
  }

  /// Calls `then` once every one of `n` completion blocks ran (main thread only).
  fn countdown(n: usize, then: impl FnOnce() + 'static) -> impl Fn() + Clone + 'static {
    let left = Rc::new(Cell::new(n));
    let then = Rc::new(RefCell::new(Some(then)));
    move || {
      left.set(left.get().saturating_sub(1));
      let ready = if left.get() == 0 { then.borrow_mut().take() } else { None };
      if let Some(f) = ready {
        f();
      }
    }
  }

  fn set_all(jar: Retained<WKHTTPCookieStore>, cookies: Vec<ImportCookie>, replaced: usize, tx: mpsc::Sender<Outcome>) {
    let built: Vec<Option<Retained<NSHTTPCookie>>> = cookies.iter().map(ns_cookie).collect();
    drop(cookies);
    let rejected = built.iter().filter(|c| c.is_none()).count();
    let ok: Vec<Retained<NSHTTPCookie>> = built.into_iter().flatten().collect();
    let n = ok.len();
    if n == 0 {
      let _ = tx.send((0, rejected, replaced));
      return;
    }
    let done = countdown(n, move || {
      let _ = tx.send((n, rejected, replaced));
    });
    for c in &ok {
      let done = done.clone();
      // SAFETY: main thread; WebKit copies the block.
      unsafe { jar.setCookie_completionHandler(c, Some(&RcBlock::new(done))) };
    }
  }

  /// Deletes the profile's cookies of the imported domains, then sets the imported ones (in that
  /// order, so a late delete never removes a new cookie).
  pub fn replace(app: &tauri::AppHandle, store: Option<[u8; 16]>, scope: Scope, cookies: Vec<ImportCookie>) -> Result<Outcome, String> {
    let (tx, rx) = mpsc::channel::<Outcome>();
    app
      .run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else { return };
        // SAFETY: main thread.
        let jar = unsafe { data_store(store, mtm).httpCookieStore() };
        let pending = RefCell::new(Some((jar.clone(), scope, cookies, tx)));
        let got = RcBlock::new(move |all: NonNull<NSArray<NSHTTPCookie>>| {
          let Some((jar, scope, cookies, tx)) = pending.borrow_mut().take() else { return };
          // SAFETY: WebKit hands a valid array for the duration of the block.
          let all = unsafe { all.as_ref() };
          let doomed: Vec<Retained<NSHTTPCookie>> = all.iter().filter(|c| scope.replaces(&c.domain().to_string())).collect();
          let replaced = doomed.len();
          if replaced == 0 {
            return set_all(jar, cookies, 0, tx);
          }
          let next = jar.clone();
          let done = countdown(replaced, move || set_all(next, cookies, replaced, tx));
          for c in &doomed {
            let done = done.clone();
            // SAFETY: main thread; the cookie object came from this store.
            unsafe { jar.deleteCookie_completionHandler(c, Some(&RcBlock::new(done))) };
          }
        });
        // SAFETY: main thread; WebKit copies the block.
        unsafe { jar.getAllCookies(&got) };
      })
      .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(120)).map_err(|_| "the browser's cookie store did not answer".to_string())
  }
}

// ---- commands ---------------------------------------------------------------------------------

/// Where to import from: a Chromium browser's profile, or a JSON cookie file.
#[derive(Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ImportFrom {
  Browser { browser: String, directory: Option<String> },
  File { path: String },
}

/// Chrome and Edge, with their profiles that have a cookie database (macOS; empty elsewhere).
#[tauri::command]
pub async fn browser_cookie_sources() -> Vec<CookieSource> {
  tauri::async_runtime::spawn_blocking(detect_sources).await.unwrap_or_default()
}

/// Imports cookies into the Kingu browser profile `profile` ("" is the shared default store).
#[tauri::command]
pub async fn browser_cookie_import(app: AppHandle, profile: String, from: ImportFrom) -> Result<Summary, Failure> {
  tauri::async_runtime::spawn_blocking(move || import(&app, &profile, from)).await.map_err(|e| Failure { detail: Some(e.to_string()), ..Failure::new("writeFailed") })?
}

#[cfg(target_os = "macos")]
fn import(app: &AppHandle, profile: &str, from: ImportFrom) -> Result<Summary, Failure> {
  let (planned, total) = match &from {
    ImportFrom::Browser { browser, directory } => plan_browser(browser, directory.as_deref())?,
    ImportFrom::File { path } => plan_file(path)?,
  };
  let store = super::profile_store(profile);
  finish(planned, total, |scope, cookies| webkit::replace(app, store, scope, cookies))
}

#[cfg(not(target_os = "macos"))]
fn import(_app: &AppHandle, _profile: &str, _from: ImportFrom) -> Result<Summary, Failure> {
  Err(Failure::new("unsupported"))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
  }

  fn aes128_cbc_encrypt(key: &[u8; 16], plain: &[u8]) -> Vec<u8> {
    use aes::cipher::{BlockCipherEncrypt, KeyInit};
    let cipher = aes::Aes128::new_from_slice(key).unwrap();
    let pad = 16 - plain.len() % 16;
    let mut data = plain.to_vec();
    data.extend(std::iter::repeat_n(pad as u8, pad));
    let mut prev = [b' '; 16];
    let mut out = Vec::new();
    for chunk in data.chunks(16) {
      let mut block = aes::Block::default();
      for (i, b) in block.iter_mut().enumerate() {
        *b = chunk[i] ^ prev[i];
      }
      cipher.encrypt_block(&mut block);
      prev.copy_from_slice(&block);
      out.extend_from_slice(&block);
    }
    out
  }

  fn v10(key: &[u8; 16], host: Option<&str>, value: &[u8]) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    let mut plain = host.map(|h| Sha256::digest(h.as_bytes()).to_vec()).unwrap_or_default();
    plain.extend_from_slice(value);
    let mut out = b"v10".to_vec();
    out.extend(aes128_cbc_encrypt(key, &plain));
    out
  }

  fn row(host: &str, name: &str, encrypted: Vec<u8>) -> Row {
    Row { host_key: host.into(), name: name.into(), encrypted, path: "/".into(), ..Row::default() }
  }

  #[test]
  fn pbkdf2_matches_rfc6070() {
    assert_eq!(hex(&pbkdf2_sha1_16(b"password", b"salt", 1)), "0c60c80f961f0e71f3a9b524af601206");
    assert_eq!(hex(&pbkdf2_sha1_16(b"password", b"salt", 2)), "ea6c014dc72d6f8ccd1ed92ace1d41f0");
    assert_eq!(hex(&pbkdf2_sha1_16(b"password", b"salt", 4096)), "4b007901b765489abead49d926f721d0");
  }

  #[test]
  fn decrypts_v10_with_and_without_the_host_hash() {
    let key = mac_key("test-safe-storage-password");
    assert_eq!(decrypt_value(&v10(&key, Some(".example.com"), b"session-abc"), &key, ".example.com").unwrap(), b"session-abc");
    assert_eq!(decrypt_value(&v10(&key, None, b"plain"), &key, "example.com").unwrap(), b"plain");
    // An empty value under the host hash is still exact.
    assert_eq!(decrypt_value(&v10(&key, Some("a.test"), b""), &key, "a.test").unwrap(), b"");
    let wrong = mac_key("another-password");
    assert_eq!(decrypt_value(&v10(&key, None, b"0123456789abcdef-value"), &wrong, "example.com"), None);
    assert_eq!(decrypt_value(b"v20abcdefabcdefabcdef", &key, "example.com"), None);
    assert_eq!(decrypt_value(b"v10", &key, "example.com"), None);
  }

  #[test]
  fn google_cookies_are_never_imported() {
    assert!(is_google_excluded("SID", ".google.com"));
    assert!(is_google_excluded("NID", "accounts.google.com"));
    assert!(is_google_excluded("SIDCC", ".google.com"));
    assert!(!is_google_excluded("SID", ".youtube.com"));
    assert!(!is_google_excluded("SIDCC", ".notgoogle.com"));
    assert!(!is_google_excluded("x", "google.com.evil.test"));
  }

  #[test]
  fn plans_rows_and_counts_what_is_left_out() {
    let key = mac_key("pw");
    let now = 1_800_000_000.0;
    let future = (1_900_000_000i64 + 11_644_473_600) * 1_000_000;
    let past = (1_700_000_000i64 + 11_644_473_600) * 1_000_000;
    let mut kept = row(".github.com", "user_session", v10(&key, Some(".github.com"), b"s3cret"));
    kept.expires_utc = future;
    kept.secure = true;
    kept.same_site = 1;
    let mut expired = row("example.com", "old", v10(&key, None, b"x"));
    expired.expires_utc = past;
    let mut plain = row("plain.test", "p", Vec::new());
    plain.value = b"visible".to_vec();
    let mut chips = row("embed.test", "c", v10(&key, None, b"y"));
    chips.partitioned = true;
    let rows = vec![kept, expired, plain, chips, row(".google.com", "SID", v10(&key, None, b"g")), row("bad.test", "u", b"v10garbage-garbage".to_vec())];
    assert!(needs_key(&rows));
    let p = plan_rows(rows, Some(&key), now);
    assert_eq!((p.google, p.partition, p.undecryptable, p.other), (1, 1, 1, 1));
    assert_eq!(p.cookies.len(), 2);
    let c = &p.cookies[0];
    assert_eq!((c.name.as_str(), c.value.as_str(), c.domain.as_str(), c.secure, c.same_site), ("user_session", "s3cret", ".github.com", true, SameSite::Lax));
    assert_eq!(c.expires, Some(1_900_000_000.0));
    assert_eq!((p.cookies[1].value.as_str(), p.cookies[1].expires), ("visible", None));
    assert!(!format!("{c:?}").contains("s3cret"));
    // Without a key every encrypted cookie is undecryptable, nothing else changes.
    assert_eq!(plan_rows(vec![row("a.test", "n", v10(&key, None, b"v"))], None, now).undecryptable, 1);
    assert!(!needs_key(&[row(".google.com", "SID", b"v10x".to_vec())]));
  }

  #[test]
  fn replaces_only_the_imported_domains() {
    let s = Scope::of(["a.example.com", ".shop.test", "localhost"]);
    // Exact host, its domain-cookie parents and its subdomains.
    assert!(s.replaces("a.example.com"));
    assert!(s.replaces(".a.example.com"));
    assert!(s.replaces(".example.com"));
    assert!(s.replaces("x.a.example.com"));
    assert!(s.replaces("shop.test"));
    assert!(s.replaces("cart.shop.test"));
    assert!(s.replaces("localhost"));
    // A host-only cookie of a parent, a sibling and other sites stay.
    assert!(!s.replaces("example.com"));
    assert!(!s.replaces("b.example.com"));
    assert!(!s.replaces(".other.com"));
    assert!(!s.replaces("localhost.other"));
    // Google cookies are never touched.
    assert!(!Scope::of(["google.com"]).replaces(".google.com"));
    assert!(Scope::of(std::iter::empty()).exact.is_empty());
  }

  #[test]
  fn cookie_domain_and_path_in_the_store() {
    let c = |name: &str, domain: &str, path: &str| ImportCookie { name: name.into(), value: String::new(), domain: domain.into(), path: path.into(), secure: true, http_only: false, same_site: SameSite::Unspecified, expires: None };
    assert_eq!(c("a", ".Example.com", "/x").store_domain().as_deref(), Some(".example.com"));
    assert_eq!(c("a", "example.com", "/x").store_domain().as_deref(), Some("example.com"));
    assert_eq!(c("__Host-id", ".example.com", "/x").store_domain().as_deref(), Some("example.com"));
    assert_eq!(c("__Host-id", ".example.com", "/x").store_path(), "/");
    assert_eq!(c("a", "exa mple.com", "/").store_domain(), None);
    assert_eq!(normalize_domain("..a.com"), Some("a.com".into()));
    assert_eq!(normalize_domain("a.com:443"), None);
    assert_eq!(normalize_domain("a..com"), None);
    assert_eq!(normalize_domain("[::1]"), Some("[::1]".into()));
  }

  #[test]
  fn cookie_files_follow_orcas_rules() {
    let now = 1_800_000_000.0;
    assert_eq!(plan_file_text("nope", now).unwrap_err().code, "fileInvalidJson");
    assert_eq!(plan_file_text("{}", now).unwrap_err().code, "fileNotArray");
    assert_eq!(plan_file_text("[]", now).unwrap_err().code, "fileEmpty");
    let none = plan_file_text(r#"[{"name":"a"},{"domain":"x.com","name":" ","value":"v"}]"#, now).unwrap_err();
    assert_eq!((none.code, none.count), ("fileNoValidCookies", Some(2)));
    let text = r#"[
      {"domain":".site.test","name":"sid","value":"ab\u0007c","secure":true,"httpOnly":1,"sameSite":"strict","expirationDate":1900000000.5},
      {"domain":"site.test","name":"host","value":"v","path":"/app"},
      {"domain":".google.com","name":"SID","value":"g"},
      {"domain":"old.test","name":"o","value":"v","expirationDate":1000},
      {"domain":"chips.test","name":"c","value":"v","partitionKey":{"topLevelSite":"https://a.test"}},
      {"domain":"x.test","name":"n"},
      7
    ]"#;
    let (p, total) = plan_file_text(text, now).unwrap();
    assert_eq!(total, 7);
    assert_eq!((p.google, p.partition, p.other, p.cookies.len()), (1, 1, 3, 2));
    let sid = &p.cookies[0];
    assert_eq!((sid.value.as_str(), sid.secure, sid.http_only, sid.same_site, sid.expires), ("abc", true, true, SameSite::Strict, Some(1_900_000_000.5)));
    assert_eq!((p.cookies[1].path.as_str(), p.cookies[1].host_only()), ("/app", true));
  }

  #[test]
  fn finish_scopes_the_write_to_the_imported_domains() {
    let (p, total) = plan_file_text(r#"[{"domain":".a.test","name":"x","value":"1"},{"domain":"b.a.test","name":"y","value":"2"},{"domain":".google.com","name":"SID","value":"g"}]"#, 0.0).unwrap();
    let s = finish(p, total, |scope, cookies| {
      assert!(scope.replaces(".a.test") && !scope.replaces(".google.com") && !scope.replaces("c.test"));
      Ok((cookies.len(), 0, 4))
    })
    .unwrap();
    assert_eq!(s, Summary { total: 3, imported: 2, skipped: 0, google_skipped: 1, partition_skipped: 0, undecryptable: 0, replaced: 4, domains: 2 });
    // Nothing to write: the store is not touched.
    let (p, total) = plan_file_text(r#"[{"domain":".google.com","name":"SID","value":"g"}]"#, 0.0).unwrap();
    assert_eq!(finish(p, total, |_, _| panic!("no write")).unwrap().google_skipped, 1);
    let (p, total) = plan_file_text(r#"[{"domain":"a.test","name":"x","value":"1"}]"#, 0.0).unwrap();
    assert_eq!(finish(p, total, |_, _| Err("boom".into())).unwrap_err().code, "writeFailed");
  }

  #[test]
  fn profiles_come_from_local_state() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(discover_profiles(dir.path()), vec![BrowserProfile { name: "Default".into(), directory: "Default".into() }]);
    std::fs::write(dir.path().join("Local State"), r#"{"profile":{"info_cache":{"Profile 1":{"name":"Work"},"Default":{"name":"Me"},"../x":{"name":"evil"}}}}"#).unwrap();
    let p = discover_profiles(dir.path());
    assert_eq!(p.iter().map(|p| (p.directory.as_str(), p.name.as_str())).collect::<Vec<_>>(), vec![("Default", "Me"), ("Profile 1", "Work")]);
    std::fs::create_dir_all(dir.path().join("Default/Network")).unwrap();
    std::fs::write(dir.path().join("Default/Network/Cookies"), b"").unwrap();
    assert!(cookies_db(&dir.path().join("Default")).unwrap().ends_with("Network/Cookies"));
    assert!(!safe_profile_directory("a/b") && !safe_profile_directory("..") && safe_profile_directory("Profile 2"));
  }

  /// A Chromium-shaped cookie database (WAL mode, rows still in the WAL), read from a copy that is
  /// removed afterwards.
  #[cfg(target_os = "macos")]
  #[test]
  fn reads_a_chromium_database_through_a_private_copy() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("Cookies");
    let key = mac_key("fixture");
    let enc = hex(&v10(&key, Some(".fixture.test"), b"token-1"));
    let sql = format!(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE cookies (creation_utc INTEGER, host_key TEXT, top_frame_site_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER);
       INSERT INTO cookies VALUES (1, '.fixture.test', '', 'sid', '', X'{enc}', '/', 0, 1, 1, 2), (2, 'chips.test', 'https://top.test', 'c', 'v', X'', '/', 0, 1, 0, -1), (3, 'plain.test', NULL, 'p', 'hello', X'', '/', 0, 0, 0, 0);"
    );
    // Keep a writer open so the rows stay in the WAL while the snapshot is taken.
    let mut writer = Command::new(crate::accounts::managed::SQLITE).arg(&db).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    {
      use std::io::Write;
      let stdin = writer.stdin.as_mut().unwrap();
      writeln!(stdin, "{sql}").unwrap();
      stdin.flush().unwrap();
    }
    let wal = dir.path().join("Cookies-wal");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !(wal.exists() && std::fs::metadata(&wal).unwrap().len() > 0) && Instant::now() < deadline {
      std::thread::sleep(Duration::from_millis(20));
    }
    let temp = tempfile::tempdir().unwrap();
    let snap = snapshot(&db, temp.path()).ok().unwrap();
    let copy_dir = snap.dir.clone();
    let rows = read_rows(&snap.db).unwrap();
    drop(snap);
    assert!(!copy_dir.exists());
    drop(writer.stdin.take());
    let _ = writer.wait();
    assert_eq!(rows.len(), 3);
    let p = plan_rows(rows, Some(&key), now_secs());
    assert_eq!(p.partition, 1);
    assert_eq!(p.cookies.iter().map(|c| (c.name.as_str(), c.value.as_str(), c.same_site)).collect::<Vec<_>>(), vec![("sid", "token-1", SameSite::Strict), ("p", "hello", SameSite::NoRestriction)]);
    assert!(p.cookies[0].http_only && p.cookies[0].expires.is_none());
  }
}
