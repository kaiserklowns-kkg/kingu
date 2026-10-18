//! Agent notifications that know where they came from (Orca routes a notification click to its
//! worktree pane and focuses the window). tauri-plugin-notification cannot report a click on
//! desktop, so on macOS Kingu delivers the notification itself through mac-notification-sys
//! (the library the plugin uses underneath) and waits for the click on a background thread; a
//! click brings the main window to the front and emits `NOTIFICATION_CLICKED` with the task's
//! slug. Elsewhere the plugin shows the notification and clicks are not routed.

use tauri::{AppHandle, Emitter, Manager};

/// Sent to the webview when the user clicks a notification: `{ slug }`.
pub const NOTIFICATION_CLICKED: &str = "agent:notification-clicked";

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
pub struct Clicked {
  pub slug: Option<String>,
}

/// Shows and focuses the main window (un-minimizing it).
pub fn focus_main(app: &AppHandle) {
  if let Some(w) = app.get_webview_window("main").or_else(|| app.webview_windows().into_values().next()) {
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
  }
}

fn clicked(app: &AppHandle, slug: Option<String>) {
  focus_main(app);
  let _ = app.emit(NOTIFICATION_CLICKED, Clicked { slug });
}

/// The macOS sound for the setting value: none, the system default, or a named system sound.
pub fn sound_of(sound: Option<&str>) -> Option<String> {
  match sound.map(str::trim) {
    None | Some("") | Some("none") => None,
    Some(s) => Some(s.to_owned()),
  }
}

#[cfg(target_os = "macos")]
fn deliver(app: AppHandle, title: String, body: String, sound: Option<String>, slug: Option<String>) -> Result<(), String> {
  use mac_notification_sys::{Notification, NotificationResponse, Sound};
  // The same bundle the plugin picks (Terminal's in dev, where Kingu has no bundle of its own).
  let bundle = if tauri::is_dev() { "com.apple.Terminal".to_owned() } else { app.config().identifier.clone() };
  let _ = mac_notification_sys::set_application(&bundle);
  std::thread::Builder::new()
    .name("agent-notification".into())
    .spawn(move || {
      let mut n = Notification::new();
      n.title(&title).message(&body).wait_for_click(true);
      if let Some(s) = sound.as_deref() {
        if s == "default" || s == "NSUserNotificationDefaultSoundName" {
          n.sound(Sound::Default);
        } else {
          n.sound(s);
        }
      }
      match n.send() {
        Ok(NotificationResponse::Click) | Ok(NotificationResponse::ActionButton(_)) => clicked(&app, slug),
        Ok(_) => {}
        Err(e) => log::warn!("notification: {e}"),
      }
    })
    .map(|_| ())
    .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
fn deliver(app: AppHandle, title: String, body: String, sound: Option<String>, _slug: Option<String>) -> Result<(), String> {
  use tauri_plugin_notification::NotificationExt;
  let mut b = app.notification().builder().title(title).body(body);
  if let Some(s) = sound {
    b = b.sound(s);
  }
  b.show().map_err(|e| e.to_string())
}

/// An agent notification for task `slug` (none: not tied to a task, e.g. the test notification).
#[tauri::command]
pub fn agent_notify(app: AppHandle, title: String, body: String, sound: Option<String>, slug: Option<String>) -> Result<(), String> {
  if let Some(s) = slug.as_deref() {
    crate::agent::worktree::validate_slug(s)?;
  }
  deliver(app, title, body, sound_of(sound.as_deref()), slug)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn sounds() {
    assert_eq!(sound_of(None), None);
    assert_eq!(sound_of(Some("none")), None);
    assert_eq!(sound_of(Some(" ")), None);
    assert_eq!(sound_of(Some("Glass")).as_deref(), Some("Glass"));
  }

  #[test]
  fn click_payload_is_the_slug() {
    assert_eq!(serde_json::to_value(Clicked { slug: Some("fix-bug".into()) }).unwrap(), serde_json::json!({ "slug": "fix-bug" }));
  }
}
