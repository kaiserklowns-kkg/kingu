//! Link previews (Orca's `linkPreview:get`): the title, description, site name, picture and icon
//! of a web page, for the card shown when the pointer rests on a link. Rules from Orca 1.4.253
//! (`DNt`, `kNt`, `aNt`, `oNt`, `fNt`, `eNt`, `$Mt`, `XMt` in its provider chunk; MECHANICS.md):
//!
//! - only `http`/`https` without a user name or password, never an internal host (`localhost`,
//!   `.localhost`, `.internal`, `.local`, private, loopback, link-local, reserved and documentation
//!   ranges), checked again on every address the name resolves to (the connection is pinned to
//!   those checked addresses, so a second lookup can't swap in an internal one);
//! - redirects 301/302/303/307/308 followed by hand, at most `MAX_REDIRECTS`, each one checked;
//! - the page: `text/html` or `application/xhtml+xml`, at most `PAGE_MAX_BYTES`, read only until
//!   `</head>`; the picture: png/jpeg/gif/webp/avif up to `IMAGE_MAX_BYTES`; the icon: those or
//!   ico/svg up to `ICON_MAX_BYTES`, from `<link rel=icon>` else `/favicon.ico`;
//! - everything within `TIMEOUT_MS`; no title and no description → unavailable;
//! - cached by URL (without `#…`): a page `PAGE_TTL_MS`, a failure `FAILURE_TTL_MS`, at most
//!   `CACHE_MAX_ENTRIES` entries and `CACHE_MAX_BYTES`.

use std::collections::HashMap;
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Serialize;

/// Orca `mNt`.
pub const TIMEOUT_MS: u64 = 5000;
/// Orca `nNt`.
pub const MAX_REDIRECTS: usize = 4;
/// Orca `hNt`, `gNt`, `_Nt`.
pub const PAGE_MAX_BYTES: usize = 1048576;
pub const IMAGE_MAX_BYTES: usize = 1048576;
pub const ICON_MAX_BYTES: usize = 65536;
/// Orca `sNt`, `cNt`.
pub const TITLE_MAX_CHARS: usize = 200;
pub const DESCRIPTION_MAX_CHARS: usize = 400;
/// Orca `vNt`, `yNt`, `bNt`, `xNt`.
pub const PAGE_TTL_MS: u64 = 600000;
pub const FAILURE_TTL_MS: u64 = 60000;
pub const CACHE_MAX_ENTRIES: usize = 300;
pub const CACHE_MAX_BYTES: usize = 20971520;
const USER_AGENT: &str = concat!("Mozilla/5.0 (compatible; KinguLinkPreview/", env!("CARGO_PKG_VERSION"), ")");
const REDIRECTS: [u16; 5] = [301, 302, 303, 307, 308];
const PAGE_TYPES: [&str; 2] = ["text/html", "application/xhtml+xml"];
const IMAGE_TYPES: [&str; 5] = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"];
const ICON_TYPES: [&str; 8] = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/x-icon", "image/vnd.microsoft.icon", "image/svg+xml"];
const INTERNAL_SUFFIXES: [&str; 3] = [".localhost", ".internal", ".local"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
  pub url: String,
  pub title: Option<String>,
  pub description: Option<String>,
  pub site_name: Option<String>,
  pub image_data_url: Option<String>,
  pub favicon_data_url: Option<String>,
}

impl Preview {
  /// Orca `qMt`: what an entry weighs in the cache.
  fn bytes(&self) -> usize {
    [Some(&self.url), self.title.as_ref(), self.description.as_ref(), self.site_name.as_ref(), self.image_data_url.as_ref(), self.favicon_data_url.as_ref()].into_iter().flatten().map(String::len).sum()
  }
}

// ---------------------------------------------------------------------------------------------
// Which hosts may be fetched

/// Orca `V3` (and `JMt` for IPv4 inside IPv6): addresses a preview must never reach.
pub fn blocked_ip(ip: IpAddr) -> bool {
  match ip {
    IpAddr::V4(v4) => blocked_v4(v4),
    IpAddr::V6(v6) => {
      // ::ffff:a.b.c.d, ::a.b.c.d, 64:ff9b::a.b.c.d carry an IPv4 address: judge that.
      let s = v6.segments();
      let embedded = (s[..5] == [0, 0, 0, 0, 0] && (s[5] == 0xffff || s[5] == 0)) || (s[..6] == [0x64, 0xff9b, 0, 0, 0, 0]);
      if embedded && !(s[6] == 0 && s[7] <= 1) {
        return blocked_v4(Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8));
      }
      let in_net = |net: [u16; 8], bits: u32| {
        let a = u128::from(v6);
        let n = u128::from(Ipv6Addr::new(net[0], net[1], net[2], net[3], net[4], net[5], net[6], net[7]));
        let mask = if bits == 0 { 0 } else { u128::MAX << (128 - bits) };
        a & mask == n & mask
      };
      v6.is_unspecified()
        || v6.is_loopback()
        || in_net([0x64, 0xff9b, 1, 0, 0, 0, 0, 0], 48)
        || in_net([0x100, 0, 0, 0, 0, 0, 0, 0], 64)
        || in_net([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0], 32)
        || in_net([0xfc00, 0, 0, 0, 0, 0, 0, 0], 7)
        || in_net([0xfe80, 0, 0, 0, 0, 0, 0, 0], 10)
        || in_net([0xfec0, 0, 0, 0, 0, 0, 0, 0], 10)
        || in_net([0xff00, 0, 0, 0, 0, 0, 0, 0], 8)
    }
  }
}

fn blocked_v4(ip: Ipv4Addr) -> bool {
  let n = u32::from(ip);
  let nets: [([u8; 4], u32); 14] = [
    ([0, 0, 0, 0], 8),
    ([10, 0, 0, 0], 8),
    ([100, 64, 0, 0], 10),
    ([127, 0, 0, 0], 8),
    ([169, 254, 0, 0], 16),
    ([172, 16, 0, 0], 12),
    ([192, 0, 0, 0], 24),
    ([192, 0, 2, 0], 24),
    ([192, 168, 0, 0], 16),
    ([198, 18, 0, 0], 15),
    ([198, 51, 100, 0], 24),
    ([203, 0, 113, 0], 24),
    ([224, 0, 0, 0], 4),
    ([240, 0, 0, 0], 4),
  ];
  nets.iter().any(|(net, bits)| {
    let mask = u32::MAX << (32 - bits);
    n & mask == u32::from(Ipv4Addr::from(*net)) & mask
  })
}

/// Orca `$Mt`: a name or literal address that is internal.
pub fn internal_host(host: &str) -> bool {
  let h = host.trim_start_matches('[').trim_end_matches(']').trim_end_matches('.').to_ascii_lowercase();
  if h.is_empty() || h == "localhost" || INTERNAL_SUFFIXES.iter().any(|s| h.ends_with(s)) {
    return true;
  }
  h.split('%').next().and_then(|a| a.parse::<IpAddr>().ok()).is_some_and(blocked_ip)
}

/// Orca `eNt`: `raw` (relative to `base`) as a URL a preview may fetch.
pub fn allowed_url(raw: &str, base: Option<&url::Url>) -> Option<url::Url> {
  let u = match base {
    Some(b) => b.join(raw).ok()?,
    None => url::Url::parse(raw).ok()?,
  };
  let ok = matches!(u.scheme(), "http" | "https") && u.username().is_empty() && u.password().is_none() && u.host_str().is_some_and(|h| !internal_host(h));
  ok.then_some(u)
}

/// Orca `tNt`: the host's addresses, refused when any of them is internal.
fn resolve(u: &url::Url) -> Option<Vec<SocketAddr>> {
  let host = u.host_str()?;
  let port = u.port_or_known_default()?;
  let addrs: Vec<SocketAddr> = (host.trim_start_matches('[').trim_end_matches(']'), port).to_socket_addrs().ok()?.collect();
  (!addrs.is_empty() && !addrs.iter().any(|a| blocked_ip(a.ip()))).then_some(addrs)
}

// ---------------------------------------------------------------------------------------------
// Reading the page

/// Orca `H3`: at most `max` characters; longer text keeps `max - 1` (trailing space dropped) and `…`.
pub fn clip(text: &str, max: usize) -> String {
  let chars: Vec<char> = text.chars().collect();
  if chars.len() <= max {
    return text.to_string();
  }
  format!("{}\u{2026}", chars[..max - 1].iter().collect::<String>().trim_end())
}

/// Entities a page writes in its meta tags, and whitespace collapsed (Orca `PMt`).
pub fn clean(text: &str) -> String {
  let mut out = String::with_capacity(text.len());
  let mut rest = text;
  while let Some(i) = rest.find('&') {
    out.push_str(&rest[..i]);
    let tail = &rest[i..];
    let end = tail[..tail.len().min(12)].find(';');
    let decoded = end.and_then(|e| {
      let name = &tail[1..e];
      let c = match name {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" | "#39" => Some('\''),
        "nbsp" => Some(' '),
        n if n.starts_with("#x") || n.starts_with("#X") => u32::from_str_radix(&n[2..], 16).ok().and_then(char::from_u32),
        n if n.starts_with('#') => n[1..].parse::<u32>().ok().and_then(char::from_u32),
        _ => None,
      };
      c.map(|c| (c, e + 1))
    });
    match decoded {
      Some((c, len)) => {
        out.push(c);
        rest = &tail[len..];
      }
      None => {
        out.push('&');
        rest = &tail[1..];
      }
    }
  }
  out.push_str(rest);
  out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The attributes of every `<tag …>` in `html` (names lower-cased).
fn tags(html: &str, tag: &str) -> Vec<HashMap<String, String>> {
  static ATTR: OnceLock<regex::Regex> = OnceLock::new();
  let attr = ATTR.get_or_init(|| regex::Regex::new(r#"(?s)([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))"#).unwrap());
  let open = regex::Regex::new(&format!(r"(?is)<{tag}\b([^>]*)>")).unwrap();
  open
    .captures_iter(html)
    .map(|c| attr.captures_iter(&c[1]).map(|a| (a[1].to_ascii_lowercase(), a.get(2).or(a.get(3)).or(a.get(4)).map_or("", |m| m.as_str()).to_string())).collect())
    .collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Meta {
  pub title: Option<String>,
  pub description: Option<String>,
  pub site_name: Option<String>,
  pub image_url: Option<String>,
  pub icon_href: String,
}

/// Orca `fNt`: title from og:title, twitter:title, else `<title>`; description from
/// og:description, twitter:description, description; site from og:site_name; picture from
/// og:image, og:image:secure_url, twitter:image (resolved against the page); icon from
/// `<link rel=…icon…>`, else `/favicon.ico`. The first value of a name wins.
pub fn parse_meta(html: &str, page: &url::Url) -> Meta {
  let mut by_name: HashMap<String, String> = HashMap::new();
  for t in tags(html, "meta") {
    let Some(content) = t.get("content") else { continue };
    for key in [t.get("property"), t.get("name")].into_iter().flatten() {
      by_name.entry(key.to_ascii_lowercase()).or_insert_with(|| content.clone());
    }
  }
  let pick = |keys: &[&str]| keys.iter().find_map(|k| by_name.get(*k).map(|v| clean(v)).filter(|v| !v.is_empty()));
  let title = pick(&["og:title", "twitter:title"]).or_else(|| {
    let re = regex::Regex::new(r"(?is)<title\b[^>]*>(.*?)</title>").unwrap();
    re.captures(html).map(|c| clean(&c[1])).filter(|t| !t.is_empty())
  });
  let icon_href = tags(html, "link")
    .into_iter()
    .find(|t| t.get("rel").is_some_and(|r| r.to_ascii_lowercase().split_whitespace().any(|w| w == "icon")) && t.get("href").is_some_and(|h| !h.trim().is_empty()))
    .and_then(|t| t.get("href").map(|h| h.trim().to_string()))
    .unwrap_or_else(|| "/favicon.ico".into());
  Meta {
    title: title.map(|t| clip(&t, TITLE_MAX_CHARS)),
    description: pick(&["og:description", "twitter:description", "description"]).map(|d| clip(&d, DESCRIPTION_MAX_CHARS)),
    site_name: pick(&["og:site_name"]).map(|s| clip(&s, TITLE_MAX_CHARS)),
    image_url: pick(&["og:image", "og:image:secure_url", "twitter:image"]).and_then(|i| page.join(&i).ok()).map(|u| u.to_string()),
    icon_href,
  }
}

/// Orca `lNt`: the charset of the header, else of a `<meta>`, else UTF-8.
pub fn decode(body: &[u8], content_type: &str) -> String {
  let from = |s: &str| {
    let re = regex::Regex::new(r#"(?i)charset\s*=\s*["']?([^"';\s>]+)"#).unwrap();
    re.captures(s).map(|c| c[1].to_string())
  };
  let label = from(content_type).or_else(|| {
    let head = String::from_utf8_lossy(&body[..body.len().min(4096)]).into_owned();
    tags(&head, "meta").into_iter().find_map(|t| t.get("charset").cloned().or_else(|| t.get("content").and_then(|c| from(c))))
  });
  let enc = label.and_then(|l| encoding_rs::Encoding::for_label(l.trim().as_bytes())).unwrap_or(encoding_rs::UTF_8);
  enc.decode(body).0.into_owned()
}

// ---------------------------------------------------------------------------------------------
// Fetching

struct Fetched {
  url: url::Url,
  mime: String,
  content_type: String,
  body: Vec<u8>,
}

fn mime_of(content_type: &str) -> String {
  content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase()
}

/// Orca `oNt`: one request to an already checked URL, pinned to its checked addresses.
enum Hop {
  Redirect(String),
  Done(Fetched),
}

fn hop(u: &url::Url, page: bool, types: &[&str], max: usize, deadline: Instant) -> Option<Hop> {
  let left = deadline.checked_duration_since(Instant::now())?;
  let addrs = resolve(u)?;
  let host = u.host_str()?.to_string();
  let client = crate::net_proxy::client_builder()
    .ok()?
    .redirect(reqwest::redirect::Policy::none())
    .timeout(left)
    .connect_timeout(left.min(Duration::from_secs(5)))
    .user_agent(USER_AGENT)
    .resolve_to_addrs(&host, &addrs)
    .build()
    .ok()?;
  let res = client.get(u.as_str()).header("Accept", if page { "text/html" } else { "image/*" }).send().ok()?;
  let status = res.status().as_u16();
  if REDIRECTS.contains(&status) {
    return res.headers().get("location").and_then(|l| l.to_str().ok()).map(|l| Hop::Redirect(l.to_string()));
  }
  if !(200..300).contains(&status) {
    return None;
  }
  let content_type = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
  let mime = mime_of(&content_type);
  if !types.contains(&mime.as_str()) {
    return None;
  }
  if !page && res.content_length().is_some_and(|n| n as usize > max) {
    return None;
  }
  let mut body = Vec::new();
  let mut reader = res;
  let mut chunk = [0u8; 16384];
  loop {
    let n = reader.read(&mut chunk).ok()?;
    if n == 0 {
      break;
    }
    if body.len() + n > max {
      if !page {
        return None; // a picture over the limit is dropped
      }
      body.extend_from_slice(&chunk[..max - body.len()]);
      break;
    }
    let seen = body.len();
    body.extend_from_slice(&chunk[..n]);
    // A page is read only until its head ends.
    if page {
      let from = seen.saturating_sub(8);
      if String::from_utf8_lossy(&body[from..]).to_ascii_lowercase().contains("</head") {
        break;
      }
    }
  }
  Some(Hop::Done(Fetched { url: u.clone(), mime, content_type, body }))
}

/// Orca `aNt`: follows up to `MAX_REDIRECTS` redirects, checking each target.
fn fetch(raw: &str, page: bool, types: &[&str], max: usize, deadline: Instant) -> Option<Fetched> {
  let mut u = allowed_url(raw, None)?;
  for i in 0..=MAX_REDIRECTS {
    match hop(&u, page, types, max, deadline)? {
      Hop::Done(f) => return Some(f),
      Hop::Redirect(loc) if i < MAX_REDIRECTS => u = allowed_url(&loc, Some(&u))?,
      Hop::Redirect(_) => return None,
    }
  }
  None
}

fn data_url(f: &Fetched) -> Option<String> {
  (!f.body.is_empty()).then(|| format!("data:{};base64,{}", f.mime, base64::engine::general_purpose::STANDARD.encode(&f.body)))
}

/// Orca `ANt`: an inline `data:` icon of an allowed type up to twice `ICON_MAX_BYTES`, else fetched.
fn icon(href: &str, page: &url::Url, deadline: Instant) -> Option<String> {
  if href.len() > 5 && href[..5].eq_ignore_ascii_case("data:") {
    let mime = href[5..].split([';', ',']).next().unwrap_or("").to_ascii_lowercase();
    return (ICON_TYPES.contains(&mime.as_str()) && href.len() <= ICON_MAX_BYTES * 2).then(|| href.to_string());
  }
  let u = page.join(href).ok()?;
  fetch(u.as_str(), false, &ICON_TYPES, ICON_MAX_BYTES, deadline).as_ref().and_then(data_url)
}

/// Orca `kNt`: the whole preview, or `None` (unavailable).
fn build(url: &str) -> Option<Preview> {
  let deadline = Instant::now() + Duration::from_millis(TIMEOUT_MS);
  let page = fetch(url, true, &PAGE_TYPES, PAGE_MAX_BYTES, deadline)?;
  let meta = parse_meta(&decode(&page.body, &page.content_type), &page.url);
  if meta.title.is_none() && meta.description.is_none() {
    return None;
  }
  let image = meta.image_url.as_deref().and_then(|i| fetch(i, false, &IMAGE_TYPES, IMAGE_MAX_BYTES, deadline)).as_ref().and_then(data_url);
  let favicon = icon(&meta.icon_href, &page.url, deadline);
  Some(Preview { url: page.url.to_string(), title: meta.title, description: meta.description, site_name: meta.site_name, image_data_url: image, favicon_data_url: favicon })
}

// ---------------------------------------------------------------------------------------------
// Cache

struct Entry {
  value: Option<Preview>,
  expires: Instant,
  bytes: usize,
  used: u64,
}

#[derive(Default)]
struct Cache {
  map: HashMap<String, Entry>,
  bytes: usize,
  tick: u64,
}

impl Cache {
  fn get(&mut self, key: &str) -> Option<Option<Preview>> {
    self.tick += 1;
    let tick = self.tick;
    let fresh = self.map.get(key).is_some_and(|e| e.expires > Instant::now());
    if !fresh {
      if let Some(e) = self.map.remove(key) {
        self.bytes -= e.bytes;
      }
      return None;
    }
    let e = self.map.get_mut(key)?;
    e.used = tick;
    Some(e.value.clone())
  }

  /// Orca `ENt`: the least recently used entries go first past either limit.
  fn put(&mut self, key: String, value: Option<Preview>) {
    self.tick += 1;
    let ttl = if value.is_some() { PAGE_TTL_MS } else { FAILURE_TTL_MS };
    let bytes = value.as_ref().map_or(0, Preview::bytes);
    if let Some(old) = self.map.remove(&key) {
      self.bytes -= old.bytes;
    }
    self.bytes += bytes;
    self.map.insert(key.clone(), Entry { value, expires: Instant::now() + Duration::from_millis(ttl), bytes, used: self.tick });
    while self.map.len() > CACHE_MAX_ENTRIES || self.bytes > CACHE_MAX_BYTES {
      let Some(oldest) = self.map.iter().filter(|(k, _)| **k != key).min_by_key(|(_, e)| e.used).map(|(k, _)| k.clone()) else { break };
      if let Some(e) = self.map.remove(&oldest) {
        self.bytes -= e.bytes;
      }
    }
  }
}

fn cache() -> &'static Mutex<Cache> {
  static C: OnceLock<Mutex<Cache>> = OnceLock::new();
  C.get_or_init(Mutex::default)
}

/// Orca `ONt`: the cache key is the URL without its `#…`.
pub fn cache_key(url: &str) -> Option<String> {
  let mut u = url::Url::parse(url).ok()?;
  u.set_fragment(None);
  Some(u.to_string())
}

/// The preview of `url`, `None` when there is none to show.
#[tauri::command]
pub async fn link_preview_get(url: String) -> Result<Option<Preview>, String> {
  let Some(key) = cache_key(&url) else { return Ok(None) };
  if let Some(hit) = cache().lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
    return Ok(hit);
  }
  let k = key.clone();
  let value = tauri::async_runtime::spawn_blocking(move || build(&k)).await.map_err(|e| e.to_string())?;
  cache().lock().unwrap_or_else(|e| e.into_inner()).put(key, value.clone());
  Ok(value)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn u(s: &str) -> url::Url {
    url::Url::parse(s).unwrap()
  }

  /// Needs the internet: `cargo test -p kingu-desktop --lib link_preview -- --ignored`.
  #[test]
  #[ignore]
  fn live_public_page() {
    let p = build("https://www.rust-lang.org/").expect("a preview");
    assert!(p.title.is_some(), "{p:?}");
    assert!(build("http://127.0.0.1:1/").is_none());
  }

  #[test]
  fn internal_hosts_and_addresses_are_refused() {
    for h in ["localhost", "LOCALHOST.", "app.localhost", "db.internal", "printer.local", "127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.1.1", "0.0.0.0", "[::1]", "::", "fe80::1", "fd12::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "224.0.0.1", "198.18.0.1", "203.0.113.5"] {
      assert!(internal_host(h), "{h}");
    }
    for h in ["example.com", "93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"] {
      assert!(!internal_host(h), "{h}");
    }
  }

  #[test]
  fn only_plain_public_http_urls() {
    assert!(allowed_url("https://example.com/a", None).is_some());
    assert!(allowed_url("ftp://example.com/a", None).is_none());
    assert!(allowed_url("https://me:pw@example.com/", None).is_none());
    assert!(allowed_url("http://localhost:3000/", None).is_none());
    assert!(allowed_url("http://169.254.169.254/latest", None).is_none());
    // A redirect target is read against the page it came from, then checked again.
    let base = u("https://example.com/x/y");
    assert_eq!(allowed_url("../z", Some(&base)).unwrap().as_str(), "https://example.com/z");
    assert!(allowed_url("http://10.0.0.1/", Some(&base)).is_none());
  }

  #[test]
  fn clips_like_orca() {
    assert_eq!(clip("short", 10), "short");
    let long = "a".repeat(250);
    let c = clip(&long, TITLE_MAX_CHARS);
    assert_eq!(c.chars().count(), TITLE_MAX_CHARS);
    assert!(c.ends_with('\u{2026}'));
    assert_eq!(clip("abc def", 5), "abc\u{2026}");
  }

  #[test]
  fn reads_meta_tags_in_orcas_order() {
    let html = r#"<html><head>
      <title> Fallback &amp; title </title>
      <meta name="twitter:title" content="Twitter title">
      <meta property="og:title" content="OG &quot;title&quot;">
      <meta name="description" content="Plain   description">
      <meta property="og:site_name" content='Example'>
      <meta property="og:image" content="/img/card.png">
      <link rel="shortcut icon" href="/fav.png">
    </head><body>"#;
    let m = parse_meta(html, &u("https://example.com/post/1"));
    assert_eq!(m.title.as_deref(), Some("OG \"title\""));
    assert_eq!(m.description.as_deref(), Some("Plain description"));
    assert_eq!(m.site_name.as_deref(), Some("Example"));
    assert_eq!(m.image_url.as_deref(), Some("https://example.com/img/card.png"));
    assert_eq!(m.icon_href, "/fav.png");
    let bare = parse_meta("<title>Only &#x41;&#66;</title>", &u("https://e.com/"));
    assert_eq!(bare.title.as_deref(), Some("Only AB"));
    assert_eq!(bare.icon_href, "/favicon.ico");
    assert_eq!(parse_meta("<p>nothing</p>", &u("https://e.com/")), Meta { icon_href: "/favicon.ico".into(), ..Default::default() });
  }

  #[test]
  fn decodes_the_declared_charset() {
    let latin1 = [b'<', b't', b'i', b't', b'l', b'e', b'>', b'c', b'a', b'f', 0xe9, b'<'];
    assert!(decode(&latin1, "text/html; charset=ISO-8859-1").contains("café"));
    let meta = b"<meta charset=\"windows-874\"><title>\xca\xC7\xD1\xCA\xB4\xD5</title>";
    assert!(decode(meta, "text/html").contains("สวัสดี"));
    assert_eq!(decode("ไทย".as_bytes(), "text/html"), "ไทย");
  }

  #[test]
  fn cache_keeps_pages_longer_than_failures_and_evicts_oldest() {
    let mut c = Cache::default();
    let p = Preview { url: "https://e.com/".into(), title: Some("T".into()), description: None, site_name: None, image_data_url: None, favicon_data_url: None };
    c.put("a".into(), Some(p.clone()));
    c.put("b".into(), None);
    assert_eq!(c.get("a"), Some(Some(p.clone())));
    assert_eq!(c.get("b"), Some(None));
    assert!(c.map["a"].expires - c.map["b"].expires >= Duration::from_millis(PAGE_TTL_MS - FAILURE_TTL_MS - 1000));
    for i in 0..CACHE_MAX_ENTRIES + 5 {
      c.put(format!("k{i}"), None);
    }
    assert_eq!(c.map.len(), CACHE_MAX_ENTRIES);
    assert!(c.get("a").is_none(), "least recently used went first");
    assert_eq!(cache_key("https://e.com/p#frag").as_deref(), Some("https://e.com/p"));
  }
}
