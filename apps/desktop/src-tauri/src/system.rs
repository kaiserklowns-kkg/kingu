//! Status bar resources, like Orca's footer: keep-awake, the Resource Manager (memory, CPU and
//! the processes under Kingu), and the ports those processes listen on.
use std::collections::HashSet;
use std::process::{Child, Command};
use std::sync::Mutex;

use crate::pty::PtyInfo;

/// The `caffeinate` process that keeps the Mac awake while it runs (`None`: off).
#[derive(Default)]
pub struct KeepAwake(Mutex<Option<Child>>);

/// One `ps` row.
#[derive(Clone, Debug, PartialEq)]
struct Proc {
  pid: u32,
  ppid: u32,
  /// KiB.
  rss: u64,
  cpu: f32,
  command: String,
}

#[derive(serde::Serialize)]
pub struct ProcessRow {
  pid: u32,
  ppid: u32,
  rss_bytes: u64,
  cpu: f32,
  /// The executable's base name (`zsh`, `node`, `claude`).
  name: String,
  /// False for the terminal daemon (it holds every terminal) and WebKit's processes (the window).
  stoppable: bool,
}

#[derive(serde::Serialize)]
pub struct Stats {
  /// Resident memory of Kingu and every process below it (shells, agent CLIs, language servers),
  /// summed RSS, plus the WebKit processes that render our window (`webkit`; launchd starts them,
  /// so they are not our children). `None` off Unix.
  memory_bytes: Option<u64>,
  /// Summed CPU of the same tree; above 100 means more than one core.
  cpu_percent: Option<f32>,
  terminals: Vec<PtyInfo>,
  /// Processes below Kingu, largest first.
  processes: Vec<ProcessRow>,
  /// `None` where keep-awake is not supported (anything but macOS).
  keep_awake: Option<bool>,
}

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct Port {
  port: u16,
  address: String,
  pid: u32,
  name: String,
  /// Started under Kingu (a terminal, an agent, a dev server); others are "external".
  ours: bool,
  /// The process's working directory, which tells the ADE whose worktree the server belongs to
  /// (`None` where it can't be read: another user's process, or no `lsof`).
  cwd: Option<String>,
}

fn parse_ps(text: &str) -> Vec<Proc> {
  text
    .lines()
    .filter_map(|line| {
      let mut it = line.split_whitespace();
      let pid = it.next()?.parse().ok()?;
      let ppid = it.next()?.parse().ok()?;
      let rss = it.next()?.parse().ok()?;
      let cpu = it.next()?.parse().ok()?;
      let command = it.collect::<Vec<_>>().join(" ");
      Some(Proc { pid, ppid, rss, cpu, command })
    })
    .collect()
}

/// Kingu and every process below it, plus the terminal daemon's tree (it is not our child).
fn kingu_tree(rows: &[Proc], daemon: Option<u32>) -> HashSet<u32> {
  let mut ours = tree(rows, std::process::id());
  if let Some(d) = daemon {
    ours.extend(tree(rows, d));
  }
  ours
}

/// `root` and every process below it.
fn tree(rows: &[Proc], root: u32) -> HashSet<u32> {
  let mut seen = HashSet::from([root]);
  let mut todo = vec![root];
  while let Some(pid) = todo.pop() {
    for p in rows {
      if p.ppid == pid && seen.insert(p.pid) {
        todo.push(p.pid);
      }
    }
  }
  seen
}

fn ps() -> Option<Vec<Proc>> {
  if !cfg!(unix) {
    return None;
  }
  let out = Command::new("ps").args(["-A", "-o", "pid=,ppid=,rss=,%cpu=,comm="]).output().ok()?;
  Some(parse_ps(&String::from_utf8_lossy(&out.stdout)))
}

/// `…/com.apple.WebKit.WebContent` → `WebView (WebContent)`.
fn webkit_name(command: &str) -> String {
  let base = base_name(command);
  format!("WebView ({})", base.strip_prefix("com.apple.WebKit.").unwrap_or(&base))
}

/// The pids of the WebKit processes behind each window's webview (web content, GPU, networking),
/// through WKWebView's private `_…ProcessIdentifier` getters (checked with `respondsToSelector:`).
#[cfg(target_os = "macos")]
pub fn webkit_pids<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Vec<u32> {
  use tauri::Manager;
  let mut pids = Vec::new();
  for window in app.webview_windows().into_values() {
    let (tx, rx) = std::sync::mpsc::channel();
    // Runs on the main thread; never block it from there, so the wait below has a timeout.
    if window.with_webview(move |w| _ = tx.send(unsafe { objc::webview_pids(w.inner()) })).is_ok() {
      pids.extend(rx.recv_timeout(std::time::Duration::from_millis(500)).unwrap_or_default());
    }
  }
  pids.sort_unstable();
  pids.dedup();
  pids
}

#[cfg(not(target_os = "macos"))]
pub fn webkit_pids<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) -> Vec<u32> {
  Vec::new()
}

#[cfg(target_os = "macos")]
mod objc {
  use std::ffi::{c_char, c_void, CStr};

  #[link(name = "objc")]
  unsafe extern "C" {
    fn sel_registerName(name: *const c_char) -> *const c_void;
    fn objc_msgSend();
  }

  /// # Safety
  /// `view` must be a live WKWebView, used on the main thread.
  pub unsafe fn webview_pids(view: *mut c_void) -> Vec<u32> {
    if view.is_null() {
      return Vec::new();
    }
    unsafe {
      let responds: unsafe extern "C" fn(*mut c_void, *const c_void, *const c_void) -> i8 = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
      let get_pid: unsafe extern "C" fn(*mut c_void, *const c_void) -> i32 = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
      let responds_sel = sel_registerName(c"respondsToSelector:".as_ptr());
      let names: [&CStr; 3] = [c"_webProcessIdentifier", c"_gpuProcessIdentifier", c"_networkProcessIdentifier"];
      names
        .iter()
        .filter_map(|name| {
          let sel = sel_registerName(name.as_ptr());
          (responds(view, responds_sel, sel) != 0).then(|| get_pid(view, sel)).filter(|pid| *pid > 0).map(|pid| pid as u32)
        })
        .collect()
    }
  }
}

fn base_name(command: &str) -> String {
  command.rsplit('/').next().unwrap_or(command).trim_start_matches('-').to_string()
}

impl KeepAwake {
  fn is_on(&self) -> bool {
    let mut child = self.0.lock().unwrap();
    // caffeinate may have been killed from outside.
    if let Some(c) = child.as_mut()
      && !matches!(c.try_wait(), Ok(None))
    {
      *child = None;
    }
    child.is_some()
  }

  pub fn set(&self, on: bool) -> Result<bool, String> {
    if !cfg!(target_os = "macos") {
      return Err("keep-awake needs macOS".into());
    }
    let mut child = self.0.lock().unwrap();
    if on && child.as_mut().is_some_and(|c| matches!(c.try_wait(), Ok(None))) {
      return Ok(true);
    }
    if let Some(mut c) = child.take() {
      let _ = c.kill();
      let _ = c.wait();
    }
    if on {
      // -d display, -i idle sleep; -w exits with Kingu, so a crash never leaves the Mac awake.
      let c = Command::new("caffeinate").args(["-di", "-w", &std::process::id().to_string()]).spawn().map_err(|e| format!("caffeinate: {e}"))?;
      *child = Some(c);
    }
    Ok(on)
  }
}

/// `daemon`: the terminal daemon's pid, whose shells and agent CLIs count as Kingu's.
pub fn stats(terminals: Vec<PtyInfo>, daemon: Option<u32>, webkit: &[u32], keep: &KeepAwake) -> Stats {
  let keep_awake = cfg!(target_os = "macos").then(|| keep.is_on());
  let Some(rows) = ps() else {
    return Stats { memory_bytes: None, cpu_percent: None, terminals, processes: Vec::new(), keep_awake };
  };
  let me = std::process::id();
  let mut ours = kingu_tree(&rows, daemon);
  ours.extend(webkit.iter().copied().filter(|pid| rows.iter().any(|p| p.pid == *pid)));
  let mine: Vec<&Proc> = rows.iter().filter(|p| ours.contains(&p.pid)).collect();
  let memory = mine.iter().map(|p| p.rss).sum::<u64>() * 1024;
  let cpu = mine.iter().map(|p| p.cpu).sum::<f32>();
  let mut processes: Vec<ProcessRow> = mine
    .iter()
    // Leaves out Kingu itself and the `ps` / `lsof` that are reading it right now.
    .filter(|p| p.pid != me && !(p.ppid == me && matches!(base_name(&p.command).as_str(), "ps" | "lsof")))
    .map(|p| {
      let web = webkit.contains(&p.pid);
      let name = if web { webkit_name(&p.command) } else { base_name(&p.command) };
      ProcessRow { pid: p.pid, ppid: p.ppid, rss_bytes: p.rss * 1024, cpu: p.cpu, name, stoppable: !web && Some(p.pid) != daemon }
    })
    .collect();
  processes.sort_by_key(|p| std::cmp::Reverse(p.rss_bytes));
  Stats { memory_bytes: Some(memory), cpu_percent: Some(cpu), terminals, processes, keep_awake }
}

/// `lsof -F pcn` output: `p<pid>`, `c<command>`, then `n<address:port>` per listening socket.
fn parse_lsof(text: &str) -> Vec<(u32, String, String, u16)> {
  let mut out = Vec::new();
  let (mut pid, mut name) = (0u32, String::new());
  for line in text.lines() {
    let (tag, rest) = line.split_at(line.len().min(1));
    match tag {
      "p" => pid = rest.parse().unwrap_or(0),
      "c" => name = rest.to_string(),
      "n" => {
        if let Some((addr, port)) = rest.rsplit_once(':')
          && let Ok(port) = port.parse()
        {
          out.push((pid, name.clone(), addr.to_string(), port));
        }
      }
      _ => {}
    }
  }
  out
}

/// TCP ports in LISTEN state, Kingu's own first, then by port. Empty where `lsof` is missing.
pub fn ports(daemon: Option<u32>) -> Result<Vec<Port>, String> {
  if !cfg!(unix) {
    return Err("port scan needs macOS or Linux".into());
  }
  let out = Command::new("lsof").args(["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]).output().map_err(|e| format!("lsof: {e}"))?;
  let ours = ps().map(|rows| kingu_tree(&rows, daemon)).unwrap_or_default();
  let mut seen = HashSet::new();
  let mut ports: Vec<Port> = parse_lsof(&String::from_utf8_lossy(&out.stdout))
    .into_iter()
    // IPv4 and IPv6 sockets of one server show up twice.
    .filter(|(pid, _, _, port)| seen.insert((*pid, *port)))
    .map(|(pid, name, address, port)| Port { port, address, pid, ours: ours.contains(&pid), name, cwd: None })
    .collect();
  let mut pids: Vec<u32> = ports.iter().map(|p| p.pid).collect();
  pids.sort_unstable();
  pids.dedup();
  let cwds = cwds(&pids);
  for p in &mut ports {
    p.cwd = cwds.get(&p.pid).cloned();
  }
  ports.sort_by(|a, b| b.ours.cmp(&a.ours).then(a.port.cmp(&b.port)));
  Ok(ports)
}

/// Working directories of `pids`: `/proc/<pid>/cwd` on Linux, one `lsof -d cwd` call elsewhere.
fn cwds(pids: &[u32]) -> std::collections::HashMap<u32, String> {
  if pids.is_empty() {
    return Default::default();
  }
  if cfg!(target_os = "linux") {
    return pids.iter().filter_map(|pid| Some((*pid, std::fs::read_link(format!("/proc/{pid}/cwd")).ok()?.to_string_lossy().into_owned()))).collect();
  }
  let list = pids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
  // `lsof` exits 1 when some pid has gone meanwhile; what it printed is still right.
  match Command::new("lsof").args(["-a", "-nP", "-d", "cwd", "-p", &list, "-F", "pn"]).output() {
    Ok(out) => parse_lsof_cwd(&String::from_utf8_lossy(&out.stdout)),
    Err(_) => Default::default(),
  }
}

/// `lsof -d cwd -F pn` output: `p<pid>` then `n<path>`.
fn parse_lsof_cwd(text: &str) -> std::collections::HashMap<u32, String> {
  let mut out = std::collections::HashMap::new();
  let mut pid = 0u32;
  for line in text.lines() {
    let (tag, rest) = line.split_at(line.len().min(1));
    match tag {
      "p" => pid = rest.parse().unwrap_or(0),
      "n" if pid != 0 && rest.starts_with('/') => {
        out.insert(pid, rest.to_owned());
      }
      _ => {}
    }
  }
  out
}

/// SIGTERM to a process, but only one that runs under Kingu: the webview can never stop
/// another app's process.
pub fn kill(pid: u32, daemon: Option<u32>) -> Result<(), String> {
  let rows = ps().ok_or("not supported here")?;
  let me = std::process::id();
  if pid == me || Some(pid) == daemon || !kingu_tree(&rows, daemon).contains(&pid) {
    return Err(format!("process {pid} was not started by Kingu"));
  }
  let ok = Command::new("kill").args(["-TERM", &pid.to_string()]).status().map_err(|e| e.to_string())?.success();
  if ok { Ok(()) } else { Err(format!("kill {pid} failed")) }
}

/// Opens a local server (`http://localhost:<port>`) in the default browser; any other URL is refused.
pub fn open_local_url(url: &str) -> Result<(), String> {
  let parsed = url::Url::parse(url).map_err(|e| e.to_string())?;
  let local = matches!(parsed.scheme(), "http" | "https") && matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
  if !local {
    return Err("only localhost URLs open from the status bar".into());
  }
  let program = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
  Command::new(program).arg(parsed.as_str()).spawn().map(|_| ()).map_err(|e| format!("{program}: {e}"))
}

static CONFIG_DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

/// The app config dir, where the user's settings.json lives (set once at startup).
pub fn set_config_dir(dir: std::path::PathBuf) {
  let _ = CONFIG_DIR.set(dir);
}

/// `workbench.externalBrowser` from the user's settings.json only: it names a program to run, so
/// a folder's workspace settings can never set it (VS Code marks it restricted).
fn external_browser() -> Option<String> {
  let value = crate::settings::user_value(CONFIG_DIR.get()?, "workbench.externalBrowser")?;
  value.as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

/// How to open `url` (VS Code's `workbench.externalBrowser`): the system default with no browser
/// set; a known name (`chrome`, `edge`, `firefox`, `safari`…) or a macOS `.app` through `open -a`;
/// any other absolute path is the browser executable itself.
pub fn browser_command(browser: Option<&str>, url: &str, macos: bool) -> (String, Vec<String>) {
  let default = || if macos { "open" } else { "xdg-open" }.to_string();
  let Some(browser) = browser else { return (default(), vec![url.into()]) };
  let known = |mac: &str, linux: &str| if macos { (default(), vec!["-a".into(), mac.into(), url.into()]) } else { (linux.into(), vec![url.into()]) };
  match browser.to_ascii_lowercase().as_str() {
    "chrome" => known("Google Chrome", "google-chrome"),
    "chromium" => known("Chromium", "chromium"),
    "edge" => known("Microsoft Edge", "microsoft-edge"),
    "firefox" => known("Firefox", "firefox"),
    "safari" => known("Safari", "safari"),
    "brave" => known("Brave Browser", "brave-browser"),
    "opera" => known("Opera", "opera"),
    _ if macos && browser.trim_end_matches('/').ends_with(".app") => (default(), vec!["-a".into(), browser.into(), url.into()]),
    _ => (browser.into(), vec![url.into()]),
  }
}

/// Opens a web page (`http`/`https` only: a terminal link, pull request or check page must never
/// launch other handlers) in `workbench.externalBrowser`, else the default browser.
pub fn open_web_url(url: &str) -> Result<(), String> {
  let parsed = url::Url::parse(url).map_err(|e| e.to_string())?;
  if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
    return Err(format!("{}: เปิดได้เฉพาะลิงก์ http/https", parsed.scheme()));
  }
  let (program, args) = browser_command(external_browser().as_deref(), parsed.as_str(), cfg!(target_os = "macos"));
  Command::new(&program).args(&args).spawn().map(|_| ()).map_err(|e| format!("{program}: {e}"))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn external_browser_command() {
    let url = "https://example.com/";
    let cmd = |b: Option<&str>, mac: bool| browser_command(b, url, mac);
    let v = |xs: &[&str]| xs.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(cmd(None, true), ("open".into(), v(&[url])));
    assert_eq!(cmd(None, false), ("xdg-open".into(), v(&[url])));
    assert_eq!(cmd(Some("chrome"), true), ("open".into(), v(&["-a", "Google Chrome", url])));
    assert_eq!(cmd(Some("Firefox"), false), ("firefox".into(), v(&[url])));
    assert_eq!(cmd(Some("/Applications/Arc.app"), true), ("open".into(), v(&["-a", "/Applications/Arc.app", url])));
    assert_eq!(cmd(Some("/usr/bin/vivaldi"), false), ("/usr/bin/vivaldi".into(), v(&[url])));
  }

  #[test]
  fn web_links_open_only_http_and_https() {
    assert!(open_web_url("file:///etc/passwd").is_err());
    assert!(open_web_url("javascript:alert(1)").is_err());
    assert!(open_web_url("not a url").is_err());
  }

  #[test]
  fn finds_a_process_tree() {
    let rows = parse_ps("  10     1  1000  1.5 /Applications/Kingu\n  11    10   200  0.0 -zsh\n  12    11    30 12.0 node\n  13     1  9999  0.0 other\n bad line\n");
    assert_eq!(rows.len(), 4);
    assert_eq!(tree(&rows, 10), HashSet::from([10, 11, 12]));
    assert_eq!(tree(&rows, 42), HashSet::from([42]));
    assert_eq!(base_name(&rows[1].command), "zsh");
    assert_eq!(base_name(&rows[0].command), "Kingu");
  }

  #[test]
  fn parses_listening_sockets() {
    let out = "p501\ncnode\nn127.0.0.1:5173\nn[::1]:5173\np77\ncpostgres\nn*:5432\n";
    assert_eq!(
      parse_lsof(out),
      [(501, "node".into(), "127.0.0.1".into(), 5173), (501, "node".into(), "[::1]".into(), 5173), (77, "postgres".into(), "*".into(), 5432)]
    );
  }

  #[test]
  fn parses_working_directories() {
    let m = parse_lsof_cwd("p501\nfcwd\nn/Users/me/app/.kingu/worktrees/fix-login\np77\nfcwd\nn/\np9\nfcwd\nnbogus\n");
    assert_eq!(m.get(&501).map(String::as_str), Some("/Users/me/app/.kingu/worktrees/fix-login"));
    assert_eq!(m.get(&77).map(String::as_str), Some("/"));
    assert!(!m.contains_key(&9));
  }

  #[test]
  fn opens_only_localhost() {
    assert!(open_local_url("https://example.com").is_err());
    assert!(open_local_url("file:///etc/passwd").is_err());
  }

  #[test]
  fn refuses_to_kill_foreign_processes() {
    assert!(kill(1, None).is_err());
    assert!(kill(std::process::id(), None).is_err());
    // The terminal daemon itself is never stopped from here (only what runs under it).
    assert!(kill(4242, Some(4242)).is_err());
  }
}
