// Child agents in the side bar (Orca's agentsShowChildAgents and its worktree lineage rows): a
// task an agent dispatched with `kingu task create` records the dispatching task as
// `dispatched_by`. With kingu.sidebar.showChildAgents on, such a task nests under the task that
// dispatched it (nestTasks in attempts.ts does the indent) and the dispatching card can collapse
// them; off, they are hidden like Orca hides them. Either way the one you selected stays, and a
// dispatcher that is not listed (removed, filtered out) or a cycle leaves the task at the top.
// Pure, so `bun test` covers it.

export type ChildAgentItem = { slug: string; parent?: string | null; dispatchedBy?: string | null };

/** Dispatcher of each listed task whose dispatcher is listed too, cycles left out. */
export function dispatchLineage(list: readonly ChildAgentItem[]): Map<string, string> {
	const present = new Set(list.map((t) => t.slug));
	const raw = new Map<string, string>();
	for (const t of list) if (t.dispatchedBy && t.dispatchedBy !== t.slug && present.has(t.dispatchedBy)) raw.set(t.slug, t.dispatchedBy);
	const out = new Map<string, string>();
	for (const [slug, by] of raw) {
		// A chain that comes back to this task is a cycle (hand-edited tasks.json): no parent then.
		const seen = new Set([slug]);
		let at: string | undefined = by;
		let cycle = false;
		while (at !== undefined) {
			if (seen.has(at)) {
				cycle = true;
				break;
			}
			seen.add(at);
			at = raw.get(at);
		}
		if (!cycle) out.set(slug, by);
	}
	return out;
}

export type ChildAgentOptions = {
	/** kingu.sidebar.showChildAgents. */
	show: boolean;
	/** Whether a dispatching task's children are folded away. */
	collapsed: (slug: string) => boolean;
	/** The selected card: never hidden. */
	selected: string | null;
};

export type ChildAgentRows<T> = {
	/** The list to nest: hidden children dropped, a shown child's `parent` set to its dispatcher (a stacked parent wins). */
	rows: T[];
	/** Number of direct children per dispatching task, shown or not. */
	children: Map<string, number>;
};

/** Applies the setting and the folded parents to a sorted list, before nestTasks. */
export function childAgentRows<T extends ChildAgentItem>(list: readonly T[], o: ChildAgentOptions): ChildAgentRows<T> {
	const lineage = dispatchLineage(list);
	const children = new Map<string, number>();
	for (const by of lineage.values()) children.set(by, (children.get(by) ?? 0) + 1);
	// Hidden when the setting is off, or any dispatcher up the chain is folded.
	const hidden = (slug: string): boolean => {
		if (!lineage.has(slug)) return false;
		if (!o.show) return true;
		for (let at = lineage.get(slug); at !== undefined; at = lineage.get(at)) if (o.collapsed(at)) return true;
		return false;
	};
	const rows: T[] = [];
	for (const t of list) {
		if (t.slug !== o.selected && hidden(t.slug)) continue;
		const by = lineage.get(t.slug);
		rows.push(o.show && by && !t.parent ? { ...t, parent: by } : t);
	}
	return { rows, children };
}

/** The disclosure on a dispatching card: its child count, and whether they are folded (hidden when the setting is off). */
export function childAgentToggle(slug: string, r: Pick<ChildAgentRows<unknown>, 'children'>, o: Pick<ChildAgentOptions, 'show' | 'collapsed'>): { count: number; expanded: boolean } | null {
	const count = r.children.get(slug) ?? 0;
	if (!count) return null;
	return { count, expanded: o.show && !o.collapsed(slug) };
}

/** The local-storage key a dispatching card's fold is kept under (with the side bar's collapsed groups). */
export const childAgentsKey = (slug: string) => `children:${slug}`;
