//! Snap contributions (snap_contrib.rs): languages, grammars, snippets, language servers, themes
//! and views in `snap.toml`, the files they name, built-in snaps and the view pages.

crate::i18n::messages! {
  pub enum SnapContribMsg {
    // Manifest checks.
    LanguageIdInvalid {
      en: "Invalid language id \"{id}\" (letters, digits, '.', '_', '+' and '-', at most 64 characters)",
      th: "id ของภาษา \"{id}\" ไม่ถูกต้อง (ใช้ตัวอักษร ตัวเลข '.', '_', '+' และ '-' ยาวไม่เกิน 64 ตัว)",
    },
    LanguageDuplicate {
      en: "Language \"{id}\" is declared twice",
      th: "ภาษา \"{id}\" ประกาศซ้ำ",
    },
    ExtensionInvalid {
      en: "Language \"{id}\": invalid extension \"{ext}\" (it starts with '.' and has no '/')",
      th: "ภาษา \"{id}\": นามสกุลไฟล์ \"{ext}\" ไม่ถูกต้อง (ต้องขึ้นต้นด้วย '.' และไม่มี '/')",
    },
    FileNameInvalid {
      en: "Language \"{id}\": invalid file name \"{name}\"",
      th: "ภาษา \"{id}\": ชื่อไฟล์ \"{name}\" ไม่ถูกต้อง",
    },
    PathInvalid {
      en: "Invalid path \"{path}\" (relative, '/'-separated, no '.' or '..' parts)",
      th: "path \"{path}\" ไม่ถูกต้อง (ต้องเป็น path ย่อยคั่นด้วย '/' ไม่มีส่วน '.' หรือ '..')",
    },
    PathExtension {
      en: "\"{path}\" must end in {allowed}",
      th: "\"{path}\" ต้องลงท้ายด้วย {allowed}",
    },
    ScopeInvalid {
      en: "Invalid TextMate scope name \"{scope}\"",
      th: "ชื่อ scope ของ TextMate \"{scope}\" ไม่ถูกต้อง",
    },
    GrammarDuplicate {
      en: "Grammar \"{scope}\" is declared twice",
      th: "grammar \"{scope}\" ประกาศซ้ำ",
    },
    LspKeyInvalid {
      en: "Invalid language server name \"{key}\" (use a-z, 0-9 and -)",
      th: "ชื่อ language server \"{key}\" ไม่ถูกต้อง (ใช้ a-z, 0-9 และ -)",
    },
    LspNoName {
      en: "Language server \"{key}\" has no name",
      th: "language server \"{key}\" ไม่มี name",
    },
    LspNoLanguages {
      en: "Language server \"{key}\" serves no languages",
      th: "language server \"{key}\" ไม่ได้ระบุภาษาที่ให้บริการ (languages)",
    },
    LspNoCommand {
      en: "Language server \"{key}\" has no command",
      th: "language server \"{key}\" ไม่มี command",
    },
    LspEnvInvalid {
      en: "Language server \"{key}\": invalid environment variable name \"{var}\"",
      th: "language server \"{key}\": ชื่อตัวแปร environment \"{var}\" ไม่ถูกต้อง",
    },
    LspSectionInvalid {
      en: "Language server \"{key}\": invalid settings section \"{section}\"",
      th: "language server \"{key}\": settings section \"{section}\" ไม่ถูกต้อง",
    },
    LspOwner {
      en: "language server \"{key}\"",
      th: "language server \"{key}\"",
    },
    InstallInvalid {
      en: "Language server \"{key}\": invalid install package \"{package}\"",
      th: "language server \"{key}\": แพ็กเกจสำหรับติดตั้ง \"{package}\" ไม่ถูกต้อง",
    },
    ThemeNoLabel {
      en: "Theme {path} has no label",
      th: "ธีม {path} ไม่มี label",
    },
    ThemeDuplicate {
      en: "Theme \"{id}\" is declared twice",
      th: "ธีม \"{id}\" ประกาศซ้ำ",
    },
    IconThemeIdInvalid {
      en: "Invalid icon theme id \"{id}\"",
      th: "id ของชุดไอคอน \"{id}\" ไม่ถูกต้อง",
    },
    ViewIdInvalid {
      en: "Invalid view id \"{id}\" (use a-z, 0-9 and -)",
      th: "id ของ view \"{id}\" ไม่ถูกต้อง (ใช้ a-z, 0-9 และ -)",
    },
    ViewDuplicate {
      en: "View \"{id}\" is declared twice",
      th: "view \"{id}\" ประกาศซ้ำ",
    },
    ViewNoName {
      en: "View \"{id}\" has no name",
      th: "view \"{id}\" ไม่มี name",
    },
    ViewSettingUndeclared {
      en: "View \"{id}\" reads setting \"{key}\", which the snap does not declare",
      th: "view \"{id}\" อ่าน setting \"{key}\" ที่ snap ไม่ได้ประกาศ",
    },
    ViewTaskUndeclared {
      en: "View \"{id}\" runs task \"{task}\", which the snap does not declare",
      th: "view \"{id}\" รัน task \"{task}\" ที่ snap ไม่ได้ประกาศ",
    },
    TooMany {
      en: "Too many {what} (at most {max})",
      th: "{what} มากเกินไป (ไม่เกิน {max})",
    },

    // Files on disk.
    FileSymlink {
      en: "{path} is or passes through a symbolic link",
      th: "{path} เป็นหรือผ่าน symbolic link",
    },
    FileMissing {
      en: "{path} does not exist",
      th: "ไม่พบ {path}",
    },
    FileNotPlain {
      en: "{path} is not a regular file",
      th: "{path} ไม่ใช่ไฟล์ธรรมดา",
    },
    FileTooBig {
      en: "{path} is larger than {mb} MB",
      th: "{path} ใหญ่เกิน {mb} MB",
    },
    FilesTooBig {
      en: "The snap's contributed files are larger than {mb} MB in all",
      th: "ไฟล์ที่ snap เพิ่มรวมกันใหญ่เกิน {mb} MB",
    },
    FileChanged {
      en: "{path} changed since the snap was listed; reload snaps and try again",
      th: "{path} เปลี่ยนไปหลังจากโหลดรายการ snap ให้โหลด snap ใหม่แล้วลองอีกครั้ง",
    },
    NotUtf8 {
      en: "{path} is not UTF-8 text",
      th: "{path} ไม่ใช่ข้อความ UTF-8",
    },
    ImageType {
      en: "{path} is not an image Kingu shows (svg, png, jpg, gif, webp)",
      th: "{path} ไม่ใช่รูปที่ Kingu แสดงได้ (svg, png, jpg, gif, webp)",
    },
    BuiltinFile {
      en: "Files of built-in snaps come with the app",
      th: "ไฟล์ของ snap ที่มากับแอปอยู่ในตัวแอปแล้ว",
    },

    // Running a snap's language server or view.
    SnapNotFound {
      en: "Snap \"{id}\" is not installed here",
      th: "ไม่พบ snap \"{id}\" ที่นี่",
    },
    SnapInactive {
      en: "Snap \"{id}\" is not active (broken, untrusted or overridden)",
      th: "snap \"{id}\" ไม่ได้ทำงานอยู่ (เสีย, ยังไม่ trust หรือถูกแทนที่)",
    },
    RestrictedMode {
      en: "{name} from this folder's snaps does not run in Restricted Mode; trust the folder to use it",
      th: "{name} จาก snap ของโฟลเดอร์นี้ไม่ทำงานในโหมดจำกัด ให้ trust โฟลเดอร์ก่อน",
    },
    NoSuchServer {
      en: "Snap \"{id}\" has no language server \"{key}\"",
      th: "snap \"{id}\" ไม่มี language server \"{key}\"",
    },
    NoSuchView {
      en: "Snap \"{id}\" has no view \"{view}\"",
      th: "snap \"{id}\" ไม่มี view \"{view}\"",
    },
    ProgramMismatch {
      en: "Language server \"{key}\": the program does not match the snap's command",
      th: "language server \"{key}\": โปรแกรมไม่ตรงกับ command ของ snap",
    },
    EnvUndeclared {
      en: "Language server \"{key}\": environment variable {var} is not declared by the snap",
      th: "language server \"{key}\": snap ไม่ได้ประกาศตัวแปร environment {var}",
    },
    ViewUnsupported {
      en: "Snap views are not available on this system yet",
      th: "ระบบนี้ยังแสดง view ของ snap ไม่ได้",
    },
    ViewTooLarge {
      en: "View page {path} is larger than {mb} MB",
      th: "หน้า view {path} ใหญ่เกิน {mb} MB",
    },
  }
}
