//! Local AI: completions and semantic search on the user's own model server (local_ai/).

crate::i18n::messages! {
  pub enum LocalAiMsg {
    BadEndpoint {
      en: "The model server address is not an http(s) URL: {url}",
      th: "ที่อยู่ของเซิร์ฟเวอร์โมเดลไม่ใช่ URL แบบ http(s): {url}",
    },
    Unreachable {
      en: "Could not reach the model server at {url}; is Ollama (or your server) running?",
      th: "ติดต่อเซิร์ฟเวอร์โมเดลที่ {url} ไม่ได้ เปิด Ollama (หรือเซิร์ฟเวอร์ของคุณ) ไว้หรือยัง",
    },
    Timeout {
      en: "The model server at {url} did not answer in time",
      th: "เซิร์ฟเวอร์โมเดลที่ {url} ไม่ตอบภายในเวลาที่กำหนด",
    },
    Http {
      en: "The model server answered HTTP {status}: {detail}",
      th: "เซิร์ฟเวอร์โมเดลตอบกลับ HTTP {status}: {detail}",
    },
    BadReply {
      en: "Could not read the model server's reply",
      th: "อ่านคำตอบของเซิร์ฟเวอร์โมเดลไม่ได้",
    },
    NoModel {
      en: "No model is set: choose one in Settings › Local AI (for Ollama, pull a coding model such as qwen2.5-coder)",
      th: "ยังไม่ได้เลือกโมเดล: ตั้งค่าได้ที่ Settings › Local AI (ถ้าใช้ Ollama ให้ pull โมเดลเขียนโค้ด เช่น qwen2.5-coder)",
    },
    SemanticOff {
      en: "Semantic search is off: turn on kingu.semanticSearch.enabled",
      th: "การค้นหาตามความหมายปิดอยู่: เปิด kingu.semanticSearch.enabled",
    },
  }
}
