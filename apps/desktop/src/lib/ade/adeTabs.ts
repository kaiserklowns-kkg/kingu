// Tabs of one worktree in the Agents layout (pure, so `bun test` can cover it).

import { fileOf, isTaskDiffKey, splitPath } from '#lib/workbench/scm.ts';

/** `title`: a task or agent name instead of "Terminal n"; `run`: the command typed into its shell. */
export type TerminalTab = { id: string; n: number; title?: string; run?: string[] };
/**
 * A file or task diff opened in the ADE center (Orca opens files next to the agent). `key` is a
 * workspace-relative path or a `taskdiff://<slug>/<rel>` key; a `preview` tab is replaced by the
 * next preview open, like VS Code's italic tabs.
 */
export type FileTab = { key: string; preview: boolean };
export type AdeTab =
	| { id: string; kind: 'agent' | 'compose' | 'terminal'; label: string }
	| { id: string; kind: 'file' | 'diff'; label: string; key: string; preview: boolean };

/** Prefixed so a file named like a terminal id (`t1`, `main`) cannot clash with it. */
export const fileTabId = (key: string) => `f:${key}`;
export const keyOfTabId = (id: string) => (id.startsWith('f:') ? id.slice(2) : null);

/** The main tab (the task's agent session, or the new-task composer for the folder), its terminals, then its files. */
export function adeTabs(key: string, terminals: TerminalTab[], files: FileTab[] = []): AdeTab[] {
	const main: AdeTab = key ? { id: 'main', kind: 'agent', label: 'Agent' } : { id: 'main', kind: 'compose', label: 'งานใหม่' };
	return [
		main,
		...terminals.map((t) => ({ id: t.id, kind: 'terminal' as const, label: t.title ?? `Terminal ${t.n}` })),
		...files.map((f) => ({
			id: fileTabId(f.key),
			kind: isTaskDiffKey(f.key) ? ('diff' as const) : ('file' as const),
			label: splitPath(fileOf(f.key))[0],
			key: f.key,
			preview: f.preview
		}))
	];
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
