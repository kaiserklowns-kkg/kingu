//! The IDE's tasks (VS Code tasks.json; the webview's src/lib/tasks/ resolves them).
//!
//! A task runs as its own process in a panel terminal, like VS Code's task terminals: `/bin/sh`
//! runs a fixed wrapper script that gets the task's argv as separate arguments (`"$@"`), so the
//! command is never typed into or re-parsed by a shell beyond what the task's own command line
//! asks for. The wrapper prints the echo line, reports the exit code with a private OSC 7337
//! sequence, prints VS Code's "terminated with exit code" and "press any key" lines, waits for a
//! key and reports the close.
//!
//! Automatic tasks (`runOptions.runOn: folderOpen`) come with the repository, so like repo
//! snaps and worktree scripts they only run once the user trusted exactly this tasks.json (the
//! snap trust store, by hash, per folder). Rust reads the file, so the hash is of what is on disk.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::i18n::msg::IdeTasksMsg;
use crate::snap::{TRUST_FILE, TrustData, set_script_trust, sha256_hex};
use crate::tr;
use crate::workspace::Workspace;

pub const TASKS_FILE: &str = ".vscode/tasks.json";
/// The trust store key (starts with `.`, so no snap id can take it).
const TRUST_KEY: &str = ".vscode-tasks";
const MAX_BYTES: u64 = 1024 * 1024;

/// What the webview asks a task terminal to run (commandLine.ts `TaskLaunch` plus its texts).
#[derive(Debug, Default, Clone, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TaskLaunch {
  /// The program and its arguments; with `default_shell`, the default shell's arguments.
  pub argv: Vec<String>,
  /// Put the user's shell (terminal.integrated.shell, else `$SHELL`) in front of `argv`.
  pub default_shell: bool,
  /// Absolute; the folder root when absent.
  pub cwd: Option<String>,
  pub env: BTreeMap<String, String>,
  /// Printed before the command (presentation.echo), already formatted.
  pub echo: String,
  /// A non-zero exit prints `failed_prefix` + code + `failed_suffix`.
  pub failed_prefix: String,
  pub failed_suffix: String,
  /// Printed after the command; the terminal then waits for a key. Empty: it ends right away.
  pub wait: String,
}

/// The wrapper `/bin/sh -c` runs: `$1`…`$4` are the texts, the rest is the task's argv.
pub const WRAPPER: &str = r#"e=$1; fp=$2; fs=$3; w=$4; shift 4
[ -n "$e" ] && printf '%s' "$e"
trap : INT
"$@"
c=$?
trap - INT
printf '\033]7337;exit;%d\007' "$c"
if [ "$c" -ne 0 ] && [ -n "$fp" ]; then printf '%s%d%s' "$fp" "$c" "$fs"; fi
if [ -n "$w" ]; then printf '%s' "$w"; stty -icanon -echo min 1 2>/dev/null; dd bs=1 count=1 >/dev/null 2>&1; fi
printf '\033]7337;close\007'
exit "$c""#;

/// The shell that runs the wrapper.
pub const POSIX_SHELL: &str = "/bin/sh";

/// The arguments for `/bin/sh` that run `launch`; `default_shell` is the user's shell.
pub fn wrapper_args(launch: &TaskLaunch, default_shell: &str) -> Result<Vec<String>, String> {
  let mut argv = launch.argv.clone();
  if launch.default_shell {
    argv.insert(0, default_shell.to_string());
  }
  if argv.is_empty() || argv[0].is_empty() {
    return Err(tr!(IdeTasksMsg::EmptyCommand));
  }
  let texts = [&launch.echo, &launch.failed_prefix, &launch.failed_suffix, &launch.wait];
  if argv.iter().chain(texts).any(|a| a.contains('\0')) || launch.env.iter().any(|(k, v)| k.contains('\0') || v.contains('\0')) {
    return Err(tr!(IdeTasksMsg::NulInCommand));
  }
  let mut out = vec!["-c".to_string(), WRAPPER.to_string(), "kingu-task".to_string()];
  out.extend(texts.into_iter().cloned());
  out.extend(argv);
  Ok(out)
}

/// The directory the task starts in: its `cwd` (absolute, existing) or `fallback`.
pub fn task_cwd(launch: &TaskLaunch, fallback: PathBuf) -> Result<PathBuf, String> {
  match launch.cwd.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
    None => Ok(fallback),
    Some(c) => {
      let p = Path::new(c);
      if p.is_absolute() && p.is_dir() { Ok(p.to_path_buf()) } else { Err(tr!(IdeTasksMsg::CwdNotFound, path = c)) }
    }
  }
}

/// The folder's tasks.json as Rust read it, its hash, and whether its automatic tasks are trusted.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct TasksFile {
  pub text: Option<String>,
  pub hash: Option<String>,
  pub trusted: bool,
}

pub fn read_tasks_file(root: &Path) -> Result<Option<String>, String> {
  let file = root.join(TASKS_FILE);
  let meta = match std::fs::metadata(&file) {
    Ok(m) => m,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(e) => return Err(format!("{TASKS_FILE}: {e}")),
  };
  if meta.len() > MAX_BYTES {
    return Err(tr!(IdeTasksMsg::TasksFileTooLarge, kb = MAX_BYTES / 1024));
  }
  // A symlink out of the folder is not the folder's tasks.json.
  crate::workspace::resolve_in(root, TASKS_FILE)?;
  std::fs::read_to_string(&file).map(Some).map_err(|e| format!("{TASKS_FILE}: {e}"))
}

pub fn status(root: &Path, trust: &TrustData) -> Result<TasksFile, String> {
  Ok(match read_tasks_file(root)? {
    None => TasksFile { text: None, hash: None, trusted: false },
    Some(text) => {
      let hash = sha256_hex(text.as_bytes());
      let trusted = trust.is_trusted(root, TRUST_KEY, &hash);
      TasksFile { text: Some(text), hash: Some(hash), trusted }
    }
  })
}

/// Trusts the tasks.json the user was shown (`expected` is its hash), or revokes the trust.
pub fn set_trust(config_dir: &Path, root: &Path, expected: Option<&str>) -> Result<(), String> {
  let Some(expected) = expected else {
    return set_script_trust(config_dir, root, TRUST_KEY, None);
  };
  let text = read_tasks_file(root)?.ok_or_else(|| tr!(IdeTasksMsg::NoTasksFile))?;
  if sha256_hex(text.as_bytes()) != expected {
    return Err(tr!(IdeTasksMsg::TasksFileChanged));
  }
  set_script_trust(config_dir, root, TRUST_KEY, Some(expected))
}

/// `.vscode/tasks.json` of the open folder, with its trust (no folder: no file).
#[tauri::command]
pub fn tasks_file(app: AppHandle, ws: Workspace) -> Result<TasksFile, String> {
  let Some(root) = ws.current() else {
    return Ok(TasksFile { text: None, hash: None, trusted: false });
  };
  status(&root, &TrustData::load(&crate::snap::config_dir(&app)?.join(TRUST_FILE)))
}

/// Allows (with the hash that was shown) or disallows the folder's automatic tasks.
#[tauri::command]
pub fn tasks_trust(app: AppHandle, ws: Workspace, hash: Option<String>) -> Result<(), String> {
  let root = ws.root()?;
  set_trust(&crate::snap::config_dir(&app)?, &root, hash.as_deref())?;
  log::info!("tasks.json automatic tasks: trusted = {} in {}", hash.is_some(), root.display());
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn launch(argv: &[&str]) -> TaskLaunch {
    TaskLaunch { argv: argv.iter().map(|s| s.to_string()).collect(), ..Default::default() }
  }

  /// Runs the wrapper as the terminal would (without a tty): output and exit status.
  #[cfg(unix)]
  fn run(l: &TaskLaunch, dir: &Path) -> (String, i32) {
    let out = std::process::Command::new(POSIX_SHELL).args(wrapper_args(l, "/bin/sh").unwrap()).current_dir(dir).stdin(std::process::Stdio::null()).output().unwrap();
    (String::from_utf8_lossy(&out.stdout).into_owned(), out.status.code().unwrap_or(-1))
  }

  #[test]
  fn argv_goes_through_as_separate_words() {
    let args = wrapper_args(&launch(&["cargo", "test"]), "/bin/zsh").unwrap();
    assert_eq!(&args[..3], &["-c".to_string(), WRAPPER.to_string(), "kingu-task".to_string()]);
    assert_eq!(&args[7..], &["cargo".to_string(), "test".to_string()]);
    let mut shell = launch(&["-l", "-c", "make all"]);
    shell.default_shell = true;
    assert_eq!(&wrapper_args(&shell, "/bin/zsh").unwrap()[7..], &["/bin/zsh", "-l", "-c", "make all"]);
    assert!(wrapper_args(&launch(&[]), "/bin/zsh").is_err());
    assert!(wrapper_args(&launch(&["a\0b"]), "/bin/zsh").is_err());
  }

  #[cfg(unix)]
  #[test]
  fn wrapper_reports_the_exit_code_and_never_reparses_arguments() {
    let tmp = tempfile::tempdir().unwrap();
    // A process task's argument with shell syntax stays one literal argument.
    let (out, code) = run(&launch(&["printf", "%s|", "$(touch pwned)", "a b;c"]), tmp.path());
    assert_eq!(code, 0);
    assert!(out.starts_with("$(touch pwned)|a b;c|"), "{out}");
    assert!(out.contains("\x1b]7337;exit;0\x07") && out.ends_with("\x1b]7337;close\x07"), "{out:?}");
    assert!(!tmp.path().join("pwned").exists());

    let mut failing = launch(&["sh", "-c", "exit 3"]);
    failing.echo = "ECHO ".into();
    failing.failed_prefix = "code: ".into();
    failing.failed_suffix = ".".into();
    let (out, code) = run(&failing, tmp.path());
    assert_eq!(code, 3);
    assert!(out.starts_with("ECHO "), "{out:?}");
    assert!(out.contains("\x1b]7337;exit;3\x07code: 3."), "{out:?}");

    let (out, code) = run(&launch(&["kingu-no-such-program-xyz"]), tmp.path());
    assert_eq!(code, 127);
    assert!(out.contains("\x1b]7337;exit;127\x07"));
  }

  #[test]
  fn cwd_must_be_an_existing_absolute_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let mut l = launch(&["x"]);
    assert_eq!(task_cwd(&l, tmp.path().to_path_buf()).unwrap(), tmp.path());
    l.cwd = Some(tmp.path().display().to_string());
    assert_eq!(task_cwd(&l, PathBuf::from("/")).unwrap(), tmp.path());
    l.cwd = Some("relative".into());
    assert!(task_cwd(&l, PathBuf::from("/")).is_err());
    l.cwd = Some(tmp.path().join("missing").display().to_string());
    assert!(task_cwd(&l, PathBuf::from("/")).is_err());
  }

  #[test]
  fn automatic_tasks_need_trust_in_exactly_this_file() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("repo");
    let config = tmp.path().join("config");
    std::fs::create_dir_all(root.join(".vscode")).unwrap();
    std::fs::create_dir_all(&config).unwrap();
    let root = root.canonicalize().unwrap();
    let load = || TrustData::load(&config.join(TRUST_FILE));
    assert_eq!(status(&root, &load()).unwrap(), TasksFile { text: None, hash: None, trusted: false });
    assert!(set_trust(&config, &root, Some("x")).is_err());

    std::fs::write(root.join(TASKS_FILE), "{\"tasks\": []}").unwrap();
    let s = status(&root, &load()).unwrap();
    assert!(!s.trusted);
    let hash = s.hash.clone().unwrap();
    assert!(set_trust(&config, &root, Some("not-the-hash")).unwrap_err().contains("changed"));
    set_trust(&config, &root, Some(&hash)).unwrap();
    assert!(status(&root, &load()).unwrap().trusted);

    // An edit after trusting needs trust again.
    std::fs::write(root.join(TASKS_FILE), "{\"tasks\": [{\"label\": \"x\"}]}").unwrap();
    assert!(!status(&root, &load()).unwrap().trusted);
    set_trust(&config, &root, None).unwrap();
    std::fs::write(root.join(TASKS_FILE), "{\"tasks\": []}").unwrap();
    assert!(!status(&root, &load()).unwrap().trusted);
  }
}
