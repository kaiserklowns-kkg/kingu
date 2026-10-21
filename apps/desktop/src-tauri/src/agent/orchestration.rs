//! Agent orchestration (Orca's Orchestration pane): an agent coordinates work by dispatching
//! sub-tasks with `kingu task create` (cli_server.rs), each with its own worktree and agent.
//! The caller's working directory names the dispatching task (`<repo>/.kingu/worktrees/<slug>`);
//! the new task records it as `dispatched_by`. Tasks you start are depth 0, the workers they
//! dispatch depth 1, and so on: `kingu.orchestration.maxDepth` (Orca's nestedWorkerMaxDepth,
//! default 1) is the deepest a dispatched task may be, so by default workers cannot dispatch
//! workers of their own. The fence is decided here, never by the caller.

use std::collections::HashSet;
use std::path::{Component, Path};

use serde_json::Value;

use super::tasks::TaskMeta;
use super::worktree::{validate_slug, worktree_path};
use crate::i18n::msg::CliMsg;
use crate::tr;

/// The setting (application scope: read from the Default profile's settings.json).
pub const MAX_DEPTH_KEY: &str = "kingu.orchestration.maxDepth";
pub const DEFAULT_MAX_DEPTH: u32 = 1;
/// The settings schema's maximum, so a hand-edited file cannot ask for unbounded nesting.
pub const MAX_MAX_DEPTH: u32 = 5;

/// The setting's value as a depth: a whole number 1–5, anything else the default (a malformed
/// value never turns the fence off).
pub fn resolve_max_depth(v: Option<&Value>) -> u32 {
  match v.and_then(Value::as_u64) {
    Some(n) if (1..=MAX_MAX_DEPTH as u64).contains(&n) => n as u32,
    _ => DEFAULT_MAX_DEPTH,
  }
}

/// The task whose worktree holds `cwd` (also below its top folder), if any.
pub fn caller_task(root: &Path, cwd: &Path) -> Option<String> {
  let canonical = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
  let base = worktree_path(root, "x");
  let base = base.parent()?;
  for (dir, at) in [(base.to_path_buf(), cwd.to_path_buf()), (canonical(base), canonical(cwd))] {
    if let Ok(rest) = at.strip_prefix(&dir)
      && let Some(Component::Normal(first)) = rest.components().next()
      && let Some(slug) = first.to_str()
      && validate_slug(slug).is_ok()
    {
      return Some(slug.to_owned());
    }
  }
  None
}

/// How deep `slug` is: 0 for a task you started, one more per dispatching task above it. A
/// chain that loops or names a missing task ends there.
pub fn depth_of(tasks: &[TaskMeta], slug: &str) -> u32 {
  let mut seen = HashSet::new();
  let mut depth = 0;
  let mut at = slug;
  while seen.insert(at) {
    match tasks.iter().find(|t| t.slug == at).and_then(|t| t.dispatched_by.as_deref()) {
      Some(up) => {
        depth += 1;
        at = up;
      }
      None => break,
    }
  }
  depth
}

/// Who dispatches a new task and how deep it will be.
#[derive(Debug, Clone, PartialEq)]
pub struct Dispatch {
  pub by: Option<String>,
  pub depth: u32,
}

/// The new task's dispatcher, or the refusal when it would be deeper than `max`. A caller in no
/// task (the main checkout, your own terminal) starts a task of depth 0.
pub fn check_dispatch(root: &Path, cwd: Option<&Path>, tasks: &[TaskMeta], max: u32) -> Result<Dispatch, String> {
  let Some(by) = cwd.and_then(|c| caller_task(root, c)).filter(|s| tasks.iter().any(|t| &t.slug == s)) else {
    return Ok(Dispatch { by: None, depth: 0 });
  };
  let depth = depth_of(tasks, &by) + 1;
  if depth > max {
    // "Do it yourself": a refusal alone leaves the worker retrying a capability it will not get.
    return Err(tr!(CliMsg::DispatchTooDeep, depth, max));
  }
  Ok(Dispatch { by: Some(by), depth })
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn task(slug: &str, by: Option<&str>) -> TaskMeta {
    serde_json::from_value(json!({ "slug": slug, "title": slug, "base": "main", "created_at": 1, "status": "running", "dispatched_by": by })).unwrap()
  }

  #[test]
  fn resolves_the_setting() {
    assert_eq!(resolve_max_depth(None), 1);
    assert_eq!(resolve_max_depth(Some(&json!(3))), 3);
    for bad in [json!(0), json!(-2), json!(2.5), json!("3"), json!(99), json!(null)] {
      assert_eq!(resolve_max_depth(Some(&bad)), DEFAULT_MAX_DEPTH, "{bad}");
    }
  }

  #[test]
  fn finds_the_calling_task_from_its_worktree() {
    let root = Path::new("/r/app");
    assert_eq!(caller_task(root, Path::new("/r/app/.kingu/worktrees/fix-login")), Some("fix-login".into()));
    assert_eq!(caller_task(root, Path::new("/r/app/.kingu/worktrees/fix-login/src/api")), Some("fix-login".into()));
    assert_eq!(caller_task(root, Path::new("/r/app/src")), None);
    assert_eq!(caller_task(root, Path::new("/r/app/.kingu/worktrees")), None);
    assert_eq!(caller_task(root, Path::new("/r/app/.kingu/worktrees/Not A Slug")), None);
    assert_eq!(caller_task(root, Path::new("/elsewhere/.kingu/worktrees/x")), None);
  }

  #[test]
  fn counts_depth_through_dispatchers() {
    let tasks = [task("a", None), task("b", Some("a")), task("c", Some("b")), task("loop1", Some("loop2")), task("loop2", Some("loop1")), task("orphan", Some("gone"))];
    assert_eq!(depth_of(&tasks, "a"), 0);
    assert_eq!(depth_of(&tasks, "b"), 1);
    assert_eq!(depth_of(&tasks, "c"), 2);
    assert_eq!(depth_of(&tasks, "loop1"), 2, "a loop ends");
    assert_eq!(depth_of(&tasks, "orphan"), 1);
  }

  #[test]
  fn fences_nested_dispatch() {
    let root = Path::new("/r/app");
    let tasks = [task("lead", None), task("worker", Some("lead"))];
    let at = |slug: &str| root.join(".kingu/worktrees").join(slug);
    // You (or an agent in the main checkout) start a root task.
    assert_eq!(check_dispatch(root, Some(&root.join("src")), &tasks, 1).unwrap(), Dispatch { by: None, depth: 0 });
    assert_eq!(check_dispatch(root, None, &tasks, 1).unwrap(), Dispatch { by: None, depth: 0 });
    // A root task's agent dispatches a worker.
    assert_eq!(check_dispatch(root, Some(&at("lead")), &tasks, 1).unwrap(), Dispatch { by: Some("lead".into()), depth: 1 });
    // The worker may not dispatch further unless the depth allows it.
    let refused = check_dispatch(root, Some(&at("worker")), &tasks, 1).unwrap_err();
    assert!(refused.contains('2') && refused.contains('1'), "{refused}");
    assert_eq!(check_dispatch(root, Some(&at("worker")), &tasks, 2).unwrap(), Dispatch { by: Some("worker".into()), depth: 2 });
    // A worktree folder without a task is not a dispatcher.
    assert_eq!(check_dispatch(root, Some(&at("stray")), &tasks, 1).unwrap().by, None);
  }
}
