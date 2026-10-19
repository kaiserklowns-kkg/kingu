//! Chat memories (agent/memories.rs), the completion chime (chime.rs) and response feedback
//! (agent/mod.rs `chat_feedback`).

crate::i18n::messages! {
  pub enum ChatExtrasMsg {
    MemoryFile {
      en: "Memories go in CLAUDE.local.md or AGENTS.md",
      th: "เก็บความจำได้ใน CLAUDE.local.md หรือ AGENTS.md เท่านั้น",
    },
    MemoryEmpty {
      en: "The memory is empty",
      th: "ความจำว่างเปล่า",
    },
    MemoryTooLong {
      en: "A memory is at most {max} characters",
      th: "ความจำยาวได้ไม่เกิน {max} ตัวอักษร",
    },
    MemoryStale {
      en: "{file} changed since it was read; reopen the list and try again",
      th: "{file} เปลี่ยนไปหลังจากอ่านครั้งล่าสุด เปิดรายการใหม่แล้วลองอีกครั้ง",
    },
    MemoryNotFile {
      en: "{file} is not a regular file (a symlink or a folder); Kingu does not write to it",
      th: "{file} ไม่ใช่ไฟล์ธรรมดา (เป็น symlink หรือโฟลเดอร์) Kingu จะไม่เขียนลงไป",
    },
    MemoryFileTooLarge {
      en: "{file} is larger than 1 MB; edit it by hand",
      th: "{file} ใหญ่เกิน 1 MB แก้ไขเองในไฟล์แทน",
    },
    ChimeSound {
      en: "Unknown completion sound {sound}",
      th: "ไม่รู้จักเสียงเมื่อเสร็จ {sound}",
    },
    ChimeCustomBad {
      en: "The custom completion sound must be an existing audio file (aiff, wav, mp3, m4a or caf, up to 10 MB) given by its full path",
      th: "เสียงเมื่อเสร็จแบบกำหนดเองต้องเป็นไฟล์เสียงที่มีอยู่จริง (aiff, wav, mp3, m4a หรือ caf ไม่เกิน 10 MB) ระบุด้วย path เต็ม",
    },
    ChimeUnsupported {
      en: "System sounds play only on macOS",
      th: "เสียงของระบบเล่นได้เฉพาะบน macOS",
    },
    FeedbackVote {
      en: "Feedback is up, down or none",
      th: "ความเห็นต้องเป็น up, down หรือไม่มี",
    },
  }
}
