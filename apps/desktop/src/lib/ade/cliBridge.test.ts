import { describe, expect, test } from 'bun:test';
import { dirOf, editorOpens, openTarget, profileFor, waitOver } from './cliBridge.ts';

describe('kingu [options] [paths…]', () => {
	// Workspace files by relative path, anything else as an external key.
	const keyFor = (p: string) => (p.startsWith('/repo/') ? p.slice('/repo/'.length) : `external:${p}`);
	const f = (path: string, line: number | null = null, column: number | null = null) => ({ path, line, column });

	test('opens each file, at its position with -g', () => {
		expect(editorOpens({ mode: 'open', files: [f('/repo/a.ts', 3, 7), f('/etc/hosts'), f('/repo/b.ts', 9)] }, keyFor)).toEqual([
			{ kind: 'file', key: 'a.ts', line: 3, column: 7 },
			{ kind: 'file', key: 'external:/etc/hosts', line: null, column: null },
			{ kind: 'file', key: 'b.ts', line: 9, column: 1 }
		]);
		expect(editorOpens({ mode: 'open', files: [] }, keyFor)).toEqual([]);
	});

	test('-d compares two files, -m shows both versions and opens the result', () => {
		expect(editorOpens({ mode: 'diff', files: [f('/repo/a.ts'), f('/tmp/b.ts')] }, keyFor)).toEqual([{ kind: 'compare', left: 'a.ts', right: 'external:/tmp/b.ts' }]);
		expect(editorOpens({ mode: 'merge', files: [f('/repo/ours'), f('/repo/theirs'), f('/repo/base'), f('/repo/out')] }, keyFor)).toEqual([
			{ kind: 'compare', left: 'ours', right: 'theirs' },
			{ kind: 'file', key: 'out', line: null, column: null }
		]);
	});

	test('--wait is over once none of its editors is open', () => {
		expect(waitOver(['a.ts', 'b.ts'], ['b.ts', 'c.ts'])).toBe(false);
		expect(waitOver(['a.ts'], new Set(['c.ts']))).toBe(true);
		expect(waitOver([], ['a.ts'])).toBe(true);
	});

	test('--profile finds a profile by name, Default by its own', () => {
		const list = [
			{ id: 'p1', name: 'Work' },
			{ id: 'p2', name: 'work' },
			{ id: 'p3', name: 'Thai Docs' }
		];
		expect(profileFor(list, 'Work', 'Default')).toBe('p1');
		expect(profileFor(list, ' thai docs ', 'Default')).toBe('p3');
		// Two case-insensitive matches and no exact one: none.
		expect(profileFor(list, 'WORK', 'Default')).toBeUndefined();
		expect(profileFor(list, 'default', 'Default')).toBeNull();
		expect(profileFor(list, 'Nope', 'Default')).toBeUndefined();
	});
});

describe('kingu open', () => {
	const file = (path: string, line: number | null = null) => ({ path, kind: 'file' as const, line, column: null });

	test('opens files of the open folder by their relative path', () => {
		expect(openTarget('/repo', file('/repo/src/a.ts', 12))).toEqual({ kind: 'file', rel: 'src/a.ts', line: 12, column: null });
		expect(openTarget('/repo/', file('/repo/a.ts'))).toEqual({ kind: 'file', rel: 'a.ts', line: null, column: null });
	});

	test('refuses files outside the folder or without one', () => {
		expect(openTarget('/repo', file('/repo-other/a.ts'))).toEqual({ error: 'outside' });
		expect(openTarget('/repo', file('/etc/hosts'))).toEqual({ error: 'outside' });
		expect(openTarget(null, file('/repo/a.ts'))).toEqual({ error: 'noFolder' });
	});

	test('opens folders whatever is open', () => {
		expect(openTarget(null, { path: '/x', kind: 'folder', line: null, column: null })).toEqual({ kind: 'folder', path: '/x' });
	});

	test('names the folder of an installed link', () => {
		expect(dirOf('/usr/local/bin/kingu')).toBe('/usr/local/bin');
		expect(dirOf('/kingu')).toBe('/');
	});
});
