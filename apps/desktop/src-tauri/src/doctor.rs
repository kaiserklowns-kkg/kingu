//! Setup check: whether this machine can do a first agent task. The UI (Settings › Setup and
//! the Now banner) turns these raw facts into text; nothing here runs a shell or reads secrets.

use std::io::Read;
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

use crate::agent::cli::found_on_path;

const TIMEOUT: Duration = Duration::from_secs(5);
const MAX_DETAIL: usize = 160;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
  Ok,
  Warn,
  Fail,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Check {
  pub id: &'static str,
  pub status: Status,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub detail: Option<String>,
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub found: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Report {
  pub os: String,
  pub arch: String,
  pub checks: Vec<Check>,
}

struct Output {
  ok: bool,
  text: String,
}

fn read_all(mut r: impl Read) -> Vec<u8> {
  let mut out = Vec::new();
  let _ = r.read_to_end(&mut out);
  out
}

fn kill(child: &mut Child) {
  #[cfg(unix)]
  unsafe {
    libc::kill(-(child.id() as i32), libc::SIGKILL);
  }
  let _ = child.kill();
  let _ = child.wait();
}

/// Runs a program with the login-shell PATH, no prompts and a timeout. `None` when it cannot be
/// started or takes too long, so a blocked keychain or network cannot hold the settings page.
fn run(program: &str, args: &[&str]) -> Option<Output> {
  let mut cmd = crate::shell_env::command(program);
  cmd
    .args(args)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .env("NO_COLOR", "1")
    .env("GH_PROMPT_DISABLED", "1")
    .env("GIT_TERMINAL_PROMPT", "0");
  #[cfg(unix)]
  std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
  let mut child = cmd.spawn().ok()?;
  let out = child.stdout.take()?;
  let err = child.stderr.take()?;
  let out = std::thread::spawn(move || read_all(out));
  let err = std::thread::spawn(move || read_all(err));
  let started = Instant::now();
  let status = loop {
    match child.try_wait() {
      Ok(Some(status)) => break status,
      Ok(None) if started.elapsed() < TIMEOUT => std::thread::sleep(Duration::from_millis(20)),
      _ => {
        kill(&mut child);
        return None;
      }
    }
  };
  let stdout = String::from_utf8_lossy(&out.join().ok()?).trim().to_owned();
  let stderr = String::from_utf8_lossy(&err.join().ok()?).trim().to_owned();
  let text = if stdout.is_empty() { stderr } else { stdout };
  Some(Output { ok: status.success(), text })
}

/// The part of a version command's output worth showing: its first non-empty line, capped.
pub fn summary(text: &str) -> String {
  text
    .lines()
    .map(str::trim)
    .find(|l| !l.is_empty())
    .unwrap_or("")
    .chars()
    .take(MAX_DETAIL)
    .collect()
}

fn tool(id: &'static str, program: &str, args: &[&str], missing: Status) -> Check {
  match run(program, args) {
    Some(out) if out.ok => Check { id, status: Status::Ok, detail: Some(summary(&out.text)), found: Vec::new() },
    Some(out) => Check { id, status: missing, detail: Some(summary(&out.text)), found: Vec::new() },
    None => Check { id, status: missing, detail: None, found: Vec::new() },
  }
}

fn shell() -> Check {
  let path = std::env::var_os("SHELL").filter(|s| !s.is_empty());
  let usable = path.as_ref().is_some_and(|p| {
    let p = std::path::Path::new(p);
    p.is_file() && crate::agent::cli::is_executable(p)
  });
  Check {
    id: "shell",
    status: if usable { Status::Ok } else { Status::Warn },
    detail: path.map(|p| p.to_string_lossy().into_owned()),
    found: Vec::new(),
  }
}

pub fn report(cli_names: &[String]) -> Report {
  let mut checks = vec![
    tool("git", "git", &["--version"], Status::Fail),
    tool("gh", "gh", &["--version"], Status::Warn),
    tool("ripgrep", "rg", &["--version"], Status::Warn),
    shell(),
  ];
  let gh = checks.iter().find(|c| c.id == "gh").is_some_and(|c| c.status == Status::Ok);
  checks.push(if gh {
    tool("gh_auth", "gh", &["auth", "status"], Status::Warn)
  } else {
    Check { id: "gh_auth", status: Status::Warn, detail: None, found: Vec::new() }
  });
  let found = found_on_path(cli_names, crate::shell_env::path().as_deref());
  checks.push(Check {
    id: "agents",
    status: if found.is_empty() { Status::Fail } else { Status::Ok },
    detail: None,
    found,
  });
  checks.sort_by_key(|c| match c.id {
    "git" => 0,
    "agents" => 1,
    "gh" => 2,
    "gh_auth" => 3,
    "ripgrep" => 4,
    _ => 5,
  });
  Report { os: std::env::consts::OS.into(), arch: std::env::consts::ARCH.into(), checks }
}

#[tauri::command]
pub async fn setup_check(cli_names: Vec<String>) -> Result<Report, String> {
  tauri::async_runtime::spawn_blocking(move || report(&cli_names)).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn summary_takes_the_first_non_empty_line() {
    assert_eq!(summary("\n\n git version 2.43.0 \nmore"), "git version 2.43.0");
    assert_eq!(summary(""), "");
    assert_eq!(summary(" \n\t"), "");
    assert_eq!(summary(&"x".repeat(400)).chars().count(), MAX_DETAIL);
  }

  #[test]
  fn a_missing_tool_is_reported_without_a_detail() {
    let c = tool("nope", "/definitely/not/a/program", &[], Status::Warn);
    assert_eq!((c.status, c.detail), (Status::Warn, None));
  }

  #[test]
  fn report_always_has_the_six_checks_in_order() {
    let r = report(&["claude".into(), "codex".into()]);
    let ids: Vec<_> = r.checks.iter().map(|c| c.id).collect();
    assert_eq!(ids, ["git", "agents", "gh", "gh_auth", "ripgrep", "shell"]);
    assert!(r.checks.iter().find(|c| c.id == "agents").is_some());
  }
}
