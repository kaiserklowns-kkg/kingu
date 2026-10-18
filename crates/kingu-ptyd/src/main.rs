//! `kingu-ptyd --dir <private dir> [--name <socket>] [--idle-minutes N]`: started (detached) by
//! the app; see `kingu_ptyd::server`. `kingu-ptyd snap-exec … -- <argv>` runs a Snap task or
//! MCP server confined to its declared permissions; see `kingu_ptyd::sandbox`.

#[cfg(unix)]
fn main() {
  use kingu_ptyd::{sandbox, server};
  if std::env::args().nth(1).as_deref() == Some(sandbox::SUBCOMMAND) {
    eprintln!("kingu: {}", sandbox::exec(std::env::args().skip(2)));
    std::process::exit(126);
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
    eprintln!("kingu: ระบบปฏิบัติการนี้ยังไม่รองรับ sandbox ของ Snap");
    std::process::exit(126);
  }
  eprintln!("kingu-ptyd: not supported on this platform (terminals run inside the app)");
  std::process::exit(1);
}
