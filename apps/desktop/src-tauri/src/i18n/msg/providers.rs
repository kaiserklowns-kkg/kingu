//! OpenCode and Devin managed accounts (accounts/managed.rs) and Antigravity's saved accounts
//! (accounts/antigravity.rs).

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
    AgyNoCurrent {
      en: "Sign in with agy on this computer, then save the current account.",
      th: "login ด้วย agy บนเครื่องนี้ก่อน แล้วค่อยบันทึกบัญชีปัจจุบัน",
    },
    AgyNoIdentity {
      en: "The current Antigravity credential has no stable Google identity; it cannot be saved for switching.",
      th: "credential ของ Antigravity ตอนนี้ไม่มีตัวตน Google ที่แน่นอน จึงบันทึกไว้สลับไม่ได้",
    },
    AgyNotVerified {
      en: "Antigravity account switching could not be verified; refresh before retrying.",
      th: "ยืนยันการสลับบัญชี Antigravity ไม่ได้ รีเฟรชก่อนลองใหม่",
    },
    AgySelectOther {
      en: "Select another Antigravity account before removing this account.",
      th: "เลือกบัญชี Antigravity อื่นก่อนลบบัญชีนี้",
    },
    AgyTokenFileUnsafe {
      en: "agy's token file can be read by other users or is too large; Kingu does not use it.",
      th: "ไฟล์ token ของ agy ผู้ใช้อื่นอ่านได้หรือใหญ่เกินไป Kingu จึงไม่ใช้",
    },
    AgyTooLarge {
      en: "The saved Antigravity credential is too large to store.",
      th: "credential ของ Antigravity ที่บันทึกไว้ใหญ่เกินกว่าจะเก็บได้",
    },
  }
}
