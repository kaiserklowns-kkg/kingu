//! Settings files, like VS Code's user `settings.json` and workspace `.vscode/settings.json`:
//! user settings live in the app config dir, workspace settings in `<workspace>/.kingu/settings.json`.
//! User keybindings live next to the user settings (`keybindings.json`, VS Code's file).
//! The webview names a scope, never a path. Writes go to a temp file in the same directory and
//! are renamed over the target, so a crash never leaves a half-written settings file.

use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, State};

use crate::i18n::msg::FilesMsg;
use crate::tr;
use crate::workspace::Workspace;

const FILE: &str = "settings.json";
const KEYBINDINGS_FILE: &str = "keybindings.json";
const WORKSPACE_DIR: &str = ".kingu";
const MAX_BYTES: usize = 1024 * 1024;

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct SettingsFile {
  pub path: String,
  /// `None` when the file does not exist yet.
  pub content: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Scope {
  User,
  Workspace,
  /// The user `keybindings.json`.
  Keybindings,
  /// Kingu's own per-repository overrides (Orca's per-repo settings) for the open folder:
  /// `<config_dir>/repos/<id>.json`, never inside the repository.
  Repo,
  /// The Default profile's `settings.json` while another profile is active: application-scoped
  /// settings always live there (VS Code). `User` is the active profile's (user_profiles.rs).
  DefaultUser,
}

impl Scope {
  pub fn parse(s: &str) -> Result<Self, String> {
    match s {
      "user" => Ok(Self::User),
      "workspace" => Ok(Self::Workspace),
      "keybindings" => Ok(Self::Keybindings),
      "repo" => Ok(Self::Repo),
      "defaultUser" => Ok(Self::DefaultUser),
      _ => Err(format!("unknown settings scope: {s}")),
    }
  }
}

/// `<config_dir>/settings.json`.
pub fn user_path(config_dir: &Path) -> PathBuf {
  config_dir.join(FILE)
}

const REPOS_DIR: &str = "repos";

/// `<config_dir>/repos/<id>.json`: the per-repository overrides of `root`, keyed by a hash of its
/// path so any folder name maps to one safe file name.
pub fn repo_path(config_dir: &Path, root: &Path) -> PathBuf {
  let hash = crate::snap::sha256_hex(root.to_string_lossy().as_bytes());
  config_dir.join(REPOS_DIR).join(format!("{}.json", &hash[..16]))
}

/// One value of `root`'s per-repository settings (local scripts, script source), read by Rust
/// itself so what may run never comes from the webview. A missing or unreadable file reads as unset.
pub fn repo_value(config_dir: &Path, root: &Path, key: &str) -> Option<serde_json::Value> {
  let text = read(&repo_path(config_dir, root)).ok()??;
  let parsed: serde_json::Value = serde_json::from_str(&strip_jsonc(&text)).ok()?;
  parsed.get(key).cloned()
}

/// `<root>/.kingu/settings.json`, refusing a `.kingu` or `settings.json` that is a symlink
/// (it could point outside the workspace) or a `.kingu` that is not a directory.
pub fn workspace_path(root: &Path) -> Result<PathBuf, String> {
  kingu_file(root, FILE)
}

/// `<root>/.kingu/<name>` for Kingu's own per-folder files (settings, tasks), with the same guards.
pub fn kingu_file(root: &Path, name: &str) -> Result<PathBuf, String> {
  let dir = root.join(WORKSPACE_DIR);
  if let Ok(meta) = std::fs::symlink_metadata(&dir)
    && (meta.file_type().is_symlink() || !meta.is_dir())
  {
    return Err(tr!(FilesMsg::NotADirectory, path = dir.display()));
  }
  let file = dir.join(name);
  if let Ok(meta) = std::fs::symlink_metadata(&file)
    && !meta.is_file()
  {
    return Err(tr!(FilesMsg::NotARegularFile, path = file.display()));
  }
  Ok(file)
}

pub fn read(path: &Path) -> Result<Option<String>, String> {
  match std::fs::read(path) {
    Ok(bytes) if bytes.len() > MAX_BYTES => Err(tr!(FilesMsg::FileTooLarge, path = path.display(), max = MAX_BYTES)),
    Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| tr!(FilesMsg::NotUtf8, path = path.display())),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(e) => Err(format!("{}: {e}", path.display())),
  }
}

/// Writes `content` to a sibling temp file, syncs it, then renames it over `path`.
pub fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
  if content.len() > MAX_BYTES {
    return Err(tr!(FilesMsg::SettingsTooLarge, max = MAX_BYTES));
  }
  let dir = path.parent().ok_or("settings path has no parent")?;
  let name = path.file_name().and_then(|n| n.to_str()).unwrap_or(FILE);
  std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
  let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
  let result = (|| {
    let mut f = std::fs::File::create(&tmp)?;
    f.write_all(content.as_bytes())?;
    f.sync_all()?;
    std::fs::rename(&tmp, path)
  })();
  if let Err(e) = result {
    let _ = std::fs::remove_file(&tmp);
    return Err(format!("{}: {e}", path.display()));
  }
  Ok(())
}

/// Drops `//` and `/* */` comments and trailing commas outside strings (settings.json is JSONC).
pub fn strip_jsonc(text: &str) -> String {
  let mut out = String::with_capacity(text.len());
  let mut chars = text.chars().peekable();
  while let Some(c) = chars.next() {
    match c {
      '"' => {
        out.push(c);
        while let Some(s) = chars.next() {
          out.push(s);
          if s == '\\' {
            if let Some(esc) = chars.next() {
              out.push(esc);
            }
          } else if s == '"' {
            break;
          }
        }
      }
      '/' if chars.peek() == Some(&'/') => {
        for s in chars.by_ref() {
          if s == '\n' {
            out.push('\n');
            break;
          }
        }
      }
      '/' if chars.peek() == Some(&'*') => {
        chars.next();
        let mut prev = ' ';
        for s in chars.by_ref() {
          if prev == '*' && s == '/' {
            break;
          }
          prev = s;
        }
      }
      ',' => {
        // A comma followed (past whitespace and comments) by `}` or `]` is a trailing one.
        if !matches!(next_significant(chars.clone()), Some('}' | ']')) {
          out.push(c);
        }
      }
      _ => out.push(c),
    }
  }
  out
}

fn next_significant(mut chars: std::iter::Peekable<std::str::Chars<'_>>) -> Option<char> {
  while let Some(c) = chars.next() {
    match c {
      c if c.is_whitespace() => {}
      '/' if chars.peek() == Some(&'/') => {
        chars.find(|&s| s == '\n');
      }
      '/' if chars.peek() == Some(&'*') => {
        chars.next();
        let mut prev = ' ';
        for s in chars.by_ref() {
          if prev == '*' && s == '/' {
            break;
          }
          prev = s;
        }
      }
      c => return Some(c),
    }
  }
  None
}

/// One value of the user settings.json, for what Rust decides before the webview runs
/// (`window.restoreWindows`). A missing or unreadable file reads as unset.
pub fn user_value(config_dir: &Path, key: &str) -> Option<serde_json::Value> {
  let text = read(&user_path(config_dir)).ok()??;
  let parsed: serde_json::Value = serde_json::from_str(&strip_jsonc(&text)).ok()?;
  parsed.get(key).cloned()
}

fn path_for(app: &AppHandle, ws: &Workspace, scope: Scope) -> Result<PathBuf, String> {
  match scope {
    Scope::User => Ok(user_path(&crate::user_profiles::active_dir(&app.path().app_config_dir().map_err(|e| e.to_string())?))),
    Scope::DefaultUser => Ok(user_path(&app.path().app_config_dir().map_err(|e| e.to_string())?)),
    Scope::Workspace => workspace_path(&ws.root()?),
    Scope::Keybindings => Ok(crate::user_profiles::active_dir(&app.path().app_config_dir().map_err(|e| e.to_string())?).join(KEYBINDINGS_FILE)),
    Scope::Repo => Ok(repo_path(&app.path().app_config_dir().map_err(|e| e.to_string())?, &ws.root()?)),
  }
}

#[tauri::command]
pub fn settings_read(app: AppHandle, ws: State<'_, Workspace>, scope: String) -> Result<SettingsFile, String> {
  let scope = Scope::parse(&scope)?;
  // No folder open: there are no workspace settings (not an error, which would keep the last
  // folder's values).
  if matches!(scope, Scope::Workspace | Scope::Repo) && ws.current().is_none() {
    return Ok(SettingsFile { path: String::new(), content: None });
  }
  let path = path_for(&app, &ws, scope)?;
  Ok(SettingsFile { content: read(&path)?, path: path.display().to_string() })
}

#[tauri::command]
pub fn settings_write(app: AppHandle, ws: State<'_, Workspace>, scope: String, content: String) -> Result<(), String> {
  let path = path_for(&app, &ws, Scope::parse(&scope)?)?;
  write_atomic(&path, &content)?;
  log::info!("saved {scope} settings");
  Ok(())
}

/// Which settings file a change in the app config dir touched (for `settings://changed`): the
/// user `settings.json`, `keybindings.json` (of the active profile), a per-repository file under
/// `repos/`, or the profiles list.
pub fn changed_file(config_dir: &Path, path: &Path) -> Option<&'static str> {
  changed_in(config_dir, &crate::user_profiles::active_dir(config_dir), path)
}

/// [`changed_file`] with the active profile's folder (`profile`, the config dir for Default): the
/// Default `settings.json` counts too, for its application-scoped settings.
pub fn changed_in(config_dir: &Path, profile: &Path, path: &Path) -> Option<&'static str> {
  if path == user_path(config_dir) || path == user_path(profile) {
    Some("settings")
  } else if path == profile.join(KEYBINDINGS_FILE) {
    Some("keybindings")
  } else if path.parent() == Some(crate::snippets::dir_in(profile).as_path()) && path.file_name().and_then(|n| n.to_str()).is_some_and(crate::snippets::valid_name) {
    Some("snippets")
  } else if path == config_dir.join(crate::user_profiles::PROFILES_DIR).join("profiles.json") {
    Some("profiles")
  } else if path.parent() == Some(config_dir.join(REPOS_DIR).as_path()) && path.extension().is_some_and(|e| e == "json") {
    Some("repo")
  } else {
    None
  }
}

/// Keeps the config-dir watcher alive.
#[derive(Default)]
pub struct ConfigWatcher(std::sync::Mutex<Option<notify::RecommendedWatcher>>);

/// Watches the app config dir so `settings.json` and `keybindings.json` edited while Kingu has
/// focus (by another program or an agent) apply right away, like VS Code; the webview also
/// re-reads on focus. Emits `settings://changed` with the file kind, at most every 150 ms per kind.
pub fn watch_config(app: &AppHandle, config_dir: &Path) -> Result<(), String> {
  use notify::{RecursiveMode, Watcher};
  use tauri::Emitter;
  std::fs::create_dir_all(config_dir.join(REPOS_DIR)).map_err(|e| e.to_string())?;
  let (tx, rx) = std::sync::mpsc::channel::<&'static str>();
  // File events carry resolved paths (e.g. /private/var on macOS).
  let dir = std::fs::canonicalize(config_dir).unwrap_or_else(|_| config_dir.to_owned());
  let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
    let Ok(event) = res else { return };
    if matches!(event.kind, notify::EventKind::Access(_)) {
      return;
    }
    for p in &event.paths {
      if let Some(kind) = changed_file(&dir, p) {
        let _ = tx.send(kind);
      }
    }
  })
  .map_err(|e| e.to_string())?;
  watcher.watch(config_dir, RecursiveMode::NonRecursive).map_err(|e| e.to_string())?;
  watcher.watch(&config_dir.join(REPOS_DIR), RecursiveMode::NonRecursive).map_err(|e| e.to_string())?;
  // The Default profile's user snippets (a profile's own are under `profiles/`, watched below).
  let snippets = crate::snippets::dir_in(config_dir);
  std::fs::create_dir_all(&snippets).map_err(|e| e.to_string())?;
  watcher.watch(&snippets, RecursiveMode::NonRecursive).map_err(|e| e.to_string())?;
  // Profiles: each one's settings.json / keybindings.json, and the list naming the active one.
  let profiles = config_dir.join(crate::user_profiles::PROFILES_DIR);
  std::fs::create_dir_all(&profiles).map_err(|e| e.to_string())?;
  watcher.watch(&profiles, RecursiveMode::Recursive).map_err(|e| e.to_string())?;
  let handle = app.clone();
  std::thread::spawn(move || {
    // Editors save in several steps (temp file, rename): one event per burst.
    while let Ok(first) = rx.recv() {
      let mut kinds = std::collections::BTreeSet::from([first]);
      while let Ok(k) = rx.recv_timeout(std::time::Duration::from_millis(150)) {
        kinds.insert(k);
      }
      for k in kinds {
        let _ = handle.emit("settings://changed", k);
      }
    }
  });
  if let Some(w) = app.try_state::<ConfigWatcher>() {
    *w.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(watcher);
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn knows_which_config_file_changed() {
    let dir = Path::new("/cfg");
    assert_eq!(changed_file(dir, Path::new("/cfg/settings.json")), Some("settings"));
    assert_eq!(changed_file(dir, Path::new("/cfg/keybindings.json")), Some("keybindings"));
    assert_eq!(changed_file(dir, &dir.join(REPOS_DIR).join("0123456789abcdef.json")), Some("repo"));
    assert_eq!(changed_file(dir, Path::new("/cfg/settings.json.tmp")), None);
    assert_eq!(changed_file(dir, Path::new("/cfg/other/settings.json")), None);
  }

  #[test]
  fn a_profile_has_its_own_files_beside_the_default_settings() {
    let dir = Path::new("/cfg");
    let profile = Path::new("/cfg/profiles/0a1b2c3d");
    assert_eq!(changed_in(dir, profile, Path::new("/cfg/profiles/0a1b2c3d/settings.json")), Some("settings"));
    assert_eq!(changed_in(dir, profile, Path::new("/cfg/profiles/0a1b2c3d/keybindings.json")), Some("keybindings"));
    // The Default profile's settings.json still holds the application-scoped settings.
    assert_eq!(changed_in(dir, profile, Path::new("/cfg/settings.json")), Some("settings"));
    // Its keybindings are not the active ones.
    assert_eq!(changed_in(dir, profile, Path::new("/cfg/keybindings.json")), None);
    assert_eq!(changed_in(dir, profile, Path::new("/cfg/profiles/ffffffff/settings.json")), None);
    assert_eq!(changed_in(dir, profile, Path::new("/cfg/profiles/profiles.json")), Some("profiles"));
    assert_eq!(changed_in(dir, profile, Path::new("/cfg/profiles/0a1b2c3d/snippets/rust.json")), Some("snippets"));
    assert_eq!(changed_in(dir, profile, Path::new("/cfg/profiles/0a1b2c3d/snippets/.rust.json.1.tmp")), None);
    assert_eq!(changed_in(dir, Path::new("/cfg"), Path::new("/cfg/snippets/all.code-snippets")), Some("snippets"));
    assert_eq!(Scope::parse("defaultUser").unwrap(), Scope::DefaultUser);
  }

  #[test]
  fn parses_only_known_scopes() {
    assert_eq!(Scope::parse("user").unwrap(), Scope::User);
    assert_eq!(Scope::parse("workspace").unwrap(), Scope::Workspace);
    assert_eq!(Scope::parse("keybindings").unwrap(), Scope::Keybindings);
    assert_eq!(Scope::parse("repo").unwrap(), Scope::Repo);
    assert!(Scope::parse("../etc").is_err());
  }

  #[test]
  fn missing_file_reads_as_none_and_write_creates_dirs() {
    let tmp = tempfile::tempdir().unwrap();
    let path = workspace_path(tmp.path()).unwrap();
    assert_eq!(path, tmp.path().join(".kingu/settings.json"));
    assert_eq!(read(&path).unwrap(), None);
    write_atomic(&path, "{ \"editor.fontSize\": 14 }").unwrap();
    assert_eq!(read(&path).unwrap().as_deref(), Some("{ \"editor.fontSize\": 14 }"));
    write_atomic(&path, "{}").unwrap();
    assert_eq!(read(&path).unwrap().as_deref(), Some("{}"));
    // No temp files left behind.
    let names: Vec<_> = std::fs::read_dir(path.parent().unwrap()).unwrap().flatten().map(|e| e.file_name()).collect();
    assert_eq!(names, ["settings.json"]);
  }

  #[cfg(unix)]
  #[test]
  fn refuses_symlinked_settings_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(outside.path(), tmp.path().join(".kingu")).unwrap();
    assert!(workspace_path(tmp.path()).is_err());
  }

  #[test]
  fn reads_a_user_value_from_jsonc() {
    let tmp = tempfile::tempdir().unwrap();
    assert_eq!(user_value(tmp.path(), "window.restoreWindows"), None);
    let text = "{\n  // keep\n  \"window.restoreWindows\": \"none\", /* note, } */\n  \"a//b\": \"x,]\\\"\",\n  \"list\": [1, 2, // two\n  ],\n}\n";
    write_atomic(&user_path(tmp.path()), text).unwrap();
    assert_eq!(user_value(tmp.path(), "window.restoreWindows"), Some(serde_json::json!("none")));
    assert_eq!(user_value(tmp.path(), "a//b"), Some(serde_json::json!("x,]\"")));
    assert_eq!(user_value(tmp.path(), "list"), Some(serde_json::json!([1, 2])));
    write_atomic(&user_path(tmp.path()), "{ broken").unwrap();
    assert_eq!(user_value(tmp.path(), "window.restoreWindows"), None);
  }

  #[test]
  fn repo_settings_live_in_the_config_dir_per_repository() {
    let config = tempfile::tempdir().unwrap();
    let (a, b) = (Path::new("/work/a"), Path::new("/work/b"));
    let pa = repo_path(config.path(), a);
    assert!(pa.starts_with(config.path().join("repos")));
    assert_ne!(pa, repo_path(config.path(), b));
    assert_eq!(pa, repo_path(config.path(), a));
    assert_eq!(repo_value(config.path(), a, "kingu.repo.setupScript"), None);
    write_atomic(&pa, "{\n  // mine\n  \"kingu.repo.setupScript\": \"bun install\",\n}\n").unwrap();
    assert_eq!(repo_value(config.path(), a, "kingu.repo.setupScript"), Some(serde_json::json!("bun install")));
    assert_eq!(repo_value(config.path(), b, "kingu.repo.setupScript"), None);
  }

  #[test]
  fn refuses_oversized_content() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(write_atomic(&tmp.path().join("settings.json"), &" ".repeat(MAX_BYTES + 1)).is_err());
  }
}
