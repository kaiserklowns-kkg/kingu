// A forgiving HTML/XML/JSX tag scanner for the Emmet actions (VS Code: @emmetio/html-matcher):
// elements with their open and close tags, attributes, comments. Unclosed elements end where
// their parent does; `<script>`, `<style>`, `<textarea>` and `<title>` hold raw text. Pure.

export type Attribute = { name: string; start: number; end: number; nameEnd: number; valueStart?: number; valueEnd?: number };
export type Tag = { name: string; start: number; end: number; nameStart: number; nameEnd: number; attributes: Attribute[]; selfClosing: boolean };
export type Element = { name: string; open: Tag; close?: Tag; start: number; end: number; parent?: Element; children: Element[] };
export type Comment = { start: number; end: number };
export type Markup = { elements: Element[]; all: Element[]; comments: Comment[] };

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', '!doctype']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);

/** An open or self-closing tag at `i` (`<` there), or null. */
function openTag(text: string, i: number): Tag | null {
	const m = /^<([a-zA-Z][\w:.-]*)/.exec(text.slice(i, i + 256));
	if (!m) return null;
	const tag: Tag = { name: m[1], start: i, end: -1, nameStart: i + 1, nameEnd: i + 1 + m[1].length, attributes: [], selfClosing: false };
	let j = tag.nameEnd;
	while (j < text.length) {
		const c = text[j];
		if (c === '>') {
			tag.end = j + 1;
			return tag;
		}
		if (c === '/' && text[j + 1] === '>') {
			tag.end = j + 2;
			tag.selfClosing = true;
			return tag;
		}
		if (c === '<') return null;
		if (/\s/.test(c)) {
			j++;
			continue;
		}
		// JSX spread or expression attribute: `{...props}`.
		if (c === '{') {
			const end = braceEnd(text, j);
			if (end < 0) return null;
			j = end;
			continue;
		}
		const name = /^[^\s=>/]+/.exec(text.slice(j, j + 256));
		if (!name) {
			j++;
			continue;
		}
		const attr: Attribute = { name: name[0], start: j, nameEnd: j + name[0].length, end: j + name[0].length };
		j = attr.end;
		let k = j;
		while (/\s/.test(text[k] ?? '')) k++;
		if (text[k] === '=') {
			k++;
			while (/\s/.test(text[k] ?? '')) k++;
			const q = text[k];
			if (q === '"' || q === "'") {
				const close = text.indexOf(q, k + 1);
				if (close < 0) return null;
				Object.assign(attr, { valueStart: k + 1, valueEnd: close, end: close + 1 });
			} else if (q === '{') {
				const end = braceEnd(text, k);
				if (end < 0) return null;
				Object.assign(attr, { valueStart: k + 1, valueEnd: end - 1, end });
			} else {
				const v = /^[^\s>]*/.exec(text.slice(k))![0];
				Object.assign(attr, { valueStart: k, valueEnd: k + v.length, end: k + v.length });
			}
			j = attr.end;
		}
		tag.attributes.push(attr);
	}
	return null;
}

/** The offset after the `}` matching the `{` at `i` (strings skipped), or -1. */
function braceEnd(text: string, i: number): number {
	let depth = 0;
	for (let j = i; j < text.length; j++) {
		const c = text[j];
		if (c === '"' || c === "'" || c === '`') {
			const close = text.indexOf(c, j + 1);
			if (close < 0) return -1;
			j = close;
		} else if (c === '{') depth++;
		else if (c === '}' && --depth === 0) return j + 1;
	}
	return -1;
}

export function parseMarkup(text: string): Markup {
	const roots: Element[] = [];
	const all: Element[] = [];
	const comments: Comment[] = [];
	const stack: Element[] = [];
	const add = (el: Element) => {
		const parent = stack[stack.length - 1];
		el.parent = parent;
		(parent ? parent.children : roots).push(el);
		all.push(el);
	};
	// Elements left open end where their parent closes (or at the end of the text).
	const closeOpen = (el: Element, end: number) => (el.end = Math.max(el.open.end, end));
	let i = 0;
	while (i < text.length) {
		const lt = text.indexOf('<', i);
		if (lt < 0) break;
		if (text.startsWith('<!--', lt)) {
			const end = text.indexOf('-->', lt + 4);
			const stop = end < 0 ? text.length : end + 3;
			comments.push({ start: lt, end: stop });
			i = stop;
			continue;
		}
		if (text.startsWith('<![CDATA[', lt)) {
			const end = text.indexOf(']]>', lt);
			i = end < 0 ? text.length : end + 3;
			continue;
		}
		if (text[lt + 1] === '!' || text[lt + 1] === '?') {
			const end = text.indexOf('>', lt);
			i = end < 0 ? text.length : end + 1;
			continue;
		}
		const close = /^<\/([a-zA-Z][\w:.-]*)?\s*>/.exec(text.slice(lt, lt + 256));
		if (close) {
			const name = close[1] ?? '';
			const tag: Tag = { name, start: lt, end: lt + close[0].length, nameStart: lt + 2, nameEnd: lt + 2 + name.length, attributes: [], selfClosing: false };
			const at = stack.map((e) => e.name.toLowerCase()).lastIndexOf(name.toLowerCase());
			if (at >= 0) {
				while (stack.length > at + 1) closeOpen(stack.pop()!, tag.start);
				const el = stack.pop()!;
				el.close = tag;
				el.end = tag.end;
			}
			i = tag.end;
			continue;
		}
		const tag = openTag(text, lt);
		if (!tag) {
			i = lt + 1;
			continue;
		}
		const el: Element = { name: tag.name, open: tag, start: tag.start, end: tag.end, children: [] };
		add(el);
		i = tag.end;
		if (tag.selfClosing || VOID.has(tag.name.toLowerCase())) continue;
		if (RAW.has(tag.name.toLowerCase())) {
			const end = new RegExp(`</${tag.name}\\s*>`, 'i').exec(text.slice(tag.end));
			if (end) {
				const start = tag.end + end.index;
				el.close = { name: tag.name, start, end: start + end[0].length, nameStart: start + 2, nameEnd: start + 2 + tag.name.length, attributes: [], selfClosing: false };
				el.end = el.close.end;
				i = el.end;
			} else el.end = i = text.length;
			continue;
		}
		stack.push(el);
	}
	while (stack.length) closeOpen(stack.pop()!, text.length);
	return { elements: roots, all, comments };
}

/** The element's inner range: between its tags (empty for a self-closing one). */
export const innerRange = (el: Element): [number, number] => [el.open.end, el.close ? el.close.start : el.open.end];

/** The innermost element containing [start, end] (its tags included). */
export function elementAt(m: Markup, start: number, end = start): Element | undefined {
	let best: Element | undefined;
	for (const el of m.all) if (el.start <= start && end <= el.end && (!best || el.start >= best.start)) best = el;
	return best;
}

const inside = (r: [number, number], s: number, e: number) => r[0] <= s && e <= r[1];
const same = (r: [number, number], s: number, e: number) => r[0] === s && r[1] === e;

/** Balance (outward): the next larger of an element's inner and outer ranges around the selection. */
export function balanceOut(m: Markup, s: number, e: number): [number, number] | undefined {
	for (let el = elementAt(m, s, e); el; el = el.parent) {
		const inner = innerRange(el);
		if (el.close && inner[1] > inner[0] && inside(inner, s, e) && !same(inner, s, e)) return inner;
		const outer: [number, number] = [el.start, el.end];
		if (inside(outer, s, e) && !same(outer, s, e)) return outer;
	}
	return undefined;
}

/** Balance (inward): from an element to its inner range, from an inner range to the first child. */
export function balanceIn(m: Markup, s: number, e: number): [number, number] | undefined {
	const el = elementAt(m, s, e);
	if (!el) return undefined;
	const inner = innerRange(el);
	if (s === e) return el.close && inner[1] > inner[0] && inside(inner, s, e) ? inner : [el.start, el.end];
	if (same([el.start, el.end], s, e)) return el.close && inner[1] > inner[0] ? inner : el.children[0] ? [el.children[0].start, el.children[0].end] : undefined;
	if (same(inner, s, e)) return el.children[0] ? [el.children[0].start, el.children[0].end] : undefined;
	const child = el.children.find((c) => c.start >= s && c.end <= e);
	return child ? [child.start, child.end] : undefined;
}

/** Go to Matching Pair: from the open tag (or the content) to the other tag. */
export function matchingTag(m: Markup, offset: number): number | undefined {
	const el = elementAt(m, offset);
	if (!el?.close) return undefined;
	if (offset >= el.close.start) return el.open.start;
	return offset <= el.open.end ? el.close.start : el.open.start;
}

export type TextEdit = { start: number; end: number; text: string };

const lineStart = (text: string, i: number) => text.lastIndexOf('\n', i - 1) + 1;
const lineEnd = (text: string, i: number) => {
	const n = text.indexOf('\n', i);
	return n < 0 ? text.length : n;
};

/** A tag's range, widened to its whole line when nothing else is on it (Remove Tag). */
function tagRange(text: string, tag: Tag): [number, number] {
	const ls = lineStart(text, tag.start);
	const le = lineEnd(text, tag.end);
	if (!text.slice(ls, tag.start).trim() && !text.slice(tag.end, le).trim()) return [ls, Math.min(text.length, le + 1)];
	return [tag.start, tag.end];
}

/** Remove Tag: the element's tags go, its content stays. */
export function removeTag(text: string, m: Markup, offset: number): TextEdit[] {
	const el = elementAt(m, offset);
	if (!el) return [];
	const open = tagRange(text, el.open);
	if (!el.close) return [{ start: open[0], end: open[1], text: '' }];
	const close = tagRange(text, el.close);
	// Content on its own lines moves out by one indentation level (the lines between the tags).
	const edits: TextEdit[] = [{ start: close[0], end: close[1], text: '' }];
	if (open[1] - open[0] > el.open.end - el.open.start) {
		const indent = /^[ \t]*/.exec(text.slice(open[1], el.close.start))![0];
		const outer = /^[ \t]*/.exec(text.slice(open[0]))![0];
		if (indent.length > outer.length) {
			const extra = indent.slice(outer.length);
			for (let ls = open[1]; ls < close[0]; ls = lineEnd(text, ls) + 1) if (text.startsWith(extra, ls)) edits.push({ start: ls, end: ls + extra.length, text: '' });
		}
	}
	edits.push({ start: open[0], end: open[1], text: '' });
	return edits.sort((a, b) => b.start - a.start);
}

/** Update Tag: a new name for the element's tags (empty: Remove Tag). */
export function updateTag(text: string, m: Markup, offset: number, name: string): TextEdit[] {
	if (!name.trim()) return removeTag(text, m, offset);
	const el = elementAt(m, offset);
	if (!el) return [];
	const edits: TextEdit[] = [];
	if (el.close) edits.push({ start: el.close.nameStart, end: el.close.nameEnd, text: name });
	edits.push({ start: el.open.nameStart, end: el.open.nameEnd, text: name });
	return edits;
}

/** Split/Join Tag: `<div></div>` ↔ `<div />` (`<div/>` outside JSX). */
export function splitJoinTag(text: string, m: Markup, offset: number, syntax: string): TextEdit[] {
	const el = elementAt(m, offset);
	if (!el) return [];
	if (el.open.selfClosing) {
		let slash = el.open.end - 2;
		while (slash > el.open.nameEnd && /\s/.test(text[slash - 1])) slash--;
		return [{ start: slash, end: el.open.end, text: `></${el.name}>` }];
	}
	if (!el.close) return [];
	return [{ start: el.open.end - 1, end: el.close.end, text: syntax === 'jsx' || syntax === 'xml' || syntax === 'xsl' ? ' />' : '/>' }];
}

/** Toggle Comment (markup): uncomment the comment around the cursor, else comment the selection or the element. */
export function toggleMarkupComment(text: string, m: Markup, s: number, e: number): TextEdit[] {
	const c = m.comments.find((c) => c.start <= s && e <= c.end);
	if (c) {
		const body = text.slice(c.start + 4, text.slice(c.end - 3, c.end) === '-->' ? c.end - 3 : c.end);
		return [{ start: c.start, end: c.end, text: body.replace(/^ /, '').replace(/ $/, '') }];
	}
	let [start, end] = [s, e];
	if (s === e) {
		const el = elementAt(m, s);
		if (!el) return [];
		[start, end] = [el.start, el.end];
	}
	// Comments inside the range are taken out first (HTML comments do not nest).
	const inner = m.comments.filter((c) => c.start >= start && c.end <= end);
	let body = text.slice(start, end);
	for (const c of [...inner].reverse()) body = body.slice(0, c.start - start) + text.slice(c.start + 4, c.end - 3).trim() + body.slice(c.end - start);
	return [{ start, end, text: `<!-- ${body} -->` }];
}

/** The ranges Select Next/Previous Item steps through in markup: tag names, attributes, values, class names. */
export function markupItems(text: string, m: Markup): [number, number][] {
	const out: [number, number][] = [];
	for (const el of m.all) {
		out.push([el.open.nameStart, el.open.nameEnd]);
		for (const a of el.open.attributes) {
			out.push([a.start, a.end]);
			if (a.valueStart === undefined || a.valueEnd === undefined || a.valueEnd <= a.valueStart) continue;
			out.push([a.valueStart, a.valueEnd]);
			if (a.name === 'class' || a.name === 'className') {
				const value = text.slice(a.valueStart, a.valueEnd);
				const words = [...value.matchAll(/\S+/g)];
				if (words.length > 1) for (const w of words) out.push([a.valueStart + w.index, a.valueStart + w.index + w[0].length]);
			}
		}
	}
	return out.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
}

/** Next/previous item after/before the selection (VS Code selectItem). */
export function stepItem(items: [number, number][], s: number, e: number, direction: 1 | -1): [number, number] | undefined {
	const at = items.findIndex((r) => r[0] === s && r[1] === e);
	if (at >= 0) return items[at + direction];
	return direction > 0 ? items.find((r) => r[0] >= s && !(r[0] === s && r[1] === e)) : [...items].reverse().find((r) => r[1] <= s || (r[0] < s && r[1] < e));
}

/** Merge Lines: the element at the cursor (or the selection's elements) on one line. */
export function mergeLines(text: string, m: Markup, s: number, e: number): TextEdit | undefined {
	const first = elementAt(m, s);
	const last = s === e ? first : elementAt(m, e);
	if (!first || !last) return undefined;
	const [start, end] = [Math.min(first.start, last.start), Math.max(first.end, last.end)];
	const body = text.slice(start, end);
	if (!body.includes('\n')) return undefined;
	const [head, ...rest] = body.split('\n');
	return { start, end, text: head + rest.map((l) => l.trim()).join('') };
}
