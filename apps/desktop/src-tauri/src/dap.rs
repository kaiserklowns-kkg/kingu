//! Debug adapters (VS Code gets these from debug extensions): one child process per debug
//! session, speaking the Debug Adapter Protocol with the same `Content-Length` framing as LSP.
//! Messages are passed through to the webview untouched over a Channel; the DAP client (session
//! state, breakpoints, stepping) lives there. Most adapters talk over stdio; `dlv dap` only
//! listens on TCP, so for it the transport connects to the address it prints. js-debug (VS Code's
//! JavaScript debugger, `node`/`chrome` configurations) is a TCP server too, downloaded on request
//! (pinned version, SHA-256 checked); its child sessions are more connections to the same server.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tauri::State;
use tauri::ipc::Channel;

use crate::i18n::msg::LspMsg;
use crate::lsp::{self, FrameDecoder, InstallInfo, LspEvent, Package, ServerSpec, encode};
use crate::tr;

/// Adapter → webview traffic has the LSP transport's shape: a message, a stderr line, the exit.
pub type DapEvent = LspEvent;
pub type Sink = Arc<dyn Fn(DapEvent) + Send + Sync>;

// ---------------------------------------------------------------------------------------------
// Adapters and their resolution

/// How the webview talks to the adapter process.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Connect {
  Stdio,
  /// The adapter prints `… listening at: host:port` (or `listening at host:port`) on stdout, then
  /// accepts connections.
  Tcp,
}

// ---------------------------------------------------------------------------------------------
// js-debug (ms-vscode.js-debug's standalone DAP server)

/// The js-debug release Kingu installs: the version VS Code ships (product.json builtInExtensions),
/// as the `js-debug-dap` tarball of the GitHub release, checked against this SHA-256.
pub const JS_DEBUG_VERSION: &str = "1.140.0";
pub const JS_DEBUG_SHA256: &str = "27dab92937ec1ab35821ae955aac867544fe06a1b6307229049f2d789af10968";
/// The tarball's size, shown before downloading.
pub const JS_DEBUG_BYTES: u64 = 1_249_709;
const JS_DEBUG_MAX_BYTES: u64 = 32 * 1024 * 1024;

pub fn js_debug_url() -> String {
  format!("https://github.com/microsoft/vscode-js-debug/releases/download/v{JS_DEBUG_VERSION}/js-debug-dap-v{JS_DEBUG_VERSION}.tar.gz")
}

/// Where downloaded debug adapters live (the app data dir's `debug-adapters`), set at startup.
static ADAPTERS_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn set_adapters_dir(dir: PathBuf) {
  let _ = ADAPTERS_DIR.set(dir);
}

pub fn adapters_dir() -> Option<&'static Path> {
  ADAPTERS_DIR.get().map(PathBuf::as_path)
}

pub fn js_debug_dir(base: &Path) -> PathBuf {
  base.join(format!("js-debug-v{JS_DEBUG_VERSION}"))
}

/// `dapDebugServer.js` of the installed release (it may not exist).
pub fn js_debug_server(base: &Path) -> PathBuf {
  js_debug_dir(base).join("js-debug/src/dapDebugServer.js")
}

/// Lowercase hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
  use sha2::{Digest, Sha256};
  Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Unpacks a js-debug tarball into `dest` once its SHA-256 is `sha256`: extracted next to it
/// first, so a failed or tampered download never leaves a half-installed adapter.
pub fn install_archive(bytes: &[u8], sha256: &str, dest: &Path) -> Result<PathBuf, String> {
  let actual = sha256_hex(bytes);
  if !actual.eq_ignore_ascii_case(sha256) {
    return Err(tr!(LspMsg::ChecksumMismatch, name = "js-debug", expected = sha256, actual));
  }
  let parent = dest.parent().ok_or_else(|| tr!(LspMsg::ExtractFailed, detail = dest.display()))?;
  std::fs::create_dir_all(parent).map_err(|e| tr!(LspMsg::ExtractFailed, detail = e))?;
  let name = dest.file_name().and_then(|n| n.to_str()).unwrap_or("adapter");
  let staging = parent.join(format!(".{name}.partial-{}", std::process::id()));
  let _ = std::fs::remove_dir_all(&staging);
  std::fs::create_dir_all(&staging).map_err(|e| tr!(LspMsg::ExtractFailed, detail = e))?;
  let result = (|| {
    let archive = staging.join("archive.tar.gz");
    std::fs::write(&archive, bytes).map_err(|e| tr!(LspMsg::ExtractFailed, detail = e))?;
    // The system tar (bsdtar on macOS, GNU tar on Linux) refuses absolute and `..` member paths.
    let out = Command::new("tar")
      .arg("-xzf")
      .arg(&archive)
      .arg("-C")
      .arg(&staging)
      .stdin(Stdio::null())
      .output()
      .map_err(|e| tr!(LspMsg::ExtractFailed, detail = e))?;
    if !out.status.success() {
      return Err(tr!(LspMsg::ExtractFailed, detail = String::from_utf8_lossy(&out.stderr).trim()));
    }
    std::fs::remove_file(&archive).map_err(|e| tr!(LspMsg::ExtractFailed, detail = e))?;
    if !staging.join("js-debug/src/dapDebugServer.js").is_file() {
      return Err(tr!(LspMsg::ExtractFailed, detail = "js-debug/src/dapDebugServer.js"));
    }
    let _ = std::fs::remove_dir_all(dest);
    std::fs::rename(&staging, dest).map_err(|e| tr!(LspMsg::ExtractFailed, detail = e))?;
    Ok(dest.join("js-debug/src/dapDebugServer.js"))
  })();
  if result.is_err() {
    let _ = std::fs::remove_dir_all(&staging);
  }
  result
}

/// GETs the pinned tarball through Kingu's proxy settings (https only, size-capped).
pub fn download_js_debug() -> Result<Vec<u8>, String> {
  let url = js_debug_url();
  let fail = |detail: String| tr!(LspMsg::DownloadFailed, url = url.as_str(), detail);
  let client = crate::net_proxy::client_builder()?.timeout(Duration::from_secs(120)).build().map_err(|e| fail(e.to_string()))?;
  let response = client.get(&url).send().map_err(|e| fail(e.to_string()))?;
  if !response.status().is_success() {
    return Err(fail(response.status().to_string()));
  }
  if response.url().scheme() != "https" {
    return Err(fail(response.url().to_string()));
  }
  let mut bytes = Vec::new();
  response.take(JS_DEBUG_MAX_BYTES + 1).read_to_end(&mut bytes).map_err(|e| fail(e.to_string()))?;
  if bytes.len() as u64 > JS_DEBUG_MAX_BYTES {
    return Err(fail(format!("more than {JS_DEBUG_MAX_BYTES} bytes")));
  }
  Ok(bytes)
}

/// Downloads, checks and unpacks the pinned js-debug (the user asked for it in Run and Debug).
pub fn install_js_debug(fetch: impl FnOnce() -> Result<Vec<u8>, String>) -> Result<PathBuf, String> {
  let base = adapters_dir().ok_or_else(|| tr!(LspMsg::ExtractFailed, detail = "debug-adapters"))?;
  let bytes = fetch()?;
  install_archive(&bytes, JS_DEBUG_SHA256, &js_debug_dir(base))
}

/// What the Run and Debug install flow shows for js-debug.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JsDebugStatus {
  pub version: &'static str,
  pub url: String,
  pub bytes: u64,
  pub sha256: &'static str,
  /// `dapDebugServer.js`, when installed.
  pub server: Option<String>,
  /// Node.js on the login-shell PATH (js-debug runs on it).
  pub node: Option<String>,
}

pub fn js_debug_status(root: &Path) -> JsDebugStatus {
  let home = std::env::var_os("HOME").map(PathBuf::from);
  let path = crate::shell_env::path();
  let node = lsp::find_executable("node", path.as_deref(), home.as_deref(), root).map(|(p, _)| p.to_string_lossy().into_owned());
  let server = adapters_dir().map(js_debug_server).filter(|p| p.is_file()).map(|p| p.to_string_lossy().into_owned());
  JsDebugStatus { version: JS_DEBUG_VERSION, url: js_debug_url(), bytes: JS_DEBUG_BYTES, sha256: JS_DEBUG_SHA256, server, node }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Adapter {
  /// `lldb`, `go` or `debugpy`; also the `KINGU_DAP_<KEY>` override's suffix.
  pub key: &'static str,
  /// Shown in "Not installed: <display>".
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
    // js-debug: `node dapDebugServer.js 0 127.0.0.1` (port 0: it prints the one it got).
    "node" | "pwa-node" | "node-terminal" | "chrome" | "pwa-chrome" | "msedge" | "pwa-msedge" => {
      a("jsdebug", "js-debug", &["node"], &["0", "127.0.0.1"], Connect::Tcp, &[Package::Brew("node")])
    }
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
  /// The installed js-debug `dapDebugServer.js`, if any.
  pub js_debug: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
  pub program: PathBuf,
  pub args: Vec<String>,
  pub connect: Connect,
}

/// Homebrew's llvm is keg-only, so its lldb-dap is never on PATH.
const LLVM_DIRS: &[&str] = &["/opt/homebrew/opt/llvm/bin", "/usr/local/opt/llvm/bin"];

/// The adapter program and arguments, or the "Not installed: …" error. `python` is the launch
/// configuration's interpreter, tried first for debugpy.
pub fn resolve(adapter: &Adapter, python: Option<&Path>, probe: &Probe) -> Result<Resolved, String> {
  let args = adapter.args.iter().map(|s| s.to_string()).collect();
  let find = |name: &str| lsp::find_executable(name, probe.path, probe.home, probe.root).map(|(p, _)| p);
  if adapter.key == "jsdebug" {
    // The override names the server script; node runs it either way.
    let server = probe.override_var.clone().filter(|o| !o.is_empty()).map(PathBuf::from).or_else(|| probe.js_debug.clone());
    let server = server.filter(|p| p.is_file()).ok_or_else(|| tr!(LspMsg::NoJsDebug, var = override_name(adapter)))?;
    let node = find("node").ok_or_else(|| tr!(LspMsg::NoNode))?;
    let args = std::iter::once(server.to_string_lossy().into_owned()).chain(adapter.args.iter().map(|s| s.to_string())).collect();
    return Ok(Resolved { program: node, args, connect: adapter.connect });
  }
  let found = |program: PathBuf| Ok(Resolved { program, args: Vec::clone(&args), connect: adapter.connect });
  if let Some(o) = probe.override_var.clone().filter(|o| !o.is_empty()) {
    let p = PathBuf::from(o);
    return if lsp::is_executable(&p) {
      found(p)
    } else {
      Err(tr!(LspMsg::NotExecutable, name = adapter.display, path = p.display(), var = override_name(adapter)))
    };
  }
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
        Some(p) => tr!(LspMsg::NoDebugpy, python = p.display(), var = override_name(adapter)),
        None => tr!(LspMsg::NoPython),
      })
    }
    _ => {
      let on_path = adapter.binaries.iter().find_map(|b| find(b));
      let keg = || adapter.binaries.iter().flat_map(|b| LLVM_DIRS.iter().map(move |d| Path::new(d).join(b))).find(|p| lsp::is_executable(p));
      let xcrun = || if adapter.key == "lldb" { (probe.xcrun)().filter(|p| lsp::is_executable(p)) } else { None };
      let program = on_path.or_else(|| if adapter.key == "lldb" { keg() } else { None }).or_else(xcrun);
      program.map_or_else(
        || {
          Err(tr!(LspMsg::AdapterNotOnPath, name = adapter.display, binaries = adapter.binaries.join(&tr!(LspMsg::Or)), var = override_name(adapter)))
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
  let adapter = adapter_for(debug_type).ok_or_else(|| tr!(LspMsg::UnsupportedDebugType, debug_type))?;
  let home = std::env::var_os("HOME").map(PathBuf::from);
  let path = crate::shell_env::path();
  let probe = Probe {
    override_var: std::env::var_os(override_name(&adapter)),
    path: path.as_deref(),
    home: home.as_deref(),
    root,
    xcrun: &xcrun_lldb_dap,
    has_debugpy: &python_has_debugpy,
    js_debug: adapters_dir().map(js_debug_server),
  };
  let resolved = resolve(&adapter, python, &probe)?;
  Ok((adapter, resolved))
}

/// Install commands for the adapter of `debug_type` usable on this machine.
pub fn install_info(debug_type: &str, root: &Path) -> Result<InstallInfo, String> {
  let adapter = adapter_for(debug_type).ok_or_else(|| tr!(LspMsg::UnknownDebugType, debug_type))?;
  let home = std::env::var_os("HOME").map(PathBuf::from);
  let path = crate::shell_env::path();
  let spec = ServerSpec { key: adapter.key, display: adapter.display, binaries: adapter.binaries, args: &[], install: adapter.install };
  let methods = lsp::install_methods(&spec, |tool| {
    lsp::find_executable(tool, path.as_deref(), home.as_deref(), root).map(|(p, on_path)| if on_path { tool.to_string() } else { p.to_string_lossy().into_owned() })
  });
  let binary = if adapter.key == "debugpy" { "debugpy" } else { adapter.binaries[0] };
  Ok(InstallInfo { server: adapter.display, binary, methods })
}

/// `dlv dap` prints `DAP server listening at: 127.0.0.1:38697` (or `[::]:port`); js-debug prints
/// `Debug server listening at 127.0.0.1:38697`.
pub fn parse_listen_address(line: &str) -> Option<String> {
  let rest = line.split_once("listening at")?.1;
  let rest = rest.strip_prefix(':').unwrap_or(rest).trim();
  let (host, port) = rest.rsplit_once(':')?;
  port.parse::<u16>().ok()?;
  let host = host.trim_start_matches('[').trim_end_matches(']');
  let host = if host.is_empty() || host == "::" || host == "0.0.0.0" { "127.0.0.1" } else { host };
  Some(if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") })
}

// ---------------------------------------------------------------------------------------------
// Sessions

/// The adapter process a session started (a child connection has none of its own).
struct Proc {
  child: Mutex<Child>,
  pid: u32,
}

struct Session {
  proc: Option<Arc<Proc>>,
  /// Frames queued for the writer thread, so `dap_send` never blocks on a full pipe.
  tx: mpsc::Sender<Vec<u8>>,
  /// A TCP adapter's address: child sessions (`startDebugging`) connect to it again.
  addr: Option<String>,
  /// The connection, so stopping a child session closes it without touching the server.
  socket: Option<TcpStream>,
}

#[derive(Default)]
pub struct Sessions {
  next_id: AtomicU32,
  running: Arc<Mutex<HashMap<u32, Arc<Session>>>>,
  /// The window that started each session (a window's folder switch or close stops only its own).
  owners: Mutex<HashMap<u32, String>>,
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

type Transport = (Box<dyn Read + Send>, Box<dyn Write + Send>);

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
    let proc = Arc::new(Proc { child: Mutex::new(child), pid });

    let mut forwarders = vec![forward_lines(stderr, sink.clone())];
    let mut addr = None;
    let mut socket = None;
    let (reader, writer): Transport = match launch.connect {
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
          .map_err(|_| tr!(LspMsg::NoDapServer, program = launch.program.display(), secs = TCP_WAIT.as_secs()))
          .and_then(|a| TcpStream::connect(&a).map(|s| (a.clone(), s)).map_err(|e| tr!(LspMsg::ConnectAdapter, addr = a, detail = e)));
        let (a, stream) = match connected {
          Ok(s) => s,
          Err(e) => {
            kill_group(pid, &proc.child);
            let _ = proc.child.lock().unwrap().wait();
            return Err(e);
          }
        };
        drop(stdin);
        addr = Some(a);
        socket = stream.try_clone().ok();
        let read_half = stream.try_clone().map_err(|e| e.to_string())?;
        (Box::new(read_half), Box::new(stream))
      }
    };
    Ok(self.register(Some(proc), addr, socket, (reader, writer), forwarders, sink))
  }

  /// A child session of a TCP adapter (js-debug's `startDebugging`): one more connection to the
  /// server of session `parent`, speaking DAP on its own. Its end leaves the server running.
  pub fn connect_child(&self, parent: u32, sink: Sink) -> Result<u32, String> {
    let addr = self.running.lock().unwrap().get(&parent).and_then(|s| s.addr.clone()).ok_or_else(|| tr!(LspMsg::NoSession))?;
    let stream = TcpStream::connect(&addr).map_err(|e| tr!(LspMsg::ConnectAdapter, addr = addr.as_str(), detail = e))?;
    let read_half = stream.try_clone().map_err(|e| e.to_string())?;
    let socket = stream.try_clone().ok();
    Ok(self.register(None, Some(addr), socket, (Box::new(read_half), Box::new(stream)), Vec::new(), sink))
  }

  fn register(&self, proc: Option<Arc<Proc>>, addr: Option<String>, socket: Option<TcpStream>, transport: Transport, forwarders: Vec<std::thread::JoinHandle<()>>, sink: Sink) -> u32 {
    let (mut reader, mut writer) = transport;
    let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let session = Arc::new(Session { proc, tx, addr, socket });
    self.running.lock().unwrap().insert(id, session.clone());

    std::thread::spawn(move || {
      for frame in rx {
        if writer.write_all(&frame).and_then(|_| writer.flush()).is_err() {
          break;
        }
      }
    });

    let running = self.running.clone();
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
      let code = match &session.proc {
        None => None,
        Some(proc) => {
          let deadline = std::time::Instant::now() + Duration::from_secs(3);
          loop {
            match proc.child.lock().unwrap().try_wait() {
              Ok(Some(s)) => break s.code(),
              Ok(None) if std::time::Instant::now() < deadline => {}
              Ok(None) => {
                kill_group(proc.pid, &proc.child);
                break proc.child.lock().unwrap().wait().ok().and_then(|s| s.code());
              }
              Err(_) => break None,
            }
            std::thread::sleep(Duration::from_millis(20));
          }
        }
      };
      for f in forwarders {
        let _ = f.join();
      }
      running.lock().unwrap().remove(&id);
      log::info!("debug adapter {id} exited (code {code:?})");
      sink(DapEvent::Exit { code });
    });
    id
  }

  pub fn send(&self, id: u32, json: &str) -> Result<(), String> {
    let s = self.running.lock().unwrap().get(&id).cloned().ok_or_else(|| tr!(LspMsg::NoSession))?;
    s.tx.send(encode(json)).map_err(|_| "debug adapter input is closed".to_string())
  }

  /// Kills the adapter and its process group (the client sends `disconnect` first when it can); a
  /// child session only closes its connection.
  pub fn stop(&self, id: u32) -> Result<(), String> {
    let s = self.running.lock().unwrap().get(&id).cloned().ok_or_else(|| tr!(LspMsg::NoSession))?;
    match &s.proc {
      Some(p) => kill_group(p.pid, &p.child),
      None => {
        if let Some(sock) = &s.socket {
          let _ = sock.shutdown(std::net::Shutdown::Both);
        }
      }
    }
    Ok(())
  }

  /// Records the window that started session `id`.
  pub fn own(&self, id: u32, window: &str) {
    self.owners.lock().unwrap().insert(id, window.to_string());
  }

  /// The window that started session `id`.
  pub fn owner(&self, id: u32) -> Option<String> {
    self.owners.lock().unwrap().get(&id).cloned()
  }

  /// A window's folder switch or close: its debug sessions go (other windows' keep running).
  pub fn stop_window(&self, window: &str) {
    let ids: Vec<u32> = {
      let mut owners = self.owners.lock().unwrap();
      let ids = owners.iter().filter(|(_, w)| *w == window).map(|(id, _)| *id).collect::<Vec<_>>();
      owners.retain(|_, w| w != window);
      ids
    };
    let gone: Vec<_> = {
      let mut running = self.running.lock().unwrap();
      ids.iter().filter_map(|id| running.remove(id)).collect()
    };
    Self::stop_sessions(&gone);
  }

  /// App exit: no debuggee may outlive its window.
  pub fn stop_all(&self) {
    let all: Vec<_> = self.running.lock().unwrap().drain().map(|(_, s)| s).collect();
    Self::stop_sessions(&all);
  }

  fn stop_sessions(all: &[Arc<Session>]) {
    for s in all {
      match &s.proc {
        Some(p) => kill_group(p.pid, &p.child),
        None => {
          if let Some(sock) = &s.socket {
            let _ = sock.shutdown(std::net::Shutdown::Both);
          }
        }
      }
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

/// A child session of session `parent` (js-debug's `startDebugging` reverse request).
pub fn start_child_for(sessions: &Sessions, parent: u32, on_event: Channel<DapEvent>) -> Result<u32, String> {
  let id = sessions.connect_child(
    parent,
    Arc::new(move |ev| {
      let _ = on_event.send(ev);
    }),
  )?;
  log::info!("debug session {id}: child of {parent}");
  Ok(id)
}

/// One process for `${command:pickProcess}` (VS Code's process picker for attach configurations).
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
pub struct ProcessEntry {
  pub pid: u32,
  pub command: String,
}

/// `ps -axww -o pid=,command=` output: `  123 /usr/bin/thing --flag` per line.
pub fn parse_ps(text: &str, own_pid: u32) -> Vec<ProcessEntry> {
  text
    .lines()
    .filter_map(|l| {
      let l = l.trim_start();
      let (pid, command) = l.split_once(char::is_whitespace)?;
      let pid = pid.parse::<u32>().ok()?;
      let command = command.trim();
      (pid != own_pid && !command.is_empty()).then(|| ProcessEntry { pid, command: command.to_string() })
    })
    .collect()
}

pub fn list_processes() -> Result<Vec<ProcessEntry>, String> {
  let out = Command::new("ps").args(["-axww", "-o", "pid=,command="]).stdin(Stdio::null()).output().map_err(|e| tr!(LspMsg::RunFailed, program = "ps", detail = e))?;
  Ok(parse_ps(&String::from_utf8_lossy(&out.stdout), std::process::id()))
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
  let (program, args) = argv.split_first().ok_or_else(|| tr!(LspMsg::NoBuildCommand))?;
  let out = crate::shell_env::command(program)
    .args(args)
    .current_dir(cwd)
    .stdin(Stdio::null())
    .output()
    .map_err(|e| tr!(LspMsg::RunFailed, program, detail = e))?;
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
    for none in ["cppdbg", "coreclr", ""] {
      assert_eq!(key(none), None, "{none}");
    }
    // js-debug serves every JavaScript type over TCP (VS Code: node, pwa-node, chrome, msedge…).
    for t in ["node", "pwa-node", "node-terminal", "chrome", "pwa-chrome", "msedge", "pwa-msedge"] {
      assert_eq!(key(t), Some("jsdebug"), "{t}");
    }
    let js = adapter_for("node").unwrap();
    assert_eq!((js.args, js.connect), (&["0", "127.0.0.1"][..], Connect::Tcp));
    assert_eq!(override_name(&js), "KINGU_DAP_JSDEBUG");
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
    // js-debug's dapDebugServer.js (no colon after "at").
    assert_eq!(parse_listen_address("Debug server listening at 127.0.0.1:61234\n").as_deref(), Some("127.0.0.1:61234"));
    assert_eq!(parse_listen_address("Debug server listening at ::1:61234").as_deref(), Some("[::1]:61234"));
  }

  #[test]
  fn parses_the_process_list() {
    let ps = "    1 /sbin/launchd\n  812 /usr/bin/node --inspect=9229 server.js\n 999 kingu\nnot a pid line\n  77 \n";
    let got = parse_ps(ps, 999);
    assert_eq!(got, [ProcessEntry { pid: 1, command: "/sbin/launchd".into() }, ProcessEntry { pid: 812, command: "/usr/bin/node --inspect=9229 server.js".into() }]);
  }

  #[cfg(unix)]
  #[test]
  fn resolves_js_debug_through_node() {
    let tmp = tempfile::tempdir().unwrap();
    let (bin, root) = (tmp.path().join("bin"), tmp.path().join("ws"));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&bin).unwrap();
    let js = adapter_for("pwa-node").unwrap();
    let no_xcrun = || None;
    let yes = |_: &Path| true;
    let server = js_debug_server(&tmp.path().join("adapters"));
    // Not downloaded yet: the "not installed" error the Run and Debug install flow keys off.
    let mut p = probe(&bin, &root, &no_xcrun, &yes);
    p.js_debug = Some(server.clone());
    let err = resolve(&js, None, &p).unwrap_err();
    assert!(err.starts_with("Not installed: js-debug") && err.contains("KINGU_DAP_JSDEBUG"), "{err}");
    std::fs::create_dir_all(server.parent().unwrap()).unwrap();
    std::fs::write(&server, "// server").unwrap();
    // Downloaded, but node is missing (skipped where a node sits in a fixed extra dir).
    if !["/opt/homebrew/bin/node", "/usr/local/bin/node"].iter().any(|n| Path::new(n).exists()) {
      let err = resolve(&js, None, &p).unwrap_err();
      assert!(err.starts_with("Not installed: Node.js"), "{err}");
    }
    let node = fake_bin(&bin, "node");
    let r = resolve(&js, None, &p).unwrap();
    assert_eq!((r.program, r.args, r.connect), (node, vec![server.to_string_lossy().into_owned(), "0".into(), "127.0.0.1".into()], Connect::Tcp));
    // The override names the server script.
    let other = tmp.path().join("my/dapDebugServer.js");
    std::fs::create_dir_all(other.parent().unwrap()).unwrap();
    std::fs::write(&other, "").unwrap();
    p.override_var = Some(other.clone().into());
    assert_eq!(resolve(&js, None, &p).unwrap().args[0], other.to_string_lossy());
  }

  /// A js-debug-shaped tarball made with the system tar (no network).
  #[cfg(unix)]
  fn tarball(dir: &Path, with_server: bool) -> Vec<u8> {
    let src = dir.join("src-tree");
    let _ = std::fs::remove_dir_all(&src);
    std::fs::create_dir_all(src.join("js-debug/src")).unwrap();
    let file = if with_server { "dapDebugServer.js" } else { "other.js" };
    std::fs::write(src.join("js-debug/src").join(file), "console.log('server')").unwrap();
    let out = dir.join("pkg.tar.gz");
    assert!(Command::new("tar").arg("-czf").arg(&out).arg("-C").arg(&src).arg("js-debug").status().unwrap().success());
    std::fs::read(out).unwrap()
  }

  #[cfg(unix)]
  #[test]
  fn installs_js_debug_only_with_the_right_checksum() {
    let tmp = tempfile::tempdir().unwrap();
    let dest = js_debug_dir(&tmp.path().join("adapters"));
    let good = tarball(tmp.path(), true);
    let sha = sha256_hex(&good);
    assert_eq!(sha.len(), 64);
    assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    // A tampered (or other) archive: refused, nothing left behind.
    let err = install_archive(&good, &"0".repeat(64), &dest).unwrap_err();
    assert!(err.contains("SHA-256") && err.contains(&sha), "{err}");
    assert!(!dest.exists());
    assert!(std::fs::read_dir(dest.parent().unwrap()).map_or(true, |d| d.count() == 0), "no staging dir left");
    // The right one: unpacked, server in place.
    let server = install_archive(&good, &sha.to_uppercase(), &dest).unwrap();
    assert_eq!(server, js_debug_server(&tmp.path().join("adapters")));
    assert!(server.is_file());
    // An archive without the server is refused and keeps the installed one.
    let bad = tarball(tmp.path(), false);
    assert!(install_archive(&bad, &sha256_hex(&bad), &dest).is_err());
    assert!(server.is_file());
    // Not a gzip at all.
    assert!(install_archive(b"garbage", &sha256_hex(b"garbage"), &dest).is_err());
    assert!(server.is_file());
    // The pinned release is VS Code's js-debug, over https from GitHub.
    assert!(js_debug_url().starts_with("https://github.com/microsoft/vscode-js-debug/releases/download/v1.140.0/js-debug-dap-v1.140.0.tar.gz"));
    assert_eq!(JS_DEBUG_SHA256.len(), 64);
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
    Probe { override_var: None, path: Some(path.as_os_str()), home: None, root, xcrun, has_debugpy, js_debug: None }
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
      assert!(err.starts_with("Not installed: lldb-dap"), "{err}");
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
      assert!(resolve(&go, None, &probe(&bin, &root, &no_xcrun, &yes)).unwrap_err().starts_with("Not installed: Delve (dlv)"));
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
    assert!(err.starts_with("Not installed: debugpy") && err.contains("pip install debugpy"), "{err}");
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
          Err(_) => panic!("timed out waiting for {what}; stderr: {:?}; backlog: {:?}", self.stderr, self.backlog),
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

  /// js-debug's shape: a TCP server whose parent session asks for a child session
  /// (`startDebugging`), which is a second connection to the same server.
  #[test]
  fn child_sessions_connect_to_the_same_server_like_js_debug() {
    let Some(python) = python3() else {
      eprintln!("python3 not found; skipping");
      return;
    };
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/fake_jsdebug.py");
    let sessions: &'static Sessions = Box::leak(Box::default());
    let (sink, rx) = collect();
    let launch = Launch { program: python, args: vec![script.to_string_lossy().into_owned()], cwd: std::env::temp_dir(), env: vec![("PATH".into(), "/usr/bin:/bin".into())], connect: Connect::Tcp };
    let id = sessions.start(launch, sink).unwrap();
    let mut parent = Driver { sessions, id, rx, seq: 0, stderr: Vec::new(), backlog: Vec::new() };
    let s = parent.request("initialize", serde_json::json!({ "clientID": "kingu", "adapterID": "pwa-node" }));
    assert_eq!(parent.response(s)["body"]["exceptionBreakpointFilters"][0]["filter"], "uncaught");
    let l = parent.request("launch", serde_json::json!({ "type": "pwa-node", "program": "/ws/index.js" }));
    parent.response(l);
    let req = parent.wait(30, "startDebugging", |v| v["type"] == "request" && v["command"] == "startDebugging");
    let config = req["arguments"]["configuration"].clone();
    assert_eq!(config["__pendingTargetId"], "target-1");

    // The child: its own connection and session id, the same address.
    let (sink, rx) = collect();
    let child_id = sessions.connect_child(id, sink).unwrap();
    assert_ne!(child_id, id);
    let mut child = Driver { sessions, id: child_id, rx, seq: 0, stderr: Vec::new(), backlog: Vec::new() };
    let s = child.request("initialize", serde_json::json!({ "clientID": "kingu", "adapterID": "pwa-node" }));
    child.response(s);
    let l = child.request("launch", config);
    child.response(l);
    child.event("initialized");
    let s = child.request("setBreakpoints", serde_json::json!({ "source": { "path": "/ws/index.js" }, "breakpoints": [{ "line": 2 }] }));
    child.response(s);
    let s = child.request("configurationDone", serde_json::json!({}));
    child.response(s);
    assert_eq!(child.event("stopped")["body"]["threadId"], 7);
    let s = child.request("continue", serde_json::json!({ "threadId": 7 }));
    child.response(s);
    child.event("terminated");
    // Stopping the child closes only its connection; the server (parent) keeps running.
    sessions.stop(child_id).unwrap();
    assert_eq!(child.exit(), None);
    assert!(sessions.is_running(id));
    // A child of a session that is not a TCP server, or is gone, is refused.
    assert!(sessions.connect_child(9999, collect().0).is_err());
    let s = parent.request("disconnect", serde_json::json!({}));
    parent.response(s);
    parent.exit();
    assert!(!sessions.is_running(id));
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
