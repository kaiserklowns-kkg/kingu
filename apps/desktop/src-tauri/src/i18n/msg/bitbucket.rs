//! Bitbucket pull requests (bitbucket.rs).

crate::i18n::messages! {
  pub enum BitbucketMsg {
    NotConnected {
      en: "Bitbucket is not connected: connect it in Settings › Integrations (an access token, or your email and an API token)",
      th: "ยังไม่ได้เชื่อมต่อ Bitbucket: เชื่อมต่อใน Settings › Integrations (ใช้ access token หรืออีเมลกับ API token)",
    },
    AccessTokenRequired {
      en: "Enter a Bitbucket access token",
      th: "ใส่ access token ของ Bitbucket",
    },
    EmailAndApiTokenRequired {
      en: "Enter your Bitbucket email and API token",
      th: "ใส่อีเมลและ API token ของ Bitbucket",
    },
    Rejected {
      en: "Bitbucket rejected these credentials (revoked or invalid)",
      th: "Bitbucket ไม่รับข้อมูลเข้าสู่ระบบนี้ (ถูกเพิกถอนหรือไม่ถูกต้อง)",
    },
    Unreachable {
      en: "Could not reach Bitbucket; check your internet connection and the API address",
      th: "ติดต่อ Bitbucket ไม่ได้ ตรวจสอบอินเทอร์เน็ตและที่อยู่ API",
    },
    BadBaseUrl {
      en: "The Bitbucket API address must start with https://",
      th: "ที่อยู่ API ของ Bitbucket ต้องขึ้นต้นด้วย https://",
    },
    SameBranch {
      en: "Create PR failed: choose a different base branch before creating a pull request.",
      th: "สร้าง PR ไม่ได้: เลือก base branch อื่นก่อนสร้าง pull request",
    },
    TitleRequired {
      en: "Create PR failed: base branch, head branch, and title are required.",
      th: "สร้าง PR ไม่ได้: ต้องมี base branch, head branch และชื่อ",
    },
    AlreadyExists {
      en: "A pull request already exists for this branch.",
      th: "branch นี้มี pull request อยู่แล้ว",
    },
    Validation {
      en: "Create PR failed: Bitbucket rejected the pull request. Check the base branch and that the branch was pushed.",
      th: "สร้าง PR ไม่ได้: Bitbucket ไม่รับ pull request นี้ ตรวจสอบ base branch และว่า push branch แล้ว",
    },
    NotOnBitbucket {
      en: "Not available for Bitbucket yet: open the pull request on bitbucket.org",
      th: "ยังใช้กับ Bitbucket ไม่ได้: เปิด pull request บน bitbucket.org",
    },
    Failed {
      en: "Bitbucket request failed (HTTP {status})",
      th: "คำขอไปยัง Bitbucket ล้มเหลว (HTTP {status})",
    },
    SaveFailed {
      en: "Could not save the Bitbucket credentials in the keychain ({detail})",
      th: "บันทึกข้อมูลเข้าสู่ระบบ Bitbucket ลง keychain ไม่ได้ ({detail})",
    },
  }
}
