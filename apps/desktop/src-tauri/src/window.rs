//! Closing the window or quitting (VS Code: the lifecycle service's onBeforeShutdown veto).
//! While the webview has a reason to ask first (unsaved files, `window.confirmBeforeClose`), it
//! arms the guard; a close or a user-initiated quit is then held back and handed to the webview,
//! which asks and calls `window_close_confirmed`. Unarmed, closing never waits on the webview, so a
//! hung page can always be quit.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager, State};

/// Sent to the webview when a close or quit is held back.
pub const CLOSE_REQUESTED: &str = "window:close-requested";

#[derive(Default)]
pub struct CloseGuard {
  armed: AtomicBool,
  confirmed: AtomicBool,
}

impl CloseGuard {
  /// Whether this close or quit must wait for the webview.
  pub fn hold(&self) -> bool {
    self.armed.load(Ordering::SeqCst) && !self.confirmed.load(Ordering::SeqCst)
  }
}

pub fn on_close_requested(app: &AppHandle) -> bool {
  let held = app.state::<CloseGuard>().hold();
  if held {
    let _ = app.emit(CLOSE_REQUESTED, ());
  }
  held
}

#[tauri::command]
pub fn window_close_guard(guard: State<'_, CloseGuard>, armed: bool) {
  guard.armed.store(armed, Ordering::SeqCst);
}

/// The webview agreed (or had nothing to ask): quit for real.
#[tauri::command]
pub fn window_close_confirmed(app: AppHandle, guard: State<'_, CloseGuard>) {
  guard.confirmed.store(true, Ordering::SeqCst);
  app.exit(0);
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn holds_only_while_armed_and_unconfirmed() {
    let g = CloseGuard::default();
    assert!(!g.hold());
    g.armed.store(true, Ordering::SeqCst);
    assert!(g.hold());
    g.confirmed.store(true, Ordering::SeqCst);
    assert!(!g.hold());
  }
}
