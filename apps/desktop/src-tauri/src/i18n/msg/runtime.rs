//! Agent runtimes of the chat (agent/runtimes.rs).

crate::i18n::messages! {
  pub enum RuntimeMsg {
    Unknown {
      en: "Unknown agent: {id}",
      th: "ไม่รู้จักเอเจนต์: {id}",
    },
    NotFound {
      en: "{name} is not installed: `{program}` was not found on PATH",
      th: "ยังไม่ได้ติดตั้ง {name}: ไม่พบ `{program}` ใน PATH",
    },
    TooOld {
      en: "Your {name} CLI is {installed}. Chats need {minimum} or newer.",
      th: "{name} CLI ของคุณเป็นเวอร์ชัน {installed} แชตต้องใช้ {minimum} ขึ้นไป",
    },
    NoRewind {
      en: "This chat's agent cannot go back to an earlier message",
      th: "เอเจนต์ของแชตนี้ย้อนกลับไปยังข้อความก่อนหน้าไม่ได้",
    },
  }
}
