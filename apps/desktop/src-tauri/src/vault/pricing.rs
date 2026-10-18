//! What a million tokens cost, in US dollars, per model family (ported from old Kingu's
//! `kinguPricing.ts`, with Gemini added). A published price list kept by hand, so every cost
//! built on it is an estimate, and a model the table does not know is "unpriced", never $0.
//!
//! The rates are applied to [`Tokens`](super::read::Tokens) as normalized by the parsers (input
//! without cache reads, output with reasoning). Long-context tiers are not applied: they depend on
//! each request's size, which the totals no longer carry, so very long sessions read low.

use super::read::Tokens;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Price {
  pub input: f64,
  pub output: f64,
  pub cache_read: f64,
  pub cache_write: f64,
}

const fn p(input: f64, output: f64, cache_read: f64, cache_write: f64) -> Price {
  Price { input, output, cache_read, cache_write }
}

/// Anthropic. Matched by family: a transcript records whatever the CLI sent
/// (`claude-opus-4-5-20251101`, `anthropic/claude-opus-5`, a `-thinking` suffix).
const CLAUDE: &[(&str, Price)] = &[
  ("fable-5", p(10.0, 50.0, 1.0, 12.5)),
  ("opus-5", p(5.0, 25.0, 0.5, 6.25)),
  ("sonnet-5", p(2.0, 10.0, 0.2, 2.5)),
  ("opus-4-8", p(5.0, 25.0, 0.5, 6.25)),
  ("opus-4-7", p(5.0, 25.0, 0.5, 6.25)),
  ("opus-4-6", p(5.0, 25.0, 0.5, 6.25)),
  ("opus-4-5", p(5.0, 25.0, 0.5, 6.25)),
  ("opus-4-1", p(15.0, 75.0, 1.5, 18.75)),
  ("sonnet-4-6", p(3.0, 15.0, 0.3, 3.75)),
  ("sonnet-4-5", p(3.0, 15.0, 0.3, 3.75)),
  ("sonnet-3-7", p(3.0, 15.0, 0.3, 3.75)),
  ("sonnet-3-5", p(3.0, 15.0, 0.3, 3.75)),
  ("haiku-4-5", p(1.0, 5.0, 0.1, 1.25)),
  ("haiku-3-5", p(0.8, 4.0, 0.08, 1.0)),
  // A base `opus-4` / `sonnet-4` / `haiku-3` (after the point releases, which would match them).
  ("opus-4", p(15.0, 75.0, 1.5, 18.75)),
  ("sonnet-4", p(3.0, 15.0, 0.3, 3.75)),
  ("haiku-3", p(0.25, 1.25, 0.03, 0.3)),
];

/// OpenAI (Codex). OpenAI does not charge for writing the cache.
const OPENAI: &[(&str, Price)] = &[
  ("gpt-5", p(1.25, 10.0, 0.125, 0.0)),
  ("gpt-5-1", p(1.25, 10.0, 0.125, 0.0)),
  ("gpt-5-1-codex", p(1.25, 10.0, 0.125, 0.0)),
  ("gpt-5-1-codex-max", p(1.25, 10.0, 0.125, 0.0)),
  ("gpt-5-1-codex-mini", p(0.25, 2.0, 0.025, 0.0)),
  ("gpt-5-2", p(1.75, 14.0, 0.175, 0.0)),
  ("gpt-5-2-codex", p(1.75, 14.0, 0.175, 0.0)),
  ("gpt-5-3", p(1.75, 14.0, 0.175, 0.0)),
  ("gpt-5-3-codex", p(1.75, 14.0, 0.175, 0.0)),
  ("gpt-5-3-codex-spark", p(1.75, 14.0, 0.175, 0.0)),
  ("gpt-5-4", p(2.5, 15.0, 0.25, 0.0)),
  ("gpt-5-4-mini", p(0.75, 4.5, 0.075, 0.0)),
  ("gpt-5-4-nano", p(0.2, 1.25, 0.02, 0.0)),
  ("gpt-5-4-pro", p(30.0, 180.0, 30.0, 0.0)),
  ("gpt-5-5", p(5.0, 30.0, 0.5, 0.0)),
  ("gpt-5-5-pro", p(30.0, 180.0, 30.0, 0.0)),
  ("gpt-5-6-sol", p(5.0, 30.0, 0.5, 0.0)),
  ("gpt-5-6-terra", p(2.5, 15.0, 0.25, 0.0)),
  ("gpt-5-6-luna", p(1.0, 6.0, 0.1, 0.0)),
  ("gpt-5-mini", p(0.25, 2.0, 0.025, 0.0)),
  ("gpt-5-nano", p(0.05, 0.4, 0.005, 0.0)),
];

/// Google (Gemini CLI), the rates up to 200k of context.
const GEMINI: &[(&str, Price)] = &[
  ("gemini-3-pro", p(2.0, 12.0, 0.2, 0.0)),
  ("gemini-2-5-pro", p(1.25, 10.0, 0.125, 0.0)),
  ("gemini-2-5-flash-lite", p(0.1, 0.4, 0.01, 0.0)),
  ("gemini-2-5-flash", p(0.3, 2.5, 0.03, 0.0)),
  ("gemini-2-0-flash", p(0.1, 0.4, 0.025, 0.0)),
];

/// How hard the model was told to think, which does not change its price.
const REASONING: &[&str] = &["minimal", "low", "medium", "high", "xhigh", "auto", "none"];

fn clean(model: &str) -> String {
  let mut id = model.trim().to_lowercase().replace('.', "-");
  for prefix in ["anthropic/", "anthropic:", "openai/", "openai:", "google/", "google:", "models/"] {
    if let Some(rest) = id.strip_prefix(prefix) {
      id = rest.to_owned();
    }
  }
  id
}

/// `family` appears in `id` followed by the end or a non-digit (`opus-4-1` is not `opus-4-12`).
fn has_family(id: &str, family: &str) -> bool {
  id.match_indices(family).any(|(i, _)| !id[i + family.len()..].starts_with(|c: char| c.is_ascii_digit()))
}

/// The price of `model`, or `None` when no table knows it.
pub fn price(model: &str) -> Option<Price> {
  let id = clean(model);
  if id.contains("claude") || ["opus", "sonnet", "haiku", "fable"].iter().any(|f| id.contains(f)) {
    // Version-first ids that older transcripts still carry.
    let id = id.replace("3-5-sonnet", "sonnet-3-5").replace("3-5-haiku", "haiku-3-5").replace("3-7-sonnet", "sonnet-3-7");
    return CLAUDE.iter().find(|(f, _)| has_family(&id, f)).map(|(_, p)| *p);
  }
  if id.starts_with("gemini") {
    return GEMINI.iter().find(|(f, _)| id == *f || id.starts_with(&format!("{f}-"))).map(|(_, p)| *p);
  }
  if !id.starts_with("gpt-") {
    return None;
  }
  // `gpt-5.5 (medium)` and `gpt-5-codex-high`: the tier is not part of the family.
  let mut id = match id.split_once('(') {
    Some((head, tier)) if REASONING.contains(&tier.trim_end_matches(')').trim()) => head.trim().to_owned(),
    Some(_) => return None,
    None => id,
  };
  while let Some(t) = REASONING.iter().find(|t| id.ends_with(&format!("-{t}"))) {
    id.truncate(id.len() - t.len() - 1);
  }
  let id = match id.as_str() {
    "gpt-5-codex" => "gpt-5".to_owned(),
    "gpt-5-6" => "gpt-5-6-sol".to_owned(),
    _ => id,
  };
  // Longest family first, so `gpt-5-6-terra` is not priced as another `gpt-5-6`.
  let mut families: Vec<&(&str, Price)> = OPENAI.iter().collect();
  families.sort_by_key(|(f, _)| std::cmp::Reverse(f.len()));
  families.into_iter().find(|(f, _)| id == *f || id.starts_with(&format!("{f}-"))).map(|(_, p)| *p)
}

/// The estimated cost of `tokens` on `model`, in US dollars; `None` for an unpriced model.
pub fn cost(model: &str, tokens: &Tokens) -> Option<f64> {
  let p = price(model)?;
  let m = 1_000_000.0;
  Some((tokens.input as f64 * p.input + tokens.output as f64 * p.output + tokens.cache_read as f64 * p.cache_read + tokens.cache_write as f64 * p.cache_write) / m)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn claude_families() {
    assert_eq!(price("claude-opus-4-5-20251101"), Some(p(5.0, 25.0, 0.5, 6.25)));
    assert_eq!(price("anthropic/claude-sonnet-4.5"), Some(p(3.0, 15.0, 0.3, 3.75)));
    assert_eq!(price("claude-opus-4-20250514"), Some(p(15.0, 75.0, 1.5, 18.75)), "base opus-4");
    assert_eq!(price("claude-3-5-haiku-20241022"), Some(p(0.8, 4.0, 0.08, 1.0)));
    assert_eq!(price("claude-opus-4-12"), Some(p(15.0, 75.0, 1.5, 18.75)), "not opus-4-1");
  }

  #[test]
  fn openai_and_gemini() {
    assert_eq!(price("gpt-5-codex").unwrap().input, 1.25);
    assert_eq!(price("gpt-5.6-terra").unwrap().input, 2.5);
    assert_eq!(price("gpt-5.6").unwrap().input, 5.0);
    assert_eq!(price("gpt-5.5 (medium)").unwrap().input, 5.0);
    assert_eq!(price("gpt-5.1-codex-max-high").unwrap().input, 1.25);
    assert_eq!(price("gemini-2.5-flash-lite").unwrap().input, 0.1);
    assert_eq!(price("gemini-2.5-pro-preview-06-05").unwrap().input, 1.25);
    assert_eq!(price("llama-3"), None);
    assert_eq!(price("gpt-5.5 (turbo)"), None);
  }

  #[test]
  fn costs_per_million() {
    let t = Tokens { input: 1_000_000, output: 100_000, cache_read: 2_000_000, cache_write: 0 };
    let c = cost("claude-sonnet-4-5", &t).unwrap();
    assert!((c - (3.0 + 1.5 + 0.6)).abs() < 1e-9);
    assert_eq!(cost("mystery", &t), None);
  }
}
