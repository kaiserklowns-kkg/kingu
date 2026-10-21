//! Antigravity's quota, the way Orca reads it: from the `agy` CLI itself, since agy keeps its
//! Google sign-in in the OS keyring and mints its own tokens. `agy --version` first (1.1.11 or
//! newer: older builds answer `/usage` with a model turn), then `agy -p /usage --output-format
//! json --print-timeout 20s`, a command reply that starts no conversation and spends no quota.
//! The envelope's `command.data.groups[].buckets[]` (`remaining_fraction`, `window` 5h / weekly)
//! become named pools; the most used 5h / weekly pool is the session / weekly window.
//!
//! If agy ever answers with a model turn (a conversation id, turns > 0), Kingu stops asking until
//! it restarts rather than spend quota again. Only runs when `kingu.usage.antigravity` is on.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::Value;

use super::io::Host;
use super::{parse_time, Bucket, ProviderUsage, Window, SESSION_MINUTES, WEEK_MINUTES};
use crate::i18n::msg::UsageMsg;
use crate::tr;

const P: &str = "antigravity";
pub const PROGRAM: &str = "agy";
pub const USAGE_ARGS: [&str; 6] = ["-p", "/usage", "--output-format", "json", "--print-timeout", "20s"];
const MIN_VERSION: (u64, u64, u64) = (1, 1, 11);

static ANSWERED_AS_PROMPT: AtomicBool = AtomicBool::new(false);

/// The first `x.y.z` in `--version` output.
pub fn version(text: &str) -> Option<(u64, u64, u64)> {
  let re = regex::Regex::new(r"(\d+)\.(\d+)\.(\d+)").expect("static regex");
  let c = re.captures(text)?;
  Some((c[1].parse().ok()?, c[2].parse().ok()?, c[3].parse().ok()?))
}

fn group_buckets(groups: &Value) -> Vec<Bucket> {
  let mut out = Vec::new();
  for g in groups.as_array().into_iter().flatten() {
    let Some(name) = g["name"].as_str().filter(|n| !n.is_empty()) else { continue };
    let enabled: Vec<&Value> = g["buckets"].as_array().into_iter().flatten().filter(|b| b.is_object() && b["disabled"] != true).collect();
    for b in &enabled {
      let (Some(_id), Some(left)) = (b["id"].as_str().filter(|i| !i.is_empty()), b["remaining_fraction"].as_f64().filter(|f| f.is_finite())) else { continue };
      let label = match b["name"].as_str().filter(|n| !n.is_empty()) {
        Some(bn) if enabled.len() > 1 => format!("{name} · {bn}"),
        _ => name.to_owned(),
      };
      let window_minutes = match b["window"].as_str() {
        Some("weekly") => WEEK_MINUTES,
        Some("5h") => SESSION_MINUTES,
        _ => 0,
      };
      out.push(Bucket { name: label, used_percent: ((1.0 - left) * 100.0).round().clamp(0.0, 100.0), window_minutes, resets_at: parse_time(&b["reset_time"]) });
    }
  }
  out
}

fn most_used(buckets: &[Bucket], minutes: u32) -> Option<Window> {
  buckets
    .iter()
    .filter(|b| b.window_minutes == minutes)
    .fold(None::<&Bucket>, |best, b| if best.is_none_or(|x| b.used_percent > x.used_percent) { Some(b) } else { best })
    .map(|b| Window { used_percent: b.used_percent, window_minutes: b.window_minutes, resets_at: b.resets_at })
}

fn json_lines(stdout: &str) -> impl Iterator<Item = Value> + '_ {
  stdout.lines().map(str::trim).filter(|l| l.starts_with('{')).filter_map(|l| serde_json::from_str(l).ok())
}

/// The usage reply among agy's output lines (log noise around it is skipped).
pub fn parse_stdout(stdout: &str) -> Option<(Option<Window>, Option<Window>, Vec<Bucket>)> {
  json_lines(stdout).find_map(|v| {
    if v["status"] != "SUCCESS" || v["command"]["name"] != "usage" || !v["command"]["data"].is_object() {
      return None;
    }
    let buckets = group_buckets(&v["command"]["data"]["groups"]);
    (!buckets.is_empty()).then(|| (most_used(&buckets, SESSION_MINUTES), most_used(&buckets, WEEK_MINUTES), buckets))
  })
}

/// agy sent `/usage` to the model instead of running it.
pub fn ran_model_turn(stdout: &str) -> bool {
  json_lines(stdout).any(|v| v["num_turns"].as_f64().is_some_and(|n| n > 0.0) || v["conversation_id"].as_str().is_some_and(|c| !c.is_empty()))
}

/// (failure kind, signed out) from agy's `AGY_ERROR:` lines, else its words.
pub fn classify(output: &str) -> Option<(&'static str, bool)> {
  for line in output.lines() {
    let Some(i) = line.find("AGY_ERROR:") else { continue };
    let Ok(v) = serde_json::from_str::<Value>(line[i + 10..].trim()) else { continue };
    let status = v["status"].as_str().unwrap_or("").to_uppercase();
    let code = v["error_code"].as_i64();
    if status == "UNAUTHENTICATED" || code == Some(401) {
      return Some(("missing-credentials", true));
    }
    if status == "PERMISSION_DENIED" || code == Some(403) {
      return Some(("no-subscription", false));
    }
    if status == "RESOURCE_EXHAUSTED" || code == Some(429) {
      return Some(("rate-limited", false));
    }
    if code.is_some_and(|c| (500..600).contains(&c)) {
      return Some(("server", false));
    }
  }
  let low = output.to_lowercase();
  let signed_out = ["not logged in", "not signed in", "not authenticated", "unauthenticated", "run agy login", "please sign in", "please log in", "sign in to antigravity", "no credentials", "authentication required"];
  signed_out.iter().any(|p| low.contains(p)).then_some(("missing-credentials", true))
}

pub fn fetch(host: &dyn Host) -> ProviderUsage {
  fetch_with(host, &ANSWERED_AS_PROMPT)
}

/// `latch`: set once agy answered `/usage` as a prompt.
pub fn fetch_with(host: &dyn Host, latch: &AtomicBool) -> ProviderUsage {
  let unavailable = |kind: &str, msg: String| ProviderUsage::failed(P, "unavailable", kind, &msg);
  if latch.load(Ordering::Relaxed) {
    return unavailable("usage-unavailable", tr!(UsageMsg::AntigravityPrompt));
  }
  let Some(program) = host.which(PROGRAM) else {
    return unavailable("cli-unavailable", tr!(UsageMsg::AntigravityMissing));
  };
  let failed = |kind: &str, msg: String| ProviderUsage::failed(P, "error", kind, &msg);
  let v = match host.run(&program, &["--version"], Duration::from_secs(5)) {
    Ok(o) if o.code == Some(0) && !o.timed_out => version(if o.stdout.trim().is_empty() { &o.stderr } else { &o.stdout }),
    Ok(_) => None,
    Err(_) => return failed("cli-unavailable", tr!(UsageMsg::AntigravityNotStarted)),
  };
  if v.is_none_or(|v| v < MIN_VERSION) {
    return unavailable("usage-unavailable", tr!(UsageMsg::AntigravityTooOld));
  }
  let out = match host.run(&program, &USAGE_ARGS, Duration::from_secs(30)) {
    Ok(o) => o,
    Err(_) => return failed("cli-unavailable", tr!(UsageMsg::AntigravityNotStarted)),
  };
  if out.timed_out {
    return failed("usage-unavailable", tr!(UsageMsg::AntigravityTimeout));
  }
  if let Some((session, weekly, buckets)) = parse_stdout(&out.stdout) {
    return ProviderUsage { session, weekly, buckets, ..ProviderUsage::new(P) };
  }
  if ran_model_turn(&out.stdout) {
    latch.store(true, Ordering::Relaxed);
    return unavailable("usage-unavailable", tr!(UsageMsg::AntigravityPrompt));
  }
  match classify(&format!("{}\n{}", out.stdout, out.stderr)) {
    Some((kind, true)) => unavailable(kind, tr!(UsageMsg::AntigravitySignedOut)),
    Some(("rate-limited", _)) => failed("rate-limited", tr!(UsageMsg::RateLimited, provider = "Antigravity")),
    Some(("no-subscription", _)) => failed("no-subscription", tr!(UsageMsg::AntigravityNoSubscription)),
    Some((kind, _)) => failed(kind, tr!(UsageMsg::Unreadable, provider = "Antigravity")),
    None => failed("parse", tr!(UsageMsg::Unreadable, provider = "Antigravity")),
  }
}

#[cfg(test)]
mod tests {
  use std::path::PathBuf;

  use super::super::io::fake::FakeHost;
  use super::super::io::Output;
  use super::*;

  /// Shaped like agy 1.2.11's reply (Orca's captured fixture, abridged).
  const REPLY: &str = r#"{"conversation_id":"","status":"SUCCESS","num_turns":0,"command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[{"id":"gemini-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":0.75,"reset_time":"2026-10-25T08:00:00Z"},{"id":"gemini-5h","name":"5h","window":"5h","remaining_fraction":0.5},{"id":"x","window":"5h","remaining_fraction":0,"disabled":true}]},{"name":"Claude and GPT models","buckets":[{"id":"3p-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":0.1}]}]}}}"#;

  fn ok(stdout: &str) -> Result<Output, String> {
    Ok(Output { code: Some(0), stdout: stdout.into(), ..Default::default() })
  }

  fn host(outputs: Vec<Result<Output, String>>) -> FakeHost {
    let mut h = FakeHost::new();
    h.programs.insert(PROGRAM.into(), PathBuf::from("/opt/bin/agy"));
    *h.outputs.lock().unwrap() = outputs;
    h
  }

  #[test]
  fn reads_group_pools() {
    let (s, w, b) = parse_stdout(&format!("I0926 quota_manager.go] refresh\n{REPLY}\nBye.")).unwrap();
    assert_eq!(b.iter().map(|b| (b.name.as_str(), b.used_percent)).collect::<Vec<_>>(), [("Gemini Models · Weekly Limit Remaining", 25.0), ("Gemini Models · 5h", 50.0), ("Claude and GPT models", 90.0)]);
    assert_eq!(s.map(|w| w.used_percent), Some(50.0));
    assert_eq!(w.map(|w| (w.used_percent, w.window_minutes)), Some((90.0, WEEK_MINUTES)));
    assert!(parse_stdout("You are not logged into Antigravity.").is_none());
    assert_eq!(version("agy version 1.2.11 (darwin)"), Some((1, 2, 11)));
  }

  #[test]
  fn runs_only_the_usage_command() {
    let h = host(vec![ok("1.2.11"), ok(REPLY)]);
    let u = fetch_with(&h, &AtomicBool::new(false));
    assert_eq!((u.status.as_str(), u.buckets.len()), ("ok", 3));
    let runs = h.runs.lock().unwrap();
    assert_eq!(runs[0].1, ["--version"]);
    assert_eq!(runs[1].1, USAGE_ARGS);
    assert!(!runs[1].1.iter().any(|a| a == "--disable-slash-commands"), "that flag turns /usage into a billed prompt");
  }

  #[test]
  fn old_missing_or_signed_out() {
    let h = host(vec![ok("1.1.10")]);
    assert_eq!(fetch_with(&h, &AtomicBool::new(false)).status, "unavailable");
    assert_eq!(h.runs.lock().unwrap().len(), 1, "an old agy is never asked /usage");
    assert_eq!(fetch_with(&FakeHost::new(), &AtomicBool::new(false)).failure_kind.as_deref(), Some("cli-unavailable"));
    let out = Output { code: Some(1), stderr: r#"AGY_ERROR: {"status":"UNAUTHENTICATED"}"#.into(), ..Default::default() };
    assert_eq!(fetch_with(&host(vec![ok("1.2.0"), Ok(out)]), &AtomicBool::new(false)).failure_kind.as_deref(), Some("missing-credentials"));
    assert_eq!(classify(r#"AGY_ERROR: {"error_code":429}"#), Some(("rate-limited", false)));
  }

  #[test]
  fn a_model_turn_stops_further_reads() {
    let turn = r#"{"conversation_id":"c-1","status":"SUCCESS","num_turns":1,"response":"..."}"#;
    assert!(ran_model_turn(turn) && !ran_model_turn(REPLY));
    let latch = AtomicBool::new(false);
    let h = host(vec![ok("1.2.0"), ok(turn)]);
    assert_eq!(fetch_with(&h, &latch).status, "unavailable");
    let again = host(vec![ok("1.2.0"), ok(REPLY)]);
    assert_eq!(fetch_with(&again, &latch).failure_kind.as_deref(), Some("usage-unavailable"));
    assert!(again.runs.lock().unwrap().is_empty(), "latched: agy is not run again");
  }
}
