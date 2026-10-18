// Pure parts of the Explorer's multi-select, clipboard and drag and drop (VS Code:
// contrib/files/browser/views/explorerViewer.ts FileDragAndDrop, fileActions.ts paste), kept free
// of runes so they are unit-testable. Paths are workspace-relative; '' is the root.

import { baseName, isUnder, joinRel, parentOf } from './fileTree';

/** VS Code's `incrementFileName` (simple): `a.ts` → `a copy.ts` → `a copy 2.ts`. Rust (fileops.rs) does the same when it writes. */
export function incrementFileName(name: string, isDir: boolean): string {
	const dot = name.lastIndexOf('.');
	const [stem, ext] = !isDir && dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
	const m = /^(.+ copy)( (\d+))?$/.exec(stem);
	if (m) return `${m[1]} ${m[3] ? Number(m[3]) + 1 : 2}${ext}`;
	return `${stem} copy${ext}`;
}

/** The name a paste of `name` into a folder holding `existing` gets (VS Code's findValidPasteFileTarget). */
export function pasteName(name: string, isDir: boolean, existing: ReadonlySet<string>): string {
	let candidate = name;
	while (existing.has(candidate)) candidate = incrementFileName(candidate, isDir);
	return candidate;
}

/** Drops paths that lie inside another selected path (moving `a/` already moves `a/b.ts`). */
export function topLevel(paths: readonly string[]): string[] {
	const unique = [...new Set(paths)].filter((p) => p !== '');
	return unique.filter((p) => !unique.some((q) => q !== p && isUnder(p, q)));
}

export type Transfer = { from: string; to: string };

/**
 * What a move (cut/paste, drag) or copy (copy/paste, ⌥-drag) of `paths` into `target` does.
 * Moves skip items already in `target` and refuse a folder into itself; copies of a folder into
 * itself are refused too. `to` is the intended path (Rust picks a `copy` name on a clash).
 */
export function planTransfer(paths: readonly string[], target: string, copy: boolean): { ops: Transfer[]; refused: string[] } {
	const ops: Transfer[] = [];
	const refused: string[] = [];
	for (const from of topLevel(paths)) {
		if (isUnder(target, from)) {
			refused.push(from);
			continue;
		}
		if (!copy && parentOf(from) === target) continue;
		ops.push({ from, to: joinRel(target, baseName(from)) });
	}
	return { ops, refused };
}

/** The folder a drop or paste lands in: a folder row itself, a file's folder. */
export const dropTarget = (rel: string | null, isDir: boolean): string => (rel === null ? '' : isDir ? rel : parentOf(rel));

/** ⇧-click / ⇧-arrow: every row between the anchor and `to`, in display order. */
export function rangeSelection(rows: readonly string[], anchor: string | null, to: string): string[] {
	const a = anchor === null ? -1 : rows.indexOf(anchor);
	const b = rows.indexOf(to);
	if (b < 0) return [];
	if (a < 0) return [to];
	const [lo, hi] = a < b ? [a, b] : [b, a];
	return rows.slice(lo, hi + 1);
}

/**
 * explorer.compactFolders: from `start`, follow folders whose only visible child is a folder.
 * `childrenOf` returns null for a folder not loaded yet (the chain stops there).
 */
export function compactChain(start: string, childrenOf: (rel: string) => readonly { rel: string; is_dir: boolean }[] | null): string[] {
	const chain = [start];
	for (;;) {
		const kids = childrenOf(chain[chain.length - 1]);
		if (!kids || kids.length !== 1 || !kids[0].is_dir) return chain;
		chain.push(kids[0].rel);
	}
}

/** The label of a compacted row: `a/b/c` from the chain's names. */
export const compactLabel = (chain: readonly string[]) => chain.map(baseName).join('/');

/** "Move 'a.ts' into 'src'?" / "Move the following 3 files into 'src'?" (VS Code's confirmDragAndDrop text). */
export function moveQuestion(paths: readonly string[], target: string, root: string): string {
	const into = target ? baseName(target) : root;
	return paths.length === 1
		? `ย้าย '${baseName(paths[0])}' ไปไว้ใน '${into}'? (Are you sure you want to move '${baseName(paths[0])}' into '${into}'?)`
		: `ย้าย ${paths.length} รายการต่อไปนี้ไปไว้ใน '${into}'? (Are you sure you want to move the following ${paths.length} files into '${into}'?)\n\n${paths.map(baseName).join('\n')}`;
}

/**
 * explorer.copyPathSeparator / explorer.copyRelativePathSeparator: `auto` keeps the platform's
 * separator (`/` on macOS and Linux); `\` writes Windows-style paths.
 */
export function withPathSeparator(path: string, separator: string): string {
	return separator === '\\' ? path.replaceAll('/', '\\') : path;
}

/**
 * explorer.autoReveal (`true`, `false` or `"focusNoScroll"`) and explorer.autoRevealExclude:
 * whether opening `rel` selects it in the Explorer, and whether the row scrolls into view.
 * `excluded` says whether a glob of autoRevealExclude matches `rel` or a folder above it.
 */
export function autoRevealOf(setting: unknown, excluded: boolean): { reveal: boolean; scroll: boolean } {
	if (excluded || (setting !== true && setting !== 'focusNoScroll')) return { reveal: false, scroll: false };
	return { reveal: true, scroll: setting === true };
}
