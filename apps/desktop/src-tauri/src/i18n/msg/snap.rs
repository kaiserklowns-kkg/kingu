//! Snaps: manifests, trust, skills (snap.rs), install / update / create (snap_install.rs) and the
//! sandbox check (snap_sandbox.rs).

crate::i18n::messages! {
  pub enum SnapMsg {
    // Shared file and folder errors.
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
    TooDeep {
      en: "Folders are nested more than {max} levels deep",
      th: "โฟลเดอร์ซ้อนลึกเกิน {max} ชั้น",
    },
    NotPlain {
      en: "{path} is not a regular file or folder",
      th: "{path} ไม่ใช่ไฟล์หรือโฟลเดอร์ธรรมดา",
    },
    NotPlainFolder {
      en: "{path} is not a regular folder",
      th: "{path} ไม่ใช่โฟลเดอร์ธรรมดา",
    },
    NotPlainFile {
      en: "{path} is not a regular file",
      th: "{path} ไม่ใช่ไฟล์ธรรมดา",
    },
    NoFolderOpen {
      en: "No folder is open",
      th: "ยังไม่ได้เปิดโฟลเดอร์",
    },
    NoRepoSnaps {
      en: "This folder has no .kingu/snaps",
      th: "โฟลเดอร์นี้ไม่มี .kingu/snaps",
    },
    InvalidId {
      en: "Invalid id \"{id}\"",
      th: "id \"{id}\" ไม่ถูกต้อง",
    },
    InvalidIdRules {
      en: "Invalid id \"{id}\" (use a-z, 0-9 and -, starting with a letter or digit, at most 40 characters)",
      th: "id \"{id}\" ไม่ถูกต้อง (ใช้ a-z, 0-9, - ขึ้นต้นด้วยตัวอักษรหรือตัวเลข ยาวไม่เกิน 40 ตัว)",
    },
    InvalidSnapId {
      en: "Invalid snap id",
      th: "id ของ snap ไม่ถูกต้อง",
    },
    InvalidIdShort {
      en: "Invalid id",
      th: "id ไม่ถูกต้อง",
    },
    NotFound {
      en: "Snap \"{id}\" not found",
      th: "ไม่พบ snap \"{id}\"",
    },
    PathNotFound {
      en: "{path} not found",
      th: "ไม่พบ {path}",
    },
    ManifestNotPlainFile {
      en: "{manifest} must be a regular file",
      th: "{manifest} ต้องเป็นไฟล์ธรรมดา",
    },
    ManifestTooBig {
      en: "{manifest} is too large",
      th: "{manifest} ใหญ่เกินไป",
    },

    // Manifest (snap.toml) validation.
    UnclosedPlaceholder {
      en: "\"{arg}\": ${setting:…} has no closing }",
      th: "\"{arg}\": ${setting:…} ไม่มี } ปิด",
    },
    UndeclaredSetting {
      en: "{owner} refers to setting \"{key}\", which is not declared in [[settings]]",
      th: "{owner} อ้างถึงการตั้งค่า \"{key}\" ที่ไม่ได้ประกาศใน [[settings]]",
    },
    SkillPathInvalid {
      en: "Skill path \"{path}\" must be a sub-path inside the snap folder (no leading /, no .., no special characters)",
      th: "path ของ skill \"{path}\" ต้องเป็น path ย่อยในโฟลเดอร์ snap (ห้ามขึ้นต้นด้วย / และห้ามมี .. หรืออักขระพิเศษ)",
    },
    SkillNameInvalid {
      en: "Skill folder name \"{name}\" cannot be used as a skill name (use a-z, 0-9 and -, at most 64 characters)",
      th: "ชื่อโฟลเดอร์ของ skill \"{name}\" ใช้เป็นชื่อ skill ไม่ได้ (ใช้ a-z, 0-9, - ยาวไม่เกิน 64 ตัว)",
    },
    SettingDefaultType {
      en: "The default of setting \"{key}\" does not match type = \"{kind}\"",
      th: "ค่า default ของการตั้งค่า \"{key}\" ไม่ตรงกับ type = \"{kind}\"",
    },
    ManifestUnreadable {
      en: "Could not read {manifest}: {detail}",
      th: "อ่าน {manifest} ไม่ได้: {detail}",
    },
    IdFolderMismatch {
      en: "id \"{id}\" must match the folder name \"{folder}\"",
      th: "id \"{id}\" ต้องตรงกับชื่อโฟลเดอร์ \"{folder}\"",
    },
    NameRequired {
      en: "name is required",
      th: "ต้องระบุ name",
    },
    VersionRequired {
      en: "version is required",
      th: "ต้องระบุ version",
    },
    SecretNameInvalid {
      en: "Invalid secret name \"{name}\" (use A-Z, a-z, 0-9 and _)",
      th: "ชื่อ secret \"{name}\" ไม่ถูกต้อง (ใช้ A-Z, a-z, 0-9, _)",
    },
    SettingKeyInvalid {
      en: "Invalid setting key \"{key}\" (start with a letter, then letters or digits)",
      th: "key ของการตั้งค่า \"{key}\" ไม่ถูกต้อง (ขึ้นต้นด้วยตัวอักษร ตามด้วยตัวอักษรหรือตัวเลข)",
    },
    SettingDuplicate {
      en: "Setting \"{key}\" is declared twice",
      th: "การตั้งค่า \"{key}\" ซ้ำ",
    },
    TaskIdInvalid {
      en: "Invalid task id \"{id}\" (use a-z, 0-9 and -)",
      th: "id ของงาน \"{id}\" ไม่ถูกต้อง (ใช้ a-z, 0-9, -)",
    },
    TaskDuplicate {
      en: "Task \"{id}\" is declared twice",
      th: "งาน \"{id}\" ซ้ำ",
    },
    TaskNoTitle {
      en: "Task \"{id}\" needs a title",
      th: "งาน \"{id}\" ต้องมี title",
    },
    TaskNoCommand {
      en: "Task \"{id}\" needs a command (at least one argv item)",
      th: "งาน \"{id}\" ต้องมี command (argv อย่างน้อยหนึ่งตัว)",
    },
    /// Names a task in another message ("Task "x" refers to …").
    TaskOwner {
      en: "Task \"{id}\"",
      th: "งาน \"{id}\"",
    },
    McpNameInvalid {
      en: "Invalid MCP server name \"{name}\" (use A-Z, a-z, 0-9, _ and -)",
      th: "ชื่อ MCP server \"{name}\" ไม่ถูกต้อง (ใช้ A-Z, a-z, 0-9, _, -)",
    },
    McpNoCommand {
      en: "MCP server \"{name}\" needs a command",
      th: "MCP server \"{name}\" ต้องมี command",
    },
    McpEnvInvalid {
      en: "MCP server \"{name}\": invalid env variable name \"{var}\"",
      th: "MCP server \"{name}\": ชื่อตัวแปร env \"{var}\" ไม่ถูกต้อง",
    },
    TooManySkills {
      en: "A snap can have at most {max} skills",
      th: "มี skill ได้ไม่เกิน {max} ตัว",
    },
    SkillDuplicate {
      en: "Skill \"{name}\" is declared twice (a skill's name is the last folder of its path)",
      th: "skill ชื่อ \"{name}\" ซ้ำ (ชื่อ skill คือชื่อโฟลเดอร์สุดท้ายของ path)",
    },

    // Skills on disk.
    SkillSymlink {
      en: "{path} is a symlink, which skills do not support",
      th: "{path} เป็น symlink — ไม่รองรับใน skill",
    },
    SkillTooBig {
      en: "Skills are too large (at most {files} files and {mb} MB per snap in total)",
      th: "skill ใหญ่เกินไป (รวมได้ไม่เกิน {files} ไฟล์ และ {mb} MB ต่อ snap)",
    },
    SkillPartSymlink {
      en: "{part} is a symlink, which is not supported",
      th: "{part} เป็น symlink — ไม่รองรับ",
    },
    SkillMustBeFolder {
      en: "must be a folder",
      th: "ต้องเป็นโฟลเดอร์",
    },
    SkillFolderMissing {
      en: "this folder is not in the snap",
      th: "ไม่พบโฟลเดอร์นี้ใน snap",
    },
    SkillFileNotPlain {
      en: "{file} must be a regular file (not a symlink)",
      th: "{file} ต้องเป็นไฟล์ธรรมดา (ไม่ใช่ symlink)",
    },
    SkillFileMissing {
      en: "no {file}",
      th: "ไม่มี {file}",
    },
    SkillFileNameInvalid {
      en: "Invalid file name in a skill: {path}",
      th: "ชื่อไฟล์ใน skill ไม่ถูกต้อง: {path}",
    },
    PluginMoveFailed {
      en: "Could not move the plugin of snap \"{id}\" into place: {detail}",
      th: "ย้าย plugin ของ snap \"{id}\" เข้าที่ไม่ได้: {detail}",
    },
    SnapInvalid {
      en: "Snap \"{id}\" is invalid",
      th: "snap \"{id}\" ไม่ถูกต้อง",
    },

    // Reading a snap folder.
    FolderNameNotId {
      en: "Folder name \"{folder}\" cannot be used as a snap id (use a-z, 0-9 and -, at most 40 characters)",
      th: "ชื่อโฟลเดอร์ \"{folder}\" ใช้เป็น id ของ snap ไม่ได้ (ใช้ a-z, 0-9, - ยาวไม่เกิน 40 ตัว)",
    },
    NoManifest {
      en: "This folder has no {manifest}",
      th: "ไม่มี {manifest} ในโฟลเดอร์นี้",
    },
    ManifestNotRegular {
      en: "{manifest} must be a regular file (not a symlink or folder)",
      th: "{manifest} ต้องเป็นไฟล์ธรรมดา (ไม่ใช่ symlink หรือโฟลเดอร์)",
    },
    ManifestOverKb {
      en: "{manifest} is larger than {kb} KB",
      th: "{manifest} ใหญ่เกิน {kb} KB",
    },
    ManifestNotUtf8 {
      en: "{manifest} is not UTF-8",
      th: "{manifest} ไม่ใช่ UTF-8",
    },
    SnapFolderSymlink {
      en: "The snap folder is a symlink, which is not supported (Kingu does not follow links out of the snaps folder)",
      th: "โฟลเดอร์ snap เป็น symlink — ไม่รองรับ (Kingu ไม่ตามลิงก์ออกนอกโฟลเดอร์ snaps)",
    },

    // Trust.
    TrustSaveFailed {
      en: "Could not save snap trust: {detail}",
      th: "บันทึกการเชื่อถือ snap ไม่สำเร็จ: {detail}",
    },
    NotFoundHere {
      en: "Snap \"{id}\" not found in this folder",
      th: "ไม่พบ snap \"{id}\" ในโฟลเดอร์นี้",
    },
    TrustBroken {
      en: "Snap \"{id}\" has an error and cannot be trusted: {detail}",
      th: "snap \"{id}\" มีข้อผิดพลาด เชื่อถือไม่ได้: {detail}",
    },
    TrustChanged {
      en: "{manifest} of snap \"{id}\" has changed. Reload Snaps and review it again before trusting it",
      th: "{manifest} ของ snap \"{id}\" เปลี่ยนไปแล้ว — โหลด Snaps ใหม่แล้วตรวจอีกครั้งก่อนเชื่อถือ",
    },

    // Installing.
    GitUrlInvalid {
      en: "Invalid or unsupported git URL: {url} (use https://…, ssh://…, git@host:path or a local path)",
      th: "URL ของ git ไม่ถูกต้องหรือไม่รองรับ: {url} (ใช้ https://…, ssh://…, git@host:path หรือ path ในเครื่อง)",
    },
    RefInvalid {
      en: "Invalid branch or tag after #: {git_ref}",
      th: "ชื่อ branch หรือ tag หลัง # ไม่ถูกต้อง: {git_ref}",
    },
    SourceSymlink {
      en: "{path} is a symlink; a snap must not contain symlinks",
      th: "{path} เป็น symlink — snap ต้องไม่มี symlink",
    },
    SourceTooBig {
      en: "Too large (at most {files} files and {mb} MB)",
      th: "ใหญ่เกินไป (ได้ไม่เกิน {files} ไฟล์ และ {mb} MB)",
    },
    NoManifestInSource {
      en: "No {manifest} at the root of this source or in snaps/<id>/{manifest}",
      th: "ไม่พบ {manifest} ที่รากของแหล่งนี้ หรือใน snaps/<id>/{manifest}",
    },
    RemoveGitFailed {
      en: "Could not remove the copy's .git: {detail}",
      th: "ลบ .git ของสำเนาไม่ได้: {detail}",
    },
    FolderPathNotAbsolute {
      en: "Must be the full path of a folder",
      th: "ต้องเป็น path เต็มของโฟลเดอร์",
    },
    FolderIsSymlink {
      en: "This folder is a symlink, which is not supported",
      th: "โฟลเดอร์นี้เป็น symlink — ไม่รองรับ",
    },
    FolderNotFound {
      en: "Folder {path} not found",
      th: "ไม่พบโฟลเดอร์ {path}",
    },
    NotInstalledByKingu {
      en: "Snap \"{id}\" was not installed through Kingu, so it cannot be updated",
      th: "snap \"{id}\" ไม่ได้ติดตั้งผ่าน Kingu จึงอัปเดตไม่ได้",
    },
    NotFromGit {
      en: "Snap \"{id}\" was not installed from git, so it cannot be updated (install it from the folder again instead)",
      th: "snap \"{id}\" ไม่ได้ติดตั้งจาก git จึงอัปเดตไม่ได้ (ติดตั้งจากโฟลเดอร์ใหม่แทน)",
    },
    RepoDropped {
      en: "This repo no longer has snap \"{id}\"",
      th: "repo นี้ไม่มี snap \"{id}\" แล้ว",
    },
    PinnedCommitMissing {
      en: "Commit {commit} not found in {url}; the team may have pinned a commit that was deleted",
      th: "ไม่พบ commit {commit} ใน {url} — ทีมอาจตรึงไว้ที่ commit ที่ถูกลบไปแล้ว",
    },
    PinnedCommitMismatch {
      en: "Got commit {head} instead of {commit}, which the team pinned",
      th: "ได้ commit {head} แทน {commit} ที่ทีมตรึงไว้",
    },
    TeamPinInvalid {
      en: "The team's data for snap \"{id}\" is invalid",
      th: "ข้อมูล snap \"{id}\" ของทีมไม่ถูกต้อง",
    },
    TeamRefInvalid {
      en: "The team's branch or tag is invalid: {git_ref}",
      th: "ชื่อ branch หรือ tag ของทีมไม่ถูกต้อง: {git_ref}",
    },
    CommitLacksSnap {
      en: "Commit {commit} has no snap \"{id}\"",
      th: "commit {commit} ไม่มี snap \"{id}\"",
    },
    CommitSnapBroken {
      en: "Snap \"{id}\" at this commit has an error: {detail}",
      th: "snap \"{id}\" ที่ commit นี้มีข้อผิดพลาด: {detail}",
    },
    HashMismatch {
      en: "The SHA-256 of snap \"{id}\" does not match what the team approved (got {got}, approved {approved}). Not installing; tell the team admin",
      th: "SHA-256 ของ snap \"{id}\" ไม่ตรงกับที่ทีมอนุมัติ (ได้ {got} ทีมอนุมัติ {approved}) — ไม่ติดตั้ง แจ้งผู้ดูแลทีม",
    },
    InstallDataInvalid {
      en: "Invalid install data",
      th: "ข้อมูลการติดตั้งไม่ถูกต้อง",
    },
    StagingGone {
      en: "The prepared copy was not found (it may have expired). Start the install again",
      th: "ไม่พบสำเนาที่เตรียมไว้ (อาจหมดเวลาแล้ว) — เริ่มติดตั้งใหม่",
    },
    NotInStaging {
      en: "Snap \"{id}\" not found in the prepared copy",
      th: "ไม่พบ snap \"{id}\" ในสำเนาที่เตรียมไว้",
    },
    InstallBroken {
      en: "Snap \"{id}\" has an error and cannot be installed: {detail}",
      th: "snap \"{id}\" มีข้อผิดพลาด ติดตั้งไม่ได้: {detail}",
    },
    ChangedWhileWaiting {
      en: "Snap \"{id}\" changed while waiting for confirmation. Start the install again",
      th: "snap \"{id}\" เปลี่ยนไประหว่างรอยืนยัน — เริ่มติดตั้งใหม่",
    },
    TargetNotFolder {
      en: "{path} is not a regular folder. Remove it first",
      th: "{path} ไม่ใช่โฟลเดอร์ธรรมดา — ลบออกก่อน",
    },
    AlreadyInstalled {
      en: "Snap \"{id}\" is already installed. Use Update or uninstall it first",
      th: "มี snap \"{id}\" ติดตั้งอยู่แล้ว — ใช้ Update หรือถอนการติดตั้งก่อน",
    },
    InstalledElsewhere {
      en: "The installed snap \"{id}\" comes from somewhere else. Uninstall it first, then install again",
      th: "snap \"{id}\" ที่ติดตั้งอยู่มาจากที่อื่น — ถอนการติดตั้งก่อนแล้วค่อยติดตั้งใหม่",
    },
    SaveFileFailed {
      en: "Could not save {file}: {detail}",
      th: "บันทึก {file} ไม่ได้: {detail}",
    },
    MoveInFailed {
      en: "Could not move the snap into place: {detail}",
      th: "ย้าย snap เข้าที่ไม่ได้: {detail}",
    },
    MoveOldFailed {
      en: "Could not move the old snap out: {detail}",
      th: "ย้าย snap เดิมออกไม่ได้: {detail}",
    },
    MoveNewFailed {
      en: "Could not move the new snap into place: {detail}",
      th: "ย้าย snap ใหม่เข้าที่ไม่ได้: {detail}",
    },
    NotInUserSnaps {
      en: "Snap \"{id}\" not found in your snaps folder",
      th: "ไม่พบ snap \"{id}\" ในโฟลเดอร์ snaps ของคุณ",
    },
    NameInvalid {
      en: "A snap name must not be empty and at most 100 characters",
      th: "ชื่อ snap ต้องไม่ว่างและยาวไม่เกิน 100 ตัวอักษร",
    },
    AlreadyExists {
      en: "{path} already exists",
      th: "มี {path} อยู่แล้ว",
    },
    KinguNotFolder {
      en: ".kingu is not a regular folder",
      th: ".kingu ไม่ใช่โฟลเดอร์ธรรมดา",
    },
    TrashFailed {
      en: "Could not move to the Trash: {detail}",
      th: "ย้ายไปถังขยะไม่ได้: {detail}",
    },
    StoreInvalid {
      en: "Invalid snap store",
      th: "ที่เก็บ snap ไม่ถูกต้อง",
    },
    SourceInvalid {
      en: "Invalid snap source",
      th: "ที่มาของ snap ไม่ถูกต้อง",
    },

    // The snap.toml template of a new snap (TOML comments).
    TemplateHeader {
      en: "Kingu Snap: a pack of tasks, MCP server settings and skills for both the IDE and the ADE",
      th: "Kingu Snap: แพ็กของงาน การตั้งค่า MCP server และ skill ที่ใช้ได้ทั้งใน IDE และ ADE",
    },
    TemplateId {
      en: "id must match the folder name (a-z, 0-9, -, at most 40 characters)",
      th: "id ต้องตรงกับชื่อโฟลเดอร์ (a-z, 0-9, - ยาวไม่เกิน 40 ตัว)",
    },
    TemplatePermissions {
      en: "Permissions: shown to the user before trusting, and enforced when tasks and MCP servers run (sandbox)\n# network = false turns off all IP networking (localhost too); fs = \"worktree\" can write only the task folder and temp\n# secrets = environment variables that may be passed; others that look like a token/key/password are removed",
      th: "สิทธิ์: แสดงให้ผู้ใช้เห็นก่อนเชื่อถือ และบังคับใช้ตอนรันงานและ MCP server (sandbox)\n# network = false ปิดเครือข่าย IP ทั้งหมด (รวม localhost) fs = \"worktree\" เขียนได้เฉพาะโฟลเดอร์งานและ temp\n# secrets = ตัวแปร environment ที่ส่งให้ได้ ตัวอื่นที่ดูเหมือน token/key/password จะถูกตัดออก",
    },
    TemplateSecrets {
      en: "names of the secrets it needs",
      th: "ชื่อ secret ที่ต้องใช้",
    },
    TemplateTasks {
      en: "Tasks that run in a terminal: command is an argv (no shell); ${setting:<key>} is replaced by a setting's value",
      th: "งานที่รันใน terminal: command เป็น argv (ไม่ผ่าน shell) ใช้ ${setting:<key>} แทนค่าการตั้งค่าได้",
    },
    TemplateSettings {
      en: "Settings: shown in the system settings as snap.{id}.<key>",
      th: "การตั้งค่า: ขึ้นในหน้าการตั้งค่าระบบเป็น snap.{id}.<key>",
    },
    TemplateGreeting {
      en: "The text the hello task prints",
      th: "ข้อความที่งาน hello พิมพ์",
    },
    TemplateMcp {
      en: "MCP server (stdio) given to agents as a tool",
      th: "MCP server (stdio) ที่ส่งให้ agent ใช้เป็น tool",
    },
    TemplateSkills {
      en: "Agent skills: folders in the snap that hold a SKILL.md",
      th: "Skill ของ agent: โฟลเดอร์ใน snap ที่มี SKILL.md",
    },

    // Sandbox (snap_sandbox.rs).
    LauncherNotUtf8 {
      en: "The path of kingu-ptyd is not UTF-8",
      th: "path ของ kingu-ptyd ไม่ใช่ UTF-8",
    },
    SandboxUnsupported {
      en: "Snap sandboxing is not supported on this operating system yet",
      th: "ระบบปฏิบัติการนี้ยังไม่รองรับ sandbox ของ Snap",
    },
  }
}
