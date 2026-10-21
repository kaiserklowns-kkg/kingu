//! Snap sandbox: confines a Snap task or MCP server to the `[permissions]` of its `snap.toml`.
//!
//! The app never builds the confined command itself. It runs
//! `kingu-ptyd snap-exec --network on|off --fs worktree|home --root <dir> [--snap <id>]
//! [--secret N]… [--keep N]… [--protect <path>]… -- <argv>` (typed into a terminal for a task, as the MCP
//! server command for an agent), and this launcher, already inside the final environment,
//! filters that environment and execs the OS confinement:
//!
//! - macOS: `/usr/bin/sandbox-exec -p <SBPL profile> -- argv`. `sandbox-exec` is deprecated but
//!   still ships and is what Apple's own tools and the Seatbelt-based CLIs use; there is no
//!   public replacement for confining an arbitrary child process.
//! - Linux: `bwrap` (bubblewrap) when installed, with a read-only `/` and writable binds.
//! - elsewhere: nothing to enforce with, so the launcher refuses.
//!
//! Filtering here (not in the app) matters for terminals: the shell that types the command has
//! sourced the user's rc files, which is where tokens are usually exported.
//!
//! Reads are not confined: toolchains read all over the system and the home folder (SDKs,
//! `~/.gitconfig`, package caches), so confining reads breaks most tasks. Secrets are protected
//! by not passing credential-looking variables instead. Writes are confined to the root (the
//! folder or task worktree), the temp dirs, the git dirs of a worktree and, for `fs = "home"`,
//! the home folder; files that would run code later outside the sandbox (git hooks and config,
//! `.kingu`) and the app's own folders (trust store, settings, skill plugins) stay read-only.

use std::ffi::{OsStr, OsString};
use std::path::{Component, Path, PathBuf};

pub const SUBCOMMAND: &str = "snap-exec";
pub const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fs {
  Worktree,
  Home,
}

/// What `snap-exec` was asked to run, from its arguments.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
  pub network: bool,
  pub fs: Fs,
  pub root: PathBuf,
  /// Declared secrets: from the keychain when `snap` has them stored there (`secrets.rs`), else
  /// passed through when the environment has them.
  pub secrets: Vec<String>,
  /// The snap whose keychain secrets to read.
  pub snap: Option<String>,
  /// Variables the snap itself sets (an MCP server's `env`): passed through too.
  pub keep: Vec<String>,
  /// Extra paths kept read-only (the app's config, data and cache folders).
  pub protect: Vec<PathBuf>,
  pub argv: Vec<String>,
}

pub fn parse_args(args: impl IntoIterator<Item = String>) -> Result<Request, String> {
  let mut it = args.into_iter();
  let (mut network, mut fs, mut root, mut snap) = (None, Fs::Worktree, None, None);
  let (mut secrets, mut keep, mut protect) = (Vec::new(), Vec::new(), Vec::new());
  loop {
    let Some(flag) = it.next() else { return Err("no command after --".into()) };
    if flag == "--" {
      break;
    }
    let value = it.next().ok_or_else(|| format!("{flag}: needs a value"))?;
    match flag.as_str() {
      "--network" => {
        network = Some(match value.as_str() {
          "on" => true,
          "off" => false,
          _ => return Err(format!("--network {value}: use on or off")),
        })
      }
      "--fs" => {
        fs = match value.as_str() {
          "worktree" => Fs::Worktree,
          "home" => Fs::Home,
          _ => return Err(format!("--fs {value}: use worktree or home")),
        }
      }
      "--root" => root = Some(PathBuf::from(value)),
      "--snap" if crate::secrets::valid_snap(&value) => snap = Some(value),
      "--snap" => return Err(format!("--snap {value}: id ของ snap ไม่ถูกต้อง")),
      "--secret" => secrets.push(value),
      "--keep" => keep.push(value),
      "--protect" => protect.push(PathBuf::from(value)),
      _ => return Err(format!("{flag}: unknown option")),
    }
  }
  let argv: Vec<String> = it.collect();
  if argv.first().is_none_or(|p| p.is_empty()) {
    return Err("no command after --".into());
  }
  let network = network.ok_or("--network is required")?;
  let root = root.ok_or("--root is required")?;
  if !root.is_absolute() {
    return Err(format!("--root {}: must be an absolute path", root.display()));
  }
  if protect.iter().any(|p| !p.is_absolute()) {
    return Err("--protect must be an absolute path".into());
  }
  Ok(Request { network, fs, root, secrets, snap, keep, protect, argv })
}

/// What the confinement allows, with every path already canonical.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
  pub network: bool,
  pub writable: Vec<PathBuf>,
  /// Read-only even inside a writable path (deny rules come after the allows).
  pub protected: Vec<PathBuf>,
}

/// The pure part of [`resolve`]: `root`, `home`, `temps` and `git_dirs` are canonical already.
pub fn policy(network: bool, fs: Fs, root: &Path, home: Option<&Path>, temps: &[PathBuf], git_dirs: &[PathBuf], protect: &[PathBuf]) -> Policy {
  let mut writable = vec![root.to_path_buf()];
  writable.extend(temps.iter().cloned());
  writable.extend(git_dirs.iter().cloned());
  if fs == Fs::Home
    && let Some(h) = home
  {
    writable.push(h.to_path_buf());
  }
  let mut protected = vec![root.join(".kingu")];
  for dir in std::iter::once(root.join(".git")).chain(git_dirs.iter().cloned()) {
    protected.extend([dir.join("hooks"), dir.join("config"), dir.join("config.worktree")]);
  }
  protected.extend(protect.iter().cloned());
  Policy { network, writable: dedup(writable), protected: dedup(protected) }
}

fn dedup(paths: Vec<PathBuf>) -> Vec<PathBuf> {
  let mut out: Vec<PathBuf> = Vec::new();
  for p in paths {
    if !out.contains(&p) {
      out.push(p);
    }
  }
  out
}

/// macOS paths through its top-level symlinks (`/tmp`, `/var`, `/etc` live under `/private`),
/// for paths that do not exist yet; the sandbox matches the real path.
pub fn macos_alias(p: &Path) -> PathBuf {
  for top in ["tmp", "var", "etc"] {
    if let Ok(rest) = p.strip_prefix(Path::new("/").join(top)) {
      return Path::new("/private").join(top).join(rest);
    }
  }
  p.to_path_buf()
}

/// The real path when it exists, else the absolute path with `.`/`..` folded (and the macOS
/// aliases applied), so a rule never names a path the kernel will not see.
pub fn canonical(p: &Path) -> PathBuf {
  if let Ok(real) = std::fs::canonicalize(p) {
    return real;
  }
  let mut out = PathBuf::new();
  for c in p.components() {
    match c {
      Component::ParentDir => {
        out.pop();
      }
      Component::CurDir => {}
      other => out.push(other),
    }
  }
  if cfg!(target_os = "macos") { macos_alias(&out) } else { out }
}

/// The git dirs of a linked worktree (`.git` is a file `gitdir: <dir>`): its own dir and the
/// common dir it shares with the main checkout, so commits work there. Empty for a normal
/// checkout, whose `.git` is inside the root already.
pub fn git_dirs(root: &Path) -> Vec<PathBuf> {
  let Ok(text) = std::fs::read_to_string(root.join(".git")) else { return Vec::new() };
  let Some(dir) = text.lines().next().and_then(|l| l.strip_prefix("gitdir:")).map(str::trim).filter(|d| !d.is_empty()) else {
    return Vec::new();
  };
  let gitdir = canonical(&root.join(dir));
  let mut out = vec![gitdir.clone()];
  if let Ok(common) = std::fs::read_to_string(gitdir.join("commondir")) {
    let common = common.trim();
    if !common.is_empty() {
      out.push(canonical(&gitdir.join(common)));
    }
  }
  out
}

/// [`policy`] for a request on this machine: canonical root (which must be a folder), home,
/// temp dirs and worktree git dirs.
pub fn resolve(req: &Request, home: Option<&OsStr>, tmpdir: Option<&OsStr>) -> Result<Policy, String> {
  let root = std::fs::canonicalize(&req.root).map_err(|e| format!("task folder {}: {e}", req.root.display()))?;
  if !root.is_dir() {
    return Err(format!("task folder {} is not a folder", root.display()));
  }
  if root == Path::new("/") {
    return Err("the task folder cannot be /".into());
  }
  let home = home.filter(|h| !h.is_empty()).map(|h| canonical(Path::new(h)));
  if req.fs == Fs::Worktree && home.as_deref() == Some(root.as_path()) {
    return Err("fs = \"worktree\" cannot use the home folder as the task folder (open the project folder instead)".into());
  }
  let mut temps: Vec<PathBuf> = tmpdir.filter(|t| !t.is_empty()).map(|t| canonical(Path::new(t))).into_iter().collect();
  if cfg!(target_os = "macos") {
    // Per-user temp and cache dirs (`$TMPDIR` lives here) and the shared /tmp.
    temps.extend([PathBuf::from("/private/tmp"), PathBuf::from("/private/var/folders")]);
  } else {
    temps.extend([PathBuf::from("/tmp"), PathBuf::from("/var/tmp")]);
  }
  let protect: Vec<PathBuf> = req.protect.iter().map(|p| canonical(p)).collect();
  Ok(policy(req.network, req.fs, &root, home.as_deref(), &dedup(temps), &git_dirs(&root), &protect))
}

/// A path as an SBPL string literal. Control characters are refused rather than escaped: no
/// real project path has them and a mistake there would change what the profile allows.
pub fn sbpl_string(p: &Path) -> Result<String, String> {
  let s = p.to_str().ok_or_else(|| format!("{}: path is not UTF-8", p.display()))?;
  if s.chars().any(char::is_control) {
    return Err(format!("{}: path has control characters", s.escape_debug()));
  }
  let mut out = String::with_capacity(s.len() + 2);
  out.push('"');
  for c in s.chars() {
    if c == '"' || c == '\\' {
      out.push('\\');
    }
    out.push(c);
  }
  out.push('"');
  Ok(out)
}

/// Devices every tool writes to: the null/zero devices, the terminal, inherited descriptors.
const MACOS_DEVICES: &str = r##"(literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (literal "/dev/ptmx") (regex #"^/dev/tty") (regex #"^/dev/fd/")"##;

/// The Seatbelt profile. Later rules win, so each deny is followed by its exceptions.
/// `network = false` denies IP networking, loopback included, but keeps Unix sockets (tools
/// talk to local daemons through them) except mDNSResponder's, which would resolve names and so
/// carry data out over DNS.
pub fn macos_profile(p: &Policy) -> Result<String, String> {
  let mut s = String::from("(version 1)\n(allow default)\n");
  if !p.network {
    s.push_str("(deny network*)\n(allow network* (local unix-socket))\n(allow network* (remote unix-socket))\n");
    s.push_str("(deny network-outbound (literal \"/private/var/run/mDNSResponder\"))\n");
  }
  s.push_str("(deny file-write*)\n(allow file-write*");
  for w in &p.writable {
    s.push_str(&format!(" (subpath {})", sbpl_string(w)?));
  }
  s.push(' ');
  s.push_str(MACOS_DEVICES);
  s.push_str(")\n");
  if !p.protected.is_empty() {
    s.push_str("(deny file-write*");
    for r in &p.protected {
      s.push_str(&format!(" (subpath {})", sbpl_string(r)?));
    }
    s.push_str(")\n");
  }
  Ok(s)
}

/// `sandbox-exec -p <profile> -- argv`: the profile is a single argument.
pub fn macos_argv(p: &Policy, argv: &[String]) -> Result<Vec<String>, String> {
  let mut out = vec![SANDBOX_EXEC.to_string(), "-p".into(), macos_profile(p)?, "--".into()];
  out.extend(argv.iter().cloned());
  Ok(out)
}

/// `bwrap` with the whole system read-only, `/dev` as is (terminals), the writable paths bound
/// read-write, the protected ones bound read-only over them, and no network namespace access
/// when `network = false`. `-try` binds skip paths that do not exist.
pub fn bwrap_argv(bwrap: &Path, p: &Policy, argv: &[String]) -> Result<Vec<String>, String> {
  let text = |p: &Path| p.to_str().map(str::to_owned).ok_or_else(|| format!("{}: path is not UTF-8", p.display()));
  let mut out = vec![text(bwrap)?, "--die-with-parent".into(), "--ro-bind".into(), "/".into(), "/".into(), "--dev-bind".into(), "/dev".into(), "/dev".into()];
  for w in &p.writable {
    let w = text(w)?;
    out.extend(["--bind-try".into(), w.clone(), w]);
  }
  for r in &p.protected {
    let r = text(r)?;
    out.extend(["--ro-bind-try".into(), r.clone(), r]);
  }
  if !p.network {
    out.push("--unshare-net".into());
  }
  out.push("--".into());
  out.extend(argv.iter().cloned());
  Ok(out)
}

/// Variable names that look like credentials: a `_`-separated word such as TOKEN, SECRET,
/// PASSWORD or KEY, or a cloud provider's prefix. Over-matching only costs a variable a tool
/// did not need; the snap can declare it under `secrets` to get it back.
pub fn is_credential_name(name: &str) -> bool {
  const WORDS: &[&str] = &[
    "TOKEN", "TOKENS", "SECRET", "SECRETS", "PASSWORD", "PASSWD", "PASS", "PASSPHRASE", "KEY", "KEYS", "APIKEY", "CREDENTIAL", "CREDENTIALS", "COOKIE", "DSN", "PAT",
  ];
  const PREFIXES: &[&str] = &["AWS_", "AZURE_", "GCP_", "GOOGLE_APPLICATION_CREDENTIALS", "VAULT_", "OP_SESSION", "DOCKER_AUTH", "NPM_CONFIG__AUTH"];
  const EXACT: &[&str] = &["DATABASE_URL", "PGPASSWORD", "MYSQL_PWD", "NETRC"];
  let up = name.to_ascii_uppercase();
  // `GIT_CONFIG_KEY_<n>` pairs with `GIT_CONFIG_VALUE_<n>`: dropping one half makes git refuse to start.
  if up.starts_with("GIT_CONFIG_") {
    return false;
  }
  EXACT.contains(&up.as_str()) || PREFIXES.iter().any(|p| up.starts_with(p)) || up.split('_').any(|w| WORDS.contains(&w))
}

/// Agent sockets that let a process act as the user on other machines: only for snaps that may
/// use the network anyway.
const NETWORK_ONLY: &[&str] = &["SSH_AUTH_SOCK", "GPG_AGENT_INFO"];

/// The environment a confined command gets: everything except credentials, unless declared
/// under `secrets` (or set by the snap itself, `keep`).
pub fn filter_env(vars: impl IntoIterator<Item = (OsString, OsString)>, network: bool, secrets: &[String], keep: &[String]) -> Vec<(OsString, OsString)> {
  vars
    .into_iter()
    .filter(|(k, _)| {
      let Some(name) = k.to_str() else { return false };
      if secrets.iter().chain(keep).any(|s| s == name) {
        return true;
      }
      !is_credential_name(name) && (network || !NETWORK_ONLY.contains(&name))
    })
    .collect()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Enforcer {
  SandboxExec,
  Bwrap(PathBuf),
}

impl Enforcer {
  pub fn name(&self) -> &'static str {
    match self {
      Enforcer::SandboxExec => "sandbox-exec",
      Enforcer::Bwrap(_) => "bwrap",
    }
  }

  pub fn argv(&self, p: &Policy, argv: &[String]) -> Result<Vec<String>, String> {
    match self {
      Enforcer::SandboxExec => macos_argv(p, argv),
      Enforcer::Bwrap(bin) => bwrap_argv(bin, p, argv),
    }
  }
}

/// What confines snaps on this machine; `path` is the PATH to look for `bwrap` in.
pub fn enforcer(path: Option<&OsStr>) -> Result<Enforcer, String> {
  if cfg!(target_os = "macos") {
    return if Path::new(SANDBOX_EXEC).is_file() { Ok(Enforcer::SandboxExec) } else { Err(format!("{SANDBOX_EXEC} not found on this machine")) };
  }
  if cfg!(target_os = "linux") {
    return find_in_path(path, "bwrap").map(Enforcer::Bwrap).ok_or_else(|| "bwrap (bubblewrap) not found: install it with the system package manager, e.g. apt install bubblewrap".into());
  }
  Err("this operating system does not support the Snap sandbox yet".into())
}

fn find_in_path(path: Option<&OsStr>, name: &str) -> Option<PathBuf> {
  std::env::split_paths(path?).map(|d| d.join(name)).find(|p| is_executable(p))
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
  use std::os::unix::fs::PermissionsExt;
  std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(p: &Path) -> bool {
  p.is_file()
}

/// `kingu-ptyd snap-exec …`: replaces this process with the confined command, or returns the
/// reason it could not.
#[cfg(unix)]
pub fn exec(args: impl IntoIterator<Item = String>) -> String {
  use std::os::unix::process::CommandExt;
  let run = || -> Result<std::process::Command, String> {
    let req = parse_args(args)?;
    let policy = resolve(&req, std::env::var_os("HOME").as_deref(), std::env::var_os("TMPDIR").as_deref())?;
    let argv = enforcer(std::env::var_os("PATH").as_deref())?.argv(&policy, &req.argv)?;
    let mut cmd = std::process::Command::new(&argv[0]);
    cmd.args(&argv[1..]).env_clear().envs(filter_env(std::env::vars_os(), req.network, &req.secrets, &req.keep));
    // Stored secrets win over the environment: they were set for this snap.
    if let Some(snap) = &req.snap {
      cmd.envs(crate::secrets::lookup(&crate::secrets::Keychain, snap, &req.secrets));
    }
    Ok(cmd)
  };
  match run() {
    Ok(mut cmd) => format!("could not start the command in the sandbox: {}", cmd.exec()),
    Err(e) => e,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn args(s: &[&str]) -> Vec<String> {
    s.iter().map(|a| a.to_string()).collect()
  }

  #[test]
  fn parses_the_launcher_arguments() {
    let r = parse_args(args(&[
      "--network", "off", "--fs", "home", "--root", "/w", "--snap", "go", "--secret", "GITHUB_TOKEN", "--keep", "MODE", "--protect", "/cfg", "--", "go", "test", "--", "./...",
    ]))
    .unwrap();
    assert_eq!(
      r,
      Request {
        network: false,
        fs: Fs::Home,
        root: "/w".into(),
        secrets: args(&["GITHUB_TOKEN"]),
        snap: Some("go".into()),
        keep: args(&["MODE"]),
        protect: vec!["/cfg".into()],
        argv: args(&["go", "test", "--", "./..."]),
      }
    );
    assert_eq!(parse_args(args(&["--network", "on", "--root", "/w", "--", "x"])).unwrap().fs, Fs::Worktree);
    assert!(parse_args(args(&["--network", "on", "--root", "/w", "--snap", "../x", "--", "x"])).is_err());
  }

  #[test]
  fn refuses_bad_launcher_arguments() {
    for bad in [
      &["--network", "on", "--root", "/w", "--"][..],
      &["--network", "on", "--root", "/w", "--", ""],
      &["--root", "/w", "--", "x"],
      &["--network", "on", "--", "x"],
      &["--network", "on", "--root", "rel", "--", "x"],
      &["--network", "maybe", "--root", "/w", "--", "x"],
      &["--network", "on", "--fs", "all", "--root", "/w", "--", "x"],
      &["--network", "on", "--root", "/w", "--protect", "cfg", "--", "x"],
      &["--network", "on", "--root", "/w", "--bogus", "1", "--", "x"],
      &["--network", "on", "--root"],
    ] {
      assert!(parse_args(args(bad)).is_err(), "{bad:?}");
    }
  }

  #[test]
  fn sbpl_strings_escape_quotes_and_backslashes() {
    assert_eq!(sbpl_string(Path::new("/a b/c")).unwrap(), r#""/a b/c""#);
    assert_eq!(sbpl_string(Path::new(r#"/x"y\z"#)).unwrap(), r#""/x\"y\\z""#);
    assert!(sbpl_string(Path::new("/a\nb")).is_err());
    assert!(sbpl_string(Path::new("/a\0b")).is_err());
  }

  #[test]
  fn macos_aliases_and_lexical_canonical_paths() {
    assert_eq!(macos_alias(Path::new("/tmp/x")), PathBuf::from("/private/tmp/x"));
    assert_eq!(macos_alias(Path::new("/var/folders/a")), PathBuf::from("/private/var/folders/a"));
    assert_eq!(macos_alias(Path::new("/etc")), PathBuf::from("/private/etc"));
    assert_eq!(macos_alias(Path::new("/tmpx/a")), PathBuf::from("/tmpx/a"));
    assert_eq!(macos_alias(Path::new("/Users/a")), PathBuf::from("/Users/a"));
    let missing = Path::new("/kingu-no-such-dir/a/../b/./c");
    assert_eq!(canonical(missing), PathBuf::from("/kingu-no-such-dir/b/c"));
  }

  fn sample(network: bool, fs: Fs) -> Policy {
    policy(network, fs, Path::new("/w/repo"), Some(Path::new("/Users/me")), &[PathBuf::from("/private/tmp")], &[], &[PathBuf::from("/Users/me/Library/Application Support/kingu")])
  }

  #[test]
  fn policy_writable_and_protected_paths() {
    let p = sample(false, Fs::Worktree);
    assert_eq!(p.writable, vec![PathBuf::from("/w/repo"), "/private/tmp".into()]);
    assert!(p.protected.contains(&"/w/repo/.kingu".into()));
    assert!(p.protected.contains(&"/w/repo/.git/hooks".into()));
    assert!(p.protected.contains(&"/w/repo/.git/config".into()));
    assert!(p.protected.contains(&"/Users/me/Library/Application Support/kingu".into()));
    assert!(sample(true, Fs::Home).writable.contains(&"/Users/me".into()));

    let wt = policy(true, Fs::Worktree, Path::new("/r/.kingu/worktrees/t"), None, &[], &["/r/.git/worktrees/t".into(), "/r/.git".into()], &[]);
    assert_eq!(wt.writable, vec![PathBuf::from("/r/.kingu/worktrees/t"), "/r/.git/worktrees/t".into(), "/r/.git".into()]);
    assert!(wt.protected.contains(&"/r/.git/hooks".into()));
    assert!(wt.protected.contains(&"/r/.git/config".into()));
    assert!(wt.protected.contains(&"/r/.git/worktrees/t/config.worktree".into()));
  }

  #[test]
  fn macos_profile_network_and_fs() {
    let off = macos_profile(&sample(false, Fs::Worktree)).unwrap();
    assert!(off.starts_with("(version 1)\n(allow default)\n"));
    assert!(off.contains("(deny network*)"));
    assert!(off.contains("(allow network* (local unix-socket))"));
    assert!(off.contains(r#"(deny network-outbound (literal "/private/var/run/mDNSResponder"))"#));
    assert!(off.contains(r#"(deny file-write*)
(allow file-write* (subpath "/w/repo") (subpath "/private/tmp") (literal "/dev/null")"#));
    assert!(off.contains(r#"(regex #"^/dev/tty")"#));
    // The protected paths are denied after the allows, so they win.
    let deny = off.rfind("(deny file-write* (subpath \"/w/repo/.kingu\")").unwrap();
    assert!(deny > off.find("(allow file-write*").unwrap());
    assert!(off.contains(r#"(subpath "/Users/me/Library/Application Support/kingu")"#));

    let on = macos_profile(&sample(true, Fs::Home)).unwrap();
    assert!(!on.contains("network"));
    assert!(on.contains(r#"(subpath "/Users/me")"#));

    let quoted = policy(true, Fs::Worktree, Path::new(r#"/w/a "b"\c"#), None, &[], &[], &[]);
    assert!(macos_profile(&quoted).unwrap().contains(r#"(subpath "/w/a \"b\"\\c")"#));
  }

  #[test]
  fn macos_argv_keeps_the_profile_one_argument() {
    let argv = macos_argv(&sample(false, Fs::Worktree), &args(&["go", "test", "./..."])).unwrap();
    assert_eq!(argv[0], SANDBOX_EXEC);
    assert_eq!(argv[1], "-p");
    assert!(argv[2].starts_with("(version 1)"));
    assert_eq!(argv[3..], args(&["--", "go", "test", "./..."])[..]);
  }

  #[test]
  fn bwrap_argv_binds_and_network() {
    let off = bwrap_argv(Path::new("/usr/bin/bwrap"), &sample(false, Fs::Worktree), &args(&["make"])).unwrap();
    let joined = off.join(" ");
    assert!(joined.starts_with("/usr/bin/bwrap --die-with-parent --ro-bind / / --dev-bind /dev /dev --bind-try /w/repo /w/repo --bind-try /private/tmp /private/tmp"));
    assert!(joined.contains("--ro-bind-try /w/repo/.git/hooks /w/repo/.git/hooks"));
    assert!(joined.ends_with("--unshare-net -- make"));
    // Read-only binds come after the writable ones (bwrap applies them in order).
    assert!(joined.find("--ro-bind-try").unwrap() > joined.rfind("--bind-try /").unwrap());
    let on = bwrap_argv(Path::new("/usr/bin/bwrap"), &sample(true, Fs::Home), &args(&["make", "a b"])).unwrap();
    assert!(!on.contains(&"--unshare-net".to_string()));
    assert!(on.join(" ").contains("--bind-try /Users/me /Users/me"));
    assert_eq!(on.last().unwrap(), "a b");
  }

  #[test]
  fn credential_names() {
    for n in [
      "GITHUB_TOKEN", "GH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_PROFILE", "NPM_TOKEN", "DB_PASSWORD", "MY_SECRET",
      "STRIPE_SECRET_KEY", "SENTRY_DSN", "DATABASE_URL", "GOOGLE_APPLICATION_CREDENTIALS", "github_token", "OP_SESSION_my", "PGPASSWORD",
    ] {
      assert!(is_credential_name(n), "{n}");
    }
    for n in ["PATH", "HOME", "TERM", "LANG", "GOPATH", "KEYTIMEOUT", "SSH_AUTH_SOCK", "GIT_ASKPASS", "TERM_SESSION_ID", "PWD", "NODE_OPTIONS", "XAUTHORITY", "GIT_CONFIG_KEY_0"] {
      assert!(!is_credential_name(n), "{n}");
    }
  }

  #[test]
  fn env_filter_strips_credentials_unless_declared() {
    let vars = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (OsString::from(k), OsString::from(v))).collect::<Vec<_>>();
    let all = vars(&[("PATH", "/bin"), ("GITHUB_TOKEN", "g"), ("ANTHROPIC_API_KEY", "a"), ("SSH_AUTH_SOCK", "/s"), ("MODE_TOKEN", "m"), ("HOME", "/h")]);
    let names = |v: Vec<(OsString, OsString)>| v.into_iter().map(|(k, _)| k.into_string().unwrap()).collect::<Vec<_>>();
    assert_eq!(names(filter_env(all.clone(), false, &[], &[])), ["PATH", "HOME"]);
    assert_eq!(names(filter_env(all.clone(), true, &[], &[])), ["PATH", "SSH_AUTH_SOCK", "HOME"]);
    assert_eq!(names(filter_env(all.clone(), false, &args(&["GITHUB_TOKEN", "MISSING_TOKEN"]), &args(&["MODE_TOKEN"]))), ["PATH", "GITHUB_TOKEN", "MODE_TOKEN", "HOME"]);
  }

  #[test]
  fn worktree_git_dirs_from_the_dot_git_file() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("wt");
    let gitdir = tmp.path().join("repo/.git/worktrees/wt");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&gitdir).unwrap();
    std::fs::write(root.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();
    std::fs::write(gitdir.join("commondir"), "../..\n").unwrap();
    let common = std::fs::canonicalize(tmp.path().join("repo/.git")).unwrap();
    assert_eq!(git_dirs(&root), vec![std::fs::canonicalize(&gitdir).unwrap(), common]);
    assert!(git_dirs(tmp.path()).is_empty());
  }

  #[test]
  fn resolve_canonicalizes_and_refuses_bad_roots() {
    let tmp = tempfile::tempdir().unwrap();
    let req = |root: &Path, fs| Request { network: false, fs, root: root.to_path_buf(), secrets: vec![], snap: None, keep: vec![], protect: vec![], argv: args(&["x"]) };
    let p = resolve(&req(tmp.path(), Fs::Worktree), Some(OsStr::new("/nonexistent-home")), None).unwrap();
    assert_eq!(p.writable[0], std::fs::canonicalize(tmp.path()).unwrap());
    assert!(resolve(&req(&tmp.path().join("missing"), Fs::Worktree), None, None).is_err());
    assert!(resolve(&req(Path::new("/"), Fs::Home), None, None).is_err());
    assert!(resolve(&req(tmp.path(), Fs::Worktree), Some(tmp.path().as_os_str()), None).is_err(), "home as the worktree root");
  }
}
