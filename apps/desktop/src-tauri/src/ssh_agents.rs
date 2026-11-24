//! Which agent CLIs an SSH host has (Orca's `preflight.detectRemoteAgents`): before an agent is
//! started in a worktree on the host, Kingu asks the host which of its known program names are
//! there, so a missing one is said plainly ("isn't installed on this host") instead of a
//! `command not found` in a terminal.
//!
//! Orca source (3b2f28b30): `src/main/preflight/installed-agent-detection.ts` asks the host for
//! every catalog command at once; on a POSIX host that isn't this computer the probe is the script
//! of `src/main/ipc/preflight/preflight-wsl-agent-detection.ts`: the login PATH, then the
//! version-manager folders of `src/shared/shell/command-resolution/posix-version-manager-bin-dirs.ts`
//! appended behind it, then a walk of PATH per command
//! (`src/shared/shell/command-resolution/posix-command-path-lookup.ts`: an executable file that
//! isn't a folder; aliases, functions and builtins can't answer), each hit printed as
//! `<prefix><command>\t<absolute path>`, a timed-out or failed run counting as nothing found.
//! Kingu runs the same script over its shared ssh connection (ssh_hosts.rs `remote_within`).
//!
//! One Kingu addition, because its terminals start the CLI through the user's login shell
//! (ssh_projects.rs `terminal_script`) and that shell's PATH has no fallback folders: a hit is
//! marked `path` when the login PATH has it and `fallback` when only a fallback folder does, and
//! the caller starts a `fallback` one by its absolute path.

use std::time::Duration;

use serde::Serialize;
use tauri::State;

use crate::ssh_hosts::{self, Targets, sh_quote};
use crate::ssh_projects::SHELL_MODE;

/// Orca `WSL_AGENT_DETECTION_TIMEOUT_MS`.
pub const DETECT_TIMEOUT_MS: u64 = 10_000;
/// At most this many names per request (agent/cli.rs asks for as many locally).
const MAX_NAMES: usize = 64;
const PATH_MARK: &str = "__KINGU_LOGIN_PATH__";
const AGENT_MARK: &str = "__KINGU_AGENT_PATH__";

/// Orca `POSIX_VERSION_MANAGER_BIN_DIRS`, in its order (version managers before system folders).
pub const FALLBACK_BIN_DIRS: &[&str] = &[
  r#""$HOME/.local/bin""#,
  r#""$HOME/.local/share/pnpm""#,
  r#""$HOME/.yarn/bin""#,
  r#""$HOME/.bun/bin""#,
  r#""$HOME/.volta/bin""#,
  r#""$HOME/.asdf/shims""#,
  r#""$HOME/.fnm/aliases/default/bin""#,
  r#""$HOME/.local/share/mise/shims""#,
  r#""$HOME"/.nvm/versions/node/*/bin"#,
  r#""/usr/local/bin""#,
  r#""/snap/bin""#,
  r#""/home/linuxbrew/.linuxbrew/bin""#,
  r#""/nix/var/nix/profiles/default/bin""#,
  r#""$HOME/.nix-profile/bin""#,
  r#""$HOME/.opencode/bin""#,
  r#""$HOME/.vite-plus/bin""#,
  r#""$HOME/.grok/bin""#,
  // Kingu's own installs on the host (ssh_agent_install.rs), last: the user's own copy wins.
  r#""$HOME/.kingu/bin""#,
];

/// Orca `buildPosixCommandPathLookupScript` for the shell variable `cmd` (without its WSL-only
/// Windows-mount skipping): sets `resolved` to the first executable non-folder named `$cmd` in a
/// folder of `$PATH`, or to nothing.
const LOOKUP: &str = r#"_kg_command=${cmd-}
resolved=
case "$_kg_command" in
  */*)
    case "$_kg_command" in
      /*) _kg_candidate=$_kg_command ;;
      *) _kg_candidate=${PWD%/}/$_kg_command ;;
    esac
    if [ -x "$_kg_candidate" ] && [ ! -d "$_kg_candidate" ]; then
      resolved=$_kg_candidate
    fi
    ;;
  *)
    _kg_remaining=${PATH-}
    while :; do
      case "$_kg_remaining" in
        *:*)
          _kg_component=${_kg_remaining%%:*}
          _kg_remaining=${_kg_remaining#*:}
          _kg_has_more=1
          ;;
        *)
          _kg_component=$_kg_remaining
          _kg_has_more=
          ;;
      esac
      [ -n "$_kg_component" ] || _kg_component=.
      case "$_kg_component" in
        /*) _kg_candidate=$_kg_component/$_kg_command ;;
        *) _kg_candidate=${PWD%/}/$_kg_component/$_kg_command ;;
      esac
      if [ -x "$_kg_candidate" ] && [ ! -d "$_kg_candidate" ]; then
        resolved=$_kg_candidate
        break
      fi
      [ -n "$_kg_has_more" ] || break
    done
    ;;
esac"#;

/// A program name Kingu will ask a host about: letters, digits, `.`, `_`, `-`, not starting with
/// `.` or `-` (the same names agent/cli.rs accepts for this computer).
pub fn valid_name(name: &str) -> bool {
  !name.is_empty() && name.len() <= 64 && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)) && !name.starts_with(['.', '-'])
}

/// The names worth asking about: valid, once each, at most `MAX_NAMES`.
pub fn probe_names(names: &[String]) -> Vec<String> {
  let mut out: Vec<String> = Vec::new();
  for n in names {
    if valid_name(n) && !out.contains(n) && out.len() < MAX_NAMES {
      out.push(n.clone());
    }
  }
  out
}

/// The detection script for `names` (already [`probe_names`]): the login shell's PATH replaces
/// the bare one ssh gives a command (read through a marker line, so a shell's greeting can't be
/// taken for it; a login shell that prints none keeps the bare PATH), each name is looked up on
/// it, then the fallback folders are appended and the names are looked up again.
pub fn detect_script(names: &[String]) -> String {
  let list = names.iter().map(|n| sh_quote(n)).collect::<Vec<_>>().join(" ");
  let pass = |how: &str| format!("for cmd in {list}; do\n{LOOKUP}\nif [ -n \"$resolved\" ]; then\nprintf '{AGENT_MARK}%s\\t%s\\t{how}\\n' \"$cmd\" \"$resolved\"\nfi\ndone");
  let ask = sh_quote(&format!(r#"printf "\n{PATH_MARK}%s\n" "$PATH""#));
  [
    SHELL_MODE.to_string(),
    format!(r#"_kg_login=$("$s" $m {ask} 2>/dev/null </dev/null | sed -n 's/^{PATH_MARK}//p' | tail -n 1)"#),
    r#"if [ -n "$_kg_login" ]; then PATH=$_kg_login; fi"#.to_string(),
    pass("path"),
    format!("for _kg_dir in {}; do\n  if [ -d \"$_kg_dir\" ]; then PATH=\"$PATH:$_kg_dir\"; fi\ndone", FALLBACK_BIN_DIRS.join(" ")),
    pass("fallback"),
  ]
  .join("\n")
}

/// A CLI found on the host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Found {
  pub name: String,
  /// Its absolute path on the host.
  pub path: String,
  /// Only a fallback folder has it: the login shell wouldn't find it by name.
  pub fallback: bool,
}

/// Orca `parseWslDetectedCommands`: marker lines only, a name that was asked for, an absolute
/// POSIX path. The first line of a name wins (the login PATH pass comes first).
pub fn parse_detected(out: &str, names: &[String]) -> Vec<Found> {
  let mut found: Vec<Found> = Vec::new();
  for line in out.lines() {
    let Some(rest) = line.trim().strip_prefix(AGENT_MARK) else { continue };
    let mut cols = rest.split('\t');
    let (Some(name), Some(path)) = (cols.next(), cols.next()) else { continue };
    if name.is_empty() || !path.starts_with('/') || !names.iter().any(|n| n == name) || found.iter().any(|f| f.name == name) {
      continue;
    }
    found.push(Found { name: name.to_string(), path: path.to_string(), fallback: cols.next() == Some("fallback") });
  }
  found
}

/// The known CLIs of `names` installed on host `id`. A host that can't be asked is an error (as
/// Orca's unverifiable host is, `SshHostNotServedError`), never "nothing installed".
#[tauri::command]
pub async fn ssh_remote_agents(targets: State<'_, Targets>, id: String, names: Vec<String>) -> Result<Vec<Found>, String> {
  let t = targets.get(&id)?;
  let names = probe_names(&names);
  if names.is_empty() {
    return Ok(Vec::new());
  }
  let script = detect_script(&names);
  ssh_hosts::blocking(move || ssh_hosts::remote_within(&t, &script, Duration::from_millis(DETECT_TIMEOUT_MS)).map(|out| parse_detected(&out, &names))).await?
}

#[cfg(all(test, unix))]
mod tests {
  use super::*;
  use std::os::unix::fs::PermissionsExt;
  use std::path::Path;
  use std::process::Command;

  fn names(xs: &[&str]) -> Vec<String> {
    xs.iter().map(|s| s.to_string()).collect()
  }

  fn exe(dir: &Path, name: &str, mode: u32) {
    std::fs::create_dir_all(dir).unwrap();
    let p = dir.join(name);
    std::fs::write(&p, "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
  }

  /// Runs the script the way ssh does: `sh -c`, a bare PATH, the host's `HOME` and `SHELL`.
  fn run(script: &str, home: &Path, shell: &Path) -> String {
    let o = Command::new("/bin/sh").arg("-c").arg(script).current_dir(home).env_clear().env("HOME", home).env("SHELL", shell).env("PATH", "/usr/bin:/bin").output().unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8_lossy(&o.stdout).into_owned()
  }

  /// A login shell whose startup greets on stdout and puts `dir` first on PATH.
  fn login_shell(home: &Path, dir: &Path) -> std::path::PathBuf {
    let shell = home.join("loginsh");
    std::fs::write(&shell, format!("#!/bin/sh\necho 'Welcome to box'\nPATH=\"{}:$PATH\"; export PATH\nshift\nexec /bin/sh -c \"$@\"\n", dir.display())).unwrap();
    std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).unwrap();
    shell
  }

  #[test]
  fn only_plain_program_names_are_asked_once_each() {
    assert_eq!(probe_names(&names(&["claude", "codex", "claude", "", "a b", "-x", ".hidden", "$(id)", "kiro-cli", "x;y"])), names(&["claude", "codex", "kiro-cli"]));
    assert_eq!(probe_names(&(0..100).map(|i| format!("a{i}")).collect::<Vec<_>>()).len(), MAX_NAMES);
  }

  #[test]
  fn finds_clis_on_the_login_path_and_marks_those_only_a_fallback_folder_has() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().canonicalize().unwrap();
    let tools = home.join("tools");
    exe(&tools, "claude", 0o755);
    // Not executable, and a folder: neither is a program.
    exe(&tools, "gemini", 0o644);
    std::fs::create_dir_all(tools.join("aider")).unwrap();
    // Only in a fallback folder (Orca's `~/.local/bin`), and one under an nvm version (its glob).
    exe(&home.join(".local/bin"), "codex", 0o755);
    exe(&home.join(".nvm/versions/node/v22.1.0/bin"), "opencode", 0o755);
    // In both: the login PATH's copy is the one reported.
    exe(&tools, "amp", 0o755);
    exe(&home.join(".local/bin"), "amp", 0o755);
    let shell = login_shell(&home, &tools);

    let asked = names(&["claude", "gemini", "aider", "codex", "opencode", "amp", "cursor-agent"]);
    let out = run(&detect_script(&asked), &home, &shell);
    let found = parse_detected(&out, &asked);
    let at = |n: &str| found.iter().find(|f| f.name == n).cloned();
    assert_eq!(at("claude"), Some(Found { name: "claude".into(), path: tools.join("claude").to_string_lossy().into_owned(), fallback: false }));
    assert_eq!(at("amp").map(|f| (f.path, f.fallback)), Some((tools.join("amp").to_string_lossy().into_owned(), false)));
    assert_eq!(at("codex").map(|f| (f.path, f.fallback)), Some((home.join(".local/bin/codex").to_string_lossy().into_owned(), true)));
    assert_eq!(at("opencode").map(|f| f.fallback), Some(true));
    assert_eq!(at("gemini"), None);
    assert_eq!(at("aider"), None);
    assert_eq!(at("cursor-agent"), None);
    assert_eq!(found.len(), 4);
  }

  #[test]
  fn a_login_shell_that_says_nothing_keeps_the_bare_path() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().canonicalize().unwrap();
    exe(&home.join(".bun/bin"), "claude", 0o755);
    // `false` as the login shell: no PATH line comes back.
    let out = run(&detect_script(&names(&["claude", "sh"])), &home, Path::new("/usr/bin/false"));
    let found = parse_detected(&out, &names(&["claude", "sh"]));
    assert_eq!(found.iter().find(|f| f.name == "sh").map(|f| f.fallback), Some(false));
    assert_eq!(found.iter().find(|f| f.name == "claude").map(|f| f.fallback), Some(true));
  }

  #[test]
  fn output_that_isnt_a_marker_line_for_an_asked_name_is_ignored() {
    let asked = names(&["claude", "codex"]);
    let out = format!("Last login: today\n{AGENT_MARK}claude\t/usr/bin/claude\tpath\n{AGENT_MARK}claude\t/opt/claude\tfallback\n{AGENT_MARK}rm\t/bin/rm\tpath\n{AGENT_MARK}codex\tC:\\codex.exe\tpath\n{AGENT_MARK}codex\n");
    assert_eq!(parse_detected(&out, &asked), vec![Found { name: "claude".into(), path: "/usr/bin/claude".into(), fallback: false }]);
    assert!(parse_detected("", &asked).is_empty());
  }
}
