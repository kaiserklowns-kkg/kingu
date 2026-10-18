//! API keys of AI accounts: only in the OS keychain (macOS Keychain via `keyring`, like the team
//! token), keyed by account id. Never in settings, never logged, never sent to the webview.

pub const KEYCHAIN_SERVICE: &str = "dev.kingu.ai-accounts";

pub trait SecretStore: Send + Sync {
  fn get(&self, id: &str) -> Option<String>;
  fn set(&self, id: &str, secret: &str) -> Result<(), String>;
  fn delete(&self, id: &str) -> Result<(), String>;
}

pub struct Keychain;

impl Keychain {
  fn entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, id).map_err(|e| e.to_string())
  }
}

impl SecretStore for Keychain {
  fn get(&self, id: &str) -> Option<String> {
    Self::entry(id).ok()?.get_password().ok()
  }

  fn set(&self, id: &str, secret: &str) -> Result<(), String> {
    Self::entry(id)?.set_password(secret).map_err(|e| format!("บันทึก API key ลง Keychain ไม่สำเร็จ: {e}"))
  }

  fn delete(&self, id: &str) -> Result<(), String> {
    match Self::entry(id)?.delete_credential() {
      Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
      Err(e) => Err(format!("ลบ API key จาก Keychain ไม่สำเร็จ: {e}")),
    }
  }
}

#[cfg(test)]
pub mod fake {
  use std::collections::HashMap;
  use std::sync::Mutex;

  use super::SecretStore;

  #[derive(Default)]
  pub struct FakeSecrets(pub Mutex<HashMap<String, String>>);

  impl SecretStore for FakeSecrets {
    fn get(&self, id: &str) -> Option<String> {
      self.0.lock().unwrap().get(id).cloned()
    }
    fn set(&self, id: &str, secret: &str) -> Result<(), String> {
      self.0.lock().unwrap().insert(id.into(), secret.into());
      Ok(())
    }
    fn delete(&self, id: &str) -> Result<(), String> {
      self.0.lock().unwrap().remove(id);
      Ok(())
    }
  }
}
