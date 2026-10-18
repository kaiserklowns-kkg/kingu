import { describe, expect, test } from 'bun:test';
import { activeAfterClose, adeTabs, fileTabId, keyOfTabId, matchesQuery, openFileTab, pinFileTab } from './adeTabs';

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
	test('files and task diffs come after the terminals, labelled by file name', () => {
		const tabs = adeTabs('x', [{ id: 't1', n: 1 }], [
			{ key: '.kingu/worktrees/x/src/a.ts', preview: true },
			{ key: 'taskdiff://x/src/b.ts', preview: false }
		]);
		expect(tabs.slice(2)).toEqual([
			{ id: 'f:.kingu/worktrees/x/src/a.ts', kind: 'file', label: 'a.ts', key: '.kingu/worktrees/x/src/a.ts', preview: true },
			{ id: 'f:taskdiff://x/src/b.ts', kind: 'diff', label: 'b.ts', key: 'taskdiff://x/src/b.ts', preview: false }
		]);
	});
	test("the folder's own working-tree diffs are diff tabs too", () => {
		expect(adeTabs('', [], [{ key: 'diff:src/c.ts', preview: true }])[1]).toMatchObject({ kind: 'diff', label: 'c.ts' });
	});
	test('a file named like a terminal id gets its own tab id', () => {
		expect(keyOfTabId(fileTabId('t1'))).toBe('t1');
		expect(keyOfTabId('t1')).toBeNull();
	});
});

describe('openFileTab', () => {
	test('a preview replaces the previous preview in place', () => {
		let files = openFileTab([], 'a', true);
		files = openFileTab(files, 'p', false);
		files = openFileTab(files, 'b', true);
		expect(files).toEqual([
			{ key: 'b', preview: true },
			{ key: 'p', preview: false }
		]);
	});
	test('a preview with unsaved edits is kept', () => {
		const files = openFileTab([{ key: 'a', preview: true }], 'b', true, (k) => k === 'a');
		expect(files.map((f) => f.key)).toEqual(['a', 'b']);
	});
	test('opening pinned pins an open preview; opening as preview again keeps it as it is', () => {
		const files = [{ key: 'a', preview: true }];
		expect(openFileTab(files, 'a', true)).toBe(files);
		expect(openFileTab(files, 'a', false)).toEqual([{ key: 'a', preview: false }]);
	});
	test('pinFileTab', () => {
		expect(pinFileTab([{ key: 'a', preview: true }, { key: 'b', preview: true }], 'b')).toEqual([
			{ key: 'a', preview: true },
			{ key: 'b', preview: false }
		]);
		const pinned = [{ key: 'a', preview: false }];
		expect(pinFileTab(pinned, 'a')).toBe(pinned);
	});
});

describe('activeAfterClose', () => {
	const ids = ['main', 't1', 'f:a', 'f:b'];
	test('an inactive tab leaves the active one', () => {
		expect(activeAfterClose(ids, 'f:a', 't1')).toBe('t1');
	});
	test('the active tab hands over to its right neighbour, else its left one', () => {
		expect(activeAfterClose(ids, 'f:a', 'f:a')).toBe('f:b');
		expect(activeAfterClose(ids, 'f:b', 'f:b')).toBe('f:a');
	});
	test('falls back to the main tab', () => {
		expect(activeAfterClose(['f:a'], 'f:a', 'f:a')).toBe('main');
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
