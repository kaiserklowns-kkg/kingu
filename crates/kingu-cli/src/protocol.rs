//! The wire format, as old Kingu's runtime socket: one JSON object per line each way.
//! A request is `{"id", "authToken", "method", "params"}`; the answer has the same `id` and
//! either `"ok": true, "result"` or `"ok": false, "error": {"code", "message"}`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Requests and answers longer than this are refused (a prompt is at most 64 KB).
pub const MAX_LINE: usize = 256 * 1024;

pub const METHOD_STATUS: &str = "status";
pub const METHOD_TASK_LIST: &str = "task.list";
pub const METHOD_TASK_CREATE: &str = "task.create";
pub const METHOD_TASK_OPEN: &str = "task.open";
pub const METHOD_OPEN: &str = "open";
pub const METHOD_NOTIFY: &str = "notify";
pub const METHOD_ARTIFACT_PUBLISH: &str = "artifact.publish";
pub const METHOD_ARTIFACT_LIST: &str = "artifact.list";
/// OpenCode / Devin managed data accounts (Orca's `accounts.*Data` methods).
pub const METHOD_ACCOUNT_LIST_DATA: &str = "accounts.listData";
pub const METHOD_ACCOUNT_ADD_DATA: &str = "accounts.addDataFromHome";
pub const METHOD_ACCOUNT_SELECT_DATA: &str = "accounts.selectData";
pub const METHOD_ACCOUNT_REMOVE_DATA: &str = "accounts.removeData";
/// `kingu [options] [paths…]`: opens files, folders, a diff or a merge; with `wait` the answer
/// holds a `waitId` that `editor.wait` blocks on until the editors (or their window) close.
pub const METHOD_EDITOR_OPEN: &str = "editor.open";
pub const METHOD_EDITOR_WAIT: &str = "editor.wait";

/// Error codes. `unauthorized`: missing or wrong token; `bad_request`: unreadable line or bad
/// params; `unknown_method`; `unavailable`: the window did not answer; `failed`: the app refused.
pub const ERR_UNAUTHORIZED: &str = "unauthorized";
pub const ERR_BAD_REQUEST: &str = "bad_request";
pub const ERR_UNKNOWN_METHOD: &str = "unknown_method";
pub const ERR_UNAVAILABLE: &str = "unavailable";
pub const ERR_FAILED: &str = "failed";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Request {
  pub id: u64,
  #[serde(rename = "authToken", default)]
  pub auth_token: String,
  pub method: String,
  #[serde(default)]
  pub params: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RpcError {
  pub code: String,
  pub message: String,
}

impl RpcError {
  pub fn new(code: &str, message: impl Into<String>) -> Self {
    Self { code: code.to_owned(), message: message.into() }
  }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Response {
  pub id: u64,
  pub ok: bool,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub result: Option<Value>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub error: Option<RpcError>,
}

impl Response {
  pub fn ok(id: u64, result: Value) -> Self {
    Self { id, ok: true, result: Some(result), error: None }
  }

  pub fn err(id: u64, error: RpcError) -> Self {
    Self { id, ok: false, result: None, error: Some(error) }
  }
}

/// One line: the JSON and a newline.
pub fn encode<T: Serialize>(v: &T) -> String {
  let mut s = serde_json::to_string(v).unwrap_or_else(|_| "{}".into());
  s.push('\n');
  s
}

pub fn decode_request(line: &str) -> Result<Request, RpcError> {
  if line.len() > MAX_LINE {
    return Err(RpcError::new(ERR_BAD_REQUEST, "request too large"));
  }
  serde_json::from_str(line.trim_end()).map_err(|e| RpcError::new(ERR_BAD_REQUEST, format!("unreadable request: {e}")))
}

pub fn decode_response(line: &str) -> Result<Response, String> {
  serde_json::from_str(line.trim_end()).map_err(|e| format!("unreadable answer from Kingu: {e}"))
}

/// Compares in time independent of where the strings differ (the length is not secret).
pub fn tokens_equal(a: &str, b: &str) -> bool {
  let (a, b) = (a.as_bytes(), b.as_bytes());
  if a.len() != b.len() {
    return false;
  }
  a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// A token is 64 lowercase hex digits (32 random bytes).
pub fn valid_token(t: &str) -> bool {
  t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// 32 bytes from the OS random source, as hex.
pub fn new_token() -> Result<String, String> {
  let mut bytes = [0u8; 32];
  fill_random(&mut bytes)?;
  Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(unix)]
fn fill_random(buf: &mut [u8]) -> Result<(), String> {
  use std::io::Read;
  std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(buf)).map_err(|e| format!("/dev/urandom: {e}"))
}

/// Elsewhere (the server runs on Unix only): std's hasher keys, which come from the OS generator.
#[cfg(not(unix))]
fn fill_random(buf: &mut [u8]) -> Result<(), String> {
  use std::hash::{BuildHasher, Hasher};
  for (i, chunk) in buf.chunks_mut(8).enumerate() {
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_usize(i);
    chunk.copy_from_slice(&h.finish().to_le_bytes()[..chunk.len()]);
  }
  Ok(())
}

/// The server's handling of one request line, without the transport: checks the token first
/// (nothing else is looked at without it), then hands the request to `dispatch`.
pub fn handle_line(line: &str, token: &str, dispatch: impl FnOnce(&Request) -> Result<Value, RpcError>) -> Response {
  let req = match decode_request(line) {
    Ok(r) => r,
    Err(e) => return Response::err(0, e),
  };
  if req.auth_token.is_empty() || !tokens_equal(&req.auth_token, token) {
    return Response::err(req.id, RpcError::new(ERR_UNAUTHORIZED, "missing or wrong token"));
  }
  match dispatch(&req) {
    Ok(v) => Response::ok(req.id, v),
    Err(e) => Response::err(req.id, e),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  #[test]
  fn requests_and_answers_round_trip_as_single_lines() {
    let req = Request { id: 7, auth_token: TOKEN.into(), method: METHOD_TASK_CREATE.into(), params: json!({ "title": "แก้ login\nบน Safari" }) };
    let line = encode(&req);
    assert!(line.ends_with('\n') && line.matches('\n').count() == 1);
    assert!(line.contains("\"authToken\""));
    assert_eq!(decode_request(&line).unwrap(), req);
    let ok = Response::ok(7, json!({ "slug": "fix-login" }));
    assert_eq!(decode_response(&encode(&ok)).unwrap(), ok);
    let err = Response::err(7, RpcError::new(ERR_FAILED, "no folder"));
    let line = encode(&err);
    assert!(!line.contains("result"));
    assert_eq!(decode_response(&line).unwrap(), err);
    // Params are optional.
    assert_eq!(decode_request(r#"{"id":1,"authToken":"x","method":"status"}"#).unwrap().params, Value::Null);
    assert!(decode_request("not json").is_err());
    assert!(decode_request(&" ".repeat(MAX_LINE + 1)).is_err());
  }

  #[test]
  fn refuses_requests_without_the_right_token_before_dispatching() {
    let mut called = 0;
    let line = |t: &str| encode(&Request { id: 3, auth_token: t.into(), method: METHOD_STATUS.into(), params: Value::Null });
    for bad in ["", "wrong", &TOKEN[..63], &format!("{}0", &TOKEN[..63]), &TOKEN.to_uppercase()] {
      let r = handle_line(&line(bad), TOKEN, |_| {
        called += 1;
        Ok(json!(1))
      });
      assert_eq!((r.id, r.ok, r.error.unwrap().code.as_str()), (3, false, ERR_UNAUTHORIZED), "{bad}");
    }
    let r = handle_line(r#"{"id":4,"method":"status"}"#, TOKEN, |_| {
      called += 1;
      Ok(json!(1))
    });
    assert_eq!(r.error.unwrap().code, ERR_UNAUTHORIZED);
    assert_eq!(called, 0);
    let r = handle_line(&line(TOKEN), TOKEN, |req| Ok(json!({ "method": req.method })));
    assert_eq!((r.ok, r.result), (true, Some(json!({ "method": "status" }))));
    let r = handle_line(&line(TOKEN), TOKEN, |_| Err(RpcError::new(ERR_UNKNOWN_METHOD, "x")));
    assert_eq!(r.error.unwrap().code, ERR_UNKNOWN_METHOD);
    assert_eq!(handle_line("{", TOKEN, |_| Ok(json!(1))).error.unwrap().code, ERR_BAD_REQUEST);
  }

  #[test]
  fn tokens_are_random_hex_and_compare_exactly() {
    let (a, b) = (new_token().unwrap(), new_token().unwrap());
    assert!(valid_token(&a) && valid_token(&b) && a != b);
    assert!(!valid_token("abc") && !valid_token(&TOKEN.to_uppercase()));
    assert!(tokens_equal(TOKEN, TOKEN));
    assert!(!tokens_equal(TOKEN, &TOKEN[1..]) && !tokens_equal("a", "b"));
  }
}
