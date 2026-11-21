// Pure parts of the dashboard's OIDC sign-in (authorization code + PKCE), so `bun test` covers them.

export const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function randomToken(bytes = 32): string {
	return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** RFC 7636 S256 code challenge. */
export async function pkceChallenge(verifier: string): Promise<string> {
	return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

export type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string };

const secureUrl = (v: unknown) => {
	if (typeof v !== 'string') return false;
	try {
		const u = new URL(v);
		return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
	} catch {
		return false;
	}
};

/** Checks a discovery document belongs to `issuer` and its endpoints are https. */
export function parseDiscovery(issuer: string, doc: unknown): Discovery | null {
	const d = doc as Partial<Discovery> | null;
	if (!d || d.issuer !== issuer || !secureUrl(d.authorization_endpoint) || !secureUrl(d.token_endpoint)) return null;
	return { issuer, authorization_endpoint: d.authorization_endpoint!, token_endpoint: d.token_endpoint! };
}

export function authorizeUrl(d: Discovery, o: { clientId: string; redirectUri: string; state: string; nonce: string; challenge: string }): string {
	const u = new URL(d.authorization_endpoint);
	u.searchParams.set('response_type', 'code');
	u.searchParams.set('client_id', o.clientId);
	u.searchParams.set('redirect_uri', o.redirectUri);
	u.searchParams.set('scope', 'openid email profile');
	u.searchParams.set('state', o.state);
	u.searchParams.set('nonce', o.nonce);
	u.searchParams.set('code_challenge', o.challenge);
	u.searchParams.set('code_challenge_method', 'S256');
	return u.toString();
}

/**
 * Reads an ID token's payload WITHOUT verifying it. Only for the nonce check; the team
 * server verifies the signature and every other claim.
 */
export function unverifiedClaims(idToken: string): Record<string, unknown> | null {
	const parts = idToken.split('.');
	if (parts.length !== 3) return null;
	try {
		const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
		const bytes = Uint8Array.from(json, (c) => c.charCodeAt(0));
		const v = JSON.parse(new TextDecoder().decode(bytes));
		return v && typeof v === 'object' ? v : null;
	} catch {
		return null;
	}
}

/** Thai message for /login?error=<code>. */
export const SSO_ERRORS: Record<string, string> = {
	not_a_member: 'ยังไม่ได้เป็นสมาชิกทีม ขอให้ owner หรือ lead เพิ่มอีเมลของคุณในหน้าสมาชิก',
	state: 'การเข้าสู่ระบบหมดเวลาหรือถูกเปิดจากแท็บอื่น ลองใหม่อีกครั้ง',
	denied: 'ผู้ให้บริการ SSO ปฏิเสธการเข้าสู่ระบบ',
	token: 'ยืนยันตัวตนกับผู้ให้บริการ SSO ไม่สำเร็จ',
	rejected: 'เซิร์ฟเวอร์ทีมไม่ยอมรับการเข้าสู่ระบบนี้ (อีเมลยังไม่ยืนยัน หรือตั้งค่า SSO ไม่ตรงกัน)',
	unavailable: 'ติดต่อผู้ให้บริการ SSO หรือเซิร์ฟเวอร์ทีมไม่ได้'
};
