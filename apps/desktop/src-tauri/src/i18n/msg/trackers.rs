//! Task sources over REST and GraphQL: GitLab issues (gitlab.rs), Jira (jira.rs), GitHub
//! Projects (agent/gh_projects.rs) and their shared HTTP side (tracker_http.rs).

crate::i18n::messages! {
  pub enum TrackerMsg {
    Timeout {
      en: "{service} did not respond in time",
      th: "{service} ไม่ตอบภายในเวลาที่กำหนด",
    },
    Connect {
      en: "Could not connect to {service}; check your internet connection ({detail})",
      th: "เชื่อมต่อ {service} ไม่ได้ ตรวจสอบอินเทอร์เน็ต ({detail})",
    },
    RateLimited {
      en: "{service} is temporarily rate limiting requests; try again in a moment",
      th: "{service} จำกัดจำนวนคำขอชั่วคราว ลองใหม่ในอีกสักครู่",
    },
    ServerError {
      en: "{service} is having problems (HTTP {status}); try again later",
      th: "{service} ขัดข้อง (HTTP {status}) ลองใหม่ภายหลัง",
    },
    BadResponse {
      en: "{service}: could not read the response (HTTP {status})",
      th: "{service}: อ่านผลไม่ได้ (HTTP {status})",
    },
    NoViewer {
      en: "{service}: user data not found",
      th: "{service}: ไม่พบข้อมูลผู้ใช้",
    },
    NoIssueNumber {
      en: "{service}: an issue has no key or number",
      th: "{service}: มี issue ที่ไม่มี key หรือหมายเลข",
    },
    NotIssueList {
      en: "{service}: the response is not a list of issues",
      th: "{service}: ผลไม่ใช่รายการ issue",
    },
    BadIssueKey {
      en: "Invalid {service} issue: {key}",
      th: "issue ของ {service} ไม่ถูกต้อง: {key}",
    },
    BadFilter {
      en: "Invalid {service} issue filter: {filter}",
      th: "ตัวกรอง issue ของ {service} ไม่ถูกต้อง: {filter}",
    },
    CommentLength {
      en: "The comment must be 1-{max} bytes long",
      th: "ข้อความ comment ต้องยาว 1-{max} bytes",
    },
    SaveSecretFailed {
      en: "Could not save the credentials to the Keychain: {detail}",
      th: "บันทึกข้อมูลเข้าสู่ระบบลง Keychain ไม่สำเร็จ: {detail}",
    },
    DeleteSecretFailed {
      en: "Could not remove the credentials from the Keychain: {detail}",
      th: "ลบข้อมูลเข้าสู่ระบบจาก Keychain ไม่สำเร็จ: {detail}",
    },
    OnlyHostLinks {
      en: "Only https links on {host} can be opened",
      th: "เปิดได้เฉพาะลิงก์ https บน {host}",
    },
    GitlabBadHost {
      en: "Invalid GitLab host: {host} (like gitlab.com or gitlab.example.com:8443)",
      th: "host ของ GitLab ไม่ถูกต้อง: {host} (เช่น gitlab.com หรือ gitlab.example.com:8443)",
    },
    GitlabBadProject {
      en: "Invalid GitLab project path: {project} (like group/app)",
      th: "path ของโปรเจกต์ GitLab ไม่ถูกต้อง: {project} (เช่น group/app)",
    },
    GitlabAuthFailed {
      en: "GitLab rejected this token (expired, revoked or invalid): reconnect with GitLab: Connect",
      th: "GitLab ไม่รับ token นี้ (หมดอายุ ถูกเพิกถอน หรือไม่ถูกต้อง): เชื่อมต่อใหม่ด้วย GitLab: Connect",
    },
    GitlabForbidden {
      en: "GitLab: this token may not read the project; it needs the read_api scope (api to comment)",
      th: "GitLab: token นี้ไม่มีสิทธิ์อ่านโปรเจกต์ ต้องมี scope read_api (และ api ถ้าจะ comment)",
    },
    GitlabNotFound {
      en: "GitLab: project or issue not found (or the token has no access to it)",
      th: "GitLab: ไม่พบโปรเจกต์หรือ issue (หรือ token ไม่มีสิทธิ์เข้าถึง)",
    },
    GitlabNotConnected {
      en: "GitLab ({host}) is not connected: run GitLab: Connect and paste a personal access token",
      th: "ยังไม่ได้เชื่อมต่อ GitLab ({host}): รันคำสั่ง GitLab: Connect แล้ววาง personal access token",
    },
    GitlabNoProject {
      en: "No remote of this folder is on {host}: set kingu.gitlab.project (group/app)",
      th: "โฟลเดอร์นี้ไม่มี remote บน {host}: ตั้งค่า kingu.gitlab.project (group/app)",
    },
    GitlabBadToken {
      en: "Invalid token: create one in GitLab > Preferences > Access tokens with the api or read_api scope",
      th: "token ไม่ถูกต้อง: สร้างได้ที่ GitLab > Preferences > Access tokens โดยเลือก scope api หรือ read_api",
    },
    JiraBadSite {
      en: "Invalid Jira site: {site} (like https://your-team.atlassian.net)",
      th: "site ของ Jira ไม่ถูกต้อง: {site} (เช่น https://your-team.atlassian.net)",
    },
    JiraBadJql {
      en: "kingu.jira.jql must be a JQL condition without ORDER BY, at most 2000 characters",
      th: "kingu.jira.jql ต้องเป็นเงื่อนไข JQL ที่ไม่มี ORDER BY และยาวไม่เกิน 2000 ตัวอักษร",
    },
    JiraAuthFailed {
      en: "Jira rejected the email or API token: reconnect with Jira: Connect",
      th: "Jira ไม่รับอีเมลหรือ API token นี้: เชื่อมต่อใหม่ด้วย Jira: Connect",
    },
    JiraForbidden {
      en: "Jira: this account may not do that (check the project permissions)",
      th: "Jira: บัญชีนี้ไม่มีสิทธิ์ทำสิ่งนี้ (ตรวจสอบสิทธิ์ของโปรเจกต์)",
    },
    JiraNotFound {
      en: "Issue not found in Jira (or you don't have access)",
      th: "ไม่พบ issue นี้ใน Jira (หรือไม่มีสิทธิ์เข้าถึง)",
    },
    JiraNotConnected {
      en: "Jira is not connected: run Jira: Connect with your site, email and API token",
      th: "ยังไม่ได้เชื่อมต่อ Jira: รันคำสั่ง Jira: Connect ด้วย site อีเมล และ API token",
    },
    JiraBadEmail {
      en: "Enter the email of your Atlassian account",
      th: "กรอกอีเมลของบัญชี Atlassian",
    },
    JiraBadToken {
      en: "Invalid API token: create one at id.atlassian.com > Security > API tokens",
      th: "API token ไม่ถูกต้อง: สร้างได้ที่ id.atlassian.com > Security > API tokens",
    },
    GhProjectBadRef {
      en: "Invalid GitHub project: {project} (like acme/3, @me/1 or the project's URL)",
      th: "GitHub project ไม่ถูกต้อง: {project} (เช่น acme/3, @me/1 หรือ URL ของ project)",
    },
    GhProjectUnreadable {
      en: "Could not read GitHub's answer ({detail})",
      th: "อ่านผลจาก GitHub ไม่ได้ ({detail})",
    },
    GhProjectNotFound {
      en: "GitHub project not found (or your gh account has no access to it)",
      th: "ไม่พบ GitHub project นี้ (หรือบัญชี gh ไม่มีสิทธิ์เข้าถึง)",
    },
    GhProjectScope {
      en: "gh needs the read:project scope for GitHub Projects: run gh auth refresh -s read:project in a terminal",
      th: "gh ต้องมี scope read:project เพื่ออ่าน GitHub Projects: รัน gh auth refresh -s read:project ใน terminal",
    },
    GhProjectBadUrl {
      en: "Not a GitHub issue URL: {url}",
      th: "ไม่ใช่ URL ของ GitHub issue: {url}",
    },
  }
}
