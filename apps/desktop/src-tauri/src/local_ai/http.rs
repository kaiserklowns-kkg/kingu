//! Requests to the local model server, Ollama or an OpenAI-compatible one (LM Studio, llama.cpp,
//! vLLM): built and parsed here as plain data, sent through a [`Transport`] — reqwest with the
//! user's proxy settings in the app, a test server in the tests.

use std::io::{BufRead, BufReader};
use std::time::Duration;

use serde_json::{Value, json};

use crate::i18n::msg::LocalAiMsg;
use crate::tr;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
  #[default]
  Ollama,
  /// `/v1/completions` and `/v1/embeddings`.
  Openai,
}

/// Where the model server is (`kingu.completions.provider` / `.endpoint` / `.apiKey`).
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct Endpoint {
  pub provider: Provider,
  pub url: String,
  pub api_key: String,
}

impl Endpoint {
  /// The server's base URL: Ollama's root, or the OpenAI-style `…/v1`.
  fn base(&self) -> Result<String, String> {
    let url = self.url.trim().trim_end_matches('/');
    let parsed = url::Url::parse(url).map_err(|_| tr!(LocalAiMsg::BadEndpoint, url = url))?;
    if !matches!(parsed.scheme(), "http" | "https") {
      return Err(tr!(LocalAiMsg::BadEndpoint, url = url));
    }
    Ok(match self.provider {
      Provider::Ollama => url.to_string(),
      Provider::Openai if url.ends_with("/v1") => url.to_string(),
      Provider::Openai => format!("{url}/v1"),
    })
  }

  fn bearer(&self) -> Option<String> {
    Some(self.api_key.trim()).filter(|k| !k.is_empty()).map(str::to_owned)
  }

  /// A key identifying what produced an embedding: an index made by another server or model is
  /// no use for this one's queries.
  pub fn identity(&self, model: &str) -> String {
    let provider = match self.provider {
      Provider::Ollama => "ollama",
      Provider::Openai => "openai",
    };
    format!("{provider}|{}|{model}", self.url.trim().trim_end_matches('/'))
  }
}

#[derive(Debug, Clone, PartialEq)]
pub struct HttpRequest {
  pub url: String,
  pub body: Value,
  pub bearer: Option<String>,
  pub timeout: Duration,
}

/// How long a completion may take: a small model answers 64 tokens in a second or two; a model
/// still loading takes longer, and the editor has moved on by then anyway.
const COMPLETION_TIMEOUT: Duration = Duration::from_secs(30);
/// An embedding batch on a laptop GPU, or the model's first load.
const EMBED_TIMEOUT: Duration = Duration::from_secs(300);
const TAGS_TIMEOUT: Duration = Duration::from_secs(3);
/// OpenAI's completions endpoint takes up to four stop sequences.
const OPENAI_MAX_STOPS: usize = 4;

/// The completion request for `prompt`, streamed so a stale one can be dropped mid-way.
pub fn completion_request(endpoint: &Endpoint, model: &str, prompt: &str, stops: &[&str], max_tokens: u32) -> Result<HttpRequest, String> {
  let base = endpoint.base()?;
  let (url, body) = match endpoint.provider {
    Provider::Ollama => (
      format!("{base}/api/generate"),
      json!({
        "model": model,
        "prompt": prompt,
        "raw": true,
        "stream": true,
        // Loading a model again takes most of a minute.
        "keep_alive": "30m",
        "options": { "num_predict": max_tokens, "temperature": 0.1, "repeat_penalty": 1.2, "stop": stops },
      }),
    ),
    Provider::Openai => (
      format!("{base}/completions"),
      json!({
        "model": model,
        "prompt": prompt,
        "max_tokens": max_tokens,
        "temperature": 0.1,
        "stream": true,
        "stop": stops.iter().take(OPENAI_MAX_STOPS).collect::<Vec<_>>(),
      }),
    ),
  };
  Ok(HttpRequest { url, body, bearer: endpoint.bearer(), timeout: COMPLETION_TIMEOUT })
}

/// The embeddings request for `inputs`.
pub fn embed_request(endpoint: &Endpoint, model: &str, inputs: &[String]) -> Result<HttpRequest, String> {
  let base = endpoint.base()?;
  let (url, body) = match endpoint.provider {
    Provider::Ollama => (format!("{base}/api/embed"), json!({ "model": model, "input": inputs, "keep_alive": "30m" })),
    Provider::Openai => (format!("{base}/embeddings"), json!({ "model": model, "input": inputs })),
  };
  Ok(HttpRequest { url, body, bearer: endpoint.bearer(), timeout: EMBED_TIMEOUT })
}

/// Ollama's installed models (`GET /api/tags`); `None` for an OpenAI-compatible server.
pub fn tags_url(endpoint: &Endpoint) -> Result<Option<String>, String> {
  Ok(match endpoint.provider {
    Provider::Ollama => Some(format!("{}/api/tags", endpoint.base()?)),
    Provider::Openai => None,
  })
}

/// One piece of a streamed completion.
#[derive(Debug, Default, PartialEq)]
pub struct StreamPiece {
  pub text: String,
  pub done: bool,
  pub error: Option<String>,
}

/// Parses one line of a streamed completion: Ollama's JSON lines, or OpenAI's server-sent events
/// (`data: {…}` … `data: [DONE]`). Blank and comment lines give nothing.
pub fn parse_stream_line(provider: Provider, line: &str) -> Option<StreamPiece> {
  let line = line.trim();
  if line.is_empty() {
    return None;
  }
  let payload = match provider {
    Provider::Ollama => line,
    Provider::Openai => {
      let data = line.strip_prefix("data:")?.trim();
      if data == "[DONE]" {
        return Some(StreamPiece { done: true, ..Default::default() });
      }
      data
    }
  };
  let v: Value = serde_json::from_str(payload).ok()?;
  if let Some(error) = error_of(&v) {
    return Some(StreamPiece { done: true, error: Some(error), ..Default::default() });
  }
  Some(match provider {
    Provider::Ollama => StreamPiece {
      text: v["response"].as_str().unwrap_or_default().to_string(),
      done: v["done"].as_bool().unwrap_or(false),
      error: None,
    },
    Provider::Openai => {
      let choice = &v["choices"][0];
      StreamPiece { text: choice["text"].as_str().unwrap_or_default().to_string(), done: !choice["finish_reason"].is_null(), error: None }
    }
  })
}

/// The server's error message: Ollama's `{"error": "…"}`, OpenAI's `{"error": {"message": "…"}}`.
pub fn error_of(v: &Value) -> Option<String> {
  match &v["error"] {
    Value::String(s) => Some(s.clone()),
    Value::Object(o) => Some(o.get("message").and_then(Value::as_str).unwrap_or("error").to_string()),
    _ => None,
  }
}

/// The vectors of an embeddings reply, in input order.
pub fn parse_embeddings(provider: Provider, v: &Value) -> Result<Vec<Vec<f32>>, String> {
  if let Some(e) = error_of(v) {
    return Err(e);
  }
  let vector = |a: &Value| a.as_array().map(|xs| xs.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect::<Vec<f32>>());
  let out: Option<Vec<Vec<f32>>> = match provider {
    Provider::Ollama => v["embeddings"].as_array().map(|rows| rows.iter().filter_map(vector).collect()),
    Provider::Openai => v["data"].as_array().map(|rows| {
      let mut rows: Vec<(u64, Vec<f32>)> = rows.iter().filter_map(|r| Some((r["index"].as_u64().unwrap_or(0), vector(&r["embedding"])?))).collect();
      rows.sort_by_key(|(i, _)| *i);
      rows.into_iter().map(|(_, e)| e).collect()
    }),
  };
  out.ok_or_else(|| tr!(LocalAiMsg::BadReply))
}

/// Ollama's model names out of `/api/tags`.
pub fn parse_tags(v: &Value) -> Vec<String> {
  v["models"].as_array().into_iter().flatten().filter_map(|m| m["name"].as_str().map(str::to_owned)).collect()
}

/// Sends requests. `post_lines` hands each line of the reply to `on_line` until it returns
/// false, which drops the connection (and with it the generation on the server).
pub trait Transport: Send + Sync {
  fn get_json(&self, url: &str, bearer: Option<&str>, timeout: Duration) -> Result<Value, String>;
  fn post_json(&self, req: &HttpRequest) -> Result<Value, String>;
  fn post_lines(&self, req: &HttpRequest, on_line: &mut dyn FnMut(&str) -> bool) -> Result<(), String>;
}

/// [`Transport`] over reqwest, with `http.proxy` and friends (`net_proxy`).
pub struct Reqwest {
  client: reqwest::blocking::Client,
}

impl Reqwest {
  pub fn new() -> Result<Self, String> {
    let client = crate::net_proxy::client_builder()?.connect_timeout(Duration::from_secs(3)).build().map_err(|e| e.to_string())?;
    Ok(Self { client })
  }

  fn send(&self, builder: reqwest::blocking::RequestBuilder, url: &str) -> Result<reqwest::blocking::Response, String> {
    let response = builder.send().map_err(|e| {
      if e.is_timeout() {
        tr!(LocalAiMsg::Timeout, url = url)
      } else {
        tr!(LocalAiMsg::Unreachable, url = url)
      }
    })?;
    let status = response.status();
    if status.is_success() {
      return Ok(response);
    }
    let text = response.text().unwrap_or_default();
    let detail = serde_json::from_str::<Value>(&text).ok().and_then(|v| error_of(&v)).unwrap_or_else(|| text.chars().take(200).collect());
    Err(tr!(LocalAiMsg::Http, status = status.as_u16(), detail = detail.trim()))
  }

  fn post(&self, req: &HttpRequest) -> reqwest::blocking::RequestBuilder {
    let builder = self.client.post(&req.url).timeout(req.timeout).json(&req.body);
    match &req.bearer {
      Some(key) => builder.bearer_auth(key),
      None => builder,
    }
  }
}

impl Transport for Reqwest {
  fn get_json(&self, url: &str, bearer: Option<&str>, timeout: Duration) -> Result<Value, String> {
    let mut builder = self.client.get(url).timeout(timeout);
    if let Some(key) = bearer {
      builder = builder.bearer_auth(key);
    }
    self.send(builder, url)?.json().map_err(|_| tr!(LocalAiMsg::BadReply))
  }

  fn post_json(&self, req: &HttpRequest) -> Result<Value, String> {
    self.send(self.post(req), &req.url)?.json().map_err(|_| tr!(LocalAiMsg::BadReply))
  }

  fn post_lines(&self, req: &HttpRequest, on_line: &mut dyn FnMut(&str) -> bool) -> Result<(), String> {
    let response = self.send(self.post(req), &req.url)?;
    for line in BufReader::new(response).lines() {
      let line = line.map_err(|_| tr!(LocalAiMsg::Timeout, url = req.url))?;
      if !on_line(&line) {
        break;
      }
    }
    Ok(())
  }
}

/// Ollama's installed models, for picking one when the setting names none.
pub fn installed_models(transport: &dyn Transport, endpoint: &Endpoint) -> Result<Vec<String>, String> {
  match tags_url(endpoint)? {
    Some(url) => Ok(parse_tags(&transport.get_json(&url, endpoint.bearer().as_deref(), TAGS_TIMEOUT)?)),
    None => Ok(Vec::new()),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn ollama() -> Endpoint {
    Endpoint { provider: Provider::Ollama, url: "http://127.0.0.1:11434/".into(), api_key: String::new() }
  }

  fn openai(url: &str) -> Endpoint {
    Endpoint { provider: Provider::Openai, url: url.into(), api_key: " sk-local ".into() }
  }

  #[test]
  fn builds_ollama_requests() {
    let req = completion_request(&ollama(), "qwen2.5-coder:1.5b", "<|fim_prefix|>a", &["<|endoftext|>", "\n"], 64).unwrap();
    assert_eq!(req.url, "http://127.0.0.1:11434/api/generate");
    assert_eq!(req.bearer, None);
    assert_eq!(req.body["raw"], true);
    assert_eq!(req.body["stream"], true);
    assert_eq!(req.body["options"]["num_predict"], 64);
    assert_eq!(req.body["options"]["stop"], json!(["<|endoftext|>", "\n"]));
    let embed = embed_request(&ollama(), "bge-m3", &["a".into(), "b".into()]).unwrap();
    assert_eq!((embed.url.as_str(), &embed.body["input"]), ("http://127.0.0.1:11434/api/embed", &json!(["a", "b"])));
    assert_eq!(tags_url(&ollama()).unwrap().as_deref(), Some("http://127.0.0.1:11434/api/tags"));
  }

  #[test]
  fn builds_openai_requests() {
    let req = completion_request(&openai("http://localhost:1234"), "m", "p", &["a", "b", "c", "d", "e"], 32).unwrap();
    assert_eq!(req.url, "http://localhost:1234/v1/completions");
    assert_eq!(req.bearer.as_deref(), Some("sk-local"));
    assert_eq!(req.body["max_tokens"], 32);
    assert_eq!(req.body["stop"], json!(["a", "b", "c", "d"]));
    assert_eq!(embed_request(&openai("http://localhost:8080/v1/"), "e5", &[]).unwrap().url, "http://localhost:8080/v1/embeddings");
    assert_eq!(tags_url(&openai("http://x")).unwrap(), None);
  }

  #[test]
  fn refuses_an_endpoint_that_is_not_http() {
    for url in ["", "file:///etc/passwd", "localhost:11434"] {
      let e = Endpoint { url: url.into(), ..ollama() };
      assert!(completion_request(&e, "m", "p", &[], 1).is_err(), "{url}");
    }
  }

  #[test]
  fn parses_streamed_completions() {
    assert_eq!(parse_stream_line(Provider::Ollama, r#"{"response":"ab","done":false}"#), Some(StreamPiece { text: "ab".into(), done: false, error: None }));
    assert!(parse_stream_line(Provider::Ollama, r#"{"response":"","done":true}"#).unwrap().done);
    assert_eq!(parse_stream_line(Provider::Ollama, r#"{"error":"model not found"}"#).unwrap().error.as_deref(), Some("model not found"));
    assert_eq!(parse_stream_line(Provider::Openai, r#"data: {"choices":[{"text":"x","finish_reason":null}]}"#).unwrap().text, "x");
    assert!(parse_stream_line(Provider::Openai, r#"data: {"choices":[{"text":"","finish_reason":"stop"}]}"#).unwrap().done);
    assert!(parse_stream_line(Provider::Openai, "data: [DONE]").unwrap().done);
    assert_eq!(parse_stream_line(Provider::Openai, ": keep-alive"), None);
    assert_eq!(parse_stream_line(Provider::Ollama, ""), None);
  }

  #[test]
  fn parses_embeddings_in_input_order() {
    assert_eq!(parse_embeddings(Provider::Ollama, &json!({ "embeddings": [[1.0, 0.0], [0.0, 1.0]] })).unwrap(), vec![vec![1.0, 0.0], vec![0.0, 1.0]]);
    let openai = json!({ "data": [{ "index": 1, "embedding": [0.0, 1.0] }, { "index": 0, "embedding": [1.0, 0.0] }] });
    assert_eq!(parse_embeddings(Provider::Openai, &openai).unwrap(), vec![vec![1.0, 0.0], vec![0.0, 1.0]]);
    assert_eq!(parse_embeddings(Provider::Openai, &json!({ "error": { "message": "no such model" } })).unwrap_err(), "no such model");
    assert!(parse_embeddings(Provider::Ollama, &json!({})).is_err());
    assert_eq!(parse_tags(&json!({ "models": [{ "name": "bge-m3:latest" }, {}] })), vec!["bge-m3:latest"]);
  }
}
