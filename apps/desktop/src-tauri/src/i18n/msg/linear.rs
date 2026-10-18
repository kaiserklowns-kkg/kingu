//! Linear issues (linear.rs).

crate::i18n::messages! {
  pub enum LinearMsg {
    NotConnected {
      en: "Linear is not connected: run Linear: Connect and paste a personal API key",
      th: "ยังไม่ได้เชื่อมต่อ Linear: รันคำสั่ง Linear: Connect แล้ววาง personal API key",
    },
    AuthFailed {
      en: "Linear rejected this API key (revoked or invalid): reconnect with Linear: Connect",
      th: "Linear ไม่รับ API key นี้ (ถูกเพิกถอนหรือไม่ถูกต้อง): เชื่อมต่อใหม่ด้วย Linear: Connect",
    },
    Timeout {
      en: "Linear did not respond in time",
      th: "Linear ไม่ตอบภายในเวลาที่กำหนด",
    },
    Connect {
      en: "Could not connect to Linear; check your internet connection ({detail})",
      th: "เชื่อมต่อ Linear ไม่ได้ ตรวจสอบอินเทอร์เน็ต ({detail})",
    },
    RateLimited {
      en: "Linear is temporarily rate limiting requests; try again in a moment",
      th: "Linear จำกัดจำนวนคำขอชั่วคราว ลองใหม่ในอีกสักครู่",
    },
    ServerError {
      en: "Linear is having problems (HTTP {status}); try again later",
      th: "Linear ขัดข้อง (HTTP {status}) ลองใหม่ภายหลัง",
    },
    BadResponse {
      en: "Linear: could not read the response (HTTP {status})",
      th: "Linear: อ่านผลไม่ได้ (HTTP {status})",
    },
    /// Stands in for a GraphQL error without a message.
    Failed {
      en: "failed",
      th: "ล้มเหลว",
    },
    IssueNotFound {
      en: "Issue not found in Linear (or you don't have access)",
      th: "ไม่พบ issue นี้ใน Linear (หรือไม่มีสิทธิ์เข้าถึง)",
    },
    NoData {
      en: "Linear: the response has no data",
      th: "Linear: ผลไม่มีข้อมูล",
    },
    NoViewer {
      en: "Linear: user data not found",
      th: "Linear: ไม่พบข้อมูลผู้ใช้",
    },
    NoIdentifier {
      en: "Linear: the issue has no identifier",
      th: "Linear: issue ไม่มี identifier",
    },
    NotIssueList {
      en: "Linear: the response is not a list of issues",
      th: "Linear: ผลไม่ใช่รายการ issue",
    },
    BadTeamKey {
      en: "Invalid Linear team key: {team}",
      th: "team key ของ Linear ไม่ถูกต้อง: {team}",
    },
    BadFilter {
      en: "Invalid Linear issue filter: {filter}",
      th: "ตัวกรอง issue ของ Linear ไม่ถูกต้อง: {filter}",
    },
    NoIssueList {
      en: "Linear: the response has no issue list",
      th: "Linear: ผลไม่มีรายการ issue",
    },
    BadIssueId {
      en: "Invalid Linear issue id: {id}",
      th: "รหัส issue ของ Linear ไม่ถูกต้อง: {id}",
    },
    CommentLength {
      en: "The comment must be 1-{max} bytes long",
      th: "ข้อความ comment ต้องยาว 1-{max} bytes",
    },
    CommentNotSaved {
      en: "Linear did not save the comment",
      th: "Linear ไม่ได้บันทึก comment",
    },
    OnlyLinearLinks {
      en: "Only https://linear.app links can be opened",
      th: "เปิดได้เฉพาะลิงก์ https://linear.app",
    },
    BadKey {
      en: "Invalid API key: create one in Linear > Settings > Security & access > Personal API keys",
      th: "API key ไม่ถูกต้อง: สร้างได้ที่ Linear > Settings > Security & access > Personal API keys",
    },
    SaveKeyFailed {
      en: "Could not save the API key to the Keychain: {detail}",
      th: "บันทึก API key ลง Keychain ไม่สำเร็จ: {detail}",
    },
    DeleteKeyFailed {
      en: "Could not remove the API key from the Keychain: {detail}",
      th: "ลบ API key จาก Keychain ไม่สำเร็จ: {detail}",
    },
  }
}
