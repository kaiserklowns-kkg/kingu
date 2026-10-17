// Server-only access to the Kingu team server. The personal access token lives in an
// httpOnly cookie that only this code reads; browser JS never sees it.

import type { Cookies } from '@sveltejs/kit';
import { KINGU_API_URL } from '$app/env/private';

export const TOKEN_COOKIE = 'kingu_token';
const TOKEN_RE = /^kgu_[A-Za-z0-9_-]{43}$/;

export const isToken = (t: string) => TOKEN_RE.test(t);

export function getToken(cookies: Cookies): string | null {
	const t = cookies.get(TOKEN_COOKIE);
	return t && isToken(t) ? t : null;
}

export function setToken(cookies: Cookies, token: string, secure: boolean) {
	cookies.set(TOKEN_COOKIE, token, {
		path: '/',
		httpOnly: true,
		secure,
		sameSite: 'strict',
		maxAge: 60 * 60 * 24 * 30
	});
}

export function clearToken(cookies: Cookies) {
	cookies.delete(TOKEN_COOKIE, { path: '/' });
}

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string
	) {
		super(message);
	}
}

/** Calls the team server with the caller's token. Throws ApiError on non-2xx. */
export async function api<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
	let res: Response;
	try {
		res = await fetch(`${KINGU_API_URL}${path}`, {
			...init,
			headers: { Accept: 'application/json', ...init.headers, Authorization: `Bearer ${token}` },
			redirect: 'manual',
			signal: init.signal ?? AbortSignal.timeout(10_000)
		});
	} catch {
		throw new ApiError(502, 'unreachable', 'ติดต่อเซิร์ฟเวอร์ทีมไม่ได้');
	}
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
		throw new ApiError(res.status, body?.error?.code ?? 'error', body?.error?.message ?? res.statusText);
	}
	return (await res.json()) as T;
}

/** Opens the upstream SSE stream (proxied by /api/events). */
export function openEvents(token: string, lastEventId: string | null, signal: AbortSignal): Promise<Response> {
	const headers: Record<string, string> = { Accept: 'text/event-stream', Authorization: `Bearer ${token}` };
	if (lastEventId && /^\d{1,19}$/.test(lastEventId)) headers['Last-Event-ID'] = lastEventId;
	return fetch(`${KINGU_API_URL}/v1/events`, { headers, signal, redirect: 'manual' });
}

export type Me = { org_id: string; org_name: string; user_id: string; role: string; token_prefix?: string };
export type Project = { id: string; name: string };
