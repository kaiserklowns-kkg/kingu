//! The floating workspace's browser tabs (Orca's): real child webviews of the main window,
//! placed by the panel's browser tab. A page gets its own webview with no Tauri API, and only
//! http(s) navigation is allowed.

use tauri::{
  webview::{Webview, WebviewBuilder},
  AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl,
};

fn allowed(url: &Url) -> bool {
  matches!(url.scheme(), "http" | "https" | "about")
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
  let window = app.get_window("main").ok_or("no main window")?;
  let emitter = app.clone();
  let tab = label.clone();
  let builder = WebviewBuilder::new(label, WebviewUrl::External(url))
    .on_navigation(|u| allowed(u))
    .on_page_load(move |wv, payload| {
      let url = payload.url().to_string();
      if payload.event() == tauri::webview::PageLoadEvent::Finished {
        let _ = emitter.emit("floating-browser", serde_json::json!({ "label": tab, "url": url }));
      }
      let _ = wv;
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
