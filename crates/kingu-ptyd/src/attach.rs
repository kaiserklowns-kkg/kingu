//! `kingu-ptyd attach | sessions | end | host-info`: the daemon used from a plain terminal, which is
//! how Kingu holds a terminal on an SSH host (Orca's host server owns the PTY there and the pane
//! reattaches after a reconnect). `ssh -t host kingu-ptyd attach …` shows session `key` of the
//! host's daemon in the terminal ssh gave it: the scrollback first, then live output, keys and
//! size changes passed on. When the connection drops this process dies with its terminal; the
//! daemon is in a session of its own, so the shell and the agent CLI in it keep running, and the
//! next `attach` to the same key shows them again.
//!
//! Exit codes of `attach` (the desktop's reattach loop reads them through ssh, which itself exits
//! 255 when the connection is lost): [`EXIT_ENDED`] the session's shell exited (or the terminal
//! detached by closing its input), [`EXIT_NO_SESSION`] there was nothing to reattach to,
//! [`EXIT_UNAVAILABLE`] the daemon could not be reached or started, [`EXIT_LOST`] the daemon went
//! away while attached.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::client::{Client, Launch, connect_or_start, fallback_socket_name};
use crate::protocol::{MIN_COMPATIBLE, PROTOCOL, socket_name};
use crate::session::{EXITED, SessionInfo, ShellSpec, Sink, validate_key};

pub const ATTACH: &str = "attach";
pub const SESSIONS: &str = "sessions";
pub const END: &str = "end";
pub const HOST_INFO: &str = "host-info";

pub const EXIT_ENDED: i32 = 0;
pub const EXIT_USAGE: i32 = 2;
pub const EXIT_NO_SESSION: i32 = 3;
pub const EXIT_UNAVAILABLE: i32 = 4;
pub const EXIT_LOST: i32 = 5;

/// How often the terminal's size is read (a size change reaches the session within this).
const SIZE_POLL: Duration = Duration::from_millis(200);

pub fn is_subcommand(arg: &str) -> bool {
  matches!(arg, ATTACH | SESSIONS | END | HOST_INFO)
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct AttachArgs {
  pub dir: PathBuf,
  pub key: String,
  /// With a folder the session is started when it isn't live (`run` typed into its login shell
  /// once); without, `attach` only reattaches.
  pub cwd: Option<PathBuf>,
  pub env: BTreeMap<String, String>,
  pub run: Option<Vec<String>>,
  /// How long a daemon this attach starts stays once it holds no session and no client
  /// (`--idle-seconds`; the daemon's own default otherwise).
  pub idle_seconds: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Command {
  Attach(AttachArgs),
  Sessions { dir: PathBuf },
  End { dir: PathBuf, key: String },
  HostInfo,
}

/// `attach --dir <dir> --key <key> [--cwd <folder> [--env K=V]… [--idle-seconds N] [-- <argv>…]]`,
/// `sessions --dir <dir>`, `end --dir <dir> --key <key>`, `host-info`.
pub fn parse(args: impl IntoIterator<Item = String>) -> Result<Command, String> {
  let mut it = args.into_iter();
  let sub = it.next().ok_or("missing subcommand")?;
  if sub == HOST_INFO {
    return Ok(Command::HostInfo);
  }
  let (mut dir, mut key, mut cwd, mut env, mut run, mut idle_seconds) = (None, None, None, BTreeMap::new(), None, None);
  while let Some(a) = it.next() {
    let mut value = || it.next().ok_or(format!("{a} needs a value"));
    match a.as_str() {
      "--dir" => dir = Some(PathBuf::from(value()?)),
      "--key" => key = Some(value()?),
      "--cwd" if sub == ATTACH => cwd = Some(PathBuf::from(value()?)),
      "--idle-seconds" if sub == ATTACH => idle_seconds = Some(value()?.parse::<u64>().map_err(|e| e.to_string())?),
      "--env" if sub == ATTACH => {
        let pair = value()?;
        let (k, v) = pair.split_once('=').filter(|(k, _)| !k.is_empty()).ok_or(format!("--env wants NAME=value, got {pair:?}"))?;
        env.insert(k.to_string(), v.to_string());
      }
      "--" if sub == ATTACH => {
        let argv: Vec<String> = it.by_ref().collect();
        run = (!argv.is_empty()).then_some(argv);
      }
      _ => return Err(format!("unknown argument {a}")),
    }
  }
  let dir = dir.filter(|d: &PathBuf| d.is_absolute()).ok_or("--dir <absolute folder> is required")?;
  let keyed = |key: Option<String>| -> Result<String, String> {
    let key = key.ok_or("--key is required")?;
    validate_key(&key)?;
    Ok(key)
  };
  match sub.as_str() {
    ATTACH => {
      if cwd.is_none() && (run.is_some() || !env.is_empty() || idle_seconds.is_some()) {
        return Err("a command or environment needs --cwd (they start a session)".into());
      }
      Ok(Command::Attach(AttachArgs { dir, key: keyed(key)?, cwd, env, run, idle_seconds }))
    }
    SESSIONS => Ok(Command::Sessions { dir }),
    END => Ok(Command::End { dir, key: keyed(key)? }),
    _ => Err(format!("unknown subcommand {sub}")),
  }
}

/// What `host-info` prints: the desktop's handshake reads it before it trusts an installed binary.
pub fn host_info(version: &str) -> String {
  serde_json::json!({ "name": "kingu-ptyd", "version": version, "protocol": PROTOCOL, "minCompatible": MIN_COMPATIBLE, "os": std::env::consts::OS, "arch": std::env::consts::ARCH }).to_string()
}

/// A daemon already running in `dir`, if any (never starts one).
fn running(dir: &Path, version: &str) -> Option<Client> {
  [socket_name(), fallback_socket_name(version)].into_iter().find_map(|name| Client::connect(&dir.join(name), version).ok())
}

/// Runs a subcommand; the process exits with the returned code.
pub fn run(command: Command, version: &str) -> i32 {
  match command {
    Command::HostInfo => {
      println!("{}", host_info(version));
      0
    }
    Command::Sessions { dir } => {
      let list: Vec<SessionInfo> = running(&dir, version).and_then(|c| c.list().ok()).unwrap_or_default();
      println!("{}", serde_json::to_string(&list).unwrap_or_else(|_| "[]".into()));
      0
    }
    Command::End { dir, key } => {
      let ended = running(&dir, version).is_some_and(|c| c.kill(&key).unwrap_or(false));
      println!("{}", if ended { "ended" } else { "none" });
      0
    }
    Command::Attach(args) => attach(&args, version),
  }
}

/// Bytes read from the terminal, as the text the protocol carries: the longest valid UTF-8 prefix
/// (a character cut by a read waits in `pending`); invalid bytes are replaced, never kept back.
pub fn take_text(pending: &mut Vec<u8>) -> String {
  let cut = match std::str::from_utf8(pending) {
    Ok(_) => pending.len(),
    Err(e) if e.error_len().is_none() => e.valid_up_to(),
    Err(_) => pending.len(),
  };
  let text = String::from_utf8_lossy(&pending[..cut]).into_owned();
  pending.drain(..cut);
  text
}

fn terminal_size() -> Option<(u16, u16)> {
  let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
  // SAFETY: TIOCGWINSZ fills the winsize it is given.
  let ok = [libc::STDOUT_FILENO, libc::STDIN_FILENO].into_iter().any(|fd| unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, &mut ws) } == 0 && ws.ws_col > 0 && ws.ws_row > 0);
  ok.then_some((ws.ws_col, ws.ws_row))
}

/// The terminal in raw mode (keys go to the session unchanged) until dropped.
struct RawMode(Option<libc::termios>);

impl RawMode {
  fn enter() -> Self {
    // SAFETY: plain termios calls on stdin; a failure (not a terminal) leaves it untouched.
    unsafe {
      let mut t: libc::termios = std::mem::zeroed();
      if libc::tcgetattr(libc::STDIN_FILENO, &mut t) != 0 {
        return RawMode(None);
      }
      let saved = t;
      libc::cfmakeraw(&mut t);
      if libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &t) != 0 {
        return RawMode(None);
      }
      RawMode(Some(saved))
    }
  }
}

impl Drop for RawMode {
  fn drop(&mut self) {
    if let Some(saved) = self.0 {
      // SAFETY: restores what `enter` read.
      unsafe {
        libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &saved);
      }
    }
  }
}

fn attach(args: &AttachArgs, version: &str) -> i32 {
  let client = match &args.cwd {
    Some(_) => {
      let Ok(bin) = std::env::current_exe() else {
        eprintln!("kingu-ptyd: cannot find this program's own path");
        return EXIT_UNAVAILABLE;
      };
      let daemon_args = args.idle_seconds.map(|s| vec!["--idle-seconds".to_string(), s.to_string()]).unwrap_or_default();
      match connect_or_start(&Launch { bin, dir: args.dir.clone(), app_version: version.to_string(), args: daemon_args, env: Vec::new() }) {
        Ok(c) => c,
        Err(e) => {
          eprintln!("kingu-ptyd: {e}");
          return EXIT_UNAVAILABLE;
        }
      }
    }
    None => match running(&args.dir, version) {
      Some(c) => c,
      None => return EXIT_NO_SESSION,
    },
  };
  let client = Arc::new(client);
  let (cols, rows) = terminal_size().unwrap_or((80, 24));

  // Output frames arrive before the attach reply returns the scrollback; they wait in `early`
  // so the replay is always printed first.
  let ended = Arc::new(AtomicBool::new(false));
  let early: Arc<Mutex<Option<Vec<String>>>> = Arc::new(Mutex::new(Some(Vec::new())));
  let sink: Sink = {
    let (ended, early) = (ended.clone(), early.clone());
    Box::new(move |text: String| {
      if text == EXITED {
        ended.store(true, Ordering::SeqCst);
      }
      let mut held = early.lock().unwrap();
      match held.as_mut() {
        Some(q) => q.push(text),
        None => print_out(&text),
      }
      true
    })
  };
  let attached = match &args.cwd {
    Some(cwd) => {
      let spec = ShellSpec { cwd, cols, rows, run: args.run.as_deref(), env: &args.env, shell: None, args: None, unset: &[], clean_env: false };
      client.spawn(&args.key, &spec, sink)
    }
    None => match client.attach(&args.key, Some((cols, rows)), sink) {
      Ok(Some(a)) => Ok(a),
      Ok(None) => return EXIT_NO_SESSION,
      Err(e) => Err(e),
    },
  };
  let attached = match attached {
    Ok(a) => a,
    Err(e) => {
      eprintln!("kingu-ptyd: {e}");
      return EXIT_UNAVAILABLE;
    }
  };

  let raw = RawMode::enter();
  {
    let mut held = early.lock().unwrap();
    print_out(&attached.replay);
    for text in held.take().unwrap_or_default() {
      print_out(&text);
    }
  }

  // Keys: stdin to the session. The end of input (the terminal closed) detaches.
  let detached = Arc::new(AtomicBool::new(false));
  {
    let (client, key, detached) = (client.clone(), args.key.clone(), detached.clone());
    std::thread::spawn(move || {
      let mut stdin = std::io::stdin().lock();
      let mut chunk = [0u8; 4096];
      let mut pending = Vec::new();
      loop {
        match stdin.read(&mut chunk) {
          Ok(0) | Err(_) => break,
          Ok(n) => {
            pending.extend_from_slice(&chunk[..n]);
            let text = take_text(&mut pending);
            if !text.is_empty() && client.write(&key, &text).is_err() {
              break;
            }
          }
        }
      }
      detached.store(true, Ordering::SeqCst);
    });
  }

  let mut size = (cols, rows);
  let code = loop {
    std::thread::sleep(SIZE_POLL);
    if !client.is_connected() {
      break EXIT_LOST;
    }
    if detached.load(Ordering::SeqCst) {
      break EXIT_ENDED;
    }
    // The exit notice is the session's last output; the list confirms it (a program can print the
    // same words).
    if ended.swap(false, Ordering::SeqCst) && !client.list().is_ok_and(|l| l.iter().any(|s| s.key == args.key && s.alive)) {
      break EXIT_ENDED;
    }
    if let Some(now) = terminal_size().filter(|now| *now != size) {
      size = now;
      let _ = client.resize(&args.key, now.0, now.1);
    }
  };
  drop(raw);
  let _ = std::io::stdout().flush();
  code
}

fn print_out(text: &str) {
  let mut out = std::io::stdout().lock();
  let _ = out.write_all(text.as_bytes());
  let _ = out.flush();
}

#[cfg(test)]
mod tests {
  use super::*;

  fn args(a: &[&str]) -> Result<Command, String> {
    parse(a.iter().map(|s| s.to_string()))
  }

  #[test]
  fn parses_the_subcommands() {
    assert_eq!(args(&["host-info"]), Ok(Command::HostInfo));
    assert_eq!(args(&["sessions", "--dir", "/h/.kingu/host/run"]), Ok(Command::Sessions { dir: "/h/.kingu/host/run".into() }));
    assert_eq!(args(&["end", "--dir", "/d", "--key", "ssh:abc"]), Ok(Command::End { dir: "/d".into(), key: "ssh:abc".into() }));
    assert_eq!(args(&["attach", "--dir", "/d", "--key", "ssh:abc"]), Ok(Command::Attach(AttachArgs { dir: "/d".into(), key: "ssh:abc".into(), ..Default::default() })));
    let started = args(&["attach", "--dir", "/d", "--key", "ssh:abc", "--cwd", "/srv/app", "--env", "A=b=c", "--env", "E=", "--", "claude", "--continue", "--", "x"]).unwrap();
    assert_eq!(
      started,
      Command::Attach(AttachArgs {
        dir: "/d".into(),
        key: "ssh:abc".into(),
        cwd: Some("/srv/app".into()),
        env: BTreeMap::from([("A".into(), "b=c".into()), ("E".into(), String::new())]),
        run: Some(vec!["claude".into(), "--continue".into(), "--".into(), "x".into()]),
        idle_seconds: None,
      })
    );
  }

  #[test]
  fn refuses_what_it_cannot_run() {
    assert!(args(&[]).is_err());
    assert!(args(&["attach", "--key", "k"]).is_err(), "no folder for the socket");
    assert!(args(&["attach", "--dir", "rel", "--key", "k"]).is_err());
    assert!(args(&["attach", "--dir", "/d"]).is_err(), "no key");
    assert!(args(&["attach", "--dir", "/d", "--key", "bad key"]).is_err());
    assert!(args(&["attach", "--dir", "/d", "--key", "k", "--", "claude"]).is_err(), "a command without a folder");
    assert!(args(&["attach", "--dir", "/d", "--key", "k", "--cwd", "/x", "--env", "novalue"]).is_err());
    assert!(args(&["sessions", "--dir", "/d", "--cwd", "/x"]).is_err());
    assert!(args(&["attach", "--dir", "/d", "--key", "k", "--idle-seconds", "5"]).is_err(), "only a starting attach sets the daemon up");
    assert!(matches!(args(&["attach", "--dir", "/d", "--key", "k", "--cwd", "/x", "--idle-seconds", "5"]), Ok(Command::Attach(a)) if a.idle_seconds == Some(5)));
    assert!(args(&["end", "--dir", "/d"]).is_err());
    assert!(args(&["bogus", "--dir", "/d"]).is_err());
  }

  #[test]
  fn host_info_names_the_protocol_and_the_platform() {
    let v: serde_json::Value = serde_json::from_str(&host_info("0.1.0")).unwrap();
    assert_eq!(v["name"], "kingu-ptyd");
    assert_eq!(v["version"], "0.1.0");
    assert_eq!(v["protocol"], PROTOCOL);
    assert_eq!(v["minCompatible"], MIN_COMPATIBLE);
    assert_eq!(v["os"], std::env::consts::OS);
    assert_eq!(v["arch"], std::env::consts::ARCH);
  }

  #[test]
  fn keys_cut_inside_a_character_wait_for_the_rest() {
    let mut pending = "aก".as_bytes()[..2].to_vec();
    assert_eq!(take_text(&mut pending), "a");
    assert_eq!(pending.len(), 1);
    pending.extend_from_slice(&"ก".as_bytes()[1..]);
    assert_eq!(take_text(&mut pending), "ก");
    assert!(pending.is_empty());
    let mut bad = vec![b'x', 0xff, b'y'];
    assert_eq!(take_text(&mut bad), "x\u{fffd}y");
    assert!(bad.is_empty());
  }
}
