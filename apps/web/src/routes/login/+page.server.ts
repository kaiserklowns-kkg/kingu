import { fail, redirect, type Actions } from '@sveltejs/kit';
import { api, ApiError, isToken, setToken, type Me } from '#lib/server/api.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (locals.token) redirect(303, '/');
};

export const actions: Actions = {
	default: async ({ request, cookies, url }) => {
		const form = await request.formData();
		const token = String(form.get('token') ?? '').trim();
		if (!isToken(token)) {
			return fail(400, { error: 'Token ต้องขึ้นต้นด้วย kgu_ และยาว 47 ตัวอักษร' });
		}
		try {
			await api<Me>(token, '/v1/me');
		} catch (e) {
			if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
				return fail(401, { error: 'Token ไม่ถูกต้อง หมดอายุ หรือถูกเพิกถอน' });
			}
			if (e instanceof ApiError && e.status === 429) return fail(429, { error: 'ลองใหม่อีกครั้งในอีกสักครู่' });
			return fail(502, { error: 'ติดต่อเซิร์ฟเวอร์ทีมไม่ได้' });
		}
		// Secure cookies everywhere except plain-HTTP localhost development.
		setToken(cookies, token, url.protocol === 'https:');
		redirect(303, '/');
	}
};
