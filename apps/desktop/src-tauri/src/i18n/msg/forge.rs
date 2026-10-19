//! The code host behind the ADE's pull request views, GitHub or GitLab (agent/forge.rs, and the
//! fork routing in agent/mr.rs).

crate::i18n::messages! {
  pub enum ForgeMsg {
    PrEmptyTitle {
      en: "Enter a pull request title",
      th: "ใส่ชื่อ pull request",
    },
    PushFailed {
      en: "Push failed. Resolve the push error, then try again. {detail}",
      th: "push ไม่สำเร็จ แก้ปัญหาการ push แล้วลองอีกครั้ง {detail}",
    },
    UnknownAction {
      en: "{action}: unknown pull request action",
      th: "{action}: ไม่รู้จักคำสั่งนี้ของ pull request",
    },
    CommentEmpty {
      en: "The comment is empty",
      th: "คอมเมนต์ว่างอยู่",
    },
    CommentTooLarge {
      en: "The comment is too large to submit safely",
      th: "คอมเมนต์ยาวเกินกว่าจะส่งได้อย่างปลอดภัย",
    },
    NoCheckDetails {
      en: "No inline details are available for this check",
      th: "check นี้ไม่มีรายละเอียดให้ดูในนี้",
    },
    NoProjectId {
      en: "GitLab did not return the id of project {project}",
      th: "GitLab ไม่ได้ส่ง id ของโปรเจกต์ {project} กลับมา",
    },
    NoBranch {
      en: "This worktree is not on a branch",
      th: "worktree นี้ไม่ได้อยู่บน branch ใด",
    },
    NoMergeRequest {
      en: "Branch {branch} has no merge request yet",
      th: "branch {branch} ยังไม่มี merge request",
    },
    UnknownReaction {
      en: "{content}: unknown reaction",
      th: "{content}: ไม่รู้จัก reaction นี้",
    },
    ReactionsNotOnGitlab {
      en: "Reactions are not available on GitLab yet",
      th: "ยังใช้ reaction บน GitLab ไม่ได้",
    },
    PrStartNotOnGitlab {
      en: "Starting a task from a merge request is not available on GitLab yet",
      th: "ยังเริ่มงานจาก merge request บน GitLab ไม่ได้",
    },
  }
}
