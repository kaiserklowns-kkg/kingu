//! The vault against a fake home holding one session of each agent (fixtures/).

use super::*;
use read::Tokens;

const CLAUDE_ID: &str = "0b6c1f8e-1111-4c2a-9d1e-000000000001";
const CODEX_ID: &str = "7f3a9c1e-2222-4b8d-8e0f-000000000002";

fn put(path: &Path, text: &str) {
  std::fs::create_dir_all(path.parent().unwrap()).unwrap();
  std::fs::write(path, text).unwrap();
}

/// A home with a session of every agent, and the roots under it.
fn home() -> (tempfile::TempDir, Roots) {
  let dir = tempfile::tempdir().unwrap();
  let h = dir.path();
  put(&h.join(format!(".claude/projects/-w-app/{CLAUDE_ID}.jsonl")), include_str!("fixtures/claude.jsonl"));
  // Not sessions: an old-style sub-agent file, a sub-agent folder, a project's other files.
  put(&h.join(".claude/projects/-w-app/agent-1234.jsonl"), include_str!("fixtures/claude.jsonl"));
  put(&h.join(format!(".claude/projects/-w-app/{CLAUDE_ID}/subagents/agent-1.jsonl")), include_str!("fixtures/claude.jsonl"));
  put(&h.join(format!(".codex/sessions/2026/10/16/rollout-2026-10-16T10-00-00-{CODEX_ID}.jsonl")), include_str!("fixtures/codex.jsonl"));
  let hash = format!("{:x}", Sha256::digest(b"/w/app"));
  put(&h.join(format!(".gemini/tmp/{hash}/chats/session-2026-10-15T08-00-c2d4e6f8.json")), &include_str!("fixtures/gemini.json").replace("PROJECT_HASH", &hash));
  put(&h.join(".gemini/tmp/other/logs.json"), "[]");
  let oc = h.join(".local/share/opencode/storage");
  put(&oc.join("session/proj1/ses_abc.json"), r#"{"id":"ses_abc","projectID":"proj1","directory":"/w/db","title":"Write the migrations","time":{"created":1760000000000,"updated":1760000600000}}"#);
  put(&oc.join("message/ses_abc/msg_1.json"), r#"{"id":"msg_1","sessionID":"ses_abc","role":"user","time":{"created":1760000000000}}"#);
  put(&oc.join("message/ses_abc/msg_2.json"), r#"{"id":"msg_2","sessionID":"ses_abc","role":"assistant","modelID":"claude-haiku-4-5","providerID":"anthropic","time":{"created":1760000300000},"tokens":{"input":2000,"output":300,"reasoning":100,"cache":{"read":400,"write":0}}}"#);
  put(&oc.join("part/msg_1/prt_1.json"), r#"{"id":"prt_1","type":"text","text":"Add the users table migration"}"#);
  put(&oc.join("part/msg_2/prt_1.json"), r#"{"id":"prt_1","type":"text","text":"Created 0001_users.sql"}"#);
  put(&oc.join("part/msg_2/prt_2.json"), r#"{"id":"prt_2","type":"tool","tool":"write","state":{"input":{"path":"0001_users.sql"}}}"#);
  put(&h.join(".cursor/projects/w-app/agent-transcripts/9a8b7c6d.jsonl"), include_str!("fixtures/cursor.jsonl"));
  put(&h.join(".cursor/projects/w-app/canvases/tsconfig.jsonl"), "{}");
  let roots = Roots::new(h, |_| None);
  (dir, roots)
}

fn by_agent(rows: &[VaultSession], a: Agent) -> &VaultSession {
  rows.iter().find(|s| s.agent == a).unwrap_or_else(|| panic!("no {a:?} session"))
}

#[test]
fn lists_one_session_per_agent() {
  let (_h, roots) = home();
  let vault = Vault::default();
  let rows = vault.list(&roots, None, None);
  assert_eq!(rows.len(), 5, "{rows:#?}");

  let c = by_agent(&rows, Agent::Claude);
  assert_eq!((c.title.as_str(), c.cwd.as_deref(), c.branch.as_deref()), ("Login redirect fix", Some("/w/app"), Some("main")));
  assert_eq!(c.model.as_deref(), Some("claude-sonnet-4-5-20250929"));
  assert_eq!(c.resume, Some(vec!["claude".into(), "--resume".into(), CLAUDE_ID.into()]));
  assert_eq!(c.preview.as_deref(), Some("› Fixed: the redirect now keeps the return URL."));
  assert_eq!(c.updated - c.created, 60_000);

  let x = by_agent(&rows, Agent::Codex);
  assert_eq!((x.id.as_str(), x.title.as_str(), x.cwd.as_deref()), (CODEX_ID, "Add rate limiting to the upload endpoint", Some("/w/api")));
  assert_eq!((x.branch.as_deref(), x.model.as_deref()), (Some("feat/rate-limit"), Some("gpt-5-codex")));
  assert_eq!(x.resume.as_ref().unwrap()[..2], ["codex".to_owned(), "resume".to_owned()]);

  let g = by_agent(&rows, Agent::Gemini);
  assert_eq!((g.title.as_str(), g.model.as_deref()), ("Explain the build pipeline", Some("gemini-2.5-pro")));
  assert_eq!(g.cwd.as_deref(), Some("/w/app"), "attributed through the project hash");
  assert_eq!(g.resume.as_ref().unwrap()[2], "c2d4e6f8-3333-4a1b-9c2d-000000000003");

  let o = by_agent(&rows, Agent::OpenCode);
  assert_eq!((o.title.as_str(), o.cwd.as_deref(), o.id.as_str()), ("Write the migrations", Some("/w/db"), "ses_abc"));
  assert_eq!(o.resume, Some(vec!["opencode".into(), "--session".into(), "ses_abc".into()]));

  let u = by_agent(&rows, Agent::Cursor);
  assert_eq!((u.title.as_str(), u.id.as_str(), u.cwd.as_deref()), ("Rename the Settings page", "9a8b7c6d", None));
}

#[test]
fn rows_are_cached_until_the_file_changes() {
  let (_h, roots) = home();
  let vault = Vault::default();
  let rows = vault.list(&roots, Some(&[Agent::Cursor]), None);
  let path = PathBuf::from(&rows[0].path);
  assert_eq!(vault.list(&roots, Some(&[Agent::Cursor]), None), rows);
  std::fs::write(&path, r#"{"role":"user","message":{"content":"A different question, now longer"}}"#).unwrap();
  let again = vault.list(&roots, Some(&[Agent::Cursor]), None);
  assert_eq!(again[0].title, "A different question, now longer");
}

#[test]
fn searches_the_conversation_text() {
  let (_h, roots) = home();
  let vault = Vault::default();
  let rows = vault.list(&roots, None, None);
  let agents_of = |q: &str| {
    let out = vault.search(&rows, q, 50);
    assert_eq!(out.stopped, Stop::Complete);
    let mut a: Vec<Agent> = out.hits.iter().map(|h| rows.iter().find(|r| r.path == h.path).unwrap().agent).collect();
    a.sort();
    (a, out.hits.first().map(|h| h.excerpt.clone()))
  };
  assert_eq!(agents_of("TOKEN BUCKET"), (vec![Agent::Codex], Some("Added a token bucket limiter to POST /upload.".into())));
  assert_eq!(agents_of("vite").0, [Agent::Gemini]);
  assert_eq!(agents_of("users table").0, [Agent::OpenCode]);
  assert_eq!(agents_of("PreferencesPage").0, [Agent::Cursor]);
  assert_eq!(agents_of("return url").0, [Agent::Claude]);
  assert!(agents_of("sidechain chatter").0.is_empty(), "sub-agent records are not the conversation");
  assert!(agents_of("requestId").0.is_empty(), "JSON keys do not match");
  assert_eq!(vault.search(&rows, "  ", 50).hits.len(), 0);
  let limited = vault.search(&rows, "e", 2);
  assert_eq!((limited.hits.len(), limited.stopped), (2, Stop::Limit));
}

#[test]
fn transcripts_are_the_conversation_only() {
  let (_h, roots) = home();
  let rows = Vault::default().list(&roots, None, None);
  let c = by_agent(&rows, Agent::Claude);
  let path = locate(&roots, Agent::Claude, &c.path).unwrap();
  let t = transcript(Agent::Claude, &path);
  let got: Vec<(Role, &str)> = t.turns.iter().map(|t| (t.role, t.text.as_str())).collect();
  assert_eq!(
    got,
    [
      (Role::User, "Fix the login redirect bug"),
      (Role::Assistant, "Looking at auth.ts first."),
      (Role::Tool, "Read: /w/app/src/auth.ts"),
      (Role::Assistant, "Fixed: the redirect now keeps the return URL."),
    ]
  );
  assert!(!t.truncated);
  let o = by_agent(&rows, Agent::OpenCode);
  let t = transcript(Agent::OpenCode, &locate(&roots, Agent::OpenCode, &o.path).unwrap());
  let got: Vec<(Role, &str)> = t.turns.iter().map(|t| (t.role, t.text.as_str())).collect();
  assert_eq!(got, [(Role::User, "Add the users table migration"), (Role::Tool, "write: 0001_users.sql"), (Role::Assistant, "Created 0001_users.sql")]);
}

#[test]
fn only_session_files_can_be_read() {
  let (h, roots) = home();
  let outside = h.path().join("secret.jsonl");
  put(&outside, "{}");
  for (a, p) in [
    (Agent::Claude, outside.display().to_string()),
    (Agent::Claude, "/etc/hosts".into()),
    (Agent::Claude, h.path().join(".claude/projects/-w-app/agent-1234.jsonl").display().to_string()),
    (Agent::Claude, h.path().join(format!(".claude/projects/-w-app/../-w-app/{CLAUDE_ID}.jsonl")).display().to_string()),
    (Agent::Codex, h.path().join(format!(".claude/projects/-w-app/{CLAUDE_ID}.jsonl")).display().to_string()),
    (Agent::Cursor, h.path().join(".cursor/projects/w-app/canvases/tsconfig.jsonl").display().to_string()),
    (Agent::Claude, "relative.jsonl".into()),
  ] {
    assert!(locate(&roots, a, &p).is_err(), "{a:?} {p}");
  }
  #[cfg(unix)]
  {
    let link = h.path().join(".claude/projects/-w-app/link.jsonl");
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    assert!(locate(&roots, Agent::Claude, &link.display().to_string()).is_err(), "a symlink out");
  }
  assert!(locate(&roots, Agent::Claude, &h.path().join(format!(".claude/projects/-w-app/{CLAUDE_ID}.jsonl")).display().to_string()).is_ok());
}

#[test]
fn stats_price_each_agent() {
  let (_h, roots) = home();
  let vault = Vault::default();
  let rows = vault.list(&roots, None, None);
  let s = stats::stats_at(&rows, |r| vault.usage(r), 0, None, 1_800_000_000_000);
  let of = |a: Agent| s.rows.iter().filter(|r| r.agent == a).fold((Tokens::default(), 0.0), |(mut t, c), r| {
    t.add(&r.tokens);
    (t, c + r.cost.unwrap_or(0.0))
  });
  let (claude, claude_cost) = of(Agent::Claude);
  assert_eq!(claude, Tokens { input: 1500, output: 300, cache_read: 5000, cache_write: 800 }, "a split message counts once");
  assert!((claude_cost - 0.0135).abs() < 1e-9);
  let (codex, codex_cost) = of(Agent::Codex);
  assert_eq!(codex, Tokens { input: 6000, output: 1000, cache_read: 14000, cache_write: 0 });
  assert!((codex_cost - 0.01925).abs() < 1e-9);
  assert_eq!(of(Agent::Gemini).0, Tokens { input: 6000, output: 500, cache_read: 3000, cache_write: 0 });
  assert_eq!(of(Agent::OpenCode).0, Tokens { input: 2000, output: 400, cache_read: 400, cache_write: 0 });
  assert_eq!(of(Agent::Cursor).0, Tokens::default());
  assert_eq!((s.sessions_with_usage, s.sessions_total), (4, 5));
  assert!(s.unpriced.is_empty(), "{:?}", s.unpriced);
  assert_eq!(s.rows.iter().find(|r| r.agent == Agent::Claude).unwrap().day, "2026-10-17");
  assert_eq!(s.top[0].agent, Agent::Codex, "the most expensive first");
}

#[test]
fn resume_ids_are_checked() {
  assert_eq!(Agent::Cursor.resume("abc-1_2"), Some(vec!["cursor-agent".into(), "--resume".into(), "abc-1_2".into()]));
  assert_eq!(Agent::Claude.resume("x; rm -rf /"), None);
  assert_eq!(Agent::Claude.resume(""), None);
}

#[test]
fn big_transcripts_stream() {
  let (h, roots) = home();
  let path = h.path().join(".claude/projects/-w-big/big.jsonl");
  let line = r#"{"type":"assistant","timestamp":"2026-10-17T03:00:10.000Z","message":{"id":"m","model":"claude-haiku-4-5","content":[{"type":"text","text":"filler text"}]}}"#;
  let mut text = String::from("{\"type\":\"user\",\"cwd\":\"/w/big\",\"message\":{\"content\":\"Start\"}}\n");
  // ~1.5 MB: more than the list's head and tail together.
  for _ in 0..10_000 {
    text.push_str(line);
    text.push('\n');
  }
  text.push_str("{\"type\":\"user\",\"timestamp\":\"2026-10-18T03:00:10.000Z\",\"message\":{\"content\":\"needle at the end\"}}\n");
  put(&path, &text);
  let vault = Vault::default();
  let rows = vault.list(&roots, Some(&[Agent::Claude]), None);
  let big = rows.iter().find(|r| r.path.ends_with("big.jsonl")).unwrap();
  assert_eq!((big.title.as_str(), big.preview.as_deref()), ("Start", Some("needle at the end")));
  let hits = vault.search(&rows, "needle", 10).hits;
  assert_eq!(hits.len(), 1);
  let t = transcript(Agent::Claude, &locate(&roots, Agent::Claude, &big.path).unwrap());
  assert_eq!(t.turns.len(), MAX_TURNS);
  assert!(t.truncated);
}
