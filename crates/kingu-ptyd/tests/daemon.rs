//! The real daemon binary on a temporary socket: sessions survive a disconnect, a reconnect gets
//! the replay, and the daemon idles out only once no session and no client is left.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kingu_ptyd::client::{Client, Launch, connect_or_start};
use kingu_ptyd::protocol::{ClientFrame, Hello, Request, encode, socket_name};
use kingu_ptyd::{ShellSpec, Sink};

fn wait_for(what: &str, secs: u64, check: impl Fn() -> bool) {
  let until = Instant::now() + Duration::from_secs(secs);
  while !check() {
    assert!(Instant::now() < until, "timed out waiting for {what}");
    std::thread::sleep(Duration::from_millis(20));
  }
}

fn collecting() -> (Sink, Arc<Mutex<String>>) {
  let seen = Arc::new(Mutex::new(String::new()));
  let sink = seen.clone();
  (
    Box::new(move |text: String| {
      sink.lock().unwrap().push_str(&text);
      true
    }),
    seen,
  )
}

fn launch(dir: &Path) -> Launch {
  Launch {
    bin: PathBuf::from(env!("CARGO_BIN_EXE_kingu-ptyd")),
    dir: dir.to_path_buf(),
    app_version: "test".into(),
    args: vec!["--idle-seconds".into(), "1".into()],
    env: vec![("SHELL".into(), "/bin/sh".into())],
  }
}

/// macOS limits socket paths to 104 bytes; some temp dirs are long.
fn short_tempdir() -> tempfile::TempDir {
  tempfile::Builder::new().prefix("kp").tempdir_in("/tmp").unwrap()
}

#[test]
fn sessions_survive_a_disconnect_and_replay_on_reattach() {
  if !Path::new("/bin/sh").exists() {
    eprintln!("skipped: no /bin/sh");
    return;
  }
  let tmp = short_tempdir();
  let dir = tmp.path().join("ptyd");
  let socket = dir.join(socket_name());
  let key = "panel:test0001:1";

  let first = connect_or_start(&launch(&dir)).unwrap();
  let pid = first.daemon().pid;
  assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
  assert_eq!(std::fs::metadata(&socket).unwrap().permissions().mode() & 0o777, 0o600);

  let (sink, seen) = collecting();
  let env = [("PS1".to_string(), "$ ".to_string())].into();
  let spec = ShellSpec { cwd: tmp.path(), cols: 80, rows: 24, run: None, env: &env, shell: None, args: None, unset: &[], clean_env: false };
  let attached = first.spawn(key, &spec, sink).unwrap();
  assert!(attached.spawned);
  first.write(key, "echo kingu-$((6*7))\r").unwrap();
  wait_for("echo output", 10, || seen.lock().unwrap().contains("kingu-42"));
  let list = first.list().unwrap();
  assert_eq!(list.len(), 1);
  assert_eq!(list[0].key, key);
  assert!(list[0].alive);
  drop(first);

  // Longer than the idle timeout: a live session keeps the daemon up with no client connected.
  std::thread::sleep(Duration::from_millis(1800));
  assert!(socket.exists(), "daemon exited while a session was alive");

  let second = connect_or_start(&launch(&dir)).unwrap();
  assert_eq!(second.daemon().pid, pid, "reconnected to the same daemon");
  let (sink, live) = collecting();
  let again = second.attach(key, Some((100, 30)), sink).unwrap().expect("session still alive");
  assert!(!again.spawned);
  assert!(again.replay.contains("kingu-42"), "replay: {:?}", again.replay);
  second.write(key, "echo again-$((1+1))\r").unwrap();
  wait_for("live output after re-attach", 10, || live.lock().unwrap().contains("again-2"));
  assert!(second.attach("panel:test0001:404", None, collecting().0).unwrap().is_none());

  assert!(second.kill(key).unwrap());
  wait_for("session gone", 10, || second.list().unwrap().is_empty());
  drop(second);
  // No sessions, no clients: the daemon removes its socket and exits.
  wait_for("idle exit", 10, || !socket.exists());
}

#[test]
fn second_daemon_leaves_and_incompatible_clients_are_refused() {
  let tmp = short_tempdir();
  let dir = tmp.path().join("ptyd");
  let client = connect_or_start(&launch(&dir)).unwrap();

  // A second daemon for the same socket sees the lock and exits without touching the socket.
  let status = Command::new(env!("CARGO_BIN_EXE_kingu-ptyd")).arg("--dir").arg(&dir).status().unwrap();
  assert!(status.success());
  assert!(client.list().unwrap().is_empty());

  // A client from a future protocol gets the daemon's hello and then the connection closes.
  let mut raw = UnixStream::connect(dir.join(socket_name())).unwrap();
  raw.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
  let future = Hello { protocol: 99, min_compatible: 99, app_version: "future".into(), pid: 0 };
  raw.write_all(&encode(&ClientFrame { id: 1, request: Request::Hello(future) })).unwrap();
  let mut reader = BufReader::new(raw);
  let mut line = String::new();
  reader.read_line(&mut line).unwrap();
  assert!(line.contains("\"protocol\":1"), "{line}");
  line.clear();
  assert_eq!(reader.read_line(&mut line).unwrap(), 0, "connection closed after an incompatible hello");

  // A client that skips the handshake is dropped too.
  let mut raw = UnixStream::connect(dir.join(socket_name())).unwrap();
  raw.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
  raw.write_all(&encode(&ClientFrame { id: 1, request: Request::List {} })).unwrap();
  let mut line = String::new();
  assert_eq!(BufReader::new(raw).read_line(&mut line).unwrap(), 0);

  assert!(Client::connect(&dir.join(socket_name()), "test").is_ok());
  drop(client);
}
