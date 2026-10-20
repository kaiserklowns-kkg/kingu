//! Closing a window or quitting (VS Code: the lifecycle service's onBeforeShutdown veto), per
//! window. While a window's page has a reason to ask first (unsaved files,
//! `window.confirmBeforeClose`), it arms its guard; closing that window, or a user-initiated quit,
//! is then held back and handed to that page, which asks and calls `window_close_confirmed`.
//! A quit asks each armed window in turn. Unarmed, closing never waits on the page, so a hung
//! page can always be closed.

use std::collections::HashSet;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager, State};

/// Sent to a window's page when its close, or a quit, is held back.
pub const CLOSE_REQUESTED: &str = "window:close-requested";

#[derive(Default)]
pub struct CloseGuard {
  armed: Mutex<HashSet<String>>,
  confirmed: Mutex<HashSet<String>>,
  /// A quit is under way: windows closing now still belong to the session to restore.
  quitting: AtomicBool,
}

impl CloseGuard {
  /// Whether closing window `label` must wait for its page.
  pub fn hold(&self, label: &str) -> bool {
    self.armed.lock().unwrap_or_else(|e| e.into_inner()).contains(label) && !self.confirmed.lock().unwrap_or_else(|e| e.into_inner()).contains(label)
  }

  /// The first of `labels` whose page must be asked before a quit.
  pub fn next_held<'a>(&self, labels: &'a [String]) -> Option<&'a String> {
    labels.iter().find(|l| self.hold(l))
  }

  pub fn set_armed(&self, label: &str, armed: bool) {
    let mut set = self.armed.lock().unwrap_or_else(|e| e.into_inner());
    if armed {
      set.insert(label.into());
    } else {
      set.remove(label);
    }
  }

  pub fn confirm(&self, label: &str) {
    self.confirmed.lock().unwrap_or_else(|e| e.into_inner()).insert(label.into());
  }

  /// A page that said no to a quit: the next quit asks every window again.
  pub fn reset_quit(&self) {
    self.quitting.store(false, Ordering::SeqCst);
    self.confirmed.lock().unwrap_or_else(|e| e.into_inner()).clear();
  }

  pub fn quitting(&self) -> bool {
    self.quitting.load(Ordering::SeqCst)
  }

  pub fn start_quit(&self) {
    self.quitting.store(true, Ordering::SeqCst);
  }

  /// A window is gone.
  pub fn forget(&self, label: &str) {
    self.armed.lock().unwrap_or_else(|e| e.into_inner()).remove(label);
    self.confirmed.lock().unwrap_or_else(|e| e.into_inner()).remove(label);
  }
}

fn ask(app: &AppHandle, label: &str, reason: &str) {
  if let Some(w) = app.get_webview_window(label) {
    let _ = w.unminimize();
    let _ = w.set_focus();
  }
  let _ = app.emit_to(label, CLOSE_REQUESTED, reason);
}

/// Closing window `label` (its close button, ⇧⌘W): held back while its guard is armed.
pub fn on_close_requested(app: &AppHandle, label: &str) -> bool {
  let held = app.state::<CloseGuard>().hold(label);
  if held {
    ask(app, label, "close");
  }
  held
}

/// A quit (⌘Q, or the last window closing): held back while any window's guard is armed; the
/// first such window is asked (the others follow as each one confirms).
pub fn on_exit_requested(app: &AppHandle) -> bool {
  let guard = app.state::<CloseGuard>();
  guard.start_quit();
  let labels = app.state::<crate::workspace::Workspaces>().labels();
  match guard.next_held(&labels) {
    Some(label) => {
      ask(app, label, "quit");
      true
    }
    None => false,
  }
}

#[tauri::command]
pub fn window_close_guard(window: tauri::WebviewWindow, guard: State<'_, CloseGuard>, armed: bool) {
  guard.set_armed(window.label(), armed);
}

/// The page agreed (or had nothing to ask). `reason` `"close"`: this window closes; otherwise
/// (`"quit"`, or none from an older page) the app quits once every other armed window agreed too.
#[tauri::command]
pub fn window_close_confirmed(app: AppHandle, window: tauri::WebviewWindow, guard: State<'_, CloseGuard>, reason: Option<String>) {
  guard.confirm(window.label());
  if reason.as_deref() == Some("close") && !guard.quitting() {
    let _ = window.destroy();
    return;
  }
  guard.start_quit();
  let labels = app.state::<crate::workspace::Workspaces>().labels();
  match guard.next_held(&labels) {
    Some(next) => ask(&app, next, "quit"),
    None => app.exit(0),
  }
}

/// The page said no (Cancel in its Save dialog): a quit in progress stops.
#[tauri::command]
pub fn window_close_cancelled(guard: State<'_, CloseGuard>) {
  guard.reset_quit();
}

/// Close Window (`workbench.action.closeWindow`): goes through the close guard like the close button.
#[tauri::command]
pub fn window_close(window: tauri::WebviewWindow) -> Result<(), String> {
  window.close().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn holds_only_while_armed_and_unconfirmed_per_window() {
    let g = CloseGuard::default();
    assert!(!g.hold("main"));
    g.set_armed("main", true);
    assert!(g.hold("main"));
    assert!(!g.hold("window-1"));
    g.confirm("main");
    assert!(!g.hold("main"));
    g.set_armed("window-1", true);
    let labels = vec!["main".to_string(), "window-1".to_string()];
    assert_eq!(g.next_held(&labels).map(String::as_str), Some("window-1"));
    g.start_quit();
    assert!(g.quitting());
    // Cancelled: every window is asked again next time.
    g.reset_quit();
    assert!(!g.quitting());
    assert_eq!(g.next_held(&labels).map(String::as_str), Some("main"));
    g.forget("main");
    g.set_armed("window-1", false);
    assert_eq!(g.next_held(&labels), None);
  }
}
