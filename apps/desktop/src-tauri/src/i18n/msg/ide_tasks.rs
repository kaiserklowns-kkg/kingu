//! The IDE's tasks (VS Code tasks.json, tasks.rs): starting a task's terminal and trusting the
//! folder's tasks.json for automatic tasks.

crate::i18n::messages! {
  pub enum IdeTasksMsg {
    EmptyCommand {
      en: "The task has no command to run",
      th: "task ไม่มีคำสั่งให้รัน",
    },
    NulInCommand {
      en: "The task's command contains a NUL character",
      th: "คำสั่งของ task มีอักขระ NUL",
    },
    CwdNotFound {
      en: "The task's folder doesn't exist: {path}",
      th: "ไม่พบโฟลเดอร์ของ task: {path}",
    },
    NoTasksFile {
      en: "This folder has no .vscode/tasks.json",
      th: "โฟลเดอร์นี้ไม่มี .vscode/tasks.json",
    },
    TasksFileChanged {
      en: ".vscode/tasks.json has changed: review it again before allowing its automatic tasks",
      th: ".vscode/tasks.json เปลี่ยนไปแล้ว — ตรวจอีกครั้งก่อนอนุญาต task อัตโนมัติ",
    },
    TasksFileTooLarge {
      en: ".vscode/tasks.json is larger than {kb} KB",
      th: ".vscode/tasks.json ใหญ่เกิน {kb} KB",
    },
  }
}
