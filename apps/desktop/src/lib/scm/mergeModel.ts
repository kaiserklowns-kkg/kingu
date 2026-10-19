// The 3-way merge editor's model (VS Code's mergeEditor: ModifiedBaseRange, the input states and
// the result assembled from them). Input 1 is Incoming (stage 3, theirs), input 2 is Current
// (stage 2, ours), both diffed against the base (stage 1). Ranges are 0-based, end-exclusive line
// indexes into the split texts (lineDiff.splitLines). Pure, so bun tests cover it.

import { diffLines, splitLines, type LineChange } from './lineDiff';

type Span = { a0: number; a1: number; b0: number; b1: number };

const span = (c: LineChange): Span => {
	const a0 = c.originalEndLineNumber === 0 ? c.originalStartLineNumber : c.originalStartLineNumber - 1;
	const b0 = c.modifiedEndLineNumber === 0 ? c.modifiedStartLineNumber : c.modifiedStartLineNumber - 1;
	return { a0, a1: c.originalEndLineNumber === 0 ? a0 : c.originalEndLineNumber, b0, b1: c.modifiedEndLineNumber === 0 ? b0 : c.modifiedEndLineNumber };
};

export type LineSpan = { start: number; end: number };

/** A base range one or both inputs changed (VS Code's ModifiedBaseRange). */
export type MergeRange = {
	base: LineSpan;
	input1: LineSpan;
	input2: LineSpan;
	changed1: boolean;
	changed2: boolean;
	/** Both inputs changed it, differently. */
	conflicting: boolean;
};

/** Which inputs a range takes in the result (both: input 1 first, VS Code's "Accept Combination"). */
export type RangeState = { input1: boolean; input2: boolean };

export type MergeTexts = { base: string; input1: string; input2: string };

export type MergeDoc = { base: string[]; input1: string[]; input2: string[]; ranges: MergeRange[] };

/** The input line a base line outside every change of `spans` maps to. */
function mapThrough(spans: Span[], line: number): number {
	let delta = 0;
	for (const s of spans) {
		if (s.a0 >= line) break;
		delta = s.b1 - s.a1;
	}
	return line + delta;
}

export function mergeRanges(texts: MergeTexts): MergeDoc {
	const base = splitLines(texts.base);
	const input1 = splitLines(texts.input1);
	const input2 = splitLines(texts.input2);
	const s1 = diffLines(base, input1).map(span);
	const s2 = diffLines(base, input2).map(span);
	// Changes of either side that overlap or touch in the base are one range.
	const all = [...s1.map((s) => ({ s, side: 1 as const })), ...s2.map((s) => ({ s, side: 2 as const }))].sort((a, b) => a.s.a0 - b.s.a0 || a.s.a1 - b.s.a1);
	const clusters: { a0: number; a1: number; one: Span[]; two: Span[] }[] = [];
	for (const { s, side } of all) {
		const last = clusters[clusters.length - 1];
		if (last && s.a0 <= last.a1) {
			last.a1 = Math.max(last.a1, s.a1);
			(side === 1 ? last.one : last.two).push(s);
		} else clusters.push({ a0: s.a0, a1: s.a1, one: side === 1 ? [s] : [], two: side === 2 ? [s] : [] });
	}
	const inputSpan = (mine: Span[], every: Span[], a0: number, a1: number): LineSpan => {
		if (!mine.length) {
			const start = mapThrough(every, a0);
			return { start, end: start + (a1 - a0) };
		}
		const first = mine[0];
		const last = mine[mine.length - 1];
		return { start: first.b0 - (first.a0 - a0), end: last.b1 + (a1 - last.a1) };
	};
	const ranges = clusters.map((c): MergeRange => {
		const i1 = inputSpan(c.one, s1, c.a0, c.a1);
		const i2 = inputSpan(c.two, s2, c.a0, c.a1);
		const changed1 = c.one.length > 0;
		const changed2 = c.two.length > 0;
		const same = input1.slice(i1.start, i1.end).join('') === input2.slice(i2.start, i2.end).join('');
		return { base: { start: c.a0, end: c.a1 }, input1: i1, input2: i2, changed1, changed2, conflicting: changed1 && changed2 && !same };
	});
	return { base, input1, input2, ranges };
}

/** VS Code's initial result: changes of one side (or the same change on both) taken, conflicts left as the base. */
export function defaultStates(doc: MergeDoc): RangeState[] {
	return doc.ranges.map((r) => (r.conflicting ? { input1: false, input2: false } : { input1: r.changed1, input2: r.changed2 && !r.changed1 }));
}

/** The result lines of one range in `state`. */
export function rangeText(doc: MergeDoc, r: MergeRange, state: RangeState): string {
	const one = doc.input1.slice(r.input1.start, r.input1.end).join('');
	const two = doc.input2.slice(r.input2.start, r.input2.end).join('');
	if (state.input1 && state.input2) return one === two ? one : one + two;
	if (state.input1) return one;
	if (state.input2) return two;
	return doc.base.slice(r.base.start, r.base.end).join('');
}

/** The result text and, per range, its lines in it (0-based, end-exclusive). */
export function assembleResult(doc: MergeDoc, states: readonly RangeState[]): { text: string; spans: LineSpan[] } {
	let text = '';
	let line = 0;
	let at = 0;
	const spans: LineSpan[] = [];
	doc.ranges.forEach((r, i) => {
		const before = doc.base.slice(at, r.base.start);
		text += before.join('');
		line += before.length;
		const part = rangeText(doc, r, states[i]);
		const n = splitLines(part).length;
		spans.push({ start: line, end: line + n });
		text += part;
		line += n;
		at = r.base.end;
	});
	text += doc.base.slice(at).join('');
	return { text, spans };
}

/** Conflicting ranges no input has been taken for (Complete Merge asks first). */
export const unresolvedCount = (doc: MergeDoc, states: readonly RangeState[]) => doc.ranges.filter((r, i) => r.conflicting && !states[i].input1 && !states[i].input2).length;
