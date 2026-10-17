import { redirect, type Actions } from '@sveltejs/kit';
import { clearToken } from '#lib/server/api.ts';

export const load = () => redirect(303, '/');

export const actions: Actions = {
	default: ({ cookies }) => {
		clearToken(cookies);
		redirect(303, '/login');
	}
};
