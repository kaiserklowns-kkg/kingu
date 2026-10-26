//! The floating workspace's browser tabs (Orca's): real child webviews of the main window,
//! placed by the panel's browser tab. A page gets its own webview with no Tauri API, and only
//! http(s) navigation is allowed.

use std::sync::Mutex;

use tauri::http::{header, Request, Response};
use tauri::{
  webview::{Webview, WebviewBuilder},
  AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, UriSchemeContext, Url, WebviewUrl,
};

/// The new-tab page's scheme: served here, so a blank tab opens on it without a data: URL
/// (WKWebView refuses those as a top-level page).
pub const SCHEME: &str = "kingu-newtab";

/// The http(s) pages the tabs loaded last, newest first: the new-tab page's Suggested tiles.
static RECENT: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn remember(url: &Url) {
  if !matches!(url.scheme(), "http" | "https") {
    return;
  }
  let mut recent = RECENT.lock().unwrap_or_else(|e| e.into_inner());
  let url = url.to_string();
  recent.retain(|u| u != &url);
  recent.insert(0, url);
  recent.truncate(8);
}

fn escape(s: &str) -> String {
  s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// A page's short name for a tile: the host, with its port when it has one.
fn name(url: &str) -> String {
  Url::parse(url).ok().and_then(|u| u.host_str().map(|h| match u.port() { Some(p) => format!("{h}:{p}"), None => h.to_owned() })).unwrap_or_else(|| url.to_owned())
}

/// The new-tab page (Orca's): dark, with Suggested tiles for the pages opened last, or the local
/// dev servers on a fresh start. It is written into `about:blank`, so the address bar stays blank.
fn new_tab_page() -> String {
  const GLOBE: &str = r#"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>"#;
  let recent = RECENT.lock().unwrap_or_else(|e| e.into_inner()).clone();
  let tiles: Vec<String> = if recent.is_empty() {
    ["http://localhost:3000", "http://localhost:5173", "http://localhost:8080", "http://localhost:8000"].iter().map(|u| (*u).to_owned()).collect()
  } else {
    recent
  };
  let tiles: String = tiles
    .iter()
    .map(|url| {
      format!(
        r#"<a class="tile" href="{href}" title="{href}"><span class="mark">{GLOBE}</span><span class="name">{name}</span></a>"#,
        href = escape(url),
        name = escape(&name(url))
      )
    })
    .collect();
  format!(
    r#"<!doctype html><html><head><meta charset="utf-8"><style>
:root {{ color-scheme: dark; }}
* {{ box-sizing: border-box; }}
body {{ margin: 0; min-height: 100vh; background: #1f1f1f; color: #cccccc; font: 13px/1.4 system-ui, -apple-system, sans-serif; }}
main {{ max-width: 1000px; margin: 0 auto; padding: 64px 32px; }}
h2 {{ margin: 0 0 20px; font-size: 12px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: #9d9d9d; }}
.grid {{ display: flex; flex-wrap: wrap; gap: 18px; }}
.tile {{ display: flex; flex-direction: column; align-items: center; gap: 8px; width: 96px; color: inherit; text-decoration: none; }}
.mark {{ display: grid; place-items: center; width: 88px; height: 88px; border-radius: 22px; background: #2b2b2b; color: #b4b4b4; }}
.mark svg {{ width: 30px; height: 30px; }}
.tile:hover .mark {{ background: #373737; }}
.name {{ max-width: 96px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; text-align: center; }}
</style></head><body><main><h2>Suggested</h2><div class="grid">{tiles}</div></main></body></html>"#
  )
}

/// The new-tab page's URL (Tauri serves custom schemes as `http://<scheme>.localhost` on Windows).
fn new_tab_url() -> String {
  if cfg!(any(windows, target_os = "android")) { format!("http://{SCHEME}.localhost/") } else { format!("{SCHEME}://localhost/") }
}

pub fn handle<R: Runtime>(_ctx: UriSchemeContext<'_, R>, _req: Request<Vec<u8>>) -> Response<Vec<u8>> {
  Response::builder()
    .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
    .body(new_tab_page().into_bytes())
    .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn allowed(url: &Url) -> bool {
  matches!(url.scheme(), "http" | "https" | "about" | SCHEME)
}

fn parsed(url: &str) -> Result<Url, String> {
  let url = Url::parse(url).map_err(|e| e.to_string())?;
  if allowed(&url) {
    Ok(url)
  } else {
    Err(format!("{url}: only http(s) pages open in the floating browser"))
  }
}

fn webview(app: &AppHandle, label: &str) -> Result<Webview, String> {
  app.get_webview(label).ok_or_else(|| format!("no browser tab {label}"))
}

/// Opens a browser tab's webview over the panel (logical px, relative to the window's client area).
#[tauri::command]
pub async fn floating_browser_open(
  app: AppHandle,
  label: String,
  url: String,
  x: f64,
  y: f64,
  width: f64,
  height: f64,
) -> Result<(), String> {
  if app.get_webview(&label).is_some() {
    return Ok(());
  }
  let url = parsed(&url)?;
  let start = if url.as_str() == "about:blank" { Url::parse(&new_tab_url()).map_err(|e| e.to_string())? } else { url };
  let window = app.get_window("main").ok_or("no main window")?;
  let emitter = app.clone();
  let tab = label.clone();
  let builder = WebviewBuilder::new(label, WebviewUrl::External(start))
    .on_navigation(|u| allowed(u))
    .on_page_load(move |_wv, payload| {
      if payload.event() != tauri::webview::PageLoadEvent::Finished {
        return;
      }
      let url = payload.url();
      remember(url);
      let _ = emitter.emit("floating-browser", serde_json::json!({ "label": tab, "url": url.to_string() }));
    });
  window.add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
  Ok(())
}

/// Moves and resizes a browser tab's webview with the panel.
#[tauri::command]
pub fn floating_browser_bounds(app: AppHandle, label: String, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
  let wv = webview(&app, &label)?;
  wv.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
  wv.set_size(LogicalSize::new(width, height)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn floating_browser_navigate(app: AppHandle, label: String, url: String) -> Result<(), String> {
  let url = parsed(&url)?;
  webview(&app, &label)?.navigate(url).map_err(|e| e.to_string())
}

/// Back and forward are the page's own history.
#[tauri::command]
pub fn floating_browser_history(app: AppHandle, label: String, back: bool) -> Result<(), String> {
  webview(&app, &label)?.eval(if back { "history.back()" } else { "history.forward()" }).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn floating_browser_reload(app: AppHandle, label: String) -> Result<(), String> {
  webview(&app, &label)?.reload().map_err(|e| e.to_string())
}

/// Shown only while its tab is active and the panel is open: a native view ignores CSS visibility.
#[tauri::command]
pub fn floating_browser_show(app: AppHandle, label: String, visible: bool) -> Result<(), String> {
  let wv = webview(&app, &label)?;
  if visible {
    wv.show()
  } else {
    wv.hide()
  }
  .map_err(|e| e.to_string())
}

/// The page in the system's browser (a site that refuses to be embedded still opens here).
#[tauri::command]
pub fn floating_browser_open_external(url: String) -> Result<(), String> {
  crate::system::open_web_url(&url)
}

#[tauri::command]
pub fn floating_browser_close(app: AppHandle, label: String) -> Result<(), String> {
  match app.get_webview(&label) {
    Some(wv) => wv.close().map_err(|e| e.to_string()),
    None => Ok(()),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn only_web_pages_open() {
    assert!(parsed("http://localhost:3000").is_ok());
    assert!(parsed("https://example.com/docs").is_ok());
    assert!(parsed("about:blank").is_ok());
    assert!(parsed("file:///etc/passwd").is_err());
    assert!(parsed("javascript:alert(1)").is_err());
    assert!(parsed("not a url").is_err());
  }
}
