import { expect, test } from 'bun:test';
import { activeFilterCount, attentionClass, cardStatus, reorder, shortAgo, sortItems, statusColumn, type SortItem } from './sidebarModel';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const item = (slug: string, o: Partial<SortItem> = {}): SortItem => ({ slug, title: slug, status: 'done', createdAt: NOW - 3600_000, lastActivityAt: NOW - 3600_000, ...o });

test('card status follows Orca precedence', () => {
	expect(cardStatus('waiting', true, true)).toBe('permission');
	expect(cardStatus('failed', false, false)).toBe('failed');
	expect(cardStatus('running', false, false)).toBe('working');
	expect(cardStatus('review', false, false)).toBe('done');
	expect(cardStatus('done', false, true)).toBe('active');
	expect(cardStatus('done', false, false)).toBe('inactive');
	expect(statusColumn('review')).toBe('attention');
});

test('recent keeps a new worktree on top for five minutes', () => {
	const old = item('old', { lastActivityAt: NOW - MIN });
	const fresh = item('fresh', { createdAt: NOW - 2 * MIN, lastActivityAt: NOW - 2 * MIN });
	expect(sortItems([old, fresh], 'recent', NOW).map((i) => i.slug)).toEqual(['fresh', 'old']);
	const stale = item('stale', { createdAt: NOW - 10 * MIN, lastActivityAt: NOW - 10 * MIN });
	expect(sortItems([stale, old], 'recent', NOW).map((i) => i.slug)).toEqual(['old', 'stale']);
});

test('agent activity: needs you, recently done, working, rest', () => {
	const list = [
		item('rest'),
		item('working', { status: 'running' }),
		item('done', { status: 'review', lastActivityAt: NOW - 5 * MIN }),
		item('waiting', { status: 'waiting' })
	];
	expect(sortItems(list, 'smart', NOW).map((i) => i.slug)).toEqual(['waiting', 'done', 'working', 'rest']);
	expect(attentionClass(item('x', { status: 'review', lastActivityAt: NOW - 31 * MIN }), NOW)).toBe(5);
});

test('manual order and name', () => {
	expect(sortItems([item('b'), item('a'), item('c')], 'manual', NOW, ['c', 'a']).map((i) => i.slug)).toEqual(['c', 'a', 'b']);
	expect(sortItems([item('b'), item('a')], 'name', NOW).map((i) => i.slug)).toEqual(['a', 'b']);
	expect(reorder(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
	expect(reorder(['a', 'b', 'c'], 'a', null)).toEqual(['b', 'c', 'a']);
});

test('short time and filter count', () => {
	expect([30_000, 5 * MIN, 3 * 60 * MIN, 50 * 60 * MIN].map((d) => shortAgo(NOW - d, NOW))).toEqual(['now', '5m', '3h', '2d']);
	expect(activeFilterCount({ hideSleeping: true, exceptDefault: true, hideDefault: false })).toBe(2);
});
