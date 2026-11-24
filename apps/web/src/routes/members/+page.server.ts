import { fail, type Actions } from '@sveltejs/kit';
import { api } from '#lib/server/api.ts';
import { apiFail } from '#lib/server/forms.ts';
import { isRole, parseTTL, validUserId, type Member, type MintedToken, type Page } from '#lib/admin.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const cursor = url.searchParams.get('cursor');
	const q = new URLSearchParams({ limit: '100' });
	if (cursor) q.set('cursor', cursor);
	const page = await api<Page<Member>>(locals.token!, `/v1/members?${q}`);
	return { members: page.items, nextCursor: page.next_cursor, paged: !!cursor };
};

const member = (id: string) => `/v1/members/${encodeURIComponent(id)}`;

async function fields(request: Request) {
	const f = await request.formData();
	return { f, user: String(f.get('user_id') ?? '').trim(), role: String(f.get('role') ?? '') };
}

// The server enforces every rule (owners manage anyone, leads only dev/viewer,
// the last owner stays); the page only hides controls the caller cannot use.
export const actions: Actions = {
	add: async ({ request, locals }) => {
		const { user, role } = await fields(request);
		if (!validUserId(user)) return fail(400, { error: 'ใส่ user id (ไม่เกิน 255 ตัวอักษร)', user });
		if (!isRole(role)) return fail(400, { error: 'เลือกบทบาท', user });
		try {
			await api(locals.token!, member(user), {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ role })
			});
		} catch (e) {
			return apiFail(e);
		}
		return { added: user };
	},
	role: async ({ request, locals }) => {
		const { user, role } = await fields(request);
		if (!validUserId(user) || !isRole(role)) return fail(400, { error: 'ข้อมูลไม่ถูกต้อง' });
		try {
			await api(locals.token!, member(user), {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ role })
			});
		} catch (e) {
			return apiFail(e, `ไม่พบสมาชิก ${user}`);
		}
		return { changed: user, role };
	},
	remove: async ({ request, locals }) => {
		const { user } = await fields(request);
		if (!validUserId(user)) return fail(400, { error: 'ข้อมูลไม่ถูกต้อง' });
		try {
			await api(locals.token!, member(user), { method: 'DELETE' });
		} catch (e) {
			return apiFail(e, `ไม่พบสมาชิก ${user} (อาจถูกนำออกไปแล้ว)`);
		}
		return { removed: user };
	},
	// Owners only: a token for another member, shown once so it can be handed over.
	token: async ({ request, locals }) => {
		const { f, user } = await fields(request);
		const ttl = parseTTL(f.get('ttl_hours'));
		if (!validUserId(user) || ttl === null) return fail(400, { error: 'ข้อมูลไม่ถูกต้อง' });
		try {
			const minted = await api<MintedToken>(locals.token!, '/v1/tokens', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: 'จากแดชบอร์ด', user_id: user, ttl_hours: ttl })
			});
			return { minted };
		} catch (e) {
			return apiFail(e, `ไม่พบสมาชิก ${user}`);
		}
	}
};
