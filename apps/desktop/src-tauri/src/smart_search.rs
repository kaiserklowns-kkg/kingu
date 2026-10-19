//! Smart search (old Kingu's `kinguSmartSearch.ts`, setting `kingu.search.smart`): a plain Find in
//! Files query finds what it means, not only what it spells — any letter case, the words in any
//! order (up to three), and a name however it is written: `stock ledger` finds `stockLedger`,
//! `stock_ledger`, `StockLedger`, `stock-ledger` and `ledger of stock`. Regex, Match Case and
//! Match Whole Word search exactly, as typed.
//!
//! Replace needs nothing extra: it writes the replacement text literally over the matched text,
//! which ripgrep reported.

use crate::search::SearchOptions;

/// What may join the words of a name: nothing, `_`, `-`, `.` or whitespace.
const NAME_SEPARATOR: &str = r"[\s_\-.]*";

/// More words than this keep the order typed; every order of five would be 120 alternatives.
const MAX_REORDERED_WORDS: usize = 3;

/// The words of a query, with names split where they are joined: `stockLedger`, `stock_ledger`
/// and `stock-ledger` are two words, `HTTPServer` is `HTTP` and `Server`.
pub fn words(query: &str) -> Vec<String> {
  query.split_whitespace().flat_map(|token| split_name(token).into_iter()).collect()
}

/// `token` split at `_ - .` and at case changes (`aB` and `ABc` → `A Bc`).
fn split_name(token: &str) -> Vec<String> {
  let chars: Vec<char> = token.chars().collect();
  let mut out = Vec::new();
  let mut word = String::new();
  for (i, &c) in chars.iter().enumerate() {
    if matches!(c, '_' | '-' | '.') {
      if !word.is_empty() {
        out.push(std::mem::take(&mut word));
      }
      continue;
    }
    if let Some(&prev) = i.checked_sub(1).and_then(|p| chars.get(p)) {
      let lower_to_upper = (prev.is_lowercase() || prev.is_ascii_digit()) && c.is_uppercase();
      // The last capital of a run starts the next word when a lowercase letter follows it.
      let acronym_end = prev.is_uppercase() && c.is_uppercase() && chars.get(i + 1).is_some_and(|n| n.is_lowercase());
      if (lower_to_upper || acronym_end) && !word.is_empty() {
        out.push(std::mem::take(&mut word));
      }
    }
    word.push(c);
  }
  if !word.is_empty() {
    out.push(word);
  }
  out
}

fn permutations(items: &[String]) -> Vec<Vec<String>> {
  if items.len() <= 1 {
    return vec![items.to_vec()];
  }
  (0..items.len())
    .flat_map(|i| {
      let mut rest = items.to_vec();
      let first = rest.remove(i);
      permutations(&rest).into_iter().map(move |mut tail| {
        tail.insert(0, first.clone());
        tail
      })
    })
    .collect()
}

/// A plain query as the regular expression to search with, case-insensitively: the words joined
/// as a name is or farther apart on the same line, in any order for up to three words. `None`
/// when there is nothing to widen (a single word as typed, or no words).
pub fn pattern(query: &str) -> Option<String> {
  let words = words(query);
  match words.as_slice() {
    [] => None,
    [one] if one == query.trim() => None,
    [one] => Some(regex::escape(one)),
    _ => {
      let escaped: Vec<String> = words.iter().map(|w| regex::escape(w)).collect();
      let orders = if escaped.len() <= MAX_REORDERED_WORDS { permutations(&escaped) } else { vec![escaped] };
      let close = orders.iter().map(|o| o.join(NAME_SEPARATOR));
      let apart = orders.iter().map(|o| o.join(".*?"));
      Some(close.chain(apart).collect::<Vec<_>>().join("|"))
    }
  }
}

/// The options ripgrep should run with when `opts` asks for a smart search of a plain query:
/// a case-insensitive regex. `None` leaves the search as it is.
pub fn apply(opts: &SearchOptions) -> Option<SearchOptions> {
  if !opts.smart.unwrap_or(false) || opts.is_regex || opts.match_case || opts.whole_word {
    return None;
  }
  let query = pattern(&opts.query)?;
  Some(SearchOptions { query, is_regex: true, match_case: false, smart_case: Some(false), ..opts.clone() })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn finds(query: &str, text: &str) -> bool {
    match pattern(query) {
      None => text.contains(query),
      Some(p) => regex::RegexBuilder::new(&p).case_insensitive(true).build().unwrap().is_match(text),
    }
  }

  #[test]
  fn splits_names_where_they_are_joined() {
    assert_eq!(words("stockLedger"), ["stock", "Ledger"]);
    assert_eq!(words("stock_ledger check"), ["stock", "ledger", "check"]);
    assert_eq!(words("HTTPServer"), ["HTTP", "Server"]);
    assert_eq!(words("a.b c"), ["a", "b", "c"]);
    assert!(words("  ").is_empty());
  }

  #[test]
  fn finds_a_name_however_it_is_written() {
    assert!(finds("stock ledger", "const stockLedger = 1"));
    assert!(finds("stock ledger", "stock_ledgers table"));
    assert!(finds("StockLedger", "<stock-ledger>"));
    assert!(finds("ledger stock", "the stock ledger"));
    assert!(finds("ledger check", "php artisan inventory:ledger-check"));
    assert!(!finds("stock ledger", "stock only"));
    assert!(finds("a.b c", "a.b and c"));
    assert!(finds("ตรวจสอบ สต็อก", "สต็อก: ตรวจสอบ"));
    assert_eq!(pattern("ledger"), None);
    assert_eq!(pattern(""), None);
  }

  #[test]
  fn keeps_the_typed_order_beyond_three_words() {
    let p = pattern("a b c d").unwrap();
    assert_eq!(p.split('|').count(), 2);
    assert_eq!(pattern("x y").unwrap().split('|').count(), 4);
  }

  #[test]
  fn applies_only_to_plain_queries_with_the_option_on() {
    let plain = SearchOptions { query: "stock ledger".into(), smart: Some(true), ..Default::default() };
    let smart = apply(&plain).unwrap();
    assert!(smart.is_regex && !smart.match_case);
    assert_eq!(smart.smart_case, Some(false));
    assert!(apply(&SearchOptions { smart: None, ..plain.clone() }).is_none());
    assert!(apply(&SearchOptions { is_regex: true, ..plain.clone() }).is_none());
    assert!(apply(&SearchOptions { match_case: true, ..plain.clone() }).is_none());
    assert!(apply(&SearchOptions { whole_word: true, ..plain.clone() }).is_none());
    assert!(apply(&SearchOptions { query: "ledger".into(), ..plain }).is_none());
  }
}
