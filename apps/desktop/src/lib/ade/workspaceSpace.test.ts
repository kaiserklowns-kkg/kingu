import { describe, expect, test } from 'bun:test';
import { formatBytes, progressText, rowLabel, share } from './workspaceSpace';

describe('workspaceSpace', () => {
	test('formatBytes uses 1024 steps and one decimal under 10', () => {
		expect(formatBytes(0)).toBe('0 B');
		expect(formatBytes(-5)).toBe('0 B');
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(1536)).toBe('1.5 KB');
		expect(formatBytes(20 * 1024 * 1024)).toBe('20 MB');
		expect(formatBytes(1.44 * 1024 ** 3)).toBe('1.4 GB');
	});

	test('share never hides a non-zero part', () => {
		expect(share(0, 100)).toBe(0);
		expect(share(1, 1_000_000)).toBe(1);
		expect(share(50, 100)).toBe(50);
		expect(share(200, 100)).toBe(100);
		expect(share(5, 0)).toBe(0);
	});

	test('rowLabel prefers task, then branch, then folder', () => {
		expect(rowLabel({ slug: 'fix-login', branch: 'kingu/fix-login', path: '/r/.kingu/worktrees/fix-login', isMain: false })).toBe('fix-login');
		expect(rowLabel({ slug: null, branch: 'main', path: '/r', isMain: true })).toBe('main');
		expect(rowLabel({ slug: null, branch: null, path: '/w/repo/', isMain: false })).toBe('repo');
	});

	test('progressText counts from one', () => {
		expect(progressText(null)).toBe('Listing workspaces…');
		expect(progressText({ scanned: 0, total: 3, current: 'a' })).toBe('Measuring 1 of 3 · a');
		expect(progressText({ scanned: 3, total: 3, current: null })).toBe('Measuring 3 of 3');
	});
});
