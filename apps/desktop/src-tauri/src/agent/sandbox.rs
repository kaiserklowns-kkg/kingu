//! The agent sandbox's settings for a run (VS Code's `chat.agent.sandbox.*`,
//! src/vs/platform/sandbox/common/settings.ts `AgentSandboxSettingId`), sent with every run as
//! the host's `sandbox` in the shape of VS Code's agent host config
//! (src/vs/platform/agentHost/common/sandboxConfigSchema.ts, `AgentHostSandboxKey`).
//!
//! Read from the user's own settings.json only, never from the page or the repository: a
//! repository must not be able to turn the sandbox off, widen its paths or unmask a variable for
//! the agent that works in it (VS Code marks every one of these settings `restricted`).
//!
//! The values go to the host as they are written. The host checks them
//! (agent-host `sandbox/config.ts`) and refuses the run when one does not fit, so a mistyped
//! masked variable or path is an error the user sees, not a rule that silently does not apply.
//! Off (VS Code's default, terminalChatAgentToolsConfiguration.ts `default: AgentSandboxEnabledValue.Off`)
//! sends nothing.

use serde_json::{Map, Value, json};
use std::path::Path;

pub const ENABLED: &str = "chat.agent.sandbox.enabled";
/// Setting id → the host's key (`sandboxSettingIdToAgentHostKey`).
const FLAGS: &[(&str, &str)] = &[
  ("chat.agent.sandbox.network.allowNetwork", "allowNetwork"),
  ("chat.agent.sandbox.network.allowLocalNetwork", "allowLocalNetwork"),
  ("chat.agent.sandbox.allowUnsandboxedCommands", "allowUnsandboxedCommands"),
  ("chat.agent.sandbox.fileSystem.userConfiguredPaths", "fileSystem.userConfiguredPaths"),
  // src/vs/platform/networkFilter/common/settings.ts `AgentNetworkDomainSettingId`.
  ("chat.agent.sandbox.network.allowedDomains", "allowedNetworkDomains"),
  ("chat.agent.sandbox.network.deniedDomains", "deniedNetworkDomains"),
];
const MASKED: &str = "chat.agent.sandbox.credentials.envVars";

/// The host's `sandbox` from the settings `get` reads; `None` when the sandbox is off.
pub fn from_values(get: impl Fn(&str) -> Option<Value>) -> Option<Value> {
  let enabled = get(ENABLED)?;
  // VS Code's `off` | `on` (and the older boolean). Anything else goes to the host, which refuses it.
  if enabled.is_null() || enabled == json!("off") || enabled == json!(false) {
    return None;
  }
  let mut out = Map::new();
  out.insert("enabled".into(), enabled);
  for (id, key) in FLAGS {
    if let Some(v) = get(id).filter(|v| !v.is_null()) {
      out.insert((*key).into(), v);
    }
  }
  // VS Code's `credentials: { envVars }` (`buildSandboxConfigForSdk`); null is "none masked".
  if let Some(v) = get(MASKED).filter(|v| !v.is_null()) {
    out.insert("credentials".into(), json!({ "envVars": v }));
  }
  Some(Value::Object(out))
}

/// `from_values` over the user's settings.json in `config`. A file that is there but cannot be
/// read or parsed is an error that stops the run: it may be the one that turns the sandbox on, so
/// it must not read as "off".
pub fn from_settings(config: &Path) -> Result<Option<Value>, String> {
  let path = crate::settings::user_path(config);
  let Some(text) = crate::settings::read(&path)? else { return Ok(None) };
  // An empty file is VS Code's "no settings".
  if text.trim().is_empty() {
    return Ok(None);
  }
  let parsed: Value = serde_json::from_str(&crate::settings::strip_jsonc(&text)).map_err(|e| format!("{}: {e}", path.display()))?;
  Ok(from_values(|key| parsed.get(key).cloned()))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn from(settings: Value) -> Option<Value> {
    from_values(|key| settings.get(key).cloned())
  }

  #[test]
  fn off_by_default_and_when_turned_off() {
    assert_eq!(from(json!({})), None);
    assert_eq!(from(json!({ "chat.agent.sandbox.enabled": "off", "chat.agent.sandbox.credentials.envVars": { "GH_TOKEN": { "injectHosts": [] } } })), None);
    assert_eq!(from(json!({ "chat.agent.sandbox.enabled": false })), None);
    assert_eq!(from(json!({ "chat.agent.sandbox.enabled": null })), None);
  }

  #[test]
  fn on_sends_the_settings_under_vscodes_agent_host_keys() {
    assert_eq!(from(json!({ "chat.agent.sandbox.enabled": "on" })), Some(json!({ "enabled": "on" })));
    let all = from(json!({
      "chat.agent.sandbox.enabled": "on",
      "chat.agent.sandbox.network.allowNetwork": false,
      "chat.agent.sandbox.network.allowLocalNetwork": true,
      "chat.agent.sandbox.allowUnsandboxedCommands": false,
      "chat.agent.sandbox.credentials.envVars": { "GH_TOKEN": { "injectHosts": ["api.github.com"] } },
      "chat.agent.sandbox.fileSystem.userConfiguredPaths": { "readwritePaths": ["~/out"], "deniedPaths": ["~/.ssh"] },
      "chat.agent.sandbox.network.allowedDomains": ["registry.npmjs.org", "*.github.com"],
      "chat.agent.sandbox.network.deniedDomains": ["gist.github.com"],
    }));
    assert_eq!(
      all,
      Some(json!({
        "enabled": "on",
        "allowNetwork": false,
        "allowLocalNetwork": true,
        "allowUnsandboxedCommands": false,
        "credentials": { "envVars": { "GH_TOKEN": { "injectHosts": ["api.github.com"] } } },
        "fileSystem.userConfiguredPaths": { "readwritePaths": ["~/out"], "deniedPaths": ["~/.ssh"] },
        "allowedNetworkDomains": ["registry.npmjs.org", "*.github.com"],
        "deniedNetworkDomains": ["gist.github.com"],
      }))
    );
    // VS Code's default for the masked variables is null: nothing is sent for it.
    assert_eq!(from(json!({ "chat.agent.sandbox.enabled": "on", "chat.agent.sandbox.credentials.envVars": null })), Some(json!({ "enabled": "on" })));
  }

  #[test]
  fn a_value_that_does_not_fit_is_sent_for_the_host_to_refuse() {
    // Never dropped here: "on, minus the masked variable that was mistyped" must not run.
    assert_eq!(from(json!({ "chat.agent.sandbox.enabled": "yes" })), Some(json!({ "enabled": "yes" })));
    assert_eq!(
      from(json!({ "chat.agent.sandbox.enabled": "on", "chat.agent.sandbox.credentials.envVars": ["GH_TOKEN"], "chat.agent.sandbox.network.allowNetwork": "no" })),
      Some(json!({ "enabled": "on", "allowNetwork": "no", "credentials": { "envVars": ["GH_TOKEN"] } }))
    );
  }

  #[test]
  fn read_from_the_users_settings_file() {
    let config = tempfile::tempdir().unwrap();
    assert_eq!(from_settings(config.path()), Ok(None));
    let path = crate::settings::user_path(config.path());
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
      &path,
      r#"{ // jsonc
        "chat.agent.sandbox.enabled": "on", "chat.agent.sandbox.network.allowNetwork": false }"#,
    )
    .unwrap();
    assert_eq!(from_settings(config.path()), Ok(Some(json!({ "enabled": "on", "allowNetwork": false }))));
    std::fs::write(&path, "").unwrap();
    assert_eq!(from_settings(config.path()), Ok(None));
  }

  #[test]
  fn a_settings_file_that_does_not_parse_stops_the_run() {
    // It may be the file that turns the sandbox on: never "off".
    let config = tempfile::tempdir().unwrap();
    let path = crate::settings::user_path(config.path());
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, r#"{ "chat.agent.sandbox.enabled": "on", "#).unwrap();
    assert!(from_settings(config.path()).is_err());
    std::fs::write(&path, [0xff, 0xfe]).unwrap();
    assert!(from_settings(config.path()).is_err());
  }
}
