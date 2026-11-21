/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { authorizeUrl, parseDiscovery, pkceChallenge, randomToken, unverifiedClaims } from './oidc';

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
