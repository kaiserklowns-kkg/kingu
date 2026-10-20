//! Native application menu (macOS menu bar), built from the menu model the webview sends.
//!
//! The model lives in TypeScript (`src/lib/workbench/menus.ts`), next to the command registry it
//! names, and is shared with the in-window menu bar of Windows/Linux. The webview resolves it
//! (labels, accelerators from the command keybindings, enabled/checked state, recent folders) and
//! sends it with `menu_set_model`; Rust is a generic renderer. A click on an item emits
//! [`MENU_COMMAND_EVENT`] with the item id, and the webview runs that command. Predefined items
//! (Undo, Copy, Hide, Quit…) are handled by the OS and never reach the webview.
//!
//! Accelerators are bound natively, but WKWebView offers key equivalents to the web page first:
//! the menu only fires for keys the webview's keybinding listener did not `preventDefault`, so the
//! webview stays the single executor of its keybindings (see `commands.svelte.ts`, which also
//! drops a menu event that echoes a key it just ran).

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Deserialize;
use tauri::menu::{AboutMetadata, CheckMenuItem, IsMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

/// Payload: the clicked item's id (a command id, or `recent:<path>`).
pub const MENU_COMMAND_EVENT: &str = "menu://command";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
  About,
  Services,
  Hide,
  HideOthers,
  ShowAll,
  Quit,
  Undo,
  Redo,
  Cut,
  Copy,
  Paste,
  SelectAll,
  Minimize,
  Zoom,
  Fullscreen,
  BringAllToFront,
}

/// Mirror of `MenuNode` in menus.ts.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MenuNode {
  Item {
    id: String,
    text: String,
    #[serde(default)]
    accelerator: Option<String>,
    enabled: bool,
    #[serde(default)]
    checked: Option<bool>,
  },
  Role {
    role: Role,
    #[serde(default)]
    text: Option<String>,
  },
  Separator,
  Submenu {
    id: String,
    text: String,
    items: Vec<MenuNode>,
  },
}

/// Where a menu is built: Tauri's native items in the app, a recorder in tests.
pub trait MenuSink {
  type Item;
  fn item(&mut self, id: &str, text: &str, accelerator: Option<&str>, enabled: bool) -> Result<Self::Item, String>;
  fn check(&mut self, id: &str, text: &str, accelerator: Option<&str>, enabled: bool, checked: bool) -> Result<Self::Item, String>;
  fn role(&mut self, role: &Role, text: Option<&str>) -> Result<Self::Item, String>;
  fn separator(&mut self) -> Result<Self::Item, String>;
  fn submenu(&mut self, id: &str, text: &str, items: Vec<Self::Item>) -> Result<Self::Item, String>;
}

/// Accelerators the menu can bind: modifiers then one key, as muda parses them. Anything else is
/// dropped (the item still works, without a shortcut) instead of failing the whole menu.
pub fn valid_accelerator(accelerator: &str) -> bool {
  let mut parts: Vec<&str> = accelerator.split('+').collect();
  let Some(key) = parts.pop() else { return false };
  let modifiers_ok = parts.iter().all(|m| {
    matches!(m.to_ascii_lowercase().as_str(), "cmd" | "command" | "super" | "ctrl" | "control" | "alt" | "option" | "shift" | "cmdorctrl")
  });
  let named = [
    "Backquote", "Backslash", "BracketLeft", "BracketRight", "Comma", "Equal", "Minus", "Period", "Quote", "Semicolon", "Slash",
    "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", "Escape", "Space", "Tab", "Backspace", "Delete",
  ];
  let key_ok = (key.len() == 1 && key.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()))
    || named.contains(&key)
    || (key.len() >= 2 && key.starts_with('F') && key[1..].parse::<u8>().is_ok_and(|n| (1..=24).contains(&n)));
  modifiers_ok && key_ok
}

/// Builds `nodes` into `sink`, depth first. Returns the built items in order.
pub fn build<S: MenuSink>(sink: &mut S, nodes: &[MenuNode]) -> Result<Vec<S::Item>, String> {
  nodes
    .iter()
    .map(|node| match node {
      MenuNode::Item { id, text, accelerator, enabled, checked } => {
        let accelerator = accelerator.as_deref().filter(|a| valid_accelerator(a));
        match checked {
          Some(checked) => sink.check(id, text, accelerator, *enabled, *checked),
          None => sink.item(id, text, accelerator, *enabled),
        }
      }
      MenuNode::Role { role, text } => sink.role(role, text.as_deref()),
      MenuNode::Separator => sink.separator(),
      MenuNode::Submenu { id, text, items } => {
        let built = build(sink, items)?;
        sink.submenu(id, text, built)
      }
    })
    .collect()
}

/// Items by id, for `menu_set_checked` / `menu_set_enabled`. One command can appear in several
/// menus (New Task is in File and Agents), so an id maps to every copy.
#[derive(Default)]
pub struct MenuState {
  items: Mutex<HashMap<String, Vec<MenuItemKind<tauri::Wry>>>>,
}

struct TauriSink<'a, R: Runtime> {
  app: &'a AppHandle<R>,
  items: HashMap<String, Vec<MenuItemKind<R>>>,
}

impl<R: Runtime> TauriSink<'_, R> {
  fn remember(&mut self, id: &str, item: MenuItemKind<R>) -> MenuItemKind<R> {
    self.items.entry(id.to_string()).or_default().push(item.clone());
    item
  }
}

fn err(e: tauri::Error) -> String {
  e.to_string()
}

impl<R: Runtime> MenuSink for TauriSink<'_, R> {
  type Item = MenuItemKind<R>;

  fn item(&mut self, id: &str, text: &str, accelerator: Option<&str>, enabled: bool) -> Result<Self::Item, String> {
    let item = MenuItem::with_id(self.app, id, text, enabled, accelerator).map_err(err)?;
    Ok(self.remember(id, MenuItemKind::MenuItem(item)))
  }

  fn check(&mut self, id: &str, text: &str, accelerator: Option<&str>, enabled: bool, checked: bool) -> Result<Self::Item, String> {
    let item = CheckMenuItem::with_id(self.app, id, text, enabled, checked, accelerator).map_err(err)?;
    Ok(self.remember(id, MenuItemKind::Check(item)))
  }

  fn role(&mut self, role: &Role, text: Option<&str>) -> Result<Self::Item, String> {
    let app = self.app;
    let item = match role {
      Role::About => {
        let info = app.package_info();
        let metadata = AboutMetadata {
          name: Some(info.name.clone()),
          version: Some(info.version.to_string()),
          ..Default::default()
        };
        PredefinedMenuItem::about(app, text, Some(metadata))
      }
      Role::Services => PredefinedMenuItem::services(app, text),
      Role::Hide => PredefinedMenuItem::hide(app, text),
      Role::HideOthers => PredefinedMenuItem::hide_others(app, text),
      Role::ShowAll => PredefinedMenuItem::show_all(app, text),
      Role::Quit => PredefinedMenuItem::quit(app, text),
      Role::Undo => PredefinedMenuItem::undo(app, text),
      Role::Redo => PredefinedMenuItem::redo(app, text),
      Role::Cut => PredefinedMenuItem::cut(app, text),
      Role::Copy => PredefinedMenuItem::copy(app, text),
      Role::Paste => PredefinedMenuItem::paste(app, text),
      Role::SelectAll => PredefinedMenuItem::select_all(app, text),
      Role::Minimize => PredefinedMenuItem::minimize(app, text),
      Role::Zoom => PredefinedMenuItem::maximize(app, text),
      Role::Fullscreen => PredefinedMenuItem::fullscreen(app, text),
      Role::BringAllToFront => PredefinedMenuItem::bring_all_to_front(app, text),
    }
    .map_err(err)?;
    Ok(MenuItemKind::Predefined(item))
  }

  fn separator(&mut self) -> Result<Self::Item, String> {
    Ok(MenuItemKind::Predefined(PredefinedMenuItem::separator(self.app).map_err(err)?))
  }

  fn submenu(&mut self, id: &str, text: &str, items: Vec<Self::Item>) -> Result<Self::Item, String> {
    let refs: Vec<&dyn IsMenuItem<R>> = items.iter().map(|i| i as &dyn IsMenuItem<R>).collect();
    let submenu = Submenu::with_id_and_items(self.app, id, text, true, &refs).map_err(err)?;
    #[cfg(target_os = "macos")]
    match id {
      "window" => submenu.set_as_windows_menu_for_nsapp().map_err(err)?,
      "help" => submenu.set_as_help_menu_for_nsapp().map_err(err)?,
      _ => {}
    }
    Ok(MenuItemKind::Submenu(submenu))
  }
}

/// Replaces the app menu with `model` (top-level submenus). Only macOS has a native menu bar;
/// elsewhere the webview draws the menu inside its title bar and this is a no-op.
#[tauri::command]
pub fn menu_set_model(app: AppHandle, window: tauri::WebviewWindow, state: State<'_, MenuState>, model: Vec<MenuNode>) -> Result<(), String> {
  if !cfg!(target_os = "macos") || !is_active(&app, window.label()) {
    return Ok(());
  }
  let mut sink = TauriSink { app: &app, items: HashMap::new() };
  let top = build(&mut sink, &model)?;
  let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = top.iter().map(|i| i as &dyn IsMenuItem<tauri::Wry>).collect();
  let menu = Menu::with_items(&app, &refs).map_err(err)?;
  app.set_menu(menu).map_err(err)?;
  *state.items.lock().map_err(|e| e.to_string())? = sink.items;
  Ok(())
}

/// Toggle state of a check item (View > Appearance > Primary Side Bar…), from webview state.
#[tauri::command]
pub fn menu_set_checked(app: AppHandle, window: tauri::WebviewWindow, state: State<'_, MenuState>, id: String, checked: bool) -> Result<(), String> {
  if !is_active(&app, window.label()) {
    return Ok(());
  }
  let items = state.items.lock().map_err(|e| e.to_string())?;
  for item in items.get(&id).into_iter().flatten() {
    if let MenuItemKind::Check(c) = item {
      c.set_checked(checked).map_err(err)?;
    }
  }
  Ok(())
}

/// Enablement follows the command's `when` in the webview.
#[tauri::command]
pub fn menu_set_enabled(app: AppHandle, window: tauri::WebviewWindow, state: State<'_, MenuState>, id: String, enabled: bool) -> Result<(), String> {
  if !is_active(&app, window.label()) {
    return Ok(());
  }
  let items = state.items.lock().map_err(|e| e.to_string())?;
  for item in items.get(&id).into_iter().flatten() {
    match item {
      MenuItemKind::MenuItem(i) => i.set_enabled(enabled).map_err(err)?,
      MenuItemKind::Check(c) => c.set_enabled(enabled).map_err(err)?,
      _ => {}
    }
  }
  Ok(())
}

/// The app menu bar is one for all windows (macOS): it shows the active window's model, and its
/// clicks go to that window.
fn is_active<R: Runtime>(app: &AppHandle<R>, label: &str) -> bool {
  app.try_state::<crate::workspace::Workspaces>().and_then(|w| w.last_active()).is_none_or(|w| w.label() == label)
}

/// Sent to a window that became active, so it puts its own menu model back.
pub const MENU_REFRESH_EVENT: &str = "menu://refresh";

/// A window came to the front: the menu bar is rebuilt from its model.
pub fn window_focused<R: Runtime>(app: &AppHandle<R>, label: &str) {
  if cfg!(target_os = "macos") && app.webview_windows().len() > 1 {
    let _ = app.emit_to(label, MENU_REFRESH_EVENT, ());
  }
}

/// Forwards clicks on the webview's own items to the active window; predefined items never get here.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
  app.on_menu_event(|app, event| {
    let id = event.id().0.clone();
    let known = app.try_state::<MenuState>().is_some_and(|s| s.items.lock().is_ok_and(|items| items.contains_key(&id)));
    if !known {
      return;
    }
    let target = app.try_state::<crate::workspace::Workspaces>().and_then(|w| w.last_active()).map(|w| w.label().to_string());
    let sent = match target {
      Some(label) => app.emit_to(label.as_str(), MENU_COMMAND_EVENT, id),
      None => app.emit(MENU_COMMAND_EVENT, id),
    };
    if let Err(e) = sent {
      log::error!("menu event: {e}");
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Title bar double-click (the overlay title bar is drawn by the webview)

#[derive(Debug, PartialEq, Eq)]
pub enum DoubleClickAction {
  Zoom,
  Minimize,
  None,
}

/// macOS "Double-click a window's title bar to": `AppleActionOnDoubleClick` is `Maximize` (Zoom),
/// `Fill` (macOS 15, treated as Zoom), `Minimize` or `None`; older systems only set the boolean
/// `AppleMiniaturizeOnDoubleClick`. Unset means Zoom.
pub fn double_click_action(action: Option<&str>, miniaturize: Option<&str>) -> DoubleClickAction {
  match action.map(str::trim) {
    Some("Minimize") => DoubleClickAction::Minimize,
    Some("None") => DoubleClickAction::None,
    Some(_) => DoubleClickAction::Zoom,
    None if matches!(miniaturize.map(str::trim), Some("1" | "true" | "YES")) => DoubleClickAction::Minimize,
    None => DoubleClickAction::Zoom,
  }
}

#[cfg(target_os = "macos")]
fn read_global_default(key: &str) -> Option<String> {
  let out = std::process::Command::new("defaults").args(["read", "-g", key]).output().ok()?;
  out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Double-click on an empty part of the title bar: the system preference on macOS, maximize
/// toggle elsewhere (Windows and Linux title bars).
#[tauri::command]
pub async fn window_titlebar_double_click(window: tauri::Window) -> Result<(), String> {
  #[cfg(target_os = "macos")]
  let action = double_click_action(
    read_global_default("AppleActionOnDoubleClick").as_deref(),
    read_global_default("AppleMiniaturizeOnDoubleClick").as_deref(),
  );
  #[cfg(not(target_os = "macos"))]
  let action = DoubleClickAction::Zoom;
  match action {
    DoubleClickAction::Minimize => window.minimize().map_err(err),
    DoubleClickAction::None => Ok(()),
    DoubleClickAction::Zoom => {
      if window.is_maximized().map_err(err)? {
        window.unmaximize().map_err(err)
      } else {
        window.maximize().map_err(err)
      }
    }
  }
}

/// File > Exit on Windows/Linux (macOS quits through the predefined Quit item).
#[tauri::command]
pub fn app_quit(app: AppHandle) {
  app.exit(0);
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Records the menu as indented lines.
  #[derive(Default)]
  struct Recorder {
    ids: Vec<String>,
  }

  impl MenuSink for Recorder {
    type Item = String;
    fn item(&mut self, id: &str, text: &str, accelerator: Option<&str>, enabled: bool) -> Result<String, String> {
      self.ids.push(id.into());
      Ok(format!("{text} [{id}]{}{}", accelerator.map(|a| format!(" {a}")).unwrap_or_default(), if enabled { "" } else { " (disabled)" }))
    }
    fn check(&mut self, id: &str, text: &str, accelerator: Option<&str>, enabled: bool, checked: bool) -> Result<String, String> {
      let line = self.item(id, text, accelerator, enabled)?;
      Ok(format!("{} {line}", if checked { "[x]" } else { "[ ]" }))
    }
    fn role(&mut self, role: &Role, text: Option<&str>) -> Result<String, String> {
      Ok(format!("<{role:?}>{}", text.map(|t| format!(" {t}")).unwrap_or_default()))
    }
    fn separator(&mut self) -> Result<String, String> {
      Ok("---".into())
    }
    fn submenu(&mut self, id: &str, text: &str, items: Vec<String>) -> Result<String, String> {
      let body: Vec<String> = items.iter().flat_map(|i| i.lines().map(|l| format!("  {l}")).collect::<Vec<_>>()).collect();
      Ok(format!("{text} ({id})\n{}", body.join("\n")))
    }
  }

  /// The JSON shape `resolveMenubar` in menus.ts produces.
  const MODEL: &str = r#"[
    {"type":"submenu","id":"app","text":"Kingu","items":[
      {"type":"role","role":"about","text":"About Kingu"},
      {"type":"separator"},
      {"type":"item","id":"workbench.action.openSettings","text":"Settings...","accelerator":"Cmd+Comma","keyLabel":"⌘,","enabled":true},
      {"type":"role","role":"quit","text":"Quit Kingu","keyLabel":"⌘Q"}
    ]},
    {"type":"submenu","id":"file","text":"File","mnemonic":0,"items":[
      {"type":"item","id":"kingu.agents.newTask","text":"New Task","enabled":false},
      {"type":"submenu","id":"openRecent","text":"Open Recent","items":[
        {"type":"item","id":"recent:/Users/me/code","text":"code  ~","enabled":true},
        {"type":"separator"},
        {"type":"item","id":"workbench.action.openRecent","text":"More...","accelerator":"Ctrl+R","enabled":true}
      ]},
      {"type":"item","id":"workbench.action.files.save","text":"Save","accelerator":"Cmd+S","enabled":true}
    ]},
    {"type":"submenu","id":"view","text":"View","items":[
      {"type":"submenu","id":"appearance","text":"Appearance","items":[
        {"type":"item","id":"workbench.action.toggleSidebarVisibility","text":"Primary Side Bar","accelerator":"Cmd+B","enabled":true,"checked":true},
        {"type":"item","id":"workbench.action.togglePanel","text":"Panel","accelerator":"Cmd+J","enabled":true,"checked":false},
        {"type":"item","id":"workbench.action.selectTheme","text":"Color Theme","keyLabel":"⌘K ⌘T","enabled":true}
      ]}
    ]},
    {"type":"submenu","id":"agents","text":"Agents","items":[
      {"type":"item","id":"kingu.agents.newTask","text":"New Task","enabled":false},
      {"type":"item","id":"bad","text":"Bad Key","accelerator":"Hyper+?","enabled":true}
    ]}
  ]"#;

  #[test]
  fn builds_the_menu_from_the_webview_model() {
    let model: Vec<MenuNode> = serde_json::from_str(MODEL).unwrap();
    let mut rec = Recorder::default();
    let top = build(&mut rec, &model).unwrap();
    assert_eq!(top.len(), 4);
    assert_eq!(
      top[0],
      "Kingu (app)\n  <About> About Kingu\n  ---\n  Settings... [workbench.action.openSettings] Cmd+Comma\n  <Quit> Quit Kingu"
    );
    assert_eq!(
      top[1],
      "File (file)\n  New Task [kingu.agents.newTask] (disabled)\n  Open Recent (openRecent)\n    code  ~ [recent:/Users/me/code]\n    ---\n    More... [workbench.action.openRecent] Ctrl+R\n  Save [workbench.action.files.save] Cmd+S"
    );
    assert_eq!(
      top[2],
      "View (view)\n  Appearance (appearance)\n    [x] Primary Side Bar [workbench.action.toggleSidebarVisibility] Cmd+B\n    [ ] Panel [workbench.action.togglePanel] Cmd+J\n    Color Theme [workbench.action.selectTheme]"
    );
    // An accelerator muda cannot parse is dropped, the item stays.
    assert_eq!(top[3], "Agents (agents)\n  New Task [kingu.agents.newTask] (disabled)\n  Bad Key [bad]");
    // A command in two menus is registered twice (menu_set_enabled updates both).
    assert_eq!(rec.ids.iter().filter(|i| *i == "kingu.agents.newTask").count(), 2);
  }

  #[test]
  fn rejects_unknown_roles_and_node_types() {
    assert!(serde_json::from_str::<Vec<MenuNode>>(r#"[{"type":"role","role":"selfDestruct"}]"#).is_err());
    assert!(serde_json::from_str::<Vec<MenuNode>>(r#"[{"type":"widget"}]"#).is_err());
  }

  #[test]
  fn accelerators_match_what_muda_parses() {
    for ok in ["Cmd+S", "Shift+Cmd+P", "Ctrl+Backquote", "Alt+Cmd+B", "Ctrl+Shift+Cmd+ArrowRight", "F12", "Cmd+Comma", "Ctrl+Minus", "Cmd+0"] {
      assert!(valid_accelerator(ok), "{ok}");
    }
    for bad in ["", "Cmd+", "Hyper+S", "Cmd+s", "Cmd+F99", "Cmd+K Cmd+T"] {
      assert!(!valid_accelerator(bad), "{bad}");
    }
  }

  #[test]
  fn title_bar_double_click_follows_the_system_setting() {
    assert_eq!(double_click_action(None, None), DoubleClickAction::Zoom);
    assert_eq!(double_click_action(Some("Maximize"), None), DoubleClickAction::Zoom);
    assert_eq!(double_click_action(Some("Fill"), None), DoubleClickAction::Zoom);
    assert_eq!(double_click_action(Some("Minimize\n"), None), DoubleClickAction::Minimize);
    assert_eq!(double_click_action(Some("None"), Some("1")), DoubleClickAction::None);
    assert_eq!(double_click_action(None, Some("1")), DoubleClickAction::Minimize);
  }
}
