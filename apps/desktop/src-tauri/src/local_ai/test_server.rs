//! A stand-in model server for the tests: answers each connection on 127.0.0.1 with the next
//! scripted reply and records what was asked. No real model is ever called.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

pub struct Reply {
  status: u16,
  body: String,
}

impl Reply {
  pub fn ok(body: &str) -> Self {
    Self { status: 200, body: body.to_string() }
  }

  pub fn status(status: u16, body: &str) -> Self {
    Self { status, body: body.to_string() }
  }
}

#[derive(Debug, Clone)]
pub struct Seen {
  pub path: String,
  pub headers: Vec<(String, String)>,
  pub body: String,
}

impl Seen {
  pub fn header(&self, name: &str) -> Option<String> {
    self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone())
  }
}

pub struct TestServer {
  pub url: String,
  seen: Arc<Mutex<Vec<Seen>>>,
}

impl TestServer {
  pub fn start(replies: Vec<Reply>) -> Self {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    std::thread::spawn(move || {
      for reply in replies {
        let Ok((stream, _)) = listener.accept() else { return };
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut first = String::new();
        let _ = reader.read_line(&mut first);
        let path = first.split_whitespace().nth(1).unwrap_or_default().to_string();
        let mut headers = Vec::new();
        loop {
          let mut line = String::new();
          if reader.read_line(&mut line).unwrap_or(0) == 0 || line.trim().is_empty() {
            break;
          }
          if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
          }
        }
        let length = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("content-length")).and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
        let mut body = vec![0; length];
        let _ = reader.read_exact(&mut body);
        log.lock().unwrap().push(Seen { path, headers, body: String::from_utf8_lossy(&body).into_owned() });
        let mut stream = stream;
        let head = format!("HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", reply.status, reply.body.len());
        // The client may hang up mid-way (a cancelled stream).
        let _ = stream.write_all(head.as_bytes()).and_then(|_| stream.write_all(reply.body.as_bytes()));
      }
    });
    Self { url, seen }
  }

  pub fn requests(&self) -> Vec<Seen> {
    self.seen.lock().unwrap().clone()
  }
}
