//! The Skills hub (skill_hub/): reading and checking skills, links, archives, install / update /
//! remove and the on/off state.

crate::i18n::messages! {
  pub enum SkillMsg {
    // Files and folders.
    ReadFailed {
      en: "Could not read {path}: {detail}",
      th: "อ่าน {path} ไม่ได้: {detail}",
    },
    CreateFailed {
      en: "Could not create {path}: {detail}",
      th: "สร้าง {path} ไม่ได้: {detail}",
    },
    WriteFailed {
      en: "Could not write {path}: {detail}",
      th: "เขียน {path} ไม่ได้: {detail}",
    },
    CopyFailed {
      en: "Could not copy {path}: {detail}",
      th: "คัดลอก {path} ไม่ได้: {detail}",
    },
    MoveFailed {
      en: "Could not move the skill into place: {detail}",
      th: "ย้าย skill เข้าที่ไม่ได้: {detail}",
    },
    TrashFailed {
      en: "Could not move the skill to the Trash: {detail}",
      th: "ย้าย skill ไปถังขยะไม่ได้: {detail}",
    },
    TooDeep {
      en: "Folders are nested more than {max} levels deep",
      th: "โฟลเดอร์ซ้อนลึกเกิน {max} ชั้น",
    },
    Symlink {
      en: "{path} is a symbolic link (skills cannot contain links)",
      th: "{path} เป็นลิงก์สัญลักษณ์ (skill มีลิงก์ไม่ได้)",
    },
    NotPlain {
      en: "{path} is not a regular file or folder",
      th: "{path} ไม่ใช่ไฟล์หรือโฟลเดอร์ธรรมดา",
    },
    TooBig {
      en: "The skill is too large (at most {files} files and {mb} MB)",
      th: "skill ใหญ่เกินไป (ไม่เกิน {files} ไฟล์ และ {mb} MB)",
    },
    FolderMissing {
      en: "Folder {path} not found",
      th: "ไม่พบโฟลเดอร์ {path}",
    },
    FileNotFound {
      en: "File {path} not found",
      th: "ไม่พบไฟล์ {path}",
    },
    TargetNotFolder {
      en: "{path} exists and is not a regular folder",
      th: "มี {path} อยู่แล้วและไม่ใช่โฟลเดอร์ธรรมดา",
    },

    // SKILL.md and its front matter.
    SkillMdMissing {
      en: "SKILL.md not found",
      th: "ไม่พบ SKILL.md",
    },
    SkillMdNotPlain {
      en: "SKILL.md must be a regular file",
      th: "SKILL.md ต้องเป็นไฟล์ธรรมดา",
    },
    SkillMdTooBig {
      en: "SKILL.md is larger than {kb} KB",
      th: "SKILL.md ใหญ่เกิน {kb} KB",
    },
    SkillMdNotUtf8 {
      en: "SKILL.md is not UTF-8 text",
      th: "SKILL.md ไม่ใช่ข้อความ UTF-8",
    },
    NoFrontMatter {
      en: "SKILL.md must start with a front matter block (--- name and description ---)",
      th: "SKILL.md ต้องขึ้นต้นด้วยส่วน front matter (--- name และ description ---)",
    },
    FrontMatterInvalid {
      en: "The front matter of SKILL.md is not valid YAML: {detail}",
      th: "front matter ของ SKILL.md ไม่ใช่ YAML ที่ถูกต้อง: {detail}",
    },
    NameMissing {
      en: "The front matter of SKILL.md has no name",
      th: "front matter ของ SKILL.md ไม่มี name",
    },
    NameInvalid {
      en: "\"{name}\" cannot be a skill name (use a-z, 0-9 and single hyphens, at most 64 characters)",
      th: "ใช้ \"{name}\" เป็นชื่อ skill ไม่ได้ (ใช้ a-z, 0-9 และขีดกลางทีละตัว ยาวไม่เกิน 64 ตัว)",
    },
    DescriptionMissing {
      en: "The front matter of SKILL.md has no description (agents use it to decide when to load the skill)",
      th: "front matter ของ SKILL.md ไม่มี description (เอเจนต์ใช้ตัดสินว่าจะโหลด skill เมื่อไร)",
    },
    DescriptionTooLong {
      en: "The description is longer than {max} characters",
      th: "description ยาวเกิน {max} ตัวอักษร",
    },
    FolderNameMismatch {
      en: "Folder \"{folder}\" holds skill \"{name}\": rename the folder to the skill's name",
      th: "โฟลเดอร์ \"{folder}\" มี skill ชื่อ \"{name}\" ให้เปลี่ยนชื่อโฟลเดอร์ให้ตรงกับชื่อ skill",
    },

    // Archives and downloads.
    ArchiveInvalid {
      en: "Not a valid .skill or .zip archive: {detail}",
      th: "ไม่ใช่ไฟล์ .skill หรือ .zip ที่ถูกต้อง: {detail}",
    },
    ArchiveTooBig {
      en: "The archive is too large (at most {files} files and {mb} MB unpacked)",
      th: "ไฟล์บีบอัดใหญ่เกินไป (ไม่เกิน {files} ไฟล์ และ {mb} MB เมื่อแตกไฟล์)",
    },
    ArchiveUnsafePath {
      en: "The archive holds an unsafe path {path} (absolute, .. or a drive): refused",
      th: "ไฟล์บีบอัดมี path ที่ไม่ปลอดภัย {path} (path เต็ม, .. หรือไดรฟ์) จึงไม่ติดตั้ง",
    },
    ArchiveSymlink {
      en: "The archive holds a symbolic link ({path}): refused",
      th: "ไฟล์บีบอัดมีลิงก์สัญลักษณ์ ({path}) จึงไม่ติดตั้ง",
    },
    ArchiveEncrypted {
      en: "Encrypted archives are not supported",
      th: "ไม่รองรับไฟล์บีบอัดที่เข้ารหัส",
    },
    DownloadFailed {
      en: "Could not download {url}: {detail}",
      th: "ดาวน์โหลด {url} ไม่ได้: {detail}",
    },
    DownloadTooBig {
      en: "The file is larger than {mb} MB",
      th: "ไฟล์ใหญ่เกิน {mb} MB",
    },
    ExportPathInvalid {
      en: "Choose a .skill or .zip file in an existing folder",
      th: "เลือกไฟล์ .skill หรือ .zip ในโฟลเดอร์ที่มีอยู่",
    },

    // Links.
    LinkEmpty {
      en: "Paste a link to a skill",
      th: "วางลิงก์ของ skill",
    },
    LinkInvalid {
      en: "\"{url}\" is not a link Kingu can install a skill from",
      th: "\"{url}\" ไม่ใช่ลิงก์ที่ Kingu ใช้ติดตั้ง skill ได้",
    },
    LinkNotHttps {
      en: "{url}: only https links are allowed",
      th: "{url}: ใช้ได้เฉพาะลิงก์ https",
    },
    LinkNotSkill {
      en: "{url} is not a repository, folder or SKILL.md on GitHub",
      th: "{url} ไม่ใช่ repository, โฟลเดอร์ หรือ SKILL.md บน GitHub",
    },
    LinkFolderInvalid {
      en: "Folder {path} in the link must be a plain path inside the repository",
      th: "โฟลเดอร์ {path} ในลิงก์ต้องเป็น path ธรรมดาภายใน repository",
    },
    LinkedFolderMissing {
      en: "The linked folder is not in the source",
      th: "ไม่พบโฟลเดอร์ตามลิงก์ในต้นทาง",
    },
    NoSkillFound {
      en: "No skill found (a skill is a folder with a {file})",
      th: "ไม่พบ skill (skill คือโฟลเดอร์ที่มี {file})",
    },

    // Install, update, remove.
    InstallDataInvalid {
      en: "Invalid install data",
      th: "ข้อมูลการติดตั้งไม่ถูกต้อง",
    },
    StagingGone {
      en: "The download is gone (it expires after an hour): install again",
      th: "ไฟล์ที่ดาวน์โหลดไว้หายไปแล้ว (หมดอายุใน 1 ชั่วโมง) ให้ติดตั้งใหม่",
    },
    ChangedWhileWaiting {
      en: "Skill {name} changed after the review: install again",
      th: "skill {name} เปลี่ยนไปหลังจากตรวจทาน ให้ติดตั้งใหม่",
    },
    AlreadyInstalled {
      en: "Skill {name} is already installed",
      th: "ติดตั้ง skill {name} ไว้แล้ว",
    },
    InstalledElsewhere {
      en: "Skill {name} is installed from somewhere else: remove it first",
      th: "skill {name} ติดตั้งจากที่อื่นอยู่ ให้ลบออกก่อน",
    },
    NotInstalled {
      en: "Skill {name} is not installed",
      th: "ไม่ได้ติดตั้ง skill {name}",
    },
    NoOrigin {
      en: "Kingu does not know where skill {name} came from",
      th: "Kingu ไม่ทราบว่า skill {name} มาจากที่ไหน",
    },
    SkillGoneFromSource {
      en: "Skill {name} is no longer at its source",
      th: "ไม่มี skill {name} ที่ต้นทางแล้ว",
    },
    InstallBroken {
      en: "Skill {name} cannot be installed: {detail}",
      th: "ติดตั้ง skill {name} ไม่ได้: {detail}",
    },
    HashMismatch {
      en: "Skill {name} at that commit is {got}…, not the {shared}… the team shared: refused",
      th: "skill {name} ที่ commit นั้นเป็น {got}… ไม่ใช่ {shared}… ที่ทีมแชร์ไว้ จึงไม่ติดตั้ง",
    },

    // Team skills (team/skills.rs).
    TeamBadList {
      en: "Could not read the team's skills: {detail}",
      th: "อ่านรายการ skill ของทีมไม่ได้: {detail}",
    },
    TeamNeedsGit {
      en: "Skill {name} was not installed from a git repository others can reach: share it with Copy Share Link or Export instead",
      th: "skill {name} ไม่ได้ติดตั้งจาก git repository ที่คนอื่นเข้าถึงได้ ให้แชร์ด้วย Copy Share Link หรือ Export แทน",
    },
    TeamChangedLocally {
      en: "Skill {name} was changed after it was installed, so the team could not get the same files: update it or share it as a file",
      th: "skill {name} ถูกแก้ไขหลังติดตั้ง ทีมจึงได้ไฟล์ไม่ตรงกัน ให้อัปเดตก่อนหรือแชร์เป็นไฟล์",
    },
    TeamVerifyFailed {
      en: "The skill could not be fetched again at its commit, so it was not shared: {detail}",
      th: "ดึง skill ที่ commit เดิมอีกครั้งไม่ได้ จึงยังไม่แชร์: {detail}",
    },
    TeamNotAllowed {
      en: "You cannot change this team skill (viewers cannot share; only its sharer or an owner or lead can replace or remove it)",
      th: "คุณแก้ skill นี้ของทีมไม่ได้ (viewer แชร์ไม่ได้ และเฉพาะผู้แชร์ owner หรือ lead เท่านั้นที่แทนที่หรือลบได้)",
    },
    TeamNotShared {
      en: "The team does not share a skill named {name}",
      th: "ทีมไม่มี skill ชื่อ {name} ที่แชร์ไว้",
    },

    // The Skills view.
    CannotToggle {
      en: "Skill {id} cannot be turned off in Kingu",
      th: "ปิด skill {id} ใน Kingu ไม่ได้",
    },
    NotFound {
      en: "Skill {id} not found",
      th: "ไม่พบ skill {id}",
    },
  }
}
