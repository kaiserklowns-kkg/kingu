//! The artifact preview: an artifact is untrusted output of an agent, so it is shown in an
//! `<iframe sandbox="allow-scripts">` (no `allow-same-origin`: an opaque origin, no access to the
//! app's DOM, storage or cookies; no popups, forms, top navigation or downloads) whose document
//! comes from the `kingu-artifact:` scheme served here, with:
//!
//! - its own CSP header (bundle::csp): no `connect-src`, so no fetch, XHR or WebSocket at all —
//!   in particular none to Tauri's `ipc:` endpoint — scripts and styles only inline, from the
//!   artifact's own files or a CDN allowlist, no frames, objects, forms or `<base>`; plus the CSP
//!   `sandbox allow-scripts` directive, so the page is sandboxed even if it were ever loaded
//!   outside the iframe;
//! - only the files of one registered version: `/<token>/<name>`, where the token is random per
//!   preview (pages of other artifacts or projects cannot be named) and `name` is one of the
//!   version's files, read without following symlinks out of its folder;
//! - a click guard injected first: a link click never navigates the frame; web links go to the
//!   app as a message (the viewer opens them in the browser after checking the sender).
//!
//! Tauri's IPC: the `__TAURI_INTERNALS__` script and its per-launch invoke key are injected into
//! the main frame only on macOS and Linux (`for_main_frame_only`), so a sandboxed cross-origin
//! frame has neither and every IPC message it could post lacks the key Tauri checks first. On
//! Windows WebView2 injects initialization scripts into subframes too, so the preview is refused
//! there (`PreviewUnsupported`) and Export is the way to look at a page.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::http::{Request, Response, StatusCode, header};
use tauri::{Manager, Runtime, State, UriSchemeContext};

use super::bundle::{csp, inject_first, mime_of};
use super::{load, root_of, version_dir};
use crate::i18n::msg::ArtifactMsg;
use crate::projects::Projects;
use crate::tr;
use crate::workspace::Workspace;

pub const SCHEME: &str = "kingu-artifact";
/// Previews registered at once; the oldest goes first beyond this.
const MAX_PREVIEWS: usize = 64;
const MAX_HTML: usize = 8 * 1024 * 1024;

/// Whether this system can show previews safely (see the module comment).
pub const SUPPORTED: bool = cfg!(any(target_os = "macos", target_os = "linux"));

/// Injected before the page: link clicks never navigate the frame.
pub const CLICK_GUARD: &str = r#"<script>document.addEventListener('click',function(e){var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(!a)return;var h=a.getAttribute('href')||'';if(h.charAt(0)==='#')return;e.preventDefault();if(/^https?:$/i.test(a.protocol))parent.postMessage({kinguArtifact:'open',href:a.href},'*');},true);</script>"#;

/// What a preview token serves: a version folder's files, and optionally the page itself from
/// memory (a rendered Markdown page, or a teammate's shared page with no folder at all).
#[derive(Clone, Debug, Default)]
pub struct Preview {
  pub dir: Option<PathBuf>,
  /// The version's files (names); others are never served.
  pub files: Vec<String>,
  pub entry: String,
  pub page: Option<String>,
}

#[derive(Default)]
pub struct Previews {
  map: Mutex<(HashMap<String, Preview>, Vec<String>)>,
}

impl Previews {
  pub fn add(&self, p: Preview) -> Result<String, String> {
    let token = kingu_cli::protocol::new_token()?[..32].to_owned();
    let mut g = self.map.lock().unwrap_or_else(|e| e.into_inner());
    let (map, order) = &mut *g;
    map.insert(token.clone(), p);
    order.push(token.clone());
    while order.len() > MAX_PREVIEWS {
      let old = order.remove(0);
      map.remove(&old);
    }
    Ok(token)
  }

  pub fn remove(&self, token: &str) {
    let mut g = self.map.lock().unwrap_or_else(|e| e.into_inner());
    g.0.remove(token);
    g.1.retain(|t| t != token);
  }

  fn get(&self, token: &str) -> Option<Preview> {
    self.map.lock().unwrap_or_else(|e| e.into_inner()).0.get(token).cloned()
  }
}

/// The CSP header of every preview response.
pub fn header_csp() -> String {
  format!("{}; sandbox allow-scripts", csp(&format!("{SCHEME}: http://{SCHEME}.localhost")))
}

/// The response for `path` (`/<token>/<name>`) of a GET; anything else is a 4xx.
pub fn respond(previews: &Previews, method: &str, path: &str) -> Response<Vec<u8>> {
  let status = |code: StatusCode| Response::builder().status(code).header(header::CONTENT_TYPE, "text/plain").body(Vec::new()).expect("response");
  if method != "GET" {
    return status(StatusCode::METHOD_NOT_ALLOWED);
  }
  let path = path.trim_start_matches('/');
  let (token, rest) = path.split_once('/').unwrap_or((path, ""));
  let Some(preview) = (token.len() == 32 && token.bytes().all(|b| b.is_ascii_hexdigit())).then(|| previews.get(token)).flatten() else {
    return status(StatusCode::NOT_FOUND);
  };
  let Some(name) = super::bundle::local_ref(if rest.is_empty() { &preview.entry } else { rest }) else { return status(StatusCode::NOT_FOUND) };
  let body = if name == preview.entry {
    let page = match &preview.page {
      Some(p) => p.clone().into_bytes(),
      None => match preview.dir.as_deref().filter(|_| preview.files.contains(&name)).map(|d| super::read_inside(d, &name)) {
        Some(Ok(b)) => b,
        _ => return status(StatusCode::NOT_FOUND),
      },
    };
    inject_first(&String::from_utf8_lossy(&page), CLICK_GUARD).into_bytes()
  } else {
    match preview.dir.as_deref().filter(|_| preview.files.contains(&name)).map(|d| super::read_inside(d, &name)) {
      Some(Ok(b)) => b,
      _ => return status(StatusCode::NOT_FOUND),
    }
  };
  let mime = if name == preview.entry { "text/html; charset=utf-8" } else { mime_of(&name) };
  Response::builder()
    .status(StatusCode::OK)
    .header(header::CONTENT_TYPE, mime)
    .header("Content-Security-Policy", header_csp())
    .header("X-Content-Type-Options", "nosniff")
    .header(header::CACHE_CONTROL, "no-store")
    .header("Referrer-Policy", "no-referrer")
    .body(body)
    .expect("response")
}

/// The scheme handler (lib.rs registers it).
pub fn handle<R: Runtime>(ctx: UriSchemeContext<'_, R>, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
  let previews = ctx.app_handle().state::<Previews>();
  respond(&previews, req.method().as_str(), req.uri().path())
}

/// The iframe URL of a token (Tauri serves custom schemes as `http://<scheme>.localhost` on Windows and Android).
fn url_of(token: &str, entry: &str) -> String {
  if cfg!(any(windows, target_os = "android")) { format!("http://{SCHEME}.localhost/{token}/{entry}") } else { format!("{SCHEME}://localhost/{token}/{entry}") }
}

#[derive(serde::Serialize)]
pub struct PreviewUrl {
  pub url: String,
  pub token: String,
}

fn check_supported() -> Result<(), String> {
  if SUPPORTED { Ok(()) } else { Err(tr!(ArtifactMsg::PreviewUnsupported)) }
}

/// Registers a version for the preview. `html`: the page to show instead of the stored one (the
/// webview's rendering of a Markdown page); assets still come from the version's folder.
#[tauri::command]
pub fn artifact_preview(
  ws: State<'_, Workspace>,
  projects: State<'_, Projects>,
  previews: State<'_, Previews>,
  root: Option<String>,
  id: String,
  version: u32,
  html: Option<String>,
) -> Result<PreviewUrl, String> {
  check_supported()?;
  let root = root_of(&ws, &projects, root)?;
  let meta = load(&root, &id)?;
  let v = meta.version(version).ok_or_else(|| tr!(ArtifactMsg::VersionNotFound, id, version))?;
  // A Markdown page is shown as the HTML the webview made of it, under the HTML page's name.
  let entry = "index.html".to_owned();
  let page = match html {
    Some(h) if h.len() <= MAX_HTML => Some(h),
    Some(_) => return Err(tr!(ArtifactMsg::FileTooLarge, path = v.entry, max = MAX_HTML / (1024 * 1024))),
    None if v.entry != entry => return Err(tr!(ArtifactMsg::BadEntry, path = v.entry)),
    None => None,
  };
  let token = previews.add(Preview { dir: Some(version_dir(&root, &id, version)?), files: v.files.iter().map(|f| f.path.clone()).collect(), entry: entry.clone(), page })?;
  Ok(PreviewUrl { url: url_of(&token, &entry), token })
}

/// A page with no files of its own (a teammate's shared artifact, already self-contained).
#[tauri::command]
pub fn artifact_preview_html(previews: State<'_, Previews>, html: String) -> Result<PreviewUrl, String> {
  check_supported()?;
  if html.len() > MAX_HTML {
    return Err(tr!(ArtifactMsg::FileTooLarge, path = "index.html", max = MAX_HTML / (1024 * 1024)));
  }
  let entry = "index.html".to_owned();
  let token = previews.add(Preview { dir: None, files: Vec::new(), entry: entry.clone(), page: Some(html) })?;
  Ok(PreviewUrl { url: url_of(&token, &entry), token })
}

#[tauri::command]
pub fn artifact_preview_close(previews: State<'_, Previews>, token: String) {
  previews.remove(&token);
}

#[cfg(test)]
mod tests {
  use super::*;

  fn header(r: &Response<Vec<u8>>, name: &str) -> String {
    r.headers().get(name).map(|v| v.to_str().unwrap().to_owned()).unwrap_or_default()
  }

  #[test]
  fn serves_only_registered_files_with_the_sandbox_policy() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("index.html"), "<!DOCTYPE html><p>hi</p>").unwrap();
    std::fs::create_dir_all(dir.path().join("img")).unwrap();
    std::fs::write(dir.path().join("img/a.png"), "PNG").unwrap();
    std::fs::write(dir.path().join("secret.txt"), "no").unwrap();
    let previews = Previews::default();
    let token = previews.add(Preview { dir: Some(dir.path().into()), files: vec!["index.html".into(), "img/a.png".into()], entry: "index.html".into(), page: None }).unwrap();

    let page = respond(&previews, "GET", &format!("/{token}/"));
    assert_eq!(page.status(), StatusCode::OK);
    let body = String::from_utf8(page.body().clone()).unwrap();
    assert!(body.starts_with("<!DOCTYPE html><script>document.addEventListener('click'") && body.ends_with("<p>hi</p>"), "{body}");
    let policy = header(&page, "Content-Security-Policy");
    for part in ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'", "object-src 'none'", "sandbox allow-scripts"] {
      assert!(policy.contains(part), "{part} missing in {policy}");
    }
    assert!(!policy.contains("allow-same-origin") && !policy.contains("ipc:") && !policy.contains("'self'"));
    assert_eq!(header(&page, "X-Content-Type-Options"), "nosniff");
    assert_eq!(header(&page, "Content-Type"), "text/html; charset=utf-8");

    let img = respond(&previews, "GET", &format!("/{token}/img/a.png"));
    assert_eq!((img.status(), header(&img, "Content-Type").as_str(), img.body().as_slice()), (StatusCode::OK, "image/png", b"PNG".as_slice()));
    // Not listed, outside, another token, another method: nothing.
    for bad in [format!("/{token}/secret.txt"), format!("/{token}/../secret.txt"), format!("/{token}/img/%2e%2e/secret.txt"), format!("/{}/index.html", "0".repeat(32)), "/x/index.html".into(), "/".into()] {
      assert_eq!(respond(&previews, "GET", &bad).status(), StatusCode::NOT_FOUND, "{bad}");
    }
    assert_eq!(respond(&previews, "POST", &format!("/{token}/")).status(), StatusCode::METHOD_NOT_ALLOWED);
    previews.remove(&token);
    assert_eq!(respond(&previews, "GET", &format!("/{token}/")).status(), StatusCode::NOT_FOUND);
  }

  #[test]
  fn serves_a_page_from_memory_and_forgets_old_previews() {
    let previews = Previews::default();
    let token = previews.add(Preview { entry: "index.html".into(), page: Some("<h1>shared</h1>".into()), ..Default::default() }).unwrap();
    let r = respond(&previews, "GET", &format!("/{token}/index.html"));
    assert!(String::from_utf8(r.body().clone()).unwrap().ends_with("<h1>shared</h1>"));
    assert_eq!(respond(&previews, "GET", &format!("/{token}/a.png")).status(), StatusCode::NOT_FOUND);
    for _ in 0..MAX_PREVIEWS {
      previews.add(Preview::default()).unwrap();
    }
    assert_eq!(respond(&previews, "GET", &format!("/{token}/")).status(), StatusCode::NOT_FOUND);
  }
}
