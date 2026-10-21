//! Voice dictation (Orca's Voice pane): the webview records the microphone, encodes 16 kHz
//! 16-bit mono WAV (voice/wav.ts) and asks for its text here, from one of two engines:
//! - `local`: whisper.cpp on this computer (`whisper-cli`, e.g. `brew install whisper-cpp`) with
//!   a ggml model file you choose (`kingu.voice.localModel`); the audio never leaves the machine.
//!   Flags from whisper.cpp's `--help`: `-m` model, `-f` file, `-l` language (`auto` detects),
//!   `-nt` no timestamps, `-np` no progress prints.
//! - `openai`: OpenAI's transcription endpoint with your API key, which lives only in the
//!   Keychain (never in settings, never logged, never sent to the webview or the team server).
//!
//! Network and process access sit behind `Http` and `Runner`, so tests never reach either.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::accounts::secrets::SecretStore;
use crate::i18n::msg::VoiceMsg;
use crate::tr;

pub const KEYCHAIN_SERVICE: &str = "dev.kingu.voice";
const OPENAI_KEY: &str = "openai-api-key";
pub const OPENAI_URL: &str = "https://api.openai.com/v1/audio/transcriptions";
pub const OPENAI_MODELS: [&str; 2] = ["gpt-4o-mini-transcribe", "gpt-4o-transcribe"];
pub const SAMPLE_RATE: u32 = 16_000;
/// Longest recording: 5 minutes (Orca's cloud limit is 10; a dictation is far shorter).
pub const MAX_MINUTES: usize = 5;
pub const MAX_WAV_BYTES: usize = 44 + SAMPLE_RATE as usize * 2 * 60 * MAX_MINUTES;
const TIMEOUT: Duration = Duration::from_secs(120);
/// whisper.cpp's command names (Homebrew's `whisper-cli`, older builds' `whisper-cpp`). Not the
/// Python `whisper`, whose flags differ.
pub const WHISPER_BINS: [&str; 2] = ["whisper-cli", "whisper-cpp"];

// ---------------------------------------------------------------------------------------------
// Seams

pub trait Http: Send + Sync {
  /// POST `body`; the status and the response text.
  fn post(&self, url: &str, headers: &[(&str, String)], body: Vec<u8>) -> Result<(u16, String), HttpError>;
}

#[derive(Debug, Clone, PartialEq)]
pub enum HttpError {
  Network,
  Other(String),
}

pub trait Runner: Send + Sync {
  /// Runs `program` with `args`: (succeeded, stdout, stderr).
  fn run(&self, program: &Path, args: &[String]) -> Result<(bool, String, String), String>;
}

pub struct Keychain;

impl Keychain {
  fn entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, id).map_err(|e| e.to_string())
  }
}

impl SecretStore for Keychain {
  fn get(&self, id: &str) -> Option<String> {
    Self::entry(id).ok()?.get_password().ok()
  }
  fn set(&self, id: &str, secret: &str) -> Result<(), String> {
    Self::entry(id)?.set_password(secret).map_err(|e| tr!(VoiceMsg::SaveKeyFailed, detail = e))
  }
  fn delete(&self, id: &str) -> Result<(), String> {
    match Self::entry(id)?.delete_credential() {
      Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
      Err(e) => Err(tr!(VoiceMsg::DeleteKeyFailed, detail = e)),
    }
  }
}

struct LiveHttp;

impl Http for LiveHttp {
  fn post(&self, url: &str, headers: &[(&str, String)], body: Vec<u8>) -> Result<(u16, String), HttpError> {
    let client = reqwest::blocking::Client::builder().timeout(TIMEOUT).build().map_err(|e| HttpError::Other(e.to_string()))?;
    let mut req = client.post(url).body(body);
    for (k, v) in headers {
      req = req.header(*k, v);
    }
    let res = req.send().map_err(|e| if e.is_timeout() || e.is_connect() || e.is_request() { HttpError::Network } else { HttpError::Other(e.to_string()) })?;
    let code = res.status().as_u16();
    Ok((code, res.text().unwrap_or_default()))
  }
}

struct LiveRunner;

impl Runner for LiveRunner {
  fn run(&self, program: &Path, args: &[String]) -> Result<(bool, String, String), String> {
    let out = std::process::Command::new(program).args(args).stdin(std::process::Stdio::null()).output().map_err(|e| e.to_string())?;
    Ok((out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned()))
  }
}

// ---------------------------------------------------------------------------------------------
// Audio

/// A 16-bit mono PCM WAV of at most `MAX_MINUTES`, with some audio in it.
pub fn check_wav(wav: &[u8]) -> Result<(), String> {
  if wav.len() > MAX_WAV_BYTES {
    return Err(tr!(VoiceMsg::AudioTooLong, max = MAX_MINUTES));
  }
  let u16_at = |i: usize| u16::from_le_bytes([wav[i], wav[i + 1]]);
  if wav.len() < 44 || &wav[0..4] != b"RIFF" || &wav[8..12] != b"WAVE" || &wav[12..16] != b"fmt " || u16_at(20) != 1 || u16_at(22) != 1 || u16_at(34) != 16 {
    return Err(tr!(VoiceMsg::AudioInvalid));
  }
  if wav.len() <= 44 {
    return Err(tr!(VoiceMsg::AudioEmpty));
  }
  Ok(())
}

/// A `multipart/form-data` body: text `fields`, then one file part.
pub fn multipart(boundary: &str, fields: &[(&str, &str)], file: (&str, &str, &str, &[u8])) -> Vec<u8> {
  let mut out = Vec::new();
  for (name, value) in fields {
    out.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes());
  }
  let (name, filename, mime, bytes) = file;
  out.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n").as_bytes());
  out.extend_from_slice(bytes);
  out.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
  out
}

/// An error text without anything key-like in it (`sk-…`, `Bearer …`).
pub fn sanitize(message: &str) -> String {
  let re = regex::Regex::new(r"(?i)\bsk-[A-Za-z0-9_-]+|\bBearer\s+[A-Za-z0-9._~+/=-]+").expect("valid regex");
  let text = re.replace_all(message, "[redacted]");
  let text = text.trim();
  // A long body is cut; it is only shown to you.
  text.chars().take(300).collect()
}

/// The words of a transcript: whitespace collapsed, whisper's `[BLANK_AUDIO]`-style markers dropped.
pub fn clean_transcript(text: &str) -> String {
  let marker = regex::Regex::new(r"\[(?:BLANK_AUDIO|MUSIC|NOISE|SILENCE|INAUDIBLE)\]|\((?:silence|music|noise)\)").expect("valid regex");
  marker.replace_all(text, " ").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `auto` or a two- or three-letter ISO 639 code; anything else is `auto`.
pub fn language(lang: &str) -> &str {
  let l = lang.trim();
  if (2..=3).contains(&l.len()) && l.bytes().all(|b| b.is_ascii_lowercase()) { l } else { "auto" }
}

// ---------------------------------------------------------------------------------------------
// Engines

pub fn transcribe_openai(http: &dyn Http, key: &str, model: &str, lang: &str, wav: &[u8]) -> Result<String, String> {
  if !OPENAI_MODELS.contains(&model) {
    return Err(tr!(VoiceMsg::UnknownModel, model));
  }
  let boundary = format!("kingu-voice-{:016x}", wav.len() as u64 ^ 0x9e37_79b9_7f4a_7c15);
  let lang = language(lang);
  let mut fields = vec![("model", model), ("response_format", "json")];
  if lang != "auto" {
    fields.push(("language", lang));
  }
  let body = multipart(&boundary, &fields, ("file", "dictation.wav", "audio/wav", wav));
  let headers = [("Authorization", format!("Bearer {key}")), ("Content-Type", format!("multipart/form-data; boundary={boundary}"))];
  let (code, text) = http.post(OPENAI_URL, &headers, body).map_err(|e| match e {
    HttpError::Network => tr!(VoiceMsg::Network),
    HttpError::Other(d) => tr!(VoiceMsg::ServiceFailed, detail = sanitize(&d)),
  })?;
  let json: Option<Value> = serde_json::from_str(&text).ok();
  match code {
    200..=299 => json.as_ref().and_then(|v| v.get("text")).and_then(Value::as_str).map(clean_transcript).ok_or_else(|| tr!(VoiceMsg::ServiceFailed, detail = "no text")),
    401 | 403 => Err(tr!(VoiceMsg::KeyRejected)),
    429 => Err(tr!(VoiceMsg::RateLimited)),
    _ => {
      let detail = json.as_ref().and_then(|v| v.pointer("/error/message")).and_then(Value::as_str).map(sanitize).unwrap_or_else(|| format!("HTTP {code}"));
      Err(tr!(VoiceMsg::ServiceFailed, detail))
    }
  }
}

/// The whisper.cpp program: `kingu.voice.whisperPath` when set (it must be whisper.cpp's), else
/// the first of `WHISPER_BINS` in `dirs`.
pub fn find_whisper(configured: &str, dirs: &[PathBuf]) -> Result<PathBuf, String> {
  let configured = configured.trim();
  if !configured.is_empty() {
    let p = PathBuf::from(configured);
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    if !p.is_absolute() || !WHISPER_BINS.contains(&name) {
      return Err(tr!(VoiceMsg::WhisperNotAllowed, path = configured));
    }
    return if p.is_file() { Ok(p) } else { Err(tr!(VoiceMsg::WhisperMissing)) };
  }
  WHISPER_BINS.iter().flat_map(|b| dirs.iter().map(move |d| d.join(b))).find(|p| p.is_file()).ok_or_else(|| tr!(VoiceMsg::WhisperMissing))
}

/// The model file: an existing `.bin` (whisper.cpp's ggml format).
pub fn check_model(model: &str) -> Result<PathBuf, String> {
  let model = model.trim();
  if model.is_empty() {
    return Err(tr!(VoiceMsg::ModelMissing));
  }
  let p = PathBuf::from(model);
  if !p.is_absolute() || p.extension().and_then(|e| e.to_str()) != Some("bin") || !p.is_file() {
    return Err(tr!(VoiceMsg::ModelNotFound, path = model));
  }
  Ok(p)
}

pub fn whisper_args(model: &Path, wav: &Path, lang: &str) -> Vec<String> {
  ["-m", &model.display().to_string(), "-f", &wav.display().to_string(), "-l", language(lang), "-nt", "-np"].iter().map(|s| s.to_string()).collect()
}

/// A private (0700) folder for one recording, removed when dropped.
struct TempDir(PathBuf);

impl TempDir {
  fn new(tmp: &Path) -> std::io::Result<Self> {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = tmp.join(format!("kingu-voice-{}-{nanos}", std::process::id()));
    let mut b = std::fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
    b.create(&dir)?;
    Ok(Self(dir))
  }
}

impl Drop for TempDir {
  fn drop(&mut self) {
    let _ = std::fs::remove_dir_all(&self.0);
  }
}

/// whisper.cpp on `wav`, written to a private temp file that is removed afterwards.
pub fn transcribe_local(runner: &dyn Runner, bin: &Path, model: &Path, lang: &str, wav: &[u8], tmp: &Path) -> Result<String, String> {
  let dir = TempDir::new(tmp).map_err(|e| tr!(VoiceMsg::WhisperFailed, detail = e))?;
  let file = dir.0.join("dictation.wav");
  std::fs::write(&file, wav).map_err(|e| tr!(VoiceMsg::WhisperFailed, detail = e))?;
  let (ok, stdout, stderr) = runner.run(bin, &whisper_args(model, &file, lang)).map_err(|e| tr!(VoiceMsg::WhisperFailed, detail = e))?;
  drop(dir);
  if !ok {
    let last = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("exit status").trim().to_owned();
    return Err(tr!(VoiceMsg::WhisperFailed, detail = sanitize(&last)));
  }
  Ok(clean_transcript(&stdout))
}

// ---------------------------------------------------------------------------------------------
// The app's state and commands

pub struct Voice {
  secrets: Box<dyn SecretStore>,
  http: Box<dyn Http>,
  runner: Box<dyn Runner>,
}

impl Default for Voice {
  fn default() -> Self {
    Self { secrets: Box::new(Keychain), http: Box::new(LiveHttp), runner: Box::new(LiveRunner) }
  }
}

/// What a dictation uses, from the settings (`kingu.voice.*`).
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
  pub engine: String,
  pub openai_model: String,
  pub language: String,
  pub local_model: String,
  pub whisper_path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
  pub openai_key_saved: bool,
  /// The whisper.cpp program found, if any.
  pub whisper: Option<String>,
  pub whisper_error: Option<String>,
}

fn path_dirs() -> Vec<PathBuf> {
  let path = crate::shell_env::path().or_else(|| std::env::var_os("PATH"));
  let mut dirs: Vec<PathBuf> = path.map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
  // Homebrew's folders, which a GUI app's PATH may lack.
  dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
  dirs
}

impl Voice {
  #[cfg(test)]
  pub fn with(secrets: Box<dyn SecretStore>, http: Box<dyn Http>, runner: Box<dyn Runner>) -> Self {
    Self { secrets, http, runner }
  }

  pub fn status(&self, whisper_path: &str, dirs: &[PathBuf]) -> Status {
    let found = find_whisper(whisper_path, dirs);
    Status { openai_key_saved: self.secrets.get(OPENAI_KEY).is_some_and(|k| !k.is_empty()), whisper: found.as_ref().ok().map(|p| p.display().to_string()), whisper_error: found.err() }
  }

  pub fn set_key(&self, key: &str) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
      return Err(tr!(VoiceMsg::KeyEmpty));
    }
    self.secrets.set(OPENAI_KEY, key)
  }

  pub fn clear_key(&self) -> Result<(), String> {
    self.secrets.delete(OPENAI_KEY)
  }

  pub fn transcribe(&self, o: &Options, wav: &[u8], dirs: &[PathBuf], tmp: &Path) -> Result<String, String> {
    check_wav(wav)?;
    match o.engine.as_str() {
      "openai" => {
        let key = self.secrets.get(OPENAI_KEY).filter(|k| !k.is_empty()).ok_or_else(|| tr!(VoiceMsg::NoKey))?;
        let model = if o.openai_model.is_empty() { OPENAI_MODELS[0] } else { o.openai_model.as_str() };
        transcribe_openai(self.http.as_ref(), &key, model, &o.language, wav)
      }
      "local" | "" => {
        let bin = find_whisper(&o.whisper_path, dirs)?;
        let model = check_model(&o.local_model)?;
        transcribe_local(self.runner.as_ref(), &bin, &model, &o.language, wav, tmp)
      }
      other => Err(tr!(VoiceMsg::UnknownEngine, engine = other)),
    }
  }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn voice_status(app: tauri::AppHandle, whisper_path: Option<String>) -> Result<Status, String> {
  use tauri::Manager;
  blocking(move || app.state::<Voice>().status(whisper_path.as_deref().unwrap_or_default(), &path_dirs())).await
}

#[tauri::command]
pub async fn voice_set_openai_key(app: tauri::AppHandle, key: String) -> Result<(), String> {
  use tauri::Manager;
  blocking(move || app.state::<Voice>().set_key(&key)).await?
}

#[tauri::command]
pub async fn voice_clear_openai_key(app: tauri::AppHandle) -> Result<(), String> {
  use tauri::Manager;
  blocking(move || app.state::<Voice>().clear_key()).await?
}

/// `audio`: the WAV as base64.
#[tauri::command]
pub async fn voice_transcribe(app: tauri::AppHandle, audio: String, options: Options) -> Result<String, String> {
  use base64::Engine as _;
  use tauri::Manager;
  if audio.len() > MAX_WAV_BYTES / 3 * 4 + 8 {
    return Err(tr!(VoiceMsg::AudioTooLong, max = MAX_MINUTES));
  }
  let wav = base64::engine::general_purpose::STANDARD.decode(audio.as_bytes()).map_err(|_| tr!(VoiceMsg::AudioInvalid))?;
  let tmp = std::env::temp_dir();
  blocking(move || app.state::<Voice>().transcribe(&options, &wav, &path_dirs(), &tmp)).await?
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::accounts::secrets::fake::FakeSecrets;
  use std::sync::Mutex;

  /// 16-bit mono WAV with `n` silent samples.
  fn wav(n: usize) -> Vec<u8> {
    let mut b = Vec::new();
    let data = (n * 2) as u32;
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + data).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    b.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&data.to_le_bytes());
    b.resize(44 + n * 2, 0);
    b
  }

  #[derive(Default)]
  struct FakeHttp {
    reply: Mutex<Option<Result<(u16, String), HttpError>>>,
    seen: Mutex<Vec<(String, Vec<(String, String)>, Vec<u8>)>>,
  }

  impl Http for FakeHttp {
    fn post(&self, url: &str, headers: &[(&str, String)], body: Vec<u8>) -> Result<(u16, String), HttpError> {
      self.seen.lock().unwrap().push((url.into(), headers.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(), body));
      self.reply.lock().unwrap().clone().unwrap_or(Ok((200, r#"{"text":" hello  world "}"#.into())))
    }
  }

  struct FakeRunner {
    reply: (bool, String, String),
    seen: Mutex<Vec<(PathBuf, Vec<String>, bool)>>,
  }

  impl Runner for FakeRunner {
    fn run(&self, program: &Path, args: &[String]) -> Result<(bool, String, String), String> {
      let file_there = args.iter().position(|a| a == "-f").map(|i| Path::new(&args[i + 1]).is_file()).unwrap_or(false);
      self.seen.lock().unwrap().push((program.into(), args.to_vec(), file_there));
      Ok(self.reply.clone())
    }
  }

  fn runner(ok: bool, out: &str, err: &str) -> FakeRunner {
    FakeRunner { reply: (ok, out.into(), err.into()), seen: Mutex::default() }
  }

  #[test]
  fn checks_recordings() {
    assert!(check_wav(&wav(16_000)).is_ok());
    assert!(check_wav(&wav(0)).is_err(), "nothing recorded");
    assert!(check_wav(b"not a wav").is_err());
    let mut stereo = wav(10);
    stereo[22] = 2;
    assert!(check_wav(&stereo).is_err());
    assert!(check_wav(&vec![0; MAX_WAV_BYTES + 1]).is_err());
  }

  #[test]
  fn builds_multipart_bodies() {
    let body = multipart("B", &[("model", "m")], ("file", "a.wav", "audio/wav", b"RIFF"));
    let text = String::from_utf8(body).unwrap();
    assert_eq!(text, "--B\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nm\r\n--B\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.wav\"\r\nContent-Type: audio/wav\r\n\r\nRIFF\r\n--B--\r\n");
  }

  #[test]
  fn redacts_keys_and_cleans_transcripts() {
    assert_eq!(sanitize("Incorrect API key provided: sk-proj-abc_123. Bearer abc.def"), "Incorrect API key provided: [redacted]. [redacted]");
    assert_eq!(clean_transcript(" [BLANK_AUDIO]\n Hello\n  there (silence) "), "Hello there");
    assert_eq!((language("th"), language("auto"), language("TH"), language("en-US"), language("")), ("th", "auto", "auto", "auto", "auto"));
  }

  #[test]
  fn openai_engine_sends_the_key_only_to_openai() {
    let http = FakeHttp::default();
    assert_eq!(transcribe_openai(&http, "sk-test", "gpt-4o-mini-transcribe", "th", &wav(100)).unwrap(), "hello world");
    let seen = http.seen.lock().unwrap();
    let (url, headers, body) = &seen[0];
    assert_eq!(url, OPENAI_URL);
    assert!(headers.contains(&("Authorization".into(), "Bearer sk-test".into())));
    let text = String::from_utf8_lossy(body);
    assert!(text.contains("name=\"model\"\r\n\r\ngpt-4o-mini-transcribe") && text.contains("name=\"language\"\r\n\r\nth"));
    assert!(!text.contains("sk-test"), "the key is only in the header");
    drop(seen);
    assert!(transcribe_openai(&http, "k", "whisper-9", "en", &wav(10)).is_err(), "unknown model");
    let auto = FakeHttp::default();
    transcribe_openai(&auto, "k", "gpt-4o-transcribe", "auto", &wav(10)).unwrap();
    assert!(!String::from_utf8_lossy(&auto.seen.lock().unwrap()[0].2).contains("name=\"language\""));
  }

  #[test]
  fn openai_errors_are_classified_and_redacted() {
    let with = |r: Result<(u16, String), HttpError>| {
      let http = FakeHttp::default();
      *http.reply.lock().unwrap() = Some(r);
      transcribe_openai(&http, "k", OPENAI_MODELS[0], "en", &wav(10)).unwrap_err()
    };
    assert_eq!(with(Ok((401, "{}".into()))), tr!(VoiceMsg::KeyRejected));
    assert_eq!(with(Ok((429, "{}".into()))), tr!(VoiceMsg::RateLimited));
    assert_eq!(with(Err(HttpError::Network)), tr!(VoiceMsg::Network));
    let e = with(Ok((400, r#"{"error":{"message":"bad file from sk-live-123"}}"#.into())));
    assert!(e.contains("bad file from [redacted]"), "{e}");
    assert!(with(Ok((500, "oops".into()))).contains("HTTP 500"));
  }

  #[test]
  fn finds_whisper_cpp_only() {
    let tmp = tempfile::tempdir().unwrap();
    let bin = tmp.path().join("whisper-cli");
    std::fs::write(&bin, "").unwrap();
    std::fs::write(tmp.path().join("whisper"), "").unwrap();
    let dirs = [tmp.path().join("none"), tmp.path().to_path_buf()];
    assert_eq!(find_whisper("", &dirs).unwrap(), bin);
    assert_eq!(find_whisper(&bin.display().to_string(), &[]).unwrap(), bin);
    assert!(find_whisper(&tmp.path().join("whisper").display().to_string(), &[]).is_err(), "Python whisper's flags differ");
    assert!(find_whisper("/bin/sh", &[]).is_err());
    assert!(find_whisper("whisper-cli", &[]).is_err(), "relative");
    assert!(find_whisper("", &[tmp.path().join("none")]).is_err());
  }

  #[test]
  fn local_engine_runs_whisper_cpp_on_a_temp_file() {
    let tmp = tempfile::tempdir().unwrap();
    let r = runner(true, "  Hello from whisper\n[BLANK_AUDIO]\n", "");
    let text = transcribe_local(&r, Path::new("/opt/homebrew/bin/whisper-cli"), Path::new("/m/ggml-base.bin"), "auto", &wav(10), tmp.path()).unwrap();
    assert_eq!(text, "Hello from whisper");
    let seen = r.seen.lock().unwrap();
    let (program, args, file_there) = &seen[0];
    assert_eq!(program, Path::new("/opt/homebrew/bin/whisper-cli"));
    assert_eq!(&args[..2], ["-m", "/m/ggml-base.bin"]);
    assert_eq!(&args[4..], ["-l", "auto", "-nt", "-np"]);
    assert!(*file_there, "the recording is on disk while whisper runs");
    assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0, "and removed afterwards");
    let failed = runner(false, "", "whisper_init: failed to load model\n\n");
    let e = transcribe_local(&failed, Path::new("/w/whisper-cli"), Path::new("/m/x.bin"), "en", &wav(10), tmp.path()).unwrap_err();
    assert!(e.contains("failed to load model"), "{e}");
  }

  #[test]
  fn the_key_lives_in_the_secret_store() {
    let v = Voice::with(Box::new(FakeSecrets::default()), Box::new(FakeHttp::default()), Box::new(runner(true, "", "")));
    let opts = Options { engine: "openai".into(), ..Default::default() };
    assert_eq!(v.transcribe(&opts, &wav(10), &[], Path::new("/tmp")).unwrap_err(), tr!(VoiceMsg::NoKey));
    assert!(v.set_key("  ").is_err());
    v.set_key(" sk-abc ").unwrap();
    assert!(v.status("", &[]).openai_key_saved);
    assert_eq!(v.transcribe(&opts, &wav(10), &[], Path::new("/tmp")).unwrap(), "hello world");
    v.clear_key().unwrap();
    assert!(!v.status("", &[]).openai_key_saved);
    let other = Options { engine: "cloud".into(), ..Default::default() };
    assert!(v.transcribe(&other, &wav(10), &[], Path::new("/tmp")).is_err());
  }

  #[test]
  fn local_engine_needs_a_model_file() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("whisper-cli"), "").unwrap();
    let model = tmp.path().join("ggml-base.bin");
    std::fs::write(&model, "").unwrap();
    let v = Voice::with(Box::new(FakeSecrets::default()), Box::new(FakeHttp::default()), Box::new(runner(true, "hi", "")));
    let dirs = [tmp.path().to_path_buf()];
    let mut o = Options { engine: "local".into(), ..Default::default() };
    assert_eq!(v.transcribe(&o, &wav(10), &dirs, tmp.path()).unwrap_err(), tr!(VoiceMsg::ModelMissing));
    o.local_model = tmp.path().join("missing.bin").display().to_string();
    assert!(v.transcribe(&o, &wav(10), &dirs, tmp.path()).is_err());
    o.local_model = model.display().to_string();
    assert_eq!(v.transcribe(&o, &wav(10), &dirs, tmp.path()).unwrap(), "hi");
  }
}
