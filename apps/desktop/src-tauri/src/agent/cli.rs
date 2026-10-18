//! Which agent CLIs are installed: the "Agent: Choose CLI…" picker asks for its known program
//! names and gets back those found as executables on the login-shell PATH.

use std::ffi::OsStr;
use std::path::Path;

/// At most this many names per request (the picker asks for a dozen).
const MAX_NAMES: usize = 64;

fn valid_name(name: &str) -> bool {
  !name.is_empty() && name.len() <= 64 && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)) && !name.starts_with('.')
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
  use std::os::unix::fs::PermissionsExt;
  std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
  path.is_file()
}

/// The names (in their order, once each) that are an executable file in a directory of `path`.
pub fn found_on_path(names: &[String], path: Option<&OsStr>) -> Vec<String> {
  let dirs: Vec<_> = path.map(|p| std::env::split_paths(p).collect()).unwrap_or_default();
  let mut out: Vec<String> = Vec::new();
  for name in names.iter().take(MAX_NAMES) {
    if valid_name(name) && !out.contains(name) && dirs.iter().any(|d| is_executable(&d.join(name))) {
      out.push(name.clone());
    }
  }
  out
}

/// The program of a CLI's argv, past an `env VAR=value …` prefix (how Kingu hands a CLI its
/// per-session env, e.g. the status hook file), like agentProfiles.ts `programOf`.
pub fn program_of(argv: &[String]) -> Option<&String> {
  let base = |w: &str| w.rsplit('/').next().unwrap_or(w).to_owned();
  if argv.first().is_some_and(|w| base(w) == "env") {
    let is_assign = |w: &str| w.split_once('=').is_some_and(|(k, _)| !k.is_empty() && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') && !k.as_bytes()[0].is_ascii_digit());
    return argv[1..].iter().find(|w| !is_assign(w));
  }
  argv.first()
}

#[tauri::command]
pub async fn agent_cli_found(names: Vec<String>) -> Result<Vec<String>, String> {
  tauri::async_runtime::spawn_blocking(move || found_on_path(&names, crate::shell_env::path().as_deref()))
    .await
    .map_err(|e| e.to_string())
}

#[cfg(all(test, unix))]
mod tests {
  #[test]
  fn program_past_an_env_prefix() {
    let v = |xs: &[&str]| xs.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(super::program_of(&v(&["claude", "-p"])).map(String::as_str), Some("claude"));
    assert_eq!(super::program_of(&v(&["env", "A=1", "B_2=x=y", "codex", "x"])).map(String::as_str), Some("codex"));
    assert_eq!(super::program_of(&v(&["/usr/bin/env", "A=1"])), None);
    assert_eq!(super::program_of(&[]), None);
  }

  use super::*;
  use std::os::unix::fs::PermissionsExt;

  #[test]
  fn finds_executables_only_in_order_once() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let write = |dir: &Path, name: &str, mode: u32| {
      let p = dir.join(name);
      std::fs::write(&p, "#!/bin/sh\n").unwrap();
      std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
    };
    write(a.path(), "codex", 0o755);
    write(b.path(), "claude", 0o755);
    write(b.path(), "gemini", 0o644);
    std::fs::create_dir(a.path().join("amp")).unwrap();
    let path = std::env::join_paths([a.path(), b.path()]).unwrap();
    let names: Vec<String> = ["claude", "gemini", "amp", "codex", "claude", "../codex", "missing"].map(String::from).to_vec();
    assert_eq!(found_on_path(&names, Some(&path)), ["claude", "codex"]);
    assert!(found_on_path(&names, None).is_empty());
  }

  #[test]
  fn names_are_plain_program_names() {
    assert!(valid_name("cursor-agent"));
    assert!(!valid_name("a/b"));
    assert!(!valid_name(".."));
    assert!(!valid_name(""));
  }
}
