//! `--screenshot <file.png>` (also `--screenshot=<file.png>`): start as usual, wait for the first
//! window to show and draw for about 120 frames, save the window's page as a PNG and quit.
//! Used by automated checks of a build; a normal launch never takes this path.
//!
//! macOS: WKWebView's `takeSnapshotWithConfiguration:completionHandler:` (no Screen Recording
//! permission needed, the page draws itself), encoded as PNG with NSBitmapImageRep.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

/// About 120 frames at 60 Hz once the window is visible.
const SETTLE: Duration = Duration::from_millis(2000);
/// Give up waiting for a visible window after this long and take whatever there is.
const WAIT_LIMIT: Duration = Duration::from_secs(60);
/// The whole run never outlives this (a snapshot that never answers).
const HARD_LIMIT: Duration = Duration::from_secs(120);

/// The output file named on the command line, resolved against `cwd`.
pub fn requested(args: impl IntoIterator<Item = OsString>, cwd: &Path) -> Option<PathBuf> {
  let mut args = args.into_iter();
  while let Some(arg) = args.next() {
    let s = arg.to_string_lossy();
    let value = if s == "--screenshot" {
      args.next().map(|v| v.to_string_lossy().into_owned())
    } else {
      s.strip_prefix("--screenshot=").map(str::to_owned)
    };
    if let Some(v) = value.filter(|v| !v.is_empty()) {
      let p = PathBuf::from(v);
      return Some(if p.is_absolute() { p } else { cwd.join(p) });
    }
  }
  None
}

/// Starts the wait-snapshot-quit sequence on a helper thread.
pub fn schedule(app: &AppHandle, out: PathBuf) {
  let app = app.clone();
  std::thread::spawn(move || {
    let started = Instant::now();
    let watchdog = app.clone();
    std::thread::spawn(move || {
      std::thread::sleep(HARD_LIMIT);
      eprintln!("screenshot: no picture after {}s", HARD_LIMIT.as_secs());
      watchdog.exit(1);
    });
    loop {
      let visible = app.webview_windows().values().any(|w| w.is_visible().unwrap_or(false));
      if visible || started.elapsed() > WAIT_LIMIT {
        break;
      }
      std::thread::sleep(Duration::from_millis(250));
    }
    std::thread::sleep(SETTLE);
    let windows = app.webview_windows();
    let Some(window) = windows.values().find(|w| w.is_visible().unwrap_or(false)).or_else(|| windows.values().next()).cloned() else {
      eprintln!("screenshot: no window");
      app.exit(1);
      return;
    };
    if let Some(dir) = out.parent() {
      let _ = std::fs::create_dir_all(dir);
    }
    take(&app, &window, out);
  });
}

#[cfg(target_os = "macos")]
fn take(app: &AppHandle, window: &tauri::WebviewWindow, out: PathBuf) {
  use block2::RcBlock;
  use objc2::msg_send;
  use objc2::runtime::{AnyClass, AnyObject};

  let app = app.clone();
  let failed = app.clone();
  let result = window.with_webview(move |webview| {
    let wk = webview.inner() as *mut AnyObject;
    let app = app.clone();
    let out = out.clone();
    let done = RcBlock::new(move |image: *mut AnyObject, _error: *mut AnyObject| {
      let code = match unsafe { png_bytes(image) } {
        Some(bytes) => match std::fs::write(&out, bytes) {
          Ok(()) => {
            println!("screenshot: saved {}", out.display());
            0
          }
          Err(e) => {
            eprintln!("screenshot: {}: {e}", out.display());
            1
          }
        },
        None => {
          eprintln!("screenshot: the page gave no picture");
          1
        }
      };
      app.exit(code);
    });
    unsafe {
      let _: () = msg_send![wk, takeSnapshotWithConfiguration: std::ptr::null_mut::<AnyObject>(), completionHandler: &*done];
    }
  });
  if let Err(e) = result {
    eprintln!("screenshot: {e}");
    failed.exit(1);
  }

  /// NSImage → PNG bytes through its TIFF form and NSBitmapImageRep.
  unsafe fn png_bytes(image: *mut AnyObject) -> Option<Vec<u8>> {
    if image.is_null() {
      return None;
    }
    unsafe {
      let tiff: *mut AnyObject = msg_send![image, TIFFRepresentation];
      if tiff.is_null() {
        return None;
      }
      let rep_class = AnyClass::get(c"NSBitmapImageRep")?;
      let rep: *mut AnyObject = msg_send![rep_class, imageRepWithData: tiff];
      if rep.is_null() {
        return None;
      }
      let dict_class = AnyClass::get(c"NSDictionary")?;
      let props: *mut AnyObject = msg_send![dict_class, dictionary];
      // NSBitmapImageFileTypePNG
      let png: *mut AnyObject = msg_send![rep, representationUsingType: 4usize, properties: props];
      if png.is_null() {
        return None;
      }
      let len: usize = msg_send![png, length];
      let ptr: *const u8 = msg_send![png, bytes];
      if ptr.is_null() || len == 0 {
        return None;
      }
      Some(std::slice::from_raw_parts(ptr, len).to_vec())
    }
  }
}

#[cfg(not(target_os = "macos"))]
fn take(app: &AppHandle, _window: &tauri::WebviewWindow, _out: PathBuf) {
  eprintln!("screenshot: only supported on macOS");
  app.exit(1);
}

/// The dev address in tauri.conf.json (`build.devUrl`).
const DEV_PORT: u16 = 1420;

/// A plain `cargo build` (no `custom-protocol`) loads the page from the dev server at `devUrl`.
/// With no dev server running (any launch of such a build, `--screenshot` included), serve the built interface (`../build`, Tauri's
/// `frontendDist`) on that address ourselves, so the picture shows the app rather than a blank
/// page. Same origin as `tauri dev`, so the page talks to Rust exactly as it does there. Loopback
/// only, read only, files under the build folder only. Release builds embed the page instead.
pub fn serve_dev_build_if_needed() {
  if !tauri::is_dev() {
    return;
  }
  let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../build");
  let Ok(dir) = dir.canonicalize() else {
    eprintln!("screenshot: no built interface at {}; run `bun run build` in apps/desktop", dir.display());
    return;
  };
  if std::net::TcpStream::connect_timeout(&([127, 0, 0, 1], DEV_PORT).into(), Duration::from_millis(300)).is_ok() {
    return; // a dev server is already up
  }
  let mut bound = false;
  for addr in [std::net::SocketAddr::from(([127, 0, 0, 1], DEV_PORT)), std::net::SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, DEV_PORT))] {
    if let Ok(listener) = std::net::TcpListener::bind(addr) {
      bound = true;
      let dir = dir.clone();
      std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
          let dir = dir.clone();
          std::thread::spawn(move || serve_one(stream, &dir));
        }
      });
    }
  }
  if !bound {
    eprintln!("screenshot: port {DEV_PORT} is busy");
  }
}

fn content_type(path: &Path) -> &'static str {
  match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
    "html" => "text/html; charset=utf-8",
    "js" | "mjs" => "text/javascript; charset=utf-8",
    "css" => "text/css; charset=utf-8",
    "json" | "map" | "webmanifest" => "application/json",
    "svg" => "image/svg+xml",
    "png" => "image/png",
    "jpg" | "jpeg" => "image/jpeg",
    "ico" => "image/x-icon",
    "woff2" => "font/woff2",
    "woff" => "font/woff",
    "ttf" => "font/ttf",
    "wasm" => "application/wasm",
    "txt" => "text/plain; charset=utf-8",
    _ => "application/octet-stream",
  }
}

/// The file a request path names under `dir`; the SPA's index.html for anything else (including
/// any path that tries to leave `dir`).
pub fn resolve(dir: &Path, target: &str) -> PathBuf {
  let path = target.split(['?', '#']).next().unwrap_or("/");
  let mut out = dir.to_path_buf();
  for part in path.split('/') {
    if part.is_empty() || part == "." {
      continue;
    }
    if part == ".." || part.contains('\\') || part.contains('%') {
      return dir.join("index.html");
    }
    out.push(part);
  }
  if out.is_file() {
    out
  } else if out.join("index.html").is_file() {
    out.join("index.html")
  } else {
    dir.join("index.html")
  }
}

fn serve_one(mut stream: std::net::TcpStream, dir: &Path) {
  use std::io::{BufRead, BufReader, Write};
  let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
  let Ok(clone) = stream.try_clone() else { return };
  let mut reader = BufReader::new(clone);
  let mut line = String::new();
  if reader.read_line(&mut line).is_err() {
    return;
  }
  // Skip the headers.
  let mut header = String::new();
  while reader.read_line(&mut header).map(|n| n > 2).unwrap_or(false) {
    header.clear();
  }
  let mut parts = line.split_whitespace();
  let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or("/"));
  if method != "GET" && method != "HEAD" {
    let _ = stream.write_all(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    return;
  }
  let file = resolve(dir, target);
  let body = std::fs::read(&file).unwrap_or_default();
  let head = format!(
    "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
    content_type(&file),
    body.len()
  );
  let _ = stream.write_all(head.as_bytes());
  if method == "GET" {
    let _ = stream.write_all(&body);
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn resolves_files_and_falls_back_to_index() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("index.html"), "i").unwrap();
    std::fs::create_dir(dir.path().join("_app")).unwrap();
    std::fs::write(dir.path().join("_app/a.js"), "a").unwrap();
    let d = dir.path();
    assert_eq!(resolve(d, "/_app/a.js?v=1"), d.join("_app/a.js"));
    assert_eq!(resolve(d, "/"), d.join("index.html"));
    assert_eq!(resolve(d, "/some/route"), d.join("index.html"));
    assert_eq!(resolve(d, "/../outside.txt"), d.join("index.html"));
  }

  fn args(v: &[&str]) -> Vec<OsString> {
    v.iter().map(OsString::from).collect()
  }

  #[test]
  fn reads_both_forms() {
    let cwd = Path::new("/w");
    assert_eq!(requested(args(&["--screenshot", "shots/a.png"]), cwd), Some(PathBuf::from("/w/shots/a.png")));
    assert_eq!(requested(args(&["/x", "--screenshot=/tmp/b.png"]), cwd), Some(PathBuf::from("/tmp/b.png")));
    assert_eq!(requested(args(&["--screenshot"]), cwd), None);
    assert_eq!(requested(args(&["/x"]), cwd), None);
  }
}
