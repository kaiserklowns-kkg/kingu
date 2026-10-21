//! Snap sandbox: confines a Snap task or MCP server to the `[permissions]` of its `snap.toml`.
//!
//! The app never builds the confined command itself. It runs
//! `kingu-ptyd snap-exec --network on|off --fs worktree|home --root <dir> [--secret N]…
//! [--keep N]… [--protect <path>]… [scopes…] [--secrets-file[-once] <file>] -- <argv>` (typed into
//! a terminal for a task, as the MCP
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
//! Reads are not confined by default: toolchains read all over the system and the home folder
//! (SDKs, `~/.gitconfig`, package caches), so confining reads breaks most tasks. A snap that
//! declares `read = [...]` gets the home folder unreadable except the root, its writable paths
//! and those folders (macOS only; system folders stay readable). Credential-looking variables
//! are not passed. Writes are confined to the root (the folder or task worktree), the temp dirs,
//! the git dirs of a worktree, declared `write` folders and, for `fs = "home"`, the home folder;
//! files that would run code later outside the sandbox (git hooks and config, `.kingu`) and the
//! app's own folders (trust store, settings, skill plugins) stay read-only, and `--hide` folders
//! (the app's snap secrets) are neither readable nor writable.
//!
//! The other declared scopes:
//! - `processes`: `(deny process-exec)` except the declared programs (looked up on PATH), the
//!   command's own program, the interpreters their `#!` lines name and, for `/bin/sh`, the shells
//!   macOS's `sh` shim runs. macOS only: bwrap cannot filter exec, so Linux does not enforce it.
//! - `hosts`: Seatbelt filters connections by IP and port only (`localhost` or `*`), never by
//!   name, so the launcher stays as the parent and runs an HTTP proxy on 127.0.0.1 that passes
//!   only CONNECT / plain HTTP to the declared hosts (`net_proxy`); the profile denies every other
//!   IP connection, so a tool that ignores `HTTPS_PROXY` gets no network rather than all of it.
//!   On Linux the proxy is unreachable from bwrap's empty network namespace: no network there.
//! - `env`: the environment is cut to a small base (`BASE_ENV`) plus the declared names.
//! - secrets the user entered: the app writes them to a 0600 file in a hidden folder and passes
//!   `--secrets-file`; the launcher reads it before confining (deleting it for a task with
//!   `--secrets-file-once`) and sets only the declared names. Values never appear in argv.

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
  /// Declared secrets: set from `secrets_file` when the user stored a value, else passed through
  /// when the environment has them.
  pub secrets: Vec<String>,
  /// Variables the snap itself sets (an MCP server's `env`): passed through too.
  pub keep: Vec<String>,
  /// Extra paths kept read-only (the app's config, data and cache folders).
  pub protect: Vec<PathBuf>,
  /// The only hosts it may reach (with network on), through the launcher's proxy.
  pub hosts: Vec<String>,
  /// Home folders it may read (`~/x` or absolute); empty: reads not confined.
  pub read: Vec<String>,
  /// Extra writable folders (`~/x` or absolute).
  pub write: Vec<String>,
  /// Programs it may start; empty: any.
  pub exec: Vec<String>,
  /// Variables it gets beyond `BASE_ENV`; empty: everything but credentials.
  pub env: Vec<String>,
  /// A JSON object `{NAME: value}` of secret values (0600), and whether to delete it once read.
  pub secrets_file: Option<PathBuf>,
  pub secrets_once: bool,
  /// Folders neither readable nor writable (the app's snap secrets folder).
  pub hide: Vec<PathBuf>,
  pub argv: Vec<String>,
}

pub fn parse_args(args: impl IntoIterator<Item = String>) -> Result<Request, String> {
  let mut it = args.into_iter();
  let (mut network, mut fs, mut root) = (None, Fs::Worktree, None);
  let (mut secrets, mut keep, mut protect) = (Vec::new(), Vec::new(), Vec::new());
  let (mut hosts, mut read, mut write, mut exec, mut env, mut hide) = (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
  let (mut secrets_file, mut secrets_once) = (None, false);
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
      "--secret" => secrets.push(value),
      "--keep" => keep.push(value),
      "--protect" => protect.push(PathBuf::from(value)),
      "--host" => hosts.push(value),
      "--read" => read.push(value),
      "--write" => write.push(value),
      "--exec" => exec.push(value),
      "--env" => env.push(value),
      "--hide" => hide.push(PathBuf::from(value)),
      "--secrets-file" | "--secrets-file-once" => {
        secrets_once = flag == "--secrets-file-once";
        secrets_file = Some(PathBuf::from(value));
      }
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
  if protect.iter().chain(&hide).chain(secrets_file.iter()).any(|p| !p.is_absolute()) {
    return Err("--protect, --hide and --secrets-file must be absolute paths".into());
  }
  if read.iter().chain(&write).any(|p| !(p.starts_with('/') || p.starts_with("~/"))) {
    return Err("--read and --write take absolute or ~/ paths".into());
  }
  if !hosts.is_empty() && !network {
    return Err("--host needs --network on".into());
  }
  Ok(Request { network, fs, root, secrets, keep, protect, hosts, read, write, exec, env, secrets_file, secrets_once, hide, argv })
}

/// What the confinement allows, with every path already canonical.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
  pub network: bool,
  pub writable: Vec<PathBuf>,
  /// Read-only even inside a writable path (deny rules come after the allows).
  pub protected: Vec<PathBuf>,
  /// With a host list: only localhost:<port> (the launcher's proxy) is reachable.
  pub proxy_port: Option<u16>,
  /// With a read list: the home folder, and what in it stays readable (root, writable, declared).
  pub home_reads: Option<(PathBuf, Vec<PathBuf>)>,
  /// With a program list: every program that may be executed.
  pub exec: Option<Vec<PathBuf>>,
  /// Neither readable nor writable, whatever else allows.
  pub hidden: Vec<PathBuf>,
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
  Policy { network, writable: dedup(writable), protected: dedup(protected), proxy_port: None, home_reads: None, exec: None, hidden: Vec::new() }
}

/// `~/x` against `home`, else the path as given; canonical either way.
fn expand_home(p: &str, home: Option<&Path>) -> Option<PathBuf> {
  match p.strip_prefix("~/") {
    Some(rest) => home.map(|h| canonical(&h.join(rest))),
    None => Some(canonical(Path::new(p))),
  }
}

/// Shells macOS's `/bin/sh` shim may run (it execs one of them "as variant for /bin/sh").
const SH_VARIANTS: &[&str] = &["/bin/bash", "/bin/zsh", "/bin/dash", "/bin/ksh"];

/// The interpreter of a `#!` script (and the program `/usr/bin/env` would run), so a declared
/// script can actually start.
fn interpreters(p: &Path, path: Option<&OsStr>) -> Vec<PathBuf> {
  use std::io::Read;
  let mut head = [0u8; 256];
  let Ok(n) = std::fs::File::open(p).and_then(|mut f| f.read(&mut head)) else { return Vec::new() };
  let Some(line) = head[..n].strip_prefix(b"#!").and_then(|l| l.split(|b| *b == b'\n').next()).and_then(|l| std::str::from_utf8(l).ok()) else {
    return Vec::new();
  };
  let mut words = line.split_whitespace();
  let Some(first) = words.next() else { return Vec::new() };
  let mut out = vec![PathBuf::from(first)];
  if first.ends_with("/env")
    && let Some(prog) = words.find(|w| !w.starts_with('-'))
    && let Some(found) = find_program(prog, path)
  {
    out.push(found);
  }
  out
}

/// A program name through PATH, a relative path from the current folder, or an absolute path.
fn find_program(name: &str, path: Option<&OsStr>) -> Option<PathBuf> {
  if name.starts_with('/') {
    return Some(PathBuf::from(name));
  }
  if name.contains('/') {
    return std::fs::canonicalize(name).ok();
  }
  find_in_path(path, name)
}

/// Every path to allow for executing `programs`: as found, canonical, their `#!` interpreters
/// and, for `/bin/sh`, the shells it runs.
pub fn exec_allow(programs: &[String], path: Option<&OsStr>) -> Vec<PathBuf> {
  let mut out: Vec<PathBuf> = Vec::new();
  let mut queue: Vec<PathBuf> = programs.iter().filter_map(|p| find_program(p, path)).collect();
  while let Some(p) = queue.pop() {
    if out.contains(&p) || out.len() > 256 {
      continue;
    }
    if p == Path::new("/bin/sh") {
      queue.extend(SH_VARIANTS.iter().map(PathBuf::from));
    }
    queue.extend(interpreters(&p, path));
    if let Ok(real) = std::fs::canonicalize(&p) {
      queue.push(real);
    }
    out.push(p);
  }
  out
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
pub fn resolve(req: &Request, home: Option<&OsStr>, tmpdir: Option<&OsStr>, path: Option<&OsStr>) -> Result<Policy, String> {
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
  let home = home.as_deref();
  let mut p = policy(req.network, req.fs, &root, home, &dedup(temps), &git_dirs(&root), &protect);
  for w in &req.write {
    let w = expand_home(w, home).ok_or("~/ paths need HOME")?;
    if w == Path::new("/") || Some(w.as_path()) == home {
      return Err(format!("{}: too broad for --write (use fs = \"home\")", w.display()));
    }
    p.writable.push(w);
  }
  p.writable = dedup(p.writable);
  if !req.read.is_empty()
    && let Some(h) = home
  {
    let mut allow: Vec<PathBuf> = p.writable.clone();
    for r in &req.read {
      allow.push(expand_home(r, Some(h)).ok_or("~/ paths need HOME")?);
    }
    p.home_reads = Some((h.to_path_buf(), dedup(allow)));
  }
  if !req.exec.is_empty() {
    let programs: Vec<String> = req.exec.iter().chain(req.argv.first()).cloned().collect();
    p.exec = Some(exec_allow(&programs, path));
  }
  p.hidden = req.hide.iter().map(|h| canonical(h)).collect();
  Ok(p)
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
  if !p.network || p.proxy_port.is_some() {
    s.push_str("(deny network*)\n(allow network* (local unix-socket))\n(allow network* (remote unix-socket))\n");
    s.push_str("(deny network-outbound (literal \"/private/var/run/mDNSResponder\"))\n");
  }
  if let Some(port) = p.proxy_port {
    s.push_str(&format!("(allow network-outbound (remote ip \"localhost:{port}\"))\n"));
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
  if let Some((home, allow)) = &p.home_reads {
    s.push_str(&format!("(deny file-read* (subpath {}))\n(allow file-read*", sbpl_string(home)?));
    for a in allow {
      s.push_str(&format!(" (subpath {})", sbpl_string(a)?));
    }
    for e in p.exec.iter().flatten() {
      s.push_str(&format!(" (literal {})", sbpl_string(e)?));
    }
    s.push_str(")\n");
    // Resolving a path inside home stats every folder above it.
    let mut above: Vec<PathBuf> = Vec::new();
    for a in allow {
      for anc in a.ancestors().skip(1) {
        if anc.starts_with(home) && !above.iter().any(|x| x == anc) {
          above.push(anc.to_path_buf());
        }
      }
    }
    if !above.is_empty() {
      s.push_str("(allow file-read-metadata");
      for a in &above {
        s.push_str(&format!(" (literal {})", sbpl_string(a)?));
      }
      s.push_str(")\n");
    }
  }
  if let Some(exec) = &p.exec {
    s.push_str("(deny process-exec)\n(allow process-exec");
    for e in exec {
      s.push_str(&format!(" (literal {})", sbpl_string(e)?));
    }
    s.push_str(")\n");
  }
  if !p.hidden.is_empty() {
    s.push_str("(deny file-read* file-write*");
    for h in &p.hidden {
      s.push_str(&format!(" (subpath {})", sbpl_string(h)?));
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
  // A host list cannot be enforced in bwrap (the proxy is outside its namespace): no network.
  if !p.network || p.proxy_port.is_some() {
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
  filter_env_only(vars, network, secrets, keep, &[])
}

/// What every confined command keeps when its snap declares `env = [...]`: the variables tools
/// need to find programs, the home folder, the locale and the terminal.
pub const BASE_ENV: &[&str] = &["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "TERM_PROGRAM", "COLORTERM", "LANG", "TMPDIR", "TZ", "PWD", "SHLVL", "__CF_USER_TEXT_ENCODING"];

/// `filter_env`, and with a non-empty `only` (the declared `env`) also nothing beyond
/// `BASE_ENV`, `LC_*`, `only`, the secrets and `keep`. Proxy settings never pass (the launcher
/// sets its own when the snap has a host list).
pub fn filter_env_only(vars: impl IntoIterator<Item = (OsString, OsString)>, network: bool, secrets: &[String], keep: &[String], only: &[String]) -> Vec<(OsString, OsString)> {
  vars
    .into_iter()
    .filter(|(k, _)| {
      let Some(name) = k.to_str() else { return false };
      if secrets.iter().chain(keep).any(|s| s == name) {
        return true;
      }
      if !only.is_empty() && !(BASE_ENV.contains(&name) || name.starts_with("LC_") || only.iter().any(|o| o == name)) {
        return false;
      }
      !is_credential_name(name) && (network || !NETWORK_ONLY.contains(&name))
    })
    .collect()
}

/// The secret values the app wrote for this run: a JSON object of strings in a regular file
/// owned by this user and readable by nobody else. Only `declared` names are taken; the file is
/// deleted first when `once`. Errors never include a value.
pub fn read_secrets(file: &Path, declared: &[String], once: bool) -> Result<Vec<(String, String)>, String> {
  let meta = std::fs::symlink_metadata(file).map_err(|e| format!("secrets file: {e}"))?;
  if !meta.is_file() || meta.len() > 1024 * 1024 {
    return Err("secrets file is not a regular file".into());
  }
  #[cfg(unix)]
  {
    use std::os::unix::fs::MetadataExt;
    // SAFETY: getuid has no preconditions.
    if meta.uid() != unsafe { libc::getuid() } || meta.mode() & 0o077 != 0 {
      return Err("secrets file must belong to you and be private (0600)".into());
    }
  }
  let bytes = std::fs::read(file).map_err(|e| format!("secrets file: {e}"))?;
  if once {
    let _ = std::fs::remove_file(file);
  }
  let map: std::collections::BTreeMap<String, String> = serde_json::from_slice(&bytes).map_err(|_| "secrets file is not a JSON object of strings".to_string())?;
  Ok(map.into_iter().filter(|(k, _)| declared.contains(k)).collect())
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
/// reason it could not. With a host list (macOS) it stays as the parent instead, serving the
/// proxy, and exits with the command's status.
#[cfg(unix)]
pub fn exec(args: impl IntoIterator<Item = String>) -> String {
  use std::os::unix::process::CommandExt;
  let run = || -> Result<(std::process::Command, bool), String> {
    let req = parse_args(args)?;
    let secrets = match &req.secrets_file {
      Some(f) => read_secrets(f, &req.secrets, req.secrets_once)?,
      None => Vec::new(),
    };
    let path = std::env::var_os("PATH");
    let mut policy = resolve(&req, std::env::var_os("HOME").as_deref(), std::env::var_os("TMPDIR").as_deref(), path.as_deref())?;
    let enforcer = enforcer(path.as_deref())?;
    let proxy = match (&enforcer, req.hosts.is_empty()) {
      (_, true) => None,
      (Enforcer::SandboxExec, false) => Some(crate::net_proxy::start(req.hosts.clone())?),
      // bwrap: `--unshare-net` (see bwrap_argv), so the host list means no network.
      (_, false) => {
        policy.proxy_port = Some(0);
        None
      }
    };
    if let Some(p) = &proxy {
      policy.proxy_port = Some(p.port);
    }
    let argv = enforcer.argv(&policy, &req.argv)?;
    let mut cmd = std::process::Command::new(&argv[0]);
    cmd.args(&argv[1..]).env_clear().envs(filter_env_only(
      std::env::vars_os().filter(|(k, _)| !k.to_str().is_some_and(|k| k.eq_ignore_ascii_case("no_proxy") || (proxy.is_some() && k.to_ascii_lowercase().ends_with("_proxy")))),
      req.network,
      &req.secrets,
      &req.keep,
      &req.env,
    ));
    cmd.envs(secrets);
    if let Some(p) = &proxy {
      cmd.envs(crate::net_proxy::proxy_env(p.port));
    }
    Ok((cmd, proxy.is_some()))
  };
  match run() {
    Ok((mut cmd, false)) => format!("could not start the command in the sandbox: {}", cmd.exec()),
    Ok((mut cmd, true)) => match cmd.spawn() {
      Ok(mut child) => {
        // Ctrl-C reaches the whole foreground group; the command decides what it means and the
        // launcher just waits for it (set after spawning: ignored signals are inherited).
        // SAFETY: setting a signal disposition to SIG_IGN has no preconditions.
        unsafe {
          libc::signal(libc::SIGINT, libc::SIG_IGN);
          libc::signal(libc::SIGQUIT, libc::SIG_IGN);
        }
        let status = child.wait();
        use std::os::unix::process::ExitStatusExt;
        std::process::exit(status.map(|s| s.code().unwrap_or_else(|| 128 + s.signal().unwrap_or(1))).unwrap_or(1));
      }
      Err(e) => format!("could not start the command in the sandbox: {e}"),
    },
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
      "--network", "off", "--fs", "home", "--root", "/w", "--secret", "GITHUB_TOKEN", "--keep", "MODE", "--protect", "/cfg", "--", "go", "test", "--", "./...",
    ]))
    .unwrap();
    assert_eq!(
      r,
      Request {
        network: false,
        fs: Fs::Home,
        root: "/w".into(),
        secrets: args(&["GITHUB_TOKEN"]),
        keep: args(&["MODE"]),
        protect: vec!["/cfg".into()],
        hosts: vec![],
        read: vec![],
        write: vec![],
        exec: vec![],
        env: vec![],
        secrets_file: None,
        secrets_once: false,
        hide: vec![],
        argv: args(&["go", "test", "--", "./..."]),
      }
    );
    assert_eq!(parse_args(args(&["--network", "on", "--root", "/w", "--", "x"])).unwrap().fs, Fs::Worktree);
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
    let req = |root: &Path, fs| Request { network: false, fs, root: root.to_path_buf(), argv: args(&["x"]), ..empty() };
    let p = resolve(&req(tmp.path(), Fs::Worktree), Some(OsStr::new("/nonexistent-home")), None, None).unwrap();
    assert_eq!(p.writable[0], std::fs::canonicalize(tmp.path()).unwrap());
    assert!(resolve(&req(&tmp.path().join("missing"), Fs::Worktree), None, None, None).is_err());
    assert!(resolve(&req(Path::new("/"), Fs::Home), None, None, None).is_err());
    assert!(resolve(&req(tmp.path(), Fs::Worktree), Some(tmp.path().as_os_str()), None, None).is_err(), "home as the worktree root");
  }

  fn empty() -> Request {
    Request {
      network: false,
      fs: Fs::Worktree,
      root: PathBuf::from("/w"),
      secrets: vec![],
      keep: vec![],
      protect: vec![],
      hosts: vec![],
      read: vec![],
      write: vec![],
      exec: vec![],
      env: vec![],
      secrets_file: None,
      secrets_once: false,
      hide: vec![],
      argv: args(&["x"]),
    }
  }

  #[test]
  fn parses_the_scope_arguments() {
    let r = parse_args(args(&[
      "--network", "on", "--root", "/w", "--host", "a.com", "--read", "~/.cargo", "--write", "/opt/c", "--exec", "go", "--env", "GOPATH", "--secrets-file-once", "/s/x.json", "--hide",
      "/s", "--", "go",
    ]))
    .unwrap();
    assert_eq!((r.hosts, r.read, r.write, r.exec, r.env), (args(&["a.com"]), args(&["~/.cargo"]), args(&["/opt/c"]), args(&["go"]), args(&["GOPATH"])));
    assert_eq!((r.secrets_file, r.secrets_once, r.hide), (Some("/s/x.json".into()), true, vec![PathBuf::from("/s")]));
    for bad in [
      &["--network", "off", "--root", "/w", "--host", "a.com", "--", "x"][..],
      &["--network", "on", "--root", "/w", "--read", "rel", "--", "x"],
      &["--network", "on", "--root", "/w", "--secrets-file", "rel.json", "--", "x"],
      &["--network", "on", "--root", "/w", "--hide", "rel", "--", "x"],
    ] {
      assert!(parse_args(args(bad)).is_err(), "{bad:?}");
    }
  }

  #[test]
  fn scopes_in_the_profile() {
    let mut p = sample(true, Fs::Worktree);
    p.proxy_port = Some(4321);
    p.home_reads = Some(("/Users/me".into(), vec!["/Users/me/proj/repo".into(), "/Users/me/.cargo".into()]));
    p.exec = Some(vec!["/usr/bin/make".into()]);
    p.hidden = vec!["/Users/me/Library/Caches/kingu/snap-secrets".into()];
    let s = macos_profile(&p).unwrap();
    assert!(s.contains("(deny network*)"));
    assert!(s.contains(r#"(allow network-outbound (remote ip "localhost:4321"))"#));
    assert!(s.contains(r#"(deny file-read* (subpath "/Users/me"))
(allow file-read* (subpath "/Users/me/proj/repo") (subpath "/Users/me/.cargo") (literal "/usr/bin/make"))"#));
    assert!(s.contains(r#"(allow file-read-metadata (literal "/Users/me/proj") (literal "/Users/me"))"#));
    assert!(s.contains("(deny process-exec)\n(allow process-exec (literal \"/usr/bin/make\"))"));
    // Hidden comes last, so nothing re-allows it.
    assert!(s.trim_end().ends_with(r#"(deny file-read* file-write* (subpath "/Users/me/Library/Caches/kingu/snap-secrets"))"#));
    let bw = bwrap_argv(Path::new("/usr/bin/bwrap"), &p, &args(&["x"])).unwrap();
    assert!(bw.contains(&"--unshare-net".to_string()), "a host list means no network under bwrap");
  }

  #[test]
  fn resolve_expands_the_scopes() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    let root = home.join("proj");
    std::fs::create_dir_all(&root).unwrap();
    let home_c = std::fs::canonicalize(&home).unwrap();
    let req = Request { root: root.clone(), read: args(&["~/.cargo"]), write: args(&["~/.cache/go"]), exec: args(&["/bin/sh"]), hide: vec![tmp.path().join("secrets")], argv: args(&["/usr/bin/true"]), ..empty() };
    let p = resolve(&req, Some(home.as_os_str()), None, None).unwrap();
    assert!(p.writable.contains(&home_c.join(".cache/go")));
    let (h, allow) = p.home_reads.clone().unwrap();
    assert_eq!(h, home_c);
    assert!(allow.contains(&home_c.join("proj")) && allow.contains(&home_c.join(".cargo")) && allow.contains(&home_c.join(".cache/go")));
    let exec = p.exec.clone().unwrap();
    assert!(exec.contains(&"/bin/sh".into()) && exec.contains(&"/usr/bin/true".into()));
    if cfg!(target_os = "macos") {
      assert!(exec.contains(&"/bin/bash".into()), "sh runs bash on macOS");
    }
    assert_eq!(p.hidden.len(), 1);
    let too_broad = Request { root, write: args(&["~/"]), ..empty() };
    assert!(resolve(&Request { write: args(&["/"]), ..too_broad.clone() }, Some(home.as_os_str()), None, None).is_err());
  }

  #[test]
  fn exec_allow_follows_shebangs() {
    let tmp = tempfile::tempdir().unwrap();
    let script = tmp.path().join("tool");
    std::fs::write(&script, "#!/usr/bin/env python3 -u\nprint(1)\n").unwrap();
    let path = std::ffi::OsString::from("/usr/bin:/bin");
    let allow = exec_allow(&[script.display().to_string()], Some(&path));
    assert!(allow.contains(&script));
    assert!(allow.contains(&"/usr/bin/env".into()));
    if Path::new("/usr/bin/python3").exists() {
      assert!(allow.contains(&"/usr/bin/python3".into()));
    }
  }

  #[test]
  fn env_allow_list_keeps_the_base_and_the_declared() {
    let vars = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (OsString::from(k), OsString::from(v))).collect::<Vec<_>>();
    let all = vars(&[("PATH", "/bin"), ("HOME", "/h"), ("LC_ALL", "C"), ("GOPATH", "/g"), ("EDITOR", "vi"), ("API_TOKEN", "t"), ("KEEP", "k")]);
    let names = |v: Vec<(OsString, OsString)>| v.into_iter().map(|(k, _)| k.into_string().unwrap()).collect::<Vec<_>>();
    assert_eq!(names(filter_env_only(all.clone(), true, &args(&["API_TOKEN"]), &args(&["KEEP"]), &args(&["GOPATH"]))), ["PATH", "HOME", "LC_ALL", "GOPATH", "API_TOKEN", "KEEP"]);
    assert_eq!(names(filter_env_only(all, true, &[], &[], &[])), ["PATH", "HOME", "LC_ALL", "GOPATH", "EDITOR", "KEEP"]);
  }

  #[cfg(unix)]
  #[test]
  fn secrets_file_is_private_and_declared_only() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::tempdir().unwrap();
    let f = tmp.path().join("s.json");
    std::fs::write(&f, r#"{"API_KEY":"v1","OTHER":"v2"}"#).unwrap();
    std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(read_secrets(&f, &args(&["API_KEY"]), false).unwrap_err().contains("0600"));
    std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(read_secrets(&f, &args(&["API_KEY"]), false).unwrap(), vec![("API_KEY".to_string(), "v1".to_string())]);
    assert!(f.exists());
    read_secrets(&f, &args(&["API_KEY"]), true).unwrap();
    assert!(!f.exists(), "a task's secrets file is gone once read");
    std::fs::write(&f, "not json v1").unwrap();
    std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o600)).unwrap();
    let e = read_secrets(&f, &[], false).unwrap_err();
    assert!(!e.contains("v1"), "errors never echo the file");
  }

  /// Runs `argv` under the profile of `p` with the real sandbox-exec; true when it exits 0.
  #[cfg(target_os = "macos")]
  fn runs(p: &Policy, argv: &[&str]) -> bool {
    let argv = macos_argv(p, &args(argv)).unwrap();
    std::process::Command::new(&argv[0]).args(&argv[1..]).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().unwrap().success()
  }

  /// These run the real `sandbox-exec` (skipped when this process is already sandboxed, where
  /// nesting is refused).
  #[cfg(target_os = "macos")]
  #[test]
  fn sandbox_exec_enforces_the_scopes() {
    let tmp = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(tmp.path()).unwrap();
    let home = base.join("home");
    let root = home.join("proj");
    let secret = home.join(".ssh/id");
    let hidden = base.join("hidden");
    for d in [&root, &secret.parent().unwrap().to_path_buf(), &home.join(".cargo"), &hidden] {
      std::fs::create_dir_all(d).unwrap();
    }
    std::fs::write(&secret, "key").unwrap();
    std::fs::write(home.join(".cargo/config"), "ok").unwrap();
    std::fs::write(hidden.join("s.json"), "{}").unwrap();
    let plain = policy(true, Fs::Worktree, &root, Some(&home), &[], &[], &[]);
    if !runs(&plain, &["/usr/bin/true"]) {
      eprintln!("sandbox-exec cannot run here (nested sandbox?); skipping");
      return;
    }
    // Reads: unconfined by default, confined to the declared folders with a read list.
    let cat = |p: &Policy, f: &Path| runs(p, &["/bin/cat", f.to_str().unwrap()]);
    assert!(cat(&plain, &secret));
    let mut reads = plain.clone();
    reads.home_reads = Some((home.clone(), vec![root.clone(), home.join(".cargo")]));
    assert!(!cat(&reads, &secret));
    assert!(cat(&reads, &home.join(".cargo/config")));
    // Hidden folders.
    let mut hide = plain.clone();
    hide.hidden = vec![hidden.clone()];
    assert!(cat(&plain, &hidden.join("s.json")) && !cat(&hide, &hidden.join("s.json")));
    // Programs: only the allowed ones start.
    let mut exec = plain.clone();
    exec.exec = Some(exec_allow(&args(&["/bin/sh"]), None));
    assert!(runs(&exec, &["/bin/sh", "-c", "exit 0"]));
    assert!(!runs(&exec, &["/bin/sh", "-c", "/bin/ls / && exit 0"]));
    exec.exec = Some(exec_allow(&args(&["/bin/sh", "/bin/ls"]), None));
    assert!(runs(&exec, &["/bin/sh", "-c", "/bin/ls / && exit 0"]));
    // Writes outside the root.
    assert!(!runs(&plain, &["/usr/bin/touch", home.join("x").to_str().unwrap()]));
    assert!(runs(&plain, &["/usr/bin/touch", root.join("x").to_str().unwrap()]));
  }
}
