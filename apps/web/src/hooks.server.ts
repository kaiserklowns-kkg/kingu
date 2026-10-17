import { redirect } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit/hooks';
import { getToken } from '#lib/server/api.ts';

const PUBLIC = new Set(['/login']);

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.token = getToken(event.cookies);
	if (!event.locals.token && !PUBLIC.has(event.url.pathname)) {
		if (event.url.pathname.startsWith('/api/')) return new Response('unauthorized', { status: 401 });
		redirect(303, '/login');
	}
	const response = await resolve(event);
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'no-referrer');
	response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
	return response;
};
