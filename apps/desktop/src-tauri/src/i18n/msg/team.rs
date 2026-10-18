//! Team server: sign-in, sync, events and team-approved snaps (team/*).

crate::i18n::messages! {
  pub enum TeamMsg {
    BadServerUrl {
      en: "Invalid server URL: {detail}",
      th: "server URL ไม่ถูกต้อง: {detail}",
    },
    UrlNeedsHost {
      en: "The server URL needs a host name",
      th: "server URL ต้องมีชื่อโฮสต์",
    },
    HttpsRequired {
      en: "HTTPS is required (HTTP is allowed only for localhost)",
      th: "ต้องใช้ HTTPS (อนุญาต HTTP เฉพาะ localhost)",
    },
    UnsupportedScheme {
      en: "Unsupported scheme {scheme}",
      th: "ไม่รองรับ scheme {scheme}",
    },
    UrlHasCredentials {
      en: "The server URL must not contain a user name or password",
      th: "server URL ต้องไม่มีชื่อผู้ใช้/รหัสผ่าน",
    },
    UrlHasQuery {
      en: "The server URL must not have a query or fragment",
      th: "server URL ต้องไม่มี query หรือ fragment",
    },
    NotEventStream {
      en: "The server did not answer with an event stream",
      th: "เซิร์ฟเวอร์ไม่ได้ตอบเป็น event stream",
    },
    BadTokenFormat {
      en: "The token must start with kgu_ and be 47 characters long",
      th: "token ต้องขึ้นต้นด้วย kgu_ และยาว 47 ตัวอักษร",
    },
    TokenRejected {
      en: "The token is invalid, expired or revoked",
      th: "token ไม่ถูกต้อง หมดอายุ หรือถูกเพิกถอน",
    },
    Unreachable {
      en: "Could not connect to the team server: {detail}",
      th: "เชื่อมต่อเซิร์ฟเวอร์ทีมไม่ได้: {detail}",
    },
    BadResponse {
      en: "The server answered with an invalid response: {detail}",
      th: "เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง: {detail}",
    },
    SaveTokenFailed {
      en: "Could not save the token to the Keychain: {detail}",
      th: "บันทึก token ลง Keychain ไม่สำเร็จ: {detail}",
    },
    BadProjectId {
      en: "kingu.team.project must be a project id (uuid) from the team server",
      th: "kingu.team.project ต้องเป็น project id (uuid) จากเซิร์ฟเวอร์ทีม",
    },
    BadSnapList {
      en: "Could not read the team's snap list: {detail}",
      th: "รายการ snap ของทีมอ่านไม่ได้: {detail}",
    },
    ApproveUserSnapsOnly {
      en: "Only snaps installed on your machine can be approved for the team (not repo snaps)",
      th: "อนุมัติให้ทีมได้เฉพาะ snap ที่ติดตั้งไว้ในเครื่องคุณ (ไม่ใช่ snap ของ repo)",
    },
    SnapHasError {
      en: "Snap \"{id}\" has an error and cannot be approved: {detail}",
      th: "snap \"{id}\" มีข้อผิดพลาด อนุมัติไม่ได้: {detail}",
    },
    SnapNotFromGit {
      en: "Snap \"{id}\" was not installed from git, so it cannot be approved for the team",
      th: "snap \"{id}\" ไม่ได้ติดตั้งจาก git จึงอนุมัติให้ทีมไม่ได้",
    },
    SnapFromLocalPath {
      en: "Snap \"{id}\" was installed from a local path that others on the team cannot fetch — install it from https:// or ssh first, then approve it",
      th: "snap \"{id}\" ติดตั้งจาก path ในเครื่อง คนอื่นในทีมดึงไม่ได้ — ติดตั้งจาก https:// หรือ ssh ก่อนแล้วค่อยอนุมัติ",
    },
    SnapCommitUnknown {
      en: "The commit of snap \"{id}\" is unknown — update or reinstall it first",
      th: "ไม่รู้ commit ของ snap \"{id}\" — อัปเดตหรือติดตั้งใหม่ก่อน",
    },
    SnapHashUnreadable {
      en: "Could not read the hash of snap \"{id}\"",
      th: "อ่าน hash ของ snap \"{id}\" ไม่ได้",
    },
    NoteTooLong {
      en: "The note must be a single line of at most {max} characters",
      th: "หมายเหตุต้องเป็นบรรทัดเดียว ยาวไม่เกิน {max} ตัวอักษร",
    },
    NotSignedIn {
      en: "Not signed in to the team — run Sign in to Team Server first",
      th: "ยังไม่ได้ลงชื่อเข้าใช้ทีม — ใช้คำสั่ง Sign in to Team Server ก่อน",
    },
    NotAllowedToApprove {
      en: "This account is not allowed — only a team owner or lead can approve snaps",
      th: "บัญชีนี้ไม่มีสิทธิ์ — เฉพาะ owner หรือ lead ของทีมที่อนุมัติ snap ได้",
    },
    TeamTokenRejected {
      en: "The team token is invalid, expired or revoked — sign in again",
      th: "token ของทีมไม่ถูกต้อง หมดอายุ หรือถูกเพิกถอน — ลงชื่อเข้าใช้ใหม่",
    },
    ServerRefused {
      en: "The team server refused: {detail}",
      th: "เซิร์ฟเวอร์ทีมปฏิเสธ: {detail}",
    },
    BadSnapId {
      en: "Invalid id \"{id}\"",
      th: "id \"{id}\" ไม่ถูกต้อง",
    },
    SnapNotInstalled {
      en: "Snap \"{id}\" is not installed on this machine",
      th: "ไม่พบ snap \"{id}\" ที่ติดตั้งในเครื่อง",
    },
    SnapVerifyFailed {
      en: "The snap does not match its git source (the local snap may have been edited after install): {detail}",
      th: "ตรวจ snap กับ git ต้นทางไม่ผ่าน (snap ในเครื่องอาจถูกแก้หลังติดตั้ง): {detail}",
    },
    BadServerReply {
      en: "Could not read the team server's reply: {detail}: {message}",
      th: "คำตอบของเซิร์ฟเวอร์ทีมอ่านไม่ได้: {detail}: {message}",
    },
    SnapNotApproved {
      en: "The team has not approved snap \"{id}\" (or it was withdrawn)",
      th: "ทีมไม่ได้อนุมัติ snap \"{id}\" (หรือถูกถอนออกแล้ว)",
    },
  }
}
