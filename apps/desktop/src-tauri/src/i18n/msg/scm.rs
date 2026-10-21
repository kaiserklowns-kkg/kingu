//! Source Control: paths, commit, discard, merge/rebase in progress, file versions (git.rs).

crate::i18n::messages! {
  pub enum ScmMsg {
    CannotResolve {
      en: "{path}: cannot resolve",
      th: "{path}: หาตำแหน่งจริงไม่ได้",
    },
    NoOperation {
      en: "No merge, rebase, cherry-pick or revert is in progress.",
      th: "ไม่มี merge, rebase, cherry-pick หรือ revert ที่ค้างอยู่",
    },
    StillConflicted {
      en: "{count|# file still has conflicts|# files still have conflicts}. Resolve and stage them first.",
      th: "ยังมี conflict อยู่ {count} ไฟล์ ให้แก้และ stage ก่อน",
    },
    NotARepository {
      en: "not a git repository",
      th: "ไม่ใช่ git repository",
    },
    UntrackedNeedsConfirm {
      en: "{paths}: untracked, deleting needs confirmation",
      th: "{paths}: ยังไม่ได้ track การลบต้องยืนยันก่อน",
    },
    CommitMessageEmpty {
      en: "commit message is empty",
      th: "ยังไม่ได้ใส่ข้อความ commit",
    },
    NothingStaged {
      en: "nothing staged to commit",
      th: "ไม่มีอะไร stage ไว้ให้ commit",
    },
    InvalidRevision {
      en: "{rev}: invalid revision",
      th: "{rev}: revision ไม่ถูกต้อง",
    },
  }
}
