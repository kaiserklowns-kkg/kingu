//! What a terminal is running: the PTY's foreground process group (`tcgetpgrp` on the master)
//! and a process's name and working directory, read from the OS without spawning `ps`.

use std::path::PathBuf;

/// The process a terminal runs in the foreground when it is not the shell itself.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Foreground {
  pub pid: u32,
  pub name: String,
}

/// The foreground job of a PTY whose shell is `shell`: `None` while the shell waits at its prompt
/// (the shell's own group is in front), or when the group cannot be read.
pub fn foreground(group: Option<i32>, shell: Option<u32>) -> Option<Foreground> {
  let pid = u32::try_from(group?).ok().filter(|p| *p > 0)?;
  if Some(pid) == shell {
    return None;
  }
  Some(Foreground { pid, name: process_name(pid).unwrap_or_default() })
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
  use super::{foreground, process_cwd, process_name};

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
