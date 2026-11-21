// How long the dashboard's token cookie lives: never past the token's own expiry (an SSO
// session token lasts 12 hours, apps/server oidc.go SessionTokenTTL), and at most 30 days. Pure.

export const MAX_COOKIE_AGE = 60 * 60 * 24 * 30;

/** Seconds for the cookie's `maxAge`; `expiresAt` is the server's `expires_at` (null: never expires). */
export function cookieMaxAge(expiresAt: string | null | undefined, now: number = Date.now()): number {
	const at = expiresAt ? Date.parse(expiresAt) : NaN;
	if (Number.isNaN(at)) return MAX_COOKIE_AGE;
	return Math.max(0, Math.min(MAX_COOKIE_AGE, Math.floor((at - now) / 1000)));
}
