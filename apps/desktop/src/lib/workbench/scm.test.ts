import { describe, expect, test } from 'bun:test';
import { decoration, diffKey, fileOf, groups, isDiffKey, splitPath, tabLabel, type StatusEntry } from './scm';

const e = (path: string, index: string | null, worktree: string | null, extra: Partial<StatusEntry> = {}): StatusEntry => ({
	path,
	orig_path: null,
	index,
	worktree,
	conflict: false,
	...extra
});

describe('decoration', () => {
	test('uses VS Code letters and colors', () => {
		expect(decoration('M')).toEqual({ letter: 'M', color: '#E2C08D' });
		expect(decoration('?')).toEqual({ letter: 'U', color: '#73C991' });
		expect(decoration('A').color).toBe('#73C991');
		expect(decoration('D')).toEqual({ letter: 'D', color: '#F48771' });
		expect(decoration('R').letter).toBe('R');
		expect(decoration('U', true).letter).toBe('!');
	});
});

describe('groups', () => {
	test('puts a staged-then-edited file in both groups, sorted by path', () => {
		const { staged, changes } = groups([e('z.ts', null, '?'), e('b.ts', 'M', 'M'), e('a.ts', 'A', null), e('d.ts', null, 'D')]);
		expect(staged.map((r) => [r.entry.path, r.letter])).toEqual([
			['a.ts', 'A'],
			['b.ts', 'M']
		]);
		expect(changes.map((r) => [r.entry.path, r.letter])).toEqual([
			['b.ts', 'M'],
			['d.ts', 'D'],
			['z.ts', 'U']
		]);
		expect(changes[1].deleted).toBe(true);
	});

	test('keeps conflicts in Changes only', () => {
		const { staged, changes } = groups([e('c.ts', 'U', 'U', { conflict: true })]);
		expect(staged).toEqual([]);
		expect(changes[0].letter).toBe('!');
	});
});

describe('paths and tab keys', () => {
	test('splits name and folder', () => {
		expect(splitPath('src/lib/a.ts')).toEqual(['a.ts', 'src/lib']);
		expect(splitPath('a.ts')).toEqual(['a.ts', '']);
	});

	test('diff keys round-trip and label like VS Code', () => {
		const key = diffKey('src/a.ts');
		expect(isDiffKey(key)).toBe(true);
		expect(isDiffKey('src/a.ts')).toBe(false);
		expect(fileOf(key)).toBe('src/a.ts');
		expect(fileOf('src/a.ts')).toBe('src/a.ts');
		expect(tabLabel(key)).toBe('a.ts (Working Tree)');
		expect(tabLabel('src/a.ts')).toBe('a.ts');
	});
});
