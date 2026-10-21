//! User snippets: the snippet files of the active profile (snippets.rs).

crate::i18n::messages! {
  pub enum SnippetsMsg {
    InvalidName {
      en: "{name} is not a snippets file name (use <language>.json or <name>.code-snippets)",
      th: "{name} ไม่ใช่ชื่อไฟล์ snippet (ใช้ <ภาษา>.json หรือ <ชื่อ>.code-snippets)",
    },
    TooLarge {
      en: "The snippets file {name} is larger than {max} bytes",
      th: "ไฟล์ snippet {name} ใหญ่เกิน {max} ไบต์",
    },
  }
}
