//! Which windows open at startup (VS Code's windowsMainService on the initial startup): the last
//! session's per `window.restoreWindows`, the folders and files Kingu was launched with (`kingu
//! open <path>` when it was not running, or a path argument), and every empty window with
//! backups (hot exit), which always comes back. Pure, so `cargo test` covers it.
//!
//! A launch with paths opens only those, except with `preserve`: then the last session's windows
//! come back too, a launched folder that one of them has comes to the front instead of opening
//! again, and launched files open in one of them next to its restored editors.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::workspace::{self, Folder, WindowSession};

/// What Kingu was launched with: folders, a `.code-workspace` file and files, as absolute paths.
#[derive(Debug, Default, PartialEq)]
pub struct Launch {
  pub folders: Vec<PathBuf>,
  pub workspace: Option<PathBuf>,
  pub files: Vec<PathBuf>,
}

impl Launch {
  pub fn is_empty(&self) -> bool {
    self.folders.is_empty() && self.workspace.is_none() && self.files.is_empty()
  }
}

/// The launch arguments (after the program): existing paths, relative ones against `cwd`;
/// flags (`-psn_…` from an old Finder, `--…`) and paths that do not exist are left out.
/// `fstat`'s error for a handle that isn't open.
#[cfg(unix)]
const EBADF: i32 = 9;

/// The standard handles and how each is reopened: input read-only (`"r"`), output and errors
/// write-only (`"w"`).
#[cfg(unix)]
const STDIO_REOPEN: [(i32, i32); 3] = [(0, libc::O_RDONLY), (1, libc::O_WRONLY), (2, libc::O_WRONLY)];

/// Orca's launcher rule (`Contents/MacOS/Orca`, `sub_1000004c0` at 0x1000004c0, run first by
/// `entry` at 0x100000460): an app started from Finder, Play or another program may get its
/// standard input, output or error closed. For each of handles 0, 1 and 2 whose `fstat` fails
/// with EBADF (9), reopen it on `/dev/null` (mode `r` for 0, `w` for 1 and 2), so the next file
/// the app opens can't land on one of them and a log or `println!` can't fail or write into it.
/// Other `fstat` errors leave the handle alone, as Orca does.
#[cfg(unix)]
pub fn reopen_closed_stdio() {
  for (fd, flags) in STDIO_REOPEN {
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut st) } == 0 {
      continue;
    }
    if std::io::Error::last_os_error().raw_os_error() != Some(EBADF) {
      continue;
    }
    let null = unsafe { libc::open(c"/dev/null".as_ptr(), flags) };
    // The lowest free handle is the closed one, so `open` usually returns `fd` itself.
    if null >= 0 && null != fd {
      unsafe {
        libc::dup2(null, fd);
        libc::close(null);
      }
    }
  }
}

#[cfg(not(unix))]
pub fn reopen_closed_stdio() {}

pub fn launch_args(args: impl IntoIterator<Item = OsString>, cwd: &Path) -> Launch {
  let mut out = Launch::default();
  let mut args = args.into_iter();
  while let Some(arg) = args.next() {
    // `--screenshot <file>` (screenshot.rs): its value is an output file, not one to open.
    if arg == "--screenshot" {
      args.next();
      continue;
    }
    if arg.to_string_lossy().starts_with('-') {
      continue;
    }
    let p = PathBuf::from(&arg);
    let Ok(path) = (if p.is_absolute() { p } else { cwd.join(p) }).canonicalize() else {
      log::warn!("launch: {} does not exist", arg.to_string_lossy());
      continue;
    };
    if path.is_dir() {
      if !out.folders.contains(&path) {
        out.folders.push(path);
      }
    } else if path.extension().is_some_and(|e| e == "code-workspace") {
      out.workspace.get_or_insert(path);
    } else if !out.files.contains(&path) {
      out.files.push(path);
    }
  }
  out
}

/// A window to open and the files it opens once its page is up.
#[derive(Debug, Default, PartialEq)]
pub struct Opening {
  pub session: WindowSession,
  pub files: Vec<PathBuf>,
}

/// The windows to open, in order: the last one is the main window, in front. `last`: the last
/// session's windows (the last active one last); `with_backups`: empty windows with backups.
pub fn plan(setting: Option<&str>, last: &[WindowSession], launch: &Launch, with_backups: &[WindowSession]) -> Vec<Opening> {
  let preserve = setting == Some("preserve");
  let restored = if launch.is_empty() || preserve { workspace::windows_to_restore(setting, last) } else { Vec::new() };
  let mut out: Vec<Opening> = restored.into_iter().map(|session| Opening { session, files: Vec::new() }).collect();
  // Empty windows with backups always come back (behind the others).
  for s in with_backups.iter().rev() {
    if !out.iter().any(|o| o.session.folders.is_empty() && o.session.empty == s.empty) {
      out.insert(0, Opening { session: s.clone(), files: Vec::new() });
    }
  }
  // A launched folder or workspace a restored window has comes to the front, else opens anew.
  let mut front = Vec::new();
  let wanted = launch.folders.iter().map(|f| (Some(f), None)).chain(launch.workspace.iter().map(|w| (None, Some(w))));
  for (folder, file) in wanted {
    let same = |s: &WindowSession| match (folder, file) {
      (Some(f), _) => s.file.is_none() && s.untitled.is_none() && s.folders.len() == 1 && s.folders[0].path == *f,
      (_, Some(w)) => s.file.as_deref() == Some(w.as_path()),
      _ => false,
    };
    let opening = match out.iter().position(|o| same(&o.session)) {
      Some(i) => out.remove(i),
      None => match folder {
        Some(f) => Opening { session: WindowSession { folders: vec![Folder::new(f.clone())], ..Default::default() }, files: Vec::new() },
        // The page opens the workspace file (its folders and settings) in a new empty window.
        None => Opening { files: file.into_iter().cloned().collect(), ..Default::default() },
      },
    };
    front.push(opening);
  }
  let launched: Vec<usize> = (out.len()..out.len() + front.len()).collect();
  out.extend(front);
  // Launched files: the window whose folder has them, else the launched one, else the one the
  // other files went to, else (preserve) the last active window, else a new empty window.
  let mut file_window: Option<usize> = None;
  for file in &launch.files {
    let target = out
      .iter()
      .position(|o| o.session.folders.iter().any(|f| file.starts_with(&f.path)))
      .or(launched.last().copied())
      .or(file_window)
      .or(if preserve { out.len().checked_sub(1) } else { None });
    let i = target.unwrap_or_else(|| {
      out.push(Opening::default());
      out.len() - 1
    });
    file_window = Some(i);
    out[i].files.push(file.clone());
  }
  // The window that got the files comes to the front.
  if let Some(i) = file_window.filter(|_| launched.is_empty())
    && i + 1 != out.len()
  {
    let o = out.remove(i);
    out.push(o);
  }
  out
}

#[cfg(test)]
mod tests {
  use super::*;

  fn folder(p: &str) -> WindowSession {
    WindowSession { folders: vec![Folder::new(p.into())], ..Default::default() }
  }
  fn empty(id: &str) -> WindowSession {
    WindowSession { empty: Some(id.into()), ..Default::default() }
  }
  fn sessions(plan: &[Opening]) -> Vec<WindowSession> {
    plan.iter().map(|o| o.session.clone()).collect()
  }

  #[test]
  fn launch_arguments_are_existing_paths() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    std::fs::create_dir(root.join("app")).unwrap();
    std::fs::write(root.join("a.txt"), "").unwrap();
    std::fs::write(root.join("x.code-workspace"), "{}").unwrap();
    let args = ["app", "-psn_0_123", "--verbose", "a.txt", "missing", "x.code-workspace", "./app"].map(OsString::from);
    let l = launch_args(args, &root);
    assert_eq!(l, Launch { folders: vec![root.join("app")], workspace: Some(root.join("x.code-workspace")), files: vec![root.join("a.txt")] });
    assert!(launch_args(Vec::<OsString>::new(), &root).is_empty());
  }

  #[test]
  fn without_paths_the_setting_decides() {
    let last = [folder("/a"), empty("e1"), folder("/c")];
    assert_eq!(sessions(&plan(Some("all"), &last, &Launch::default(), &[])), last);
    assert_eq!(sessions(&plan(Some("preserve"), &last, &Launch::default(), &[])), last);
    assert_eq!(sessions(&plan(Some("one"), &last, &Launch::default(), &[])), [folder("/c")]);
    assert!(plan(Some("none"), &last, &Launch::default(), &[]).is_empty());
  }

  #[test]
  fn empty_windows_with_backups_always_come_back() {
    let last = [folder("/a"), empty("e1")];
    // Behind the restored ones, and never twice.
    assert_eq!(sessions(&plan(Some("one"), &last, &Launch::default(), &[empty("e1")])), [empty("e1")]);
    assert_eq!(sessions(&plan(Some("folders"), &last, &Launch::default(), &[empty("e1"), empty("e2")])), [empty("e1"), empty("e2"), folder("/a")]);
    assert_eq!(sessions(&plan(Some("none"), &last, &Launch::default(), &[empty("e2")])), [empty("e2")]);
    assert_eq!(sessions(&plan(Some("all"), &last, &Launch::default(), &[empty("e1")])), last);
  }

  #[test]
  fn a_launched_folder_opens_alone_unless_preserve() {
    let last = [folder("/a"), folder("/b")];
    let launch = Launch { folders: vec!["/n".into()], ..Default::default() };
    assert_eq!(sessions(&plan(Some("all"), &last, &launch, &[])), [folder("/n")]);
    assert_eq!(sessions(&plan(None, &last, &launch, &[])), [folder("/n")]);
    // preserve: everything comes back, the launched folder in front.
    assert_eq!(sessions(&plan(Some("preserve"), &last, &launch, &[])), [folder("/a"), folder("/b"), folder("/n")]);
    // A folder a restored window has: that window comes to the front instead of opening again.
    let again = Launch { folders: vec!["/a".into()], ..Default::default() };
    assert_eq!(sessions(&plan(Some("preserve"), &last, &again, &[])), [folder("/b"), folder("/a")]);
    // A workspace file is opened by the page of a new window (or the window that has it).
    let ws = Launch { workspace: Some("/w/x.code-workspace".into()), ..Default::default() };
    let p = plan(Some("all"), &last, &ws, &[]);
    assert_eq!((sessions(&p), p[0].files.clone()), (vec![WindowSession::default()], vec![PathBuf::from("/w/x.code-workspace")]));
    let had = WindowSession { file: Some("/w/x.code-workspace".into()), ..folder("/a") };
    let p = plan(Some("preserve"), &[had.clone(), folder("/b")], &ws, &[]);
    assert_eq!(sessions(&p), [folder("/b"), had]);
    assert!(p[1].files.is_empty());
  }

  #[test]
  fn launched_files_open_in_a_window_of_their_folder() {
    let last = [folder("/a"), folder("/b")];
    let files = Launch { files: vec!["/a/src/x.ts".into(), "/tmp/notes.txt".into()], ..Default::default() };
    // all: only a new empty window with the files.
    let p = plan(Some("all"), &last, &files, &[]);
    assert_eq!(p, [Opening { session: WindowSession::default(), files: files.files.clone() }]);
    // preserve: in the restored windows, which come to the front.
    let p = plan(Some("preserve"), &last, &files, &[]);
    assert_eq!(sessions(&p), [folder("/b"), folder("/a")]);
    assert_eq!(p[1].files, files.files);
    // With a launched folder, they open in its window.
    let both = Launch { folders: vec!["/n".into()], files: vec!["/n/a.ts".into(), "/elsewhere.txt".into()], ..Default::default() };
    let p = plan(Some("all"), &last, &both, &[]);
    assert_eq!(p, [Opening { session: folder("/n"), files: both.files.clone() }]);
  }
}
