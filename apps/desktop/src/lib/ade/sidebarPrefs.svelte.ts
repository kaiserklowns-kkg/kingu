// Agents side bar preferences. Grouping, sort, card layout and the Filters switches are the
// `kingu.sidebar.*` user settings (Orca's sidebar UI preferences; settings.json and the Settings
// page edit the same values). What only this side bar remembers stays in local storage: collapsed
// groups, the activity view, "except default branch", and per folder the pinned worktrees, manual
// order and hand-marked unread ones.

import { settings } from '#lib/settings/settings.svelte.ts';
import type { Filters, GroupBy, SortBy } from './sidebarModel';

const KEY = 'kingu.ade.sidebar';

type PerRoot = { pinned: string[]; manual: string[]; unread: string[] };
type Saved = { exceptDefault: boolean; collapsed: string[]; activity: boolean; roots: Record<string, PerRoot> };

const DEFAULTS: Saved = { exceptDefault: true, collapsed: [], activity: false, roots: {} };

/** Filter switch → its setting (`exceptDefault` is not one). */
const FILTER_SETTING = {
	hideSleeping: 'kingu.sidebar.hideSleeping',
	hideDefault: 'kingu.sidebar.hideDefaultBranch',
	showActiveOnly: 'kingu.sidebar.showActiveOnly',
	hideAutomation: 'kingu.sidebar.hideAutomationTasks',
	hideDetached: 'kingu.sidebar.hideDetachedHead'
} as const satisfies Partial<Record<keyof Filters, string>>;

function load(): Saved {
	try {
		const s = JSON.parse(localStorage.getItem(KEY) ?? '{}');
		// Older saves kept the filters (and grouping) here; only `exceptDefault` still lives here.
		return { ...DEFAULTS, ...s, exceptDefault: s.exceptDefault ?? s.filters?.exceptDefault ?? DEFAULTS.exceptDefault };
	} catch {
		return DEFAULTS;
	}
}

const setUser = (id: string, value: unknown) => void settings.set(id, value, 'user');

class SidebarPrefs {
	#s = $state<Saved>(load());

	get groupBy(): GroupBy {
		return settings.get<GroupBy>('kingu.sidebar.groupBy');
	}
	set groupBy(v: GroupBy) {
		setUser('kingu.sidebar.groupBy', v);
		this.#s.collapsed = [];
		this.#save();
	}
	get sortBy(): SortBy {
		return settings.get<SortBy>('kingu.sidebar.sortBy');
	}
	set sortBy(v: SortBy) {
		setUser('kingu.sidebar.sortBy', v);
	}
	get compact() {
		return settings.get<boolean>('kingu.sidebar.compactCards') === true;
	}
	set compact(v: boolean) {
		setUser('kingu.sidebar.compactCards', v);
	}
	get filters(): Filters {
		const on = (k: keyof typeof FILTER_SETTING) => settings.get<boolean>(FILTER_SETTING[k]) === true;
		return {
			hideSleeping: on('hideSleeping'),
			hideDefault: on('hideDefault'),
			showActiveOnly: on('showActiveOnly'),
			hideAutomation: on('hideAutomation'),
			hideDetached: on('hideDetached'),
			exceptDefault: this.#s.exceptDefault
		};
	}
	setFilter(key: keyof Filters, v: boolean) {
		if (key === 'exceptDefault') {
			this.#s.exceptDefault = v;
			this.#save();
		} else setUser(FILTER_SETTING[key], v);
	}
	clearFilters() {
		for (const id of Object.values(FILTER_SETTING)) setUser(id, undefined);
		this.#s.exceptDefault = DEFAULTS.exceptDefault;
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
