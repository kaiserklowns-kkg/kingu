//! Git: remotes, clone, sync, branches and stashes (git_remote.rs).

crate::i18n::messages! {
  pub enum GitMsg {
    /// The webview offers "Open in Terminal" when an error starts with rustErrors.ts
    /// `remoteAuthFailed` (checked by i18n's tests).
    AuthFailed {
      en: "Authentication with the remote failed: Kingu does not ask for passwords itself. Open it in the Terminal to authenticate, then try again",
      th: "ยืนยันตัวตนกับ remote ไม่สำเร็จ: Kingu ไม่ถามรหัสผ่านเอง เปิดใน Terminal เพื่อยืนยันตัวตนแล้วลองใหม่",
    },
    Busy {
      en: "Another git command is running; wait for it to finish",
      th: "มีคำสั่ง git อื่นกำลังทำงานอยู่ รอให้เสร็จก่อน",
    },
    /// git_queue: an operation waited too long for another one in the same repository.
    QueueTimeout {
      en: "git {op} waited {secs} seconds for another git operation in this repository ({running}) and gave up; try again when it finishes",
      th: "git {op} รอ git อีกงานใน repository นี้ ({running}) นาน {secs} วินาทีแล้วจึงยกเลิก ลองใหม่เมื่องานนั้นเสร็จ",
    },
    Cancelled {
      en: "git {op} was cancelled",
      th: "ยกเลิก git {op} แล้ว",
    },
    TimedOut {
      en: "git {op} took longer than {secs} seconds and was stopped",
      th: "git {op} ใช้เวลานานเกิน {secs} วินาที จึงหยุดไว้",
    },
    NotFastForward {
      en: "Cannot pull with fast-forward: the branch has diverged from its upstream (use Git: Pull (Rebase) or merge yourself)",
      th: "pull แบบ fast-forward ไม่ได้ เพราะ branch แยกทางกับ upstream แล้ว (ใช้ Git: Pull (Rebase) หรือ merge เอง)",
    },
    WouldOverwrite {
      en: "Uncommitted changes would be overwritten; commit or stash them first",
      th: "การแก้ไขที่ยังไม่ commit จะถูกเขียนทับ ให้ commit หรือ stash ก่อน",
    },
    PushRejected {
      en: "Push was rejected: the remote has commits you don't have locally; pull first",
      th: "push ถูกปฏิเสธ เพราะ remote มี commit ที่ยังไม่มีในเครื่อง ให้ pull ก่อน",
    },
    Unreachable {
      en: "Could not reach the remote; check your network connection",
      th: "ติดต่อ remote ไม่ได้ ตรวจการเชื่อมต่อเครือข่าย",
    },
    Conflict {
      en: "There are conflicts; resolve them in Source Control, then commit",
      th: "มี conflict ให้แก้ใน Source Control แล้ว commit",
    },
    OpFailed {
      en: "git {op} failed",
      th: "git {op} ไม่สำเร็จ",
    },
    InvalidBranchName {
      en: "Invalid branch name: {name}",
      th: "ชื่อ branch ไม่ถูกต้อง: {name}",
    },
    PullDetached {
      en: "HEAD is not on a branch (detached), so it cannot pull",
      th: "HEAD ไม่ได้อยู่บน branch (detached) จึง pull ไม่ได้",
    },
    NoUpstream {
      en: "Branch {branch} has no upstream yet; use Publish Branch first",
      th: "branch {branch} ยังไม่มี upstream ให้ Publish Branch ก่อน",
    },
    TagConflict {
      en: "Local tags clash with the remote's tags; turn on git.replaceTagsWhenPull to use the remote's tags instead\n{detail}",
      th: "tag ในเครื่องขัดกับ tag ของ remote เปิด git.replaceTagsWhenPull เพื่อใช้ tag ของ remote แทน\n{detail}",
    },
    PushDetached {
      en: "HEAD is not on a branch (detached); create a branch first, then push",
      th: "HEAD ไม่ได้อยู่บน branch (detached) สร้าง branch ก่อนแล้วจึง push",
    },
    NoRemotes {
      en: "This repository has no remote yet; add one with git remote add first",
      th: "repository นี้ยังไม่มี remote ให้เพิ่มด้วย git remote add ก่อน",
    },
    NoSuchRemote {
      en: "No remote named {remote}",
      th: "ไม่มี remote ชื่อ {remote}",
    },
    InOtherWorktree {
      en: "Branch {name} is checked out in another worktree ({path}), so git won't use it here too",
      th: "branch {name} ถูก check out อยู่ใน worktree อื่น ({path}) git จึงไม่ยอมให้ใช้ที่นี่อีก",
    },
    /// `{what}` in the branch errors below.
    WhatCheckOut {
      en: "check out",
      th: "check out",
    },
    WhatCreateBranch {
      en: "create branch",
      th: "สร้าง branch",
    },
    BranchWouldOverwrite {
      en: "Cannot {what} {name}: uncommitted changes would be overwritten; commit or stash them first\n{detail}",
      th: "{what} {name} ไม่ได้: การแก้ไขที่ยังไม่ commit จะถูกเขียนทับ ให้ commit หรือ stash ก่อน\n{detail}",
    },
    BranchExists {
      en: "A branch named {name} already exists",
      th: "มี branch ชื่อ {name} อยู่แล้ว",
    },
    BranchOpFailed {
      en: "Could not {what} {name}\n{detail}",
      th: "{what} {name} ไม่สำเร็จ\n{detail}",
    },
    TagNotFound {
      en: "Tag {name} not found",
      th: "ไม่พบ tag {name}",
    },
    BranchNotFound {
      en: "Branch {name} not found",
      th: "ไม่พบ branch {name}",
    },
    RemoteBranchNotFound {
      en: "Remote branch {name} not found",
      th: "ไม่พบ remote branch {name}",
    },
    NotRemoteBranch {
      en: "{name}: not a branch of a known remote",
      th: "{name}: ไม่ใช่ branch ของ remote ที่รู้จัก",
    },
    LocalNotTracking {
      en: "Branch {local} already exists but does not track {name}; pick {local} instead",
      th: "มี branch {local} อยู่แล้วแต่ไม่ได้ track {name} ให้เลือก {local} แทน",
    },
    UnknownRev {
      en: "Unknown revision {rev}",
      th: "ไม่รู้จัก {rev}",
    },
    DeleteCurrent {
      en: "Cannot delete the current branch ({name}); check out another branch first",
      th: "ลบ branch ปัจจุบัน ({name}) ไม่ได้ ให้ check out branch อื่นก่อน",
    },
    DeleteFailed {
      en: "Could not delete branch {name}\n{detail}",
      th: "ลบ branch {name} ไม่สำเร็จ\n{detail}",
    },
    StashFailed {
      en: "Stash failed\n{detail}",
      th: "stash ไม่สำเร็จ\n{detail}",
    },
    NothingToStash {
      en: "No changes to stash",
      th: "ไม่มีการเปลี่ยนแปลงให้ stash",
    },
    StashConflict {
      en: "Stash applied with conflicts; resolve them in Source Control\n{detail}",
      th: "นำ stash กลับมาแล้วแต่มี conflict ให้แก้ใน Source Control\n{detail}",
    },
    StashConflictKept {
      en: "Stash applied with conflicts; resolve them in Source Control (the stash was kept)\n{detail}",
      th: "นำ stash กลับมาแล้วแต่มี conflict ให้แก้ใน Source Control (stash ยังเก็บไว้)\n{detail}",
    },
    StashWouldOverwrite {
      en: "Cannot apply the stash: changed files would be overwritten; commit or stash them first\n{detail}",
      th: "นำ stash กลับมาไม่ได้: ไฟล์ที่แก้ไขอยู่จะถูกเขียนทับ ให้ commit หรือ stash ก่อน\n{detail}",
    },
    StashApplyFailed {
      en: "Could not apply {stash}\n{detail}",
      th: "นำ {stash} กลับมาไม่สำเร็จ\n{detail}",
    },
    StashDropFailed {
      en: "Could not drop the stash\n{detail}",
      th: "ลบ stash ไม่สำเร็จ\n{detail}",
    },
    BadCloneUrl {
      en: "Invalid or unsupported repository URL: {url} (use https://…, ssh://… or git@host:owner/repo.git)",
      th: "URL ของ repository ไม่ถูกต้องหรือไม่รองรับ: {url} (ใช้ https://…, ssh://… หรือ git@host:owner/repo.git)",
    },
    NoFolderName {
      en: "Cannot name a folder after this URL",
      th: "ตั้งชื่อโฟลเดอร์จาก URL นี้ไม่ได้",
    },
    DestNotAbsolute {
      en: "The destination folder must be a full path",
      th: "โฟลเดอร์ปลายทางต้องเป็น path เต็ม",
    },
    CreateFolderFailed {
      en: "Could not create folder {path}: {detail}",
      th: "สร้างโฟลเดอร์ {path} ไม่ได้: {detail}",
    },
    DestNotEmpty {
      en: "{path} already exists and is not empty; choose another destination folder",
      th: "มี {path} อยู่แล้วและไม่ว่าง เลือกโฟลเดอร์ปลายทางอื่น",
    },
    DestNotUtf8 {
      en: "The destination path is not UTF-8",
      th: "path ปลายทางไม่ใช่ UTF-8",
    },
    CloneBusy {
      en: "A clone is already running; wait for it or cancel it first",
      th: "กำลัง clone อยู่แล้ว รอให้เสร็จหรือยกเลิกก่อน",
    },
  }
}
