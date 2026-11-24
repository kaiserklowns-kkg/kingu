// Server-only OIDC sign-in for the dashboard: authorization code flow with PKCE, then the
// ID token is traded at the team server (POST /v1/auth/session) for a 12-hour Kingu token,
// which goes into the usual httpOnly cookie. The ID token itself is never stored.
// Several providers: one button each (?p=<id>); the team server picks the org by issuer.

import type { Cookies } from '@sveltejs/kit';
import { KINGU_OIDC_CLIENT_ID, KINGU_OIDC_CLIENT_SECRET, KINGU_OIDC_ISSUER, KINGU_OIDC_PROVIDERS } from '$app/env/private';
import { api, ApiError, setToken } from './api.ts';
import { authorizeUrl, parseDiscovery, parseProviders, pkceChallenge, randomToken, unverifiedClaims, type Discovery, type Provider } from '../oidc.ts';

const providers: Provider[] = parseProviders(KINGU_OIDC_PROVIDERS, { issuer: KINGU_OIDC_ISSUER, clientId: KINGU_OIDC_CLIENT_ID, clientSecret: KINGU_OIDC_CLIENT_SECRET });

export const ssoEnabled = () => providers.length > 0;
/** The login page's buttons (no secrets). */
export const ssoProviders = () => providers.map((p) => ({ id: p.id, name: p.name }));
/** The provider of `?p=` (the first one when there is none, as the legacy single button links). */
export const providerOf = (id: string | null): Provider | undefined => (id ? providers.find((p) => p.id === id) : providers[0]);

const FLOW_COOKIE = 'kingu_oidc';
const cached = new Map<string, { at: number; d: Discovery }>();

async function discovery(p: Provider): Promise<Discovery> {
	const hit = cached.get(p.id);
	if (hit && Date.now() - hit.at < 3600_000) return hit.d;
	const res = await fetch(`${p.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
	const d = res.ok ? parseDiscovery(p.issuer, await res.json()) : null;
	if (!d) throw new Error('invalid OIDC discovery document');
	cached.set(p.id, { at: Date.now(), d });
	return d;
}

const redirectUri = (origin: string) => `${origin}/login/callback`;

/** Starts the flow: remembers state/nonce/verifier in a short-lived cookie, returns the IdP URL. */
export async function startLogin(p: Provider, cookies: Cookies, origin: string): Promise<string> {
	const flow = { state: randomToken(), nonce: randomToken(), verifier: randomToken(48), provider: p.id };
	// SameSite=Lax: the IdP returns with a top-level GET, which Lax cookies accompany.
	cookies.set(FLOW_COOKIE, JSON.stringify(flow), { path: '/login', httpOnly: true, secure: origin.startsWith('https:'), sameSite: 'lax', maxAge: 600 });
	return authorizeUrl(await discovery(p), {
		clientId: p.clientId,
		redirectUri: redirectUri(origin),
		state: flow.state,
		nonce: flow.nonce,
		challenge: await pkceChallenge(flow.verifier)
	});
}

/** Completes the flow. Returns an error code for /login?error=, or null when signed in. */
export async function finishLogin(url: URL, cookies: Cookies, clientIp: string): Promise<string | null> {
	const raw = cookies.get(FLOW_COOKIE);
	cookies.delete(FLOW_COOKIE, { path: '/login' });
	let flow: { state?: string; nonce?: string; verifier?: string; provider?: string } = {};
	try {
		flow = raw ? JSON.parse(raw) : {};
	} catch {
		/* treated as a state mismatch below */
	}
	const state = url.searchParams.get('state');
	if (!flow.state || !flow.verifier || !flow.nonce || state !== flow.state) return 'state';
	// Older flow cookies carry no provider: the single provider they were made for.
	const p = providerOf(flow.provider ?? null);
	if (!p) return 'state';
	if (url.searchParams.get('error')) return 'denied';
	const code = url.searchParams.get('code');
	if (!code) return 'denied';

	let idToken: string;
	try {
		const d = await discovery(p);
		const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(url.origin), code_verifier: flow.verifier, client_id: p.clientId });
		const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
		if (p.clientSecret) {
			// client_secret_basic, the spec's default client authentication.
			headers.Authorization = `Basic ${btoa(`${encodeURIComponent(p.clientId)}:${encodeURIComponent(p.clientSecret)}`)}`;
		}
		const res = await fetch(d.token_endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000), redirect: 'error' });
		const json = (await res.json().catch(() => null)) as { id_token?: unknown } | null;
		if (!res.ok || typeof json?.id_token !== 'string') return 'token';
		idToken = json.id_token;
	} catch {
		return 'unavailable';
	}
	if (unverifiedClaims(idToken)?.nonce !== flow.nonce) return 'token';

	try {
		const minted = await api<{ token: string; expires_at: string | null }>(idToken, '/v1/auth/session', { method: 'POST', headers: { 'X-Forwarded-For': clientIp } });
		setToken(cookies, minted.token, url.protocol === 'https:', minted.expires_at);
		return null;
	} catch (e) {
		if (e instanceof ApiError && e.code === 'not_a_member') return 'not_a_member';
		if (e instanceof ApiError && (e.status === 401 || e.status === 400)) return 'rejected';
		return 'unavailable';
	}
}
