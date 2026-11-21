import { error } from '@sveltejs/kit';
import { api } from '#lib/server/api.ts';
import { AUDIT_GROUPS, isAdmin, validUserId, type AuditEntry, type Page } from '#lib/admin.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url, parent }) => {
	const { me } = await parent();
	if (!isAdmin(me?.role)) error(403, 'เฉพาะ owner หรือ lead ที่ดู audit log ได้');
	const p = url.searchParams;
	const actor = (p.get('actor') ?? '').trim();
	const action = AUDIT_GROUPS.some((g) => g.value === p.get('action')) ? p.get('action')! : '';
	const q = new URLSearchParams({ limit: '100' });
	if (actor && validUserId(actor)) q.set('actor', actor);
	if (action) q.set('action', action);
	const cursor = p.get('cursor');
	if (cursor) q.set('cursor', cursor);
	const page = await api<Page<AuditEntry>>(locals.token!, `/v1/audit?${q}`);
	return { entries: page.items, nextCursor: page.next_cursor, paged: !!cursor, actor, action };
};
