//! ZCode / GLM Coding Plan quota, the way Orca reads it: `GET <site>/api/monitor/usage/quota/limit`
//! with the plan's API key as the bare `Authorization` value. The key is the one a user saved in
//! Kingu for the site in `kingu.usage.zcode.site` (Z.AI `api.z.ai`, or BigModel
//! `open.bigmodel.cn`), else the selected provider of ZCode CLI's `~/.zcode/cli/config.json`
//! (`model: "<provider>/<model>"`, `provider.<provider>.options.{apiKey, baseURL}`), and only when
//! that base URL is one of those hosts over HTTPS. A key of another configured provider is never
//! used. Body: `{success, code, data: {level, limits: [{type, unit, number, usage, currentValue,
//! remaining, percentage, nextResetTime}]}}`.
//!
//! ZCode 2's `~/.zcode/v2` store comes first; its values may be AES-256-GCM sealed (`enc:v1:`).

use std::path::PathBuf;

use serde_json::Value;

use super::io::{Host, Http, Request};
use super::{ProviderUsage, Window, MONTH_MINUTES, SESSION_MINUTES, WEEK_MINUTES};
use crate::accounts::secrets::SecretStore;
use crate::i18n::msg::UsageMsg;
use crate::tr;

const P: &str = "zcode";
const HOSTS: [&str; 3] = ["api.z.ai", "open.bigmodel.cn", "dev.bigmodel.cn"];

pub fn site_base(site: &str) -> &'static str {
  if site == "bigmodel" { "https://open.bigmodel.cn" } else { "https://api.z.ai" }
}

/// The quota URL for a base URL, when it is a GLM Coding Plan host over HTTPS.
pub fn quota_url(base: &str) -> Option<String> {
  let u = url::Url::parse(base.trim()).ok()?;
  let host = u.host_str()?;
  (u.scheme() == "https" && HOSTS.contains(&host) && u.port().is_none_or(|p| p == 443)).then(|| format!("https://{host}/api/monitor/usage/quota/limit"))
}

fn clean_key(k: &str) -> Option<String> {
  let k = k.trim();
  (!k.is_empty() && !k.contains(['\r', '\n'])).then(|| k.to_owned())
}

/// ZCode CLI's selected provider: (key, base URL).
pub fn cli_credentials(text: &str) -> Option<(String, String)> {
  let v: Value = serde_json::from_str(text).ok()?;
  let model = v.get("model").and_then(|m| m.as_str().or_else(|| m.get("main")?.as_str()))?;
  let (provider, rest) = model.split_once('/')?;
  if provider.is_empty() || rest.is_empty() {
    return None;
  }
  let o = v.get("provider")?.get(provider)?.get("options")?;
  Some((clean_key(o.get("apiKey")?.as_str()?)?, o.get("baseURL")?.as_str()?.to_owned()))
}

fn n(v: &Value) -> Option<f64> {
  v.as_f64().filter(|x| x.is_finite())
}

fn minutes(l: &Value) -> Option<u32> {
  if l["type"] == "TIME_LIMIT" && l["unit"] == 5 && l["number"] == 1 {
    // Z.ai marks its monthly MCP quota as "one minute".
    return Some(MONTH_MINUTES);
  }
  let per = match n(&l["unit"])? as i64 {
    1 => 1440,
    3 => 60,
    5 => 1,
    6 => WEEK_MINUTES,
    _ => return None,
  };
  let count = n(&l["number"]).filter(|c| *c > 0.0 && c.fract() == 0.0)? as u32;
  Some(count * per)
}

fn used(l: &Value) -> Option<f64> {
  if let Some(total) = n(&l["usage"]).filter(|t| *t > 0.0) {
    let (cur, left) = (n(&l["currentValue"]), n(&l["remaining"]));
    if cur.is_some() || left.is_some() {
      let u = cur.unwrap_or(total - left.unwrap_or(0.0));
      return Some((u / total * 100.0).clamp(0.0, 100.0));
    }
  }
  n(&l["percentage"]).map(|p| p.clamp(0.0, 100.0))
}

fn window(l: &Value, now: i64) -> Option<Window> {
  let (used_percent, window_minutes) = (used(l)?, minutes(l)?);
  let reset = n(&l["nextResetTime"]).filter(|r| *r > 0.0).map(|r| r as i64);
  // A "5 hour" reset further out than that is not this window's.
  let resets_at = reset.filter(|r| window_minutes != SESSION_MINUTES || *r <= now + 301 * 60_000);
  Some(Window { used_percent, window_minutes, resets_at })
}

pub fn parse(body: &str, now: i64) -> ProviderUsage {
  let bad = |msg: String| ProviderUsage::failed(P, "error", "parse", &msg);
  let Ok(v) = serde_json::from_str::<Value>(body) else { return bad(tr!(UsageMsg::Unreadable, provider = "ZCode")) };
  let code = &v["code"];
  let Some(limits) = v["data"]["limits"].as_array().filter(|_| v["success"] == true && (code.is_null() || code == 0 || code == 200)) else {
    return bad(v["msg"].as_str().map(str::to_owned).unwrap_or_else(|| tr!(UsageMsg::Unreadable, provider = "ZCode")));
  };
  let mut plan: Vec<Window> = limits.iter().filter(|l| l["type"] == "TOKENS_LIMIT" || l["type"] == "CREDIT_LIMIT").filter_map(|l| window(l, now)).collect();
  plan.sort_by_key(|w| w.window_minutes);
  let session = plan.iter().find(|w| w.window_minutes == SESSION_MINUTES).cloned();
  let weekly = plan.iter().find(|w| w.window_minutes == WEEK_MINUTES).cloned();
  let monthly = limits.iter().find(|l| l["type"] == "TIME_LIMIT").and_then(|l| window(l, now));
  if session.is_none() && weekly.is_none() && monthly.is_none() {
    return bad(tr!(UsageMsg::Unreadable, provider = "ZCode"));
  }
  ProviderUsage { session, weekly, monthly, plan_type: v["data"]["level"].as_str().map(str::to_owned), ..ProviderUsage::new(P) }
}

fn cli_config(host: &dyn Host) -> Option<PathBuf> {
  Some(host.home()?.join(".zcode/cli/config.json"))
}

/// `enc:v1:<nonce>.<tag>.<ciphertext>` (base64url), sealed with SHA-256 of `ZCODE_CREDENTIAL_SECRET`
/// or ZCode's fallback secret; a plain value comes back as it is.
pub fn unseal(value: &str, host: &dyn Host) -> Option<String> {
  use aes_gcm::aead::{Aead, KeyInit};
  use base64::Engine;
  use sha2::{Digest, Sha256};
  let Some(rest) = value.strip_prefix("enc:v1:") else { return Some(value.to_owned()) };
  let b64 = |s: &str| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s.trim_end_matches('=')).ok();
  let mut parts = rest.split('.');
  let (nonce, tag, ct) = (b64(parts.next()?)?, b64(parts.next()?)?, b64(parts.next()?)?);
  if nonce.len() != 12 || tag.len() != 16 {
    return None;
  }
  let secret = host.var("ZCODE_CREDENTIAL_SECRET").unwrap_or_else(|| {
    let home = host.home().map(|h| h.display().to_string()).unwrap_or_default();
    format!("zcode-credential-fallback:{}:{home}:{}", std::env::consts::OS, host.var("USER").unwrap_or_default())
  });
  let cipher = aes_gcm::Aes256Gcm::new_from_slice(&Sha256::digest(secret.as_bytes())).ok()?;
  let mut sealed = ct;
  sealed.extend_from_slice(&tag);
  String::from_utf8(cipher.decrypt(aes_gcm::Nonce::from_slice(&nonce), sealed.as_slice()).ok()?).ok()
}

/// ZCode 2's selected Coding Plan: `provider_config.json` (schemaVersion 1) names the provider,
/// `credentials.json` holds its identity and key. `Err` when a file exists but cannot be read.
pub fn v2_credentials(host: &dyn Host) -> Result<Option<(String, String)>, ()> {
  let base = host.var("ZCODE_DATA_BASE_DIR").map(PathBuf::from).or_else(|| host.home()).ok_or(())?;
  let config_file = host.var("ZCODE_PERSONAL_PROVIDER_CONFIG_FILE").map(PathBuf::from).unwrap_or_else(|| base.join(".zcode/v2/provider_config.json"));
  let Some(config) = host.read(&config_file)? else { return Ok(None) };
  let config: Value = serde_json::from_str(&config).map_err(|_| ())?;
  if config["schemaVersion"] != 1 {
    return Ok(None);
  }
  let Some(pid) = config["defaultModelSelection"]["providerId"].as_str() else { return Ok(None) };
  let base_url = match pid {
    "account:zai-individual-coding-plan" => "https://api.z.ai",
    "account:bigmodel-individual-coding-plan" => "https://open.bigmodel.cn",
    _ => return Ok(None),
  };
  let Some(creds) = host.read(&base.join(".zcode/v2/credentials.json"))? else { return Ok(None) };
  let creds: Value = serde_json::from_str(&creds).map_err(|_| ())?;
  let get = |k: &str| creds[k].as_str().and_then(|v| unseal(v, host));
  let Some(identity) = get(&format!("account-provider:{pid}:identity")) else { return Ok(None) };
  let enc = url::form_urlencoded::byte_serialize(identity.as_bytes()).collect::<String>().replace('+', "%20");
  Ok(get(&format!("account-provider:coding-plan:{pid}:account:{enc}:api-key")).and_then(|k| clean_key(&k)).map(|k| (k, base_url.to_owned())))
}

pub fn fetch(http: &dyn Http, host: &dyn Host, secrets: &dyn SecretStore, site: &str, now: i64) -> ProviderUsage {
  let (key, url) = match secrets.get("zcode.apiKey") {
    Some(k) => (k, quota_url(site_base(site)).unwrap_or_default()),
    None => {
      // ZCode 2's store first, then the legacy CLI config.
      let found = match v2_credentials(host) {
        Ok(Some((k, base))) => match quota_url(&base) {
          Some(url) => return send(http, &k, &url, now),
          None => return ProviderUsage::failed(P, "unavailable", "missing-credentials", &tr!(UsageMsg::ZcodeNotConfigured)),
        },
        Err(()) => Some(Err(())),
        Ok(None) => cli_config(host).map(|p| host.read(&p)),
      };
      match found {
        Some(Err(())) => return ProviderUsage::failed(P, "error", "parse", &tr!(UsageMsg::ZcodeCliUnreadable)),
        Some(Ok(Some(text))) => match cli_credentials(&text).and_then(|(k, base)| Some((k, quota_url(&base)?))) {
          Some(c) => c,
          None => return ProviderUsage::failed(P, "unavailable", "missing-credentials", &tr!(UsageMsg::ZcodeNotConfigured)),
        },
        _ => return ProviderUsage::failed(P, "unavailable", "missing-credentials", &tr!(UsageMsg::ZcodeNotConfigured)),
      }
    }
  };
  send(http, &key, &url, now)
}

/// The quota request with the plan key (sent raw, no Bearer, only to the plan host).
fn send(http: &dyn Http, key: &str, url: &str, now: i64) -> ProviderUsage {
  let req = Request::get(url).header("Authorization", key.to_owned()).header("Accept-Language", "en-US,en").header("Content-Type", "application/json");
  match http.send(&req) {
    Err(kind) => ProviderUsage::failed(P, "error", kind, &tr!(UsageMsg::Network, provider = "ZCode")),
    Ok(r) if matches!(r.status, 401 | 403) => ProviderUsage::failed(P, "error", "stale-token", &tr!(UsageMsg::KeyRejected, provider = "ZCode")),
    Ok(r) if !(200..300).contains(&r.status) => ProviderUsage::failed(P, "error", if r.status == 429 { "rate-limited" } else { "server" }, &tr!(UsageMsg::RequestFailed, provider = "ZCode", status = r.status)),
    Ok(r) => parse(&r.body, now),
  }
}

#[cfg(test)]
mod tests {
  use super::super::io::fake::{FakeHost, FakeHttp, HOME};
  use super::*;
  use crate::accounts::secrets::fake::FakeSecrets;

  const NOW: i64 = 1_792_600_000_000;
  const BODY: &str = r#"{"success":true,"code":200,"data":{"level":"pro","limits":[
    {"type":"TOKENS_LIMIT","unit":3,"number":5,"usage":1000,"currentValue":250,"nextResetTime":1792609200000},
    {"type":"TOKENS_LIMIT","unit":6,"number":1,"percentage":40},
    {"type":"TIME_LIMIT","unit":5,"number":1,"usage":100,"remaining":90,"nextResetTime":1795000000000}]}}"#;

  #[test]
  fn maps_limits_to_windows() {
    let u = parse(BODY, NOW);
    assert_eq!(u.session, Some(Window { used_percent: 25.0, window_minutes: 300, resets_at: Some(1_792_609_200_000) }));
    assert_eq!(u.weekly.map(|w| (w.used_percent, w.window_minutes)), Some((40.0, 10_080)));
    assert_eq!(u.monthly.map(|w| (w.used_percent, w.window_minutes)), Some((10.0, MONTH_MINUTES)));
    assert_eq!(u.plan_type.as_deref(), Some("pro"));
    // A 5-hour reset more than 5 hours away is dropped.
    let far = r#"{"success":true,"data":{"limits":[{"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":5,"nextResetTime":1892609200000}]}}"#;
    assert_eq!(parse(far, NOW).session.unwrap().resets_at, None);
    let refused = parse(r#"{"success":false,"msg":"token expired"}"#, NOW);
    assert_eq!((refused.failure_kind.as_deref(), refused.error.as_deref()), (Some("parse"), Some("token expired")));
  }

  #[test]
  fn only_coding_plan_hosts() {
    assert_eq!(quota_url("https://api.z.ai/api/anthropic").as_deref(), Some("https://api.z.ai/api/monitor/usage/quota/limit"));
    assert_eq!(quota_url("https://open.bigmodel.cn:443").as_deref(), Some("https://open.bigmodel.cn/api/monitor/usage/quota/limit"));
    for bad in ["http://api.z.ai", "https://evil.example/api.z.ai", "https://api.z.ai:8443", "nonsense"] {
      assert_eq!(quota_url(bad), None, "{bad}");
    }
    let cfg = r#"{"model":"zai/glm-4.6","provider":{"zai":{"options":{"apiKey":"zk","baseURL":"https://api.z.ai/api/anthropic"}},"other":{"options":{"apiKey":"no"}}}}"#;
    assert_eq!(cli_credentials(cfg), Some(("zk".into(), "https://api.z.ai/api/anthropic".into())));
    assert_eq!(cli_credentials(r#"{"model":{"main":"other/x"},"provider":{}}"#), None);
  }

  #[test]
  fn saved_key_then_cli_config() {
    let s = FakeSecrets::default();
    s.set("zcode.apiKey", "saved").unwrap();
    let http = FakeHttp::new(vec![FakeHttp::ok(BODY)]);
    assert_eq!(fetch(&http, &FakeHost::new(), &s, "bigmodel", NOW).status, "ok");
    assert_eq!(http.urls(), ["https://open.bigmodel.cn/api/monitor/usage/quota/limit"]);
    assert_eq!(http.header(0, "authorization").as_deref(), Some("saved"));

    let cfg = r#"{"model":"zai/glm","provider":{"zai":{"options":{"apiKey":"cli","baseURL":"https://api.z.ai/x"}}}}"#;
    let host = FakeHost::new().file(&format!("{HOME}/.zcode/cli/config.json"), cfg);
    let http = FakeHttp::new(vec![FakeHttp::status(401)]);
    assert_eq!(fetch(&http, &host, &FakeSecrets::default(), "zai", NOW).failure_kind.as_deref(), Some("stale-token"));
    assert_eq!(http.header(0, "authorization").as_deref(), Some("cli"));

    let http = FakeHttp::new(vec![]);
    assert_eq!(fetch(&http, &FakeHost::new(), &FakeSecrets::default(), "zai", NOW).status, "unavailable");
    assert!(http.urls().is_empty());
  }

  #[test]
  fn reads_zcode2_sealed_store() {
    use aes_gcm::aead::{Aead, KeyInit};
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(&Sha256::digest(b"s3cret")).unwrap();
    let e = |b: &[u8]| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b);
    let seal = |plain: &str| {
      let nonce = [7u8; 12];
      let sealed = cipher.encrypt(aes_gcm::Nonce::from_slice(&nonce), plain.as_bytes()).unwrap();
      let (ct, tag) = sealed.split_at(sealed.len() - 16);
      format!("enc:v1:{}.{}.{}", e(&nonce), e(tag), e(ct))
    };
    let pid = "account:zai-individual-coding-plan";
    let creds = serde_json::json!({
      format!("account-provider:{pid}:identity"): seal("me@x.io"),
      format!("account-provider:coding-plan:{pid}:account:me%40x.io:api-key"): seal("plan-key"),
    });
    let host = FakeHost::new()
      .var("ZCODE_CREDENTIAL_SECRET", "s3cret")
      .file(&format!("{HOME}/.zcode/v2/provider_config.json"), &format!(r#"{{"schemaVersion":1,"defaultModelSelection":{{"providerId":"{pid}"}}}}"#))
      .file(&format!("{HOME}/.zcode/v2/credentials.json"), &creds.to_string());
    assert_eq!(v2_credentials(&host), Ok(Some(("plan-key".into(), "https://api.z.ai".into()))));
    assert_eq!(unseal("plain", &host).as_deref(), Some("plain"));
  }

}
