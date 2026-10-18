//! Folders and projects: new project, Initialize Repository (project.rs).

crate::i18n::messages! {
  pub enum WorkspaceMsg {
    IdentityHint {
      en: "Git has no author name yet: run git config --global user.name \"Your Name\" and git config --global user.email \"you@example.com\", then try again",
      th: "ยังไม่ได้ตั้งชื่อผู้เขียนของ git ให้รัน git config --global user.name \"ชื่อคุณ\" และ git config --global user.email \"you@example.com\" แล้วลองใหม่",
    },
    NotAFolder {
      en: "{path}: not a folder",
      th: "{path}: ไม่ใช่โฟลเดอร์",
    },
    AlreadyRepo {
      en: "{path} is already a git repository",
      th: "{path} เป็น git repository อยู่แล้ว",
    },
    BadDefaultBranch {
      en: "Invalid default branch name: {name} (git.defaultBranchName)",
      th: "ชื่อ branch เริ่มต้นไม่ถูกต้อง: {name} (git.defaultBranchName)",
    },
    InitFailed {
      en: "git init failed: {detail}",
      th: "git init ไม่สำเร็จ: {detail}",
    },
    FirstCommitFailed {
      en: "Could not create the first commit: {detail}",
      th: "สร้าง commit แรกไม่สำเร็จ: {detail}",
    },
    NameRequired {
      en: "Enter a project name",
      th: "ใส่ชื่อโปรเจกต์",
    },
    BadName {
      en: "Invalid project name: {name} (it must not contain / or be . or ..)",
      th: "ชื่อโปรเจกต์ใช้ไม่ได้: {name} (ห้ามมี / หรือเป็น . / ..)",
    },
    ParentNotAbsolute {
      en: "The folder to create the project in must be a full path",
      th: "โฟลเดอร์ที่จะสร้างโปรเจกต์ต้องเป็น path เต็ม",
    },
    CreateFolderFailed {
      en: "Could not create folder {path}: {detail}",
      th: "สร้างโฟลเดอร์ {path} ไม่ได้: {detail}",
    },
    NotEmpty {
      en: "\"{name}\" already exists here and is not empty",
      th: "มี \"{name}\" อยู่ที่นี่แล้วและไม่ว่าง",
    },
  }
}
