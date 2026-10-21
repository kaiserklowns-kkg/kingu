//! Rules files beyond CLAUDE.md (Cursor's rules, Copilot's instructions), for agent chats:
//!
//! - `AGENTS.md` in the run folder and in every folder from there down to an attached file's,
//!   the nearer one last (it wins);
//! - `.cursor/rules/**/*.mdc` (and `.md`): frontmatter `alwaysApply`, `globs` (matched against the
//!   attached files) and `description`. A rule with only a description is not applied but listed
//!   to the agent, which can read it when it matters (Cursor's "agent requested");
//! - `.github/copilot-instructions.md`;
//! - VS Code's instructions files (`*.instructions.md` in `chat.instructionsFilesLocations`,
//!   `customizations.rs`): `applyTo` globs like Cursor's, and a `description` alone lists it.
//!
//! VS Code's `chat.useAgentsMdFile` (AGENTS.md) and `chat.includeApplyingInstructions` (`applyTo`
//! and Cursor's globs) switch parts off; like the locations they are read from the user's own
//! settings.json only (`Options::from_user`).
//!
//! CLAUDE.md is left out: the SDK loads it (`settingSources`). The applied rules' text goes after
//! Claude Code's system prompt (`system_append`, the host's `systemPromptAppend`), and
//! `chat_rules` lists them for the composer's "N rules" chip. Files are read only inside the run
//! folder (canonicalized, no symlinked files), and each and all of them are size-capped.

use std::path::{Component, Path, PathBuf};


use crate::workspace::Workspace;

/// One rule file's text is cut to this, and all of them together to `MAX_TOTAL`.
pub const MAX_RULE_BYTES: usize = 64 * 1024;
pub const MAX_TOTAL: usize = 128 * 1024;
/// Attached files looked at (the rest are ignored), and `.cursor/rules` files read.
pub const MAX_FILES: usize = 200;
const MAX_CURSOR_RULES: usize = 100;
const MAX_DEPTH: usize = 4;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleKind {
  Agents,
  Cursor,
  Copilot,
  Instructions,
}

/// What `discover` looks at besides the files (VS Code's chat settings; all on by default).
#[derive(Debug, Clone)]
pub struct Options {
  /// `chat.useAgentsMdFile`.
  pub agents_md: bool,
  /// `chat.includeApplyingInstructions`: rules whose globs match an attached file apply.
  pub applying: bool,
  /// Where instructions files are (`chat.instructionsFilesLocations`).
  pub locations: super::customizations::Settings,
  pub home: Option<PathBuf>,
}

impl Default for Options {
  fn default() -> Self {
    Self { agents_md: true, applying: true, locations: Default::default(), home: None }
  }
}

impl Options {
  pub fn from_user(config: &Path) -> Self {
    let flag = |key: &str| crate::settings::user_value(config, key).and_then(|v| v.as_bool()).unwrap_or(true);
    Self {
      agents_md: flag("chat.useAgentsMdFile"),
      applying: flag("chat.includeApplyingInstructions"),
      locations: super::customizations::Settings::from_user(config),
      home: super::customizations::home(),
    }
  }
}

/// A rules file as the chip lists it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Rule {
  /// Relative to the open folder ('/'-separated), to open it in the editor.
  pub path: String,
  /// Relative to the run folder, as the agent is told.
  pub rel: String,
  pub kind: RuleKind,
  pub description: Option<String>,
  /// `alwaysApply` (AGENTS.md and Copilot's file always apply).
  pub always: bool,
  pub globs: Vec<String>,
  /// Whether its text goes to the agent (always, or a glob matched an attached file).
  pub applies: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Loaded {
  pub rule: Rule,
  pub body: String,
}

/// A `.cursor/rules` file's frontmatter.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Front {
  pub description: Option<String>,
  pub globs: Vec<String>,
  pub always: bool,
}

fn unquote(s: &str) -> &str {
  let s = s.trim();
  s.strip_prefix('"').and_then(|x| x.strip_suffix('"')).or_else(|| s.strip_prefix('\'').and_then(|x| x.strip_suffix('\''))).unwrap_or(s)
}

fn glob_list(value: &str) -> Vec<String> {
  let v = value.trim();
  let v = v.strip_prefix('[').and_then(|x| x.strip_suffix(']')).unwrap_or(v);
  v.split(',').map(unquote).filter(|g| !g.is_empty()).map(str::to_owned).collect()
}

/// Splits a `.mdc` file into its frontmatter (`---` lines around `key: value` pairs; `globs`
/// as a comma list, a `[...]` list or `- item` lines) and its body.
pub fn parse_mdc(text: &str) -> (Front, String) {
  let text = text.replace("\r\n", "\n");
  let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
  let mut lines = text.lines();
  if lines.next().map(str::trim) != Some("---") {
    return (Front::default(), text.trim().to_owned());
  }
  let mut front = Front::default();
  let mut in_globs = false;
  let mut consumed = text.find('\n').map_or(text.len(), |i| i + 1);
  for line in lines {
    consumed += line.len() + 1;
    if line.trim() == "---" {
      let body = text.get(consumed.min(text.len())..).unwrap_or("");
      return (front, body.trim().to_owned());
    }
    if in_globs && let Some(item) = line.trim().strip_prefix("- ") {
      front.globs.extend(glob_list(item));
      continue;
    }
    in_globs = false;
    let Some((key, value)) = line.split_once(':') else { continue };
    match key.trim() {
      "description" => front.description = Some(unquote(value).to_owned()).filter(|d| !d.is_empty()),
      "alwaysApply" => front.always = unquote(value).eq_ignore_ascii_case("true"),
      "globs" => {
        front.globs = glob_list(value);
        in_globs = value.trim().is_empty();
      }
      _ => {}
    }
  }
  // No closing `---`: all of it is the body.
  (Front::default(), text.trim().to_owned())
}

/// Whether a rule's glob matches the run-folder-relative `rel`; a glob without `/` also matches
/// the file name anywhere (`*.ts`), as Cursor does.
pub fn glob_matches(glob: &str, rel: &str) -> bool {
  let glob = glob.trim().trim_start_matches("./");
  let Some(re) = crate::glob::to_regex(glob) else { return false };
  re.is_match(rel) || (!glob.contains('/') && rel.rsplit('/').next().is_some_and(|name| re.is_match(name)))
}

/// An attached file as a path relative to the run folder `cwd`: absolute ones under `cwd` or
/// the open folder `root` (the same path in a task worktree), relative ones as given. `None` for
/// anything else or with `..`.
pub fn file_rel(root: &Path, cwd: &Path, file: &str) -> Option<String> {
  let p = Path::new(file);
  let rel = if p.is_absolute() { p.strip_prefix(cwd).or_else(|_| p.strip_prefix(root)).ok()? } else { p };
  let mut parts = Vec::new();
  for c in rel.components() {
    match c {
      Component::Normal(s) => parts.push(s.to_str()?),
      Component::CurDir => {}
      _ => return None,
    }
  }
  (!parts.is_empty()).then(|| parts.join("/"))
}

/// The file's text when it is a regular file (not a symlink) inside `real_cwd`, cut to `max` bytes.
fn read_inside(real_cwd: &Path, path: &Path, max: usize) -> Option<String> {
  let meta = std::fs::symlink_metadata(path).ok()?;
  if !meta.is_file() {
    return None;
  }
  let real = std::fs::canonicalize(path).ok()?;
  if !real.starts_with(real_cwd) {
    return None;
  }
  let bytes = std::fs::read(&real).ok()?;
  let mut end = bytes.len().min(max);
  let mut text = String::from_utf8_lossy(&bytes[..end]).into_owned();
  // A cut in the middle of a character leaves a replacement character: drop it.
  while end < bytes.len() && text.ends_with('\u{fffd}') {
    text.pop();
    end -= 1;
  }
  Some(text)
}

fn rel_to(base: &Path, path: &Path) -> String {
  path.strip_prefix(base).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

fn cursor_rule_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
  let Ok(read) = std::fs::read_dir(dir) else { return };
  let mut entries: Vec<_> = read.flatten().collect();
  entries.sort_by_key(|e| e.file_name());
  for e in entries {
    if out.len() >= MAX_CURSOR_RULES {
      return;
    }
    let Ok(ft) = e.file_type() else { continue };
    let path = e.path();
    if ft.is_dir() && depth < MAX_DEPTH {
      cursor_rule_files(&path, depth + 1, out);
    } else if ft.is_file() && path.extension().and_then(|x| x.to_str()).is_some_and(|x| x == "mdc" || x == "md") {
      out.push(path);
    }
  }
}

/// The rules files of the run folder `cwd` (inside the open folder `root`) for the attached
/// `files`, in the order they go to the agent: AGENTS.md (outermost first), Copilot's
/// instructions, VS Code's instructions files, then `.cursor/rules` by name.
pub fn discover(root: &Path, cwd: &Path, files: &[String], opts: &Options) -> Vec<Loaded> {
  let Ok(real_cwd) = std::fs::canonicalize(cwd) else { return Vec::new() };
  let rels: Vec<String> = files.iter().take(MAX_FILES).filter_map(|f| file_rel(root, cwd, f)).collect();
  let mut out = Vec::new();
  let mut budget = MAX_TOTAL;
  let mut push = |out: &mut Vec<Loaded>, path: &Path, kind: RuleKind, front: Front, body: String, applies: bool| {
    let mut body = body;
    if applies {
      let mut cut = body.len().min(budget);
      while !body.is_char_boundary(cut) {
        cut -= 1;
      }
      body.truncate(cut);
      budget -= body.len();
    }
    let always = front.always || !matches!(kind, RuleKind::Cursor | RuleKind::Instructions);
    out.push(Loaded { rule: Rule { path: rel_to(root, path), rel: rel_to(cwd, path), kind, description: front.description, always, globs: front.globs, applies }, body });
  };

  // AGENTS.md: the run folder's, then each folder down to an attached file's.
  let mut dirs: Vec<String> = vec![String::new()];
  for rel in &rels {
    let parts: Vec<&str> = rel.split('/').collect();
    for i in 1..parts.len() {
      let d = parts[..i].join("/");
      if !dirs.contains(&d) {
        dirs.push(d);
      }
    }
  }
  dirs.sort_by_key(|d| (d.matches('/').count() + usize::from(!d.is_empty()), d.clone()));
  for d in dirs.iter().filter(|_| opts.agents_md) {
    let path = if d.is_empty() { cwd.join("AGENTS.md") } else { cwd.join(d).join("AGENTS.md") };
    if let Some(text) = read_inside(&real_cwd, &path, MAX_RULE_BYTES).filter(|t| !t.trim().is_empty()) {
      push(&mut out, &path, RuleKind::Agents, Front::default(), text.trim().to_owned(), true);
    }
  }

  let copilot = cwd.join(".github/copilot-instructions.md");
  if let Some(text) = read_inside(&real_cwd, &copilot, MAX_RULE_BYTES).filter(|t| !t.trim().is_empty()) {
    push(&mut out, &copilot, RuleKind::Copilot, Front::default(), text.trim().to_owned(), true);
  }

  for f in super::customizations::instructions_files(cwd, opts.home.as_deref(), &opts.locations) {
    let always = f.apply_to.iter().any(|g| matches!(g.trim(), "**" | "**/*" | "*"));
    let applies = opts.applying && (always || f.apply_to.iter().any(|g| rels.iter().any(|r| glob_matches(g, r))));
    let front = Front { description: f.description, globs: if always { Vec::new() } else { f.apply_to }, always };
    push(&mut out, &f.path, RuleKind::Instructions, front, f.body, applies);
  }

  let mut cursor = Vec::new();
  cursor_rule_files(&cwd.join(".cursor/rules"), 0, &mut cursor);
  for path in cursor {
    let Some(text) = read_inside(&real_cwd, &path, MAX_RULE_BYTES) else { continue };
    let (front, body) = parse_mdc(&text);
    if body.is_empty() {
      continue;
    }
    let applies = front.always || (opts.applying && front.globs.iter().any(|g| rels.iter().any(|r| glob_matches(g, r))));
    push(&mut out, &path, RuleKind::Cursor, front, body, applies);
  }
  out
}

/// The text after Claude Code's system prompt: the applied rules, then the ones the agent may
/// read when they matter; `None` with neither.
pub fn system_append(rules: &[Loaded]) -> Option<String> {
  let applied: Vec<_> = rules.iter().filter(|r| r.rule.applies).collect();
  let requested: Vec<_> = rules.iter().filter(|r| !r.rule.applies && r.rule.description.is_some()).collect();
  if applied.is_empty() && requested.is_empty() {
    return None;
  }
  let mut s = String::from(
    "# Project rules\n\nThese come from the project's rules files (AGENTS.md, .cursor/rules, .github/copilot-instructions.md, *.instructions.md). Follow them as you follow CLAUDE.md; where they disagree, the more specific one (a nearer AGENTS.md, a rule for the files at hand) wins.\n",
  );
  for r in applied {
    s.push_str(&format!("\n<rule path=\"{}\">\n{}\n</rule>\n", r.rule.rel, r.body));
  }
  if !requested.is_empty() {
    s.push_str("\nMore rules, not loaded: read one with the Read tool when its description fits the task.\n");
    for r in requested {
      s.push_str(&format!("- {}: {}\n", r.rule.rel, r.rule.description.as_deref().unwrap_or("")));
    }
  }
  Some(s)
}

/// The rules of chat folder `cwd` for the attached `files` (workspace-relative or absolute), for
/// the composer's chip. Errors only when `cwd` is not the open folder or one of its worktrees.
#[tauri::command]
pub async fn chat_rules(app: tauri::AppHandle, ws: Workspace, cwd: String, files: Vec<String>) -> Result<Vec<Rule>, String> {
  let root = ws.root()?;
  let opts = Options::from_user(&crate::snap::config_dir(&app)?);
  tauri::async_runtime::spawn_blocking(move || {
    let dir = super::chats::resolve_cwd(&root, Path::new(&cwd))?;
    let root = std::fs::canonicalize(&root).unwrap_or(root);
    Ok(discover(&root, &dir, &files, &opts).into_iter().map(|l| l.rule).collect())
  })
  .await
  .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
  use super::*;

  fn write(dir: &Path, rel: &str, text: &str) {
    let p = dir.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
  }

  #[test]
  fn parses_cursor_frontmatter() {
    let (f, body) = parse_mdc("---\ndescription: \"React components\"\nglobs: src/**/*.tsx, *.css\nalwaysApply: false\n---\nUse function components.\n");
    assert_eq!(f, Front { description: Some("React components".into()), globs: vec!["src/**/*.tsx".into(), "*.css".into()], always: false });
    assert_eq!(body, "Use function components.");
    let (f, _) = parse_mdc("---\nglobs:\n  - \"*.rs\"\n  - crates/**\nalwaysApply: true\n---\nx");
    assert_eq!((f.globs, f.always), (vec!["*.rs".to_owned(), "crates/**".to_owned()], true));
    let (f, _) = parse_mdc("---\nglobs: [\"a/*.ts\", 'b.ts']\n---\nx");
    assert_eq!(f.globs, ["a/*.ts", "b.ts"]);
    assert_eq!(parse_mdc("Just text"), (Front::default(), "Just text".into()));
    assert_eq!(parse_mdc("---\nnot closed").1, "---\nnot closed");
  }

  #[test]
  fn globs_match_paths_and_bare_names() {
    assert!(glob_matches("src/**/*.tsx", "src/ui/App.tsx"));
    assert!(!glob_matches("src/**/*.tsx", "lib/App.tsx"));
    assert!(glob_matches("*.rs", "crates/a/src/lib.rs"));
    assert!(glob_matches("./docs/*.md", "docs/a.md"));
    assert!(!glob_matches("docs/*.md", "docs/x/a.md"));
  }

  #[test]
  fn attached_files_relative_to_the_run_folder() {
    let (root, cwd) = (Path::new("/r"), Path::new("/r/.kingu/worktrees/t"));
    assert_eq!(file_rel(root, root, "src/a.ts").as_deref(), Some("src/a.ts"));
    assert_eq!(file_rel(root, cwd, "/r/.kingu/worktrees/t/src/a.ts").as_deref(), Some("src/a.ts"));
    assert_eq!(file_rel(root, cwd, "/r/src/a.ts").as_deref(), Some("src/a.ts"));
    assert_eq!(file_rel(root, root, "./src/a.ts").as_deref(), Some("src/a.ts"));
    assert_eq!(file_rel(root, root, "../x"), None);
    assert_eq!(file_rel(root, root, "/etc/passwd"), None);
  }

  #[test]
  fn discovers_rules_for_the_attached_files() {
    let tmp = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(tmp.path()).unwrap();
    write(&root, "AGENTS.md", "Run bun test.");
    write(&root, "apps/web/AGENTS.md", "Svelte 5 runes only.");
    write(&root, "apps/other/AGENTS.md", "Not attached.");
    write(&root, "CLAUDE.md", "The SDK reads this one.");
    write(&root, ".github/copilot-instructions.md", "Thai and English strings.");
    write(&root, ".cursor/rules/always.mdc", "---\nalwaysApply: true\n---\nNo emojis.");
    write(&root, ".cursor/rules/ts.mdc", "---\nglobs: *.ts\n---\nStrict TypeScript.");
    write(&root, ".cursor/rules/rust/style.mdc", "---\nglobs: **/*.rs\n---\nTwo-space indent.");
    write(&root, ".cursor/rules/db.mdc", "---\ndescription: Database migrations\n---\nUse sqlx.");
    write(&root, ".cursor/rules/empty.mdc", "---\nalwaysApply: true\n---\n");

    let rules = discover(&root, &root, &["apps/web/src/main.ts".into()], &Options::default());
    let shown: Vec<_> = rules.iter().map(|l| (l.rule.rel.as_str(), l.rule.applies)).collect();
    assert_eq!(
      shown,
      [
        ("AGENTS.md", true),
        ("apps/web/AGENTS.md", true),
        (".github/copilot-instructions.md", true),
        (".cursor/rules/always.mdc", true),
        (".cursor/rules/db.mdc", false),
        (".cursor/rules/rust/style.mdc", false),
        (".cursor/rules/ts.mdc", true),
      ]
    );
    assert_eq!(rules[0].rule.kind, RuleKind::Agents);
    let append = system_append(&rules).unwrap();
    assert!(append.contains("<rule path=\"apps/web/AGENTS.md\">\nSvelte 5 runes only.\n</rule>"), "{append}");
    assert!(append.contains("- .cursor/rules/db.mdc: Database migrations"), "{append}");
    assert!(!append.contains("Two-space") && !append.contains("SDK reads") && !append.contains("Not attached"), "{append}");
    // The nearer AGENTS.md comes after the outer one.
    assert!(append.find("Run bun test").unwrap() < append.find("Svelte 5").unwrap());

    assert!(system_append(&discover(&root, &root.join("apps/other"), &[], &Options::default())).is_some());
    let none = tempfile::tempdir().unwrap();
    assert_eq!(system_append(&discover(none.path(), none.path(), &[], &Options::default())), None);
  }

  #[test]
  fn instructions_files_and_the_vscode_switches() {
    let tmp = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(tmp.path()).unwrap();
    write(&root, "AGENTS.md", "Run bun test.");
    write(&root, ".github/instructions/py.instructions.md", "---\napplyTo: '**/*.py'\n---\nType hints.");
    write(&root, ".github/instructions/all.instructions.md", "---\napplyTo: '**'\n---\nAnswer briefly.");
    write(&root, ".github/instructions/db.instructions.md", "---\ndescription: Database work\n---\nUse migrations.");
    write(&root, ".cursor/rules/ts.mdc", "---\nglobs: *.ts\n---\nStrict TypeScript.");
    let files = ["src/app.py".to_owned(), "src/a.ts".to_owned()];
    let shown = |opts: &Options| discover(&root, &root, &files, opts).into_iter().map(|l| (l.rule.rel, l.rule.applies)).collect::<Vec<_>>();
    assert_eq!(
      shown(&Options::default()),
      [
        ("AGENTS.md".to_owned(), true),
        (".github/instructions/all.instructions.md".to_owned(), true),
        (".github/instructions/db.instructions.md".to_owned(), false),
        (".github/instructions/py.instructions.md".to_owned(), true),
        (".cursor/rules/ts.mdc".to_owned(), true),
      ]
    );
    let rules = discover(&root, &root, &files, &Options::default());
    assert_eq!((rules[1].rule.kind.clone(), rules[1].rule.always), (RuleKind::Instructions, true));
    assert_eq!((rules[3].rule.always, rules[3].rule.globs.clone()), (false, vec!["**/*.py".to_owned()]));
    let append = system_append(&rules).unwrap();
    assert!(append.contains("Type hints.") && append.contains("- .github/instructions/db.instructions.md: Database work"), "{append}");
    // chat.useAgentsMdFile and chat.includeApplyingInstructions off.
    let off = Options { agents_md: false, applying: false, ..Options::default() };
    assert_eq!(
      shown(&off),
      [
        (".github/instructions/all.instructions.md".to_owned(), false),
        (".github/instructions/db.instructions.md".to_owned(), false),
        (".github/instructions/py.instructions.md".to_owned(), false),
        (".cursor/rules/ts.mdc".to_owned(), false),
      ]
    );
  }

  #[test]
  fn reads_only_regular_files_inside_the_folder_and_caps_them() {
    let tmp = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(tmp.path()).unwrap();
    let outside = tempfile::tempdir().unwrap();
    write(outside.path(), "AGENTS.md", "secret");
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.path().join("AGENTS.md"), root.join("AGENTS.md")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.path(), root.join("linked")).unwrap();
    write(&root, ".github/copilot-instructions.md", &"ก".repeat(MAX_RULE_BYTES));
    let rules = discover(&root, &root, &["linked/x.ts".into()], &Options::default());
    assert_eq!(rules.len(), 1, "symlinked AGENTS.md files are skipped: {rules:?}");
    assert!(rules[0].body.len() <= MAX_RULE_BYTES && rules[0].body.chars().all(|c| c == 'ก'));
  }
}
