// Orca's nested workspaces (docs model/worktrees.mdx): a task's descendants are the tasks stacked
// on it (`parent`) or dispatched by its agent (`dispatched_by`), recursively. Sleep / Delete
// "with Descendants" act on them; stale links and cycles are ignored. Pure.

export type LineageTask = { slug: string; parent?: string | null; dispatched_by?: string | null };

/** Every descendant of `slug`, children before grandchildren, each once (cycle-safe). */
export function descendantsOf(list: readonly LineageTask[], slug: string): string[] {
	const out: string[] = [];
	const seen = new Set([slug]);
	let level = [slug];
	while (level.length) {
		const next: string[] = [];
		for (const t of list) {
			if (seen.has(t.slug)) continue;
			if (level.includes(t.parent ?? '') || level.includes(t.dispatched_by ?? '')) {
				seen.add(t.slug);
				next.push(t.slug);
			}
		}
		out.push(...next);
		level = next;
	}
	return out;
}
