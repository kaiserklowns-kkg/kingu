//! The host filter of a Snap that declares `hosts`: a small HTTP proxy on 127.0.0.1 that the
//! launcher runs (outside the sandbox) for the confined command, which may reach nothing else
//! (see `sandbox`). It understands `CONNECT host:port` (HTTPS and anything tunnelled) and
//! absolute-form plain HTTP requests (`GET http://host/path`), checks the host against the
//! declared patterns and refuses everything else with 403. It never looks inside a tunnel.
//!
//! Patterns: `example.com` (that host), `*.example.com` (its subdomains, not itself), each with
//! an optional `:port`; without one, ports 80 and 443. IP addresses only match when declared
//! literally (the app's manifest check does not allow them; tests do).

use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream, ToSocketAddrs};
use std::time::Duration;

/// Request heads are small; a client sending more before the blank line is not a proxy client.
const MAX_HEAD: usize = 16 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// Whether `host:port` is allowed by `patterns`.
pub fn allowed(patterns: &[String], host: &str, port: u16) -> bool {
  let host = host.trim_end_matches('.').to_ascii_lowercase();
  patterns.iter().any(|p| {
    let (name, want) = match p.rsplit_once(':') {
      Some((n, port)) if !n.contains(':') => (n, port.parse::<u16>().ok()),
      _ => (p.as_str(), None),
    };
    let port_ok = match want {
      Some(w) => w == port,
      None => port == 80 || port == 443,
    };
    let name = name.to_ascii_lowercase();
    let host_ok = match name.strip_prefix("*.") {
      Some(base) => host.len() > base.len() + 1 && host.ends_with(base) && host.as_bytes()[host.len() - base.len() - 1] == b'.',
      None => host == name,
    };
    port_ok && host_ok
  })
}

/// `host:port` (or `[v6]:port`) of a CONNECT target.
pub fn split_authority(auth: &str, default_port: u16) -> Option<(String, u16)> {
  if let Some(rest) = auth.strip_prefix('[') {
    let (host, after) = rest.split_once(']')?;
    let port = match after.strip_prefix(':') {
      Some(p) => p.parse().ok()?,
      None if after.is_empty() => default_port,
      None => return None,
    };
    return Some((host.to_string(), port));
  }
  match auth.rsplit_once(':') {
    Some((h, p)) if !h.contains(':') => Some((h.to_string(), p.parse().ok()?)),
    Some(_) => None,
    None => Some((auth.to_string(), default_port)),
  }
  .filter(|(h, _)| !h.is_empty())
}

/// What a request head asks for.
#[derive(Debug, PartialEq)]
pub enum Target {
  /// `CONNECT host:port`: reply 200, then relay bytes.
  Tunnel { host: String, port: u16 },
  /// Absolute-form HTTP: forward the head with the request line in origin form.
  Http { host: String, port: u16, head: Vec<u8> },
}

/// Parses a request head (up to and including the blank line).
pub fn parse_head(head: &[u8]) -> Result<Target, String> {
  let text = std::str::from_utf8(head).map_err(|_| "request head is not text")?;
  let (line, rest) = text.split_once("\r\n").ok_or("no request line")?;
  let mut parts = line.split(' ');
  let (method, uri, version) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
  if !version.starts_with("HTTP/1.") || parts.next().is_some() {
    return Err("not an HTTP/1 request".into());
  }
  if method.eq_ignore_ascii_case("CONNECT") {
    let (host, port) = split_authority(uri, 443).ok_or("bad CONNECT target")?;
    return Ok(Target::Tunnel { host, port });
  }
  let after = uri.strip_prefix("http://").ok_or("only http:// URLs and CONNECT go through this proxy")?;
  let (auth, path) = match after.find('/') {
    Some(i) => (&after[..i], &after[i..]),
    None => (after, "/"),
  };
  if auth.contains('@') {
    return Err("credentials in the URL are refused".into());
  }
  let (host, port) = split_authority(auth, 80).ok_or("bad host")?;
  let head = format!("{method} {path} {version}\r\n{rest}").into_bytes();
  Ok(Target::Http { host, port, head })
}

fn read_head(stream: &mut TcpStream) -> Result<(Vec<u8>, Vec<u8>), String> {
  let mut buf = Vec::new();
  let mut chunk = [0u8; 4096];
  loop {
    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
      let extra = buf.split_off(i + 4);
      return Ok((buf, extra));
    }
    if buf.len() > MAX_HEAD {
      return Err("request head too large".into());
    }
    let n = stream.read(&mut chunk).map_err(|e| e.to_string())?;
    if n == 0 {
      return Err("closed".into());
    }
    buf.extend_from_slice(&chunk[..n]);
  }
}

fn refuse(stream: &mut TcpStream, why: &str) {
  let body = format!("Kingu Snap sandbox: {why}\n");
  let _ = write!(stream, "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
}

fn connect(host: &str, port: u16) -> Result<TcpStream, String> {
  let addrs = (host, port).to_socket_addrs().map_err(|e| e.to_string())?;
  let mut last = "no address".to_string();
  for a in addrs {
    match TcpStream::connect_timeout(&a, CONNECT_TIMEOUT) {
      Ok(s) => return Ok(s),
      Err(e) => last = e.to_string(),
    }
  }
  Err(last)
}

/// Copies both ways until either side closes.
fn relay(a: TcpStream, b: TcpStream) {
  let (Ok(a2), Ok(b2)) = (a.try_clone(), b.try_clone()) else { return };
  let up = std::thread::spawn(move || {
    let (mut from, mut to) = (a, b);
    let _ = std::io::copy(&mut from, &mut to);
    let _ = to.shutdown(Shutdown::Write);
  });
  let (mut from, mut to) = (b2, a2);
  let _ = std::io::copy(&mut from, &mut to);
  let _ = to.shutdown(Shutdown::Write);
  let _ = up.join();
}

fn serve(mut client: TcpStream, patterns: &[String]) {
  let Ok((head, extra)) = read_head(&mut client) else { return };
  let target = match parse_head(&head) {
    Ok(t) => t,
    Err(e) => return refuse(&mut client, &e),
  };
  let (host, port) = match &target {
    Target::Tunnel { host, port } | Target::Http { host, port, .. } => (host.clone(), *port),
  };
  if !allowed(patterns, &host, port) {
    return refuse(&mut client, &format!("{host}:{port} is not in the snap's permissions.hosts"));
  }
  let mut upstream = match connect(&host, port) {
    Ok(s) => s,
    Err(_) => {
      let _ = write!(client, "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
  };
  match target {
    Target::Tunnel { .. } => {
      if client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").is_err() {
        return;
      }
    }
    Target::Http { head, .. } => {
      // A keep-alive client could send the next request to another host down this connection.
      if upstream.write_all(&head).is_err() {
        return;
      }
    }
  }
  if !extra.is_empty() && upstream.write_all(&extra).is_err() {
    return;
  }
  relay(client, upstream);
}

/// A running proxy: the port it listens on (127.0.0.1).
pub struct Proxy {
  pub port: u16,
}

/// Starts the proxy for `patterns` on a free port; it serves until the process exits.
pub fn start(patterns: Vec<String>) -> Result<Proxy, String> {
  let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("host filter: {e}"))?;
  let port = listener.local_addr().map_err(|e| e.to_string())?.port();
  std::thread::spawn(move || {
    let patterns = std::sync::Arc::new(patterns);
    for conn in listener.incoming().flatten() {
      let patterns = patterns.clone();
      std::thread::spawn(move || serve(conn, &patterns));
    }
  });
  Ok(Proxy { port })
}

/// The proxy variables a confined command gets (curl, git, npm, pip, go and most HTTP clients
/// read one of them); `NO_PROXY` is dropped so nothing bypasses it.
pub fn proxy_env(port: u16) -> Vec<(String, String)> {
  let url = format!("http://127.0.0.1:{port}");
  ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].iter().map(|k| (k.to_string(), url.clone())).collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  fn pats(p: &[&str]) -> Vec<String> {
    p.iter().map(|s| s.to_string()).collect()
  }

  #[test]
  fn host_patterns() {
    let p = pats(&["api.github.com", "*.npmjs.org", "example.com:8443"]);
    assert!(allowed(&p, "api.github.com", 443));
    assert!(allowed(&p, "API.GitHub.com.", 80));
    assert!(!allowed(&p, "api.github.com", 22));
    assert!(!allowed(&p, "evilapi.github.com", 443));
    assert!(allowed(&p, "registry.npmjs.org", 443));
    assert!(!allowed(&p, "npmjs.org", 443), "*. means subdomains");
    assert!(!allowed(&p, "xnpmjs.org", 443));
    assert!(allowed(&p, "example.com", 8443));
    assert!(!allowed(&p, "example.com", 443));
    assert!(!allowed(&[], "a.com", 443));
  }

  #[test]
  fn request_heads() {
    assert_eq!(parse_head(b"CONNECT api.github.com:443 HTTP/1.1\r\nHost: x\r\n\r\n").unwrap(), Target::Tunnel { host: "api.github.com".into(), port: 443 });
    assert_eq!(parse_head(b"CONNECT [::1]:8080 HTTP/1.1\r\n\r\n").unwrap(), Target::Tunnel { host: "::1".into(), port: 8080 });
    match parse_head(b"GET http://a.com:8080/x?y HTTP/1.1\r\nHost: a.com\r\n\r\n").unwrap() {
      Target::Http { host, port, head } => {
        assert_eq!((host.as_str(), port), ("a.com", 8080));
        assert_eq!(head, b"GET /x?y HTTP/1.1\r\nHost: a.com\r\n\r\n");
      }
      t => panic!("{t:?}"),
    }
    assert!(parse_head(b"GET /x HTTP/1.1\r\n\r\n").is_err(), "origin-form is not a proxy request");
    assert!(parse_head(b"GET http://u:p@a.com/ HTTP/1.1\r\n\r\n").is_err());
    assert!(parse_head(b"GET ftp://a.com/ HTTP/1.1\r\n\r\n").is_err());
    assert!(parse_head(b"CONNECT a.com:x HTTP/1.1\r\n\r\n").is_err());
  }

  /// A local upstream; the proxy lets the declared one through and refuses another.
  #[test]
  fn tunnels_only_to_declared_hosts() {
    let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let up_port = upstream.local_addr().unwrap().port();
    std::thread::spawn(move || {
      for mut c in upstream.incoming().flatten() {
        let mut b = [0u8; 5];
        if c.read_exact(&mut b).is_ok() {
          let _ = c.write_all(&b);
        }
      }
    });
    let proxy = start(pats(&[&format!("127.0.0.1:{up_port}")])).unwrap();
    let ask = |target: &str| {
      let mut c = TcpStream::connect(("127.0.0.1", proxy.port)).unwrap();
      write!(c, "CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n").unwrap();
      let mut reply = vec![0u8; 39];
      c.read_exact(&mut reply).unwrap();
      (c, String::from_utf8_lossy(&reply).into_owned())
    };
    let (mut c, reply) = ask(&format!("127.0.0.1:{up_port}"));
    assert!(reply.starts_with("HTTP/1.1 200"), "{reply}");
    c.write_all(b"hello").unwrap();
    let mut echo = [0u8; 5];
    c.read_exact(&mut echo).unwrap();
    assert_eq!(&echo, b"hello");
    let (_, reply) = ask("127.0.0.1:1");
    assert!(reply.starts_with("HTTP/1.1 403"), "{reply}");
  }
}
