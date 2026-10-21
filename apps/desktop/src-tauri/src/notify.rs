//! Agent notifications that know where they came from (Orca routes a notification click to its
//! worktree pane and focuses the window). tauri-plugin-notification cannot report a click on
//! desktop, so on macOS Kingu delivers the notification itself through mac-notification-sys
//! (the library the plugin uses underneath) and waits for the click on a background thread; a
//! click brings the main window to the front and emits `NOTIFICATION_CLICKED` with the task's
//! slug or the agent chat's id. Elsewhere the plugin shows the notification and clicks are not routed.

use tauri::{AppHandle, Emitter, Manager};

/// Sent to the webview when the user clicks a notification: `{ slug, chat_id?, root? }`.
pub const NOTIFICATION_CLICKED: &str = "agent:notification-clicked";

/// What a click opens: an ADE task (`slug`) or an agent chat of the open folder (`chat_id`).
/// `root`: the added project the task belongs to when it is not the open folder (the click
/// switches to it first).
#[derive(Debug, Clone, Default, serde::Serialize, PartialEq)]
pub struct Clicked {
  /// The window that asked for the notification: the click goes back to it.
  #[serde(skip)]
  pub window: Option<String>,
  pub slug: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub chat_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub root: Option<String>,
}

/// Shows and focuses the main window (un-minimizing it).
pub fn focus_main(app: &AppHandle) {
  if let Some(w) = app.get_webview_window("main").or_else(|| app.webview_windows().into_values().next()) {
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
  }
}

fn clicked(app: &AppHandle, target: Clicked) {
  match target.window.clone().filter(|w| crate::windows::focus(app, w)) {
    Some(w) => {
      let _ = app.emit_to(w.as_str(), NOTIFICATION_CLICKED, target);
    }
    None => {
      focus_main(app);
      let _ = app.emit(NOTIFICATION_CLICKED, target);
    }
  }
}

/// The macOS sound for the setting value: none, the system default, or a named system sound.
pub fn sound_of(sound: Option<&str>) -> Option<String> {
  match sound.map(str::trim) {
    None | Some("") | Some("none") => None,
    Some(s) => Some(s.to_owned()),
  }
}

#[cfg(target_os = "macos")]
fn deliver(app: AppHandle, title: String, body: String, sound: Option<String>, target: Clicked) -> Result<(), String> {
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
        Ok(NotificationResponse::Click) | Ok(NotificationResponse::ActionButton(_)) => clicked(&app, target),
        Ok(_) => {}
        Err(e) => log::warn!("notification: {e}"),
      }
    })
    .map(|_| ())
    .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
fn deliver(app: AppHandle, title: String, body: String, sound: Option<String>, _target: Clicked) -> Result<(), String> {
  use tauri_plugin_notification::NotificationExt;
  let mut b = app.notification().builder().title(title).body(body);
  if let Some(s) = sound {
    b = b.sound(s);
  }
  b.show().map_err(|e| e.to_string())
}

/// A notification not tied to a task (`kingu notify`); a click brings Kingu to the front.
pub fn show(app: &AppHandle, title: String, body: String) -> Result<(), String> {
  deliver(app.clone(), title, body, sound_of(Some("default")), Clicked::default())
}

/// An agent notification for task `slug` or agent chat `chat_id` (neither: not tied to one,
/// e.g. the test notification).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn agent_notify(
  app: AppHandle,
  ws: crate::workspace::Workspace,
  projects: tauri::State<'_, crate::projects::Projects>,
  title: String,
  body: String,
  sound: Option<String>,
  slug: Option<String>,
  chat_id: Option<String>,
  root: Option<String>,
) -> Result<(), String> {
  if let Some(s) = slug.as_deref() {
    crate::agent::worktree::validate_slug(s)?;
  }
  if let Some(id) = chat_id.as_deref() {
    crate::agent::chats::check_id(id)?;
  }
  if let Some(r) = root.as_deref() {
    projects.check(r, ws.current().as_deref())?;
  }
  deliver(app, title, body, sound_of(sound.as_deref()), Clicked { window: Some(ws.label().to_string()), slug, chat_id, root })
}

/// The dock badge text for `count` agents/tasks waiting on you (Orca's unread dock badge): none
/// for 0, `99+` past 99.
pub fn badge_label(count: u32) -> Option<String> {
  match count {
    0 => None,
    1..=99 => Some(count.to_string()),
    _ => Some("99+".into()),
  }
}

/// Puts the attention count on the app's dock icon (macOS); elsewhere the taskbar badge where
/// the platform has one. Best effort: a window that cannot badge is not an error.
#[tauri::command]
pub fn app_badge(app: AppHandle, count: u32) {
  let Some(w) = app.get_webview_window("main").or_else(|| app.webview_windows().into_values().next()) else { return };
  #[cfg(target_os = "macos")]
  let r = w.set_badge_label(badge_label(count));
  #[cfg(not(target_os = "macos"))]
  let r = w.set_badge_count((count > 0).then_some(i64::from(count)));
  if let Err(e) = r {
    log::debug!("app badge: {e}");
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn badge_labels() {
    assert_eq!(badge_label(0), None);
    assert_eq!(badge_label(7).as_deref(), Some("7"));
    assert_eq!(badge_label(99).as_deref(), Some("99"));
    assert_eq!(badge_label(100).as_deref(), Some("99+"));
  }

  #[test]
  fn sounds() {
    assert_eq!(sound_of(None), None);
    assert_eq!(sound_of(Some("none")), None);
    assert_eq!(sound_of(Some(" ")), None);
    assert_eq!(sound_of(Some("Glass")).as_deref(), Some("Glass"));
  }

  #[test]
  fn click_payload_is_the_slug() {
    assert_eq!(serde_json::to_value(Clicked { slug: Some("fix-bug".into()), ..Default::default() }).unwrap(), serde_json::json!({ "slug": "fix-bug" }));
    assert_eq!(serde_json::to_value(Clicked { chat_id: Some("c-1".into()), ..Default::default() }).unwrap(), serde_json::json!({ "slug": null, "chat_id": "c-1" }));
    assert_eq!(
      serde_json::to_value(Clicked { slug: Some("fix-bug".into()), root: Some("/r/b".into()), ..Default::default() }).unwrap(),
      serde_json::json!({ "slug": "fix-bug", "root": "/r/b" })
    );
  }
}
