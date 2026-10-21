//! Terminal shell integration (VS Code's `terminal.integrated.shellIntegration.enabled`): Kingu's
//! own scripts for zsh, bash, fish and pwsh mark each prompt, command line, run and exit code with
//! OSC 633 sequences, which the terminal page parses (src/lib/terminal/shellIntegration.ts).
//!
//! A new shell gets them by injection, like VS Code: zsh through a `ZDOTDIR` whose startup files
//! run the user's own, bash through `--init-file`, fish through `--init-command`, pwsh through
//! `-NoExit -Command`. Only a shell started with no arguments, or with the plain login and
//! interactive flags, is injected: anything else is the user's own launch and stays untouched.
//!
//! Also the shells' history files, for Run Recent Command's "shell history" section.

use std::path::{Path, PathBuf};

/// The scripts, written under `<app data>/shell-integration/` (`ensure_scripts`).
const FILES: &[(&str, &str)] = &[
  ("zsh/.zshenv", include_str!("../shell-integration/zsh/.zshenv")),
  ("zsh/.zprofile", include_str!("../shell-integration/zsh/.zprofile")),
  ("zsh/.zshrc", include_str!("../shell-integration/zsh/.zshrc")),
  ("zsh/.zlogin", include_str!("../shell-integration/zsh/.zlogin")),
  ("zsh/kingu.zsh", include_str!("../shell-integration/zsh/kingu.zsh")),
  ("kingu.bash", include_str!("../shell-integration/kingu.bash")),
  ("kingu.fish", include_str!("../shell-integration/kingu.fish")),
  ("kingu.ps1", include_str!("../shell-integration/kingu.ps1")),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellKind {
  Zsh,
  Bash,
  Fish,
  Pwsh,
}

impl ShellKind {
  /// The shell a program path (or name) runs: `/bin/zsh`, `-zsh` (a login shell's argv[0]), `pwsh-preview`.
  pub fn of(program: &str) -> Option<ShellKind> {
    let name = Path::new(program.trim()).file_name()?.to_str()?.trim_start_matches('-');
    let name = name.strip_suffix(".exe").unwrap_or(name);
    match name {
      "zsh" => Some(ShellKind::Zsh),
      "bash" => Some(ShellKind::Bash),
      "fish" => Some(ShellKind::Fish),
      "pwsh" | "pwsh-preview" => Some(ShellKind::Pwsh),
      _ => None,
    }
  }
}

/// How a shell is started with the integration: its arguments and the variables to add.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Injection {
  pub args: Vec<String>,
  pub env: Vec<(String, String)>,
}

/// Writes the scripts under `root/shell-integration` (only the ones whose text changed) and
/// returns that folder.
pub fn ensure_scripts(root: &Path) -> std::io::Result<PathBuf> {
  let dir = root.join("shell-integration");
  for (rel, text) in FILES {
    let path = dir.join(rel);
    if std::fs::read(&path).is_ok_and(|now| now == text.as_bytes()) {
      continue;
    }
    if let Some(parent) = path.parent() {
      std::fs::create_dir_all(parent)?;
    }
    // Write then rename, so a shell starting meanwhile never reads half a file.
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, &path)?;
  }
  Ok(dir)
}

/// Whether `args` are ones injection keeps the meaning of: none, or only login/interactive flags
/// (VS Code injects in the same cases). `None` is the default login shell (`-l`).
fn plain_args(kind: ShellKind, args: Option<&[String]>) -> Option<bool> {
  let Some(args) = args else { return Some(true) };
  let mut login = false;
  for a in args {
    let a = a.trim();
    match kind {
      ShellKind::Pwsh => match a.to_ascii_lowercase().as_str() {
        "-l" | "-login" => login = true,
        "-nologo" | "-nol" => {}
        _ => return None,
      },
      _ => match a {
        "-l" | "--login" => login = true,
        "-i" | "--interactive" | "-il" | "-li" => login |= a.contains('l'),
        _ => return None,
      },
    }
  }
  Some(login)
}

/// A fish string literal holding `s` (single quotes; `\` and `'` escaped).
fn fish_quote(s: &str) -> String {
  format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
}

/// A PowerShell string literal holding `s` (single quotes doubled).
fn pwsh_quote(s: &str) -> String {
  format!("'{}'", s.replace('\'', "''"))
}

/// How to start `program` with `args` (`None`: Kingu's default login shell) so the integration
/// in `dir` (`ensure_scripts`) loads. `user_zdotdir`: the ZDOTDIR the shell would have had (the
/// terminal's env, else Kingu's), else `home`. `None` when the shell or its arguments are not
/// ones Kingu injects into.
pub fn injection(program: &str, args: Option<&[String]>, dir: &Path, user_zdotdir: Option<&str>, home: Option<&str>) -> Option<Injection> {
  let kind = ShellKind::of(program)?;
  let login = plain_args(kind, args)?;
  let script = |rel: &str| dir.join(rel).to_string_lossy().into_owned();
  let mut env = vec![("KINGU_SHELL_INTEGRATION".to_string(), "1".to_string())];
  let original = || args.map(<[String]>::to_vec).unwrap_or_else(|| vec!["-l".into()]);
  let args = match kind {
    ShellKind::Zsh => {
      let user = user_zdotdir.filter(|d| !d.is_empty()).or(home.filter(|h| !h.is_empty()))?;
      env.push(("ZDOTDIR".into(), script("zsh")));
      env.push(("KINGU_USER_ZDOTDIR".into(), user.into()));
      original()
    }
    ShellKind::Bash => {
      // bash ignores --init-file in a login shell: the script reads the login files itself.
      env.push(("KINGU_SHELL_INJECTED".into(), "1".into()));
      if login {
        env.push(("KINGU_SHELL_LOGIN".into(), "1".into()));
      }
      vec!["--init-file".into(), script("kingu.bash")]
    }
    ShellKind::Fish => {
      let mut a: Vec<String> = if login { vec!["-l".into()] } else { vec![] };
      a.extend(["--init-command".into(), format!("source {}", fish_quote(&script("kingu.fish")))]);
      a
    }
    ShellKind::Pwsh => {
      let mut a: Vec<String> = if login { vec!["-l".into()] } else { vec![] };
      a.extend(["-NoLogo".into(), "-NoExit".into(), "-Command".into(), format!(". {}", pwsh_quote(&script("kingu.ps1")))]);
      a
    }
  };
  Some(Injection { args, env })
}

/// The most history Run Recent Command reads from a shell's history file.
const MAX_HISTORY_BYTES: u64 = 1 << 20;

/// The history file of `kind` for the user at `home`: `$HISTFILE` style defaults (zsh in
/// `zdotdir`, fish and pwsh under the XDG data folder).
pub fn history_file(kind: ShellKind, home: &Path, zdotdir: Option<&Path>, xdg_data: Option<&Path>) -> PathBuf {
  let data = xdg_data.filter(|d| d.is_absolute()).map(Path::to_path_buf).unwrap_or_else(|| home.join(".local/share"));
  match kind {
    ShellKind::Zsh => zdotdir.unwrap_or(home).join(".zsh_history"),
    ShellKind::Bash => home.join(".bash_history"),
    ShellKind::Fish => data.join("fish/fish_history"),
    ShellKind::Pwsh => data.join("powershell/PSReadLine/ConsoleHost_history.txt"),
  }
}

/// zsh stores bytes 0x83..=0x9f and NUL "metafied": 0x83 then the byte xor 32.
fn unmetafy(bytes: &[u8]) -> Vec<u8> {
  let mut out = Vec::with_capacity(bytes.len());
  let mut it = bytes.iter();
  while let Some(&b) = it.next() {
    if b == 0x83 {
      if let Some(&n) = it.next() {
        out.push(n ^ 32);
      }
    } else {
      out.push(b);
    }
  }
  out
}

/// The commands of a history file's text, oldest first (multi-line commands joined with `\n`).
pub fn parse_history(kind: ShellKind, bytes: &[u8]) -> Vec<String> {
  let mut out: Vec<String> = Vec::new();
  match kind {
    ShellKind::Zsh => {
      let text = String::from_utf8_lossy(&unmetafy(bytes)).into_owned();
      let mut current: Option<String> = None;
      for line in text.lines() {
        let line = match current.take() {
          Some(mut prev) => {
            prev.push('\n');
            prev.push_str(line);
            prev
          }
          // Extended history: `: <start>:<duration>;<command>`.
          None => match line.strip_prefix(": ").and_then(|l| l.split_once(';')) {
            Some((stamp, cmd)) if stamp.split(':').all(|p| p.chars().all(|c| c.is_ascii_digit())) => cmd.to_string(),
            _ => line.to_string(),
          },
        };
        // A line ending in `\` continues on the next one.
        if let Some(stripped) = line.strip_suffix('\\') {
          current = Some(stripped.to_string());
        } else {
          out.push(line);
        }
      }
      out.extend(current);
    }
    ShellKind::Bash => {
      let text = String::from_utf8_lossy(bytes);
      // HISTTIMEFORMAT writes `#<seconds>` before each command.
      out.extend(text.lines().filter(|l| !(l.starts_with('#') && l.len() > 1 && l[1..].chars().all(|c| c.is_ascii_digit()))).map(str::to_string));
    }
    ShellKind::Fish => {
      let text = String::from_utf8_lossy(bytes);
      for line in text.lines() {
        if let Some(cmd) = line.strip_prefix("- cmd: ") {
          // fish escapes `\` and newlines in its YAML-like file.
          let mut s = String::new();
          let mut chars = cmd.chars();
          while let Some(c) = chars.next() {
            if c == '\\' {
              match chars.next() {
                Some('n') => s.push('\n'),
                Some('\\') => s.push('\\'),
                Some(o) => {
                  s.push('\\');
                  s.push(o);
                }
                None => s.push('\\'),
              }
            } else {
              s.push(c);
            }
          }
          out.push(s);
        }
      }
    }
    ShellKind::Pwsh => {
      let text = String::from_utf8_lossy(bytes);
      let mut current: Option<String> = None;
      for line in text.lines() {
        let line = match current.take() {
          Some(mut prev) => {
            prev.push('\n');
            prev.push_str(line);
            prev
          }
          None => line.to_string(),
        };
        // PSReadLine ends a line that continues with a backtick.
        if let Some(stripped) = line.strip_suffix('`') {
          current = Some(stripped.to_string());
        } else {
          out.push(line);
        }
      }
      out.extend(current);
    }
  }
  out.retain(|c| !c.trim().is_empty());
  out
}

/// The last `limit` distinct commands of `commands`, oldest first (a repeat counts as its latest use).
pub fn recent_unique(commands: Vec<String>, limit: usize) -> Vec<String> {
  let mut seen = std::collections::HashSet::new();
  let mut out: Vec<String> = commands.into_iter().rev().filter(|c| seen.insert(c.clone())).take(limit).collect();
  out.reverse();
  out
}

/// The tail of `path` (at most `MAX_HISTORY_BYTES`), starting at a line break.
fn read_tail(path: &Path) -> std::io::Result<Vec<u8>> {
  use std::io::{Read, Seek, SeekFrom};
  let mut f = std::fs::File::open(path)?;
  let len = f.metadata()?.len();
  if len > MAX_HISTORY_BYTES {
    f.seek(SeekFrom::Start(len - MAX_HISTORY_BYTES))?;
  }
  let mut buf = Vec::new();
  f.read_to_end(&mut buf)?;
  if len > MAX_HISTORY_BYTES
    && let Some(i) = buf.iter().position(|&b| b == b'\n')
  {
    buf.drain(..=i);
  }
  Ok(buf)
}

/// Run Recent Command's shell history section: the last commands of the history file of the
/// shell `shell` (a program path or name; empty: the login shell), oldest first; empty when it has none.
#[tauri::command(async)]
pub fn terminal_shell_history(shell: String, limit: Option<usize>) -> Result<Vec<String>, String> {
  let shell = if shell.trim().is_empty() { std::env::var("SHELL").unwrap_or_default() } else { shell };
  let Some(kind) = ShellKind::of(&shell) else { return Ok(vec![]) };
  let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else { return Ok(vec![]) };
  let zdotdir = std::env::var_os("ZDOTDIR").map(PathBuf::from).filter(|d| d.is_absolute());
  let xdg = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from);
  let path = history_file(kind, &home, zdotdir.as_deref(), xdg.as_deref());
  let bytes = match read_tail(&path) {
    Ok(b) => b,
    Err(_) => return Ok(vec![]),
  };
  Ok(recent_unique(parse_history(kind, &bytes), limit.unwrap_or(500).min(5000)))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
  }

  #[test]
  fn shell_kinds() {
    assert_eq!(ShellKind::of("/bin/zsh"), Some(ShellKind::Zsh));
    assert_eq!(ShellKind::of("-zsh"), Some(ShellKind::Zsh));
    assert_eq!(ShellKind::of("/opt/homebrew/bin/bash"), Some(ShellKind::Bash));
    assert_eq!(ShellKind::of("fish"), Some(ShellKind::Fish));
    assert_eq!(ShellKind::of("/usr/local/bin/pwsh"), Some(ShellKind::Pwsh));
    assert_eq!(ShellKind::of("pwsh.exe"), Some(ShellKind::Pwsh));
    assert_eq!(ShellKind::of("/usr/bin/tmux"), None);
    assert_eq!(ShellKind::of("nu"), None);
    assert_eq!(ShellKind::of(""), None);
  }

  #[test]
  fn zsh_gets_a_zdotdir_and_keeps_its_args() {
    let dir = Path::new("/data/shell-integration");
    let i = injection("/bin/zsh", None, dir, None, Some("/Users/u")).unwrap();
    assert_eq!(i.args, s(&["-l"]));
    assert!(i.env.contains(&("ZDOTDIR".into(), "/data/shell-integration/zsh".into())));
    assert!(i.env.contains(&("KINGU_USER_ZDOTDIR".into(), "/Users/u".into())));
    assert!(i.env.contains(&("KINGU_SHELL_INTEGRATION".into(), "1".into())));
    let i = injection("zsh", Some(&s(&["-i"])), dir, Some("/Users/u/.config/zsh"), Some("/Users/u")).unwrap();
    assert_eq!(i.args, s(&["-i"]));
    assert!(i.env.contains(&("KINGU_USER_ZDOTDIR".into(), "/Users/u/.config/zsh".into())));
    // Nowhere to find the user's files: no injection rather than a shell without them.
    assert_eq!(injection("zsh", None, dir, None, None), None);
  }

  #[test]
  fn bash_reads_its_login_files_from_the_init_file() {
    let dir = Path::new("/d");
    let login = injection("/bin/bash", Some(&s(&["-l"])), dir, None, Some("/h")).unwrap();
    assert_eq!(login.args, s(&["--init-file", "/d/kingu.bash"]));
    assert!(login.env.contains(&("KINGU_SHELL_LOGIN".into(), "1".into())));
    assert!(login.env.contains(&("KINGU_SHELL_INJECTED".into(), "1".into())));
    let plain = injection("bash", Some(&[]), dir, None, Some("/h")).unwrap();
    assert!(!plain.env.iter().any(|(k, _)| k == "KINGU_SHELL_LOGIN"));
    assert!(injection("bash", None, dir, None, None).unwrap().env.iter().any(|(k, _)| k == "KINGU_SHELL_LOGIN"));
  }

  #[test]
  fn fish_and_pwsh_source_the_script_quoted() {
    let dir = Path::new("/My Data/it's");
    let fish = injection("/opt/homebrew/bin/fish", Some(&s(&["--login"])), dir, None, None).unwrap();
    assert_eq!(fish.args, s(&["-l", "--init-command", "source '/My Data/it\\'s/kingu.fish'"]));
    let pwsh = injection("pwsh", Some(&s(&["-NoLogo"])), dir, None, None).unwrap();
    assert_eq!(pwsh.args, s(&["-NoLogo", "-NoExit", "-Command", ". '/My Data/it''s/kingu.ps1'"]));
    let pwsh = injection("pwsh", None, dir, None, None).unwrap();
    assert_eq!(pwsh.args[0], "-l");
  }

  #[test]
  fn other_args_or_shells_are_left_alone() {
    let dir = Path::new("/d");
    assert_eq!(injection("zsh", Some(&s(&["-c", "echo hi"])), dir, None, Some("/h")), None);
    assert_eq!(injection("bash", Some(&s(&["--norc"])), dir, None, Some("/h")), None);
    assert_eq!(injection("fish", Some(&s(&["--private"])), dir, None, None), None);
    assert_eq!(injection("pwsh", Some(&s(&["-File", "x.ps1"])), dir, None, None), None);
    assert_eq!(injection("/usr/bin/tmux", None, dir, None, Some("/h")), None);
    assert_eq!(injection("/bin/sh", None, dir, None, Some("/h")), None);
  }

  #[test]
  fn scripts_are_written_once_and_rewritten_when_changed() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = ensure_scripts(tmp.path()).unwrap();
    for (rel, text) in FILES {
      assert_eq!(std::fs::read_to_string(dir.join(rel)).unwrap(), *text);
    }
    std::fs::write(dir.join("kingu.bash"), "stale").unwrap();
    ensure_scripts(tmp.path()).unwrap();
    assert_eq!(std::fs::read_to_string(dir.join("kingu.bash")).unwrap(), FILES.iter().find(|(r, _)| *r == "kingu.bash").unwrap().1);
    // No temp files are left behind.
    let names: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    assert!(names.iter().all(|n| !n.contains(".tmp")), "{names:?}");
  }

  #[test]
  fn every_script_emits_the_sequences() {
    for (rel, text) in FILES.iter().filter(|(r, _)| r.contains("kingu.")) {
      for seq in ["633;A", "633;B", "633;C", "633;D", "633;E;", "633;P;Cwd="] {
        assert!(text.contains(seq), "{rel} lacks {seq}");
      }
    }
  }

  #[test]
  fn parses_zsh_history() {
    let text = b": 1700000000:0;git status\n: 1700000001:3;echo one\\\ntwo\nls -la\n\n";
    assert_eq!(parse_history(ShellKind::Zsh, text), s(&["git status", "echo one\ntwo", "ls -la"]));
    // 'ค' is e0 b8 84; zsh stores its 0x84 metafied as 0x83 0xa4.
    let meta = [b'e', b'c', b'h', b'o', b' ', 0xe0, 0xb8, 0x83, 0xa4];
    assert_eq!(parse_history(ShellKind::Zsh, &meta), s(&["echo ค"]));
  }

  #[test]
  fn parses_bash_fish_and_pwsh_history() {
    assert_eq!(parse_history(ShellKind::Bash, b"#1700000000\nmake\n#1700000001\nnpm test\n#notatime\n"), s(&["make", "npm test", "#notatime"]));
    let fish = b"- cmd: echo a\\nb\n  when: 1700000000\n- cmd: cd C:\\\\x\n  when: 1\n  paths:\n    - x\n";
    assert_eq!(parse_history(ShellKind::Fish, fish), s(&["echo a\nb", "cd C:\\x"]));
    assert_eq!(parse_history(ShellKind::Pwsh, b"Get-ChildItem\nif ($a) {`\n  1 }\n"), s(&["Get-ChildItem", "if ($a) {\n  1 }"]));
  }

  #[test]
  fn recent_unique_keeps_the_latest_use() {
    assert_eq!(recent_unique(s(&["a", "b", "a", "c", "b"]), 10), s(&["a", "c", "b"]));
    assert_eq!(recent_unique(s(&["a", "b", "c"]), 2), s(&["b", "c"]));
  }

  #[test]
  fn history_files_per_shell() {
    let home = Path::new("/h");
    assert_eq!(history_file(ShellKind::Zsh, home, None, None), PathBuf::from("/h/.zsh_history"));
    assert_eq!(history_file(ShellKind::Zsh, home, Some(Path::new("/h/.config/zsh")), None), PathBuf::from("/h/.config/zsh/.zsh_history"));
    assert_eq!(history_file(ShellKind::Bash, home, None, None), PathBuf::from("/h/.bash_history"));
    assert_eq!(history_file(ShellKind::Fish, home, None, Some(Path::new("/x"))), PathBuf::from("/x/fish/fish_history"));
    assert_eq!(history_file(ShellKind::Fish, home, None, Some(Path::new("rel"))), PathBuf::from("/h/.local/share/fish/fish_history"));
    assert_eq!(history_file(ShellKind::Pwsh, home, None, None), PathBuf::from("/h/.local/share/powershell/PSReadLine/ConsoleHost_history.txt"));
  }

  #[test]
  fn reads_only_the_tail_of_a_huge_history() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("h");
    let mut text = String::new();
    while (text.len() as u64) < MAX_HISTORY_BYTES + 100 {
      text.push_str("some old command\n");
    }
    text.push_str("the last one\n");
    std::fs::write(&path, &text).unwrap();
    let tail = read_tail(&path).unwrap();
    assert!(tail.len() as u64 <= MAX_HISTORY_BYTES);
    assert!(tail.starts_with(b"some old command\n"));
    assert_eq!(parse_history(ShellKind::Bash, &tail).last().map(String::as_str), Some("the last one"));
  }
}
