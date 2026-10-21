// Editor line ↔ preview scroll position (VS Code's markdown preview scroll-sync): the preview's
// blocks carry their 0-based source line (`data-line`); a fractional line between two blocks maps
// to a position between their tops, and back. Pure, so `bun test` covers it.

/** A rendered block: its source line and its top in the preview's scroll coordinates. */
export type Block = { line: number; top: number };

/** Blocks ordered by line, one per line (the first, outermost, block of a line wins). */
export function normalizeBlocks(blocks: Block[]): Block[] {
	const byLine = new Map<number, Block>();
	for (const b of blocks) if (!byLine.has(b.line)) byLine.set(b.line, b);
	return [...byLine.values()].sort((a, b) => a.line - b.line);
}

/** The scroll top that shows source `line` (fractional, 0-based) at the top of the preview. */
export function scrollTopForLine(blocks: Block[], line: number): number {
	if (!blocks.length) return 0;
	let prev = blocks[0];
	if (line <= prev.line) return prev.line > 0 ? Math.max(0, prev.top * (line / prev.line)) : prev.top;
	for (const next of blocks.slice(1)) {
		if (next.line > line) return prev.top + ((line - prev.line) / (next.line - prev.line)) * (next.top - prev.top);
		prev = next;
	}
	return prev.top;
}

/** The fractional source line at preview scroll top `top` (the inverse of scrollTopForLine). */
export function lineForScrollTop(blocks: Block[], top: number): number {
	if (!blocks.length) return 0;
	let prev = blocks[0];
	if (top <= prev.top) return prev.top > 0 ? prev.line * Math.max(0, top / prev.top) : prev.line;
	for (const next of blocks.slice(1)) {
		if (next.top > top) return prev.line + ((top - prev.top) / Math.max(1, next.top - prev.top)) * (next.line - prev.line);
		prev = next;
	}
	return prev.line;
}

/** The block holding source `line` (the last one starting at or before it), for markEditorSelection. */
export function blockIndexForLine(lines: number[], line: number): number {
	let best = -1;
	for (let i = 0; i < lines.length; i++) if (lines[i] <= line && (best < 0 || lines[i] >= lines[best])) best = i;
	return best;
}
