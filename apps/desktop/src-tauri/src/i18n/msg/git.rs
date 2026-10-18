//! Git: remotes, clone, sync (git_remote.rs) and related git commands.

crate::i18n::messages! {
  pub enum GitMsg {
    /// The webview offers "Open in Terminal" when an error starts with rustErrors.ts
    /// `remoteAuthFailed` (checked by i18n's tests).
    AuthFailed {
      en: "Authentication with the remote failed: Kingu does not ask for passwords itself. Open it in the Terminal to authenticate, then try again",
      th: "ยืนยันตัวตนกับ remote ไม่สำเร็จ: Kingu ไม่ถามรหัสผ่านเอง เปิดใน Terminal เพื่อยืนยันตัวตนแล้วลองใหม่",
    },
  }
}
