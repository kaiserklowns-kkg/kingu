//! The status bar's system items: keep awake, listening ports, stopping a process, opening a
//! local server (system.rs).

crate::i18n::messages! {
  pub enum SystemMsg {
    KeepAwakeMacOnly {
      en: "keep-awake needs macOS",
      th: "กันเครื่องหลับใช้ได้เฉพาะบน macOS",
    },
    PortScanUnsupported {
      en: "port scan needs macOS or Linux",
      th: "ดูพอร์ตที่เปิดอยู่ได้เฉพาะบน macOS หรือ Linux",
    },
    NotSupportedHere {
      en: "not supported here",
      th: "ใช้บนระบบนี้ไม่ได้",
    },
    NotOurProcess {
      en: "process {pid} was not started by Kingu",
      th: "process {pid} ไม่ได้เริ่มจาก Kingu",
    },
    KillFailed {
      en: "kill {pid} failed",
      th: "หยุด process {pid} ไม่สำเร็จ",
    },
    LocalhostOnly {
      en: "only localhost URLs open from the status bar",
      th: "เปิดจากแถบสถานะได้เฉพาะ URL ของ localhost",
    },
  }
}
