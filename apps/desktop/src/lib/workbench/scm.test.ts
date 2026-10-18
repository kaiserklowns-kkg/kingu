import { describe, expect, test } from 'bun:test';
import { decoration, diffKey, fileDecorations, fileOf, groups, isDiffKey, smartCommitPaths, splitPath, tabLabel, type StatusEntry } from './scm';

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

describe('fileDecorations', () => {
	test('decorates files and colors their folders by the most important change', () => {
		const d = fileDecorations([
			{ path: 'src/lib/new.ts', code: '?' },
			{ path: 'src/lib/a.ts', code: 'M' },
			{ path: 'src/gone.ts', code: 'D' },
			{ path: 'README.md', code: 'M' }
		]);
		expect(d.get('src/lib/new.ts')).toEqual({ letter: 'U', color: '#73C991' });
		expect(d.get('src/lib/a.ts')?.letter).toBe('M');
		expect(d.get('src/lib')).toEqual({ letter: '', color: '#E2C08D' });
		expect(d.get('src')).toEqual({ letter: '', color: '#E2C08D' });
		expect(d.get('README.md')?.letter).toBe('M');
		expect(d.has('')).toBe(false);
	});

	test('lets a conflict win and prefixes paths', () => {
		const d = fileDecorations([{ path: 'a/x.ts', code: 'M' }, { path: 'a/y.ts', code: 'U', conflict: true }], 'wt/');
		expect(d.get('wt/a/y.ts')?.letter).toBe('!');
		expect(d.get('wt/a')?.color).toBe('#E4676B');
		expect(d.get('wt')?.color).toBe('#E4676B');
	});
});

describe('git.enableSmartCommit', () => {
	test('stages all changes or tracked ones only, never conflicts', () => {
		const { changes } = groups([e('a.ts', null, 'M'), e('new.ts', null, '?'), e('c.ts', 'U', 'U', { conflict: true }), e('d.ts', null, 'D')]);
		expect(smartCommitPaths(changes, 'all')).toEqual(['a.ts', 'd.ts', 'new.ts']);
		expect(smartCommitPaths(changes, 'tracked')).toEqual(['a.ts', 'd.ts']);
	});
});
