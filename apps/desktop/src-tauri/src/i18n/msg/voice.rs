//! Voice dictation (voice.rs).

crate::i18n::messages! {
  pub enum VoiceMsg {
    KeyEmpty {
      en: "Enter an OpenAI API key",
      th: "ใส่ OpenAI API key",
    },
    NoKey {
      en: "No OpenAI API key is saved for dictation; add one in Settings › Voice",
      th: "ยังไม่ได้บันทึก OpenAI API key สำหรับการพูดเป็นข้อความ ให้เพิ่มที่ การตั้งค่า › Voice",
    },
    SaveKeyFailed {
      en: "Could not save the key in the Keychain: {detail}",
      th: "บันทึก key ลง Keychain ไม่สำเร็จ: {detail}",
    },
    DeleteKeyFailed {
      en: "Could not remove the key from the Keychain: {detail}",
      th: "ลบ key ออกจาก Keychain ไม่สำเร็จ: {detail}",
    },
    KeyRejected {
      en: "OpenAI rejected the API key; check it in Settings › Voice",
      th: "OpenAI ไม่รับ API key นี้ ตรวจสอบที่ การตั้งค่า › Voice",
    },
    RateLimited {
      en: "OpenAI's transcription is rate limited right now; try again shortly",
      th: "บริการถอดเสียงของ OpenAI ถูกจำกัดการใช้งานอยู่ ลองใหม่อีกครั้งในอีกสักครู่",
    },
    ServiceFailed {
      en: "Transcription failed: {detail}",
      th: "ถอดเสียงไม่สำเร็จ: {detail}",
    },
    Network {
      en: "Could not reach OpenAI's transcription service",
      th: "ติดต่อบริการถอดเสียงของ OpenAI ไม่ได้",
    },
    AudioEmpty {
      en: "No audio was recorded",
      th: "ไม่ได้บันทึกเสียงไว้",
    },
    AudioInvalid {
      en: "The recording is not 16-bit mono WAV audio",
      th: "เสียงที่บันทึกไม่ใช่ WAV แบบ 16-bit mono",
    },
    AudioTooLong {
      en: "The recording is longer than {max} minutes",
      th: "เสียงที่บันทึกยาวเกิน {max} นาที",
    },
    UnknownEngine {
      en: "Unknown speech engine: {engine}",
      th: "ไม่รู้จักตัวถอดเสียง: {engine}",
    },
    UnknownModel {
      en: "Unknown transcription model: {model}",
      th: "ไม่รู้จักโมเดลถอดเสียง: {model}",
    },
    WhisperMissing {
      en: "whisper.cpp is not installed (no whisper-cli on the PATH); install it, e.g. brew install whisper-cpp, or set kingu.voice.whisperPath",
      th: "ยังไม่ได้ติดตั้ง whisper.cpp (ไม่พบ whisper-cli ใน PATH) ให้ติดตั้ง เช่น brew install whisper-cpp หรือตั้ง kingu.voice.whisperPath",
    },
    WhisperNotAllowed {
      en: "{path} is not a whisper.cpp program (whisper-cli or whisper-cpp)",
      th: "{path} ไม่ใช่โปรแกรมของ whisper.cpp (whisper-cli หรือ whisper-cpp)",
    },
    ModelMissing {
      en: "Choose a whisper.cpp model file (ggml-*.bin) in kingu.voice.localModel",
      th: "เลือกไฟล์โมเดลของ whisper.cpp (ggml-*.bin) ใน kingu.voice.localModel",
    },
    ModelNotFound {
      en: "The speech model {path} does not exist or is not a ggml .bin file",
      th: "ไม่พบโมเดลเสียง {path} หรือไม่ใช่ไฟล์ ggml .bin",
    },
    WhisperFailed {
      en: "whisper.cpp could not transcribe the recording: {detail}",
      th: "whisper.cpp ถอดเสียงไม่สำเร็จ: {detail}",
    },
  }
}
