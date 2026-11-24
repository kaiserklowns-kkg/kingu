//! `kingu-ptyd attach` in a real terminal (a PTY standing in for the one `ssh -t` gives it on a
//! host): the session outlives the attached terminal, the next attach replays its scrollback and
//! reaches the same shell, and `sessions` / `end` see and stop it. No ssh is involved.
#![cfg(unix)]

use std::io::{Read, Write};
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{Child, CommandBuilder, PtySize, native_pty_system};

const BIN: &str = env!("CARGO_BIN_EXE_kingu-ptyd");

fn wait_for(what: &str, secs: u64, check: impl Fn() -> bool) {
  let until = Instant::now() + Duration::from_secs(secs);
  while !check() {
    assert!(Instant::now() < until, "timed out waiting for {what}");
    std::thread::sleep(Duration::from_millis(20));
  }
}

/// macOS limits socket paths to 104 bytes; some temp dirs are long.
fn short_tempdir() -> tempfile::TempDir {
  tempfile::Builder::new().prefix("ka").tempdir_in("/tmp").unwrap()
}

/// One attached terminal: what it showed so far, a way to type, and the attach process.
struct Term {
  seen: Arc<Mutex<String>>,
  writer: Box<dyn Write + Send>,
  child: Box<dyn Child + Send + Sync>,
  _master: Box<dyn portable_pty::MasterPty + Send>,
}

impl Term {
  fn open(args: &[&str]) -> Term {
    let pair = native_pty_system().openpty(PtySize { rows: 30, cols: 100, pixel_width: 0, pixel_height: 0 }).unwrap();
    let mut cmd = CommandBuilder::new(BIN);
    cmd.args(args);
    cmd.env("SHELL", "/bin/sh");
    cmd.env("PS1", "$ ");
    let child = pair.slave.spawn_command(cmd).unwrap();
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let writer = pair.master.take_writer().unwrap();
    let seen = Arc::new(Mutex::new(String::new()));
    let sink = seen.clone();
    std::thread::spawn(move || {
      let mut buf = [0u8; 4096];
      while let Ok(n) = reader.read(&mut buf) {
        if n == 0 {
          break;
        }
        sink.lock().unwrap().push_str(&String::from_utf8_lossy(&buf[..n]));
      }
    });
    Term { seen, writer, child, _master: pair.master }
  }

  fn shows(&self, text: &str) -> bool {
    self.seen.lock().unwrap().contains(text)
  }

  fn type_line(&mut self, line: &str) {
    self.writer.write_all(format!("{line}\r").as_bytes()).unwrap();
    self.writer.flush().unwrap();
  }

  fn exit_code(&mut self, secs: u64) -> u32 {
    let until = Instant::now() + Duration::from_secs(secs);
    loop {
      if let Some(status) = self.child.try_wait().unwrap() {
        return status.exit_code();
      }
      assert!(Instant::now() < until, "attach did not exit; it showed: {}", self.seen.lock().unwrap());
      std::thread::sleep(Duration::from_millis(20));
    }
  }
}

fn plain(args: &[&str]) -> (i32, String) {
  let o = Command::new(BIN).args(args).output().unwrap();
  (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).trim().to_string())
}

#[test]
fn a_session_outlives_its_terminal_and_the_next_attach_replays_it() {
  if !Path::new("/bin/sh").exists() {
    eprintln!("skipped: no /bin/sh");
    return;
  }
  let tmp = short_tempdir();
  let dir = tmp.path().join("run");
  let dir_s = dir.to_str().unwrap();
  let cwd = tmp.path().canonicalize().unwrap();
  let cwd_s = cwd.to_str().unwrap();

  // Nothing runs yet: a reattach has nothing to show, and no daemon is started for it.
  let mut none = Term::open(&["attach", "--dir", dir_s, "--key", "ssh:t1"]);
  assert_eq!(none.exit_code(10), 3);
  assert_eq!(plain(&["sessions", "--dir", dir_s]), (0, "[]".into()));
  assert!(!dir.join("kingu-ptyd-1.sock").exists(), "a reattach must not start a daemon");

  // The first attach starts the session: its command is typed once, with its environment.
  let start = ["attach", "--dir", dir_s, "--key", "ssh:t1", "--cwd", cwd_s, "--env", "KINGU_T=from-env", "--idle-seconds", "1", "--", "sh", "-c", "echo started-$KINGU_T"];
  let mut first = Term::open(&start);
  wait_for("the command's output", 15, || first.shows("started-from-env"));
  first.type_line("echo \"env=$KINGU_T\"; MARK=kept-$((40+2)); echo first-$MARK");
  wait_for("the shell's answer", 15, || first.shows("env=from-env") && first.shows("first-kept-42"));

  let (code, list) = plain(&["sessions", "--dir", dir_s]);
  assert_eq!(code, 0);
  let sessions: serde_json::Value = serde_json::from_str(&list).unwrap();
  assert_eq!(sessions[0]["key"], "ssh:t1");
  assert_eq!(sessions[0]["cwd"], cwd_s);
  assert_eq!(sessions[0]["alive"], true);

  // The connection drops: the terminal and the attach process are gone, the session is not.
  first.child.kill().unwrap();
  let _ = first.child.wait();
  drop(first);
  std::thread::sleep(Duration::from_millis(300));
  let (_, list) = plain(&["sessions", "--dir", dir_s]);
  assert!(list.contains("ssh:t1"), "the session ended with its terminal: {list}");

  // Reattach: the scrollback is replayed and the same shell answers (its variable is still set).
  let mut again = Term::open(&["attach", "--dir", dir_s, "--key", "ssh:t1"]);
  wait_for("the replay", 15, || again.shows("first-kept-42"));
  again.type_line("echo again-$MARK");
  wait_for("the same shell", 15, || again.shows("again-kept-42"));

  // A starting attach to a live key attaches too, and never types the command a second time.
  again.child.kill().unwrap();
  let _ = again.child.wait();
  drop(again);
  let mut third = Term::open(&start);
  wait_for("the replay", 15, || third.shows("again-kept-42"));
  third.type_line("echo third-$MARK");
  wait_for("the same shell", 15, || third.shows("third-kept-42"));
  assert_eq!(third.seen.lock().unwrap().matches("started-from-env").count(), 1, "the command ran once");

  // The shell exits: attach reports the session ended.
  third.type_line("exit");
  assert_eq!(third.exit_code(15), 0);
  assert!(third.shows("[process exited]"));
  wait_for("the session to be dropped", 10, || plain(&["sessions", "--dir", dir_s]).1 == "[]");
}

#[test]
fn end_stops_a_session_from_outside() {
  if !Path::new("/bin/sh").exists() {
    eprintln!("skipped: no /bin/sh");
    return;
  }
  let tmp = short_tempdir();
  let dir = tmp.path().join("run");
  let dir_s = dir.to_str().unwrap();
  let cwd = tmp.path().canonicalize().unwrap();
  assert_eq!(plain(&["end", "--dir", dir_s, "--key", "ssh:t2"]), (0, "none".into()));
  let mut term = Term::open(&["attach", "--dir", dir_s, "--key", "ssh:t2", "--cwd", cwd.to_str().unwrap(), "--idle-seconds", "1"]);
  wait_for("the session", 15, || plain(&["sessions", "--dir", dir_s]).1.contains("ssh:t2"));
  assert_eq!(plain(&["end", "--dir", dir_s, "--key", "ssh:t2"]), (0, "ended".into()));
  assert_eq!(term.exit_code(15), 0, "the attached terminal sees the session end");
  assert_eq!(plain(&["sessions", "--dir", dir_s]).1, "[]");
  let info: serde_json::Value = serde_json::from_str(&plain(&["host-info"]).1).unwrap();
  assert_eq!(info["protocol"], kingu_ptyd::protocol::PROTOCOL);
}
