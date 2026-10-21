// Search Editor (VS Code: contrib/searchEditor): the editor keys, the `.code-search` format and the
// results text, kept free of Svelte runes so `bun test` checks them. The format follows VS Code's
// searchEditorSerialization.ts: a `# Key: value` header, a blank line, then the results text that
// the editor shows (`N results - M files`, a blank line, and one block per file).

import type { TextMatch } from './searchResults';

/** VS Code's SearchConfiguration, without the notebook and open-editors options Kingu has no use for. */
export type SearchConfig = {
	query: string;
	filesToInclude: string;
	filesToExclude: string;
	contextLines: number;
	matchWholeWord: boolean;
	isCaseSensitive: boolean;
	isRegexp: boolean;
	useExcludeSettingsAndIgnoreFiles: boolean;
	showIncludesExcludes: boolean;
};

/** Mirrors Rust `search::FileLine`: a whole result or context line of a Search Editor result. */
export type FileLine = { line: number; text: string; is_match: boolean };
/** One file of a Search Editor search: its matches and its result and context lines in line order. */
export type EditorFile = { path: string; matches: TextMatch[]; lines: FileLine[] };
/** A 1-based range in the results text (Monaco's IRange). */
export type MatchRange = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };

export const SEARCH_EDITOR_EXT = '.code-search';
/** Editor key of an untitled Search Editor: `search-editor:<n>`. */
export const SEARCH_EDITOR_PREFIX = 'search-editor:';
export const untitledSearchEditorKey = (n: number) => `${SEARCH_EDITOR_PREFIX}${n}`;
export const isUntitledSearchEditor = (key: string) => key.startsWith(SEARCH_EDITOR_PREFIX);
/** A workspace `.code-search` file opens in the Search Editor, like VS Code's editor resolver. */
export const isSearchFilePath = (key: string) => !key.includes(':') && key.toLowerCase().endsWith(SEARCH_EDITOR_EXT);
export const isSearchEditorKey = (key: string) => isUntitledSearchEditor(key) || isSearchFilePath(key);

export const defaultSearchConfig = (): SearchConfig => ({
	query: '',
	filesToInclude: '',
	filesToExclude: '',
	isRegexp: false,
	isCaseSensitive: false,
	useExcludeSettingsAndIgnoreFiles: true,
	matchWholeWord: false,
	contextLines: 0,
	showIncludesExcludes: false
});

const lineDelimiter = '\n';

/** The `# Query:` … header, ending with its blank line (VS Code's serializeSearchConfiguration). */
export function serializeSearchConfiguration(config: Partial<SearchConfig>): string {
	const escapeNewlines = (str: string) => str.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
	const flags = [config.isCaseSensitive && 'CaseSensitive', config.matchWholeWord && 'WordMatch', config.isRegexp && 'RegExp', config.useExcludeSettingsAndIgnoreFiles === false && 'IgnoreExcludeSettings'].filter(Boolean);
	return [
		`# Query: ${escapeNewlines(config.query ?? '')}`,
		flags.length ? `# Flags: ${flags.join(' ')}` : undefined,
		config.filesToInclude ? `# Including: ${config.filesToInclude}` : undefined,
		config.filesToExclude ? `# Excluding: ${config.filesToExclude}` : undefined,
		config.contextLines ? `# ContextLines: ${config.contextLines}` : undefined,
		''
	]
		.filter((l) => l !== undefined)
		.join(lineDelimiter);
}

/** Thrown for a query with a lone backslash (VS Code: "All backslashes in Query string must be escaped"). */
export class InvalidQueryError extends Error {}

/** The configuration from header lines (VS Code's extractSearchQueryFromLines). */
export function extractSearchQueryFromLines(lines: string[]): SearchConfig {
	const query = defaultSearchConfig();
	const unescapeNewlines = (str: string) => {
		let out = '';
		for (let i = 0; i < str.length; i++) {
			if (str[i] !== '\\') {
				out += str[i];
				continue;
			}
			i++;
			if (str[i] === 'n') out += '\n';
			else if (str[i] === '\\') out += '\\';
			else throw new InvalidQueryError('All backslashes in Query string must be escaped (\\\\)');
		}
		return out;
	};
	const parseYML = /^# ([^:]*): (.*)$/;
	for (const line of lines) {
		const parsed = parseYML.exec(line);
		if (!parsed) continue;
		const [, key, value] = parsed;
		switch (key) {
			case 'Query':
				query.query = unescapeNewlines(value);
				break;
			case 'Including':
				query.filesToInclude = value;
				break;
			case 'Excluding':
				query.filesToExclude = value;
				break;
			case 'ContextLines':
				query.contextLines = +value || 0;
				break;
			case 'Flags':
				query.isRegexp = value.includes('RegExp');
				query.isCaseSensitive = value.includes('CaseSensitive');
				query.useExcludeSettingsAndIgnoreFiles = !value.includes('IgnoreExcludeSettings');
				query.matchWholeWord = value.includes('WordMatch');
		}
	}
	query.showIncludesExcludes = !!(query.filesToInclude || query.filesToExclude || !query.useExcludeSettingsAndIgnoreFiles);
	return query;
}

/** A saved `.code-search` file: its configuration and the results text after the header. */
export function parseSerializedSearchEditor(text: string): { config: SearchConfig; text: string } {
	const header: string[] = [];
	const body: string[] = [];
	let inHeader = true;
	for (const line of text.split(/\r?\n/g)) {
		if (inHeader) {
			header.push(line);
			if (line === '') inHeader = false;
		} else body.push(line);
	}
	return { config: extractSearchQueryFromLines(header), text: body.join('\n') };
}

/** What a `.code-search` file holds (VS Code's serializeForDisk). */
export const serializeForDisk = (config: Partial<SearchConfig>, results: string) => serializeSearchConfiguration(config) + '\n' + results;

/**
 * A Search Editor is dirty when what it would save (query, options and the results text, which the
 * user can edit) differs from what it last saved or opened with (VS Code: SearchEditorInput.isDirty).
 */
export const searchEditorDirty = (saved: string, config: Partial<SearchConfig>, results: string) => serializeForDisk(config, results) !== saved;

export type ResultLabels = {
	results: (count: number) => string;
	files: (count: number) => string;
	noResults: string;
	limitHit: string;
};

/** VS Code's English labels (its localize defaults). */
export const ENGLISH_LABELS: ResultLabels = {
	results: (n) => (n > 1 ? `${n} results` : '1 result'),
	files: (n) => (n > 1 ? `${n} files` : '1 file'),
	noResults: 'No Results',
	limitHit: 'The result set only contains a subset of all matches. Be more specific in your search to narrow down the results.'
};

/** One file's block (VS Code's matchesToSearchResultFormat): `path:`, then `  12: text` results and `  13  text` context. */
function fileBlock(file: EditorFile): { text: string[]; ranges: MatchRange[] } {
	const matchLines = file.lines.filter((l) => l.is_match);
	const lastMatch = matchLines.length ? matchLines[matchLines.length - 1].line : Math.max(0, ...file.matches.map((m) => m.line));
	const width = `${lastMatch}`.length;
	const text = [`${file.path}:`];
	const ranges: MatchRange[] = [];
	// Without whole lines (a Search view result), each match line shows its preview.
	const lines: FileLine[] = file.lines.length
		? file.lines
		: [...new Map(file.matches.map((m) => [m.line, { line: m.line, text: m.preview, is_match: true }])).values()];
	const context = lines.filter((l) => !l.is_match);
	let last: number | undefined;
	for (const l of lines.filter((x) => x.is_match)) {
		while (context.length && context[0].line < l.line) {
			const c = context.shift()!;
			if (last !== undefined && c.line !== last + 1) text.push('');
			text.push(`  ${' '.repeat(width - `${c.line}`.length)}${c.line}  ${c.text}`);
			last = c.line;
		}
		const prefix = `  ${' '.repeat(width - `${l.line}`.length)}${l.line}: `;
		text.push(prefix + l.text);
		const row = text.length;
		for (const m of file.matches.filter((x) => x.line === l.line)) {
			// A preview line (no whole lines) starts where the preview does.
			const start = file.lines.length ? m.column : m.preview_start + 1;
			const end = file.lines.length ? m.end_column : m.preview_end + 1;
			const max = l.text.length + 1;
			ranges.push({ startLineNumber: row, startColumn: Math.min(start, max) + prefix.length, endLineNumber: row, endColumn: Math.min(end, max) + prefix.length });
		}
		last = l.line;
	}
	// VS Code writes trailing context without the padding.
	for (const c of context) text.push(`  ${c.line}  ${c.text}`);
	return { text, ranges };
}

/** The results text and its match ranges (VS Code's serializeSearchResultForEditor). */
export function serializeSearchResults(files: EditorFile[], { limitHit = false, labels = ENGLISH_LABELS }: { limitHit?: boolean; labels?: ResultLabels } = {}): { text: string; matchRanges: MatchRange[] } {
	const count = files.reduce((n, f) => n + f.matches.length, 0);
	const info = [count ? `${labels.results(count)} - ${labels.files(files.length)}` : labels.noResults];
	if (limitHit) info.push(labels.limitHit);
	info.push('');
	const text = [...info];
	const matchRanges: MatchRange[] = [];
	for (const file of files) {
		const block = fileBlock(file);
		const offset = text.length;
		for (const r of block.ranges) matchRanges.push({ ...r, startLineNumber: r.startLineNumber + offset, endLineNumber: r.endLineNumber + offset });
		text.push(...block.text, '');
	}
	return { text: text.join(lineDelimiter), matchRanges };
}

const FILE_LINE_REGEX = /^(\S.*):$/;
const RESULT_LINE_REGEX = /^(\s+)(\d+)(: |  )(\s*)(.*)$/;
const ELISION_REGEX = /⟪ ([0-9]+) characters skipped ⟫/;

export type ResultLocation = { kind: 'file'; path: string } | { kind: 'line'; path: string; line: number; column: number; isMatch: boolean };

/**
 * Where a position in the results text points (VS Code's search-result extension): a `path:` line
 * is the file, a result or context line is that line of the file below the nearest `path:` line;
 * the column is the clicked column in the source line.
 */
export function locationAt(lines: readonly string[], lineNumber: number, column = 1): ResultLocation | null {
	const line = lines[lineNumber - 1];
	if (line === undefined) return null;
	const file = FILE_LINE_REGEX.exec(line);
	if (file) return { kind: 'file', path: file[1] };
	const result = RESULT_LINE_REGEX.exec(line);
	if (!result) return null;
	let path: string | null = null;
	for (let i = lineNumber - 2; i >= 0; i--) {
		const above = FILE_LINE_REGEX.exec(lines[i]);
		if (above) {
			path = above[1];
			break;
		}
		if (lines[i] !== '' && !RESULT_LINE_REGEX.test(lines[i])) break;
	}
	if (path === null) return null;
	const [, indentation, num, separator] = result;
	const offset = (indentation + num + separator).length;
	const body = line.slice(offset);
	const elided = ELISION_REGEX.exec(body);
	const max = (elided ? elided.index : body.length) + 1;
	return { kind: 'line', path, line: +num, column: Math.max(1, Math.min(column - offset, max)), isMatch: separator === ': ' };
}

/**
 * Delete File Results (⇧⌘⌫): the lines of every file block a selection touches, from its `path:`
 * line down to the next unindented line (VS Code's deleteResultBlock). Returns the lines left.
 */
export function deleteFileResults(lines: readonly string[], selections: readonly { startLineNumber: number; endLineNumber: number }[], ranges: readonly MatchRange[] = []): { lines: string[]; ranges: MatchRange[] } {
	const gone = linesToDelete(lines, selections);
	// Match ranges move up with the lines left above them.
	const moved = new Map<number, number>();
	let next = 1;
	for (let n = 1; n <= lines.length; n++) if (!gone.has(n)) moved.set(n, next++);
	return {
		lines: lines.filter((_, i) => !gone.has(i + 1)),
		ranges: ranges.flatMap((r) => {
			const line = moved.get(r.startLineNumber);
			return line === undefined ? [] : [{ ...r, startLineNumber: line, endLineNumber: line + (r.endLineNumber - r.startLineNumber) }];
		})
	};
}

function linesToDelete(lines: readonly string[], selections: readonly { startLineNumber: number; endLineNumber: number }[]): Set<number> {
	const gone = new Set<number>();
	const max = lines.length;
	const unindented = (n: number) => lines[n - 1][0] !== undefined && lines[n - 1][0] !== ' ';
	for (const s of selections) {
		const start = Math.max(1, Math.min(s.startLineNumber, max));
		gone.add(start);
		for (let n = start + 1; n <= max && !unindented(n); n++) gone.add(n);
		for (let n = start; n >= 1; n--) {
			gone.add(n);
			if (unindented(n)) break;
		}
		for (let n = start; n <= Math.min(s.endLineNumber, max); n++) gone.add(n);
	}
	return gone;
}

/** VS Code's tab name: `Search: <file name>` for a saved search, else `Search: <query>` (cut at 12), else `Search`. */
export function searchEditorName(key: string, query: string, maxLength = 12): string {
	if (isSearchFilePath(key)) {
		const base = key.slice(key.lastIndexOf('/') + 1);
		return `Search: ${base.slice(0, base.length - SEARCH_EDITOR_EXT.length)}`;
	}
	const q = query.trim();
	if (!q) return 'Search';
	return `Search: ${q.length < maxLength ? q : `${q.slice(0, maxLength - 3)}...`}`;
}

/** A file name for Save As: the query, without characters file systems refuse. */
export function suggestedSearchFileName(query: string): string {
	const base = query.trim().replace(/[\\/:*?"<>|\s]+/g, ' ').trim().slice(0, 60);
	return `${base || 'Search'}${SEARCH_EDITOR_EXT}`;
}

/** Increase / Decrease Context Lines (VS Code's modifyContextLines): never below 0. */
export const modifyContextLines = (n: number, increase: boolean) => Math.max(0, n + (increase ? 1 : -1));

/**
 * The configuration a new Search Editor starts with (VS Code's getOrMakeSearchEditorInput): the
 * defaults, then the prior editor's when `search.searchEditor.reusePriorSearchConfiguration`, then
 * what the caller gives. `search.searchEditor.defaultNumberOfContextLines` (null keeps the prior's).
 */
export function initialConfig(given: Partial<SearchConfig>, prior: Partial<SearchConfig> | null, reusePrior: boolean, defaultContextLines: number | null): SearchConfig {
	const config = { ...defaultSearchConfig(), ...(reusePrior && prior ? { ...prior, query: '' } : {}), ...given };
	if (defaultContextLines !== null && defaultContextLines !== undefined) config.contextLines = given.contextLines ?? defaultContextLines;
	return config;
}
