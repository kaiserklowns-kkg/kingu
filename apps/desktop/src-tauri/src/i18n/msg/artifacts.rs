//! Artifacts: pages agents publish into a project (artifacts/), their preview, export and team share.

crate::i18n::messages! {
  pub enum ArtifactMsg {
    NoProject {
      en: "{path} is not inside a project open in Kingu; open its folder first",
      th: "{path} ไม่ได้อยู่ในโปรเจกต์ที่เปิดใน Kingu ให้เปิดโฟลเดอร์ของมันก่อน",
    },
    BadId {
      en: "Not an artifact id: {id}",
      th: "ไม่ใช่ id ของ artifact: {id}",
    },
    NotFound {
      en: "No artifact {id} in this project",
      th: "ไม่มี artifact {id} ในโปรเจกต์นี้",
    },
    VersionNotFound {
      en: "Artifact {id} has no version {version}",
      th: "artifact {id} ไม่มีเวอร์ชัน {version}",
    },
    TitleRequired {
      en: "The artifact needs a title",
      th: "artifact ต้องมีชื่อ",
    },
    TitleTooLong {
      en: "The title is longer than {max} characters",
      th: "ชื่อยาวเกิน {max} ตัวอักษร",
    },
    DescriptionTooLong {
      en: "The description is longer than {max} characters",
      th: "คำอธิบายยาวเกิน {max} ตัวอักษร",
    },
    BadEntry {
      en: "{path}: an artifact page must be an .html or .md file",
      th: "{path}: หน้า artifact ต้องเป็นไฟล์ .html หรือ .md",
    },
    NotAFile {
      en: "{path} is not a regular file",
      th: "{path} ไม่ใช่ไฟล์ปกติ",
    },
    FileTooLarge {
      en: "{path} is larger than {max} MB",
      th: "{path} ใหญ่เกิน {max} MB",
    },
    TooManyAssets {
      en: "An artifact can have at most {max} files",
      th: "artifact มีไฟล์ได้ไม่เกิน {max} ไฟล์",
    },
    TotalTooLarge {
      en: "The artifact's files add up to more than {max} MB",
      th: "ไฟล์ของ artifact รวมกันเกิน {max} MB",
    },
    BadName {
      en: "{name}: a file name in an artifact must be a relative path inside it",
      th: "{name}: ชื่อไฟล์ใน artifact ต้องเป็น path แบบ relative ที่อยู่ข้างใน",
    },
    DuplicateName {
      en: "{name} appears twice in the artifact",
      th: "มี {name} ซ้ำกันใน artifact",
    },
    StoreOutside {
      en: "The project's .kingu/artifacts folder points outside the project; Kingu does not write there",
      th: "โฟลเดอร์ .kingu/artifacts ของโปรเจกต์ชี้ออกไปนอกโปรเจกต์ Kingu จะไม่เขียนลงไป",
    },
    TooManyVersions {
      en: "Artifact {id} already has {max} versions; publish a new artifact instead",
      th: "artifact {id} มีครบ {max} เวอร์ชันแล้ว ให้เผยแพร่เป็น artifact ใหม่แทน",
    },
    WriteFailed {
      en: "Could not save the artifact ({path}): {detail}",
      th: "บันทึก artifact ไม่สำเร็จ ({path}): {detail}",
    },
    ReadFailed {
      en: "Could not read {path}: {detail}",
      th: "อ่าน {path} ไม่สำเร็จ: {detail}",
    },
    Unreadable {
      en: "Artifact {id} is damaged (artifact.json unreadable): {detail}",
      th: "artifact {id} เสียหาย (อ่าน artifact.json ไม่ได้): {detail}",
    },
    PreviewUnsupported {
      en: "Artifact previews are not available on this system yet; export the page and open it in a browser",
      th: "ระบบนี้ยังแสดงตัวอย่าง artifact ไม่ได้ ให้ export หน้าแล้วเปิดในเบราว์เซอร์",
    },
    ShareTooLarge {
      en: "With its files inlined the page is larger than {max} MB, too large to share with the team",
      th: "เมื่อรวมไฟล์เข้าไปแล้วหน้านี้ใหญ่เกิน {max} MB จึงแชร์ให้ทีมไม่ได้",
    },
    BadTeamList {
      en: "The team server sent an unreadable artifact list: {detail}",
      th: "รายการ artifact จาก team server อ่านไม่ได้: {detail}",
    },
    NotAllowed {
      en: "Only the teammate who shared this artifact, or a team owner or lead, can change it",
      th: "เฉพาะคนที่แชร์ artifact นี้ หรือ owner / lead ของทีมเท่านั้นที่แก้ได้",
    },
  }
}
