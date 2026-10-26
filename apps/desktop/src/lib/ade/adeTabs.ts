// Tabs of one worktree in the Agents layout (pure, so `bun test` can cover it).

import { leaves, type PaneNode } from '#lib/terminal/paneLayout.ts';
import { fileOf, isDiffKey, splitPath } from '#lib/workbench/scm.ts';
import { t } from '#lib/i18n/index.ts';
import { isUntitled, untitledName } from '#lib/workbench/untitled.ts';

/** `title`: a task or agent name instead of "Terminal n"; `run`: the command typed into its shell. */
export type TerminalTab = {
	id: string;
	n: number;
	title?: string;
	run?: string[];
	/** A `#rgb` / `#rrggbb` tab color (kingu.yaml defaultTabs). */
	color?: string;
	/** Split panes (Orca's pane layout); absent while the tab is one pane, whose id is the tab's. */
	layout?: PaneNode;
	/** The focused pane of a split tab. */
	pane?: string;
	/** The pane expanded over the others (Orca's Expand Pane). */
	expanded?: string;
};

/** The panes of a terminal tab, in tree order. */
export const tabPanes = (t: TerminalTab): string[] => (t.layout ? leaves(t.layout) : [t.id]);
/** The focused pane of a terminal tab (its first pane when the saved one is gone). */
export const activePane = (t: TerminalTab): string => {
	const panes = tabPanes(t);
	return t.pane && panes.includes(t.pane) ? t.pane : panes[0];
};
/** Orca's pane focus order: creation order, which the `t<seq>` ids keep. */
export const paneOrder = (t: TerminalTab): string[] => [...tabPanes(t)].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));

/** Most recently used first; a tab moves to the front when shown (Orca's recentTabIds). */
export function touchMru(mru: string[], id: string, cap = 50): string[] {
	return [id, ...mru.filter((x) => x !== id)].slice(0, cap);
}

/** The Ctrl+Tab switcher's rows: the active tab, then by recent use, then the rest in tab order. */
export function mruOrder(mru: string[], ids: string[], active: string): string[] {
	const recent = mru.filter((id) => id !== active && ids.includes(id));
	return [...(ids.includes(active) ? [active] : []), ...recent, ...ids.filter((id) => id !== active && !recent.includes(id))];
}

/** The switcher's selection after one more Tab (`step` 1) or Shift+Tab (-1), wrapping. */
export const switcherStep = (index: number, step: 1 | -1, n: number) => (n ? (index + step + n) % n : 0);

/** The tab after (`step` 1) or before (-1) `active` among `ids`, wrapping; `active` itself when it is the only one. */
export function cycleTab(ids: string[], active: string, step: 1 | -1): string {
	if (!ids.length) return active;
	const i = ids.indexOf(active);
	if (i < 0) return ids[step === 1 ? 0 : ids.length - 1];
	return ids[(i + step + ids.length) % ids.length];
}

/** Orca's Select Tab n: the n-th tab (1-based), or null when there are fewer (9 is the 9th, not the last). */
export const tabAtIndex = (ids: string[], n: number): string | null => ids[n - 1] ?? null;

/** A browser tab of the Agents layout (Orca's browser tabs): a real page, its title from the page. */
export type BrowserTab = { id: string; url: string; title: string };

/** A closed tab, enough to open it again (Orca: a fresh shell keeps only the title). */
export type ClosedTab = { kind: 'terminal'; title?: string; index: number } | { kind: 'file'; key: string } | { kind: 'browser'; url: string; title?: string; index: number };
/** Orca keeps the last 10 closes per worktree. */
export function pushClosed(stack: ClosedTab[], tab: ClosedTab, cap = 10): ClosedTab[] {
	return [...stack, tab].slice(-cap);
}
/**
 * A file or task diff opened in the ADE center (Orca opens files next to the agent). `key` is a
 * workspace-relative path or a `taskdiff://<slug>/<rel>` key; a `preview` tab is replaced by the
 * next preview open, like VS Code's italic tabs.
 */
export type FileTab = { key: string; preview: boolean; /** Orca's markdown-preview mode: the tab renders instead of editing. */ mdPreview?: boolean };
export type AdeTab =
	| { id: string; kind: 'agent' | 'compose' | 'terminal'; label: string; color?: string }
	| { id: string; kind: 'browser'; label: string }
	| { id: string; kind: 'file' | 'diff'; label: string; key: string; preview: boolean };

/** Prefixed so a file named like a terminal id (`t1`, `main`) cannot clash with it. */
export const fileTabId = (key: string) => `f:${key}`;
export const keyOfTabId = (id: string) => (id.startsWith('f:') ? id.slice(2) : null);

/** The main tab (the task's agent session, or the new-task composer for the folder), its terminals, its browser tabs, then its files. */
export function adeTabs(key: string, terminals: TerminalTab[], files: FileTab[] = [], browsers: BrowserTab[] = []): AdeTab[] {
	const main: AdeTab = key ? { id: 'main', kind: 'agent', label: 'Agent' } : { id: 'main', kind: 'compose', label: t('ade.tabs.newTask') };
	return [
		main,
		...terminals.map((t) => ({ id: t.id, kind: 'terminal' as const, label: t.title ?? `Terminal ${t.n}`, ...(t.color ? { color: t.color } : {}) })),
		...browsers.map((b) => ({ id: b.id, kind: 'browser' as const, label: b.title })),
		...files.map((f) => ({
			id: fileTabId(f.key),
			kind: isDiffKey(f.key) ? ('diff' as const) : ('file' as const),
			label: isUntitled(f.key) ? untitledName(f.key) : splitPath(fileOf(f.key))[0],
			key: f.key,
			preview: f.preview
		}))
	];
}

/**
 * Tabs in the user's dragged order (Orca's tab strip): ids named in `order` first, the rest after
 * them in their usual order. Unknown ids (a tab closed since) are ignored.
 */
export function applyTabOrder(tabs: AdeTab[], order: readonly string[]): AdeTab[] {
	const rank = new Map(order.map((id, i) => [id, i]));
	const at = (id: string) => rank.get(id) ?? Number.MAX_SAFE_INTEGER;
	return [...tabs].sort((a, b) => at(a.id) - at(b.id));
}

/**
 * Opens `key`: an open tab is reused (and pinned unless opened as a preview again); a new preview
 * takes the place of the current preview tab unless `keep(thatKey)` (it has unsaved edits).
 */
export function openFileTab(files: FileTab[], key: string, preview: boolean, keep: (key: string) => boolean = () => false): FileTab[] {
	if (files.some((f) => f.key === key)) return preview ? files : pinFileTab(files, key);
	const tab: FileTab = { key, preview };
	const i = preview ? files.findIndex((f) => f.preview && !keep(f.key)) : -1;
	return i < 0 ? [...files, tab] : files.map((f, j) => (j === i ? tab : f));
}

export function pinFileTab(files: FileTab[], key: string): FileTab[] {
	return files.some((f) => f.key === key && f.preview) ? files.map((f) => (f.key === key ? { ...f, preview: false } : f)) : files;
}

/** The tab to show after closing `closing` (ids in tab order): its neighbour when it was active, like an editor tab. */
export function activeAfterClose(ids: string[], closing: string, active: string): string {
	if (closing !== active) return active;
	const i = ids.indexOf(closing);
	const rest = ids.filter((id) => id !== closing);
	return rest[Math.min(Math.max(i, 0), rest.length - 1)] ?? 'main';
}

/** Whether a worktree matches the side bar's search box (title, branch or slug; case-insensitive). */
export function matchesQuery(query: string, ...fields: (string | null | undefined)[]): boolean {
	const q = query.trim().toLowerCase();
	return !q || fields.some((f) => f?.toLowerCase().includes(q));
}
