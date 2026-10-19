// Merge conflict markers in a text (VS Code's extensions/merge-conflict: mergeConflictParser.ts,
// documentMergeConflict.ts and the compare content provider). Line numbers are 1-based like
// Monaco's. Pure, so bun tests cover it.

import { splitLines } from './lineDiff';

const START = '<<<<<<<';
const ANCESTORS = '|||||||';
const SPLITTER = '=======';
const END = '>>>>>>>';

/** One side of a conflict: its marker line, the name after the marker, and its content lines (`from > to` when empty). */
export type ConflictRegion = { header: number; name: string; from: number; to: number };

export type Conflict = {
	/** The `<<<<<<<` line … the `>>>>>>>` line. */
	start: number;
	end: number;
	current: ConflictRegion;
	/** `|||||||` sections (diff3 / zdiff3 conflict style). */
	commonAncestors: ConflictRegion[];
	splitter: number;
	/** `header` is the `>>>>>>>` line. */
	incoming: ConflictRegion;
};

export type Resolution = 'current' | 'incoming' | 'both';

const strip = (line: string) => line.replace(/\r?\n$/, '');
const nameOf = (line: string, marker: string) => strip(line).slice(marker.length + 1);

/** Quick check before parsing (VS Code only scans documents that have both markers). */
export const hasConflictMarkers = (text: string) => text.includes(START) && text.includes(END);

/**
 * The conflicts of `text`, in order. Like VS Code, a `<<<<<<<` inside a conflict (nested
 * markers) stops the scan: the conflicts before it are kept, nothing after it is read.
 */
export function parseConflicts(text: string): Conflict[] {
	if (!hasConflictMarkers(text)) return [];
	const lines = splitLines(text);
	const out: Conflict[] = [];
	type Scan = { start: number; startText: string; ancestors: { line: number; text: string }[]; splitter?: number };
	let cur: Scan | null = null;
	for (let i = 0; i < lines.length; i++) {
		const text = strip(lines[i]);
		const line = i + 1;
		if (!text.trim()) continue;
		if (text.startsWith(START)) {
			if (cur) break;
			cur = { start: line, startText: lines[i], ancestors: [] };
		} else if (cur && cur.splitter === undefined && text.startsWith(ANCESTORS)) {
			cur.ancestors.push({ line, text: lines[i] });
		} else if (cur && cur.splitter === undefined && text === SPLITTER) {
			cur.splitter = line;
		} else if (cur && text.startsWith(END)) {
			if (cur.splitter !== undefined) {
				const afterCurrent = cur.ancestors[0]?.line ?? cur.splitter;
				out.push({
					start: cur.start,
					end: line,
					current: { header: cur.start, name: nameOf(cur.startText, START), from: cur.start + 1, to: afterCurrent - 1 },
					commonAncestors: cur.ancestors.map((a, k) => ({ header: a.line, name: nameOf(a.text, ANCESTORS), from: a.line + 1, to: (cur!.ancestors[k + 1]?.line ?? cur!.splitter!) - 1 })),
					splitter: cur.splitter,
					incoming: { header: line, name: nameOf(lines[i], END), from: cur.splitter + 1, to: line - 1 }
				});
			}
			cur = null;
		}
	}
	return out;
}

const regionText = (lines: readonly string[], r: ConflictRegion) => lines.slice(r.from - 1, r.to).join('');

/**
 * What a conflict's lines become (documentMergeConflict.applyEdit): one side's content, or both
 * (current then incoming). A side that is only a line break becomes nothing.
 */
export function resolutionText(lines: readonly string[], c: Conflict, kind: Resolution): string {
	const current = regionText(lines, c.current);
	const incoming = regionText(lines, c.incoming);
	const text = kind === 'current' ? current : kind === 'incoming' ? incoming : current + incoming;
	if (kind !== 'both' && (text === '\n' || text === '\r\n')) return '';
	// A footer without a line break (end of file) leaves the content's last break out too.
	return lines[c.end - 1].endsWith('\n') ? text : text.replace(/\r?\n$/, '');
}

/** `text` with the conflicts in `picks` (conflict index → resolution) resolved. */
export function resolveConflicts(text: string, picks: ReadonlyMap<number, Resolution>): string {
	const lines = splitLines(text);
	const conflicts = parseConflicts(text);
	let out = '';
	let at = 1;
	conflicts.forEach((c, i) => {
		const kind = picks.get(i);
		if (!kind) return;
		out += lines.slice(at - 1, c.start - 1).join('') + resolutionText(lines, c, kind);
		at = c.end + 1;
	});
	return out + lines.slice(at - 1).join('');
}

/** The two documents Compare Changes shows: every conflict as its current side, and as its incoming side. */
export function compareSides(text: string): { current: string; incoming: string } {
	const all = (kind: Resolution) => new Map(parseConflicts(text).map((_, i) => [i, kind] as const));
	return { current: resolveConflicts(text, all('current')), incoming: resolveConflicts(text, all('incoming')) };
}

/** The conflict holding `line`, else -1. */
export const conflictAt = (conflicts: readonly Conflict[], line: number) => conflicts.findIndex((c) => line >= c.start && line <= c.end);

/** Next (`1`) or previous (`-1`) conflict from `line`, wrapping; -1 when there are none. */
export function stepConflict(conflicts: readonly Conflict[], line: number, dir: 1 | -1): number {
	if (!conflicts.length) return -1;
	if (dir === 1) {
		const i = conflicts.findIndex((c) => c.start > line);
		return i < 0 ? 0 : i;
	}
	for (let i = conflicts.length - 1; i >= 0; i--) if (conflicts[i].end < line) return i;
	return conflicts.length - 1;
}
