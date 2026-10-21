// The structure of a Markdown document for the language features (VS Code's markdown language
// service: its table of contents, link provider and block folding). A line scanner, not a full
// CommonMark parser: it finds headers, fenced code, front matter, HTML comments, lists, block
// quotes, tables, paragraphs and links with their exact ranges. Pure, so `bun test` covers it.
// Positions are 0-based lines and UTF-16 characters (LSP's), ranges end-exclusive.

import { headerText, Slugs } from './slugify.ts';

export type Pos = { line: number; character: number };
export type Range = { start: Pos; end: Pos };

export type Header = {
	level: number;
	/** The visible text (no inline Markdown). */
	text: string;
	slug: string;
	line: number;
	/** The whole header line (both lines of a setext header). */
	range: Range;
	/** The header's own text on its line: what a rename replaces. */
	textRange: Range;
	setext: boolean;
};

export type BlockKind = 'code' | 'list' | 'listItem' | 'quote' | 'paragraph' | 'table' | 'html' | 'frontMatter' | 'region';
/** Lines are inclusive. */
export type Block = { kind: BlockKind; startLine: number; endLine: number };

export type LinkKind = 'inline' | 'reference' | 'definition' | 'autolink';
export type Link = {
	kind: LinkKind;
	image: boolean;
	/** The whole link, `[text](href)` / `[text][ref]` / `[ref]: href` / `<href>`. */
	range: Range;
	/** The text between the brackets (inline and reference links). */
	text: string;
	/** The target as written (without `<>`), '' for a reference link. */
	href: string;
	/** Where `href` sits; for a reference link, where the reference label sits. */
	hrefRange: Range;
	/** The reference label of a reference link or definition, lowercased and whitespace-folded. */
	ref?: string;
};

export type MdDocument = {
	lines: string[];
	headers: Header[];
	links: Link[];
	/** Link definitions by normalized label (several when the label is defined twice). */
	definitions: Map<string, Link[]>;
	blocks: Block[];
	/** Lines inside fenced code, front matter or HTML comments. */
	codeLines: Set<number>;
};

export const normalizeRef = (label: string) => label.trim().replace(/\s+/g, ' ').toLowerCase();

export function splitLines(text: string): string[] {
	return text.split(/\r\n|\r|\n/);
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX = /^( {0,3})(#{1,6})(?=[ \t]|$)[ \t]*(.*?)$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const LIST_ITEM = /^( *)([-+*]|\d{1,9}[.)])([ \t]+|$)/;
const QUOTE = /^ {0,3}>/;
const HR = /^ {0,3}((\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$/;
const TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const DEFINITION = /^( {0,3})\[((?:[^\]\\]|\\.)+)\]:[ \t]*(<[^>\n]*>|\S+)/;
const REGION_START = /^\s*<!--\s*#?region\b.*-->/;
const REGION_END = /^\s*<!--\s*#?endregion\b.*-->/;

const blank = (s: string) => /^\s*$/.test(s);
const pos = (line: number, character: number): Pos => ({ line, character });
const range = (line: number, start: number, end: number, endLine = line): Range => ({ start: pos(line, start), end: pos(endLine, end) });

export function parseMarkdown(text: string): MdDocument {
	const lines = splitLines(text);
	const headers: Header[] = [];
	const blocks: Block[] = [];
	const codeLines = new Set<number>();
	const slugs = new Slugs();
	const regions: number[] = [];
	/** Lines that may hold links (not code), with their text masked where links can't be. */
	const scan: boolean[] = lines.map(() => true);

	let i = 0;
	// Front matter: `---` on the first line up to the next `---` or `...`.
	if (lines[0] === '---') {
		const end = lines.findIndex((l, n) => n > 0 && (l === '---' || l === '...'));
		if (end > 0) {
			blocks.push({ kind: 'frontMatter', startLine: 0, endLine: end });
			for (let n = 0; n <= end; n++) (codeLines.add(n), (scan[n] = false));
			i = end + 1;
		}
	}

	let para: number | null = null;
	const closePara = (end: number) => {
		if (para !== null && end >= para) blocks.push({ kind: 'paragraph', startLine: para, endLine: end });
		para = null;
	};

	for (; i < lines.length; i++) {
		const line = lines[i];
		const fence = FENCE.exec(line);
		if (fence) {
			closePara(i - 1);
			const ch = fence[1][0];
			const len = fence[1].length;
			let end = i + 1;
			const close = new RegExp(`^ {0,3}${ch === '`' ? '`' : '~'}{${len},}[ \\t]*$`);
			while (end < lines.length && !close.test(lines[end])) end++;
			const last = Math.min(end, lines.length - 1);
			blocks.push({ kind: 'code', startLine: i, endLine: last });
			for (let n = i; n <= last; n++) (codeLines.add(n), (scan[n] = false));
			i = last;
			continue;
		}
		if (REGION_START.test(line)) {
			closePara(i - 1);
			regions.push(i);
			scan[i] = false;
			continue;
		}
		if (REGION_END.test(line)) {
			closePara(i - 1);
			const start = regions.pop();
			if (start !== undefined) blocks.push({ kind: 'region', startLine: start, endLine: i });
			scan[i] = false;
			continue;
		}
		// An HTML comment spanning lines.
		if (/^ {0,3}<!--/.test(line) && !line.includes('-->')) {
			closePara(i - 1);
			let end = i + 1;
			while (end < lines.length && !lines[end].includes('-->')) end++;
			const last = Math.min(end, lines.length - 1);
			blocks.push({ kind: 'html', startLine: i, endLine: last });
			for (let n = i; n <= last; n++) (codeLines.add(n), (scan[n] = false));
			i = last;
			continue;
		}
		const atx = ATX.exec(line);
		if (atx) {
			closePara(i - 1);
			const content = atx[3].replace(/[ \t]+#+[ \t]*$/, '').replace(/^#+[ \t]*$/, '');
			const startChar = line.length - atx[3].length;
			const raw = content.trimEnd();
			const h = headerText(raw);
			headers.push({
				level: atx[2].length,
				text: h,
				slug: slugs.next(raw),
				line: i,
				range: range(i, 0, line.length),
				textRange: range(i, startChar, startChar + raw.length),
				setext: false
			});
			continue;
		}
		const setext = SETEXT.exec(line);
		if (setext && para !== null) {
			// The paragraph's last line becomes the header (a multi-line paragraph keeps its earlier lines).
			const hLine = i - 1;
			closePara(hLine - 1);
			const text = lines[hLine];
			const lead = text.length - text.trimStart().length;
			const raw = text.trim();
			headers.push({
				level: setext[1][0] === '=' ? 1 : 2,
				text: headerText(raw),
				slug: slugs.next(raw),
				line: hLine,
				range: range(hLine, 0, line.length, i),
				textRange: range(hLine, lead, lead + raw.length),
				setext: true
			});
			continue;
		}
		if (blank(line)) {
			closePara(i - 1);
			continue;
		}
		if (HR.test(line)) {
			closePara(i - 1);
			continue;
		}
		if (para === null && TABLE_DELIM.test(lines[i + 1] ?? '') && line.includes('|')) {
			let end = i + 2;
			while (end < lines.length && !blank(lines[end]) && lines[end].includes('|')) end++;
			blocks.push({ kind: 'table', startLine: i, endLine: end - 1 });
			i = end - 1;
			continue;
		}
		if (QUOTE.test(line) && para === null) {
			let end = i + 1;
			while (end < lines.length && !blank(lines[end]) && !FENCE.test(lines[end]) && !ATX.test(lines[end])) end++;
			blocks.push({ kind: 'quote', startLine: i, endLine: end - 1 });
			// Quote lines are still scanned for links (and their own headers are rare enough to skip).
			i = end - 1;
			continue;
		}
		if (LIST_ITEM.test(line) && (para === null || !/^\d/.test(line.trimStart()))) {
			closePara(i - 1);
			i = parseList(lines, i, blocks, codeLines, scan) - 1;
			continue;
		}
		if (para === null) para = i;
	}
	closePara(lines.length - 1);

	const links: Link[] = [];
	const definitions = new Map<string, Link[]>();
	for (let n = 0; n < lines.length; n++) {
		if (!scan[n]) continue;
		const def = DEFINITION.exec(lines[n]);
		if (def) {
			const label = def[2];
			const hrefRaw = def[3];
			const angle = hrefRaw.startsWith('<');
			const hrefStart = def[0].length - hrefRaw.length + (angle ? 1 : 0);
			const href = angle ? hrefRaw.slice(1, -1) : hrefRaw;
			const link: Link = {
				kind: 'definition',
				image: false,
				range: range(n, def[1].length, lines[n].trimEnd().length),
				text: label,
				href,
				hrefRange: range(n, hrefStart, hrefStart + href.length),
				ref: normalizeRef(label)
			};
			links.push(link);
			definitions.set(link.ref!, [...(definitions.get(link.ref!) ?? []), link]);
			continue;
		}
		links.push(...lineLinks(lines[n], n));
	}
	// Shortcut references (`[ref]`) count only when the label is defined.
	const kept = links.filter((l) => !(l.kind === 'reference' && l.text === '\0shortcut' ? !definitions.has(l.ref!) : false));
	for (const l of kept) if (l.text === '\0shortcut') l.text = l.ref!;
	blocks.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
	return { lines, headers, links: kept, definitions, blocks, codeLines };
}

/** A list starting at `start`: the list block and one block per item (nested lists recurse
 * through indentation). Returns the line after the list. */
function parseList(lines: string[], start: number, blocks: Block[], codeLines: Set<number>, scan: boolean[]): number {
	const first = LIST_ITEM.exec(lines[start])!;
	const indent = first[1].length;
	let i = start;
	let itemStart = start;
	let lastContent = start;
	const items: Block[] = [];
	const content = (m: RegExpExecArray) => m[1].length + m[2].length + Math.max(1, Math.min(4, m[3].length || 1));
	let itemContent = content(first);
	for (i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (blank(line)) continue;
		const lead = line.length - line.trimStart().length;
		const item = LIST_ITEM.exec(line);
		if (item && item[1].length === indent) {
			items.push({ kind: 'listItem', startLine: itemStart, endLine: lastContent });
			itemStart = i;
			itemContent = content(item);
			lastContent = i;
			continue;
		}
		if (lead >= itemContent || (lead > indent && item)) {
			const fence = FENCE.exec(line.slice(Math.min(lead, itemContent)));
			if (fence) {
				const ch = fence[1][0];
				const close = new RegExp(`^\\s*${ch === '`' ? '`' : '~'}{${fence[1].length},}[ \\t]*$`);
				let end = i + 1;
				while (end < lines.length && !close.test(lines[end])) end++;
				const last = Math.min(end, lines.length - 1);
				blocks.push({ kind: 'code', startLine: i, endLine: last });
				for (let n = i; n <= last; n++) (codeLines.add(n), (scan[n] = false));
				i = last;
				lastContent = last;
				continue;
			}
			if (item) {
				const end = parseList(lines, i, blocks, codeLines, scan);
				lastContent = end - 1;
				while (lastContent > i && blank(lines[lastContent])) lastContent--;
				i = end - 1;
				continue;
			}
			lastContent = i;
			continue;
		}
		// A lazy continuation line right after content (no blank line between).
		if (!blank(lines[i - 1]) && lead > indent - 1 && !ATX.test(line) && !FENCE.test(line) && !HR.test(line) && !item && lead >= indent) {
			lastContent = i;
			continue;
		}
		if (!blank(lines[i - 1]) && !item && !ATX.test(line) && !FENCE.test(line) && !HR.test(line) && !QUOTE.test(line) && lead === 0 && indent === 0) {
			lastContent = i;
			continue;
		}
		break;
	}
	items.push({ kind: 'listItem', startLine: itemStart, endLine: lastContent });
	blocks.push({ kind: 'list', startLine: start, endLine: lastContent }, ...items);
	return lastContent + 1;
}

/** `line` with code spans, escapes and autolinks' insides blanked (same length), so link
 * patterns only see real Markdown. */
function maskCode(line: string): string {
	let out = line.replace(/\\[\\`*_{}[\]()#+\-.!<>|]/g, '  ');
	out = out.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (m) => ' '.repeat(m.length));
	return out;
}

const INLINE = /(!?)\[((?:[^[\]]|\[(?:[^[\]]|\[[^[\]]*\])*\])*)\]\([ \t]*(<[^>\n]*>|(?:[^\s()]|\((?:[^\s()]|\([^\s()]*\))*\))*)(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^()]*\)))?[ \t]*\)/g;
const REFERENCE = /(!?)\[((?:[^[\]]|\[[^[\]]*\])*)\]\[([^[\]]*)\]/g;
const SHORTCUT = /(!?)\[([^[\]]+)\](?![[(:])/g;
const AUTOLINK = /<([a-z][a-z0-9+.-]{1,31}:[^\s<>]*)>/gi;

/** The links on one line; `offset` maps masked text positions back to the line. */
export function lineLinks(line: string, n: number, masked = maskCode(line), offset = 0): Link[] {
	const out: Link[] = [];
	const taken: [number, number][] = [];
	const free = (s: number, e: number) => !taken.some(([a, b]) => s < b && e > a);
	for (const m of masked.matchAll(INLINE)) {
		const s = m.index! + offset;
		const e = s + m[0].length;
		const textStart = s + m[1].length + 1;
		const hrefRaw = m[3];
		const parenAt = m[0].indexOf('](', m[1].length + 1 + m[2].length) + 2;
		const lead = m[0].slice(parenAt).length - m[0].slice(parenAt).trimStart().length;
		const angle = hrefRaw.startsWith('<');
		const hrefStart = s + parenAt + lead + (angle ? 1 : 0);
		const href = line.slice(hrefStart, hrefStart + hrefRaw.length - (angle ? 2 : 0));
		out.push({ kind: 'inline', image: m[1] === '!', range: range(n, s, e), text: line.slice(textStart, textStart + m[2].length), href, hrefRange: range(n, hrefStart, hrefStart + href.length) });
		taken.push([s, e]);
		// Images inside a link's text: `[![alt](img.png)](page.md)`.
		if (m[2].includes('](') || m[2].includes('][')) out.push(...lineLinks(line, n, masked.slice(0, textStart - offset).replace(/[\s\S]/g, ' ') + masked.slice(textStart - offset, textStart - offset + m[2].length), offset).filter((l) => l.range.start.character >= textStart));
	}
	for (const m of masked.matchAll(REFERENCE)) {
		const s = m.index! + offset;
		const e = s + m[0].length;
		if (!free(s, e)) continue;
		const textStart = s + m[1].length + 1;
		const collapsed = m[3].trim() === '';
		const label = collapsed ? m[2] : m[3];
		const refStart = collapsed ? textStart : e - 1 - m[3].length;
		out.push({ kind: 'reference', image: m[1] === '!', range: range(n, s, e), text: line.slice(textStart, textStart + m[2].length), href: '', hrefRange: range(n, refStart, refStart + label.length), ref: normalizeRef(label) });
		taken.push([s, e]);
	}
	for (const m of masked.matchAll(AUTOLINK)) {
		const s = m.index! + offset;
		const e = s + m[0].length;
		if (!free(s, e)) continue;
		out.push({ kind: 'autolink', image: false, range: range(n, s, e), text: m[1], href: m[1], hrefRange: range(n, s + 1, e - 1) });
		taken.push([s, e]);
	}
	for (const m of masked.matchAll(SHORTCUT)) {
		const s = m.index! + offset;
		const e = s + m[0].length;
		// A task list box (`[ ]`, `[x]`) is never a link.
		if (!free(s, e) || /^[ xX]$/.test(m[2])) continue;
		const textStart = s + m[1].length + 1;
		out.push({ kind: 'reference', image: m[1] === '!', range: range(n, s, e), text: '\0shortcut', href: '', hrefRange: range(n, textStart, textStart + m[2].length), ref: normalizeRef(m[2]) });
		taken.push([s, e]);
	}
	return out.sort((a, b) => a.range.start.character - b.range.start.character);
}

// --- Queries -------------------------------------------------------------------------------------

export const comparePos = (a: Pos, b: Pos) => a.line - b.line || a.character - b.character;
export const contains = (r: Range, p: Pos) => comparePos(r.start, p) <= 0 && comparePos(p, r.end) <= 0;

/** The header whose line holds `line`. */
export const headerAt = (doc: MdDocument, line: number) => doc.headers.find((h) => h.line === line || (h.setext && h.line + 1 === line));

/** The link under a position (the innermost, for an image inside a link). */
export function linkAt(doc: MdDocument, p: Pos): Link | undefined {
	return doc.links.filter((l) => contains(l.range, p)).sort((a, b) => comparePos(b.range.start, a.range.start))[0];
}

/** The last line of a header's section: up to the next header of the same or a higher level. */
export function sectionEnd(doc: MdDocument, index: number): number {
	const h = doc.headers[index];
	const next = doc.headers.slice(index + 1).find((x) => x.level <= h.level);
	let end = next ? next.line - 1 : doc.lines.length - 1;
	while (end > h.line && blank(doc.lines[end])) end--;
	return Math.max(end, h.setext ? h.line + 1 : h.line);
}
