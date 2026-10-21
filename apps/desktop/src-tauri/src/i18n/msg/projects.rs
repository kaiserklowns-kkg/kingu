//! The added projects of the Agents side bar (projects.rs).

crate::i18n::messages! {
  pub enum ProjectsMsg {
    NotAFolder {
      en: "{path}: not a folder",
      th: "{path}: ไม่ใช่โฟลเดอร์",
    },
    NotAdded {
      en: "{path} is not an added project",
      th: "{path} ไม่ได้เพิ่มเป็นโปรเจกต์",
    },
    TooMany {
      en: "At most {max} projects can be added; remove one first",
      th: "เพิ่มโปรเจกต์ได้ไม่เกิน {max} โปรเจกต์ ลบโปรเจกต์หนึ่งออกก่อน",
    },
  }
}
