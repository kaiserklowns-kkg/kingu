//! PTY sessions keyed by a name the webview picks (`panel:<root>:3`, `cli:<root>:<slug>:…`): a
//! login shell per key, its recent output in a scrollback ring, and at most one viewer (`Sink`)
//! receiving live output. A viewer that attaches takes over the stream and gets the scrollback
//! replayed first. The daemon and the app's in-process fallback both use this.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};

/// Output kept per session for a re-attaching viewer.
pub const SCROLLBACK_BYTES: usize = 256 * 1024;
const EXITED: &str = "\r\n[process exited]\r\n";

/// Receives a session's live output; returns false once the viewer is gone (a reloaded page, a
/// closed connection), and the session then keeps buffering until the next attach.
pub type Sink = Box<dyn FnMut(String) -> bool + Send>;

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

/// Environment variables a parent Claude Code session leaves behind.
pub fn is_agent_session_marker(key: &str) -> bool {
  key == "CLAUDECODE" || key.starts_with("CLAUDE_CODE_")
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

/// Output of one session: the scrollback, and the viewer while one is attached.
struct Output {
  scrollback: Scrollback,
  sink: Option<Sink>,
}

impl Output {
  fn emit(&mut self, text: String) {
    self.scrollback.push(&text);
    if let Some(sink) = &mut self.sink
      && !sink(text)
    {
      self.sink = None;
    }
  }
}

struct Session {
  id: u32,
  cwd: PathBuf,
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

/// What a spawn or attach returns: output to show before live data, and whether a new shell started.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Attached {
  pub replay: String,
  pub spawned: bool,
}

/// One live session, for `list`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SessionInfo {
  pub key: String,
  pub cwd: String,
  /// False between the shell's exit and the session being dropped.
  pub alive: bool,
}

/// What `open` starts when `key` has no live session.
pub struct ShellSpec<'a> {
  pub cwd: &'a Path,
  pub cols: u16,
  pub rows: u16,
  /// Typed into the new shell once, on the first spawn of this key.
  pub run: Option<&'a [String]>,
  pub env: &'a BTreeMap<String, String>,
}

#[derive(Default)]
pub struct Host {
  next_id: AtomicU32,
  sessions: Sessions,
  /// Keys spawned by this host. One whose shell exited starts again without its `run`
  /// command, so a re-attach never re-types an agent CLI's first prompt.
  started: Mutex<HashSet<String>>,
  opening: Mutex<()>,
}

fn size(cols: u16, rows: u16) -> PtySize {
  PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }
}

impl Host {
  /// Re-attaches a viewer to the live session `key`, if there is one: `sink` replaces the old
  /// viewer and gets everything after the returned replay. With a size (the terminal is shown),
  /// the PTY takes it; a terminal attached while hidden keeps the old size until it is shown.
  pub fn attach(&self, key: &str, size_now: Option<(u16, u16)>, sink: Sink) -> Option<Attached> {
    self.attach_taking(key, size_now, &mut Some(sink))
  }

  /// `attach` that takes the sink only when `key` is live, so a miss can still spawn with it.
  fn attach_taking(&self, key: &str, size_now: Option<(u16, u16)>, sink: &mut Option<Sink>) -> Option<Attached> {
    let sessions = self.sessions.lock().unwrap();
    let s = sessions.get(key)?;
    let replay = {
      // Under the output lock, so no chunk is both replayed and sent, or lost in between.
      let mut out = s.output.lock().unwrap();
      out.sink = sink.take();
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

  /// Attaches to the live session `key`, else starts a login shell for it (`ShellSpec`).
  pub fn open(&self, key: &str, spec: &ShellSpec<'_>, sink: Sink) -> Result<Attached, String> {
    validate_key(key)?;
    // Two viewers opening one key at once must not both spawn (the second would kill the first).
    let _one = self.opening.lock().unwrap();
    let mut sink = Some(sink);
    if let Some(a) = self.attach_taking(key, Some((spec.cols, spec.rows)), &mut sink) {
      return Ok(a);
    }
    self.spawn_shell(key, spec, sink.ok_or("terminal sink หาย")?)
  }

  /// A login shell in `cwd`, as session `key`. With `run`, that command is typed into the shell
  /// once it starts (like Orca starting an agent CLI in a worktree terminal): when it exits, the
  /// shell stays open. A key whose earlier shell exited gets a plain shell.
  pub fn spawn_shell(&self, key: &str, spec: &ShellSpec<'_>, sink: Sink) -> Result<Attached, String> {
    validate_key(key)?;
    if !spec.cwd.is_absolute() || !spec.cwd.is_dir() {
      return Err(format!("ไม่พบโฟลเดอร์ {}", spec.cwd.display()));
    }
    let again = !self.started.lock().unwrap().insert(key.to_string());
    let line = if again { None } else { spec.run.map(command_line).transpose()? };
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(shell);
    cmd.arg("-l");
    cmd.cwd(spec.cwd);
    for (k, v) in spec.env {
      if !is_agent_session_marker(k) {
        cmd.env(k, v);
      }
    }
    self.spawn(key, cmd, spec.cols, spec.rows, sink, line)
  }

  /// Starts `cmd` in a new PTY as session `key` (replacing a live one), typing `line` into it.
  pub fn spawn(&self, key: &str, mut cmd: CommandBuilder, cols: u16, rows: u16, sink: Sink, line: Option<String>) -> Result<Attached, String> {
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(|e| e.to_string())?;
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // An agent CLI started here must be a session of its own, not a child of whatever Claude Code
    // session launched Kingu (its markers turn off transcripts and change behaviour).
    for (k, _) in std::env::vars_os() {
      if is_agent_session_marker(&k.to_string_lossy()) {
        cmd.env_remove(&k);
      }
    }
    let cwd = cmd.get_cwd().map(PathBuf::from).unwrap_or_default();
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    if let Some(line) = line {
      // The tty buffers it until the shell reads its first line.
      writer.write_all(format!("{line}\r").as_bytes()).map_err(|e| e.to_string())?;
    }
    let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let output = Arc::new(Mutex::new(Output { scrollback: Scrollback::new(SCROLLBACK_BYTES), sink: Some(sink) }));

    let out = output.clone();
    let sessions = self.sessions.clone();
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

    let session = Session { id, cwd, writer, master: pair.master, child, output };
    if let Some(old) = self.sessions.lock().unwrap().insert(key.to_string(), session) {
      old.kill();
    }
    Ok(Attached { replay: String::new(), spawned: true })
  }

  pub fn write(&self, key: &str, data: &[u8]) -> Result<(), String> {
    let mut sessions = self.sessions.lock().unwrap();
    let s = sessions.get_mut(key).ok_or("no such terminal")?;
    s.writer.write_all(data).map_err(|e| e.to_string())
  }

  pub fn resize(&self, key: &str, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = self.sessions.lock().unwrap();
    let s = sessions.get(key).ok_or("no such terminal")?;
    s.master.resize(size(cols, rows)).map_err(|e| e.to_string())
  }

  /// Ends session `key`; false when there was none.
  pub fn kill(&self, key: &str) -> bool {
    let removed = self.sessions.lock().unwrap().remove(key);
    removed.map(Session::kill).is_some()
  }

  /// Ends every session; returns how many there were.
  pub fn kill_all(&self) -> usize {
    let all: Vec<Session> = self.sessions.lock().unwrap().drain().map(|(_, s)| s).collect();
    let n = all.len();
    all.into_iter().for_each(Session::kill);
    n
  }

  pub fn list(&self) -> Vec<SessionInfo> {
    let mut sessions = self.sessions.lock().unwrap();
    let mut out: Vec<SessionInfo> = sessions
      .iter_mut()
      .map(|(key, s)| SessionInfo { key: key.clone(), cwd: s.cwd.display().to_string(), alive: matches!(s.child.try_wait(), Ok(None)) })
      .collect();
    out.sort_by(|a, b| a.key.cmp(&b.key));
    out
  }

  pub fn len(&self) -> usize {
    self.sessions.lock().unwrap().len()
  }

  pub fn is_empty(&self) -> bool {
    self.len() == 0
  }
}

#[cfg(test)]
pub(crate) mod tests {
  use std::path::Path;
  use std::sync::{Arc, Mutex};
  use std::time::{Duration, Instant};

  use portable_pty::CommandBuilder;

  use super::{Host, Scrollback, Sink, command_line, is_agent_session_marker, shell_quote, tail_start, utf8_prefix_len, validate_key};

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
  fn drops_parent_agent_session_markers() {
    assert!(is_agent_session_marker("CLAUDECODE"));
    assert!(is_agent_session_marker("CLAUDE_CODE_CHILD_SESSION"));
    assert!(!is_agent_session_marker("ANTHROPIC_API_KEY"));
    assert!(!is_agent_session_marker("PATH"));
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

  pub(crate) fn collecting() -> (Sink, Arc<Mutex<String>>) {
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

  pub(crate) fn wait_for(what: &str, check: impl Fn() -> bool) {
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
    let host = Host::default();
    let mut cmd = CommandBuilder::new("/bin/sh");
    cmd.args(["-c", "echo first; read line; echo got $line"]);
    cmd.cwd("/");
    let (first, seen) = collecting();
    let spawned = host.spawn("test:1", cmd, 80, 24, first, None).unwrap();
    assert!(spawned.spawned);
    wait_for("first output", || seen.lock().unwrap().contains("first"));
    assert_eq!(host.list()[0].key, "test:1");
    assert_eq!(host.list()[0].cwd, "/");

    // A reload: a new viewer attaches, gets the output so far, and the shell keeps running.
    let (second, live) = collecting();
    let attached = host.attach("test:1", Some((100, 30)), second).unwrap();
    assert!(!attached.spawned);
    assert!(attached.replay.contains("first"));
    host.write("test:1", b"again\r").unwrap();
    wait_for("output on the new viewer", || live.lock().unwrap().contains("got again"));
    wait_for("exit", || host.is_empty());
    assert!(live.lock().unwrap().contains("[process exited]"));
    assert!(host.attach("test:1", None, collecting().0).is_none());
  }

  #[test]
  fn a_gone_viewer_stops_receiving_but_output_is_kept() {
    if !Path::new("/bin/sh").exists() {
      return;
    }
    let host = Host::default();
    let mut cmd = CommandBuilder::new("/bin/sh");
    cmd.args(["-c", "read a; echo one-$a; read b; echo two-$b; read c"]);
    let calls = Arc::new(Mutex::new(0));
    let counted = calls.clone();
    host.spawn("test:gone", cmd, 80, 24, Box::new(move |_| {
      *counted.lock().unwrap() += 1;
      false
    }), None).unwrap();
    host.write("test:gone", b"x\r").unwrap();
    wait_for("first chunk", || *calls.lock().unwrap() > 0);
    host.write("test:gone", b"y\r").unwrap();
    let (sink, live) = collecting();
    wait_for("both lines buffered", || host.attach("test:gone", None, collecting().0).is_some_and(|a| a.replay.contains("two-y")));
    let replay = host.attach("test:gone", None, sink).unwrap().replay;
    assert!(replay.contains("one-x") && replay.contains("two-y"));
    // The first viewer said it was gone after its first chunk and got nothing more.
    assert_eq!(*calls.lock().unwrap(), 1);
    assert!(host.kill("test:gone"));
    assert!(!host.kill("test:gone"));
    drop(live);
  }

  #[test]
  fn validates_session_keys() {
    for ok in ["panel:1", "ade::t3", "ade:fix-login:t12", "cli:a1b2c3d4:fix-login:1700000000000", "a.b_c-D"] {
      assert!(validate_key(ok).is_ok(), "{ok}");
    }
    for bad in ["", "a b", "a/b", "ก", "x\n", &"k".repeat(129)] {
      assert!(validate_key(bad).is_err(), "{bad:?}");
    }
    assert!(validate_key(&"k".repeat(128)).is_ok());
  }
}
