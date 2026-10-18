//! Kingu's terminal host. PTY sessions (`session`) live either in the app process (Windows, or
//! when the daemon cannot start) or in `kingu-ptyd`, a per-user daemon the app talks to over a
//! Unix socket (`protocol`, `server`, `client`), so agent CLIs keep running after the app quits.

pub mod protocol;
pub mod session;

#[cfg(unix)]
pub mod client;
#[cfg(unix)]
pub mod peer;
#[cfg(unix)]
pub mod server;

pub use session::{Attached, Host, SessionInfo, ShellSpec, Sink, command_line, is_agent_session_marker, shell_quote, validate_key};
