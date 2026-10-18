import { describe, expect, test } from 'bun:test';
import { prLine, sortChecks, summarizeChecks, type PrCheck } from './prChecks';

const c = (name: string, state: PrCheck['state']): PrCheck => ({ name, state, url: null });

describe('PR checks', () => {
	test('summary: a failure wins, then running, then passed', () => {
		expect(summarizeChecks([c('a', 'success'), c('b', 'failure'), c('c', 'pending')])).toMatchObject({ overall: 'failure', failed: 1, pending: 1, passed: 1 });
		expect(summarizeChecks([c('a', 'success'), c('c', 'pending')]).overall).toBe('pending');
		expect(summarizeChecks([c('a', 'success'), c('s', 'skipped')]).overall).toBe('success');
		expect(summarizeChecks([]).overall).toBe('none');
	});
	test('failures first, then running', () => {
		expect(sortChecks([c('z', 'success'), c('b', 'pending'), c('a', 'failure')]).map((x) => x.name)).toEqual(['a', 'b', 'z']);
	});
	test('PR line', () => {
		const pr = { number: 1, url: '', title: '', state: 'OPEN', draft: false, review: 'CHANGES_REQUESTED', mergeable: 'CONFLICTING', checks: [] };
		expect(prLine(pr)).toBe('open · ขอให้แก้ · มี conflict กับ base');
		expect(prLine({ ...pr, state: 'MERGED', review: '', mergeable: 'UNKNOWN' })).toBe('merged แล้ว');
	});
});
