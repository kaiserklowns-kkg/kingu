// Which tasks' agents a git action would run under (VS Code's Agents window: an agent's worktree
// belongs to its session while it works). Commit, reject, merge and refresh-base ask first when
// one of these is working, so the action does not fight the agent's own edits.

/** The task worktrees an action touches: the task itself, plus the task that has `branch` checked
 * out (a merge or refresh moves that checkout too). */
export function touchedTasks(slug: string | null, branch: string | null, worktrees: readonly { slug?: string | null; branch?: string | null }[]): string[] {
	const out = new Set<string>();
	if (slug) out.add(slug);
	if (branch) for (const w of worktrees) if (w.slug && w.branch === branch) out.add(w.slug);
	return [...out];
}

/** The first of `slugs` whose agent is working, or null. */
export function workingTask(slugs: readonly string[], isWorking: (slug: string) => boolean): string | null {
	return slugs.find((s) => isWorking(s)) ?? null;
}
