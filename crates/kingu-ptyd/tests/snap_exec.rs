//! `kingu-ptyd snap-exec` end to end on macOS: the host filter (proxy + Seatbelt) and secrets.
//! Skipped where `sandbox-exec` cannot run (inside another sandbox).

#![cfg(target_os = "macos")]

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::{Command, Stdio};

fn launcher() -> &'static str {
  env!("CARGO_BIN_EXE_kingu-ptyd")
}

fn sandbox_works() -> bool {
  Command::new("/usr/bin/sandbox-exec").args(["-p", "(version 1)(allow default)", "/usr/bin/true"]).status().is_ok_and(|s| s.success())
}

/// A tiny HTTP server answering every request with `ok`.
fn http_server() -> u16 {
  let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
  let port = l.local_addr().unwrap().port();
  std::thread::spawn(move || {
    for mut c in l.incoming().flatten() {
      let mut buf = [0u8; 2048];
      let _ = c.read(&mut buf);
      let _ = c.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
    }
  });
  port
}

fn snap_exec(root: &Path, flags: &[&str], argv: &[&str]) -> (bool, String) {
  let out = Command::new(launcher())
    .arg("snap-exec")
    .args(["--root", root.to_str().unwrap()])
    .args(flags)
    .arg("--")
    .args(argv)
    .stdin(Stdio::null())
    .output()
    .unwrap();
  (out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned())
}

#[test]
fn hosts_go_through_the_filter_and_nothing_else_gets_out() {
  if !sandbox_works() {
    eprintln!("sandbox-exec cannot run here; skipping");
    return;
  }
  let root = tempfile::tempdir().unwrap();
  let allowed = http_server();
  let other = http_server();
  let host = format!("127.0.0.1:{allowed}");
  let curl = |url: &str, extra: &[&str]| {
    let mut a = vec!["/usr/bin/curl", "-s", "-f", "--max-time", "10"];
    a.extend_from_slice(extra);
    a.push(url);
    snap_exec(root.path(), &["--network", "on", "--host", &host], &a.iter().map(|s| *s).collect::<Vec<_>>())
  };
  assert_eq!(curl(&format!("http://127.0.0.1:{allowed}/"), &[]), (true, "ok".to_string()));
  // Another host (here: port) is refused by the proxy.
  assert!(!curl(&format!("http://127.0.0.1:{other}/"), &[]).0);
  // Going around the proxy is refused by the sandbox.
  assert!(!curl(&format!("http://127.0.0.1:{allowed}/"), &["--noproxy", "*"]).0);
  // Without a host list, network on reaches it directly.
  let (ok, out) = snap_exec(root.path(), &["--network", "on"], &["/usr/bin/curl", "-s", "-f", "--max-time", "10", &format!("http://127.0.0.1:{other}/")]);
  assert!(ok && out == "ok");
}

#[test]
fn secrets_reach_the_command_only_through_the_file() {
  if !sandbox_works() {
    eprintln!("sandbox-exec cannot run here; skipping");
    return;
  }
  use std::os::unix::fs::PermissionsExt;
  let root = tempfile::tempdir().unwrap();
  let dir = tempfile::tempdir().unwrap();
  let file = dir.path().join("s.json");
  std::fs::write(&file, r#"{"API_KEY":"v1","UNDECLARED":"no"}"#).unwrap();
  std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
  let hide = dir.path().to_str().unwrap();
  let (ok, out) = snap_exec(
    root.path(),
    &["--network", "off", "--secret", "API_KEY", "--secrets-file-once", file.to_str().unwrap(), "--hide", hide],
    &["/bin/sh", "-c", "printf '%s|%s' \"$API_KEY\" \"$UNDECLARED\""],
  );
  assert!(ok);
  assert_eq!(out, "v1|");
  assert!(!file.exists(), "read once, then deleted");
}
