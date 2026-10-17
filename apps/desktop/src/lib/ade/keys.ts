// Editor tab keys of the ADE editors: a task page `task://<slug>` and the board `board://`.
// (Task file diffs use `taskdiff://<slug>/<rel>`, see workbench/scm.ts.)

export const TASK_PREFIX = 'task://';
export const BOARD_KEY = 'board://';

export const taskKey = (slug: string) => TASK_PREFIX + slug;
export const isTaskKey = (key: string) => key.startsWith(TASK_PREFIX);
export const slugOfTaskKey = (key: string) => (isTaskKey(key) ? key.slice(TASK_PREFIX.length) : null);
export const isBoardKey = (key: string) => key === BOARD_KEY;
/** Tabs rendered by ADE components rather than a text editor. */
export const isAdeEditor = (key: string) => isTaskKey(key) || isBoardKey(key);

/** Workspace-relative folder of a task worktree (Rust: `agent::worktree::worktree_path`). */
export const worktreeDir = (slug: string) => `.kingu/worktrees/${slug}`;
