import { describe, expect, test } from 'bun:test';
import { dirOf, openTarget } from './cliBridge.ts';

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
