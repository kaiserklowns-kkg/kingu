//! A snap's language server (`[lsp.<key>]`, snap_contrib.rs), started like the built-in ones
//! (lsp.rs): the same binary lookup (PATH, the usual tool folders, a trusted folder's
//! `node_modules/.bin`, `KINGU_LSP_<KEY>`), the same "Not installed" error and install commands,
//! the same process handling. The webview expands `${setting:…}` and passes the argv and env it
//! will run; Rust lists the snap again and only starts a server an active snap declares, with
//! its declared program and environment names.
//!
//! - Built-in snaps' servers (rust-analyzer) are lsp.rs's table rows (snap_builtin.rs) and start
//!   unconfined, exactly as before.
//! - A user or repo snap's server runs under `kingu-ptyd snap-exec` with the snap's permissions
//!   when the sandbox is on (`kingu.snaps.sandbox`, decided by the webview as for tasks).
//! - A repo snap's server never starts in Restricted Mode (an untrusted folder's servers stay off,
//!   as VS Code disables extensions there).

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri::{AppHandle, Manager};

use crate::i18n::msg::SnapContribMsg;
use crate::lsp::{self, InstallMethod, Launch, LspEvent, Servers};
use crate::snap::{self, Permissions, SnapInfo, Source, TrustData};
use crate::snap_contrib::{InstallTool, LspServer};
use crate::tr;
use crate::workspace::Workspace;

/// Which snap server to run and how (`snap` of `lsp_start`, `lsp_check`, `lsp_install_methods`).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SnapServerRef {
  pub source: Source,
  pub id: String,
  pub server: String,
  /// The command with `${setting:…}` expanded (snapModel.expandArgv).
  #[serde(default)]
  pub argv: Vec<String>,
  #[serde(default)]
  pub env: BTreeMap<String, String>,
  /// Run under the snap sandbox (the webview's plan is `enforce`).
  #[serde(default)]
  pub sandbox: bool,
}

/// A user or repo snap's server, checked against its manifest.
#[derive(Debug, PartialEq)]
pub struct Resolved {
  /// `<snap id>/<server key>`, for `KINGU_LSP_<KEY>`.
  pub key: String,
  pub display: String,
  pub program: String,
  pub args: Vec<String>,
  pub env: BTreeMap<String, String>,
  pub install: Vec<(InstallTool, String)>,
  pub permissions: Permissions,
}

fn installers(tool: InstallTool) -> lsp::Installers {
  match tool {
    InstallTool::Npm => lsp::NPM,
    InstallTool::Go => lsp::GO,
    InstallTool::Rustup => lsp::RUSTUP,
    InstallTool::Brew => lsp::BREW,
    InstallTool::Pytool => lsp::PYTOOL,
    InstallTool::Cargo => lsp::CARGO,
    InstallTool::Pip => lsp::PIP,
  }
}

/// Checks `r` against snap `snap` (already found in the listing): active, allowed here, the server
/// declared, its program the declared one unless that comes from a setting, its env names declared.
pub fn check_ref(snap: &SnapInfo, trusted_workspace: bool, r: &SnapServerRef) -> Result<Resolved, String> {
  if snap.error.is_some() || !snap.trusted || snap.overridden {
    return Err(tr!(SnapContribMsg::SnapInactive, id = snap.id));
  }
  let server: &LspServer = snap.contributes.lsp.iter().find(|s| s.key == r.server).ok_or_else(|| tr!(SnapContribMsg::NoSuchServer, id = snap.id, key = r.server))?;
  if snap.source == Source::Repo && !trusted_workspace {
    return Err(tr!(SnapContribMsg::RestrictedMode, name = server.name));
  }
  let template = &server.command[0];
  let program = r.argv.first().filter(|p| !p.trim().is_empty()).ok_or_else(|| tr!(SnapContribMsg::LspNoCommand, key = server.key))?;
  if !template.contains("${") && program != template {
    return Err(tr!(SnapContribMsg::ProgramMismatch, key = server.key));
  }
  if let Some(var) = r.env.keys().find(|k| !server.env.contains_key(*k)) {
    return Err(tr!(SnapContribMsg::EnvUndeclared, key = server.key, var));
  }
  Ok(Resolved {
    key: format!("{}/{}", snap.id, server.key),
    display: server.name.clone(),
    program: program.clone(),
    args: r.argv[1..].to_vec(),
    env: r.env.clone(),
    install: server.install.iter().map(|h| (h.tool, h.package.clone())).collect(),
    permissions: snap.permissions.clone(),
  })
}

/// The snap of `r` among the user and repo snaps of the open folder.
fn find_snap(app: &AppHandle, ws: &Workspace, r: &SnapServerRef) -> Result<SnapInfo, String> {
  let config = snap::config_dir(app)?;
  let trust = TrustData::load(&config.join(snap::TRUST_FILE));
  snap::discover(&config.join(snap::USER_DIR), ws.current().as_deref(), &trust)
    .into_iter()
    .find(|s| s.source == r.source && s.id == r.id)
    .ok_or_else(|| tr!(SnapContribMsg::SnapNotFound, id = r.id))
}

enum Server {
  Builtin(lsp::ServerSpec),
  Snap(Resolved),
}

fn server_of(app: &AppHandle, ws: &Workspace, r: &SnapServerRef) -> Result<Server, String> {
  if r.source == Source::Builtin {
    return crate::snap_builtin::server(&r.id, &r.server).map(|s| Server::Builtin(s.spec.clone())).ok_or_else(|| tr!(SnapContribMsg::NoSuchServer, id = r.id, key = r.server));
  }
  let snap = find_snap(app, ws, r)?;
  let trusted = crate::workspace_trust::ws_trusted(crate::system::config_dir(), ws);
  check_ref(&snap, trusted, r).map(Server::Snap)
}

fn resolve_program(s: &Resolved, roots: &[PathBuf]) -> Result<PathBuf, String> {
  let home = std::env::var_os("HOME").map(PathBuf::from);
  let var = lsp::override_var_of(&s.key);
  lsp::resolve_named(&s.display, &[s.program.as_str()], &var, std::env::var_os(&var), crate::shell_env::path().as_deref(), home.as_deref(), roots)
}

/// `launcher snap-exec … -- program args` (mirrors snapModel.sandboxedArgv): the snap's network
/// and file access, its declared secrets, the env it sets kept, the app's own folders protected.
pub fn sandboxed(launcher: &Path, p: &Permissions, root: &Path, protect: &[PathBuf], keep: &[String], program: &Path, args: &[String]) -> (PathBuf, Vec<String>) {
  let mut out: Vec<String> = vec!["snap-exec".into(), "--network".into(), if p.network { "on" } else { "off" }.into(), "--fs".into()];
  out.push(match p.fs {
    snap::FsAccess::Worktree => "worktree".into(),
    snap::FsAccess::Home => "home".into(),
  });
  out.extend(["--root".into(), root.to_string_lossy().into_owned()]);
  for s in &p.secrets {
    out.extend(["--secret".into(), s.clone()]);
  }
  for k in keep {
    out.extend(["--keep".into(), k.clone()]);
  }
  for d in protect {
    out.extend(["--protect".into(), d.to_string_lossy().into_owned()]);
  }
  out.push("--".into());
  out.push(program.to_string_lossy().into_owned());
  out.extend(args.iter().cloned());
  (launcher.to_path_buf(), out)
}

fn launcher_and_protect(app: &AppHandle) -> Result<(PathBuf, Vec<PathBuf>), String> {
  let exe_dir = std::env::current_exe().ok().and_then(|e| e.parent().map(PathBuf::from));
  let launcher = crate::pty::find_daemon(std::env::var_os("KINGU_PTYD"), exe_dir.as_deref())?;
  let paths = app.path();
  let mut protect: Vec<PathBuf> = [paths.app_config_dir(), paths.app_data_dir(), paths.app_cache_dir()].into_iter().flatten().collect();
  protect.dedup();
  Ok((launcher, protect))
}

/// `lsp_start` for a snap's server. `roots`: where a project-local binary may come from (none in
/// Restricted Mode).
pub fn start(app: &AppHandle, ws: &Workspace, servers: &Servers, cwd: &Path, roots: &[PathBuf], r: &SnapServerRef, on_event: tauri::ipc::Channel<LspEvent>) -> Result<u32, String> {
  let home = std::env::var_os("HOME").map(PathBuf::from);
  let launch = match server_of(app, ws, r)? {
    Server::Builtin(spec) => {
      let program = lsp::resolve_binary(&spec, std::env::var_os(lsp::override_name(&spec)), crate::shell_env::path().as_deref(), home.as_deref(), roots)?;
      let env = lsp::server_env(crate::shell_env::vars_os(), &program, home.as_deref());
      Launch { program, args: spec.args.iter().map(|s| s.to_string()).collect(), cwd: cwd.to_path_buf(), env }
    }
    Server::Snap(s) => {
      let program = resolve_program(&s, roots)?;
      let mut env = lsp::server_env(crate::shell_env::vars_os(), &program, home.as_deref());
      env.extend(s.env.iter().map(|(k, v)| (OsString::from(k), OsString::from(v))));
      let (program, args) = if r.sandbox {
        let (launcher, protect) = launcher_and_protect(app)?;
        let keep: Vec<String> = s.env.keys().cloned().collect();
        sandboxed(&launcher, &s.permissions, cwd, &protect, &keep, &program, &s.args)
      } else {
        (program, s.args.clone())
      };
      Launch { program, args, cwd: cwd.to_path_buf(), env }
    }
  };
  let shown = launch.program.display().to_string();
  let id = lsp::start_launch(servers, launch, on_event)?;
  log::info!("language server {id} started for snap {}/{}: {shown}", r.id, r.server);
  Ok(id)
}

/// `lsp_check` for a snap's server: the program's path, or the "Not installed" error.
pub fn check(app: &AppHandle, ws: &Workspace, roots: &[PathBuf], r: &SnapServerRef) -> Result<PathBuf, String> {
  let home = std::env::var_os("HOME").map(PathBuf::from);
  match server_of(app, ws, r)? {
    Server::Builtin(spec) => lsp::resolve_binary(&spec, std::env::var_os(lsp::override_name(&spec)), crate::shell_env::path().as_deref(), home.as_deref(), roots),
    Server::Snap(s) => resolve_program(&s, roots),
  }
}

/// What `lsp_install_methods` returns (lsp.rs `InstallInfo`, with owned names).
#[derive(serde::Serialize, Debug, PartialEq)]
pub struct InstallInfo {
  pub server: String,
  pub binary: String,
  pub methods: Vec<InstallMethod>,
}

pub fn install_methods(s: &Resolved, program: impl Fn(&str) -> Option<String>) -> Vec<InstallMethod> {
  lsp::install_commands(s.install.iter().map(|(tool, words)| (installers(*tool), words.as_str())), program)
}

/// `lsp_install_methods` for a snap's server.
pub fn install_info(app: &AppHandle, ws: &Workspace, roots: &[PathBuf], r: &SnapServerRef) -> Result<InstallInfo, String> {
  let program = lsp::tool_program(roots);
  Ok(match server_of(app, ws, r)? {
    Server::Builtin(spec) => InstallInfo { server: spec.display.to_string(), binary: spec.binaries[0].to_string(), methods: lsp::install_methods(&spec, program) },
    Server::Snap(s) => InstallInfo { methods: install_methods(&s, program), server: s.display, binary: s.program },
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::snap::read_snap;

  const ZIG: &str = r#"
id = "zig"
name = "Zig"
version = "1"

[permissions]
network = true

[[settings]]
key = "zlsPath"
type = "string"
default = "zls"

[lsp.zls]
name = "ZLS"
languages = ["zig"]
command = ["zls", "--stdio"]
env = { ZLS_LOG = "info" }
install = [{ tool = "brew", package = "zls" }, { tool = "npm", package = "zls-bin extra" }]

[lsp.custom]
name = "Custom"
languages = ["zig"]
command = ["${setting:zlsPath}"]
"#;

  fn snap(source: Source, trusted: bool) -> SnapInfo {
    let tmp = tempfile::tempdir().unwrap();
    let d = tmp.path().join("zig");
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(d.join("snap.toml"), ZIG).unwrap();
    let mut s = read_snap(&d, "zig", source, None, &TrustData::default());
    s.trusted = trusted;
    s
  }

  fn r(server: &str, argv: &[&str]) -> SnapServerRef {
    SnapServerRef { source: Source::User, id: "zig".into(), server: server.into(), argv: argv.iter().map(|s| s.to_string()).collect(), env: BTreeMap::new(), sandbox: false }
  }

  #[test]
  fn starts_only_what_an_active_snap_declares() {
    let user = snap(Source::User, true);
    let ok = check_ref(&user, false, &r("zls", &["zls", "--stdio"])).unwrap();
    assert_eq!((ok.key.as_str(), ok.display.as_str(), ok.program.as_str(), ok.args.as_slice()), ("zig/zls", "ZLS", "zls", ["--stdio".to_string()].as_slice()));
    assert!(check_ref(&user, true, &r("nope", &["zls"])).unwrap_err().contains("no language server \"nope\""));
    // The program is the declared one; only a setting may change it.
    assert!(check_ref(&user, true, &r("zls", &["/bin/sh", "-c", "x"])).unwrap_err().contains("does not match"));
    assert_eq!(check_ref(&user, true, &r("custom", &["/opt/zls/bin/zls"])).unwrap().program, "/opt/zls/bin/zls");
    assert!(check_ref(&user, true, &r("zls", &[])).unwrap_err().contains("has no command"));
    let mut with_env = r("zls", &["zls"]);
    with_env.env.insert("ZLS_LOG".into(), "debug".into());
    assert!(check_ref(&user, true, &with_env).is_ok());
    with_env.env.insert("LD_PRELOAD".into(), "/x.so".into());
    assert!(check_ref(&user, true, &with_env).unwrap_err().contains("LD_PRELOAD"));
  }

  #[test]
  fn inactive_snaps_and_untrusted_folders_start_nothing() {
    assert!(check_ref(&snap(Source::Repo, false), true, &r("zls", &["zls"])).unwrap_err().contains("not active"));
    let mut broken = snap(Source::User, true);
    broken.error = Some("x".into());
    assert!(check_ref(&broken, true, &r("zls", &["zls"])).unwrap_err().contains("not active"));
    let mut overridden = snap(Source::User, true);
    overridden.overridden = true;
    assert!(check_ref(&overridden, true, &r("zls", &["zls"])).is_err());
    // A trusted repo snap still needs a trusted folder (Restricted Mode).
    let repo = snap(Source::Repo, true);
    assert!(check_ref(&repo, false, &r("zls", &["zls"])).unwrap_err().contains("Restricted Mode"));
    assert!(check_ref(&repo, true, &r("zls", &["zls"])).is_ok());
    // A user snap is the user's own: it runs in Restricted Mode like a built-in server.
    assert!(check_ref(&snap(Source::User, true), false, &r("zls", &["zls"])).is_ok());
  }

  #[test]
  fn install_commands_match_the_built_in_table() {
    let s = check_ref(&snap(Source::User, true), true, &r("zls", &["zls"])).unwrap();
    let all = |t: &str| Some(t.to_string());
    let argvs: Vec<String> = install_methods(&s, all).iter().map(|m| m.argv.join(" ")).collect();
    assert_eq!(argvs, ["brew install zls", "bun add -g zls-bin extra", "npm i -g zls-bin extra"]);
    // The same installers as lsp.rs's packages.
    let ra = crate::snap_builtin::spec_for("rust").unwrap();
    let rows: Vec<(InstallTool, String)> = vec![(InstallTool::Rustup, "rust-analyzer".into()), (InstallTool::Brew, "rust-analyzer".into())];
    let snap_way = lsp::install_commands(rows.iter().map(|(t, w)| (installers(*t), w.as_str())), all);
    assert_eq!(snap_way, lsp::install_methods(&ra, all));
  }

  #[test]
  fn sandboxed_argv_mirrors_the_webview() {
    let p = Permissions { network: false, fs: snap::FsAccess::Home, secrets: vec!["TOKEN".into()] };
    let (prog, args) = sandboxed(Path::new("/A/kingu-ptyd"), &p, Path::new("/ws"), &[PathBuf::from("/cfg")], &["ZLS_LOG".into()], Path::new("/bin/zls"), &["--stdio".into()]);
    assert_eq!(prog, Path::new("/A/kingu-ptyd"));
    assert_eq!(
      args,
      ["snap-exec", "--network", "off", "--fs", "home", "--root", "/ws", "--secret", "TOKEN", "--keep", "ZLS_LOG", "--protect", "/cfg", "--", "/bin/zls", "--stdio"]
    );
  }

  #[test]
  fn override_variable_names() {
    assert_eq!(lsp::override_var_of("zig/zls"), "KINGU_LSP_ZIG_ZLS");
    assert_eq!(lsp::override_var_of("rust"), "KINGU_LSP_RUST");
  }
}
