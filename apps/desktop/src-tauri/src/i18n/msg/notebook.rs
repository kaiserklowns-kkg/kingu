//! Notebooks (notebook/kernel.rs): Jupyter kernels.

crate::i18n::messages! {
  pub enum NotebookMsg {
    NoJupyter {
      en: "No Python with Jupyter was found. Install it (pip install jupyter) or create a .venv with ipykernel in the folder.",
      th: "ไม่พบ Python ที่มี Jupyter ติดตั้ง (pip install jupyter) หรือสร้าง .venv ที่มี ipykernel ในโฟลเดอร์",
    },
    Untrusted {
      en: "Running notebook cells is disabled in Restricted Mode. Trust the folder to run them.",
      th: "Restricted Mode ปิดการรัน cell ของ notebook ไว้ เชื่อถือโฟลเดอร์ก่อนจึงจะรันได้",
    },
    BadReply {
      en: "The kernel bridge answered with something unexpected: {detail}",
      th: "ตัวเชื่อม kernel ตอบกลับมาไม่ถูกรูปแบบ: {detail}",
    },
    NoSession {
      en: "The kernel is not running.",
      th: "kernel ไม่ได้ทำงานอยู่",
    },
  }
}
