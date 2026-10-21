//! Snap secrets in the OS keychain, owned by this launcher: `kingu-ptyd snap-secret set|delete|has
//! <snap> <NAME>…` stores them (the value on stdin, never in argv), and `snap-exec --snap <id>`
//! reads the snap's declared secrets right before it execs the confined command. On macOS the
//! keychain lets the app that created an item read it without asking, so keeping both sides in
//! this binary means no prompts and the app itself never holds the value (it only learns whether
//! one is stored). Items: service `dev.kingu.snap-secrets`, account `<snap>/<NAME>`.

pub const SUBCOMMAND: &str = "snap-secret";
pub const SERVICE: &str = "dev.kingu.snap-secrets";
/// A secret value is a token or a password, not a file.
pub const MAX_VALUE: usize = 16 * 1024;

pub trait Store {
  fn get(&self, account: &str) -> Option<String>;
  fn set(&self, account: &str, value: &str) -> Result<(), String>;
  fn delete(&self, account: &str) -> Result<(), String>;
}

/// `^[a-z0-9][a-z0-9-]{0,39}$`, as snap ids are.
pub fn valid_snap(id: &str) -> bool {
  let b = id.as_bytes();
  !b.is_empty() && b.len() <= 40 && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// `^[A-Za-z_][A-Za-z0-9_]*$`, as environment variable names are.
pub fn valid_name(name: &str) -> bool {
  let b = name.as_bytes();
  !b.is_empty() && b.len() <= 128 && (b[0].is_ascii_alphabetic() || b[0] == b'_') && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
}

pub fn account(snap: &str, name: &str) -> Result<String, String> {
  if !valid_snap(snap) {
    return Err(format!("snap id \"{snap}\" ไม่ถูกต้อง"));
  }
  if !valid_name(name) {
    return Err(format!("ชื่อ secret \"{name}\" ไม่ถูกต้อง"));
  }
  Ok(format!("{snap}/{name}"))
}

/// The declared secrets of `snap` that the keychain has, as environment entries.
pub fn lookup(store: &dyn Store, snap: &str, names: &[String]) -> Vec<(String, String)> {
  names.iter().filter_map(|n| account(snap, n).ok().and_then(|a| store.get(&a)).map(|v| (n.clone(), v))).collect()
}

/// The value read from stdin: one trailing newline (from `echo` or a pipe) is not part of it.
pub fn clean_value(raw: &str) -> Result<&str, String> {
  let v = raw.strip_suffix('\n').map(|v| v.strip_suffix('\r').unwrap_or(v)).unwrap_or(raw);
  if v.is_empty() {
    return Err("ค่า secret ว่าง".into());
  }
  if v.len() > MAX_VALUE || v.contains('\0') {
    return Err("ค่า secret ยาวเกินไปหรือมีอักขระที่ใช้ไม่ได้".into());
  }
  Ok(v)
}

/// `snap-secret set <snap> <NAME>` (value on stdin), `delete <snap> <NAME>`, or
/// `has <snap> <NAME>…` (prints a JSON array of booleans). Returns what to print on stdout.
pub fn run(store: &dyn Store, args: &[String], stdin: impl FnOnce() -> std::io::Result<String>) -> Result<String, String> {
  match args {
    [op, snap, name] if op == "set" => {
      let account = account(snap, name)?;
      let raw = stdin().map_err(|e| format!("อ่านค่า secret ไม่ได้: {e}"))?;
      store.set(&account, clean_value(&raw)?)?;
      Ok(String::new())
    }
    [op, snap, name] if op == "delete" => {
      store.delete(&account(snap, name)?)?;
      Ok(String::new())
    }
    [op, snap, names @ ..] if op == "has" => {
      let has: Result<Vec<bool>, String> = names.iter().map(|n| account(snap, n).map(|a| store.get(&a).is_some())).collect();
      serde_json::to_string(&has?).map_err(|e| e.to_string())
    }
    _ => Err(format!("usage: kingu-ptyd {SUBCOMMAND} set|delete <snap> <NAME> | has <snap> <NAME>…")),
  }
}

/// The login keychain (macOS); elsewhere there is no keychain here and secrets come from the
/// environment only.
pub struct Keychain;

#[cfg(target_os = "macos")]
impl Store for Keychain {
  fn get(&self, account: &str) -> Option<String> {
    keyring::Entry::new(SERVICE, account).ok()?.get_password().ok()
  }

  fn set(&self, account: &str, value: &str) -> Result<(), String> {
    keyring::Entry::new(SERVICE, account).and_then(|e| e.set_password(value)).map_err(|e| format!("บันทึก secret ลง Keychain ไม่สำเร็จ: {e}"))
  }

  fn delete(&self, account: &str) -> Result<(), String> {
    match keyring::Entry::new(SERVICE, account).and_then(|e| e.delete_credential()) {
      Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
      Err(e) => Err(format!("ลบ secret จาก Keychain ไม่สำเร็จ: {e}")),
    }
  }
}

#[cfg(not(target_os = "macos"))]
impl Store for Keychain {
  fn get(&self, _: &str) -> Option<String> {
    None
  }
  fn set(&self, _: &str, _: &str) -> Result<(), String> {
    Err("ระบบนี้ยังไม่รองรับการเก็บ secret ของ Snap (ใช้ตัวแปร environment แทน)".into())
  }
  fn delete(&self, _: &str) -> Result<(), String> {
    Ok(())
  }
}

#[cfg(test)]
pub mod fake {
  use std::collections::HashMap;
  use std::sync::Mutex;

  #[derive(Default)]
  pub struct Fake(pub Mutex<HashMap<String, String>>);

  impl super::Store for Fake {
    fn get(&self, account: &str) -> Option<String> {
      self.0.lock().unwrap().get(account).cloned()
    }
    fn set(&self, account: &str, value: &str) -> Result<(), String> {
      self.0.lock().unwrap().insert(account.into(), value.into());
      Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
      self.0.lock().unwrap().remove(account);
      Ok(())
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn args(s: &[&str]) -> Vec<String> {
    s.iter().map(|a| a.to_string()).collect()
  }

  #[test]
  fn set_has_delete_with_the_value_on_stdin() {
    let store = fake::Fake::default();
    assert_eq!(run(&store, &args(&["set", "pg", "PGPASSWORD"]), || Ok("s3cret\n".into())).unwrap(), "");
    assert_eq!(store.get("pg/PGPASSWORD").as_deref(), Some("s3cret"));
    assert_eq!(run(&store, &args(&["has", "pg", "PGPASSWORD", "OTHER"]), || unreachable!()).unwrap(), "[true,false]");
    run(&store, &args(&["delete", "pg", "PGPASSWORD"]), || unreachable!()).unwrap();
    assert_eq!(run(&store, &args(&["has", "pg", "PGPASSWORD"]), || unreachable!()).unwrap(), "[false]");
    // Deleting what is not there is fine.
    run(&store, &args(&["delete", "pg", "PGPASSWORD"]), || unreachable!()).unwrap();
  }

  #[test]
  fn refuses_bad_ids_names_and_values() {
    let store = fake::Fake::default();
    assert!(run(&store, &args(&["set", "../x", "A"]), || Ok("v".into())).is_err());
    assert!(run(&store, &args(&["set", "pg", "A-B"]), || Ok("v".into())).is_err());
    assert!(run(&store, &args(&["set", "pg", "A"]), || Ok("\n".into())).is_err());
    assert!(run(&store, &args(&["set", "pg", "A"]), || Ok("a\0b".into())).is_err());
    assert!(run(&store, &args(&["set", "pg", "A"]), || Ok("x".repeat(MAX_VALUE + 1))).is_err());
    assert!(run(&store, &args(&["get", "pg", "A"]), || Ok("v".into())).is_err());
    assert!(store.0.lock().unwrap().is_empty());
    assert_eq!(clean_value("a b\r\n").unwrap(), "a b");
    assert_eq!(clean_value("two\n\n").unwrap(), "two\n");
  }

  #[test]
  fn lookup_returns_only_stored_declared_secrets() {
    let store = fake::Fake::default();
    store.set("pg/PGPASSWORD", "pw").unwrap();
    store.set("other/PGPASSWORD", "not-ours").unwrap();
    assert_eq!(lookup(&store, "pg", &args(&["PGPASSWORD", "MISSING", "bad-name"])), vec![("PGPASSWORD".to_string(), "pw".to_string())]);
    assert!(lookup(&store, "BAD ID", &args(&["PGPASSWORD"])).is_empty());
  }
}
