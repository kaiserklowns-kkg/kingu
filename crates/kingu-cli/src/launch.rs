//! `kingu <paths…>` with Kingu not running starts the app with the paths as its launch arguments,
//! like VS Code's `code <path>`; the app then opens them per `window.restoreWindows` (its
//! startup.rs). Without paths the app just starts (the command then waits for it to listen and
//! sends what launch arguments cannot carry: a diff, `--wait`, …). Only the command line to run
//! is worked out here, so it is testable.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// The app's executable names next to this command: the bundle's (`Kingu`, the product name)
/// and a development build's (`kingu-desktop`, the crate).
const APP_NAMES: &[&str] = if cfg!(windows) { &["Kingu.exe", "kingu-desktop.exe"] } else { &["Kingu", "kingu-desktop"] };

/// The program and arguments that start Kingu with `paths`. `exe`: this command's executable with
/// links resolved (the app links it as `kingu`); `app`: `KINGU_APP`, a `.app` bundle or an
/// executable to use instead. Inside a macOS bundle it goes through `open -a`, so Launch
/// Services starts the app as from the Finder. None: no app found.
pub fn app_command(exe: &Path, app: Option<OsString>, paths: &[PathBuf]) -> Option<(PathBuf, Vec<OsString>)> {
  let args = || paths.iter().map(|p| p.as_os_str().to_owned()).collect::<Vec<_>>();
  let via_open = |bundle: &Path| {
    let mut a: Vec<OsString> = vec!["-a".into(), bundle.as_os_str().to_owned()];
    if !paths.is_empty() {
      a.push("--args".into());
      a.extend(args());
    }
    (PathBuf::from("/usr/bin/open"), a)
  };
  if let Some(app) = app.filter(|a| !a.is_empty()).map(PathBuf::from) {
    if app.extension().is_some_and(|e| e == "app") {
      return Some(via_open(&app));
    }
    return app.is_file().then(|| (app, args()));
  }
  let dir = exe.parent()?;
  if cfg!(target_os = "macos")
    && dir.ends_with("Contents/MacOS")
    && let Some(bundle) = dir.parent().and_then(Path::parent).filter(|b| b.extension().is_some_and(|e| e == "app"))
  {
    return Some(via_open(bundle));
  }
  APP_NAMES.iter().map(|n| dir.join(n)).find(|p| p.is_file()).map(|p| (p, args()))
}

/// Starts Kingu with `paths` and returns at once (the app keeps running on its own).
pub fn start(paths: &[PathBuf]) -> Result<(), String> {
  let exe = std::env::current_exe().and_then(|e| e.canonicalize()).map_err(|e| e.to_string())?;
  let (program, args) = app_command(&exe, std::env::var_os("KINGU_APP"), paths).ok_or_else(|| format!("no Kingu app next to {}", exe.display()))?;
  std::process::Command::new(&program)
    .args(&args)
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null())
    .spawn()
    .map(drop)
    .map_err(|e| format!("{}: {e}", program.display()))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn os(v: &[&str]) -> Vec<OsString> {
    v.iter().map(OsString::from).collect()
  }

  #[test]
  fn finds_the_app_next_to_the_command() {
    let tmp = tempfile::tempdir().unwrap();
    let dev = tmp.path().join("target/debug");
    std::fs::create_dir_all(&dev).unwrap();
    let exe = dev.join("kingu-cli");
    let w = [PathBuf::from("/w/app")];
    assert_eq!(app_command(&exe, None, &w), None);
    std::fs::write(dev.join(APP_NAMES[1]), "").unwrap();
    assert_eq!(app_command(&exe, None, &w), Some((dev.join(APP_NAMES[1]), os(&["/w/app"]))));
    // Several paths, or none (the app restores its last session).
    let two = [PathBuf::from("/w/a"), PathBuf::from("/w/b.ts")];
    assert_eq!(app_command(&exe, None, &two).unwrap().1, os(&["/w/a", "/w/b.ts"]));
    assert!(app_command(&exe, None, &[]).unwrap().1.is_empty());
    // KINGU_APP wins: a bundle through `open -a`, an executable as it is.
    let (program, args) = app_command(&exe, Some("/Applications/Kingu.app".into()), &w).unwrap();
    assert_eq!((program, args), (PathBuf::from("/usr/bin/open"), os(&["-a", "/Applications/Kingu.app", "--args", "/w/app"])));
    assert_eq!(app_command(&exe, Some("/Applications/Kingu.app".into()), &[]).unwrap().1, os(&["-a", "/Applications/Kingu.app"]));
    let own = dev.join(APP_NAMES[1]);
    assert_eq!(app_command(&exe, Some(own.clone().into()), &w).map(|c| c.0), Some(own));
    assert_eq!(app_command(&exe, Some(tmp.path().join("missing").into()), &w), None);
  }

  #[cfg(target_os = "macos")]
  #[test]
  fn inside_a_bundle_it_goes_through_launch_services() {
    let exe = Path::new("/Applications/Kingu.app/Contents/MacOS/kingu-cli");
    let (program, args) = app_command(exe, None, &[PathBuf::from("/w/a.ts")]).unwrap();
    assert_eq!(program, PathBuf::from("/usr/bin/open"));
    assert_eq!(args, os(&["-a", "/Applications/Kingu.app", "--args", "/w/a.ts"]));
  }
}
