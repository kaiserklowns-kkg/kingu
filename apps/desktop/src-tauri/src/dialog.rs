//! Native message boxes whose Cancel button answers Escape (VS Code: Escape = Cancel).
//! NSAlert gives Escape only to a button titled exactly "Cancel" (and ⌘D only to "Don't Save"),
//! so the dialog plugin's alerts with Thai labels ignored Escape and the next Enter pressed the
//! default button. On macOS the alert is built here with those key equivalents set explicitly;
//! elsewhere the dialog plugin is used (Windows and GTK already map Escape to the cancel response).

use serde::Deserialize;
use tauri::{AppHandle, WebviewWindow};

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
  #[default]
  Info,
  Warning,
  Error,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MessageBox {
  pub title: String,
  pub message: String,
  #[serde(default)]
  pub kind: Kind,
  /// Left to right in the caller's order; the first is the default (Return).
  pub buttons: Vec<String>,
  /// The answer for Escape or a dismissed dialog.
  pub cancel_id: usize,
  /// Gets ⌘D on macOS, like NSAlert's own "Don't Save".
  #[serde(default)]
  pub dont_save_id: Option<usize>,
}

impl MessageBox {
  fn validate(&self) -> Result<(), String> {
    if self.buttons.is_empty() || self.buttons.len() > 3 {
      return Err(format!("a message box takes 1 to 3 buttons, not {}", self.buttons.len()));
    }
    if self.cancel_id >= self.buttons.len() {
      return Err(format!("cancelId {} is not a button", self.cancel_id));
    }
    Ok(())
  }

  /// Which button gets Escape: none when it is also the only (default) button, since Escape would
  /// then replace its Return key equivalent.
  fn escape_button(&self) -> Option<usize> {
    (self.buttons.len() > 1).then_some(self.cancel_id)
  }
}

/// NSAlert answers NSAlertFirstButtonReturn (1000) + the button's index; anything else
/// (a sheet ended by closing the window) is a cancel.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn alert_answer(response: isize, b: &MessageBox) -> usize {
  usize::try_from(response - 1000).ok().filter(|i| *i < b.buttons.len()).unwrap_or(b.cancel_id)
}

/// The dialog plugin's answer as a button index.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn plugin_answer(result: &tauri_plugin_dialog::MessageDialogResult, b: &MessageBox) -> usize {
  use tauri_plugin_dialog::MessageDialogResult as R;
  match result {
    R::Ok | R::Yes => 0,
    R::No => 1,
    R::Cancel => b.cancel_id,
    R::Custom(label) => b.buttons.iter().position(|l| l == label).unwrap_or(b.cancel_id),
  }
}

/// Shows the message box as a sheet on the calling window and answers the clicked button's index.
#[tauri::command]
pub async fn message_box(app: AppHandle, window: WebviewWindow, options: MessageBox) -> Result<usize, String> {
  options.validate()?;
  show(app, window, options).await
}

#[cfg(target_os = "macos")]
async fn show(app: AppHandle, window: WebviewWindow, b: MessageBox) -> Result<usize, String> {
  use block2::RcBlock;
  use objc2::MainThreadMarker;
  use objc2_app_kit::{NSAlert, NSAlertStyle, NSEventModifierFlags, NSModalResponse, NSWindow};
  use objc2_foundation::NSString;

  let ns_window = window.ns_window().map_err(|e| e.to_string())? as usize;
  let (tx, rx) = std::sync::mpsc::channel::<isize>();
  let shown = b.clone();
  app
    .run_on_main_thread(move || {
      let Some(mtm) = MainThreadMarker::new() else { return };
      let alert = NSAlert::new(mtm);
      alert.setAlertStyle(match shown.kind {
        Kind::Info => NSAlertStyle::Informational,
        Kind::Warning => NSAlertStyle::Warning,
        Kind::Error => NSAlertStyle::Critical,
      });
      alert.setMessageText(&NSString::from_str(&shown.title));
      alert.setInformativeText(&NSString::from_str(&shown.message));
      for (i, label) in shown.buttons.iter().enumerate() {
        let button = alert.addButtonWithTitle(&NSString::from_str(label));
        if shown.escape_button() == Some(i) {
          button.setKeyEquivalent(&NSString::from_str("\u{1b}"));
          button.setKeyEquivalentModifierMask(NSEventModifierFlags::empty());
        } else if shown.dont_save_id == Some(i) && i != 0 {
          button.setKeyEquivalent(&NSString::from_str("d"));
          button.setKeyEquivalentModifierMask(NSEventModifierFlags::Command);
        }
      }
      // SAFETY: Tauri's NSWindow pointer for this webview window, used on the main thread while
      // the window is alive (the command holds its handle).
      let parent: &NSWindow = unsafe { &*(ns_window as *const NSWindow) };
      // The block keeps the alert alive until the sheet ends.
      let kept = alert.clone();
      let done = RcBlock::new(move |response: NSModalResponse| {
        let _ = &kept;
        let _ = tx.send(response);
      });
      alert.beginSheetModalForWindow_completionHandler(parent, Some(&done));
    })
    .map_err(|e| e.to_string())?;
  let response = tauri::async_runtime::spawn_blocking(move || rx.recv())
    .await
    .map_err(|e| e.to_string())?
    .map_err(|_| "the message box was not shown".to_string())?;
  Ok(alert_answer(response, &b))
}

#[cfg(not(target_os = "macos"))]
async fn show(app: AppHandle, window: WebviewWindow, b: MessageBox) -> Result<usize, String> {
  use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

  let buttons = match b.buttons.as_slice() {
    [ok] => MessageDialogButtons::OkCustom(ok.clone()),
    [ok, cancel] => MessageDialogButtons::OkCancelCustom(ok.clone(), cancel.clone()),
    [yes, no, cancel, ..] => MessageDialogButtons::YesNoCancelCustom(yes.clone(), no.clone(), cancel.clone()),
    [] => MessageDialogButtons::Ok,
  };
  let kind = match b.kind {
    Kind::Info => MessageDialogKind::Info,
    Kind::Warning => MessageDialogKind::Warning,
    Kind::Error => MessageDialogKind::Error,
  };
  let dialog = app.dialog().message(b.message.clone()).title(b.title.clone()).kind(kind).buttons(buttons).parent(&window);
  let result = tauri::async_runtime::spawn_blocking(move || dialog.blocking_show_with_result())
    .await
    .map_err(|e| e.to_string())?;
  Ok(plugin_answer(&result, &b))
}

#[cfg(test)]
mod tests {
  use super::*;
  use tauri_plugin_dialog::MessageDialogResult as R;

  fn save_box() -> MessageBox {
    MessageBox {
      title: "t".into(),
      message: "m".into(),
      kind: Kind::Warning,
      buttons: vec!["Save".into(), "Don't Save".into(), "Cancel".into()],
      cancel_id: 2,
      dont_save_id: Some(1),
    }
  }

  #[test]
  fn escape_goes_to_the_cancel_button() {
    let b = save_box();
    assert_eq!(b.escape_button(), Some(2));
    let only = MessageBox { buttons: vec!["OK".into()], cancel_id: 0, dont_save_id: None, ..save_box() };
    assert_eq!(only.escape_button(), None);
  }

  #[test]
  fn alert_responses_map_to_buttons() {
    let b = save_box();
    assert_eq!(alert_answer(1000, &b), 0);
    assert_eq!(alert_answer(1001, &b), 1);
    assert_eq!(alert_answer(1002, &b), 2);
    // NSModalResponseCancel / Abort, or out of range: the cancel button.
    assert_eq!(alert_answer(0, &b), 2);
    assert_eq!(alert_answer(-1001, &b), 2);
    assert_eq!(alert_answer(1003, &b), 2);
  }

  #[test]
  fn plugin_results_map_to_buttons() {
    let b = save_box();
    assert_eq!(plugin_answer(&R::Custom("Don't Save".into()), &b), 1);
    assert_eq!(plugin_answer(&R::Cancel, &b), 2);
    assert_eq!(plugin_answer(&R::Custom("?".into()), &b), 2);
    assert_eq!(plugin_answer(&R::Ok, &b), 0);
  }

  #[test]
  fn options_are_checked() {
    assert!(save_box().validate().is_ok());
    assert!(MessageBox { cancel_id: 3, ..save_box() }.validate().is_err());
    assert!(MessageBox { buttons: vec![], cancel_id: 0, ..save_box() }.validate().is_err());
    let parsed: MessageBox = serde_json::from_str(r#"{"title":"a","message":"b","kind":"error","buttons":["OK","Cancel"],"cancelId":1}"#).unwrap();
    assert_eq!(parsed.kind, Kind::Error);
    assert_eq!(parsed.dont_save_id, None);
  }
}
