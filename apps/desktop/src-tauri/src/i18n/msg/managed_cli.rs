//! Agent CLIs Kingu installs itself (agent/managed_cli): what an install or removal refused or failed on.

crate::i18n::messages! {
  pub enum ManagedCliMsg {
    UnknownAgent {
      en: "Kingu installs no copy of {agent}.",
      th: "Kingu ไม่ได้ติดตั้ง {agent} ให้เอง",
    },
    Unavailable {
      en: "{label} is not available on {os} {arch}.",
      th: "{label} ยังไม่มีสำหรับ {os} {arch}",
    },
    LookupFailed {
      en: "Couldn't look up the latest {label} release. Check your network connection or proxy, then try again. ({detail})",
      th: "ค้นหา {label} รุ่นล่าสุดไม่สำเร็จ ตรวจการเชื่อมต่อเครือข่ายหรือพร็อกซี แล้วลองอีกครั้ง ({detail})",
    },
    BeingRemoved {
      en: "{label} is being removed. Try again after it finishes.",
      th: "กำลังลบ {label} อยู่ รอให้เสร็จแล้วลองอีกครั้ง",
    },
    Installing {
      en: "{label} is installing. Try again after it finishes.",
      th: "กำลังติดตั้ง {label} อยู่ รอให้เสร็จแล้วลองอีกครั้ง",
    },
    TurnedOff {
      en: "Kingu's copy of {label} is turned off ({setting}).",
      th: "ปิดการใช้ {label} ชุดของ Kingu ไว้ ({setting})",
    },
    ChatsNotStopped {
      en: "Not every {label} chat could be stopped, so nothing was removed. Try again.",
      th: "หยุดแชต {label} ได้ไม่ครบ จึงยังไม่ได้ลบอะไร ลองอีกครั้ง",
    },
    NotRunning {
      en: "That {label} installation is no longer running.",
      th: "การติดตั้ง {label} ครั้งนั้นจบไปแล้ว",
    },
    RemoveNoCancel {
      en: "Removing {label} cannot be cancelled.",
      th: "ยกเลิกการลบ {label} ไม่ได้",
    },
    TookTooLong {
      en: "Installing {label} took longer than 45 minutes. Try again.",
      th: "การติดตั้ง {label} ใช้เวลาเกิน 45 นาที ลองอีกครั้ง",
    },
    ChecksumMismatch {
      en: "The {label} download did not match its published checksum, so nothing was installed.",
      th: "ไฟล์ {label} ที่ดาวน์โหลดไม่ตรงกับเช็กซัมที่ผู้พัฒนาเผยแพร่ จึงไม่ได้ติดตั้งอะไร",
    },
    ReleaseMismatch {
      en: "The {label} download didn't match the release Kingu expects, so nothing was installed. Try again later.",
      th: "ไฟล์ {label} ที่ดาวน์โหลดไม่ตรงกับรุ่นที่ Kingu คาดไว้ จึงไม่ได้ติดตั้งอะไร ลองอีกครั้งภายหลัง",
    },
    DownloadFailed {
      en: "Couldn't download {label}. Check your network connection or proxy, then try again.",
      th: "ดาวน์โหลด {label} ไม่สำเร็จ ตรวจการเชื่อมต่อเครือข่ายหรือพร็อกซี แล้วลองอีกครั้ง",
    },
    DiskSpace {
      en: "{label} needs {megabytes} MB of free disk space to install.",
      th: "การติดตั้ง {label} ต้องใช้พื้นที่ว่าง {megabytes} MB",
    },
    Unpack {
      en: "Couldn't unpack the {label} download: {detail}.",
      th: "แตกไฟล์ {label} ที่ดาวน์โหลดไม่สำเร็จ: {detail}",
    },
    Missing {
      en: "The {label} download is missing {file}.",
      th: "ไฟล์ {label} ที่ดาวน์โหลดไม่มี {file}",
    },
    NoStart {
      en: "{label} couldn't start on this computer, so it wasn't installed. This computer may not support it. {detail}",
      th: "{label} เริ่มทำงานบนเครื่องนี้ไม่ได้ จึงไม่ได้ติดตั้ง เครื่องนี้อาจไม่รองรับ {detail}",
    },
    StartTimeout {
      en: "It timed out after {seconds} seconds.",
      th: "ไม่ตอบภายใน {seconds} วินาที",
    },
    StartExit {
      en: "It exited with {status}.",
      th: "จบการทำงานด้วย {status}",
    },
    StartVersion {
      en: "It answered as version {answered}, expected {expected}.",
      th: "ตอบว่าเป็นเวอร์ชัน {answered} แต่ควรเป็น {expected}",
    },
    Unreadable {
      en: "Couldn't read the installed {label} files on this computer.",
      th: "อ่านไฟล์ {label} ที่ติดตั้งบนเครื่องนี้ไม่ได้",
    },
  }
}
