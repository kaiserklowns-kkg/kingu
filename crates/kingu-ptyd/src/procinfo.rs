//! What a terminal is running: the PTY's foreground process group (`tcgetpgrp` on the master)
//! and a process's name and working directory, read from the OS without spawning `ps`.

use std::path::PathBuf;

/// The process a terminal runs in the foreground when it is not the shell itself.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Foreground {
  pub pid: u32,
  pub name: String,
  /// The command line, only when `name` is an interpreter (`node`, `python3`): an agent CLI that
  /// runs as one is known by its script, not its process name. Empty otherwise, and from older daemons.
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub args: Vec<String>,
}

/// At most this many arguments of this many bytes each are kept (the script is among the first).
const MAX_ARGS: usize = 12;
const MAX_ARG_LEN: usize = 512;

/// Process names whose command line says what really runs.
fn is_interpreter(name: &str) -> bool {
  let name = name.to_ascii_lowercase();
  let name = name.strip_suffix(".exe").unwrap_or(&name);
  name == "node" || name.strip_prefix("python").is_some_and(|v| v.bytes().all(|b| b.is_ascii_digit() || b == b'.'))
}

/// NUL-separated arguments (`/proc/<pid>/cmdline`, the argv area of `KERN_PROCARGS2`), bounded.
fn split_args(bytes: &[u8], count: usize) -> Vec<String> {
  bytes
    .split(|b| *b == 0)
    .take(count.min(MAX_ARGS))
    .map(|a| {
      let mut end = a.len().min(MAX_ARG_LEN);
      let text = String::from_utf8_lossy(&a[..end]).into_owned();
      // A cut inside a multi-byte character leaves a replacement character; drop it.
      end = text.trim_end_matches('\u{fffd}').len();
      text[..end].to_string()
    })
    .collect()
}

/// The command line of `pid` (its first arguments), empty when it cannot be read.
#[cfg(target_os = "macos")]
pub fn process_args(pid: u32) -> Vec<String> {
  let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as libc::c_int];
  let mut size: libc::size_t = 0;
  if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, std::ptr::null_mut(), &mut size, std::ptr::null_mut(), 0) } != 0 || size < 4 {
    return Vec::new();
  }
  let mut buf = vec![0u8; size];
  if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, buf.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0) } != 0 || size < 4 {
    return Vec::new();
  }
  buf.truncate(size);
  parse_procargs2(&buf)
}

/// `KERN_PROCARGS2`: argc, the executable path, NUL padding, then argc arguments (the environment
/// follows and is not read).
#[cfg(any(target_os = "macos", test))]
fn parse_procargs2(buf: &[u8]) -> Vec<String> {
  let Some(argc) = buf.get(..4).map(|b| i32::from_ne_bytes([b[0], b[1], b[2], b[3]])).and_then(|n| usize::try_from(n).ok()) else {
    return Vec::new();
  };
  let rest = &buf[4..];
  let Some(path_end) = rest.iter().position(|b| *b == 0) else { return Vec::new() };
  let Some(pad) = rest[path_end..].iter().position(|b| *b != 0) else { return Vec::new() };
  split_args(&rest[path_end + pad..], argc)
}

#[cfg(target_os = "linux")]
pub fn process_args(pid: u32) -> Vec<String> {
  use std::io::Read;
  let mut buf = Vec::new();
  let Ok(file) = std::fs::File::open(format!("/proc/{pid}/cmdline")) else { return Vec::new() };
  if file.take((MAX_ARGS * (MAX_ARG_LEN + 1)) as u64 * 4).read_to_end(&mut buf).is_err() {
    return Vec::new();
  }
  if buf.last() == Some(&0) {
    buf.pop();
  }
  split_args(&buf, usize::MAX)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn process_args(_pid: u32) -> Vec<String> {
  Vec::new()
}

/// The foreground job of a PTY whose shell is `shell`: `None` while the shell waits at its prompt
/// (the shell's own group is in front), or when the group cannot be read.
pub fn foreground(group: Option<i32>, shell: Option<u32>) -> Option<Foreground> {
  let pid = u32::try_from(group?).ok().filter(|p| *p > 0)?;
  if Some(pid) == shell {
    return None;
  }
  let name = process_name(pid).unwrap_or_default();
  let args = if is_interpreter(&name) { process_args(pid) } else { Vec::new() };
  Some(Foreground { pid, name, args })
}

/// The executable name of `pid` (`sleep`, `node`), `None` when it is gone.
#[cfg(target_os = "macos")]
pub fn process_name(pid: u32) -> Option<String> {
  let mut buf = [0u8; 256];
  let n = unsafe { libc::proc_name(pid as i32, buf.as_mut_ptr().cast(), buf.len() as u32) };
  (n > 0).then(|| String::from_utf8_lossy(&buf[..n as usize]).into_owned())
}

#[cfg(target_os = "linux")]
pub fn process_name(pid: u32) -> Option<String> {
  std::fs::read_to_string(format!("/proc/{pid}/comm")).ok().map(|s| s.trim_end().to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn process_name(_pid: u32) -> Option<String> {
  None
}

/// The current working directory of `pid` (a shell after `cd`), `None` when it cannot be read.
#[cfg(target_os = "macos")]
pub fn process_cwd(pid: u32) -> Option<PathBuf> {
  use std::ffi::CStr;
  use std::mem::{MaybeUninit, size_of};
  let mut info = MaybeUninit::<libc::proc_vnodepathinfo>::zeroed();
  let size = size_of::<libc::proc_vnodepathinfo>() as i32;
  let n = unsafe { libc::proc_pidinfo(pid as i32, libc::PROC_PIDVNODEPATHINFO, 0, info.as_mut_ptr().cast(), size) };
  if n != size {
    return None;
  }
  let info = unsafe { info.assume_init() };
  // `vip_path` is a MAXPATHLEN buffer split into rows; read it as one NUL-terminated string.
  let bytes: &[u8] = unsafe { std::slice::from_raw_parts(info.pvi_cdir.vip_path.as_ptr().cast(), 32 * 32) };
  let path = CStr::from_bytes_until_nul(bytes).ok()?.to_str().ok()?;
  (!path.is_empty()).then(|| PathBuf::from(path))
}

#[cfg(target_os = "linux")]
pub fn process_cwd(pid: u32) -> Option<PathBuf> {
  std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn process_cwd(_pid: u32) -> Option<PathBuf> {
  None
}

#[cfg(test)]
mod tests {
  use super::{foreground, is_interpreter, parse_procargs2, process_cwd, process_name, split_args};

  #[test]
  fn only_an_interpreter_has_its_command_line_read() {
    for name in ["node", "python", "python3", "python3.12", "Python", "node.exe"] {
      assert!(is_interpreter(name), "{name}");
    }
    for name in ["claude", "nodemon", "pythonista", "sleep", "zsh", ""] {
      assert!(!is_interpreter(name), "{name}");
    }
    // A plain job carries no arguments, and an older daemon's record (no field) reads as none.
    assert!(foreground(Some(43), Some(42)).unwrap().args.is_empty());
    let old: super::Foreground = serde_json::from_str(r#"{"pid":7,"name":"node"}"#).unwrap();
    assert!(old.args.is_empty());
    assert_eq!(serde_json::to_string(&super::Foreground { pid: 7, name: "sleep".into(), args: vec![] }).unwrap(), r#"{"pid":7,"name":"sleep"}"#);
  }

  #[test]
  fn arguments_are_read_from_the_argv_area_and_bounded() {
    let mut buf = 3i32.to_ne_bytes().to_vec();
    buf.extend_from_slice(b"/usr/local/bin/node\0\0\0\0node\0/opt/lib/node_modules/@google/gemini-cli/dist/index.js\0--yolo\0HOME=/Users/x\0");
    assert_eq!(parse_procargs2(&buf), ["node", "/opt/lib/node_modules/@google/gemini-cli/dist/index.js", "--yolo"]);
    assert!(parse_procargs2(b"\x01").is_empty());
    assert!(parse_procargs2(&1i32.to_ne_bytes()).is_empty());
    let many = vec![b"a".as_slice(); 40].join(&0u8);
    assert_eq!(split_args(&many, usize::MAX).len(), 12);
    let long = "é".repeat(600);
    let cut = split_args(long.as_bytes(), 1).remove(0);
    assert!(cut.len() <= 512 && cut.chars().all(|c| c == 'é'));
  }

  #[cfg(any(target_os = "macos", target_os = "linux"))]
  #[test]
  fn reads_the_command_line_of_a_child() {
    let mut child = std::process::Command::new("/bin/sleep").arg("30").spawn().unwrap();
    let args = super::process_args(child.id());
    child.kill().unwrap();
    child.wait().unwrap();
    assert_eq!(args, ["/bin/sleep", "30"]);
  }

  #[test]
  fn the_shell_in_front_is_no_foreground_job() {
    assert_eq!(foreground(Some(42), Some(42)), None);
    assert_eq!(foreground(None, Some(42)), None);
    assert_eq!(foreground(Some(0), Some(42)), None);
    assert_eq!(foreground(Some(43), Some(42)).map(|f| f.pid), Some(43));
  }

  #[cfg(any(target_os = "macos", target_os = "linux"))]
  #[test]
  fn reads_this_process() {
    let me = std::process::id();
    assert!(process_name(me).is_some_and(|n| !n.is_empty()));
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    assert_eq!(process_cwd(me).map(|p| p.canonicalize().unwrap()), Some(cwd));
  }
}
