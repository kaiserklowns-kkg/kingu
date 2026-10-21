//! Attachments for agents (Orca's clipboard image paste and chat attachments). A pasted image
//! (raw bytes from the webview) is saved as `kingu-paste-<ms>-<n>.<ext>` in Kingu's own
//! `<app cache>/pasted-images` (0700, files 0600) so a CLI can be handed its path, or the timeline
//! composer can attach it; files older than 30 days there are swept on each save (Orca keeps its
//! chat pastes 30 days). Images for a timeline run are checked here before the agent host reads
//! them: Claude's limits as Orca applies them (png/jpeg/gif/webp, 5 MB each, 20 per message,
//! 20 MB in all).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use tauri::Manager;
use crate::i18n::msg::CoreMsg;
use crate::tr;

const DIR: &str = "pasted-images";
const PREFIX: &str = "kingu-paste-";
/// Orca's clipboard image cap: 24 MiB of base64, about 18 MiB of bytes.
pub const MAX_PASTE_BYTES: usize = 18 * 1024 * 1024;
const TTL: Duration = Duration::from_secs(30 * 24 * 3600);
pub const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
pub const MAX_IMAGES: usize = 20;
pub const MAX_IMAGES_TOTAL: u64 = 20 * 1024 * 1024;

/// The image type of `bytes` by its signature (never by what the page claims).
pub fn sniff(bytes: &[u8]) -> Option<&'static str> {
  if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
    Some("png")
  } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
    Some("jpg")
  } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
    Some("gif")
  } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
    Some("webp")
  } else {
    None
  }
}

/// Removes this folder's pastes older than `ttl` (only Kingu's own file names).
pub fn sweep(dir: &Path, ttl: Duration, now: SystemTime) {
  let Ok(entries) = fs::read_dir(dir) else { return };
  for e in entries.flatten() {
    let old = e.metadata().ok().and_then(|m| m.modified().ok()).is_some_and(|t| now.duration_since(t).unwrap_or_default() > ttl);
    if old && e.file_name().to_string_lossy().starts_with(PREFIX) && e.file_type().is_ok_and(|t| t.is_file()) {
      let _ = fs::remove_file(e.path());
    }
  }
}

static SEQ: AtomicU64 = AtomicU64::new(0);

/// Saves a pasted image into `dir`; returns its path.
pub fn save_image(dir: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
  if bytes.is_empty() {
    return Err(tr!(CoreMsg::NoClipboardImage));
  }
  if bytes.len() > MAX_PASTE_BYTES {
    return Err(tr!(CoreMsg::PasteTooLarge));
  }
  let ext = sniff(bytes).ok_or_else(|| tr!(CoreMsg::NotAnImage))?;
  fs::create_dir_all(dir).map_err(|e| e.to_string())?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
  }
  sweep(dir, TTL, SystemTime::now());
  let ms = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
  let n = SEQ.fetch_add(1, Ordering::Relaxed);
  let file = dir.join(format!("{PREFIX}{ms}-{}-{n}.{ext}", std::process::id()));
  let mut opts = fs::OpenOptions::new();
  opts.write(true).create_new(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    opts.mode(0o600);
  }
  let mut f = opts.open(&file).map_err(|e| e.to_string())?;
  f.write_all(bytes).map_err(|e| {
    let _ = fs::remove_file(&file);
    e.to_string()
  })?;
  Ok(file)
}

/// Image files for a timeline message: absolute, existing, a supported type by name and
/// signature, within the size limits.
pub fn check_images(paths: &[String]) -> Result<(), String> {
  if paths.len() > MAX_IMAGES {
    return Err(tr!(CoreMsg::TooManyImages, max = MAX_IMAGES));
  }
  let mut total = 0;
  for p in paths {
    let path = Path::new(p);
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if !path.is_absolute() {
      return Err(tr!(CoreMsg::NeedsAbsolutePath, path = p));
    }
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp") {
      return Err(tr!(CoreMsg::ImageTypeOnly, name));
    }
    let meta = fs::metadata(path).map_err(|e| format!("{name}: {e}"))?;
    if !meta.is_file() {
      return Err(tr!(CoreMsg::NotAFile, name));
    }
    if meta.len() == 0 || meta.len() > MAX_IMAGE_BYTES {
      return Err(tr!(CoreMsg::ImageSize, name));
    }
    total += meta.len();
    let mut head = [0u8; 12];
    let n = std::io::Read::read(&mut fs::File::open(path).map_err(|e| e.to_string())?, &mut head).map_err(|e| e.to_string())?;
    if sniff(&head[..n]).is_none() {
      return Err(tr!(CoreMsg::ImageContent, name));
    }
  }
  if total > MAX_IMAGES_TOTAL {
    return Err(tr!(CoreMsg::ImagesTotalTooLarge));
  }
  Ok(())
}

/// The composer's thumbnail of an attached image: the file as a `data:` URL, after the checks a
/// message's images get (absolute, a supported type by name and signature, within 5 MB).
pub fn preview_data_url(path: &str) -> Result<String, String> {
  use base64::Engine;
  check_images(&[path.to_owned()])?;
  let bytes = fs::read(path).map_err(|e| e.to_string())?;
  let mime = match sniff(&bytes) {
    Some("png") => "image/png",
    Some("jpg") => "image/jpeg",
    Some("gif") => "image/gif",
    Some("webp") => "image/webp",
    _ => return Err(tr!(CoreMsg::NotAnImage)),
  };
  Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// An attached image's thumbnail for the chat composer (`preview_data_url`).
#[tauri::command]
pub async fn chat_attachment_preview(path: String) -> Result<String, String> {
  tauri::async_runtime::spawn_blocking(move || preview_data_url(&path)).await.map_err(|e| e.to_string())?
}

/// A pasted image (the request body is its raw bytes): saved, its path returned.
#[tauri::command]
pub async fn paste_image_save(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
  let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected the image bytes".into()) };
  let bytes = bytes.clone();
  let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join(DIR);
  let file = tauri::async_runtime::spawn_blocking(move || save_image(&dir, &bytes)).await.map_err(|e| e.to_string())??;
  file.to_str().map(str::to_owned).ok_or_else(|| "path is not UTF-8".into())
}

#[cfg(test)]
mod tests {
  use super::*;

  const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

  #[test]
  fn sniffs_types() {
    assert_eq!(sniff(PNG), Some("png"));
    assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("jpg"));
    assert_eq!(sniff(b"GIF89a.."), Some("gif"));
    assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some("webp"));
    assert_eq!(sniff(b"<svg"), None);
  }

  #[test]
  fn saves_private_files_and_sweeps_old_ones() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path().join(DIR);
    let a = save_image(&d, PNG).unwrap();
    let b = save_image(&d, PNG).unwrap();
    assert_ne!(a, b);
    assert!(a.file_name().unwrap().to_str().unwrap().starts_with(PREFIX));
    assert_eq!(a.extension().unwrap(), "png");
    assert_eq!(fs::read(&a).unwrap(), PNG);
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      assert_eq!(fs::metadata(&a).unwrap().permissions().mode() & 0o777, 0o600);
      assert_eq!(fs::metadata(&d).unwrap().permissions().mode() & 0o777, 0o700);
    }
    assert!(save_image(&d, b"").is_err());
    assert!(save_image(&d, b"hello").is_err());
    assert!(save_image(&d, &vec![0x89; MAX_PASTE_BYTES + 1]).is_err());
    fs::write(d.join("keep.txt"), "x").unwrap();
    sweep(&d, Duration::ZERO, SystemTime::now() + Duration::from_secs(5));
    assert!(!a.exists() && !b.exists());
    assert!(d.join("keep.txt").exists(), "only Kingu's pastes are swept");
  }

  #[test]
  fn previews_attached_images_only() {
    let dir = tempfile::tempdir().unwrap();
    let img = dir.path().join("shot.png");
    fs::write(&img, PNG).unwrap();
    let url = preview_data_url(img.to_str().unwrap()).unwrap();
    assert!(url.starts_with("data:image/png;base64,"));
    let txt = dir.path().join("notes.txt");
    fs::write(&txt, "x").unwrap();
    assert!(preview_data_url(txt.to_str().unwrap()).is_err());
    let fake = dir.path().join("fake.png");
    fs::write(&fake, "not an image").unwrap();
    assert!(preview_data_url(fake.to_str().unwrap()).is_err());
    assert!(preview_data_url("shot.png").is_err(), "relative paths are refused");
  }

  #[test]
  fn checks_images_for_a_message() {
    let dir = tempfile::tempdir().unwrap();
    let img = dir.path().join("shot.PNG");
    fs::write(&img, PNG).unwrap();
    let s = |p: &Path| p.to_str().unwrap().to_owned();
    assert!(check_images(&[s(&img)]).is_ok());
    let fake = dir.path().join("fake.png");
    fs::write(&fake, "not an image").unwrap();
    assert!(check_images(&[s(&fake)]).is_err());
    let txt = dir.path().join("a.txt");
    fs::write(&txt, "x").unwrap();
    assert!(check_images(&[s(&txt)]).is_err());
    assert!(check_images(&["shot.png".into()]).is_err());
    assert!(check_images(&vec![s(&img); MAX_IMAGES + 1]).is_err());
    let big = dir.path().join("big.png");
    let mut bytes = PNG.to_vec();
    bytes.resize(MAX_IMAGE_BYTES as usize + 1, 0);
    fs::write(&big, bytes).unwrap();
    assert!(check_images(&[s(&big)]).is_err());
  }
}
