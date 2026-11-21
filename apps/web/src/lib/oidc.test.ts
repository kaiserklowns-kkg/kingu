/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { authorizeUrl, parseDiscovery, parseProviders, pkceChallenge, randomToken, unverifiedClaims } from './oidc';

test('pkceChallenge matches the RFC 7636 example', async () => {
	expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('randomToken is url-safe and unique', () => {
	const a = randomToken();
	expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(randomToken()).not.toBe(a);
});

describe('parseDiscovery', () => {
	const doc = { issuer: 'https://id.example.com', authorization_endpoint: 'https://id.example.com/auth', token_endpoint: 'https://id.example.com/token' };
	test('accepts a matching https document', () => {
		expect(parseDiscovery('https://id.example.com', doc)?.token_endpoint).toBe('https://id.example.com/token');
	});
	test('rejects a different issuer or plain-http endpoints', () => {
		expect(parseDiscovery('https://other.example.com', doc)).toBeNull();
		expect(parseDiscovery('https://id.example.com', { ...doc, token_endpoint: 'http://id.example.com/token' })).toBeNull();
		expect(parseDiscovery('https://id.example.com', null)).toBeNull();
	});
});

test('authorizeUrl carries PKCE, state and nonce', () => {
	const u = new URL(
		authorizeUrl(
			{ issuer: 'https://id.example.com', authorization_endpoint: 'https://id.example.com/auth?tenant=x', token_endpoint: 'https://id.example.com/token' },
			{ clientId: 'kingu', redirectUri: 'https://team.example.com/login/callback', state: 's', nonce: 'n', challenge: 'c' }
		)
	);
	expect(u.searchParams.get('tenant')).toBe('x');
	expect(u.searchParams.get('code_challenge_method')).toBe('S256');
	expect(u.searchParams.get('scope')).toBe('openid email profile');
	expect([u.searchParams.get('state'), u.searchParams.get('nonce'), u.searchParams.get('code_challenge')]).toEqual(['s', 'n', 'c']);
});

test('unverifiedClaims decodes UTF-8 payloads and rejects junk', () => {
	const payload = Buffer.from(JSON.stringify({ nonce: 'n1', name: 'สมชาย' })).toString('base64url');
	expect(unverifiedClaims(`h.${payload}.s`)).toEqual({ nonce: 'n1', name: 'สมชาย' });
	expect(unverifiedClaims('a.b')).toBeNull();
	expect(unverifiedClaims('a.!!!.c')).toBeNull();
});

describe('parseProviders', () => {
	const none = { issuer: '', clientId: '', clientSecret: '' };
	const legacy = { issuer: 'https://login.acme.com', clientId: 'kingu', clientSecret: '' };
	test('legacy single provider is "sso", listed first', () => {
		const ps = parseProviders('[{"id":"partner","name":"Partner Co","issuer":"https://idp.partner.com","client_id":"k","client_secret":"s"}]', legacy);
		expect(ps.map((p) => p.id)).toEqual(['sso', 'partner']);
		expect(ps[1]).toEqual({ id: 'partner', name: 'Partner Co', issuer: 'https://idp.partner.com', clientId: 'k', clientSecret: 's' });
		expect(parseProviders('', none)).toEqual([]);
		expect(parseProviders('[{"id":"x","issuer":"https://x.com","client_id":"k"}]', none)[0].name).toBe('x');
	});
	test('rejects bad entries and repeats', () => {
		for (const raw of [
			'nope',
			'{}',
			'[{"id":"Bad Id","issuer":"https://x.com","client_id":"k"}]',
			'[{"id":"x","issuer":"http://x.com","client_id":"k"}]',
			'[{"id":"x","issuer":"https://x.com"}]',
			'[{"id":"sso","issuer":"https://x.com","client_id":"k"}]',
			'[{"id":"x","issuer":"https://login.acme.com","client_id":"k"}]'
		]) {
			expect(() => parseProviders(raw, legacy)).toThrow();
		}
	});
});
