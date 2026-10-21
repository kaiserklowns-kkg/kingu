//! Files of the workspace: explorer operations, opening and saving text, replace in files, the
//! image viewer, settings files, floating notes (fileops.rs, workspace.rs, textfile.rs,
//! replace.rs, fs.rs, settings.rs, floating.rs), and the guards on
//! Kingu's own files under `.kingu` (agent/chats.rs, agent/chat_edits.rs, agent/rewind.rs).

crate::i18n::messages! {
  pub enum FilesMsg {
    NoFolder {
      en: "no folder is open",
      th: "ยังไม่ได้เปิดโฟลเดอร์",
    },
    BadPath {
      en: "{path}: not a valid path inside the workspace",
      th: "{path}: ไม่ใช่ path ที่ใช้ได้ใน workspace",
    },
    OutsideWorkspace {
      en: "{path}: outside the workspace",
      th: "{path}: อยู่นอก workspace",
    },
    /// The explorer offers "Replace?" when a move or copy fails with this (rustErrors.ts
    /// `fileExists`, checked by i18n's tests).
    Exists {
      en: "Already exists: {path}",
      th: "มีอยู่แล้ว: {path}",
    },
    ParentNotAFolder {
      en: "{path}: {parent} is not a folder",
      th: "{path}: {parent} ไม่ใช่โฟลเดอร์",
    },
    NotAFolder {
      en: "{path}: not a folder",
      th: "{path}: ไม่ใช่โฟลเดอร์",
    },
    NotADirectory {
      en: "{path}: not a directory",
      th: "{path}: ไม่ใช่โฟลเดอร์",
    },
    NotAFile {
      en: "{path}: not a file",
      th: "{path}: ไม่ใช่ไฟล์",
    },
    NotARegularFile {
      en: "{path}: not a regular file",
      th: "{path}: ไม่ใช่ไฟล์ธรรมดา",
    },
    IsADirectory {
      en: "{path}: is a directory",
      th: "{path}: เป็นโฟลเดอร์",
    },
    /// A read of a path that turned out to be a folder (no path: the caller adds it).
    IsADirectoryBare {
      en: "is a directory",
      th: "เป็นโฟลเดอร์",
    },
    InvalidPath {
      en: "{path}: invalid path",
      th: "{path}: path ไม่ถูกต้อง",
    },
    FolderNotFound {
      en: "{path}: folder not found",
      th: "{path}: ไม่พบโฟลเดอร์",
    },
    MoveIntoItself {
      en: "{path}: cannot move a folder into itself",
      th: "{path}: ย้ายโฟลเดอร์เข้าไปในตัวเองไม่ได้",
    },
    CopyIntoItself {
      en: "{path}: cannot copy a folder into itself",
      th: "{path}: คัดลอกโฟลเดอร์เข้าไปในตัวเองไม่ได้",
    },
    NoFreeName {
      en: "{name}: no free name",
      th: "{name}: หาชื่อที่ยังว่างไม่ได้",
    },
    UndoCopyGone {
      en: "{path}: the undo copy is gone",
      th: "{path}: สำเนาสำหรับเลิกทำหายไปแล้ว",
    },
    RevealFailed {
      en: "Could not reveal {path}: {detail}",
      th: "แสดง {path} ใน Finder ไม่ได้: {detail}",
    },
    // replace.rs
    MatchGone {
      en: "line {line}: \"{text}\" is no longer there",
      th: "บรรทัด {line}: ไม่มี \"{text}\" อยู่ตรงนั้นแล้ว",
    },
    ChangedSinceSearch {
      en: "changed since the search",
      th: "ไฟล์เปลี่ยนไปหลังการค้นหา",
    },
    NotUtf8Text {
      en: "not UTF-8 text",
      th: "ไม่ใช่ข้อความ UTF-8",
    },
    // fs.rs (image viewer)
    NotAnImage {
      en: "not an image",
      th: "ไม่ใช่รูปภาพ",
    },
    ImageTooLarge {
      en: "larger than {mb} MB",
      th: "ใหญ่เกิน {mb} MB",
    },
    // settings.rs
    FileTooLarge {
      en: "{path}: larger than {max} bytes",
      th: "{path}: ใหญ่เกิน {max} ไบต์",
    },
    NotUtf8 {
      en: "{path}: not UTF-8",
      th: "{path}: ไม่ใช่ UTF-8",
    },
    SettingsTooLarge {
      en: "settings larger than {max} bytes",
      th: "การตั้งค่าใหญ่เกิน {max} ไบต์",
    },
    // floating.rs
    NotMarkdown {
      en: "Selected file is not a markdown document.",
      th: "ไฟล์ที่เลือกไม่ใช่เอกสาร markdown",
    },
    UntitledFailed {
      en: "Failed to create untitled markdown file.",
      th: "สร้างไฟล์ markdown ใหม่ไม่สำเร็จ",
    },
  }
}
