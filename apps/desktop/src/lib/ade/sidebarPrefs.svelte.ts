// Agents side bar state that Orca keeps across restarts: grouping, sort, card layout, filters,
// collapsed groups, the activity view, and per folder the pinned worktrees and manual order.

import type { Filters, GroupBy, SortBy } from './sidebarModel';

const KEY = 'kingu.ade.sidebar';

type PerRoot = { pinned: string[]; manual: string[]; unread: string[] };
type Saved = { groupBy: GroupBy; sortBy: SortBy; compact: boolean; filters: Filters; collapsed: string[]; activity: boolean; roots: Record<string, PerRoot> };

const DEFAULTS: Saved = {
	groupBy: 'repo',
	sortBy: 'recent',
	compact: false,
	filters: { hideSleeping: false, exceptDefault: true, hideDefault: false },
	collapsed: [],
	activity: false,
	roots: {}
};

function load(): Saved {
	try {
		const s = JSON.parse(localStorage.getItem(KEY) ?? '{}');
		return { ...DEFAULTS, ...s, filters: { ...DEFAULTS.filters, ...s.filters } };
	} catch {
		return DEFAULTS;
	}
}

class SidebarPrefs {
	#s = $state<Saved>(load());

	get groupBy() {
		return this.#s.groupBy;
	}
	set groupBy(v: GroupBy) {
		this.#s.groupBy = v;
		this.#s.collapsed = [];
		this.#save();
	}
	get sortBy() {
		return this.#s.sortBy;
	}
	set sortBy(v: SortBy) {
		this.#s.sortBy = v;
		this.#save();
	}
	get compact() {
		return this.#s.compact;
	}
	set compact(v: boolean) {
		this.#s.compact = v;
		this.#save();
	}
	get filters(): Filters {
		return this.#s.filters;
	}
	setFilter(key: keyof Filters, v: boolean) {
		this.#s.filters[key] = v;
		this.#save();
	}
	clearFilters() {
		this.#s.filters = { ...DEFAULTS.filters };
		this.#save();
	}
	get activity() {
		return this.#s.activity;
	}
	set activity(v: boolean) {
		this.#s.activity = v;
		this.#save();
	}
	isCollapsed(group: string) {
		return this.#s.collapsed.includes(group);
	}
	toggleCollapsed(group: string) {
		this.#s.collapsed = this.isCollapsed(group) ? this.#s.collapsed.filter((g) => g !== group) : [...this.#s.collapsed, group];
		this.#save();
	}

	#root(root: string): PerRoot {
		return (this.#s.roots[root] ??= { pinned: [], manual: [], unread: [] });
	}
	pinned(root: string): string[] {
		return this.#s.roots[root]?.pinned ?? [];
	}
	setPinned(root: string, slug: string, on: boolean) {
		const r = this.#root(root);
		r.pinned = on ? [...r.pinned.filter((s) => s !== slug), slug] : r.pinned.filter((s) => s !== slug);
		this.#save();
	}
	manual(root: string): string[] {
		return this.#s.roots[root]?.manual ?? [];
	}
	setManual(root: string, order: string[]) {
		this.#root(root).manual = order;
		this.#save();
	}
	/** Worktrees marked unread by hand (Mark Unread), until they are opened. */
	markedUnread(root: string): string[] {
		return this.#s.roots[root]?.unread ?? [];
	}
	setMarkedUnread(root: string, slug: string, on: boolean) {
		const r = this.#root(root);
		r.unread = on ? [...r.unread.filter((s) => s !== slug), slug] : r.unread.filter((s) => s !== slug);
		this.#save();
	}

	#save() {
		try {
			localStorage.setItem(KEY, JSON.stringify(this.#s));
		} catch {
			// Kept for this window only.
		}
	}
}

export const sidebarPrefs = new SidebarPrefs();
