//! Gemini CLI quota (Orca's gemini-usage-fetcher, opt-in with `kingu.usage.gemini.cliOAuth`).
//!
//! The OAuth login comes from OpenCode's `auth.json` (`google` entry) or the Gemini CLI's
//! `~/.gemini/oauth_creds.json`. An expired token is refreshed with the Gemini CLI's own OAuth
//! client (read from its installed package, never stored) and, for the Gemini CLI file only, written
//! back the way the CLI does. Then `loadCodeAssist` gives the project and `retrieveUserQuota` the
//! per-model buckets; the most used one is the session.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::{Bucket, Ctx, Req, Status, Usage, read_json, window};
use crate::i18n::msg::ProvidersMsg;
use crate::tr;

const P: &str = "gemini";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const LOAD_URL: &str = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const QUOTA_URL: &str = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";

#[derive(Debug, Clone, PartialEq)]
enum Source {
  /// OpenCode's auth.json: `refresh` is `token|project?|managedProject?`; never written.
  Opencode,
  /// The Gemini CLI's oauth_creds.json (written back after a refresh).
  GeminiCli(PathBuf),
}

#[derive(Debug, Clone)]
struct Creds {
  source: Source,
  access: String,
  refresh: String,
  expires: u64,
  /// The whole Gemini CLI file, so a write-back keeps its other fields.
  file: Value,
}

fn opencode_auth_files(home: &Path) -> Vec<PathBuf> {
  let mut out = Vec::new();
  if let Some(d) = std::env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty()) {
    out.push(PathBuf::from(d).join("opencode/auth.json"));
  }
  out.push(home.join(".local/share/opencode/auth.json"));
  out.push(home.join("Library/Application Support/opencode/auth.json"));
  out
}

fn read_creds(home: &Path) -> Result<Option<Creds>, String> {
  for f in opencode_auth_files(home) {
    if let Some(v) = read_json(&f, 1 << 20)? {
      let g = &v["google"];
      if g["type"] == "oauth" {
        return Ok(Some(Creds {
          source: Source::Opencode,
          access: g["access"].as_str().unwrap_or_default().into(),
          refresh: g["refresh"].as_str().unwrap_or_default().into(),
          expires: g["expires"].as_u64().unwrap_or(0),
          file: Value::Null,
        }));
      }
      break;
    }
  }
  let file = home.join(".gemini/oauth_creds.json");
  let Some(v) = read_json(&file, 1 << 20)? else { return Ok(None) };
  let (Some(access), Some(refresh)) = (v["access_token"].as_str(), v["refresh_token"].as_str()) else { return Ok(None) };
  Ok(Some(Creds { source: Source::GeminiCli(file), access: access.into(), refresh: refresh.into(), expires: v["expiry_date"].as_u64().unwrap_or(0), file: v.clone() }))
}

/// The OAuth client the Gemini CLI ships (its `oauth2.js`), found next to its installed binary.
fn cli_oauth_client(ctx: &Ctx) -> Option<(String, String)> {
  let bin = ctx.run.which("gemini").or_else(|| {
    ["/usr/local/bin/gemini", "/opt/homebrew/bin/gemini"].iter().map(PathBuf::from).chain([ctx.home.join(".local/bin/gemini"), ctx.home.join("bin/gemini")]).find(|p| p.exists())
  })?;
  let real = std::fs::canonicalize(&bin).unwrap_or(bin);
  let base = real.parent()?.parent()?.to_path_buf();
  let core = "node_modules/@google/gemini-cli-core/dist/src/code_assist/oauth2.js";
  let mut candidates = vec![
    base.join("libexec/lib/node_modules/@google/gemini-cli").join(core),
    base.join("lib/node_modules/@google/gemini-cli").join(core),
    base.join("share/gemini-cli").join(core),
    base.join("../gemini-cli-core/dist/src/code_assist/oauth2.js"),
    base.join(core),
  ];
  // The package root (walking up from the binary), and its bundle (CLI 0.38+).
  let mut dir = real.parent().map(Path::to_path_buf);
  for _ in 0..8 {
    let Some(d) = dir else { break };
    if read_json(&d.join("package.json"), 1 << 20).ok().flatten().is_some_and(|p| p["name"] == "@google/gemini-cli") {
      candidates.push(d.join(core));
      candidates.push(d.join("dist/src/code_assist/oauth2.js"));
      if let Ok(entries) = std::fs::read_dir(d.join("bundle")) {
        candidates.extend(entries.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "js")));
      }
      break;
    }
    dir = d.parent().map(Path::to_path_buf);
  }
  candidates.iter().find_map(|f| std::fs::read_to_string(f).ok().and_then(|text| oauth_client_in(&text)))
}

/// `OAUTH_CLIENT_ID = '…'` and `OAUTH_CLIENT_SECRET = '…'` in the CLI's source.
pub fn oauth_client_in(text: &str) -> Option<(String, String)> {
  let find = |name: &str| {
    let re = regex::Regex::new(&format!(r#"{name}\s*=\s*['"]([^'"]+)['"]"#)).ok()?;
    re.captures(text).map(|c| c[1].to_owned())
  };
  Some((find("OAUTH_CLIENT_ID")?, find("OAUTH_CLIENT_SECRET")?))
}

fn refresh(ctx: &Ctx, creds: &mut Creds) -> Result<(), String> {
  let (id, secret) = cli_oauth_client(ctx).ok_or_else(|| tr!(ProvidersMsg::GeminiRefreshFailed))?;
  let token = creds.refresh.split('|').next().unwrap_or_default();
  let body = form(&[("client_id", &id), ("client_secret", &secret), ("refresh_token", token), ("grant_type", "refresh_token")]);
  let res = ctx.web.send(Req::post(TOKEN_URL, body).header("Content-Type", "application/x-www-form-urlencoded").timeout(10)).map_err(|_| tr!(ProvidersMsg::GeminiRefreshFailed))?;
  let v = res.json().filter(|_| res.ok()).ok_or_else(|| tr!(ProvidersMsg::GeminiRefreshFailed))?;
  let access = v["access_token"].as_str().ok_or_else(|| tr!(ProvidersMsg::GeminiRefreshFailed))?;
  creds.access = access.into();
  creds.expires = ctx.now + v["expires_in"].as_u64().unwrap_or(3600) * 1000;
  if let Source::GeminiCli(path) = &creds.source {
    let mut file = creds.file.clone();
    file["access_token"] = json!(creds.access);
    file["expiry_date"] = json!(creds.expires);
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    if std::fs::write(&tmp, serde_json::to_string_pretty(&file).unwrap_or_default()).is_ok() {
      let _ = std::fs::rename(&tmp, path);
    }
  }
  Ok(())
}

fn form(pairs: &[(&str, &str)]) -> String {
  url::form_urlencoded::Serializer::new(String::new()).extend_pairs(pairs).finish()
}

fn post_json(ctx: &Ctx, url: &str, access: &str, body: Value) -> Result<super::Resp, String> {
  ctx.web.send(Req::post(url, body.to_string()).header("Content-Type", "application/json").header("Authorization", format!("Bearer {access}")).timeout(10))
}

pub fn fetch(ctx: &Ctx) -> Usage {
  if !ctx.config.gemini_cli_oauth {
    return Usage::unavailable(P, tr!(ProvidersMsg::GeminiOff), "missing-credentials");
  }
  let mut creds = match read_creds(&ctx.home) {
    Ok(Some(c)) => c,
    Ok(None) => return Usage::unavailable(P, tr!(ProvidersMsg::GeminiNoCredentials), "missing-credentials"),
    Err(e) => return Usage::error(P, e, "parse"),
  };
  if creds.access.is_empty() || creds.expires <= ctx.now {
    if let Err(e) = refresh(ctx, &mut creds) {
      return Usage::error(P, e, "stale-token");
    }
  }
  let project = match post_json(ctx, LOAD_URL, &creds.access, json!({ "metadata": { "ideType": "GEMINI_CLI", "pluginType": "GEMINI" } })) {
    Ok(r) if r.ok() => r.json().and_then(|v| v["cloudaicompanionProject"].as_str().map(str::to_owned)),
    _ => None,
  }
  .or_else(|| (creds.source == Source::Opencode).then(|| creds.refresh.split('|').skip(1).find(|s| !s.is_empty()).map(str::to_owned)).flatten());
  let Some(project) = project else { return Usage::error(P, tr!(ProvidersMsg::GeminiNoProject), "usage-unavailable") };
  let mut res = post_json(ctx, QUOTA_URL, &creds.access, json!({ "project": project }));
  if matches!(&res, Ok(r) if r.status == 401) && refresh(ctx, &mut creds).is_ok() {
    res = post_json(ctx, QUOTA_URL, &creds.access, json!({ "project": project }));
  }
  match res {
    Err(e) => Usage::error(P, e, "network"),
    Ok(r) if !r.ok() => Usage::error(P, tr!(ProvidersMsg::GeminiQuotaFailed, status = r.status), if r.status == 401 { "stale-token" } else { "server" }),
    Ok(r) => match r.json() {
      Some(v) => parse_quota(&v),
      None => Usage::error(P, tr!(ProvidersMsg::GeminiQuotaFailed, status = r.status), "parse"),
    },
  }
}

/// Orca's names for Gemini models; others lose `gemini-` and are title-cased.
pub fn model_name(id: &str) -> String {
  let known = [
    ("gemini-2.5-pro", "Pro"),
    ("gemini-2.5-flash", "Flash"),
    ("gemini-2.5-flash-lite", "Flash Lite"),
    ("gemini-3.1-pro", "3.1 Pro"),
    ("gemini-3.1-flash", "3.1 Flash"),
    ("gemini-3.1-flash-lite", "3.1 Flash Lite"),
    ("gemini-3.0-pro", "3.0 Pro"),
    ("gemini-3.0-flash", "3.0 Flash"),
    ("gemini-2.0-pro", "2.0 Pro"),
    ("gemini-2.0-flash", "2.0 Flash"),
    ("gemini-2.0-flash-lite", "2.0 Flash Lite"),
    ("gemini-1.5-pro", "1.5 Pro"),
    ("gemini-1.5-flash", "1.5 Flash"),
    ("gemini-exp", "Exp"),
    ("gemini-experimental", "Exp"),
  ];
  if let Some((_, n)) = known.iter().find(|(k, _)| *k == id) {
    return (*n).into();
  }
  id.trim_start_matches("gemini-").split('-').filter(|s| !s.is_empty()).map(|s| s[..1].to_uppercase() + &s[1..]).collect::<Vec<_>>().join(" ")
}

pub fn parse_quota(v: &Value) -> Usage {
  let list = v.get("buckets").and_then(Value::as_array).or_else(|| v.as_array()).cloned().unwrap_or_default();
  let mut buckets: Vec<(bool, Bucket)> = Vec::new();
  for b in &list {
    let (Some(frac), Some(id)) = (b["remainingFraction"].as_f64(), b["modelId"].as_str()) else { continue };
    let resets = b["resetTime"].as_str().and_then(super::parse_iso);
    let w = window((1.0 - frac) * 100.0, 60, resets);
    let name = model_name(id);
    let mapped = name != id;
    // One bucket per (percent, reset): prefer a known model, then the shorter name.
    if let Some(pos) = buckets.iter().position(|(_, x)| x.window.used_percent == w.used_percent && x.window.resets_at == w.resets_at) {
      let (was_mapped, old) = &buckets[pos];
      if (mapped && !*was_mapped) || (mapped == *was_mapped && name.len() < old.name.len()) {
        buckets[pos] = (mapped, Bucket { name, window: w });
      }
      continue;
    }
    buckets.push((mapped, Bucket { name, window: w }));
  }
  let buckets: Vec<Bucket> = buckets.into_iter().map(|(_, b)| b).collect();
  let session = buckets.iter().max_by(|a, b| a.window.used_percent.total_cmp(&b.window.used_percent)).map(|b| b.window.clone());
  Usage { session, buckets, ..Usage::new(P, Status::Ok) }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn names_models_and_parses_buckets() {
    assert_eq!(model_name("gemini-2.5-pro"), "Pro");
    assert_eq!(model_name("gemini-9-ultra-x"), "9 Ultra X");
    let u = parse_quota(&json!({ "buckets": [
      { "remainingFraction": 0.25, "resetTime": "1970-01-01T01:00:00Z", "modelId": "gemini-2.5-pro" },
      { "remainingFraction": 0.9, "resetTime": "1970-01-01T01:00:00Z", "modelId": "gemini-2.5-flash" },
      { "remainingFraction": 0.9, "resetTime": "1970-01-01T01:00:00Z", "modelId": "gemini-2.5-flash-preview-x" },
      { "modelId": "broken" }
    ]}));
    assert_eq!(u.status, Status::Ok);
    assert_eq!(u.buckets.iter().map(|b| b.name.as_str()).collect::<Vec<_>>(), vec!["Pro", "Flash"]);
    assert_eq!(u.session.unwrap().used_percent, 75.0);
  }

  #[test]
  fn finds_the_cli_oauth_client() {
    let src = "const OAUTH_CLIENT_ID = '123.apps.googleusercontent.com';\nconst OAUTH_CLIENT_SECRET = \"GOCSPX-abc\";";
    assert_eq!(oauth_client_in(src), Some(("123.apps.googleusercontent.com".into(), "GOCSPX-abc".into())));
    assert_eq!(oauth_client_in("nothing"), None);
  }

  #[test]
  fn off_unless_turned_on() {
    let web = super::super::fake::FakeWeb::default();
    let run = super::super::fake::FakeRunner::default();
    let secrets = crate::accounts::secrets::fake::FakeSecrets::default();
    let config = super::super::Config::default();
    let dir = tempfile::tempdir().unwrap();
    let ctx = Ctx { web: &web, run: &run, secrets: &secrets, home: dir.path().into(), config: &config, now: 0 };
    assert_eq!(fetch(&ctx).status, Status::Unavailable);
    let config = super::super::Config { gemini_cli_oauth: true, ..Default::default() };
    let ctx = Ctx { config: &config, ..ctx };
    assert_eq!(fetch(&ctx).error, Some(tr!(ProvidersMsg::GeminiNoCredentials)));
  }
}
