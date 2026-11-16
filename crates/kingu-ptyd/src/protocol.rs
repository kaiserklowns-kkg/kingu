//! Wire protocol between the app and `kingu-ptyd`: newline-delimited JSON frames over a Unix
//! socket. The client's first frame is `{"id":1,"hello":{…}}`; the daemon answers with its own
//! hello, and either side drops the connection when the other is incompatible. After that the
//! client sends requests (`{"id":N,"spawn":{…}}`), each answered by a reply with the same id;
//! id 0 means "no reply wanted" (keystrokes, resizes). The daemon also sends output events for
//! the sessions this connection is attached to, tagged with the `stream` the client picked when
//! attaching, so output still in flight from an older attach is never shown twice.
//!
//! Generation. Each daemon picks an `epoch` when it starts (its start time in microseconds, so it
//! fits a JavaScript number) and puts it in its hello and in every attach / spawn reply. A client
//! that re-attaches after its connection dropped sends the epoch it last saw: a different daemon
//! (restarted, or crashed and started again) refuses with [`STALE_ATTACH`], because a session of
//! the same key there is a new shell, not the one the client was showing. Epoch 0 means "unknown"
//! (a daemon or client from before generations) and is never refused. `status` and `shutdown`
//! exist only on daemons with an epoch; clients must not send them to one without (an older
//! daemon drops a connection on a request it cannot parse).

use std::collections::BTreeMap;
use std::io::{self, BufRead, Read};

use serde::{Deserialize, Serialize};

/// Bumped on any incompatible change. Part of the socket name, so a newer app starts its own
/// daemon and the older one keeps its sessions until it idles out.
pub const PROTOCOL: u32 = 1;
/// The oldest peer protocol this build still speaks.
pub const MIN_COMPATIBLE: u32 = 1;
/// Largest frame either side accepts (a big paste, a full scrollback replay).
pub const MAX_FRAME: usize = 16 << 20;

/// Prefix of the error a stale attach gets (the client then knows its session ended).
pub const STALE_ATTACH: &str = "stale-attach:";

pub fn socket_name() -> String {
  format!("kingu-ptyd-{PROTOCOL}.sock")
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
  pub protocol: u32,
  pub min_compatible: u32,
  pub app_version: String,
  #[serde(default)]
  pub pid: u32,
  /// The daemon's generation (see the module docs); 0 from clients and older daemons.
  #[serde(default, skip_serializing_if = "is_zero")]
  pub epoch: u64,
}

fn is_zero(n: &u64) -> bool {
  *n == 0
}

impl Hello {
  pub fn ours(app_version: &str) -> Self {
    Self { protocol: PROTOCOL, min_compatible: MIN_COMPATIBLE, app_version: app_version.to_string(), pid: std::process::id(), epoch: 0 }
  }
}

/// A fresh daemon generation: microseconds since the Unix epoch (unique per start on one socket,
/// whose lock admits one daemon at a time; below 2^53, so the webview keeps it exactly).
pub fn new_epoch() -> u64 {
  let micros = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_micros() as u64).unwrap_or(1);
  micros.max(1)
}

/// What `status` reports (Orca's `terminal-daemon status`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStatus {
  pub pid: u32,
  pub epoch: u64,
  pub protocol: u32,
  pub app_version: String,
  /// Unix seconds.
  pub started_at: u64,
  /// Sessions it holds, and how many of them still run.
  pub sessions: usize,
  pub alive: usize,
  /// Connected apps (this one included).
  pub clients: usize,
}

/// Both sides speak a protocol the other still accepts.
pub fn compatible(a: &Hello, b: &Hello) -> bool {
  a.protocol >= b.min_compatible && b.protocol >= a.min_compatible
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Request {
  Hello(Hello),
  /// Attach to `key` if it is live, else start a login shell in `cwd` (typing `run` once).
  Spawn {
    key: String,
    cwd: String,
    cols: u16,
    rows: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    run: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    env: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    shell: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    args: Option<Vec<String>>,
    /// Variables removed from the shell's environment (`terminal.integrated.env.*` set to null).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    unset: Vec<String>,
    /// Start from a minimal environment (`terminal.integrated.inheritEnv: false`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    clean_env: bool,
    stream: u64,
  },
  /// Attach to a live `key` only; the reply is null when there is none.
  Attach {
    key: String,
    #[serde(default)]
    cols: Option<u16>,
    #[serde(default)]
    rows: Option<u16>,
    stream: u64,
    /// The daemon generation the client last saw this session in; another one refuses with
    /// [`STALE_ATTACH`]. None (a first attach after the app started) attaches to whatever is there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    epoch: Option<u64>,
  },
  Write { key: String, data: String },
  Resize { key: String, cols: u16, rows: u16 },
  Kill { key: String },
  KillAll {},
  List {},
  /// [`DaemonStatus`].
  Status {},
  /// Kills every session and exits, when `epoch` is still this daemon's (a status read just
  /// before, so a restart never stops a daemon the user did not see). Replies with the count.
  Shutdown { epoch: u64 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClientFrame {
  pub id: u64,
  #[serde(flatten)]
  pub request: Request,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ServerFrame {
  /// `error` set: the request failed; else `ok` holds the result (null for none / not found).
  Reply {
    id: u64,
    #[serde(default)]
    ok: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
  },
  Output { key: String, stream: u64, data: String },
}

/// One frame: its JSON and a newline (JSON strings escape newlines, so a frame is one line).
pub fn encode<T: Serialize>(frame: &T) -> Vec<u8> {
  let mut out = serde_json::to_vec(frame).expect("frames serialize");
  out.push(b'\n');
  out
}

/// The next frame, `None` at a clean end of stream. A frame over `MAX_FRAME` or one that is not
/// valid JSON for `T` is an error (the connection is then dropped).
pub fn read_frame<T: for<'de> Deserialize<'de>>(reader: &mut impl BufRead) -> io::Result<Option<T>> {
  let mut line = Vec::new();
  let n = reader.by_ref().take(MAX_FRAME as u64 + 1).read_until(b'\n', &mut line)?;
  if n == 0 {
    return Ok(None);
  }
  if line.last() != Some(&b'\n') {
    let why = if line.len() > MAX_FRAME { "frame too large" } else { "truncated frame" };
    return Err(io::Error::new(io::ErrorKind::InvalidData, why));
  }
  serde_json::from_slice(&line).map(Some).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

#[cfg(test)]
mod tests {
  use std::io::Cursor;

  use super::*;

  #[test]
  fn requests_round_trip_with_their_id() {
    let frames = [
      ClientFrame { id: 1, request: Request::Hello(Hello::ours("0.1.0")) },
      ClientFrame {
        id: 2,
        request: Request::Spawn {
          key: "cli:ab12cd34:fix:1".into(),
          cwd: "/tmp".into(),
          cols: 80,
          rows: 24,
          run: Some(vec!["claude".into(), "แก้\nบั๊ก".into()]),
          env: Some(BTreeMap::from([("A".into(), "b".into())])),
          shell: Some("/bin/bash".into()),
          args: Some(vec!["--login".into()]),
          unset: vec!["OLDPWD".into()],
          clean_env: true,
          stream: 7,
        },
      },
      ClientFrame { id: 3, request: Request::Attach { key: "k".into(), cols: None, rows: Some(3), stream: 8, epoch: None } },
      ClientFrame { id: 6, request: Request::Attach { key: "k".into(), cols: None, rows: None, stream: 9, epoch: Some(1_700_000_000_000_000) } },
      ClientFrame { id: 7, request: Request::Status {} },
      ClientFrame { id: 8, request: Request::Shutdown { epoch: 5 } },
      ClientFrame { id: 0, request: Request::Write { key: "k".into(), data: "ls\r".into() } },
      ClientFrame { id: 4, request: Request::KillAll {} },
      ClientFrame { id: 5, request: Request::List {} },
    ];
    let mut wire = Vec::new();
    for f in &frames {
      wire.extend(encode(f));
    }
    let mut r = Cursor::new(wire);
    for f in &frames {
      assert_eq!(&read_frame::<ClientFrame>(&mut r).unwrap().unwrap(), f);
    }
    assert!(read_frame::<ClientFrame>(&mut r).unwrap().is_none());
  }

  #[test]
  fn wire_shape_is_plain_json() {
    let hello = String::from_utf8(encode(&ClientFrame { id: 1, request: Request::Hello(Hello { protocol: 1, min_compatible: 1, app_version: "0.1.0".into(), pid: 9, epoch: 0 }) })).unwrap();
    assert_eq!(hello, "{\"id\":1,\"hello\":{\"protocol\":1,\"minCompatible\":1,\"appVersion\":\"0.1.0\",\"pid\":9}}\n");
    // A daemon's hello carries its epoch; an older one's (without) reads as 0.
    let daemon: Hello = serde_json::from_str("{\"protocol\":1,\"minCompatible\":1,\"appVersion\":\"0.1.0\",\"pid\":9,\"epoch\":42}").unwrap();
    assert_eq!(daemon.epoch, 42);
    let old: Hello = serde_json::from_str("{\"protocol\":1,\"minCompatible\":1,\"appVersion\":\"0.1.0\",\"pid\":9}").unwrap();
    assert_eq!(old.epoch, 0);
    let attach: ClientFrame = serde_json::from_str("{\"id\":2,\"attach\":{\"key\":\"k\",\"stream\":1}}").unwrap();
    assert_eq!(attach.request, Request::Attach { key: "k".into(), cols: None, rows: None, stream: 1, epoch: None });
    assert!(new_epoch() < (1u64 << 53));
    let list: ClientFrame = serde_json::from_str("{\"id\":2,\"list\":{}}").unwrap();
    assert_eq!(list.request, Request::List {});
    let out = String::from_utf8(encode(&ServerFrame::Output { key: "k".into(), stream: 3, data: "a\nก".into() })).unwrap();
    assert_eq!(out, "{\"output\":{\"key\":\"k\",\"stream\":3,\"data\":\"a\\nก\"}}\n");
    let reply: ServerFrame = serde_json::from_str("{\"reply\":{\"id\":4}}").unwrap();
    assert_eq!(reply, ServerFrame::Reply { id: 4, ok: serde_json::Value::Null, error: None });
  }

  #[test]
  fn rejects_garbage_and_oversized_frames() {
    assert!(read_frame::<ClientFrame>(&mut Cursor::new(b"{nope}\n".to_vec())).is_err());
    assert!(read_frame::<ClientFrame>(&mut Cursor::new(b"{\"id\":1,\"bogus\":{}}\n".to_vec())).is_err());
    assert!(read_frame::<ClientFrame>(&mut Cursor::new(b"{\"id\":1".to_vec())).is_err());
    let mut big = vec![b' '; MAX_FRAME + 10];
    big.push(b'\n');
    assert!(read_frame::<ClientFrame>(&mut Cursor::new(big)).is_err());
  }

  #[test]
  fn handshake_compatibility() {
    let v = |protocol, min_compatible| Hello { protocol, min_compatible, app_version: String::new(), pid: 0, epoch: 0 };
    assert!(compatible(&v(1, 1), &v(1, 1)));
    // A newer peer that still accepts protocol 1.
    assert!(compatible(&v(1, 1), &v(3, 1)));
    // A newer peer that dropped protocol 1, and the same seen from its side.
    assert!(!compatible(&v(1, 1), &v(2, 2)));
    assert!(!compatible(&v(2, 2), &v(1, 1)));
    assert_eq!(socket_name(), format!("kingu-ptyd-{PROTOCOL}.sock"));
  }
}
