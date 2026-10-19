//! Source Control inside the editor (git_editor.rs): stage selected ranges, blame, file history,
//! merge conflict versions.

crate::i18n::messages! {
  pub enum ScmEditorMsg {
    BadPatch {
      en: "The change to stage is not a valid patch.",
      th: "การเปลี่ยนแปลงที่จะ stage ไม่ใช่ patch ที่ถูกต้อง",
    },
    PatchFailed {
      en: "Could not stage the selected changes: {error}",
      th: "stage ส่วนที่เลือกไม่ได้: {error}",
    },
    NotTracked {
      en: "{path} is not in the index yet; stage the whole file first.",
      th: "{path} ยังไม่อยู่ใน index ให้ stage ทั้งไฟล์ก่อน",
    },
    BadStage {
      en: "Merge stage {stage} does not exist (1 base, 2 current, 3 incoming).",
      th: "ไม่มี merge stage {stage} (1 base, 2 current, 3 incoming)",
    },
  }
}
