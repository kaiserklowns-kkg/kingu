// Orca's notification inbox (the header bell, docs notifications.mdx): every agent notice —
// finished, needs you, failed — kept in a list with read / unread, newest first. Pure.

export type InboxItem = { id: string; at: number; title: string; body: string; slug: string; root: string | null; read: boolean };

/** Orca keeps a bounded history; Kingu keeps the newest 100. */
export const INBOX_CAP = 100;

export function addItem(list: readonly InboxItem[], item: Omit<InboxItem, 'id' | 'read'>): InboxItem[] {
	const next: InboxItem = { ...item, id: `${item.at}-${item.root ?? ''}-${item.slug}`, read: false };
	return [next, ...list.filter((i) => i.id !== next.id)].slice(0, INBOX_CAP);
}

export const setRead = (list: readonly InboxItem[], ids: readonly string[] | 'all', read = true): InboxItem[] =>
	list.map((i) => (ids === 'all' || ids.includes(i.id) ? { ...i, read } : i));

/** Opening a task reads its notices. */
export const readTask = (list: readonly InboxItem[], slug: string, root: string | null): InboxItem[] =>
	list.some((i) => !i.read && i.slug === slug && i.root === root) ? list.map((i) => (i.slug === slug && i.root === root ? { ...i, read: true } : i)) : (list as InboxItem[]);

export const unreadCount = (list: readonly InboxItem[]) => list.filter((i) => !i.read).length;

/** Saved items, checked (localStorage may hold anything). */
export function parseInbox(raw: unknown): InboxItem[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((i): i is InboxItem => !!i && typeof i === 'object' && typeof i.id === 'string' && typeof i.at === 'number' && typeof i.title === 'string' && typeof i.body === 'string' && typeof i.slug === 'string' && (i.root === null || typeof i.root === 'string') && typeof i.read === 'boolean')
		.slice(0, INBOX_CAP);
}

/** One row of the Activity history (Orca's Agents feed): a notice, or a worktree created. */
export type FeedEntry = { id: string; at: number; kind: 'notice' | 'created'; title: string; body: string; slug: string; root: string | null };

/**
 * Orca's Agents feed history: the inbox's notices (finished turns, questions, failures with the
 * latest response preview) and worktree creations, newest first, narrowed by `query` (every word
 * must appear in the title or text). At most `limit` rows.
 */
export function activityFeed(items: readonly InboxItem[], tasks: readonly { slug: string; title: string; created_at: number }[], query: string, limit = 200): FeedEntry[] {
	const rows: FeedEntry[] = [
		...items.map((i): FeedEntry => ({ id: `n:${i.id}`, at: i.at, kind: 'notice', title: i.title, body: i.body, slug: i.slug, root: i.root })),
		...tasks.map((t): FeedEntry => ({ id: `c:${t.slug}`, at: t.created_at, kind: 'created', title: t.title, body: '', slug: t.slug, root: null }))
	];
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	return rows
		.filter((r) => words.every((w) => `${r.title} ${r.body} ${r.slug}`.toLowerCase().includes(w)))
		.sort((a, b) => b.at - a.at)
		.slice(0, limit);
}
