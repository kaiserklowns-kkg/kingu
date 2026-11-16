import { describe, expect, test } from 'bun:test';
import { activityFeed, addItem, INBOX_CAP, parseInbox, readTask, setRead, unreadCount } from './agentInbox';

describe('agent notification inbox (Orca bell)', () => {
	const n = (at: number, slug = 'a', root: string | null = null) => ({ at, title: 't', body: 'b', slug, root });
	test('newest first, capped, read state', () => {
		let l = addItem([], n(1));
		l = addItem(l, n(2, 'b'));
		expect(l.map((i) => i.slug)).toEqual(['b', 'a']);
		expect(unreadCount(l)).toBe(2);
		l = setRead(l, [l[0].id]);
		expect(unreadCount(l)).toBe(1);
		l = readTask(l, 'a', null);
		expect(unreadCount(l)).toBe(0);
		l = setRead(l, 'all', false);
		expect(unreadCount(l)).toBe(2);
		let big: ReturnType<typeof addItem> = [];
		for (let i = 0; i < INBOX_CAP + 5; i++) big = addItem(big, n(i));
		expect(big.length).toBe(INBOX_CAP);
	});
	test('saved items are checked', () => {
		const l = addItem([], n(1));
		expect(parseInbox(JSON.parse(JSON.stringify(l)))).toEqual(l);
		expect(parseInbox([{ id: 1 }, null, 'x'])).toEqual([]);
		expect(parseInbox({})).toEqual([]);
	});
});

describe('activity feed history (Orca Agents feed)', () => {
	test('notices and creations, newest first, filtered', () => {
		const items = addItem([], { at: 5, title: 'Fix login done', body: 'Agent: fixed the race', slug: 'fix', root: null });
		const feed = activityFeed(items, [{ slug: 'fix', title: 'Fix login', created_at: 1 }, { slug: 'docs', title: 'Docs', created_at: 9 }], '');
		expect(feed.map((f) => [f.kind, f.slug])).toEqual([
			['created', 'docs'],
			['notice', 'fix'],
			['created', 'fix']
		]);
		expect(activityFeed(items, [{ slug: 'docs', title: 'Docs', created_at: 9 }], 'race').map((f) => f.slug)).toEqual(['fix']);
	});
});
