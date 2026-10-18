// Pure parts of the ADE's right side bar (Orca's right sidebar): the tab list, the Files tab's
// name filter over the whole worktree, the Contents search results grouped per file, and the
// tree's ignored / git decorations. Free of runes so `bun test` covers them.

import { COLORS, type Decoration } from '#lib/workbench/scm.ts';
import type { FileMatches, TextMatch } from '#lib/workbench/searchResults.ts';

export type RightTab = 'files' | 'agents' | 'changes' | 'checks' | 'review';

export type RightTabInfo = { id: RightTab; label: string; icon: 'files' | 'agentsLayout' | 'git' | 'listChecks' | 'pullRequest'; key?: string; gitOnly?: boolean; taskOnly?: boolean };

/** Orca's tab strip: Explorer, Agents, Source Control, Checks (the last two only in a git repository),
 * then Kingu's own Review (accept, merge, PR), which only a task has. */
export const RIGHT_TABS: RightTabInfo[] = [
	{ id: 'files', label: 'Explorer', icon: 'files', key: 'cmd+shift+e' },
	{ id: 'agents', label: 'Agents', icon: 'agentsLayout' },
	{ id: 'changes', label: 'Source Control', icon: 'git', key: 'cmd+shift+g', gitOnly: true },
	{ id: 'checks', label: 'Checks', icon: 'listChecks', gitOnly: true },
	{ id: 'review', label: 'Review', icon: 'pullRequest', taskOnly: true }
];

export const isRightTab = (v: unknown): v is RightTab => RIGHT_TABS.some((t) => t.id === v);

/** Saved tabs per folder are capped at this many worktrees (the most recently set kept). */
export const SAVED_TABS_MAX = 200;

/** A saved `{ worktree: tab }` map read back: unknown tabs dropped, and the newest
 * `SAVED_TABS_MAX` worktrees kept (keys are in insertion order, newest last). */
export function cleanTabs(v: unknown): Record<string, RightTab> {
	if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
	const ok = Object.entries(v as Record<string, unknown>).filter((e): e is [string, RightTab] => isRightTab(e[1]));
	return Object.fromEntries(ok.slice(-SAVED_TABS_MAX));
}

/** The tabs a worktree shows, and the one in front (a hidden tab falls back to Explorer). */
export function visibleTabs(isGit: boolean, wanted: RightTab, isTask = false): { tabs: RightTabInfo[]; active: RightTab } {
	const tabs = RIGHT_TABS.filter((t) => (isGit || !t.gitOnly) && (isTask || !t.taskOnly));
	return { tabs, active: tabs.some((t) => t.id === wanted) ? wanted : 'files' };
}

/**
 * A tab shortcut: shows that tab (and the side bar); pressed again while the tab is already in
 * front, it hides the side bar (Orca's `sidebar.*.toggle`).
 */
export function toggleTab(state: { visible: boolean; tab: RightTab }, tab: RightTab): { visible: boolean; tab: RightTab } {
	if (state.visible && state.tab === tab) return { visible: false, tab };
	return { visible: true, tab };
}

/** Case- and form-insensitive text for matching (Thai typed in NFD still matches NFC names). */
export const fold = (s: string) => s.normalize('NFC').toLocaleLowerCase();

export type NameRow = { rel: string; name: string; depth: number; is_dir: boolean };

/**
 * Files › Names (Orca's file filter): the query splits on spaces and a file matches when every
 * part is in its worktree-relative path, case-insensitively (not fuzzy). Matches show as a tree
 * with their folders. At most `limit` files are kept, so a one-letter query stays responsive.
 */
export function nameMatches(files: string[], query: string, limit = 2000): { rows: NameRow[]; total: number } {
	const tokens = fold(query).split(/\s+/).filter(Boolean);
	if (!tokens.length) return { rows: [], total: 0 };
	const hits: string[] = [];
	let total = 0;
	for (const f of files) {
		const path = fold(f);
		if (!tokens.every((t) => path.includes(t))) continue;
		total++;
		if (hits.length < limit) hits.push(f);
	}
	return { rows: treeRows(hits), total };
}

/** Sorted tree rows for a flat list of file paths: folders first, then names, like the explorer. */
export function treeRows(files: string[]): NameRow[] {
	type Node = { dirs: Map<string, Node>; files: string[] };
	const root: Node = { dirs: new Map(), files: [] };
	for (const f of files) {
		const parts = f.split('/');
		let node = root;
		for (const p of parts.slice(0, -1)) {
			let next = node.dirs.get(p);
			if (!next) node.dirs.set(p, (next = { dirs: new Map(), files: [] }));
			node = next;
		}
		node.files.push(parts[parts.length - 1]);
	}
	const byName = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase());
	const out: NameRow[] = [];
	const walk = (node: Node, prefix: string, depth: number) => {
		for (const d of [...node.dirs.keys()].sort(byName)) {
			const rel = prefix + d;
			out.push({ rel, name: d, depth, is_dir: true });
			walk(node.dirs.get(d)!, rel + '/', depth + 1);
		}
		for (const f of [...node.files].sort(byName)) out.push({ rel: prefix + f, name: f, depth, is_dir: false });
	};
	walk(root, '', 0);
	return out;
}

export type ContentRow =
	| { kind: 'file'; key: string; path: string; name: string; dir: string; count: number; collapsed: boolean }
	| { kind: 'match'; key: string; path: string; match: TextMatch };

/**
 * Files › Contents: ripgrep results as file rows (name, folder, match count) each followed by
 * its matches unless collapsed; paths are worktree-relative.
 */
export function contentRows(files: FileMatches[], collapsed: ReadonlySet<string>): ContentRow[] {
	const rows: ContentRow[] = [];
	for (const f of files) {
		const i = f.path.lastIndexOf('/');
		const isCollapsed = collapsed.has(f.path);
		rows.push({ kind: 'file', key: f.path, path: f.path, name: f.path.slice(i + 1), dir: i < 0 ? '' : f.path.slice(0, i), count: f.matches.length, collapsed: isCollapsed });
		if (!isCollapsed) f.matches.forEach((match, n) => rows.push({ kind: 'match', key: `${f.path}\u0000${n}`, path: f.path, match }));
	}
	return rows;
}

/** "12 ผลใน 3 ไฟล์" plus a note when ripgrep stopped at the limit. */
export function contentSummary(files: FileMatches[], limitHit: boolean): string {
	const matches = files.reduce((n, f) => n + f.matches.length, 0);
	if (!files.length) return 'ไม่พบ';
	return `${matches} ผลใน ${files.length} ไฟล์${limitHit ? ' (แสดงเฉพาะส่วนแรก ลองค้นให้เจาะจงขึ้น)' : ''}`;
}

/**
 * Whether a watcher batch (workspace-relative paths) concerns worktree `slug` ('' = the folder
 * itself): its files, or its git metadata (`.git/worktrees/<slug>/` for a task, `.git/` else).
 * `''` in the batch is a rescan and concerns everyone.
 */
export function touchesWorktree(paths: string[], slug: string): boolean {
	return paths.some((p) => {
		if (p === '') return true;
		if (slug) return p === `.kingu/worktrees/${slug}` || p.startsWith(`.kingu/worktrees/${slug}/`) || p.startsWith(`.git/worktrees/${slug}/`);
		return p !== '.kingu' && !p.startsWith('.kingu/') && !p.startsWith('.git/worktrees/');
	});
}

/** The watcher paths that are files of worktree `slug`, still workspace-relative (to re-list folders). */
export function filesOf(paths: string[], slug: string): string[] {
	if (!slug) return paths.filter((p) => p !== '.git' && !p.startsWith('.git/') && !p.startsWith('.kingu/'));
	const dir = `.kingu/worktrees/${slug}`;
	return paths.filter((p) => p === '' || p === dir || p.startsWith(dir + '/'));
}

/** An argv as one line to paste into a shell (Copy Resume Command). */
export function shellJoin(argv: readonly string[]): string {
	return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`)).join(' ');
}

export type SessionSort = 'updated' | 'created';
type SessionLike = { meta: { slug: string; created_at: number; updated_at: number } };

/** Agents tab (Orca's session history): the sessions newest first, by last update or creation. */
export function sortSessions<T extends SessionLike>(views: readonly T[], by: SessionSort): T[] {
	const at = (v: T) => (by === 'created' ? v.meta.created_at : v.meta.updated_at);
	return [...views].sort((a, b) => at(b) - at(a) || a.meta.slug.localeCompare(b.meta.slug));
}

/** How a tree row looks: ignored entries dim with a badge (no git letter); else the git decoration. */
export type RowLook = { ignored: true } | { ignored: false; deco: Decoration | undefined };

export function rowLook(
	rel: string,
	ignored: boolean | undefined,
	decorations: ReadonlyMap<string, Decoration>,
	ignoredDirs: ReadonlySet<string> = new Set(),
	untracked = false
): RowLook {
	if (ignored) return { ignored: true };
	// Inside an ignored folder everything is ignored too (git check-ignore only marked the folder).
	for (let i = rel.lastIndexOf('/'); i > 0; i = rel.lastIndexOf('/', i - 1)) if (ignoredDirs.has(rel.slice(0, i))) return { ignored: true };
	// A folder with nothing tracked gets Orca's `U`, not the dot of a folder with changes inside.
	if (untracked) return { ignored: false, deco: { letter: 'U', color: COLORS.added } };
	return { ignored: false, deco: decorations.get(rel) };
}
