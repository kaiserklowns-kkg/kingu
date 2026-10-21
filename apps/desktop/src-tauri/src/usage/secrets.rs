//! Credentials a user pastes for a usage provider (Orca keeps these in settings, encrypted at
//! rest): only in the macOS Keychain, service `dev.kingu.usage-providers`, one item per id. The
//! webview can set or clear one and ask which are set; it never reads a value back, and nothing
//! here logs one. Each is sent only to its own provider's endpoint.

use crate::accounts::secrets::SecretStore;
use crate::i18n::msg::AccountsMsg;
use crate::tr;

pub const SERVICE: &str = "dev.kingu.usage-providers";

/// The ids a user can set, and the provider each belongs to.
pub const IDS: &[(&str, &str)] = &[
  ("opencode.apiKey", "opencode"),
  ("opencode.cookie", "opencode"),
  ("minimax.apiKey", "minimax"),
  ("minimax.cookie", "minimax"),
  ("zcode.apiKey", "zcode"),
];

pub fn known(id: &str) -> bool {
  IDS.iter().any(|(k, _)| *k == id)
}

pub struct UsageKeychain;

impl UsageKeychain {
  fn entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, id).map_err(|e| e.to_string())
  }
}

impl SecretStore for UsageKeychain {
  fn get(&self, id: &str) -> Option<String> {
    Self::entry(id).ok()?.get_password().ok().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty())
  }

  fn set(&self, id: &str, secret: &str) -> Result<(), String> {
    Self::entry(id)?.set_password(secret).map_err(|e| tr!(AccountsMsg::SaveKeyFailed, detail = e))
  }

  fn delete(&self, id: &str) -> Result<(), String> {
    match Self::entry(id)?.delete_credential() {
      Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
      Err(e) => Err(tr!(AccountsMsg::DeleteKeyFailed, detail = e)),
    }
  }
}

/// A trimmed, single-line value, or None (empty clears the item).
pub fn clean(value: &str) -> Option<String> {
  let v = value.trim();
  (!v.is_empty() && !v.contains(['\r', '\n'])).then(|| v.to_owned())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn ids_and_values() {
    assert!(known("minimax.cookie") && !known("claude.token"));
    assert_eq!(clean("  sk-1 "), Some("sk-1".into()));
    assert_eq!(clean(" "), None);
    assert_eq!(clean("a\nb"), None);
  }
}
