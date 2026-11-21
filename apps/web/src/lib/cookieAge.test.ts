import { expect, test } from 'bun:test';
import { cookieMaxAge, MAX_COOKIE_AGE } from './cookieAge.ts';

test('the cookie lives as long as the token, at most 30 days', () => {
	const now = Date.parse('2026-11-21T00:00:00Z');
	expect(cookieMaxAge('2026-11-21T12:00:00Z', now)).toBe(12 * 3600);
	expect(cookieMaxAge('2027-11-21T00:00:00Z', now)).toBe(MAX_COOKIE_AGE);
	expect(cookieMaxAge(null, now)).toBe(MAX_COOKIE_AGE);
	expect(cookieMaxAge('not a date', now)).toBe(MAX_COOKIE_AGE);
	expect(cookieMaxAge('2026-11-20T00:00:00Z', now)).toBe(0);
});
