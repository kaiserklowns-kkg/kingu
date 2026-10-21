//! `chat.tools.urls.autoApprove` (VS Code's chatUrlFetchingPatterns, reimplemented): URL patterns
//! → `true` / `false` or `{ approveRequest, approveResponse }`. The first pattern that matches a
//! URL and says something about requests decides; a URL no pattern approves is asked about.
//! Kingu has no separate review of a fetched response, so only the request half is used.
//!
//! A pattern without a scheme matches http and https. `*` matches any run of characters, and a
//! host's `*.` also matches no subdomain (`https://*.example.com` matches `https://example.com`).
//! A pattern's path matches that path and everything below it (`https://a.com/docs` matches
//! `https://a.com/docs/x`, not `https://a.com/docsx`); `:*` matches any port.

use serde_json::{Map, Value};

/// The patterns in order, each with what it says about requests (None: nothing).
#[derive(Debug, Clone, Default)]
pub struct UrlRules(Vec<(String, Option<bool>)>);

/// A URL taken apart for matching: lower-case scheme and authority, path without a trailing `/`.
#[derive(Debug, PartialEq, Eq)]
struct Parts {
  scheme: String,
  authority: String,
  path: String,
}

/// A fetchable URL's parts, or None (no host, user info in it, not a URL).
fn url_parts(url: &str) -> Option<Parts> {
  let u = url::Url::parse(url.trim()).ok()?;
  if !u.username().is_empty() || u.password().is_some() {
    return None;
  }
  let host = u.host_str()?;
  let authority = match u.port() {
    Some(p) => format!("{host}:{p}"),
    None => host.to_owned(),
  };
  Some(Parts { scheme: u.scheme().to_owned(), authority: authority.to_lowercase(), path: u.path().trim_end_matches('/').to_owned() })
}

/// A pattern's parts (no URL parser: hosts may hold `*`); `scheme` is the URL's when it has none.
fn pattern_parts(pattern: &str, url_scheme: &str) -> Option<Parts> {
  let has_scheme = pattern.find("://").is_some_and(|i| !pattern[..i].contains(['.', '/', ':']));
  let (scheme, rest) = if has_scheme {
    let (s, r) = pattern.split_once("://")?;
    (s.to_lowercase(), r)
  } else {
    if url_scheme != "http" && url_scheme != "https" {
      return None;
    }
    (url_scheme.to_owned(), pattern)
  };
  let rest = rest.split(['?', '#']).next().unwrap_or("");
  let (authority, path) = match rest.find('/') {
    Some(i) => (&rest[..i], &rest[i..]),
    None => (rest, ""),
  };
  Some(Parts { scheme, authority: authority.to_lowercase(), path: path.trim_end_matches('/').to_owned() })
}

/// VS Code's `doUrlPartMatch`: equal; without `*`, a prefix ending at a `/`; with `*`, a glob
/// (`*.` may match nothing at a label start, `:*` any port when `port`). A glob that ends where the
/// text goes on at a `/` matches too (a path matches what is below it).
fn part_match(text: &str, glob: &str, port: bool) -> bool {
  if text == glob {
    return true;
  }
  if !glob.contains('*') {
    return text.starts_with(&format!("{glob}/"));
  }
  let t: Vec<char> = text.chars().collect();
  let g: Vec<char> = glob.chars().collect();
  // States (text offset, glob offset) still to try; each moves forward, so a seen set bounds it.
  let mut seen = std::collections::HashSet::new();
  let mut todo = vec![(0usize, 0usize)];
  while let Some((ti, gi)) = todo.pop() {
    if !seen.insert((ti, gi)) {
      continue;
    }
    let any_port = port && g.get(gi) == Some(&':') && g.get(gi + 1) == Some(&'*');
    if ti == t.len() {
      if gi == g.len() || (any_port && gi + 2 == g.len()) || g[gi..].iter().all(|&c| c == '*') {
        return true;
      }
      continue;
    }
    if gi == g.len() {
      if t[ti] == '/' {
        return true;
      }
      continue;
    }
    if t[ti] == g[gi] {
      todo.push((ti + 1, gi + 1));
    }
    if g[gi] == '*' {
      if gi + 1 == g.len() {
        return true;
      }
      if g[gi + 1] == '.' {
        // `*.`: labels only (never across `/` or a port), or nothing at a label start.
        if t[ti] != '/' && t[ti] != ':' {
          todo.push((ti + 1, gi));
        }
        if ti == 0 || t[ti - 1] == '.' {
          todo.push((ti, gi + 2));
        }
      } else {
        todo.push((ti + 1, gi));
      }
      todo.push((ti, gi + 1));
    }
    if any_port {
      let mut end = ti;
      if t[ti] == ':' {
        end += 1;
        while t.get(end).is_some_and(char::is_ascii_digit) {
          end += 1;
        }
      }
      todo.push((end, gi + 2));
    }
  }
  false
}

/// Whether `url` matches `pattern`.
pub fn matches(url: &str, pattern: &str) -> bool {
  let Some(u) = url_parts(url) else { return pattern == "*" };
  if pattern == "*" {
    return true;
  }
  let Some(p) = pattern_parts(pattern.trim(), &u.scheme) else { return false };
  part_match(&u.scheme, &p.scheme, false) && part_match(&u.authority, &p.authority, true) && (p.path.is_empty() || part_match(&u.path, &p.path, false))
}

/// The key "Always allow this domain" adds for `url`: its scheme and host (`https://docs.rs`).
pub fn domain_key(url: &str) -> Option<String> {
  let u = url_parts(url)?;
  matches!(u.scheme.as_str(), "http" | "https").then(|| format!("{}://{}", u.scheme, u.authority))
}

impl UrlRules {
  /// The rules of a setting value (defaults merged with the user's, in order).
  pub fn new(config: &Map<String, Value>) -> Self {
    Self(
      config
        .iter()
        .map(|(k, v)| {
          let request = match v {
            Value::Bool(b) => Some(*b),
            Value::Object(o) => o.get("approveRequest").and_then(Value::as_bool),
            _ => None,
          };
          (k.clone(), request)
        })
        .collect(),
    )
  }

  /// The pattern that approves requesting `url`, or None (the user is asked).
  pub fn approving(&self, url: &str) -> Option<&str> {
    for (pattern, request) in &self.0 {
      if let Some(v) = request
        && matches(url, pattern)
      {
        return v.then_some(pattern.as_str());
      }
    }
    None
  }
}

/// VS Code's merge for this object setting: the user's keys over the defaults (`null` removes one).
pub fn merged(defaults: &Map<String, Value>, user: Option<&Value>) -> Map<String, Value> {
  super::terminal::merged(defaults, user, false)
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn hosts_paths_and_schemes() {
    assert!(matches("https://example.com", "https://example.com"));
    assert!(matches("https://example.com/a/b?q=1#x", "https://example.com"));
    assert!(matches("https://EXAMPLE.com/", "example.com"));
    assert!(matches("http://example.com/x", "example.com"));
    assert!(!matches("ftp://example.com/x", "example.com"));
    assert!(!matches("http://example.com", "https://example.com"));
    assert!(!matches("https://example.com.evil.net", "https://example.com"));
    assert!(!matches("https://evil.net/https://example.com", "https://example.com"));
    assert!(!matches("https://example.com:8443", "https://example.com"));
    assert!(matches("https://example.com:8443/x", "https://example.com:*"));
    assert!(matches("https://example.com/x", "https://example.com:*"));
  }

  #[test]
  fn paths_match_below() {
    assert!(matches("https://a.com/docs", "https://a.com/docs"));
    assert!(matches("https://a.com/docs/x/y", "https://a.com/docs/"));
    assert!(!matches("https://a.com/docsx", "https://a.com/docs"));
    assert!(!matches("https://a.com/", "https://a.com/docs"));
    assert!(matches("https://github.com/microsoft/vscode/wiki/Home", "https://github.com/microsoft/vscode/wiki/*"));
    assert!(!matches("https://github.com/microsoft/vscode/issues", "https://github.com/microsoft/vscode/wiki/*"));
    assert!(matches("https://a.com/api/v1/users", "https://a.com/api/*/users"));
  }

  #[test]
  fn wildcard_subdomains() {
    assert!(matches("https://docs.contoso.com/x", "https://*.contoso.com/*"));
    assert!(matches("https://a.b.contoso.com", "https://*.contoso.com"));
    assert!(matches("https://contoso.com", "https://*.contoso.com"));
    assert!(!matches("https://evilcontoso.com", "https://*.contoso.com"));
    assert!(!matches("https://contoso.com.evil.net", "https://*.contoso.com"));
    assert!(matches("https://anything.net/x", "*"));
  }

  #[test]
  fn unsafe_urls_only_match_star() {
    assert!(!matches("https://user:pw@example.com", "https://example.com"));
    assert!(matches("https://user@example.com", "*"));
    assert!(!matches("not a url", "https://example.com"));
  }

  #[test]
  fn first_rule_with_a_request_value_decides() {
    let rules = UrlRules::new(&merged(
      &json!({ "https://code.visualstudio.com": true }).as_object().unwrap().clone(),
      Some(&json!({
        "https://www.example.com": false,
        "https://*.example.com": true,
        "https://api.example.com/v1": { "approveResponse": true },
        "https://api.example.com": { "approveRequest": true, "approveResponse": false },
        "https://code.visualstudio.com": null
      })),
    ));
    assert_eq!(rules.approving("https://www.example.com/x"), None);
    assert_eq!(rules.approving("https://docs.example.com/x"), Some("https://*.example.com"));
    assert_eq!(rules.approving("https://example.com"), Some("https://*.example.com"));
    assert_eq!(rules.approving("https://other.net"), None);
    assert_eq!(rules.approving("https://code.visualstudio.com/docs"), None);
    let rules = UrlRules::new(json!({ "https://api.example.com/v1": { "approveResponse": true }, "https://api.example.com": { "approveRequest": true } }).as_object().unwrap());
    assert_eq!(rules.approving("https://api.example.com/v1/x"), Some("https://api.example.com"));
  }

  #[test]
  fn domain_keys() {
    assert_eq!(domain_key("https://Docs.rs/serde/latest?x=1").as_deref(), Some("https://docs.rs"));
    assert_eq!(domain_key("http://localhost:3000/a").as_deref(), Some("http://localhost:3000"));
    assert_eq!(domain_key("file:///etc/passwd"), None);
    assert_eq!(domain_key("https://u:p@x.com"), None);
    // The key approves the whole site.
    assert!(matches("https://docs.rs/serde/latest", &domain_key("https://docs.rs/x").unwrap()));
  }
}
