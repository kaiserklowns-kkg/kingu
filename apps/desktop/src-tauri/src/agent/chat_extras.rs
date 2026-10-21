//! Chat extras: thumbs up / down on an answer (kept in the chat's transcript as a `Feedback`
//! event), memories (`memories.rs`), AI follow-up suggestions after an answer, and the
//! completion chime.
//!
//! Follow-ups (VS Code's chatFollowups) use the same source-control AI agent as AI chat titles
//! (`ai_text`), and only when the user set that agent up and turned `kingu.chat.followups` on in
//! their own settings.json: a turn never runs a model the user did not pick.
//!
//! The chime (`kingu.chat.completionSound`) plays a macOS system sound, or the user's own file
//! (`kingu.chat.completionSound.customPath`, read here from the user settings, never from the
//! page), with `afplay`; elsewhere the webview plays its own tone instead.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::{AppHandle, Manager};

use super::events::AgentEvent;
use super::{ai_text, chats, memories};
use crate::i18n::msg::{AgentMsg, ChatExtrasMsg};
use crate::tr;
use crate::workspace::Workspace;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// The `Feedback` event of a vote: `up`, `down`, or none (taken back).
pub fn feedback_event(request: u32, vote: Option<&str>) -> Result<AgentEvent, String> {
  match vote {
    None | Some("up") | Some("down") => Ok(AgentEvent::Feedback { request, vote: vote.map(str::to_owned) }),
    Some(_) => Err(tr!(ChatExtrasMsg::FeedbackVote)),
  }
}

/// The user's vote on the answer to request `request` of chat `id`, appended to its transcript.
#[tauri::command]
pub async fn chat_feedback(ws: Workspace, id: String, request: u32, vote: Option<String>) -> Result<(), String> {
  chats::check_id(&id)?;
  let ev = feedback_event(request, vote.as_deref())?;
  let root = ws.root()?;
  blocking(move || chats::Transcript::new(&root, &id)?.append(&ev)).await
}

#[tauri::command]
pub async fn memories_list(ws: Workspace) -> Result<Vec<memories::Memory>, String> {
  let root = ws.root()?;
  blocking(move || Ok(memories::list(&root))).await
}

#[tauri::command]
pub async fn memory_add(ws: Workspace, file: String, text: String) -> Result<memories::Memory, String> {
  let root = ws.root()?;
  blocking(move || memories::add(&root, &file, &text)).await
}

/// Edits memory `index` of `file`, read as `expected`, to `text`; `text` null deletes it.
#[tauri::command]
pub async fn memory_change(ws: Workspace, file: String, index: usize, expected: String, text: Option<String>) -> Result<(), String> {
  let root = ws.root()?;
  blocking(move || memories::change(&root, &file, index, &expected, text.as_deref())).await
}

/// Whether follow-ups may run: on in the user's settings, and the AI agent set up (as for titles).
pub fn followups_configured(on: Option<&serde_json::Value>, enabled: Option<&serde_json::Value>, agent: &str) -> bool {
  on.and_then(|v| v.as_bool()) == Some(true) && ai_text::titles_configured(enabled, agent)
}

/// Follow-up suggestions for a finished chat turn, from the source-control AI agent; `None` when
/// they are off or the agent is not set up.
#[tauri::command]
pub async fn ai_chat_followups(app: AppHandle, ws: Workspace, prompt: String) -> Result<Option<String>, String> {
  if prompt.trim().is_empty() || prompt.len() > ai_text::MAX_TITLE_PROMPT {
    return Err(tr!(AgentMsg::PromptTooLong));
  }
  let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
  let user = |key: &str| crate::settings::user_value(&config, key);
  let agent = user("kingu.git.ai.agent").and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default();
  if !followups_configured(user("kingu.chat.followups").as_ref(), user("kingu.git.ai.enabled").as_ref(), &agent) {
    return Ok(None);
  }
  let dir = ws.root()?;
  let inv = ai_text::invocation_from_settings(&config, &prompt)?;
  log::info!("chat follow-ups: {}", inv.argv[0]);
  blocking(move || ai_text::run(&inv, &dir, ai_text::TITLE_TIMEOUT).map(Some)).await
}

/// The macOS system sounds the chime may play (`/System/Library/Sounds/<name>.aiff`).
pub const SYSTEM_SOUNDS: &[&str] = &["Glass", "Ping", "Pop", "Hero", "Submarine", "Tink", "Purr", "Funk"];
const AUDIO: &[&str] = &["aiff", "aif", "wav", "mp3", "m4a", "caf"];
const MAX_SOUND: u64 = 10 * 1024 * 1024;

/// The file the chime plays for `sound` (a system sound name, or `custom` with the user's path).
pub fn sound_file(sound: &str, custom: Option<&str>) -> Result<PathBuf, String> {
  if SYSTEM_SOUNDS.contains(&sound) {
    return Ok(PathBuf::from(format!("/System/Library/Sounds/{sound}.aiff")));
  }
  if sound != "custom" {
    return Err(tr!(ChatExtrasMsg::ChimeSound, sound = format!("{sound:?}")));
  }
  let path = Path::new(custom.unwrap_or("").trim());
  let audio = path.extension().and_then(|e| e.to_str()).is_some_and(|e| AUDIO.contains(&e.to_ascii_lowercase().as_str()));
  let ok = path.is_absolute() && audio && std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() <= MAX_SOUND);
  if ok { Ok(path.to_owned()) } else { Err(tr!(ChatExtrasMsg::ChimeCustomBad)) }
}

/// Plays the completion chime once (`afplay`, in the background). Not macOS: an error, and the
/// webview plays its own tone.
#[tauri::command]
pub fn chat_chime(app: AppHandle, sound: String) -> Result<(), String> {
  let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
  let custom = crate::settings::user_value(&config, "kingu.chat.completionSound.customPath").and_then(|v| v.as_str().map(str::to_owned));
  let file = sound_file(&sound, custom.as_deref())?;
  if !cfg!(target_os = "macos") {
    return Err(tr!(ChatExtrasMsg::ChimeUnsupported));
  }
  let mut child = std::process::Command::new("/usr/bin/afplay")
    .arg(&file)
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null())
    .spawn()
    .map_err(|e| e.to_string())?;
  // Reaped in the background; a sound longer than this is cut.
  std::thread::spawn(move || {
    let end = std::time::Instant::now() + Duration::from_secs(15);
    while std::time::Instant::now() < end {
      if let Ok(Some(_)) = child.try_wait() {
        return;
      }
      std::thread::sleep(Duration::from_millis(200));
    }
    let _ = child.kill();
    let _ = child.wait();
  });
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn feedback_votes() {
    assert_eq!(feedback_event(3, Some("up")).unwrap(), AgentEvent::Feedback { request: 3, vote: Some("up".into()) });
    assert_eq!(feedback_event(3, None).unwrap(), AgentEvent::Feedback { request: 3, vote: None });
    assert!(feedback_event(3, Some("meh")).is_err());
  }

  #[test]
  fn feedback_is_kept_in_the_transcript() {
    let tmp = tempfile::tempdir().unwrap();
    chats::Transcript::new(tmp.path(), "c-1").unwrap().append(&feedback_event(0, Some("down")).unwrap()).unwrap();
    assert_eq!(chats::load_transcript(tmp.path(), "c-1").unwrap(), [AgentEvent::Feedback { request: 0, vote: Some("down".into()) }]);
  }

  #[test]
  fn followups_need_the_setting_and_the_agent() {
    assert!(followups_configured(Some(&json!(true)), None, "claude"));
    assert!(!followups_configured(None, None, "claude"), "off by default");
    assert!(!followups_configured(Some(&json!(true)), Some(&json!(false)), "claude"));
    assert!(!followups_configured(Some(&json!(true)), None, ""));
  }

  #[test]
  fn chime_files() {
    assert_eq!(sound_file("Glass", None).unwrap(), PathBuf::from("/System/Library/Sounds/Glass.aiff"));
    assert!(sound_file("../../x", None).is_err());
    assert!(sound_file("custom", None).is_err());
    assert!(sound_file("custom", Some("relative.wav")).is_err());
    let tmp = tempfile::tempdir().unwrap();
    let wav = tmp.path().join("done.WAV");
    std::fs::write(&wav, b"RIFF").unwrap();
    assert_eq!(sound_file("custom", wav.to_str()).unwrap(), wav);
    let txt = tmp.path().join("x.txt");
    std::fs::write(&txt, b"x").unwrap();
    assert!(sound_file("custom", txt.to_str()).is_err());
  }
}
