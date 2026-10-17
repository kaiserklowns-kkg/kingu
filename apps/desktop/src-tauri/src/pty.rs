//! PTY sessions for the integrated terminal: spawn a login shell, stream its output over a
//! Tauri channel, and accept input and resizes from the webview.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use tauri::State;
use tauri::ipc::Channel;

struct Session {
  writer: Box<dyn Write + Send>,
  master: Box<dyn MasterPty + Send>,
  child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
pub struct Ptys {
  next_id: AtomicU32,
  sessions: Mutex<HashMap<u32, Session>>,
}

fn size(cols: u16, rows: u16) -> PtySize {
  PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }
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

/// A login shell in `cwd`. With `run`, that command is typed into the shell once it starts (like
/// Orca starting an agent CLI in a worktree terminal): when it exits, the shell stays open.
pub fn spawn_shell(ptys: &Ptys, cwd: &Path, cols: u16, rows: u16, on_data: Channel<String>, run: Option<&[String]>) -> Result<u32, String> {
  let line = run.map(command_line).transpose()?;
  let pair = native_pty_system().openpty(size(cols, rows)).map_err(|e| e.to_string())?;
  let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
  let mut cmd = CommandBuilder::new(shell);
  cmd.arg("-l");
  cmd.cwd(cwd);
  cmd.env("TERM", "xterm-256color");
  cmd.env("COLORTERM", "truecolor");
  let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
  drop(pair.slave);

  let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
  let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
  if let Some(line) = line {
    // The tty buffers it until the shell reads its first line.
    writer.write_all(format!("{line}\r").as_bytes()).map_err(|e| e.to_string())?;
  }
  let id = ptys.next_id.fetch_add(1, Ordering::Relaxed) + 1;

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
          if on_data.send(text).is_err() {
            break;
          }
        }
      }
    }
  });

  ptys.sessions.lock().unwrap().insert(id, Session { writer, master: pair.master, child });
  Ok(id)
}

#[tauri::command]
pub fn pty_write(ptys: State<'_, Ptys>, id: u32, data: String) -> Result<(), String> {
  let mut sessions = ptys.sessions.lock().unwrap();
  let s = sessions.get_mut(&id).ok_or("no such terminal")?;
  s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(ptys: State<'_, Ptys>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
  let sessions = ptys.sessions.lock().unwrap();
  let s = sessions.get(&id).ok_or("no such terminal")?;
  s.master.resize(size(cols, rows)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(ptys: State<'_, Ptys>, id: u32) -> Result<(), String> {
  if let Some(mut s) = ptys.sessions.lock().unwrap().remove(&id) {
    s.child.kill().map_err(|e| e.to_string())?;
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::{command_line, shell_quote, utf8_prefix_len};

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
}
