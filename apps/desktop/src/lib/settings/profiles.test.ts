/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { activeProfileName, profileUserValues, templateContents } from './profiles';
import { SETTINGS } from './registry';
import { renderWindowTitle } from '#lib/workbench/title.ts';

describe('profiles', () => {
	test('application-scoped settings come from the Default profile, the rest from the active one', () => {
		const app = SETTINGS.find((s) => s.scope === 'application')!;
		const plain = SETTINGS.find((s) => s.id === 'editor.fontSize')!;
		expect(app).toBeDefined();
		const values = profileUserValues({ [plain.id]: 20, [app.id]: 'from profile' }, { [plain.id]: 12, [app.id]: 'from default' }, SETTINGS);
		expect(values).toEqual({ [plain.id]: 20, [app.id]: 'from default' });
		// Unset in the profile: the Default profile's value of a plain setting does not leak in.
		expect(profileUserValues({}, { [plain.id]: 12 }, SETTINGS)).toEqual({});
	});

	test('the window title names the active profile, nothing for Default', () => {
		const list = { active: 'a1', profiles: [{ id: 'a1', name: 'Work' }] };
		expect(activeProfileName(list)).toBe('Work');
		expect(activeProfileName({ ...list, active: null })).toBe('');
		const tpl = '${rootName}${separator}${profileName}${separator}${appName}';
		expect(renderWindowTitle(tpl, { rootName: 'kingu', profileName: 'Work', app: 'Kingu' })).toBe('kingu — Work — Kingu');
		expect(renderWindowTitle(tpl, { rootName: 'kingu', profileName: '', app: 'Kingu' })).toBe('kingu — Kingu');
	});
});

describe('Import Profile', () => {
	test('lists what a template holds', () => {
		expect(templateContents({ name: 'x', settings: true, keybindings: false, snippets: 2 })).toEqual([
			{ key: 'profiles.partSettings', count: 1 },
			{ key: 'profiles.partSnippets', count: 2 }
		]);
		expect(templateContents({ name: 'x', settings: false, keybindings: false, snippets: 0 })).toEqual([]);
	});
});
