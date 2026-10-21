import { describe, expect, test } from 'bun:test';
import { RESTRICTED_SETTINGS, withoutRestricted } from './restricted.ts';
import { allowedIn, SETTINGS } from './registry.ts';

describe('restricted settings', () => {
	test('a Restricted Mode window drops them from the folders’ settings, [language] blocks too', () => {
		const values = { 'json.schemas': [{ url: 'https://evil.example/s.json' }], 'editor.fontSize': 14, '[json]': { 'json.schemas': [], 'editor.tabSize': 2 }, '[x]': 'not a block' };
		expect(withoutRestricted(values)).toEqual({ 'editor.fontSize': 14, '[json]': { 'editor.tabSize': 2 }, '[x]': 'not a block' });
	});

	test('each one is a registered setting a folder could otherwise set', () => {
		const byId = new Map(SETTINGS.map((s) => [s.id, s]));
		for (const id of RESTRICTED_SETTINGS) {
			const s = byId.get(id);
			expect([id, !!s]).toEqual([id, true]);
		}
		// Settings that pick a program or its environment stay user-only whatever the trust.
		for (const id of ['terminal.integrated.shell.osx', 'terminal.integrated.profiles.osx', 'terminal.integrated.defaultProfile.osx', 'terminal.integrated.env.osx', 'terminal.integrated.cwd', 'git.path', 'workbench.externalBrowser'])
			expect([id, allowedIn(byId.get(id)!, 'workspace')]).toEqual([id, false]);
	});
});
