// Line diffs for Source Control in the editor (VS Code: the dirty diff's LineChange and the git
// extension's staging.ts). Pure, so bun tests cover it.
//
// Text is split into lines that keep their terminator ('a\nb' → ['a\n', 'b']), so a missing final
// newline is a real difference (as in git) and joining lines gives back the exact text. Line
// numbers are 1-based like Monaco's; line k of the array is Monaco line k (a text ending in a
// newline has one more, empty, Monaco line that no change ever names).
//
// A LineChange is VS Code's: an insertion has `originalEndLineNumber: 0` and
// `originalStartLineNumber` = the original line it follows (0 at the top); a deletion has
// `modifiedEndLineNumber: 0` and `modifiedStartLineNumber` = the modified line it follows.

export type LineChange = {
	readonly originalStartLineNumber: number;
	readonly originalEndLineNumber: number;
	readonly modifiedStartLineNumber: number;
	readonly modifiedEndLineNumber: number;
};

export type ChangeType = 'added' | 'modified' | 'deleted';

/** Lines with their terminators; `''` has none. */
export function splitLines(text: string): string[] {
	const out: string[] = [];
	let start = 0;
	for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', start)) {
		out.push(text.slice(start, i + 1));
		start = i + 1;
	}
	if (start < text.length) out.push(text.slice(start));
	return out;
}

/** VS Code's quick diff kinds (dirtydiffDecorator getChangeType). */
export function changeType(c: LineChange): ChangeType {
	if (c.originalEndLineNumber === 0) return 'added';
	if (c.modifiedEndLineNumber === 0) return 'deleted';
	return 'modified';
}

/** A change range in 0-based, end-exclusive indexes. */
type Span = { a0: number; a1: number; b0: number; b1: number };

function toLineChange({ a0, a1, b0, b1 }: Span): LineChange {
	if (a0 === a1) return { originalStartLineNumber: a0, originalEndLineNumber: 0, modifiedStartLineNumber: b0 + 1, modifiedEndLineNumber: b1 };
	if (b0 === b1) return { originalStartLineNumber: a0 + 1, originalEndLineNumber: a1, modifiedStartLineNumber: b0, modifiedEndLineNumber: 0 };
	return { originalStartLineNumber: a0 + 1, originalEndLineNumber: a1, modifiedStartLineNumber: b0 + 1, modifiedEndLineNumber: b1 };
}

function toSpan(c: LineChange): Span {
	const a0 = c.originalEndLineNumber === 0 ? c.originalStartLineNumber : c.originalStartLineNumber - 1;
	const a1 = c.originalEndLineNumber === 0 ? a0 : c.originalEndLineNumber;
	const b0 = c.modifiedEndLineNumber === 0 ? c.modifiedStartLineNumber : c.modifiedStartLineNumber - 1;
	const b1 = c.modifiedEndLineNumber === 0 ? b0 : c.modifiedEndLineNumber;
	return { a0, a1, b0, b1 };
}

/** Past this many edits the middle of the files becomes one change (keeps a typing editor fast). */
const MAX_EDITS = 4000;

/** Myers' O(ND) diff of two id arrays: the spans that differ, in order. */
function myers(a: Int32Array, b: Int32Array, lo: number, hiA: number, hiB: number): Span[] {
	const n = hiA - lo;
	const m = hiB - lo;
	if (n === 0 && m === 0) return [];
	if (n === 0 || m === 0) return [{ a0: lo, a1: hiA, b0: lo, b1: hiB }];
	const max = Math.min(n + m, MAX_EDITS);
	const off = max + 1;
	const v = new Int32Array(2 * max + 3);
	const trace: Int32Array[] = [];
	let end = -1;
	for (let d = 0; d <= max && end < 0; d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
			let y = x - k;
			while (x < n && y < m && a[lo + x] === b[lo + y]) {
				x++;
				y++;
			}
			v[off + k] = x;
			if (x >= n && y >= m) {
				end = d;
				break;
			}
		}
	}
	if (end < 0) return [{ a0: lo, a1: hiA, b0: lo, b1: hiB }];
	// Walk back through the trace collecting the matched pairs.
	const matches: [number, number][] = [];
	let x = n;
	let y = m;
	for (let d = end; d >= 0; d--) {
		const vd = trace[d];
		const k = x - y;
		const prevK = k === -d || (k !== d && vd[off + k - 1] < vd[off + k + 1]) ? k + 1 : k - 1;
		const prevX = d === 0 ? 0 : vd[off + prevK];
		const prevY = d === 0 ? 0 : prevX - prevK;
		while (x > prevX && y > prevY) {
			x--;
			y--;
			matches.push([x, y]);
		}
		x = prevX;
		y = prevY;
	}
	matches.reverse();
	const spans: Span[] = [];
	let i = 0;
	let j = 0;
	for (const [mx, my] of [...matches, [n, m] as [number, number]]) {
		if (mx > i || my > j) spans.push({ a0: lo + i, a1: lo + mx, b0: lo + j, b1: lo + my });
		i = mx + 1;
		j = my + 1;
	}
	return spans;
}

/** The changes from `original` to `modified` lines. `ignoreTrimWhitespace` compares trimmed lines. */
export function diffLines(original: readonly string[], modified: readonly string[], opts: { ignoreTrimWhitespace?: boolean } = {}): LineChange[] {
	const ids = new Map<string, number>();
	const key = opts.ignoreTrimWhitespace ? (s: string) => s.trim() : (s: string) => s;
	const id = (s: string) => {
		const k = key(s);
		let n = ids.get(k);
		if (n === undefined) ids.set(k, (n = ids.size));
		return n;
	};
	const a = Int32Array.from(original, id);
	const b = Int32Array.from(modified, id);
	// Common prefix and suffix first: most edits touch a few lines of a long file.
	let lo = 0;
	while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
	let hiA = a.length;
	let hiB = b.length;
	while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) {
		hiA--;
		hiB--;
	}
	return myers(a, b, lo, hiA, hiB).map(toLineChange);
}

/** {@link diffLines} of two texts. */
export const diffTexts = (original: string, modified: string, opts?: { ignoreTrimWhitespace?: boolean }) => diffLines(splitLines(original), splitLines(modified), opts);

/**
 * VS Code's applyLineChanges: `original` with `changes` (from original to modified) applied, the
 * rest left as in `original`.
 */
export function applyLineChanges(original: readonly string[], modified: readonly string[], changes: readonly LineChange[]): string {
	const out: string[] = [];
	let cur = 0;
	for (const c of [...changes].sort(compareLineChanges)) {
		const s = toSpan(c);
		for (let i = cur; i < s.a0; i++) out.push(original[i]);
		for (let i = s.b0; i < s.b1; i++) out.push(modified[i]);
		cur = s.a1;
	}
	for (let i = cur; i < original.length; i++) out.push(original[i]);
	return out.join('');
}

export function compareLineChanges(a: LineChange, b: LineChange): number {
	const sa = toSpan(a);
	const sb = toSpan(b);
	return sa.a0 - sb.a0 || sa.a1 - sb.a1;
}

export function invertLineChange(c: LineChange): LineChange {
	return {
		originalStartLineNumber: c.modifiedStartLineNumber,
		originalEndLineNumber: c.modifiedEndLineNumber,
		modifiedStartLineNumber: c.originalStartLineNumber,
		modifiedEndLineNumber: c.originalEndLineNumber
	};
}

/** A selection as whole lines, 1-based and inclusive (VS Code's toLineRanges takes the end line even at column 1). */
export type LineRange = { start: number; end: number };

/** Sorted, with overlapping and adjacent ranges merged (staging.ts toLineRanges). */
export function toLineRanges(selections: readonly LineRange[]): LineRange[] {
	const sorted = selections.map((s) => ({ start: Math.min(s.start, s.end), end: Math.max(s.start, s.end) })).sort((a, b) => a.start - b.start);
	const out: LineRange[] = [];
	for (const r of sorted) {
		const last = out[out.length - 1];
		if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
		else out.push({ ...r });
	}
	return out;
}

/**
 * The part of `c` inside `range` (lines of the modified side), or null (staging.ts
 * intersectDiffWithRange): a deletion counts when the selection touches the line break it sits
 * on; a change with as many lines on both sides is cut line by line.
 */
export function intersectChange(c: LineChange, range: LineRange): LineChange | null {
	if (c.modifiedEndLineNumber === 0) {
		const after = c.modifiedStartLineNumber;
		return range.start <= after + 1 && range.end >= Math.max(after, 1) ? c : null;
	}
	const lo = Math.max(range.start, c.modifiedStartLineNumber);
	const hi = Math.min(range.end, c.modifiedEndLineNumber);
	if (lo > hi) return null;
	if (c.originalEndLineNumber !== 0 && c.originalEndLineNumber - c.originalStartLineNumber === c.modifiedEndLineNumber - c.modifiedStartLineNumber) {
		const delta = lo - c.modifiedStartLineNumber;
		return { originalStartLineNumber: c.originalStartLineNumber + delta, originalEndLineNumber: c.originalStartLineNumber + delta + (hi - lo), modifiedStartLineNumber: lo, modifiedEndLineNumber: hi };
	}
	return { originalStartLineNumber: c.originalStartLineNumber, originalEndLineNumber: c.originalEndLineNumber, modifiedStartLineNumber: lo, modifiedEndLineNumber: hi };
}

/** The changes (or parts of them) the selections touch. */
export function selectedChanges(changes: readonly LineChange[], selections: readonly LineRange[]): LineChange[] {
	const ranges = toLineRanges(selections);
	return changes.map((c) => ranges.reduce<LineChange | null>((hit, r) => hit ?? intersectChange(c, r), null)).filter((c): c is LineChange => c !== null);
}

/** Whether a change touches the selections (revertSelectedRanges keeps the ones that don't). */
export const touches = (c: LineChange, selections: readonly LineRange[]) => toLineRanges(selections).some((r) => intersectChange(c, r) !== null);

/**
 * Where modified line `line` came from in the original, or null when it is new or changed
 * (blame of an unsaved buffer; a working tree line's index line).
 */
export function mapLine(changes: readonly LineChange[], line: number): number | null {
	let delta = 0;
	for (const c of changes) {
		const s = toSpan(c);
		if (line <= s.b0) break;
		if (line <= s.b1) return null;
		delta = s.a1 - s.b1;
	}
	return line + delta;
}

/** Index of the change at or after `line` going `dir` (wrapping), for next / previous change. */
export function stepChange(changes: readonly LineChange[], line: number, dir: 1 | -1): number {
	if (!changes.length) return -1;
	const start = (c: LineChange) => Math.max(1, c.modifiedStartLineNumber);
	const end = (c: LineChange) => Math.max(start(c), c.modifiedEndLineNumber);
	if (dir === 1) {
		const i = changes.findIndex((c) => start(c) > line);
		return i < 0 ? 0 : i;
	}
	for (let i = changes.length - 1; i >= 0; i--) if (end(changes[i]) < line) return i;
	return changes.length - 1;
}

/** The change whose lines hold `line` (a deletion: the line it follows), or -1. */
export function changeAt(changes: readonly LineChange[], line: number): number {
	return changes.findIndex((c) => {
		const s = Math.max(1, c.modifiedStartLineNumber);
		const e = c.modifiedEndLineNumber === 0 ? s : c.modifiedEndLineNumber;
		return line >= s && line <= e;
	});
}

/**
 * Unified diff hunks (no file header) from `original` to `modified`, with `context` lines around
 * each change, for `git apply`. A last line without a newline gets git's "\ No newline at end
 * of file" marker.
 */
export function unifiedHunks(original: readonly string[], modified: readonly string[], context = 3): string {
	const spans = diffLines(original, modified).map(toSpan);
	if (!spans.length) return '';
	const groups: Span[][] = [];
	for (const s of spans) {
		const last = groups[groups.length - 1];
		if (last && s.a0 - last[last.length - 1].a1 <= 2 * context) last.push(s);
		else groups.push([s]);
	}
	const line = (prefix: string, text: string) => (text.endsWith('\n') ? `${prefix}${text}` : `${prefix}${text}\n\\ No newline at end of file\n`);
	let out = '';
	for (const g of groups) {
		const first = g[0];
		const last = g[g.length - 1];
		const a0 = Math.max(0, first.a0 - context);
		const b0 = first.b0 - (first.a0 - a0);
		const a1 = Math.min(original.length, last.a1 + context);
		const b1 = last.b1 + (a1 - last.a1);
		const head = (start: number, count: number) => `${count === 0 ? start : start + 1},${count}`;
		out += `@@ -${head(a0, a1 - a0)} +${head(b0, b1 - b0)} @@\n`;
		let ai = a0;
		for (const s of g) {
			for (; ai < s.a0; ai++) out += line(' ', original[ai]);
			for (let i = s.a0; i < s.a1; i++) out += line('-', original[i]);
			for (let i = s.b0; i < s.b1; i++) out += line('+', modified[i]);
			ai = s.a1;
		}
		for (; ai < a1; ai++) out += line(' ', original[ai]);
	}
	return out;
}
