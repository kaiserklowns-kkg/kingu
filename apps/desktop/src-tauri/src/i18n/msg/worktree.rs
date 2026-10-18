//! Task worktrees started from an existing branch or a pull request, and the first-work branch
//! rename (agent/worktree.rs, agent/worktree_from.rs).

crate::i18n::messages! {
  pub enum WorktreeMsg {
    BranchNotFound {
      en: "Branch {branch} was found neither here nor on origin",
      th: "ไม่พบ branch {branch} ทั้งในเครื่องและบน origin",
    },
    BranchInOtherWorktree {
      en: "Branch {branch} is already checked out at {path}; open that worktree, or pick another branch",
      th: "branch {branch} ถูก check out อยู่ที่ {path} แล้ว เปิด worktree นั้นแทน หรือเลือก branch อื่น",
    },
    LocalNotTracking {
      en: "Branch {local} already exists here but does not track {remote}; pick {local} instead",
      th: "มี branch {local} ในเครื่องอยู่แล้วแต่ไม่ได้ track {remote} ให้เลือก {local} แทน",
    },
    BadPrRef {
      en: "{input}: enter a pull request number (such as 123 or #123) or its GitHub link",
      th: "{input}: ใส่เลข pull request (เช่น 123 หรือ #123) หรือลิงก์ GitHub ของมัน",
    },
    PrOtherRepository {
      en: "{url} is a pull request of another repository; origin is {origin}",
      th: "{url} เป็น pull request ของ repository อื่น ส่วน origin คือ {origin}",
    },
    PrNoHead {
      en: "Pull request #{number} has no head branch",
      th: "pull request #{number} ไม่มี head branch",
    },
    PrFetchFailed {
      en: "Could not fetch pull request #{number} from origin: {detail}",
      th: "ดึง pull request #{number} จาก origin ไม่ได้: {detail}",
    },
    BranchMoved {
      en: "The worktree is no longer on {branch}, so it was not renamed",
      th: "worktree ไม่ได้อยู่บน {branch} แล้ว จึงไม่ได้เปลี่ยนชื่อ",
    },
    BranchPublished {
      en: "Branch {branch} is already pushed, so it keeps its name",
      th: "branch {branch} ถูก push แล้ว จึงคงชื่อเดิมไว้",
    },
    RemoveLocked {
      en: "Worktree {slug} is locked by git; run git worktree unlock on it first",
      th: "worktree {slug} ถูก git ล็อกไว้ ให้รัน git worktree unlock ก่อน",
    },
    RemoveOrphan {
      en: "Git no longer tracks {path} but the folder is still there; remove it again to delete the folder",
      th: "git ไม่รู้จัก {path} แล้วแต่โฟลเดอร์ยังอยู่ กดลบอีกครั้งเพื่อลบโฟลเดอร์ทิ้ง",
    },
    RemoveNotWorktree {
      en: "{path} is not a git worktree, so Kingu leaves it alone; delete the folder yourself, then remove the task again",
      th: "{path} ไม่ใช่ git worktree Kingu จึงไม่แตะมัน ลบโฟลเดอร์เองแล้วลบงานอีกครั้ง",
    },
  }
}
