//! Source Control Graph and the git commands around it: merge, rebase, tags, cherry-pick, undo
//! commit, .gitignore, remotes, stash contents, the commit message editor and worktrees
//! (git_graph.rs, git_ops.rs).

crate::i18n::messages! {
  pub enum ScmGraphMsg {
    InvalidTagName {
      en: "{name} is not a valid tag name",
      th: "{name} ไม่ใช่ชื่อ tag ที่ใช้ได้",
    },
    TagExists {
      en: "A tag named {name} already exists",
      th: "มี tag ชื่อ {name} อยู่แล้ว",
    },
    TagNotFound {
      en: "Tag {name} was not found",
      th: "ไม่พบ tag {name}",
    },
    InvalidRemoteName {
      en: "{name} is not a valid remote name",
      th: "{name} ไม่ใช่ชื่อ remote ที่ใช้ได้",
    },
    InvalidRemoteUrl {
      en: "{url} is not a valid remote URL",
      th: "{url} ไม่ใช่ URL ของ remote ที่ใช้ได้",
    },
    RemoteExists {
      en: "A remote named {name} already exists",
      th: "มี remote ชื่อ {name} อยู่แล้ว",
    },
    RemoteNotFound {
      en: "Remote {name} was not found",
      th: "ไม่พบ remote {name}",
    },
    NoCommit {
      en: "The repository has no commit yet",
      th: "repository นี้ยังไม่มี commit",
    },
    OperationInProgress {
      en: "Finish or abort the {op} in progress first",
      th: "ทำ {op} ที่ค้างอยู่ให้เสร็จหรือยกเลิกก่อน",
    },
    OpFailed {
      en: "git {op} failed: {detail}",
      th: "git {op} ไม่สำเร็จ: {detail}",
    },
    StashNotFound {
      en: "{stash} was not found",
      th: "ไม่พบ {stash}",
    },
    EmptyCommitMessage {
      en: "The commit was cancelled because the commit message is empty",
      th: "ยกเลิกการ commit เพราะข้อความ commit ว่าง",
    },
    WorktreePathNotAbsolute {
      en: "{path}: the worktree folder must be an absolute path",
      th: "{path}: โฟลเดอร์ของ worktree ต้องเป็น path เต็ม",
    },
    WorktreePathNotEmpty {
      en: "{path} already exists and is not an empty folder",
      th: "{path} มีอยู่แล้วและไม่ใช่โฟลเดอร์ว่าง",
    },
    WorktreeNotFound {
      en: "{path} is not a worktree of this repository",
      th: "{path} ไม่ใช่ worktree ของ repository นี้",
    },
    WorktreeIsMain {
      en: "{path} is the main worktree of the repository and cannot be deleted",
      th: "{path} เป็น worktree หลักของ repository จึงลบไม่ได้",
    },
    WorktreeIsTask {
      en: "{path} is a task's worktree; delete the task in the Agents layout instead",
      th: "{path} เป็น worktree ของงาน (task) ให้ลบงานนั้นใน Agents แทน",
    },
    WorktreeLocked {
      en: "{path} is locked (git worktree lock); unlock it first",
      th: "{path} ถูกล็อกไว้ (git worktree lock) ให้ปลดล็อกก่อน",
    },
  }
}
