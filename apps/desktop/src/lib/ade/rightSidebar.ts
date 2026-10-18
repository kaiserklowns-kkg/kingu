// Pure parts of the ADE's right side bar (Orca's right sidebar): the tab list, the Files tab's
// name filter over the whole worktree, the Contents search results grouped per file, and the
// tree's ignored / git decorations. Free of runes so `bun test` covers them.

import type { Decoration } from '#lib/workbench/scm.ts';
import type { FileMatches, TextMatch } from '#lib/workbench/searchResults.ts';

export type RightTab = 'files' | 'search' | 'changes' | 'checks';

export type RightTabInfo = { id: RightTab; label: string; icon: 'files' | 'search' | 'git' | 'tasks'; key: string };

/** Orca's order: Explorer, Search, Source Control, Checks. `key` is the shortcut that shows the tab. */
export const RIGHT_TABS: RightTabInfo[] = [
	{ id: 'files', label: 'Explorer', icon: 'files', key: 'cmd+shift+e' },
	{ id: 'search', label: 'Search', icon: 'search', key: 'cmd+shift+f' },
	{ id: 'changes', label: 'Source Control', icon: 'git', key: 'ctrl+shift+g' },
	{ id: 'checks', label: 'Checks', icon: 'tasks', key: 'cmd+shift+k' }
];

export const isRightTab = (v: unknown): v is RightTab => RIGHT_TABS.some((t) => t.id === v);

/**
 * A tab shortcut: shows that tab (and the side bar); pressed again while the tab is already in
 * front, it hides the side bar (VS Code / Orca toggle a view the same way).
 */
export function toggleTab(state: { visible: boolean; tab: RightTab }, tab: RightTab): { visible: boolean; tab: RightTab } {
	if (state.visible && state.tab === tab) return { visible: false, tab };
	return { visible: true, tab };
}

/** Case- and form-insensitive text for matching (Thai typed in NFD still matches NFC names). */
export const fold = (s: string) => s.normalize('NFC').toLocaleLowerCase();

export type NameRow = { rel: string; name: string; depth: number; is_dir: boolean };

/**
 * Files › Names: every file of the worktree whose name contains `query`, shown as a tree with
 * the folders above each match (always expanded). `files` are worktree-relative; folders whose
 * own name matches bring nothing extra (Orca filters files, folders are only context). At most
 * `limit` files are kept, so a one-letter query in a huge tree stays responsive.
 */
export function nameMatches(files: string[], query: string, limit = 2000): { rows: NameRow[]; total: number } {
	const q = fold(query.trim());
	if (!q) return { rows: [], total: 0 };
	const hits: string[] = [];
	let total = 0;
	for (const f of files) {
		if (!fold(f.slice(f.lastIndexOf('/') + 1)).includes(q)) continue;
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

/** How a tree row looks: ignored entries dim with a badge (no git letter); else the git decoration. */
export type RowLook = { ignored: true } | { ignored: false; deco: Decoration | undefined };

export function rowLook(rel: string, ignored: boolean | undefined, decorations: ReadonlyMap<string, Decoration>, ignoredDirs: ReadonlySet<string> = new Set()): RowLook {
	if (ignored) return { ignored: true };
	// Inside an ignored folder everything is ignored too (git check-ignore only marked the folder).
	for (let i = rel.lastIndexOf('/'); i > 0; i = rel.lastIndexOf('/', i - 1)) if (ignoredDirs.has(rel.slice(0, i))) return { ignored: true };
	return { ignored: false, deco: decorations.get(rel) };
}
