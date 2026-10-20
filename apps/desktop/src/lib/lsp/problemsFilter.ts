// The Problems view's filter (VS Code: markersFilterOptions.ts FilterOptions and the tree's Filter
// in markersTreeViewer.ts). Pure, so `bun test` checks it.
//
// The filter box text is at once a text filter (message, source, code, file name), a list of
// globs on the file path (comma separated; `!glob` excludes; `.ts` means `*.ts`) and
// `@source:name` / `!@source:name` source filters. The toggles: Show Errors / Warnings / Infos,
// Show Active File Only and Hide Excluded Files (`files.exclude`). Like VS Code, hints are not
// listed (they have no toggle).

import { globToRegExp, isExcluded } from '#lib/settings/mappings.ts';
import type { ProblemFile } from './model.ts';
import type { Diagnostic } from './protocol.ts';

const SOURCE_FILTER = /(!)?@source:("[^"]*"|[^\s,]+)(\s*)/i;

export type ParsedProblemsFilter = {
	text: string;
	negate: boolean;
	includeSources: string[];
	excludeSources: string[];
	// File path globs: each typed pattern anywhere in the path, as a file or as a folder.
	include: RegExp[];
	exclude: RegExp[];
};

/** VS Code's splitGlobAware: commas inside `{…}` or `[…]` do not split. */
export function splitGlobAware(text: string, sep = ','): string[] {
	const out: string[] = [];
	let cur = '';
	let braces = 0;
	let brackets = 0;
	for (const c of text) {
		if (c === '{') braces++;
		else if (c === '}' && braces) braces--;
		else if (c === '[') brackets++;
		else if (c === ']' && brackets) brackets--;
		if (c === sep && !braces && !brackets) {
			out.push(cur);
			cur = '';
		} else cur += c;
	}
	out.push(cur);
	return out;
}

/** VS Code's setPattern: `.js` → `*.js`, then the pattern anywhere, as a file or a folder. */
function patternGlobs(pattern: string): RegExp[] {
	const p = pattern.startsWith('.') ? `*${pattern}` : pattern;
	return [globToRegExp(`**/${p}/**`), globToRegExp(`**/${p}`)];
}

export function parseProblemsFilter(raw: string): ParsedProblemsFilter {
	let filter = raw.trim();
	const includeSources: string[] = [];
	const excludeSources: string[] = [];
	for (let m = SOURCE_FILTER.exec(filter); m; m = SOURCE_FILTER.exec(filter)) {
		let source = m[2];
		if (source.startsWith('"') && source.endsWith('"')) source = source.slice(1, -1);
		(m[1] ? excludeSources : includeSources).push(source.toLowerCase());
		filter = (filter.slice(0, m.index) + filter.slice(m.index + m[0].length)).trim();
	}
	const negate = filter.startsWith('!');
	const include: RegExp[] = [];
	const exclude: RegExp[] = [];
	for (const f of splitGlobAware(filter).map((s) => s.trim()).filter(Boolean)) {
		if (f.startsWith('!')) {
			const text = f.replace(/^!+/, '');
			if (text) exclude.push(...patternGlobs(text));
		} else include.push(...patternGlobs(f));
	}
	return { text: (negate ? filter.replace(/^!+/, '') : filter).trim(), negate, includeSources, excludeSources, include, exclude };
}

const textCache = new Map<string, RegExp>();

/**
 * VS Code's matchesFuzzy for the filter text: a case-insensitive substring where `*` stands for
 * any run of characters (convertSimple2RegExpPattern).
 */
export function matchesText(text: string, target: string): boolean {
	let re = textCache.get(text);
	if (!re) {
		re = new RegExp(text.replace(/[-\\{}+?|^$.,[\]()#\s]/g, '\\$&').replace(/[*]/g, '.*'), 'i');
		if (textCache.size > 200) textCache.clear();
		textCache.set(text, re);
	}
	return re.test(target);
}

export type ProblemsFilterState = {
	text: string;
	showErrors: boolean;
	showWarnings: boolean;
	showInfos: boolean;
	/** Show Active File Only: the active editor's workspace path, or null when the toggle is off. */
	activeFile: string | null;
	/** Hide Excluded Files: the enabled `files.exclude` globs, or [] when the toggle is off. */
	filesExclude: readonly string[];
};

export const DEFAULT_PROBLEMS_FILTER: ProblemsFilterState = { text: '', showErrors: true, showWarnings: true, showInfos: true, activeFile: null, filesExclude: [] };

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const codeOf = (d: Diagnostic) => (d.code === undefined ? '' : String(d.code));

function severityShown(d: Diagnostic, s: ProblemsFilterState): boolean {
	const sev = d.severity ?? 1;
	return sev === 1 ? s.showErrors : sev === 2 ? s.showWarnings : sev === 3 ? s.showInfos : false;
}

function sourceShown(d: Diagnostic, f: ParsedProblemsFilter): boolean {
	if (!f.includeSources.length && !f.excludeSources.length) return true;
	const source = d.source?.toLowerCase();
	if (source && f.excludeSources.includes(source)) return false;
	if (f.includeSources.length) return !!source && f.includeSources.includes(source);
	return true;
}

/**
 * The files and problems the view shows, with the counts for "Showing X of Y". `path` is the
 * file's absolute path when known (globs match it like VS Code matches the resource path).
 */
export function filterProblems(
	files: readonly ProblemFile[],
	state: ProblemsFilterState,
	path: (file: ProblemFile) => string = (f) => f.label
): { files: ProblemFile[]; shown: number; total: number } {
	const f = parseProblemsFilter(state.text);
	let total = 0;
	let shown = 0;
	const out: ProblemFile[] = [];
	for (const file of files) {
		const listed = file.items.filter((d) => (d.severity ?? 1) !== 4);
		total += listed.length;
		if (state.activeFile !== null && file.rel !== state.activeFile) continue;
		if (file.rel !== null && isExcluded(file.rel, state.filesExclude)) continue;
		const abs = path(file);
		if (f.exclude.some((re) => re.test(abs))) continue;
		// The file itself matches: its problems show whatever their text (VS Code's TreeVisibility.Visible).
		const fileMatches = f.include.some((re) => re.test(abs)) || (!!f.text && !f.negate && matchesText(f.text, basename(file.label)));
		const items = listed.filter((d) => {
			if (!severityShown(d, state) || !sourceShown(d, f)) return false;
			if (!f.text || fileMatches) return true;
			const matched = d.message.split(/\r?\n/).some((l) => matchesText(f.text, l)) || (!!d.source && matchesText(f.text, d.source)) || (!!codeOf(d) && matchesText(f.text, codeOf(d)));
			return f.negate ? !matched : matched;
		});
		if (!items.length) continue;
		shown += items.length;
		out.push(items.length === file.items.length ? file : { ...file, items });
	}
	return { files: out, shown, total };
}

/** Whether anything narrows the list (VS Code then shows "Showing X of Y" and checks the filter button). */
export const isFiltering = (s: ProblemsFilterState) => !!s.text.trim() || !s.showErrors || !s.showWarnings || !s.showInfos || s.activeFile !== null || s.filesExclude.length > 0;

/** Problems: Copy — VS Code's Marker.toString(): the marker as JSON. */
export function copyText(file: ProblemFile, d: Diagnostic): string {
	const severity = ({ 1: 8, 2: 4, 3: 2, 4: 1 } as Record<number, number>)[d.severity ?? 1];
	return JSON.stringify(
		{
			resource: file.uri,
			code: d.code,
			severity,
			message: d.message,
			source: d.source,
			startLineNumber: d.range.start.line + 1,
			startColumn: d.range.start.character + 1,
			endLineNumber: d.range.end.line + 1,
			endColumn: d.range.end.character + 1
		},
		null,
		'\t'
	);
}
