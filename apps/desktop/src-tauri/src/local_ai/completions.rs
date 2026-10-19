//! Grey-text completions in the editor (old Kingu's `kinguInlineCompletions.ts`): the webview's
//! Monaco provider sends the code around the cursor once typing pauses; this asks the local model
//! for the middle and streams the answer, dropping it (and the connection, which stops the
//! generation) as soon as a newer request or a cancel makes it stale.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use super::fim::{self, Family};
use super::http::{self, Endpoint, Provider, Transport};
use crate::i18n::msg::LocalAiMsg;
use crate::tr;

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct CompletionRequest {
  /// Increases with every request of the webview; a request is stale once a later one arrives.
  pub id: u64,
  pub endpoint: Endpoint,
  /// Empty: Ollama's first installed coding model.
  pub model: String,
  /// `kingu.completions.fimTemplate`.
  pub template: String,
  pub prefix: String,
  pub suffix: String,
  pub max_tokens: u32,
}

/// How long the installed model list is trusted before Ollama is asked again.
const MODEL_CACHE: Duration = Duration::from_secs(60);
/// More than this many characters is a model that does not stop: what came so far is used.
const MAX_REPLY_CHARS: usize = 4000;

#[derive(Default)]
pub struct Completions {
  latest: AtomicU64,
  cancelled: AtomicU64,
  /// (endpoint URL, picked model, when).
  picked: Mutex<Option<(String, Option<String>, Instant)>>,
}

/// The model to complete with when none is set: Chyle, else a coding model, never an embedder.
pub fn pick_model(installed: &[String]) -> Option<String> {
  let usable = installed.iter().filter(|m| !m.to_lowercase().contains("embed") && !m.to_lowercase().starts_with("bge-"));
  let coding: Vec<&String> = usable.filter(|m| m.to_lowercase().contains("code")).collect();
  coding.iter().find(|m| m.to_lowercase().starts_with("chyle")).or(coding.first()).map(|m| (*m).clone())
}

impl Completions {
  /// Marks `id` stale (the editor moved on); its stream stops at the next line.
  pub fn cancel(&self, id: u64) {
    self.cancelled.fetch_max(id, Ordering::SeqCst);
  }

  fn alive(&self, id: u64) -> bool {
    self.latest.load(Ordering::SeqCst) == id && self.cancelled.load(Ordering::SeqCst) < id
  }

  fn model(&self, transport: &dyn Transport, req: &CompletionRequest) -> Result<String, String> {
    let configured = req.model.trim();
    if !configured.is_empty() {
      return Ok(configured.to_string());
    }
    if req.endpoint.provider == Provider::Openai {
      return Err(tr!(LocalAiMsg::NoModel));
    }
    let mut cache = self.picked.lock().unwrap_or_else(|e| e.into_inner());
    let picked = match cache.as_ref() {
      Some((url, picked, at)) if *url == req.endpoint.url && at.elapsed() < MODEL_CACHE => picked.clone(),
      _ => {
        let picked = pick_model(&http::installed_models(transport, &req.endpoint)?);
        *cache = Some((req.endpoint.url.clone(), picked.clone(), Instant::now()));
        picked
      }
    };
    picked.ok_or_else(|| tr!(LocalAiMsg::NoModel))
  }

  /// The completion for `req`, `Ok(None)` when there is nothing to show or it went stale.
  pub fn complete(&self, transport: &dyn Transport, req: &CompletionRequest) -> Result<Option<String>, String> {
    self.latest.fetch_max(req.id, Ordering::SeqCst);
    if !self.alive(req.id) {
      return Ok(None);
    }
    let model = self.model(transport, req)?;
    let family = Family::resolve(&req.template, &model);
    let prompt = fim::build_prompt(family, &req.prefix, &req.suffix);
    let mut stops: Vec<&str> = Vec::new();
    // Mid-line, only the rest of the line is wanted; first, so OpenAI's four stops keep it.
    if fim::is_mid_line(&req.prefix) {
      stops.push("\n");
    }
    stops.extend(family.stops());
    let request = http::completion_request(&req.endpoint, &model, &prompt, &stops, req.max_tokens.clamp(1, 512))?;

    let mut text = String::new();
    let mut error = None;
    transport.post_lines(&request, &mut |line| {
      if !self.alive(req.id) {
        return false;
      }
      let Some(piece) = http::parse_stream_line(req.endpoint.provider, line) else { return true };
      text.push_str(&piece.text);
      error = piece.error;
      !piece.done && error.is_none() && text.len() < MAX_REPLY_CHARS
    })?;
    if let Some(e) = error {
      return Err(e);
    }
    if !self.alive(req.id) {
      return Ok(None);
    }
    Ok(fim::clean_completion(&text, &req.suffix, family))
  }
}

#[cfg(test)]
mod tests {
  use super::super::test_server::{Reply, TestServer};
  use super::*;
  use serde_json::json;

  fn request(server: &TestServer, provider: Provider, id: u64) -> CompletionRequest {
    CompletionRequest {
      id,
      endpoint: Endpoint { provider, url: server.url.clone(), api_key: String::new() },
      model: "qwen2.5-coder:1.5b".into(),
      template: "auto".into(),
      prefix: "fn add(a: i32, b: i32) -> i32 {\n  ".into(),
      suffix: "\n}".into(),
      max_tokens: 64,
    }
  }

  #[test]
  fn picks_a_coding_model_and_never_an_embedder() {
    let names = |xs: &[&str]| xs.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(pick_model(&names(&["bge-m3:latest", "llama3:8b", "qwen2.5-coder:7b", "chyle-1-coder:latest"])).as_deref(), Some("chyle-1-coder:latest"));
    assert_eq!(pick_model(&names(&["nomic-embed-text", "qwen2.5-coder:7b"])).as_deref(), Some("qwen2.5-coder:7b"));
    assert_eq!(pick_model(&names(&["llama3:8b", "nomic-embed-code"])), None);
  }

  #[test]
  fn streams_an_ollama_completion_and_cleans_it() {
    let body = [r#"{"response":"a + b","done":false}"#, r#"{"response":"\n<|endoftext|>","done":false}"#, r#"{"response":"","done":true}"#].join("\n");
    let server = TestServer::start(vec![Reply::ok(&body)]);
    let c = Completions::default();
    let out = c.complete(&http::Reqwest::new().unwrap(), &request(&server, Provider::Ollama, 1)).unwrap();
    assert_eq!(out.as_deref(), Some("a + b"));
    let seen = server.requests();
    assert_eq!(seen[0].path, "/api/generate");
    let sent: serde_json::Value = serde_json::from_str(&seen[0].body).unwrap();
    assert_eq!(sent["model"], "qwen2.5-coder:1.5b");
    assert_eq!(sent["prompt"], "<|fim_prefix|>fn add(a: i32, b: i32) -> i32 {\n  <|fim_suffix|>\n}<|fim_middle|>");
    // A fresh line: no newline stop.
    assert!(!sent["options"]["stop"].as_array().unwrap().contains(&json!("\n")));
  }

  #[test]
  fn streams_an_openai_completion_with_the_key() {
    let body = "data: {\"choices\":[{\"text\":\"a + b\",\"finish_reason\":null}]}\n\ndata: [DONE]\n";
    let server = TestServer::start(vec![Reply::ok(body)]);
    let mut req = request(&server, Provider::Openai, 1);
    req.endpoint.api_key = "secret".into();
    req.prefix = "let x = ".into();
    let out = Completions::default().complete(&http::Reqwest::new().unwrap(), &req).unwrap();
    assert_eq!(out.as_deref(), Some("a + b"));
    let seen = &server.requests()[0];
    assert_eq!(seen.path, "/v1/completions");
    assert_eq!(seen.header("authorization").as_deref(), Some("Bearer secret"));
    let sent: serde_json::Value = serde_json::from_str(&seen.body).unwrap();
    assert_eq!(sent["stop"][0], "\n");
  }

  #[test]
  fn picks_the_model_from_ollama_when_none_is_set() {
    let server = TestServer::start(vec![
      Reply::ok(r#"{"models":[{"name":"bge-m3:latest"},{"name":"qwen2.5-coder:1.5b"}]}"#),
      Reply::ok(r#"{"response":"1","done":true}"#),
      Reply::ok(r#"{"response":"2","done":true}"#),
    ]);
    let c = Completions::default();
    let t = http::Reqwest::new().unwrap();
    let mut req = request(&server, Provider::Ollama, 1);
    req.model = String::new();
    assert_eq!(c.complete(&t, &req).unwrap().as_deref(), Some("1"));
    req.id = 2;
    assert_eq!(c.complete(&t, &req).unwrap().as_deref(), Some("2"));
    // The list was asked for once.
    let paths: Vec<String> = server.requests().into_iter().map(|r| r.path).collect();
    assert_eq!(paths, ["/api/tags", "/api/generate", "/api/generate"]);
  }

  #[test]
  fn a_stale_or_cancelled_request_shows_nothing_and_stops_reading() {
    let server = TestServer::start(vec![Reply::ok(r#"{"response":"x","done":true}"#)]);
    let c = Completions::default();
    let t = http::Reqwest::new().unwrap();
    // A later request already arrived: this one never goes out.
    c.latest.store(5, Ordering::SeqCst);
    assert_eq!(c.complete(&t, &request(&server, Provider::Ollama, 4)).unwrap(), None);
    c.cancel(6);
    assert_eq!(c.complete(&t, &request(&server, Provider::Ollama, 6)).unwrap(), None);
    assert!(server.requests().is_empty());

    // Cancelled while streaming: the rest is not read.
    let lines: Vec<String> = (0..2000).map(|i| format!(r#"{{"response":"{i} ","done":false}}"#)).collect();
    let server = TestServer::start(vec![Reply::ok(&lines.join("\n"))]);
    let c = Completions::default();
    struct CancelAfterFirst<'a>(&'a Completions, http::Reqwest);
    impl Transport for CancelAfterFirst<'_> {
      fn get_json(&self, url: &str, bearer: Option<&str>, timeout: Duration) -> Result<serde_json::Value, String> {
        self.1.get_json(url, bearer, timeout)
      }
      fn post_json(&self, req: &http::HttpRequest) -> Result<serde_json::Value, String> {
        self.1.post_json(req)
      }
      fn post_lines(&self, req: &http::HttpRequest, on_line: &mut dyn FnMut(&str) -> bool) -> Result<(), String> {
        let mut n = 0;
        self.1.post_lines(req, &mut |line| {
          n += 1;
          if n == 2 {
            self.0.cancel(7);
          }
          on_line(line)
        })?;
        assert_eq!(n, 2);
        Ok(())
      }
    }
    let t = CancelAfterFirst(&c, http::Reqwest::new().unwrap());
    assert_eq!(c.complete(&t, &request(&server, Provider::Ollama, 7)).unwrap(), None);
  }

  #[test]
  fn reports_the_server_error() {
    let server = TestServer::start(vec![Reply::status(404, r#"{"error":"model 'nope' not found"}"#)]);
    let err = Completions::default().complete(&http::Reqwest::new().unwrap(), &request(&server, Provider::Ollama, 1)).unwrap_err();
    assert!(err.contains("404") && err.contains("model 'nope' not found"), "{err}");
    let server = TestServer::start(vec![Reply::ok(r#"{"error":"out of memory"}"#)]);
    let err = Completions::default().complete(&http::Reqwest::new().unwrap(), &request(&server, Provider::Ollama, 1)).unwrap_err();
    assert_eq!(err, "out of memory");
  }
}
