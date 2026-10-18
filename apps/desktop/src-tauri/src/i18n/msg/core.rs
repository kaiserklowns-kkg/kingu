//! The workbench core: image attachments, search, terminals, links, proxy (top-level src/*.rs).

crate::i18n::messages! {
  pub enum CoreMsg {
    // attachments.rs
    NoClipboardImage {
      en: "There is no image on the clipboard",
      th: "ไม่มีรูปในคลิปบอร์ด",
    },
    PasteTooLarge {
      en: "The image is too large (over 18 MB)",
      th: "รูปใหญ่เกินไป (เกิน 18 MB)",
    },
    NotAnImage {
      en: "Not a png, jpeg, gif or webp image",
      th: "ไม่ใช่รูป png, jpeg, gif หรือ webp",
    },
    TooManyImages {
      en: "You can attach at most {max} images per message",
      th: "แนบรูปได้ไม่เกิน {max} รูปต่อข้อความ",
    },
    NeedsAbsolutePath {
      en: "{path}: must be an absolute path",
      th: "{path}: ต้องเป็น path เต็ม",
    },
    ImageTypeOnly {
      en: "{name}: only png, jpeg, gif or webp images can be attached",
      th: "{name}: แนบได้เฉพาะรูป png, jpeg, gif หรือ webp",
    },
    NotAFile {
      en: "{name}: not a file",
      th: "{name}: ไม่ใช่ไฟล์",
    },
    ImageSize {
      en: "{name}: an image must not be empty and at most 5 MB",
      th: "{name}: รูปต้องไม่ว่างและไม่เกิน 5 MB",
    },
    ImageContent {
      en: "{name}: the file's content is not a supported image",
      th: "{name}: เนื้อไฟล์ไม่ใช่รูปที่รองรับ",
    },
    ImagesTotalTooLarge {
      en: "The attached images add up to more than 20 MB",
      th: "รูปที่แนบรวมกันเกิน 20 MB",
    },
    // search.rs
    RgOverrideMissing {
      en: "KINGU_RG={path}: ripgrep file not found",
      th: "KINGU_RG={path} ไม่พบไฟล์ ripgrep",
    },
    RgMissing {
      en: "ripgrep (rg) not found: install it with `brew install ripgrep` or set KINGU_RG to the path of rg",
      th: "ไม่พบ ripgrep (rg): ติดตั้งด้วย `brew install ripgrep` หรือตั้ง KINGU_RG เป็น path ของ rg",
    },
    // pty.rs
    DaemonDisconnected {
      en: "The terminal daemon disconnected",
      th: "terminal daemon หลุดการเชื่อมต่อ",
    },
    PtydOverrideMissing {
      en: "KINGU_PTYD={path}: file not found",
      th: "KINGU_PTYD={path}: ไม่พบไฟล์",
    },
    PtydMissing {
      en: "{name} not found next to the app (set KINGU_PTYD or run cargo build -p kingu-ptyd)",
      th: "ไม่พบ {name} ข้างตัวแอป (ตั้ง KINGU_PTYD หรือ cargo build -p kingu-ptyd)",
    },
    DaemonDirUnknown {
      en: "The daemon's folder is not known yet",
      th: "ยังไม่รู้โฟลเดอร์ของ daemon",
    },
    // terminal_links.rs, system.rs
    SchemeNotAllowed {
      en: "{scheme}: not in terminal.integrated.allowedLinkSchemes",
      th: "{scheme}: ไม่อยู่ใน terminal.integrated.allowedLinkSchemes",
    },
    SchemeBlocked {
      en: "{scheme}: cannot be opened from the terminal",
      th: "{scheme}: เปิดจาก terminal ไม่ได้",
    },
    HttpOnly {
      en: "{scheme}: only http/https links can be opened",
      th: "{scheme}: เปิดได้เฉพาะลิงก์ http/https",
    },
    // net_proxy.rs
    ProxyInvalid {
      en: "http.proxy is not valid: {detail}",
      th: "http.proxy ไม่ถูกต้อง: {detail}",
    },
    ProxyScheme {
      en: "http.proxy: scheme {scheme} is not supported (use http, https or socks5)",
      th: "http.proxy: ไม่รองรับ scheme {scheme} (ใช้ http, https หรือ socks5)",
    },
    ProxyNoHost {
      en: "http.proxy needs a host name",
      th: "http.proxy ต้องมีชื่อโฮสต์",
    },
    ProxyHasPath {
      en: "http.proxy must be scheme://host:port without a path",
      th: "http.proxy ต้องเป็น scheme://host:port ไม่มี path",
    },
    ProxyAuthHeader {
      en: "http.proxyAuthorization has characters that cannot be used in a header",
      th: "http.proxyAuthorization มีอักขระที่ใช้ใน header ไม่ได้",
    },
    // lib.rs
    NoTaskWorktree {
      en: "Worktree of task {slug} not found",
      th: "ไม่พบ worktree ของงาน {slug}",
    },
    // vault/mod.rs
    VaultNotASession {
      en: "That file is not a session of this agent",
      th: "ไฟล์นี้ไม่ใช่ session ของ agent นี้",
    },
  }
}
