import { describe, expect, test } from 'bun:test';
import { appendArrayElement, parseJsonc } from '#lib/settings/jsonc.ts';
import { displayLink, isUrlTrusted, isWebLink, linkNeedsPrompt, TRUSTED_DOMAINS_TEMPLATE, trustOptions } from './trustedDomains.ts';

describe('trusted domains', () => {
	test('an exact domain trusts its scheme and any path, not subdomains or other ports', () => {
		const t = ['https://example.com'];
		expect(isUrlTrusted('https://example.com', t)).toBe(true);
		expect(isUrlTrusted('https://EXAMPLE.com/path?q=1#x', t)).toBe(true);
		expect(isUrlTrusted('http://example.com', t)).toBe(false);
		expect(isUrlTrusted('https://www.example.com', t)).toBe(false);
		expect(isUrlTrusted('https://example.com:8443/', t)).toBe(false);
		expect(isUrlTrusted('https://example.com.evil.test', t)).toBe(false);
	});

	test('a wildcard trusts the domain and every subdomain', () => {
		const t = ['https://*.github.com'];
		expect(isUrlTrusted('https://github.com', t)).toBe(true);
		expect(isUrlTrusted('https://api.github.com', t)).toBe(true);
		expect(isUrlTrusted('https://sub.api.github.com/x', t)).toBe(true);
		expect(isUrlTrusted('https://evilgithub.com', t)).toBe(false);
		expect(isUrlTrusted('https://github.com.evil.test', t)).toBe(false);
		// Backslashes are path separators, not part of the host.
		expect(isUrlTrusted('https://example.com\\.github.com', t)).toBe(false);
	});

	test('no scheme means http and https; ports and paths narrow it', () => {
		expect(isUrlTrusted('http://docs.rs/x', ['docs.rs'])).toBe(true);
		expect(isUrlTrusted('https://docs.rs/x', ['docs.rs'])).toBe(true);
		expect(isUrlTrusted('https://example.com:8080/', ['https://example.com:*'])).toBe(true);
		expect(isUrlTrusted('https://example.com:8080/', ['https://example.com:8080'])).toBe(true);
		expect(isUrlTrusted('https://example.com:9090/', ['https://example.com:8080'])).toBe(false);
		const docs = ['https://example.com/docs'];
		expect(isUrlTrusted('https://example.com/docs', docs)).toBe(true);
		expect(isUrlTrusted('https://example.com/docs/a/b', docs)).toBe(true);
		expect(isUrlTrusted('https://example.com/docsx', docs)).toBe(false);
		// Resolved before matching: `..` cannot climb out of a trusted path.
		expect(isUrlTrusted('https://example.com/docs/../admin', docs)).toBe(false);
		expect(isUrlTrusted('https://example.com/docs/%2e%2e/admin', docs)).toBe(false);
		expect(isUrlTrusted('https://example.com/docs/child/../page', docs)).toBe(true);
		const api = ['https://example.com/api/*'];
		expect(isUrlTrusted('https://example.com/api/v1', api)).toBe(true);
		expect(isUrlTrusted('https://example.com/api', api)).toBe(false);
	});

	test('localhost always, user information never, * everything', () => {
		expect(isUrlTrusted('http://localhost:5173/', [])).toBe(true);
		expect(isUrlTrusted('http://127.0.0.1:8080', [])).toBe(true);
		expect(isUrlTrusted('http://[::1]:3000/', [])).toBe(true);
		expect(isUrlTrusted('http://app.localhost/', [])).toBe(true);
		expect(isUrlTrusted('https://github.com@evil.example/', ['https://*.github.com'])).toBe(false);
		expect(isUrlTrusted('https://user:pw@github.com/', ['https://*.github.com'])).toBe(false);
		expect(isUrlTrusted('https://anything.example', ['*'])).toBe(true);
		expect(isUrlTrusted('not a url', ['https://example.com'])).toBe(false);
		// IDN spellings match each other.
		expect(isUrlTrusted('https://xn--bcher-kva.example/page', ['https://bücher.example'])).toBe(true);
		expect(isUrlTrusted('https://x.bücher.example/', ['https://*.xn--bcher-kva.example'])).toBe(true);
		// Bad patterns are skipped.
		expect(isUrlTrusted('https://example.com', ['https://user@example.com', '', 'https://'])).toBe(false);
	});

	test('when a link asks first', () => {
		const base = { trusted: [], fromWorkspace: false, workspaceTrusted: true, promptInTrustedWorkspace: false };
		expect(linkNeedsPrompt('https://example.com', base)).toBe(true);
		expect(linkNeedsPrompt('mailto:a@b.c', base)).toBe(false);
		expect(linkNeedsPrompt('https://example.com', { ...base, trusted: ['https://example.com'] })).toBe(false);
		// Editor and Markdown preview links in a trusted window, unless asked to prompt there too.
		expect(linkNeedsPrompt('https://example.com', { ...base, fromWorkspace: true })).toBe(false);
		expect(linkNeedsPrompt('https://example.com', { ...base, fromWorkspace: true, promptInTrustedWorkspace: true })).toBe(true);
		expect(linkNeedsPrompt('https://example.com', { ...base, fromWorkspace: true, workspaceTrusted: false })).toBe(true);
		expect(isWebLink(' HTTPS://x.y')).toBe(true);
		expect(isWebLink('file:///etc')).toBe(false);
	});

	test('configure offers the exact link and the domain with subdomains', () => {
		expect(trustOptions('https://www.example.com/a/b?q=1')).toEqual({ exact: 'https://www.example.com/a/b', domain: 'https://*.example.com' });
		expect(trustOptions('https://example.com/')).toEqual({ exact: 'https://example.com', domain: 'https://*.example.com' });
		expect(trustOptions('http://10.0.0.5:8080/x')).toEqual({ exact: 'http://10.0.0.5:8080/x', domain: 'http://10.0.0.5:8080' });
		expect(trustOptions('nope')).toBeNull();
		// What a pick trusts is trusted afterwards.
		const o = trustOptions('https://docs.example.com/guide')!;
		expect(isUrlTrusted('https://api.example.com/', [o.domain])).toBe(true);
		expect(isUrlTrusted('https://docs.example.com/guide/x', [o.exact])).toBe(true);
	});

	test('shows long links shortened and keeps the template a valid list', () => {
		expect(displayLink('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
		const long = displayLink(`https://example.com/path?${'x'.repeat(200)}#end`);
		expect(long.startsWith('https://example.com/path?...')).toBe(true);
		expect(long.endsWith('#end')).toBe(true);
		expect(parseJsonc<string[]>(TRUSTED_DOMAINS_TEMPLATE)).toEqual([]);
		expect(parseJsonc<string[]>(appendArrayElement(TRUSTED_DOMAINS_TEMPLATE, 'https://*.example.com'))).toEqual(['https://*.example.com']);
	});
});
