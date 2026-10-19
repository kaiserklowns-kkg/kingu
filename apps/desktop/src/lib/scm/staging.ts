// What staging part of a file writes (VS Code's git.stageSelectedRanges, unstageSelectedRanges,
// revertSelectedRanges, stageChange and revertChange in extensions/git/src/commands.ts): new
// index or buffer text from the HEAD, index and buffer texts and the selected lines. The index
// text then goes to git as hunks (`unifiedHunks` → `scm_stage_patch` → `git apply --cached`).
// Pure, so bun tests cover it.

import { applyLineChanges, diffLines, invertLineChange, mapLine, selectedChanges, splitLines, touches, unifiedHunks, type LineChange, type LineRange } from './lineDiff';

/** The index with the buffer's changes inside `selections` staged; null when they touch none. */
export function stageRanges(index: string, buffer: string, selections: readonly LineRange[]): string | null {
	const [i, b] = [splitLines(index), splitLines(buffer)];
	const picked = selectedChanges(diffLines(i, b), selections);
	return picked.length ? applyLineChanges(i, b, picked) : null;
}

/** The buffer with the changes inside `selections` reverted to the index; null when they touch none. */
export function revertRanges(index: string, buffer: string, selections: readonly LineRange[]): string | null {
	const [i, b] = [splitLines(index), splitLines(buffer)];
	const changes = diffLines(i, b);
	const keep = changes.filter((c) => !touches(c, selections));
	return keep.length === changes.length ? null : applyLineChanges(i, b, keep);
}

/** One change of the quick diff staged (the peek's Stage). */
export function stageChange(index: string, buffer: string, change: LineChange): string {
	return applyLineChanges(splitLines(index), splitLines(buffer), [change]);
}

/** The buffer with change `at` of `changes` (index → buffer) reverted (the peek's Revert). */
export function revertChange(index: string, buffer: string, changes: readonly LineChange[], at: number): string {
	return applyLineChanges(splitLines(index), splitLines(buffer), changes.filter((_, i) => i !== at));
}

/**
 * Lines of the modified side as lines of the original: a line inside a change takes the change's
 * original lines (a selection on an added line reaches the place it was added).
 */
export function mapRangeToOriginal(changes: readonly LineChange[], r: LineRange): LineRange {
	const containing = (line: number) =>
		changes.find((c) => c.modifiedEndLineNumber !== 0 && line >= c.modifiedStartLineNumber && line <= c.modifiedEndLineNumber);
	const at = (line: number, edge: 'start' | 'end') => {
		const mapped = mapLine(changes, line);
		if (mapped !== null) return mapped;
		const c = containing(line)!;
		if (c.originalEndLineNumber === 0) return edge === 'start' ? c.originalStartLineNumber + 1 : c.originalStartLineNumber;
		return edge === 'start' ? c.originalStartLineNumber : c.originalEndLineNumber;
	};
	return { start: at(r.start, 'start'), end: at(r.end, 'end') };
}

/**
 * The index with its staged changes (HEAD → index) inside `selections` taken back to HEAD; null
 * when they touch none. `selections` are lines of the index text.
 */
export function unstageRangesOfIndex(head: string, index: string, selections: readonly LineRange[]): string | null {
	const [h, i] = [splitLines(head), splitLines(index)];
	const picked = selectedChanges(diffLines(h, i), selections);
	return picked.length ? applyLineChanges(i, h, picked.map(invertLineChange)) : null;
}

/** {@link unstageRangesOfIndex} with `selections` in the buffer (mapped through index → buffer). */
export function unstageRanges(head: string, index: string, buffer: string, selections: readonly LineRange[]): string | null {
	const working = diffLines(splitLines(index), splitLines(buffer));
	return unstageRangesOfIndex(head, index, selections.map((r) => mapRangeToOriginal(working, r)));
}

/** The hunks `git apply --cached` needs to turn `index` into `next`. */
export const indexPatch = (index: string, next: string) => unifiedHunks(splitLines(index), splitLines(next));
