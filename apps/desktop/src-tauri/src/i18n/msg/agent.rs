//! Agents, tasks, worktrees, PRs, reviews, GitHub issues, automations (agent/*).

crate::i18n::messages! {
  pub enum AgentMsg {
    /// The webview shows its gh setup help when an error contains rustErrors.ts `ghMissing`
    /// (checked by i18n's tests).
    GhMissing {
      en: "GitHub CLI (gh) not found: install it with `brew install gh`, then run `gh auth login`",
      th: "ไม่พบ GitHub CLI (gh): ติดตั้งด้วย `brew install gh` แล้ว `gh auth login`",
    },
    GhTimeout {
      en: "gh {what} took longer than {secs} seconds and was stopped",
      th: "gh {what} ใช้เวลานานเกิน {secs} วินาที จึงหยุดไว้",
    },
    BadPrUrl {
      en: "Invalid PR link: {url}",
      th: "ลิงก์ PR ไม่ถูกต้อง: {url}",
    },
    PrMerged {
      en: "This PR is already merged",
      th: "PR นี้ merge แล้ว",
    },
    PrClosed {
      en: "This PR is closed",
      th: "PR นี้ถูกปิดแล้ว",
    },
    PrDraft {
      en: "This PR is still a draft: mark it Ready for review on GitHub first",
      th: "PR นี้ยังเป็น draft ให้เปลี่ยนเป็น Ready for review บน GitHub ก่อน",
    },
    PrReviewRequired {
      en: "This PR needs an approving review before it can be merged",
      th: "PR นี้ต้องได้รับการอนุมัติ (review) ก่อนจึงจะ merge ได้",
    },
    PrChangesRequested {
      en: "A reviewer requested changes to this PR, so it cannot be merged yet",
      th: "ผู้รีวิวขอให้แก้ PR นี้ จึงยัง merge ไม่ได้",
    },
    PrConflict {
      en: "This PR has conflicts with {base}: update the branch with {base} and resolve the conflicts before merging",
      th: "PR นี้มี conflict กับ {base} อัปเดต branch กับ {base} แล้วแก้ conflict ก่อน merge",
    },
    PrViewWrongNumber {
      en: "gh pr view returned PR #{got} instead of #{number}",
      th: "gh pr view ตอบ PR #{got} แทน #{number}",
    },
    ForkBranchKept {
      en: "The branch was not deleted because it is in another repository (fork)",
      th: "ไม่ได้ลบ branch เพราะ branch อยู่ใน repository อื่น (fork)",
    },
    BranchDeleteFailed {
      en: "Merged, but could not delete branch {branch} on GitHub: {detail}",
      th: "merge แล้ว แต่ลบ branch {branch} บน GitHub ไม่ได้: {detail}",
    },
    ReviewThreadsFailed {
      en: "Could not read review threads: {detail}",
      th: "อ่าน review threads ไม่ได้: {detail}",
    },
    NoPullRequest {
      en: "pull request not found",
      th: "ไม่พบ pull request",
    },
    BadThreadId {
      en: "Invalid thread id: {id}",
      th: "thread id ไม่ถูกต้อง: {id}",
    },
    NoGithubResult {
      en: "{mutation}: GitHub returned no result",
      th: "{mutation}: ไม่มีผลลัพธ์จาก GitHub",
    },
    AutomationsUnreadable {
      en: "{path}: cannot be read ({detail})",
      th: "{path}: อ่านไม่ได้ ({detail})",
    },
    AutomationsNewer {
      en: "{path}: written by a newer Kingu (version {version})",
      th: "{path}: เขียนโดย Kingu รุ่นใหม่กว่า (version {version})",
    },
    TooManyAutomations {
      en: "At most {max} automations are allowed",
      th: "มี automation ได้ไม่เกิน {max} รายการ",
    },
    BadAutomationId {
      en: "Invalid automation id: {detail}",
      th: "id ของ automation ไม่ถูกต้อง: {detail}",
    },
    DuplicateAutomationId {
      en: "{id}: duplicate id",
      th: "{id}: id ซ้ำ",
    },
    BadAutomationName {
      en: "{id}: the name must be 1-{max} characters with no control characters",
      th: "{id}: ชื่อต้องยาว 1-{max} ตัวอักษรและไม่มีอักขระควบคุม",
    },
    AutomationNoPrompt {
      en: "{id}: needs instructions for the agent",
      th: "{id}: ต้องมีคำสั่งให้ agent",
    },
    AutomationPromptTooLong {
      en: "{id}: the instructions are longer than {max} bytes",
      th: "{id}: คำสั่งยาวเกิน {max} ไบต์",
    },
    AutomationBadSchedule {
      en: "{id}: invalid schedule",
      th: "{id}: ตารางเวลาไม่ถูกต้อง",
    },
    AutomationBadBranch {
      en: "{id}: invalid branch ({detail})",
      th: "{id}: branch ไม่ถูกต้อง ({detail})",
    },
    AutomationUnknownMode {
      en: "{id}: unknown mode {mode}",
      th: "{id}: ไม่รู้จักโหมด {mode}",
    },
    AutomationBadLastTask {
      en: "{id}: invalid last task ({detail})",
      th: "{id}: งานล่าสุดไม่ถูกต้อง ({detail})",
    },
    AutomationBadSkipReason {
      en: "{id}: the skip reason is longer than {max} bytes or has control characters",
      th: "{id}: เหตุผลที่ข้ามยาวเกิน {max} ไบต์หรือมีอักขระควบคุม",
    },
    BadBranchPrefix {
      en: "Invalid branch prefix \"{prefix}\" (only a-z A-Z 0-9 . _ / - are allowed)",
      th: "branch prefix \"{prefix}\" ไม่ถูกต้อง (ใช้ได้เฉพาะ a-z A-Z 0-9 . _ / -)",
    },
    DetachedWorktree {
      en: "Worktree {slug} is not on a branch (detached HEAD)",
      th: "worktree {slug} ไม่ได้อยู่บน branch (detached HEAD)",
    },
    BadBranchName {
      en: "{branch}: invalid branch name",
      th: "{branch}: ชื่อ branch ไม่ถูกต้อง",
    },
    BaseNotFastForward {
      en: "{base} has commits that are not on {remote}, so it was not updated (cannot fast-forward)",
      th: "{base} มี commit ที่ไม่อยู่บน {remote} จึงไม่ได้อัปเดต (fast-forward ไม่ได้)",
    },
    BaseDirty {
      en: "{base} has uncommitted changes at {path}, so it was not updated",
      th: "{base} มีการแก้ไขที่ยังไม่ commit ที่ {path} จึงไม่ได้อัปเดต",
    },
    BaseUpdated {
      en: "Updated {base} from {remote} ({short})",
      th: "อัปเดต {base} จาก {remote} แล้ว ({short})",
    },
    OpenInAppName {
      en: "app: must be followed by an app name",
      th: "app: ต้องตามด้วยชื่อแอป",
    },
    OpenInAppMacOnly {
      en: "app:<app name> works only on macOS",
      th: "app:<ชื่อแอป> ใช้ได้เฉพาะ macOS",
    },
    NoCommand {
      en: "No command",
      th: "ไม่มีคำสั่ง",
    },
    OpenInNotObject {
      en: "kingu.worktree.openIn must be an object",
      th: "kingu.worktree.openIn ต้องเป็น object",
    },
    OpenInMissing {
      en: "\"{label}\" is not in {setting}",
      th: "ไม่มี \"{label}\" ใน {setting}",
    },
    NotAWorktree {
      en: "{path} is not a worktree of the open folder",
      th: "{path} ไม่ใช่ worktree ของโฟลเดอร์ที่เปิดอยู่",
    },
    ScriptTooLarge {
      en: ".kingu/{name} is larger than {kb} KB",
      th: ".kingu/{name} ใหญ่เกิน {kb} KB",
    },
    ScriptNotUtf8 {
      en: ".kingu/{name} is not UTF-8",
      th: ".kingu/{name} ไม่ใช่ UTF-8",
    },
    NoRepoScript {
      en: "This folder has no {kind} script in the repository",
      th: "โฟลเดอร์นี้ไม่มีสคริปต์ {kind} ของ repository",
    },
    ScriptChanged {
      en: "{path} has changed: review it again before trusting it",
      th: "{path} เปลี่ยนไปแล้ว — ตรวจอีกครั้งก่อนเชื่อถือ",
    },
    ScriptNotTrusted {
      en: "{path} is not trusted (or changed after it was trusted)",
      th: "{path} ยังไม่ได้รับความเชื่อถือ (หรือเปลี่ยนไปหลังจากเชื่อถือ)",
    },
    ScriptHashRequired {
      en: "The hash of the reviewed script is required",
      th: "ต้องระบุ hash ของสคริปต์ที่ตรวจแล้ว",
    },
    BadAiModel {
      en: "kingu.git.ai.model: {model} is not a valid model name",
      th: "kingu.git.ai.model: {model} ไม่ใช่ชื่อ model ที่ใช้ได้",
    },
    AiAgentUnsupported {
      en: "{agent}: generating text with this agent is not supported yet; choose {agents} or custom",
      th: "{agent}: ยังไม่รองรับการสร้างข้อความด้วย agent นี้ — เลือก {agents} หรือ custom",
    },
    UnclosedSingleQuote {
      en: "The command has an unclosed '",
      th: "คำสั่งมี ' ที่ไม่ปิด",
    },
    TrailingBackslash {
      en: "The command ends with \\",
      th: "คำสั่งจบด้วย \\",
    },
    UnclosedDoubleQuote {
      en: "The command has an unclosed \"",
      th: "คำสั่งมี \" ที่ไม่ปิด",
    },
    CustomCommandEmpty {
      en: "kingu.git.ai.customCommand is empty",
      th: "kingu.git.ai.customCommand ว่างอยู่",
    },
    ProgramTimeout {
      en: "{program} took longer than {secs} seconds and was stopped",
      th: "{program} ใช้เวลานานเกิน {secs} วินาทีจึงหยุดไว้",
    },
    ProgramExited {
      en: "{program} exited with {code}: {detail}",
      th: "{program} จบด้วย {code}: {detail}",
    },
    ProgramNoOutput {
      en: "{program} returned nothing",
      th: "{program} ไม่ได้ตอบอะไรกลับมา",
    },
    PromptTooLong {
      en: "The prompt is too long",
      th: "prompt ยาวเกินไป",
    },
    IssueNoNumber {
      en: "gh: the issue has no number",
      th: "gh: issue ไม่มีหมายเลข",
    },
    GhUnreadable {
      en: "{op}: cannot read the result ({detail})",
      th: "{op}: อ่านผลไม่ได้ ({detail})",
    },
    GhNotAList {
      en: "gh issue list: the result is not a list",
      th: "gh issue list: ผลไม่ใช่รายการ",
    },
    GhNotLoggedIn {
      en: "gh is not logged in: run `gh auth login` in a terminal",
      th: "gh ยังไม่ได้เข้าสู่ระบบ: รัน `gh auth login` ในเทอร์มินัล",
    },
    NoGithubRemote {
      en: "This folder has no remote that points to GitHub (such as origin on github.com)",
      th: "โฟลเดอร์นี้ไม่มี remote ที่ชี้ไป GitHub (เช่น origin บน github.com)",
    },
    GithubNotFound {
      en: "Repository or issue not found on GitHub (or no access)",
      th: "ไม่พบ repository หรือ issue นี้บน GitHub (หรือไม่มีสิทธิ์เข้าถึง)",
    },
    IssuesDisabled {
      en: "This repository has Issues turned off",
      th: "repository นี้ปิด Issues ไว้",
    },
    GithubUnreachable {
      en: "Could not connect to GitHub: check the internet connection",
      th: "เชื่อมต่อ GitHub ไม่ได้ ตรวจสอบอินเทอร์เน็ต",
    },
    Failed {
      en: "failed",
      th: "ล้มเหลว",
    },
    GhNoReply {
      en: "{op}: gh did not answer within {secs} seconds",
      th: "{op}: gh ไม่ตอบภายใน {secs} วินาที",
    },
    BadIssueState {
      en: "Invalid issue state: {state}",
      th: "สถานะ issue ไม่ถูกต้อง: {state}",
    },
    BadAssignee {
      en: "Invalid assignee name: {name}",
      th: "ชื่อผู้รับผิดชอบไม่ถูกต้อง: {name}",
    },
    CommentLength {
      en: "The comment must be 1-{max} bytes",
      th: "ข้อความ comment ต้องยาว 1-{max} bytes",
    },
    NotJson {
      en: "{path} cannot be read (not JSON), so it was left unchanged",
      th: "{path} อ่านไม่ได้ (ไม่ใช่ JSON) จึงไม่แก้",
    },
    NotToml {
      en: "{path} cannot be read (not TOML), so it was left unchanged",
      th: "{path} อ่านไม่ได้ (ไม่ใช่ TOML) จึงไม่แก้",
    },
    NoBun {
      en: "bun not found for running the agent host: install bun or set KINGU_BUN / KINGU_AGENT_HOST",
      th: "ไม่พบ bun สำหรับรัน agent host: ติดตั้ง bun หรือตั้ง KINGU_BUN / KINGU_AGENT_HOST",
    },
    HostExited {
      en: "The agent host exited unexpectedly",
      th: "agent host หยุดทำงานกะทันหัน",
    },
    /// Single owner per agent session (`host::Owners`).
    SessionBusy {
      en: "This agent session is already running in Kingu: continue it there, or stop it first",
      th: "session นี้กำลังทำงานอยู่ใน Kingu แล้ว: ทำงานต่อที่เดิม หรือหยุดมันก่อน",
    },
    ChatBusy {
      en: "This chat already has a running agent: stop it first",
      th: "แชตนี้มี agent ทำงานอยู่แล้ว: หยุดก่อน",
    },
    ChatCwdOutside {
      en: "{path}: an agent chat runs only in the open folder or one of its task worktrees",
      th: "{path}: แชต agent รันได้เฉพาะในโฟลเดอร์ที่เปิดอยู่หรือ worktree ของงานในโฟลเดอร์นั้น",
    },
    ChatCwdMissing {
      en: "{path}: folder not found",
      th: "{path}: ไม่พบโฟลเดอร์",
    },
    ChatFolderChanged {
      en: "The open folder changed: open {path} again to run this chat",
      th: "โฟลเดอร์ที่เปิดเปลี่ยนไปแล้ว: เปิด {path} อีกครั้งเพื่อรันแชตนี้",
    },
    BadChatId {
      en: "Invalid chat id",
      th: "รหัสแชตไม่ถูกต้อง",
    },
    /// Chat edits (agent/chat_edits.rs): Undo / Restore checkpoint while a turn still runs.
    EditsBusy {
      en: "The agent is still working in this chat: wait for the turn to end or stop it, then undo",
      th: "agent ยังทำงานอยู่ในแชตนี้: รอให้รอบนี้จบหรือหยุดก่อน แล้วค่อยย้อนกลับ",
    },
    EditNotRestorable {
      en: "{path}: no saved copy from before the agent changed it, so it cannot be undone here",
      th: "{path}: ไม่มีสำเนาก่อน agent แก้ไว้ จึงย้อนกลับจากที่นี่ไม่ได้",
    },
    EditPathOutside {
      en: "{path}: outside the chat's folder",
      th: "{path}: อยู่นอกโฟลเดอร์ของแชต",
    },
    EditNoRequest {
      en: "This chat has no request {index}",
      th: "แชตนี้ไม่มีคำขอที่ {index}",
    },
    /// Keep / Undo of one change in the editor (agent/chat_edits/hunks.rs).
    EditHunkGone {
      en: "{path}: that change is no longer there (the file changed since); look at its changes again",
      th: "{path}: ไม่มีการแก้ตรงนั้นแล้ว (ไฟล์เปลี่ยนไปหลังจากนั้น) ลองดูการแก้ของไฟล์อีกครั้ง",
    },
    EditHunkNoRoom {
      en: "{path}: the chat's snapshot store is full, so this change cannot be kept on its own; keep the whole file instead",
      th: "{path}: ที่เก็บสำเนาของแชตเต็มแล้ว จึงเก็บการแก้นี้แยกไม่ได้ ให้เก็บทั้งไฟล์แทน",
    },
    EditCwdChanged {
      en: "The chat's edits were made in {path}, not in this folder",
      th: "การแก้ไขของแชตนี้ทำใน {path} ไม่ใช่โฟลเดอร์นี้",
    },
    NoAgentCwd {
      en: "No working directory for the agent: pass a chat folder or a task",
      th: "ไม่ได้ระบุโฟลเดอร์ทำงานของ agent: ต้องระบุโฟลเดอร์ของแชตหรืองาน",
    },
    MergeDirty {
      en: "{slug}: has uncommitted changes; commit or discard them before merging",
      th: "{slug}: มีการเปลี่ยนแปลงที่ยังไม่ commit, commit หรือทิ้งก่อน merge",
    },
    NothingToMerge {
      en: "{branch}: no new commits to merge into {base}",
      th: "{branch}: ไม่มี commit ใหม่ให้ merge เข้า {base}",
    },
    BaseCheckoutDirty {
      en: "{path}: {base} has uncommitted changes",
      th: "{path}: {base} มีการแก้ไขที่ยังไม่ commit",
    },
    BaseNotCheckedOut {
      en: "{base} is not checked out anywhere: a merge commit needs {base} checked out first",
      th: "{base} ไม่ได้ checkout อยู่ที่ไหน: merge commit ต้อง checkout {base} ก่อน",
    },
    BaseAhead {
      en: "{base} has new commits: cannot fast-forward; check out {base} and use a merge commit",
      th: "{base} มี commit ใหม่: fast-forward ไม่ได้, checkout {base} แล้วใช้ merge commit",
    },
    NoOrigin {
      en: "No remote named origin",
      th: "ไม่มี remote ชื่อ origin",
    },
  }
}
