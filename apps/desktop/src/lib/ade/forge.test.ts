import { afterEach, expect, test } from 'bun:test';
import { en } from '#lib/i18n/en.ts';
import { paramNames } from '#lib/i18n/format.ts';
import { setLocale } from '#lib/i18n/index.ts';
import { forgeFor, forgeOf, forgeOfUrl, ft } from './forge';

afterEach(() => setLocale('en'));

test('tells the host from a pull request link', () => {
	expect(forgeOfUrl('https://github.com/acme/app/pull/12')).toBe('github');
	expect(forgeOfUrl('https://gitlab.com/acme/sub/app/-/merge_requests/12')).toBe('gitlab');
	expect(forgeOfUrl('https://git.acme.dev:8443/team/svc/-/merge_requests/3#note_1')).toBe('gitlab');
	expect(forgeOfUrl('https://gitlab.com/acme/app/-/issues/3')).toBeNull();
	expect(forgeOfUrl('')).toBeNull();
	expect(forgeOf({ provider: 'gitlab' })).toBe('gitlab');
	expect(forgeOf(null)).toBe('github');
	expect(forgeFor(null, { provider: 'gitlab' })).toBe('gitlab');
	expect(forgeFor('https://github.com/a/b/pull/1', { provider: 'gitlab' })).toBe('github');
});

test('labels by host', () => {
	expect(ft('forge.create.title', 'github')).toBe('Create Pull Request');
	expect(ft('forge.create.title', 'gitlab')).toBe('Create Merge Request');
	expect(ft('forge.link', 'gitlab', { number: 7 })).toBe('MR !7');
	setLocale('th');
	expect(ft('forge.create.button', 'gitlab')).toBe('สร้าง MR');
});

test('every .github message has a .gitlab twin with the same params', () => {
	const keys = Object.keys(en) as (keyof typeof en)[];
	for (const k of keys) {
		const twin = k.endsWith('.github') ? k.replace(/\.github$/, '.gitlab') : k.endsWith('.gitlab') ? k.replace(/\.gitlab$/, '.github') : null;
		if (!twin) continue;
		expect([k, twin in en]).toEqual([k, true]);
		expect([k, paramNames(en[k]).sort()]).toEqual([k, paramNames((en as Record<string, string>)[twin]).sort()]);
	}
});
