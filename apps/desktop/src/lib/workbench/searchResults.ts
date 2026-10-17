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
};

export type FileMatches = { path: string; matches: TextMatch[] };

/** Mirrors Rust `search::SearchEvent`. */
export type SearchEvent =
	| ({ kind: 'file' } & FileMatches)
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
};

export type ResultRow =
	| { kind: 'file'; key: string; file: FileMatches; collapsed: boolean }
	| { kind: 'match'; key: string; file: FileMatches; match: TextMatch };

/** The flattened tree in display order: each file row, then its matches unless collapsed. */
export function flattenResults(files: FileMatches[], collapsed: ReadonlySet<string>): ResultRow[] {
	const rows: ResultRow[] = [];
	for (const file of files) {
		const isCollapsed = collapsed.has(file.path);
		rows.push({ kind: 'file', key: file.path, file, collapsed: isCollapsed });
		if (isCollapsed) continue;
		file.matches.forEach((match, i) => rows.push({ kind: 'match', key: `${file.path}\u0000${i}`, file, match }));
	}
	return rows;
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
