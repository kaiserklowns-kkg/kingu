//! Arkai, the chat runtime that runs Kingu's own agent loop (agent host `src/arkai/`) on a model
//! the user brings: an OpenAI-compatible server (OpenAI, OpenRouter, Groq, DeepSeek, LM Studio,
//! vLLM, Ollama's `/v1`) or the Anthropic Messages API.
//!
//! - Providers: `kingu.arkai.providers` in the user settings only (a folder never points Arkai at
//!   a server): `{"openrouter": {"baseUrl": "https://openrouter.ai/api/v1", "models": ["…"]}}`,
//!   with `name`, `api` (`openai`, the default, or `anthropic`), `headers`, and models as ids or
//!   `{id, name, contextWindow, maxTokens, light}`. A provider with no models listed is asked for
//!   them (`GET {baseUrl}/models`). A local Ollama is offered without settings when it answers.
//! - API keys: in the macOS Keychain (`dev.kingu.arkai`, one item per provider id), set from
//!   Settings › Arkai; never in settings.json (an `Authorization` header there is dropped). The
//!   key goes to the agent host with the run and is never logged (`SecretKey`).
//! - Context windows: Ollama's are asked of it ([`ollama_windows`]: what a loaded model runs at,
//!   else its Modelfile's `num_ctx`, else the server's default, never more than the model takes);
//!   LM Studio's of its `/api/v0/models`. A model gets light mode only when that window is small.
//! - A chat's model is `<provider>/<model>`. A continued chat sends the conversation so far from
//!   its transcript (`history`), since the agent host keeps nothing between runs.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::Value;

use super::events::AgentEvent;
use crate::i18n::msg::ArkaiMsg;
use crate::local_ai::http::{HttpRequest, Transport};
use crate::tr;

pub const RUNTIME: &str = "arkai";
pub const SETTING: &str = "kingu.arkai.providers";
pub const KEYCHAIN_SERVICE: &str = "dev.kingu.arkai";
pub const OLLAMA: &str = "ollama";
const OLLAMA_BASE: &str = "http://127.0.0.1:11434/v1";
/// The window Ollama serves a model at when neither the model nor a loaded copy says otherwise
/// (its OpenAI-compatible API cannot ask for more); old Arkai's Chyle ran at this size, in light mode.
const OLLAMA_CONTEXT: u64 = 16_384;
/// The agent host's window for a model nobody describes (`DEFAULT_CONTEXT_WINDOW` in spec.ts).
const DEFAULT_CONTEXT: u64 = 32_768;
const MAX_PROVIDERS: usize = 32;
const MAX_MODELS: usize = 200;
const MAX_MODEL_ID: usize = 200;
const MAX_KEY: usize = 4096;
/// The transcript events a continued chat sends at most (serialized), newest kept.
const MAX_HISTORY_BYTES: usize = 2 * 1024 * 1024;
const LOCAL_TIMEOUT: Duration = Duration::from_millis(1500);
const REMOTE_TIMEOUT: Duration = Duration::from_secs(6);
/// Headers that carry keys: never taken from settings.json.
const SECRET_HEADERS: &[&str] = &["authorization", "x-api-key", "api-key", "proxy-authorization"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Api {
  Openai,
  Anthropic,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
  pub id: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub name: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub context_window: Option<u64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub max_tokens: Option<u64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub light: Option<bool>,
}

impl Model {
  fn bare(id: &str) -> Self {
    Self { id: id.to_owned(), name: None, context_window: None, max_tokens: None, light: None }
  }
}

/// A provider from the settings (or the local Ollama).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Provider {
  pub id: String,
  pub name: String,
  pub api: Api,
  pub base_url: String,
  pub headers: BTreeMap<String, String>,
  /// Empty: asked of the server (`/models`).
  pub models: Vec<Model>,
  /// Not in the settings: the local Ollama, offered when it answers.
  pub implicit: bool,
}

impl Provider {
  /// On this machine: no key needed, and a short timeout when asking for its models.
  pub fn local(&self) -> bool {
    url::Url::parse(&self.base_url).ok().and_then(|u| u.host_str().map(|h| matches!(h, "localhost" | "127.0.0.1" | "::1" | "[::1]"))).unwrap_or(false)
  }
}

fn valid_model_id(id: &str) -> bool {
  !id.trim().is_empty() && id.len() <= MAX_MODEL_ID && !id.chars().any(|c| c.is_control())
}

fn model_of(v: &Value) -> Option<Model> {
  if let Some(id) = v.as_str() {
    return valid_model_id(id).then(|| Model::bare(id));
  }
  let id = v.get("id")?.as_str().filter(|id| valid_model_id(id))?;
  let pos = |k: &str| v.get(k).and_then(Value::as_u64).filter(|n| *n > 0 && *n <= 10_000_000);
  Some(Model {
    id: id.to_owned(),
    name: v.get("name").and_then(Value::as_str).map(|s| s.chars().take(80).collect()),
    context_window: pos("contextWindow"),
    max_tokens: pos("maxTokens"),
    light: v.get("light").and_then(Value::as_bool),
  })
}

fn base_url(v: &str) -> Option<String> {
  let u = url::Url::parse(v.trim()).ok()?;
  matches!(u.scheme(), "http" | "https").then(|| v.trim().trim_end_matches('/').to_owned())
}

/// The providers out of the setting's value, then the local Ollama unless the setting names one.
/// Bad entries are skipped (and logged).
pub fn parse(value: Option<&Value>) -> Vec<Provider> {
  let mut out = Vec::new();
  for (id, v) in value.and_then(Value::as_object).into_iter().flatten().take(MAX_PROVIDERS) {
    let url = v.get("baseUrl").and_then(Value::as_str).and_then(base_url);
    let api = match v.get("api").and_then(Value::as_str) {
      None | Some("openai") => Some(Api::Openai),
      Some("anthropic") => Some(Api::Anthropic),
      Some(_) => None,
    };
    let (Some(base_url), Some(api)) = (url, api) else {
      log::warn!("{SETTING}: {id}: skipped (needs an http(s) baseUrl and api openai or anthropic)");
      continue;
    };
    if !super::runtimes::valid_id(id) {
      log::warn!("{SETTING}: {id}: skipped (ids are lowercase letters, digits and -)");
      continue;
    }
    let mut headers = BTreeMap::new();
    for (k, h) in v.get("headers").and_then(Value::as_object).into_iter().flatten() {
      let ok_name = !k.is_empty() && k.len() <= 64 && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
      match h.as_str() {
        _ if SECRET_HEADERS.contains(&k.to_ascii_lowercase().as_str()) => log::warn!("{SETTING}: {id}: header {k} skipped (keys go in the Keychain: Settings › Arkai)"),
        Some(h) if ok_name && !h.contains(['\n', '\r', '\0']) => {
          headers.insert(k.clone(), h.to_owned());
        }
        _ => log::warn!("{SETTING}: {id}: header {k} skipped"),
      }
    }
    let models: Vec<Model> = v.get("models").and_then(Value::as_array).into_iter().flatten().filter_map(model_of).take(MAX_MODELS).collect();
    let name = v.get("name").and_then(Value::as_str).filter(|n| !n.trim().is_empty()).map(|n| n.chars().take(80).collect()).unwrap_or_else(|| id.clone());
    out.push(Provider { id: id.clone(), name, api, base_url, headers, models, implicit: false });
  }
  if !out.iter().any(|p| p.id == OLLAMA) {
    out.push(Provider { id: OLLAMA.into(), name: "Ollama".into(), api: Api::Openai, base_url: OLLAMA_BASE.into(), headers: BTreeMap::new(), models: Vec::new(), implicit: true });
  }
  out
}

/// The models a server lists at `GET {baseUrl}/models` (OpenAI's shape; Ollama's `/v1` has it too).
pub fn discover(transport: &dyn Transport, p: &Provider, key: Option<&str>) -> Result<Vec<Model>, String> {
  if p.api != Api::Openai {
    return Err(tr!(ArkaiMsg::ProviderNoModels, name = p.name));
  }
  let timeout = if p.local() { LOCAL_TIMEOUT } else { REMOTE_TIMEOUT };
  let v = transport.get_json(&format!("{}/models", p.base_url), key, timeout)?;
  let mut models: Vec<Model> = v["data"]
    .as_array()
    .into_iter()
    .flatten()
    .filter_map(|m| m["id"].as_str().filter(|id| valid_model_id(id)))
    // Embedding models cannot chat.
    .filter(|id| !id.contains("embed"))
    .take(MAX_MODELS)
    .map(Model::bare)
    .collect();
  models.sort_by(|a, b| a.id.cmp(&b.id));
  let windows = if p.id == OLLAMA {
    ollama_windows(transport, p, &models)
  } else if p.local() {
    lmstudio_windows(transport, p)
  } else {
    HashMap::new()
  };
  for m in &mut models {
    m.context_window = windows.get(&m.id).copied();
  }
  Ok(models)
}

/// What `/api/show` says of a model: its Modelfile's `num_ctx` and the most it takes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct OllamaShow {
  pub num_ctx: Option<u64>,
  pub native: Option<u64>,
}

fn sane(n: u64) -> Option<u64> {
  (512..=10_000_000).contains(&n).then_some(n)
}

/// `/api/show`'s answer: `parameters` (Modelfile lines, `num_ctx 32768`) and `model_info`
/// (`<arch>.context_length`).
pub fn parse_show(v: &Value) -> OllamaShow {
  let num_ctx = v["parameters"].as_str().and_then(|params| {
    params.lines().find_map(|l| {
      let mut words = l.split_whitespace();
      if words.next() == Some("num_ctx") { words.next()?.parse::<u64>().ok() } else { None }
    })
  });
  let native = v["model_info"].as_object().and_then(|info| info.iter().find(|(k, _)| k.ends_with(".context_length")).and_then(|(_, n)| n.as_u64()));
  OllamaShow { num_ctx: num_ctx.and_then(sane), native: native.and_then(sane) }
}

/// The window Ollama runs a model at: a loaded copy's (`/api/ps`), else the Modelfile's
/// `num_ctx`, else the server's default; never more than the model takes.
pub fn ollama_window(loaded: Option<u64>, show: OllamaShow) -> u64 {
  let served = loaded.or(show.num_ctx).unwrap_or(OLLAMA_CONTEXT);
  show.native.map_or(served, |n| served.min(n))
}

/// `/api/show` answers per server and model: they only change when the model is pulled again.
fn show_cache() -> &'static Mutex<HashMap<String, OllamaShow>> {
  static CACHE: OnceLock<Mutex<HashMap<String, OllamaShow>>> = OnceLock::new();
  CACHE.get_or_init(Default::default)
}

/// Ollama's own API root (`…/v1` is its OpenAI-compatible part).
fn ollama_root(base_url: &str) -> &str {
  base_url.strip_suffix("/v1").unwrap_or(base_url)
}

/// Each model's window at this Ollama (best effort: a model it says nothing of gets the default).
pub fn ollama_windows(transport: &dyn Transport, p: &Provider, models: &[Model]) -> HashMap<String, u64> {
  let root = ollama_root(&p.base_url);
  let loaded: HashMap<String, u64> = transport
    .get_json(&format!("{root}/api/ps"), None, LOCAL_TIMEOUT)
    .ok()
    .and_then(|v| v["models"].as_array().cloned())
    .into_iter()
    .flatten()
    .filter_map(|m| Some((m["model"].as_str().or(m["name"].as_str())?.to_owned(), m["context_length"].as_u64().and_then(sane)?)))
    .collect();
  models
    .iter()
    .map(|m| {
      let key = format!("{root}|{}", m.id);
      let cached = show_cache().lock().unwrap().get(&key).copied();
      let show = cached.unwrap_or_else(|| {
        let req = HttpRequest { url: format!("{root}/api/show"), body: serde_json::json!({"model": m.id}), bearer: None, timeout: LOCAL_TIMEOUT };
        match transport.post_json(&req) {
          Ok(v) => {
            let show = parse_show(&v);
            show_cache().lock().unwrap().insert(key, show);
            show
          }
          Err(_) => OllamaShow::default(),
        }
      });
      (m.id.clone(), ollama_window(loaded.get(&m.id).copied(), show))
    })
    .collect()
}

/// LM Studio's windows (`/api/v0/models`): a loaded model's, else its maximum when that is below
/// the agent host's default. Other local servers do not answer there; that is fine.
pub fn lmstudio_windows(transport: &dyn Transport, p: &Provider) -> HashMap<String, u64> {
  let Ok(u) = url::Url::parse(&p.base_url) else { return HashMap::new() };
  let Ok(v) = transport.get_json(&format!("{}/api/v0/models", u.origin().ascii_serialization()), None, LOCAL_TIMEOUT) else { return HashMap::new() };
  v["data"]
    .as_array()
    .into_iter()
    .flatten()
    .filter_map(|m| {
      let id = m["id"].as_str()?;
      let loaded = m["loaded_context_length"].as_u64().and_then(sane);
      let max = m["max_context_length"].as_u64().and_then(sane).filter(|n| *n < DEFAULT_CONTEXT);
      Some((id.to_owned(), loaded.or(max)?))
    })
    .collect()
}

/// A provider as the chat's model picker and Settings › Arkai show it.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ProviderInfo {
  pub id: String,
  pub name: String,
  pub api: Api,
  pub base_url: String,
  pub local: bool,
  pub has_key: bool,
  pub implicit: bool,
  pub models: Vec<Model>,
  /// Why its models could not be listed.
  pub error: Option<String>,
}

/// Every provider with its models (listed or asked for); the local Ollama only when it answered.
pub fn infos(providers: &[Provider], transport: &dyn Transport, key: &dyn Fn(&str) -> Option<String>) -> Vec<ProviderInfo> {
  providers
    .iter()
    .filter_map(|p| {
      let k = key(&p.id);
      let (models, error) = if p.models.is_empty() {
        match discover(transport, p, k.as_deref()) {
          Ok(m) => (m, None),
          Err(_) if p.implicit => return None,
          Err(e) => (Vec::new(), Some(e)),
        }
      } else {
        (p.models.clone(), None)
      };
      if p.implicit && models.is_empty() {
        return None;
      }
      Some(ProviderInfo { id: p.id.clone(), name: p.name.clone(), api: p.api, base_url: p.base_url.clone(), local: p.local(), has_key: k.is_some(), implicit: p.implicit, models, error })
    })
    .collect()
}

/// The API key, serialized for the agent host and never shown by Debug.
#[derive(Clone, PartialEq, Eq, serde::Serialize)]
#[serde(transparent)]
pub struct SecretKey(pub String);

impl std::fmt::Debug for SecretKey {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str("SecretKey(…)")
  }
}

/// The provider as the agent host takes it (`src/arkai/spec.ts` `ArkaiProvider`).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireProvider {
  pub id: String,
  pub name: String,
  pub api: Api,
  pub base_url: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub api_key: Option<SecretKey>,
  pub headers: BTreeMap<String, String>,
  pub models: Vec<Model>,
}

/// Arkai's part of a run's `runtime` (`src/arkai/spec.ts` `ArkaiSpec`, next to `kind`).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Wire {
  pub provider: WireProvider,
  pub model: String,
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub history: Vec<AgentEvent>,
}

/// `provider/model` split; None without a provider part.
pub fn split_model(value: &str) -> Option<(&str, &str)> {
  let (p, m) = value.split_once('/')?;
  (super::runtimes::valid_id(p) && valid_model_id(m)).then_some((p, m))
}

/// The provider with its models (asked for when the settings list none) and key, for the host.
pub fn wire_provider(p: &Provider, transport: &dyn Transport, key: Option<String>) -> Result<WireProvider, String> {
  let models = if p.models.is_empty() { discover(transport, p, key.as_deref())? } else { p.models.clone() };
  Ok(WireProvider { id: p.id.clone(), name: p.name.clone(), api: p.api, base_url: p.base_url.clone(), api_key: key.map(SecretKey), headers: p.headers.clone(), models })
}

/// What a run on `model` (the chat's `provider/model`; anything else: the first model there is)
/// sends to the agent host.
pub fn resolve(providers: &[Provider], model: Option<&str>, transport: &dyn Transport, key: &dyn Fn(&str) -> Option<String>, history: Vec<AgentEvent>) -> Result<Wire, String> {
  if let Some((pid, mid)) = model.and_then(split_model)
    && let Some(p) = providers.iter().find(|p| p.id == pid)
  {
    let provider = wire_provider(p, transport, key(&p.id))?;
    return Ok(Wire { provider, model: mid.to_owned(), history });
  }
  if let Some((pid, _)) = model.and_then(split_model)
    && !providers.iter().any(|p| p.id == pid)
  {
    return Err(tr!(ArkaiMsg::UnknownProvider, id = pid));
  }
  // No model picked yet: the first one any provider has.
  for p in providers {
    let Ok(provider) = wire_provider(p, transport, key(&p.id)) else { continue };
    if let Some(first) = provider.models.first() {
      let model = first.id.clone();
      return Ok(Wire { provider, model, history });
    }
  }
  Err(tr!(ArkaiMsg::NoModels))
}

/// A chat's transcript events as the history a continued run needs: the main conversation's
/// messages, tool calls and results, newest kept within `MAX_HISTORY_BYTES`.
pub fn history(events: Vec<AgentEvent>) -> Vec<AgentEvent> {
  let mut kept: Vec<AgentEvent> = events
    .into_iter()
    .filter(|e| match e {
      AgentEvent::Message { parent_tool_use_id, role, .. } => parent_tool_use_id.is_none() && (role == "user" || role == "assistant"),
      AgentEvent::ToolUse { parent_tool_use_id, .. } | AgentEvent::ToolResult { parent_tool_use_id, .. } => parent_tool_use_id.is_none(),
      _ => false,
    })
    .collect();
  let mut size = 0usize;
  let mut from = kept.len();
  while from > 0 {
    let n = serde_json::to_string(&kept[from - 1]).map(|s| s.len()).unwrap_or(0);
    if size + n > MAX_HISTORY_BYTES {
      break;
    }
    size += n;
    from -= 1;
  }
  kept.drain(..from);
  kept
}

// ---------------------------------------------------------------------------------------------
// Keychain and commands

fn entry(provider: &str) -> Result<keyring::Entry, String> {
  keyring::Entry::new(KEYCHAIN_SERVICE, provider).map_err(|e| e.to_string())
}

/// The provider's API key from the Keychain, if one is stored.
pub fn stored_key(provider: &str) -> Option<String> {
  entry(provider).ok()?.get_password().ok().filter(|k| !k.is_empty())
}

pub fn valid_key(key: &str) -> bool {
  !key.is_empty() && key.len() <= MAX_KEY && !key.chars().any(|c| c.is_control() || c.is_whitespace())
}

/// The configured providers (user settings).
pub fn configured(config_dir: &std::path::Path) -> Vec<Provider> {
  parse(crate::settings::user_value(config_dir, SETTING).as_ref())
}

/// The Arkai run for a chat on `model`: provider, key and, when continuing, the transcript.
pub fn run_spec(config_dir: &std::path::Path, model: Option<&str>, history_events: Vec<AgentEvent>) -> Result<super::runtimes::Spec, String> {
  let transport = crate::local_ai::http::Reqwest::new()?;
  let wire = resolve(&configured(config_dir), model, &transport, &stored_key, history(history_events))?;
  Ok(super::runtimes::Spec { kind: RUNTIME, command: String::new(), args: Vec::new(), arkai: Some(wire) })
}

/// The provider of `model` (`provider/model`) for a mid-session switch, when it is an Arkai one.
pub fn switch_provider(config_dir: &std::path::Path, model: &str) -> Option<WireProvider> {
  let (pid, _) = split_model(model)?;
  let providers = configured(config_dir);
  let p = providers.iter().find(|p| p.id == pid)?;
  let transport = crate::local_ai::http::Reqwest::new().ok()?;
  wire_provider(p, &transport, stored_key(&p.id)).ok()
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// The chat's Arkai model picker and Settings › Arkai: each provider, its models and whether it has a key.
#[tauri::command]
pub async fn arkai_providers(app: tauri::AppHandle) -> Result<Vec<ProviderInfo>, String> {
  let config = crate::snap::config_dir(&app)?;
  blocking(move || {
    let transport = crate::local_ai::http::Reqwest::new()?;
    Ok(infos(&configured(&config), &transport, &stored_key))
  })
  .await
}

/// Stores a provider's API key in the Keychain.
#[tauri::command]
pub async fn arkai_set_key(provider: String, key: String) -> Result<(), String> {
  let key = key.trim().to_owned();
  if !super::runtimes::valid_id(&provider) {
    return Err(tr!(ArkaiMsg::UnknownProvider, id = provider));
  }
  if !valid_key(&key) {
    return Err(tr!(ArkaiMsg::BadKey));
  }
  blocking(move || {
    entry(&provider)?.set_password(&key).map_err(|e| tr!(ArkaiMsg::SaveKeyFailed, detail = e))?;
    log::info!("arkai: key stored for {provider}");
    Ok(())
  })
  .await
}

/// Removes a provider's API key from the Keychain.
#[tauri::command]
pub async fn arkai_delete_key(provider: String) -> Result<(), String> {
  if !super::runtimes::valid_id(&provider) {
    return Err(tr!(ArkaiMsg::UnknownProvider, id = provider));
  }
  blocking(move || match entry(&provider)?.delete_credential() {
    Ok(()) | Err(keyring::Error::NoEntry) => {
      log::info!("arkai: key removed for {provider}");
      Ok(())
    }
    Err(e) => Err(tr!(ArkaiMsg::DeleteKeyFailed, detail = e)),
  })
  .await
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::local_ai::http::HttpRequest;
  use serde_json::json;
  use std::sync::Mutex;

  /// Answers `/models` from a map of URL → reply; records what was asked with which key.
  #[derive(Default)]
  struct FakeTransport {
    replies: BTreeMap<String, Value>,
    /// POST replies by URL and the body's `model`.
    posts: BTreeMap<(String, String), Value>,
    asked: Mutex<Vec<(String, Option<String>)>>,
  }

  impl Transport for FakeTransport {
    fn get_json(&self, url: &str, bearer: Option<&str>, _timeout: Duration) -> Result<Value, String> {
      self.asked.lock().unwrap().push((url.to_owned(), bearer.map(str::to_owned)));
      self.replies.get(url).cloned().ok_or_else(|| "unreachable".to_owned())
    }
    fn post_json(&self, req: &HttpRequest) -> Result<Value, String> {
      self.asked.lock().unwrap().push((req.url.clone(), None));
      let model = req.body["model"].as_str().unwrap_or_default().to_owned();
      self.posts.get(&(req.url.clone(), model)).cloned().ok_or_else(|| "no".to_owned())
    }
    fn post_lines(&self, _req: &HttpRequest, _on_line: &mut dyn FnMut(&str) -> bool) -> Result<(), String> {
      Err("no".into())
    }
  }

  fn settings() -> Value {
    json!({
      "openrouter": {"name": "OpenRouter", "baseUrl": "https://openrouter.ai/api/v1/", "models": ["qwen/qwen3-coder", {"id": "deepseek/deepseek-chat", "contextWindow": 64000, "light": false}, "", 3],
        "headers": {"HTTP-Referer": "https://kingu.dev", "Authorization": "Bearer leaked", "bad\nname": "x"}},
      "claude": {"api": "anthropic", "baseUrl": "https://api.anthropic.com", "models": ["claude-sonnet-5"]},
      "lmstudio": {"baseUrl": "http://localhost:1234/v1"},
      "Bad Id": {"baseUrl": "https://x"},
      "noscheme": {"baseUrl": "file:///etc"},
      "weird-api": {"baseUrl": "https://x", "api": "gemini"}
    })
  }

  #[test]
  fn providers_come_from_the_setting_and_ollama_is_added() {
    let ps = parse(Some(&settings()));
    let ids: Vec<_> = ps.iter().map(|p| (p.id.as_str(), p.implicit)).collect();
    assert_eq!(ids, [("openrouter", false), ("claude", false), ("lmstudio", false), ("ollama", true)]);
    let or = ps.iter().find(|p| p.id == "openrouter").unwrap();
    assert_eq!(or.base_url, "https://openrouter.ai/api/v1");
    assert_eq!(or.models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["qwen/qwen3-coder", "deepseek/deepseek-chat"]);
    assert_eq!(or.models[1].context_window, Some(64000));
    assert_eq!(or.headers, BTreeMap::from([("HTTP-Referer".to_owned(), "https://kingu.dev".to_owned())]), "a key in settings.json is never sent");
    assert_eq!(ps.iter().find(|p| p.id == "claude").unwrap().api, Api::Anthropic);
    assert!(ps.iter().find(|p| p.id == "lmstudio").unwrap().local() && !or.local());
    // A configured `ollama` replaces the built-in one.
    let own = parse(Some(&json!({"ollama": {"baseUrl": "http://10.0.0.2:11434/v1"}})));
    assert_eq!(own.len(), 1);
    assert!(!own[0].implicit);
    assert_eq!(parse(None).len(), 1);
  }

  #[test]
  fn infos_list_models_and_drop_an_ollama_that_is_not_running() {
    let ps = parse(Some(&settings()));
    let mut t = FakeTransport::default();
    t.replies.insert("http://localhost:1234/v1/models".into(), json!({"data": [{"id": "qwen2.5-coder-7b"}, {"id": "nomic-embed-text"}]}));
    let key = |id: &str| (id == "openrouter").then(|| "sk-or".to_owned());
    let list = infos(&ps, &t, &key);
    let rows: Vec<_> = list.iter().map(|p| (p.id.as_str(), p.has_key, p.models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>())).collect();
    assert_eq!(
      rows,
      [("openrouter", true, vec!["qwen/qwen3-coder", "deepseek/deepseek-chat"]), ("claude", false, vec!["claude-sonnet-5"]), ("lmstudio", false, vec!["qwen2.5-coder-7b"])]
    );
    // Ollama answers: its models are offered, small and in light mode by default.
    t.replies.insert("http://127.0.0.1:11434/v1/models".into(), json!({"data": [{"id": "qwen3-coder:30b"}]}));
    let list = infos(&ps, &t, &key);
    let ollama = list.iter().find(|p| p.id == "ollama").unwrap();
    assert_eq!(ollama.models, [Model { context_window: Some(OLLAMA_CONTEXT), ..Model::bare("qwen3-coder:30b") }]);
    assert!(ollama.local && ollama.implicit);
    // A provider that does not answer shows why.
    t.replies.remove("http://localhost:1234/v1/models");
    assert_eq!(infos(&ps, &t, &key).iter().find(|p| p.id == "lmstudio").unwrap().error.as_deref(), Some("unreachable"));
  }

  #[test]
  fn ollama_windows_come_from_the_server() {
    let show = |params: &str, native: u64| json!({"parameters": params, "model_info": {"general.architecture": "qwen3", "qwen3.context_length": native}});
    assert_eq!(parse_show(&show("stop \"<|im_end|>\"\nnum_ctx 32768", 131072)), OllamaShow { num_ctx: Some(32768), native: Some(131072) });
    assert_eq!(parse_show(&json!({})), OllamaShow::default());
    // Loaded copy first, then num_ctx, then the default; never past what the model takes.
    let s = OllamaShow { num_ctx: Some(32768), native: Some(131072) };
    assert_eq!(ollama_window(Some(65536), s), 65536);
    assert_eq!(ollama_window(None, s), 32768);
    assert_eq!(ollama_window(None, OllamaShow { num_ctx: None, native: Some(131072) }), OLLAMA_CONTEXT);
    assert_eq!(ollama_window(None, OllamaShow { num_ctx: None, native: Some(8192) }), 8192);

    let mut t = FakeTransport::default();
    t.replies.insert("http://127.0.0.1:11434/v1/models".into(), json!({"data": [{"id": "wt-big"}, {"id": "wt-small"}, {"id": "wt-loaded"}, {"id": "wt-silent"}]}));
    t.replies.insert("http://127.0.0.1:11434/api/ps".into(), json!({"models": [{"model": "wt-loaded", "context_length": 40960}]}));
    let api = "http://127.0.0.1:11434/api/show".to_owned();
    t.posts.insert((api.clone(), "wt-big".into()), show("num_ctx 65536", 262144));
    t.posts.insert((api.clone(), "wt-small".into()), show("", 4096));
    t.posts.insert((api.clone(), "wt-loaded".into()), show("", 131072));
    let ps = parse(None);
    let list = infos(&ps, &t, &|_| None);
    let windows: Vec<_> = list[0].models.iter().map(|m| (m.id.as_str(), m.context_window)).collect();
    assert_eq!(windows, [("wt-big", Some(65536)), ("wt-loaded", Some(40960)), ("wt-silent", Some(OLLAMA_CONTEXT)), ("wt-small", Some(4096))]);
    // Asked once per model: the next listing is answered from the cache.
    let shows = || t.asked.lock().unwrap().iter().filter(|(u, _)| *u == api).count();
    assert_eq!(shows(), 4);
    infos(&ps, &t, &|_| None);
    assert_eq!(shows(), 5, "only the model that did not answer is asked again");

    // LM Studio: a loaded model's window, else its maximum when that is small.
    let mut t = FakeTransport::default();
    t.replies.insert("http://localhost:1234/v1/models".into(), json!({"data": [{"id": "a"}, {"id": "b"}, {"id": "c"}]}));
    t.replies.insert(
      "http://localhost:1234/api/v0/models".into(),
      json!({"data": [{"id": "a", "max_context_length": 131072, "loaded_context_length": 8192}, {"id": "b", "max_context_length": 4096}, {"id": "c", "max_context_length": 131072}]}),
    );
    let ps = parse(Some(&json!({"lmstudio": {"baseUrl": "http://localhost:1234/v1"}})));
    let list = infos(&ps, &t, &|_| None);
    let windows: Vec<_> = list[0].models.iter().map(|m| m.context_window).collect();
    assert_eq!(windows, [Some(8192), Some(4096), None]);
  }

  #[test]
  fn a_run_gets_its_provider_model_and_key() {
    let ps = parse(Some(&settings()));
    let t = FakeTransport::default();
    let key = |id: &str| (id == "openrouter").then(|| "sk-or".to_owned());
    let w = resolve(&ps, Some("openrouter/qwen/qwen3-coder"), &t, &key, Vec::new()).unwrap();
    assert_eq!((w.provider.id.as_str(), w.model.as_str()), ("openrouter", "qwen/qwen3-coder"));
    assert_eq!(w.provider.api_key, Some(SecretKey("sk-or".into())));
    assert!(!format!("{w:?}").contains("sk-or"), "the key is never in a log line");
    let spec = super::super::runtimes::Spec { kind: RUNTIME, command: String::new(), args: Vec::new(), arkai: Some(w) };
    let wire = serde_json::to_value(&spec).unwrap();
    assert_eq!(wire["kind"], "arkai");
    assert_eq!(wire["model"], "qwen/qwen3-coder");
    assert_eq!(wire["provider"]["apiKey"], "sk-or");
    assert_eq!(wire["provider"]["baseUrl"], "https://openrouter.ai/api/v1");
    assert_eq!(wire["provider"]["models"][1], json!({"id": "deepseek/deepseek-chat", "contextWindow": 64000, "light": false}));
    assert!(wire.get("command").is_none() && wire.get("args").is_none() && wire.get("history").is_none());

    // No Arkai model picked (a Claude model id, or none): the first model there is.
    let first = resolve(&ps, Some("claude-opus-5-5"), &t, &key, Vec::new()).unwrap();
    assert_eq!((first.provider.id.as_str(), first.model.as_str()), ("openrouter", "qwen/qwen3-coder"));
    let claude = resolve(&ps, Some("claude/claude-sonnet-5"), &t, &key, Vec::new()).unwrap();
    assert_eq!(claude.provider.api, Api::Anthropic);
    assert!(claude.provider.api_key.is_none());
    assert!(resolve(&ps, Some("nope/x"), &t, &key, Vec::new()).unwrap_err().contains("nope"));
    assert!(resolve(&parse(None), None, &t, &key, Vec::new()).is_err(), "no settings and no Ollama: nothing to run on");
  }

  #[test]
  fn history_keeps_the_main_conversation_newest_first_within_its_cap() {
    let msg = |role: &str, text: &str| AgentEvent::Message { role: role.into(), text: text.into(), parent_tool_use_id: None };
    let events = vec![
      AgentEvent::System { subtype: "init".into(), session_id: Some("s".into()), model: None },
      msg("user", "hi"),
      AgentEvent::Message { role: "assistant".into(), text: "sub".into(), parent_tool_use_id: Some("t".into()) },
      AgentEvent::ToolUse { id: "c".into(), name: "Read".into(), input: json!({"file_path": "a"}), parent_tool_use_id: None },
      AgentEvent::ToolResult { tool_use_id: "c".into(), content: "x".into(), is_error: false, parent_tool_use_id: None },
      msg("assistant", "ok"),
    ];
    let h = history(events);
    assert_eq!(h.len(), 4);
    assert_eq!(h[0], msg("user", "hi"));
    let big: Vec<_> = (0..40).map(|i| msg("user", &format!("{i}{}", "x".repeat(100_000)))).collect();
    let h = history(big);
    assert!(h.len() < 40 && h.len() > 10);
    assert!(matches!(&h[h.len() - 1], AgentEvent::Message { text, .. } if text.starts_with("39")));
  }

  #[test]
  fn keys_and_model_values() {
    assert!(valid_key("sk-abc_123") && !valid_key("") && !valid_key("two words") && !valid_key("a\nb") && !valid_key(&"k".repeat(5000)));
    assert_eq!(split_model("openrouter/qwen/qwen3-coder"), Some(("openrouter", "qwen/qwen3-coder")));
    assert_eq!(split_model("claude-opus-5-5"), None);
    assert_eq!(split_model("Bad/x"), None);
  }
}
