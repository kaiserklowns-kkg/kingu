// The Agents side bar as Orca builds its worktree list: the card status (Orca's precedence),
// sort comparators (Name, Agent Activity, Recent, Manual), status groups, filters and the
// relative time of agent rows. Pure, so it is unit-testable.

import type { Column, TaskStatus } from './model';

export type { GroupBy } from './sidebarView';
export type SortBy = 'name' | 'smart' | 'recent' | 'manual';
export const SORT_LABEL: Record<SortBy, string> = { name: 'Name', smart: 'Agent Activity', recent: 'Recent', manual: 'Manual' };

/** Orca's worktree status, shown in the card's status slot. */
export type CardStatus = 'working' | 'permission' | 'failed' | 'done' | 'active' | 'inactive';
export const CARD_STATUS_LABEL: Partial<Record<CardStatus, string>> = { working: 'Working', permission: 'Needs permission', failed: 'Failed', done: 'Done' };

export function cardStatus(status: TaskStatus, working: boolean, hasTabs: boolean): CardStatus {
	if (status === 'waiting') return 'permission';
	if (status === 'failed') return 'failed';
	if (status === 'running' || working) return 'working';
	if (status === 'review') return 'done';
	return hasTabs ? 'active' : 'inactive';
}

/** Board lane of a status (Group by Status). */
export function statusColumn(status: TaskStatus): Column {
	if (status === 'running') return 'active';
	if (status === 'done') return 'done';
	return 'attention';
}

export type SortItem = {
	slug: string;
	title: string;
	status: TaskStatus;
	createdAt: number;
	/** Latest agent or task activity, Unix ms. */
	lastActivityAt: number;
};

const MIN = 60_000;
/** A new worktree stays on top of Recent for five minutes. */
export function effectiveActivity(i: SortItem, now: number): number {
	const fresh = i.createdAt + 5 * MIN;
	return now < fresh ? Math.max(i.lastActivityAt, fresh) : i.lastActivityAt;
}

/** Agent Activity: 1 needs you, 2 done in the last 30 minutes, 3 working, 5 the rest. */
export function attentionClass(i: SortItem, now: number): number {
	if (i.status === 'waiting') return 1;
	if ((i.status === 'review' || i.status === 'failed') && now - i.lastActivityAt <= 30 * MIN) return 2;
	if (i.status === 'running') return 3;
	return 5;
}

const byName = (a: SortItem, b: SortItem) => a.title.localeCompare(b.title) || a.slug.localeCompare(b.slug);

export function sortItems<T extends SortItem>(items: T[], by: SortBy, now: number, manual: string[] = []): T[] {
	const list = [...items];
	switch (by) {
		case 'name':
			return list.sort(byName);
		case 'recent':
			return list.sort((a, b) => effectiveActivity(b, now) - effectiveActivity(a, now) || byName(a, b));
		case 'smart':
			return list.sort(
				(a, b) => attentionClass(a, now) - attentionClass(b, now) || b.lastActivityAt - a.lastActivityAt || effectiveActivity(b, now) - effectiveActivity(a, now) || byName(a, b)
			);
		case 'manual': {
			// Dropped order first; worktrees never dragged keep Recent order after them.
			const rank = (s: string) => {
				const i = manual.indexOf(s);
				return i < 0 ? Infinity : i;
			};
			return list.sort((a, b) => rank(a.slug) - rank(b.slug) || effectiveActivity(b, now) - effectiveActivity(a, now) || byName(a, b));
		}
	}
}

/** Moves `slug` before `before` (or to the end) in the manual order of `visible`. */
export function reorder(visible: string[], slug: string, before: string | null): string[] {
	const rest = visible.filter((s) => s !== slug);
	const at = before === null ? rest.length : rest.indexOf(before);
	rest.splice(at < 0 ? rest.length : at, 0, slug);
	return rest;
}

/** Orca's agent-row time: now, 5m, 3h, 2d. */
export function shortAgo(then: number, now: number): string {
	const s = Math.max(0, now - then) / 1000;
	if (s < 60) return 'now';
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	if (s < 86_400) return `${Math.floor(s / 3600)}h`;
	return `${Math.floor(s / 86_400)}d`;
}

/** The Filters switches: `kingu.sidebar.*` settings, except `exceptDefault` (a side bar preference). */
export type Filters = { hideSleeping: boolean; exceptDefault: boolean; hideDefault: boolean; showActiveOnly: boolean; hideAutomation: boolean; hideDetached: boolean };
/** The active-filter count on the options button. */
export const activeFilterCount = (f: Filters) =>
	Number(f.hideSleeping) + Number(f.hideSleeping && f.exceptDefault) + Number(f.hideDefault) + Number(f.showActiveOnly) + Number(f.hideAutomation) + Number(f.hideDetached);
