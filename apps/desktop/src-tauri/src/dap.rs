//! Debug adapters (VS Code gets these from debug extensions): one child process per debug
//! session, speaking the Debug Adapter Protocol with the same `Content-Length` framing as LSP.
//! Messages are passed through to the webview untouched over a Channel; the DAP client (session
//! state, breakpoints, stepping) lives there. Most adapters talk over stdio; `dlv dap` only
//! listens on TCP, so for it the transport connects to the address it prints.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::State;
use tauri::ipc::Channel;

use crate::lsp::{self, FrameDecoder, InstallInfo, LspEvent, NOT_INSTALLED, Package, ServerSpec, encode};

/// Adapter → webview traffic has the LSP transport's shape: a message, a stderr line, the exit.
pub type DapEvent = LspEvent;
pub type Sink = Arc<dyn Fn(DapEvent) + Send + Sync>;

// ---------------------------------------------------------------------------------------------
// Adapters and their resolution

/// How the webview talks to the adapter process.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Connect {
  Stdio,
  /// The adapter prints `… listening at: host:port` on stdout, then accepts one connection.
  Tcp,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Adapter {
  /// `lldb`, `go` or `debugpy`; also the `KINGU_DAP_<KEY>` override's suffix.
  pub key: &'static str,
  /// Shown in "ไม่ได้ติดตั้ง <display>".
  pub display: &'static str,
  pub binaries: &'static [&'static str],
  pub args: &'static [&'static str],
  pub connect: Connect,
  pub install: &'static [Package],
}

/// The adapter for a launch.json `type`.
pub fn adapter_for(debug_type: &str) -> Option<Adapter> {
  let a = |key, display, binaries, args, connect, install| Adapter { key, display, binaries, args, connect, install };
  Some(match debug_type {
    "lldb" | "lldb-dap" | "lldb-vscode" => a("lldb", "lldb-dap", &["lldb-dap", "lldb-vscode"], &[], Connect::Stdio, &[Package::Brew("llvm")]),
    // Port 0: dlv prints the port it got.
    "go" => a(
      "go",
      "Delve (dlv)",
      &["dlv"],
      &["dap", "--listen=127.0.0.1:0"],
      Connect::Tcp,
      &[Package::Go("github.com/go-delve/delve/cmd/dlv@latest"), Package::Brew("delve")],
    ),
    "debugpy" | "python" => a("debugpy", "debugpy", &["python3", "python"], &["-m", "debugpy.adapter"], Connect::Stdio, &[Package::Pip("debugpy")]),
    _ => return None,
  })
}

pub fn override_name(adapter: &Adapter) -> String {
  format!("KINGU_DAP_{}", adapter.key.to_uppercase())
}

/// What resolution may look at; the real one is [`Probe::system`], tests fake every part.
pub struct Probe<'a> {
  pub override_var: Option<OsString>,
  pub path: Option<&'a OsStr>,
  pub home: Option<&'a Path>,
  pub root: &'a Path,
  /// `xcrun -f lldb-dap` (macOS ships lldb-dap with the Command Line Tools, off PATH).
  pub xcrun: &'a dyn Fn() -> Option<PathBuf>,
  /// Whether this Python can `import debugpy`.
  pub has_debugpy: &'a dyn Fn(&Path) -> bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
  pub program: PathBuf,
  pub args: Vec<String>,
  pub connect: Connect,
}

/// Homebrew's llvm is keg-only, so its lldb-dap is never on PATH.
const LLVM_DIRS: &[&str] = &["/opt/homebrew/opt/llvm/bin", "/usr/local/opt/llvm/bin"];

/// The adapter program and arguments, or the "ไม่ได้ติดตั้ง …" error. `python` is the launch
/// configuration's interpreter, tried first for debugpy.
pub fn resolve(adapter: &Adapter, python: Option<&Path>, probe: &Probe) -> Result<Resolved, String> {
  let args = adapter.args.iter().map(|s| s.to_string()).collect();
  let found = |program: PathBuf| Ok(Resolved { program, args: Vec::clone(&args), connect: adapter.connect });
  if let Some(o) = probe.override_var.clone().filter(|o| !o.is_empty()) {
    let p = PathBuf::from(o);
    return if lsp::is_executable(&p) {
      found(p)
    } else {
      Err(format!("{NOT_INSTALLED} {}: {} (จาก {}) ไม่ใช่ไฟล์ที่รันได้", adapter.display, p.display(), override_name(adapter)))
    };
  }
  let find = |name: &str| lsp::find_executable(name, probe.path, probe.home, probe.root).map(|(p, _)| p);
  match adapter.key {
    "debugpy" => {
      // The configured interpreter, then the project's virtualenv (VS Code's Python extension picks
      // it too; debugpy then runs the program with it), then python3 on PATH.
      let venvs = [".venv/bin/python", "venv/bin/python"].map(|v| probe.root.join(v));
      let candidates: Vec<PathBuf> = python
        .map(Path::to_path_buf)
        .into_iter()
        .chain(venvs)
        .filter(|p| lsp::is_executable(p))
        .chain(adapter.binaries.iter().filter_map(|b| find(b)))
        .collect();
      if let Some(p) = candidates.iter().find(|p| (probe.has_debugpy)(p)) {
        return found(p.clone());
      }
      Err(match candidates.first() {
        Some(p) => format!("{NOT_INSTALLED} debugpy ({} ไม่มีโมดูล debugpy; ติดตั้งด้วย python3 -m pip install debugpy หรือตั้ง {} เป็นพาธของ python ที่มี debugpy)", p.display(), override_name(adapter)),
        None => format!("{NOT_INSTALLED} debugpy (ไม่พบ python3 ใน PATH)"),
      })
    }
    _ => {
      let on_path = adapter.binaries.iter().find_map(|b| find(b));
      let keg = || adapter.binaries.iter().flat_map(|b| LLVM_DIRS.iter().map(move |d| Path::new(d).join(b))).find(|p| lsp::is_executable(p));
      let xcrun = || if adapter.key == "lldb" { (probe.xcrun)().filter(|p| lsp::is_executable(p)) } else { None };
      let program = on_path.or_else(|| if adapter.key == "lldb" { keg() } else { None }).or_else(xcrun);
      program.map_or_else(
        || {
          Err(format!(
            "{NOT_INSTALLED} {} (ไม่พบ {} ใน PATH; ติดตั้งได้จาก Run and Debug หรือตั้ง {} เป็นพาธของโปรแกรม)",
            adapter.display,
            adapter.binaries.join(" หรือ "),
            override_name(adapter)
          ))
        },
        found,
      )
    }
  }
}

fn xcrun_lldb_dap() -> Option<PathBuf> {
  if !cfg!(target_os = "macos") {
    return None;
  }
  let out = Command::new("/usr/bin/xcrun").args(["-f", "lldb-dap"]).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
  let p = String::from_utf8_lossy(&out.stdout).trim().to_owned();
  (out.status.success() && !p.is_empty()).then(|| PathBuf::from(p))
}

fn python_has_debugpy(python: &Path) -> bool {
  Command::new(python)
    .args(["-c", "import debugpy"])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .status()
    .is_ok_and(|s| s.success())
}

/// Resolves on this machine (login-shell PATH, `xcrun`, a real `import debugpy`).
pub fn check(debug_type: &str, python: Option<&Path>, root: &Path) -> Result<(Adapter, Resolved), String> {
  let adapter = adapter_for(debug_type).ok_or_else(|| format!("ไม่รองรับ debugger ชนิด \"{debug_type}\" (รองรับ lldb, go, debugpy)"))?;
  let home = std::env::var_os("HOME").map(PathBuf::from);
  let path = crate::shell_env::path();
  let probe = Probe {
    override_var: std::env::var_os(override_name(&adapter)),
    path: path.as_deref(),
    home: home.as_deref(),
    root,
    xcrun: &xcrun_lldb_dap,
    has_debugpy: &python_has_debugpy,
  };
  let resolved = resolve(&adapter, python, &probe)?;
  Ok((adapter, resolved))
}

/// Install commands for the adapter of `debug_type` usable on this machine.
pub fn install_info(debug_type: &str, root: &Path) -> Result<InstallInfo, String> {
  let adapter = adapter_for(debug_type).ok_or_else(|| format!("ไม่รองรับ debugger ชนิด \"{debug_type}\""))?;
  let home = std::env::var_os("HOME").map(PathBuf::from);
  let path = crate::shell_env::path();
  let spec = ServerSpec { key: adapter.key, display: adapter.display, binaries: adapter.binaries, args: &[], install: adapter.install };
  let methods = lsp::install_methods(&spec, |tool| {
    lsp::find_executable(tool, path.as_deref(), home.as_deref(), root).map(|(p, on_path)| if on_path { tool.to_string() } else { p.to_string_lossy().into_owned() })
  });
  let binary = if adapter.key == "debugpy" { "debugpy" } else { adapter.binaries[0] };
  Ok(InstallInfo { server: adapter.display, binary, methods })
}

/// `dlv dap` prints `DAP server listening at: 127.0.0.1:38697` (or `[::]:port`).
pub fn parse_listen_address(line: &str) -> Option<String> {
  let rest = line.split_once("listening at:")?.1.trim();
  let (host, port) = rest.rsplit_once(':')?;
  port.parse::<u16>().ok()?;
  let host = host.trim_start_matches('[').trim_end_matches(']');
  let host = if host.is_empty() || host == "::" || host == "0.0.0.0" { "127.0.0.1" } else { host };
  Some(if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") })
}

// ---------------------------------------------------------------------------------------------
// Sessions

struct Session {
  child: Mutex<Child>,
  pid: u32,
  /// Frames queued for the writer thread, so `dap_send` never blocks on a full pipe.
  tx: mpsc::Sender<Vec<u8>>,
}

#[derive(Default)]
pub struct Sessions {
  next_id: AtomicU32,
  running: Arc<Mutex<HashMap<u32, Arc<Session>>>>,
}

pub struct Launch {
  pub program: PathBuf,
  pub args: Vec<String>,
  pub cwd: PathBuf,
  pub env: Vec<(OsString, OsString)>,
  pub connect: Connect,
}

const TCP_WAIT: Duration = Duration::from_secs(15);

fn kill_group(pid: u32, child: &Mutex<Child>) {
  // The adapter leads its own process group, which also reaches the debuggee it spawned.
  #[cfg(unix)]
  unsafe {
    libc::kill(-(pid as i32), libc::SIGKILL);
  }
  #[cfg(not(unix))]
  let _ = pid;
  let _ = child.lock().unwrap().kill();
}

fn forward_lines(r: impl Read + Send + 'static, sink: Sink) -> std::thread::JoinHandle<()> {
  std::thread::spawn(move || {
    let mut r = BufReader::new(r);
    let mut line = Vec::new();
    while matches!(r.read_until(b'\n', &mut line), Ok(n) if n > 0) {
      sink(DapEvent::Stderr { line: String::from_utf8_lossy(&line).trim_end().to_owned() });
      line.clear();
    }
  })
}

impl Sessions {
  pub fn start(&self, launch: Launch, sink: Sink) -> Result<u32, String> {
    let mut cmd = Command::new(&launch.program);
    cmd
      .args(&launch.args)
      .current_dir(&launch.cwd)
      .env_clear()
      .envs(launch.env)
      .stdin(Stdio::piped())
      .stdout(Stdio::piped())
      .stderr(Stdio::piped());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    let mut child = cmd.spawn().map_err(|e| format!("{}: {e}", launch.program.display()))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let pid = child.id();
    let child = Mutex::new(child);

    let mut forwarders = vec![forward_lines(stderr, sink.clone())];
    let (reader, writer): (Box<dyn Read + Send>, Box<dyn Write + Send>) = match launch.connect {
      Connect::Stdio => (Box::new(stdout), Box::new(stdin)),
      Connect::Tcp => {
        let (addr_tx, addr_rx) = mpsc::channel();
        let out_sink = sink.clone();
        // Before the address: wait for it. After: the debuggee's output, if the adapter prints it.
        forwarders.push(std::thread::spawn(move || {
          let mut r = BufReader::new(stdout);
          let mut line = String::new();
          let mut sent = false;
          while matches!(r.read_line(&mut line), Ok(n) if n > 0) {
            match parse_listen_address(&line).filter(|_| !sent) {
              Some(addr) => sent = addr_tx.send(addr).is_ok(),
              None => out_sink(DapEvent::Stderr { line: line.trim_end().to_owned() }),
            }
            line.clear();
          }
        }));
        let connected = addr_rx
          .recv_timeout(TCP_WAIT)
          .map_err(|_| format!("{} ไม่ได้เปิด DAP server ภายใน {} วินาที", launch.program.display(), TCP_WAIT.as_secs()))
          .and_then(|addr| TcpStream::connect(&addr).map_err(|e| format!("เชื่อมต่อ debug adapter ที่ {addr} ไม่ได้: {e}")));
        let stream = match connected {
          Ok(s) => s,
          Err(e) => {
            kill_group(pid, &child);
            let _ = child.lock().unwrap().wait();
            return Err(e);
          }
        };
        drop(stdin);
        let read_half = stream.try_clone().map_err(|e| e.to_string())?;
        (Box::new(read_half), Box::new(stream))
      }
    };

    let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let session = Arc::new(Session { pid, child, tx });
    self.running.lock().unwrap().insert(id, session.clone());

    let mut writer = writer;
    std::thread::spawn(move || {
      for frame in rx {
        if writer.write_all(&frame).and_then(|_| writer.flush()).is_err() {
          break;
        }
      }
    });

    let running = self.running.clone();
    let mut reader = reader;
    std::thread::spawn(move || {
      let mut decoder = FrameDecoder::default();
      let mut chunk = vec![0u8; 64 * 1024];
      loop {
        match reader.read(&mut chunk) {
          Ok(0) | Err(_) => break,
          Ok(n) => match decoder.push(&chunk[..n]) {
            Ok(msgs) => msgs.into_iter().for_each(|json| sink(DapEvent::Message { json })),
            Err(e) => {
              log::error!("debug adapter {id}: {e}");
              sink(DapEvent::Stderr { line: format!("kingu: {e}") });
              break;
            }
          },
        }
      }
      // The adapter closed its end (disconnect, crash): give it a moment to exit, then make sure.
      let deadline = std::time::Instant::now() + Duration::from_secs(3);
      let code = loop {
        match session.child.lock().unwrap().try_wait() {
          Ok(Some(s)) => break s.code(),
          Ok(None) if std::time::Instant::now() < deadline => {}
          Ok(None) => {
            kill_group(session.pid, &session.child);
            break session.child.lock().unwrap().wait().ok().and_then(|s| s.code());
          }
          Err(_) => break None,
        }
        std::thread::sleep(Duration::from_millis(20));
      };
      for f in forwarders {
        let _ = f.join();
      }
      running.lock().unwrap().remove(&id);
      log::info!("debug adapter {id} exited (code {code:?})");
      sink(DapEvent::Exit { code });
    });
    Ok(id)
  }

  pub fn send(&self, id: u32, json: &str) -> Result<(), String> {
    let s = self.running.lock().unwrap().get(&id).cloned().ok_or("ไม่มี debug session นี้แล้ว")?;
    s.tx.send(encode(json)).map_err(|_| "debug adapter input is closed".to_string())
  }

  /// Kills the adapter and its process group (the client sends `disconnect` first when it can).
  pub fn stop(&self, id: u32) -> Result<(), String> {
    let s = self.running.lock().unwrap().get(&id).cloned().ok_or("ไม่มี debug session นี้แล้ว")?;
    kill_group(s.pid, &s.child);
    Ok(())
  }

  /// Folder switch and app exit: no debuggee may outlive its window.
  pub fn stop_all(&self) {
    let all: Vec<_> = self.running.lock().unwrap().drain().map(|(_, s)| s).collect();
    for s in &all {
      kill_group(s.pid, &s.child);
    }
    if !all.is_empty() {
      log::info!("stopped {} debug adapter(s)", all.len());
    }
  }

  #[cfg(test)]
  fn is_running(&self, id: u32) -> bool {
    self.running.lock().unwrap().contains_key(&id)
  }
}

// ---------------------------------------------------------------------------------------------
// Commands

/// Starts the adapter for a launch.json `type` in the workspace; its messages stream over `on_event`.
/// The debuggee gets the user's full environment (login-shell PATH), like a terminal would.
pub fn start_for(sessions: &Sessions, root: &Path, debug_type: &str, python: Option<&Path>, on_event: Channel<DapEvent>) -> Result<u32, String> {
  let (adapter, resolved) = check(debug_type, python, root)?;
  let launch = Launch {
    program: resolved.program.clone(),
    args: resolved.args,
    cwd: root.to_path_buf(),
    env: crate::shell_env::vars_os(),
    connect: resolved.connect,
  };
  let id = sessions.start(
    launch,
    Arc::new(move |ev| {
      let _ = on_event.send(ev);
    }),
  )?;
  log::info!("debug adapter {id} ({}) started: {}", adapter.key, resolved.program.display());
  Ok(id)
}

#[tauri::command]
pub fn dap_send(sessions: State<'_, Sessions>, id: u32, message: String) -> Result<(), String> {
  sessions.send(id, &message)
}

#[tauri::command]
pub fn dap_stop(sessions: State<'_, Sessions>, id: u32) -> Result<(), String> {
  sessions.stop(id)
}

/// Output of a build step before launching (the generated Rust configuration's `cargo build`).
#[derive(serde::Serialize, Debug)]
pub struct BuildResult {
  pub success: bool,
  pub output: String,
}

/// Runs `argv` in `cwd` with the login-shell PATH and waits for it (no shell involved).
pub fn run_build(argv: &[String], cwd: &Path) -> Result<BuildResult, String> {
  let (program, args) = argv.split_first().ok_or("ไม่มีคำสั่ง build")?;
  let out = crate::shell_env::command(program)
    .args(args)
    .current_dir(cwd)
    .stdin(Stdio::null())
    .output()
    .map_err(|e| format!("รัน {program} ไม่ได้: {e}"))?;
  let mut output = String::from_utf8_lossy(&out.stdout).into_owned();
  output.push_str(&String::from_utf8_lossy(&out.stderr));
  Ok(BuildResult { success: out.status.success(), output })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn frames_dap_messages_split_merged_and_unicode() {
    let a = r#"{"seq":1,"type":"event","event":"output","body":{"output":"สวัสดี 🦀\n"}}"#;
    let b = r#"{"seq":2,"type":"response","request_seq":1,"success":true,"command":"initialize"}"#;
    let mut bytes = encode(a);
    bytes.extend(encode(b));
    // Every split point of two merged frames, including inside the 4-byte emoji.
    for cut in 0..bytes.len() {
      let mut d = FrameDecoder::default();
      let mut got = d.push(&bytes[..cut]).unwrap();
      got.extend(d.push(&bytes[cut..]).unwrap());
      assert_eq!(got, [a, b], "cut {cut}");
    }
    // Byte length, not characters: the Thai text and the emoji are multi-byte.
    assert!(encode(a).starts_with(format!("Content-Length: {}\r\n\r\n", a.len()).as_bytes()));
    assert!(a.len() > a.chars().count());
  }

  #[test]
  fn maps_launch_types_to_adapters() {
    let key = |t: &str| adapter_for(t).map(|a| a.key);
    for (t, k) in [("lldb", "lldb"), ("lldb-dap", "lldb"), ("lldb-vscode", "lldb"), ("go", "go"), ("debugpy", "debugpy"), ("python", "debugpy")] {
      assert_eq!(key(t), Some(k), "{t}");
    }
    for none in ["node", "pwa-node", "cppdbg", ""] {
      assert_eq!(key(none), None, "{none}");
    }
    let go = adapter_for("go").unwrap();
    assert_eq!((go.args, go.connect), (&["dap", "--listen=127.0.0.1:0"][..], Connect::Tcp));
    assert_eq!(override_name(&adapter_for("python").unwrap()), "KINGU_DAP_DEBUGPY");
  }

  #[test]
  fn parses_delve_listen_lines() {
    assert_eq!(parse_listen_address("DAP server listening at: 127.0.0.1:38697\n").as_deref(), Some("127.0.0.1:38697"));
    assert_eq!(parse_listen_address("DAP server listening at: [::]:4000").as_deref(), Some("127.0.0.1:4000"));
    assert_eq!(parse_listen_address("DAP server listening at: [::1]:4000").as_deref(), Some("[::1]:4000"));
    assert_eq!(parse_listen_address("Type 'dlv help' for list of commands."), None);
    assert_eq!(parse_listen_address("listening at: host:notaport"), None);
  }

  #[cfg(unix)]
  fn fake_bin(dir: &Path, name: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(dir).unwrap();
    let p = dir.join(name);
    std::fs::write(&p, "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    p
  }

  fn probe<'a>(path: &'a Path, root: &'a Path, xcrun: &'a dyn Fn() -> Option<PathBuf>, has_debugpy: &'a dyn Fn(&Path) -> bool) -> Probe<'a> {
    Probe { override_var: None, path: Some(path.as_os_str()), home: None, root, xcrun, has_debugpy }
  }

  #[cfg(unix)]
  #[test]
  fn resolves_adapters_from_fake_binaries() {
    let tmp = tempfile::tempdir().unwrap();
    let (bin, root) = (tmp.path().join("bin"), tmp.path().join("ws"));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&bin).unwrap();
    let no_xcrun = || None;
    let yes = |_: &Path| true;
    let lldb = adapter_for("lldb").unwrap();

    // Skipped where a real lldb-dap sits in a fixed extra dir (Homebrew llvm).
    let elsewhere = ["/opt/homebrew/bin", "/usr/local/bin"].iter().chain(LLVM_DIRS).any(|d| Path::new(d).join("lldb-dap").exists() || Path::new(d).join("lldb-vscode").exists());
    if !elsewhere {
      // Nothing anywhere (xcrun included): the Thai "not installed" error the install flow keys off.
      let err = resolve(&lldb, None, &probe(&bin, &root, &no_xcrun, &yes)).unwrap_err();
      assert!(err.starts_with("ไม่ได้ติดตั้ง lldb-dap"), "{err}");
      assert!(err.contains("lldb-vscode") && err.contains("KINGU_DAP_LLDB"), "{err}");
      // xcrun's answer when nothing is on PATH.
      let from_xcrun = fake_bin(&tmp.path().join("xcode"), "lldb-dap");
      let xcrun = || Some(from_xcrun.clone());
      assert_eq!(resolve(&lldb, None, &probe(&bin, &root, &xcrun, &yes)).unwrap().program, from_xcrun);
    }
    // The old name on PATH, then the current name wins.
    let old = fake_bin(&bin, "lldb-vscode");
    assert_eq!(resolve(&lldb, None, &probe(&bin, &root, &no_xcrun, &yes)).unwrap().program, old);
    let new = fake_bin(&bin, "lldb-dap");
    let r = resolve(&lldb, None, &probe(&bin, &root, &no_xcrun, &yes)).unwrap();
    assert_eq!((r.program, r.args, r.connect), (new, vec![], Connect::Stdio));

    // Delve, over TCP.
    let go = adapter_for("go").unwrap();
    if !["/opt/homebrew/bin/dlv", "/usr/local/bin/dlv"].iter().any(|p| Path::new(p).exists()) {
      assert!(resolve(&go, None, &probe(&bin, &root, &no_xcrun, &yes)).unwrap_err().starts_with("ไม่ได้ติดตั้ง Delve (dlv)"));
    }
    let dlv = fake_bin(&bin, "dlv");
    let r = resolve(&go, None, &probe(&bin, &root, &no_xcrun, &yes)).unwrap();
    assert_eq!((r.program, r.args, r.connect), (dlv, vec!["dap".to_string(), "--listen=127.0.0.1:0".into()], Connect::Tcp));

    // An override must be executable.
    let mut p = probe(&bin, &root, &no_xcrun, &yes);
    p.override_var = Some("/nonexistent/lldb-dap".into());
    assert!(resolve(&lldb, None, &p).unwrap_err().contains("KINGU_DAP_LLDB"));
  }

  #[cfg(unix)]
  #[test]
  fn resolves_debugpy_through_a_python_that_has_it() {
    let tmp = tempfile::tempdir().unwrap();
    let (bin, root) = (tmp.path().join("bin"), tmp.path().join("ws"));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&bin).unwrap();
    let debugpy = adapter_for("debugpy").unwrap();
    let no_xcrun = || None;
    let venv_python = fake_bin(&tmp.path().join("venv/bin"), "python");
    let venv = venv_python.clone();
    let only_venv = move |p: &Path| p == venv;
    let never = |_: &Path| false;
    let mk = |has: &dyn Fn(&Path) -> bool| resolve(&debugpy, Some(&venv_python), &probe(&bin, &root, &no_xcrun, has));
    // No python3 on PATH, the configured one lacks debugpy.
    let err = mk(&never).unwrap_err();
    assert!(err.starts_with("ไม่ได้ติดตั้ง debugpy") && err.contains("pip install debugpy"), "{err}");
    // The launch configuration's interpreter has it.
    let r = mk(&only_venv).unwrap();
    assert_eq!((r.program, r.args), (venv_python.clone(), vec!["-m".to_string(), "debugpy.adapter".into()]));
    // python3 on PATH is tried after it.
    let py3 = fake_bin(&bin, "python3");
    let p3 = py3.clone();
    assert_eq!(mk(&move |p: &Path| p == p3).unwrap().program, py3);
    // The project's .venv comes before PATH when the configuration names no interpreter.
    let project = fake_bin(&root.join(".venv/bin"), "python");
    let any = |_: &Path| true;
    assert_eq!(resolve(&debugpy, None, &probe(&bin, &root, &no_xcrun, &any)).unwrap().program, project);
  }

  #[test]
  fn install_methods_for_adapters() {
    let all = |t: &str| t.to_string();
    let argvs = |debug_type: &str| {
      let a = adapter_for(debug_type).unwrap();
      let spec = ServerSpec { key: a.key, display: a.display, binaries: a.binaries, args: &[], install: a.install };
      lsp::install_methods(&spec, |t| Some(all(t))).into_iter().map(|m| m.argv.join(" ")).collect::<Vec<_>>()
    };
    assert_eq!(argvs("lldb"), ["brew install llvm"]);
    assert_eq!(argvs("go"), ["go install github.com/go-delve/delve/cmd/dlv@latest", "brew install delve"]);
    assert_eq!(argvs("debugpy"), ["python3 -m pip install --user debugpy"]);
  }

  // --- Through the real transport ------------------------------------------------------------

  fn collect() -> (Sink, mpsc::Receiver<DapEvent>) {
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    (Arc::new(move |ev| tx.lock().unwrap().send(ev).unwrap()), rx)
  }

  fn python3() -> Option<PathBuf> {
    ["/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"].iter().map(PathBuf::from).find(|p| p.exists())
  }

  /// Drives an adapter like the webview's client does: requests with increasing `seq`, and every
  /// message, event and stderr line collected in order.
  struct Driver<'a> {
    sessions: &'a Sessions,
    id: u32,
    rx: mpsc::Receiver<DapEvent>,
    seq: u64,
    stderr: Vec<String>,
    /// Messages that arrived while waiting for another (a launch response before `initialized`).
    backlog: Vec<serde_json::Value>,
  }

  impl Driver<'_> {
    fn request(&mut self, command: &str, arguments: serde_json::Value) -> u64 {
      self.seq += 1;
      let msg = serde_json::json!({ "seq": self.seq, "type": "request", "command": command, "arguments": arguments });
      self.sessions.send(self.id, &msg.to_string()).unwrap();
      self.seq
    }

    /// The next adapter message matching `pred`, failing after `secs`.
    fn wait(&mut self, secs: u64, what: &str, pred: impl Fn(&serde_json::Value) -> bool) -> serde_json::Value {
      if let Some(i) = self.backlog.iter().position(&pred) {
        return self.backlog.remove(i);
      }
      let deadline = std::time::Instant::now() + Duration::from_secs(secs);
      loop {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        match self.rx.recv_timeout(left) {
          Ok(DapEvent::Message { json }) => {
            let v: serde_json::Value = serde_json::from_str(&json).unwrap();
            if pred(&v) {
              return v;
            }
            self.backlog.push(v);
          }
          Ok(DapEvent::Stderr { line }) => self.stderr.push(line),
          Ok(DapEvent::Exit { code }) => panic!("adapter exited ({code:?}) waiting for {what}; stderr: {:?}", self.stderr),
          Err(_) => panic!("timed out waiting for {what}; stderr: {:?}", self.stderr),
        }
      }
    }

    fn response(&mut self, seq: u64) -> serde_json::Value {
      let r = self.wait(30, &format!("response to {seq}"), |v| v["type"] == "response" && v["request_seq"] == seq);
      assert_eq!(r["success"], true, "{r}");
      r
    }

    fn event(&mut self, name: &str) -> serde_json::Value {
      self.wait(30, name, |v| v["type"] == "event" && v["event"] == name)
    }

    fn exit(&mut self) -> Option<i32> {
      loop {
        match self.rx.recv_timeout(Duration::from_secs(10)).expect("no exit") {
          DapEvent::Exit { code } => return code,
          _ => continue,
        }
      }
    }
  }

  fn fake_session(tcp: bool) -> Option<Driver<'static>> {
    let python = python3()?;
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/fake_dap.py");
    let mut args = vec![script.to_string_lossy().into_owned()];
    if tcp {
      args.push("--tcp".into());
    }
    let sessions: &'static Sessions = Box::leak(Box::default());
    let (sink, rx) = collect();
    let launch = Launch { program: python, args, cwd: std::env::temp_dir(), env: vec![("PATH".into(), "/usr/bin:/bin".into())], connect: if tcp { Connect::Tcp } else { Connect::Stdio } };
    let id = sessions.start(launch, sink).unwrap();
    Some(Driver { sessions, id, rx, seq: 0, stderr: Vec::new(), backlog: Vec::new() })
  }

  fn run_core_loop(d: &mut Driver) {
    let s = d.request("initialize", serde_json::json!({ "clientID": "kingu", "adapterID": "fake", "linesStartAt1": true, "columnsStartAt1": true, "pathFormat": "path" }));
    assert_eq!(d.response(s)["body"]["supportsConfigurationDoneRequest"], true);
    let launch = d.request("launch", serde_json::json!({ "program": "/ws/main.py" }));
    d.event("initialized");
    let s = d.request("setBreakpoints", serde_json::json!({ "source": { "path": "/ws/main.py" }, "breakpoints": [{ "line": 3 }, { "line": 9 }] }));
    let bps = d.response(s)["body"]["breakpoints"].clone();
    assert_eq!(bps, serde_json::json!([{ "id": 1, "verified": true, "line": 3 }, { "id": 2, "verified": true, "line": 9 }]));
    let s = d.request("configurationDone", serde_json::json!({}));
    d.response(s);
    d.response(launch);
    assert_eq!(d.event("output")["body"]["output"], "สวัสดี from the debuggee\n");
    let stopped = d.event("stopped");
    assert_eq!((&stopped["body"]["reason"], &stopped["body"]["threadId"]), (&"breakpoint".into(), &1.into()));
    let s = d.request("threads", serde_json::json!({}));
    assert_eq!(d.response(s)["body"]["threads"][0]["name"], "main");
    let s = d.request("stackTrace", serde_json::json!({ "threadId": 1 }));
    let frame = d.response(s)["body"]["stackFrames"][0].clone();
    assert_eq!((&frame["line"], &frame["source"]["path"]), (&3.into(), &"/ws/main.py".into()));
    let s = d.request("scopes", serde_json::json!({ "frameId": frame["id"] }));
    let scope = d.response(s)["body"]["scopes"][0].clone();
    let s = d.request("variables", serde_json::json!({ "variablesReference": scope["variablesReference"] }));
    assert_eq!(d.response(s)["body"]["variables"][0]["value"], "42");
    let s = d.request("continue", serde_json::json!({ "threadId": 1 }));
    d.response(s);
    d.event("continued");
    assert_eq!(d.event("exited")["body"]["exitCode"], 0);
    d.event("terminated");
    let s = d.request("disconnect", serde_json::json!({ "terminateDebuggee": true }));
    d.response(s);
    assert_eq!(d.exit(), Some(0));
    assert!(d.stderr.iter().any(|l| l == "fake adapter ready"), "{:?}", d.stderr);
    assert!(!d.sessions.is_running(d.id));
    assert!(d.sessions.send(d.id, "{}").is_err());
  }

  #[test]
  fn drives_a_fake_adapter_over_stdio() {
    let Some(mut d) = fake_session(false) else {
      eprintln!("python3 not found; skipping");
      return;
    };
    run_core_loop(&mut d);
  }

  #[test]
  fn drives_a_fake_adapter_over_tcp_like_delve() {
    let Some(mut d) = fake_session(true) else {
      eprintln!("python3 not found; skipping");
      return;
    };
    run_core_loop(&mut d);
  }

  #[cfg(unix)]
  #[test]
  fn stop_kills_the_adapter() {
    let tmp = tempfile::tempdir().unwrap();
    let sessions = Sessions::default();
    let (sink, rx) = collect();
    let launch = Launch { program: "/bin/sleep".into(), args: vec!["30".into()], cwd: tmp.path().into(), env: vec![], connect: Connect::Stdio };
    let id = sessions.start(launch, sink).unwrap();
    sessions.stop(id).unwrap();
    let exited = loop {
      if let DapEvent::Exit { .. } = rx.recv_timeout(Duration::from_secs(10)).unwrap() {
        break true;
      }
    };
    assert!(exited && !sessions.is_running(id));
  }

  #[cfg(unix)]
  #[test]
  fn tcp_adapter_that_never_listens_fails_in_time() {
    let tmp = tempfile::tempdir().unwrap();
    let sessions = Sessions::default();
    let (sink, _rx) = collect();
    // Prints something else and exits: the wait ends at EOF, not after the full timeout.
    let launch = Launch { program: "/bin/echo".into(), args: vec!["no address".into()], cwd: tmp.path().into(), env: vec![], connect: Connect::Tcp };
    let started = std::time::Instant::now();
    let err = sessions.start(launch, sink).unwrap_err();
    assert!(err.contains("DAP server"), "{err}");
    assert!(started.elapsed() < TCP_WAIT + Duration::from_secs(2));
  }

  #[test]
  fn runs_a_build_and_reports_failure() {
    let tmp = tempfile::tempdir().unwrap();
    let ok = run_build(&["sh".into(), "-c".into(), "echo built; echo warn >&2".into()], tmp.path()).unwrap();
    assert!(ok.success && ok.output.contains("built") && ok.output.contains("warn"), "{ok:?}");
    assert!(!run_build(&["sh".into(), "-c".into(), "exit 3".into()], tmp.path()).unwrap().success);
    assert!(run_build(&[], tmp.path()).is_err());
  }

  /// The real lldb-dap (PATH, Homebrew llvm or `xcrun -f lldb-dap`) debugging a tiny C program to a
  /// breakpoint and reading a local. Skipped when lldb-dap or a C compiler is missing.
  #[cfg(unix)]
  #[test]
  fn lldb_dap_stops_at_a_breakpoint_in_c() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let Ok((_, resolved)) = check("lldb", None, &root) else {
      eprintln!("lldb-dap not installed; skipping");
      return;
    };
    let src = root.join("main.c");
    std::fs::write(&src, "#include <stdio.h>\nint main(void) {\n  int answer = 41;\n  answer += 1;\n  printf(\"%d\\n\", answer);\n  return 0;\n}\n").unwrap();
    let exe = root.join("main");
    match Command::new("cc").args(["-g", "-O0", "-o"]).arg(&exe).arg(&src).status() {
      Ok(s) if s.success() => {}
      _ => {
        eprintln!("no C compiler; skipping");
        return;
      }
    }
    let sessions = Sessions::default();
    let (sink, rx) = collect();
    let launch = Launch { program: resolved.program, args: resolved.args, cwd: root.clone(), env: std::env::vars_os().collect(), connect: resolved.connect };
    let id = sessions.start(launch, sink).unwrap();
    let mut d = Driver { sessions: Box::leak(Box::new(sessions)), id, rx, seq: 0, stderr: Vec::new(), backlog: Vec::new() };
    let s = d.request("initialize", serde_json::json!({ "clientID": "kingu", "adapterID": "lldb-dap", "linesStartAt1": true, "columnsStartAt1": true, "pathFormat": "path" }));
    d.response(s);
    let launch = d.request("launch", serde_json::json!({ "program": exe, "cwd": root }));
    d.event("initialized");
    let s = d.request("setBreakpoints", serde_json::json!({ "source": { "path": src }, "breakpoints": [{ "line": 4 }] }));
    let bp = d.response(s)["body"]["breakpoints"][0].clone();
    assert_eq!(bp["line"], 4, "{bp}");
    let s = d.request("configurationDone", serde_json::json!({}));
    d.response(s);
    d.response(launch);
    let stopped = d.event("stopped");
    assert_eq!(stopped["body"]["reason"], "breakpoint", "{stopped}");
    let thread = stopped["body"]["threadId"].clone();
    let s = d.request("stackTrace", serde_json::json!({ "threadId": thread, "levels": 1 }));
    let frame = d.response(s)["body"]["stackFrames"][0].clone();
    assert_eq!(frame["line"], 4, "{frame}");
    assert!(frame["source"]["path"].as_str().unwrap_or_default().ends_with("main.c"), "{frame}");
    let s = d.request("scopes", serde_json::json!({ "frameId": frame["id"] }));
    let locals = d.response(s)["body"]["scopes"][0]["variablesReference"].clone();
    let s = d.request("variables", serde_json::json!({ "variablesReference": locals }));
    let vars = d.response(s)["body"]["variables"].clone();
    assert!(vars.as_array().unwrap().iter().any(|v| v["name"] == "answer" && v["value"] == "41"), "{vars}");
    let s = d.request("continue", serde_json::json!({ "threadId": thread }));
    d.response(s);
    d.event("exited");
    let s = d.request("disconnect", serde_json::json!({ "terminateDebuggee": true }));
    d.response(s);
    d.exit();
  }
}
