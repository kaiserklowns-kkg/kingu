//! Local AI in the editor, on the user's own model server (Ollama or OpenAI-compatible), as old
//! Kingu had it: grey-text completions ([`completions`]) and semantic search ([`semantic`]).
//! Both are off by default and send nothing while off; the webview passes the settings with each
//! call (the endpoint ones are user-only, so a repository cannot point them elsewhere). Requests
//! go through reqwest with the user's proxy settings ([`http::Reqwest`]).

pub mod completions;
pub mod fim;
pub mod http;
pub mod semantic;
#[cfg(test)]
mod test_server;

use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::workspace::Workspace;
use completions::{CompletionRequest, Completions};
use semantic::{SearchResult, Semantic, SemanticConfig, Status};

/// The event that carries the semantic index's [`Status`] while it changes.
const SEMANTIC_EVENT: &str = "local-ai://semantic";

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// A completion for the code around the cursor; `None` when there is none or a newer request
/// made this one stale.
#[tauri::command]
pub async fn local_ai_complete(state: State<'_, Arc<Completions>>, request: CompletionRequest) -> Result<Option<String>, String> {
  let completions = state.inner().clone();
  blocking(move || completions.complete(&http::Reqwest::new()?, &request)).await
}

/// The editor moved on: request `id` is dropped, and its stream with it.
#[tauri::command]
pub fn local_ai_cancel(state: State<'_, Arc<Completions>>, id: u64) {
  state.cancel(id);
}

fn cache_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
  app.path().app_cache_dir().map_err(|e| e.to_string())
}

fn start_index(app: &AppHandle, semantic: &Semantic, root: &std::path::Path, config: &SemanticConfig) -> Result<Status, String> {
  let rg = crate::search::find_rg(std::env::var_os("KINGU_RG"), crate::shell_env::path())?;
  let events = app.clone();
  let notify = Arc::new(move |s: Status| {
    let _ = events.emit(SEMANTIC_EVENT, s);
  });
  semantic.start(root, &cache_dir(app)?, rg, config, Arc::new(http::Reqwest::new()?), notify)
}

/// Brings the open folder's semantic index up to date in the background.
#[tauri::command]
pub fn semantic_index(app: AppHandle, ws: State<'_, Workspace>, state: State<'_, Arc<Semantic>>, config: SemanticConfig) -> Result<Status, String> {
  start_index(&app, &state, &ws.root()?, &config)
}

#[tauri::command]
pub fn semantic_status(state: State<'_, Arc<Semantic>>) -> Status {
  state.status()
}

/// The chunks of the open folder closest in meaning to `query`, best first. Starts (or
/// continues) the index first, so a first search finds what is indexed so far.
#[tauri::command]
pub async fn semantic_search(
  app: AppHandle,
  ws: State<'_, Workspace>,
  state: State<'_, Arc<Semantic>>,
  config: SemanticConfig,
  query: String,
  limit: Option<usize>,
) -> Result<SearchResult, String> {
  let root = ws.root()?;
  let semantic = state.inner().clone();
  start_index(&app, &semantic, &root, &config)?;
  blocking(move || semantic.search(&root, &http::Reqwest::new()?, &config, &query, limit.unwrap_or(semantic::DEFAULT_LIMIT))).await
}

/// Stops indexing and deletes the open folder's index (Semantic Search: Rebuild Index, or the
/// setting turned off).
#[tauri::command]
pub fn semantic_clear(app: AppHandle, ws: State<'_, Workspace>, state: State<'_, Arc<Semantic>>) -> Result<(), String> {
  let path = ws.current().map(|root| cache_dir(&app).map(|dir| semantic::index_path(&dir, &root))).transpose()?;
  state.reset(path.as_deref());
  let _ = app.emit(SEMANTIC_EVENT, state.status());
  Ok(())
}
