import { fail, redirect, type Actions } from '@sveltejs/kit';
import { api, clearToken } from '#lib/server/api.ts';
import { apiFail } from '#lib/server/forms.ts';
import { parseTTL, type MintedToken, type Page, type Token } from '#lib/admin.ts';
import type { PageServerLoad } from './$types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const load: PageServerLoad = async ({ locals, url, parent }) => {
	const { me } = await parent();
	const all = me?.role === 'owner' && url.searchParams.get('all') === '1';
	const cursor = url.searchParams.get('cursor');
	const q = new URLSearchParams({ limit: '100' });
	if (all) q.set('all', 'true');
	if (cursor) q.set('cursor', cursor);
	const page = await api<Page<Token>>(locals.token!, `/v1/tokens?${q}`);
	return { tokens: page.items, nextCursor: page.next_cursor, paged: !!cursor, all };
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const f = await request.formData();
		const name = String(f.get('name') ?? '').trim();
		const ttl = parseTTL(f.get('ttl_hours'));
		if (!name || [...name].length > 100) return fail(400, { error: 'ตั้งชื่อ token (ไม่เกิน 100 ตัวอักษร) เช่น “MacBook งาน”' });
		if (ttl === null) return fail(400, { error: 'เลือกอายุ token' });
		try {
			const minted = await api<MintedToken>(locals.token!, '/v1/tokens', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, ttl_hours: ttl })
			});
			return { minted };
		} catch (e) {
			return apiFail(e);
		}
	},
	revoke: async ({ request, locals, cookies }) => {
		const f = await request.formData();
		const id = String(f.get('id') ?? '');
		if (!UUID.test(id)) return fail(400, { error: 'ข้อมูลไม่ถูกต้อง' });
		let revoked: Token;
		try {
			revoked = await api<Token>(locals.token!, `/v1/tokens/${id}`, { method: 'DELETE' });
		} catch (e) {
			return apiFail(e, 'ไม่พบ token นี้');
		}
		// This session's own token no longer works: sign out.
		if (revoked.current) {
			clearToken(cookies);
			redirect(303, '/login');
		}
		return { revoked: revoked.prefix };
	}
};
