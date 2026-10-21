//! More AI providers (accounts/managed.rs, accounts/providers/*): OpenCode and Devin managed
//! accounts, and the usage of Gemini, OpenCode Go, MiniMax, Grok, Cursor, Antigravity and ZCode.

crate::i18n::messages! {
  pub enum ProvidersMsg {
    UnknownDataProvider {
      en: "Use --agent opencode or --agent devin.",
      th: "ใช้ --agent opencode หรือ --agent devin",
    },
    BadLabel {
      en: "--label must contain 1–120 characters.",
      th: "--label ต้องยาว 1–120 ตัวอักษร",
    },
    AccountLimit {
      en: "Managed account limit reached.",
      th: "จำนวนบัญชี managed ครบแล้ว",
    },
    AccountNotFound {
      en: "Managed account not found.",
      th: "ไม่พบบัญชี managed",
    },
    BadState {
      en: "Could not read the managed accounts of {provider}: {detail}",
      th: "อ่านบัญชี managed ของ {provider} ไม่ได้: {detail}",
    },
    SaveFailed {
      en: "Could not save the managed accounts: {detail}",
      th: "บันทึกบัญชี managed ไม่สำเร็จ: {detail}",
    },
    DevinNoCredentials {
      en: "Devin login did not save supported credentials.",
      th: "การ login ของ Devin ไม่ได้บันทึก credential ที่รองรับ",
    },
    DevinBadFormat {
      en: "Unsupported Devin credential format.",
      th: "รูปแบบ credential ของ Devin ไม่รองรับ",
    },
    OpencodeBadDb {
      en: "Unsupported OpenCode credential database.",
      th: "ฐานข้อมูล credential ของ OpenCode ไม่รองรับ",
    },
    OpencodeHasSessions {
      en: "Use an isolated OpenCode login directory; importing conversation databases is not supported.",
      th: "ใช้โฟลเดอร์ login ของ OpenCode ที่แยกไว้ การนำเข้าฐานข้อมูลที่มีบทสนทนาไม่รองรับ",
    },
    OpencodeNoCredential {
      en: "OpenCode login did not save a supported credential.",
      th: "การ login ของ OpenCode ไม่ได้บันทึก credential ที่รองรับ",
    },
    OpencodeBadCredential {
      en: "Unsupported OpenCode credential format.",
      th: "รูปแบบ credential ของ OpenCode ไม่รองรับ",
    },
    Sqlite {
      en: "Could not read the OpenCode database: {detail}",
      th: "อ่านฐานข้อมูลของ OpenCode ไม่ได้: {detail}",
    },
    CopyFailed {
      en: "Could not store the login of the new account: {detail}",
      th: "เก็บ login ของบัญชีใหม่ไม่สำเร็จ: {detail}",
    },
    RemoveFailed {
      en: "Could not remove the account folder: {detail}",
      th: "ลบโฟลเดอร์ของบัญชีไม่สำเร็จ: {detail}",
    },
    AgyChanged {
      en: "The Antigravity credential changed during selection; refresh before retrying.",
      th: "credential ของ Antigravity เปลี่ยนระหว่างเลือก รีเฟรชก่อนลองใหม่",
    },
    AgyKeychain {
      en: "Could not use the Antigravity login in the macOS Keychain.",
      th: "ใช้ login ของ Antigravity ใน macOS Keychain ไม่ได้",
    },
    AgyKeyringUnavailable {
      en: "agy has no keyring on this computer, so its account cannot be switched here.",
      th: "agy ไม่มี keyring บนเครื่องนี้ จึงสลับบัญชีที่นี่ไม่ได้",
    },
    AgyMissing {
      en: "Antigravity usage is not available. The Antigravity CLI (`agy`) was not found on this machine.",
      th: "ดูการใช้งาน Antigravity ไม่ได้ ไม่พบ Antigravity CLI (`agy`) บนเครื่องนี้",
    },
    AgyNoCurrent {
      en: "Sign in with agy on this computer, then save the current account.",
      th: "login ด้วย agy บนเครื่องนี้ก่อน แล้วค่อยบันทึกบัญชีปัจจุบัน",
    },
    AgyNoIdentity {
      en: "The current Antigravity credential has no stable Google identity; it cannot be saved for switching.",
      th: "credential ของ Antigravity ตอนนี้ไม่มีตัวตน Google ที่แน่นอน จึงบันทึกไว้สลับไม่ได้",
    },
    AgyNoQuota {
      en: "Antigravity usage is not available. The Antigravity CLI did not report a quota (exit {code}).",
      th: "ดูการใช้งาน Antigravity ไม่ได้ Antigravity CLI ไม่ได้รายงานโควตา (exit {code})",
    },
    AgyNotEntitled {
      en: "Antigravity usage is not available. This account is signed in but not entitled to Antigravity quota.",
      th: "ดูการใช้งาน Antigravity ไม่ได้ บัญชีนี้ login แล้วแต่ไม่มีสิทธิ์ใช้โควตา Antigravity",
    },
    AgyNotStarted {
      en: "Antigravity usage is not available. The Antigravity CLI could not be started: {detail}.",
      th: "ดูการใช้งาน Antigravity ไม่ได้ เปิด Antigravity CLI ไม่ได้: {detail}",
    },
    AgyNotVerified {
      en: "Antigravity account switching could not be verified; refresh before retrying.",
      th: "ยืนยันการสลับบัญชี Antigravity ไม่ได้ รีเฟรชก่อนลองใหม่",
    },
    AgyNoVersion {
      en: "Antigravity usage is unavailable because the agy CLI version could not be read. Update agy to 1.1.11 or newer.",
      th: "ดูการใช้งาน Antigravity ไม่ได้เพราะอ่านเวอร์ชันของ agy ไม่ได้ อัปเดต agy เป็น 1.1.11 ขึ้นไป",
    },
    AgyRateLimited {
      en: "Antigravity usage is not available. The Antigravity API is rate-limiting this account.",
      th: "ดูการใช้งาน Antigravity ไม่ได้ Antigravity API กำลังจำกัดการเรียกของบัญชีนี้",
    },
    AgySelectOther {
      en: "Select another Antigravity account before removing this account.",
      th: "เลือกบัญชี Antigravity อื่นก่อนลบบัญชีนี้",
    },
    AgyServer {
      en: "Antigravity usage is not available. The Antigravity API returned a server error.",
      th: "ดูการใช้งาน Antigravity ไม่ได้ Antigravity API ตอบกลับเป็น server error",
    },
    AgySignedOut {
      en: "Antigravity usage is not available. Sign in with `agy` to report this account's quota.",
      th: "ดูการใช้งาน Antigravity ไม่ได้ login ด้วย `agy` เพื่อดูโควตาของบัญชีนี้",
    },
    AgyTimeout {
      en: "Antigravity usage is not available. The Antigravity CLI did not answer in time.",
      th: "ดูการใช้งาน Antigravity ไม่ได้ Antigravity CLI ไม่ตอบภายในเวลา",
    },
    AgyTokenFileUnsafe {
      en: "agy's token file can be read by other users or is too large; Kingu does not use it.",
      th: "ไฟล์ token ของ agy ผู้ใช้อื่นอ่านได้หรือใหญ่เกินไป Kingu จึงไม่ใช้",
    },
    AgyTooLarge {
      en: "The saved Antigravity credential is too large to store.",
      th: "credential ของ Antigravity ที่บันทึกไว้ใหญ่เกินกว่าจะเก็บได้",
    },
    AgyTooOld {
      en: "Antigravity usage needs agy 1.1.11 or newer (found {version}). Update the agy CLI to show quota in the status bar.",
      th: "ดูการใช้งาน Antigravity ต้องใช้ agy 1.1.11 ขึ้นไป (พบ {version}) อัปเดต agy เพื่อแสดงโควตาในแถบสถานะ",
    },
    AgyTurnSpent {
      en: "Antigravity usage is not available. This version of the Antigravity CLI answers `/usage` as a prompt instead of a command, so Kingu stopped asking rather than spend quota on it. Update `agy` and restart Kingu.",
      th: "ดูการใช้งาน Antigravity ไม่ได้ Antigravity CLI เวอร์ชันนี้ตอบ `/usage` เป็น prompt แทนคำสั่ง Kingu จึงหยุดถามเพื่อไม่ให้เสียโควตา อัปเดต `agy` แล้วเปิด Kingu ใหม่",
    },
    CursorAuthInvalid {
      en: "Cursor CLI auth file is invalid",
      th: "ไฟล์ auth ของ Cursor CLI ไม่ถูกต้อง",
    },
    CursorAuthUnreadable {
      en: "Unable to read the Cursor CLI auth file",
      th: "อ่านไฟล์ auth ของ Cursor CLI ไม่ได้",
    },
    CursorExpired {
      en: "Cursor sign-in expired — run `cursor-agent login` again",
      th: "login ของ Cursor หมดอายุ รัน `cursor-agent login` อีกครั้ง",
    },
    CursorHttp {
      en: "Cursor usage request failed (HTTP {status})",
      th: "ขอข้อมูลการใช้งาน Cursor ไม่สำเร็จ (HTTP {status})",
    },
    CursorKeychain {
      en: "Unable to read the Cursor login from the macOS Keychain",
      th: "อ่าน login ของ Cursor จาก macOS Keychain ไม่ได้",
    },
    CursorNoAllowance {
      en: "Cursor reported no usage allowance for this account",
      th: "Cursor ไม่ได้รายงานโควตาของบัญชีนี้",
    },
    CursorNoLogin {
      en: "No Cursor sign-in on this computer — sign in with Cursor IDE or `cursor-agent login`",
      th: "ไม่พบ login ของ Cursor บนเครื่องนี้ login ด้วย Cursor IDE หรือ `cursor-agent login`",
    },
    CursorParse {
      en: "Cursor usage response could not be parsed",
      th: "อ่านข้อมูลการใช้งาน Cursor ไม่ได้",
    },
    CursorRateLimited {
      en: "Cursor usage is rate limited right now",
      th: "Cursor จำกัดการขอข้อมูลการใช้งานอยู่ตอนนี้",
    },
    CursorRequestFailed {
      en: "Cursor usage request failed",
      th: "ขอข้อมูลการใช้งาน Cursor ไม่สำเร็จ",
    },
    GeminiNoCredentials {
      en: "Gemini CLI credentials not found",
      th: "ไม่พบ credential ของ Gemini CLI",
    },
    GeminiNoProject {
      en: "Gemini project ID not found",
      th: "ไม่พบ project ID ของ Gemini",
    },
    GeminiOff {
      en: "Gemini CLI OAuth is disabled in settings",
      th: "ปิดการใช้ OAuth ของ Gemini CLI ไว้ในการตั้งค่า",
    },
    GeminiQuotaFailed {
      en: "Quota fetch failed ({status})",
      th: "ดึงโควตาไม่สำเร็จ ({status})",
    },
    GeminiRefreshFailed {
      en: "Token refresh failed",
      th: "refresh token ไม่สำเร็จ",
    },
    GrokAuthInvalid {
      en: "Grok auth file is invalid",
      th: "ไฟล์ auth ของ Grok ไม่ถูกต้อง",
    },
    GrokAuthUnreadable {
      en: "Unable to read Grok auth file",
      th: "อ่านไฟล์ auth ของ Grok ไม่ได้",
    },
    GrokExpired {
      en: "Grok sign-in expired — run grok on the computer running Kingu; sign in if prompted. No chat message is needed.",
      th: "login ของ Grok หมดอายุ รัน grok บนเครื่องที่เปิด Kingu และ login ถ้าถูกถาม ไม่ต้องส่งข้อความแชท",
    },
    GrokFailed {
      en: "Grok usage request failed (HTTP {status})",
      th: "ขอข้อมูลการใช้งาน Grok ไม่สำเร็จ (HTTP {status})",
    },
    GrokNoConfig {
      en: "Grok billing response did not include config",
      th: "ข้อมูล billing ของ Grok ไม่มี config",
    },
    GrokNoCredits {
      en: "Grok billing response did not include credit usage",
      th: "ข้อมูล billing ของ Grok ไม่มีการใช้เครดิต",
    },
    GrokNoPercent {
      en: "Grok did not report a usage percentage for this account",
      th: "Grok ไม่ได้รายงานเปอร์เซ็นต์การใช้งานของบัญชีนี้",
    },
    GrokSignedOut {
      en: "Not signed in to Grok — run grok login",
      th: "ยังไม่ได้ login Grok รัน grok login",
    },
    GrokUnauthorized {
      en: "Grok usage request unauthorized (HTTP {status})",
      th: "ขอข้อมูลการใช้งาน Grok ไม่ได้รับอนุญาต (HTTP {status})",
    },
    MinimaxBadResponse {
      en: "Invalid MiniMax usage response",
      th: "ข้อมูลการใช้งาน MiniMax ไม่ถูกต้อง",
    },
    MinimaxCookieExpired {
      en: "MiniMax session cookie expired. Replace it in Settings.",
      th: "session cookie ของ MiniMax หมดอายุ เปลี่ยนใหม่ในการตั้งค่า",
    },
    MinimaxError {
      en: "MiniMax returned an error",
      th: "MiniMax ตอบกลับเป็น error",
    },
    MinimaxFailed {
      en: "MiniMax usage fetch failed ({status})",
      th: "ดึงการใช้งาน MiniMax ไม่สำเร็จ ({status})",
    },
    MinimaxKeyExpired {
      en: "MiniMax API key expired. Replace it in Settings.",
      th: "API key ของ MiniMax หมดอายุ เปลี่ยนใหม่ในการตั้งค่า",
    },
    MinimaxNoModel {
      en: "MiniMax usage data for the configured model was not found",
      th: "ไม่พบข้อมูลการใช้งานของโมเดลที่ตั้งไว้ใน MiniMax",
    },
    MinimaxNotConfigured {
      en: "MiniMax session cookie not configured",
      th: "ยังไม่ได้ตั้ง session cookie ของ MiniMax",
    },
    MinimaxNoToken {
      en: "MiniMax auth cookie not found — paste a Cookie header with _token",
      th: "ไม่พบ cookie auth ของ MiniMax วาง Cookie header ที่มี _token",
    },
    OpencodeGo401 {
      en: "Usage fetch failed (401) — paste the full Cookie header including __Host-console_session (auth alone is not enough)",
      th: "ดึงการใช้งานไม่สำเร็จ (401) วาง Cookie header ทั้งหมดรวม __Host-console_session (auth อย่างเดียวไม่พอ)",
    },
    OpencodeGoBadWorkspace {
      en: "Invalid workspace ID format: must match ^(org|wrk|wk)_[A-Za-z0-9]+$",
      th: "รูปแบบ workspace ID ไม่ถูกต้อง ต้องตรงกับ ^(org|wrk|wk)_[A-Za-z0-9]+$",
    },
    OpencodeGoFailed {
      en: "OpenCode Go usage request failed ({status})",
      th: "ขอข้อมูลการใช้งาน OpenCode Go ไม่สำเร็จ ({status})",
    },
    OpencodeGoKeyRejected {
      en: "The OpenCode Go API key was rejected. Run /connect in OpenCode, or replace the key in Settings.",
      th: "API key ของ OpenCode Go ถูกปฏิเสธ รัน /connect ใน OpenCode หรือเปลี่ยน key ในการตั้งค่า",
    },
    OpencodeGoNoAuthCookie {
      en: "No auth cookie found — paste the full Cookie header from opencode.ai DevTools",
      th: "ไม่พบ cookie auth วาง Cookie header ทั้งหมดจาก DevTools ของ opencode.ai",
    },
    OpencodeGoNone {
      en: "No OpenCode Go API key or session cookie configured",
      th: "ยังไม่ได้ตั้ง API key หรือ session cookie ของ OpenCode Go",
    },
    OpencodeGoNoSubscription {
      en: "This OpenCode account has no OpenCode Go subscription. Subscribe at opencode.ai to see Go usage.",
      th: "บัญชี OpenCode นี้ไม่มี subscription ของ OpenCode Go สมัครที่ opencode.ai เพื่อดูการใช้งาน Go",
    },
    OpencodeGoNoWorkspace {
      en: "No workspace found for this cookie — add an OpenCode Go API key (or run /connect in OpenCode), or set a Workspace ID override",
      th: "ไม่พบ workspace ของ cookie นี้ เพิ่ม API key ของ OpenCode Go (หรือรัน /connect ใน OpenCode) หรือกำหนด Workspace ID เอง",
    },
    OpencodeGoParse {
      en: "Could not parse usage data",
      th: "อ่านข้อมูลการใช้งานไม่ได้",
    },
    OpencodeGoParseAny {
      en: "Could not parse usage data from any available workspace",
      th: "อ่านข้อมูลการใช้งานจาก workspace ไหนก็ไม่ได้",
    },
    OpencodeGoUsageFailed {
      en: "Usage fetch failed ({status})",
      th: "ดึงการใช้งานไม่สำเร็จ ({status})",
    },
    OpencodeGoWorkspacesFailed {
      en: "Workspaces fetch failed ({status})",
      th: "ดึงรายการ workspace ไม่สำเร็จ ({status})",
    },
    ZcodeCliUnreadable {
      en: "Could not read the selected ZCode CLI Coding Plan credential",
      th: "อ่าน credential Coding Plan ของ ZCode CLI ที่เลือกไว้ไม่ได้",
    },
    ZcodeFailed {
      en: "ZCode quota request failed ({status})",
      th: "ขอโควตา ZCode ไม่สำเร็จ ({status})",
    },
    ZcodeInvalid {
      en: "Invalid ZCode quota response",
      th: "ข้อมูลโควตาของ ZCode ไม่ถูกต้อง",
    },
    ZcodeNoLimits {
      en: "ZCode quota response contained no usable limits",
      th: "ข้อมูลโควตาของ ZCode ไม่มีขีดจำกัดที่ใช้ได้",
    },
    ZcodeNotConfigured {
      en: "ZCode Coding Plan credentials are not configured",
      th: "ยังไม่ได้ตั้ง credential ของ ZCode Coding Plan",
    },
    ZcodeParse {
      en: "Could not parse ZCode quota response",
      th: "อ่านข้อมูลโควตาของ ZCode ไม่ได้",
    },
    CredentialEmpty {
      en: "The credential is empty or not a single line.",
      th: "credential ว่างหรือมีหลายบรรทัด",
    },
    UnknownCredential {
      en: "Unknown provider credential.",
      th: "ไม่รู้จัก credential นี้",
    },
  }
}
