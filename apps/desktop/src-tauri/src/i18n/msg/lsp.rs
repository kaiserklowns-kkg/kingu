//! Language servers (lsp.rs) and debug adapters (dap.rs).

crate::i18n::messages! {
  pub enum LspMsg {
    // "Not installed" errors: the webview offers Install when one starts with
    // rustErrors.ts `notInstalled` (checked by i18n's tests).
    NotExecutable {
      en: "Not installed: {name}: {path} (from {var}) is not an executable file",
      th: "ไม่ได้ติดตั้ง {name}: {path} (จาก {var}) ไม่ใช่ไฟล์ที่รันได้",
    },
    NotOnPath {
      en: "Not installed: {name} ({binaries} not found on PATH; install it from the status bar or set {var} to the program's path)",
      th: "ไม่ได้ติดตั้ง {name} (ไม่พบ {binaries} ใน PATH; ติดตั้งได้จากแถบสถานะ หรือตั้ง {var} เป็นพาธของโปรแกรม)",
    },
    NoDebugpy {
      en: "Not installed: debugpy ({python} has no debugpy module; install it with python3 -m pip install debugpy or set {var} to a python that has debugpy)",
      th: "ไม่ได้ติดตั้ง debugpy ({python} ไม่มีโมดูล debugpy; ติดตั้งด้วย python3 -m pip install debugpy หรือตั้ง {var} เป็นพาธของ python ที่มี debugpy)",
    },
    NoPython {
      en: "Not installed: debugpy (python3 not found on PATH)",
      th: "ไม่ได้ติดตั้ง debugpy (ไม่พบ python3 ใน PATH)",
    },
    AdapterNotOnPath {
      en: "Not installed: {name} ({binaries} not found on PATH; install it from Run and Debug or set {var} to the program's path)",
      th: "ไม่ได้ติดตั้ง {name} (ไม่พบ {binaries} ใน PATH; ติดตั้งได้จาก Run and Debug หรือตั้ง {var} เป็นพาธของโปรแกรม)",
    },
    NoServer {
      en: "No language server for {language}",
      th: "ไม่มี language server สำหรับ {language}",
    },
    UnsupportedDebugType {
      en: "Debugger type \"{debug_type}\" is not supported (supported: lldb, go, debugpy)",
      th: "ไม่รองรับ debugger ชนิด \"{debug_type}\" (รองรับ lldb, go, debugpy)",
    },
    UnknownDebugType {
      en: "Debugger type \"{debug_type}\" is not supported",
      th: "ไม่รองรับ debugger ชนิด \"{debug_type}\"",
    },
    NoDapServer {
      en: "{program} did not open a DAP server within {secs} seconds",
      th: "{program} ไม่ได้เปิด DAP server ภายใน {secs} วินาที",
    },
    ConnectAdapter {
      en: "Could not connect to the debug adapter at {addr}: {detail}",
      th: "เชื่อมต่อ debug adapter ที่ {addr} ไม่ได้: {detail}",
    },
    NoSession {
      en: "This debug session no longer exists",
      th: "ไม่มี debug session นี้แล้ว",
    },
    NoBuildCommand {
      en: "No build command",
      th: "ไม่มีคำสั่ง build",
    },
    RunFailed {
      en: "Could not run {program}: {detail}",
      th: "รัน {program} ไม่ได้: {detail}",
    },
    /// Joins alternative program names: `a or b`.
    Or {
      en: " or ",
      th: " หรือ ",
    },
  }
}
