//! Thai and English text that Rust shows or returns to the webview (command errors, native
//! dialogs, notifications), in the UI language the frontend resolved from `kingu.uiLanguage`.
//!
//! - Catalogs: one file per area in [`msg`], each a `messages!` table with both languages on one
//!   line per message. A message id is an enum variant (`GitMsg::AuthFailed`), so a typo or a
//!   removed message is a compile error, and an unused one is a dead-code warning.
//! - Use: `tr!(GitMsg::Timeout, op, secs = timeout.as_secs())` → `String`. `{name}` in the text is
//!   filled from the named params; `{count|one|other}` picks `one` when the value is 1 (`#` is the
//!   value), as in the frontend's `t()`. Raw OS/git/gh output goes in as a `{detail}` param.
//! - Locale: [`set_locale`] (command `app_set_locale`, called by the frontend on start and when
//!   the resolved `kingu.uiLanguage` changes); before that, the OS language (Thai if it starts
//!   with `th`, else English). Tests get English unless they wrap code in [`with_locale`].
//! - Tests below check that both languages exist, are non-empty, use the same `{params}`, carry no
//!   ครับ/ค่ะ, that every `tr!` call passes exactly the params its message uses, and that the
//!   error prefixes the frontend matches (`src/lib/i18n/rustErrors.ts`) are these catalogs' text.
//!
//! Log lines (`log::*`) stay English and do not go through here.

pub mod msg;

use std::cell::Cell;
use std::fmt::Display;
use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Locale {
  En,
  Th,
}

impl Locale {
  /// `th` / `en` as given; anything else (`auto`) follows `os` — Thai if it starts with `th`.
  pub fn resolve(setting: &str, os: Option<&str>) -> Locale {
    match setting {
      "th" => Locale::Th,
      "en" => Locale::En,
      _ if os.is_some_and(|l| l.trim().to_lowercase().starts_with("th")) => Locale::Th,
      _ => Locale::En,
    }
  }
}

/// A catalog message: an enum variant made by `messages!`.
pub trait Message: Copy {
  fn text(self, locale: Locale) -> &'static str;
  /// `Enum::Variant`, for the catalog tests.
  #[cfg(test)]
  fn id(self) -> &'static str;
}

const UNSET: u8 = 0;
const EN: u8 = 1;
const TH: u8 = 2;
static LOCALE: AtomicU8 = AtomicU8::new(UNSET);

thread_local! {
  static OVERRIDE: Cell<Option<Locale>> = const { Cell::new(None) };
}

/// The locale `tr!` uses on this thread.
pub fn current() -> Locale {
  if let Some(l) = OVERRIDE.with(Cell::get) {
    return l;
  }
  match LOCALE.load(Ordering::Relaxed) {
    EN => Locale::En,
    TH => Locale::Th,
    _ => {
      let l = default_locale();
      // Only fills the unset slot: a set_locale that raced us wins.
      let _ = LOCALE.compare_exchange(UNSET, encode(l), Ordering::Relaxed, Ordering::Relaxed);
      l
    }
  }
}

pub fn set_locale(l: Locale) {
  LOCALE.store(encode(l), Ordering::Relaxed);
}

fn encode(l: Locale) -> u8 {
  match l {
    Locale::En => EN,
    Locale::Th => TH,
  }
}

/// Runs `f` with `tr!` in `l` on this thread only (tests; no race with other threads).
#[cfg(test)]
pub fn with_locale<R>(l: Locale, f: impl FnOnce() -> R) -> R {
  struct Reset(Option<Locale>);
  impl Drop for Reset {
    fn drop(&mut self) {
      OVERRIDE.with(|o| o.set(self.0));
    }
  }
  let _reset = Reset(OVERRIDE.with(|o| o.replace(Some(l))));
  f()
}

#[cfg(test)]
fn default_locale() -> Locale {
  Locale::En
}

#[cfg(not(test))]
fn default_locale() -> Locale {
  Locale::resolve("auto", os_language().as_deref())
}

/// The OS UI language: macOS's preferred languages (what the WebView's `navigator.language`
/// follows), else `LC_ALL` / `LC_MESSAGES` / `LANG`.
#[cfg(not(test))]
fn os_language() -> Option<String> {
  #[cfg(target_os = "macos")]
  {
    let first = objc2_foundation::NSLocale::preferredLanguages().firstObject().map(|s| s.to_string());
    if first.is_some() {
      return first;
    }
  }
  ["LC_ALL", "LC_MESSAGES", "LANG"]
    .into_iter()
    .filter_map(|k| std::env::var(k).ok())
    .find(|v| !v.is_empty() && v != "C" && v != "POSIX")
}

/// `app_set_locale`: the frontend's resolved UI language (`th` / `en`; `auto` follows the OS).
#[tauri::command]
pub fn app_set_locale(locale: String) {
  #[cfg(not(test))]
  let os = if locale == "th" || locale == "en" { None } else { os_language() };
  #[cfg(test)]
  let os: Option<String> = None;
  set_locale(Locale::resolve(&locale, os.as_deref()));
}

/// Fills `template`'s `{name}` and `{name|one|other}` placeholders. A placeholder without a param
/// is left as is so the gap shows; `{` not followed by `name}` / `name|` is plain text.
pub fn render(template: &str, params: &[(&str, &dyn Display)]) -> String {
  let mut out = String::with_capacity(template.len() + 16);
  let mut rest = template;
  while let Some(open) = rest.find('{') {
    out.push_str(&rest[..open]);
    let after = &rest[open + 1..];
    match placeholder(after) {
      Some((name, forms, len)) => {
        match params.iter().find(|(n, _)| *n == name) {
          Some((_, value)) => {
            let value = value.to_string();
            match forms {
              None => out.push_str(&value),
              Some(forms) => {
                let mut it = forms.split('|');
                let one = it.next().unwrap_or("");
                let other = it.next().unwrap_or(one);
                out.push_str(&(if value == "1" { one } else { other }).replace('#', &value));
              }
            }
          }
          None => out.push_str(&rest[open..open + 1 + len]),
        }
        rest = &after[len..];
      }
      None => {
        out.push('{');
        rest = after;
      }
    }
  }
  out.push_str(rest);
  out
}

/// After a `{`: `(name, plural forms, length through the closing })` for `name}` / `name|…}`.
fn placeholder(s: &str) -> Option<(&str, Option<&str>, usize)> {
  let end = s.find('}')?;
  let inner = &s[..end];
  let (name, forms) = match inner.split_once('|') {
    Some((n, f)) => (n, Some(f)),
    None => (inner, None),
  };
  let mut chars = name.chars();
  let ok = chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
  ok.then_some((name, forms, end + 1))
}

/// Param names a message uses, in order of first use.
#[cfg(test)]
pub fn param_names(template: &str) -> Vec<&str> {
  let mut names = Vec::new();
  let mut rest = template;
  while let Some(open) = rest.find('{') {
    let after = &rest[open + 1..];
    match placeholder(after) {
      Some((name, _, len)) => {
        if !names.contains(&name) {
          names.push(name);
        }
        rest = &after[len..];
      }
      None => rest = after,
    }
  }
  names
}

/// `tr!(Area::Message, name = value, other, …)`: the message in the current locale with its
/// `{params}` filled (`other` alone means `other = other`). Any `Display` value works.
#[macro_export]
macro_rules! tr {
  (@value $name:ident = $value:expr) => { $value };
  (@value $name:ident) => { $name };
  ($msg:expr $(, $name:ident $(= $value:expr)?)* $(,)?) => {
    $crate::i18n::render(
      $crate::i18n::Message::text($msg, $crate::i18n::current()),
      &[$((stringify!($name), &$crate::tr!(@value $name $(= $value)?) as &dyn ::std::fmt::Display)),*],
    )
  };
}

/// Defines an area's catalog: `messages! { pub enum GitMsg { AuthFailed { en: "…", th: "…" }, … } }`.
macro_rules! messages {
  ($(#[$meta:meta])* $vis:vis enum $name:ident { $($(#[$vmeta:meta])* $variant:ident { en: $en:literal, th: $th:literal $(,)? }),* $(,)? }) => {
    $(#[$meta])*
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    $vis enum $name {
      $($(#[$vmeta])* $variant),*
    }

    impl $crate::i18n::Message for $name {
      fn text(self, locale: $crate::i18n::Locale) -> &'static str {
        match locale {
          $crate::i18n::Locale::En => match self { $(Self::$variant => $en),* },
          $crate::i18n::Locale::Th => match self { $(Self::$variant => $th),* },
        }
      }
      #[cfg(test)]
      fn id(self) -> &'static str {
        match self { $(Self::$variant => concat!(stringify!($name), "::", stringify!($variant))),* }
      }
    }

    #[cfg(test)]
    impl $name {
      pub const ALL: &[Self] = &[$(Self::$variant),*];
    }
  };
}
pub(crate) use messages;

#[cfg(test)]
mod tests {
  use super::*;
  use std::collections::{BTreeMap, BTreeSet};
  use std::path::Path;

  /// Every catalog message: (id, English, Thai).
  fn all() -> Vec<(&'static str, &'static str, &'static str)> {
    msg::all().into_iter().collect()
  }

  #[test]
  fn resolves_like_the_frontend() {
    assert_eq!(Locale::resolve("th", Some("en-US")), Locale::Th);
    assert_eq!(Locale::resolve("en", Some("th-TH")), Locale::En);
    assert_eq!(Locale::resolve("auto", Some("th-TH")), Locale::Th);
    assert_eq!(Locale::resolve("auto", Some("TH")), Locale::Th);
    assert_eq!(Locale::resolve("auto", Some("en-GB")), Locale::En);
    assert_eq!(Locale::resolve("auto", None), Locale::En);
    assert_eq!(Locale::resolve("weird", Some("th_TH.UTF-8")), Locale::Th);
  }

  #[test]
  fn renders_params_and_plurals() {
    let n = 3;
    assert_eq!(render("{n|# file|# files} in {dir}", &[("n", &n), ("dir", &"src")]), "3 files in src");
    assert_eq!(render("{n|# file|# files}", &[("n", &1)]), "1 file");
    assert_eq!(render("{missing} {a}", &[("a", &"x")]), "{missing} x");
    assert_eq!(render("json { \"a\": 1 } {a}", &[("a", &"ok")]), "json { \"a\": 1 } ok");
    assert_eq!(render("ไม่พบ {x}", &[("x", &"ก")]), "ไม่พบ ก");
    assert_eq!(param_names("{a} {b|x|y} {a} { c }"), ["a", "b"]);
  }

  #[test]
  fn locale_override_is_per_thread() {
    with_locale(Locale::Th, || {
      assert_eq!(current(), Locale::Th);
      std::thread::spawn(|| assert_eq!(current(), Locale::En)).join().unwrap();
      with_locale(Locale::En, || assert_eq!(current(), Locale::En));
      assert_eq!(current(), Locale::Th);
    });
    assert_eq!(current(), Locale::En);
  }

  #[test]
  fn catalogs_are_complete() {
    let mut problems = Vec::new();
    for (id, en, th) in all() {
      if en.trim().is_empty() || th.trim().is_empty() {
        problems.push(format!("{id}: empty message"));
      }
      let (pe, pt): (BTreeSet<_>, BTreeSet<_>) = (param_names(en).into_iter().collect(), param_names(th).into_iter().collect());
      if pe != pt {
        problems.push(format!("{id}: params differ: en {pe:?} th {pt:?}"));
      }
      if th.contains("ครับ") || th.contains("ค่ะ") {
        problems.push(format!("{id}: polite particle in Thai"));
      }
      if en.chars().any(|c| ('\u{0E00}'..='\u{0E7F}').contains(&c)) {
        problems.push(format!("{id}: Thai in the English message"));
      }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
  }

  /// Source files of this crate, minus this module.
  fn sources(dir: &Path, out: &mut Vec<(String, String)>) {
    for e in std::fs::read_dir(dir).unwrap().flatten() {
      let p = e.path();
      if p.is_dir() {
        sources(&p, out);
      } else if p.extension().is_some_and(|x| x == "rs") && !p.ends_with("i18n/mod.rs") {
        out.push((p.display().to_string(), std::fs::read_to_string(&p).unwrap()));
      }
    }
  }

  /// Top-level comma-separated args of the call whose `(` ends at `s[0..]`, and the rest.
  fn call_args(s: &str) -> Option<Vec<String>> {
    let (mut depth, mut args, mut cur, mut chars) = (0usize, Vec::new(), String::new(), s.chars().peekable());
    while let Some(c) = chars.next() {
      match c {
        '"' => {
          cur.push(c);
          while let Some(d) = chars.next() {
            cur.push(d);
            if d == '\\' {
              cur.extend(chars.next());
            } else if d == '"' {
              break;
            }
          }
        }
        '(' | '[' | '{' => {
          depth += 1;
          cur.push(c);
        }
        ')' | ']' | '}' if depth == 0 => {
          args.push(std::mem::take(&mut cur));
          return Some(args.into_iter().map(|a| a.trim().to_string()).filter(|a| !a.is_empty()).collect());
        }
        ')' | ']' | '}' => {
          depth -= 1;
          cur.push(c);
        }
        ',' if depth == 0 => args.push(std::mem::take(&mut cur)),
        _ => cur.push(c),
      }
    }
    None
  }

  /// Every `tr!(Area::Message, params…)` names a catalog message and passes exactly its params.
  #[test]
  fn tr_calls_pass_the_params_their_message_uses() {
    let catalog: BTreeMap<_, _> = all().into_iter().map(|(id, en, _)| (id, en)).collect();
    let mut files = Vec::new();
    sources(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
    let (mut problems, mut calls) = (Vec::new(), 0);
    for (path, text) in &files {
      for (at, _) in text.match_indices("tr!(") {
        let line_start = text[..at].rfind('\n').map_or(0, |i| i + 1);
        if text[..at].chars().next_back().is_some_and(|c| c.is_alphanumeric() || c == '_') || text[line_start..at].trim_start().starts_with("//") {
          continue;
        }
        let line = text[..at].lines().count().max(1);
        let Some(args) = call_args(&text[at + 4..]) else {
          problems.push(format!("{path}:{line}: unterminated tr!"));
          continue;
        };
        calls += 1;
        let id = args.first().map(|a| a.trim_start_matches("crate::i18n::msg::").to_string()).unwrap_or_default();
        let Some(template) = catalog.get(id.as_str()) else {
          problems.push(format!("{path}:{line}: tr! needs a literal `Area::Message` the catalogs define, got `{id}`"));
          continue;
        };
        let passed: BTreeSet<&str> = args[1..].iter().map(|a| a.split('=').next().unwrap_or("").trim()).collect();
        let wanted: BTreeSet<&str> = param_names(template).into_iter().collect();
        if passed != wanted {
          problems.push(format!("{path}:{line}: {id} takes {wanted:?}, tr! passes {passed:?}"));
        }
      }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
    assert!(calls > 0);
  }

  /// `src/lib/i18n/rustErrors.ts` matches some Rust errors by their text in either language:
  /// each entry there must be the start of the listed Rust messages, in both languages.
  #[test]
  fn frontend_error_prefixes_are_the_catalog_text() {
    let ts = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/i18n/rustErrors.ts")).unwrap();
    let re = regex::Regex::new(r#"(?m)^\s*(\w+): \{ en: '([^']*)', th: '([^']*)' \}"#).unwrap();
    let entries: BTreeMap<&str, (&str, &str)> =
      re.captures_iter(&ts).map(|c| (c.get(1).unwrap().as_str(), (c.get(2).unwrap().as_str(), c.get(3).unwrap().as_str()))).collect();
    let mut seen = BTreeSet::new();
    for (key, messages) in msg::frontend_matched() {
      let (en, th) = entries.get(key).unwrap_or_else(|| panic!("rustErrors.ts has no `{key}`"));
      seen.insert(key);
      for (id, msg_en, msg_th) in messages {
        assert!(!en.is_empty() && msg_en.starts_with(en), "{key}: {id} English `{msg_en}` does not start with `{en}`");
        assert!(!th.is_empty() && msg_th.starts_with(th), "{key}: {id} Thai `{msg_th}` does not start with `{th}`");
      }
    }
    let extra: Vec<_> = entries.keys().filter(|k| !seen.contains(*k)).collect();
    assert!(extra.is_empty(), "rustErrors.ts entries not listed in msg::frontend_matched: {extra:?}");
  }
}
