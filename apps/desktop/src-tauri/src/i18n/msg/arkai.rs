//! Arkai, the chat's own agent on the user's model providers (agent/arkai.rs).

crate::i18n::messages! {
  pub enum ArkaiMsg {
    NoModels {
      en: "Arkai has no model yet: start Ollama, or add a provider in kingu.arkai.providers",
      th: "Arkai ยังไม่มีโมเดล: เปิด Ollama หรือเพิ่มผู้ให้บริการใน kingu.arkai.providers",
    },
    UnknownProvider {
      en: "Arkai has no provider named {id}: add it in kingu.arkai.providers",
      th: "Arkai ไม่มีผู้ให้บริการชื่อ {id}: เพิ่มได้ใน kingu.arkai.providers",
    },
    ProviderNoModels {
      en: "{name} lists no models: add them to the provider in kingu.arkai.providers",
      th: "{name} ไม่มีรายชื่อโมเดล: เพิ่มโมเดลให้ผู้ให้บริการนี้ใน kingu.arkai.providers",
    },
    BadKey {
      en: "That API key cannot be used: it is empty, too long or has line breaks",
      th: "ใช้ API key นี้ไม่ได้: ว่าง ยาวเกินไป หรือมีการขึ้นบรรทัดใหม่",
    },
    SaveKeyFailed {
      en: "Could not save the API key in the Keychain: {detail}",
      th: "บันทึก API key ลงในพวงกุญแจ (Keychain) ไม่ได้: {detail}",
    },
    DeleteKeyFailed {
      en: "Could not remove the API key from the Keychain: {detail}",
      th: "ลบ API key ออกจากพวงกุญแจ (Keychain) ไม่ได้: {detail}",
    },
  }
}
