//! Session cookies kept across a restart (Orca's `src/main/browser/cookies/session-restore`).
//! WebKit, like Chromium, never writes a cookie without an expiry to disk, so a site that signs in
//! with one signs out whenever Kingu quits. Kingu restores its browser tabs, so it saves each
//! profile's session cookies itself and puts them back before the profile's first page loads.
//!
//! A snapshot never sits on disk in the clear (Orca's `writeSessionCookieSnapshot`): it is
//! AES-256-GCM sealed with a key that lives only in the Keychain, in a 0600 file under
//! `<app data>/browser-session-cookies` (a 0700 folder). Without the key there is no file. Values
//! are never logged. The whole live set replaces the file on every save, so a sign-out leaves it too.
//!
//! Saves: Orca listens for cookie changes and saves 30 s later. WebKit's change observer needs an
//! Objective-C class of Kingu's own, so the profiles with an open tab are read every 30 s, and 2 s
//! after a page finishes loading or a tab closes. A change in the last moments before quitting can
//! be missed. macOS only (the cookie stores are WebKit's).
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::cookies::{normalize_domain, ImportCookie, SameSite};

const FORMAT: &str = "kingu-browser-session-cookies-v1";
const DIRECTORY: &str = "browser-session-cookies";
const KEY_SERVICE: &str = "dev.kingu.browser-session-cookies";
const KEY_ACCOUNT: &str = "snapshot-key";
/// Orca's `SAVE_DELAY_MS`.
const SAVE_EVERY: Duration = Duration::from_secs(30);
/// After a page load or a closed tab: long enough for the page's own cookie writes to land.
const SETTLE: Duration = Duration::from_secs(2);
/// A jar holding more than this is not saved (a snapshot is a sign-in or two, not a crawl).
const MAX_COOKIES: usize = 5000;

/// One saved cookie. `domain` is as the store has it: a leading dot is a domain cookie.
#[derive(Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
  name: String,
  value: String,
  domain: String,
  path: String,
  #[serde(default)]
  secure: bool,
  #[serde(default)]
  http_only: bool,
  /// "lax", "strict" or "" (none given).
  #[serde(default)]
  same_site: String,
}

impl Saved {
  pub fn of(c: &ImportCookie) -> Saved {
    let same_site = match c.same_site {
      SameSite::Lax => "lax",
      SameSite::Strict => "strict",
      SameSite::NoRestriction | SameSite::Unspecified => "",
    };
    Saved { name: c.name.clone(), value: c.value.clone(), domain: c.domain.clone(), path: c.path.clone(), secure: c.secure, http_only: c.http_only, same_site: same_site.to_owned() }
  }

  /// Back as a session cookie (no expiry); None when the file names something that is not a cookie.
  pub fn cookie(&self) -> Option<ImportCookie> {
    if self.name.is_empty() || self.name.chars().any(char::is_control) || self.value.chars().any(char::is_control) || normalize_domain(&self.domain).is_none() {
      return None;
    }
    let same_site = match self.same_site.as_str() {
      "lax" => SameSite::Lax,
      "strict" => SameSite::Strict,
      _ => SameSite::Unspecified,
    };
    Some(ImportCookie { name: self.name.clone(), value: self.value.clone(), domain: self.domain.clone(), path: self.path.clone(), secure: self.secure, http_only: self.http_only, same_site, expires: None })
  }
}

/// What the file holds: the format, and the sealed JSON of the cookies.
#[derive(Serialize, Deserialize)]
struct Persisted {
  format: String,
  /// base64 of a 12-byte nonce followed by the AES-256-GCM ciphertext.
  cookies: String,
}

/// Seals `cookies` (sorted, so the same jar always gives the same plain text) under `key`.
pub fn seal(cookies: &[Saved], key: &[u8; 32], nonce: &[u8; 12]) -> Option<String> {
  use aes_gcm::aead::{Aead, KeyInit};
  use base64::Engine as _;
  let cipher = aes_gcm::Aes256Gcm::new_from_slice(key).ok()?;
  let sealed = cipher.encrypt(aes_gcm::Nonce::from_slice(nonce), plain(cookies).as_bytes()).ok()?;
  let mut bytes = nonce.to_vec();
  bytes.extend(sealed);
  serde_json::to_string(&Persisted { format: FORMAT.to_owned(), cookies: base64::engine::general_purpose::STANDARD.encode(bytes) }).ok()
}

/// The cookies of a snapshot file's text; None when it is not one, or `key` is not its key.
pub fn unseal(text: &str, key: &[u8; 32]) -> Option<Vec<Saved>> {
  use aes_gcm::aead::{Aead, KeyInit};
  use base64::Engine as _;
  let persisted: Persisted = serde_json::from_str(text).ok()?;
  if persisted.format != FORMAT {
    return None;
  }
  let bytes = base64::engine::general_purpose::STANDARD.decode(persisted.cookies.as_bytes()).ok()?;
  if bytes.len() <= 12 {
    return None;
  }
  let (nonce, sealed) = bytes.split_at(12);
  let cipher = aes_gcm::Aes256Gcm::new_from_slice(key).ok()?;
  serde_json::from_slice(&cipher.decrypt(aes_gcm::Nonce::from_slice(nonce), sealed).ok()?).ok()
}

/// The jar as text, in one order whatever order the store listed it in.
fn plain(cookies: &[Saved]) -> String {
  let mut sorted: Vec<&Saved> = cookies.iter().collect();
  sorted.sort_by(|a, b| (&a.domain, &a.path, &a.name, &a.value).cmp(&(&b.domain, &b.path, &b.name, &b.value)));
  serde_json::to_string(&sorted).unwrap_or_default()
}

fn digest(cookies: &[Saved]) -> [u8; 32] {
  use sha2::{Digest, Sha256};
  Sha256::digest(plain(cookies).as_bytes()).into()
}

/// A profile's file: named by its store id, so a profile's name is never a path.
pub fn snapshot_path(dir: &Path, profile: &str) -> PathBuf {
  let name = match super::profile_store(profile) {
    Some(id) => id.iter().map(|b| format!("{b:02x}")).collect::<String>(),
    None => "default".to_owned(),
  };
  dir.join(format!("{name}.json"))
}

fn write_private(path: &Path, text: &str) -> Result<(), String> {
  use std::io::Write;
  let dir = path.parent().ok_or("no folder")?;
  std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
  let tmp = path.with_extension("json.tmp");
  let _ = std::fs::remove_file(&tmp);
  let mut options = std::fs::OpenOptions::new();
  options.write(true).create_new(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    options.mode(0o600);
  }
  // The errors name the file, never what was being written.
  options.open(&tmp).and_then(|mut f| f.write_all(text.as_bytes())).map_err(|e| e.to_string())?;
  std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Writes `cookies` as the profile's snapshot; with none, or without a key, the file goes
/// (a stale one would undo a sign-out).
pub fn write_snapshot(path: &Path, cookies: &[Saved], key: Option<&[u8; 32]>, nonce: &[u8; 12]) -> Result<(), String> {
  let text = match key {
    Some(key) if !cookies.is_empty() => seal(cookies, key, nonce),
    _ => None,
  };
  match text {
    Some(text) => write_private(path, &text),
    None => match std::fs::remove_file(path) {
      Ok(()) => Ok(()),
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
      Err(e) => Err(e.to_string()),
    },
  }
}

/// The saved cookies that may go back: those the jar has no cookie for (same name, domain and
/// path). The jar may hold a newer cookie there, which a saved one must never replace.
pub fn missing_from(saved: Vec<ImportCookie>, live: &BTreeSet<(String, String, String)>) -> Vec<ImportCookie> {
  saved.into_iter().filter(|c| !live.contains(&(c.name.clone(), c.domain.trim_start_matches('.').to_ascii_lowercase(), c.path.clone()))).collect()
}

/// The key a jar's cookie is known by in [`missing_from`].
pub fn live_key(name: &str, domain: &str, path: &str) -> (String, String, String) {
  (name.to_owned(), domain.trim_start_matches('.').to_ascii_lowercase(), path.to_owned())
}

// ---- the running app --------------------------------------------------------------------------

/// The Keychain key, read at most once per launch (None: no Keychain, or no key and `create` is off).
fn key(create: bool) -> Option<[u8; 32]> {
  use base64::Engine as _;
  static KEY: Mutex<Option<[u8; 32]>> = Mutex::new(None);
  let mut cached = KEY.lock().unwrap_or_else(|e| e.into_inner());
  if let Some(k) = *cached {
    return Some(k);
  }
  let entry = keyring::Entry::new(KEY_SERVICE, KEY_ACCOUNT).ok()?;
  let found = match entry.get_password() {
    Ok(text) => base64::engine::general_purpose::STANDARD.decode(text.trim()).ok().and_then(|b| <[u8; 32]>::try_from(b).ok()),
    Err(keyring::Error::NoEntry) if create => {
      let fresh: [u8; 32] = crate::mobile::random_bytes(32).ok()?.try_into().ok()?;
      entry.set_password(&base64::engine::general_purpose::STANDARD.encode(fresh)).ok()?;
      Some(fresh)
    }
    Err(_) => None,
  };
  *cached = found;
  found
}

fn directory(app: &AppHandle) -> Option<PathBuf> {
  app.path().app_data_dir().ok().map(|d| d.join(DIRECTORY))
}

#[derive(Default)]
struct State {
  /// Open browser views: webview label → profile name ("" is the shared default store).
  views: BTreeMap<String, String>,
  /// What each profile's file holds now (the digest of its cookies), once known.
  saved: BTreeMap<String, [u8; 32]>,
  nudge: Option<mpsc::Sender<()>>,
}

static STATE: OnceLock<Mutex<State>> = OnceLock::new();

fn state() -> std::sync::MutexGuard<'static, State> {
  STATE.get_or_init(Mutex::default).lock().unwrap_or_else(|e| e.into_inner())
}

/// A save soon (a page finished loading, a tab closed).
pub fn nudge() {
  if let Some(tx) = &state().nudge {
    let _ = tx.send(());
  }
}

/// The view `label` is gone (closed, or freed by Memory Saver): its profile is saved once more.
pub fn closed(label: &str) {
  let mut st = state();
  if st.views.remove(label).is_some()
    && let Some(tx) = &st.nudge
  {
    let _ = tx.send(());
  }
}

/// Before a view of `profile` opens: the first time in this launch, the profile's saved session
/// cookies go back into its store. Later views share the live jar. Never fails the open: a jar
/// that cannot be restored still opens, signed out.
#[cfg(target_os = "macos")]
pub async fn before_open(app: &AppHandle, label: &str, profile: &str) {
  let (app, label, profile) = (app.clone(), label.to_owned(), profile.trim().to_owned());
  let _ = tauri::async_runtime::spawn_blocking(move || {
    // Held through the restore: a second tab of the profile waits for the cookies too.
    static RESTORED: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());
    let mut restored = RESTORED.lock().unwrap_or_else(|e| e.into_inner());
    if restored.insert(profile.clone()) {
      restore(&app, &profile);
    }
    drop(restored);
    let mut st = state();
    st.views.insert(label, profile);
    if st.nudge.is_none() {
      let (tx, rx) = mpsc::channel();
      st.nudge = Some(tx);
      std::thread::spawn(move || saver(app, rx));
    }
  })
  .await;
}

#[cfg(not(target_os = "macos"))]
pub async fn before_open(_app: &AppHandle, _label: &str, _profile: &str) {}

#[cfg(target_os = "macos")]
fn restore(app: &AppHandle, profile: &str) {
  let Some(path) = directory(app).map(|d| snapshot_path(&d, profile)) else { return };
  let Ok(text) = std::fs::read_to_string(&path) else { return };
  let cookies = key(false).and_then(|k| unseal(&text, &k));
  let Some(cookies) = cookies else {
    // Unreadable (another key, a damaged file): it can never go back, so it does not stay.
    let _ = std::fs::remove_file(&path);
    return;
  };
  state().saved.insert(profile.to_owned(), digest(&cookies));
  let cookies: Vec<ImportCookie> = cookies.iter().filter_map(Saved::cookie).collect();
  if let Err(e) = super::cookies::webkit::add_missing(app, super::profile_store(profile), cookies) {
    log::warn!("browser session cookies: restore failed: {e}");
  }
}

/// The profile's cookies were cleared (Clear cookies…): its snapshot goes too, so the next launch
/// can't put them back. An open tab's next save finds the jar empty and writes nothing.
#[cfg(target_os = "macos")]
pub fn forget(app: &AppHandle, profile: &str) {
  let Some(path) = directory(app).map(|d| snapshot_path(&d, profile)) else { return };
  state().saved.insert(profile.to_owned(), digest(&[]));
  if let Err(e) = write_snapshot(&path, &[], None, &[0; 12]) {
    log::warn!("browser session cookies: clear failed: {e}");
  }
}

/// Saves the profiles with an open view every [`SAVE_EVERY`], and [`SETTLE`] after a nudge.
#[cfg(target_os = "macos")]
fn saver(app: AppHandle, rx: mpsc::Receiver<()>) {
  let mut last: BTreeSet<String> = BTreeSet::new();
  loop {
    match rx.recv_timeout(SAVE_EVERY) {
      Ok(()) => {
        std::thread::sleep(SETTLE);
        while rx.try_recv().is_ok() {}
      }
      Err(mpsc::RecvTimeoutError::Timeout) => {}
      Err(mpsc::RecvTimeoutError::Disconnected) => return,
    }
    let open: BTreeSet<String> = state().views.values().cloned().collect();
    // A profile whose last view just closed is saved once more.
    for profile in open.union(&last) {
      save(&app, profile);
    }
    last = open;
  }
}

#[cfg(target_os = "macos")]
fn save(app: &AppHandle, profile: &str) {
  let Some(path) = directory(app).map(|d| snapshot_path(&d, profile)) else { return };
  let Ok(live) = super::cookies::webkit::session_cookies(app, super::profile_store(profile)) else { return };
  if live.len() > MAX_COOKIES {
    return;
  }
  let cookies: Vec<Saved> = live.iter().map(Saved::of).collect();
  let now = digest(&cookies);
  // Sites often set a session cookie again to the value it had: no write then.
  if state().saved.get(profile) == Some(&now) || (cookies.is_empty() && !path.exists()) {
    return;
  }
  let key = if cookies.is_empty() { None } else { key(true) };
  let Some(nonce) = crate::mobile::random_bytes(12).ok().and_then(|b| <[u8; 12]>::try_from(b).ok()) else { return };
  match write_snapshot(&path, &cookies, key.as_ref(), &nonce) {
    Ok(()) => {
      state().saved.insert(profile.to_owned(), now);
    }
    Err(e) => log::warn!("browser session cookies: save failed: {e}"),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn saved(name: &str, value: &str, domain: &str) -> Saved {
    Saved { name: name.into(), value: value.into(), domain: domain.into(), path: "/".into(), secure: true, http_only: true, same_site: "lax".into() }
  }

  #[test]
  fn a_snapshot_is_sealed_and_opens_only_with_its_key() {
    let (key, other, nonce) = ([7u8; 32], [8u8; 32], [1u8; 12]);
    let cookies = vec![saved("sid", "s3cr3t-value", ".example.com"), saved("t", "v", "app.dev")];
    let text = seal(&cookies, &key, &nonce).unwrap();
    assert!(text.contains(FORMAT) && !text.contains("s3cr3t-value") && !text.contains("example.com"));
    let mut back = unseal(&text, &key).unwrap();
    back.sort_by(|a, b| a.name.cmp(&b.name));
    assert!(back == cookies);
    assert!(unseal(&text, &other).is_none());
    assert!(unseal("{}", &key).is_none());
    assert!(unseal(&text.replace(FORMAT, "orca-browser-session-cookies-v1"), &key).is_none());
    // The same jar in another order is the same snapshot (no rewrite).
    let reversed: Vec<Saved> = cookies.iter().rev().cloned().collect();
    assert_eq!(digest(&cookies), digest(&reversed));
    assert_ne!(digest(&cookies), digest(&cookies[..1]));
  }

  #[test]
  fn a_snapshot_file_is_private_and_goes_without_cookies_or_a_key() {
    let dir = tempfile::tempdir().unwrap();
    let path = snapshot_path(&dir.path().join(DIRECTORY), "work");
    let (key, nonce) = ([7u8; 32], [1u8; 12]);
    let cookies = vec![saved("sid", "abc", "example.com")];
    write_snapshot(&path, &cookies, Some(&key), &nonce).unwrap();
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
      assert_eq!(std::fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
    }
    assert!(unseal(&std::fs::read_to_string(&path).unwrap(), &key).unwrap() == cookies);
    // No key: nothing in the clear, and the old file does not stay.
    write_snapshot(&path, &cookies, None, &nonce).unwrap();
    assert!(!path.exists());
    write_snapshot(&path, &cookies, Some(&key), &nonce).unwrap();
    // Signed out everywhere: the file goes.
    write_snapshot(&path, &[], Some(&key), &nonce).unwrap();
    assert!(!path.exists());
    write_snapshot(&path, &[], Some(&key), &nonce).unwrap();
  }

  #[test]
  fn a_profile_name_never_names_a_path() {
    let dir = Path::new("/data/browser-session-cookies");
    assert_eq!(snapshot_path(dir, ""), dir.join("default.json"));
    assert_eq!(snapshot_path(dir, "  "), dir.join("default.json"));
    let evil = snapshot_path(dir, "../../etc/passwd");
    assert_eq!(evil.parent(), Some(dir));
    assert_eq!(evil.file_stem().unwrap().len(), 32);
    assert_ne!(snapshot_path(dir, "work"), snapshot_path(dir, "personal"));
    assert_eq!(snapshot_path(dir, "work"), snapshot_path(dir, " work "));
  }

  #[test]
  fn saved_cookies_come_back_as_session_cookies_and_never_over_a_live_one() {
    let c = saved("sid", "abc", ".example.com").cookie().unwrap();
    assert!(c.expires.is_none() && c.secure && c.http_only && c.same_site == SameSite::Lax && c.domain == ".example.com");
    assert!(Saved::of(&c) == saved("sid", "abc", ".example.com"));
    assert!(saved("", "abc", "example.com").cookie().is_none());
    assert!(saved("sid", "a\r\nSet-Cookie: x", "example.com").cookie().is_none());
    assert!(saved("sid", "abc", "exa mple.com/").cookie().is_none());
    let live = BTreeSet::from([live_key("sid", ".Example.com", "/")]);
    let back = missing_from(vec![c, saved("other", "1", "example.com").cookie().unwrap()], &live);
    assert_eq!(back.len(), 1);
    assert_eq!(back[0].name, "other");
  }
}
