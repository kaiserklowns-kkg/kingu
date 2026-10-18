// Which tasks' agents a git action would run under (VS Code's Agents window: an agent's worktree
// belongs to its session while it works). Commit, reject, merge and refresh-base ask first when
// one of these is working, so the action does not fight the agent's own edits.

import { slugOfTaskKey, worktreeDir } from './keys';

/** The task worktrees an action touches: the task itself, plus the task that has `branch` checked
 * out (a merge or refresh moves that checkout too). */
export function touchedTasks(slug: string | null, branch: string | null, worktrees: readonly { slug?: string | null; branch?: string | null }[]): string[] {
	const out = new Set<string>();
	if (slug) out.add(slug);
	if (branch) for (const w of worktrees) if (w.slug && w.branch === branch) out.add(w.slug);
	return [...out];
}

/**
 * Editor tabs that go with a task when it is removed: its task page and diffs (`diffSlug` reads a
 * `taskdiff://` key), and files opened from its worktree. Duplicates (one tab per group) collapse.
 */
export function tabsOfTask(paths: readonly string[], slug: string, diffSlug: (path: string) => string | null | undefined): string[] {
	const dir = `${worktreeDir(slug)}/`;
	return [...new Set(paths.filter((p) => slugOfTaskKey(p) === slug || diffSlug(p) === slug || p.startsWith(dir)))];
}

/**
 * Whether the task list may end the terminals and agent CLIs of tasks missing from it: only once
 * the open folder's tasks were read successfully (a failed read leaves an empty list).
 */
export function mayPruneSessions(o: { loaded: boolean; loadedRoot: string | null; root: string | null }): boolean {
	return o.loaded && !!o.root && o.loadedRoot === o.root;
}

/** The first of `slugs` whose agent is working, or null. */
export function workingTask(slugs: readonly string[], isWorking: (slug: string) => boolean): string | null {
	return slugs.find((s) => isWorking(s)) ?? null;
}
