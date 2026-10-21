//! The team Snap library on the team server (`/v1/snap-library`): snap packages an owner or lead
//! explicitly publishes, one immutable zip per version, which every member can install. Only
//! the snap's own folder goes up (what `snap::snap_files` covers plus `snap.toml`), never
//! anything else of a project, and never secret values (permissions only name them). The team
//! token stays in the Keychain (`client::Keychain`).
//!
//! Installing downloads the package, checks its SHA-256 against the published one, extracts it
//! into staging like any install (no symlinks, unsafe paths or oversize trees), and refuses it
//! unless the snap there has the published trust hash; then the webview shows the normal confirm
//! (with the permission diff on an update) and `snap_install_commit` installs it.

use std::io::Write;
use std::path::Path;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::client::{HttpTransport, Keychain, SendError, TokenStore, normalize_server_url, server_message};
use crate::i18n::msg::{SnapMsg, TeamMsg};
use crate::snap::{MANIFEST, SnapInfo, Source, TRUST_FILE, TrustData, USER_DIR, config_dir, discover, is_snap_id, sha256_hex, snap_files};
use crate::snap_install::{CLONE_TIMEOUT, Origin, Prepared, TeamOrigin, blocking, cancel, finish_stage, is_sha256, staged, staging_dir, user_dir};
use crate::tr;
use crate::workspace::Workspace;

/// The server's limit on a package.
pub const MAX_PACKAGE_BYTES: usize = 8 * 1024 * 1024;

/// `^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$`, as the server checks it (path-safe).
pub fn is_version(v: &str) -> bool {
  let b = v.as_bytes();
  !b.is_empty() && b.len() <= 64 && b[0].is_ascii_alphanumeric() && b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'+' | b'_' | b'-'))
}

/// One published version (`GET /v1/snap-library` item; snake_case like the server).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct LibraryVersion {
  pub snap_id: String,
  pub version: String,
  pub name: String,
  #[serde(default)]
  pub description: String,
  pub sha256: String,
  pub package_sha256: String,
  #[serde(default)]
  pub package_size: u64,
  #[serde(default)]
  pub permissions: serde_json::Value,
  #[serde(default)]
  pub published_by: String,
  #[serde(default)]
  pub published_at: String,
  #[serde(default)]
  pub yanked: bool,
  #[serde(default)]
  pub yank_reason: Option<String>,
}

impl LibraryVersion {
  fn valid(&self) -> bool {
    is_snap_id(&self.snap_id) && is_version(&self.version) && is_sha256(&self.sha256) && is_sha256(&self.package_sha256)
  }
}

#[derive(Deserialize)]
struct ListBody {
  items: Vec<serde_json::Value>,
}

/// Parses the list, dropping malformed entries; keeps the server's order (newest first per snap).
pub fn parse_library(body: &str) -> Result<Vec<LibraryVersion>, String> {
  let list: ListBody = serde_json::from_str(body).map_err(|e| tr!(TeamMsg::BadSnapList, detail = e))?;
  Ok(list.items.into_iter().filter_map(|v| serde_json::from_value::<LibraryVersion>(v).ok()).filter(LibraryVersion::valid).collect())
}

/// The version to install: `version` exactly (yanked or not: a lock file may pin it), else the
/// newest one that is not yanked.
pub fn pick<'a>(items: &'a [LibraryVersion], id: &str, version: Option<&str>) -> Option<&'a LibraryVersion> {
  let mut of_id = items.iter().filter(|v| v.snap_id == id);
  match version {
    Some(want) => of_id.find(|v| v.version == want),
    None => of_id.find(|v| !v.yanked),
  }
}

/// The snap folder as a zip: `snap.toml` and every file `snap_files` covers, sorted, with fixed
/// timestamps (the same folder always packs to the same bytes) and the executable bit kept.
pub fn pack(dir: &Path) -> Result<Vec<u8>, String> {
  let mut names = vec![MANIFEST.to_string()];
  names.extend(snap_files(dir)?.into_iter().map(|f| f.path));
  let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
  let fail = |e: zip::result::ZipError| tr!(SnapMsg::PackageInvalid, detail = e);
  for rel in &names {
    let path = dir.join(rel);
    let bytes = std::fs::read(&path).map_err(|e| tr!(SnapMsg::ReadFailed, path = rel, detail = e))?;
    #[cfg(unix)]
    let exec = {
      use std::os::unix::fs::PermissionsExt;
      std::fs::metadata(&path).map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false)
    };
    #[cfg(not(unix))]
    let exec = false;
    let options = zip::write::SimpleFileOptions::default()
      .compression_method(zip::CompressionMethod::Deflated)
      .last_modified_time(zip::DateTime::default())
      .unix_permissions(if exec { 0o755 } else { 0o644 });
    zip.start_file(rel.as_str(), options).map_err(fail)?;
    zip.write_all(&bytes).map_err(|e| tr!(SnapMsg::PackageInvalid, detail = e))?;
  }
  let bytes = zip.finish().map_err(fail)?.into_inner();
  if bytes.len() > MAX_PACKAGE_BYTES {
    return Err(tr!(SnapMsg::PackageInvalid, detail = format!("larger than {} MB", MAX_PACKAGE_BYTES / 1024 / 1024)));
  }
  Ok(bytes)
}

/// Stages a downloaded package of `entry` for the normal install confirm. Refuses bytes that are
/// not the published package, and a snap inside that does not hash to the published trust hash.
pub fn prepare_package(staging: &Path, users: &Path, server: &str, entry: &LibraryVersion, bytes: &[u8]) -> Result<Prepared, String> {
  if sha256_hex(bytes) != entry.package_sha256 {
    return Err(tr!(SnapMsg::PackageHashMismatch, id = entry.snap_id, version = entry.version));
  }
  let origin = Origin { team: Some(TeamOrigin { server: server.to_string(), version: entry.version.clone() }), ..Origin::default() };
  let mut p = staged(staging, |token, dir| {
    crate::skill_hub::package::extract_zip(bytes, &dir.join("src")).map_err(|e| tr!(SnapMsg::PackageInvalid, detail = e))?;
    finish_stage(token.to_string(), dir, origin, users)
  })?;
  p.candidates.retain(|c| c.snap.id == entry.snap_id && c.rel.is_empty());
  let short = |h: &str| h.get(..12).unwrap_or(h).to_string();
  let refusal = match p.candidates.first() {
    None => Some(tr!(SnapMsg::PackageInvalid, detail = format!("no {MANIFEST} of {} at the top", entry.snap_id))),
    Some(c) if c.snap.error.is_some() => Some(tr!(SnapMsg::CommitSnapBroken, id = entry.snap_id, detail = c.snap.error.clone().unwrap_or_default())),
    Some(c) if c.snap.hash != entry.sha256 => Some(tr!(SnapMsg::PackageSnapMismatch, id = entry.snap_id, version = entry.version, got = short(&c.snap.hash), published = short(&entry.sha256))),
    Some(_) => None,
  };
  if let Some(e) = refusal {
    cancel(staging, &p.token);
    return Err(e);
  }
  p.existing.retain(|e| e.id == entry.snap_id);
  Ok(p)
}

/// The body of `PUT /v1/snap-library/{id}/versions/{version}`. `sha256` is the trust hash of the
/// snap as an installer will see it: the package is extracted and read back as a user snap
/// (a repo snap's repo scripts are not part of it).
pub fn publish_body(staging: &Path, snap: &SnapInfo, bytes: &[u8]) -> Result<serde_json::Value, String> {
  let probe = staging.join(format!(".publish-{}-{}", snap.id, std::process::id()));
  let _ = std::fs::remove_dir_all(&probe);
  std::fs::create_dir_all(&probe).map_err(|e| tr!(SnapMsg::CreateFailed, path = probe.display(), detail = e))?;
  let read = (|| {
    crate::skill_hub::package::extract_zip(bytes, &probe.join(&snap.id)).map_err(|e| tr!(SnapMsg::PackageInvalid, detail = e))?;
    let list = crate::snap::scan(&probe, Source::User, None, &TrustData::default());
    list.into_iter().find(|s| s.id == snap.id).ok_or_else(|| tr!(SnapMsg::NotFound, id = snap.id))
  })();
  let _ = std::fs::remove_dir_all(&probe);
  let packed = read?;
  if let Some(e) = packed.error {
    return Err(tr!(SnapMsg::InstallBroken, id = snap.id, detail = e));
  }
  Ok(serde_json::json!({
    "name": packed.name,
    "description": packed.description,
    "sha256": packed.hash,
    "permissions": packed.permissions,
    "package": base64::engine::general_purpose::STANDARD.encode(bytes),
    "package_sha256": sha256_hex(bytes),
  }))
}

// ---- commands -------------------------------------------------------------------

fn token_for(server: &str) -> Result<String, String> {
  Keychain.get(server).ok_or_else(|| tr!(TeamMsg::NotSignedIn))
}

fn send_error_text(e: SendError) -> String {
  match e {
    SendError::Unauthorized(m) if m.contains("403") => tr!(TeamMsg::NotAllowedToApprove),
    SendError::Unauthorized(_) => tr!(TeamMsg::TeamTokenRejected),
    SendError::Retryable(m) => tr!(TeamMsg::Unreachable, detail = m),
    SendError::Permanent(m) => tr!(TeamMsg::ServerRefused, detail = m),
  }
}

fn fetch(http: &HttpTransport, server: &str, token: &str) -> Result<Vec<LibraryVersion>, String> {
  parse_library(&http.request(reqwest::Method::GET, server, token, "/v1/snap-library", None).map_err(send_error_text)?)
}

#[derive(Serialize)]
pub struct Library {
  pub server: String,
  pub role: String,
  pub items: Vec<LibraryVersion>,
}

/// Every published version, and the caller's role (whether Publish and Yank are offered).
#[tauri::command]
pub async fn team_snap_library(server_url: String) -> Result<Library, String> {
  let server = normalize_server_url(&server_url)?;
  blocking(move || {
    let token = token_for(&server)?;
    let http = HttpTransport::new()?;
    let me = http.me(&server, &token).map_err(send_error_text)?;
    let items = fetch(&http, &server, &token)?;
    Ok(Library { role: me["role"].as_str().unwrap_or_default().to_owned(), server, items })
  })
  .await
}

/// Publishes snap `id` of this window's listing (user snap, or repo snap with `source = "repo"`)
/// as its manifest's version. The server refuses a version that exists with other bytes.
#[tauri::command]
pub async fn team_snap_publish(app: AppHandle, ws: Workspace, server_url: String, id: String, source: String) -> Result<LibraryVersion, String> {
  let server = normalize_server_url(&server_url)?;
  if !is_snap_id(&id) {
    return Err(tr!(TeamMsg::BadSnapId, id));
  }
  blocking(move || {
    let token = token_for(&server)?;
    let config = config_dir(&app)?;
    let trust = TrustData::load(&config.join(TRUST_FILE));
    let want = if source == "repo" { Source::Repo } else { Source::User };
    let snap = discover(&config.join(USER_DIR), ws.current().as_deref(), &trust).into_iter().find(|s| s.id == id && s.source == want).ok_or_else(|| tr!(SnapMsg::NotFound, id))?;
    if let Some(e) = &snap.error {
      return Err(tr!(SnapMsg::InstallBroken, id, detail = e));
    }
    if !is_version(&snap.version) {
      return Err(tr!(SnapMsg::PackageInvalid, detail = format!("version \"{}\" must match [0-9A-Za-z][0-9A-Za-z.+_-]*", snap.version)));
    }
    let bytes = pack(Path::new(&snap.dir))?;
    let body = publish_body(&staging_dir(&app)?, &snap, &bytes)?;
    let http = HttpTransport::with_timeout(120)?;
    let text = http.request(reqwest::Method::PUT, &server, &token, &format!("/v1/snap-library/{id}/versions/{}", snap.version), Some(&body)).map_err(send_error_text)?;
    let stored: LibraryVersion = serde_json::from_str(&text).map_err(|e| tr!(TeamMsg::BadServerReply, detail = e, message = server_message(&text).unwrap_or_default()))?;
    log::info!("team library: published snap {id} {} ({} bytes)", stored.version, bytes.len());
    Ok(stored)
  })
  .await
}

/// Stages snap `id` from the library (`version`, else the newest not yanked) for the normal
/// install confirm; the entry is read from the server again here, not taken from the webview.
#[tauri::command]
pub async fn snap_install_library(app: AppHandle, server_url: String, id: String, version: Option<String>) -> Result<Prepared, String> {
  let server = normalize_server_url(&server_url)?;
  if !is_snap_id(&id) || version.as_deref().is_some_and(|v| !is_version(v)) {
    return Err(tr!(TeamMsg::BadSnapId, id));
  }
  blocking(move || {
    let token = token_for(&server)?;
    let http = HttpTransport::new()?;
    let items = fetch(&http, &server, &token)?;
    let entry = pick(&items, &id, version.as_deref()).ok_or_else(|| tr!(TeamMsg::SnapNotApproved, id))?.clone();
    let bytes = HttpTransport::with_timeout(CLONE_TIMEOUT.as_secs())?
      .get_bytes(&server, &token, &format!("/v1/snap-library/{id}/versions/{}/package", entry.version), MAX_PACKAGE_BYTES)
      .map_err(send_error_text)?;
    prepare_package(&staging_dir(&app)?, &user_dir(&app)?, &server, &entry, &bytes)
  })
  .await
}

/// Yanks (or restores) a published version: installs that pin it keep working, new installs
/// and updates skip it.
#[tauri::command]
pub async fn team_snap_yank(server_url: String, id: String, version: String, yanked: bool, reason: Option<String>) -> Result<LibraryVersion, String> {
  let server = normalize_server_url(&server_url)?;
  if !is_snap_id(&id) || !is_version(&version) {
    return Err(tr!(TeamMsg::BadSnapId, id));
  }
  blocking(move || {
    let token = token_for(&server)?;
    let reason = reason.map(|r| r.trim().to_string()).filter(|r| !r.is_empty());
    let body = serde_json::json!({ "yanked": yanked, "reason": reason });
    let text = HttpTransport::new()?.request(reqwest::Method::POST, &server, &token, &format!("/v1/snap-library/{id}/versions/{version}/yank"), Some(&body)).map_err(send_error_text)?;
    serde_json::from_str(&text).map_err(|e| tr!(TeamMsg::BadServerReply, detail = e, message = server_message(&text).unwrap_or_default()))
  })
  .await
}

#[cfg(test)]
mod tests {
  use super::*;

  fn write(dir: &Path, files: &[(&str, &str)]) {
    for (rel, text) in files {
      let p = dir.join(rel);
      std::fs::create_dir_all(p.parent().unwrap()).unwrap();
      std::fs::write(p, text).unwrap();
    }
  }

  fn snap_dir(tmp: &Path) -> std::path::PathBuf {
    let dir = tmp.join("src/go");
    write(&dir, &[
      ("snap.toml", "id = \"go\"\nname = \"Go\"\nversion = \"1.2.0\"\n[permissions]\nnetwork = true\nsecrets = [\"GO_TOKEN\"]\n[[tasks]]\nid = \"t\"\ntitle = \"T\"\ncommand = [\"./run.sh\"]\n"),
      ("run.sh", "#!/bin/sh\necho hi\n"),
      ("docs/README.md", "hi"),
      (".DS_Store", "junk"),
      (".kingu-snap.json", "{}"),
    ]);
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      std::fs::set_permissions(dir.join("run.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    dir
  }

  fn entry(sha256: &str, bytes: &[u8]) -> LibraryVersion {
    LibraryVersion {
      snap_id: "go".into(),
      version: "1.2.0".into(),
      name: "Go".into(),
      description: String::new(),
      sha256: sha256.into(),
      package_sha256: sha256_hex(bytes),
      package_size: bytes.len() as u64,
      permissions: serde_json::json!({}),
      published_by: "olive".into(),
      published_at: "2026-10-20T00:00:00Z".into(),
      yanked: false,
      yank_reason: None,
    }
  }

  #[test]
  fn packs_deterministically_and_round_trips_through_install() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = snap_dir(tmp.path());
    let bytes = pack(&dir).unwrap();
    assert_eq!(pack(&dir).unwrap(), bytes, "same folder, same bytes");
    let mut names: Vec<String> = {
      let mut z = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
      (0..z.len()).map(|i| z.by_index(i).unwrap().name().to_string()).collect()
    };
    names.sort();
    assert_eq!(names, ["docs/README.md", "run.sh", "snap.toml"], "no .DS_Store, no install record");

    let staging = tmp.path().join("staging");
    let body = publish_body(&staging, &crate::snap::scan(&tmp.path().join("src"), Source::User, None, &TrustData::default()).remove(0), &bytes).unwrap();
    assert_eq!(body["permissions"], serde_json::json!({ "network": true, "fs": "worktree", "secrets": ["GO_TOKEN"] }));
    assert_eq!(body["package_sha256"], sha256_hex(&bytes));
    let sha = body["sha256"].as_str().unwrap().to_string();

    let users = tmp.path().join("config/snaps");
    let p = prepare_package(&staging, &users, "https://team.example", &entry(&sha, &bytes), &bytes).unwrap();
    assert_eq!(p.candidates.len(), 1);
    assert_eq!(p.origin.team, Some(TeamOrigin { server: "https://team.example".into(), version: "1.2.0".into() }));
    crate::snap_install::commit(&staging, &users, &p.token, "go", &sha, false).unwrap();
    let installed = crate::snap::scan(&users, Source::User, None, &TrustData::default()).remove(0);
    assert_eq!(installed.hash, sha);
    assert_eq!(installed.origin.and_then(|o| o.team).map(|t| t.version).as_deref(), Some("1.2.0"));
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      assert_ne!(std::fs::metadata(users.join("go/run.sh")).unwrap().permissions().mode() & 0o111, 0, "scripts stay executable");
    }
  }

  #[test]
  fn refuses_packages_that_are_not_what_was_published() {
    let tmp = tempfile::tempdir().unwrap();
    let bytes = pack(&snap_dir(tmp.path())).unwrap();
    let staging = tmp.path().join("staging");
    let users = tmp.path().join("users");
    let mut tampered = bytes.clone();
    let last = tampered.len() - 30;
    tampered[last] ^= 1;
    assert!(prepare_package(&staging, &users, "s", &entry(&"a".repeat(64), &bytes), &tampered).unwrap_err().contains("SHA-256"));
    // Right bytes, but the snap inside is not the published one.
    let e = prepare_package(&staging, &users, "s", &entry(&"a".repeat(64), &bytes), &bytes).unwrap_err();
    assert!(e.contains("aaaaaaaaaaaa"), "{e}");
    assert!(std::fs::read_dir(&staging).map(|r| r.count()).unwrap_or(0) == 0, "staging cleaned up");
    // A zip with an unsafe path.
    let mut z = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    z.start_file("../evil", zip::write::SimpleFileOptions::default()).unwrap();
    z.write_all(b"x").unwrap();
    let evil = z.finish().unwrap().into_inner();
    assert!(prepare_package(&staging, &users, "s", &entry(&"a".repeat(64), &evil), &evil).is_err());
  }

  #[test]
  fn picks_versions_and_parses_the_list() {
    let mk = |v: &str, yanked: bool| serde_json::json!({ "snap_id": "go", "version": v, "name": "Go", "sha256": "a".repeat(64), "package_sha256": "b".repeat(64), "yanked": yanked });
    let body = serde_json::json!({ "items": [mk("2.0.0", true), mk("1.1.0", false), mk("1.0.0", false), { "snap_id": "Bad" }, mk("../x", false)] }).to_string();
    let items = parse_library(&body).unwrap();
    assert_eq!(items.iter().map(|v| v.version.as_str()).collect::<Vec<_>>(), ["2.0.0", "1.1.0", "1.0.0"]);
    assert_eq!(pick(&items, "go", None).unwrap().version, "1.1.0", "yanked is skipped");
    assert_eq!(pick(&items, "go", Some("2.0.0")).unwrap().version, "2.0.0", "a lock may pin a yanked one");
    assert!(pick(&items, "rust", None).is_none());
    assert!(is_version("1.0.0+build.1") && !is_version("") && !is_version("-1") && !is_version("1/2"));
  }
}
