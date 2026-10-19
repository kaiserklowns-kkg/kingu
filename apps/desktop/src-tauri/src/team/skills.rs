//! Team skills on the team server (`/v1/skills`): Kingu-managed skills members shared with their
//! org, pinned to a git commit and the skill's content hash. Only metadata goes to the server
//! (where to fetch the skill, its name, description and hash), never the skill's files.
//!
//! Sharing re-fetches the installed commit first and requires it to produce the installed hash,
//! so nobody is pinned to content only this computer has. Installing a team skill fetches the
//! pinned commit and refuses it unless it hashes to `content_sha256`; the user still reviews it.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::i18n::msg::{SkillMsg, TeamMsg};
use crate::skill_hub::install::{self, FETCH_TIMEOUT, OriginKind, Prepared};
use crate::skill_hub::package::{self, is_skill_name};
use crate::skill_hub::{skills_dir, source, staging_dir};
use crate::snap_install::{blocking, is_commit, is_sha256, parse_git_source};
use crate::tr;
use super::client::{HttpTransport, Keychain, SendError, TokenStore, normalize_server_url, server_message};

const MAX_NOTE_CHARS: usize = 500;

/// One shared skill (`GET /v1/skills` item; snake_case like the server).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TeamSkill {
  pub skill_name: String,
  pub description: String,
  pub git_url: String,
  #[serde(default)]
  pub git_ref: Option<String>,
  #[serde(default)]
  pub path: String,
  pub commit_sha: String,
  pub content_sha256: String,
  #[serde(default)]
  pub shared_by: String,
  #[serde(default)]
  pub shared_at: String,
  #[serde(default)]
  pub note: Option<String>,
}

impl TeamSkill {
  /// An entry the desktop can act on; anything else is dropped rather than half-shown.
  fn valid(&self) -> bool {
    let path_ok = self.path.is_empty() || package::entry_path(&self.path).as_deref() == Some(self.path.as_str());
    is_skill_name(&self.skill_name) && is_commit(&self.commit_sha) && is_sha256(&self.content_sha256) && path_ok && parse_git_source(&self.git_url).is_ok_and(|s| source::is_remote(&s.url))
  }
}

#[derive(Deserialize)]
struct ListBody {
  items: Vec<serde_json::Value>,
}

/// Parses `{"items": [...]}`, skipping malformed or unusable entries.
pub fn parse_list(body: &str) -> Result<Vec<TeamSkill>, String> {
  let list: ListBody = serde_json::from_str(body).map_err(|e| tr!(SkillMsg::TeamBadList, detail = e))?;
  let mut out: Vec<TeamSkill> = list.items.into_iter().filter_map(|v| serde_json::from_value::<TeamSkill>(v).ok()).filter(TeamSkill::valid).collect();
  out.sort_by(|a, b| a.skill_name.cmp(&b.skill_name));
  out.dedup_by(|a, b| a.skill_name == b.skill_name);
  Ok(out)
}

/// The body of `PUT /v1/skills/{name}`.
#[derive(Serialize, Debug, PartialEq)]
pub struct Share {
  pub description: String,
  pub git_url: String,
  pub git_ref: Option<String>,
  pub path: String,
  pub commit_sha: String,
  pub content_sha256: String,
  pub note: Option<String>,
}

/// What sharing installed skill `name` (in `skills_dir`) sends: its git origin, the installed
/// commit and hash. Only skills installed from a remote git repository and unchanged since
/// qualify.
pub fn share_for(skills_dir: &std::path::Path, name: &str, note: Option<&str>) -> Result<Share, String> {
  let dir = install::installed_dir(skills_dir, name)?;
  let origin = install::read_origin(&dir).ok_or_else(|| tr!(SkillMsg::NoOrigin, name))?;
  let url = match (&origin.kind, &origin.url) {
    (OriginKind::Git, Some(url)) if source::is_remote(url) => parse_git_source(url)?.url,
    _ => return Err(tr!(SkillMsg::TeamNeedsGit, name)),
  };
  let commit = origin.commit.clone().filter(|c| is_commit(c)).ok_or_else(|| tr!(SkillMsg::TeamNeedsGit, name))?;
  let skill = package::read_skill_dir(&dir)?;
  if skill.hash != origin.hash {
    return Err(tr!(SkillMsg::TeamChangedLocally, name));
  }
  let note = note.map(str::trim).filter(|n| !n.is_empty());
  if let Some(n) = note
    && (n.chars().count() > MAX_NOTE_CHARS || n.chars().any(char::is_control))
  {
    return Err(tr!(TeamMsg::NoteTooLong, max = MAX_NOTE_CHARS));
  }
  Ok(Share {
    description: skill.front.description,
    git_url: url,
    git_ref: origin.git_ref.clone().filter(|r| !is_commit(r)),
    path: origin.path.clone(),
    commit_sha: commit,
    content_sha256: skill.hash,
    note: note.map(String::from),
  })
}

// ---- commands -------------------------------------------------------------------

fn token_for(server: &str) -> Result<String, String> {
  Keychain.get(server).ok_or_else(|| tr!(TeamMsg::NotSignedIn))
}

fn send_error_text(e: SendError) -> String {
  match e {
    SendError::Unauthorized(m) if m.contains("403") => tr!(SkillMsg::TeamNotAllowed),
    SendError::Unauthorized(_) => tr!(TeamMsg::TeamTokenRejected),
    SendError::Retryable(m) => tr!(TeamMsg::Unreachable, detail = m),
    SendError::Permanent(m) => tr!(TeamMsg::ServerRefused, detail = m),
  }
}

fn fetch_list(http: &HttpTransport, server: &str, token: &str) -> Result<Vec<TeamSkill>, String> {
  parse_list(&http.request(reqwest::Method::GET, server, token, "/v1/skills", None).map_err(send_error_text)?)
}

#[derive(Serialize)]
pub struct TeamSkills {
  pub server: String,
  pub user_id: String,
  pub role: String,
  pub items: Vec<TeamSkill>,
}

/// The team's shared skills plus who the caller is (sharer or owner/lead may remove one).
#[tauri::command]
pub async fn team_skill_list(server_url: String) -> Result<TeamSkills, String> {
  let server = normalize_server_url(&server_url)?;
  blocking(move || {
    let token = token_for(&server)?;
    let http = HttpTransport::new()?;
    let me = http.me(&server, &token).map_err(send_error_text)?;
    let items = fetch_list(&http, &server, &token)?;
    let s = |k: &str| me[k].as_str().unwrap_or_default().to_owned();
    Ok(TeamSkills { user_id: s("user_id"), role: s("role"), server, items })
  })
  .await
}

/// Shares installed skill `name` with the team at its installed commit, after checking that the
/// commit still produces the installed content.
#[tauri::command]
pub async fn team_skill_share(app: AppHandle, server_url: String, name: String, note: Option<String>) -> Result<TeamSkill, String> {
  let server = normalize_server_url(&server_url)?;
  blocking(move || {
    let token = token_for(&server)?;
    let skills = skills_dir(&app)?;
    let share = share_for(&skills, &name, note.as_deref())?;
    let staging = staging_dir(&app)?;
    let check = install::prepare_pinned(&staging, &skills, &share.git_url, share.git_ref.as_deref(), &share.path, &share.commit_sha, &name, &share.content_sha256, FETCH_TIMEOUT)
      .map_err(|e| tr!(SkillMsg::TeamVerifyFailed, detail = e))?;
    install::cancel(&staging, &check.token);
    let body = serde_json::to_value(&share).map_err(|e| e.to_string())?;
    let text = HttpTransport::new()?.request(reqwest::Method::PUT, &server, &token, &format!("/v1/skills/{name}"), Some(&body)).map_err(send_error_text)?;
    let stored: TeamSkill = serde_json::from_str(&text).map_err(|e| tr!(TeamMsg::BadServerReply, detail = e, message = server_message(&text).unwrap_or_default()))?;
    log::info!("team skill {name}: shared at {}", stored.commit_sha);
    Ok(stored)
  })
  .await
}

#[tauri::command]
pub async fn team_skill_unshare(server_url: String, name: String) -> Result<(), String> {
  let server = normalize_server_url(&server_url)?;
  if !is_skill_name(&name) {
    return Err(tr!(SkillMsg::NameInvalid, name));
  }
  blocking(move || {
    let token = token_for(&server)?;
    HttpTransport::new()?.request(reqwest::Method::DELETE, &server, &token, &format!("/v1/skills/{name}"), None).map_err(send_error_text)?;
    log::info!("team skill {name}: unshared");
    Ok(())
  })
  .await
}

/// Stages team skill `name` at its pinned commit (verifying the hash); the webview then shows the
/// review and calls `skill_hub_commit`. The pin is read from the server again here rather than
/// taken from the webview.
#[tauri::command]
pub async fn team_skill_install(app: AppHandle, server_url: String, name: String) -> Result<Prepared, String> {
  let server = normalize_server_url(&server_url)?;
  blocking(move || {
    let token = token_for(&server)?;
    let entry = fetch_list(&HttpTransport::new()?, &server, &token)?.into_iter().find(|s| s.skill_name == name).ok_or_else(|| tr!(SkillMsg::TeamNotShared, name))?;
    install::prepare_pinned(&staging_dir(&app)?, &skills_dir(&app)?, &entry.git_url, entry.git_ref.as_deref(), &entry.path, &entry.commit_sha, &entry.skill_name, &entry.content_sha256, FETCH_TIMEOUT)
  })
  .await
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::skill_hub::package::tests::skill;

  const C: &str = "0123456789abcdef0123456789abcdef01234567";

  fn item(name: &str) -> serde_json::Value {
    serde_json::json!({
      "skill_name": name, "description": "PDF help",
      "git_url": "https://github.com/acme/skills.git", "git_ref": "main", "path": "skills/pdf",
      "commit_sha": C, "content_sha256": "ab".repeat(32),
      "shared_by": "dan", "shared_at": "2026-10-19T09:00:00Z", "note": null, "later": 1
    })
  }

  #[test]
  fn parses_the_list_and_drops_unusable_entries() {
    let mut bad_path = item("bad-path");
    bad_path["path"] = "../x".into();
    let mut local = item("local");
    local["git_url"] = "/srv/skills.git".into();
    let mut short = item("short");
    short["commit_sha"] = "abc".into();
    let body = serde_json::json!({"items": [item("pdf"), item("notes"), bad_path, local, short, item("Bad"), {"skill_name": "x"}]}).to_string();
    let list = parse_list(&body).unwrap();
    assert_eq!(list.iter().map(|s| s.skill_name.as_str()).collect::<Vec<_>>(), ["notes", "pdf"]);
    assert_eq!(list[1].path, "skills/pdf");
    assert!(parse_list("<html>").is_err());
  }

  /// A skill installed from git at commit `C` (written as `commit` would leave it).
  fn installed(tmp: &std::path::Path, url: &str, edit: bool) -> std::path::PathBuf {
    let skills = tmp.join("skills");
    let dir = skills.join("pdf");
    skill(&dir, "pdf", "PDF help");
    let hash = package::read_skill_dir(&dir).unwrap().hash;
    let origin = serde_json::json!({"kind": "git", "url": url, "ref": "main", "commit": C, "path": "skills/pdf", "hash": hash});
    std::fs::write(dir.join(install::ORIGIN_FILE), origin.to_string()).unwrap();
    if edit {
      std::fs::write(dir.join("extra.md"), "local change").unwrap();
    }
    skills
  }

  #[test]
  fn share_carries_the_installed_pin() {
    let tmp = tempfile::tempdir().unwrap();
    let skills = installed(tmp.path(), "https://github.com/acme/skills", false);
    let s = share_for(&skills, "pdf", Some("  สำหรับทีม  ")).unwrap();
    assert_eq!((s.git_url.as_str(), s.git_ref.as_deref(), s.path.as_str(), s.commit_sha.as_str()), ("https://github.com/acme/skills", Some("main"), "skills/pdf", C));
    assert_eq!(s.description, "PDF help");
    assert_eq!(s.note.as_deref(), Some("สำหรับทีม"));
    assert!(share_for(&skills, "pdf", Some("a\nb")).is_err());
  }

  #[test]
  fn share_refuses_what_the_team_cannot_reproduce() {
    let tmp = tempfile::tempdir().unwrap();
    let skills = installed(&tmp.path().join("a"), "/srv/skills.git", false);
    assert_eq!(share_for(&skills, "pdf", None), Err(tr!(SkillMsg::TeamNeedsGit, name = "pdf")));
    let skills = installed(&tmp.path().join("b"), "https://github.com/acme/skills", true);
    assert_eq!(share_for(&skills, "pdf", None), Err(tr!(SkillMsg::TeamChangedLocally, name = "pdf")));
    assert_eq!(share_for(&skills, "missing", None), Err(tr!(SkillMsg::NotInstalled, name = "missing")));
  }
}
