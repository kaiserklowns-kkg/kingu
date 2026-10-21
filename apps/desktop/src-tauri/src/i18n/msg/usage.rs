//! Plan usage of Orca's other agent providers in the status bar (usage/*.rs).

crate::i18n::messages! {
  pub enum UsageMsg {
    Network {
      en: "{provider} usage could not be refreshed because the network request failed",
      th: "อัปเดต usage ของ {provider} ไม่ได้เพราะเชื่อมต่อเครือข่ายไม่สำเร็จ",
    },
    RequestFailed {
      en: "{provider} usage request failed (HTTP {status})",
      th: "ขอ usage ของ {provider} ไม่สำเร็จ (HTTP {status})",
    },
    Unreadable {
      en: "{provider} usage data could not be read",
      th: "อ่านข้อมูล usage ของ {provider} ไม่ได้",
    },
    RateLimited {
      en: "{provider} usage is rate limited right now; will retry later",
      th: "usage ของ {provider} ถูกจำกัดการเรียกชั่วคราว จะลองใหม่ภายหลัง",
    },
    KeyRejected {
      en: "{provider} refused the sign-in Kingu read; sign in to {provider} again",
      th: "{provider} ไม่รับการลงชื่อเข้าใช้ที่ Kingu อ่านได้ ให้ลงชื่อเข้าใช้ {provider} ใหม่",
    },
    UnknownProvider {
      en: "{provider}: unknown usage provider",
      th: "{provider}: ไม่รู้จักผู้ให้บริการ usage นี้",
    },
    UnknownSecret {
      en: "{id}: not a usage provider credential",
      th: "{id}: ไม่ใช่ข้อมูลลงชื่อเข้าใช้ของผู้ให้บริการ usage",
    },
    OpencodeNotConfigured {
      en: "No OpenCode Go API key or session cookie is set up",
      th: "ยังไม่ได้ตั้ง API key หรือ session cookie ของ OpenCode Go",
    },
    OpencodeNoAuthCookie {
      en: "No auth cookie found: paste the full Cookie header from opencode.ai",
      th: "ไม่พบ auth cookie: วาง Cookie header ทั้งหมดจาก opencode.ai",
    },
    OpencodeKeyRejected {
      en: "The OpenCode Go API key was rejected: run /connect in OpenCode, or replace the key in Settings",
      th: "OpenCode Go ไม่รับ API key นี้: รัน /connect ใน OpenCode หรือเปลี่ยน key ในการตั้งค่า",
    },
    OpencodeNoSubscription {
      en: "This OpenCode account has no OpenCode Go subscription",
      th: "บัญชี OpenCode นี้ไม่มีแพ็กเกจ OpenCode Go",
    },
    OpencodeCookieRejected {
      en: "Usage fetch failed (401): paste the full Cookie header including __Host-console_session",
      th: "ดึง usage ไม่สำเร็จ (401): วาง Cookie header ทั้งหมดรวม __Host-console_session",
    },
    OpencodeBadWorkspace {
      en: "The OpenCode workspace id must look like org_…, wrk_… or wk_…",
      th: "workspace id ของ OpenCode ต้องเป็นรูปแบบ org_… wrk_… หรือ wk_…",
    },
    OpencodeNoWorkspace {
      en: "No OpenCode workspace found for this cookie: add an OpenCode Go API key or set a workspace id",
      th: "ไม่พบ workspace ของ OpenCode สำหรับ cookie นี้: เพิ่ม API key ของ OpenCode Go หรือตั้ง workspace id",
    },
    MinimaxNotConfigured {
      en: "No MiniMax API key or session cookie is set up",
      th: "ยังไม่ได้ตั้ง API key หรือ session cookie ของ MiniMax",
    },
    MinimaxNoToken {
      en: "MiniMax auth cookie not found: paste a Cookie header with _token",
      th: "ไม่พบ auth cookie ของ MiniMax: วาง Cookie header ที่มี _token",
    },
    MinimaxKeyExpired {
      en: "The MiniMax API key expired; replace it in Settings",
      th: "API key ของ MiniMax หมดอายุ ให้เปลี่ยนในการตั้งค่า",
    },
    MinimaxCookieExpired {
      en: "The MiniMax session cookie expired; replace it in Settings",
      th: "session cookie ของ MiniMax หมดอายุ ให้เปลี่ยนในการตั้งค่า",
    },
    MinimaxNoModel {
      en: "MiniMax usage for the configured model was not found",
      th: "ไม่พบ usage ของ MiniMax สำหรับโมเดลที่ตั้งไว้",
    },
    ZcodeNotConfigured {
      en: "No GLM Coding Plan API key is set up (in Settings or ZCode CLI)",
      th: "ยังไม่ได้ตั้ง API key ของ GLM Coding Plan (ในการตั้งค่าหรือใน ZCode CLI)",
    },
    ZcodeCliUnreadable {
      en: "ZCode CLI's config file could not be read",
      th: "อ่านไฟล์ตั้งค่าของ ZCode CLI ไม่ได้",
    },
    CursorSignedOut {
      en: "No Cursor sign-in on this computer: sign in with Cursor or `cursor-agent login`",
      th: "เครื่องนี้ยังไม่ได้ลงชื่อเข้าใช้ Cursor: ลงชื่อเข้าใช้ใน Cursor หรือรัน `cursor-agent login`",
    },
    CursorExpired {
      en: "Cursor sign-in expired: run `cursor-agent login` again",
      th: "การลงชื่อเข้าใช้ Cursor หมดอายุ: รัน `cursor-agent login` อีกครั้ง",
    },
    CursorUnreadable {
      en: "The Cursor sign-in could not be read",
      th: "อ่านการลงชื่อเข้าใช้ของ Cursor ไม่ได้",
    },
    CursorNoAllowance {
      en: "Cursor reported no usage allowance for this account",
      th: "Cursor ไม่ได้แจ้งโควตาของบัญชีนี้",
    },
    GrokSignedOut {
      en: "Not signed in to Grok: run grok login",
      th: "ยังไม่ได้ลงชื่อเข้าใช้ Grok: รัน grok login",
    },
    GrokUnreadable {
      en: "Grok's auth file could not be read",
      th: "อ่านไฟล์ลงชื่อเข้าใช้ของ Grok ไม่ได้",
    },
    GrokExpired {
      en: "Grok sign-in expired: run grok on this computer (sign in if it asks); usage updates after that",
      th: "การลงชื่อเข้าใช้ Grok หมดอายุ: รัน grok ในเครื่องนี้ (ลงชื่อเข้าใช้ถ้าถูกถาม) แล้ว usage จะอัปเดต",
    },
    GrokNoQuota {
      en: "Grok did not report a usage quota for this account",
      th: "Grok ไม่ได้แจ้งโควตาของบัญชีนี้",
    },
    KimiSignedOut {
      en: "Not signed in to Kimi Code",
      th: "ยังไม่ได้ลงชื่อเข้าใช้ Kimi Code",
    },
    KimiUnreadable {
      en: "Kimi's credentials file could not be read",
      th: "อ่านไฟล์ลงชื่อเข้าใช้ของ Kimi ไม่ได้",
    },
    KimiExpired {
      en: "Kimi session expired: run kimi on this computer, then refresh usage",
      th: "session ของ Kimi หมดอายุ: รัน kimi ในเครื่องนี้ แล้วรีเฟรช usage",
    },
    AntigravityMissing {
      en: "The Antigravity CLI (agy) was not found on this computer",
      th: "ไม่พบ Antigravity CLI (agy) ในเครื่องนี้",
    },
    AntigravityNotStarted {
      en: "The Antigravity CLI could not be started",
      th: "เริ่ม Antigravity CLI ไม่ได้",
    },
    AntigravityTooOld {
      en: "Antigravity usage needs agy 1.1.11 or newer; update agy",
      th: "usage ของ Antigravity ต้องใช้ agy 1.1.11 ขึ้นไป ให้อัปเดต agy",
    },
    AntigravityTimeout {
      en: "The Antigravity CLI did not answer in time",
      th: "Antigravity CLI ไม่ตอบภายในเวลาที่กำหนด",
    },
    AntigravityPrompt {
      en: "This agy answers /usage as a prompt instead of a command, so Kingu stopped asking rather than spend quota; update agy and restart Kingu",
      th: "agy รุ่นนี้ตอบ /usage เป็นข้อความถึงโมเดลแทนคำสั่ง Kingu จึงหยุดถามเพื่อไม่ให้เสียโควตา ให้อัปเดต agy แล้วเปิด Kingu ใหม่",
    },
    AntigravitySignedOut {
      en: "Sign in with agy to see this account's Antigravity quota",
      th: "ลงชื่อเข้าใช้ด้วย agy เพื่อดูโควตา Antigravity ของบัญชีนี้",
    },
    AntigravityNoSubscription {
      en: "This account is signed in but has no Antigravity quota",
      th: "บัญชีนี้ลงชื่อเข้าใช้แล้วแต่ไม่มีโควตา Antigravity",
    },
  }
}
