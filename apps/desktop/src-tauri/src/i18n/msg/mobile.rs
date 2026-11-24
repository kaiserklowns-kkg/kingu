//! Mobile pairing (mobile.rs): errors for the desktop and the phone, and the phone page's words.

crate::i18n::messages! {
  pub enum MobileMsg {
    NotEnabled {
      en: "Mobile access is off: turn it on first",
      th: "ยังปิดการเข้าถึงจากมือถืออยู่ เปิดก่อน",
    },
    NoRandom {
      en: "Could not make a secure random code: {detail}",
      th: "สร้างรหัสสุ่มที่ปลอดภัยไม่ได้: {detail}",
    },
    BindFailed {
      en: "Could not start the mobile server on port {port}: {detail}",
      th: "เปิดเซิร์ฟเวอร์สำหรับมือถือที่พอร์ต {port} ไม่ได้: {detail}",
    },
    BadAddress {
      en: "{address} is not an IPv4 address",
      th: "{address} ไม่ใช่ที่อยู่ IPv4",
    },
    NoNetwork {
      en: "No network address found: connect to Wi-Fi (or Tailscale), or type this computer's address",
      th: "ไม่พบที่อยู่เครือข่าย เชื่อมต่อ Wi-Fi (หรือ Tailscale) หรือพิมพ์ที่อยู่ของเครื่องนี้เอง",
    },
    SaveFailed {
      en: "Could not save the paired devices: {detail}",
      th: "บันทึกรายการอุปกรณ์ที่จับคู่ไม่ได้: {detail}",
    },
    QrFailed {
      en: "Could not draw the QR code: {detail}",
      th: "สร้าง QR code ไม่ได้: {detail}",
    },
    NoWindow {
      en: "Open this project in a Kingu window to send messages to its agents",
      th: "เปิดโปรเจกต์นี้ในหน้าต่าง Kingu ก่อน จึงจะส่งข้อความถึง agent ได้",
    },
    WindowNoAnswer {
      en: "Kingu did not answer in time",
      th: "Kingu ไม่ตอบกลับภายในเวลาที่กำหนด",
    },
    UnknownTask {
      en: "Task {slug} was not found",
      th: "ไม่พบงาน {slug}",
    },
    UnknownProject {
      en: "This project is not in Kingu's project list",
      th: "โปรเจกต์นี้ไม่อยู่ในรายการโปรเจกต์ของ Kingu",
    },
    EmptyMessage {
      en: "Write a message first",
      th: "พิมพ์ข้อความก่อน",
    },
    MessageTooLong {
      en: "The message is too long (at most {max} characters)",
      th: "ข้อความยาวเกินไป (ไม่เกิน {max} ตัวอักษร)",
    },
    Unauthorized {
      en: "This device is not paired, or it was removed: pair it again from Kingu",
      th: "อุปกรณ์นี้ยังไม่ได้จับคู่ หรือถูกถอดออกแล้ว จับคู่ใหม่จาก Kingu",
    },
    BadCode {
      en: "Wrong or expired pairing code",
      th: "รหัสจับคู่ไม่ถูกต้องหรือหมดอายุแล้ว",
    },
    CodeUsedUp {
      en: "Too many wrong codes: make a new code in Kingu",
      th: "ใส่รหัสผิดหลายครั้งเกินไป สร้างรหัสใหม่ใน Kingu",
    },
    BadRequest {
      en: "Bad request",
      th: "คำขอไม่ถูกต้อง",
    },
    NotFound {
      en: "Not found",
      th: "ไม่พบ",
    },
    NothingToAnswer {
      en: "The agent is not waiting for this answer any more",
      th: "agent ไม่ได้รอคำตอบนี้แล้ว",
    },
  }
}

// The phone page (mobile_web.html): sent with the page as one JSON table, in Kingu's language.
crate::i18n::messages! {
  pub enum MobileWebMsg {
    PairTitle {
      en: "Pair with Kingu",
      th: "จับคู่กับ Kingu",
    },
    PairHint {
      en: "Scan the QR code in Kingu (Mobile: Pair Device…), or type the code shown there.",
      th: "สแกน QR code ใน Kingu (Mobile: Pair Device…) หรือพิมพ์รหัสที่แสดงอยู่",
    },
    Pair {
      en: "Pair",
      th: "จับคู่",
    },
    Pairing {
      en: "Pairing…",
      th: "กำลังจับคู่…",
    },
    Tasks {
      en: "Tasks",
      th: "งาน",
    },
    Refresh {
      en: "Refresh",
      th: "รีเฟรช",
    },
    NoTasks {
      en: "No tasks yet",
      th: "ยังไม่มีงาน",
    },
    Back {
      en: "Back",
      th: "กลับ",
    },
    Send {
      en: "Send",
      th: "ส่ง",
    },
    Sending {
      en: "Sending…",
      th: "กำลังส่ง…",
    },
    Sent {
      en: "Sent to the agent",
      th: "ส่งถึง agent แล้ว",
    },
    MessagePlaceholder {
      en: "Message to the agent",
      th: "ข้อความถึง agent",
    },
    NotOpen {
      en: "Open this project in Kingu to send messages",
      th: "เปิดโปรเจกต์นี้ใน Kingu ก่อนจึงจะส่งข้อความได้",
    },
    Offline {
      en: "Can't reach Kingu. Is it running, with mobile access on?",
      th: "ติดต่อ Kingu ไม่ได้ เปิด Kingu และเปิดการเข้าถึงจากมือถืออยู่หรือไม่",
    },
    Forget {
      en: "Forget this device",
      th: "ลืมอุปกรณ์นี้",
    },
    Prompt {
      en: "Instructions",
      th: "คำสั่ง",
    },
    LastRun {
      en: "Last run",
      th: "รอบล่าสุด",
    },
    Sleeping {
      en: "sleeping",
      th: "พักอยู่",
    },
    StatusRunning {
      en: "Running",
      th: "กำลังทำงาน",
    },
    StatusWaiting {
      en: "Needs you",
      th: "รอคุณตอบ",
    },
    StatusReview {
      en: "Ready for review",
      th: "พร้อมให้ตรวจ",
    },
    StatusDone {
      en: "Done",
      th: "เสร็จแล้ว",
    },
    StatusFailed {
      en: "Failed",
      th: "ล้มเหลว",
    },
    PermissionTitle {
      en: "Permission needed",
      th: "ขออนุญาต",
    },
    PermissionHint {
      en: "Allow presses Enter on the agent's highlighted choice (usually \"Yes\"); Deny presses Esc.",
      th: "อนุญาต = กด Enter ที่ตัวเลือกที่ agent ไฮไลต์ไว้ (ปกติคือ \"Yes\") ส่วนปฏิเสธ = กด Esc",
    },
    PermissionHintHeld {
      en: "Your answer goes to the agent as its own allow / deny decision.",
      th: "คำตอบนี้ส่งถึง agent เป็นการอนุญาต / ปฏิเสธของมันเอง",
    },
    Allow {
      en: "Allow once",
      th: "อนุญาตครั้งนี้",
    },
    AllowSession {
      en: "Allow for this session",
      th: "อนุญาตตลอด session นี้",
    },
    AllowProject {
      en: "Always allow in this project",
      th: "อนุญาตเสมอในโปรเจกต์นี้",
    },
    AllowUser {
      en: "Always allow",
      th: "อนุญาตเสมอ",
    },
    AlwaysRules {
      en: "\"Always allow\" has Claude save these rules to its settings (this project's local settings, or your user settings), for later sessions too. Revoke them on the desktop: Agents: Permission Grants.",
      th: "\"อนุญาตเสมอ\" จะให้ Claude บันทึกกฎต่อไปนี้ลงการตั้งค่า (การตั้งค่า local ของโปรเจกต์นี้ หรือการตั้งค่าผู้ใช้) ใช้กับ session ถัดไปด้วย ยกเลิกได้บนเดสก์ท็อปที่ Agents: Permission Grants",
    },
    TrackedProject {
      en: "Git would track this project's settings file: a commit would share the rule.",
      th: "git จะติดตามไฟล์การตั้งค่าของโปรเจกต์นี้: ถ้า commit กฎนี้จะถูกแชร์ออกไป",
    },
    TrackedUser {
      en: "Git would track your user settings file: a commit would share the rule.",
      th: "git จะติดตามไฟล์การตั้งค่าผู้ใช้ของคุณ: ถ้า commit กฎนี้จะถูกแชร์ออกไป",
    },
    SessionGrants {
      en: "Allowing for this session also grants, until the agent exits:",
      th: "อนุญาตตลอด session นี้จะให้สิทธิ์ต่อไปนี้ด้วย จนกว่า agent จะปิด:",
    },
    GrantRule {
      en: "Run without asking",
      th: "ใช้ได้โดยไม่ถาม",
    },
    GrantDir {
      en: "Work in the folder",
      th: "ทำงานในโฟลเดอร์",
    },
    GrantMode {
      en: "Edit files without asking",
      th: "แก้ไฟล์ได้โดยไม่ถาม",
    },
    Unsandboxed {
      en: "This command asks to run outside the agent's sandbox.",
      th: "คำสั่งนี้ขอรันนอก sandbox ของ agent",
    },
    DenyReason {
      en: "Why not? (optional, told to the agent)",
      th: "เหตุผลที่ปฏิเสธ (ไม่บังคับ จะบอก agent)",
    },
    Deny {
      en: "Deny",
      th: "ปฏิเสธ",
    },
    QuestionTitle {
      en: "The agent asks",
      th: "agent ถามว่า",
    },
    OtherAnswer {
      en: "Or type your own answer",
      th: "หรือพิมพ์คำตอบเอง",
    },
    SendAnswer {
      en: "Answer",
      th: "ตอบ",
    },
    Answered {
      en: "Answered",
      th: "ตอบแล้ว",
    },
  }
}
