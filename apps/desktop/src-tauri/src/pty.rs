//! PTY sessions for the integrated terminal: spawn a login shell, stream its output over a
//! Tauri channel, and accept input and resizes from the webview.
//!
//! Sessions live in this process, keyed by a name the webview picks (`panel:3`, `cli:<slug>:…`),
//! so they outlive a webview reload: the reloaded page asks for the same key and re-attaches,
//! getting the recent output replayed from the session's scrollback. Surviving an app quit would
//! need a separate daemon owning the PTYs.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use tauri::State;
use tauri::ipc::Channel;

/// Output kept per session for a re-attaching webview.
const SCROLLBACK_BYTES: usize = 256 * 1024;
const EXITED: &str = "\r\n[process exited]\r\n";

/// The last `cap` bytes of a session's output. Trimmed lazily, so a busy terminal does not move
/// the whole buffer on every chunk.
pub struct Scrollback {
  text: String,
  cap: usize,
}

impl Scrollback {
  pub fn new(cap: usize) -> Self {
    Self { text: String::new(), cap }
  }

  pub fn push(&mut self, chunk: &str) {
    self.text.push_str(chunk);
    if self.text.len() > self.cap + self.cap / 4 {
      let start = tail_start(&self.text, self.cap);
      self.text.drain(..start);
    }
  }

  pub fn contents(&self) -> &str {
    &self.text[tail_start(&self.text, self.cap)..]
  }
}

/// Where the last `cap` bytes of `s` start: on a character boundary, and at the next line when
/// one is close, so a replay rarely begins inside an escape sequence.
fn tail_start(s: &str, cap: usize) -> usize {
  if s.len() <= cap {
    return 0;
  }
  let mut i = s.len() - cap;
  while !s.is_char_boundary(i) {
    i += 1;
  }
  match s[i..].find('\n') {
    Some(nl) if nl < 4096 => i + nl + 1,
    _ => i,
  }
}

/// Session keys come from the webview; keep them short and plain.
pub fn validate_key(key: &str) -> Result<(), String> {
  let ok = (1..=128).contains(&key.len()) && key.bytes().all(|b| b.is_ascii_alphanumeric() || b":_.-".contains(&b));
  if ok { Ok(()) } else { Err(format!("terminal key ไม่ถูกต้อง: {key:?}")) }
}

/// Output of one session: the scrollback, and the webview channel while one is attached.
struct Output {
  scrollback: Scrollback,
  sink: Option<Channel<String>>,
}

impl Output {
  fn emit(&mut self, text: String) {
    self.scrollback.push(&text);
    // A reloaded page leaves a dead channel: stop forwarding until the next attach, keep buffering.
    if let Some(sink) = &self.sink
      && sink.send(text).is_err()
    {
      self.sink = None;
    }
  }
}

struct Session {
  id: u32,
  writer: Box<dyn Write + Send>,
  master: Box<dyn MasterPty + Send>,
  child: Box<dyn portable_pty::Child + Send + Sync>,
  output: Arc<Mutex<Output>>,
}

impl Session {
  /// Ends the shell off the caller's thread (`kill` waits up to ~200ms for SIGHUP to work).
  fn kill(mut self) {
    std::thread::spawn(move || {
      let _ = self.child.kill();
      let _ = self.child.wait();
    });
  }
}

type Sessions = Arc<Mutex<HashMap<String, Session>>>;

#[derive(Default)]
pub struct Ptys {
  next_id: AtomicU32,
  sessions: Sessions,
  /// Keys spawned by this process. One whose shell exited starts again without its `run`
  /// command, so a reload never re-types an agent CLI's first prompt.
  started: Mutex<HashSet<String>>,
}

/// What `pty_spawn` returns: output to write before live data, and whether a new shell started.
#[derive(serde::Serialize)]
pub struct Attached {
  pub replay: String,
  pub spawned: bool,
}

fn size(cols: u16, rows: u16) -> PtySize {
  PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }
}

/// Splits `buf` at the end of its last complete UTF-8 sequence, so a multi-byte
/// character cut by a read boundary is held back for the next chunk.
fn utf8_prefix_len(buf: &[u8]) -> usize {
  match std::str::from_utf8(buf) {
    Ok(_) => buf.len(),
    Err(e) if e.error_len().is_none() => e.valid_up_to(),
    // Invalid bytes, not a cut: emit everything and let lossy decoding replace them.
    Err(_) => buf.len(),
  }
}

/// POSIX shell quoting for one argument: bare when it only has safe characters, else in single
/// quotes (`'` becomes `'\''`). Newlines stay inside the quotes, so a multi-line prompt is one argument.
pub fn shell_quote(arg: &str) -> String {
  let safe = !arg.is_empty() && arg.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_./=:@%+,".contains(&b));
  if safe {
    arg.to_string()
  } else {
    format!("'{}'", arg.replace('\'', "'\\''"))
  }
}

/// The command line typed into a new terminal for `run` (each argument quoted, so a prompt or a
/// setting value can never become shell syntax).
pub fn command_line(argv: &[String]) -> Result<String, String> {
  if argv.is_empty() || argv[0].is_empty() {
    return Err("คำสั่งว่าง".into());
  }
  if argv.iter().any(|a| a.contains('\0')) {
    return Err("คำสั่งมีอักขระ NUL".into());
  }
  Ok(argv.iter().map(|a| shell_quote(a)).collect::<Vec<_>>().join(" "))
}

/// Re-attaches the webview to the live session `key`, if there is one: `on_data` replaces the old
/// channel and gets everything after the returned replay. With a size (the terminal is shown), the
/// PTY takes it; a terminal attached while hidden keeps the old size until it is shown.
pub fn attach(ptys: &Ptys, key: &str, size_now: Option<(u16, u16)>, on_data: Channel<String>) -> Option<Attached> {
  let sessions = ptys.sessions.lock().unwrap();
  let s = sessions.get(key)?;
  let replay = {
    // Under the output lock, so no chunk is both replayed and sent, or lost in between.
    let mut out = s.output.lock().unwrap();
    out.sink = Some(on_data);
    out.scrollback.contents().to_string()
  };
  if let Some((cols, rows)) = size_now {
    let same = s.master.get_size().is_ok_and(|now| now.cols == cols && now.rows == rows);
    if same {
      // A full-screen program (an agent CLI) repaints on SIGWINCH; an unchanged size sends none.
      #[cfg(unix)]
      if let Some(group) = s.master.process_group_leader() {
        unsafe { libc::killpg(group, libc::SIGWINCH) };
      }
    } else {
      let _ = s.master.resize(size(cols, rows));
    }
  }
  Some(Attached { replay, spawned: false })
}

/// A login shell in `cwd`, as session `key`. With `run`, that command is typed into the shell once
/// it starts (like Orca starting an agent CLI in a worktree terminal): when it exits, the shell
/// stays open. A key whose earlier shell exited gets a plain shell.
pub fn spawn_shell(ptys: &Ptys, key: &str, cwd: &Path, cols: u16, rows: u16, on_data: Channel<String>, run: Option<&[String]>) -> Result<Attached, String> {
  let again = !ptys.started.lock().unwrap().insert(key.to_string());
  let line = if again { None } else { run.map(command_line).transpose()? };
  let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
  let mut cmd = CommandBuilder::new(shell);
  cmd.arg("-l");
  cmd.cwd(cwd);
  spawn(ptys, key, cmd, cols, rows, on_data, line)
}

fn spawn(ptys: &Ptys, key: &str, mut cmd: CommandBuilder, cols: u16, rows: u16, on_data: Channel<String>, line: Option<String>) -> Result<Attached, String> {
  let pair = native_pty_system().openpty(size(cols, rows)).map_err(|e| e.to_string())?;
  cmd.env("TERM", "xterm-256color");
  cmd.env("COLORTERM", "truecolor");
  let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
  drop(pair.slave);

  let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
  let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
  if let Some(line) = line {
    // The tty buffers it until the shell reads its first line.
    writer.write_all(format!("{line}\r").as_bytes()).map_err(|e| e.to_string())?;
  }
  let id = ptys.next_id.fetch_add(1, Ordering::Relaxed) + 1;
  let output = Arc::new(Mutex::new(Output { scrollback: Scrollback::new(SCROLLBACK_BYTES), sink: Some(on_data) }));

  let out = output.clone();
  let sessions = ptys.sessions.clone();
  let owner = key.to_string();
  std::thread::spawn(move || {
    let mut chunk = [0u8; 8192];
    let mut pending: Vec<u8> = Vec::new();
    loop {
      match reader.read(&mut chunk) {
        Ok(0) | Err(_) => break,
        Ok(n) => {
          pending.extend_from_slice(&chunk[..n]);
          let cut = utf8_prefix_len(&pending);
          if cut == 0 {
            continue;
          }
          let text = String::from_utf8_lossy(&pending[..cut]).into_owned();
          pending.drain(..cut);
          out.lock().unwrap().emit(text);
        }
      }
    }
    out.lock().unwrap().emit(EXITED.to_string());
    // The shell is gone: drop the session, unless a kill (or a new shell under this key) got there first.
    let ended = {
      let mut map = sessions.lock().unwrap();
      if map.get(&owner).is_some_and(|s| s.id == id) { map.remove(&owner) } else { None }
    };
    if let Some(mut s) = ended {
      let _ = s.child.wait();
    }
  });

  let session = Session { id, writer, master: pair.master, child, output };
  if let Some(old) = ptys.sessions.lock().unwrap().insert(key.to_string(), session) {
    old.kill();
  }
  Ok(Attached { replay: String::new(), spawned: true })
}

/// Re-attaches to a live session without starting one (a terminal mounted hidden after a reload,
/// so an agent CLI's output keeps reaching the page). Null when `key` has no live shell.
#[tauri::command]
pub fn pty_attach(ptys: State<'_, Ptys>, key: String, cols: Option<u16>, rows: Option<u16>, on_data: Channel<String>) -> Result<Option<Attached>, String> {
  validate_key(&key)?;
  Ok(attach(&ptys, &key, cols.zip(rows), on_data))
}

#[tauri::command]
pub fn pty_write(ptys: State<'_, Ptys>, key: String, data: String) -> Result<(), String> {
  let mut sessions = ptys.sessions.lock().unwrap();
  let s = sessions.get_mut(&key).ok_or("no such terminal")?;
  s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(ptys: State<'_, Ptys>, key: String, cols: u16, rows: u16) -> Result<(), String> {
  let sessions = ptys.sessions.lock().unwrap();
  let s = sessions.get(&key).ok_or("no such terminal")?;
  s.master.resize(size(cols, rows)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(ptys: State<'_, Ptys>, key: String) -> Result<(), String> {
  let removed = ptys.sessions.lock().unwrap().remove(&key);
  if let Some(s) = removed {
    log::info!("terminal {key} killed");
    s.kill();
  }
  Ok(())
}

/// Keys of the live sessions, so a reloaded page can kill the ones it no longer shows.
#[tauri::command]
pub fn pty_list(ptys: State<'_, Ptys>) -> Vec<String> {
  ptys.sessions.lock().unwrap().keys().cloned().collect()
}

#[cfg(test)]
mod tests {
  use std::io::Write;
  use std::path::Path;
  use std::sync::{Arc, Mutex};
  use std::time::{Duration, Instant};

  use portable_pty::CommandBuilder;
  use tauri::ipc::{Channel, InvokeResponseBody};

  use super::{Ptys, Scrollback, attach, command_line, shell_quote, spawn, tail_start, utf8_prefix_len, validate_key};

  #[test]
  fn holds_back_a_cut_thai_character() {
    let thai = "ก".as_bytes(); // 3 bytes
    let mut buf = b"ok ".to_vec();
    buf.extend_from_slice(&thai[..2]);
    assert_eq!(utf8_prefix_len(&buf), 3);
    buf.push(thai[2]);
    assert_eq!(utf8_prefix_len(&buf), buf.len());
  }

  #[test]
  fn passes_invalid_bytes_through() {
    assert_eq!(utf8_prefix_len(&[b'a', 0xff, b'b']), 3);
  }

  #[test]
  fn quotes_arguments_for_the_shell() {
    assert_eq!(shell_quote("go"), "go");
    assert_eq!(shell_quote("./..."), "./...");
    assert_eq!(shell_quote("แก้บั๊ก login"), "'แก้บั๊ก login'");
    assert_eq!(shell_quote("it's $(rm -rf ~)"), "'it'\\''s $(rm -rf ~)'");
    assert_eq!(shell_quote(""), "''");
    assert_eq!(command_line(&["claude".into(), "a\nb".into()]).unwrap(), "claude 'a\nb'");
    assert!(command_line(&[]).is_err());
    assert!(command_line(&["x\0".into()]).is_err());
  }

  #[test]
  fn scrollback_keeps_the_tail_within_its_cap() {
    let mut sb = Scrollback::new(100);
    sb.push("hello ");
    assert_eq!(sb.contents(), "hello ");
    for i in 0..1000 {
      sb.push(&format!("{i:04}"));
    }
    assert!(sb.contents().len() <= 100);
    assert!(sb.contents().ends_with("0999"));
    // The buffer itself is trimmed too, not only the view of it.
    assert!(sb.text.len() <= 125);
  }

  #[test]
  fn scrollback_cuts_on_a_character_boundary() {
    // 3-byte Thai characters: a 10-byte cap lands inside one; the cut moves forward to the next.
    let s = "กขคงจฉ";
    let start = tail_start(s, 10);
    assert!(s.is_char_boundary(start));
    assert_eq!(&s[start..], "งจฉ");
    let mut sb = Scrollback::new(10);
    for _ in 0..50 {
      sb.push("กข");
    }
    assert!(sb.contents().len() <= 10);
    assert!(sb.contents().chars().all(|c| c == 'ก' || c == 'ข'));
  }

  #[test]
  fn scrollback_prefers_starting_at_a_line() {
    let s = format!("{}\nline two\n", "x".repeat(50));
    assert_eq!(&s[tail_start(&s, 20)..], "line two\n");
  }

  fn collecting() -> (Channel<String>, Arc<Mutex<String>>) {
    let seen = Arc::new(Mutex::new(String::new()));
    let sink = seen.clone();
    let channel = Channel::new(move |body| {
      if let InvokeResponseBody::Json(json) = body {
        sink.lock().unwrap().push_str(&serde_json::from_str::<String>(&json).unwrap_or_default());
      }
      Ok(())
    });
    (channel, seen)
  }

  fn wait_for(what: &str, check: impl Fn() -> bool) {
    let until = Instant::now() + Duration::from_secs(10);
    while !check() {
      assert!(Instant::now() < until, "timed out waiting for {what}");
      std::thread::sleep(Duration::from_millis(20));
    }
  }

  #[test]
  fn reattaches_with_replay_and_drops_the_session_on_exit() {
    if !Path::new("/bin/sh").exists() {
      return;
    }
    let ptys = Ptys::default();
    let mut cmd = CommandBuilder::new("/bin/sh");
    cmd.args(["-c", "echo first; read line; echo got $line"]);
    let (first, seen) = collecting();
    let spawned = spawn(&ptys, "test:1", cmd, 80, 24, first, None).unwrap();
    assert!(spawned.spawned);
    wait_for("first output", || seen.lock().unwrap().contains("first"));

    // A reload: a new channel attaches, gets the output so far, and the shell keeps running.
    let (second, live) = collecting();
    let attached = attach(&ptys, "test:1", Some((100, 30)), second).unwrap();
    assert!(!attached.spawned);
    assert!(attached.replay.contains("first"));
    ptys.sessions.lock().unwrap().get_mut("test:1").unwrap().writer.write_all(b"again\r").unwrap();
    wait_for("output on the new channel", || live.lock().unwrap().contains("got again"));
    wait_for("exit", || ptys.sessions.lock().unwrap().is_empty());
    assert!(live.lock().unwrap().contains("[process exited]"));
    assert!(attach(&ptys, "test:1", None, collecting().0).is_none());
  }

  #[test]
  fn validates_session_keys() {
    for ok in ["panel:1", "ade::t3", "ade:fix-login:t12", "cli:fix-login:1700000000000", "a.b_c-D"] {
      assert!(validate_key(ok).is_ok(), "{ok}");
    }
    for bad in ["", "a b", "a/b", "ก", "x\n", &"k".repeat(129)] {
      assert!(validate_key(bad).is_err(), "{bad:?}");
    }
    assert!(validate_key(&"k".repeat(128)).is_ok());
  }
}
