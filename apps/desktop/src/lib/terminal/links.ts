// Links in terminal output (pure, so `bun test` covers it). Web URLs, and file paths with an
// optional position: VS Code's terminalLinkParsing.ts suffixes (`:12`, `:12:5`, `(12,5)`,
// `", line 12`) and its no-suffix unix path regex, plus Orca's bare file names (`README.md`).
// A file candidate is only a link once Rust has found the file (`terminal_link_target`).

import { t } from '#lib/i18n/index.ts';

export type FileLink = { kind: 'file'; start: number; end: number; path: string; line?: number; column?: number };
export type UrlLink = { kind: 'url'; start: number; end: number; url: string };
export type TerminalLink = FileLink | UrlLink;

/** VS Code: lines longer than this are not scanned, and at most this many links per line. */
export const MAX_LINE = 2000;
export const MAX_LINKS = 10;
const MAX_URL = 2048;
const MAX_PATH = 1024;

// --- Web URLs (VS Code's LinkComputer / Orca's scanner: http(s) after a word boundary).
const URL_RE = /(?<![0-9A-Za-z_])https?:\/\/[^\s<>"'`|\\^{}、。｡､，．：；‘’“”〈〉「」『』〔〕（）［］｛｝｢｣…]+/g;
const URL_TRAILING = /[.,;:!?'"]$/;

function trimUrl(url: string): string {
	for (;;) {
		if (URL_TRAILING.test(url)) url = url.slice(0, -1);
		else if (url.endsWith(')') && count(url, '(') < count(url, ')')) url = url.slice(0, -1);
		else if (url.endsWith(']') && count(url, '[') < count(url, ']')) url = url.slice(0, -1);
		else return url;
	}
}

const count = (s: string, c: string) => s.split(c).length - 1;

function urlLinks(line: string): UrlLink[] {
	const out: UrlLink[] = [];
	for (const m of line.matchAll(URL_RE)) {
		const url = trimUrl(m[0]);
		if (url.length > MAX_URL || !/^https?:\/\/[^/?#\s]/.test(url)) continue;
		try {
			new URL(url);
		} catch {
			continue;
		}
		out.push({ kind: 'url', start: m.index, end: m.index + url.length, url });
	}
	return out;
}

// --- Line/column suffixes (VS Code terminalLinkParsing.ts, its three clauses; a space may also be a no-break space).
const S = '[\\u00A0 ]';
const SUFFIX_RE = new RegExp(
	[
		`(?::|#|${S}|['"],|,${S})(?<row1>\\d+)(?:[:.](?<col1>\\d+)(?:-(?:\\d+\\.)?\\d+)?)?`,
		`['"]?(?:,?${S}|:${S}?|${S}on${S})lines?${S}(?<row2>\\d+)(?:-\\d+)?(?:,?${S}(?:col(?:umn)?|characters?)${S}(?<col2>\\d+)(?:-\\d+)?)?`,
		`:?${S}?[\\[\\(](?<row3>\\d+)(?:(?:,${S}?|:)(?<col3>\\d+))?[\\]\\)]`
	].join('|'),
	'g'
);
/** The path right before a suffix (VS Code's linkWithSuffixPathCharacters). */
const PATH_BEFORE_SUFFIX = /(?:file:\/\/\/)?[^\s|<>[({][^\s|<>]*$/;

// --- Paths without a suffix (VS Code's unix local link regex: at least one `/`).
const EXCLUDED = '[^\\0<>?\\s!`&*()\'":;\\\\]';
const EXCLUDED_START = '[^\\0<>?\\s!`&*()\\[\\]\'":;\\\\]';
const PATH_RE = new RegExp(`(?:(?:\\.\\.?|~|file://)|(?:${EXCLUDED_START}${EXCLUDED}*))?(?:/(?:${EXCLUDED})+)+`, 'g');

// --- Bare file names (Orca's terminal-bare-file-link-detection.ts).
const TOKEN_RE = /[^\s()[\]{}'",;<>|`]+/g;
const BARE_RE = /^[A-Za-z0-9_][A-Za-z0-9._+-]*$/;
const BARE_NAMES = new Set(['Makefile', 'Dockerfile', 'Rakefile', 'Gemfile', 'Procfile', 'LICENSE', 'README', 'CHANGELOG', 'AUTHORS', 'NOTICE', 'CONTRIBUTING']);

/** `--- a/x`, `+++ b/x`, `diff --git a/x b/x`: the git prefix is not part of the path (VS Code). */
const GIT_DIFF_LINE = /^(?:--- |\+\+\+ |diff --git )/;

const positive = (s: string | undefined) => {
	const n = s === undefined ? NaN : Number(s);
	return Number.isSafeInteger(n) && n >= 1 ? n : undefined;
};

/** Cleans a matched path: a `file://` prefix, quotes around it and trailing punctuation go. Empty when nothing is left. */
export function cleanPath(raw: string, gitDiff = false): { path: string; offset: number } {
	let path = raw;
	let offset = 0;
	const lead = /^['"]+/.exec(path);
	if (lead) {
		path = path.slice(lead[0].length);
		offset += lead[0].length;
	}
	if (path.startsWith('file://')) {
		path = decodeFileUri(path.slice('file://'.length));
	}
	path = path.replace(/['"\]\[.,]+$/, '');
	if (gitDiff && /^[abciow12]\//.test(path)) path = path.slice(2);
	if (path.length > MAX_PATH || /^\d+$/.test(path)) return { path: '', offset };
	return { path, offset };
}

function decodeFileUri(rest: string): string {
	try {
		return decodeURIComponent(rest);
	} catch {
		return rest;
	}
}

function suffixLinks(line: string, gitDiff: boolean): FileLink[] {
	const out: FileLink[] = [];
	for (const m of line.matchAll(SUFFIX_RE)) {
		const g = m.groups ?? {};
		const lineNo = positive(g.row1 ?? g.row2 ?? g.row3);
		if (lineNo === undefined) continue;
		const before = PATH_BEFORE_SUFFIX.exec(line.slice(0, m.index));
		if (!before) continue;
		const { path, offset } = cleanPath(before[0], gitDiff);
		if (!path) continue;
		const start = before.index + offset;
		out.push({ kind: 'file', start, end: m.index + m[0].length, path, line: lineNo, column: positive(g.col1 ?? g.col2 ?? g.col3) });
	}
	return out;
}

function plainPathLinks(line: string, gitDiff: boolean): FileLink[] {
	const out: FileLink[] = [];
	for (const m of line.matchAll(PATH_RE)) {
		const { path, offset } = cleanPath(m[0], gitDiff);
		if (!path || path === '/' || path === '//') continue;
		const start = m.index + offset;
		out.push({ kind: 'file', start, end: start + m[0].length - offset - trailingCut(m[0]), path });
	}
	return out;
}

const trailingCut = (raw: string) => (/['"\]\[.,]+$/.exec(raw)?.[0].length ?? 0);

function bareLinks(line: string): FileLink[] {
	const out: FileLink[] = [];
	for (const m of line.matchAll(TOKEN_RE)) {
		const token = m[0].replace(/[.:]+$/, '');
		if (token.length < 2 || token.length > 100 || !BARE_RE.test(token) || /^\d+$/.test(token)) continue;
		if (!token.includes('.') && !BARE_NAMES.has(token)) continue;
		// Version numbers and dotted numbers (`1.2.3`) are not files.
		if (/^[\d.]+$/.test(token)) continue;
		out.push({ kind: 'file', start: m.index, end: m.index + token.length, path: token });
	}
	return out;
}

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;

/** Every link candidate in one (unwrapped) terminal line, left to right, without overlaps. */
export function detectLinks(line: string): TerminalLink[] {
	if (line.length > MAX_LINE) return [];
	const gitDiff = GIT_DIFF_LINE.test(line);
	const taken: TerminalLink[] = [];
	const add = (links: TerminalLink[]) => {
		for (const l of links) if (!taken.some((t) => overlaps(t, l))) taken.push(l);
	};
	add(urlLinks(line));
	add(suffixLinks(line, gitDiff));
	add(plainPathLinks(line, gitDiff));
	add(bareLinks(line));
	return taken.sort((a, b) => a.start - b.start).slice(0, MAX_LINKS);
}

/**
 * Text of a run of terminal cells and, per UTF-16 index of that text, the cell it is drawn in.
 * A wide character's second cell is empty; a Thai vowel or tone mark shares its consonant's cell.
 */
export function cellText(cells: string[]): { text: string; cellAt: number[] } {
	let text = '';
	const cellAt: number[] = [];
	cells.forEach((chars, i) => {
		for (let j = 0; j < chars.length; j++) cellAt.push(i);
		text += chars;
	});
	return { text, cellAt };
}

/** VS Code's hover text: how to follow a link with the link modifier. */
export function linkHint(kind: TerminalLink['kind'], mac: boolean, altModifier: boolean): string {
	const click = altModifier ? (mac ? 'option + click' : 'alt + click') : mac ? 'cmd + click' : 'ctrl + click';
	return kind === 'url' ? t('tools.terminal.link.openUrl', { click }) : t('tools.terminal.link.openFile', { click });
}

/** The link modifier is held (VS Code: ⌘ on macOS, Ctrl elsewhere; Alt when editor.multiCursorModifier is ctrlCmd). */
export function linkModifierDown(e: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'altKey'>, mac: boolean, altModifier: boolean): boolean {
	if (altModifier) return e.altKey;
	return mac ? e.metaKey : e.ctrlKey;
}
