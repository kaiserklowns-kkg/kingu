//! Local History (local_history.rs): copies of a file kept on each save.

crate::i18n::messages! {
  pub enum LocalHistoryMsg {
    BadEntry {
      en: "Local history entry {id} not found.",
      th: "ไม่พบรายการ local history {id}",
    },
    NoHistory {
      en: "This file has no local history.",
      th: "ไฟล์นี้ไม่มี local history",
    },
  }
}
