//! VS Code globs (`files.watcherExclude`) over `/`-separated workspace-relative paths: `**`
//! spans folders, `*` and `?` stay within one, `{a,b}` and `[...]` work. Mirrors the webview's
//! `globToRegExp` (settings/mappings.ts), so a pattern means the same on both sides.

use regex::Regex;

pub fn to_regex(glob: &str) -> Option<Regex> {
  let chars: Vec<char> = glob.chars().collect();
  let mut re = String::from("^");
  let mut in_group = false;
  let mut i = 0;
  while i < chars.len() {
    let c = chars[i];
    if c == '*' && chars.get(i + 1) == Some(&'*') {
      let slash_after = chars.get(i + 2) == Some(&'/');
      re.push_str(if slash_after { "(?:.*/)?" } else { ".*" });
      i += if slash_after { 3 } else { 2 };
      continue;
    }
    match c {
      '*' => re.push_str("[^/]*"),
      '?' => re.push_str("[^/]"),
      '{' => {
        in_group = true;
        re.push_str("(?:");
      }
      '}' if in_group => {
        in_group = false;
        re.push(')');
      }
      ',' if in_group => re.push('|'),
      '[' => match chars[i + 1..].iter().position(|&ch| ch == ']') {
        Some(len) => {
          let body: String = chars[i + 1..i + 1 + len].iter().collect();
          let body = body.strip_prefix('!').map(|b| format!("^{b}")).unwrap_or(body).replace('\\', "\\\\");
          re.push_str(&format!("[{body}]"));
          i += len + 1;
        }
        None => re.push_str("\\["),
      },
      _ => re.push_str(&regex::escape(&c.to_string())),
    }
    i += 1;
  }
  re.push('$');
  Regex::new(&re).ok()
}

/// Whether `rel` or a folder above it matches one of `globs`, like VS Code's excludes.
pub fn is_excluded(rel: &str, globs: &[Regex]) -> bool {
  if globs.is_empty() || rel.is_empty() {
    return false;
  }
  let mut end = rel.len();
  loop {
    let prefix = &rel[..end];
    if globs.iter().any(|g| g.is_match(prefix)) {
      return true;
    }
    match prefix.rfind('/') {
      Some(i) => end = i,
      None => return false,
    }
  }
}

/// One sibling clause of an exclude map (VS Code: `"**/*.js": { "when": "$(basename).ts" }`).
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct SiblingClause {
  pub glob: String,
  pub when: String,
}

/// Compiled sibling clauses: a file matching `glob` is hidden when the file named by `when`
/// (with `$(basename)` = its name without the extension) is next to it.
pub struct SiblingClauses(Vec<(Regex, String)>);

impl SiblingClauses {
  pub fn new(clauses: &[SiblingClause]) -> Self {
    Self(clauses.iter().filter_map(|c| Some((to_regex(c.glob.trim())?, c.when.clone()))).collect())
  }

  pub fn is_empty(&self) -> bool {
    self.0.is_empty()
  }

  /// Whether `rel` is hidden by a clause, `exists` telling whether a workspace-relative path exists.
  pub fn hides(&self, rel: &str, exists: impl Fn(&str) -> bool) -> bool {
    let (dir, name) = rel.rsplit_once('/').map_or(("", rel), |(d, n)| (d, n));
    let base = name.rsplit_once('.').map_or(name, |(b, _)| b);
    self.0.iter().any(|(re, when)| {
      if !re.is_match(rel) {
        return false;
      }
      let sibling = when.replace("$(basename)", base);
      exists(&if dir.is_empty() { sibling } else { format!("{dir}/{sibling}") })
    })
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn sibling_clauses_hide_a_file_next_to_its_source() {
    let clauses = SiblingClauses::new(&[SiblingClause { glob: "**/*.js".into(), when: "$(basename).ts".into() }]);
    let files = ["src/a.ts", "src/a.js", "src/b.js", "c.ts", "c.js"];
    let exists = |p: &str| files.contains(&p);
    assert!(clauses.hides("src/a.js", exists));
    assert!(!clauses.hides("src/b.js", exists));
    assert!(clauses.hides("c.js", exists));
    assert!(!clauses.hides("src/a.ts", exists));
    assert!(SiblingClauses::new(&[]).is_empty());
  }

  fn compiled(globs: &[&str]) -> Vec<Regex> {
    globs.iter().filter_map(|g| to_regex(g)).collect()
  }

  #[test]
  fn matches_like_vscode_globs() {
    let re = to_regex("**/node_modules/*/**").unwrap();
    assert!(re.is_match("node_modules/react/index.js"));
    assert!(re.is_match("apps/web/node_modules/react/lib/a.js"));
    assert!(!re.is_match("node_modules"));
    assert!(to_regex("**/.git/objects/**").unwrap().is_match(".git/objects/ab/cdef"));
    assert!(to_regex("*.log").unwrap().is_match("a.log"));
    assert!(!to_regex("*.log").unwrap().is_match("logs/a.log"));
    assert!(to_regex("**/*.{js,ts}").unwrap().is_match("src/a.ts"));
    assert!(to_regex("build[0-9]").unwrap().is_match("build3"));
    assert!(to_regex("a.b").unwrap().is_match("a.b"));
    assert!(!to_regex("a.b").unwrap().is_match("axb"));
  }

  #[test]
  fn a_matching_folder_excludes_its_contents() {
    let globs = compiled(&["**/dist", "**/.git/objects/**"]);
    assert!(is_excluded("dist/a/b.js", &globs));
    assert!(is_excluded("pkg/dist", &globs));
    assert!(is_excluded(".git/objects/aa", &globs));
    assert!(!is_excluded("src/dist.ts", &globs));
    assert!(!is_excluded("", &globs));
    assert!(!is_excluded("dist", &[]));
  }
}
