//! Tasks, chats and their worktrees: starting runs, merging and opening PRs, rejecting hunks,
//! task slugs and bases, saved tasks/chats/notes limits, agent trust (agent/mod.rs,
//! agent/review.rs, agent/hunks.rs, agent/worktree.rs, agent/worktree_from.rs, agent/trust.rs,
//! agent/tasks.rs, agent/chats.rs, agent/notes.rs).

crate::i18n::messages! {
  pub enum TasksMsg {
    // agent/mod.rs
    NoWorktreeYet {
      en: "{slug}: no worktree, create it first",
      th: "{slug}: ยังไม่มี worktree ให้สร้างก่อน",
    },
    PromptEmpty {
      en: "prompt is empty",
      th: "ยังไม่ได้พิมพ์ prompt",
    },
    MessageEmpty {
      en: "message is empty",
      th: "ยังไม่ได้พิมพ์ข้อความ",
    },
    // agent/review.rs
    NoWorktree {
      en: "{slug}: no worktree",
      th: "{slug}: ไม่มี worktree",
    },
    NotTaskWorktree {
      en: "{slug}: not a task worktree",
      th: "{slug}: ไม่ใช่ worktree ของงาน",
    },
    MergeIntoOwnBranch {
      en: "cannot merge a task into its own branch",
      th: "merge งานเข้า branch ของตัวเองไม่ได้",
    },
    PrTitleEmpty {
      en: "PR title is empty",
      th: "ยังไม่ได้ใส่ชื่อ PR",
    },
    // agent/hunks.rs
    HunkGone {
      en: "{path}: change {id} is no longer in the file (refresh the diff)",
      th: "{path}: การเปลี่ยนแปลง {id} ไม่อยู่ในไฟล์แล้ว (รีเฟรช diff)",
    },
    // agent/worktree.rs, agent/worktree_from.rs
    SlugLength {
      en: "slug must be 1-{max} characters",
      th: "slug ต้องยาว 1-{max} ตัวอักษร",
    },
    SlugChars {
      en: "{slug}: slug may only contain a-z, 0-9 and '-'",
      th: "{slug}: slug ใช้ได้เฉพาะ a-z, 0-9 และ '-'",
    },
    SlugDashes {
      en: "{slug}: slug must not start/end with '-' or contain '--'",
      th: "{slug}: slug ห้ามขึ้นต้นหรือลงท้ายด้วย '-' และห้ามมี '--'",
    },
    BadBaseRef {
      en: "{base}: invalid base ref",
      th: "{base}: base ref ไม่ถูกต้อง",
    },
    NotACommit {
      en: "{base}: not a commit",
      th: "{base}: ไม่ใช่ commit",
    },
    WorktreeExists {
      en: "{path}: already exists",
      th: "{path}: มีอยู่แล้ว",
    },
    // agent/trust.rs
    BackupIsSymlink {
      en: "{path} is a symlink",
      th: "{path} เป็น symlink",
    },
    NotWorktreeFolder {
      en: "{path}: not a worktree folder",
      th: "{path}: ไม่ใช่โฟลเดอร์ worktree",
    },
    // agent/tasks.rs, agent/chats.rs, agent/notes.rs
    TooManyTasks {
      en: "more than {max} tasks",
      th: "มีงานเกิน {max} งาน",
    },
    TooManyChats {
      en: "more than {max} chats",
      th: "มีแชตเกิน {max} แชต",
    },
    TooManyNotes {
      en: "more than {max} notes",
      th: "มีโน้ตเกิน {max} รายการ",
    },
    TitleLength {
      en: "{name}: title must be 1-{max} characters",
      th: "{name}: ชื่อต้องยาว 1-{max} ตัวอักษร",
    },
    TaskPromptTooLarge {
      en: "{slug}: prompt larger than {max} bytes",
      th: "{slug}: prompt ใหญ่เกิน {max} ไบต์",
    },
    ChatPromptTooLong {
      en: "{id}: prompt longer than {max} characters",
      th: "{id}: prompt ยาวเกิน {max} ตัวอักษร",
    },
    NoteSize {
      en: "{id}: note must be 1-{max} bytes",
      th: "{id}: โน้ตต้องยาว 1-{max} ไบต์",
    },
  }
}
