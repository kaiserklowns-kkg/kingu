// Search view model helpers (VS Code: searchModel.ts / searchResultsView.ts), kept free of
// Svelte runes so they can be unit-tested with `bun test`.

/** Mirrors Rust `search::TextMatch`. Columns are 1-based UTF-16, like Monaco's. */
export type TextMatch = {
	line: number;
	column: number;
	end_column: number;
	preview: string;
	preview_start: number;
	preview_end: number;
	/** The whole matched text (the preview may elide it). */
	text: string;
};

/** `version` fingerprints the file as searched; Replace refuses the file once it differs.
 * `modified`: the file's mtime (ms), for `search.sortOrder: modified`. */
export type FileMatches = { path: string; matches: TextMatch[]; version?: string; modified?: number };

/** Mirrors Rust `search::SearchEvent`. */
export type SearchEvent =
	| { kind: 'file'; path: string; matches: TextMatch[]; version: string; modified: number }
	| { kind: 'done'; files: number; matches: number; limit_hit: boolean; elapsed_ms: number }
	| { kind: 'error'; message: string };

export type SearchOptions = {
	query: string;
	is_regex: boolean;
	match_case: boolean;
	whole_word: boolean;
	include: string;
	exclude: string;
	use_ignore_files: boolean;
	max_results?: number;
	/** From settings (mappings.searchSettingsFrom): files.exclude + search.exclude globs and ripgrep flags. */
	exclude_globs?: string[];
	follow_symlinks?: boolean;
	smart_case?: boolean;
	use_global_ignore?: boolean;
	use_parent_ignore?: boolean;
	max_threads?: number;
	/** kingu.search.smart (Rust smart_search.rs). */
	smart?: boolean;
};

export type ResultRow =
	| { kind: 'folder'; key: string; path: string; depth: number; collapsed: boolean }
	| { kind: 'file'; key: string; file: FileMatches; collapsed: boolean; depth: number }
	| { kind: 'match'; key: string; file: FileMatches; match: TextMatch; depth: number };

export type ViewMode = 'list' | 'tree';

/** The collapse key of a folder row in the tree view (files use their path). */
export const folderKey = (path: string) => `\u0000dir:${path}`;

/**
 * The flattened results in display order. `list` (search.defaultViewMode): each file, then its
 * matches unless collapsed. `tree`: files under their folders, each folder a collapsible row.
 */
export function flattenResults(files: FileMatches[], collapsed: ReadonlySet<string>, mode: ViewMode = 'list'): ResultRow[] {
	const rows: ResultRow[] = [];
	const pushFile = (file: FileMatches, depth: number) => {
		const isCollapsed = collapsed.has(file.path);
		rows.push({ kind: 'file', key: file.path, file, collapsed: isCollapsed, depth });
		if (isCollapsed) return;
		file.matches.forEach((match, i) => rows.push({ kind: 'match', key: `${file.path}\u0000${i}`, file, match, depth: depth + 1 }));
	};
	if (mode === 'list') {
		for (const file of files) pushFile(file, 0);
		return rows;
	}
	// Tree: folders in the order their first file appears (the sort order), then their files.
	type Node = { dirs: Map<string, Node>; files: FileMatches[] };
	const root: Node = { dirs: new Map(), files: [] };
	for (const file of files) {
		let node = root;
		let path = '';
		for (const part of dirname(file.path).split('/').filter(Boolean)) {
			path = path ? `${path}/${part}` : part;
			let next = node.dirs.get(path);
			if (!next) node.dirs.set(path, (next = { dirs: new Map(), files: [] }));
			node = next;
		}
		node.files.push(file);
	}
	const walk = (node: Node, depth: number) => {
		for (const [path, child] of node.dirs) {
			const isCollapsed = collapsed.has(folderKey(path));
			rows.push({ kind: 'folder', key: folderKey(path), path, depth, collapsed: isCollapsed });
			if (!isCollapsed) walk(child, depth + 1);
		}
		for (const file of node.files) pushFile(file, depth);
	};
	walk(root, 0);
	return rows;
}

export type ResultSortOrder = 'default' | 'fileNames' | 'type' | 'modified' | 'countDescending' | 'countAscending';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const extOf = (path: string) => {
	const name = basename(path);
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(dot + 1) : '';
};
/** Folder by folder, then the file name (VS Code's comparePaths). */
const byPath = (a: string, b: string) => {
	const pa = a.split('/');
	const pb = b.split('/');
	for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
		const aLast = i === pa.length - 1;
		const bLast = i === pb.length - 1;
		// A file in a folder comes before the folder's sub-folders.
		if (aLast !== bLast) return aLast ? -1 : 1;
		const c = collator.compare(pa[i], pb[i]);
		if (c) return c;
	}
	return pa.length - pb.length;
};

/** `search.sortOrder` (VS Code's searchMatchComparer): the order of the result files. */
export function sortResults(files: readonly FileMatches[], order: ResultSortOrder): FileMatches[] {
	const name = (f: FileMatches) => basename(f.path);
	const cmp: Record<ResultSortOrder, (a: FileMatches, b: FileMatches) => number> = {
		default: (a, b) => byPath(a.path, b.path),
		fileNames: (a, b) => collator.compare(name(a), name(b)) || byPath(a.path, b.path),
		type: (a, b) => collator.compare(extOf(a.path), extOf(b.path)) || collator.compare(name(a), name(b)) || byPath(a.path, b.path),
		modified: (a, b) => (b.modified ?? 0) - (a.modified ?? 0) || byPath(a.path, b.path),
		countDescending: (a, b) => b.matches.length - a.matches.length || byPath(a.path, b.path),
		countAscending: (a, b) => a.matches.length - b.matches.length || byPath(a.path, b.path)
	};
	return [...files].sort(cmp[order] ?? cmp.default);
}

/** `search.collapseResults`: whether a new result file starts collapsed (`auto`: over 10 matches, like VS Code). */
export function startsCollapsed(setting: string, matches: number): boolean {
	return setting === 'alwaysCollapse' || (setting === 'auto' && matches > 10);
}

/** VS Code's result message, e.g. "3 results in 2 files". */
export function summarize(matches: number, files: number): string {
	const r = matches === 1 ? '1 result' : `${matches} results`;
	const f = files === 1 ? '1 file' : `${files} files`;
	return `${r} in ${f}`;
}

/** Splits a preview around its highlighted match (JS strings index UTF-16 units, as Rust sends). */
export function splitPreview(m: TextMatch): { before: string; match: string; after: string } {
	return {
		before: m.preview.slice(0, m.preview_start),
		match: m.preview.slice(m.preview_start, m.preview_end),
		after: m.preview.slice(m.preview_end)
	};
}

export function basename(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}

export function dirname(path: string): string {
	const i = path.lastIndexOf('/');
	return i < 0 ? '' : path.slice(0, i);
}

/** VS Code seeds Find in Files from the editor selection only when it is a single line. */
export function seedFromSelection(selection: string): string | null {
	if (!selection || /[\r\n]/.test(selection)) return null;
	return selection;
}

// --- Replace ---------------------------------------------------------------------------------

/** Mirrors Rust `replace::ReplaceEdit`: 1-based line, UTF-16 columns of the text before. */
export type ReplaceEdit = { line: number; column: number; end_column: number; text: string };

/** Mirrors Rust `replace::FileResult`. */
export type ReplaceResult = {
	path: string;
	outcome: 'written' | 'edits' | 'stale' | 'failed';
	replaced: number;
	edits: ReplaceEdit[];
	version: string | null;
	message: string | null;
};

/** Moves matches that follow replaced text to where that text now ends (VS Code keeps the other
 * results of a file valid after replacing one). `edits` must not overlap `matches`. */
export function rebaseMatches(matches: TextMatch[], edits: ReplaceEdit[]): TextMatch[] {
	// Last edit first: a later edit never moves an earlier one's coordinates.
	const sorted = [...edits].sort((a, b) => b.line - a.line || b.column - a.column);
	return matches.map((m) => {
		let { line, column, end_column } = m;
		for (const e of sorted) {
			const lines = e.text.split(/\r\n|\r|\n/);
			const added = lines.length - 1;
			if (line === e.line && column >= e.end_column) {
				const lastLen = lines[added].length;
				const start = added ? lastLen + 1 : e.column + lastLen;
				const shift = start - e.end_column;
				line += added;
				column += shift;
				end_column += shift;
			} else if (line > e.line) line += added;
		}
		return line === m.line && column === m.column ? m : { ...m, line, column, end_column };
	});
}

/** What a match becomes, for the results preview. Regex mode uses JavaScript's replace (the
 * same `$1`/`$&` rules Rust applies); a pattern JavaScript cannot compile shows the raw text. */
export function previewReplacement(matched: string, replace: string, opts: { isRegex: boolean; matchCase: boolean; query: string }): string {
	if (!opts.isRegex) return replace;
	try {
		const re = new RegExp(`^(?:${opts.query})$`, opts.matchCase ? 'u' : 'iu');
		const template = replace.replace(/\\(n|t|\\)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : '\\'));
		return re.test(matched) ? matched.replace(re, template) : replace;
	} catch {
		return replace;
	}
}

/** "Replace 3 occurrences across 2 files with 'x'?" */
export function replaceConfirmText(matches: number, files: number, replace: string): string {
	const o = matches === 1 ? '1 occurrence' : `${matches} occurrences`;
	const f = files === 1 ? '1 file' : `${files} files`;
	return replace ? `Replace ${o} across ${f} with '${replace}'?` : `Replace ${o} across ${f} with nothing (delete)?`;
}
