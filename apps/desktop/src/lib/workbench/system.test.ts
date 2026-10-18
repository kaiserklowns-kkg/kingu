import { describe, expect, test } from 'bun:test';
import { formatBytes, pushSample, sparkline, terminalGroup } from './system';

describe('status bar resources', () => {
	test('formatBytes: MB below a gigabyte, GB above', () => {
		expect(formatBytes(791.1 * 1024 * 1024)).toBe('791.1 MB');
		expect(formatBytes(1.25 * 1024 ** 3)).toBe('1.3 GB');
	});

	test('pushSample keeps the last readings', () => {
		expect(pushSample([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
		expect(pushSample([], 7)).toEqual([7]);
	});

	test('sparkline spans the box and is flat with one reading', () => {
		expect(sparkline([5], 48, 14)).toBe('0,7 48,7');
		const pts = sparkline([10, 20, 10], 48, 14).split(' ');
		expect(pts).toEqual(['0.0,13.0', '24.0,1.0', '48.0,13.0']);
	});

	test('terminalGroup names the worktree or the workspace', () => {
		expect(terminalGroup('/w/Kingu/.kingu/worktrees/fix-login/src', '/w/Kingu')).toBe('kingu/fix-login');
		expect(terminalGroup('/w/Kingu/apps', '/w/Kingu')).toBe('Kingu');
		expect(terminalGroup('/tmp/other', '/w/Kingu')).toBe('other');
	});
});
