//! Kingu's "always ask" checks for agent runs (Cursor's yoloOutsideWorkspaceDisabled,
//! yoloDeleteFileDisabled, yoloMcpToolsDisabled and .cursorignore): which ones are on and the
//! protected paths, sent with every run as the host's `guardAsks` (the host asks from its
//! PreToolUse hook, so no permission mode skips them). The switches come only from the user's own
//! settings.json, never from the page or the repository; the repository's `.kinguignore` can only
//! add protected paths (more questions, never fewer).

use std::path::Path;

/// The file of protected paths (gitignore patterns), in the run's folder or the open folder.
pub const IGNORE_FILE: &str = ".kinguignore";
/// What is read of a `.kinguignore`, and how many patterns go to the host in all (its limit).
const MAX_FILE: u64 = 64 * 1024;
pub const MAX_PATTERNS: usize = 500;
const MAX_PATTERN: usize = 500;

/// The host's `guardAsks` (camelCase on the wire).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardAsks {
  pub outside_cwd: bool,
  pub deletes: bool,
  pub mcp_tools: bool,
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub protected_paths: Vec<String>,
}

fn flag(value: Option<serde_json::Value>, default: bool) -> bool {
  value.and_then(|v| v.as_bool()).unwrap_or(default)
}

/// The patterns of a `.kinguignore` text (blank lines and comments left out).
pub fn patterns(text: &str) -> Vec<String> {
  text.lines().map(str::trim_end).filter(|l| !l.trim().is_empty() && !l.starts_with('#') && l.len() <= MAX_PATTERN).map(str::to_owned).collect()
}

/// `dir/.kinguignore` when it is a regular file (a symlink is not followed), else nothing.
fn read_ignore(dir: &Path) -> Vec<String> {
  let path = dir.join(IGNORE_FILE);
  match std::fs::symlink_metadata(&path) {
    Ok(m) if m.is_file() && m.len() <= MAX_FILE => std::fs::read_to_string(&path).map(|t| patterns(&t)).unwrap_or_default(),
    _ => Vec::new(),
  }
}

/// The asks from `kingu.agent.ask.*` and `kingu.agent.protectedPaths` (user settings), plus the
/// `.kinguignore` of the run's folder `dir` and of the open folder `root`.
pub fn from_settings(config: &Path, root: &Path, dir: &Path) -> GuardAsks {
  let user = |key: &str| crate::settings::user_value(config, key);
  let mut protected: Vec<String> = user("kingu.agent.protectedPaths")
    .and_then(|v| v.as_array().cloned())
    .unwrap_or_default()
    .into_iter()
    .filter_map(|v| v.as_str().map(str::to_owned))
    .filter(|p| !p.trim().is_empty() && p.len() <= MAX_PATTERN)
    .collect();
  protected.extend(read_ignore(dir));
  if dir != root {
    protected.extend(read_ignore(root));
  }
  let mut seen = std::collections::HashSet::new();
  protected.retain(|p| seen.insert(p.clone()));
  protected.truncate(MAX_PATTERNS);
  GuardAsks {
    outside_cwd: flag(user("kingu.agent.ask.outsideWorkspace"), true),
    deletes: flag(user("kingu.agent.ask.fileDeletes"), true),
    mcp_tools: flag(user("kingu.agent.ask.mcpTools"), false),
    protected_paths: protected,
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn defaults_and_user_settings() {
    let config = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let asks = from_settings(config.path(), root.path(), root.path());
    assert_eq!(asks, GuardAsks { outside_cwd: true, deletes: true, mcp_tools: false, protected_paths: vec![] });
    assert_eq!(serde_json::to_value(&asks).unwrap(), json!({"outsideCwd": true, "deletes": true, "mcpTools": false}));

    std::fs::write(
      crate::settings::user_path(config.path()),
      r#"{ // jsonc
        "kingu.agent.ask.fileDeletes": false, "kingu.agent.ask.mcpTools": true, "kingu.agent.protectedPaths": [".env*", "", 3] }"#,
    )
    .unwrap();
    let asks = from_settings(config.path(), root.path(), root.path());
    assert_eq!((asks.deletes, asks.mcp_tools, asks.protected_paths), (false, true, vec![".env*".to_owned()]));
  }

  #[test]
  fn kinguignore_of_the_run_folder_and_the_open_folder() {
    let config = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let wt = root.path().join(".kingu/worktrees/t");
    std::fs::create_dir_all(&wt).unwrap();
    std::fs::write(root.path().join(IGNORE_FILE), "# keys\nsecrets/\n\n*.pem\n").unwrap();
    std::fs::write(wt.join(IGNORE_FILE), "*.pem\nprod.yml\n").unwrap();
    assert_eq!(from_settings(config.path(), root.path(), &wt).protected_paths, ["*.pem", "prod.yml", "secrets/"]);
    assert_eq!(patterns("a\r\n  \n#c\nb  "), ["a", "b"]);
  }

  #[cfg(unix)]
  #[test]
  fn a_symlinked_kinguignore_is_not_read() {
    let config = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    std::fs::write(other.path().join("x"), "secret\n").unwrap();
    std::os::unix::fs::symlink(other.path().join("x"), root.path().join(IGNORE_FILE)).unwrap();
    assert!(from_settings(config.path(), root.path(), root.path()).protected_paths.is_empty());
  }
}
