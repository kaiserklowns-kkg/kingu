//! `kingu-ptyd snap-exec` under the real `sandbox-exec` (macOS only): network, writes, reads,
//! git and the environment. Only a local listener is used, never the internet.
#![cfg(target_os = "macos")]

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn available() -> bool {
  Path::new(kingu_ptyd::sandbox::SANDBOX_EXEC).is_file()
}

fn snap_exec(network: bool, fs: &str, root: &Path, extra: &[&str], argv: &[&str]) -> Output {
  let mut cmd = Command::new(env!("CARGO_BIN_EXE_kingu-ptyd"));
  cmd.args(["snap-exec", "--network", if network { "on" } else { "off" }, "--fs", fs, "--root"]).arg(root).args(extra).arg("--").args(argv).current_dir(root);
  cmd.output().unwrap()
}

fn ok(o: &Output) -> bool {
  o.status.success()
}

fn home() -> PathBuf {
  PathBuf::from(std::env::var_os("HOME").expect("HOME"))
}

/// Removes the path when dropped, so a failed assertion leaves nothing behind.
struct Cleanup(PathBuf);
impl Drop for Cleanup {
  fn drop(&mut self) {
    let _ = std::fs::remove_file(&self.0);
    let _ = std::fs::remove_dir_all(&self.0);
  }
}

/// A one-request-at-a-time HTTP server on 127.0.0.1 answering 200.
fn local_server() -> u16 {
  let listener = TcpListener::bind("127.0.0.1:0").unwrap();
  let port = listener.local_addr().unwrap().port();
  std::thread::spawn(move || {
    for stream in listener.incoming().flatten() {
      let mut s = stream;
      let mut buf = [0u8; 1024];
      let _ = s.read(&mut buf);
      let _ = s.write_all(b"HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok");
    }
  });
  port
}

#[test]
fn network_off_blocks_loopback_and_on_allows_it() {
  if !available() {
    return;
  }
  let root = tempfile::tempdir().unwrap();
  let url = format!("http://127.0.0.1:{}/", local_server());
  let curl = ["/usr/bin/curl", "-s", "-o", "/dev/null", "--max-time", "5", url.as_str()];
  assert!(ok(&Command::new(curl[0]).args(&curl[1..]).output().unwrap()), "the server answers without the sandbox");
  let off = snap_exec(false, "worktree", root.path(), &[], &curl);
  assert!(!ok(&off), "network = false must block 127.0.0.1");
  assert!(ok(&snap_exec(true, "worktree", root.path(), &[], &curl)), "network = true allows it");
  // Unix sockets keep working without the network (tools talk to local daemons through them).
  let sock = root.path().join("s.sock");
  let py = format!("import socket;s=socket.socket(socket.AF_UNIX);s.bind({:?});s.listen(1);c=socket.socket(socket.AF_UNIX);c.connect({:?})", sock, sock);
  if Path::new("/usr/bin/python3").is_file() && ok(&Command::new("/usr/bin/python3").arg("-c").arg("print(1)").output().unwrap()) {
    let _ = std::fs::remove_file(&sock);
    let o = snap_exec(false, "worktree", root.path(), &[], &["/usr/bin/python3", "-c", &py]);
    assert!(ok(&o), "unix socket: {}", String::from_utf8_lossy(&o.stderr));
  }
}

#[test]
fn worktree_mode_confines_writes_but_not_reads() {
  if !available() {
    return;
  }
  // A space and quotes in the root exercise the SBPL escaping.
  let tmp = tempfile::tempdir().unwrap();
  let root = tmp.path().join(r#"my "proj" dir"#);
  std::fs::create_dir(&root).unwrap();
  let inside = root.join("in.txt");
  let o = snap_exec(false, "worktree", &root, &[], &["/bin/sh", "-c", &format!("echo x > '{}'", inside.display())]);
  assert!(ok(&o), "write inside the root: {}", String::from_utf8_lossy(&o.stderr));
  assert!(inside.is_file());

  let outside = home().join(format!("kingu-sbx-test-{}", std::process::id()));
  let _cleanup = Cleanup(outside.clone());
  let write_outside = format!("echo x > '{}'", outside.display());
  let o = snap_exec(true, "worktree", &root, &[], &["/bin/sh", "-c", &write_outside]);
  assert!(!ok(&o), "write outside the root must fail");
  assert!(!outside.exists());

  // Reads are not confined.
  if std::fs::write(&outside, "readable").is_ok() {
    let o = snap_exec(false, "worktree", &root, &[], &["/bin/cat", outside.to_str().unwrap()]);
    assert_eq!(String::from_utf8_lossy(&o.stdout), "readable");
    std::fs::remove_file(&outside).unwrap();
    // fs = "home" may write there.
    let o = snap_exec(false, "home", &root, &[], &["/bin/sh", "-c", &write_outside]);
    assert!(ok(&o), "fs = home writes in home: {}", String::from_utf8_lossy(&o.stderr));
  }

  // The temp dir stays writable.
  assert!(ok(&snap_exec(false, "worktree", &root, &[], &["/bin/sh", "-c", "echo x > \"$TMPDIR/kingu-sbx-$$\" && rm \"$TMPDIR/kingu-sbx-$$\""])));
  // The app's own folders stay read-only even in fs = home.
  let app = tmp.path().join("app-config");
  std::fs::create_dir(&app).unwrap();
  let o = snap_exec(false, "home", &root, &["--protect", app.to_str().unwrap()], &["/bin/sh", "-c", &format!("echo x > '{}/trust.json'", app.display())]);
  assert!(!ok(&o), "a protected folder must stay read-only");
}

fn git(dir: &Path, args: &[&str]) {
  let o = Command::new("git").args(["-c", "user.email=k@k", "-c", "user.name=k", "-c", "commit.gpgsign=false"]).args(args).current_dir(dir).output().unwrap();
  assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
}

#[test]
fn git_works_in_the_root_but_hooks_and_config_stay_read_only() {
  if !available() || Command::new("git").arg("--version").output().is_err() {
    return;
  }
  // Outside the temp dirs (which stay writable), so a write to the main checkout can be refused.
  let in_home = tempfile::Builder::new().prefix("kingu-sbx-test-").tempdir_in(home());
  let tmp = match in_home {
    Ok(t) => t,
    Err(_) => tempfile::tempdir().unwrap(),
  };
  let outside_temp = !tmp.path().starts_with(std::env::temp_dir());
  let repo = tmp.path().join("repo");
  std::fs::create_dir(&repo).unwrap();
  git(&repo, &["init", "-q", "-b", "main"]);
  std::fs::write(repo.join("a.txt"), "a").unwrap();
  git(&repo, &["add", "a.txt"]);
  git(&repo, &["commit", "-qm", "init"]);
  let gitc = ["git", "-c", "user.email=k@k", "-c", "user.name=k", "-c", "commit.gpgsign=false"];
  let run = |root: &Path, args: &[&str]| snap_exec(false, "worktree", root, &[], &[gitc.as_slice(), args].concat());

  let o = run(&repo, &["status", "--short"]);
  assert!(ok(&o), "git status: {}", String::from_utf8_lossy(&o.stderr));
  let o = run(&repo, &["commit", "-q", "--allow-empty", "-m", "in sandbox"]);
  assert!(ok(&o), "git commit: {}", String::from_utf8_lossy(&o.stderr));
  assert!(!ok(&run(&repo, &["config", "core.hooksPath", "/tmp/evil"])), ".git/config is read-only");
  let hook = repo.join(".git/hooks/pre-commit");
  assert!(!ok(&snap_exec(false, "worktree", &repo, &[], &["/bin/sh", "-c", &format!("echo evil > '{}'", hook.display())])), ".git/hooks is read-only");
  assert!(!hook.exists());

  // A linked worktree (an ADE task) commits through the main repo's git dir.
  let wt = repo.join(".kingu/worktrees/t1");
  git(&repo, &["worktree", "add", "-q", "-b", "kingu/t1", wt.to_str().unwrap()]);
  std::fs::write(wt.join("b.txt"), "b").unwrap();
  let o = run(&wt, &["add", "b.txt"]);
  assert!(ok(&o), "git add in a worktree: {}", String::from_utf8_lossy(&o.stderr));
  let o = run(&wt, &["commit", "-qm", "b"]);
  assert!(ok(&o), "git commit in a worktree: {}", String::from_utf8_lossy(&o.stderr));
  // Writing elsewhere in the main checkout is still denied.
  if outside_temp {
    assert!(!ok(&snap_exec(false, "worktree", &wt, &[], &["/bin/sh", "-c", &format!("echo x > '{}'", repo.join("x.txt").display())])));
    assert!(!repo.join("x.txt").exists());
  }
}

#[test]
fn credentials_are_not_passed_unless_declared() {
  if !available() {
    return;
  }
  let root = tempfile::tempdir().unwrap();
  let o = Command::new(env!("CARGO_BIN_EXE_kingu-ptyd"))
    .args(["snap-exec", "--network", "off", "--root"])
    .arg(root.path())
    .args(["--secret", "GITHUB_TOKEN", "--keep", "MODE_TOKEN", "--", "/usr/bin/env"])
    .env("GITHUB_TOKEN", "gh")
    .env("ANTHROPIC_API_KEY", "sk")
    .env("MODE_TOKEN", "m")
    .env("SSH_AUTH_SOCK", "/tmp/agent")
    .env("KINGU_SBX_PLAIN", "1")
    .output()
    .unwrap();
  assert!(ok(&o), "{}", String::from_utf8_lossy(&o.stderr));
  let env = String::from_utf8_lossy(&o.stdout);
  assert!(env.contains("GITHUB_TOKEN=gh\n"));
  assert!(env.contains("MODE_TOKEN=m\n"));
  assert!(env.contains("KINGU_SBX_PLAIN=1\n"));
  assert!(!env.contains("ANTHROPIC_API_KEY"));
  assert!(!env.contains("SSH_AUTH_SOCK"));
}

#[test]
fn the_terminal_command_line_survives_shell_quoting() {
  if !available() {
    return;
  }
  // A task is typed into a shell: `command_line` quotes each argument, the profile never
  // passes through the shell (the launcher builds it).
  let tmp = tempfile::tempdir().unwrap();
  let root = tmp.path().join("it's $HOME");
  std::fs::create_dir(&root).unwrap();
  let argv: Vec<String> = [env!("CARGO_BIN_EXE_kingu-ptyd"), "snap-exec", "--network", "off", "--fs", "worktree", "--root", root.to_str().unwrap(), "--", "/bin/sh", "-c", "echo \"$0\" > out.txt", "a b"]
    .iter()
    .map(|s| s.to_string())
    .collect();
  let line = kingu_ptyd::command_line(&argv).unwrap();
  let o = Command::new("/bin/zsh").args(["-f", "-c", &line]).current_dir(&root).output().unwrap();
  assert!(ok(&o), "{}", String::from_utf8_lossy(&o.stderr));
  assert_eq!(std::fs::read_to_string(root.join("out.txt")).unwrap(), "a b\n");
}

#[test]
fn refuses_with_a_message_when_the_root_is_missing() {
  let o = Command::new(env!("CARGO_BIN_EXE_kingu-ptyd")).args(["snap-exec", "--network", "off", "--root", "/kingu-no-such-root", "--", "/usr/bin/true"]).output().unwrap();
  assert_eq!(o.status.code(), Some(126));
  assert!(String::from_utf8_lossy(&o.stderr).contains("โฟลเดอร์งาน"));
}
