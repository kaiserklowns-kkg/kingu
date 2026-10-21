//! Built-in snaps: snaps that ship with the app (`apps/desktop/snaps/<id>/`), so what Kingu
//! bundles goes through the same contribution path as a user's snap. Today: `rust-analyzer` (the
//! Rust language server, formerly a row of lsp.rs's server table) and `kingu-themes` (the color
//! themes, formerly vendored under the editor).
//!
//! Rust embeds the manifests (it starts their language servers); the webview gets the built-ins
//! from `src/lib/snaps/builtinSnaps.json`, which a test here writes from the same folders and
//! keeps current (`KINGU_UPDATE_BUILTIN_SNAPS=1 cargo test builtin`), and loads their files (theme
//! JSON) from the folders as part of the app bundle. They are trusted, never listed by
//! `snap_list`, and a user or repo snap with the same id overrides one.

use std::sync::OnceLock;

use crate::lsp::{Package, ServerSpec};
use crate::snap::{Parsed, parse_manifest};
use crate::snap_contrib::InstallTool;

/// (id, snap.toml), one per folder of `apps/desktop/snaps`.
const MANIFESTS: &[(&str, &str)] = &[
  ("kingu-themes", include_str!("../../snaps/kingu-themes/snap.toml")),
  ("rust-analyzer", include_str!("../../snaps/rust-analyzer/snap.toml")),
];

/// The parsed built-in manifests (a broken one is a test failure, and left out at runtime).
pub fn list() -> &'static [Parsed] {
  static LIST: OnceLock<Vec<Parsed>> = OnceLock::new();
  LIST.get_or_init(|| {
    MANIFESTS
      .iter()
      .filter_map(|(id, text)| parse_manifest(text, id).inspect_err(|e| log::error!("built-in snap {id}: {e}")).ok())
      .collect()
  })
}

/// A built-in language server as lsp.rs's static server table has them: (snap id, server key,
/// languages, spec). Leaked once per process from the embedded manifests.
pub struct BuiltinServer {
  pub snap: &'static str,
  pub key: &'static str,
  pub languages: Vec<&'static str>,
  pub spec: ServerSpec,
}

fn leak(s: &str) -> &'static str {
  Box::leak(s.to_owned().into_boxed_str())
}

fn package(tool: InstallTool, words: &'static str) -> Package {
  match tool {
    InstallTool::Npm => Package::Npm(words),
    InstallTool::Go => Package::Go(words),
    InstallTool::Rustup => Package::Rustup(words),
    InstallTool::Brew => Package::Brew(words),
    InstallTool::Pytool => Package::PyTool(words),
    InstallTool::Cargo => Package::Cargo(words),
    InstallTool::Pip => Package::Pip(words),
  }
}

/// Every built-in snap's language servers. Their commands have no `${setting:…}` (checked by a
/// test): the program is the binary looked up like the table's, its other words the arguments.
pub fn servers() -> &'static [BuiltinServer] {
  static SERVERS: OnceLock<Vec<BuiltinServer>> = OnceLock::new();
  SERVERS.get_or_init(|| {
    let mut out = Vec::new();
    for p in list() {
      for s in &p.contributes.lsp {
        let binaries: &'static [&'static str] = Box::leak(vec![leak(&s.command[0])].into_boxed_slice());
        let args: &'static [&'static str] = Box::leak(s.command[1..].iter().map(|a| leak(a)).collect::<Vec<_>>().into_boxed_slice());
        let install: &'static [Package] = Box::leak(s.install.iter().map(|h| package(h.tool, leak(&h.package))).collect::<Vec<_>>().into_boxed_slice());
        let key = leak(&s.key);
        out.push(BuiltinServer {
          snap: leak(&p.id),
          key,
          languages: s.languages.iter().map(|l| leak(l)).collect(),
          spec: ServerSpec { key, display: leak(&s.name), binaries, args, install },
        });
      }
    }
    out
  })
}

/// The built-in snap server for a language, if one serves it.
pub fn spec_for(language: &str) -> Option<ServerSpec> {
  servers().iter().find(|s| s.languages.contains(&language)).map(|s| s.spec.clone())
}

/// Server `key` of built-in snap `snap`.
pub fn server(snap: &str, key: &str) -> Option<&'static BuiltinServer> {
  servers().iter().find(|s| s.snap == snap && s.key == key)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::snap::{Source, TrustData, read_snap};
  use std::path::Path;

  fn folder() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../snaps")
  }

  #[test]
  fn every_folder_is_embedded_and_valid() {
    let mut on_disk: Vec<String> = std::fs::read_dir(folder()).unwrap().flatten().filter(|e| e.path().join("snap.toml").is_file()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    on_disk.sort();
    let embedded: Vec<&str> = MANIFESTS.iter().map(|(id, _)| *id).collect();
    assert_eq!(on_disk, embedded);
    assert_eq!(list().len(), MANIFESTS.len(), "a built-in manifest does not parse");
    for (id, _) in MANIFESTS {
      let s = read_snap(&folder().join(id), id, Source::Builtin, None, &TrustData::default());
      assert_eq!(s.error, None, "{id}");
      assert!(s.trusted);
      // Built-ins are data and language servers only: nothing that runs on its own.
      assert!(s.tasks.is_empty() && s.mcp.is_empty() && s.contributes.views.is_empty(), "{id}");
      for server in &s.contributes.lsp {
        assert!(server.command.iter().all(|a| !a.contains("${")), "{id}: built-in servers take no settings");
      }
    }
  }

  /// The webview's copy of the built-in snaps (`builtinSnaps.json`) is what Rust reads from the
  /// folders. `KINGU_UPDATE_BUILTIN_SNAPS=1` rewrites it.
  #[test]
  fn builtin_snapshot_is_current() {
    let snaps: Vec<_> = MANIFESTS
      .iter()
      .map(|(id, _)| {
        let mut s = read_snap(&folder().join(id), id, Source::Builtin, None, &TrustData::default());
        s.dir = String::new();
        s
      })
      .collect();
    let text = format!("{}\n", serde_json::to_string_pretty(&snaps).unwrap());
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/snaps/builtinSnaps.json");
    if std::env::var_os("KINGU_UPDATE_BUILTIN_SNAPS").is_some() {
      std::fs::write(&file, &text).unwrap();
    }
    let current = std::fs::read_to_string(&file).unwrap_or_default();
    assert!(current == text, "src/lib/snaps/builtinSnaps.json is stale: run KINGU_UPDATE_BUILTIN_SNAPS=1 cargo test builtin_snapshot");
  }

  /// rust-analyzer moved from lsp.rs's table into the built-in snap unchanged.
  #[test]
  fn rust_analyzer_is_the_same_server_as_before() {
    let spec = spec_for("rust").unwrap();
    assert_eq!((spec.key, spec.display), ("rust", "rust-analyzer"));
    assert_eq!(spec.binaries, ["rust-analyzer"]);
    assert!(spec.args.is_empty());
    assert_eq!(spec.install, [Package::Rustup("rust-analyzer"), Package::Brew("rust-analyzer")]);
    assert_eq!(crate::lsp::spec_for("rust"), Some(spec));
    let s = server("rust-analyzer", "rust").unwrap();
    assert_eq!(s.languages, ["rust"]);
    assert!(spec_for("go").is_none());
  }
}
