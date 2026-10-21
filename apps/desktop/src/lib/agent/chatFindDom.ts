// Find in Chat over the rendered list (VS Code's chatFindContent / chatFindHighlights): the
// list's text as one string with where each text node starts, ranges for matches in it, and the
// highlights, painted with the CSS Custom Highlight API (the current match on its own layer).
// Without that API the current match is selected instead.

/** The list's text and where each of its text nodes starts in it. */
export type TextIndex = { text: string; nodes: { node: Text; start: number }[] };

/** Text in these is not searched: inputs, the find bar itself, anything marked. */
const SKIP = 'textarea, input, script, style, [data-chat-find-skip]';
/** Text in different blocks gets a line break between, so a match never joins two of them. */
const BLOCK = 'p, li, pre, div, h1, h2, h3, h4, h5, h6, td, th, blockquote, summary';

export function indexText(root: HTMLElement): TextIndex {
	const nodes: TextIndex['nodes'] = [];
	let text = '';
	let lastBlock: Element | null = null;
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode: (n) => (n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
	});
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		const node = n as Text;
		if (!node.data) continue;
		const block = node.parentElement?.closest(BLOCK) ?? null;
		if (text && block !== lastBlock) text += '\n';
		lastBlock = block;
		nodes.push({ node, start: text.length });
		text += node.data;
	}
	return { text, nodes };
}

/** The node holding offset `at` (the last whose start is at or before it). */
function nodeAt(index: TextIndex, at: number): number {
	let lo = 0;
	let hi = index.nodes.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (index.nodes[mid].start <= at) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/** A DOM range over `[start, end)` of the index's text. */
export function rangeAt(index: TextIndex, start: number, end: number): Range | null {
	if (!index.nodes.length) return null;
	const a = index.nodes[nodeAt(index, start)];
	const b = index.nodes[nodeAt(index, end - 1)];
	const range = document.createRange();
	try {
		range.setStart(a.node, Math.min(start - a.start, a.node.length));
		range.setEnd(b.node, Math.min(end - b.start, b.node.length));
	} catch {
		return null;
	}
	return range;
}

const ALL = 'kg-chat-find';
const CURRENT = 'kg-chat-find-current';

type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void };
const registry = (): HighlightRegistry | null => {
	const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
	return css?.highlights && typeof (globalThis as { Highlight?: unknown }).Highlight === 'function' ? css.highlights : null;
};

/** Paints the matches, the current one on top; without the Highlight API it selects the current one. */
export function paint(ranges: Range[], current: Range | null) {
	const reg = registry();
	if (reg) {
		const H = (globalThis as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight;
		reg.set(ALL, new H(...ranges));
		if (current) reg.set(CURRENT, new H(current));
		else reg.delete(CURRENT);
	} else if (current) {
		const sel = getSelection();
		sel?.removeAllRanges();
		sel?.addRange(current);
	}
}

export function clearPaint() {
	const reg = registry();
	reg?.delete(ALL);
	reg?.delete(CURRENT);
}

/** Scrolls `scroller` so the range is in view (centred when it was out of view). */
export function reveal(scroller: HTMLElement, range: Range) {
	const r = range.getBoundingClientRect();
	const box = scroller.getBoundingClientRect();
	// A sticky first request covers the top of the list: keep matches below it.
	const top = box.top + 48;
	if (r.top >= top && r.bottom <= box.bottom - 8) return;
	scroller.scrollTop += r.top - box.top - scroller.clientHeight / 2;
}
