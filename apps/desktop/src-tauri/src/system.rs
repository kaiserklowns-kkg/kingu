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
}

#[derive(serde::Serialize)]
pub struct Stats {
  /// Resident memory of Kingu and every process below it (shells, agent CLIs, language servers),
  /// summed RSS. WebKit's web-content processes are not our children and are not counted.
  /// `None` off Unix.
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

pub fn stats(terminals: Vec<PtyInfo>, keep: &KeepAwake) -> Stats {
  let keep_awake = cfg!(target_os = "macos").then(|| keep.is_on());
  let Some(rows) = ps() else {
    return Stats { memory_bytes: None, cpu_percent: None, terminals, processes: Vec::new(), keep_awake };
  };
  let me = std::process::id();
  let ours = tree(&rows, me);
  let mine: Vec<&Proc> = rows.iter().filter(|p| ours.contains(&p.pid)).collect();
  let memory = mine.iter().map(|p| p.rss).sum::<u64>() * 1024;
  let cpu = mine.iter().map(|p| p.cpu).sum::<f32>();
  let mut processes: Vec<ProcessRow> = mine
    .iter()
    // Leaves out Kingu itself and the `ps` / `lsof` that are reading it right now.
    .filter(|p| p.pid != me && !(p.ppid == me && matches!(base_name(&p.command).as_str(), "ps" | "lsof")))
    .map(|p| ProcessRow { pid: p.pid, ppid: p.ppid, rss_bytes: p.rss * 1024, cpu: p.cpu, name: base_name(&p.command) })
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
pub fn ports() -> Result<Vec<Port>, String> {
  if !cfg!(unix) {
    return Err("port scan needs macOS or Linux".into());
  }
  let out = Command::new("lsof").args(["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]).output().map_err(|e| format!("lsof: {e}"))?;
  let ours = ps().map(|rows| tree(&rows, std::process::id())).unwrap_or_default();
  let mut seen = HashSet::new();
  let mut ports: Vec<Port> = parse_lsof(&String::from_utf8_lossy(&out.stdout))
    .into_iter()
    // IPv4 and IPv6 sockets of one server show up twice.
    .filter(|(pid, _, _, port)| seen.insert((*pid, *port)))
    .map(|(pid, name, address, port)| Port { port, address, pid, ours: ours.contains(&pid), name })
    .collect();
  ports.sort_by(|a, b| b.ours.cmp(&a.ours).then(a.port.cmp(&b.port)));
  Ok(ports)
}

/// SIGTERM to a process, but only one that runs under Kingu: the webview can never stop
/// another app's process.
pub fn kill(pid: u32) -> Result<(), String> {
  let rows = ps().ok_or("not supported here")?;
  let me = std::process::id();
  if pid == me || !tree(&rows, me).contains(&pid) {
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

/// A pull request or check page in the default browser: https only, so nothing local or
/// scriptable can be opened this way.
pub fn open_web_url(url: &str) -> Result<(), String> {
  let parsed = url::Url::parse(url).map_err(|e| e.to_string())?;
  if parsed.scheme() != "https" || parsed.host_str().is_none() {
    return Err("only https links open in the browser".into());
  }
  let program = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
  Command::new(program).arg(parsed.as_str()).spawn().map(|_| ()).map_err(|e| format!("{program}: {e}"))
}

#[cfg(test)]
mod tests {
  use super::*;

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
  fn opens_only_localhost() {
    assert!(open_local_url("https://example.com").is_err());
    assert!(open_local_url("file:///etc/passwd").is_err());
  }

  #[test]
  fn refuses_to_kill_foreign_processes() {
    assert!(kill(1).is_err());
    assert!(kill(std::process::id()).is_err());
  }
}
