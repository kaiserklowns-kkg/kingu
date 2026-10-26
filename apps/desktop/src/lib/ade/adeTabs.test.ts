import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { leaf, splitPane } from '#lib/terminal/paneLayout.ts';
import {
	activeAfterClose,
	activePane,
	applyTabOrder,
	adeTabs,
	cycleTab,
	fileTabId,
	keyOfTabId,
	matchesQuery,
	mruOrder,
	openFileTab,
	paneOrder,
	pinFileTab,
	pushClosed,
	switcherStep,
	tabAtIndex,
	tabPanes,
	touchMru,
	type ClosedTab,
	type TerminalTab
} from './adeTabs';
import { setLocale } from '#lib/i18n/index.ts';

// These tests check the Thai UI text.
beforeAll(() => setLocale('th'));
afterAll(() => setLocale('en'));

describe('adeTabs', () => {
	test('the folder starts with the new-task composer', () => {
		expect(adeTabs('', [])).toEqual([{ id: 'main', kind: 'compose', label: 'งานใหม่' }]);
	});
	test('a terminal can carry its own title', () => {
		expect(adeTabs('x', [{ id: 't1', n: 1, title: 'test (Go)' }])[1].label).toBe('test (Go)');
	});
	test('browser tabs sit between the terminals and the files', () => {
		const tabs = adeTabs('x', [{ id: 't1', n: 1 }], [{ key: 'src/a.ts', preview: false }], [{ id: 'b2', url: '', title: 'New Tab' }]);
		expect(tabs.map((t) => [t.kind, t.label])).toEqual([
			['agent', 'Agent'],
			['terminal', 'Terminal 1'],
			['browser', 'New Tab'],
			['file', 'a.ts']
		]);
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

describe('tab switching (Orca)', () => {
	test('MRU: shown tabs move to the front; the switcher lists active, recent, then the rest', () => {
		let mru: string[] = [];
		for (const id of ['main', 't1', 'f:a.ts', 't1']) mru = touchMru(mru, id);
		expect(mru).toEqual(['t1', 'f:a.ts', 'main']);
		expect(touchMru(['a', 'b', 'c'], 'd', 3)).toEqual(['d', 'a', 'b']);
		expect(mruOrder(mru, ['main', 't1', 't2', 'f:a.ts'], 't1')).toEqual(['t1', 'f:a.ts', 'main', 't2']);
		// A closed tab drops out.
		expect(mruOrder(['gone', 'main'], ['main', 't2'], 't2')).toEqual(['t2', 'main']);
	});

	test('Ctrl+Tab picks the previous recent tab, Shift reverses, both wrap', () => {
		expect(switcherStep(0, 1, 3)).toBe(1);
		expect(switcherStep(2, 1, 3)).toBe(0);
		expect(switcherStep(0, -1, 3)).toBe(2);
		expect(switcherStep(0, 1, 0)).toBe(0);
	});

	test('next / previous wrap; select by number is the n-th tab', () => {
		expect(cycleTab(['main', 't1', 't2'], 't2', 1)).toBe('main');
		expect(cycleTab(['main', 't1', 't2'], 'main', -1)).toBe('t2');
		expect(cycleTab(['t1', 't2'], 'main', 1)).toBe('t1');
		expect(cycleTab([], 'main', 1)).toBe('main');
		expect(tabAtIndex(['main', 't1'], 2)).toBe('t1');
		expect(tabAtIndex(['main', 't1'], 9)).toBeNull();
	});

	test('closed tabs: the last 10, newest last', () => {
		let stack: ClosedTab[] = [];
		for (let i = 0; i < 12; i++) stack = pushClosed(stack, { kind: 'terminal', title: `T${i}`, index: i });
		expect(stack).toHaveLength(10);
		expect(stack.at(-1)).toEqual({ kind: 'terminal', title: 'T11', index: 11 });
		expect(pushClosed([], { kind: 'file', key: 'a.ts' })).toEqual([{ kind: 'file', key: 'a.ts' }]);
	});

	test('panes of a split tab; focus order is creation order', () => {
		const tab: TerminalTab = { id: 't3', n: 1, layout: splitPane(splitPane(leaf('t3'), 't3', 't9', 'vertical'), 't3', 't5', 'horizontal') };
		expect(tabPanes(tab)).toEqual(['t3', 't5', 't9']);
		expect(paneOrder({ ...tab, layout: splitPane(leaf('t12'), 't12', 't3', 'vertical') })).toEqual(['t3', 't12']);
		expect(activePane(tab)).toBe('t3');
		expect(activePane({ ...tab, pane: 't9' })).toBe('t9');
		expect(activePane({ ...tab, pane: 'gone' })).toBe('t3');
		expect(tabPanes({ id: 't1', n: 1 })).toEqual(['t1']);
	});

	test('dragged tab order: listed ids first, the rest keep their usual order', () => {
		const tabs = adeTabs('', [], [], [{ id: 'b1', url: '', title: 'A' }, { id: 'b2', url: '', title: 'B' }]);
		expect(applyTabOrder(tabs, []).map((t) => t.id)).toEqual(['main', 'b1', 'b2']);
		expect(applyTabOrder(tabs, ['b2', 'main']).map((t) => t.id)).toEqual(['b2', 'main', 'b1']);
		expect(applyTabOrder(tabs, ['gone']).map((t) => t.id)).toEqual(['main', 'b1', 'b2']);
	});
});
