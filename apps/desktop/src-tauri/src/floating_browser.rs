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

/// Where Design Mode's picker sends the picked element: a navigation to Kingu's own scheme, which
/// `on_navigation` takes and cancels (the page has no Tauri API). The data rides in the fragment.
fn pick_url() -> String {
  format!("{}pick", new_tab_url())
}

/// The picked element, when `url` is a pick: (base64 JSON decoded).
pub fn picked(url: &Url) -> Option<serde_json::Value> {
  let base = Url::parse(&pick_url()).ok()?;
  if url.scheme() != base.scheme() || url.host_str() != base.host_str() || url.path() != base.path() {
    return None;
  }
  use base64::Engine as _;
  let bytes = base64::engine::general_purpose::STANDARD.decode(url.fragment()?.as_bytes()).ok()?;
  if bytes.len() > 64 * 1024 {
    return None;
  }
  let mut v: serde_json::Value = serde_json::from_slice(&bytes).ok().filter(serde_json::Value::is_object)?;
  // The page wrote it: the source location stays one short line of text (never opened).
  if let Some(obj) = v.as_object_mut() {
    let ok = obj.get("source").and_then(|s| s.as_str()).is_some_and(|s| s.chars().count() <= SOURCE_MAX && !s.chars().any(char::is_control));
    if !ok {
      obj.remove("source");
    }
  }
  Some(v)
}

/// Orca's `GRAB_BUDGET.sourceFileMaxLength` (500) plus the " (truncated)" the picker appends.
const SOURCE_MAX: usize = 512;

/// Orca's Design Mode picker (docs browser/design-mode.mdx): outlines the element under the
/// pointer; a click takes its selector, trimmed HTML, a few computed styles, its box, its text and,
/// in a React dev build, its source location; Escape stops. Turning it off removes it.
const PICK_SCRIPT: &str = r#"(() => {
  const w = window;
  if (w.__kinguPick) w.__kinguPick.stop();
  if (!__ON__) return;
  const BASE = __BASE__;
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #3b82f6;background:rgba(59,130,246,.12);border-radius:2px';
  document.documentElement.appendChild(box);
  const esc = (s) => (w.CSS && CSS.escape ? CSS.escape(s) : s);
  const sel = (el) => {
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 6 && el !== document.documentElement) {
      if (el.id) { parts.unshift('#' + esc(el.id)); break; }
      let p = el.tagName.toLowerCase();
      if (el.classList.length) p += '.' + [...el.classList].slice(0, 2).map(esc).join('.');
      const parent = el.parentElement;
      if (parent) { const same = [...parent.children].filter((c) => c.tagName === el.tagName); if (same.length > 1) p += ':nth-of-type(' + (same.indexOf(el) + 1) + ')'; }
      parts.unshift(p);
      el = parent;
    }
    return parts.join(' > ');
  };
  // Orca's grab-guest-react-script.ts: the file:line:col a React dev build records on the fiber
  // (`_debugSource`, or its owner's), first found walking up at most 35 fibers; dev-server
  // prefixes and query strings stripped; dropped if it looks like a secret; at most 500 chars.
  const SECRETS = ['access_token','auth_token','api_key','apikey','client_secret','oauth_state','x-amz-','session_id','sessionid','csrf','secret','password','passwd'];
  const cleanSource = (p) => String(p)
    .replace(/[?#].*$/, '')
    .replace(/^turbopack:\/\/\/\[project\]\//, '')
    .replace(/^webpack-internal:\/\/\/\.\//, '')
    .replace(/^webpack-internal:\/\/\//, '')
    .replace(/^webpack:\/\/\/\.\//, '')
    .replace(/^webpack:\/\/\//, '')
    .replace(/^turbopack:\/\/\//, '')
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/^file:\/\/\//, '/')
    .replace(/^\([^)]+\)\/\.\//, '')
    .replace(/^\.\//, '');
  const source = (el) => {
    try {
      const k = Object.keys(el).find((n) => n.indexOf('__reactFiber$') === 0 || n.indexOf('__reactInternalInstance$') === 0);
      let fiber = k ? el[k] : null;
      for (let depth = 0; fiber && depth < 35; depth++, fiber = fiber.return) {
        const s = fiber._debugSource || (fiber._debugOwner && fiber._debugOwner._debugSource);
        if (s && s.fileName && s.lineNumber) {
          const out = cleanSource(s.fileName) + ':' + s.lineNumber + (s.columnNumber !== undefined ? ':' + s.columnNumber : '');
          const low = out.toLowerCase();
          if (SECRETS.some((x) => low.indexOf(x) !== -1)) continue;
          return out.length > 500 ? out.slice(0, 500) + ' (truncated)' : out;
        }
      }
    } catch (_) {}
    return null;
  };
  const KEYS = ['display','position','width','height','margin','padding','color','background-color','font-family','font-size','font-weight','line-height','border','border-radius','gap','flex-direction','justify-content','align-items'];
  const move = (e) => { const r = e.target.getBoundingClientRect(); Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' }); };
  const click = (e) => {
    e.preventDefault(); e.stopPropagation();
    const el = e.target, cs = getComputedStyle(el), styles = {};
    for (const k of KEYS) { const v = cs.getPropertyValue(k); if (v) styles[k] = v; }
    const r = el.getBoundingClientRect();
    const html = el.outerHTML.length > 3000 ? el.outerHTML.slice(0, 3000) + '…' : el.outerHTML;
    const data = { url: location.href, selector: sel(el), html, styles, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, text: (el.innerText || '').slice(0, 300) };
    const src = source(el);
    if (src) data.source = src;
    stop();
    const json = JSON.stringify(data);
    location.href = BASE + '#' + btoa(unescape(encodeURIComponent(json)));
  };
  const key = (e) => { if (e.key === 'Escape') stop(); };
  const stop = () => { document.removeEventListener('mousemove', move, true); document.removeEventListener('click', click, true); document.removeEventListener('keydown', key, true); box.remove(); delete w.__kinguPick; };
  document.addEventListener('mousemove', move, true);
  document.addEventListener('click', click, true);
  document.addEventListener('keydown', key, true);
  w.__kinguPick = { stop };
})();"#;

pub fn pick_script(on: bool) -> String {
  PICK_SCRIPT.replace("__ON__", if on { "true" } else { "false" }).replace("__BASE__", &serde_json::to_string(&pick_url()).unwrap_or_default())
}

/// Orca's Design Mode on (or off) in a browser tab.
#[tauri::command]
pub fn floating_browser_pick(app: AppHandle, label: String, on: bool) -> Result<(), String> {
  webview(&app, &label)?.eval(pick_script(on)).map_err(|e| e.to_string())
}

/// A browser profile's own cookies and storage (Orca's browser profiles): a WebKit data store per
/// profile name (macOS 14+); the empty name is the shared default store.
fn profile_store(profile: &str) -> Option<[u8; 16]> {
  if profile.trim().is_empty() {
    return None;
  }
  use sha2::{Digest, Sha256};
  let h = Sha256::digest(format!("kingu-browser-profile:{}", profile.trim()).as_bytes());
  let mut id = [0u8; 16];
  id.copy_from_slice(&h[..16]);
  Some(id)
}

/// Where a download goes: the Downloads folder, under the page's name for it, never over a file.
pub fn download_path(dir: &std::path::Path, suggested: &std::path::Path, url: &Url) -> std::path::PathBuf {
  let from_url = url.path_segments().and_then(|mut s| s.next_back().map(str::to_owned)).filter(|n| !n.is_empty());
  let name = suggested.file_name().map(|n| n.to_string_lossy().into_owned()).filter(|n| !n.is_empty()).or(from_url).unwrap_or_else(|| "download".into());
  let name: String = name.chars().map(|c| if matches!(c, '/' | '\\' | ':' | '\0') { '_' } else { c }).collect();
  let name = if name.starts_with('.') { format!("_{name}") } else { name };
  let p = std::path::Path::new(&name);
  let (stem, ext) = (p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(), p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default());
  let mut out = dir.join(&name);
  let mut n = 2;
  while out.exists() {
    out = dir.join(format!("{stem} ({n}){ext}"));
    n += 1;
  }
  out
}

/// Shows a finished download in Finder: only a file in the Downloads folder.
#[tauri::command]
pub fn floating_browser_reveal_download(app: AppHandle, path: String) -> Result<(), String> {
  let dir = app.path().download_dir().map_err(|e| e.to_string())?;
  let p = std::path::Path::new(&path);
  let (Ok(real), Ok(base)) = (p.canonicalize(), dir.canonicalize()) else { return Err("not a download".into()) };
  if !real.starts_with(&base) {
    return Err("not a download".into());
  }
  crate::fileops::reveal_path(&real)
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
#[allow(clippy::too_many_arguments)] // a Tauri command: its arguments are the IPC payload
pub async fn floating_browser_open(
  app: AppHandle,
  label: String,
  url: String,
  x: f64,
  y: f64,
  width: f64,
  height: f64,
  profile: Option<String>,
) -> Result<(), String> {
  if app.get_webview(&label).is_some() {
    return Ok(());
  }
  let url = parsed(&url)?;
  let start = if url.as_str() == "about:blank" { Url::parse(&new_tab_url()).map_err(|e| e.to_string())? } else { url };
  let window = app.get_window("main").ok_or("no main window")?;
  let emitter = app.clone();
  let tab = label.clone();
  let (picker, pick_tab) = (app.clone(), label.clone());
  let (loader, load_tab) = (app.clone(), label.clone());
  let downloads = app.path().download_dir().ok();
  let mut builder = WebviewBuilder::new(label, WebviewUrl::External(start))
    .on_navigation(move |u| {
      if let Some(data) = picked(u) {
        let _ = picker.emit("browser-pick", serde_json::json!({ "label": pick_tab, "element": data }));
        return false;
      }
      allowed(u)
    })
    // Orca's downloads: into the Downloads folder, each reported to the tab's surface.
    .on_download(move |_wv, event| {
      match event {
        tauri::webview::DownloadEvent::Requested { url, destination } => {
          let Some(dir) = downloads.as_deref() else { return false };
          *destination = download_path(dir, destination, &url);
          let _ = loader.emit("browser-download", serde_json::json!({ "label": load_tab, "url": url.to_string(), "path": destination.display().to_string(), "state": "started" }));
        }
        tauri::webview::DownloadEvent::Finished { url, path, success } => {
          let _ = loader.emit("browser-download", serde_json::json!({ "label": load_tab, "url": url.to_string(), "path": path.map(|p| p.display().to_string()), "state": if success { "done" } else { "failed" } }));
        }
        _ => {}
      }
      true
    })
    .on_page_load(move |_wv, payload| {
      if payload.event() != tauri::webview::PageLoadEvent::Finished {
        return;
      }
      let url = payload.url();
      remember(url);
      let _ = emitter.emit("floating-browser", serde_json::json!({ "label": tab, "url": url.to_string() }));
    });
  if let Some(id) = profile.as_deref().and_then(profile_store) {
    builder = builder.data_store_identifier(id);
  }
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

/// Orca's browser zoom (⌘= / ⌘- / ⌘0): the page's own scale, 25%–500%.
#[tauri::command]
pub fn floating_browser_zoom(app: AppHandle, label: String, factor: f64) -> Result<(), String> {
  webview(&app, &label)?.set_zoom(zoom_factor(factor)).map_err(|e| e.to_string())
}

pub fn zoom_factor(f: f64) -> f64 {
  if f.is_finite() { f.clamp(0.25, 5.0) } else { 1.0 }
}

/// Orca's Find in Page: the page's own `window.find` (highlights and scrolls to the next match).
#[tauri::command]
pub fn floating_browser_find(app: AppHandle, label: String, text: String, backwards: bool) -> Result<(), String> {
  webview(&app, &label)?.eval(find_script(&text, backwards)).map_err(|e| e.to_string())
}

/// The text goes in as a JSON string, so nothing it holds runs as script.
pub fn find_script(text: &str, backwards: bool) -> String {
  let q = serde_json::to_string(&text.chars().take(500).collect::<String>()).unwrap_or_else(|_| "\"\"".into());
  format!("window.find({q}, false, {backwards}, true, false, false, false)")
}

/// Orca's browser DevTools (Web Inspector). Builds without Tauri's `devtools` feature have it only in debug.
#[tauri::command]
pub fn floating_browser_devtools(app: AppHandle, label: String) -> Result<(), String> {
  let wv = webview(&app, &label)?;
  #[cfg(any(debug_assertions, feature = "devtools"))]
  {
    if wv.is_devtools_open() {
      wv.close_devtools();
    } else {
      wv.open_devtools();
    }
    Ok(())
  }
  #[cfg(not(any(debug_assertions, feature = "devtools")))]
  {
    let _ = wv;
    Err("DevTools are not part of this build".into())
  }
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

  #[test]
  fn design_mode_picks_come_back_only_through_kingus_own_url() {
    use base64::Engine as _;
    let json = r##"{"selector":"#a","html":"<b>ก</b>"}"##;
    let enc = base64::engine::general_purpose::STANDARD.encode(json);
    let u = Url::parse(&format!("{}#{enc}", pick_url())).unwrap();
    assert_eq!(picked(&u).unwrap()["html"], "<b>ก</b>");
    assert!(picked(&Url::parse(&format!("https://evil.dev/pick#{enc}")).unwrap()).is_none());
    assert!(picked(&Url::parse(&format!("{}#not-base64!", pick_url())).unwrap()).is_none());
    assert!(picked(&Url::parse(&new_tab_url()).unwrap()).is_none());
    let pick = |json: &str| picked(&Url::parse(&format!("{}#{}", pick_url(), base64::engine::general_purpose::STANDARD.encode(json))).unwrap()).unwrap();
    assert_eq!(pick(r#"{"source":"src/App.tsx:12:5"}"#)["source"], "src/App.tsx:12:5");
    assert!(pick(r#"{"source":"a\nb"}"#).get("source").is_none());
    assert!(pick(r#"{"source":7}"#).get("source").is_none());
    assert!(pick(&format!(r#"{{"source":"{}"}}"#, "x".repeat(600))).get("source").is_none());
    assert!(pick_script(true).contains("_debugSource") && pick_script(true).contains("data.source = src"));
    assert!(pick_script(true).contains("if (!true) return;") && pick_script(false).contains("if (!false) return;"));
    assert!(profile_store("") .is_none());
    assert_ne!(profile_store("work"), profile_store("personal"));
  }

  #[test]
  fn downloads_never_overwrite_and_strip_paths() {
    let dir = tempfile::tempdir().unwrap();
    let url = Url::parse("https://x.dev/files/report.pdf").unwrap();
    let first = download_path(dir.path(), std::path::Path::new(""), &url);
    assert_eq!(first, dir.path().join("report.pdf"));
    std::fs::write(&first, "x").unwrap();
    assert_eq!(download_path(dir.path(), std::path::Path::new("/tmp/report.pdf"), &url), dir.path().join("report (2).pdf"));
    assert_eq!(download_path(dir.path(), std::path::Path::new(".bashrc"), &url), dir.path().join("_.bashrc"));
  }

  #[test]
  fn zoom_and_find_are_bounded() {
    assert_eq!(zoom_factor(10.0), 5.0);
    assert_eq!(zoom_factor(0.1), 0.25);
    assert_eq!(zoom_factor(f64::NAN), 1.0);
    assert_eq!(find_script("a\"); alert(1); (\"", true), r#"window.find("a\"); alert(1); (\"", false, true, true, false, false, false)"#);
  }
}
