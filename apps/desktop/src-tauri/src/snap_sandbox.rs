//! What the frontend needs to confine Snap tasks and MCP servers (`kingu_ptyd::sandbox` does the
//! confining): the launcher (`kingu-ptyd`, run as `kingu-ptyd snap-exec …`), the OS mechanism
//! it will use, and the app folders a snap must never write (trust store, settings, skill
//! plugins), so `fs = "home"` cannot untrust-proof itself or turn the sandbox off.

use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Debug, PartialEq)]
pub struct SandboxInfo {
  /// `sandbox-exec` or `bwrap`; null when nothing on this machine can enforce.
  enforcer: Option<String>,
  launcher: Option<String>,
  protect: Vec<String>,
  /// Why snaps cannot be confined here (Thai, shown to the user).
  problem: Option<String>,
}

fn info(enforcer: Result<&str, String>, launcher: Result<PathBuf, String>, protect: Vec<PathBuf>) -> SandboxInfo {
  let launcher = launcher.and_then(|p| p.to_str().map(str::to_owned).ok_or_else(|| "path ของ kingu-ptyd ไม่ใช่ UTF-8".into()));
  let problem = match (&enforcer, &launcher) {
    (Err(e), _) | (_, Err(e)) => Some(e.clone()),
    _ => None,
  };
  SandboxInfo {
    enforcer: enforcer.ok().map(str::to_owned),
    launcher: launcher.ok(),
    protect: protect.into_iter().filter_map(|p| p.to_str().map(str::to_owned)).collect(),
    problem,
  }
}

#[tauri::command]
pub fn snap_sandbox_info(app: AppHandle) -> SandboxInfo {
  let enforcer = kingu_ptyd::sandbox::enforcer(crate::shell_env::path().as_deref());
  let exe_dir = std::env::current_exe().ok().and_then(|e| e.parent().map(PathBuf::from));
  let launcher = if cfg!(unix) { crate::pty::find_daemon(std::env::var_os("KINGU_PTYD"), exe_dir.as_deref()) } else { Err("ระบบปฏิบัติการนี้ยังไม่รองรับ sandbox ของ Snap".into()) };
  let paths = app.path();
  // On macOS the config and data dirs are the same folder.
  let mut protect: Vec<PathBuf> = [paths.app_config_dir(), paths.app_data_dir(), paths.app_cache_dir()].into_iter().flatten().collect();
  protect.dedup();
  info(enforcer.as_ref().map(|e| e.name()).map_err(Clone::clone), launcher, protect)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn info_reports_the_first_problem() {
    let ok = info(Ok("sandbox-exec"), Ok("/A/kingu-ptyd".into()), vec!["/cfg".into()]);
    assert_eq!(ok, SandboxInfo { enforcer: Some("sandbox-exec".into()), launcher: Some("/A/kingu-ptyd".into()), protect: vec!["/cfg".into()], problem: None });
    let no_bwrap = info(Err("ไม่พบ bwrap".into()), Ok("/A/kingu-ptyd".into()), vec![]);
    assert_eq!((no_bwrap.enforcer, no_bwrap.problem.as_deref()), (None, Some("ไม่พบ bwrap")));
    let no_launcher = info(Ok("bwrap"), Err("ไม่พบ kingu-ptyd".into()), vec![]);
    assert_eq!((no_launcher.launcher, no_launcher.problem.as_deref()), (None, Some("ไม่พบ kingu-ptyd")));
  }
}
