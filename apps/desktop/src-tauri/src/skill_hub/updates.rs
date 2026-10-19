//! "Update available" for Kingu-managed skills installed from a git link: the commit recorded at
//! install (`Origin::commit`) against what the remote's branch (or default branch) points at now,
//! from `git ls-remote` (no clone, nothing written but a small cache). Checked at most once a day
//! per skill unless the user asks; nothing is installed: Update in the Skills view still fetches
//! and shows the review.
//!
//! The cache is `<app config>/skill-updates.json`: per skill the repository and ref it checked,
//! the commit it found and when. A skill pinned to a commit, or installed from an archive or a
//! local file or folder, has nothing to compare and is not checked.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::install::{self, Origin, OriginKind};
use crate::snap_install::is_commit;

pub const CACHE_FILE: &str = "skill-updates.json";
/// A skill is checked again after this long (or when the user asks).
pub const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
/// One `git ls-remote` may take this long.
pub const LS_REMOTE_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_CACHE_BYTES: u64 = 1024 * 1024;

#[derive(Serialize, Deserialize, Default, Debug, PartialEq)]
struct Cache {
  #[serde(default)]
  skills: BTreeMap<String, Entry>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Entry {
  url: String,
  #[serde(default, rename = "ref")]
  git_ref: Option<String>,
  /// The commit the remote's ref pointed at; `None` when it could not be read.
  #[serde(default)]
  remote: Option<String>,
  /// Seconds since the Unix epoch.
  checked_at: u64,
}

/// One skill with a newer commit upstream.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillUpdate {
  pub name: String,
  pub installed: String,
  pub remote: String,
}

/// What `skill_hub_check_updates` returns.
#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateReport {
  pub updates: Vec<SkillUpdate>,
  /// When the oldest of the checked skills was last checked (seconds since the epoch; 0: none).
  pub checked_at: u64,
}

/// The repository and ref an installed skill follows, if it can have updates: a git install with
/// its commit recorded, on a branch (or the default branch), not pinned to a commit.
fn followed(origin: &Origin) -> Option<(String, Option<String>, String)> {
  if origin.kind != OriginKind::Git {
    return None;
  }
  let url = origin.url.clone()?;
  let commit = origin.commit.clone().filter(|c| is_commit(c))?;
  let git_ref = origin.git_ref.clone().filter(|r| !r.is_empty());
  if git_ref.as_deref().is_some_and(is_commit) {
    return None;
  }
  Some((url, git_ref, commit))
}

/// The `git ls-remote` arguments for `url` at `git_ref` (`HEAD` without one).
pub fn ls_remote_args<'a>(url: &'a str, heads: &'a str, tags: &'a str, git_ref: Option<&str>) -> Vec<&'a str> {
  let mut args = vec!["-c", "protocol.ext.allow=never", "ls-remote", "--", url];
  if git_ref.is_some() {
    args.extend([heads, tags]);
  } else {
    args.push("HEAD");
  }
  args
}

/// The commit `git_ref` names in `git ls-remote` output: a branch first, then a tag (peeled to its
/// commit when annotated); `HEAD` without a ref.
pub fn remote_commit(out: &str, git_ref: Option<&str>) -> Option<String> {
  let refs: BTreeMap<&str, &str> = out
    .lines()
    .filter_map(|l| {
      let (sha, name) = l.split_once('\t')?;
      is_commit(sha.trim()).then_some((name.trim(), sha.trim()))
    })
    .collect();
  let wanted = match git_ref {
    None => vec!["HEAD".to_string()],
    Some(r) => vec![format!("refs/heads/{r}"), format!("refs/tags/{r}^{{}}"), format!("refs/tags/{r}")],
  };
  wanted.iter().find_map(|w| refs.get(w.as_str()).map(|s| s.to_string()))
}

/// `git ls-remote` of a repository at a ref (tests pass a fake).
pub type LsRemote<'a> = dyn Fn(&str, Option<&str>) -> Result<String, String> + 'a;

fn load(file: &Path) -> Cache {
  std::fs::symlink_metadata(file)
    .ok()
    .filter(|m| m.is_file() && m.len() <= MAX_CACHE_BYTES)
    .and_then(|_| std::fs::read(file).ok())
    .and_then(|b| serde_json::from_slice(&b).ok())
    .unwrap_or_default()
}

/// Checks the managed skills in `skills_dir` whose last check is older than a day (all of them
/// with `force`), keeping what it finds in `cache_file`. `ls_remote(url, ref)` returns the
/// output of `git ls-remote`; a failure keeps the earlier answer and waits for the next day.
pub fn check(cache_file: &Path, skills_dir: &Path, now: u64, force: bool, ls_remote: &LsRemote) -> UpdateReport {
  let old = load(cache_file);
  let mut cache = Cache::default();
  let mut report = UpdateReport::default();
  let mut names: Vec<String> = std::fs::read_dir(skills_dir).map(|r| r.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
  names.sort();
  for name in names.into_iter().filter(|n| !n.starts_with('.')) {
    let Some((url, git_ref, installed)) = install::installed_dir(skills_dir, &name).ok().and_then(|d| install::read_origin(&d)).as_ref().and_then(followed) else {
      continue;
    };
    let before = old.skills.get(&name).filter(|e| e.url == url && e.git_ref == git_ref);
    let fresh = before.filter(|e| !force && now.saturating_sub(e.checked_at) < CHECK_INTERVAL.as_secs() && e.checked_at <= now);
    let entry = match fresh {
      Some(e) => e.clone(),
      None => {
        let remote = match ls_remote(&url, git_ref.as_deref()) {
          Ok(out) => remote_commit(&out, git_ref.as_deref()).or_else(|| {
            log::warn!("skills: {name}: {} not found at {url}", git_ref.as_deref().unwrap_or("HEAD"));
            None
          }),
          Err(e) => {
            log::warn!("skills: could not check {name} for updates: {e}");
            before.and_then(|e| e.remote.clone())
          }
        };
        Entry { url, git_ref, remote, checked_at: now }
      }
    };
    report.checked_at = if report.checked_at == 0 { entry.checked_at } else { report.checked_at.min(entry.checked_at) };
    if let Some(remote) = entry.remote.as_ref().filter(|r| **r != installed) {
      report.updates.push(SkillUpdate { name: name.clone(), installed, remote: remote.clone() });
    }
    cache.skills.insert(name, entry);
  }
  if cache != old {
    let saved = serde_json::to_string_pretty(&cache).map_err(|e| e.to_string()).and_then(|text| crate::settings::write_atomic(cache_file, &(text + "\n")));
    if let Err(e) = saved {
      log::warn!("skills: could not save {CACHE_FILE}: {e}");
    }
  }
  report
}

/// `git ls-remote` of `url` (run in `dir`), never prompting, over https, ssh or a local path.
pub fn ls_remote(dir: &Path, url: &str, git_ref: Option<&str>) -> Result<String, String> {
  let (heads, tags) = git_ref.map(|r| (format!("refs/heads/{r}"), format!("refs/tags/{r}"))).unwrap_or_default();
  let args = ls_remote_args(url, &heads, &tags, git_ref);
  let env = [("GIT_ALLOW_PROTOCOL", "https:ssh:file")];
  crate::git_remote::net_env(dir, &args, &env, &std::sync::atomic::AtomicBool::new(false), LS_REMOTE_TIMEOUT)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::cell::RefCell;

  const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const C: &str = "cccccccccccccccccccccccccccccccccccccccc";

  #[test]
  fn reads_the_commit_of_a_ref() {
    let out = format!("{A}\tHEAD\n{B}\trefs/heads/main\n{C}\trefs/tags/v1\n{A}\trefs/tags/v1^{{}}\n");
    assert_eq!(remote_commit(&out, None).as_deref(), Some(A));
    assert_eq!(remote_commit(&out, Some("main")).as_deref(), Some(B));
    // An annotated tag: the commit it points at, not the tag object.
    assert_eq!(remote_commit(&out, Some("v1")).as_deref(), Some(A));
    assert_eq!(remote_commit(&format!("{C}\trefs/tags/v2\n"), Some("v2")).as_deref(), Some(C));
    assert_eq!(remote_commit(&out, Some("gone")), None);
    assert_eq!(remote_commit("garbage\nnot\ta commit\n", None), None);
    assert_eq!(ls_remote_args("u", "refs/heads/main", "refs/tags/main", Some("main")), ["-c", "protocol.ext.allow=never", "ls-remote", "--", "u", "refs/heads/main", "refs/tags/main"]);
    assert_eq!(ls_remote_args("u", "", "", None).last(), Some(&"HEAD"));
  }

  fn install(skills: &Path, name: &str, origin: serde_json::Value) {
    let dir = skills.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), format!("---\nname: {name}\ndescription: d\n---\n")).unwrap();
    std::fs::write(dir.join(install::ORIGIN_FILE), origin.to_string()).unwrap();
  }

  #[test]
  fn checks_once_a_day_unless_asked() {
    let tmp = tempfile::tempdir().unwrap();
    let (skills, cache) = (tmp.path().join("skills"), tmp.path().join(CACHE_FILE));
    install(&skills, "pdf", serde_json::json!({ "kind": "git", "url": "https://x/r.git", "ref": "main", "commit": A, "path": "pdf" }));
    install(&skills, "head", serde_json::json!({ "kind": "git", "url": "https://x/h.git", "commit": B }));
    // Nothing to compare: pinned to a commit, an archive, no commit recorded.
    install(&skills, "pinned", serde_json::json!({ "kind": "git", "url": "https://x/p.git", "ref": A, "commit": A }));
    install(&skills, "zip", serde_json::json!({ "kind": "archive", "url": "https://x/z.skill" }));
    install(&skills, "nocommit", serde_json::json!({ "kind": "git", "url": "https://x/n.git" }));
    let calls = RefCell::new(Vec::new());
    let remote = RefCell::new(format!("{C}\trefs/heads/main\n{B}\tHEAD\n"));
    let ls = |url: &str, r: Option<&str>| {
      calls.borrow_mut().push(format!("{url} {}", r.unwrap_or("HEAD")));
      Ok(remote.borrow().clone())
    };

    let day = CHECK_INTERVAL.as_secs();
    let r = check(&cache, &skills, 1000, false, &ls);
    assert_eq!(r.updates, vec![SkillUpdate { name: "pdf".into(), installed: A.into(), remote: C.into() }]);
    assert_eq!(r.checked_at, 1000);
    assert_eq!(*calls.borrow(), ["https://x/h.git HEAD", "https://x/r.git main"]);

    // Within the day: the cached answer, no network.
    *remote.borrow_mut() = format!("{A}\trefs/heads/main\n{C}\tHEAD\n");
    let r = check(&cache, &skills, 1000 + day - 1, false, &ls);
    assert_eq!(r.updates.len(), 1);
    assert_eq!(calls.borrow().len(), 2);

    // Asked for: checked now (pdf is current again, head has moved on).
    let r = check(&cache, &skills, 2000, true, &ls);
    assert_eq!(r.updates, vec![SkillUpdate { name: "head".into(), installed: B.into(), remote: C.into() }]);
    assert_eq!(calls.borrow().len(), 4);

    // A failed check keeps the earlier answer until the next day; a removed skill leaves the cache.
    std::fs::remove_dir_all(skills.join("pdf")).unwrap();
    let failing = |_: &str, _: Option<&str>| Err("offline".to_string());
    let r = check(&cache, &skills, 2000 + day, false, &failing);
    assert_eq!(r.updates.len(), 1);
    assert_eq!(r.checked_at, 2000 + day);
    let saved = load(&cache);
    assert_eq!(saved.skills.keys().collect::<Vec<_>>(), ["head"]);

    // A reinstall from elsewhere is checked again at once.
    install(&skills, "head", serde_json::json!({ "kind": "git", "url": "https://x/other.git", "commit": B }));
    let r = check(&cache, &skills, 2001 + day, false, &ls);
    assert!(r.updates.iter().any(|u| u.name == "head"));
    assert_eq!(calls.borrow().last().map(String::as_str), Some("https://x/other.git HEAD"));
  }

  #[test]
  fn ls_remote_reads_a_local_repo() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let git = |args: &[&str]| {
      let out = std::process::Command::new("git").args(args).current_dir(&repo).env("GIT_CONFIG_GLOBAL", "/dev/null").output().unwrap();
      assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
      String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    git(&["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("f"), "x").unwrap();
    git(&["add", "f"]);
    git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one"]);
    let head = git(&["rev-parse", "HEAD"]);
    let url = repo.display().to_string();
    let out = ls_remote(tmp.path(), &url, Some("main")).unwrap();
    assert_eq!(remote_commit(&out, Some("main")), Some(head.clone()));
    assert_eq!(remote_commit(&ls_remote(tmp.path(), &url, None).unwrap(), None), Some(head));
  }
}
