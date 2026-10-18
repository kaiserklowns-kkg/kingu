//! Wire protocol between the app and `kingu-ptyd`: newline-delimited JSON frames over a Unix
//! socket. The client's first frame is `{"id":1,"hello":{…}}`; the daemon answers with its own
//! hello, and either side drops the connection when the other is incompatible. After that the
//! client sends requests (`{"id":N,"spawn":{…}}`), each answered by a reply with the same id;
//! id 0 means "no reply wanted" (keystrokes, resizes). The daemon also sends output events for
//! the sessions this connection is attached to, tagged with the `stream` the client picked when
//! attaching, so output still in flight from an older attach is never shown twice.

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
}

impl Hello {
  pub fn ours(app_version: &str) -> Self {
    Self { protocol: PROTOCOL, min_compatible: MIN_COMPATIBLE, app_version: app_version.to_string(), pid: std::process::id() }
  }
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
  },
  Write { key: String, data: String },
  Resize { key: String, cols: u16, rows: u16 },
  Kill { key: String },
  KillAll {},
  List {},
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
          stream: 7,
        },
      },
      ClientFrame { id: 3, request: Request::Attach { key: "k".into(), cols: None, rows: Some(3), stream: 8 } },
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
    let hello = String::from_utf8(encode(&ClientFrame { id: 1, request: Request::Hello(Hello { protocol: 1, min_compatible: 1, app_version: "0.1.0".into(), pid: 9 }) })).unwrap();
    assert_eq!(hello, "{\"id\":1,\"hello\":{\"protocol\":1,\"minCompatible\":1,\"appVersion\":\"0.1.0\",\"pid\":9}}\n");
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
    let v = |protocol, min_compatible| Hello { protocol, min_compatible, app_version: String::new(), pid: 0 };
    assert!(compatible(&v(1, 1), &v(1, 1)));
    // A newer peer that still accepts protocol 1.
    assert!(compatible(&v(1, 1), &v(3, 1)));
    // A newer peer that dropped protocol 1, and the same seen from its side.
    assert!(!compatible(&v(1, 1), &v(2, 2)));
    assert!(!compatible(&v(2, 2), &v(1, 1)));
    assert_eq!(socket_name(), format!("kingu-ptyd-{PROTOCOL}.sock"));
  }
}
