//! Profiles: named sets of user settings and keybindings (user_profiles.rs).

crate::i18n::messages! {
  pub enum ProfilesMsg {
    NameRequired {
      en: "Enter a profile name",
      th: "ใส่ชื่อ profile",
    },
    NameTaken {
      en: "A profile named {name} already exists",
      th: "มี profile ชื่อ {name} อยู่แล้ว",
    },
    NotFound {
      en: "Profile {id} not found",
      th: "ไม่พบ profile {id}",
    },
    DefaultIsFixed {
      en: "The Default profile cannot be renamed or deleted",
      th: "เปลี่ยนชื่อหรือลบ profile Default ไม่ได้",
    },
  }
}
