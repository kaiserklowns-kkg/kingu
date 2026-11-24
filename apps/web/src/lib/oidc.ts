// Pure parts of the dashboard's OIDC sign-in (authorization code + PKCE), so `bun test` covers them.

export const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function randomToken(bytes = 32): string {
	return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** RFC 7636 S256 code challenge. */
export async function pkceChallenge(verifier: string): Promise<string> {
	return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

/** One identity provider of the login page (the team server maps its issuer to an org). */
export type Provider = { id: string; name: string; issuer: string; clientId: string; clientSecret: string };

const ISSUER_ERROR = 'issuer must be https (http only on localhost)';

/**
 * The login page's providers: KINGU_OIDC_PROVIDERS (a JSON array of
 * {id, name, issuer, client_id, client_secret?}) after the single legacy provider, which is "sso".
 * Throws on a bad entry, a repeated id or a repeated issuer.
 */
export function parseProviders(raw: string, legacy: { issuer: string; clientId: string; clientSecret: string }): Provider[] {
	const out: Provider[] = [];
	if (legacy.issuer && legacy.clientId) out.push({ id: 'sso', name: 'SSO', ...legacy });
	const text = raw.trim();
	if (text) {
		let list: unknown;
		try {
			list = JSON.parse(text);
		} catch {
			throw new Error('KINGU_OIDC_PROVIDERS must be a JSON array');
		}
		if (!Array.isArray(list) || list.length > 50) throw new Error('KINGU_OIDC_PROVIDERS must be a JSON array of at most 50 providers');
		for (const e of list as Record<string, unknown>[]) {
			const str = (k: string) => (typeof e?.[k] === 'string' ? (e[k] as string).trim() : '');
			const p: Provider = { id: str('id'), name: str('name'), issuer: str('issuer'), clientId: str('client_id'), clientSecret: str('client_secret') };
			if (!/^[a-z0-9-]{1,32}$/.test(p.id)) throw new Error(`provider id "${p.id}" must be 1-32 of a-z, 0-9, -`);
			if (!p.clientId) throw new Error(`provider ${p.id}: client_id is required`);
			if (!secureUrl(p.issuer)) throw new Error(`provider ${p.id}: ${ISSUER_ERROR}`);
			p.name ||= p.id;
			out.push(p);
		}
	}
	const ids = new Set<string>();
	const issuers = new Set<string>();
	for (const p of out) {
		if (ids.has(p.id)) throw new Error(`provider id "${p.id}" is used twice`);
		if (issuers.has(p.issuer)) throw new Error(`issuer ${p.issuer} is configured twice`);
		ids.add(p.id);
		issuers.add(p.issuer);
	}
	return out;
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
