import { error, redirect } from '@sveltejs/kit';
import { ssoEnabled, startLogin } from '#lib/server/oidc.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ cookies, url, setHeaders }) => {
	if (!ssoEnabled()) error(404, 'SSO is not configured');
	let target: string;
	try {
		target = await startLogin(cookies, url.origin);
	} catch {
		redirect(303, '/login?error=unavailable');
	}
	setHeaders({ 'Cache-Control': 'no-store' });
	// redirect() only allows same-origin targets; the identity provider is external.
	return new Response(null, { status: 303, headers: { Location: target } });
};
