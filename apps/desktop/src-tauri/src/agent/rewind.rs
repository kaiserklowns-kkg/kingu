//! Rewinding and forking agent chats, like VS Code's Restore Checkpoint, Edit request, Retry and
//! Fork Conversation: the conversation goes back too, not only the files.
//!
//! - Rewind points: the agent host sends an `Anchor` (the SDK message uuid) after each message of
//!   the session's main chain. While a chat runs, [`Anchors`] follows them and stamps each
//!   `Checkpoint` (the request Rust numbered after a user message) with the last one before it
//!   and its session. The transcript keeps both, so the request → rewind point mapping lives with
//!   the conversation and is cut with it.
//! - [`rewind`] to request N: its files go back (`chat_edits::rewind_files`), the transcript is cut
//!   before N's user message, and the cut-off tail plus what Redo needs are kept in
//!   `<root>/.kingu/chats/<id>/redo.json` until the next run of the chat starts ([`clear_redo`]).
//!   The returned [`Resume`] is where the next run continues: the SDK's `resume` +
//!   `resumeSessionAt` + `forkSession`, so the original session stays whole (Redo just goes back to it).
//! - [`fork`]: a new chat with the transcript before request N (all of it with none) whose first
//!   run continues from the same point.

use std::path::Path;

use crate::i18n::msg::{AgentMsg, FilesMsg};
use crate::tr;

use super::chat_edits::{self, EditsRedo, Report, Store};
use super::chats::{Line, transcript_path, write_atomic_big};
use super::events::AgentEvent;
use super::tasks::valid_session_id;

const REDO: &str = "redo.json";

/// A uuid as the SDK writes them: 8-4-4-4-12 hex digits.
pub fn valid_uuid(s: &str) -> bool {
  let parts: Vec<&str> = s.split('-').collect();
  parts.len() == 5 && parts.iter().zip([8, 4, 4, 4, 12]).all(|(p, n)| p.len() == n && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Where a run continues a chat's conversation. Both set: `session_id` up to `resume_at` (in a
/// fork of it). Only `session_id`: all of that session (a transcript from before rewind points
/// were kept). Neither: a new session.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct Resume {
  pub session_id: Option<String>,
  pub resume_at: Option<String>,
}

/// A chat run's rewind points: its session and the last anchor seen (with the session it is in).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Anchors {
  session: Option<String>,
  last: Option<(String, String)>,
}

impl Anchors {
  /// Follows one event; stamps a `Checkpoint` with the last anchor before it.
  pub fn observe(&mut self, ev: &mut AgentEvent) {
    match ev {
      AgentEvent::System { session_id: Some(id), .. } | AgentEvent::Result { session_id: Some(id), .. } if valid_session_id(id) => {
        self.session = Some(id.clone());
      }
      AgentEvent::Anchor { uuid } if valid_uuid(uuid) => {
        if let Some(s) = &self.session {
          self.last = Some((s.clone(), uuid.clone()));
        }
      }
      AgentEvent::Checkpoint { session_id, resume_at, .. } => {
        if let Some((s, u)) = &self.last {
          *session_id = Some(s.clone());
          *resume_at = Some(u.clone());
        }
      }
      _ => {}
    }
  }

  fn of<'a>(events: impl IntoIterator<Item = &'a AgentEvent>) -> Self {
    let mut a = Anchors::default();
    for ev in events {
      a.observe(&mut ev.clone());
    }
    a
  }

  /// Where the conversation so far ends.
  fn resume(&self) -> Resume {
    match &self.last {
      Some((s, u)) => Resume { session_id: Some(s.clone()), resume_at: Some(u.clone()) },
      None => Resume { session_id: self.session.clone(), resume_at: None },
    }
  }
}

/// The rewind points of chat `id` so far (a new run of it goes on from them). Best effort.
pub fn anchors(root: &Path, id: &str) -> Anchors {
  let text = transcript_path(root, id).ok().and_then(|p| read_transcript(&p).ok()).unwrap_or_default();
  Anchors::of(&lines(&text).into_iter().filter_map(|(_, ev)| ev).collect::<Vec<_>>())
}

fn read_transcript(path: &Path) -> Result<String, String> {
  match std::fs::read(path) {
    Ok(b) => Ok(String::from_utf8_lossy(&b).into_owned()),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
    Err(e) => Err(format!("{}: {e}", path.display())),
  }
}

/// The transcript's lines (with their newline) and their events (`None` when a line does not parse).
fn lines(text: &str) -> Vec<(&str, Option<AgentEvent>)> {
  text.split_inclusive('\n').map(|l| (l, serde_json::from_str::<Line>(l.trim_end()).ok().map(|l| l.event))).collect()
}

/// A transcript cut before a request: what stays, what goes, and where the conversation resumes.
#[derive(Debug, PartialEq)]
struct Split {
  head: String,
  tail: String,
  resume: Resume,
}

/// Cuts `text` before request `request`'s user message (`None`: keeps it all); `None` when the
/// transcript has no checkpoint of that request.
fn split(text: &str, request: Option<u32>) -> Option<Split> {
  let lines = lines(text);
  let Some(request) = request else {
    let resume = Anchors::of(lines.iter().filter_map(|(_, e)| e.as_ref())).resume();
    return Some(Split { head: text.to_owned(), tail: String::new(), resume });
  };
  let at = lines.iter().position(|(_, e)| matches!(e, Some(AgentEvent::Checkpoint { request: r, .. }) if *r == request))?;
  let cut = lines[..at].iter().rposition(|(_, e)| matches!(e, Some(AgentEvent::Message { role, parent_tool_use_id: None, .. }) if role == "user")).unwrap_or(at);
  let resume = match &lines[at].1 {
    Some(AgentEvent::Checkpoint { session_id: Some(s), resume_at: Some(u), .. }) if valid_session_id(s) && valid_uuid(u) => Resume { session_id: Some(s.clone()), resume_at: Some(u.clone()) },
    _ => Anchors::of(lines[..cut].iter().filter_map(|(_, e)| e.as_ref())).resume(),
  };
  Some(Split { head: lines[..cut].iter().map(|(l, _)| *l).collect(), tail: lines[cut..].iter().map(|(l, _)| *l).collect(), resume })
}

/// What a rewind keeps for Redo.
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct Redo {
  /// The transcript lines it cut off.
  tail: String,
  /// The files and edits file from before it; none when the chat had no edits store.
  edits: Option<EditsRedo>,
}

fn redo_path(root: &Path, id: &str) -> Result<std::path::PathBuf, String> {
  Ok(chat_edits::chat_dir(root, id)?.join(REDO))
}

fn load_redo(root: &Path, id: &str) -> Result<Option<Redo>, String> {
  let path = redo_path(root, id)?;
  if std::fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file()) {
    return Err(tr!(FilesMsg::NotARegularFile, path = path.display()));
  }
  match std::fs::read_to_string(&path) {
    Ok(text) => serde_json::from_str(&text).map(Some).map_err(|e| format!("{REDO}: {e}")),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(e) => Err(format!("{}: {e}", path.display())),
  }
}

/// The files and edits file Redo would put back (their snapshot blobs must be kept).
pub fn redo_edits(root: &Path, id: &str) -> Result<Option<EditsRedo>, String> {
  Ok(load_redo(root, id)?.and_then(|r| r.edits))
}

/// Drops what Redo would put back: a run of the chat started, so the rewind is final.
pub fn clear_redo(root: &Path, id: &str) -> Result<(), String> {
  let path = redo_path(root, id)?;
  match std::fs::remove_file(&path) {
    Ok(()) => Ok(()),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(e) => Err(format!("{}: {e}", path.display())),
  }
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct Rewound {
  #[serde(flatten)]
  pub resume: Resume,
  /// What happened to the files.
  pub report: Report,
}

/// Rewinds chat `id` to before request `request`: its files and every later request's go back,
/// and the transcript loses that request and the rest. `stack`: a rewind made since the last
/// run is still undoable, and Redo should undo both (else this one replaces it). `store`: the
/// chat's edits store, if it has one. The caller holds the edits lock and checked no run is live.
pub fn rewind(root: &Path, id: &str, request: u32, stack: bool, store: Option<&Store>) -> Result<Rewound, String> {
  let path = transcript_path(root, id)?;
  let text = read_transcript(&path)?;
  let cut = split(&text, Some(request)).ok_or_else(|| tr!(AgentMsg::RewindNoRequest, index = request + 1))?;
  let (report, edits) = match store {
    Some(s) => {
      let (r, e) = chat_edits::rewind_files(s, request)?;
      (r, Some(e))
    }
    None => (Report::default(), None),
  };
  let mut redo = Redo { tail: cut.tail, edits };
  if stack && let Some(prev) = load_redo(root, id)? {
    redo = Redo {
      tail: redo.tail + &prev.tail,
      edits: match (prev.edits, redo.edits) {
        (Some(first), Some(then)) => Some(first.stack(then)),
        (first, then) => first.or(then),
      },
    };
  }
  let json = serde_json::to_string(&redo).map_err(|e| e.to_string())?;
  write_atomic_big(&redo_path(root, id)?, &json)?;
  write_atomic_big(&path, &cut.head)?;
  Ok(Rewound { resume: cut.resume, report })
}

/// Redo: puts back what the rewinds since the chat's last run took away (files and transcript).
pub fn redo(root: &Path, id: &str, store: Option<&Store>) -> Result<Report, String> {
  let redo = load_redo(root, id)?.ok_or_else(|| tr!(AgentMsg::RewindNothingToRedo))?;
  let report = match (store, &redo.edits) {
    (Some(s), Some(e)) => chat_edits::redo_files(s, e)?,
    _ => Report::default(),
  };
  let path = transcript_path(root, id)?;
  let mut text = read_transcript(&path)?;
  if !text.is_empty() && !text.ends_with('\n') {
    text.push('\n');
  }
  text.push_str(&redo.tail);
  write_atomic_big(&path, &text)?;
  clear_redo(root, id)?;
  Ok(report)
}

/// Fork: chat `to` (new) gets chat `from`'s transcript before request `before` (all of it with
/// none); its first run continues the conversation from there (the returned `Resume`). The
/// source chat is unchanged. `store`: `from`'s edits store, whose request numbers the copy keeps.
pub fn fork(root: &Path, from: &str, to: &str, before: Option<u32>, store: Option<&Store>) -> Result<Resume, String> {
  let src = transcript_path(root, from)?;
  let dst = transcript_path(root, to)?;
  if std::fs::symlink_metadata(&dst).is_ok() || chat_edits::chat_dir(root, to)?.exists() {
    return Err(tr!(AgentMsg::ForkExists));
  }
  let text = read_transcript(&src)?;
  let cut = split(&text, before).ok_or_else(|| tr!(AgentMsg::RewindNoRequest, index = before.unwrap_or(0) + 1))?;
  if let Some(s) = store {
    chat_edits::seed_fork(s, &Store::open(root, to, s.cwd())?, before)?;
  }
  write_atomic_big(&dst, &cut.head)?;
  Ok(cut.resume)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::agent::chats::{Transcript, load_transcript};

  const U1: &str = "0b5e9a1c-4c1d-4e2f-9a3b-000000000001";
  const U2: &str = "0b5e9a1c-4c1d-4e2f-9a3b-000000000002";
  const U3: &str = "0b5e9a1c-4c1d-4e2f-9a3b-000000000003";

  fn user(text: &str) -> AgentEvent {
    AgentEvent::Message { role: "user".into(), text: text.into(), parent_tool_use_id: None }
  }
  fn said(text: &str) -> AgentEvent {
    AgentEvent::Message { role: "assistant".into(), text: text.into(), parent_tool_use_id: None }
  }
  fn system(s: &str) -> AgentEvent {
    AgentEvent::System { subtype: "init".into(), session_id: Some(s.into()), model: None }
  }
  fn anchor(u: &str) -> AgentEvent {
    AgentEvent::Anchor { uuid: u.into() }
  }
  fn checkpoint(request: u32) -> AgentEvent {
    AgentEvent::Checkpoint { request, session_id: None, resume_at: None }
  }
  fn exit() -> AgentEvent {
    AgentEvent::Exit { code: Some(0), signal: None, stopped: false }
  }

  /// Writes events through `Anchors` like a chat run's sink does.
  fn run(root: &Path, id: &str, events: Vec<AgentEvent>) {
    let t = Transcript::new(root, id).unwrap();
    let mut a = anchors(root, id);
    for mut ev in events {
      a.observe(&mut ev);
      t.append(&ev).unwrap();
    }
  }

  /// Two runs: request 0 in session s-1, then request 1 resumed (same session), request 2 in it.
  fn chat(root: &Path) {
    run(root, "c", vec![user("หนึ่ง"), checkpoint(0), system("s-1"), said("ตอบหนึ่ง"), anchor(U1), exit()]);
    run(root, "c", vec![user("สอง"), checkpoint(1), system("s-1"), said("ตอบสอง"), anchor(U2), user("สาม"), checkpoint(2), said("ตอบสาม"), anchor(U3), exit()]);
  }

  fn texts(root: &Path, id: &str) -> Vec<String> {
    load_transcript(root, id).unwrap().into_iter().filter_map(|e| if let AgentEvent::Message { text, .. } = e { Some(text) } else { None }).collect()
  }

  #[test]
  fn uuids_are_checked() {
    assert!(valid_uuid(U1) && valid_uuid(&U1.to_uppercase()));
    for bad in ["", "x", "0b5e9a1c-4c1d-4e2f-9a3b", "0b5e9a1c-4c1d-4e2f-9a3b-00000000000z", "--resume-0b5e9a1c-4c1d-4e2f-9a3b-000000000001"] {
      assert!(!valid_uuid(bad), "{bad}");
    }
  }

  #[test]
  fn checkpoints_are_stamped_with_the_last_anchor_before_them() {
    let (_t, root) = tmp();
    chat(&root);
    let events = load_transcript(&root, "c").unwrap();
    let stamps: Vec<_> = events.iter().filter_map(|e| if let AgentEvent::Checkpoint { request, resume_at, .. } = e { Some((*request, resume_at.clone())) } else { None }).collect();
    assert_eq!(stamps, [(0, None), (1, Some(U1.into())), (2, Some(U2.into()))], "the second run starts from the transcript's anchors");
    assert!(!events.iter().any(|e| matches!(e, AgentEvent::Anchor { .. })), "anchors stay in Rust");
  }

  fn tmp() -> (tempfile::TempDir, std::path::PathBuf) {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().canonicalize().unwrap();
    (t, root)
  }

  #[test]
  fn rewind_cuts_the_transcript_and_redo_puts_it_back() {
    let (_t, root) = tmp();
    chat(&root);
    let before = std::fs::read_to_string(transcript_path(&root, "c").unwrap()).unwrap();
    let r = rewind(&root, "c", 2, false, None).unwrap();
    assert_eq!(r.resume, Resume { session_id: Some("s-1".into()), resume_at: Some(U2.into()) });
    assert_eq!(texts(&root, "c"), ["หนึ่ง", "ตอบหนึ่ง", "สอง", "ตอบสอง"]);
    // Rewinding again before Redo: Redo undoes both.
    let r = rewind(&root, "c", 1, true, None).unwrap();
    assert_eq!(r.resume.resume_at.as_deref(), Some(U1));
    assert_eq!(texts(&root, "c"), ["หนึ่ง", "ตอบหนึ่ง"]);
    redo(&root, "c", None).unwrap();
    assert_eq!(std::fs::read_to_string(transcript_path(&root, "c").unwrap()).unwrap(), before);
    assert!(redo(&root, "c", None).unwrap_err().contains("redo"), "once");
  }

  #[test]
  fn rewinding_to_the_first_request_starts_over_and_unknown_requests_are_refused() {
    let (_t, root) = tmp();
    chat(&root);
    let r = rewind(&root, "c", 0, false, None).unwrap();
    assert_eq!(r.resume, Resume::default(), "a new session");
    assert_eq!(load_transcript(&root, "c").unwrap(), []);
    assert!(rewind(&root, "c", 7, false, None).unwrap_err().contains('8'));
    // A stale redo (not stacked) is replaced.
    clear_redo(&root, "c").unwrap();
    assert!(redo(&root, "c", None).is_err());
  }

  #[test]
  fn transcripts_without_rewind_points_resume_the_whole_session() {
    let (_t, root) = tmp();
    let t = Transcript::new(&root, "old").unwrap();
    for ev in [user("a"), checkpoint(0), system("s-9"), said("b"), exit(), user("c"), checkpoint(1), said("d"), exit()] {
      t.append(&ev).unwrap();
    }
    let r = rewind(&root, "old", 1, false, None).unwrap();
    assert_eq!(r.resume, Resume { session_id: Some("s-9".into()), resume_at: None });
    assert_eq!(texts(&root, "old"), ["a", "b"]);
  }

  #[test]
  fn an_arkai_chat_rewinds_and_forks_by_its_transcript() {
    // Arkai sends no anchors: its conversation is the transcript, kept with whole tool inputs.
    let (_t, root) = tmp();
    let t = Transcript::new(&root, "a").unwrap().full_inputs(true);
    let call = AgentEvent::ToolUse { id: "t1".into(), name: "Write".into(), input: serde_json::json!({"file_path": "a.rs", "content": "x".repeat(10_000)}), parent_tool_use_id: None };
    let done = AgentEvent::ToolResult { tool_use_id: "t1".into(), content: "ok".into(), is_error: false, parent_tool_use_id: None };
    for ev in [user("a"), checkpoint(0), system(U1), call.clone(), done.clone(), said("b"), exit(), user("c"), checkpoint(1), system(U1), said("d"), exit()] {
      t.append(&ev).unwrap();
    }
    let r = rewind(&root, "a", 1, false, None).unwrap();
    assert_eq!(r.resume, Resume { session_id: Some(U1.into()), resume_at: None }, "the same session, rebuilt from the cut transcript");
    let history = crate::agent::arkai::history(crate::agent::chats::load_transcript_full(&root, "a").unwrap());
    assert_eq!(history, [user("a"), call.clone(), done.clone(), said("b")]);
    assert_eq!(fork(&root, "a", "f", None, None).unwrap(), Resume { session_id: Some(U1.into()), resume_at: None });
    assert_eq!(crate::agent::arkai::history(crate::agent::chats::load_transcript_full(&root, "f").unwrap()), history);
    redo(&root, "a", None).unwrap();
    assert_eq!(texts(&root, "a"), ["a", "b", "c", "d"]);
  }

  #[test]
  fn fork_copies_the_conversation_before_a_request() {
    let (_t, root) = tmp();
    chat(&root);
    let src = std::fs::read_to_string(transcript_path(&root, "c").unwrap()).unwrap();
    assert_eq!(fork(&root, "c", "f", Some(2), None).unwrap(), Resume { session_id: Some("s-1".into()), resume_at: Some(U2.into()) });
    assert_eq!(texts(&root, "f"), ["หนึ่ง", "ตอบหนึ่ง", "สอง", "ตอบสอง"]);
    assert_eq!(std::fs::read_to_string(transcript_path(&root, "c").unwrap()).unwrap(), src, "the source is unchanged");
    assert_eq!(fork(&root, "c", "g", None, None).unwrap().resume_at.as_deref(), Some(U3), "all of it");
    assert_eq!(texts(&root, "g").len(), 6);
    assert!(fork(&root, "c", "f", None, None).is_err(), "the new chat must not exist");
    assert!(fork(&root, "c", "h", Some(9), None).is_err());
    // A run of the fork goes on from the copied anchors.
    assert_eq!(anchors(&root, "f").resume().resume_at.as_deref(), Some(U2));
  }

  #[test]
  fn rewind_restores_files_and_redo_brings_them_back() {
    let (_t, root) = tmp();
    let edits = chat_edits::ChatEdits::default();
    let write = |rel: &str, text: &str| std::fs::write(root.join(rel), text).unwrap();
    write("a.txt", "v0");
    // Request 0 edits a.txt (v0 → v1); request 1 edits it again (→ v2) and creates b.txt.
    let snap = |rel: &str, existed: bool, content: Option<&str>| {
      use base64::Engine;
      AgentEvent::FileSnapshot {
        tool_use_id: "t".into(),
        tool: "Write".into(),
        path: root.join(rel).display().to_string(),
        existed,
        size: 0,
        content_b64: content.map(|c| base64::engine::general_purpose::STANDARD.encode(c)),
        skipped: None,
      }
    };
    let t = Transcript::new(&root, "c").unwrap();
    let mut a = Anchors::default();
    let mut feed = |ev: AgentEvent| {
      for mut ev in edits.on_event(&root, "c", &root, ev) {
        a.observe(&mut ev);
        t.append(&ev).unwrap();
      }
    };
    feed(user("one"));
    feed(system("s-1"));
    feed(snap("a.txt", true, Some("v0")));
    write("a.txt", "v1");
    feed(anchor(U1));
    feed(AgentEvent::Result { subtype: "success".into(), is_error: false, result: None, session_id: Some("s-1".into()), num_turns: None, duration_ms: None, total_cost_usd: None, usage: None });
    feed(user("two"));
    feed(snap("a.txt", true, Some("v1")));
    write("a.txt", "v2");
    feed(snap("b.txt", false, None));
    write("b.txt", "new");
    feed(anchor(U2));
    feed(exit());

    let store = Store::open(&root, "c", &root).unwrap();
    let r = rewind(&root, "c", 1, false, Some(&store)).unwrap();
    assert_eq!(r.resume.resume_at.as_deref(), Some(U1));
    assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "v1");
    assert!(!root.join("b.txt").exists());
    assert_eq!((r.report.restored, r.report.deleted), (vec!["a.txt".to_owned()], vec!["b.txt".to_owned()]));
    redo(&root, "c", Some(&store)).unwrap();
    assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "v2");
    assert_eq!(std::fs::read_to_string(root.join("b.txt")).unwrap(), "new");
    assert_eq!(texts(&root, "c"), ["one", "two"]);
    let view = chat_edits::view(&store, String::new(), false).unwrap();
    assert!(view.requests.iter().all(|r| !r.reverted), "the edits file is back too");

    // A fork keeps the copied requests' numbers: its next request comes after them.
    fork(&root, "c", "f", Some(1), Some(&store)).unwrap();
    let fstore = Store::open(&root, "f", &root).unwrap();
    assert_eq!(chat_edits::begin_request(&fstore, 0).unwrap(), 1);
  }
}
