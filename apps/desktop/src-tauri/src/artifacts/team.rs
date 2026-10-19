//! "Share with team": a version, bundled into one HTML file (bundle.rs), goes to the team server
//! (`PUT /v1/artifacts/{id}`, apps/server/internal/api/artifacts.go), where teammates list it and
//! open it read-only in the same sandboxed preview. Only when the user asks, one page at a time;
//! the server refuses a page that looks like it holds a credential.

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use super::{Format, Shared, bundle_version, mark_shared, notify_changed, root_of, valid_id};
use crate::i18n::msg::{ArtifactMsg, TeamMsg};
use crate::projects::Projects;
use crate::snap_install::blocking;
use crate::team::client::{Keychain, SendError, TokenStore, classify, normalize_server_url, server_message};
use crate::tr;
use crate::workspace::Workspace;

/// The server's limit on a shared page (MaxArtifactHTMLBytes).
pub const MAX_SHARED_BYTES: usize = 2 * 1024 * 1024;

/// A shared artifact as `GET /v1/artifacts` lists it (`html` only from `GET /v1/artifacts/{id}`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TeamArtifact {
  pub artifact_id: String,
  pub title: String,
  #[serde(default)]
  pub description: Option<String>,
  pub format: Format,
  pub version: u32,
  #[serde(default)]
  pub size_bytes: u64,
  #[serde(default)]
  pub sha256: String,
  #[serde(default)]
  pub shared_by: String,
  #[serde(default)]
  pub shared_at: String,
  #[serde(default)]
  pub updated_at: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub html: Option<String>,
}

/// The body of `PUT /v1/artifacts/{id}`.
#[derive(Serialize, Debug, PartialEq)]
pub struct ShareBody {
  pub title: String,
  pub description: Option<String>,
  pub format: Format,
  pub version: u32,
  pub html: String,
}

#[derive(Deserialize)]
struct ListBody {
  items: Vec<serde_json::Value>,
}

/// `{"items": [...]}`, dropping entries with an unusable id.
pub fn parse_list(body: &str) -> Result<Vec<TeamArtifact>, String> {
  let list: ListBody = serde_json::from_str(body).map_err(|e| tr!(ArtifactMsg::BadTeamList, detail = e))?;
  Ok(list.items.into_iter().filter_map(|v| serde_json::from_value::<TeamArtifact>(v).ok()).filter(|a| valid_id(&a.artifact_id)).collect())
}

fn token_for(server: &str) -> Result<String, String> {
  Keychain.get(server).ok_or_else(|| tr!(TeamMsg::NotSignedIn))
}

fn error_text(e: SendError, body: &str) -> String {
  match e {
    SendError::Unauthorized(m) if m.contains("403") => tr!(ArtifactMsg::NotAllowed),
    SendError::Unauthorized(_) => tr!(TeamMsg::TeamTokenRejected),
    SendError::Retryable(m) => tr!(TeamMsg::Unreachable, detail = m),
    SendError::Permanent(m) => tr!(TeamMsg::ServerRefused, detail = server_message(body).map_or(m.clone(), |msg| format!("{m}: {msg}"))),
  }
}

fn client() -> Result<reqwest::blocking::Client, String> {
  crate::net_proxy::client_builder()?
    .timeout(Duration::from_secs(60))
    .connect_timeout(Duration::from_secs(5))
    .redirect(reqwest::redirect::Policy::none())
    .user_agent(concat!("kingu-desktop/", env!("CARGO_PKG_VERSION")))
    .build()
    .map_err(|e| e.to_string())
}

/// One request; the body on 2xx, else the error in the UI language.
fn send(req: reqwest::blocking::RequestBuilder, token: &str) -> Result<String, String> {
  let res = req.bearer_auth(token).send().map_err(|e| tr!(TeamMsg::Unreachable, detail = e.without_url()))?;
  let status = res.status().as_u16();
  let body = res.text().unwrap_or_default();
  classify(status, &body).map_err(|e| error_text(e, &body))?;
  Ok(body)
}

/// Shares version `version` of artifact `id` (its bundled page; `html`: the webview's rendering
/// of a Markdown page) and records where it went.
pub fn share(root: &Path, server: &str, token: &str, id: &str, version: u32, html: Option<String>) -> Result<TeamArtifact, String> {
  let (meta, page) = bundle_version(root, id, version, html)?;
  if page.len() > MAX_SHARED_BYTES {
    return Err(tr!(ArtifactMsg::ShareTooLarge, max = MAX_SHARED_BYTES / (1024 * 1024)));
  }
  let format = meta.version(version).map_or(Format::Html, |v| v.format);
  let body = ShareBody { title: meta.title.clone(), description: meta.description.clone(), format, version, html: page };
  let text = send(client()?.put(format!("{server}/v1/artifacts/{id}")).json(&body), token)?;
  let shared: TeamArtifact = serde_json::from_str(&text).map_err(|e| tr!(ArtifactMsg::BadTeamList, detail = e))?;
  let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
  mark_shared(root, id, Shared { server: server.to_owned(), version, shared_at: now })?;
  log::info!("shared artifact {id} v{version} with the team");
  Ok(shared)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn artifact_share_team(
  app: AppHandle,
  ws: State<'_, Workspace>,
  projects: State<'_, Projects>,
  server_url: String,
  root: Option<String>,
  id: String,
  version: u32,
  html: Option<String>,
) -> Result<TeamArtifact, String> {
  let server = normalize_server_url(&server_url)?;
  let root = root_of(&ws, &projects, root)?;
  let shared = blocking({
    let (root, id) = (root.clone(), id.clone());
    move || share(&root, &server, &token_for(&server)?, &id, version, html)
  })
  .await?;
  notify_changed(&app, &root.display().to_string(), &id);
  Ok(shared)
}

#[tauri::command]
pub async fn team_artifacts_list(server_url: String) -> Result<Vec<TeamArtifact>, String> {
  let server = normalize_server_url(&server_url)?;
  blocking(move || parse_list(&send(client()?.get(format!("{server}/v1/artifacts")), &token_for(&server)?)?)).await
}

/// A shared artifact with its page.
#[tauri::command]
pub async fn team_artifact_get(server_url: String, id: String) -> Result<TeamArtifact, String> {
  let server = normalize_server_url(&server_url)?;
  if !valid_id(&id) {
    return Err(tr!(ArtifactMsg::BadId, id));
  }
  blocking(move || {
    let text = send(client()?.get(format!("{server}/v1/artifacts/{id}")), &token_for(&server)?)?;
    serde_json::from_str(&text).map_err(|e| tr!(ArtifactMsg::BadTeamList, detail = e))
  })
  .await
}

#[tauri::command]
pub async fn team_artifact_delete(server_url: String, id: String) -> Result<(), String> {
  let server = normalize_server_url(&server_url)?;
  if !valid_id(&id) {
    return Err(tr!(ArtifactMsg::BadId, id));
  }
  blocking(move || send(client()?.delete(format!("{server}/v1/artifacts/{id}")), &token_for(&server)?).map(|_| ())).await
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_the_team_list() {
    let body = r#"{"items":[
      {"artifact_id":"0123456789abcdef","title":"Q3","description":null,"format":"html","version":2,"size_bytes":10,"sha256":"x","shared_by":"olive","shared_at":"2026-10-01T00:00:00Z","updated_at":"2026-10-02T00:00:00Z"},
      {"artifact_id":"../../x","title":"bad","format":"html","version":1},
      {"artifact_id":"fedcba9876543210","title":"md","format":"markdown","version":1,"extra":true}
    ]}"#;
    let list = parse_list(body).unwrap();
    assert_eq!(list.iter().map(|a| a.artifact_id.as_str()).collect::<Vec<_>>(), ["0123456789abcdef", "fedcba9876543210"]);
    assert_eq!((list[0].version, list[0].shared_by.as_str(), list[1].format), (2, "olive", Format::Markdown));
    assert!(parse_list("nope").is_err());
  }

  #[test]
  fn share_body_matches_the_server() {
    let body = ShareBody { title: "t".into(), description: None, format: Format::Markdown, version: 3, html: "<p>".into() };
    assert_eq!(serde_json::to_value(&body).unwrap(), serde_json::json!({ "title": "t", "description": null, "format": "markdown", "version": 3, "html": "<p>" }));
  }

  #[test]
  fn refuses_pages_too_large_to_share() {
    let (root, src) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let page = src.path().join("p.html");
    std::fs::write(&page, "x".repeat(MAX_SHARED_BYTES + 1)).unwrap();
    let p = super::super::publish(root.path(), &super::super::Publish { file: page, source: "cli".into(), ..Default::default() }).unwrap();
    // Refused before any request (the server URL is never contacted).
    let err = share(root.path(), "http://127.0.0.1:9", "kgu_x", &p.id, 1, None).unwrap_err();
    assert!(err.contains("MB"), "{err}");
  }
}
