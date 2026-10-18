//! Who may talk to the daemon: only processes of the same user. The socket lives in a 0700
//! directory and is itself 0600; on top of that each side checks the other's uid.

use std::fs;
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::net::UnixStream;
use std::path::Path;

pub fn own_uid() -> u32 {
  unsafe { libc::getuid() }
}

/// The uid of the process at the other end of a connected Unix socket.
pub fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
  let fd = stream.as_raw_fd();
  #[cfg(any(target_os = "linux", target_os = "android"))]
  {
    let mut cred = libc::ucred { pid: 0, uid: 0, gid: 0 };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let r = unsafe { libc::getsockopt(fd, libc::SOL_SOCKET, libc::SO_PEERCRED, (&raw mut cred).cast(), &mut len) };
    if r != 0 {
      return Err(io::Error::last_os_error());
    }
    Ok(cred.uid)
  }
  #[cfg(not(any(target_os = "linux", target_os = "android")))]
  {
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    if unsafe { libc::getpeereid(fd, &mut uid, &mut gid) } != 0 {
      return Err(io::Error::last_os_error());
    }
    Ok(uid)
  }
}

/// Accepts only a peer running as `own`.
pub fn check_peer(peer: u32, own: u32) -> Result<(), String> {
  if peer == own { Ok(()) } else { Err(format!("ปฏิเสธการเชื่อมต่อจาก uid {peer} (daemon เป็นของ uid {own})")) }
}

pub fn check_stream(stream: &UnixStream) -> Result<(), String> {
  let uid = peer_uid(stream).map_err(|e| format!("อ่าน uid ของอีกฝั่งไม่ได้: {e}"))?;
  check_peer(uid, own_uid())
}

/// Creates `dir` (0700) or tightens an existing one; refuses a directory another user owns.
pub fn prepare_dir(dir: &Path) -> Result<(), String> {
  fs::create_dir_all(dir).map_err(|e| format!("สร้าง {} ไม่ได้: {e}", dir.display()))?;
  let meta = fs::symlink_metadata(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
  if !meta.is_dir() {
    return Err(format!("{} ไม่ใช่โฟลเดอร์", dir.display()));
  }
  if meta.uid() != own_uid() {
    return Err(format!("{} เป็นของ uid {} ไม่ใช่ของผู้ใช้นี้", dir.display(), meta.uid()));
  }
  if meta.mode() & 0o777 != 0o700 {
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(|e| format!("{}: {e}", dir.display()))?;
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use std::os::unix::fs::PermissionsExt;
  use std::os::unix::net::UnixStream;

  use super::{check_peer, own_uid, peer_uid, prepare_dir};

  #[test]
  fn rejects_another_uid() {
    assert!(check_peer(501, 501).is_ok());
    let err = check_peer(0, 501).unwrap_err();
    assert!(err.contains("uid 0"), "{err}");
    assert!(check_peer(502, 501).is_err());
  }

  #[test]
  fn reads_the_peer_uid_of_a_real_socket() {
    let (a, b) = UnixStream::pair().unwrap();
    assert_eq!(peer_uid(&a).unwrap(), own_uid());
    assert_eq!(peer_uid(&b).unwrap(), own_uid());
    assert!(super::check_stream(&a).is_ok());
  }

  #[test]
  fn prepares_a_private_directory() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("ptyd");
    prepare_dir(&dir).unwrap();
    assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    prepare_dir(&dir).unwrap();
    assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
    std::fs::write(tmp.path().join("file"), "").unwrap();
    assert!(prepare_dir(&tmp.path().join("file")).is_err());
  }
}
