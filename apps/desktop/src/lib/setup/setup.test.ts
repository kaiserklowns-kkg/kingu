import { describe, expect, test } from 'bun:test';
import { failures, readiness, warnings, type SetupReport } from './setup';

const report = (...checks: SetupReport['checks']): SetupReport => ({ os: 'macos', arch: 'aarch64', checks });

describe('setup readiness', () => {
	test('loading without a report', () => {
		expect(readiness(null)).toBe('loading');
		expect(failures(null)).toEqual([]);
		expect(warnings(null)).toEqual([]);
	});

	test('ready when every check passes', () => {
		const r = report({ id: 'git', status: 'ok' }, { id: 'agents', status: 'ok' });
		expect(readiness(r)).toBe('ready');
	});

	test('warnings still allow work', () => {
		const r = report({ id: 'git', status: 'ok' }, { id: 'gh', status: 'warn' });
		expect(readiness(r)).toBe('warn');
		expect(warnings(r).map((c) => c.id)).toEqual(['gh']);
	});

	test('a failure blocks', () => {
		const r = report({ id: 'git', status: 'fail' }, { id: 'gh', status: 'warn' });
		expect(readiness(r)).toBe('blocked');
		expect(failures(r).map((c) => c.id)).toEqual(['git']);
	});
});
