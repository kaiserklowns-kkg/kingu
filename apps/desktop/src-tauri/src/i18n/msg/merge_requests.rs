//! GitLab merge requests in the ADE's PR flow (agent/mr.rs).

crate::i18n::messages! {
  pub enum MrMsg {
    Connected {
      en: "GitLab ({host})",
      th: "GitLab ({host})",
    },
    BadUrl {
      en: "Not a GitLab merge request link: {url}",
      th: "ไม่ใช่ลิงก์ merge request ของ GitLab: {url}",
    },
    OtherHost {
      en: "This merge request is on {host}, but this folder's GitLab is {expected}",
      th: "merge request นี้อยู่บน {host} แต่ GitLab ของโฟลเดอร์นี้คือ {expected}",
    },
    EmptyTitle {
      en: "Enter a merge request title",
      th: "ใส่ชื่อ merge request",
    },
    Forbidden {
      en: "GitLab: this token may not change merge requests here; it needs the api scope and Developer access",
      th: "GitLab: token นี้ไม่มีสิทธิ์แก้ไข merge request ในโปรเจกต์นี้ ต้องมี scope api และสิทธิ์ระดับ Developer",
    },
    NotFound {
      en: "GitLab: merge request, project or job not found (or the token has no access to it)",
      th: "GitLab: ไม่พบ merge request โปรเจกต์ หรือ job (หรือ token ไม่มีสิทธิ์เข้าถึง)",
    },
    Draft {
      en: "This merge request is still a draft: mark it ready on GitLab first",
      th: "merge request นี้ยังเป็น draft อยู่ กด Mark as ready บน GitLab ก่อน",
    },
    NotMergeable {
      en: "GitLab will not merge this merge request now: {detail}",
      th: "GitLab ยัง merge ไม่ได้ตอนนี้: {detail}",
    },
    HeadMoved {
      en: "New commits reached the branch since the merge request was read: refresh and check them before merging",
      th: "มี commit ใหม่เข้ามาใน branch หลังจากอ่าน merge request ล่าสุด รีเฟรชและตรวจดูก่อน merge",
    },
    NotMerged {
      en: "GitLab did not merge the merge request (it is {state})",
      th: "GitLab ไม่ได้ merge ให้ (สถานะตอนนี้คือ {state})",
    },
    NoLink {
      en: "GitLab did not return the merge request link",
      th: "GitLab ไม่ได้ส่งลิงก์ของ merge request กลับมา",
    },
    LogUnavailable {
      en: "The job log could not be read (HTTP {status})",
      th: "อ่าน log ของ job ไม่ได้ (HTTP {status})",
    },
    BadDiscussion {
      en: "Invalid GitLab discussion id: {id}",
      th: "id ของ discussion บน GitLab ไม่ถูกต้อง: {id}",
    },
  }
}
