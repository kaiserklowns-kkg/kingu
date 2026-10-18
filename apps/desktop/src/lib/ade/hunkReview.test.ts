import { describe, expect, test } from 'bun:test';
import { keyOf } from '#lib/workbench/keys.ts';
import { acceptHunk, afterRemoval, HUNK_SHORTCUTS, hunkAt, hunkLines, isHunkAccepted, openHunks, pruneAcceptedHunks, sameMarks, stepFile, stepFrom, toggleHunk, type Hunk } from './hunkReview.ts';
import type { FileChange } from './model';

const h = (id: string, new_start: number, new_lines: number): Hunk => ({ id, old_start: new_start, old_lines: 1, new_start, new_lines });
const file = (path: string): FileChange => ({ path, orig_path: null, status: 'M', added: 1, deleted: 1 });

describe('accepted hunk marks', () => {
	const all = ['a1', 'a2', 'a3'];

	test('accepting hunks one by one ends with the file accepted', () => {
		let m: { accepted: string[]; accepted_hunks?: Record<string, string[]> } = { accepted: ['z.ts'] };
		m = toggleHunk(m, 'a.ts', 'a2', all);
		expect(m).toEqual({ accepted: ['z.ts'], accepted_hunks: { 'a.ts': ['a2'] } });
		expect(isHunkAccepted(m, 'a.ts', 'a2')).toBe(true);
		expect(isHunkAccepted(m, 'a.ts', 'a1')).toBe(false);
		m = acceptHunk(m, 'a.ts', 'a1', all)!;
		expect(acceptHunk(m, 'a.ts', 'a1', all)).toBeNull();
		m = toggleHunk(m, 'a.ts', 'a3', all);
		expect(m).toEqual({ accepted: ['a.ts', 'z.ts'], accepted_hunks: {} });
		expect(all.every((id) => isHunkAccepted(m, 'a.ts', id))).toBe(true);
	});

	test('un-accepting a hunk of an accepted file keeps the others', () => {
		const m = toggleHunk({ accepted: ['a.ts'] }, 'a.ts', 'a1', all);
		expect(m).toEqual({ accepted: [], accepted_hunks: { 'a.ts': ['a2', 'a3'] } });
		expect(toggleHunk(toggleHunk({ accepted: [] }, 'a.ts', 'a1', all), 'a.ts', 'a1', all)).toEqual({ accepted: [], accepted_hunks: {} });
	});

	test('pruning drops files that no longer change and stale ids of the shown file', () => {
		const marks = { 'a.ts': ['a1', 'gone'], 'b.ts': ['b1'], 'old.ts': ['o1'] };
		expect(pruneAcceptedHunks(marks, [file('a.ts'), file('b.ts')])).toEqual({ 'a.ts': ['a1', 'gone'], 'b.ts': ['b1'] });
		expect(pruneAcceptedHunks(marks, [file('a.ts'), file('b.ts')], 'a.ts', ['a1'])).toEqual({ 'a.ts': ['a1'], 'b.ts': ['b1'] });
		expect(pruneAcceptedHunks(marks, [file('a.ts')], 'a.ts', [])).toEqual({});
		expect(pruneAcceptedHunks(undefined, [])).toEqual({});
		expect(sameMarks(undefined, {})).toBe(true);
		expect(sameMarks(marks, {})).toBe(false);
	});

	test('open hunks are the ones not accepted', () => {
		const fh = { path: 'a.ts', whole_file: false, binary: false, hunks: [h('a1', 1, 1), h('a2', 5, 1)] };
		expect(openHunks({ accepted: [], accepted_hunks: { 'a.ts': ['a2'] } }, fh)).toEqual(['a1']);
		expect(openHunks({ accepted: ['a.ts'] }, fh)).toEqual([]);
	});
});

describe('navigation', () => {
	const hunks = [h('x', 3, 2), h('y', 10, 0), h('z', 20, 1)];

	test('hunk lines: a deletion is the line it follows', () => {
		expect(hunkLines(hunks[0])).toEqual([3, 4]);
		expect(hunkLines(hunks[1])).toEqual([10, 10]);
		expect(hunkLines(h('top', 0, 0))).toEqual([1, 1]);
	});

	test('the hunk at the cursor, else the next one, else the last', () => {
		expect(hunkAt(hunks, 1)).toBe(0);
		expect(hunkAt(hunks, 4)).toBe(0);
		expect(hunkAt(hunks, 5)).toBe(1);
		expect(hunkAt(hunks, 15)).toBe(2);
		expect(hunkAt(hunks, 99)).toBe(2);
		expect(hunkAt([], 1)).toBe(-1);
	});

	test('stepping hunks from the cursor stops at the ends (the next file takes over)', () => {
		expect(stepFrom(hunks, null, 1)).toBe(0);
		expect(stepFrom(hunks, null, -1)).toBe(2);
		expect(stepFrom(hunks, 4, 1)).toBe(1);
		expect(stepFrom(hunks, 10, 1)).toBe(2);
		expect(stepFrom(hunks, 20, 1)).toBeNull();
		expect(stepFrom(hunks, 3, -1)).toBeNull();
		expect(stepFrom(hunks, 1, 1)).toBe(0);
		expect(stepFrom(hunks, 15, 1)).toBe(2);
		expect(stepFrom(hunks, 15, -1)).toBe(1);
		expect(stepFrom(hunks, 2, -1)).toBeNull();
		expect(stepFrom(hunks, 99, -1)).toBe(2);
		expect(stepFrom([], 1, 1)).toBeNull();
		expect([afterRemoval(2, 2), afterRemoval(0, 2), afterRemoval(0, 0)]).toEqual([1, 0, -1]);
	});

	test('stepping files wraps around the review list', () => {
		const files = [file('a'), file('b'), file('c')];
		expect(stepFile(files, 'a', 1)).toBe('b');
		expect(stepFile(files, 'c', 1)).toBe('a');
		expect(stepFile(files, 'a', -1)).toBe('c');
		expect(stepFile(files, 'gone', 1)).toBe('a');
		expect(stepFile(files, 'gone', -1)).toBe('c');
		expect(stepFile([file('a')], 'a', 1)).toBeNull();
		expect(stepFile([], 'a', 1)).toBeNull();
	});
});

test("VS Code's review keys, none shared", () => {
	const keys = Object.values(HUNK_SHORTCUTS).map((s) => keyOf(s, true));
	expect(new Set(keys).size).toBe(keys.length);
	expect(keyOf(HUNK_SHORTCUTS.nextHunk, true)).toBe('alt+f5');
	expect(keyOf(HUNK_SHORTCUTS.acceptHunk, true)).toBe('cmd+y');
	expect(keyOf(HUNK_SHORTCUTS.rejectHunk, false)).toBe('cmd+n');
});
