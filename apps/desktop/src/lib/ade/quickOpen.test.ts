import { describe, expect, test } from 'bun:test';
import { HISTORY_FILES, HISTORY_SCOPES, historyOf, historyScope, parseHistory, parseTarget, rankWithHistory, recordVisit, relInWorktree, worktreeFile, type QuickOpenHistory } from './quickOpen';

const files = ['src/lib/b.ts', 'src/lib/a.ts', 'README.md', 'src/app.ts', 'docs/notes.md'];

describe('ranking with history (Orca rankQuickOpenFilesWithHistory)', () => {
	test('empty query: recent files first, most recent first, then the rest in path order', () => {
		const r = rankWithHistory('', files, ['src/app.ts', 'gone.ts', 'README.md']);
		expect(r.map((x) => [x.path, x.recent])).toEqual([
			['src/app.ts', true],
			['README.md', true],
			['docs/notes.md', false],
			['src/lib/a.ts', false],
			['src/lib/b.ts', false]
		]);
	});

	test('a query keeps only matching recent files on top, the others by score', () => {
		const r = rankWithHistory('a.ts', files, ['README.md', 'src/lib/a.ts']);
		expect(r[0]).toMatchObject({ path: 'src/lib/a.ts', recent: true });
		expect(r.some((x) => x.path === 'README.md')).toBe(false);
		expect(r.filter((x) => x.recent)).toHaveLength(1);
	});

	test('a file is listed once and the limit holds', () => {
		const many = Array.from({ length: 80 }, (_, i) => `f${i}.ts`);
		const r = rankWithHistory('', many, ['f5.ts', 'f5.ts']);
		expect(r).toHaveLength(50);
		expect(r.filter((x) => x.path === 'f5.ts')).toHaveLength(1);
	});
});

describe('history', () => {
	test('a visit moves to the front of its scope, scopes most recent first', () => {
		let h: QuickOpenHistory = [];
		h = recordVisit(h, 's1', 'a.ts');
		h = recordVisit(h, 's1', 'b.ts');
		h = recordVisit(h, 's2', 'x.ts');
		h = recordVisit(h, 's1', 'a.ts');
		expect(historyOf(h, 's1')).toEqual(['a.ts', 'b.ts']);
		expect(h.map(([s]) => s)).toEqual(['s1', 's2']);
		expect(recordVisit(h, 's1', 'a.ts')).toBe(h);
		expect(recordVisit(h, 's1', '../etc/passwd')).toBe(h);
	});

	test('caps files per scope and scopes', () => {
		let h: QuickOpenHistory = [];
		for (let i = 0; i < HISTORY_FILES + 5; i++) h = recordVisit(h, 's', `f${i}`);
		expect(historyOf(h, 's')).toHaveLength(HISTORY_FILES);
		expect(historyOf(h, 's')[0]).toBe(`f${HISTORY_FILES + 4}`);
		for (let i = 0; i < HISTORY_SCOPES + 3; i++) h = recordVisit(h, `scope${i}`, 'a');
		expect(h).toHaveLength(HISTORY_SCOPES);
		expect(historyOf(h, 's')).toEqual([]);
	});

	test('stored history is checked', () => {
		expect(parseHistory([['s', ['a', '/abs', 'x/../y', 'a', 3]], ['s', ['dup']], 'bad', [1, []]])).toEqual([['s', ['a']]]);
		expect(parseHistory('nope')).toEqual([]);
		expect(historyScope('/r', '')).not.toBe(historyScope('/r', 'task'));
	});
});

describe('path:line targets', () => {
	const listed = new Set(['src/a.ts', 'odd:12']);
	test('line and column', () => {
		expect(parseTarget('a.ts:12', listed)).toEqual({ query: 'a.ts', line: 12, column: undefined });
		expect(parseTarget('a.ts:12:4', listed)).toEqual({ query: 'a.ts', line: 12, column: 4 });
	});
	test('an exact listed path, a drive letter or line 0 stays a query', () => {
		expect(parseTarget('odd:12', listed)).toEqual({ query: 'odd:12' });
		expect(parseTarget('C:5', listed)).toEqual({ query: 'C:5' });
		expect(parseTarget('a.ts:0', listed)).toEqual({ query: 'a.ts:0' });
	});
});

test('worktree paths', () => {
	expect(worktreeFile('.kingu/worktrees/t', 'src/a.ts')).toBe('.kingu/worktrees/t/src/a.ts');
	expect(worktreeFile('', 'src/a.ts')).toBe('src/a.ts');
	expect(relInWorktree('.kingu/worktrees/t', '.kingu/worktrees/t/src/a.ts')).toBe('src/a.ts');
	expect(relInWorktree('.kingu/worktrees/t', 'src/a.ts')).toBeNull();
	expect(relInWorktree('', '.kingu/worktrees/t/a.ts')).toBeNull();
});
