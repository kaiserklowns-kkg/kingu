/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { applyLineChanges, changeAt, changeType, diffLines, diffTexts, intersectChange, mapLine, selectedChanges, splitLines, stepChange, toLineRanges, unifiedHunks, type LineChange } from './lineDiff';
import { indexPatch, mapRangeToOriginal, revertChange, revertRanges, stageChange, stageRanges, unstageRanges, unstageRangesOfIndex } from './staging';

const lc = (os: number, oe: number, ms: number, me: number): LineChange => ({ originalStartLineNumber: os, originalEndLineNumber: oe, modifiedStartLineNumber: ms, modifiedEndLineNumber: me });
const TEN = Array.from({ length: 10 }, (_, i) => `${i + 1}\n`).join('');

/** Applies unified hunks the way `git apply` reads them, checking every context and removed line. */
function applyPatch(original: string, hunks: string): string {
	const lines = splitLines(original);
	const out: string[] = [];
	let pos = 0;
	const body = hunks.split('\n');
	for (let i = 0; i < body.length; ) {
		const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@$/.exec(body[i]);
		if (!m) {
			i++;
			continue;
		}
		const count = m[2] === undefined ? 1 : Number(m[2]);
		const start = count === 0 ? Number(m[1]) : Number(m[1]) - 1;
		while (pos < start) out.push(lines[pos++]);
		i++;
		for (; i < body.length && !body[i].startsWith('@@'); i++) {
			const l = body[i];
			if (l === '' && i === body.length - 1) break;
			const noNl = body[i + 1] === '\\ No newline at end of file';
			const text = l.slice(1) + (noNl ? '' : '\n');
			if (l[0] === ' ' || l[0] === '-') {
				expect(lines[pos]).toBe(text);
				pos++;
				if (l[0] === ' ') out.push(text);
			} else if (l[0] === '+') out.push(text);
			if (noNl) i++;
		}
	}
	while (pos < lines.length) out.push(lines[pos++]);
	return out.join('');
}

describe('splitLines', () => {
	test('keeps terminators so joining gives the text back', () => {
		expect(splitLines('')).toEqual([]);
		expect(splitLines('a')).toEqual(['a']);
		expect(splitLines('a\nb\n')).toEqual(['a\n', 'b\n']);
		expect(splitLines('a\r\nb')).toEqual(['a\r\n', 'b']);
		expect(splitLines('\n\n')).toEqual(['\n', '\n']);
	});
});

describe('diffLines', () => {
	test('additions, modifications and deletions in VS Code’s LineChange shape', () => {
		expect(diffTexts(TEN, TEN)).toEqual([]);
		// Line 3 replaced, a line added after 6, line 9 deleted.
		const mod = TEN.replace('3\n', 'three\n').replace('6\n', '6\nnew\n').replace('9\n', '');
		const changes = diffTexts(TEN, mod);
		expect(changes).toEqual([lc(3, 3, 3, 3), lc(6, 0, 7, 7), lc(9, 9, 9, 0)]);
		expect(changes.map(changeType)).toEqual(['modified', 'added', 'deleted']);
	});

	test('changes at the very top and bottom, and empty sides', () => {
		expect(diffTexts('a\n', 'x\na\n')).toEqual([lc(0, 0, 1, 1)]);
		expect(diffTexts('a\nb\n', 'b\n')).toEqual([lc(1, 1, 0, 0)]);
		expect(diffTexts('', 'a\nb\n')).toEqual([lc(0, 0, 1, 2)]);
		expect(diffTexts('a\n', '')).toEqual([lc(1, 1, 0, 0)]);
		// A missing final newline is a change of the last line (as in git).
		expect(diffTexts('a\nb', 'a\nb\n')).toEqual([lc(2, 2, 2, 2)]);
	});

	test('a minimal diff of interleaved edits', () => {
		const a = splitLines('a\nb\nc\nd\ne\n');
		const b = splitLines('a\nc\nd\nx\ne\ny\n');
		const changes = diffLines(a, b);
		expect(changes).toEqual([lc(2, 2, 1, 0), lc(4, 0, 4, 4), lc(5, 0, 6, 6)]);
		expect(applyLineChanges(a, b, changes)).toBe(b.join(''));
	});

	test('ignoreTrimWhitespace', () => {
		expect(diffTexts('a\n  b\n', 'a\nb  \n', { ignoreTrimWhitespace: true })).toEqual([]);
		expect(diffTexts('a\n  b\n', 'a\nb  \n')).toEqual([lc(2, 2, 2, 2)]);
	});

	test('applying every change gives the modified text, none the original', () => {
		const cases: [string, string][] = [
			[TEN, TEN.replace('1\n', '').replace('10\n', '10\n11\n12')],
			['x', 'y\nx'],
			['a\nb\nc\n', 'c\nb\na\n'],
			['', 'only\n']
		];
		for (const [o, m] of cases) {
			const [a, b] = [splitLines(o), splitLines(m)];
			expect(applyLineChanges(a, b, diffLines(a, b))).toBe(m);
			expect(applyLineChanges(a, b, [])).toBe(o);
		}
	});

	test('a large file with a few edits stays fast', () => {
		const big = Array.from({ length: 20000 }, (_, i) => `line ${i}\n`);
		const edited = [...big];
		edited[100] = 'changed\n';
		edited.splice(15000, 0, 'inserted\n');
		const t0 = performance.now();
		expect(diffLines(big, edited)).toEqual([lc(101, 101, 101, 101), lc(15000, 0, 15001, 15001)]);
		expect(performance.now() - t0).toBeLessThan(500);
	});
});

describe('line mapping and navigation', () => {
	const changes = diffTexts(TEN, TEN.replace('3\n', 'three\nthree b\n').replace('8\n', ''));
	test('mapLine maps unchanged lines and gives null inside changes', () => {
		expect(changes).toEqual([lc(3, 3, 3, 4), lc(8, 8, 8, 0)]);
		expect([1, 2, 3, 4, 5, 7, 8, 9].map((l) => mapLine(changes, l))).toEqual([1, 2, null, null, 4, 6, 7, 9]);
	});
	test('next / previous change wrap around', () => {
		expect(stepChange(changes, 1, 1)).toBe(0);
		expect(stepChange(changes, 3, 1)).toBe(1);
		expect(stepChange(changes, 9, 1)).toBe(0);
		expect(stepChange(changes, 9, -1)).toBe(1);
		expect(stepChange(changes, 3, -1)).toBe(1);
		expect(changeAt(changes, 4)).toBe(0);
		expect(changeAt(changes, 8)).toBe(1);
		expect(changeAt(changes, 5)).toBe(-1);
		expect(stepChange([], 1, 1)).toBe(-1);
	});
});

describe('selected ranges', () => {
	test('toLineRanges merges overlapping and adjacent selections', () => {
		expect(toLineRanges([{ start: 5, end: 3 }, { start: 1, end: 1 }, { start: 2, end: 2 }, { start: 9, end: 10 }])).toEqual([
			{ start: 1, end: 5 },
			{ start: 9, end: 10 }
		]);
	});
	test('intersectChange cuts same-size changes line by line', () => {
		expect(intersectChange(lc(3, 6, 3, 6), { start: 4, end: 5 })).toEqual(lc(4, 5, 4, 5));
		expect(intersectChange(lc(3, 4, 3, 6), { start: 5, end: 9 })).toEqual(lc(3, 4, 5, 6));
		expect(intersectChange(lc(3, 3, 3, 3), { start: 4, end: 9 })).toBeNull();
		// A deletion after line 5 is touched by a selection of line 5 or 6.
		expect(intersectChange(lc(6, 6, 5, 0), { start: 5, end: 5 })).not.toBeNull();
		expect(intersectChange(lc(6, 6, 5, 0), { start: 6, end: 6 })).not.toBeNull();
		expect(intersectChange(lc(6, 6, 5, 0), { start: 7, end: 9 })).toBeNull();
		expect(intersectChange(lc(1, 1, 0, 0), { start: 1, end: 1 })).not.toBeNull();
	});
	test('selectedChanges keeps only the touched ones', () => {
		const changes = [lc(2, 2, 2, 2), lc(5, 0, 6, 7), lc(9, 9, 10, 0)];
		expect(selectedChanges(changes, [{ start: 6, end: 6 }])).toEqual([lc(5, 0, 6, 6)]);
		expect(selectedChanges(changes, [{ start: 1, end: 2 }, { start: 10, end: 10 }])).toEqual([lc(2, 2, 2, 2), lc(9, 9, 10, 0)]);
	});
});

describe('staging', () => {
	const head = TEN;
	const buffer = TEN.replace('2\n', 'two\n').replace('9\n', 'nine\n');

	test('stage selected ranges stages only the selected change', () => {
		const next = stageRanges(head, buffer, [{ start: 2, end: 2 }]);
		expect(next).toBe(TEN.replace('2\n', 'two\n'));
		expect(stageRanges(head, buffer, [{ start: 5, end: 5 }])).toBeNull();
		const patch = indexPatch(head, next!);
		expect(patch).toBe('@@ -1,5 +1,5 @@\n 1\n-2\n+two\n 3\n 4\n 5\n');
		expect(applyPatch(head, patch)).toBe(next!);
	});

	test('a selection over part of an added block stages those lines', () => {
		const buf = TEN.replace('5\n', '5\na\nb\nc\n');
		expect(stageRanges(TEN, buf, [{ start: 7, end: 7 }])).toBe(TEN.replace('5\n', '5\nb\n'));
	});

	test('revert selected ranges and the peek’s Stage / Revert', () => {
		expect(revertRanges(head, buffer, [{ start: 9, end: 9 }])).toBe(TEN.replace('2\n', 'two\n'));
		expect(revertRanges(head, buffer, [{ start: 4, end: 4 }])).toBeNull();
		const changes = diffTexts(head, buffer);
		expect(stageChange(head, buffer, changes[1])).toBe(TEN.replace('9\n', 'nine\n'));
		expect(revertChange(head, buffer, changes, 0)).toBe(TEN.replace('9\n', 'nine\n'));
	});

	test('unstage selected ranges takes staged lines back to HEAD', () => {
		const index = TEN.replace('2\n', 'two\n').replace('9\n', 'nine\n');
		expect(unstageRangesOfIndex(head, index, [{ start: 9, end: 9 }])).toBe(TEN.replace('2\n', 'two\n'));
		// From the buffer, whose extra unstaged lines shift the index lines down.
		const buf = index.replace('5\n', '5\nextra\nextra\n');
		expect(unstageRanges(head, index, buf, [{ start: 11, end: 11 }])).toBe(TEN.replace('2\n', 'two\n'));
		expect(unstageRanges(head, index, buf, [{ start: 6, end: 7 }])).toBeNull();
		expect(mapRangeToOriginal(diffTexts(index, buf), { start: 6, end: 7 })).toEqual({ start: 6, end: 5 });
	});

	test('patches carry a missing final newline', () => {
		const patch = indexPatch('a\nb', 'a\nb\nc\n');
		expect(patch).toBe('@@ -1,2 +1,3 @@\n a\n-b\n\\ No newline at end of file\n+b\n+c\n');
		expect(applyPatch('a\nb', patch)).toBe('a\nb\nc\n');
		expect(indexPatch('a\n', 'a\n')).toBe('');
		const toEmpty = indexPatch('', 'x\n');
		expect(toEmpty).toBe('@@ -0,0 +1,1 @@\n+x\n');
	});

	test('nearby changes share a hunk, distant ones get their own', () => {
		const lines = Array.from({ length: 30 }, (_, i) => `${i + 1}\n`).join('');
		const near = lines.replace('3\n', 'c\n').replace('8\n', 'h\n');
		expect(unifiedHunks(splitLines(lines), splitLines(near)).match(/^@@/gm)?.length).toBe(1);
		const far = lines.replace('3\n', 'c\n').replace('20\n', 't\n');
		const patch = indexPatch(lines, far);
		expect(patch.match(/^@@/gm)?.length).toBe(2);
		expect(applyPatch(lines, patch)).toBe(far);
	});
});
