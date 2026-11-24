//! Every Codex home here is a temp folder handed to the sweep; nothing reads `CODEX_HOME` or the
//! user's own `~/.codex`.

use std::os::unix::fs::{PermissionsExt, symlink};
use std::time::{Duration, SystemTime};

use super::super::{GRACE_MS, now_ms};
use super::*;
use crate::agent::worktree::worktree_path;

const ON: &dyn Fn() -> bool = &|| true;
const NOT_LIVE: &dyn Fn(&str) -> bool = &|_| false;
const A1: &str = "0123456789ab";
const A2: &str = "ba9876543210";

struct Fixture {
  _tmp: tempfile::TempDir,
  base: PathBuf,
  root: PathBuf,
  /// The user's own Codex home.
  own: PathBuf,
  /// `<data>/ai-accounts/codex`.
  accounts: PathBuf,
}

fn codex_home(home: &Path) {
  std::fs::create_dir_all(home.join("sessions")).unwrap();
  std::fs::create_dir_all(home.join(LOCKS_FOLDER)).unwrap();
}

/// A project with `.kingu/worktrees` and tasks.json listing `tasks`, the user's Codex home and an
/// empty accounts folder; every home keeps writer locks.
fn fixture(tasks: &[&str]) -> Fixture {
  let tmp = tempfile::tempdir().unwrap();
  let base = std::fs::canonicalize(tmp.path()).unwrap();
  let (root, own, accounts) = (base.join("proj"), base.join("codex"), base.join("ai-accounts/codex"));
  std::fs::create_dir_all(root.join(".kingu/worktrees")).unwrap();
  let rows: Vec<String> = tasks.iter().map(|s| format!(r#"{{"slug":"{s}","title":"T","base":"main","created_at":5,"status":"done"}}"#)).collect();
  std::fs::write(root.join(".kingu/tasks.json"), format!(r#"{{"version":1,"tasks":[{}]}}"#, rows.join(","))).unwrap();
  codex_home(&own);
  std::fs::create_dir_all(&accounts).unwrap();
  Fixture { _tmp: tmp, base, root, own, accounts }
}

impl Fixture {
  fn account(&self, id: &str) -> PathBuf {
    let home = self.accounts.join(id);
    codex_home(&home);
    home
  }

  fn gone(&self) -> PathBuf {
    worktree_path(&self.root, "gone")
  }

  fn live(&self) -> PathBuf {
    let live = worktree_path(&self.root, "live");
    std::fs::create_dir_all(&live).unwrap();
    live
  }

  fn homes(&self) -> Option<Vec<PathBuf>> {
    codex_homes(&self.own, &self.accounts)
  }

  fn sweep(&self) -> SweepResult {
    sweep_codex(&self.root, &|| self.homes(), &now_ms, ON, NOT_LIVE)
  }
}

fn id(n: u8) -> String {
  format!("{n:08x}-0000-4000-8000-000000000000")
}

fn name(n: u8) -> String {
  format!("rollout-2026-11-01T10-00-00-{}.jsonl", id(n))
}

fn dated(home: &Path) -> PathBuf {
  home.join("sessions/2026/11/01")
}

fn meta(cwd: &Path, extra: Value) -> String {
  let mut payload = serde_json::json!({ "session_id": "s", "id": "thread", "timestamp": "2026-11-01T10:00:00Z", "cwd": cwd, "originator": "codex_cli_rs", "cli_version": "0.156.0" });
  payload.as_object_mut().unwrap().extend(extra.as_object().cloned().unwrap_or_default());
  format!("{}\n", serde_json::json!({ "type": "session_meta", "payload": payload }))
}

/// A Codex rollout: the start folder, one turn per later cwd, then a long reply naming the start
/// folder in a tool call (only `session_meta` and `turn_context` records count).
fn rollout(start: &Path, turns: &[&Path]) -> String {
  let mut text = meta(start, Value::Null);
  for cwd in turns {
    text += &format!("{}\n", serde_json::json!({ "type": "turn_context", "payload": { "cwd": cwd, "model": "gpt" } }));
  }
  text + &format!("{}\n", serde_json::json!({ "type": "event_msg", "payload": { "type": "exec", "cwd": start, "text": "x".repeat(300 * 1024) } }))
}

/// A forked chat: its header names the rollout it reads its earlier turns from.
fn fork(cwd: &Path, parent: &str) -> String {
  meta(cwd, serde_json::json!({ "history_mode": "paginated", "history_base": { "thread_id": parent, "end_ordinal_exclusive": 1, "end_byte_offset": 10 } }))
}

fn pack(text: &str) -> Vec<u8> {
  ruzstd::encoding::compress_to_vec(text.as_bytes(), ruzstd::encoding::CompressionLevel::Fastest)
}

/// Sets a file's time three hours back: past the grace hour and the unfinished-header grace.
fn age(path: &Path) {
  let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
  file.set_modified(SystemTime::now() - Duration::from_millis(3 * GRACE_MS)).unwrap();
}

/// Writes an old file.
fn write(path: PathBuf, contents: impl AsRef<[u8]>) -> PathBuf {
  std::fs::create_dir_all(path.parent().unwrap()).unwrap();
  std::fs::write(&path, contents).unwrap();
  age(&path);
  path
}

/// Dangling links count: they are names too.
fn exists(path: &Path) -> bool {
  std::fs::symlink_metadata(path).is_ok()
}

fn size(path: &Path) -> u64 {
  std::fs::metadata(path).unwrap().len()
}

fn is_root() -> bool {
  // SAFETY: geteuid has no preconditions.
  unsafe { libc::geteuid() == 0 }
}

#[test]
fn deletes_a_rollout_under_every_name_it_has_across_homes() {
  let fx = fixture(&["kept"]);
  let (gone, live) = (fx.gone(), fx.live());
  let (a1, a2) = (fx.account(A1), fx.account(A2));
  // Shared with an account by hard link, packed under another account, archived under the first.
  let shared = write(dated(&fx.own).join(name(1)), rollout(&gone, &[&gone]));
  std::fs::create_dir_all(dated(&a1)).unwrap();
  std::fs::hard_link(&shared, dated(&a1).join(name(1))).unwrap();
  let packed = write(dated(&a2).join(format!("{}.zst", name(1))), pack(&rollout(&gone, &[&gone])));
  let archived = write(a1.join("archived_sessions").join(name(1)), rollout(&gone, &[]));
  let other = write(dated(&fx.own).join(name(2)), rollout(&live, &[&live]));
  let freed = size(&shared) + size(&packed) + size(&archived);

  let got = fx.sweep();
  assert_eq!(got, SweepResult { deleted: 1, failed: 0, freed_bytes: freed });
  assert!(![&shared, &dated(&a1).join(name(1)), &packed, &archived].into_iter().any(|p| exists(p)));
  assert!(other.exists() && dated(&a1).is_dir(), "only names go, never a folder or another chat");
}

#[test]
fn does_nothing_while_the_setting_is_off_and_stops_when_it_is_turned_off() {
  let fx = fixture(&[]);
  let gone = fx.gone();
  let a1 = fx.account(A1);
  let first = write(dated(&fx.own).join(name(1)), rollout(&gone, &[&gone]));
  let linked = dated(&a1).join(name(1));
  std::fs::create_dir_all(dated(&a1)).unwrap();
  std::fs::hard_link(&first, &linked).unwrap();
  let second = write(dated(&fx.own).join(name(2)), rollout(&gone, &[&gone]));
  assert_eq!(sweep_codex(&fx.root, &|| fx.homes(), &now_ms, &|| false, NOT_LIVE), SweepResult::default());
  assert!(first.exists() && linked.exists() && second.exists());
  // Turned off once the first name went: the switch is read before every unlink, so the same
  // rollout's other name stays, and so does the next rollout.
  let got = sweep_codex(&fx.root, &|| fx.homes(), &now_ms, &|| first.exists(), NOT_LIVE);
  assert_eq!((got.deleted, got.freed_bytes), (1, 0), "the file's last link is still there");
  assert!(!first.exists() && linked.exists() && second.exists());
}

#[test]
fn keeps_rollouts_of_workspaces_that_exist_are_listed_or_are_not_kingus() {
  let fx = fixture(&["archived"]);
  let live = fx.live();
  let archived = worktree_path(&fx.root, "archived");
  let nested = live.join("gone");
  let odd = fx.root.join(".kingu/worktrees/Not A Slug");
  let elsewhere = fx.base.join("other/gone");
  let kept: Vec<PathBuf> = [&live, &archived, &fx.root, &nested, &odd, &elsewhere].iter().enumerate().map(|(i, cwd)| write(dated(&fx.own).join(name(i as u8 + 1)), rollout(cwd, &[cwd]))).collect();
  assert_eq!(fx.sweep(), SweepResult::default());
  assert!(kept.iter().all(|p| p.exists()));
}

#[test]
fn keeps_everything_when_kingus_rows_or_the_workspace_parent_prove_nothing() {
  let fx = fixture(&[]);
  let gone = fx.gone();
  let chat = write(dated(&fx.own).join(name(1)), rollout(&gone, &[&gone]));
  std::fs::write(fx.root.join(".kingu/tasks.json"), "{ not json").unwrap();
  assert_eq!(fx.sweep(), SweepResult::default());
  std::fs::write(fx.root.join(".kingu/tasks.json"), r#"{"version":1,"tasks":[]}"#).unwrap();
  // A lookalike sibling, then a checkout where the workspaces should be.
  std::fs::create_dir(fx.root.join(".kingu/worktrees/gone ")).unwrap();
  assert_eq!(fx.sweep(), SweepResult::default());
  std::fs::remove_dir(fx.root.join(".kingu/worktrees/gone ")).unwrap();
  std::fs::create_dir(fx.root.join(".kingu/worktrees/.git")).unwrap();
  assert_eq!(fx.sweep(), SweepResult::default());
  // The whole parent gone (a moved project, an unmounted volume) proves nothing about `gone`.
  std::fs::remove_dir_all(fx.root.join(".kingu/worktrees")).unwrap();
  assert_eq!(fx.sweep(), SweepResult::default());
  assert!(chat.exists());
}

#[test]
fn keeps_a_rollout_written_in_the_last_hour() {
  let fx = fixture(&[]);
  let gone = fx.gone();
  let chat = dated(&fx.own).join(name(1));
  std::fs::create_dir_all(dated(&fx.own)).unwrap();
  std::fs::write(&chat, rollout(&gone, &[&gone])).unwrap();
  assert_eq!(fx.sweep(), SweepResult::default());
  // Its archived copy alone was written just now: every name stays.
  age(&chat);
  let archived = fx.own.join("archived_sessions").join(name(1));
  std::fs::create_dir_all(archived.parent().unwrap()).unwrap();
  std::fs::write(&archived, rollout(&gone, &[&gone])).unwrap();
  assert_eq!(fx.sweep(), SweepResult::default());
  assert!(chat.exists() && archived.exists());
}

#[test]
fn keeps_every_name_when_any_copy_ran_elsewhere() {
  let fx = fixture(&[]);
  let (gone, live) = (fx.gone(), fx.live());
  let a1 = fx.account(A1);
  // Started in the gone workspace, last turn at a live one.
  let resumed = write(dated(&fx.own).join(name(1)), rollout(&gone, &[&gone, &live]));
  // Codex packed the account's copy, breaking the link, and that copy was resumed in `live`.
  let plain = write(dated(&fx.own).join(name(2)), rollout(&gone, &[&gone]));
  let packed = write(dated(&a1).join(format!("{}.zst", name(2))), pack(&rollout(&gone, &[&gone, &live])));
  // A packed rollout in two frames: the later frame holds the turn that ran elsewhere.
  let turn = format!("{}\n", serde_json::json!({ "type": "turn_context", "payload": { "cwd": live } }));
  let framed = write(dated(&fx.own).join(format!("{}.zst", name(3))), [pack(&rollout(&gone, &[&gone])), pack(&turn)].concat());
  // The archived copy records a turn elsewhere.
  let dated_copy = write(dated(&fx.own).join(name(4)), rollout(&gone, &[&gone]));
  let archived = write(fx.own.join("archived_sessions").join(name(4)), rollout(&gone, &[&live]));
  assert_eq!(fx.sweep(), SweepResult::default());
  assert!([&resumed, &plain, &packed, &framed, &dated_copy, &archived].into_iter().all(|p| p.exists()));
}

#[test]
fn deletes_a_packed_rollout_whose_last_turn_was_in_the_gone_folder() {
  let fx = fixture(&[]);
  let gone = fx.gone();
  let packed = write(dated(&fx.own).join(format!("{}.zst", name(1))), pack(&rollout(&gone, &[&gone])));
  let bytes = size(&packed);
  assert_eq!(fx.sweep(), SweepResult { deleted: 1, failed: 0, freed_bytes: bytes });
  assert!(!packed.exists());
}

#[test]
fn keeps_a_rollout_a_codex_has_open() {
  let fx = fixture(&[]);
  let gone = fx.gone();
  let a1 = fx.account(A1);
  // Resumed under an account and still open there, with no turn written yet.
  let open = write(dated(&fx.own).join(name(4)), rollout(&gone, &[&gone]));
  let lock = write(a1.join(LOCKS_FOLDER).join(format!("{}.lock", id(4))), "");
  // A reverted thread's rollout is named by thread id and rollout id: either can be the lock's.
  let reverted = write(dated(&fx.own).join(name(6).replace(".jsonl", &format!("_{}.jsonl", id(7)))), rollout(&gone, &[&gone]));
  let thread_lock = write(fx.own.join(LOCKS_FOLDER).join(format!("{}.lock", id(6))), "");
  assert_eq!(fx.sweep(), SweepResult::default());
  assert!(open.exists() && reverted.exists());
  // A lock that cannot be told absent is a lock.
  std::fs::remove_file(&lock).unwrap();
  std::fs::remove_file(&thread_lock).unwrap();
  if !is_root() {
    std::fs::set_permissions(a1.join(LOCKS_FOLDER), std::fs::Permissions::from_mode(0o000)).unwrap();
    assert_eq!(fx.sweep(), SweepResult::default());
    std::fs::set_permissions(a1.join(LOCKS_FOLDER), std::fs::Permissions::from_mode(0o755)).unwrap();
  }
  // A run of this app holds the session (either id).
  assert_eq!(sweep_codex(&fx.root, &|| fx.homes(), &now_ms, ON, &|session| session == id(4) || session == id(6)), SweepResult::default());
  assert!(open.exists() && reverted.exists());
  assert_eq!(fx.sweep().deleted, 2);
  assert!(!open.exists() && !reverted.exists());
}

#[test]
fn keeps_rollouts_of_a_home_whose_codex_keeps_no_writer_locks() {
  let fx = fixture(&[]);
  let gone = fx.gone();
  let a1 = fx.account(A1);
  // The account's Codex keeps no locks, so nothing proves its chat closed, whatever other homes keep.
  std::fs::remove_dir(a1.join(LOCKS_FOLDER)).unwrap();
  let lockless = write(dated(&a1).join(name(5)), rollout(&gone, &[&gone]));
  // Shared into that home by hard link: one of its names sits where no lock would show.
  let shared = write(dated(&fx.own).join(name(6)), rollout(&gone, &[&gone]));
  std::fs::hard_link(&shared, dated(&a1).join(name(6))).unwrap();
  let locked_home = write(dated(&fx.own).join(name(7)), rollout(&gone, &[&gone]));
  assert_eq!(fx.sweep().deleted, 1);
  assert!(lockless.exists() && shared.exists() && dated(&a1).join(name(6)).exists() && !locked_home.exists());
}

#[test]
fn keeps_a_rollout_while_a_surviving_fork_reads_its_history_and_deletes_it_after_its_forks() {
  let fx = fixture(&[]);
  let (gone, live) = (fx.gone(), fx.live());
  // A fork continued in a live folder reads its earlier turns from the gone folder's parent; Codex
  // skips a header line it cannot parse, and reads one with no newline after it.
  let kept_parent = write(dated(&fx.own).join(name(7)), rollout(&gone, &[&gone]));
  let live_fork = write(dated(&fx.own).join(name(8)), format!("{{\"type\":\"session_meta\",\"payload\":null}}\n{}", fork(&live, &id(7)).trim_end()));
  // Both ran only in the gone folder; the parent is listed first.
  let gone_parent = write(dated(&fx.own).join(name(9)), rollout(&gone, &[&gone]));
  let gone_fork = write(dated(&fx.own).join(name(10)), fork(&gone, &id(9)));
  // A fork that names its parent only as `forked_from_id`, in upper case.
  let named_parent = write(dated(&fx.own).join(name(11)), rollout(&gone, &[&gone]));
  let named_fork = write(dated(&fx.own).join(name(12)), meta(&live, serde_json::json!({ "forked_from_id": id(11).to_uppercase() })));
  let got = fx.sweep();
  assert_eq!((got.deleted, got.failed), (2, 0));
  assert!(kept_parent.exists() && live_fork.exists() && named_parent.exists() && named_fork.exists());
  assert!(!gone_parent.exists() && !gone_fork.exists());
}

#[test]
fn a_chain_of_forks_goes_link_by_link_and_stays_whole_while_its_last_fork_survives() {
  let fx = fixture(&[]);
  let (gone, live) = (fx.gone(), fx.live());
  // 1 <- 2 <- 3, all in the gone folder, parents listed first.
  let gone_chain = [write(dated(&fx.own).join(name(1)), rollout(&gone, &[&gone])), write(dated(&fx.own).join(name(2)), fork(&gone, &id(1))), write(dated(&fx.own).join(name(3)), fork(&gone, &id(2)))];
  // 4 <- 5 <- 6, where only the last fork was continued in a live folder.
  let live_chain = [write(dated(&fx.own).join(name(4)), rollout(&gone, &[&gone])), write(dated(&fx.own).join(name(5)), fork(&gone, &id(4))), write(dated(&fx.own).join(name(6)), fork(&live, &id(5)))];
  // A reverted thread's fork names the thread id, the first of the two ids in its parent's name.
  let reverted = write(dated(&fx.own).join(name(7).replace(".jsonl", &format!("_{}.jsonl", id(8)))), rollout(&gone, &[&gone]));
  let reverted_fork = write(dated(&fx.own).join(name(9)), fork(&live, &id(7)));
  let got = fx.sweep();
  assert_eq!((got.deleted, got.failed), (3, 0));
  assert!(!gone_chain.iter().any(|p| p.exists()));
  assert!(live_chain.iter().all(|p| p.exists()) && reverted.exists() && reverted_fork.exists());
}

#[test]
fn a_fork_in_another_account_home_keeps_its_parent() {
  let fx = fixture(&[]);
  let (gone, live) = (fx.gone(), fx.live());
  let (a1, a2) = (fx.account(A1), fx.account(A2));
  // The fork sits only under an account, archived there.
  let parent = write(dated(&fx.own).join(name(1)), rollout(&gone, &[&gone]));
  let archived_fork = write(a1.join("archived_sessions").join(name(2)), fork(&live, &id(1)));
  // The fork ran in the gone folder too, but an account holds a hard link of it under a name this
  // sweep does not look for: the fork stays, and so does what it reads.
  let linked_parent = write(dated(&fx.own).join(name(3)), rollout(&gone, &[&gone]));
  let linked_fork = write(dated(&fx.own).join(name(4)), fork(&gone, &id(3)));
  let stray = a2.join("sessions/2026/11/02").join(name(4));
  std::fs::create_dir_all(stray.parent().unwrap()).unwrap();
  std::fs::hard_link(&linked_fork, &stray).unwrap();
  // Shared with an account under the same dated name: every name of the fork goes, then its parent.
  let shared_parent = write(dated(&fx.own).join(name(5)), rollout(&gone, &[&gone]));
  let shared_fork = write(dated(&fx.own).join(name(6)), fork(&gone, &id(5)));
  std::fs::create_dir_all(dated(&a2)).unwrap();
  std::fs::hard_link(&shared_fork, dated(&a2).join(name(6))).unwrap();

  let got = fx.sweep();
  assert_eq!((got.deleted, got.failed), (2, 0));
  assert!(parent.exists() && archived_fork.exists());
  assert!(linked_parent.exists() && linked_fork.exists() && stray.exists());
  assert!(!shared_parent.exists() && !shared_fork.exists() && !dated(&a2).join(name(6)).exists());
}

#[test]
fn keeps_a_rollout_hard_linked_somewhere_this_sweep_cannot_see() {
  let fx = fixture(&[]);
  let gone = fx.gone();
  let chat = write(dated(&fx.own).join(name(1)), rollout(&gone, &[&gone]));
  std::fs::create_dir_all(fx.base.join("backup")).unwrap();
  std::fs::hard_link(&chat, fx.base.join("backup/rollout.jsonl")).unwrap();
  assert_eq!(fx.sweep(), SweepResult::default());
  assert!(chat.exists());
}

#[test]
fn keeps_every_rollout_when_the_fork_index_cannot_be_read() {
  if is_root() {
    return;
  }
  let fx = fixture(&[]);
  let gone = fx.gone();
  let a1 = fx.account(A1);
  let chat = write(dated(&fx.own).join(name(1)), rollout(&gone, &[&gone]));
  let blocked = |why: &str| {
    assert_eq!(fx.sweep(), SweepResult::default(), "{why}");
    assert!(chat.exists(), "{why}");
  };
  // A rollout of another home whose header does not read: it may be a fork of anything.
  let unreadable = write(a1.join("archived_sessions").join(name(2)), fork(&fx.live(), &id(1)));
  std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o000)).unwrap();
  blocked("unreadable header");
  std::fs::remove_file(&unreadable).unwrap();
  // A folder of history that does not list.
  let folder = a1.join("sessions/2025/01/01");
  std::fs::create_dir_all(&folder).unwrap();
  std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o000)).unwrap();
  blocked("unreadable folder");
  std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o755)).unwrap();
  // Codex creates a fork's file empty and writes its header seconds later.
  let unfinished = a1.join("sessions/2025/01/01").join(name(3));
  std::fs::write(&unfinished, "").unwrap();
  blocked("header not written yet");
  std::fs::write(&unfinished, fork(&gone, &id(1)).trim_end().split_at(40).0).unwrap();
  blocked("header half written");
  std::fs::remove_file(&unfinished).unwrap();
  // A packed rollout that does not unpack.
  let corrupt = write(a1.join("archived_sessions").join(format!("{}.zst", name(4))), "not zstd");
  blocked("corrupt packed rollout");
  std::fs::remove_file(&corrupt).unwrap();
  // An old rollout with no header never becomes a fork: it blocks nothing.
  let headerless = write(a1.join("archived_sessions").join(name(5)), "");
  assert_eq!(fx.sweep().deleted, 1);
  assert!(!chat.exists() && headerless.exists());
}

#[test]
fn keeps_every_rollout_when_a_home_or_a_history_folder_is_a_link() {
  let fx = fixture(&[]);
  let gone = fx.gone();
  let a1 = fx.account(A1);
  let chat = write(dated(&fx.own).join(name(1)), rollout(&gone, &[&gone]));
  let elsewhere = fx.base.join("elsewhere");
  codex_home(&elsewhere);
  // A fork behind each link: followed, it would be found; unfollowed, nothing is proven.
  write(dated(&elsewhere).join(name(2)), fork(&fx.live(), &id(1)));
  let links = [
    fx.accounts.join(A2),
    a1.join("archived_sessions"),
    a1.join("sessions/2026"),
    fx.own.join("sessions/2026/12"),
    dated(&fx.own).join(name(3)),
    dated(&fx.own).join(format!("{}.zst", name(1))),
  ];
  for link in &links {
    let target = if link.extension().is_some() { dated(&elsewhere).join(name(2)) } else { elsewhere.clone() };
    std::fs::create_dir_all(link.parent().unwrap()).unwrap();
    symlink(&target, link).unwrap();
    assert_eq!(fx.sweep(), SweepResult::default(), "{}", link.display());
    assert!(chat.exists(), "{}", link.display());
    std::fs::remove_file(link).unwrap();
  }
  // The home itself, its history folder, and its writer locks.
  for folder in ["", "sessions", LOCKS_FOLDER] {
    let (path, moved) = (if folder.is_empty() { a1.clone() } else { a1.join(folder) }, fx.base.join("moved"));
    std::fs::rename(&path, &moved).unwrap();
    symlink(&moved, &path).unwrap();
    assert_eq!(fx.homes(), None, "{folder}");
    assert_eq!(fx.sweep(), SweepResult::default(), "{folder}");
    std::fs::remove_file(&path).unwrap();
    std::fs::rename(&moved, &path).unwrap();
  }
  // The user's own home as a link.
  let own_link = fx.base.join("own-link");
  symlink(&fx.own, &own_link).unwrap();
  assert_eq!(codex_homes(&own_link, &fx.accounts), None);
  assert_eq!(sweep_codex(&fx.root, &|| codex_homes(&own_link, &fx.accounts), &now_ms, ON, NOT_LIVE), SweepResult::default());
  // The accounts folder as a link.
  let accounts_link = fx.base.join("accounts-link");
  symlink(&fx.accounts, &accounts_link).unwrap();
  assert_eq!(codex_homes(&fx.own, &accounts_link), None);
  assert!(chat.exists());
  // Nothing in the way any more: the same rollout goes.
  assert_eq!(fx.sweep().deleted, 1);
  assert!(!chat.exists() && dated(&elsewhere).join(name(2)).exists());
}

#[test]
fn keeps_the_parent_when_its_deleted_fork_comes_back() {
  let fx = fixture(&[]);
  let gone = fx.gone();
  let parent = write(dated(&fx.own).join(name(1)), rollout(&gone, &[&gone]));
  let fork_path = dated(&fx.own).join(name(2));
  write(fork_path.clone(), fork(&gone, &id(1)));
  let restored = std::cell::Cell::new(false);
  // A backup restores the fork, as it was, after it was deleted and before the parent is retried.
  let enabled = || {
    if !fork_path.exists() && !restored.get() {
      write(fork_path.clone(), fork(&gone, &id(1)));
      restored.set(true);
    }
    true
  };
  let got = sweep_codex(&fx.root, &|| fx.homes(), &now_ms, &enabled, NOT_LIVE);
  assert!(restored.get());
  assert_eq!(got.deleted, 1);
  assert!(parent.exists() && fork_path.exists());
}

#[test]
fn keeps_the_parent_of_a_fork_created_and_archived_during_the_sweep() {
  let fx = fixture(&[]);
  let gone = fx.gone();
  let first = write(dated(&fx.own).join(name(1)), rollout(&gone, &[&gone]));
  let parent = write(dated(&fx.own).join(name(2)), rollout(&gone, &[&gone]));
  let archived = fx.own.join("archived_sessions").join(name(3));
  // Once the first rollout went (the index is built by then), Codex forks the parent and the user
  // archives the fork.
  let enabled = || {
    if !first.exists() && !archived.exists() {
      write(archived.clone(), fork(&gone, &id(2)));
    }
    true
  };
  let got = sweep_codex(&fx.root, &|| fx.homes(), &now_ms, &enabled, NOT_LIVE);
  assert_eq!(got.deleted, 1);
  assert!(!first.exists() && parent.exists() && archived.exists());
}

#[test]
fn keeps_everything_once_the_homes_cannot_be_listed() {
  let fx = fixture(&[]);
  let gone = fx.gone();
  let first = write(dated(&fx.own).join(name(1)), rollout(&gone, &[&gone]));
  let second = write(dated(&fx.own).join(name(2)), rollout(&gone, &[&gone]));
  assert_eq!(sweep_codex(&fx.root, &|| None, &now_ms, ON, NOT_LIVE), SweepResult::default());
  // An account folder turned into a link while the sweep ran: the rest stays.
  let got = sweep_codex(&fx.root, &|| if first.exists() { fx.homes() } else { None }, &now_ms, ON, NOT_LIVE);
  assert_eq!(got.deleted, 1);
  assert!(!first.exists() && second.exists());
}

#[test]
fn never_touches_rollouts_outside_the_dated_layout_or_other_files() {
  let fx = fixture(&[]);
  let gone = fx.gone();
  // Archived only, not a rollout name, a folder named like a rollout, and a name that is a folder.
  let archived = write(fx.own.join("archived_sessions").join(name(1)), rollout(&gone, &[&gone]));
  let notes = write(dated(&fx.own).join("notes.jsonl"), rollout(&gone, &[&gone]));
  let short_id = write(dated(&fx.own).join("rollout-2026-11-01T10-00-00-1234.jsonl"), rollout(&gone, &[&gone]));
  let undated = write(fx.own.join("sessions").join(name(2)), rollout(&gone, &[&gone]));
  let folder = dated(&fx.own).join(name(3));
  std::fs::create_dir_all(&folder).unwrap();
  // A real chat whose archived name is a folder: that name cannot be told a file, so all stay.
  let chat = write(dated(&fx.own).join(name(4)), rollout(&gone, &[&gone]));
  std::fs::create_dir_all(fx.own.join("archived_sessions").join(name(4))).unwrap();
  assert_eq!(fx.sweep(), SweepResult::default());
  assert!([&archived, &notes, &short_id, &undated, &folder, &chat].into_iter().all(|p| p.exists()));
}

#[test]
fn lists_each_codex_home_once_and_only_account_folders() {
  let fx = fixture(&[]);
  let a1 = fx.account(A1);
  std::fs::create_dir_all(fx.accounts.join("not-an-account")).unwrap();
  std::fs::write(fx.accounts.join(".DS_Store"), "").unwrap();
  std::fs::write(fx.accounts.join(A2), "a file").unwrap();
  assert_eq!(fx.homes(), Some(vec![fx.own.clone(), a1.clone()]));
  // Kingu's own CODEX_HOME can be an account folder: listed once.
  assert_eq!(codex_homes(&a1, &fx.accounts), Some(vec![a1.clone()]));
  // No home yet, and no accounts folder: nothing to read, nothing wrong.
  assert_eq!(codex_homes(&fx.base.join("none"), &fx.base.join("none")), Some(Vec::new()));
  assert_eq!(codex_homes(Path::new("relative"), &fx.accounts), None);
  // A home whose history folder is a file proves nothing.
  std::fs::write(a1.join("archived_sessions"), "").unwrap();
  assert_eq!(fx.homes(), None);
}

#[test]
fn parses_rollout_names() {
  let plain = parse_rollout_name(&name(1)).unwrap();
  assert_eq!((plain.plain.as_str(), plain.ids.as_slice(), plain.packed), (name(1).as_str(), [id(1)].as_slice(), false));
  let packed = parse_rollout_name(&format!("{}.zst", name(1))).unwrap();
  assert_eq!((packed.plain, packed.packed), (name(1), true));
  let reverted = parse_rollout_name(&format!("rollout-2026-11-01T10-00-00-{}_{}.jsonl", id(1).to_uppercase(), id(2))).unwrap();
  assert_eq!(reverted.ids, [id(1), id(2)]);
  for bad in ["rollout-2026-11-01T10-00-00-1234.jsonl", "rollout-2026-11-01-10-00-00-00000001-0000-4000-8000-000000000000.jsonl", "notes.jsonl", "rollout-2026-11-01T10-00-00-00000001-0000-4000-8000-000000000000.json", "rollout-ก.jsonl"] {
    assert_eq!(parse_rollout_name(bad), None, "{bad}");
  }
  assert_eq!(parse_rollout_name(&format!("rollout-2026-11-01T10-00-00-{}_{}_{}.jsonl", id(1), id(2), id(3))), None);
}

#[test]
fn reads_what_a_header_settles() {
  let tmp = tempfile::tempdir().unwrap();
  let path = tmp.path().join("r.jsonl");
  let header = |text: &str| {
    std::fs::write(&path, text).unwrap();
    read_header(&path, false)
  };
  let cwd = Path::new("/w");
  assert_eq!(header(&meta(cwd, Value::Null)), Header::Settled(Vec::new()));
  assert_eq!(header(&fork(cwd, "ABCDEF01-0000-4000-8000-000000000000")), Header::Settled(vec!["abcdef01-0000-4000-8000-000000000000".into()]));
  // A header Codex would skip (a field missing) settles nothing; the first response does.
  let partial = "{\"type\":\"session_meta\",\"payload\":{\"id\":\"t\",\"cwd\":\"/w\"}}\n";
  let response = "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\"}}\n";
  assert_eq!(header(&format!("{partial}{response}{}", fork(cwd, &id(1)))), Header::Settled(Vec::new()));
  // Finished lines without a header never become a fork; a line still being written might.
  assert_eq!(header(partial), Header::Settled(Vec::new()));
  assert_eq!(header(&format!("{partial}{{\"type\":\"session_me")), Header::Unsettled);
  assert_eq!(header(""), Header::Unsettled);
  assert_eq!(header("{\"type\":\"session_me"), Header::Unsettled);
  // A header past the first read, after a long line.
  let long = format!("{}\n", serde_json::json!({ "type": "event_msg", "payload": { "text": "x".repeat(HEAD_BYTES * 2) } }));
  assert_eq!(header(&format!("{long}{}", fork(cwd, &id(1)))), Header::Settled(vec![id(1)]));
  // Packed, in two frames; and one that does not unpack.
  let packed = tmp.path().join("r.jsonl.zst");
  std::fs::write(&packed, [pack(partial), pack(&fork(cwd, &id(2)))].concat()).unwrap();
  assert_eq!(read_header(&packed, true), Header::Settled(vec![id(2)]));
  std::fs::write(&packed, "junk").unwrap();
  assert_eq!(read_header(&packed, true), Header::Failed);
  assert_eq!(read_header(&tmp.path().join("missing.jsonl"), false), Header::Failed);
}

#[test]
fn measures_codex_history_once_per_file_without_following_links() {
  let fx = fixture(&[]);
  let a1 = fx.account(A1);
  let live = fx.live();
  let shared = write(dated(&fx.own).join(name(1)), rollout(&live, &[&live]));
  std::fs::create_dir_all(dated(&a1)).unwrap();
  std::fs::hard_link(&shared, dated(&a1).join(name(1))).unwrap();
  let packed = write(a1.join("archived_sessions").join(format!("{}.zst", name(2))), pack(&rollout(&live, &[])));
  write(dated(&fx.own).join("notes.txt"), "x".repeat(100_000));
  let outside = write(fx.base.join("outside").join(name(3)), rollout(&live, &[]));
  symlink(&outside, dated(&fx.own).join(name(3))).unwrap();
  symlink(fx.base.join("outside"), fx.own.join("sessions/linked")).unwrap();
  let blocks = |p: &Path| std::fs::metadata(p).unwrap().blocks() * 512;
  let homes = usage_homes(&fx.own, &fx.accounts);
  assert_eq!(homes, [fx.own.clone(), a1.clone()]);
  assert_eq!(history_usage(&homes, USAGE_MAX_ENTRIES, USAGE_BUDGET), CodexHistoryUsage { bytes: blocks(&shared) + blocks(&packed), rollouts: 2, complete: true });
  // Past the entry budget the total is a lower bound.
  assert!(!history_usage(&homes, 1, USAGE_BUDGET).complete);
  // No Codex at all: nothing, and nothing missing.
  assert_eq!(history_usage(&[fx.base.join("none")], USAGE_MAX_ENTRIES, USAGE_BUDGET), CodexHistoryUsage { bytes: 0, rollouts: 0, complete: true });
}
