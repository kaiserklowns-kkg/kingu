// Pure path helpers for the Explorer's file operations and the file watcher, kept free of runes
// so they are unit-testable. Paths are workspace-relative and `/`-separated; '' is the root.

import { DIFF_PREFIX, fileOf, isDiffKey, isTaskDiffKey } from './scm';
import { t } from '#lib/i18n/index.ts';

export function parentOf(rel: string): string {
	const i = rel.lastIndexOf('/');
	return i < 0 ? '' : rel.slice(0, i);
}

export function baseName(rel: string): string {
	return rel.slice(rel.lastIndexOf('/') + 1);
}

export function joinRel(dir: string, name: string): string {
	return dir ? `${dir}/${name}` : name;
}

/** True when `rel` is `ancestor` or lies under it ('' contains everything). */
export function isUnder(rel: string, ancestor: string): boolean {
	return ancestor === '' || rel === ancestor || rel.startsWith(ancestor + '/');
}

/**
 * VS Code's `validateFileName`: the text typed into the new/rename box. `a/b/c.txt` is allowed
 * (creates folders); empty segments, `.`/`..`, leading slashes and surrounding spaces are not.
 * Returns an error message or null.
 */
export function validateName(input: string): string | null {
	if (!input || !input.trim()) return t('workbench.fileTree.nameRequired');
	if (input !== input.trim()) return t('workbench.fileTree.whitespace');
	if (input.startsWith('/') || input.includes('\\')) return t('workbench.fileTree.relativeOnly');
	for (const seg of input.split('/')) {
		if (!seg) return t('workbench.fileTree.emptySegment');
		if (seg === '.' || seg === '..') return t('workbench.fileTree.reservedName', { name: seg });
	}
	return null;
}

/** Where `path` (a tab key: a file or `diff:<file>`) moves when `from` is renamed to `to`; null if unaffected. */
export function remapPath(path: string, from: string, to: string): string | null {
	// A task diff names a file inside its worktree, which an Explorer rename never moves.
	if (isTaskDiffKey(path)) return null;
	const file = fileOf(path);
	if (!isUnder(file, from) || from === '') return null;
	const moved = to + file.slice(from.length);
	return isDiffKey(path) ? DIFF_PREFIX + moved : moved;
}

/** Tab keys (files or diffs) that point at `rel` or anything under it. */
export function affectedBy(paths: string[], rel: string): string[] {
	return paths.filter((p) => rel !== '' && isUnder(fileOf(p), rel));
}

/**
 * Directories to re-list after the watcher reported `changed`: the parent of each change, plus a
 * changed path that is itself a loaded directory (deleted or replaced). Only loaded directories
 * are re-read; `''` in `changed` (a rescan) re-reads all of them.
 */
export function dirsToRefresh(changed: string[], loaded: Iterable<string>): string[] {
	const have = new Set(loaded);
	if (changed.includes('')) return [...have].sort();
	const out = new Set<string>();
	for (const p of changed) {
		const parent = parentOf(p);
		if (have.has(parent)) out.add(parent);
		if (have.has(p)) out.add(p);
	}
	return [...out].sort();
}

/** Watcher paths that matter to the Explorer and editors (git's own files only refresh SCM). */
export function workspaceFiles(changed: string[]): string[] {
	return changed.filter((p) => p !== '.git' && !p.startsWith('.git/'));
}

/** VS Code's recent list label: folder name, then the parent path with the home folder as `~`. */
export function recentLabel(path: string, home = ''): { label: string; detail: string } {
	const i = path.lastIndexOf('/');
	const parent = i > 0 ? path.slice(0, i) : '/';
	const detail = home && (parent === home || parent.startsWith(home + '/')) ? '~' + parent.slice(home.length) : parent;
	return { label: path.slice(i + 1) || path, detail };
}

/** The name part to preselect when renaming (VS Code selects up to the last dot). */
export function stemLength(name: string, isDir: boolean): number {
	if (isDir) return name.length;
	const dot = name.lastIndexOf('.');
	return dot > 0 ? dot : name.length;
}
