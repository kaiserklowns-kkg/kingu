//! What a snap contributes beyond tasks, settings, MCP servers and skills, after VS Code's
//! contribution points: `[[languages]]` (ids, file associations, a language-configuration file),
//! `[[grammars]]` (TextMate), `[[snippets]]`, `[lsp.<key>]` (a language server: a process Rust
//! starts like the built-in ones, see snap_lsp.rs), `[[themes]]` (VS Code color themes),
//! `[[icon_themes]]` (VS Code file icon themes) and `[[views]]` (an HTML page shown in a sandboxed
//! frame, see snap_view.rs).
//!
//! The files they name are read when the snap is listed: each must be a regular file inside the
//! snap (no symlinked part) and they are covered by the trust hash (`snap::snap_hash`), so a repo
//! snap's grammar or view cannot change behind the user's back. The webview reads them later with
//! `snap_file_read`, passing the SHA-256 it was listed with; a file that changed since is refused.
//! Files a theme or icon theme refers to (an `include`, icon images) are read the same way without
//! a hash: they are data shown by the app, never run.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::i18n::msg::SnapContribMsg;
use crate::snap::{self, Source};
use crate::tr;
use crate::workspace::Workspace;

const MAX_LANGUAGES: usize = 64;
const MAX_GRAMMARS: usize = 64;
const MAX_SNIPPETS: usize = 64;
const MAX_LSP: usize = 8;
const MAX_THEMES: usize = 64;
const MAX_VIEWS: usize = 8;
/// One contributed file, and all of a snap's together.
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// Manifest tables (raw, as written)

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawLanguage {
  id: String,
  #[serde(default)]
  aliases: Vec<String>,
  #[serde(default)]
  extensions: Vec<String>,
  #[serde(default)]
  filenames: Vec<String>,
  #[serde(default)]
  filename_patterns: Vec<String>,
  first_line: Option<String>,
  configuration: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawGrammar {
  language: Option<String>,
  scope_name: String,
  path: String,
  #[serde(default)]
  embedded_languages: BTreeMap<String, String>,
  #[serde(default)]
  token_types: BTreeMap<String, TokenType>,
  #[serde(default)]
  inject_to: Vec<String>,
  #[serde(default)]
  balanced_bracket_scopes: Vec<String>,
  #[serde(default)]
  unbalanced_bracket_scopes: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawSnippets {
  language: String,
  path: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawLsp {
  name: String,
  languages: Vec<String>,
  command: Vec<String>,
  #[serde(default)]
  env: BTreeMap<String, String>,
  initialization_options: Option<toml::Value>,
  settings_section: Option<String>,
  #[serde(default)]
  install: Vec<InstallHint>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawTheme {
  id: Option<String>,
  label: String,
  ui_theme: UiTheme,
  path: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawIconTheme {
  id: String,
  label: String,
  path: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawView {
  id: String,
  name: String,
  location: ViewLocation,
  path: String,
  /// Snap settings the page may read (`kingu.getSetting`).
  #[serde(default)]
  settings: Vec<String>,
  /// Snap tasks the page may run (`kingu.runTask`).
  #[serde(default)]
  tasks: Vec<String>,
  /// Whether the page may show notifications (`kingu.notify`).
  #[serde(default)]
  notifications: bool,
}

/// Every contribution table of `snap.toml`, as read.
#[derive(Default)]
pub(crate) struct Raw {
  pub languages: Vec<RawLanguage>,
  pub grammars: Vec<RawGrammar>,
  pub snippets: Vec<RawSnippets>,
  pub lsp: BTreeMap<String, RawLsp>,
  pub themes: Vec<RawTheme>,
  pub icon_themes: Vec<RawIconTheme>,
  pub views: Vec<RawView>,
}

// ---------------------------------------------------------------------------------------------
// Validated contributions (what `snap_list` returns, camelCase for the webview)

/// VS Code's `contributes.grammars[].tokenTypes` values.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TokenType {
  Other,
  Comment,
  String,
}

/// VS Code's `uiTheme`: the base the theme is drawn on.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq)]
pub enum UiTheme {
  #[serde(rename = "vs")]
  Light,
  #[serde(rename = "vs-dark")]
  Dark,
  #[serde(rename = "hc-black")]
  HcDark,
  #[serde(rename = "hc-light")]
  HcLight,
}

#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ViewLocation {
  Sidebar,
  Panel,
}

/// How a language server can be installed (lsp.rs `Package`): run in a visible terminal when the
/// user picks it, never silently.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct InstallHint {
  pub tool: InstallTool,
  /// Space-separated words after the tool's install command (`typescript-language-server typescript`).
  pub package: String,
}

#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum InstallTool {
  Npm,
  Go,
  Rustup,
  Brew,
  Pytool,
  Cargo,
  Pip,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Language {
  pub id: String,
  pub aliases: Vec<String>,
  pub extensions: Vec<String>,
  pub filenames: Vec<String>,
  pub filename_patterns: Vec<String>,
  pub first_line: Option<String>,
  /// A VS Code `language-configuration.json` in the snap.
  pub configuration: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Grammar {
  pub language: Option<String>,
  pub scope_name: String,
  pub path: String,
  pub embedded_languages: BTreeMap<String, String>,
  pub token_types: BTreeMap<String, TokenType>,
  pub inject_to: Vec<String>,
  pub balanced_bracket_scopes: Vec<String>,
  pub unbalanced_bracket_scopes: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Snippets {
  pub language: String,
  pub path: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LspServer {
  /// The `[lsp.<key>]` name.
  pub key: String,
  pub name: String,
  /// Language ids it serves (VS Code's documentSelector languages).
  pub languages: Vec<String>,
  /// argv; `${setting:<key>}` is expanded by the webview like task arguments.
  pub command: Vec<String>,
  pub env: BTreeMap<String, String>,
  pub initialization_options: Option<serde_json::Value>,
  /// `workspace/configuration` for this section is answered with the snap's settings.
  pub settings_section: Option<String>,
  pub install: Vec<InstallHint>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
  /// The `workbench.colorTheme` value (VS Code: the theme's `id`, else its label).
  pub id: String,
  pub label: String,
  pub ui_theme: UiTheme,
  pub path: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct IconTheme {
  /// The `workbench.iconTheme` value.
  pub id: String,
  pub label: String,
  pub path: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct View {
  pub id: String,
  pub name: String,
  pub location: ViewLocation,
  pub path: String,
  pub settings: Vec<String>,
  pub tasks: Vec<String>,
  pub notifications: bool,
}

/// A contributed file and the SHA-256 of the bytes listed (and hashed for trust).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct FileHash {
  pub path: String,
  pub sha256: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Contributions {
  pub languages: Vec<Language>,
  pub grammars: Vec<Grammar>,
  pub snippets: Vec<Snippets>,
  pub lsp: Vec<LspServer>,
  pub themes: Vec<Theme>,
  pub icon_themes: Vec<IconTheme>,
  pub views: Vec<View>,
  /// Filled when the snap's folder is read (`read_files`).
  pub files: Vec<FileHash>,
}

impl Contributions {
  /// Every file the manifest names, once, in a stable order.
  pub fn paths(&self) -> Vec<String> {
    let mut set = BTreeSet::new();
    set.extend(self.languages.iter().filter_map(|l| l.configuration.clone()));
    set.extend(self.grammars.iter().map(|g| g.path.clone()));
    set.extend(self.snippets.iter().map(|s| s.path.clone()));
    set.extend(self.themes.iter().map(|t| t.path.clone()));
    set.extend(self.icon_themes.iter().map(|t| t.path.clone()));
    set.extend(self.views.iter().map(|v| v.path.clone()));
    set.into_iter().collect()
  }

  #[cfg(test)]
  pub fn is_empty(&self) -> bool {
    self.paths().is_empty() && self.lsp.is_empty()
  }
}

// ---------------------------------------------------------------------------------------------
// Validation

/// VS Code language ids: `typescript`, `objective-c`, `c++`-ish names, `jsonc`.
pub fn is_language_id(s: &str) -> bool {
  let b = s.as_bytes();
  !b.is_empty() && b.len() <= 64 && b[0].is_ascii_alphanumeric() && b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'+' | b'-'))
}

/// TextMate scope names (`source.zig`, `text.html.basic`, `documentation.injection.ts`).
fn is_scope(s: &str) -> bool {
  let b = s.as_bytes();
  !b.is_empty() && b.len() <= 128 && b[0].is_ascii_alphanumeric() && b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

/// `^[A-Za-z][A-Za-z0-9._-]*$` (a `workspace/configuration` section, an icon theme id).
fn is_dotted_name(s: &str) -> bool {
  let b = s.as_bytes();
  !b.is_empty() && b.len() <= 64 && b[0].is_ascii_alphabetic() && b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

/// A file inside the snap: relative, `/`-separated, plain names (no `.`/`..`/empty parts).
pub fn is_snap_path(path: &str) -> bool {
  let plain = |p: &str| !p.is_empty() && p != "." && p != ".." && !p.starts_with('.') && p.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'));
  !path.is_empty() && path.len() <= 256 && !path.starts_with('/') && path.split('/').all(plain)
}

fn check_path(path: &str, allowed: &[&str]) -> Result<(), String> {
  if !is_snap_path(path) {
    return Err(tr!(SnapContribMsg::PathInvalid, path));
  }
  if !allowed.iter().any(|ext| path.to_ascii_lowercase().ends_with(ext)) {
    return Err(tr!(SnapContribMsg::PathExtension, path, allowed = allowed.join(", ")));
  }
  Ok(())
}

fn too_many(n: usize, max: usize, what: &str) -> Result<(), String> {
  if n > max { Err(tr!(SnapContribMsg::TooMany, what, max)) } else { Ok(()) }
}

fn json_of(v: toml::Value) -> serde_json::Value {
  // A TOML value always has a JSON form (datetimes become strings).
  serde_json::to_value(v).unwrap_or(serde_json::Value::Null)
}

/// Checks the contribution tables. `settings` and `tasks` are the snap's declared setting keys and
/// task ids (placeholders and view permissions must name them).
pub(crate) fn validate(raw: Raw, settings: &BTreeSet<String>, tasks: &BTreeSet<String>) -> Result<Contributions, String> {
  too_many(raw.languages.len(), MAX_LANGUAGES, "languages")?;
  too_many(raw.grammars.len(), MAX_GRAMMARS, "grammars")?;
  too_many(raw.snippets.len(), MAX_SNIPPETS, "snippets")?;
  too_many(raw.lsp.len(), MAX_LSP, "language servers")?;
  too_many(raw.themes.len() + raw.icon_themes.len(), MAX_THEMES, "themes")?;
  too_many(raw.views.len(), MAX_VIEWS, "views")?;

  let mut languages = Vec::new();
  let mut ids = BTreeSet::new();
  for l in raw.languages {
    if !is_language_id(&l.id) {
      return Err(tr!(SnapContribMsg::LanguageIdInvalid, id = l.id));
    }
    if !ids.insert(l.id.clone()) {
      return Err(tr!(SnapContribMsg::LanguageDuplicate, id = l.id));
    }
    if let Some(ext) = l.extensions.iter().find(|e| e.len() < 2 || !e.starts_with('.') || e.contains('/') || e.contains('\\')) {
      return Err(tr!(SnapContribMsg::ExtensionInvalid, id = l.id, ext));
    }
    if let Some(name) = l.filenames.iter().chain(&l.filename_patterns).find(|f| f.trim().is_empty() || f.contains('\\')) {
      return Err(tr!(SnapContribMsg::FileNameInvalid, id = l.id, name));
    }
    if let Some(c) = &l.configuration {
      check_path(c, &[".json"])?;
    }
    languages.push(Language { id: l.id, aliases: l.aliases, extensions: l.extensions, filenames: l.filenames, filename_patterns: l.filename_patterns, first_line: l.first_line.filter(|f| !f.is_empty()), configuration: l.configuration });
  }

  let mut grammars = Vec::new();
  let mut scopes = BTreeSet::new();
  for g in raw.grammars {
    if !is_scope(&g.scope_name) {
      return Err(tr!(SnapContribMsg::ScopeInvalid, scope = g.scope_name));
    }
    if !scopes.insert(g.scope_name.clone()) {
      return Err(tr!(SnapContribMsg::GrammarDuplicate, scope = g.scope_name));
    }
    if let Some(lang) = g.language.as_deref().filter(|l| !is_language_id(l)) {
      return Err(tr!(SnapContribMsg::LanguageIdInvalid, id = lang));
    }
    if let Some(s) = g.inject_to.iter().chain(g.embedded_languages.keys()).chain(g.token_types.keys()).chain(&g.balanced_bracket_scopes).chain(&g.unbalanced_bracket_scopes).find(|s| s.trim().is_empty()) {
      return Err(tr!(SnapContribMsg::ScopeInvalid, scope = s));
    }
    if let Some(lang) = g.embedded_languages.values().find(|l| !is_language_id(l)) {
      return Err(tr!(SnapContribMsg::LanguageIdInvalid, id = lang));
    }
    check_path(&g.path, &[".json", ".tmlanguage", ".plist"])?;
    grammars.push(Grammar {
      language: g.language,
      scope_name: g.scope_name,
      path: g.path,
      embedded_languages: g.embedded_languages,
      token_types: g.token_types,
      inject_to: g.inject_to,
      balanced_bracket_scopes: g.balanced_bracket_scopes,
      unbalanced_bracket_scopes: g.unbalanced_bracket_scopes,
    });
  }

  let mut snippets = Vec::new();
  for s in raw.snippets {
    if !is_language_id(&s.language) {
      return Err(tr!(SnapContribMsg::LanguageIdInvalid, id = s.language));
    }
    check_path(&s.path, &[".json", ".code-snippets"])?;
    snippets.push(Snippets { language: s.language, path: s.path });
  }

  let mut lsp = Vec::new();
  for (key, s) in raw.lsp {
    if !snap::is_slug(&key, 40) {
      return Err(tr!(SnapContribMsg::LspKeyInvalid, key));
    }
    if s.name.trim().is_empty() {
      return Err(tr!(SnapContribMsg::LspNoName, key));
    }
    if s.languages.is_empty() {
      return Err(tr!(SnapContribMsg::LspNoLanguages, key));
    }
    if let Some(lang) = s.languages.iter().find(|l| !is_language_id(l)) {
      return Err(tr!(SnapContribMsg::LanguageIdInvalid, id = lang));
    }
    if s.command.first().is_none_or(|c| c.trim().is_empty()) {
      return Err(tr!(SnapContribMsg::LspNoCommand, key));
    }
    if let Some(var) = s.env.keys().find(|k| !snap::is_env_name(k)) {
      return Err(tr!(SnapContribMsg::LspEnvInvalid, key, var));
    }
    if let Some(section) = s.settings_section.as_deref().filter(|s| !is_dotted_name(s)) {
      return Err(tr!(SnapContribMsg::LspSectionInvalid, key, section));
    }
    // Words of an install command: no empty package, no option-looking or shell-looking words.
    let bad_word = |w: &str| w.starts_with('-') || !w.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-' | b'/' | b'@' | b':' | b'=' | b'+'));
    if let Some(h) = s.install.iter().find(|h| h.package.split_whitespace().next().is_none() || h.package.split_whitespace().any(bad_word)) {
      return Err(tr!(SnapContribMsg::InstallInvalid, key, package = h.package));
    }
    let owner = tr!(SnapContribMsg::LspOwner, key);
    for arg in s.command.iter().chain(s.env.values()) {
      snap::check_placeholders(arg, settings, &owner)?;
    }
    lsp.push(LspServer {
      key,
      name: s.name,
      languages: s.languages,
      command: s.command,
      env: s.env,
      initialization_options: s.initialization_options.map(json_of),
      settings_section: s.settings_section,
      install: s.install,
    });
  }

  let mut themes = Vec::new();
  let mut theme_ids = BTreeSet::new();
  for t in raw.themes {
    if t.label.trim().is_empty() {
      return Err(tr!(SnapContribMsg::ThemeNoLabel, path = t.path));
    }
    let id = t.id.filter(|i| !i.trim().is_empty()).unwrap_or_else(|| t.label.clone());
    if !theme_ids.insert(id.clone()) {
      return Err(tr!(SnapContribMsg::ThemeDuplicate, id));
    }
    check_path(&t.path, &[".json"])?;
    themes.push(Theme { id, label: t.label, ui_theme: t.ui_theme, path: t.path });
  }
  let mut icon_themes = Vec::new();
  for t in raw.icon_themes {
    if !is_dotted_name(&t.id) {
      return Err(tr!(SnapContribMsg::IconThemeIdInvalid, id = t.id));
    }
    if !theme_ids.insert(t.id.clone()) {
      return Err(tr!(SnapContribMsg::ThemeDuplicate, id = t.id));
    }
    if t.label.trim().is_empty() {
      return Err(tr!(SnapContribMsg::ThemeNoLabel, path = t.path));
    }
    check_path(&t.path, &[".json"])?;
    icon_themes.push(IconTheme { id: t.id, label: t.label, path: t.path });
  }

  let mut views = Vec::new();
  let mut view_ids = BTreeSet::new();
  for v in raw.views {
    if !snap::is_slug(&v.id, 40) {
      return Err(tr!(SnapContribMsg::ViewIdInvalid, id = v.id));
    }
    if !view_ids.insert(v.id.clone()) {
      return Err(tr!(SnapContribMsg::ViewDuplicate, id = v.id));
    }
    if v.name.trim().is_empty() {
      return Err(tr!(SnapContribMsg::ViewNoName, id = v.id));
    }
    if let Some(key) = v.settings.iter().find(|k| !settings.contains(*k)) {
      return Err(tr!(SnapContribMsg::ViewSettingUndeclared, id = v.id, key));
    }
    if let Some(task) = v.tasks.iter().find(|t| !tasks.contains(*t)) {
      return Err(tr!(SnapContribMsg::ViewTaskUndeclared, id = v.id, task));
    }
    check_path(&v.path, &[".html", ".htm"])?;
    views.push(View { id: v.id, name: v.name, location: v.location, path: v.path, settings: v.settings, tasks: v.tasks, notifications: v.notifications });
  }

  Ok(Contributions { languages, grammars, snippets, lsp, themes, icon_themes, views, files: Vec::new() })
}

// ---------------------------------------------------------------------------------------------
// Files

/// `<snap_dir>/<path>` when every part of it is a plain folder and the last a regular file of at
/// most `max` bytes (never through a symlink, which could point out of the snap).
fn plain_file(snap_dir: &Path, path: &str, max: u64) -> Result<PathBuf, String> {
  if !is_snap_path(path) {
    return Err(tr!(SnapContribMsg::PathInvalid, path));
  }
  let mut file = snap_dir.to_path_buf();
  let parts: Vec<&str> = path.split('/').collect();
  for (i, part) in parts.iter().enumerate() {
    file.push(part);
    let meta = std::fs::symlink_metadata(&file).map_err(|_| tr!(SnapContribMsg::FileMissing, path))?;
    if meta.file_type().is_symlink() {
      return Err(tr!(SnapContribMsg::FileSymlink, path));
    }
    let last = i + 1 == parts.len();
    if last && !meta.is_file() || !last && !meta.is_dir() {
      return Err(tr!(SnapContribMsg::FileNotPlain, path));
    }
    if last && meta.len() > max {
      return Err(tr!(SnapContribMsg::FileTooBig, path, mb = max.div_ceil(1024 * 1024)));
    }
  }
  Ok(file)
}

/// Reads every file the contributions name: (path, bytes) in `paths()` order, for the trust hash.
pub fn read_files(snap_dir: &Path, c: &Contributions) -> Result<Vec<(String, Vec<u8>)>, String> {
  let mut total = 0u64;
  let mut out = Vec::new();
  for path in c.paths() {
    let file = plain_file(snap_dir, &path, MAX_FILE_BYTES)?;
    let bytes = std::fs::read(&file).map_err(|e| tr!(crate::i18n::msg::SnapMsg::ReadFailed, path, detail = e))?;
    total += bytes.len() as u64;
    if total > MAX_TOTAL_BYTES {
      return Err(tr!(SnapContribMsg::FilesTooBig, mb = MAX_TOTAL_BYTES / 1024 / 1024));
    }
    out.push((path, bytes));
  }
  Ok(out)
}

pub fn file_hashes(files: &[(String, Vec<u8>)]) -> Vec<FileHash> {
  files.iter().map(|(path, bytes)| FileHash { path: path.clone(), sha256: snap::sha256_hex(bytes) }).collect()
}

/// The folder of a user or repo snap (`None` for a built-in one, whose files ship in the app).
pub(crate) fn snap_dir(config_dir: &Path, root: Option<&Path>, source: Source, id: &str) -> Result<PathBuf, String> {
  if !snap::is_snap_id(id) {
    return Err(tr!(crate::i18n::msg::SnapMsg::InvalidId, id));
  }
  match source {
    Source::User => Ok(config_dir.join(snap::USER_DIR).join(id)),
    Source::Repo => root.and_then(snap::repo_snaps_dir).map(|d| d.join(id)).ok_or_else(|| tr!(SnapContribMsg::SnapNotFound, id)),
    Source::Builtin => Err(tr!(SnapContribMsg::BuiltinFile)),
  }
}

/// A file of a snap: bytes, refused when `sha256` is given and the file no longer has it.
pub(crate) fn read_snap_file(dir: &Path, path: &str, sha256: Option<&str>, max: u64) -> Result<Vec<u8>, String> {
  let file = plain_file(dir, path, max)?;
  let bytes = std::fs::read(&file).map_err(|e| tr!(crate::i18n::msg::SnapMsg::ReadFailed, path, detail = e))?;
  if sha256.is_some_and(|h| h != snap::sha256_hex(&bytes)) {
    return Err(tr!(SnapContribMsg::FileChanged, path));
  }
  Ok(bytes)
}

/// `data:` URL of an image (icon themes), by extension.
pub(crate) fn data_url(path: &str, bytes: &[u8]) -> Result<String, String> {
  let lower = path.to_ascii_lowercase();
  let mime = [(".svg", "image/svg+xml"), (".png", "image/png"), (".jpg", "image/jpeg"), (".jpeg", "image/jpeg"), (".gif", "image/gif"), (".webp", "image/webp")]
    .iter()
    .find(|(ext, _)| lower.ends_with(ext))
    .map(|(_, m)| *m)
    .ok_or_else(|| tr!(SnapContribMsg::ImageType, path))?;
  Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// A text file of a user or repo snap (a grammar, theme, snippets file…). `sha256`: the hash it was
/// listed with, for the files the manifest names.
#[tauri::command]
pub async fn snap_file_read(app: AppHandle, ws: Workspace, source: Source, id: String, path: String, sha256: Option<String>) -> Result<String, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let dir = snap_dir(&snap::config_dir(&app)?, ws.current().as_deref(), source, &id)?;
    let bytes = read_snap_file(&dir, &path, sha256.as_deref(), MAX_FILE_BYTES)?;
    String::from_utf8(bytes).map_err(|_| tr!(SnapContribMsg::NotUtf8, path))
  })
  .await
  .map_err(|e| e.to_string())?
}

/// An image of a user or repo snap (a file icon theme's icons) as a `data:` URL.
#[tauri::command]
pub async fn snap_file_data_url(app: AppHandle, ws: Workspace, source: Source, id: String, path: String) -> Result<String, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let dir = snap_dir(&snap::config_dir(&app)?, ws.current().as_deref(), source, &id)?;
    data_url(&path, &read_snap_file(&dir, &path, None, MAX_IMAGE_BYTES)?)
  })
  .await
  .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::snap::parse_manifest;

  const HEAD: &str = "id = \"zig\"\nname = \"Zig\"\nversion = \"1\"\n";

  pub(crate) const ZIG: &str = r#"
id = "zig"
name = "Zig"
version = "0.2.0"

[[settings]]
key = "zlsPath"
type = "string"
default = "zls"

[[settings]]
key = "greeting"
type = "string"
default = "hi"

[[tasks]]
id = "build"
title = "Build"
command = ["zig", "build"]

[[languages]]
id = "zig"
aliases = ["Zig", "zig"]
extensions = [".zig", ".zon"]
filenames = ["build.zig.zon"]
first_line = "^#!.*\\bzig\\b"
configuration = "language-configuration.json"

[[grammars]]
language = "zig"
scope_name = "source.zig"
path = "syntaxes/zig.tmLanguage.json"
embedded_languages = { "meta.embedded.block.c" = "c" }
token_types = { "string.quoted" = "string", "comment.line" = "comment" }

[[snippets]]
language = "zig"
path = "snippets/zig.code-snippets"

[lsp.zls]
name = "ZLS"
languages = ["zig"]
command = ["${setting:zlsPath}", "--enable-debug-log"]
env = { ZLS_LOG = "info" }
initialization_options = { enable_snippets = true, warn_style = false }
settings_section = "zls"
install = [{ tool = "brew", package = "zls" }]

[[themes]]
label = "Zig Night"
ui_theme = "vs-dark"
path = "themes/night.json"

[[icon_themes]]
id = "zig-icons"
label = "Zig Icons"
path = "icons/icons.json"

[[views]]
id = "board"
name = "Board"
location = "panel"
path = "views/board.html"
settings = ["greeting"]
tasks = ["build"]
notifications = true
"#;

  #[test]
  fn parses_every_contribution() {
    let p = parse_manifest(ZIG, "zig").unwrap();
    let c = &p.contributes;
    assert_eq!(c.languages[0].id, "zig");
    assert_eq!(c.languages[0].extensions, [".zig", ".zon"]);
    assert_eq!(c.languages[0].configuration.as_deref(), Some("language-configuration.json"));
    assert_eq!(c.grammars[0].scope_name, "source.zig");
    assert_eq!(c.grammars[0].token_types.get("string.quoted"), Some(&TokenType::String));
    assert_eq!(c.snippets, [Snippets { language: "zig".into(), path: "snippets/zig.code-snippets".into() }]);
    let zls = &c.lsp[0];
    assert_eq!((zls.key.as_str(), zls.name.as_str()), ("zls", "ZLS"));
    assert_eq!(zls.initialization_options, Some(serde_json::json!({ "enable_snippets": true, "warn_style": false })));
    assert_eq!(zls.install, [InstallHint { tool: InstallTool::Brew, package: "zls".into() }]);
    assert_eq!(c.themes, [Theme { id: "Zig Night".into(), label: "Zig Night".into(), ui_theme: UiTheme::Dark, path: "themes/night.json".into() }]);
    assert_eq!(c.icon_themes[0].id, "zig-icons");
    assert_eq!(c.views[0].location, ViewLocation::Panel);
    assert_eq!(c.paths(), ["icons/icons.json", "language-configuration.json", "snippets/zig.code-snippets", "syntaxes/zig.tmLanguage.json", "themes/night.json", "views/board.html"]);
    // The webview reads camelCase.
    let json = serde_json::to_value(c).unwrap();
    assert_eq!(json["grammars"][0]["scopeName"], "source.zig");
    assert_eq!(json["lsp"][0]["settingsSection"], "zls");
    assert_eq!(json["themes"][0]["uiTheme"], "vs-dark");
    assert_eq!(json["iconThemes"][0]["label"], "Zig Icons");
    assert_eq!(json["languages"][0]["firstLine"], "^#!.*\\bzig\\b");
  }

  #[test]
  fn a_snap_without_contributions_has_none() {
    let p = parse_manifest(HEAD, "zig").unwrap();
    assert!(p.contributes.is_empty());
    assert_eq!(serde_json::to_value(&p.contributes).unwrap()["views"], serde_json::json!([]));
  }

  fn err(text: &str) -> String {
    parse_manifest(&format!("{HEAD}{text}"), "zig").unwrap_err()
  }

  #[test]
  fn validates_languages_and_grammars() {
    assert!(err("[[languages]]\nid = \"bad id\"\n").contains("Invalid language id"));
    assert!(err("[[languages]]\nid = \"z\"\n[[languages]]\nid = \"z\"\n").contains("declared twice"));
    assert!(err("[[languages]]\nid = \"z\"\nextensions = [\"zig\"]\n").contains("extension"));
    assert!(err("[[languages]]\nid = \"z\"\nconfiguration = \"../x.json\"\n").contains("Invalid path"));
    assert!(err("[[languages]]\nid = \"z\"\nconfiguration = \"conf.yaml\"\n").contains("must end in"));
    assert!(err("[[languages]]\nid = \"z\"\nmime = \"x\"\n").contains("mime"));
    assert!(err("[[grammars]]\nscope_name = \"source zig\"\npath = \"g.json\"\n").contains("scope"));
    assert!(err("[[grammars]]\nscope_name = \"source.z\"\npath = \"g.json\"\n[[grammars]]\nscope_name = \"source.z\"\npath = \"h.json\"\n").contains("declared twice"));
    assert!(err("[[grammars]]\nscope_name = \"source.z\"\npath = \"/abs/g.json\"\n").contains("Invalid path"));
    assert!(err("[[grammars]]\nscope_name = \"source.z\"\npath = \"g.json\"\ntoken_types = { x = \"regex\" }\n").contains("regex"));
    // Injection grammars have no language; plist grammars are fine.
    assert!(parse_manifest(&format!("{HEAD}[[grammars]]\nscope_name = \"todo.injection\"\npath = \"g.tmLanguage\"\ninject_to = [\"source.zig\"]\n"), "zig").is_ok());
    assert!(err("[[snippets]]\nlanguage = \"zig\"\npath = \"s.txt\"\n").contains("must end in"));
  }

  #[test]
  fn validates_language_servers() {
    let lsp = |body: &str| format!("[lsp.zls]\nname = \"ZLS\"\nlanguages = [\"zig\"]\ncommand = [\"zls\"]\n{body}");
    assert!(parse_manifest(&format!("{HEAD}{}", lsp("")), "zig").is_ok());
    assert!(err("[lsp.Zls]\nname = \"ZLS\"\nlanguages = [\"zig\"]\ncommand = [\"zls\"]\n").contains("Invalid language server name"));
    assert!(err("[lsp.zls]\nname = \" \"\nlanguages = [\"zig\"]\ncommand = [\"zls\"]\n").contains("has no name"));
    assert!(err("[lsp.zls]\nname = \"ZLS\"\nlanguages = []\ncommand = [\"zls\"]\n").contains("serves no languages"));
    assert!(err("[lsp.zls]\nname = \"ZLS\"\nlanguages = [\"zig\"]\ncommand = []\n").contains("has no command"));
    assert!(err(&lsp("env = { \"BAD-NAME\" = \"1\" }\n")).contains("BAD-NAME"));
    assert!(err(&lsp("settings_section = \"1zls\"\n")).contains("settings section"));
    assert!(err(&lsp("install = [{ tool = \"brew\", package = \"--force zls\" }]\n")).contains("install package"));
    assert!(err(&lsp("install = [{ tool = \"brew\", package = \"zls; rm -rf /\" }]\n")).contains("install package"));
    assert!(err(&lsp("install = [{ tool = \"apt\", package = \"zls\" }]\n")).contains("apt"));
    // `${setting:…}` must name a declared setting, in command and env alike.
    let e = err("[lsp.zls]\nname = \"ZLS\"\nlanguages = [\"zig\"]\ncommand = [\"${setting:nope}\"]\n");
    assert!(e.contains("\"nope\""), "{e}");
    let e = err(&lsp("env = { X = \"${setting:nope}\" }\n"));
    assert!(e.contains("\"nope\""), "{e}");
  }

  #[test]
  fn validates_themes_and_views() {
    assert!(err("[[themes]]\nlabel = \"\"\nui_theme = \"vs\"\npath = \"t.json\"\n").contains("no label"));
    assert!(err("[[themes]]\nlabel = \"A\"\nui_theme = \"vs-purple\"\npath = \"t.json\"\n").contains("vs-purple"));
    assert!(err("[[themes]]\nlabel = \"A\"\nui_theme = \"vs\"\npath = \"t.json\"\n[[themes]]\nlabel = \"A\"\nui_theme = \"vs-dark\"\npath = \"u.json\"\n").contains("declared twice"));
    assert!(err("[[icon_themes]]\nid = \"1x\"\nlabel = \"I\"\npath = \"i.json\"\n").contains("icon theme id"));
    let view = |extra: &str| format!("[[views]]\nid = \"board\"\nname = \"Board\"\nlocation = \"sidebar\"\npath = \"v.html\"\n{extra}");
    assert!(parse_manifest(&format!("{HEAD}{}", view("")), "zig").is_ok());
    assert!(err(&view("settings = [\"missing\"]\n")).contains("does not declare"));
    assert!(err(&view("tasks = [\"missing\"]\n")).contains("does not declare"));
    assert!(err(&view("").replace("location = \"sidebar\"", "location = \"editor\"")).contains("editor"));
    assert!(err(&view("").replace("v.html", "v.js")).contains("must end in"));
    assert!(err(&view("").replace("id = \"board\"", "id = \"Board\"")).contains("Invalid view id"));
    assert!(err(&format!("{}{}", view(""), view(""))).contains("declared twice"));
  }

  fn write(dir: &Path, rel: &str, text: &str) {
    let p = dir.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
  }

  pub(crate) fn zig_snap(dir: &Path) -> PathBuf {
    let d = dir.join("zig");
    write(&d, "snap.toml", ZIG);
    write(&d, "language-configuration.json", "{ \"comments\": { \"lineComment\": \"//\" } }");
    write(&d, "syntaxes/zig.tmLanguage.json", "{ \"scopeName\": \"source.zig\", \"patterns\": [] }");
    write(&d, "snippets/zig.code-snippets", "{}");
    write(&d, "themes/night.json", "{ \"colors\": {} }");
    write(&d, "icons/icons.json", "{ \"iconDefinitions\": {} }");
    write(&d, "views/board.html", "<p>board</p>");
    d
  }

  #[test]
  fn contributed_files_are_listed_hashed_and_covered_by_trust() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = zig_snap(tmp.path());
    let trust = snap::TrustData::default();
    let s = snap::read_snap(&dir, "zig", Source::Repo, Some(tmp.path()), &trust);
    assert_eq!(s.error, None);
    let files = &s.contributes.files;
    assert_eq!(files.len(), 6);
    assert_eq!(files.iter().find(|f| f.path == "views/board.html").unwrap().sha256, snap::sha256_hex(b"<p>board</p>"));
    // Not the manifest-only hash: a changed grammar revokes trust.
    assert_ne!(s.hash, snap::sha256_hex(ZIG.as_bytes()));
    write(&dir, "syntaxes/zig.tmLanguage.json", "{ \"scopeName\": \"source.zig\", \"patterns\": [{}] }");
    assert_ne!(snap::read_snap(&dir, "zig", Source::Repo, Some(tmp.path()), &trust).hash, s.hash);
  }

  #[test]
  fn missing_or_symlinked_files_break_the_snap() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = zig_snap(tmp.path());
    std::fs::remove_file(dir.join("views/board.html")).unwrap();
    let s = snap::read_snap(&dir, "zig", Source::User, None, &snap::TrustData::default());
    assert!(s.error.as_deref().unwrap().contains("views/board.html does not exist"), "{:?}", s.error);
    #[cfg(unix)]
    {
      let outside = tmp.path().join("outside.html");
      std::fs::write(&outside, "secret").unwrap();
      std::os::unix::fs::symlink(&outside, dir.join("views/board.html")).unwrap();
      let s = snap::read_snap(&dir, "zig", Source::User, None, &snap::TrustData::default());
      assert!(s.error.as_deref().unwrap().contains("symbolic link"), "{:?}", s.error);
      std::fs::remove_file(dir.join("views/board.html")).unwrap();
      std::fs::write(dir.join("views/board.html"), "x").unwrap();
      std::fs::remove_dir_all(dir.join("themes")).unwrap();
      std::os::unix::fs::symlink(tmp.path(), dir.join("themes")).unwrap();
      let s = snap::read_snap(&dir, "zig", Source::User, None, &snap::TrustData::default());
      assert!(s.error.as_deref().unwrap().contains("symbolic link"), "{:?}", s.error);
    }
  }

  #[test]
  fn reads_files_only_inside_the_snap_and_checks_their_hash() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = zig_snap(tmp.path());
    let sha = snap::sha256_hex(b"<p>board</p>");
    assert_eq!(read_snap_file(&dir, "views/board.html", Some(&sha), MAX_FILE_BYTES).unwrap(), b"<p>board</p>");
    // Undeclared files (a theme's include, icons) are read without a hash.
    write(&dir, "themes/base.json", "{}");
    assert_eq!(read_snap_file(&dir, "themes/base.json", None, MAX_FILE_BYTES).unwrap(), b"{}");
    write(&dir, "views/board.html", "<p>changed</p>");
    assert!(read_snap_file(&dir, "views/board.html", Some(&sha), MAX_FILE_BYTES).unwrap_err().contains("changed since"));
    for bad in ["../outside.json", "/etc/passwd", "a//b", "./x", ".hidden/x", "x/../y"] {
      assert!(read_snap_file(&dir, bad, None, MAX_FILE_BYTES).unwrap_err().contains("Invalid path"), "{bad}");
    }
    assert!(read_snap_file(&dir, "themes", None, MAX_FILE_BYTES).unwrap_err().contains("not a regular file"));
    assert!(read_snap_file(&dir, "views/board.html", None, 4).unwrap_err().contains("larger than"));
  }

  #[test]
  fn images_become_data_urls() {
    assert_eq!(data_url("i/a.svg", b"<svg/>").unwrap(), "data:image/svg+xml;base64,PHN2Zy8+");
    assert!(data_url("i/a.PNG", b"x").unwrap().starts_with("data:image/png;base64,"));
    assert!(data_url("i/a.html", b"x").is_err());
  }

  /// The example snap in tests/fixtures (every kind of contribution) is valid, and its view opens.
  #[test]
  fn the_example_fixture_snap_is_valid() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/snaps/example");
    let s = snap::read_snap(&dir, "example", Source::User, None, &snap::TrustData::default());
    assert_eq!(s.error, None);
    let c = &s.contributes;
    assert_eq!((c.languages.len(), c.grammars.len(), c.snippets.len(), c.lsp.len(), c.themes.len(), c.icon_themes.len(), c.views.len()), (1, 1, 1, 1, 1, 1, 1));
    assert_eq!(c.files.len(), 6);
    let page = crate::snap_view::page_of(&s, false, "board").unwrap();
    assert!(page.starts_with("<!doctype html><script>") && page.contains("kingu.getSetting('greeting')"));
  }

  #[test]
  fn snap_dirs_by_source() {
    let cfg = Path::new("/cfg");
    assert_eq!(snap_dir(cfg, None, Source::User, "zig").unwrap(), Path::new("/cfg/snaps/zig"));
    assert!(snap_dir(cfg, None, Source::User, "../x").is_err());
    assert!(snap_dir(cfg, None, Source::Repo, "zig").is_err());
    assert!(snap_dir(cfg, None, Source::Builtin, "zig").is_err());
  }
}
