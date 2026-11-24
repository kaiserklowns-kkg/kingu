// The board's search (Orca's Agent Dashboard toolbar, model/agents-sessions.mdx: "Search —
// worktree, project, or agent name"): every word must appear in the task's title, its worktree
// (slug), its branch, its agent or its project. Pure.

export type BoardSearchable = { title: string; slug: string; agent?: string | null; branch?: string | null; project?: string | null };

export function boardMatches(task: BoardSearchable, query: string): boolean {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return true;
	const hay = [task.title, task.slug, task.branch ?? '', task.agent ?? '', task.project ?? ''].join('\n').toLowerCase();
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

/**
 * Orca's Project filter (dashboard-popout/agent-board-filtering.ts, agent-dashboard-filter-options.ts):
 * nothing chosen keeps every project; the options list each project with its card count, in the
 * order given.
 */
export type ProjectOption = { id: string; label: string; count: number };

export function projectOptions(projects: readonly { id: string; label: string }[], cards: readonly { root: string }[]): ProjectOption[] {
	const counts = new Map<string, number>();
	for (const c of cards) counts.set(c.root, (counts.get(c.root) ?? 0) + 1);
	return projects.map((p) => ({ ...p, count: counts.get(p.id) ?? 0 }));
}

export const inProjects = (chosen: readonly string[], root: string) => chosen.length === 0 || chosen.includes(root);

/** Orca `toggleDashboardFilter`. */
export const toggleFilter = <T>(values: readonly T[], value: T): T[] => (values.includes(value) ? values.filter((v) => v !== value) : [...values, value]);
