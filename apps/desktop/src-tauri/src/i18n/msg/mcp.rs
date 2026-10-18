//! MCP servers from config files (agent/mcp.rs) and the ones handed to agent runs (agent/host.rs).

crate::i18n::messages! {
  pub enum McpMsg {
    TooMany {
      en: "Too many MCP servers (at most {max})",
      th: "MCP server มากเกินไป (ไม่เกิน {max})",
    },
    InvalidName {
      en: "{name}: invalid MCP server name (letters, digits, - and _ only)",
      th: "{name}: ชื่อ MCP server ไม่ถูกต้อง (ใช้ได้เฉพาะตัวอักษร ตัวเลข - และ _)",
    },
    InvalidCommand {
      en: "{name}: invalid MCP server command",
      th: "{name}: คำสั่งของ MCP server ไม่ถูกต้อง",
    },
    InvalidUrl {
      en: "{name}: the URL must start with http:// or https://",
      th: "{name}: URL ต้องขึ้นต้นด้วย http:// หรือ https://",
    },
    InvalidHeader {
      en: "{name}: invalid HTTP header {header}",
      th: "{name}: HTTP header {header} ไม่ถูกต้อง",
    },
    UnsupportedType {
      en: "{name}: unsupported MCP server type {kind} (stdio, http or sse)",
      th: "{name}: ไม่รองรับ MCP server แบบ {kind} (ใช้ stdio, http หรือ sse)",
    },
    NotAnObject {
      en: "{name}: the server entry is not an object",
      th: "{name}: รายการ server ไม่ใช่ object",
    },
    NeedsInput {
      en: "{name}: uses {var}, which asks for input in VS Code; Kingu cannot fill it in",
      th: "{name}: ใช้ {var} ซึ่ง VS Code ถามค่าจากผู้ใช้ Kingu ใส่ค่าให้ไม่ได้",
    },
    UnknownVariable {
      en: "{name}: unknown variable {var}",
      th: "{name}: ไม่รู้จักตัวแปร {var}",
    },
    FileUnreadable {
      en: "{path}: cannot read MCP config: {detail}",
      th: "{path}: อ่าน MCP config ไม่ได้: {detail}",
    },
    FileInvalid {
      en: "{path}: not valid JSON: {detail}",
      th: "{path}: ไม่ใช่ JSON ที่ถูกต้อง: {detail}",
    },
    AlreadyExists {
      en: "An MCP server named {name} already exists in your mcp.json",
      th: "มี MCP server ชื่อ {name} ใน mcp.json ของคุณอยู่แล้ว",
    },
    NotFound {
      en: "No MCP server named {name} in {path}",
      th: "ไม่พบ MCP server ชื่อ {name} ใน {path}",
    },
    Changed {
      en: "{name} in {path} has changed: review it again before trusting it",
      th: "{name} ใน {path} เปลี่ยนไปแล้ว — ตรวจอีกครั้งก่อนเชื่อถือ",
    },
    SourceInvalid {
      en: "Unknown MCP config source {source}",
      th: "ไม่รู้จักแหล่ง MCP config {source}",
    },
    NoFolder {
      en: "Open a folder first: project MCP servers belong to a folder",
      th: "เปิดโฟลเดอร์ก่อน — MCP server ของโปรเจกต์ผูกกับโฟลเดอร์",
    },
  }
}
