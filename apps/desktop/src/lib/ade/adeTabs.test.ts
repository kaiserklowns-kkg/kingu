import { describe, expect, test } from 'bun:test';
import { adeTabs, matchesQuery } from './adeTabs';

describe('adeTabs', () => {
	test('the folder starts with the new-task composer', () => {
		expect(adeTabs('', [])).toEqual([{ id: 'main', kind: 'compose', label: 'งานใหม่' }]);
	});
	test('a terminal can carry its own title', () => {
		expect(adeTabs('x', [{ id: 't1', n: 1, title: 'test (Go)' }])[1].label).toBe('test (Go)');
	});
	test('a task starts with its agent session, then its terminals', () => {
		expect(adeTabs('fix-login', [{ id: 't1', n: 1 }, { id: 't4', n: 2 }]).map((t) => [t.kind, t.label])).toEqual([
			['agent', 'Agent'],
			['terminal', 'Terminal 1'],
			['terminal', 'Terminal 2']
		]);
	});
});

describe('matchesQuery', () => {
	test('empty query matches everything', () => {
		expect(matchesQuery('  ', 'x')).toBe(true);
	});
	test('matches any field, ignoring case', () => {
		expect(matchesQuery('LOGIN', 'แก้บั๊ก', 'kingu/fix-login')).toBe(true);
		expect(matchesQuery('export', 'แก้บั๊ก', null)).toBe(false);
	});
});
