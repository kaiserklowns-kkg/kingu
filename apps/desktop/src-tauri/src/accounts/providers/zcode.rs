//! GLM Coding Plan usage (Orca's zcode-usage-*): the plan API key saved in Kingu first, else the
//! ZCode CLI's own Coding Plan credential (v2 `provider_config.json` + `credentials.json`, whose
//! values may be AES-256-GCM sealed, or the legacy `~/.zcode/cli/config.json`). The quota limits
//! of the plan site become the 5-hour session, the week and the monthly MCP allowance.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use super::{Ctx, Req, Status, Usage, fingerprint, num, read_json, window};
use crate::i18n::msg::ProvidersMsg;
use crate::tr;

const P: &str = "zcode";
const QUOTA_PATH: &str = "/api/monitor/usage/quota/limit";

pub fn site_origin(site: &str) -> &'static str {
  if site == "bigmodel" { "https://open.bigmodel.cn" } else { "https://api.z.ai" }
}

/// An https origin on one of the plan hosts, port 443.
pub fn plan_origin(base_url: &str) -> Option<String> {
  let u = url::Url::parse(base_url).ok()?;
  let host = u.host_str()?;
  (u.scheme() == "https" && matches!(host, "api.z.ai" | "open.bigmodel.cn" | "dev.bigmodel.cn") && u.port_or_known_default() == Some(443)).then(|| format!("https://{host}"))
}

#[derive(Debug, Clone, PartialEq)]
pub struct Credential {
  pub key: String,
  pub origin: String,
  /// kingu-plan, or the CLI config file used.
  pub source: String,
  pub identity: Option<String>,
}

fn base_dir(home: &Path) -> PathBuf {
  std::env::var_os("ZCODE_DATA_BASE_DIR").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| home.to_path_buf())
}

/// `enc:v1:<nonce>.<tag>.<ciphertext>` (base64url) sealed with SHA-256 of the ZCode secret.
pub fn unseal(value: &str, home: &Path) -> Option<String> {
  use aes_gcm::aead::{Aead, KeyInit};
  use base64::Engine;
  use sha2::{Digest, Sha256};
  let Some(rest) = value.strip_prefix("enc:v1:") else { return Some(value.to_owned()) };
  let mut parts = rest.split('.');
  let b64 = |s: &str| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s.trim_end_matches('=')).ok();
  let (nonce, tag, ct) = (b64(parts.next()?)?, b64(parts.next()?)?, b64(parts.next()?)?);
  if nonce.len() != 12 || tag.len() != 16 {
    return None;
  }
  let secret = std::env::var("ZCODE_CREDENTIAL_SECRET").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| {
    let user = std::env::var("USER").unwrap_or_default();
    format!("zcode-credential-fallback:{}:{}:{user}", std::env::consts::OS, home.display())
  });
  let key = Sha256::digest(secret.as_bytes());
  let cipher = aes_gcm::Aes256Gcm::new_from_slice(&key).ok()?;
  let mut sealed = ct;
  sealed.extend_from_slice(&tag);
  let plain = cipher.decrypt(aes_gcm::Nonce::from_slice(&nonce), sealed.as_slice()).ok()?;
  String::from_utf8(plain).ok()
}

fn v2_credential(home: &Path) -> Result<Option<Credential>, String> {
  let base = base_dir(home);
  let config_file = std::env::var_os("ZCODE_PERSONAL_PROVIDER_CONFIG_FILE").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| base.join(".zcode/v2/provider_config.json"));
  let Some(config) = read_json(&config_file, 1 << 20)? else { return Ok(None) };
  if config["schemaVersion"] != 1 {
    return Ok(None);
  }
  let Some(pid) = config["defaultModelSelection"]["providerId"].as_str() else { return Ok(None) };
  let origin = match pid {
    "account:zai-individual-coding-plan" => "https://api.z.ai",
    "account:bigmodel-individual-coding-plan" => "https://open.bigmodel.cn",
    _ => return Ok(None),
  };
  let Some(creds) = read_json(&base.join(".zcode/v2/credentials.json"), 1 << 20)? else { return Ok(None) };
  let get = |k: &str| creds[k].as_str().and_then(|v| unseal(v, home));
  let Some(identity) = get(&format!("account-provider:{pid}:identity")) else { return Ok(None) };
  let enc_identity = url::form_urlencoded::byte_serialize(identity.as_bytes()).collect::<String>().replace('+', "%20");
  let Some(key) = get(&format!("account-provider:coding-plan:{pid}:account:{enc_identity}:api-key")).filter(|k| !k.is_empty()) else { return Ok(None) };
  Ok(Some(Credential { key, origin: origin.into(), source: config_file.display().to_string(), identity: Some(identity) }))
}

fn legacy_credential(home: &Path) -> Result<Option<Credential>, String> {
  let file = home.join(".zcode/cli/config.json");
  let Some(v) = read_json(&file, 1 << 20)? else { return Ok(None) };
  let model = v["model"].as_str().or(v["model"]["main"].as_str()).unwrap_or_default();
  let Some((provider, _)) = model.split_once('/') else { return Ok(None) };
  let opts = &v["provider"][provider]["options"];
  let (Some(key), Some(base)) = (opts["apiKey"].as_str().filter(|k| !k.is_empty()), opts["baseURL"].as_str()) else { return Ok(None) };
  let Some(origin) = plan_origin(base) else { return Ok(None) };
  Ok(Some(Credential { key: key.into(), origin, source: file.display().to_string(), identity: None }))
}

pub fn cli_credential(home: &Path) -> Result<Option<Credential>, String> {
  match v2_credential(home)? {
    Some(c) => Ok(Some(c)),
    None => legacy_credential(home),
  }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZcodeStatus {
  pub api_key_configured: bool,
  pub zcode_cli_configured: bool,
}

pub fn status(ctx: &Ctx) -> ZcodeStatus {
  ZcodeStatus { api_key_configured: ctx.secret("zcode:api-key").is_some(), zcode_cli_configured: cli_credential(&ctx.home).ok().flatten().is_some() }
}

pub fn fetch(ctx: &Ctx) -> Usage {
  let cred = match ctx.secret("zcode:api-key") {
    Some(key) => Credential { key, origin: site_origin(&ctx.config.zcode_site).into(), source: "kingu-plan".into(), identity: None },
    None => match cli_credential(&ctx.home) {
      Ok(Some(c)) => c,
      Ok(None) => return Usage::unavailable(P, tr!(ProvidersMsg::ZcodeNotConfigured), "missing-credentials"),
      Err(_) => return Usage::error(P, tr!(ProvidersMsg::ZcodeCliUnreadable), "missing-credentials"),
    },
  };
  let req = Req::get(format!("{}{QUOTA_PATH}", cred.origin)).header("Authorization", cred.key.clone()).header("Accept-Language", "en-US,en").header("Content-Type", "application/json");
  let res = match ctx.web.send(req) {
    Ok(r) => r,
    Err(e) => return Usage::error(P, e.replace(&cred.key, "…"), "network"),
  };
  if !res.ok() {
    return Usage::error(P, tr!(ProvidersMsg::ZcodeFailed, status = res.status), "server");
  }
  let Some(v) = res.json() else { return Usage::error(P, tr!(ProvidersMsg::ZcodeParse), "parse") };
  let mut u = parse(&v);
  u.provenance = Some(fingerprint(&format!("{}|{}|{}", cred.identity.unwrap_or_default(), cred.origin, cred.key), 12));
  u
}

fn unit_minutes(unit: i64) -> Option<u64> {
  match unit {
    1 => Some(1440),
    3 => Some(60),
    5 => Some(1),
    6 => Some(10080),
    _ => None,
  }
}

pub fn parse(v: &Value) -> Usage {
  let code = v["code"].as_i64().unwrap_or(-1);
  let Some(limits) = v["data"]["limits"].as_array().filter(|_| v["success"] == true && (code == 0 || code == 200)) else {
    return Usage::error(P, v["msg"].as_str().map(str::to_owned).unwrap_or_else(|| tr!(ProvidersMsg::ZcodeInvalid)), "usage-unavailable");
  };
  let mut windows = Vec::new();
  let mut monthly = None;
  for l in limits {
    let kind = l["type"].as_str().unwrap_or_default();
    let (unit, number) = (l["unit"].as_i64().unwrap_or(0), l["number"].as_i64().unwrap_or(0));
    let minutes = if kind == "TIME_LIMIT" && unit == 5 && number == 1 { Some(43200) } else { unit_minutes(unit).map(|m| m * number.max(0) as u64) };
    let Some(minutes) = minutes.filter(|m| *m > 0) else { continue };
    let usage = num(&l["usage"]).unwrap_or(0.0);
    let pct = match (num(&l["currentValue"]), num(&l["remaining"])) {
      (Some(cur), _) if usage > 0.0 => cur / usage * 100.0,
      (None, Some(rem)) if usage > 0.0 => (usage - rem) / usage * 100.0,
      _ => num(&l["percentage"]).unwrap_or(0.0),
    };
    let reset = l["nextResetTime"].as_u64().filter(|r| *r > 0);
    let w = window(pct, minutes as u32, reset);
    if kind == "TIME_LIMIT" {
      monthly = monthly.or(Some(w));
    } else if kind == "TOKENS_LIMIT" || kind == "CREDIT_LIMIT" {
      windows.push(w);
    }
  }
  windows.sort_by_key(|w| w.window_minutes);
  let session = windows.iter().find(|w| w.window_minutes == 300).cloned();
  let weekly = windows.iter().find(|w| w.window_minutes == 10080).cloned();
  if session.is_none() && weekly.is_none() && monthly.is_none() {
    return Usage::error(P, tr!(ProvidersMsg::ZcodeNoLimits), "usage-unavailable");
  }
  Usage { session, weekly, monthly, plan: v["data"]["level"].as_str().map(str::to_owned), ..Usage::new(P, Status::Ok) }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn parses_quota_limits() {
    let u = parse(&json!({ "success": true, "code": 200, "data": { "level": "pro", "limits": [
      { "type": "TOKENS_LIMIT", "unit": 3, "number": 5, "usage": 100, "currentValue": 30, "nextResetTime": 9 },
      { "type": "TOKENS_LIMIT", "unit": 6, "number": 1, "percentage": 12 },
      { "type": "TIME_LIMIT", "unit": 5, "number": 1, "usage": 10, "remaining": 5 }
    ]}}));
    assert_eq!(u.session.as_ref().unwrap().used_percent, 30.0);
    assert_eq!(u.weekly.as_ref().unwrap().used_percent, 12.0);
    assert_eq!(u.monthly.as_ref().unwrap().window_minutes, 43200);
    assert_eq!(u.monthly.unwrap().used_percent, 50.0);
    assert_eq!(u.plan.as_deref(), Some("pro"));
    assert_eq!(parse(&json!({ "success": false, "msg": "nope" })).error.as_deref(), Some("nope"));
  }

  #[test]
  fn checks_plan_hosts() {
    assert_eq!(plan_origin("https://api.z.ai/api/anthropic").as_deref(), Some("https://api.z.ai"));
    assert_eq!(plan_origin("http://api.z.ai"), None);
    assert_eq!(plan_origin("https://evil.example/api.z.ai"), None);
  }

  #[test]
  fn unseals_v2_values() {
    use aes_gcm::aead::{Aead, KeyInit};
    use base64::Engine;
    use sha2::{Digest, Sha256};
    // SAFETY: tests set the secret before any thread reads it.
    unsafe { std::env::set_var("ZCODE_CREDENTIAL_SECRET", "s3cret") };
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(&Sha256::digest(b"s3cret")).unwrap();
    let nonce = [7u8; 12];
    let sealed = cipher.encrypt(aes_gcm::Nonce::from_slice(&nonce), b"key-123".as_slice()).unwrap();
    let (ct, tag) = sealed.split_at(sealed.len() - 16);
    let e = |b: &[u8]| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b);
    let value = format!("enc:v1:{}.{}.{}", e(&nonce), e(tag), e(ct));
    assert_eq!(unseal(&value, Path::new("/home/x")).as_deref(), Some("key-123"));
    assert_eq!(unseal("plain", Path::new("/")).as_deref(), Some("plain"));
    unsafe { std::env::remove_var("ZCODE_CREDENTIAL_SECRET") };
  }
}
