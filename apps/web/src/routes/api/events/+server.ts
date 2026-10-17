// Same-origin SSE proxy for the board. The browser's EventSource talks to this endpoint with
// its cookie; this server adds the bearer token, so the token never reaches browser JS.

import { error } from '@sveltejs/kit';
import { openEvents } from '#lib/server/api.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, request }) => {
	if (!locals.token) error(401, 'unauthorized');
	let upstream: Response;
	try {
		upstream = await openEvents(locals.token, request.headers.get('last-event-id'), request.signal);
	} catch {
		error(502, 'team server unreachable');
	}
	if (!upstream.ok || !upstream.body) {
		await upstream.body?.cancel();
		// 401 makes EventSource stop; other errors let it retry.
		error(upstream.status === 401 ? 401 : 502, 'event stream unavailable');
	}
	return new Response(upstream.body, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-store',
			'X-Accel-Buffering': 'no'
		}
	});
};
