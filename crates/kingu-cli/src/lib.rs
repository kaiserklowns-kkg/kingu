//! The `kingu` command (old Kingu's / Orca's CLI): agents and scripts in a terminal list and start
//! tasks, open files and folders, post notifications and ask for the app's status. The running app
//! listens on a Unix socket in its data folder and writes a runtime file (owner-only) holding the
//! socket path and a random token; every request carries the token (`protocol`, `runtime`).

pub mod args;
pub mod client;
pub mod i18n;
pub mod login;
pub mod protocol;
pub mod runtime;
