//! The chat input's `/` list while no session is live: custom commands (`.claude/commands/**/*.md`
//! of the chat's folder and of the user) and skills (`.claude/skills/<name>/SKILL.md`), with the
//! description and argument hint from their front matter. A live session reports its own list
//! (the sidecar's `commands` event), which also has Claude Code's built-in commands.
//!
//! Only names and front matter are read (the first few KB of each file); symlinks are skipped,
//! so a repository cannot point the list at files outside it.

use std::path::{Path, PathBuf};


use crate::workspace::Workspace;

/// Files read per source, and how deep `commands/` is walked.
const MAX_FILES: usize = 500;
const MAX_DEPTH: usize = 4;
const HEAD_BYTES: usize = 8 * 1024;
const MAX_DESCRIPTION: usize = 200;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct FileCommand {
  /// Without the leading `/`; a subfolder becomes a `dir:name` prefix.
  pub name: String,
  pub description: String,
  pub argument_hint: String,
  /// `project` / `user` (a commands file) or `project-skill` / `user-skill`.
  pub source: &'static str,
}

/// The user's Claude Code folder: `$CLAUDE_CONFIG_DIR`, else `~/.claude`.
fn claude_home() -> Option<PathBuf> {
  match std::env::var_os("CLAUDE_CONFIG_DIR") {
    Some(dir) if !dir.is_empty() => Some(PathBuf::from(dir)),
    _ => std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".claude")),
  }
}

/// `description` and `argument-hint` from a `---` front matter block; with no description, the
/// first line of the body (as Claude Code shows it).
fn front_matter(text: &str) -> (Option<String>, Option<String>, Option<String>) {
  let text = text.strip_prefix('\u{feff}').unwrap_or(text);
  let (mut name, mut description, mut hint) = (None, None, None);
  let mut body = text;
  if let Some(rest) = text.strip_prefix("---\n").or_else(|| text.strip_prefix("---\r\n")) {
    let end = rest.find("\n---").unwrap_or(rest.len());
    for line in rest[..end].lines() {
      let Some((key, value)) = line.split_once(':') else { continue };
      let value = value.trim().trim_matches(|c| c == '"' || c == '\'').trim();
      if value.is_empty() {
        continue;
      }
      match key.trim() {
        "name" => name = Some(value.to_owned()),
        "description" => description = Some(value.to_owned()),
        "argument-hint" => hint = Some(value.to_owned()),
        _ => {}
      }
    }
    body = rest.get(end + 4..).unwrap_or("");
  }
  let description = description.or_else(|| body.lines().map(str::trim).find(|l| !l.is_empty()).map(|l| l.trim_start_matches('#').trim().to_owned()));
  (name, description, hint)
}

fn cut(s: Option<String>, max: usize) -> String {
  let s = s.unwrap_or_default();
  if s.chars().count() > max { format!("{}…", s.chars().take(max).collect::<String>()) } else { s }
}

/// The start of a file (front matter fits), lossy UTF-8; None when it cannot be read.
fn head(path: &Path) -> Option<String> {
  use std::io::Read;
  let mut buf = Vec::with_capacity(HEAD_BYTES);
  std::fs::File::open(path).ok()?.take(HEAD_BYTES as u64).read_to_end(&mut buf).ok()?;
  Some(String::from_utf8_lossy(&buf).into_owned())
}

/// A plain directory (not a symlink).
fn real_dir(p: &Path) -> bool {
  std::fs::symlink_metadata(p).is_ok_and(|m| m.is_dir())
}

/// A command name segment Claude Code accepts: no spaces, slashes or colons.
fn valid_segment(s: &str) -> bool {
  !s.is_empty() && s.len() <= 100 && !s.starts_with('.') && s.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// `commands/**/*.md` under `dir`.
fn commands_in(dir: &Path, source: &'static str, out: &mut Vec<FileCommand>) {
  fn walk(dir: &Path, prefix: &[String], depth: usize, source: &'static str, seen: &mut usize, out: &mut Vec<FileCommand>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
      if *seen >= MAX_FILES {
        return;
      }
      let Ok(kind) = e.file_type() else { continue };
      let file_name = e.file_name();
      let Some(fname) = file_name.to_str() else { continue };
      if kind.is_dir() && depth < MAX_DEPTH && valid_segment(fname) {
        let mut next = prefix.to_vec();
        next.push(fname.to_owned());
        walk(&e.path(), &next, depth + 1, source, seen, out);
      } else if kind.is_file()
        && let Some(stem) = fname.strip_suffix(".md")
        && valid_segment(stem)
      {
        *seen += 1;
        let Some(text) = head(&e.path()) else { continue };
        let (_, description, hint) = front_matter(&text);
        let mut parts = prefix.to_vec();
        parts.push(stem.to_owned());
        out.push(FileCommand { name: parts.join(":"), description: cut(description, MAX_DESCRIPTION), argument_hint: cut(hint, 100), source });
      }
    }
  }
  if real_dir(dir) {
    walk(dir, &[], 0, source, &mut 0, out);
  }
}

/// `skills/<name>/SKILL.md` under `dir`.
fn skills_in(dir: &Path, source: &'static str, out: &mut Vec<FileCommand>) {
  if !real_dir(dir) {
    return;
  }
  let Ok(entries) = std::fs::read_dir(dir) else { return };
  let mut entries: Vec<_> = entries.flatten().collect();
  entries.sort_by_key(|e| e.file_name());
  for e in entries.into_iter().take(MAX_FILES) {
    let file_name = e.file_name();
    let Some(folder) = file_name.to_str() else { continue };
    if !e.file_type().is_ok_and(|k| k.is_dir()) || !valid_segment(folder) {
      continue;
    }
    let skill = e.path().join("SKILL.md");
    if !std::fs::symlink_metadata(&skill).is_ok_and(|m| m.is_file()) {
      continue;
    }
    let Some(text) = head(&skill) else { continue };
    let (name, description, hint) = front_matter(&text);
    let name = name.filter(|n| valid_segment(n)).unwrap_or_else(|| folder.to_owned());
    out.push(FileCommand { name, description: cut(description, MAX_DESCRIPTION), argument_hint: cut(hint, 100), source });
  }
}

/// The folder's commands and skills, then the user's; a name the folder has hides the user's.
pub fn list(project: Option<&Path>, user: Option<&Path>) -> Vec<FileCommand> {
  let mut all = Vec::new();
  if let Some(dir) = project {
    commands_in(&dir.join(".claude/commands"), "project", &mut all);
    skills_in(&dir.join(".claude/skills"), "project-skill", &mut all);
  }
  if let Some(dir) = user {
    commands_in(&dir.join("commands"), "user", &mut all);
    skills_in(&dir.join("skills"), "user-skill", &mut all);
  }
  let mut seen = std::collections::HashSet::new();
  all.retain(|c| seen.insert(c.name.clone()));
  all.sort_by(|a, b| a.name.cmp(&b.name));
  all
}

/// The `/` list for a chat that has no live session. `cwd`: where the chat runs (the open folder
/// or one of its task worktrees, checked like `agent_start`); the open folder when omitted.
#[tauri::command]
pub async fn chat_slash_commands(ws: Workspace, cwd: Option<String>) -> Result<Vec<FileCommand>, String> {
  let project = match ws.current() {
    Some(root) => Some(match cwd.as_deref() {
      Some(dir) => super::chats::resolve_cwd(&root, Path::new(dir))?,
      None => root,
    }),
    None => None,
  };
  tauri::async_runtime::spawn_blocking(move || list(project.as_deref(), claude_home().as_deref())).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
  }

  #[test]
  fn reads_front_matter() {
    let (name, d, h) = front_matter("---\ndescription: \"Review a PR\"\nargument-hint: <pr-number>\nallowed-tools: Bash(gh:*)\n---\nDo it");
    assert_eq!((name, d.as_deref(), h.as_deref()), (None, Some("Review a PR"), Some("<pr-number>")));
    let (_, d, h) = front_matter("\n# Fix the tests\n\nRun them.");
    assert_eq!((d.as_deref(), h), (Some("Fix the tests"), None));
    let (name, d, _) = front_matter("---\r\nname: deploy\r\n---\r\nShip the build\r\n");
    assert_eq!((name.as_deref(), d.as_deref()), (Some("deploy"), Some("Ship the build")));
    assert_eq!(cut(Some("ก".repeat(5)), 3), "กกก…");
  }

  #[test]
  fn lists_commands_and_skills_project_first() {
    let tmp = tempfile::tempdir().unwrap();
    let (project, user) = (tmp.path().join("repo"), tmp.path().join("home"));
    write(&project.join(".claude/commands/review.md"), "---\ndescription: Review\nargument-hint: <pr>\n---\n");
    write(&project.join(".claude/commands/frontend/component.md"), "Make a component\n");
    write(&project.join(".claude/commands/notes.txt"), "not a command");
    write(&project.join(".claude/commands/bad name.md"), "spaces");
    write(&project.join(".claude/skills/pdf/SKILL.md"), "---\nname: pdf\ndescription: Read PDFs\n---\n");
    write(&project.join(".claude/skills/empty/README.md"), "no skill file");
    write(&user.join("commands/review.md"), "---\ndescription: Mine\n---\n");
    write(&user.join("commands/standup.md"), "Write my standup");
    let all = list(Some(&project), Some(&user));
    let names: Vec<_> = all.iter().map(|c| (c.name.as_str(), c.source, c.description.as_str())).collect();
    assert_eq!(
      names,
      vec![
        ("frontend:component", "project", "Make a component"),
        ("pdf", "project-skill", "Read PDFs"),
        ("review", "project", "Review"),
        ("standup", "user", "Write my standup"),
      ]
    );
    assert_eq!(all.iter().find(|c| c.name == "review").unwrap().argument_hint, "<pr>");
    assert!(list(None, None).is_empty());
  }

  #[cfg(unix)]
  #[test]
  fn skips_symlinks() {
    let tmp = tempfile::tempdir().unwrap();
    let outside = tmp.path().join("outside");
    write(&outside.join("secret.md"), "---\ndescription: secret\n---\n");
    let project = tmp.path().join("repo");
    std::fs::create_dir_all(project.join(".claude/commands")).unwrap();
    std::os::unix::fs::symlink(outside.join("secret.md"), project.join(".claude/commands/leak.md")).unwrap();
    std::os::unix::fs::symlink(&outside, project.join(".claude/commands/linked")).unwrap();
    std::os::unix::fs::symlink(&outside, project.join(".claude/skills")).unwrap();
    assert!(list(Some(&project), None).is_empty());
  }
}
