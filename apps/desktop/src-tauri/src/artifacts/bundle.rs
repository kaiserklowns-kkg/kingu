//! One self-contained HTML file from an artifact version, for Export and Share with team: the
//! page's local assets go inline — `<script src>` and `<link rel=stylesheet>` become `<script>` /
//! `<style>` blocks, other `src` / `href` / `poster` references and CSS `url()`s become `data:`
//! URLs — and a CSP meta tag goes first, the same network rules as the preview (preview.rs).
//! Remote URLs, anchors and anything that is not one of the artifact's own files stay as they
//! are. Pure: the caller hands in how to read a file by its name inside the artifact.

use base64::Engine;
use regex::{Captures, Regex};
use std::sync::OnceLock;

/// Who may serve what to an artifact page, in the preview and in exported files: inline code,
/// its own files (`kingu-artifact:` in the preview, `data:` once inlined) and a few CDNs.
pub const CDNS: &str = "https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://cdn.tailwindcss.com https://code.jquery.com";
const FONT_HOSTS: &str = "https://fonts.googleapis.com https://fonts.gstatic.com";

/// The CSP of an artifact page. `own`: the source expressions for the artifact's own files (none
/// once they are inlined). No `connect-src`: a page never fetches, posts or opens sockets; no
/// frames, forms or `<base>`.
pub fn csp(own: &str) -> String {
  let own = if own.is_empty() { String::new() } else { format!("{own} ") };
  format!(
    "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' {own}{CDNS}; style-src 'unsafe-inline' {own}data: {CDNS} {FONT_HOSTS}; \
     img-src {own}data: blob: {CDNS}; font-src {own}data: {CDNS} {FONT_HOSTS}; media-src {own}data: blob:; worker-src blob:; \
     connect-src 'none'; frame-src 'none'; child-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'"
  )
}

/// `text` with `snippet` right after a leading `<!DOCTYPE …>` (else at the very start), so it runs
/// or applies before anything of the page; the page's own mode (standards or quirks) is kept.
pub fn inject_first(text: &str, snippet: &str) -> String {
  let body = text.strip_prefix('\u{feff}').unwrap_or(text);
  let lead = body.len() - body.trim_start().len();
  let rest = &body[lead..];
  if rest.len() >= 9 && rest[..9].eq_ignore_ascii_case("<!doctype")
    && let Some(end) = rest.find('>')
  {
    let at = lead + end + 1;
    return format!("{}{snippet}{}", &body[..at], &body[at..]);
  }
  format!("{snippet}{body}")
}

/// The MIME type of a file name, by its extension.
pub fn mime_of(name: &str) -> &'static str {
  let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
  match ext.as_str() {
    "html" | "htm" => "text/html; charset=utf-8",
    "css" => "text/css; charset=utf-8",
    "js" | "mjs" => "text/javascript; charset=utf-8",
    "json" | "map" => "application/json",
    "md" | "markdown" => "text/markdown; charset=utf-8",
    "txt" => "text/plain; charset=utf-8",
    "csv" => "text/csv; charset=utf-8",
    "svg" => "image/svg+xml",
    "png" => "image/png",
    "jpg" | "jpeg" => "image/jpeg",
    "gif" => "image/gif",
    "webp" => "image/webp",
    "avif" => "image/avif",
    "ico" => "image/x-icon",
    "woff" => "font/woff",
    "woff2" => "font/woff2",
    "ttf" => "font/ttf",
    "otf" => "font/otf",
    "mp4" => "video/mp4",
    "webm" => "video/webm",
    "mp3" => "audio/mpeg",
    "wav" => "audio/wav",
    "ogg" => "audio/ogg",
    "pdf" => "application/pdf",
    "wasm" => "application/wasm",
    _ => "application/octet-stream",
  }
}

/// The artifact file a reference in the page means, or None for anything else: remote URLs (any
/// scheme, `//host`), absolute paths, anchors, `data:`. `./` and `a/../` are resolved; a query or
/// fragment is dropped; percent escapes are decoded. Never above the artifact's folder.
pub fn local_ref(url: &str) -> Option<String> {
  local_ref_in("", url)
}

/// [`local_ref`] for a reference made in the file whose folder is `base` (`css/`; `""`: the page).
pub fn local_ref_in(base: &str, url: &str) -> Option<String> {
  let path = url.trim().split(['?', '#']).next()?;
  if path.is_empty() || path.starts_with('/') || path.contains('\\') {
    return None;
  }
  // A scheme: letters, then `:` before any `/`.
  if let Some(colon) = path.find(':')
    && !path[..colon].contains('/')
  {
    return None;
  }
  let decoded = percent_decode(&format!("{base}{path}"))?;
  let mut parts: Vec<&str> = Vec::new();
  for seg in decoded.split('/') {
    match seg {
      "" | "." => {}
      ".." => {
        parts.pop()?;
      }
      s => parts.push(s),
    }
  }
  (!parts.is_empty()).then(|| parts.join("/"))
}

fn percent_decode(s: &str) -> Option<String> {
  let bytes = s.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut i = 0;
  while i < bytes.len() {
    if bytes[i] == b'%' {
      let hex = s.get(i + 1..i + 3)?;
      out.push(u8::from_str_radix(hex, 16).ok()?);
      i += 3;
    } else {
      out.push(bytes[i]);
      i += 1;
    }
  }
  String::from_utf8(out).ok()
}

fn data_url(name: &str, bytes: &[u8]) -> String {
  let mime = mime_of(name).split(';').next().unwrap_or("application/octet-stream");
  format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
  cell.get_or_init(|| Regex::new(pattern).expect("valid regex"))
}

/// An attribute value from a regex capture of `"…"`, `'…'` or a bare word (groups `q1`/`q2`/`bare`).
fn value<'a>(c: &'a Captures) -> &'a str {
  c.name("q1").or_else(|| c.name("q2")).or_else(|| c.name("bare")).map_or("", |m| m.as_str())
}

fn escape_attr(s: &str) -> String {
  s.replace('&', "&amp;").replace('"', "&quot;")
}

/// CSS with its local `url(…)`s inline (fonts, images; one level, no `@import`), relative to
/// `base`, the CSS file's folder.
fn inline_css(css: &str, base: &str, read: &dyn Fn(&str) -> Option<Vec<u8>>) -> String {
  static URL: OnceLock<Regex> = OnceLock::new();
  re(&URL, r#"url\(\s*(?:"(?P<q1>[^"]*)"|'(?P<q2>[^']*)'|(?P<bare>[^)'"\s]+))\s*\)"#)
    .replace_all(css, |c: &Captures| match local_ref_in(base, value(c)).and_then(|n| read(&n).map(|b| (n, b))) {
      Some((n, b)) => format!("url(\"{}\")", data_url(&n, &b)),
      None => c[0].to_owned(),
    })
    .into_owned()
}

/// The bundled page (see the module comment). `read` returns an artifact file's bytes by name.
pub fn bundle(html: &str, read: impl Fn(&str) -> Option<Vec<u8>>) -> String {
  let read: &dyn Fn(&str) -> Option<Vec<u8>> = &read;
  static SCRIPT: OnceLock<Regex> = OnceLock::new();
  static LINK: OnceLock<Regex> = OnceLock::new();
  static STYLE: OnceLock<Regex> = OnceLock::new();
  static ATTR: OnceLock<Regex> = OnceLock::new();
  static TAG: OnceLock<Regex> = OnceLock::new();
  const VALUE: &str = r#"\s*=\s*(?:"(?P<q1>[^"]*)"|'(?P<q2>[^']*)'|(?P<bare>[^\s"'>]+))"#;

  // <script src="local.js"></script> → the code inline.
  let script = re(&SCRIPT, &format!(r#"(?is)<script\b(?P<pre>[^>]*?)\ssrc{VALUE}(?P<post>[^>]*)>\s*</script\s*>"#));
  let out = script.replace_all(html, |c: &Captures| {
    match local_ref(value(c)).and_then(|n| read(&n)) {
      Some(code) => {
        let code = String::from_utf8_lossy(&code);
        let safe = Regex::new(r"(?i)</script").expect("valid regex").replace_all(&code, r"<\/script").into_owned();
        format!("<script{}{}>{safe}</script>", &c["pre"], &c["post"])
      }
      None => c[0].to_owned(),
    }
  });
  // <link rel="stylesheet" href="local.css"> → <style> with its url()s inline.
  let link = re(&LINK, r#"(?is)<link\b[^>]*>"#);
  let out = link.replace_all(&out, |c: &Captures| {
    let tag = &c[0];
    static REL: OnceLock<Regex> = OnceLock::new();
    static HREF: OnceLock<Regex> = OnceLock::new();
    let stylesheet = re(&REL, &format!(r#"(?is)\srel{VALUE}"#)).captures(tag).is_some_and(|r| value(&r).split_whitespace().any(|w| w.eq_ignore_ascii_case("stylesheet")));
    let href = re(&HREF, &format!(r#"(?is)\shref{VALUE}"#)).captures(tag).map(|h| value(&h).to_owned());
    match (stylesheet, href.as_deref().and_then(local_ref)) {
      (true, Some(n)) => match read(&n) {
        Some(css) => {
          let base = n.rsplit_once('/').map_or(String::new(), |(dir, _)| format!("{dir}/"));
          format!("<style>{}</style>", inline_css(&String::from_utf8_lossy(&css), &base, read).replace("</style", "<\\/style"))
        }
        None => tag.to_owned(),
      },
      _ => tag.to_owned(),
    }
  });
  // <style> blocks: their url()s.
  let style = re(&STYLE, r"(?is)(<style\b[^>]*>)(.*?)(</style\s*>)");
  let out = style.replace_all(&out, |c: &Captures| format!("{}{}{}", &c[1], inline_css(&c[2], "", read), &c[3]));
  // Every other tag: src / href / poster / data attributes, and style="… url() …".
  let attr = re(&ATTR, &format!(r#"(?is)(?P<lead>\s)(?P<name>src|href|poster|data|xlink:href|style){VALUE}"#));
  let tag = re(&TAG, r#"(?s)<[a-zA-Z][^>]*>"#);
  let out = tag.replace_all(&out, |t: &Captures| {
    let text = &t[0];
    let lower = text.to_ascii_lowercase();
    // A plain link to another page stays a link (a data: URL there would not open).
    let is_anchor = lower.starts_with("<a ") || lower.starts_with("<a\n") || lower.starts_with("<a\t");
    attr
      .replace_all(text, |c: &Captures| {
        let name = c["name"].to_ascii_lowercase();
        let v = value(c);
        if name == "style" {
          return format!("{}{}=\"{}\"", &c["lead"], &c["name"], escape_attr(&inline_css(v, "", read)));
        }
        if is_anchor && name == "href" {
          return c[0].to_owned();
        }
        match local_ref(v).and_then(|n| read(&n).map(|b| (n, b))) {
          Some((n, b)) => format!("{}{}=\"{}\"", &c["lead"], &c["name"], data_url(&n, &b)),
          None => c[0].to_owned(),
        }
      })
      .into_owned()
  });
  let meta = format!("<meta http-equiv=\"Content-Security-Policy\" content=\"{}\">", csp(""));
  inject_first(&out, &meta)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::collections::HashMap;

  fn files() -> HashMap<&'static str, &'static [u8]> {
    HashMap::from([
      ("app.js", b"console.log('</script>')" as &[u8]),
      ("css/site.css", b"body{background:url(../img/bg.png)} h1{font:1em x}"),
      ("img/bg.png", b"BG"),
      ("img/a b.png", b"AB"),
      ("logo.svg", b"<svg/>"),
    ])
  }

  fn run(html: &str) -> String {
    let f = files();
    bundle(html, |n| f.get(n).map(|b| b.to_vec()))
  }

  #[test]
  fn resolves_only_local_references() {
    assert_eq!(local_ref("img/a.png").as_deref(), Some("img/a.png"));
    assert_eq!(local_ref("./img/../img/a.png?v=2#x").as_deref(), Some("img/a.png"));
    assert_eq!(local_ref("img/a%20b.png").as_deref(), Some("img/a b.png"));
    for remote in ["https://cdn.jsdelivr.net/x.js", "//evil.com/x", "/etc/passwd", "data:image/png;base64,AA", "#top", "", "../x", "a/../../x", "javascript:alert(1)", "C:\\x", "%zz"] {
      assert_eq!(local_ref(remote), None, "{remote}");
    }
  }

  #[test]
  fn inlines_scripts_styles_and_assets() {
    let html = r#"<!doctype html><html><head><link rel="stylesheet" href="css/site.css"><link rel=icon href="logo.svg"><script src="app.js" defer></script><script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1"></script></head>
<body style="background-image:url('img/bg.png')"><img src='img/a%20b.png' alt=x><img src="missing.png"><a href="other.html">next</a><a href="https://example.com">web</a></body></html>"#;
    let out = run(html);
    assert!(out.starts_with("<!doctype html><meta http-equiv=\"Content-Security-Policy\""), "{out}");
    assert!(out.contains("<script defer>console.log('<\\/script>')</script>"), "{out}");
    assert!(out.contains("<style>body{background:url(\"data:image/png;base64,Qkc=\")} h1{font:1em x}</style>"), "{out}");
    assert!(out.contains("href=\"data:image/svg+xml;base64,"), "{out}");
    assert!(out.contains("<script src=\"https://cdn.jsdelivr.net/npm/chart.js@4.4.1\"></script>"));
    assert!(out.contains("style=\"background-image:url(&quot;data:image/png;base64,Qkc=&quot;)\""), "{out}");
    assert!(out.contains("src=\"data:image/png;base64,QUI=\""));
    // What is not an artifact file is left alone; links to pages stay links.
    assert!(out.contains("<img src=\"missing.png\">") && out.contains("<a href=\"other.html\">") && out.contains("<a href=\"https://example.com\">"));
    assert!(!out.contains("css/site.css") && !out.contains("app.js"));
  }

  #[test]
  fn puts_the_policy_first() {
    let out = run("<p>hi</p>");
    assert!(out.starts_with("<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none';"));
    assert!(out.contains("connect-src 'none'") && out.contains("form-action 'none'") && out.ends_with("<p>hi</p>"));
    assert_eq!(inject_first("\u{feff}  <!DOCTYPE html>\n<p>", "X"), "  <!DOCTYPE html>X\n<p>");
    assert_eq!(inject_first("<html>", "X"), "X<html>");
  }

  #[test]
  fn mime_types() {
    assert_eq!(mime_of("a/b.WOFF2"), "font/woff2");
    assert_eq!(mime_of("x.html"), "text/html; charset=utf-8");
    assert_eq!(mime_of("noext"), "application/octet-stream");
  }
}
