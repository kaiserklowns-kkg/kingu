// Document symbols (Outline, breadcrumbs, `@`), folding and smart select of a Markdown document
// (VS Code's markdown language service: its document symbol, folding and selection range
// providers). Pure; ranges in parse.ts's 0-based positions.

import { comparePos, contains, sectionEnd, type Block, type Header, type MdDocument, type Pos, type Range } from './parse.ts';

export type MdSymbol = { name: string; level: number; range: Range; selectionRange: Range; children: MdSymbol[] };

const lineRange = (doc: MdDocument, start: number, end: number): Range => ({ start: { line: start, character: 0 }, end: { line: end, character: doc.lines[end]?.length ?? 0 } });

/** Headers as a tree: each spans its section; the name shows its level (`## Install`), like VS Code. */
export function documentSymbols(doc: MdDocument): MdSymbol[] {
	const root: MdSymbol[] = [];
	const stack: MdSymbol[] = [];
	doc.headers.forEach((h, i) => {
		const sym: MdSymbol = { name: `${'#'.repeat(h.level)} ${h.text}`, level: h.level, range: lineRange(doc, h.line, sectionEnd(doc, i)), selectionRange: h.range, children: [] };
		while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
		(stack.length ? stack[stack.length - 1].children : root).push(sym);
		stack.push(sym);
	});
	return root;
}

export type Fold = { start: number; end: number; kind?: 'region' | 'comment' };

/** 0-based inclusive line ranges: header sections, multi-line list items, code blocks, block
 * quotes, tables, HTML comments, front matter and `<!-- #region -->` pairs. */
export function foldingRanges(doc: MdDocument): Fold[] {
	const out: Fold[] = [];
	doc.headers.forEach((h, i) => {
		const end = sectionEnd(doc, i);
		if (end > h.line) out.push({ start: h.line, end });
	});
	for (const b of doc.blocks) {
		if (b.endLine <= b.startLine || b.kind === 'paragraph' || b.kind === 'list') continue;
		// A fence keeps its closing line visible, like VS Code.
		const end = b.kind === 'code' && b.endLine > b.startLine + 1 && /^\s*(`{3,}|~{3,})\s*$/.test(doc.lines[b.endLine]) ? b.endLine - 1 : b.endLine;
		if (end <= b.startLine) continue;
		out.push({ start: b.startLine, end, ...(b.kind === 'region' ? { kind: 'region' as const } : b.kind === 'html' ? { kind: 'comment' as const } : {}) });
	}
	const seen = new Set<string>();
	return out.filter((f) => !seen.has(`${f.start}:${f.end}`) && !!seen.add(`${f.start}:${f.end}`)).sort((a, b) => a.start - b.start || b.end - a.end);
}

const size = (r: Range) => (r.end.line - r.start.line) * 1e6 + (r.end.character - r.start.character);

/**
 * Smart select at `p`, innermost first: the link target, the whole link, the line, each block
 * around it (list item, list, quote, code, table, paragraph), each header section (content,
 * then with its header), and the document.
 */
export function selectionRanges(doc: MdDocument, p: Pos): Range[] {
	const candidates: Range[] = [];
	for (const l of doc.links) {
		if (contains(l.hrefRange, p) && comparePos(l.hrefRange.start, l.hrefRange.end) < 0) candidates.push(l.hrefRange);
		if (contains(l.range, p)) candidates.push(l.range);
	}
	const text = doc.lines[p.line] ?? '';
	const lead = text.length - text.trimStart().length;
	if (text.trim()) candidates.push({ start: { line: p.line, character: lead }, end: { line: p.line, character: text.trimEnd().length } });
	const blockRange = (b: Block) => lineRange(doc, b.startLine, b.endLine);
	for (const b of doc.blocks) {
		if (p.line < b.startLine || p.line > b.endLine) continue;
		candidates.push(blockRange(b));
		// The inside of a fenced code block, without its fences.
		if (b.kind === 'code' && b.endLine - b.startLine >= 2 && p.line > b.startLine && p.line < b.endLine) candidates.push(lineRange(doc, b.startLine + 1, b.endLine - 1));
	}
	doc.headers.forEach((h: Header, i) => {
		const end = sectionEnd(doc, i);
		if (p.line < h.line || p.line > end) return;
		if (h.line === p.line) candidates.push(h.textRange, h.range);
		const bodyStart = h.setext ? h.line + 2 : h.line + 1;
		if (end >= bodyStart && p.line >= bodyStart) candidates.push(lineRange(doc, bodyStart, end));
		candidates.push(lineRange(doc, h.line, end));
	});
	const last = doc.lines.length - 1;
	candidates.push(lineRange(doc, 0, last));
	const unique: Range[] = [];
	for (const r of candidates.filter((r) => contains(r, p)).sort((a, b) => size(a) - size(b))) {
		const prev = unique[unique.length - 1];
		if (prev && comparePos(prev.start, r.start) === 0 && comparePos(prev.end, r.end) === 0) continue;
		// Each range must contain the previous one.
		if (prev && (comparePos(r.start, prev.start) > 0 || comparePos(r.end, prev.end) < 0)) continue;
		unique.push(r);
	}
	return unique;
}
