/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { compareSides, conflictAt, parseConflicts, resolveConflicts, stepConflict, type Resolution } from './conflicts';
import { assembleResult, defaultStates, mergeRanges, rangeText, unresolvedCount } from './mergeModel';

// What `git merge` writes (merge.conflictStyle merge, then diff3).
const MERGE = ['1', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> other', '3', '<<<<<<< HEAD', 'a', 'b', '=======', '>>>>>>> other', 'end', ''].join('\n');
const DIFF3 = ['top', '<<<<<<< HEAD', 'ours', '||||||| 1a2b3c4', 'base', '=======', 'theirs', '>>>>>>> feature/x', ''].join('\n');

describe('parseConflicts', () => {
	test('merge style: regions, names and line numbers', () => {
		const [c, d] = parseConflicts(MERGE);
		expect(c).toEqual({
			start: 2,
			end: 6,
			current: { header: 2, name: 'HEAD', from: 3, to: 3 },
			commonAncestors: [],
			splitter: 4,
			incoming: { header: 6, name: 'other', from: 5, to: 5 }
		});
		expect(d.current).toEqual({ header: 8, name: 'HEAD', from: 9, to: 10 });
		expect(d.incoming.from > d.incoming.to).toBe(true);
	});

	test('diff3 style: the common ancestors section ends the current side', () => {
		const [c] = parseConflicts(DIFF3);
		expect(c.current).toEqual({ header: 2, name: 'HEAD', from: 3, to: 3 });
		expect(c.commonAncestors).toEqual([{ header: 4, name: '1a2b3c4', from: 5, to: 5 }]);
		expect(c.incoming.name).toBe('feature/x');
		expect(compareSides(DIFF3)).toEqual({ current: 'top\nours\n', incoming: 'top\ntheirs\n' });
	});

	test('nested markers stop the scan; incomplete conflicts are left out', () => {
		const nested = ['<<<<<<< a', 'x', '=======', 'y', '>>>>>>> b', '<<<<<<< c', '<<<<<<< d', 'z', '=======', '>>>>>>> e', ''].join('\n');
		expect(parseConflicts(nested).map((c) => c.start)).toEqual([1]);
		expect(parseConflicts(['<<<<<<< a', 'x', '>>>>>>> b', ''].join('\n'))).toEqual([]);
		expect(parseConflicts('no markers\n')).toEqual([]);
		// A `=======` with trailing text is content, not the splitter.
		const odd = parseConflicts(['<<<<<<< a', '======= no', '=======', 'y', '>>>>>>> b'].join('\n'));
		expect(odd[0].current).toMatchObject({ from: 2, to: 2 });
	});

	test('CRLF files', () => {
		const crlf = MERGE.replace(/\n/g, '\r\n');
		expect(parseConflicts(crlf).length).toBe(2);
		expect(resolveConflicts(crlf, new Map([[0, 'incoming' as Resolution]]))).toBe(crlf.replace('<<<<<<< HEAD\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> other\r\n', 'theirs\r\n'));
	});
});

describe('resolving', () => {
	test('accept current, incoming and both (current first)', () => {
		const pick = (kind: Resolution) => resolveConflicts(MERGE, new Map([[0, kind]]));
		expect(pick('current').split('\n').slice(0, 3)).toEqual(['1', 'ours', '3']);
		expect(pick('incoming').split('\n').slice(0, 3)).toEqual(['1', 'theirs', '3']);
		expect(pick('both').split('\n').slice(0, 4)).toEqual(['1', 'ours', 'theirs', '3']);
		const all = resolveConflicts(MERGE, new Map<number, Resolution>([[0, 'current'], [1, 'incoming']]));
		expect(all).toBe('1\nours\n3\nend\n');
		expect(parseConflicts(all)).toEqual([]);
	});

	test('a conflict at the end of a file without a final newline', () => {
		const text = 'x\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> other';
		expect(resolveConflicts(text, new Map([[0, 'current' as Resolution]]))).toBe('x\nours');
	});

	test('navigation', () => {
		const conflicts = parseConflicts(MERGE);
		expect(conflictAt(conflicts, 4)).toBe(0);
		expect(conflictAt(conflicts, 7)).toBe(-1);
		expect(stepConflict(conflicts, 1, 1)).toBe(0);
		expect(stepConflict(conflicts, 3, 1)).toBe(1);
		expect(stepConflict(conflicts, 13, 1)).toBe(0);
		expect(stepConflict(conflicts, 9, -1)).toBe(0);
		expect(stepConflict(conflicts, 1, -1)).toBe(1);
	});
});

describe('merge editor model', () => {
	const base = 'a\nb\nc\nd\ne\nf\n';
	// Incoming changes b and adds after f; current changes b differently and deletes d.
	const texts = { base, input1: 'a\nB1\nc\nd\ne\nf\ng\n', input2: 'a\nB2\nc\ne\nf\n' };

	test('ranges: a conflict where both sides changed, one-sided changes apart', () => {
		const doc = mergeRanges(texts);
		expect(doc.ranges.map((r) => [r.base, r.changed1, r.changed2, r.conflicting])).toEqual([
			[{ start: 1, end: 2 }, true, true, true],
			[{ start: 3, end: 4 }, false, true, false],
			[{ start: 6, end: 6 }, true, false, false]
		]);
		expect(doc.ranges[1].input1).toEqual({ start: 3, end: 4 });
		expect(doc.ranges[1].input2).toEqual({ start: 3, end: 3 });
		expect(doc.ranges[2].input2).toEqual({ start: 5, end: 5 });
	});

	test('the default result takes one-sided changes and leaves conflicts as the base', () => {
		const doc = mergeRanges(texts);
		const states = defaultStates(doc);
		const { text, spans } = assembleResult(doc, states);
		expect(text).toBe('a\nb\nc\ne\nf\ng\n');
		expect(spans).toEqual([
			{ start: 1, end: 2 },
			{ start: 3, end: 3 },
			{ start: 5, end: 6 }
		]);
		expect(unresolvedCount(doc, states)).toBe(1);
	});

	test('accepting inputs and combinations', () => {
		const doc = mergeRanges(texts);
		const states = defaultStates(doc);
		states[0] = { input1: true, input2: false };
		expect(assembleResult(doc, states).text).toBe('a\nB1\nc\ne\nf\ng\n');
		states[0] = { input1: true, input2: true };
		const both = assembleResult(doc, states);
		expect(both.text).toBe('a\nB1\nB2\nc\ne\nf\ng\n');
		expect(both.spans[1]).toEqual({ start: 4, end: 4 });
		expect(unresolvedCount(doc, states)).toBe(0);
		expect(rangeText(doc, doc.ranges[1], { input1: true, input2: false })).toBe('d\n');
	});

	test('the same change on both sides is not a conflict and is taken once', () => {
		const doc = mergeRanges({ base, input1: base.replace('c\n', 'C\n'), input2: base.replace('c\n', 'C\n') });
		expect(doc.ranges.map((r) => r.conflicting)).toEqual([false]);
		expect(assembleResult(doc, defaultStates(doc)).text).toBe(base.replace('c\n', 'C\n'));
		expect(rangeText(doc, doc.ranges[0], { input1: true, input2: true })).toBe('C\n');
	});

	test('a real merge: the result of both conflict-free sides equals git’s merge', () => {
		const b = '1\n2\n3\n4\n5\n6\n7\n8\n9\n';
		const doc = mergeRanges({ base: b, input1: b.replace('2\n', 'two\n'), input2: b.replace('8\n', 'eight\n') });
		expect(assembleResult(doc, defaultStates(doc)).text).toBe('1\ntwo\n3\n4\n5\n6\n7\neight\n9\n');
		expect(unresolvedCount(doc, defaultStates(doc))).toBe(0);
	});
});
