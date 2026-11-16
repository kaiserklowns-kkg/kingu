//! The added projects of the Agents side bar (projects.rs, ssh_projects.rs).

crate::i18n::messages! {
  pub enum ProjectsMsg {
    NotAFolder {
      en: "{path}: not a folder",
      th: "{path}: ไม่ใช่โฟลเดอร์",
    },
    NotAdded {
      en: "{path} is not an added project",
      th: "{path} ไม่ได้เพิ่มเป็นโปรเจกต์",
    },
    TooMany {
      en: "At most {max} projects can be added; remove one first",
      th: "เพิ่มโปรเจกต์ได้ไม่เกิน {max} โปรเจกต์ ลบโปรเจกต์หนึ่งออกก่อน",
    },
    RemoteNotRepo {
      en: "{path} on {host} is not a git repository",
      th: "{path} บน {host} ไม่ใช่ git repository",
    },
    RemoteNotACommit {
      en: "{base} is not a commit on the host",
      th: "{base} ไม่ใช่ commit บนเครื่องปลายทาง",
    },
    RemoteWorktreeExists {
      en: "{path} already exists on the host",
      th: "{path} มีอยู่แล้วบนเครื่องปลายทาง",
    },
    RemoteBadPath {
      en: "{path} is not a folder of this project",
      th: "{path} ไม่ใช่โฟลเดอร์ของโปรเจกต์นี้",
    },
    RemoteBadFile {
      en: "{path} is not a file path inside the worktree",
      th: "{path} ไม่ใช่ path ของไฟล์ใน worktree",
    },
    RemoteNotAFile {
      en: "{path} is not a file on the host",
      th: "{path} ไม่ใช่ไฟล์บนเครื่องปลายทาง",
    },
    RemoteBadAnswer {
      en: "The host's answer could not be read",
      th: "อ่านคำตอบจากเครื่องปลายทางไม่ได้",
    },
    RemoteEmptyMessage {
      en: "Type a commit message first",
      th: "พิมพ์ข้อความ commit ก่อน",
    },
    RemoteNoBranch {
      en: "The worktree on the host is not on a branch",
      th: "worktree บนเครื่องปลายทางไม่ได้อยู่บน branch",
    },
    RemoteNoGithub {
      en: "origin on the host is not a GitHub, GitLab or Bitbucket repository: {url}",
      th: "origin บนเครื่องปลายทางไม่ใช่ repository ของ GitHub, GitLab หรือ Bitbucket: {url}",
    },
    RemotePushFailed {
      en: "Push on the host failed: {detail}",
      th: "push บนเครื่องปลายทางไม่สำเร็จ: {detail}",
    },
  }
}
