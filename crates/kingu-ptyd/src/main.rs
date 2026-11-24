//! `kingu-ptyd --dir <private dir> [--name <socket>] [--idle-minutes N]`: started (detached) by
//! the app; see `kingu_ptyd::server`. `kingu-ptyd snap-exec … -- <argv>` runs a Snap task or
//! MCP server confined to its declared permissions; see `kingu_ptyd::sandbox`.
//! `kingu-ptyd attach | sessions | end | host-info` use a daemon from a plain terminal (a session
//! on an SSH host shown through `ssh -t`); see `kingu_ptyd::attach`.

#[cfg(unix)]
fn main() {
  use kingu_ptyd::{sandbox, server};
  if std::env::args().nth(1).as_deref() == Some(sandbox::SUBCOMMAND) {
    eprintln!("kingu: {}", sandbox::exec(std::env::args().skip(2)));
    std::process::exit(126);
  }
  // Browser tools for an agent on an SSH host, relayed to Kingu's browser (kingu_ptyd::browser_relay).
  if std::env::args().nth(1).as_deref() == Some(kingu_ptyd::browser_relay::SUBCOMMAND) {
    std::process::exit(kingu_ptyd::browser_relay::run_mcp(std::env::args().skip(2)));
  }
  if std::env::args().nth(1).is_some_and(|a| kingu_ptyd::attach::is_subcommand(&a)) {
    let code = match kingu_ptyd::attach::parse(std::env::args().skip(1)) {
      Ok(command) => kingu_ptyd::attach::run(command, env!("CARGO_PKG_VERSION")),
      Err(e) => {
        eprintln!("kingu-ptyd: {e}");
        kingu_ptyd::attach::EXIT_USAGE
      }
    };
    std::process::exit(code);
  }
  let cfg = match server::parse_args(std::env::args().skip(1), env!("CARGO_PKG_VERSION")) {
    Ok(cfg) => cfg,
    Err(e) => {
      eprintln!("kingu-ptyd: {e}");
      std::process::exit(2);
    }
  };
  match server::run(&cfg) {
    Ok(_) => {}
    Err(e) => {
      server::log(e);
      std::process::exit(1);
    }
  }
}

#[cfg(not(unix))]
fn main() {
  if std::env::args().nth(1).as_deref() == Some(kingu_ptyd::sandbox::SUBCOMMAND) {
    eprintln!("kingu: this operating system does not support the Snap sandbox yet");
    std::process::exit(126);
  }
  eprintln!("kingu-ptyd: not supported on this platform (terminals run inside the app)");
  std::process::exit(1);
}
