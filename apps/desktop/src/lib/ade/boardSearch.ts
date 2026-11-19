// The board's search (Orca's Agent Dashboard toolbar, model/agents-sessions.mdx: "Search —
// worktree, project, or agent name"): every word must appear in the task's title, its worktree
// (slug), its branch, or its agent. Pure.

export type BoardSearchable = { title: string; slug: string; agent?: string | null; branch?: string | null };

export function boardMatches(task: BoardSearchable, query: string): boolean {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return true;
	const hay = [task.title, task.slug, task.branch ?? '', task.agent ?? ''].join('\n').toLowerCase();
	return words.every((w) => hay.includes(w));
}

/**
 * Orca's Idle column (shared/dashboard-snapshot.ts `dashboardCardBaseDisplayState`): a finished
 * task stays in Done while it has unread notices, then settles into Idle once you have seen it.
 */
export function splitIdle<T extends { meta: { slug: string } }>(done: readonly T[], unread: ReadonlySet<string>): { done: T[]; idle: T[] } {
	const out = { done: [] as T[], idle: [] as T[] };
	for (const v of done) (unread.has(v.meta.slug) ? out.done : out.idle).push(v);
	return out;
}
