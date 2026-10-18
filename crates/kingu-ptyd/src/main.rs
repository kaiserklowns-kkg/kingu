//! `kingu-ptyd --dir <private dir> [--name <socket>] [--idle-minutes N]`: started (detached) by
//! the app; see `kingu_ptyd::server`.

#[cfg(unix)]
fn main() {
  use kingu_ptyd::server;
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
  eprintln!("kingu-ptyd: not supported on this platform (terminals run inside the app)");
  std::process::exit(1);
}
