//! The `kingu` command's server and installer (cli_server.rs).

crate::i18n::messages! {
  pub enum CliMsg {
    NoFolder {
      en: "No folder is open in Kingu",
      th: "ยังไม่ได้เปิดโฟลเดอร์ใน Kingu",
    },
    UnknownMethod {
      en: "Unknown request: {method} (update the kingu command)",
      th: "ไม่รู้จักคำขอ: {method} (อัปเดตคำสั่ง kingu)",
    },
    TitleRequired {
      en: "The task needs a title",
      th: "งานต้องมีชื่อ",
    },
    TitleTooLong {
      en: "The title is longer than {max} characters",
      th: "ชื่องานยาวเกิน {max} ตัวอักษร",
    },
    PromptTooLarge {
      en: "The prompt is larger than {max} KB",
      th: "คำสั่งงานใหญ่เกิน {max} KB",
    },
    BadMode {
      en: "Unknown run mode: {mode} (terminal or timeline)",
      th: "ไม่รู้จักวิธีรัน: {mode} (terminal หรือ timeline)",
    },
    UnknownTask {
      en: "No task {slug} in the open folder (see kingu task list)",
      th: "ไม่มีงาน {slug} ในโฟลเดอร์ที่เปิดอยู่ (ดู kingu task list)",
    },
    PathNotAbsolute {
      en: "The path must be absolute",
      th: "path ต้องเป็นแบบเต็ม (absolute)",
    },
    PathNotFound {
      en: "{path} does not exist",
      th: "ไม่พบ {path}",
    },
    MessageRequired {
      en: "The notification needs a message",
      th: "การแจ้งเตือนต้องมีข้อความ",
    },
    MessageTooLong {
      en: "The message is longer than {max} characters",
      th: "ข้อความยาวเกิน {max} ตัวอักษร",
    },
    WindowNoAnswer {
      en: "The Kingu window did not answer in time (is it still starting?)",
      th: "หน้าต่าง Kingu ไม่ตอบภายในเวลาที่กำหนด (ยังเปิดไม่เสร็จหรือเปล่า)",
    },
    NotBundled {
      en: "This build of Kingu has no kingu command (kingu-cli is missing next to the app)",
      th: "Kingu รุ่นนี้ไม่มีคำสั่ง kingu (ไม่พบ kingu-cli ข้างตัวแอป)",
    },
    LinkTaken {
      en: "{path} already exists and is not Kingu's command; remove it first",
      th: "มี {path} อยู่แล้วและไม่ใช่คำสั่งของ Kingu ให้ลบออกก่อน",
    },
    InstallFailed {
      en: "Could not install the kingu command in {dir}: {detail}",
      th: "ติดตั้งคำสั่ง kingu ใน {dir} ไม่สำเร็จ: {detail}",
    },
    UninstallFailed {
      en: "Could not remove {path}: {detail}",
      th: "ลบ {path} ไม่สำเร็จ: {detail}",
    },
    Unsupported {
      en: "The kingu command is not supported on this operating system yet",
      th: "ระบบปฏิบัติการนี้ยังไม่รองรับคำสั่ง kingu",
    },
    DispatchTooDeep {
      en: "Dispatching a sub-task is not allowed at depth {depth} (max {max}). Complete this task yourself; to allow deeper nesting, raise kingu.orchestration.maxDepth in Kingu's settings",
      th: "ส่งงานย่อยต่อที่ความลึก {depth} ไม่ได้ (สูงสุด {max}) ให้ทำงานนี้เอง ถ้าต้องการให้ซ้อนลึกขึ้น ให้เพิ่ม kingu.orchestration.maxDepth ในการตั้งค่าของ Kingu",
    },
    NotAFile {
      en: "{path} is a folder; --diff and --merge compare files",
      th: "{path} เป็นโฟลเดอร์ --diff และ --merge ใช้กับไฟล์เท่านั้น",
    },
    NotAFolder {
      en: "{path} is not a folder; --add and --remove take folders",
      th: "{path} ไม่ใช่โฟลเดอร์ --add และ --remove ใช้กับโฟลเดอร์เท่านั้น",
    },
    BadEditorRequest {
      en: "--diff needs two files and --merge four",
      th: "--diff ต้องมีสองไฟล์และ --merge ต้องมีสี่ไฟล์",
    },
    NoInstallFolder {
      en: "No folder to install the kingu command in",
      th: "ไม่มีโฟลเดอร์ให้ติดตั้งคำสั่ง kingu",
    },
  }
}
