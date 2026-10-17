import { redirect } from '@sveltejs/kit';
import { api, ApiError, clearToken, type Me } from '#lib/server/api.ts';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, cookies }) => {
	if (!locals.token) return { me: null };
	try {
		return { me: await api<Me>(locals.token, '/v1/me') };
	} catch (e) {
		if (e instanceof ApiError && e.status === 401) {
			clearToken(cookies);
			redirect(303, '/login');
		}
		throw e;
	}
};
