//! Snap views (`[[views]]`, phase 3): a snap's HTML page in the side bar or the panel, shown the
//! way artifact previews are (artifacts/preview.rs), only stricter:
//!
//! - `<iframe sandbox="allow-scripts">` (no `allow-same-origin`): an opaque origin with no access
//!   to the app's DOM, storage or cookies, no popups, forms, top navigation or downloads;
//! - the page comes from the `kingu-snap-view:` scheme served here under a random per-open token,
//!   with a CSP that allows inline scripts and styles and `data:` images and fonts, and nothing
//!   else: no `connect-src` (no fetch, XHR or WebSocket — none to Tauri's `ipc:` either), no other
//!   scripts, frames, objects, forms or `<base>`; plus `sandbox allow-scripts` in the header so it
//!   stays sandboxed even outside the frame. A view is one self-contained page;
//! - no Tauri IPC: on macOS and Linux the IPC script and its key go to the main frame only (see
//!   the preview's module comment); on Windows views are refused, like previews;
//! - the page talks to the app only through `postMessage` with the bridge injected first
//!   ([`BRIDGE`], `window.kingu`): the webview (src/lib/snaps/viewBridge.ts) answers what the
//!   manifest lets this view do — read the settings it lists, run the tasks it lists, show
//!   notifications if it says so — and nothing else.
//!
//! The page is read when the view opens: a file the manifest names, hashed for trust and checked
//! against the hash it was listed with. Only active snaps' views open, and a repo snap's views
//! not in Restricted Mode.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::http::{Request, Response, StatusCode, header};
use tauri::{AppHandle, Manager, Runtime, State, UriSchemeContext};

use crate::i18n::msg::SnapContribMsg;
use crate::snap::{self, SnapInfo, Source, TrustData};
use crate::snap_contrib::View;
use crate::tr;
use crate::workspace::Workspace;

pub const SCHEME: &str = "kingu-snap-view";
const MAX_PAGE: u64 = 2 * 1024 * 1024;
/// Views open at once (every window); the oldest goes first beyond this.
const MAX_OPEN: usize = 32;

/// Like artifact previews: no IPC isolation for subframes on Windows.
pub const SUPPORTED: bool = cfg!(any(target_os = "macos", target_os = "linux"));

/// The response CSP: inline script and style, `data:` images and fonts, nothing else.
pub const CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'; sandbox allow-scripts";

/// Injected before the page. `window.kingu` posts requests to the app and resolves their answers;
/// links never navigate the frame.
pub const BRIDGE: &str = r#"<script>(function(){var n=0,p={},T='kinguSnapView';addEventListener('message',function(e){if(e.source!==parent)return;var d=e.data;if(!d||d[T]!==1)return;if(d.event==='theme'){document.documentElement.setAttribute('data-kingu-theme',d.kind);dispatchEvent(new CustomEvent('kingu-theme',{detail:d.kind}));return;}var c=p[d.id];if(!c)return;delete p[d.id];if(typeof d.error==='string')c[1](new Error(d.error));else c[0](d.result);});function call(m,a){return new Promise(function(r,j){var id=++n;p[id]=[r,j];var o={id:id,method:m,params:a||{}};o[T]=1;parent.postMessage(o,'*');});}window.kingu=Object.freeze({context:function(){return call('context');},getSetting:function(k){return call('getSetting',{key:String(k)});},runTask:function(t){return call('runTask',{task:String(t)});},notify:function(m,s){return call('notify',{message:String(m),severity:s||'info'});}});document.addEventListener('click',function(e){var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(a&&(a.getAttribute('href')||'').charAt(0)!=='#')e.preventDefault();},true);})();</script>"#;

/// `page` with [`BRIDGE`] first: after a leading doctype (so the page keeps standards mode), else
/// before everything.
pub fn with_bridge(page: &str) -> String {
  let trimmed = page.trim_start();
  if trimmed.len() >= 9 && trimmed[..9].eq_ignore_ascii_case("<!doctype")
    && let Some(end) = trimmed.find('>')
  {
    return format!("{}{BRIDGE}{}", &trimmed[..=end], &trimmed[end + 1..]);
  }
  format!("{BRIDGE}{page}")
}

#[derive(Default)]
pub struct SnapViews {
  pages: Mutex<(HashMap<String, String>, Vec<String>)>,
}

impl SnapViews {
  pub fn add(&self, token: String, page: String) {
    let mut g = self.pages.lock().unwrap_or_else(|e| e.into_inner());
    let (map, order) = &mut *g;
    map.insert(token.clone(), page);
    order.push(token);
    while order.len() > MAX_OPEN {
      let old = order.remove(0);
      map.remove(&old);
    }
  }

  pub fn remove(&self, token: &str) {
    let mut g = self.pages.lock().unwrap_or_else(|e| e.into_inner());
    g.0.remove(token);
    g.1.retain(|t| t != token);
  }

  fn get(&self, token: &str) -> Option<String> {
    self.pages.lock().unwrap_or_else(|e| e.into_inner()).0.get(token).cloned()
  }
}

/// The response for `path` (`/<token>/index.html`) of a GET; anything else is a 4xx.
pub fn respond(views: &SnapViews, method: &str, path: &str) -> Response<Vec<u8>> {
  let status = |code: StatusCode| Response::builder().status(code).header(header::CONTENT_TYPE, "text/plain").body(Vec::new()).expect("response");
  if method != "GET" {
    return status(StatusCode::METHOD_NOT_ALLOWED);
  }
  let path = path.trim_start_matches('/');
  let (token, rest) = path.split_once('/').unwrap_or((path, ""));
  let page = (token.len() == 32 && token.bytes().all(|b| b.is_ascii_hexdigit()) && (rest.is_empty() || rest == "index.html")).then(|| views.get(token)).flatten();
  let Some(page) = page else { return status(StatusCode::NOT_FOUND) };
  Response::builder()
    .status(StatusCode::OK)
    .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
    .header("Content-Security-Policy", CSP)
    .header("X-Content-Type-Options", "nosniff")
    .header(header::CACHE_CONTROL, "no-store")
    .header("Referrer-Policy", "no-referrer")
    .body(page.into_bytes())
    .expect("response")
}

/// The scheme handler (lib.rs registers it).
pub fn handle<R: Runtime>(ctx: UriSchemeContext<'_, R>, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
  let views = ctx.app_handle().state::<SnapViews>();
  respond(&views, req.method().as_str(), req.uri().path())
}

fn url_of(token: &str) -> String {
  if cfg!(any(windows, target_os = "android")) { format!("http://{SCHEME}.localhost/{token}/index.html") } else { format!("{SCHEME}://localhost/{token}/index.html") }
}

/// The view `view` of `snap` if it may open here, with the SHA-256 its page was listed with.
pub fn view_of<'a>(snap: &'a SnapInfo, trusted_workspace: bool, view: &str) -> Result<(&'a View, &'a str), String> {
  if snap.error.is_some() || !snap.trusted || snap.overridden {
    return Err(tr!(SnapContribMsg::SnapInactive, id = snap.id));
  }
  let v = snap.contributes.views.iter().find(|v| v.id == view).ok_or_else(|| tr!(SnapContribMsg::NoSuchView, id = snap.id, view))?;
  if snap.source == Source::Repo && !trusted_workspace {
    return Err(tr!(SnapContribMsg::RestrictedMode, name = v.name));
  }
  let sha = snap.contributes.files.iter().find(|f| f.path == v.path).map(|f| f.sha256.as_str()).ok_or_else(|| tr!(SnapContribMsg::FileMissing, path = v.path))?;
  Ok((v, sha))
}

/// The page of view `view` of snap `snap`, read and checked, with the bridge in front.
pub fn page_of(snap: &SnapInfo, trusted_workspace: bool, view: &str) -> Result<String, String> {
  let (v, sha) = view_of(snap, trusted_workspace, view)?;
  let bytes = crate::snap_contrib::read_snap_file(std::path::Path::new(&snap.dir), &v.path, Some(sha), MAX_PAGE).map_err(|e| {
    if e.contains(&format!("{} MB", MAX_PAGE / 1024 / 1024)) { tr!(SnapContribMsg::ViewTooLarge, path = v.path, mb = MAX_PAGE / 1024 / 1024) } else { e }
  })?;
  let text = String::from_utf8(bytes).map_err(|_| tr!(SnapContribMsg::NotUtf8, path = v.path))?;
  Ok(with_bridge(&text))
}

#[derive(serde::Serialize)]
pub struct ViewUrl {
  pub url: String,
  pub token: String,
}

/// Opens a view: registers its page under a new token and returns the frame's URL.
#[tauri::command]
pub async fn snap_view_open(app: AppHandle, ws: Workspace, source: Source, id: String, view: String) -> Result<ViewUrl, String> {
  if !SUPPORTED {
    return Err(tr!(SnapContribMsg::ViewUnsupported));
  }
  tauri::async_runtime::spawn_blocking(move || {
    let config = snap::config_dir(&app)?;
    let trust = TrustData::load(&config.join(snap::TRUST_FILE));
    let snap = snap::discover(&config.join(snap::USER_DIR), ws.current().as_deref(), &trust)
      .into_iter()
      .find(|s| s.source == source && s.id == id)
      .ok_or_else(|| tr!(SnapContribMsg::SnapNotFound, id))?;
    let trusted = crate::workspace_trust::ws_trusted(crate::system::config_dir(), &ws);
    let page = page_of(&snap, trusted, &view)?;
    let token = kingu_cli::protocol::new_token()?[..32].to_owned();
    app.state::<SnapViews>().add(token.clone(), page);
    Ok(ViewUrl { url: url_of(&token), token })
  })
  .await
  .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn snap_view_close(views: State<'_, SnapViews>, token: String) {
  views.remove(&token);
}

#[cfg(test)]
mod tests {
  use super::*;

  const SNAP: &str = r#"
id = "board"
name = "Board"
version = "1"

[[settings]]
key = "greeting"
type = "string"
default = "hi"

[[views]]
id = "main"
name = "Board"
location = "panel"
path = "views/main.html"
settings = ["greeting"]
"#;

  fn snap(source: Source, trusted: bool) -> (tempfile::TempDir, SnapInfo) {
    let tmp = tempfile::tempdir().unwrap();
    let d = tmp.path().join("board");
    std::fs::create_dir_all(d.join("views")).unwrap();
    std::fs::write(d.join("snap.toml"), SNAP).unwrap();
    std::fs::write(d.join("views/main.html"), "<!DOCTYPE html><p>hello</p>").unwrap();
    let mut s = snap::read_snap(&d, "board", source, None, &TrustData::default());
    s.trusted = trusted;
    (tmp, s)
  }

  #[test]
  fn the_bridge_goes_first_and_keeps_the_doctype() {
    assert_eq!(with_bridge("<!DOCTYPE html><p>x</p>"), format!("<!DOCTYPE html>{BRIDGE}<p>x</p>"));
    assert_eq!(with_bridge("<p>x</p>"), format!("{BRIDGE}<p>x</p>"));
    assert!(BRIDGE.contains("parent.postMessage") && !BRIDGE.contains("__TAURI"));
  }

  #[test]
  fn opens_only_active_snaps_views() {
    let (_tmp, s) = snap(Source::User, true);
    let page = page_of(&s, false, "main").unwrap();
    assert!(page.starts_with("<!DOCTYPE html><script>") && page.ends_with("<p>hello</p>"));
    assert!(page_of(&s, true, "nope").unwrap_err().contains("no view \"nope\""));
    let (_tmp, untrusted) = snap(Source::Repo, false);
    assert!(page_of(&untrusted, true, "main").unwrap_err().contains("not active"));
    let (_tmp, repo) = snap(Source::Repo, true);
    assert!(page_of(&repo, false, "main").unwrap_err().contains("Restricted Mode"));
    assert!(page_of(&repo, true, "main").is_ok());
  }

  #[test]
  fn a_page_changed_since_listing_is_refused() {
    let (_tmp, s) = snap(Source::User, true);
    std::fs::write(std::path::Path::new(&s.dir).join("views/main.html"), "<p>swapped</p>").unwrap();
    assert!(page_of(&s, true, "main").unwrap_err().contains("changed since"));
  }

  #[test]
  fn serves_registered_pages_with_the_strict_csp() {
    let views = SnapViews::default();
    let token = "0123456789abcdef0123456789abcdef".to_string();
    views.add(token.clone(), "<p>v</p>".into());
    let ok = respond(&views, "GET", &format!("/{token}/index.html"));
    assert_eq!(ok.status(), StatusCode::OK);
    let csp = ok.headers().get("Content-Security-Policy").unwrap().to_str().unwrap();
    assert!(csp.starts_with("default-src 'none'") && csp.contains("sandbox allow-scripts"));
    // No connect-src: fetch/XHR/WebSocket (and Tauri's ipc:) fall under default-src 'none'.
    assert!(!csp.contains("connect-src") && !csp.contains("ipc:") && !csp.contains("http"));
    assert_eq!(ok.body(), b"<p>v</p>");
    assert_eq!(respond(&views, "GET", &format!("/{token}/other.js")).status(), StatusCode::NOT_FOUND);
    assert_eq!(respond(&views, "GET", "/ffff/index.html").status(), StatusCode::NOT_FOUND);
    assert_eq!(respond(&views, "POST", &format!("/{token}/index.html")).status(), StatusCode::METHOD_NOT_ALLOWED);
    views.remove(&token);
    assert_eq!(respond(&views, "GET", &format!("/{token}/index.html")).status(), StatusCode::NOT_FOUND);
  }
}
