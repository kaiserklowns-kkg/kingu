import { error, redirect } from '@sveltejs/kit';
import { finishLogin, ssoEnabled } from '#lib/server/oidc.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ cookies, url, getClientAddress }) => {
	if (!ssoEnabled()) error(404, 'SSO is not configured');
	const err = await finishLogin(url, cookies, getClientAddress());
	redirect(303, err ? `/login?error=${err}` : '/');
};
