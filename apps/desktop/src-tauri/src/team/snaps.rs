//! The team Snap catalog on the team server (`/v1/snaps`): snaps the team's owners/leads approved,
//! pinned to a git commit and the snap's trust hash. Only metadata goes to the server (where to
//! fetch the snap, its version, hash and declared permissions), never the snap's files.
//!
//! Installing a team snap clones the pinned commit and refuses it unless the snap there hashes to
//! the approved `manifest_sha256`; the user still sees the normal install confirm.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::client::{HttpTransport, Keychain, SendError, TokenStore, normalize_server_url, server_message};
use crate::snap::{FsAccess, Permissions, SnapInfo, Source, TrustData, is_snap_id};
use crate::snap_install::{CLONE_TIMEOUT, Pin, Prepared, blocking, cancel, is_commit, is_sha256, parse_git_source, prepare_pinned, staging_dir, user_dir};

const MAX_NOTE_CHARS: usize = 500;

/// Declared permissions as the server stores them. Lenient on unknown fields (a newer server).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct TeamPermissions {
  #[serde(default)]
  pub network: bool,
  #[serde(default)]
  pub fs: FsAccess,
  #[serde(default)]
  pub secrets: Vec<String>,
}

/// One approved snap (`GET /v1/snaps` item; snake_case like the server).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TeamSnap {
  pub snap_id: String,
  pub name: String,
  pub version: String,
  pub git_url: String,
  #[serde(default)]
  pub git_ref: Option<String>,
  pub commit_sha: String,
  pub manifest_sha256: String,
  #[serde(default)]
  pub permissions: TeamPermissions,
  #[serde(default)]
  pub approved_by: String,
  #[serde(default)]
  pub approved_at: String,
  #[serde(default)]
  pub required: bool,
  #[serde(default)]
  pub note: Option<String>,
}

impl TeamSnap {
  /// An entry the desktop can act on; anything else is dropped rather than half-shown.
  fn valid(&self) -> bool {
    is_snap_id(&self.snap_id) && is_commit(&self.commit_sha) && is_sha256(&self.manifest_sha256) && parse_git_source(&self.git_url).is_ok()
  }

  pub fn pin(&self) -> Pin {
    Pin { id: self.snap_id.clone(), url: self.git_url.clone(), git_ref: self.git_ref.clone(), commit: self.commit_sha.clone(), sha256: self.manifest_sha256.clone() }
  }
}

#[derive(Deserialize)]
struct ListBody {
  items: Vec<serde_json::Value>,
}

/// Parses `{"items": [...]}`, skipping entries that are malformed or carry an unusable id, commit,
/// hash or git URL.
pub fn parse_list(body: &str) -> Result<Vec<TeamSnap>, String> {
  let list: ListBody = serde_json::from_str(body).map_err(|e| format!("รายการ snap ของทีมอ่านไม่ได้: {e}"))?;
  let mut out: Vec<TeamSnap> = list.items.into_iter().filter_map(|v| serde_json::from_value::<TeamSnap>(v).ok()).filter(TeamSnap::valid).collect();
  out.sort_by(|a, b| a.snap_id.cmp(&b.snap_id));
  out.dedup_by(|a, b| a.snap_id == b.snap_id);
  Ok(out)
}

/// The body of `PUT /v1/snaps/{id}`.
#[derive(Serialize, Debug, PartialEq)]
pub struct Approval {
  pub name: String,
  pub version: String,
  pub git_url: String,
  pub git_ref: Option<String>,
  pub commit_sha: String,
  pub manifest_sha256: String,
  pub permissions: Permissions,
  pub required: bool,
  pub note: Option<String>,
}

impl Approval {
  pub fn pin(&self, id: &str) -> Pin {
    Pin { id: id.to_string(), url: self.git_url.clone(), git_ref: self.git_ref.clone(), commit: self.commit_sha.clone(), sha256: self.manifest_sha256.clone() }
  }
}

/// What approving installed user snap `snap` sends: its git origin (the team clones the same URL),
/// the installed commit, hash and declared permissions. Only git snaps from a remote other
/// desktops can reach qualify.
pub fn approval_for(snap: &SnapInfo, required: bool, note: Option<&str>) -> Result<Approval, String> {
  if snap.source != Source::User {
    return Err("อนุมัติให้ทีมได้เฉพาะ snap ที่ติดตั้งไว้ในเครื่องคุณ (ไม่ใช่ snap ของ repo)".into());
  }
  if let Some(e) = &snap.error {
    return Err(format!("snap \"{}\" มีข้อผิดพลาด อนุมัติไม่ได้: {e}", snap.id));
  }
  let origin = snap.origin.as_ref();
  let url = origin.and_then(|o| o.url.clone()).ok_or_else(|| format!("snap \"{}\" ไม่ได้ติดตั้งจาก git จึงอนุมัติให้ทีมไม่ได้", snap.id))?;
  let spec = parse_git_source(&url)?;
  if spec.url.starts_with('/') || spec.url.to_ascii_lowercase().starts_with("file:") {
    return Err(format!("snap \"{}\" ติดตั้งจาก path ในเครื่อง คนอื่นในทีมดึงไม่ได้ — ติดตั้งจาก https:// หรือ ssh ก่อนแล้วค่อยอนุมัติ", snap.id));
  }
  let commit = origin.and_then(|o| o.commit.clone()).filter(|c| is_commit(c)).ok_or_else(|| format!("ไม่รู้ commit ของ snap \"{}\" — อัปเดตหรือติดตั้งใหม่ก่อน", snap.id))?;
  if !is_sha256(&snap.hash) {
    return Err(format!("อ่าน hash ของ snap \"{}\" ไม่ได้", snap.id));
  }
  let note = note.map(str::trim).filter(|n| !n.is_empty());
  if let Some(n) = note
    && (n.chars().count() > MAX_NOTE_CHARS || n.chars().any(char::is_control))
  {
    return Err(format!("หมายเหตุต้องเป็นบรรทัดเดียว ยาวไม่เกิน {MAX_NOTE_CHARS} ตัวอักษร"));
  }
  Ok(Approval {
    name: snap.name.clone(),
    version: snap.version.clone(),
    git_url: spec.url,
    git_ref: origin.and_then(|o| o.git_ref.clone()),
    commit_sha: commit,
    manifest_sha256: snap.hash.clone(),
    permissions: snap.permissions.clone(),
    required,
    note: note.map(String::from),
  })
}

// ---- commands -------------------------------------------------------------------

fn token_for(server: &str) -> Result<String, String> {
  Keychain.get(server).ok_or_else(|| "ยังไม่ได้ลงชื่อเข้าใช้ทีม — ใช้คำสั่ง Sign in to Team Server ก่อน".to_string())
}

fn thai(e: SendError) -> String {
  match e {
    SendError::Unauthorized(m) if m.contains("403") => "บัญชีนี้ไม่มีสิทธิ์ — เฉพาะ owner หรือ lead ของทีมที่อนุมัติ snap ได้".into(),
    SendError::Unauthorized(_) => "token ของทีมไม่ถูกต้อง หมดอายุ หรือถูกเพิกถอน — ลงชื่อเข้าใช้ใหม่".into(),
    SendError::Retryable(m) => format!("เชื่อมต่อเซิร์ฟเวอร์ทีมไม่ได้: {m}"),
    SendError::Permanent(m) => format!("เซิร์ฟเวอร์ทีมปฏิเสธ: {m}"),
  }
}

fn fetch_catalog(server: &str, token: &str) -> Result<Vec<TeamSnap>, String> {
  parse_list(&HttpTransport::new()?.list_snaps(server, token).map_err(thai)?)
}

#[derive(Serialize)]
pub struct Catalog {
  pub server: String,
  pub user_id: String,
  pub role: String,
  pub items: Vec<TeamSnap>,
}

/// The team catalog plus who the caller is (the role decides whether Approve is offered).
#[tauri::command]
pub async fn team_snap_catalog(server_url: String) -> Result<Catalog, String> {
  let server = normalize_server_url(&server_url)?;
  blocking(move || {
    let token = token_for(&server)?;
    let http = HttpTransport::new()?;
    let me = http.me(&server, &token).map_err(thai)?;
    let items = parse_list(&http.list_snaps(&server, &token).map_err(thai)?)?;
    let s = |k: &str| me[k].as_str().unwrap_or_default().to_owned();
    Ok(Catalog { user_id: s("user_id"), role: s("role"), server, items })
  })
  .await
}

/// Approves installed user snap `id` for the team at its installed commit. Before sending, the
/// commit is fetched again and must still produce the installed hash, so a snap edited after
/// install (or a moved remote) is never pinned to a hash nobody else can reproduce.
#[tauri::command]
pub async fn team_snap_approve(app: AppHandle, server_url: String, id: String, required: bool, note: Option<String>) -> Result<TeamSnap, String> {
  let server = normalize_server_url(&server_url)?;
  if !is_snap_id(&id) {
    return Err(format!("id \"{id}\" ไม่ถูกต้อง"));
  }
  blocking(move || {
    let token = token_for(&server)?;
    let users = user_dir(&app)?;
    let snap = crate::snap::scan(&users, Source::User, None, &TrustData::default())
      .into_iter()
      .find(|s| s.id == id)
      .ok_or_else(|| format!("ไม่พบ snap \"{id}\" ที่ติดตั้งในเครื่อง"))?;
    let approval = approval_for(&snap, required, note.as_deref())?;
    let staging = staging_dir(&app)?;
    let check = prepare_pinned(&staging, &users, &approval.pin(&id), CLONE_TIMEOUT)
      .map_err(|e| format!("ตรวจ snap กับ git ต้นทางไม่ผ่าน (snap ในเครื่องอาจถูกแก้หลังติดตั้ง): {e}"))?;
    cancel(&staging, &check.token);
    let body = HttpTransport::new()?.put_snap(&server, &token, &id, &approval).map_err(thai)?;
    let stored: TeamSnap = serde_json::from_str(&body).map_err(|e| format!("คำตอบของเซิร์ฟเวอร์ทีมอ่านไม่ได้: {e}: {}", server_message(&body).unwrap_or_default()))?;
    log::info!("team snap {id}: approved at {}", stored.commit_sha);
    Ok(stored)
  })
  .await
}

/// Stages team snap `id` at its pinned commit (verifying the hash); the webview then shows the
/// normal confirm and calls `snap_install_commit`. The pin is read from the server again here
/// rather than taken from the webview.
#[tauri::command]
pub async fn snap_install_team(app: AppHandle, server_url: String, id: String) -> Result<Prepared, String> {
  let server = normalize_server_url(&server_url)?;
  blocking(move || {
    let token = token_for(&server)?;
    let entry = fetch_catalog(&server, &token)?.into_iter().find(|s| s.snap_id == id).ok_or_else(|| format!("ทีมไม่ได้อนุมัติ snap \"{id}\" (หรือถูกถอนออกแล้ว)"))?;
    prepare_pinned(&staging_dir(&app)?, &user_dir(&app)?, &entry.pin(), CLONE_TIMEOUT)
  })
  .await
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::snap_install::Origin;

  const C: &str = "0123456789abcdef0123456789abcdef01234567";

  fn h() -> String {
    "ab".repeat(32)
  }

  fn item(id: &str) -> serde_json::Value {
    serde_json::json!({
      "snap_id": id, "name": "Go", "version": "1.0.0",
      "git_url": "https://github.com/acme/go.git", "git_ref": "v1",
      "commit_sha": C, "manifest_sha256": h(),
      "permissions": {"network": true, "fs": "home", "secrets": ["GO_TOKEN"], "future": 1},
      "approved_by": "olive", "approved_at": "2026-10-18T09:00:00Z", "required": true, "note": null,
      "added_later": "ignored"
    })
  }

  #[test]
  fn parses_the_catalog_and_drops_unusable_entries() {
    let mut bad_commit = item("bad-commit");
    bad_commit["commit_sha"] = "abc".into();
    let mut bad_url = item("bad-url");
    bad_url["git_url"] = "ext::sh -c x".into();
    let mut upper_sha = item("upper");
    upper_sha["manifest_sha256"] = "AB".repeat(32).into();
    let body = serde_json::json!({"items": [item("rust"), item("go"), bad_commit, bad_url, upper_sha, {"snap_id": "x"}, item("Bad")]}).to_string();
    let list = parse_list(&body).unwrap();
    assert_eq!(list.iter().map(|s| s.snap_id.as_str()).collect::<Vec<_>>(), ["go", "rust"]);
    let go = &list[0];
    assert_eq!(go.permissions, TeamPermissions { network: true, fs: FsAccess::Home, secrets: vec!["GO_TOKEN".into()] });
    assert!(go.required);
    assert_eq!(go.pin(), Pin { id: "go".into(), url: "https://github.com/acme/go.git".into(), git_ref: Some("v1".into()), commit: C.into(), sha256: h() });
    assert!(parse_list("{}").is_err());
    assert!(parse_list("<html>").is_err());
    assert_eq!(parse_list(r#"{"items":[]}"#).unwrap(), vec![]);
  }

  fn installed(origin: Option<Origin>) -> SnapInfo {
    let dir = tempfile::tempdir().unwrap();
    let snap_dir = dir.path().join("go");
    std::fs::create_dir_all(&snap_dir).unwrap();
    std::fs::write(snap_dir.join("snap.toml"), "id = \"go\"\nname = \"Go\"\nversion = \"1.2.0\"\n[permissions]\nnetwork = true\nsecrets = [\"T\"]\n").unwrap();
    let mut s = crate::snap::scan(dir.path(), Source::User, None, &TrustData::default()).remove(0);
    s.origin = origin;
    s
  }

  fn git_origin(url: &str) -> Option<Origin> {
    Some(Origin { url: Some(url.into()), git_ref: Some("main".into()), commit: Some(C.into()), path: None, installed_at: 1 })
  }

  #[test]
  fn approval_carries_the_installed_pin() {
    let s = installed(git_origin("git@github.com:acme/go.git"));
    let a = approval_for(&s, true, Some("  ใช้ทุก repo  ")).unwrap();
    assert_eq!((a.name.as_str(), a.version.as_str(), a.git_url.as_str(), a.git_ref.as_deref()), ("Go", "1.2.0", "git@github.com:acme/go.git", Some("main")));
    assert_eq!((a.commit_sha.as_str(), a.manifest_sha256.as_str()), (C, s.hash.as_str()));
    assert!(a.permissions.network && a.required);
    assert_eq!(a.note.as_deref(), Some("ใช้ทุก repo"));
    let wire = serde_json::to_value(&a).unwrap();
    assert_eq!(wire["permissions"], serde_json::json!({"network": true, "fs": "worktree", "secrets": ["T"]}));
    assert_eq!(approval_for(&s, false, Some(" ")).unwrap().note, None);
  }

  #[test]
  fn approval_refuses_what_the_team_cannot_reproduce() {
    let err = |s: &SnapInfo| approval_for(s, false, None).unwrap_err();
    assert!(err(&installed(None)).contains("ไม่ได้ติดตั้งจาก git"));
    assert!(err(&installed(Some(Origin { path: Some("/x".into()), ..Origin::default() }))).contains("ไม่ได้ติดตั้งจาก git"));
    assert!(err(&installed(git_origin("/tmp/remote.git"))).contains("path ในเครื่อง"));
    assert!(err(&installed(git_origin("file:///tmp/remote.git"))).contains("path ในเครื่อง"));
    let mut no_commit = installed(git_origin("https://github.com/acme/go.git"));
    no_commit.origin.as_mut().unwrap().commit = Some("abc".into());
    assert!(err(&no_commit).contains("commit"));
    let mut repo = installed(git_origin("https://github.com/acme/go.git"));
    repo.source = Source::Repo;
    assert!(err(&repo).contains("repo"));
    let mut broken = installed(git_origin("https://github.com/acme/go.git"));
    broken.error = Some("bad".into());
    assert!(err(&broken).contains("ข้อผิดพลาด"));
    let ok = installed(git_origin("https://github.com/acme/go.git"));
    assert!(approval_for(&ok, false, Some("a\nb")).unwrap_err().contains("บรรทัดเดียว"));
  }
}
