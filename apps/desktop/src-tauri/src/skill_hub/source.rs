//! Links a skill can be installed from, and the share link that installs an installed one again.
//!
//! - A git repository: `<url>`, `<url>#<ref>`, `<url>#<ref>:<folder>` or `<url>#:<folder>`
//!   (Docker's build-context syntax), with the URLs `snap_install::parse_git_source` accepts
//!   (https, ssh, `user@host:path`, local paths and `file://`).
//! - A GitHub page: `https://github.com/<owner>/<repo>[/tree|blob/<ref>/<folder>]`. A ref may
//!   hold `/`, so `tree/a/b/c` is tried as ref `a` with folder `b/c`, then `a/b` with `c`, ….
//! - An archive: an https URL whose path ends in `.skill` or `.zip`, or a local one by its
//!   absolute path.
//! - A local skill folder (or a folder of skills) by its absolute path.

use crate::i18n::msg::SkillMsg;
use crate::snap_install::parse_git_source;
use crate::tr;
use super::package::entry_path;

/// One way to fetch a git link: the repository, a branch, tag or commit, and the folder in it.
#[derive(Debug, Clone, PartialEq)]
pub struct GitLink {
  pub url: String,
  pub git_ref: Option<String>,
  /// `/`-separated folder inside the repository, `""` for its root.
  pub path: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Link {
  /// The readings of the link to try in order (more than one only for a GitHub tree URL).
  Git(Vec<GitLink>),
  Archive { url: String },
  LocalArchive { path: String },
  LocalFolder { path: String },
}

/// How many ways a GitHub tree URL's ref / folder split is tried.
const MAX_REF_GUESSES: usize = 3;

fn is_archive_name(path: &str) -> bool {
  let lower = path.to_ascii_lowercase();
  lower.ends_with(".skill") || lower.ends_with(".zip")
}

/// `HEAD` means the default branch, which is what no ref does.
fn named_ref(r: &str) -> Option<String> {
  (!r.is_empty() && r != "HEAD").then(|| r.to_string())
}

fn folder(path: &str) -> Result<String, String> {
  if path.is_empty() {
    return Ok(String::new());
  }
  entry_path(path).ok_or_else(|| tr!(SkillMsg::LinkFolderInvalid, path = format!("{path:?}")))
}

/// Checks the repository URL and ref the way snaps do (no `ext::`, no options, no plain http).
fn checked(url: &str, git_ref: Option<String>, path: String) -> Result<GitLink, String> {
  let spec = parse_git_source(&match &git_ref {
    Some(r) => format!("{url}#{r}"),
    None => url.to_string(),
  })?;
  Ok(GitLink { url: spec.url, git_ref: spec.git_ref, path })
}

fn github(url: &url::Url) -> Option<Result<Link, String>> {
  if !matches!(url.host_str(), Some("github.com" | "www.github.com")) {
    return None;
  }
  let segments: Vec<&str> = url.path_segments()?.filter(|s| !s.is_empty()).collect();
  let [owner, repo, rest @ ..] = segments.as_slice() else { return None };
  let repo = repo.strip_suffix(".git").unwrap_or(repo);
  let base = format!("https://github.com/{owner}/{repo}");
  let (kind, tail) = match rest {
    [] => return None,
    [kind, tail @ ..] => (*kind, tail),
  };
  if !matches!(kind, "tree" | "blob") || tail.is_empty() {
    return Some(Err(tr!(SkillMsg::LinkNotSkill, url = url.as_str())));
  }
  let mut tail = tail.to_vec();
  // `blob/<ref>/<folder>/SKILL.md`: the skill is the folder.
  if kind == "blob" {
    if tail.last() != Some(&"SKILL.md") {
      return Some(Err(tr!(SkillMsg::LinkNotSkill, url = url.as_str())));
    }
    tail.pop();
  }
  let mut out = Vec::new();
  for k in 1..=tail.len().min(MAX_REF_GUESSES) {
    let git_ref = tail[..k].join("/");
    let path = match folder(&tail[k..].join("/")) {
      Ok(p) => p,
      Err(e) => return Some(Err(e)),
    };
    match checked(&base, named_ref(&git_ref), path) {
      Ok(l) => out.push(l),
      Err(e) if out.is_empty() => return Some(Err(e)),
      Err(_) => {}
    }
  }
  Some(Ok(Link::Git(out)))
}

/// Reads what the user pasted.
pub fn parse_link(input: &str) -> Result<Link, String> {
  let input = input.trim();
  if input.is_empty() {
    return Err(tr!(SkillMsg::LinkEmpty));
  }
  if input.starts_with('/') && !input.contains('#') {
    return Ok(if is_archive_name(input) { Link::LocalArchive { path: input.to_string() } } else { Link::LocalFolder { path: input.to_string() } });
  }
  let lower = input.to_ascii_lowercase();
  if lower.starts_with("https://") || lower.starts_with("http://") {
    // The URL parser would quietly resolve `..`; a link that needs it is not one we were given.
    if input.split(['/', '?', '#']).any(|s| s == ".." || s == ".") {
      return Err(tr!(SkillMsg::LinkInvalid, url = input));
    }
    let url = url::Url::parse(input).map_err(|_| tr!(SkillMsg::LinkInvalid, url = input))?;
    if url.scheme() == "http" {
      return Err(tr!(SkillMsg::LinkNotHttps, url = input));
    }
    if is_archive_name(url.path()) {
      return Ok(Link::Archive { url: url.to_string() });
    }
    if let Some(link) = github(&url) {
      return link;
    }
  }
  // Any other git URL, with an optional `#<ref>[:<folder>]`.
  let (url, git_ref, path) = match input.rsplit_once('#') {
    Some((url, frag)) => match frag.split_once(':') {
      Some((r, p)) => (url, named_ref(r), folder(p)?),
      None => (url, named_ref(frag), String::new()),
    },
    None => (input, None, String::new()),
  };
  let url = match url::Url::parse(url) {
    // A GitHub page with our fragment: the repository itself.
    Ok(u) if matches!(u.host_str(), Some("github.com" | "www.github.com")) && u.scheme() == "https" => {
      let segments: Vec<&str> = u.path_segments().map(|s| s.filter(|s| !s.is_empty()).collect()).unwrap_or_default();
      match segments.as_slice() {
        [owner, repo] => format!("https://github.com/{owner}/{}", repo.strip_suffix(".git").unwrap_or(repo)),
        _ => url.to_string(),
      }
    }
    _ => url.to_string(),
  };
  Ok(Link::Git(vec![checked(&url, git_ref, path)?]))
}

/// A link that installs the skill at `path` of git `url` (at `git_ref`, else the default branch):
/// a GitHub tree URL for GitHub, otherwise `<url>#<ref>:<folder>`.
pub fn share_link(url: &str, git_ref: Option<&str>, path: &str) -> String {
  if let Some(rest) = url.strip_prefix("https://github.com/") {
    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    if rest.split('/').count() == 2 {
      if git_ref.is_none() && path.is_empty() {
        return format!("https://github.com/{rest}");
      }
      let r = git_ref.unwrap_or("HEAD");
      return if path.is_empty() { format!("https://github.com/{rest}/tree/{r}") } else { format!("https://github.com/{rest}/tree/{r}/{path}") };
    }
  }
  match (git_ref, path.is_empty()) {
    (None, true) => url.to_string(),
    (Some(r), true) => format!("{url}#{r}"),
    (r, false) => format!("{url}#{}:{path}", r.unwrap_or("")),
  }
}

/// Only links other computers can open can be shared (not a local path or `file://`).
pub fn is_remote(url: &str) -> bool {
  !url.starts_with('/') && !url.to_ascii_lowercase().starts_with("file:")
}

#[cfg(test)]
mod tests {
  use super::*;

  fn git(url: &str, git_ref: Option<&str>, path: &str) -> GitLink {
    GitLink { url: url.into(), git_ref: git_ref.map(String::from), path: path.into() }
  }

  #[test]
  fn git_urls() {
    assert_eq!(parse_link("https://example.com/team/skills.git").unwrap(), Link::Git(vec![git("https://example.com/team/skills.git", None, "")]));
    assert_eq!(parse_link(" git@example.com:team/skills.git#v1 ").unwrap(), Link::Git(vec![git("git@example.com:team/skills.git", Some("v1"), "")]));
    assert_eq!(parse_link("https://example.com/s.git#main:skills/pdf").unwrap(), Link::Git(vec![git("https://example.com/s.git", Some("main"), "skills/pdf")]));
    assert_eq!(parse_link("ssh://git@example.com/s.git#:skills/pdf").unwrap(), Link::Git(vec![git("ssh://git@example.com/s.git", None, "skills/pdf")]));
    assert_eq!(parse_link("file:///srv/s.git#HEAD:pdf").unwrap(), Link::Git(vec![git("file:///srv/s.git", None, "pdf")]));
    assert_eq!(parse_link("https://github.com/o/r.git#dev:pdf").unwrap(), Link::Git(vec![git("https://github.com/o/r", Some("dev"), "pdf")]));
  }

  #[test]
  fn github_pages() {
    assert_eq!(parse_link("https://github.com/anthropics/skills").unwrap(), Link::Git(vec![git("https://github.com/anthropics/skills", None, "")]));
    assert_eq!(parse_link("https://github.com/o/r/tree/main/skills/pdf").unwrap(), Link::Git(vec![git("https://github.com/o/r", Some("main"), "skills/pdf"), git("https://github.com/o/r", Some("main/skills"), "pdf"), git("https://github.com/o/r", Some("main/skills/pdf"), "")]));
    assert_eq!(parse_link("https://github.com/o/r/tree/HEAD/pdf").unwrap(), Link::Git(vec![git("https://github.com/o/r", None, "pdf"), git("https://github.com/o/r", Some("HEAD/pdf"), "")]));
    assert_eq!(parse_link("https://github.com/o/r/blob/v2/pdf/SKILL.md").unwrap(), Link::Git(vec![git("https://github.com/o/r", Some("v2"), "pdf"), git("https://github.com/o/r", Some("v2/pdf"), "")]));
    let sha = "0123456789abcdef0123456789abcdef01234567";
    assert_eq!(parse_link(&format!("https://github.com/o/r/tree/{sha}")).unwrap(), Link::Git(vec![git("https://github.com/o/r", Some(sha), "")]));
    assert!(parse_link("https://github.com/o/r/issues/1").is_err());
    assert!(parse_link("https://github.com/o/r/blob/main/README.md").is_err());
  }

  #[test]
  fn archives_and_paths() {
    assert_eq!(parse_link("https://example.com/dl/pdf.skill?x=1").unwrap(), Link::Archive { url: "https://example.com/dl/pdf.skill?x=1".into() });
    assert_eq!(parse_link("https://github.com/o/r/archive/refs/heads/main.zip").unwrap(), Link::Archive { url: "https://github.com/o/r/archive/refs/heads/main.zip".into() });
    assert_eq!(parse_link("/Users/me/Downloads/pdf.SKILL").unwrap(), Link::LocalArchive { path: "/Users/me/Downloads/pdf.SKILL".into() });
    assert_eq!(parse_link("/Users/me/skills/pdf").unwrap(), Link::LocalFolder { path: "/Users/me/skills/pdf".into() });
  }

  #[test]
  fn refuses_unsafe_links() {
    for bad in ["", "http://example.com/s.git", "http://example.com/pdf.skill", "ext::sh -c touch% /tmp/x", "--upload-pack=x", "https://example.com/s.git#main:../x", "https://example.com/s.git#main:/abs", "https://example.com/s.git#-x", "https://github.com/o/r/tree/main/a/../../b", "not a link"] {
      assert!(parse_link(bad).is_err(), "{bad:?}");
    }
  }

  #[test]
  fn share_links_round_trip() {
    let cases = [
      ("https://github.com/o/r", None, ""),
      ("https://github.com/o/r", Some("main"), "skills/pdf"),
      ("https://github.com/o/r", None, "pdf"),
      ("https://github.com/o/r", Some("v1"), ""),
      ("https://example.com/s.git", None, ""),
      ("https://example.com/s.git", Some("v1"), ""),
      ("https://example.com/s.git", Some("v1"), "a/b"),
      ("git@example.com:s.git", None, "a"),
    ];
    for (url, r, path) in cases {
      let link = share_link(url, r, path);
      let Link::Git(readings) = parse_link(&link).unwrap() else { panic!("{link}") };
      assert_eq!(readings[0], git(url, r, path), "{link}");
    }
    assert_eq!(share_link("https://github.com/o/r.git", Some("main"), "pdf"), "https://github.com/o/r/tree/main/pdf");
    assert!(is_remote("https://x/y") && !is_remote("/srv/s.git") && !is_remote("FILE:///s"));
  }
}
