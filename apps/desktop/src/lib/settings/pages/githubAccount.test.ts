import { describe, expect, test } from 'bun:test';
import { AMBIENT, accountKey, ghOptions, readBinding, suggestion, type GhInventory } from './githubAccount.ts';

const inv = (o: Partial<GhInventory> = {}): GhInventory => ({
	installed: true,
	capability: 'supported',
	accounts: [
		{ host: 'github.com', user: 'alice', active: true, source: 'keyring', envToken: null, scopes: ['repo'] },
		{ host: 'github.com', user: 'alice-work', active: false, source: 'keyring', envToken: null, scopes: [] },
		{ host: 'github.com', user: 'ci-bot', active: false, source: 'env', envToken: 'GH_TOKEN', scopes: [] }
	],
	binding: null,
	suggested: null,
	...o
});

describe("a project's GitHub account", () => {
	test('lists the ambient login first, then every login; env-token logins are not choosable', () => {
		const opts = ghOptions(inv(), null);
		expect(opts.map((o) => [o.value, o.disabled])).toEqual([
			[AMBIENT, false],
			['github.com\u0000alice', false],
			['github.com\u0000alice-work', false],
			['github.com\u0000ci-bot', true]
		]);
		expect(opts[3]!.label).toEqual({ key: 'env', user: 'ci-bot', host: 'github.com', token: 'GH_TOKEN' });
	});

	test('a bound login that is gone stays shown but not choosable; an old gh blocks every login', () => {
		const gone = { host: 'github.com', user: 'old' };
		const opts = ghOptions(inv(), gone);
		expect(opts[1]).toEqual({ value: accountKey(gone), label: { key: 'unavailable', user: 'old', host: 'github.com' }, disabled: true });
		expect(ghOptions(inv({ capability: 'unsupported' }), null).filter((o) => !o.disabled).map((o) => o.value)).toEqual([AMBIENT]);
	});

	test("the suggestion is origin's owner unless it is already the binding", () => {
		const s = { host: 'github.com', user: 'alice-work' };
		expect(suggestion(inv({ suggested: s }), null)).toEqual(s);
		expect(suggestion(inv({ suggested: s }), { host: 'GitHub.com', user: 'Alice-Work' })).toBeNull();
		expect(suggestion(inv({ suggested: s, capability: 'unknown' }), null)).toBeNull();
	});

	test('reads the setting as a host and a login', () => {
		expect(readBinding({ host: 'GitHub.com', user: ' a ' })).toEqual({ host: 'github.com', user: 'a' });
		expect(readBinding('alice')).toBeNull();
		expect(readBinding({ host: 'github.com' })).toBeNull();
	});
});
