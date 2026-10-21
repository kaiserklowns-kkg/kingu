//! `kingu account add`: runs OpenCode's or Devin's own login with a throwaway XDG home, so the
//! login lands in a folder of its own that the app then keeps as a managed account (Orca's
//! data-account-commands). The folder is removed when the command ends, Ctrl-C included.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::i18n::{Msg, tr};

/// The temporary login home; deleted on drop.
pub struct TempHome(pub PathBuf);

impl TempHome {
  /// The XDG data home the CLI saved its login under.
  pub fn data(&self) -> PathBuf {
    self.0.join("data")
  }
}

impl Drop for TempHome {
  fn drop(&mut self) {
    let _ = std::fs::remove_dir_all(&self.0);
  }
}

/// The login command of a managed-account agent: program and arguments.
pub fn login_command(agent: &str, integration: Option<&str>) -> (&'static str, Vec<String>) {
  match agent {
    "devin" => ("devin", vec!["auth".into(), "login".into(), "--force-manual-token-flow".into()]),
    _ => {
      let mut args = vec!["auth".to_owned(), "login".to_owned()];
      args.extend(integration.map(str::to_owned));
      args.push("--standalone".into());
      ("opencode", args)
    }
  }
}

/// The env of the login: every XDG home inside `base` (and OpenCode's own config, database and
/// inline auth pointed at it too).
pub fn login_env(agent: &str, base: &Path) -> Vec<(String, String)> {
  let p = |s: &str| base.join(s).display().to_string();
  let mut env = vec![
    ("XDG_DATA_HOME".to_owned(), p("data")),
    ("XDG_CONFIG_HOME".to_owned(), p("config")),
    ("XDG_CACHE_HOME".to_owned(), p("cache")),
    ("XDG_STATE_HOME".to_owned(), p("state")),
  ];
  if agent == "opencode" {
    env.push(("OPENCODE_CONFIG_DIR".into(), p("config/opencode")));
    env.push(("OPENCODE_AUTH_CONTENT".into(), String::new()));
    env.push(("OPENCODE_DB".into(), "opencode.db".into()));
  }
  env
}

pub fn run_login(agent: &str, integration: Option<&str>) -> Result<TempHome, String> {
  let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
  let base = std::env::temp_dir().join(format!("kingu-account-add-{agent}-{}-{nanos:x}", std::process::id()));
  create_private(&base).map_err(|e| tr(Msg::TempFolder, &[("detail", &e)]))?;
  let home = TempHome(base);
  let (program, args) = login_command(agent, integration);
  let shown = format!("{program} {}", args.join(" "));
  let mut child = Command::new(program).args(&args).envs(login_env(agent, &home.0)).spawn().map_err(|_| tr(Msg::LoginNotLaunched, &[("command", &program)]))?;
  // Ctrl-C reaches the login (it shares the terminal); this process waits for it to end so the
  // temporary folder, which holds a login, is always removed.
  let _ignore = IgnoreInterrupts::new();
  let status = child.wait().map_err(|_| tr(Msg::LoginNotLaunched, &[("command", &program)]))?;
  if !status.success() {
    let code = status.code().map_or_else(|| "?".to_owned(), |c| c.to_string());
    return Err(tr(Msg::LoginExited, &[("command", &shown), ("code", &code)]));
  }
  Ok(home)
}

fn create_private(dir: &Path) -> std::io::Result<()> {
  std::fs::create_dir(dir)?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
  }
  Ok(())
}

/// SIGINT / SIGTERM ignored in this process while it lives (restored on drop).
struct IgnoreInterrupts {
  #[cfg(unix)]
  old: [libc::sighandler_t; 2],
}

impl IgnoreInterrupts {
  fn new() -> Self {
    #[cfg(unix)]
    unsafe {
      Self { old: [libc::signal(libc::SIGINT, libc::SIG_IGN), libc::signal(libc::SIGTERM, libc::SIG_IGN)] }
    }
    #[cfg(not(unix))]
    Self {}
  }
}

impl Drop for IgnoreInterrupts {
  fn drop(&mut self) {
    #[cfg(unix)]
    unsafe {
      libc::signal(libc::SIGINT, self.old[0]);
      libc::signal(libc::SIGTERM, self.old[1]);
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn login_commands_and_env() {
    assert_eq!(login_command("devin", None), ("devin", vec!["auth".to_owned(), "login".into(), "--force-manual-token-flow".into()]));
    assert_eq!(login_command("opencode", Some("opencode-go")).1, vec!["auth", "login", "opencode-go", "--standalone"]);
    let env = login_env("opencode", Path::new("/tmp/x"));
    assert!(env.contains(&("XDG_DATA_HOME".into(), "/tmp/x/data".into())));
    assert!(env.contains(&("OPENCODE_DB".into(), "opencode.db".into())));
    assert!(!login_env("devin", Path::new("/tmp/x")).iter().any(|(k, _)| k.starts_with("OPENCODE")));
  }

  #[test]
  fn the_temporary_home_goes_away() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("home");
    std::fs::create_dir(&path).unwrap();
    drop(TempHome(path.clone()));
    assert!(!path.exists());
  }
}
