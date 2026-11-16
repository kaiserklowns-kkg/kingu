//! Localhost worktree labels (Orca's `localhostWorktreeLabels:register`, its `XAe` relay): a task's
//! dev server on `http://localhost:3000` also answers at `http://<label>.kingu.localhost:<relay>/`,
//! so each task gets its own host name and with it its own cookies and storage (on plain
//! `localhost` every port shares them). A small HTTP relay on 127.0.0.1 forwards by the label in
//! the request's `Host`.
//!
//! Rules from Orca 1.4.253 (`kO`, `LBe`, `RBe`, `zBe`, `EO`, `OO` in its provider chunk; `XAe`,
//! `ZAe`, `$Ae`, `eje` in out/main/index.js; MECHANICS.md › Localhost labels):
//! - a label is the worktree folder's last part as a slug (lower-case `a-z0-9` and `-`, at most
//!   `SLUG_MAX` characters, `workspace` when empty); the main checkout (`main`, or a name ending
//!   in `-main`, `_main`, ` main`, `/main`) is `<project>-main`;
//! - the same task and target keep their label; a taken label gets `-2`, `-3`, … up to `-999`;
//! - only `http` targets on this machine (`localhost`, `127.0.0.1`, `0.0.0.0`, `::1`, `::`;
//!   `0.0.0.0` → `127.0.0.1`, `::` → `::1`);
//! - the relay keeps the path and query, sends `Host: <target host>` and
//!   `X-Forwarded-Host: <label host>`, passes WebSocket upgrades through, answers an unknown label
//!   with 404 and a failed target with 502.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;

/// Orca `YAe` (`.orca.localhost`), named for Kingu.
pub const SUFFIX: &str = ".kingu.localhost";
/// Orca `FBe`.
pub const SLUG_MAX: usize = 48;
/// Orca's `nextAvailableLabel` tries `-2` … `-999`.
pub const MAX_SUFFIX: usize = 999;
/// Orca `EO`: hosts that mean "this machine".
pub const LOCAL_HOSTS: [&str; 5] = ["localhost", "127.0.0.1", "0.0.0.0", "::1", "::"];
/// A request head larger than this is refused (the relay reads only the head itself).
const MAX_HEAD: usize = 64 * 1024;

/// Orca `kO`.
pub fn slug(text: &str) -> String {
  let lower = text.trim().to_lowercase().replace(['\'', '"'], "");
  let mut out = String::new();
  for c in lower.chars() {
    if c.is_ascii_lowercase() || c.is_ascii_digit() {
      out.push(c);
    } else if !out.ends_with('-') {
      out.push('-');
    }
  }
  let trimmed = out.trim_matches('-');
  let cut: String = trimmed.chars().take(SLUG_MAX).collect();
  let cut = cut.trim_end_matches('-').to_string();
  if cut.is_empty() { "workspace".into() } else { cut }
}

/// Orca `IBe = /(?:^|[-_\s/])main$/i` (provider chunk offset 0xdac22): `main` (any case) at the
/// end, right after the start or a `-`, `_`, `/` or any whitespace character.
pub fn is_main_name(name: &str) -> bool {
  let chars: Vec<char> = name.chars().collect();
  let n = chars.len();
  if n < 4 || !chars[n - 4..].iter().collect::<String>().eq_ignore_ascii_case("main") {
    return false;
  }
  n == 4 || matches!(chars[n - 5], '-' | '_' | '/') || chars[n - 5].is_whitespace()
}

/// Orca `LBe` + `RBe`: the label for a worktree.
pub fn label_for(project: &str, worktree_name: &str, worktree_path: Option<&str>) -> String {
  let last = worktree_path.unwrap_or(worktree_name).split(['/', '\\']).map(str::trim).filter(|s| !s.is_empty()).next_back().unwrap_or(worktree_name);
  let n = slug(last);
  if n == "main" || is_main_name(worktree_name) { slug(&format!("{project}-main")) } else { n }
}

/// Orca `ZAe` + `OO`: the target as `(host to dial, port, host header)`, only `http` on this machine.
pub fn target_of(url: &str) -> Result<(String, u16, String), String> {
  let u = url::Url::parse(url).map_err(|_| "Localhost label target is not a valid URL.".to_string())?;
  if u.scheme() != "http" {
    return Err("Only http workspace ports can be labeled.".into());
  }
  let host = u.host_str().unwrap_or("").trim_start_matches('[').trim_end_matches(']').to_lowercase();
  if !LOCAL_HOSTS.contains(&host.as_str()) {
    return Err("Localhost label target is not an allowed workspace port.".into());
  }
  let port = u.port_or_known_default().unwrap_or(80);
  let dial = match host.as_str() {
    "0.0.0.0" | "localhost" => "127.0.0.1".to_string(),
    "::" => "::1".to_string(),
    h => h.to_string(),
  };
  let header = if dial.contains(':') { format!("[{dial}]:{port}") } else { format!("{}:{port}", u.host_str().unwrap_or("localhost").replace("0.0.0.0", "127.0.0.1")) };
  Ok((dial, port, header))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Route {
  dial: String,
  port: u16,
  host_header: String,
  worktree: String,
}

#[derive(Default)]
struct Routes {
  by_label: HashMap<String, Route>,
  /// Orca `zBe`'s key (task + target) → its label.
  by_key: HashMap<String, String>,
}

impl Routes {
  /// Orca `registerRoute`/`nextAvailableLabel`.
  fn register(&mut self, base: &str, key: &str, route: Route) -> Result<String, String> {
    let label = match self.by_key.get(key) {
      Some(l) => l.clone(),
      None if !self.by_label.contains_key(base) => base.to_string(),
      None => (2..=MAX_SUFFIX).map(|i| format!("{base}-{i}")).find(|l| !self.by_label.contains_key(l)).ok_or("No available localhost label.")?,
    };
    self.by_label.insert(label.clone(), route);
    self.by_key.insert(key.to_string(), label.clone());
    Ok(label)
  }
}

struct Relay {
  port: u16,
  routes: Mutex<Routes>,
}

fn relay() -> Result<&'static Relay, String> {
  static R: OnceLock<Result<Relay, String>> = OnceLock::new();
  R.get_or_init(|| {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("Failed to start localhost label proxy: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    std::thread::spawn(move || {
      for stream in listener.incoming().flatten() {
        std::thread::spawn(move || {
          if let Ok(r) = relay() {
            serve(r, stream);
          }
        });
      }
    });
    log::info!("localhost labels: relay on 127.0.0.1:{port}");
    Ok(Relay { port, routes: Mutex::default() })
  })
  .as_ref()
  .map_err(Clone::clone)
}

/// The label in a `Host` header (`fix-login.kingu.localhost:51234` → `fix-login`).
pub fn label_of_host(host: &str) -> Option<String> {
  let name = host.rsplit_once(':').map_or(host, |(h, p)| if p.chars().all(|c| c.is_ascii_digit()) { h } else { host }).to_lowercase();
  name.strip_suffix(SUFFIX).filter(|l| !l.is_empty()).map(str::to_string)
}

/// Orca `eje`: the head with `Host` set to the target and `X-Forwarded-Host` to the label host;
/// a plain request asks the target to close after it (so every request is routed afresh), an
/// upgrade keeps its own `Connection`.
pub fn rewrite_head(head: &str, host_header: &str) -> (String, Option<String>) {
  let mut lines = head.split("\r\n");
  let first = lines.next().unwrap_or_default().to_string();
  let mut original_host = None;
  let mut upgrade = false;
  let mut kept = Vec::new();
  for l in lines.filter(|l| !l.is_empty()) {
    let Some((name, value)) = l.split_once(':') else { continue };
    let n = name.trim().to_ascii_lowercase();
    match n.as_str() {
      "host" => original_host = Some(value.trim().to_string()),
      "x-forwarded-host" => {}
      "upgrade" => {
        upgrade = true;
        kept.push(l.to_string());
      }
      "connection" | "proxy-connection" | "keep-alive" => kept.push(format!("\u{0}{l}")),
      _ => kept.push(l.to_string()),
    }
  }
  let mut out = vec![first, format!("Host: {host_header}")];
  if let Some(h) = &original_host {
    out.push(format!("X-Forwarded-Host: {h}"));
  }
  for l in kept {
    match l.strip_prefix('\u{0}') {
      Some(conn) if upgrade => out.push(conn.to_string()),
      Some(_) => {}
      None => out.push(l),
    }
  }
  if !upgrade {
    out.push("Connection: close".into());
  }
  (out.join("\r\n") + "\r\n\r\n", original_host)
}

fn reply(mut s: &TcpStream, status: &str, text: &str) {
  let _ = write!(s, "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}", text.len());
}

fn serve(relay: &Relay, mut client: TcpStream) {
  let _ = client.set_read_timeout(Some(Duration::from_secs(30)));
  // Read the request head (and whatever body bytes came with it).
  let mut buf = Vec::new();
  let mut chunk = [0u8; 8192];
  let split = loop {
    let Ok(n) = client.read(&mut chunk) else { return };
    if n == 0 {
      return;
    }
    buf.extend_from_slice(&chunk[..n]);
    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
      break i + 4;
    }
    if buf.len() > MAX_HEAD {
      return reply(&client, "431 Request Header Fields Too Large", "Request head too large.");
    }
  };
  let head = String::from_utf8_lossy(&buf[..split]).to_string();
  let host = head.lines().find_map(|l| l.split_once(':').filter(|(n, _)| n.trim().eq_ignore_ascii_case("host")).map(|(_, v)| v.trim().to_string()));
  let route = host.as_deref().and_then(label_of_host).and_then(|l| relay.routes.lock().unwrap_or_else(|e| e.into_inner()).by_label.get(&l).cloned());
  let Some(route) = route else {
    return reply(&client, "404 Not Found", "Unknown Kingu localhost label.");
  };
  let addr = if route.dial.contains(':') { format!("[{}]:{}", route.dial, route.port) } else { format!("{}:{}", route.dial, route.port) };
  let mut upstream = match TcpStream::connect_timeout(&match addr.parse() {
    Ok(a) => a,
    Err(_) => return reply(&client, "502 Bad Gateway", "Proxy failed: bad target address"),
  }, Duration::from_secs(5))
  {
    Ok(s) => s,
    Err(e) => return reply(&client, "502 Bad Gateway", &format!("Proxy failed: {e}")),
  };
  let (rewritten, _) = rewrite_head(&head, &route.host_header);
  if upstream.write_all(rewritten.as_bytes()).is_err() || upstream.write_all(&buf[split..]).is_err() {
    return reply(&client, "502 Bad Gateway", "Proxy failed: could not send the request");
  }
  let _ = client.set_read_timeout(None);
  // Both directions until either side closes (a body, the answer, or a WebSocket).
  let (Ok(mut c2), Ok(mut u2)) = (client.try_clone(), upstream.try_clone()) else { return };
  let up = std::thread::spawn(move || {
    let _ = std::io::copy(&mut c2, &mut u2);
    let _ = u2.shutdown(std::net::Shutdown::Write);
  });
  let _ = std::io::copy(&mut upstream, &mut client);
  let _ = client.shutdown(std::net::Shutdown::Both);
  let _ = up.join();
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Labeled {
  pub label: String,
  pub url: String,
}

/// Orca `buildLabeledUrl`: the target's path and query on `<label>.kingu.localhost:<relay port>`.
pub fn labeled_url(label: &str, relay_port: u16, target: &str) -> Result<String, String> {
  let mut u = url::Url::parse(target).map_err(|e| e.to_string())?;
  u.set_host(Some(&format!("{label}{SUFFIX}"))).map_err(|e| e.to_string())?;
  u.set_port(Some(relay_port)).map_err(|_| "bad port".to_string())?;
  Ok(u.to_string())
}

#[tauri::command]
pub fn localhost_label_register(target_url: String, project_name: String, worktree_name: String, worktree_path: Option<String>) -> Result<Labeled, String> {
  let (dial, port, host_header) = target_of(&target_url)?;
  let relay = relay()?;
  let base = label_for(&project_name, &worktree_name, worktree_path.as_deref());
  let worktree = worktree_path.clone().unwrap_or_else(|| worktree_name.clone());
  // Orca `zBe`: one label per task and target.
  let key = format!("worktree:{worktree}:{target_url}");
  let label = relay.routes.lock().unwrap_or_else(|e| e.into_inner()).register(&base, &key, Route { dial, port, host_header, worktree })?;
  Ok(Labeled { url: labeled_url(&label, relay.port, &target_url)?, label })
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::BufRead;

  #[test]
  fn slugs_like_orca() {
    assert_eq!(slug("  Fix Login Bug! "), "fix-login-bug");
    assert_eq!(slug("O'Brien \"x\""), "obrien-x");
    assert_eq!(slug("ไทย"), "workspace");
    assert_eq!(slug(&"a".repeat(60)).len(), SLUG_MAX);
    assert_eq!(slug(&format!("{}-b", "a".repeat(47))), "a".repeat(47));
  }

  #[test]
  fn labels_name_the_task_and_the_main_checkout() {
    assert_eq!(label_for("Kingu", "fix-login", Some("/r/.kingu/worktrees/fix-login")), "fix-login");
    assert_eq!(label_for("Kingu", "main", Some("/Users/me/Kingu")), "kingu-main");
    assert_eq!(label_for("My App", "release_main", None), "my-app-main");
    assert_eq!(label_for("Kingu", "feature", Some("/r/feature/")), "feature");
  }

  #[test]
  fn main_name_matches_orcas_pattern() {
    for yes in ["main", "MAIN", "repo-main", "repo_Main", "a/main", "a main", "a\u{a0}main", "a\nmain"] {
      assert!(is_main_name(yes), "{yes:?}");
    }
    for no in ["domain", "mainline", "main-x", "ma", "", "a.main"] {
      assert!(!is_main_name(no), "{no:?}");
    }
  }

  #[test]
  fn only_local_http_targets() {
    assert_eq!(target_of("http://localhost:3000/").unwrap(), ("127.0.0.1".into(), 3000, "localhost:3000".into()));
    assert_eq!(target_of("http://0.0.0.0:5173").unwrap().0, "127.0.0.1");
    assert_eq!(target_of("http://[::]:8080/").unwrap(), ("::1".into(), 8080, "[::1]:8080".into()));
    assert!(target_of("https://localhost:3000").is_err());
    assert!(target_of("http://example.com:3000").is_err());
    assert!(target_of("http://192.168.1.2:3000").is_err());
  }

  #[test]
  fn duplicate_labels_get_numbers_and_a_task_keeps_its_own() {
    let mut r = Routes::default();
    let route = |w: &str| Route { dial: "127.0.0.1".into(), port: 1, host_header: "localhost:1".into(), worktree: w.into() };
    assert_eq!(r.register("web", "a", route("a")).unwrap(), "web");
    assert_eq!(r.register("web", "b", route("b")).unwrap(), "web-2");
    assert_eq!(r.register("web", "a", route("a")).unwrap(), "web");
    assert_eq!(r.register("web", "c", route("c")).unwrap(), "web-3");
  }

  #[test]
  fn hosts_and_heads() {
    assert_eq!(label_of_host("fix-login.kingu.localhost:51234").as_deref(), Some("fix-login"));
    assert_eq!(label_of_host("FIX.kingu.localhost").as_deref(), Some("fix"));
    assert_eq!(label_of_host("localhost:3000"), None);
    let (h, orig) = rewrite_head("GET /a?b=1 HTTP/1.1\r\nHost: x.kingu.localhost:9\r\nConnection: keep-alive\r\nAccept: */*\r\n\r\n", "localhost:3000");
    assert_eq!(orig.as_deref(), Some("x.kingu.localhost:9"));
    assert_eq!(h, "GET /a?b=1 HTTP/1.1\r\nHost: localhost:3000\r\nX-Forwarded-Host: x.kingu.localhost:9\r\nAccept: */*\r\nConnection: close\r\n\r\n");
    let (ws, _) = rewrite_head("GET /ws HTTP/1.1\r\nHost: x.kingu.localhost:9\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n", "localhost:3000");
    assert!(ws.contains("Connection: Upgrade") && ws.contains("Upgrade: websocket") && !ws.contains("close"));
    assert_eq!(labeled_url("fix", 5000, "http://localhost:3000/app?x=1").unwrap(), "http://fix.kingu.localhost:5000/app?x=1");
  }

  #[test]
  fn relays_a_request_to_the_task_server() {
    // A tiny "dev server" that echoes the Host and X-Forwarded-Host it got.
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = server.local_addr().unwrap().port();
    std::thread::spawn(move || {
      let (s, _) = server.accept().unwrap();
      let mut reader = std::io::BufReader::new(s.try_clone().unwrap());
      let mut seen = String::new();
      loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        if line == "\r\n" || line.is_empty() {
          break;
        }
        seen.push_str(&line);
      }
      let body = seen.replace("\r\n", "|");
      let mut s = s;
      write!(s, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    });
    let got = localhost_label_register(format!("http://localhost:{port}/"), "Kingu".into(), "relay-test".into(), Some("/tmp/relay-test".into())).unwrap();
    assert!(got.url.starts_with("http://relay-test.kingu.localhost:"));
    let relay_port = relay().unwrap().port;
    let mut c = TcpStream::connect(("127.0.0.1", relay_port)).unwrap();
    write!(c, "GET /page?q=1 HTTP/1.1\r\nHost: relay-test.kingu.localhost:{relay_port}\r\n\r\n").unwrap();
    let mut answer = String::new();
    c.read_to_string(&mut answer).unwrap();
    assert!(answer.starts_with("HTTP/1.1 200 OK"), "{answer}");
    assert!(answer.contains("GET /page?q=1 HTTP/1.1"), "{answer}");
    assert!(answer.contains(&format!("Host: localhost:{port}")), "{answer}");
    assert!(answer.contains(&format!("X-Forwarded-Host: relay-test.kingu.localhost:{relay_port}")), "{answer}");
    // An unknown label is a 404.
    let mut c = TcpStream::connect(("127.0.0.1", relay_port)).unwrap();
    write!(c, "GET / HTTP/1.1\r\nHost: nope.kingu.localhost\r\n\r\n").unwrap();
    let mut answer = String::new();
    c.read_to_string(&mut answer).unwrap();
    assert!(answer.starts_with("HTTP/1.1 404"), "{answer}");
  }
}
