//! MCP Apps (SEP-1865, the ext-apps protocol) in the chat: a tool's `ui://` resource shown in the
//! chat as VS Code shows it (src/vs/workbench/contrib/chat/browser/widget/chatContentParts/
//! toolInvocationParts/chatMcpAppModel.ts), the page served here to a sandboxed iframe
//! (agent/McpAppFrame.svelte). An MCP server is untrusted, so:
//!
//! - The frame is `<iframe sandbox="allow-same-origin allow-pointer-lock allow-scripts
//!   allow-downloads allow-forms">` with `allow="cross-origin-isolated; autoplay; clipboard-read;
//!   clipboard-write"`, VS Code's own frame for webview content (webview/browser/pre/index.html,
//!   [`SANDBOX`], [`ALLOW`]): no popups, no top navigation, no modals.
//! - It is a cross-origin frame. `allow-same-origin` keeps the page on its own origin, which in VS
//!   Code is the webview's own host (one per server, `WebviewOriginStore`); here it is
//!   `kingu-mcp-app://<origin>/`, one random `<origin>` per chat and server ([`McpApps::origin`]),
//!   never the app's own (`tauri://localhost`). So the page cannot reach the app's DOM, storage
//!   or cookies, nor the pages of other chats or servers (other origins); a token is served only
//!   on the origin it was opened for.
//! - The CSP is VS Code's (`_injectPreamble`, [`csp`]), built from the resource's
//!   `_meta.ui.csp` domains, as a `<meta>` at the top of `<head>` like VS Code's and also as a
//!   response header with the same policy plus `sandbox …`, so it holds before the `<meta>`
//!   too and outside the frame. Kingu-only: domains naming the app's own schemes (`ipc:`,
//!   `tauri:`, `asset:`, `kingu-*`) or with characters that would end a directive are dropped.
//! - No Tauri IPC: on macOS and Linux Tauri's `__TAURI_INTERNALS__` script and its per-launch
//!   invoke key go to the main frame only (see artifacts/preview.rs), so this frame has neither and
//!   every IPC message it could post lacks the key Tauri checks first. On Windows, where WebView2
//!   puts initialization scripts in subframes too, apps are refused ([`SUPPORTED`]).
//! - The page talks to the chat only with the ext-apps JSON-RPC messages over `postMessage`
//!   (agent/mcpApp.ts answers them, checking the sender is this frame); what reaches the
//!   server goes through the agent host's run (arkai/mcpApps.ts), where an app's tool calls meet
//!   the chat's permission rules.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use serde_json::{Value, json};
use tauri::http::{Request, Response, StatusCode, header};
use tauri::{Manager, Runtime, State, UriSchemeContext};

use crate::agent::host::AgentHost;
use crate::i18n::msg::McpMsg;
use crate::tr;

pub const SCHEME: &str = "kingu-mcp-app";
/// See the module comment: no IPC isolation for subframes on Windows.
pub const SUPPORTED: bool = cfg!(any(target_os = "macos", target_os = "linux"));
/// VS Code's sandbox for webview content with scripts and forms (pre/index.html, `sandboxRules`).
pub const SANDBOX: &str = "allow-same-origin allow-pointer-lock allow-scripts allow-downloads allow-forms";
/// VS Code's `allow` for that frame (`allowRules`, Chromium; `local-network-access` left out).
pub const ALLOW: &str = "cross-origin-isolated; autoplay; clipboard-read; clipboard-write";
const MAX_HTML: usize = 8 * 1024 * 1024;
/// Apps open at once (every window); the oldest goes first beyond this.
const MAX_OPEN: usize = 64;
const MAX_DOMAINS: usize = 64;
/// Reading the resource, and an app's request (a tool call may wait for a permission prompt).
const READ_TIMEOUT: Duration = Duration::from_secs(60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// `McpUiResourceCsp`: the origins a resource asks for.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UiCsp {
  pub connect_domains: Vec<String>,
  pub resource_domains: Vec<String>,
  pub frame_domains: Vec<String>,
  pub base_uri_domains: Vec<String>,
}

/// Whether a domain entry may go into the policy: no directive or attribute breakers, nothing that
/// names the app's own schemes or hosts (Kingu-only; VS Code escapes HTML only, see `csp`).
fn domain_ok(d: &str) -> bool {
  let lower = d.to_ascii_lowercase();
  !d.is_empty()
    && d.len() <= 512
    && !d.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, ';' | ',' | '"' | '<' | '>' | '\\'))
    && !["ipc:", "tauri:", "asset:", "kingu-"].iter().any(|s| lower.starts_with(s))
    && !["ipc.localhost", "tauri.localhost", "asset.localhost", "kingu-"].iter().any(|h| lower.split("://").nth(1).is_some_and(|rest| rest.starts_with(h)))
}

/// VS Code's `cleanDomains`: the entries joined by spaces (`&` escaped for the `<meta>`).
fn clean_domains(list: &[String]) -> String {
  list.iter().filter(|d| domain_ok(d)).take(MAX_DOMAINS).map(|d| d.replace('&', "&amp;")).collect::<Vec<_>>().join(" ")
}

/// VS Code's policy for an MCP App (chatMcpAppModel.ts `_injectPreamble`), directive for directive.
pub fn csp(c: &UiCsp) -> String {
  let resource = clean_domains(&c.resource_domains);
  let connect = clean_domains(&c.connect_domains);
  let frame = clean_domains(&c.frame_domains);
  let base = clean_domains(&c.base_uri_domains);
  let or = |s: &str, d: &'static str| if s.is_empty() { d.to_owned() } else { s.to_owned() };
  let directives = [
    "default-src 'none'".to_owned(),
    format!("script-src 'self' 'unsafe-inline' 'unsafe-eval' {resource}"),
    format!("style-src 'self' 'unsafe-inline' 'unsafe-eval' {resource}"),
    format!("connect-src 'self' {connect}"),
    format!("img-src 'self' data: {resource}"),
    format!("font-src 'self' {resource}"),
    format!("media-src 'self' data: {resource}"),
    format!("frame-src {}", or(&frame, "'none'")),
    "object-src 'none'".to_owned(),
    format!("base-uri {}", or(&base, "'self'")),
  ];
  directives.iter().map(|d| d.trim_end()).collect::<Vec<_>>().join("; ")
}

/// The response header: the same policy, and the frame's sandbox so it holds outside the frame.
pub fn header_csp(policy: &str) -> String {
  format!("{}; sandbox {}", policy.replace("&amp;", "&"), SANDBOX)
}

/// VS Code's scroll hand-off (`ui/notifications/sandbox-wheel`): a wheel the page cannot scroll
/// any further scrolls the chat. VS Code also rewires `window.parent` here because its content
/// sits in a frame inside the webview; Kingu's frame is the chat's own child, so the app's
/// `parent.postMessage` already reaches the chat.
pub const WHEEL: &str = r#"<script>(function(){var b=function(e){for(var n=e.target;n;n=n.parentNode){if(!(n instanceof Element))continue;if(n===document.documentElement||n===document.body)continue;var o=getComputedStyle(n).overflowY;if(o==='hidden'||o==='visible')continue;if(e.deltaY<0&&n.scrollTop>0)return false;if(e.deltaY>0&&n.scrollTop+n.clientHeight<n.scrollHeight){if(n.scrollHeight-n.scrollTop-n.clientHeight<2)continue;return false;}}var d=document.documentElement,t=window.scrollY||d.scrollTop||document.body.scrollTop||0,h=Math.max(d.scrollHeight,document.body.scrollHeight),r=h-d.clientHeight;if(r>2){if(e.deltaY<0&&t>0)return false;if(e.deltaY>0&&t<r-2)return false;}return true;};addEventListener('wheel',function(e){if(e.defaultPrevented||!b(e))return;parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/sandbox-wheel',params:{deltaMode:e.deltaMode,deltaX:e.deltaX,deltaY:e.deltaY,deltaZ:e.deltaZ}},'*');},{passive:true});})();</script>"#;

/// VS Code's `_prependToHead`: after `<head …>`, else a `<head>` after `<html …>`, else a whole document.
pub fn prepend_to_head(html: &str, content: &str) -> String {
  let lower = html.to_ascii_lowercase();
  let tag_end = |name: &str| -> Option<usize> {
    let mut from = 0;
    while let Some(i) = lower[from..].find(&format!("<{name}")) {
      let at = from + i;
      let next = lower.as_bytes().get(at + name.len() + 1).copied();
      if matches!(next, Some(b'>') | Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r') | Some(b'/')) {
        return lower[at..].find('>').map(|j| at + j + 1);
      }
      from = at + 1;
    }
    None
  };
  if let Some(end) = tag_end("head") {
    return format!("{}\n{content}{}", &html[..end], &html[end..]);
  }
  if let Some(end) = tag_end("html") {
    return format!("{}\n<head>{content}</head>{}", &html[..end], &html[end..]);
  }
  format!("<!DOCTYPE html><html><head>{content}</head><body>{html}</body></html>")
}

/// The page as served: the policy's `<meta>` and the wheel script first in `<head>`.
pub fn page(html: &str, policy: &str) -> String {
  prepend_to_head(html, &format!(r#"<meta http-equiv="Content-Security-Policy" content="{policy}">{WHEEL}"#))
}

/// A `resources/read` answer as VS Code reads it (mcpToolCallUI.ts `readResourceContentToHtml`):
/// the first content's text (or base64 blob) and its `_meta.ui`.
pub fn resource_of(uri: &str, result: &Value) -> Result<(String, Value), String> {
  let first = result.get("contents").and_then(Value::as_array).and_then(|c| c.first()).ok_or_else(|| tr!(McpMsg::AppNoContent, uri))?;
  let html = if let Some(text) = first.get("text").and_then(Value::as_str) {
    text.to_owned()
  } else if let Some(blob) = first.get("blob").and_then(Value::as_str) {
    let bytes = base64::engine::general_purpose::STANDARD.decode(blob).map_err(|_| tr!(McpMsg::AppNoContent, uri))?;
    String::from_utf8_lossy(&bytes).into_owned()
  } else {
    return Err(tr!(McpMsg::AppNoContent, uri));
  };
  if html.len() > MAX_HTML {
    return Err(tr!(McpMsg::AppTooLarge, uri, mb = MAX_HTML / 1024 / 1024));
  }
  let meta = first.get("_meta").and_then(|m| m.get("ui")).cloned().unwrap_or(Value::Null);
  Ok((html, meta))
}

struct Entry {
  origin: String,
  page: String,
  /// The policy `page` carries in its `<meta>`, for the header too.
  policy: String,
}

#[derive(Default)]
struct Inner {
  pages: HashMap<String, Entry>,
  order: Vec<String>,
  /// chat + server → its origin (VS Code: one per server, kept in memory for agent-host apps).
  origins: HashMap<String, String>,
}

#[derive(Default)]
pub struct McpApps {
  inner: Mutex<Inner>,
}

impl McpApps {
  /// The origin (a host name) of server `server`'s apps in chat `chat`, made once per launch.
  pub fn origin(&self, chat: &str, server: &str) -> Result<String, String> {
    let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
    let key = format!("{chat}\0{server}");
    if let Some(o) = g.origins.get(&key) {
      return Ok(o.clone());
    }
    let o = kingu_cli::protocol::new_token()?[..32].to_owned();
    g.origins.insert(key, o.clone());
    Ok(o)
  }

  /// Registers an app's HTML on `origin`, served with `policy` ([`page`]); its token.
  pub fn add(&self, origin: String, html: &str, policy: String) -> Result<String, String> {
    let token = kingu_cli::protocol::new_token()?[..32].to_owned();
    let page = page(html, &policy);
    let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
    g.pages.insert(token.clone(), Entry { origin, page, policy });
    g.order.push(token.clone());
    while g.order.len() > MAX_OPEN {
      let old = g.order.remove(0);
      g.pages.remove(&old);
    }
    Ok(token)
  }

  pub fn remove(&self, token: &str) {
    let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
    g.pages.remove(token);
    g.order.retain(|t| t != token);
  }

  fn get(&self, origin: &str, token: &str) -> Option<(String, String)> {
    let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
    g.pages.get(token).filter(|e| e.origin == origin).map(|e| (e.page.clone(), e.policy.clone()))
  }
}

const fn hex32(s: &str) -> bool {
  let b = s.as_bytes();
  if b.len() != 32 {
    return false;
  }
  let mut i = 0;
  while i < 32 {
    if !b[i].is_ascii_hexdigit() {
      return false;
    }
    i += 1;
  }
  true
}

/// The response for `/<token>/index.html` on `host` (a GET); anything else is a 4xx.
pub fn respond(apps: &McpApps, method: &str, host: &str, path: &str) -> Response<Vec<u8>> {
  let status = |code: StatusCode| Response::builder().status(code).header(header::CONTENT_TYPE, "text/plain").body(Vec::new()).expect("response");
  if method != "GET" {
    return status(StatusCode::METHOD_NOT_ALLOWED);
  }
  let path = path.trim_start_matches('/');
  let (token, rest) = path.split_once('/').unwrap_or((path, ""));
  let page = (hex32(host) && hex32(token) && (rest.is_empty() || rest == "index.html")).then(|| apps.get(host, token)).flatten();
  let Some((page, policy)) = page else { return status(StatusCode::NOT_FOUND) };
  Response::builder()
    .status(StatusCode::OK)
    .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
    .header("Content-Security-Policy", header_csp(&policy))
    .header("X-Content-Type-Options", "nosniff")
    .header(header::CACHE_CONTROL, "no-store")
    .header("Referrer-Policy", "no-referrer")
    .body(page.into_bytes())
    .expect("response")
}

/// The scheme handler (lib.rs registers it).
pub fn handle<R: Runtime>(ctx: UriSchemeContext<'_, R>, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
  let apps = ctx.app_handle().state::<McpApps>();
  let host = req.uri().host().unwrap_or_default().to_owned();
  respond(&apps, req.method().as_str(), &host, req.uri().path())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedApp {
  pub url: String,
  pub token: String,
  /// The resource's `_meta.ui.csp` as given (the app hears it back in `hostCapabilities.sandbox.csp`).
  pub csp: Value,
  pub prefers_border: bool,
  /// The frame's `sandbox` and `allow`, so the webview cannot drift from what is documented here.
  pub sandbox: &'static str,
  pub allow: &'static str,
}

/// Opens the app of tool call `server`'s `uri` in chat `chat_id`: the resource read over the run's
/// connection (`resources/read`), its page registered under a new token on the chat and server's
/// origin; the frame's URL.
#[tauri::command]
pub async fn mcp_app_open(agents: State<'_, Arc<AgentHost>>, apps: State<'_, McpApps>, run_id: u32, chat_id: String, server: String, uri: String) -> Result<OpenedApp, String> {
  if !SUPPORTED {
    return Err(tr!(McpMsg::AppUnsupported));
  }
  if !uri.starts_with("ui://") || uri.len() > 2048 || uri.contains(['\0', '\n']) {
    return Err(tr!(McpMsg::AppBadResource, uri));
  }
  crate::agent::host::valid_mcp_name(&server).then_some(()).ok_or_else(|| tr!(McpMsg::InvalidName, name = server))?;
  let agents = agents.inner().clone();
  let read_uri = uri.clone();
  let read_server = server.clone();
  let result = tauri::async_runtime::spawn_blocking(move || agents.run_call(run_id, "mcp_app", json!({ "server": read_server, "method": "resources/read", "params": { "uri": read_uri } }), READ_TIMEOUT))
    .await
    .map_err(|e| e.to_string())??;
  let (html, meta) = resource_of(&uri, &result)?;
  let ui_csp: UiCsp = meta.get("csp").cloned().and_then(|c| serde_json::from_value(c).ok()).unwrap_or_default();
  let origin = apps.origin(&chat_id, &server)?;
  let token = apps.add(origin.clone(), &html, csp(&ui_csp))?;
  Ok(OpenedApp {
    url: format!("{SCHEME}://{origin}/{token}/index.html"),
    token,
    csp: meta.get("csp").cloned().unwrap_or(Value::Null),
    prefers_border: meta.get("prefersBorder").and_then(Value::as_bool).unwrap_or(false),
    sandbox: SANDBOX,
    allow: ALLOW,
  })
}

#[tauri::command]
pub fn mcp_app_close(apps: State<'_, McpApps>, token: String) {
  apps.remove(&token);
}

/// An app's request to its server through the chat's run (agent-host `mcp_app`): `resources/read`,
/// `tools/call` (the run applies the chat's permission rules) or `sampling/createMessage`.
#[tauri::command]
pub async fn agent_mcp_app_request(agents: State<'_, Arc<AgentHost>>, run_id: u32, server: String, method: String, params: Option<Value>) -> Result<Value, String> {
  if !matches!(method.as_str(), "resources/read" | "tools/call" | "sampling/createMessage") {
    return Err(format!("Method not found: {method}"));
  }
  crate::agent::host::valid_mcp_name(&server).then_some(()).ok_or_else(|| tr!(McpMsg::InvalidName, name = server))?;
  let agents = agents.inner().clone();
  let params = params.filter(Value::is_object).unwrap_or_else(|| json!({}));
  tauri::async_runtime::spawn_blocking(move || agents.run_call(run_id, "mcp_app", json!({ "server": server, "method": method, "params": params }), REQUEST_TIMEOUT)).await.map_err(|e| e.to_string())?
}

/// The tools app `app_id` registered (`App.registerTool()`), for the run's model; empty: gone.
#[tauri::command]
pub async fn agent_mcp_app_tools(agents: State<'_, Arc<AgentHost>>, run_id: u32, app_id: String, tools: Vec<Value>) -> Result<(), String> {
  let agents = agents.inner().clone();
  tauri::async_runtime::spawn_blocking(move || agents.run_call(run_id, "mcp_app_tools", json!({ "appId": app_id, "tools": tools }), crate::agent::host::REQUEST_TIMEOUT).map(|_| ()))
    .await
    .map_err(|e| e.to_string())?
}

/// The app's answer to the model's call of its tool (`mcp_app_tool_call`).
#[tauri::command]
pub async fn agent_mcp_app_tool_result(agents: State<'_, Arc<AgentHost>>, run_id: u32, request_id: String, result: Option<Value>, error: Option<String>) -> Result<(), String> {
  let agents = agents.inner().clone();
  tauri::async_runtime::spawn_blocking(move || {
    agents.run_call(run_id, "mcp_app_tool_result", json!({ "requestId": request_id, "result": result.filter(Value::is_object), "error": error }), crate::agent::host::REQUEST_TIMEOUT).map(|_| ())
  })
  .await
  .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_policy_is_vscodes() {
    let p = csp(&UiCsp::default());
    assert_eq!(
      p,
      "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self'; img-src 'self' data:; font-src 'self'; media-src 'self' data:; frame-src 'none'; object-src 'none'; base-uri 'self'"
    );
    let p = csp(&UiCsp {
      connect_domains: vec!["https://api.example.com".into(), "wss://live.example.com".into()],
      resource_domains: vec!["https://cdn.example.com".into()],
      frame_domains: vec!["https://www.youtube.com".into()],
      base_uri_domains: vec!["https://cdn.example.com".into()],
    });
    assert!(p.contains("script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.example.com;"));
    assert!(p.contains("connect-src 'self' https://api.example.com wss://live.example.com;"));
    assert!(p.contains("img-src 'self' data: https://cdn.example.com;"));
    assert!(p.contains("frame-src https://www.youtube.com;"));
    assert!(p.ends_with("base-uri https://cdn.example.com"));
  }

  #[test]
  fn domains_cannot_open_the_app_or_add_directives() {
    let p = csp(&UiCsp {
      connect_domains: vec![
        "ipc:".into(),
        "http://ipc.localhost".into(),
        "tauri://localhost".into(),
        "asset:".into(),
        "kingu-artifact:".into(),
        "http://kingu-snap-view.localhost".into(),
        "https://ok.example.com; script-src *".into(),
        "https://a.example.com,https://b".into(),
        "x\" onload=\"y".into(),
        "https://fine.example.com".into(),
      ],
      ..Default::default()
    });
    assert!(p.contains("connect-src 'self' https://fine.example.com;"));
    for bad in ["ipc", "tauri", "asset", "kingu-", "script-src *", "onload"] {
      assert!(!p.contains(bad), "{bad} in {p}");
    }
    assert_eq!(p.matches("script-src").count(), 1);
    let h = header_csp(&p);
    assert!(h.ends_with("; sandbox allow-same-origin allow-pointer-lock allow-scripts allow-downloads allow-forms"));
  }

  #[test]
  fn the_preamble_goes_first_in_head_as_vscode_puts_it() {
    let pre = "<meta x>";
    assert_eq!(prepend_to_head("<html><head lang=\"en\"><title>t</title></head></html>", pre), "<html><head lang=\"en\">\n<meta x><title>t</title></head></html>");
    assert_eq!(prepend_to_head("<!doctype html><HTML><body>b</body></HTML>", pre), "<!doctype html><HTML>\n<head><meta x></head><body>b</body></HTML>");
    assert_eq!(prepend_to_head("<p>frag</p>", pre), "<!DOCTYPE html><html><head><meta x></head><body><p>frag</p></body></html>");
    // `<header>` is not `<head>`.
    assert_eq!(prepend_to_head("<html><body><header>h</header></body></html>", pre), "<html>\n<head><meta x></head><body><header>h</header></body></html>");
    let served = page("<html><head></head><body>app</body></html>", "default-src 'none'");
    assert!(served.starts_with("<html><head>\n<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'\"><script>"));
    assert!(WHEEL.contains("ui/notifications/sandbox-wheel") && !WHEEL.contains("__TAURI"));
  }

  #[test]
  fn reads_the_resource_as_vscode_does() {
    let r = json!({ "contents": [{ "uri": "ui://a/b", "mimeType": "text/html;profile=mcp-app", "text": "<p>x</p>", "_meta": { "ui": { "csp": { "connectDomains": ["https://api.example.com"] }, "prefersBorder": true } } }] });
    let (html, meta) = resource_of("ui://a/b", &r).unwrap();
    assert_eq!(html, "<p>x</p>");
    assert_eq!(meta["prefersBorder"], true);
    let c: UiCsp = serde_json::from_value(meta["csp"].clone()).unwrap();
    assert_eq!(c.connect_domains, vec!["https://api.example.com".to_owned()]);
    let blob = json!({ "contents": [{ "uri": "ui://a/b", "blob": base64::engine::general_purpose::STANDARD.encode("<p>b</p>") }] });
    assert_eq!(resource_of("ui://a/b", &blob).unwrap().0, "<p>b</p>");
    assert!(resource_of("ui://a/b", &json!({ "contents": [] })).is_err());
    assert!(resource_of("ui://a/b", &json!({ "contents": [{ "uri": "ui://a/b" }] })).is_err());
  }

  #[test]
  fn serves_a_token_only_on_its_origin() {
    let apps = McpApps::default();
    let a = apps.origin("chat-1", "charts").unwrap();
    assert_eq!(apps.origin("chat-1", "charts").unwrap(), a);
    let other_chat = apps.origin("chat-2", "charts").unwrap();
    let other_server = apps.origin("chat-1", "maps").unwrap();
    assert!(a != other_chat && a != other_server && hex32(&a));
    // A page with a lax policy of its own before `<head>` does not change the header.
    let token = apps.add(a.clone(), "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src *\"><head></head><p>v</p>", csp(&UiCsp::default())).unwrap();
    let ok = respond(&apps, "GET", &a, &format!("/{token}/index.html"));
    assert_eq!(ok.status(), StatusCode::OK);
    let header = ok.headers().get("Content-Security-Policy").unwrap().to_str().unwrap();
    assert!(header.starts_with("default-src 'none'") && header.contains("sandbox allow-same-origin"));
    assert!(String::from_utf8_lossy(ok.body()).contains("<p>v</p>"));
    // Another chat's or server's origin, another path, another method: nothing.
    assert_eq!(respond(&apps, "GET", &other_chat, &format!("/{token}/index.html")).status(), StatusCode::NOT_FOUND);
    assert_eq!(respond(&apps, "GET", &a, &format!("/{token}/other.js")).status(), StatusCode::NOT_FOUND);
    assert_eq!(respond(&apps, "POST", &a, &format!("/{token}/index.html")).status(), StatusCode::METHOD_NOT_ALLOWED);
    apps.remove(&token);
    assert_eq!(respond(&apps, "GET", &a, &format!("/{token}/index.html")).status(), StatusCode::NOT_FOUND);
  }
}
