//! AI provider accounts: the account list, API keys in the Keychain, usage quotas (accounts/*).

crate::i18n::messages! {
  pub enum AccountsMsg {
    SaveKeyFailed {
      en: "Could not save the API key to the Keychain: {detail}",
      th: "บันทึก API key ลง Keychain ไม่สำเร็จ: {detail}",
    },
    DeleteKeyFailed {
      en: "Could not delete the API key from the Keychain: {detail}",
      th: "ลบ API key จาก Keychain ไม่สำเร็จ: {detail}",
    },
    UsesLogin {
      en: "This account signs in with a login, not an API key",
      th: "บัญชีนี้ใช้การ login ไม่ใช่ API key",
    },
    SetKeyFirst {
      en: "Set the API key of {label} before choosing it",
      th: "ตั้ง API key ของ {label} ก่อนเลือกใช้",
    },
    LoginFirst {
      en: "Log in to account {label} before choosing it",
      th: "login บัญชี {label} ก่อนเลือกใช้",
    },
    OwnAccount {
      en: "Your own account",
      th: "บัญชีของคุณเอง",
    },
    BadUsageData {
      en: "Could not read usage data: {detail}",
      th: "อ่านข้อมูล usage ไม่ได้: {detail}",
    },
    NoPlanType {
      en: "Codex usage data has no plan_type",
      th: "ข้อมูล usage ของ Codex ไม่มี plan_type",
    },
    NotSignedIn {
      en: "Not logged in to {provider}",
      th: "ยังไม่ได้ login {provider}",
    },
    ApiKeyBilling {
      en: "Uses an API key (billed by usage, no plan quota)",
      th: "ใช้ API key (คิดตามการใช้งาน ไม่มีโควตาแพ็กเกจ)",
    },
    StaleToken {
      en: "Token expired: open {provider} with this account or log in again",
      th: "token หมดอายุ: เปิด {provider} ในบัญชีนี้หรือ login ใหม่",
    },
    MissingScope {
      en: "The token is not allowed to read usage: log in again",
      th: "token ไม่มีสิทธิ์อ่าน usage: login ใหม่",
    },
    RateLimited {
      en: "Usage requests are rate limited for now; will retry later",
      th: "ถูกจำกัดการเรียก usage ชั่วคราว จะลองใหม่ภายหลัง",
    },
    ServerDown {
      en: "The {provider} server is having problems; will retry later",
      th: "เซิร์ฟเวอร์ {provider} ขัดข้อง จะลองใหม่ภายหลัง",
    },
    Network {
      en: "Could not connect; will retry later",
      th: "เชื่อมต่อไม่ได้ จะลองใหม่ภายหลัง",
    },
    UsageUnreadable {
      en: "Could not read usage data",
      th: "อ่านข้อมูล usage ไม่ได้",
    },
    KeychainUnavailable {
      en: "Could not read the Keychain (is it locked?)",
      th: "อ่าน Keychain ไม่ได้ (ล็อกอยู่?)",
    },
    UnknownProvider {
      en: "Unknown provider {name}",
      th: "ไม่รู้จักผู้ให้บริการ {name}",
    },
    UnknownKind {
      en: "Unknown account type {name}",
      th: "ไม่รู้จักชนิดบัญชี {name}",
    },
    NameRequired {
      en: "Give the account a name first",
      th: "ตั้งชื่อบัญชีก่อน",
    },
    NameTooLong {
      en: "The account name is longer than {max} characters",
      th: "ชื่อบัญชียาวเกิน {max} ตัวอักษร",
    },
    SaveListFailed {
      en: "Could not save the account list: {detail}",
      th: "บันทึกรายการบัญชีไม่สำเร็จ: {detail}",
    },
    AccountGone {
      en: "This account no longer exists",
      th: "ไม่พบบัญชีนี้แล้ว",
    },
    OtherProvider {
      en: "This account belongs to another provider",
      th: "บัญชีนี้เป็นของผู้ให้บริการอื่น",
    },
    PathNotUtf8 {
      en: "The account's path is not UTF-8",
      th: "path ของบัญชีไม่ใช่ UTF-8",
    },
    NoKeyInKeychain {
      en: "Account {label} has no API key in the Keychain yet",
      th: "บัญชี {label} ยังไม่มี API key ใน Keychain",
    },
    ApiKeyNoLogin {
      en: "API key accounts don't log in; use \"Set API key\" instead",
      th: "บัญชี API key ไม่ต้อง login ใช้ \"ตั้ง API key\" แทน",
    },
    KeyPrefix {
      en: "{provider} API keys must start with {prefix}",
      th: "API key ของ {provider} ต้องขึ้นต้นด้วย {prefix}",
    },
    CreateDirFailed {
      en: "Could not create the account folder: {detail}",
      th: "สร้างโฟลเดอร์บัญชีไม่ได้: {detail}",
    },
    CreateClaudeJsonFailed {
      en: "Could not create the account's .claude.json: {detail}",
      th: "สร้าง .claude.json ของบัญชีไม่ได้: {detail}",
    },
    LinkFailed {
      en: "Could not link {name}: {detail}",
      th: "ลิงก์ {name} ไม่ได้: {detail}",
    },
    CopyConfigFailed {
      en: "Could not copy config.toml: {detail}",
      th: "คัดลอก config.toml ไม่ได้: {detail}",
    },
    BadAccountId {
      en: "Invalid account id",
      th: "id ของบัญชีไม่ถูกต้อง",
    },
    NotPlainDir {
      en: "The account folder is not a regular folder; not deleting it",
      th: "โฟลเดอร์บัญชีไม่ใช่โฟลเดอร์ปกติ ไม่ลบ",
    },
    DeleteDirFailed {
      en: "Could not delete the account folder: {detail}",
      th: "ลบโฟลเดอร์บัญชีไม่ได้: {detail}",
    },
  }
}
