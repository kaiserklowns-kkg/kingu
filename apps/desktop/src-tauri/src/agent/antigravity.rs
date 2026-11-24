//! Where an Antigravity chat runs, and the managed ACP server's launch (Orca
//! `main/antigravity/antigravity-chat-route.ts`, `antigravity-acp-launch-spec.ts`,
//! `antigravity-acp-environment*.ts`, `antigravity-browser-helper.ts`, `antigravity-chat-account.ts`).
//!
//! Two programs can serve an Antigravity chat:
//! - **agy** (`agy acp`): the user's own, or Kingu's copy (managed_cli `antigravity`). It keeps its
//!   own Google sign-in in `~/.gemini`; when signed out the chat offers agy's own login in a Kingu
//!   terminal. Kingu never reads, writes or forwards the credential.
//! - **Kingu's ACP server** (`agy_acp_server`, managed_cli `antigravity-server`, pinned): its
//!   sign-in lives in `<app data>/antigravity-chat` (`GEMINI_HOME`), apart from agy's. When signed
//!   out the chat's Sign in sends ACP `authenticate` with `oauth-personal`; the server itself runs
//!   Google's OAuth with a loopback redirect, and the link it would open is captured (the `BROWSER`
//!   helper below, or the line it prints) so the chat shows it and the user opens it.
//!
//! The server's account type (antigravity_auth.rs, Orca `antigravityChatAuth`) is a personal Google
//! sign-in, a Gemini API key or Google Agent Platform (ADC); the last two run only on the server.
//!
//! The route (Orca `antigravityChatRoute`): `kingu.agent.antigravityGoogleSignIn` = `kingu`, an
//! account type other than a Google sign-in, or an agy set up for a Gemini API key, runs the server; `agy` runs agy; `auto` runs agy unless Kingu's
//! server is already in use (installed) or Kingu's copy of agy is turned off — then a signed-in agy
//! still takes new chats, anything else goes to the server.

use std::path::{Path, PathBuf};

use crate::accounts::store::AgentEnv;

/// User setting: whose Google sign-in Antigravity chats use (Orca `antigravityGoogleSignIn`).
pub const GOOGLE_SIGN_IN_SETTING: &str = "kingu.agent.antigravityGoogleSignIn";
/// The managed_cli id of the server (its folder is Orca's `agent-runtimes/antigravity`).
pub const SERVER_ID: &str = "antigravity-server";
/// The runtime id chats are saved with.
pub const RUNTIME_ID: &str = "antigravity";
/// `GEMINI_HOME` of the server's chats, under Kingu's app data (Orca `ANTIGRAVITY_CHAT_HOME_FOLDER`).
pub const CHAT_HOME_FOLDER: &str = "antigravity-chat";
/// The server's own folder inside its home (Orca `ANTIGRAVITY_ACP_HOME`).
pub const ACP_HOME: &str = "antigravity-acp";
/// What the `BROWSER` helper prints before a sign-in link (agent-host acpSignIn.ts reads it).
pub const BROWSER_MARKER: &str = "__KINGU_ANTIGRAVITY_AUTH_URL__";
use super::antigravity_auth::{self as auth, Method};

/// Set for the server (Orca `ANTIGRAVITY_ACP_ENV`): sign-in kept in files under its own home,
/// unbuffered Python output so the sign-in line arrives at once.
pub const SERVER_ENV: &[(&str, &str)] = &[("AGY_ACP_FORCE_FILE_STORAGE", "1"), ("PYTHONUNBUFFERED", "1")];

/// The variables a Google sign-in's server must not inherit (Orca `scrubAntigravityAcpEnvironment`).
pub fn scrubbed_env(keys: impl IntoIterator<Item = String>) -> Vec<String> {
  scrubbed_env_for(keys, Method::Personal)
}

/// The variables the server must not inherit: another account's key or project, a harness
/// override, a stale crash pipe — keeping only the credentials `method` reads (Orca
/// `scrubAntigravityAcpEnvironment` with the chat's saved account type).
pub fn scrubbed_env_for(keys: impl IntoIterator<Item = String>, method: Method) -> Vec<String> {
  let kept = method.kept_env();
  let mut out: Vec<String> = keys
    .into_iter()
    .filter(|k| {
      let n = if cfg!(windows) { k.to_ascii_uppercase() } else { k.clone() };
      let configured = SERVER_ENV.iter().any(|(c, _)| *c == n) || n == "BROWSER" || n == auth::AUTH_METHOD_ENV;
      n.eq_ignore_ascii_case("CHROME_CRASHPAD_PIPE_NAME")
        || (!configured && !kept.contains(&n.as_str()) && (["GEMINI_API_KEY", "ANTIGRAVITY_HARNESS_PATH", "GCLOUD_PROJECT", "CLOUDSDK_CORE_PROJECT"].contains(&n.as_str()) || n.starts_with("GOOGLE_") || n.starts_with("AGY_ACP_")))
    })
    .collect();
  for k in ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT"] {
    if !kept.contains(&k) && !out.iter().any(|o| o == k) {
      out.push(k.to_owned());
    }
  }
  out
}

/// The `BROWSER` the server's Python `webbrowser` runs: it prints the link on stderr after
/// [`BROWSER_MARKER`] instead of opening a browser, so only the user's click opens one (Orca's
/// browser helper). Python splits `BROWSER` on `:` and replaces every `%s`, so the command has
/// neither but the one argument. Windows: none; the server's own printed line is read instead.
pub fn browser_command() -> Option<String> {
  cfg!(unix).then(|| format!("/bin/sh -c 'echo \"{BROWSER_MARKER}$1\" >&2' kingu-browser %s"))
}

/// The server's arguments: on Linux `--uid=`, or it drops a root launch to `nobody` (Orca).
pub fn server_args() -> Vec<String> {
  if cfg!(target_os = "linux") { vec!["--uid=".into()] } else { Vec::new() }
}

/// Whose Google sign-in chats use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Choice {
  Auto,
  /// agy's own sign-in.
  Agy,
  /// Kingu's ACP server and its own sign-in (Orca's `orca`).
  Kingu,
}

impl Choice {
  pub fn parse(v: Option<&serde_json::Value>) -> Self {
    match v.and_then(|v| v.as_str()) {
      Some("agy") => Choice::Agy,
      Some("kingu") | Some("orca") => Choice::Kingu,
      _ => Choice::Auto,
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Route {
  /// `agy acp` (the user's own, or Kingu's copy).
  Agy,
  /// Kingu's managed ACP server.
  Server,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct RouteInput {
  pub choice: Option<Choice>,
  /// The account type is one only Kingu's server signs in with (a Gemini API key, Agent Platform).
  pub server_auth: bool,
  /// agy's settings select an API-key provider: its launch drops the key, so agy can't serve chats.
  pub agy_uses_api_key: bool,
  /// Kingu's copy of agy may run (`kingu.agent.antigravityManagedAgy`).
  pub managed_agy: bool,
  /// Kingu's server is installed (or its folder can't be read).
  pub server_in_use: bool,
  /// An agy program is found (the user's own or Kingu's copy).
  pub agy_found: bool,
  /// agy holds a Google login (its token file or Keychain item).
  pub agy_signed_in: bool,
}

/// Orca `computeAntigravityChatRoute`, without its ACP readiness probe (a login present counts as signed in).
pub fn route(i: RouteInput) -> Route {
  let choice = i.choice.unwrap_or(Choice::Auto);
  if choice == Choice::Kingu || i.server_auth || i.agy_uses_api_key {
    return Route::Server;
  }
  if !i.managed_agy || (choice != Choice::Agy && i.server_in_use) {
    return if i.agy_found && i.agy_signed_in { Route::Agy } else { Route::Server };
  }
  Route::Agy
}

/// Whether `~/.gemini/antigravity-cli/settings.json` selects an API-key provider (unreadable JSON: yes, as Orca).
pub fn agy_uses_api_key(home: &Path) -> bool {
  let Ok(text) = std::fs::read_to_string(home.join(".gemini/antigravity-cli/settings.json")) else { return false };
  match serde_json::from_str::<serde_json::Value>(&text) {
    Ok(v) => v.get("modelProvider").is_some_and(|p| !p.is_null() && p != &serde_json::Value::Bool(false) && p.as_str() != Some("")),
    Err(_) => true,
  }
}

/// Whether agy may hold a login, read without a prompt (Orca `agyCredentialPresence`): its token
/// file, or on macOS the Keychain item's attributes (never its secret).
pub fn agy_signed_in(home: &Path, keychain: &dyn Fn() -> bool) -> bool {
  home.join(".gemini/antigravity-cli/antigravity-oauth-token").is_file() || home.join(".gemini/antigravity-cli/cache/antigravity-keyring-unavailable").exists() || keychain()
}

fn keychain_item() -> bool {
  if !cfg!(target_os = "macos") {
    return false;
  }
  // Without `-w` only the attributes are read, which never asks for Keychain access.
  std::process::Command::new("/usr/bin/security")
    .args(["find-generic-password", "-s", "gemini", "-a", "antigravity"])
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null())
    .status()
    .is_ok_and(|s| s.success())
}

/// What the server's account folder must say (Orca `writeAntigravityChatSettings`): the account
/// type, and Agent Platform's project and location.
pub fn settings_projection(method: Method, gcp: Option<&(String, String)>) -> String {
  let mut v = serde_json::json!({ "auth": { "type": method.id() } });
  if let Some((project, location)) = gcp {
    v["gcp"] = serde_json::json!({ "project": project, "location": location });
  }
  v.to_string()
}

/// Creates the server's home under `data` and writes its account settings when they differ.
pub fn prepare_chat_home(data: &Path, method: Method, gcp: Option<&(String, String)>) -> Result<PathBuf, String> {
  let home = data.join(CHAT_HOME_FOLDER);
  let dir = home.join(ACP_HOME);
  std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  let path = dir.join("settings.json");
  let projection = settings_projection(method, gcp);
  if std::fs::read_to_string(&path).ok().as_deref() != Some(projection.as_str()) {
    let tmp = dir.join(".settings.json.tmp");
    std::fs::write(&tmp, &projection).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
  }
  Ok(home)
}

/// The server's launch environment here, for the account type the user chose.
pub fn server_env(data: &Path, inherited: impl IntoIterator<Item = String>) -> Result<AgentEnv, String> {
  let chat = auth::current()?;
  let (set, gcp) = auth::launch(&chat, &auth::process_env, &auth::home(), &auth::KeyStore)?;
  server_env_for(data, inherited, chat.method, set, gcp)
}

/// The server's launch environment, its home prepared under `data` for `method`: `set` are the
/// credentials Kingu supplies (antigravity_auth.rs `launch`), never unset again.
pub fn server_env_for(data: &Path, inherited: impl IntoIterator<Item = String>, method: Method, set: Vec<(String, String)>, gcp: Option<(String, String)>) -> Result<AgentEnv, String> {
  let home = prepare_chat_home(data, method, gcp.as_ref())?;
  let mut env = AgentEnv::default();
  env.set.extend(SERVER_ENV.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())));
  env.set.insert("GEMINI_HOME".into(), home.to_string_lossy().into_owned());
  if let Some(browser) = browser_command() {
    env.set.insert("BROWSER".into(), browser);
  }
  env.set.extend(set);
  env.unset = scrubbed_env_for(inherited, method).into_iter().filter(|k| !env.set.contains_key(k)).collect();
  Ok(env)
}

// ---- this machine ---------------------------------------------------------------------------

fn setting(key: &str) -> Option<serde_json::Value> {
  crate::settings::user_value(crate::system::config_dir()?, key)
}

/// Where a new Antigravity chat runs here, given whether agy is found.
pub fn current_route(agy_found: bool) -> Route {
  let home = std::env::var_os("HOME").map(PathBuf::from);
  let server_in_use = super::managed_cli::server_in_use(SERVER_ID);
  route(RouteInput {
    choice: Some(Choice::parse(setting(GOOGLE_SIGN_IN_SETTING).as_ref())),
    // An unreadable account type also goes to the server, whose launch then says what is wrong.
    server_auth: auth::current().map_or(true, |a| a.method != Method::Personal),
    agy_uses_api_key: home.as_deref().is_some_and(agy_uses_api_key),
    managed_agy: setting(super::managed_cli::AGY_SETTING) != Some(serde_json::Value::Bool(false)),
    server_in_use,
    agy_found,
    // Asked only where it decides the route, so the Keychain isn't read for nothing.
    agy_signed_in: home.as_deref().is_some_and(|h| agy_signed_in(h, &keychain_item)),
  })
}

/// Kingu's installed server, when the route runs it.
pub fn server_command() -> Option<PathBuf> {
  super::managed_cli::installed_command(SERVER_ID)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteView {
  pub route: Route,
  /// What the chat's Install puts here (Orca `installs`): the managed_cli id.
  pub installs: &'static str,
}

/// The chat pane's question: where would a new Antigravity chat run, and what does Install add.
#[tauri::command]
pub async fn antigravity_chat_route() -> Result<RouteView, String> {
  tauri::async_runtime::spawn_blocking(|| {
    let agy_found = super::runtimes::locates("antigravity");
    let route = current_route(agy_found);
    RouteView { route, installs: if route == Route::Server { SERVER_ID } else { RUNTIME_ID } }
  })
  .await
  .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_route_follows_orcas() {
    let base = RouteInput { managed_agy: true, ..RouteInput::default() };
    // Nothing installed: agy, so Install puts agy where chats already go.
    assert_eq!(route(base), Route::Agy);
    assert_eq!(route(RouteInput { choice: Some(Choice::Kingu), ..base }), Route::Server);
    assert_eq!(route(RouteInput { agy_uses_api_key: true, choice: Some(Choice::Agy), ..base }), Route::Server, "agy's launch drops the key");
    assert_eq!(route(RouteInput { server_auth: true, choice: Some(Choice::Agy), agy_found: true, agy_signed_in: true, ..base }), Route::Server, "a key or ADC chat signs in only on the server");
    // Kingu's server in use: a signed-in agy still takes new chats, else the server.
    let server = RouteInput { server_in_use: true, ..base };
    assert_eq!(route(server), Route::Server);
    assert_eq!(route(RouteInput { agy_found: true, ..server }), Route::Server);
    assert_eq!(route(RouteInput { agy_found: true, agy_signed_in: true, ..server }), Route::Agy);
    assert_eq!(route(RouteInput { choice: Some(Choice::Agy), ..server }), Route::Agy, "agy's own sign-in was chosen");
    // Kingu's agy turned off: only the user's signed-in agy.
    let off = RouteInput { managed_agy: false, ..base };
    assert_eq!(route(off), Route::Server);
    assert_eq!(route(RouteInput { agy_found: true, agy_signed_in: true, ..off }), Route::Agy);
    assert_eq!([Choice::parse(None), Choice::parse(Some(&"agy".into())), Choice::parse(Some(&"orca".into())), Choice::parse(Some(&"kingu".into()))], [Choice::Auto, Choice::Agy, Choice::Kingu, Choice::Kingu]);
  }

  #[test]
  fn agys_own_files_say_api_key_and_login() {
    let home = tempfile::tempdir().unwrap();
    let cli = home.path().join(".gemini/antigravity-cli");
    std::fs::create_dir_all(&cli).unwrap();
    assert!(!agy_uses_api_key(home.path()));
    std::fs::write(cli.join("settings.json"), r#"{"theme":"dark"}"#).unwrap();
    assert!(!agy_uses_api_key(home.path()));
    std::fs::write(cli.join("settings.json"), r#"{"modelProvider":"gemini"}"#).unwrap();
    assert!(agy_uses_api_key(home.path()));
    std::fs::write(cli.join("settings.json"), "{not json").unwrap();
    assert!(agy_uses_api_key(home.path()), "settings agy may read differently could select a provider");
    assert!(!agy_signed_in(home.path(), &|| false));
    assert!(agy_signed_in(home.path(), &|| true));
    std::fs::write(cli.join("antigravity-oauth-token"), "{}").unwrap();
    assert!(agy_signed_in(home.path(), &|| false));
  }

  #[test]
  fn the_server_gets_its_own_home_and_no_inherited_google_auth() {
    let data = tempfile::tempdir().unwrap();
    let inherited = ["PATH", "GEMINI_API_KEY", "GOOGLE_CLOUD_PROJECT", "GOOGLE_GENAI_USE_VERTEXAI", "AGY_ACP_DEBUG", "ANTIGRAVITY_HARNESS_PATH", "HOME", "AGY_ACP_FORCE_FILE_STORAGE"].map(str::to_owned);
    let env = server_env_for(data.path(), inherited, Method::Personal, vec![(auth::AUTH_METHOD_ENV.into(), "oauth-personal".into())], None).unwrap();
    let home = data.path().join(CHAT_HOME_FOLDER);
    assert_eq!(env.set["GEMINI_HOME"], home.to_string_lossy());
    assert_eq!((env.set["AGY_ACP_FORCE_FILE_STORAGE"].as_str(), env.set["PYTHONUNBUFFERED"].as_str()), ("1", "1"));
    for k in ["GEMINI_API_KEY", "GOOGLE_CLOUD_PROJECT", "GOOGLE_GENAI_USE_VERTEXAI", "AGY_ACP_DEBUG", "ANTIGRAVITY_HARNESS_PATH", "GOOGLE_API_KEY"] {
      assert!(env.unset.iter().any(|u| u == k), "{k}");
    }
    assert!(!env.unset.iter().any(|u| u == "PATH" || u == "HOME" || u == "AGY_ACP_FORCE_FILE_STORAGE"));
    assert_eq!(std::fs::read_to_string(home.join(ACP_HOME).join("settings.json")).unwrap(), r#"{"auth":{"type":"oauth-personal"}}"#);
    #[cfg(unix)]
    {
      let browser = env.set["BROWSER"].clone();
      assert!(browser.contains("%s") && !browser.contains(':') && browser.matches("%s").count() == 1, "{browser}");
      // Run as Python's webbrowser would: the link comes out on stderr after the marker, nothing opens.
      let argv: Vec<String> = shlex_split(&browser).into_iter().map(|a| a.replace("%s", "https://accounts.google.com/o/oauth2/v2/auth?x=1&y=2")).collect();
      let out = std::process::Command::new(&argv[0]).args(&argv[1..]).output().unwrap();
      assert!(out.status.success() && out.stdout.is_empty());
      assert_eq!(String::from_utf8_lossy(&out.stderr), format!("{BROWSER_MARKER}https://accounts.google.com/o/oauth2/v2/auth?x=1&y=2\n"));
    }
    // A second launch finds the settings as they should be and leaves them.
    server_env_for(data.path(), Vec::<String>::new(), Method::Personal, Vec::new(), None).unwrap();
  }

  #[test]
  fn a_key_or_adc_chat_keeps_only_its_own_credentials() {
    let data = tempfile::tempdir().unwrap();
    let inherited = ["GEMINI_API_KEY", "GOOGLE_GEMINI_BASE_URL", "GOOGLE_CLOUD_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS", "AGY_ACP_DEBUG"].map(str::to_owned);
    // A key chat: the saved key is set over the environment's and never unset again.
    let env = server_env_for(data.path(), inherited.clone(), Method::ApiKey, vec![("GEMINI_API_KEY".into(), "saved".into())], None).unwrap();
    assert_eq!(env.set["GEMINI_API_KEY"], "saved");
    assert!(!env.unset.iter().any(|k| k == "GEMINI_API_KEY" || k == "GOOGLE_GEMINI_BASE_URL"), "{:?}", env.unset);
    assert!(env.unset.iter().any(|k| k == "GOOGLE_CLOUD_PROJECT") && env.unset.iter().any(|k| k == "AGY_ACP_DEBUG"));
    let home = data.path().join(CHAT_HOME_FOLDER).join(ACP_HOME).join("settings.json");
    assert_eq!(std::fs::read_to_string(&home).unwrap(), r#"{"auth":{"type":"gemini-api-key"}}"#);
    // Agent Platform: ADC's variables pass, the key does not; its project is in the settings file.
    let env = server_env_for(data.path(), inherited, Method::AgentPlatform, vec![("GOOGLE_CLOUD_PROJECT".into(), "p1".into())], Some(("p1".into(), "global".into()))).unwrap();
    assert!(env.unset.iter().any(|k| k == "GEMINI_API_KEY"));
    assert!(!env.unset.iter().any(|k| k == "GOOGLE_APPLICATION_CREDENTIALS" || k == "GOOGLE_CLOUD_PROJECT"));
    let written: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&home).unwrap()).unwrap();
    assert_eq!(written, serde_json::json!({ "auth": { "type": "agent-platform" }, "gcp": { "project": "p1", "location": "global" } }));
  }

  /// Python's `shlex.split` for the quoting the helper uses (single quotes, plain words).
  #[cfg(unix)]
  fn shlex_split(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let (mut cur, mut quoted, mut any) = (String::new(), false, false);
    for c in s.chars() {
      match c {
        '\'' => {
          quoted = !quoted;
          any = true;
        }
        ' ' if !quoted => {
          if any {
            out.push(std::mem::take(&mut cur));
            any = false;
          }
        }
        c => {
          cur.push(c);
          any = true;
        }
      }
    }
    if any {
      out.push(cur);
    }
    out
  }
}
