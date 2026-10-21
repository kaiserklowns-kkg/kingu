//! A shell command line split into the sub-commands `chat.tools.terminal.autoApprove` judges one by
//! one (VS Code reads them with the bash tree-sitter grammar; this is a hand-written reader of the
//! same shapes). `a && b || c; d | e & f` are six sub-commands; `( … )` subshells, `{ …; }`
//! groups, `$( … )`, backticks and `<( … )` / `>( … )` add the commands inside them, and the outer
//! command keeps their text (`echo $(rm x)` is `echo $(rm x)` and `rm x`). Redirections are left
//! out of a sub-command's text, like tree-sitter's `command` node.
//!
//! What it cannot read safely fails closed (`unanalyzable`: never auto-approved, the user is asked):
//! a shell-state change (`X=1` on its own, `export`, `declare`, `alias`, …), loops and function
//! definitions, here-documents, an unterminated quote or bracket, and a substitution inside
//! `${…}` or `$((…))`. An output redirection to a file (`> out.txt`; not `2>&1` or `/dev/null`)
//! is `writes_file`, which blocks auto-approval too (VS Code's file write detection).

/// The sub-commands of a command line and what makes it unsafe to auto-approve.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Parsed {
  pub sub_commands: Vec<String>,
  /// Why the line cannot be judged sub-command by sub-command, if it cannot.
  pub unanalyzable: Option<&'static str>,
  /// An output redirection to a file (not a descriptor or a /dev/ stream).
  pub writes_file: bool,
}

/// Words that open or close a compound command: dropped from the front of a sub-command.
const RESERVED: &[&str] = &["!", "{", "}", "then", "do", "else", "elif", "if", "while", "until", "fi", "done", "esac", "time"];
/// Compound commands whose words are not commands (`for x in a b`), and function definitions.
const COMPOUND: &[&str] = &["for", "case", "select", "function", "coproc"];
/// Builtins that change the shell's state for what follows (tree-sitter's `declaration_command`, and kin).
const STATE: &[&str] = &["export", "declare", "typeset", "local", "readonly", "unset", "alias", "unalias", "set", "shopt", "trap", "enable"];
/// Where output may go without writing a file.
const SAFE_TARGETS: &[&str] = &["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"];

/// How deep `$(…)` and subshells may nest before the line is refused.
const MAX_DEPTH: usize = 32;

/// Splits `line` (see the module comment).
pub fn parse(line: &str) -> Parsed {
  let chars: Vec<char> = line.chars().collect();
  let mut r = Reader { chars: &chars, i: 0, out: Parsed::default() };
  r.list(End::Eof, 0);
  for cmd in std::mem::take(&mut r.out.sub_commands) {
    if let Some(cmd) = r.tidy(&cmd) {
      r.out.sub_commands.push(cmd);
    }
  }
  r.out
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum End {
  Eof,
  Paren,
  Backtick,
}

struct Reader<'a> {
  chars: &'a [char],
  i: usize,
  out: Parsed,
}

fn is_assignment(word: &str) -> bool {
  let Some(eq) = word.find('=') else { return false };
  let name = &word[..eq];
  let name = name.strip_suffix('+').unwrap_or(name);
  let mut c = name.chars();
  matches!(c.next(), Some(ch) if ch.is_ascii_alphabetic() || ch == '_') && c.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

impl Reader<'_> {
  fn peek(&self, off: usize) -> Option<char> {
    self.chars.get(self.i + off).copied()
  }

  fn fail(&mut self, why: &'static str) {
    self.out.unanalyzable.get_or_insert(why);
  }

  /// Commands up to `end` (consumed; false when the text ended first); each finished one goes
  /// to `out.sub_commands`.
  fn list(&mut self, end: End, depth: usize) -> bool {
    if depth > MAX_DEPTH {
      self.fail("nested too deeply");
      self.i = self.chars.len();
      return false;
    }
    let mut closed = end == End::Eof;
    let mut cur = String::new();
    loop {
      let Some(c) = self.peek(0) else {
        if end != End::Eof {
          self.fail("unterminated substitution or subshell");
        }
        break;
      };
      match c {
        ')' if end == End::Paren => {
          self.i += 1;
          closed = true;
          break;
        }
        '`' if end == End::Backtick => {
          self.i += 1;
          closed = true;
          break;
        }
        ')' => {
          self.fail("unbalanced parenthesis");
          self.i += 1;
        }
        '\n' | ';' => {
          self.i += 1;
          // `;;` ends a case branch: `case` itself already failed.
          self.push(&mut cur);
        }
        '|' => {
          self.i += if matches!(self.peek(1), Some('|') | Some('&')) { 2 } else { 1 };
          self.push(&mut cur);
        }
        '&' if self.peek(1) == Some('>') => self.redirect(&mut cur),
        '&' => {
          self.i += if self.peek(1) == Some('&') { 2 } else { 1 };
          self.push(&mut cur);
        }
        '(' if cur.trim().is_empty() || cur.trim_end().ends_with('!') => {
          // A subshell (or `((…))` arithmetic, whose words are not commands).
          if self.peek(1) == Some('(') {
            self.fail("arithmetic command");
          }
          self.i += 1;
          self.list(End::Paren, depth + 1);
          cur.clear();
        }
        '(' => {
          // `name() { … }` defines a function; anything else is a syntax error.
          self.fail("function definition or stray parenthesis");
          self.i += 1;
        }
        '#' if cur.is_empty() || cur.ends_with(char::is_whitespace) => {
          while self.peek(0).is_some_and(|c| c != '\n') {
            self.i += 1;
          }
        }
        '<' | '>' => {
          if self.peek(1) == Some('(') {
            // Process substitution: its command runs too.
            cur.push(c);
            cur.push('(');
            self.i += 2;
            self.nested(&mut cur, End::Paren, depth);
            cur.push(')');
          } else {
            self.redirect(&mut cur);
          }
        }
        _ => {
          self.word_char(&mut cur, depth);
        }
      }
    }
    self.push(&mut cur);
    closed
  }

  /// One character of a word (quotes, escapes and expansions read whole), appended to `cur`.
  fn word_char(&mut self, cur: &mut String, depth: usize) {
    let c = self.chars[self.i];
    match c {
      '\'' => {
        cur.push(c);
        self.i += 1;
        loop {
          match self.peek(0) {
            None => return self.fail("unterminated quote"),
            Some('\'') => {
              cur.push('\'');
              self.i += 1;
              return;
            }
            Some(ch) => {
              cur.push(ch);
              self.i += 1;
            }
          }
        }
      }
      '"' => {
        cur.push(c);
        self.i += 1;
        loop {
          match self.peek(0) {
            None => return self.fail("unterminated quote"),
            Some('"') => {
              cur.push('"');
              self.i += 1;
              return;
            }
            Some('\\') => {
              cur.push('\\');
              self.i += 1;
              if let Some(ch) = self.peek(0) {
                cur.push(ch);
                self.i += 1;
              }
            }
            Some('$') | Some('`') => self.dollar_or_backtick(cur, depth),
            Some(ch) => {
              cur.push(ch);
              self.i += 1;
            }
          }
        }
      }
      '\\' => {
        self.i += 1;
        match self.peek(0) {
          // A line continuation joins the lines.
          Some('\n') => self.i += 1,
          Some(ch) => {
            cur.push('\\');
            cur.push(ch);
            self.i += 1;
          }
          None => cur.push('\\'),
        }
      }
      '$' | '`' => self.dollar_or_backtick(cur, depth),
      _ => {
        cur.push(c);
        self.i += 1;
      }
    }
  }

  /// `$(…)`, `` `…` ``, `$((…))`, `${…}` or a plain `$`.
  fn dollar_or_backtick(&mut self, cur: &mut String, depth: usize) {
    if self.chars[self.i] == '`' {
      cur.push('`');
      self.i += 1;
      self.nested(cur, End::Backtick, depth);
      cur.push('`');
      return;
    }
    match (self.peek(1), self.peek(2)) {
      (Some('('), Some('(')) => {
        let text = self.balanced('(', ')', 1);
        if text.contains("$(") || text.contains('`') {
          self.fail("command substitution inside arithmetic");
        }
        cur.push('$');
        cur.push_str(&text);
      }
      (Some('('), _) => {
        cur.push_str("$(");
        self.i += 2;
        self.nested(cur, End::Paren, depth);
        cur.push(')');
      }
      (Some('{'), _) => {
        let text = self.balanced('{', '}', 1);
        if text.contains("$(") || text.contains('`') {
          self.fail("command substitution inside a parameter expansion");
        }
        cur.push('$');
        cur.push_str(&text);
      }
      _ => {
        cur.push('$');
        self.i += 1;
      }
    }
  }

  /// The text of `open … close` starting at `self.i + skip` (nesting counted), consumed.
  fn balanced(&mut self, open: char, close: char, skip: usize) -> String {
    self.i += skip;
    let start = self.i;
    let mut depth = 0usize;
    while let Some(c) = self.peek(0) {
      self.i += 1;
      if c == open {
        depth += 1;
      } else if c == close {
        depth -= 1;
        if depth == 0 {
          return self.chars[start..self.i].iter().collect();
        }
      }
    }
    self.fail("unterminated expansion");
    self.chars[start..].iter().collect()
  }

  /// The commands inside a substitution: their text is appended to `cur` as written.
  fn nested(&mut self, cur: &mut String, end: End, depth: usize) {
    let start = self.i;
    let closed = self.list(end, depth + 1);
    let stop = if closed { self.i - 1 } else { self.i };
    cur.extend(&self.chars[start..stop.max(start)]);
  }

  /// A redirection at `self.i` (`>`, `>>`, `>|`, `&>`, `>&`, `<`, `<>`, `<<<`, `<<`): left out of
  /// the command's text; a file it writes sets `writes_file`.
  fn redirect(&mut self, cur: &mut String) {
    // A descriptor number right before it (`2>`) belongs to it.
    let trimmed = cur.trim_end_matches(|c: char| c.is_ascii_digit());
    if trimmed.len() < cur.len() && (trimmed.is_empty() || trimmed.ends_with(char::is_whitespace)) {
      cur.truncate(trimmed.len());
    }
    let mut op = String::new();
    while let Some(c) = self.peek(0) {
      if matches!(c, '<' | '>' | '&' | '|') && op.len() < 3 {
        op.push(c);
        self.i += 1;
      } else {
        break;
      }
    }
    if op.starts_with("<<") && op != "<<<" {
      self.fail("here-document");
    }
    while self.peek(0).is_some_and(|c| c == ' ' || c == '\t') {
      self.i += 1;
    }
    let mut target = String::new();
    while let Some(c) = self.peek(0) {
      if c.is_whitespace() || matches!(c, ';' | '|' | '&' | '<' | '>' | ')' | '(') && !(target.is_empty() && c == '&') {
        break;
      }
      self.word_char(&mut target, 0);
    }
    let writes = op.contains('>');
    // `>&2`, `2>&1`, `>&-`: another descriptor, not a file.
    let dup = op.ends_with('&') && (target.chars().all(|c| c.is_ascii_digit()) || target == "-");
    let unquoted = target.trim_matches(|c| c == '"' || c == '\'');
    if writes && !dup && !SAFE_TARGETS.contains(&unquoted) {
      self.out.writes_file = true;
    }
    if target.is_empty() && op != "&>" {
      self.fail("redirection without a target");
    }
    if !cur.is_empty() && !cur.ends_with(' ') {
      cur.push(' ');
    }
  }

  fn push(&mut self, cur: &mut String) {
    let text = cur.trim();
    if !text.is_empty() {
      self.out.sub_commands.push(text.to_owned());
    }
    cur.clear();
  }

  /// A raw sub-command as rules see it: compound-command words dropped, spaces left by
  /// redirections collapsed; None when nothing is left. Shell-state changes fail the line.
  fn tidy(&mut self, cmd: &str) -> Option<String> {
    let mut rest = cmd.trim();
    loop {
      let (first, tail) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
      if RESERVED.contains(&first) {
        rest = tail.trim_start();
        continue;
      }
      if COMPOUND.contains(&first) {
        self.fail("loop, case or function definition");
        return None;
      }
      if STATE.contains(&first) {
        self.fail("shell state change");
        return None;
      }
      break;
    }
    if rest.is_empty() {
      return None;
    }
    // Only assignments: a variable of the shell itself (`X=1` on its own).
    if rest.split_whitespace().all(is_assignment) {
      self.fail("variable assignment");
      return None;
    }
    let mut out = String::with_capacity(rest.len());
    let mut quote: Option<char> = None;
    let mut prev_space = false;
    let mut escaped = false;
    for c in rest.chars() {
      if escaped {
        escaped = false;
      } else if c == '\\' && quote != Some('\'') {
        escaped = true;
      } else if quote == Some(c) {
        quote = None;
      } else if quote.is_none() && (c == '\'' || c == '"') {
        quote = Some(c);
      } else if quote.is_none() && (c == ' ' || c == '\t') {
        // Several spaces outside quotes (left where a redirection was) become one.
        if prev_space {
          continue;
        }
        prev_space = true;
        out.push(' ');
        continue;
      }
      prev_space = false;
      out.push(c);
    }
    let out = out.trim().to_owned();
    (!out.is_empty()).then_some(out)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn subs(line: &str) -> Vec<String> {
    let p = parse(line);
    assert_eq!(p.unanalyzable, None, "{line}: {:?}", p.unanalyzable);
    p.sub_commands
  }

  #[test]
  fn operators_split_sub_commands() {
    assert_eq!(subs("ls -la"), ["ls -la"]);
    assert_eq!(subs("a && b || c; d | e & f"), ["a", "b", "c", "d", "e", "f"]);
    assert_eq!(subs("a|&b\nc"), ["a", "b", "c"]);
    assert_eq!(subs("  npm   test  "), ["npm test"]);
    assert_eq!(subs("a;;b"), ["a", "b"]);
    assert!(subs("").is_empty());
    assert!(subs("   ").is_empty());
  }

  #[test]
  fn quotes_keep_operators_and_spaces() {
    assert_eq!(subs(r#"echo "a && b" 'c; d'"#), [r#"echo "a && b" 'c; d'"#]);
    assert_eq!(subs(r#"echo "x  y""#), [r#"echo "x  y""#]);
    assert_eq!(subs(r"echo a\;b"), [r"echo a\;b"]);
    assert_eq!(subs("echo a \\\n b"), ["echo a b"]);
    assert_eq!(subs(r#"grep "\"x\" && y" f"#), [r#"grep "\"x\" && y" f"#]);
  }

  #[test]
  fn substitutions_add_their_commands() {
    assert_eq!(subs("echo $(rm -rf x)"), ["rm -rf x", "echo $(rm -rf x)"]);
    assert_eq!(subs("echo `whoami`"), ["whoami", "echo `whoami`"]);
    assert_eq!(subs(r#"echo "today: $(date)""#), ["date", r#"echo "today: $(date)""#]);
    assert_eq!(subs("diff <(ls a) <(ls b)"), ["ls a", "ls b", "diff <(ls a) <(ls b)"]);
    assert_eq!(subs("tee >(wc -l)"), ["wc -l", "tee >(wc -l)"]);
    assert_eq!(subs("echo $(cat $(ls))"), ["ls", "cat $(ls)", "echo $(cat $(ls))"]);
    assert_eq!(subs("echo $HOME ${USER:-me} $((1 + 2))"), ["echo $HOME ${USER:-me} $((1 + 2))"]);
  }

  #[test]
  fn subshells_and_groups_are_flattened() {
    assert_eq!(subs("(cd x && make)"), ["cd x", "make"]);
    assert_eq!(subs("{ ls; pwd; }"), ["ls", "pwd"]);
    assert_eq!(subs("! grep -q x f"), ["grep -q x f"]);
    assert_eq!(subs("if test -f a; then cat a; else echo no; fi"), ["test -f a", "cat a", "echo no"]);
    assert_eq!(subs("while true; do sleep 1; done"), ["true", "sleep 1"]);
  }

  #[test]
  fn redirections_are_left_out() {
    assert_eq!(subs("ls 2>&1"), ["ls"]);
    assert_eq!(subs("ls >/dev/null 2>&1 | wc -l"), ["ls", "wc -l"]);
    assert_eq!(subs("sort < in.txt"), ["sort"]);
    assert_eq!(subs("cat <<< 'x'"), ["cat"]);
    assert!(!parse("ls 2>/dev/null").writes_file);
    assert!(!parse("ls &>/dev/null").writes_file);
    assert!(!parse("echo x >&2").writes_file);
    let p = parse("echo hi > out.txt");
    assert!(p.writes_file);
    assert_eq!(p.sub_commands, ["echo hi"]);
    assert!(parse("echo hi >> log").writes_file);
    assert!(parse("ls &> all.log").writes_file);
    assert!(parse("ls 2> err").writes_file);
    assert!(parse("echo x >| f").writes_file);
  }

  #[test]
  fn comments_end_at_the_line() {
    assert_eq!(subs("ls # && rm -rf /\npwd"), ["ls", "pwd"]);
    assert_eq!(subs("echo a#b"), ["echo a#b"]);
  }

  #[test]
  fn shell_state_and_odd_syntax_fail_closed() {
    for line in [
      "X=1",
      "X=1; ls",
      "export PATH=/evil:$PATH",
      "declare -x A=b",
      "alias ls='rm -rf'",
      "for f in *; do rm $f; done",
      "case $x in a) ls;; esac",
      "f() { rm -rf /; }; f",
      "function f { ls; }",
      "cat <<EOF\nrm -rf /\nEOF",
      "echo 'unterminated",
      "echo \"unterminated",
      "echo $(ls",
      "echo `ls",
      "ls )",
      "echo ${x:-$(rm -rf /)}",
      "echo $(( $(rm x) ))",
      "(( i++ ))",
    ] {
      assert!(parse(line).unanalyzable.is_some(), "{line}");
    }
    // A prefix assignment is a command (judged by the rules, which deny it).
    assert_eq!(subs("FOO=1 ls"), ["FOO=1 ls"]);
  }

  #[test]
  fn deep_nesting_is_refused() {
    let line = format!("{}ls{}", "$(".repeat(40), ")".repeat(40));
    assert!(parse(&line).unanalyzable.is_some());
  }
}
