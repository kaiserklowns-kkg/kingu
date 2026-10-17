// Tabs of one worktree in the Agents layout (pure, so `bun test` can cover it).

/** `title`: a task or agent name instead of "Terminal n"; `run`: the command typed into its shell. */
export type TerminalTab = { id: string; n: number; title?: string; run?: string[] };
export type AdeTab = { id: string; kind: 'agent' | 'compose' | 'terminal'; label: string };

/** The main tab (the task's agent session, or the new-task composer for the folder), then its terminals. */
export function adeTabs(key: string, terminals: TerminalTab[]): AdeTab[] {
	const main: AdeTab = key ? { id: 'main', kind: 'agent', label: 'Agent' } : { id: 'main', kind: 'compose', label: 'งานใหม่' };
	return [main, ...terminals.map((t) => ({ id: t.id, kind: 'terminal' as const, label: t.title ?? `Terminal ${t.n}` }))];
}

/** Whether a worktree matches the side bar's search box (title, branch or slug; case-insensitive). */
export function matchesQuery(query: string, ...fields: (string | null | undefined)[]): boolean {
	const q = query.trim().toLowerCase();
	return !q || fields.some((f) => f?.toLowerCase().includes(q));
}
