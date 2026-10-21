//! `kingu-ptyd --dir <private dir> [--name <socket>] [--idle-minutes N]`: started (detached) by
//! the app; see `kingu_ptyd::server`. `kingu-ptyd snap-exec … -- <argv>` runs a Snap task or
//! MCP server confined to its declared permissions; see `kingu_ptyd::sandbox`. `kingu-ptyd
//! snap-secret …` stores a Snap's secrets in the keychain; see `kingu_ptyd::secrets`.

#[cfg(unix)]
fn main() {
  use kingu_ptyd::{sandbox, secrets, server};
  if std::env::args().nth(1).as_deref() == Some(sandbox::SUBCOMMAND) {
    eprintln!("kingu: {}", sandbox::exec(std::env::args().skip(2)));
    std::process::exit(126);
  }
  if std::env::args().nth(1).as_deref() == Some(secrets::SUBCOMMAND) {
    let args: Vec<String> = std::env::args().skip(2).collect();
    let stdin = || std::io::read_to_string(std::io::stdin());
    match secrets::run(&secrets::Keychain, &args, stdin) {
      Ok(out) => print!("{out}"),
      Err(e) => {
        eprintln!("kingu: {e}");
        std::process::exit(1);
      }
    }
    return;
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
