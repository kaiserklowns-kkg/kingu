//! The command's own text (help and errors) in English or Thai. The language: `KINGU_LANG`
//! (Kingu's terminals set it to the app's UI language), else `LC_ALL` / `LC_MESSAGES` / `LANG`
//! (Thai when it starts with `th`), else English. Answers from the app come already translated.
//!
//! A message is a [`Msg`] variant with both languages side by side in [`Msg::text`]; `{name}` in
//! the text is filled by [`tr`]. The tests check that both languages exist and use the same
//! `{params}`.

use std::sync::atomic::{AtomicU8, Ordering};

/// Set by Kingu's terminals: `th` or `en`.
pub const ENV_LANG: &str = "KINGU_LANG";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
  En,
  Th,
}

impl Lang {
  /// The first of `kingu_lang`, `lc_all`, `lc_messages`, `lang` that is set (not empty, `C` or
  /// `POSIX`) decides: Thai when it starts with `th`.
  pub fn resolve(kingu_lang: Option<&str>, lc_all: Option<&str>, lc_messages: Option<&str>, lang: Option<&str>) -> Lang {
    let first = [kingu_lang, lc_all, lc_messages, lang].into_iter().flatten().map(str::trim).find(|v| !v.is_empty() && *v != "C" && *v != "POSIX");
    if first.is_some_and(|v| v.to_ascii_lowercase().starts_with("th")) { Lang::Th } else { Lang::En }
  }

  pub fn from_env() -> Lang {
    let var = |k: &str| std::env::var(k).ok();
    Lang::resolve(var(ENV_LANG).as_deref(), var("LC_ALL").as_deref(), var("LC_MESSAGES").as_deref(), var("LANG").as_deref())
  }
}

const UNSET: u8 = 0;
const EN: u8 = 1;
const TH: u8 = 2;
static LANG: AtomicU8 = AtomicU8::new(UNSET);

/// The language [`tr`] uses: set by `main` from the environment; English until then.
pub fn current() -> Lang {
  if LANG.load(Ordering::Relaxed) == TH { Lang::Th } else { Lang::En }
}

pub fn set(l: Lang) {
  LANG.store(if l == Lang::Th { TH } else { EN }, Ordering::Relaxed);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Msg {
  Usage,
  NeedsValue,
  UnknownCommand,
  UnexpectedArgument,
  UnknownOption,
  TaskNeedsSubcommand,
  TaskCreateNeedsTitle,
  BadMode,
  TaskOpenNeedsSlug,
  TaskOpenOneSlug,
  UnknownTaskCommand,
  OpenNeedsPath,
  OpenOnePath,
  NotifyNeedsMessage,
  PromptTooLarge,
  StatusFolder,
  NoFolder,
  NoTasks,
  NotReachable,
  SendFailed,
  NoAnswer,
  ClosedWithoutAnswer,
  Unsupported,
  Stdin,
  CurrentFolder,
  NoDataFolder,
  NotRunning,
  Failed,
  RuntimeVersion,
  RuntimeIncomplete,
  NotRegularFile,
  OtherOwner,
  OtherUsers,
  ArtifactNeedsSubcommand,
  ArtifactNeedsFile,
  ArtifactOneFile,
  ArtifactBadId,
  ArtifactBadAsset,
  UnknownArtifactCommand,
  ArtifactPublished,
  NoArtifacts,
}

impl Msg {
  pub const ALL: &[Msg] = &[
    Msg::Usage,
    Msg::NeedsValue,
    Msg::UnknownCommand,
    Msg::UnexpectedArgument,
    Msg::UnknownOption,
    Msg::TaskNeedsSubcommand,
    Msg::TaskCreateNeedsTitle,
    Msg::BadMode,
    Msg::TaskOpenNeedsSlug,
    Msg::TaskOpenOneSlug,
    Msg::UnknownTaskCommand,
    Msg::OpenNeedsPath,
    Msg::OpenOnePath,
    Msg::NotifyNeedsMessage,
    Msg::PromptTooLarge,
    Msg::StatusFolder,
    Msg::NoFolder,
    Msg::NoTasks,
    Msg::NotReachable,
    Msg::SendFailed,
    Msg::NoAnswer,
    Msg::ClosedWithoutAnswer,
    Msg::Unsupported,
    Msg::Stdin,
    Msg::CurrentFolder,
    Msg::NoDataFolder,
    Msg::NotRunning,
    Msg::Failed,
    Msg::RuntimeVersion,
    Msg::RuntimeIncomplete,
    Msg::NotRegularFile,
    Msg::OtherOwner,
    Msg::OtherUsers,
    Msg::ArtifactNeedsSubcommand,
    Msg::ArtifactNeedsFile,
    Msg::ArtifactOneFile,
    Msg::ArtifactBadId,
    Msg::ArtifactBadAsset,
    Msg::UnknownArtifactCommand,
    Msg::ArtifactPublished,
    Msg::NoArtifacts,
  ];

  /// (English, Thai).
  fn pair(self) -> (&'static str, &'static str) {
    match self {
      Msg::Usage => (USAGE_EN, USAGE_TH),
      Msg::NeedsValue => ("{flag} needs a value", "{flag} ต้องมีค่าตามหลัง"),
      Msg::UnknownCommand => ("unknown command `{command}` (try `kingu --help`)", "ไม่รู้จักคำสั่ง `{command}` (ดู `kingu --help`)"),
      Msg::UnexpectedArgument => ("unexpected argument `{arg}`", "มี argument เกินมา: `{arg}`"),
      Msg::UnknownOption => ("unknown option `{option}`", "ไม่รู้จักตัวเลือก `{option}`"),
      Msg::TaskNeedsSubcommand => ("`kingu task` needs list, create or open", "`kingu task` ต้องตามด้วย list, create หรือ open"),
      Msg::TaskCreateNeedsTitle => ("`kingu task create` needs a title", "`kingu task create` ต้องมีชื่องาน"),
      Msg::BadMode => ("--mode must be terminal or timeline, not `{mode}`", "--mode ต้องเป็น terminal หรือ timeline ไม่ใช่ `{mode}`"),
      Msg::TaskOpenNeedsSlug => ("`kingu task open` needs a task slug (see `kingu task list`)", "`kingu task open` ต้องมี slug ของงาน (ดูได้จาก `kingu task list`)"),
      Msg::TaskOpenOneSlug => ("`kingu task open` takes one slug", "`kingu task open` รับ slug ได้ทีละหนึ่ง"),
      Msg::UnknownTaskCommand => ("unknown task command `{command}` (list, create, open)", "ไม่รู้จักคำสั่ง task `{command}` (มี list, create, open)"),
      Msg::OpenNeedsPath => ("`kingu open` needs a path", "`kingu open` ต้องมี path"),
      Msg::OpenOnePath => ("`kingu open` takes one path", "`kingu open` รับ path ได้ทีละหนึ่ง"),
      Msg::NotifyNeedsMessage => ("`kingu notify` needs a message", "`kingu notify` ต้องมีข้อความ"),
      Msg::PromptTooLarge => ("the prompt is larger than {kb} KB", "prompt ยาวเกิน {kb} KB"),
      Msg::StatusFolder => ("folder: {folder}\ntasks: {tasks}", "โฟลเดอร์: {folder}\nงาน: {tasks}"),
      Msg::NoFolder => ("no folder open", "ยังไม่ได้เปิดโฟลเดอร์"),
      Msg::NoTasks => ("no tasks", "ไม่มีงาน"),
      Msg::NotReachable => ("Kingu is not running or not reachable ({socket}: {detail})", "Kingu ไม่ได้เปิดอยู่หรือติดต่อไม่ได้ ({socket}: {detail})"),
      Msg::SendFailed => ("could not send to Kingu: {detail}", "ส่งคำขอไปยัง Kingu ไม่ได้: {detail}"),
      Msg::NoAnswer => ("no answer from Kingu: {detail}", "Kingu ไม่ตอบกลับ: {detail}"),
      Msg::ClosedWithoutAnswer => ("Kingu closed the connection without answering", "Kingu ปิดการเชื่อมต่อโดยไม่ตอบกลับ"),
      Msg::Unsupported => ("the kingu command is not supported on this operating system yet", "คำสั่ง kingu ยังใช้บนระบบปฏิบัติการนี้ไม่ได้"),
      Msg::Stdin => ("stdin: {detail}", "อ่าน stdin ไม่ได้: {detail}"),
      Msg::CurrentFolder => ("current folder: {detail}", "อ่านโฟลเดอร์ปัจจุบันไม่ได้: {detail}"),
      Msg::NoDataFolder => ("cannot find Kingu's data folder (HOME is not set)", "หาโฟลเดอร์ข้อมูลของ Kingu ไม่เจอ (ไม่ได้ตั้งค่า HOME)"),
      Msg::NotRunning => ("Kingu is not running (start the app first)", "Kingu ไม่ได้เปิดอยู่ (เปิดแอปก่อน)"),
      Msg::Failed => ("failed", "ไม่สำเร็จ"),
      Msg::RuntimeVersion => (
        "{path}: runtime file version {found} (this kingu understands {supported}); update the kingu command",
        "{path}: ไฟล์ runtime เวอร์ชัน {found} (kingu ตัวนี้รองรับ {supported}) อัปเดตคำสั่ง kingu ก่อน",
      ),
      Msg::RuntimeIncomplete => ("{path}: incomplete runtime file", "{path}: ไฟล์ runtime ไม่ครบ"),
      Msg::NotRegularFile => ("{path} is not a regular file", "{path} ไม่ใช่ไฟล์ปกติ"),
      Msg::OtherOwner => ("{path} belongs to uid {uid}, not this user; refusing it", "{path} เป็นของ uid {uid} ไม่ใช่ผู้ใช้นี้ จึงไม่ใช้ไฟล์นี้"),
      Msg::OtherUsers => ("{path} is readable or writable by other users (mode {mode}); refusing it", "ผู้ใช้อื่นอ่านหรือเขียน {path} ได้ (mode {mode}) จึงไม่ใช้ไฟล์นี้"),
      Msg::ArtifactNeedsSubcommand => ("`kingu artifact` needs publish or list", "`kingu artifact` ต้องตามด้วย publish หรือ list"),
      Msg::ArtifactNeedsFile => ("`kingu artifact publish` needs an .html or .md file", "`kingu artifact publish` ต้องระบุไฟล์ .html หรือ .md"),
      Msg::ArtifactOneFile => ("`kingu artifact publish` takes one file (add others with --asset)", "`kingu artifact publish` รับได้ไฟล์เดียว (ไฟล์อื่นใส่ด้วย --asset)"),
      Msg::ArtifactBadId => ("--id must be an artifact id (16 hex digits, see `kingu artifact list`), not `{id}`", "--id ต้องเป็น id ของ artifact (เลขฐานสิบหก 16 หลัก ดูได้จาก `kingu artifact list`) ไม่ใช่ `{id}`"),
      Msg::ArtifactBadAsset => ("--asset needs <path> or <path>=<name>, not `{value}`", "--asset ต้องเป็น <path> หรือ <path>=<name> ไม่ใช่ `{value}`"),
      Msg::UnknownArtifactCommand => ("unknown artifact command `{command}` (publish, list)", "ไม่รู้จักคำสั่ง artifact `{command}` (มี publish, list)"),
      Msg::ArtifactPublished => ("Published {title} (artifact {id}, version {version})", "เผยแพร่ {title} แล้ว (artifact {id} เวอร์ชัน {version})"),
      Msg::NoArtifacts => ("no artifacts", "ไม่มี artifact"),
    }
  }

  pub fn text(self, lang: Lang) -> &'static str {
    let (en, th) = self.pair();
    if lang == Lang::Th { th } else { en }
  }
}

/// `m` in `lang` with each `{name}` replaced by its value.
pub fn tr_in(lang: Lang, m: Msg, params: &[(&str, &dyn std::fmt::Display)]) -> String {
  let mut out = m.text(lang).to_owned();
  for (k, v) in params {
    out = out.replace(&format!("{{{k}}}"), &v.to_string());
  }
  out
}

/// `m` in the current language with each `{name}` replaced by its value.
pub fn tr(m: Msg, params: &[(&str, &dyn std::fmt::Display)]) -> String {
  tr_in(current(), m, params)
}

/// The help text in the current language.
pub fn usage() -> &'static str {
  Msg::Usage.text(current())
}

const USAGE_EN: &str = "kingu: control the running Kingu app from a terminal or an agent

Usage:
  kingu status                       Kingu's version, open folder and task count
  kingu task list                    tasks of the open folder (slug, status, title)
  kingu task create <title> [--prompt <text>|-] [--base <branch>] [--mode terminal|timeline] [--background]
                                     start a task in a new worktree; prints its slug
  kingu task open <slug>             show a task in Kingu
  kingu open <path>[:line[:column]]  open a file (in the open folder) or a folder in Kingu
  kingu notify <message…> [--title <title>]
                                     post a desktop notification
  kingu artifact publish <file> [--title <title>] [--description <text>]
                         [--asset <path>[=<name>]]… [--id <id>]
                                     publish an HTML or Markdown page as an artifact of
                                     the project (a new version with --id); prints its id
  kingu artifact list                the project's artifacts (id, version, format, title)

Options:
  --json         print the app's answer as JSON
  -h, --help     this help
  -V, --version  the command's version

The app must be running. Inside Kingu's terminals `kingu` is on PATH; elsewhere run
\"Shell Command: Install 'kingu' command in PATH\" from Kingu's command palette.
Language: KINGU_LANG=th|en (else LANG).";

const USAGE_TH: &str = "kingu: สั่งงานแอป Kingu ที่เปิดอยู่จากเทอร์มินัลหรือจาก agent

วิธีใช้:
  kingu status                       เวอร์ชันของ Kingu โฟลเดอร์ที่เปิด และจำนวนงาน
  kingu task list                    งานของโฟลเดอร์ที่เปิด (slug, สถานะ, ชื่อ)
  kingu task create <title> [--prompt <text>|-] [--base <branch>] [--mode terminal|timeline] [--background]
                                     เริ่มงานใน worktree ใหม่ แล้วพิมพ์ slug ของงาน
  kingu task open <slug>             แสดงงานใน Kingu
  kingu open <path>[:line[:column]]  เปิดไฟล์ (ในโฟลเดอร์ที่เปิด) หรือโฟลเดอร์ใน Kingu
  kingu notify <message…> [--title <title>]
                                     แสดงการแจ้งเตือนบนเดสก์ท็อป
  kingu artifact publish <file> [--title <title>] [--description <text>]
                         [--asset <path>[=<name>]]… [--id <id>]
                                     เผยแพร่หน้า HTML หรือ Markdown เป็น artifact ของโปรเจกต์
                                     (ใส่ --id เพื่อเพิ่มเวอร์ชันใหม่) แล้วพิมพ์ id
  kingu artifact list                artifact ของโปรเจกต์ (id, เวอร์ชัน, รูปแบบ, ชื่อ)

ตัวเลือก:
  --json         พิมพ์คำตอบของแอปเป็น JSON
  -h, --help     แสดงวิธีใช้นี้
  -V, --version  เวอร์ชันของคำสั่ง

ต้องเปิดแอปไว้ก่อน ในเทอร์มินัลของ Kingu มี `kingu` อยู่ใน PATH แล้ว ที่อื่นให้รัน
\"Shell Command: Install 'kingu' command in PATH\" จาก command palette ของ Kingu
ภาษา: KINGU_LANG=th|en (ถ้าไม่ได้ตั้งจะดูจาก LANG)";

#[cfg(test)]
mod tests {
  use super::*;

  fn params(s: &str) -> Vec<&str> {
    let mut out: Vec<&str> = s.split('{').skip(1).filter_map(|p| p.split_once('}').map(|(k, _)| k)).filter(|k| k.bytes().all(|b| b.is_ascii_lowercase())).collect();
    out.sort_unstable();
    out
  }

  #[test]
  fn every_message_has_both_languages_with_the_same_params() {
    for &m in Msg::ALL {
      let (en, th) = m.pair();
      assert!(!en.trim().is_empty() && !th.trim().is_empty(), "{m:?}");
      assert_ne!(en, th, "{m:?} is not translated");
      assert_eq!(params(en), params(th), "{m:?}");
      assert!(!th.contains("ครับ") && !th.contains("ค่ะ"), "{m:?}");
    }
  }

  #[test]
  fn usage_lists_the_same_commands_in_both_languages() {
    let commands = |s: &str| s.lines().filter(|l| l.trim_start().starts_with("kingu ")).map(|l| l.trim().split("  ").next().unwrap_or_default().to_owned()).collect::<Vec<_>>();
    assert_eq!(commands(USAGE_EN), commands(USAGE_TH));
    assert_eq!(commands(USAGE_EN).len(), 8);
  }

  #[test]
  fn resolves_the_language() {
    assert_eq!(Lang::resolve(None, None, None, None), Lang::En);
    assert_eq!(Lang::resolve(Some("th"), None, None, Some("en_US.UTF-8")), Lang::Th);
    assert_eq!(Lang::resolve(Some("en"), Some("th_TH.UTF-8"), None, None), Lang::En);
    assert_eq!(Lang::resolve(Some(""), None, None, Some("th_TH.UTF-8")), Lang::Th);
    assert_eq!(Lang::resolve(None, Some("C"), Some("TH_TH"), Some("en_US")), Lang::Th);
    assert_eq!(Lang::resolve(None, None, None, Some("POSIX")), Lang::En);
  }

  #[test]
  fn fills_params() {
    assert_eq!(tr_in(Lang::En, Msg::BadMode, &[("mode", &"cloud")]), "--mode must be terminal or timeline, not `cloud`");
    assert_eq!(tr_in(Lang::Th, Msg::PromptTooLarge, &[("kb", &64)]), "prompt ยาวเกิน 64 KB");
    assert_eq!(tr(Msg::NoTasks, &[]), "no tasks");
  }
}
