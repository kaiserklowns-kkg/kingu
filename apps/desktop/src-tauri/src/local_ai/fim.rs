//! Fill-in-the-middle prompts (old Kingu's `kinguCompletions.ts`): the code before the cursor and
//! the code after it, in the tokens the model was trained on, and the completion it gives back
//! cleaned for the editor. Old Kingu knew Qwen's tokens only (Chyle is a Qwen coder); the other
//! families here are the ones local servers commonly run.

/// A model family's FIM format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
  /// Qwen2.5-Coder, Chyle: `<|fim_prefix|>…<|fim_suffix|>…<|fim_middle|>`.
  Qwen,
  /// CodeGemma: Qwen's tokens with its own stop tokens.
  CodeGemma,
  /// DeepSeek-Coder: `<｜fim▁begin｜>…<｜fim▁hole｜>…<｜fim▁end｜>`.
  DeepSeek,
  /// Code Llama: `<PRE> … <SUF>… <MID>`.
  CodeLlama,
  /// StarCoder, StarCoder2, Stable Code, Granite Code: `<fim_prefix>…<fim_suffix>…<fim_middle>`.
  StarCoder,
  /// Codestral: `[SUFFIX]…[PREFIX]…`, the suffix first.
  Codestral,
}

impl Family {
  /// `kingu.completions.fimTemplate`: a family by name, or (`auto`, anything else) by the model's name.
  pub fn resolve(setting: &str, model: &str) -> Family {
    match setting {
      "qwen" => Family::Qwen,
      "codegemma" => Family::CodeGemma,
      "deepseek" => Family::DeepSeek,
      "codellama" => Family::CodeLlama,
      "starcoder" => Family::StarCoder,
      "codestral" => Family::Codestral,
      _ => Family::of_model(model),
    }
  }

  /// The family a model name says it is; Qwen's format when it says nothing (Chyle, Qwen).
  pub fn of_model(model: &str) -> Family {
    let m = model.to_lowercase();
    if m.contains("deepseek") {
      Family::DeepSeek
    } else if m.contains("codellama") || m.contains("code-llama") || m.contains("code_llama") {
      Family::CodeLlama
    } else if m.contains("starcoder") || m.contains("stable-code") || m.contains("granite") {
      Family::StarCoder
    } else if m.contains("codestral") {
      Family::Codestral
    } else if m.contains("codegemma") {
      Family::CodeGemma
    } else {
      Family::Qwen
    }
  }

  pub fn prompt(self, prefix: &str, suffix: &str) -> String {
    match self {
      Family::Qwen | Family::CodeGemma => format!("<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>"),
      Family::DeepSeek => format!("<｜fim▁begin｜>{prefix}<｜fim▁hole｜>{suffix}<｜fim▁end｜>"),
      Family::CodeLlama => format!("<PRE> {prefix} <SUF>{suffix} <MID>"),
      Family::StarCoder => format!("<fim_prefix>{prefix}<fim_suffix>{suffix}<fim_middle>"),
      Family::Codestral => format!("[SUFFIX]{suffix}[PREFIX]{prefix}"),
    }
  }

  /// Where the model stops: the end of its fill, or the start of another file or prompt.
  pub fn stops(self) -> &'static [&'static str] {
    match self {
      Family::Qwen => &["<|endoftext|>", "<|fim_pad|>", "<|file_sep|>", "<|fim_prefix|>", "<|im_end|>"],
      Family::CodeGemma => &["<|file_separator|>", "<|fim_prefix|>", "<|fim_suffix|>", "<|fim_middle|>", "<eos>"],
      Family::DeepSeek => &["<｜end▁of▁sentence｜>", "<｜fim▁begin｜>", "<｜fim▁hole｜>", "<｜fim▁end｜>", "<|EOT|>"],
      Family::CodeLlama => &["<EOT>", "<END>", "<PRE>", "<SUF>", "<MID>"],
      Family::StarCoder => &["<|endoftext|>", "<file_sep>", "<fim_prefix>", "<fim_suffix>", "<fim_middle>"],
      Family::Codestral => &["[PREFIX]", "[SUFFIX]", "</s>"],
    }
  }
}

/// The code read before and after the cursor: what a small model reads quickly, nearest the cursor kept.
pub const MAX_PREFIX_CHARS: usize = 4000;
pub const MAX_SUFFIX_CHARS: usize = 1500;

/// The last `n` characters of `s`.
pub fn tail_chars(s: &str, n: usize) -> &str {
  let count = s.chars().count();
  if count <= n {
    return s;
  }
  let at = s.char_indices().nth(count - n).map_or(0, |(i, _)| i);
  &s[at..]
}

/// The first `n` characters of `s`.
pub fn head_chars(s: &str, n: usize) -> &str {
  s.char_indices().nth(n).map_or(s, |(i, _)| &s[..i])
}

/// The prompt for the text between `prefix` and `suffix`, each cut to the limits above.
pub fn build_prompt(family: Family, prefix: &str, suffix: &str) -> String {
  family.prompt(tail_chars(prefix, MAX_PREFIX_CHARS), head_chars(suffix, MAX_SUFFIX_CHARS))
}

/// Whether the cursor has code before it on its line, where only the rest of that line is wanted.
pub fn is_mid_line(prefix: &str) -> bool {
  prefix.rsplit('\n').next().is_some_and(|line| line.chars().any(|c| !c.is_whitespace()))
}

/// The shortest run a small model loops on that counts as a loop rather than code.
const MIN_REPEAT: usize = 6;
/// Longer replies are not searched for loops (the search is cubic; 64 tokens are far below this).
const MAX_REPEAT_SCAN: usize = 2000;

/// The text up to where it starts repeating itself: a small model that loses the thread writes
/// the same few words again and again until it runs out of tokens (`a + b;  // return a + b;  //
/// return a + b;`). It is cut where the first round of the loop ends a statement, else after
/// that round.
fn drop_repeats(text: &str) -> String {
  let chars: Vec<char> = text.chars().collect();
  if chars.len() > MAX_REPEAT_SCAN {
    return text.to_string();
  }
  let n = chars.len();
  for start in 0..n {
    let mut length = MIN_REPEAT;
    while start + length * 2 <= n {
      let unit = &chars[start..start + length];
      if unit.iter().any(|c| !c.is_whitespace()) && chars[start + length..start + length * 2] == *unit {
        // The first `; } ) ]` in the unit followed by whitespace or the unit's end.
        let statement_end =
          (0..unit.len()).find(|&i| matches!(unit[i], ';' | '}' | ')' | ']') && unit.get(i + 1).is_none_or(|c| c.is_whitespace()));
        let end = statement_end.map_or(start + length, |i| start + i + 1);
        return chars[..end].iter().collect();
      }
      length += 1;
    }
  }
  text.to_string()
}

/// The completion as the editor should show it: stop tokens gone, not repeating the code that
/// already follows the cursor, and nothing when it is only whitespace.
pub fn clean_completion(text: &str, suffix: &str, family: Family) -> Option<String> {
  let mut result = text;
  for stop in family.stops() {
    if let Some(at) = result.find(stop) {
      result = &result[..at];
    }
  }
  let mut result = drop_repeats(result);
  // A model that closes a bracket the file already closes would double it.
  let next_line = suffix.split('\n').next().unwrap_or("").trim();
  if !next_line.is_empty() {
    let trimmed = result.trim_end();
    if let Some(cut) = trimmed.strip_suffix(next_line) {
      result = cut.to_string();
    }
  }
  // Trailing whitespace goes when it ends a line; spaces after a word stay (`value; `).
  let body = result.trim_end();
  if result[body.len()..].contains('\n') {
    result.truncate(body.len());
  }
  if result.trim().is_empty() { None } else { Some(result) }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn asks_for_the_middle_with_the_code_nearest_the_cursor() {
    assert_eq!(
      build_prompt(Family::Qwen, "def add(a, b):\n    ", "\nprint(add(1, 2))"),
      "<|fim_prefix|>def add(a, b):\n    <|fim_suffix|>\nprint(add(1, 2))<|fim_middle|>"
    );
    let long = build_prompt(Family::Qwen, &"x".repeat(5000), &"y".repeat(2000));
    assert!(long.starts_with(&format!("<|fim_prefix|>{}<|fim_suffix|>", "x".repeat(4000))));
    assert!(long.ends_with(&format!("<|fim_suffix|>{}<|fim_middle|>", "y".repeat(1500))));
    // Cut by characters, never inside one.
    assert_eq!(tail_chars("กขค", 2), "ขค");
    assert_eq!(head_chars("กขค", 2), "กข");
  }

  #[test]
  fn formats_each_family() {
    assert_eq!(Family::DeepSeek.prompt("a", "b"), "<｜fim▁begin｜>a<｜fim▁hole｜>b<｜fim▁end｜>");
    assert_eq!(Family::CodeLlama.prompt("a", "b"), "<PRE> a <SUF>b <MID>");
    assert_eq!(Family::StarCoder.prompt("a", "b"), "<fim_prefix>a<fim_suffix>b<fim_middle>");
    assert_eq!(Family::Codestral.prompt("a", "b"), "[SUFFIX]b[PREFIX]a");
    assert_eq!(Family::CodeGemma.prompt("a", "b"), "<|fim_prefix|>a<|fim_suffix|>b<|fim_middle|>");
  }

  #[test]
  fn picks_the_family_from_the_setting_or_the_model_name() {
    let by_name = |m| Family::resolve("auto", m);
    assert_eq!(by_name("qwen2.5-coder:7b"), Family::Qwen);
    assert_eq!(by_name("chyle-1-coder:latest"), Family::Qwen);
    assert_eq!(by_name("deepseek-coder:6.7b-base"), Family::DeepSeek);
    assert_eq!(by_name("codellama:7b-code"), Family::CodeLlama);
    assert_eq!(by_name("starcoder2:3b"), Family::StarCoder);
    assert_eq!(by_name("granite-code:3b"), Family::StarCoder);
    assert_eq!(by_name("codestral:22b"), Family::Codestral);
    assert_eq!(by_name("codegemma:2b"), Family::CodeGemma);
    assert_eq!(Family::resolve("deepseek", "qwen2.5-coder"), Family::DeepSeek);
  }

  #[test]
  fn cleans_what_the_model_gives_back() {
    let clean = |text: &str, suffix: &str| clean_completion(text, suffix, Family::Qwen);
    assert_eq!(clean("return a + b\n<|endoftext|>junk", "\n").as_deref(), Some("return a + b"));
    assert_eq!(clean("  \n", ""), None);
    assert_eq!(clean("foo(bar)", ")").as_deref(), Some("foo(bar"));
    assert_eq!(clean("value; ", "").as_deref(), Some("value; "));
    assert_eq!(clean("a + b;  // return a + b;  // return a + b;  // ret", "\n}").as_deref(), Some("a + b;"));
    assert_eq!(clean("items.map(item => item.id)", "").as_deref(), Some("items.map(item => item.id)"));
    assert_eq!(clean_completion("x = 1 <EOT> y", "", Family::CodeLlama).as_deref(), Some("x = 1 "));
  }

  #[test]
  fn tells_mid_line_from_a_fresh_line() {
    assert!(is_mid_line("function f() {\n\treturn "));
    assert!(!is_mid_line("function f() {\n\t"));
    assert!(!is_mid_line(""));
  }
}
