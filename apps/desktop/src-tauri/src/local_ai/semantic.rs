//! Semantic search (old Kingu's `kinguSemanticSearch.ts` + `node/semanticSearch.ts`): the
//! workspace's text in overlapping chunks, embedded by the user's own model server (bge-m3 reads
//! Thai as well as English), ranked by cosine against the query's embedding.
//!
//! - The index lives under the app cache dir, one file per workspace folder, and is brought up to
//!   date in the background: only files new or changed since (mtime and size) are embedded again,
//!   recently changed ones first, and it is saved as it goes so a long first index survives a quit.
//! - Memory stays bounded: at most [`MAX_FILES`] files and [`MAX_CHUNKS`] chunks, vectors kept as
//!   one byte per dimension (a 1024-dimension bge-m3 chunk is 1 KB), chunk text never kept (the
//!   shown line is read from the file when it is a hit), and one batch of text in flight.
//! - Files come from `rg --files`, so `.gitignore` and `files.exclude` / `search.exclude` apply as
//!   in Find in Files.
//! - An index made with another server or model, or by an older Kingu, is thrown away.

use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, RwLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as B64;
use regex::Regex;

use super::http::{self, Endpoint, Transport};
use crate::i18n::msg::LocalAiMsg;
use crate::tr;

const CHUNK_LINES: usize = 60;
const CHUNK_STEP: usize = 50;
const MAX_CHUNK_CHARS: usize = 1500;
pub const MAX_FILES: usize = 5000;
pub const MAX_CHUNKS: usize = 30_000;
const MAX_FILE_BYTES: u64 = 256 * 1024;
const EMBED_BATCH: usize = 16;
const SAVE_EVERY: Duration = Duration::from_secs(30);
/// Bumped when chunking or storage changes: older indexes are rebuilt.
const INDEX_VERSION: u32 = 1;
/// Below this a chunk is not related enough to show.
const MIN_SCORE: f32 = 0.3;
pub const DEFAULT_LIMIT: usize = 30;

/// Text worth searching by meaning; images, archives and builds are left out.
const TEXT_EXTENSIONS: &[&str] = &[
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "svelte", "py", "php", "go", "rs", "java", "kt", "cs", "rb", "swift", "c", "h", "cpp", "hpp", "md", "mdx",
  "txt", "json", "yml", "yaml", "toml", "ini", "xml", "html", "css", "scss", "less", "sql", "sh", "ps1", "bat", "graphql", "proto", "dart", "lua", "zig",
];
static SKIPPED: LazyLock<Regex> = LazyLock::new(|| {
  Regex::new(r"(?i)(^|/)(node_modules|\.git|dist|build|out|vendor|\.next|coverage|target)(/|$)|(\.min\.(js|css)|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock|Cargo\.lock|composer\.lock)$").unwrap()
});

/// Whether a workspace-relative path is text worth embedding.
pub fn indexable(rel: &str) -> bool {
  let ext = Path::new(rel).extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
  TEXT_EXTENSIONS.contains(&ext.as_str()) && !SKIPPED.is_match(rel)
}

// ---------------------------------------------------------------------------------------------
// Chunks and ranking

/// Line ranges `[start, end)` of `lines` in windows of 60 lines, 10 shared with the next, so a
/// passage cut at a boundary is still whole in one chunk. Blank windows are left out.
pub fn chunk_ranges(lines: &[&str]) -> Vec<(usize, usize)> {
  let mut out = Vec::new();
  let mut start = 0;
  while start < lines.len() {
    let end = (start + CHUNK_LINES).min(lines.len());
    if lines[start..end].iter().any(|l| !l.trim().is_empty()) {
      out.push((start, end));
    }
    if end >= lines.len() {
      break;
    }
    start += CHUNK_STEP;
  }
  out
}

/// What is embedded for a chunk: its path first, so a file's name counts towards what it is
/// about, then the text, cut to what the model reads well.
pub fn embedding_text(rel: &str, lines: &[&str]) -> String {
  let text = format!("{rel}\n{}", lines.join("\n"));
  super::fim::head_chars(&text, MAX_CHUNK_CHARS).to_string()
}

/// Lines that open a file rather than say what it does.
static BOILERPLATE: LazyLock<Regex> =
  LazyLock::new(|| Regex::new(r#"^(<\?php|namespace\s|use\s|import\s|package\s|#include|'use strict'|"use strict"|//|/\*|\*)"#).unwrap());

/// The line of a chunk to show and jump to (0-based in the file): the one sharing most words
/// with the query, else the first that says something (a Thai query over English code, say).
pub fn best_line(lines: &[&str], start: usize, query: &str) -> (usize, String) {
  let lower = query.to_lowercase();
  let words: Vec<&str> = lower.split(|c: char| c.is_whitespace() || matches!(c, '_' | '-' | '.')).filter(|w| w.chars().count() > 1).collect();
  let mut best = None;
  let mut best_count = 0;
  for (i, line) in lines.iter().enumerate() {
    let l = line.to_lowercase();
    let count = words.iter().filter(|w| l.contains(*w)).count();
    if count > best_count {
      best = Some(i);
      best_count = count;
    }
  }
  let index = best.unwrap_or_else(|| {
    lines
      .iter()
      .position(|l| {
        let t = l.trim();
        t.chars().any(char::is_alphabetic) && t.chars().count() >= 12 && !BOILERPLATE.is_match(t)
      })
      .or_else(|| lines.iter().position(|l| !l.trim().is_empty()))
      .unwrap_or(0)
  });
  (start + index, lines.get(index).map_or("", |l| l.trim()).to_string())
}

/// `v` scaled to length 1, so a dot product is its cosine.
pub fn normalize(v: &[f32]) -> Vec<f32> {
  let length = v.iter().map(|x| x * x).sum::<f32>().sqrt();
  if length == 0.0 { v.to_vec() } else { v.iter().map(|x| x / length).collect() }
}

/// A unit vector in one byte per dimension.
pub fn quantize(unit: &[f32]) -> Vec<i8> {
  unit.iter().map(|x| (x * 127.0).round().clamp(-127.0, 127.0) as i8).collect()
}

/// The cosine of a unit query vector and a quantized unit chunk vector.
pub fn cosine(query: &[f32], chunk: &[i8]) -> f32 {
  query.iter().zip(chunk).map(|(q, c)| q * f32::from(*c)).sum::<f32>() / 127.0
}

// ---------------------------------------------------------------------------------------------
// The index

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct IndexedChunk {
  pub start: u32,
  pub end: u32,
  #[serde(with = "b64_vector")]
  pub vector: Vec<i8>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct IndexedFile {
  pub mtime: u64,
  pub size: u64,
  pub chunks: Vec<IndexedChunk>,
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Index {
  pub version: u32,
  /// The server and model that made the vectors ([`Endpoint::identity`]).
  pub identity: String,
  pub files: BTreeMap<String, IndexedFile>,
}

mod b64_vector {
  use super::B64;
  use base64::Engine;

  pub fn serialize<S: serde::Serializer>(v: &[i8], s: S) -> Result<S::Ok, S::Error> {
    let bytes: Vec<u8> = v.iter().map(|x| *x as u8).collect();
    s.serialize_str(&B64.encode(bytes))
  }

  pub fn deserialize<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<i8>, D::Error> {
    let text: String = serde::Deserialize::deserialize(d)?;
    let bytes = B64.decode(text).map_err(serde::de::Error::custom)?;
    Ok(bytes.into_iter().map(|b| b as i8).collect())
  }
}

impl Index {
  pub fn new(identity: &str) -> Self {
    Self { version: INDEX_VERSION, identity: identity.to_string(), files: BTreeMap::new() }
  }

  /// `self`, or an empty index when it was made by another model or an older Kingu.
  pub fn for_identity(self, identity: &str) -> Self {
    if self.version == INDEX_VERSION && self.identity == identity { self } else { Self::new(identity) }
  }

  pub fn chunk_count(&self) -> usize {
    self.files.values().map(|f| f.chunks.len()).sum()
  }

  pub fn load(path: &Path) -> Option<Self> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
  }

  pub fn save(&self, path: &Path) -> Result<(), String> {
    let dir = path.parent().ok_or("index path has no parent")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    let result = (|| {
      let mut f = std::io::BufWriter::new(std::fs::File::create(&tmp)?);
      serde_json::to_writer(&mut f, self)?;
      f.flush()?;
      std::fs::rename(&tmp, path)
    })();
    result.map_err(|e| {
      let _ = std::fs::remove_file(&tmp);
      format!("{}: {e}", path.display())
    })
  }
}

/// A file as listed now: workspace-relative path, mtime in ms, size in bytes.
#[derive(Debug, Clone, PartialEq)]
pub struct Listed {
  pub rel: String,
  pub mtime: u64,
  pub size: u64,
}

/// What an update has to do: files gone from the workspace, and files new or changed since they
/// were embedded, most recently changed first (the work at hand is searchable soonest).
pub fn plan(index: &Index, listing: &[Listed]) -> (Vec<String>, Vec<Listed>) {
  let present: std::collections::HashSet<&str> = listing.iter().map(|l| l.rel.as_str()).collect();
  let removed = index.files.keys().filter(|k| !present.contains(k.as_str())).cloned().collect();
  let mut pending: Vec<Listed> = listing
    .iter()
    .filter(|l| l.size <= MAX_FILE_BYTES && index.files.get(&l.rel).is_none_or(|f| f.mtime != l.mtime || f.size != l.size))
    .cloned()
    .collect();
  pending.sort_by(|a, b| b.mtime.cmp(&a.mtime).then_with(|| a.rel.cmp(&b.rel)));
  (removed, pending)
}

/// The best `limit` chunks for a unit query vector: (path, start line, end line, score).
pub fn rank(index: &Index, query: &[f32], limit: usize) -> Vec<(String, u32, u32, f32)> {
  let mut hits: Vec<(String, u32, u32, f32)> = Vec::new();
  for (rel, file) in &index.files {
    for chunk in &file.chunks {
      let score = cosine(query, &chunk.vector);
      if score >= MIN_SCORE {
        hits.push((rel.clone(), chunk.start, chunk.end, score));
      }
    }
  }
  hits.sort_by(|a, b| b.3.total_cmp(&a.3));
  hits.truncate(limit);
  hits
}

// ---------------------------------------------------------------------------------------------
// Listing and updating

/// The workspace's indexable files, as Find in Files would see them (`rg --files`): ignore files
/// unless turned off, the exclude globs, never `.git` or task worktrees.
pub fn list_files(rg: &Path, root: &Path, exclude_globs: &[String], use_ignore_files: bool) -> Result<Vec<Listed>, String> {
  let mut args: Vec<String> = ["--files", "--no-config", "--hidden", "--no-messages"].map(String::from).to_vec();
  if !use_ignore_files {
    args.push("--no-ignore".into());
  }
  let defaults = ["**/.git", "**/.git/**", "**/.DS_Store", crate::search::TASK_WORKTREES_GLOB];
  for g in defaults.iter().map(|g| g.to_string()).chain(exclude_globs.iter().map(|g| g.trim().to_string())).filter(|g| !g.is_empty() && !g.starts_with('!')) {
    args.push("--glob".into());
    args.push(format!("!{g}"));
  }
  args.extend(["--".into(), "./".into()]);
  let out = Command::new(rg).args(&args).current_dir(root).stdin(Stdio::null()).stderr(Stdio::null()).output().map_err(|e| format!("{}: {e}", rg.display()))?;
  let text = String::from_utf8_lossy(&out.stdout);
  let mut listed = Vec::new();
  for raw in text.lines() {
    let rel = raw.strip_prefix("./").unwrap_or(raw).replace('\\', "/");
    if !indexable(&rel) {
      continue;
    }
    let Ok(meta) = std::fs::metadata(root.join(&rel)) else { continue };
    let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
    listed.push(Listed { rel, mtime, size: meta.len() });
  }
  // The most recently changed files are kept when there are too many.
  listed.sort_by_key(|l| std::cmp::Reverse(l.mtime));
  listed.truncate(MAX_FILES);
  Ok(listed)
}

/// How far an index is, for the status bar and the search's footer.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct Status {
  /// `idle` (never built here), `building`, `ready` or `error`.
  pub state: &'static str,
  pub done: usize,
  pub total: usize,
  pub files: usize,
  pub chunks: usize,
  /// The chunk limit was reached; some files are not indexed.
  pub limited: bool,
  pub error: Option<String>,
}

/// Embeds a batch of texts: one vector per text, in order.
pub type Embed<'a> = dyn Fn(&[String]) -> Result<Vec<Vec<f32>>, String> + 'a;

/// Embeds the chunks of `pending` into `index` in batches, a file joining once all its chunks
/// are in. Stops early when `cancel` is set; calls `progress` after each file and `save` now and
/// then and at the end.
#[allow(clippy::too_many_arguments)]
pub fn update(
  root: &Path,
  index: &RwLock<Index>,
  removed: &[String],
  pending: &[Listed],
  embed: &Embed,
  cancel: &AtomicBool,
  progress: &mut dyn FnMut(usize, bool),
  save: &mut dyn FnMut(&Index),
) -> Result<(), String> {
  {
    let mut ix = index.write().unwrap_or_else(|e| e.into_inner());
    for rel in removed {
      ix.files.remove(rel);
    }
  }
  let mut chunks_total = index.read().unwrap_or_else(|e| e.into_inner()).chunk_count();
  let mut last_save = Instant::now();
  let mut dirty = !removed.is_empty();
  let mut limited = false;
  for (done, file) in pending.iter().enumerate() {
    if cancel.load(Ordering::SeqCst) {
      break;
    }
    let text = std::fs::read(root.join(&file.rel)).ok().filter(|b| !b.contains(&0)).and_then(|b| String::from_utf8(b).ok());
    match text {
      None => {
        // Unreadable or binary now: whatever was indexed for it goes.
        dirty |= index.write().unwrap_or_else(|e| e.into_inner()).files.remove(&file.rel).is_some();
      }
      Some(text) => {
        let lines: Vec<&str> = text.lines().collect();
        let ranges = chunk_ranges(&lines);
        let previous = index.read().unwrap_or_else(|e| e.into_inner()).files.get(&file.rel).map_or(0, |f| f.chunks.len());
        if chunks_total - previous + ranges.len() > MAX_CHUNKS {
          limited = true;
          progress(done + 1, limited);
          continue;
        }
        let mut vectors = Vec::with_capacity(ranges.len());
        for batch in ranges.chunks(EMBED_BATCH) {
          if cancel.load(Ordering::SeqCst) {
            return Ok(());
          }
          let inputs: Vec<String> = batch.iter().map(|&(s, e)| embedding_text(&file.rel, &lines[s..e])).collect();
          let out = embed(&inputs)?;
          if out.len() != inputs.len() {
            return Err(tr!(LocalAiMsg::BadReply));
          }
          vectors.extend(out.iter().map(|v| quantize(&normalize(v))));
        }
        let chunks = ranges.iter().zip(vectors).map(|(&(s, e), vector)| IndexedChunk { start: s as u32, end: e as u32, vector }).collect::<Vec<_>>();
        chunks_total = chunks_total - previous + chunks.len();
        index.write().unwrap_or_else(|e| e.into_inner()).files.insert(file.rel.clone(), IndexedFile { mtime: file.mtime, size: file.size, chunks });
        dirty = true;
      }
    }
    progress(done + 1, limited);
    if dirty && last_save.elapsed() > SAVE_EVERY {
      save(&index.read().unwrap_or_else(|e| e.into_inner()));
      dirty = false;
      last_save = Instant::now();
    }
  }
  if dirty {
    save(&index.read().unwrap_or_else(|e| e.into_inner()));
  }
  Ok(())
}

/// Embeds `inputs` with the configured server and model.
pub fn embed_with(transport: &dyn Transport, endpoint: &Endpoint, model: &str, inputs: &[String]) -> Result<Vec<Vec<f32>>, String> {
  let req = http::embed_request(endpoint, model, inputs)?;
  http::parse_embeddings(endpoint.provider, &transport.post_json(&req)?)
}

// ---------------------------------------------------------------------------------------------
// Per-workspace state

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct SemanticConfig {
  /// `kingu.semanticSearch.enabled`; nothing is sent while it is off.
  pub enabled: bool,
  pub endpoint: Endpoint,
  /// `kingu.semanticSearch.model`.
  pub model: String,
  /// `files.exclude` + `search.exclude` globs.
  pub exclude_globs: Vec<String>,
  pub use_ignore_files: Option<bool>,
}

struct Run {
  root: PathBuf,
  identity: String,
  index: Arc<RwLock<Index>>,
  status: Arc<Mutex<Status>>,
  cancel: Arc<AtomicBool>,
  building: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct Semantic {
  run: Mutex<Option<Run>>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Hit {
  pub path: String,
  /// 1-based line to show and jump to.
  pub line: u32,
  pub text: String,
  /// 1-based lines of the chunk.
  pub start_line: u32,
  pub end_line: u32,
  pub score: f32,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct SearchResult {
  pub hits: Vec<Hit>,
  pub status: Status,
}

/// Where `root`'s index is kept under `cache_dir`.
pub fn index_path(cache_dir: &Path, root: &Path) -> PathBuf {
  use sha2::{Digest, Sha256};
  let hash: String = Sha256::digest(root.to_string_lossy().as_bytes()).iter().take(12).map(|b| format!("{b:02x}")).collect();
  cache_dir.join("semantic-index").join(format!("{hash}.json"))
}

impl Semantic {
  pub fn status(&self) -> Status {
    let run = self.run.lock().unwrap_or_else(|e| e.into_inner());
    run.as_ref().map(|r| r.status.lock().unwrap_or_else(|e| e.into_inner()).clone()).unwrap_or(Status { state: "idle", ..Default::default() })
  }

  /// Stops any build and forgets the index in memory (`delete` also removes it from disk).
  pub fn reset(&self, delete: Option<&Path>) {
    if let Some(run) = self.run.lock().unwrap_or_else(|e| e.into_inner()).take() {
      run.cancel.store(true, Ordering::SeqCst);
    }
    if let Some(path) = delete {
      let _ = std::fs::remove_file(path);
    }
  }

  /// Starts bringing `root`'s index up to date in the background, unless that is already under
  /// way; another workspace's build is stopped. `notify` gets the status as it changes.
  pub fn start(
    &self,
    root: &Path,
    cache_dir: &Path,
    rg: PathBuf,
    config: &SemanticConfig,
    transport: Arc<dyn Transport>,
    notify: Arc<dyn Fn(Status) + Send + Sync>,
  ) -> Result<Status, String> {
    if !config.enabled {
      return Err(tr!(LocalAiMsg::SemanticOff));
    }
    let model = config.model.trim().to_string();
    if model.is_empty() {
      return Err(tr!(LocalAiMsg::NoModel));
    }
    let identity = config.endpoint.identity(&model);
    let path = index_path(cache_dir, root);
    let mut guard = self.run.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(run) = guard.as_ref().filter(|r| r.root != root || r.identity != identity) {
      run.cancel.store(true, Ordering::SeqCst);
      *guard = None;
    }
    let run = guard.get_or_insert_with(|| {
      let index = Index::load(&path).unwrap_or_default().for_identity(&identity);
      let status = Status { state: "idle", files: index.files.len(), chunks: index.chunk_count(), ..Default::default() };
      Run {
        root: root.to_path_buf(),
        identity: identity.clone(),
        index: Arc::new(RwLock::new(index)),
        status: Arc::new(Mutex::new(status)),
        cancel: Arc::new(AtomicBool::new(false)),
        building: Arc::new(AtomicBool::new(false)),
      }
    });
    if run.building.swap(true, Ordering::SeqCst) {
      return Ok(run.status.lock().unwrap_or_else(|e| e.into_inner()).clone());
    }
    let (index, status, cancel, building) = (run.index.clone(), run.status.clone(), run.cancel.clone(), run.building.clone());
    let set = {
      let status = status.clone();
      let notify = notify.clone();
      move |f: &dyn Fn(&mut Status)| {
        let s = {
          let mut s = status.lock().unwrap_or_else(|e| e.into_inner());
          f(&mut s);
          s.clone()
        };
        notify(s);
      }
    };
    set(&|s| {
      s.state = "building";
      s.error = None;
      s.done = 0;
      s.total = 0;
    });
    let root = root.to_path_buf();
    let endpoint = config.endpoint.clone();
    let excludes = config.exclude_globs.clone();
    let use_ignore = config.use_ignore_files.unwrap_or(true);
    let initial = status.lock().unwrap_or_else(|e| e.into_inner()).clone();
    std::thread::Builder::new()
      .name("semantic-index".into())
      .spawn(move || {
        let started = Instant::now();
        let result = (|| -> Result<(), String> {
          let listing = list_files(&rg, &root, &excludes, use_ignore)?;
          let (removed, pending) = plan(&index.read().unwrap_or_else(|e| e.into_inner()), &listing);
          set(&|s| s.total = pending.len());
          let embed = |inputs: &[String]| embed_with(transport.as_ref(), &endpoint, &model, inputs);
          let mut progress = |done: usize, limited: bool| {
            let ix = index.read().unwrap_or_else(|e| e.into_inner());
            let (files, chunks) = (ix.files.len(), ix.chunk_count());
            drop(ix);
            set(&|s| {
              s.done = done;
              s.limited = limited;
              s.files = files;
              s.chunks = chunks;
            });
          };
          let mut save = |ix: &Index| {
            if let Err(e) = ix.save(&path) {
              log::warn!("semantic index save: {e}");
            }
          };
          update(&root, &index, &removed, &pending, &embed, &cancel, &mut progress, &mut save)
        })();
        let ix = index.read().unwrap_or_else(|e| e.into_inner());
        let (files, chunks) = (ix.files.len(), ix.chunk_count());
        drop(ix);
        building.store(false, Ordering::SeqCst);
        if cancel.load(Ordering::SeqCst) {
          return;
        }
        log::info!("semantic index: {files} files, {chunks} chunks in {:?}{}", started.elapsed(), result.as_ref().err().map(|e| format!(" ({e})")).unwrap_or_default());
        set(&|s| {
          s.files = files;
          s.chunks = chunks;
          match &result {
            Ok(()) => s.state = "ready",
            Err(e) => {
              s.state = "error";
              s.error = Some(e.clone());
            }
          }
        });
      })
      .map_err(|e| e.to_string())?;
    Ok(Status { state: "building", ..initial })
  }

  /// Ranks what the index holds now for `query` (a first index may still be under way).
  pub fn search(&self, root: &Path, transport: &dyn Transport, config: &SemanticConfig, query: &str, limit: usize) -> Result<SearchResult, String> {
    if !config.enabled {
      return Err(tr!(LocalAiMsg::SemanticOff));
    }
    let query = query.trim();
    let index = {
      let run = self.run.lock().unwrap_or_else(|e| e.into_inner());
      run.as_ref().filter(|r| r.root == root).map(|r| r.index.clone())
    };
    let status = self.status();
    let Some(index) = index.filter(|_| !query.is_empty()) else { return Ok(SearchResult { hits: Vec::new(), status }) };
    let vectors = embed_with(transport, &config.endpoint, config.model.trim(), &[query.to_string()])?;
    let unit = normalize(vectors.first().ok_or_else(|| tr!(LocalAiMsg::BadReply))?);
    let ranked = rank(&index.read().unwrap_or_else(|e| e.into_inner()), &unit, limit.clamp(1, 200));
    let mut texts: HashMap<String, Option<String>> = HashMap::new();
    let hits = ranked
      .into_iter()
      .map(|(path, start, end, score)| {
        let text = texts.entry(path.clone()).or_insert_with(|| std::fs::read_to_string(root.join(&path)).ok());
        let (line, shown) = match text {
          Some(t) => {
            let lines: Vec<&str> = t.lines().collect();
            let (s, e) = ((start as usize).min(lines.len()), (end as usize).min(lines.len()));
            best_line(&lines[s..e], s, query)
          }
          None => (start as usize, String::new()),
        };
        Hit { path, line: line as u32 + 1, text: shown, start_line: start + 1, end_line: end, score }
      })
      .collect();
    Ok(SearchResult { hits, status })
  }
}

#[cfg(test)]
mod tests {
  use super::super::test_server::{Reply, TestServer};
  use super::*;
  use crate::local_ai::http::Provider;

  #[test]
  fn chunks_in_overlapping_windows_and_leaves_blank_ones_out() {
    let text: Vec<String> = (0..115).map(|i| format!("line {i}")).collect();
    let lines: Vec<&str> = text.iter().map(String::as_str).collect();
    assert_eq!(chunk_ranges(&lines), [(0, 60), (50, 110), (100, 115)]);
    assert!(chunk_ranges(&["", "  ", ""]).is_empty());
    assert!(chunk_ranges(&[]).is_empty());
    assert_eq!(chunk_ranges(&["a"]), [(0, 1)]);
  }

  #[test]
  fn embeds_the_path_then_the_text_cut_by_characters() {
    assert_eq!(embedding_text("src/a.rs", &["fn a() {}", "}"]), "src/a.rs\nfn a() {}\n}");
    let thai = "ก".repeat(2000);
    assert_eq!(embedding_text("x.md", &[&thai]).chars().count(), MAX_CHUNK_CHARS);
  }

  #[test]
  fn shows_the_line_that_shares_most_words_with_the_query() {
    assert_eq!(best_line(&["", "class Foo {}", "function stockLedger() {}", "stock ledger check"], 10, "ledger check"), (13, "stock ledger check".into()));
    assert_eq!(best_line(&["<?php", "namespace App;", "", "class InventoryLedgerCheck"], 0, "ตรวจสอบ"), (3, "class InventoryLedgerCheck".into()));
  }

  #[test]
  fn ranks_by_cosine() {
    let unit = normalize(&[1.0, 1.0]);
    assert!((cosine(&normalize(&[1.0, 0.0]), &quantize(&unit)) - 0.707).abs() < 0.01);
    let mut index = Index::new("x");
    let file = |v: &[f32]| IndexedFile { mtime: 0, size: 0, chunks: vec![IndexedChunk { start: 0, end: 1, vector: quantize(&normalize(v)) }] };
    index.files.insert("near.rs".into(), file(&[0.9, 0.1]));
    index.files.insert("far.rs".into(), file(&[0.0, 1.0]));
    index.files.insert("mid.rs".into(), file(&[0.6, 0.4]));
    let ranked: Vec<String> = rank(&index, &normalize(&[1.0, 0.0]), 10).into_iter().map(|h| h.0).collect();
    // `far.rs` is below the threshold.
    assert_eq!(ranked, ["near.rs", "mid.rs"]);
    assert_eq!(rank(&index, &normalize(&[1.0, 0.0]), 1).len(), 1);
  }

  #[test]
  fn plans_only_changed_files_and_drops_removed_ones() {
    let mut index = Index::new("x");
    let entry = |mtime, size| IndexedFile { mtime, size, chunks: Vec::new() };
    index.files.insert("same.rs".into(), entry(1, 10));
    index.files.insert("touched.rs".into(), entry(1, 10));
    index.files.insert("gone.rs".into(), entry(1, 10));
    let listed = |rel: &str, mtime, size| Listed { rel: rel.into(), mtime, size };
    let (removed, pending) = plan(&index, &[listed("same.rs", 1, 10), listed("touched.rs", 2, 10), listed("new.rs", 5, 3), listed("huge.rs", 9, MAX_FILE_BYTES + 1)]);
    assert_eq!(removed, ["gone.rs"]);
    // Most recently changed first; too big never.
    assert_eq!(pending.iter().map(|l| l.rel.as_str()).collect::<Vec<_>>(), ["new.rs", "touched.rs"]);
    let resized = plan(&index, &[listed("same.rs", 1, 11)]).1;
    assert_eq!(resized.len(), 1);
  }

  #[test]
  fn another_model_or_version_invalidates_the_index() {
    let mut index = Index::new("ollama|http://x|bge-m3");
    index.files.insert("a.rs".into(), IndexedFile { mtime: 1, size: 1, chunks: Vec::new() });
    assert_eq!(index.clone().for_identity("ollama|http://x|bge-m3").files.len(), 1);
    assert!(index.clone().for_identity("ollama|http://x|nomic-embed-text").files.is_empty());
    let old = Index { version: INDEX_VERSION - 1, ..index };
    assert!(old.for_identity("ollama|http://x|bge-m3").files.is_empty());
  }

  #[test]
  fn saves_and_loads_the_index() {
    let dir = tempfile::tempdir().unwrap();
    let path = index_path(dir.path(), Path::new("/work/kingu"));
    assert_ne!(path, index_path(dir.path(), Path::new("/work/other")));
    let mut index = Index::new("id");
    index.files.insert("a.rs".into(), IndexedFile { mtime: 3, size: 4, chunks: vec![IndexedChunk { start: 0, end: 2, vector: vec![-127, 0, 64, 127] }] });
    index.save(&path).unwrap();
    assert_eq!(Index::load(&path), Some(index));
    std::fs::write(&path, "not json").unwrap();
    assert_eq!(Index::load(&path), None);
  }

  #[test]
  fn updates_incrementally_with_injected_embeddings() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("a.rs"), "fn a() {}\n").unwrap();
    std::fs::write(root.join("b.md"), (0..70).map(|i| format!("line {i}\n")).collect::<String>()).unwrap();
    std::fs::write(root.join("bin.rs"), b"\0\x01").unwrap();
    let calls = Mutex::new(Vec::<usize>::new());
    let embed = |inputs: &[String]| {
      calls.lock().unwrap().push(inputs.len());
      Ok(inputs.iter().map(|t| vec![t.len() as f32, 1.0]).collect())
    };
    let index = RwLock::new(Index::new("x"));
    let listed = |rel: &str, mtime| Listed { rel: rel.into(), mtime, size: 1 };
    let mut saves = 0;
    let mut last = 0;
    let (removed, pending) = plan(&index.read().unwrap(), &[listed("a.rs", 1), listed("b.md", 2), listed("bin.rs", 3)]);
    update(root, &index, &removed, &pending, &embed, &AtomicBool::new(false), &mut |done, _| last = done, &mut |_| saves += 1).unwrap();
    assert_eq!((last, saves), (3, 1));
    let ix = index.read().unwrap().clone();
    assert_eq!(ix.files.keys().collect::<Vec<_>>(), ["a.rs", "b.md"]);
    assert_eq!(ix.files["b.md"].chunks.iter().map(|c| (c.start, c.end)).collect::<Vec<_>>(), [(0, 60), (50, 70)]);
    assert_eq!(*calls.lock().unwrap(), [2, 1]);

    // Nothing changed: nothing embedded, nothing saved. Then one file goes.
    let (removed, pending) = plan(&index.read().unwrap(), &[listed("a.rs", 1), listed("b.md", 2)]);
    assert!(removed.is_empty() && pending.is_empty());
    let (removed, pending) = plan(&index.read().unwrap(), &[listed("b.md", 2)]);
    update(root, &index, &removed, &pending, &embed, &AtomicBool::new(false), &mut |_, _| {}, &mut |_| saves += 1).unwrap();
    assert_eq!(index.read().unwrap().files.keys().collect::<Vec<_>>(), ["b.md"]);
    assert_eq!((calls.lock().unwrap().len(), saves), (2, 2));

    // Cancelled: stops before embedding.
    let (removed, pending) = plan(&Index::new("x"), &[listed("a.rs", 1)]);
    update(root, &RwLock::new(Index::new("x")), &removed, &pending, &embed, &AtomicBool::new(true), &mut |_, _| {}, &mut |_| {}).unwrap();
    assert_eq!(calls.lock().unwrap().len(), 2);
  }

  #[test]
  fn searches_through_the_embedding_server() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("ledger.php"), "<?php\nnamespace App;\n\nclass InventoryLedgerCheck {}\n").unwrap();
    let semantic = Semantic::default();
    let mut index = Index::new("ollama|URL|bge-m3");
    index.files.insert("ledger.php".into(), IndexedFile { mtime: 0, size: 0, chunks: vec![IndexedChunk { start: 0, end: 4, vector: quantize(&normalize(&[1.0, 0.0])) }] });
    *semantic.run.lock().unwrap() = Some(Run {
      root: root.to_path_buf(),
      identity: index.identity.clone(),
      index: Arc::new(RwLock::new(index)),
      status: Arc::new(Mutex::new(Status { state: "ready", ..Default::default() })),
      cancel: Arc::new(AtomicBool::new(false)),
      building: Arc::new(AtomicBool::new(false)),
    });
    let server = TestServer::start(vec![Reply::ok(r#"{"embeddings":[[0.9,0.1]]}"#)]);
    let config = SemanticConfig { enabled: true, endpoint: Endpoint { provider: Provider::Ollama, url: server.url.clone(), api_key: String::new() }, model: "bge-m3".into(), ..Default::default() };
    let result = semantic.search(root, &http::Reqwest::new().unwrap(), &config, "ตรวจสอบสต็อก", 10).unwrap();
    assert_eq!(result.hits.len(), 1);
    assert_eq!((result.hits[0].path.as_str(), result.hits[0].line, result.hits[0].text.as_str()), ("ledger.php", 4, "class InventoryLedgerCheck {}"));
    let sent: serde_json::Value = serde_json::from_str(&server.requests()[0].body).unwrap();
    assert_eq!((sent["model"].as_str(), &sent["input"]), (Some("bge-m3"), &serde_json::json!(["ตรวจสอบสต็อก"])));

    // Off: nothing is sent.
    let off = SemanticConfig { enabled: false, ..config };
    assert!(semantic.search(root, &http::Reqwest::new().unwrap(), &off, "x", 10).is_err());
    assert_eq!(server.requests().len(), 1);
  }

  #[test]
  fn lists_files_as_find_in_files_does() {
    let Ok(rg) = crate::search::find_rg(std::env::var_os("KINGU_RG"), std::env::var_os("PATH")) else { return };
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::process::Command::new("git").arg("init").arg("-q").current_dir(root).status().unwrap();
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::create_dir_all(root.join("gen")).unwrap();
    std::fs::write(root.join(".gitignore"), "ignored.rs\n").unwrap();
    for f in ["src/a.rs", "ignored.rs", "gen/out.ts", "image.png", "notes.md"] {
      std::fs::write(root.join(f), "x").unwrap();
    }
    let mut names: Vec<String> = list_files(&rg, root, &["**/gen".into()], true).unwrap().into_iter().map(|l| l.rel).collect();
    names.sort();
    assert_eq!(names, ["notes.md", "src/a.rs"]);
    let mut all: Vec<String> = list_files(&rg, root, &[], false).unwrap().into_iter().map(|l| l.rel).collect();
    all.sort();
    assert_eq!(all, ["gen/out.ts", "ignored.rs", "notes.md", "src/a.rs"]);
  }
}
