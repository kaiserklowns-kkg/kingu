/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { PROFILE_TEMPLATES, templateSettingIds, templateSettingsText, temporaryProfileName } from './profileTemplates';
import { applyToAllProfiles, profileUserValues, sharedByAllProfiles } from './profiles';
import { SETTINGS } from './registry';

describe('profile templates', () => {
	test('every setting a template sets is a Kingu setting, with a valid value', () => {
		const byId = new Map(SETTINGS.map((s) => [s.id, s]));
		for (const tpl of PROFILE_TEMPLATES) {
			for (const id of templateSettingIds(tpl)) expect([tpl.name, id, byId.has(id)]).toEqual([tpl.name, id, true]);
			for (const [id, v] of Object.entries(tpl.settings)) {
				const s = byId.get(id);
				if (s?.type === 'string' && s.enum) expect(s.enum).toContain(v as string);
			}
			expect(JSON.parse(templateSettingsText(tpl))).toEqual(tpl.settings);
		}
		expect(new Set(PROFILE_TEMPLATES.map((t) => t.id)).size).toBe(PROFILE_TEMPLATES.length);
	});

	test('temporary profile names', () => {
		expect(temporaryProfileName([])).toBe('Temp 1');
		expect(temporaryProfileName(['Temp 1', 'temp 2'])).toBe('Temp 3');
	});
});

describe('workbench.settings.applyToAllProfiles', () => {
	test('listed settings come from the Default profile in every profile', () => {
		const defaults = { 'workbench.settings.applyToAllProfiles': ['editor.fontSize', 7], 'editor.fontSize': 18, 'editor.tabSize': 8 };
		expect([...applyToAllProfiles(defaults)]).toEqual(['editor.fontSize']);
		expect(profileUserValues({ 'editor.fontSize': 12, 'editor.tabSize': 2 }, defaults, SETTINGS)).toEqual({ 'editor.tabSize': 2, 'editor.fontSize': 18, 'workbench.settings.applyToAllProfiles': ['editor.fontSize', 7] });
		expect(sharedByAllProfiles('editor.fontSize', SETTINGS.find((s) => s.id === 'editor.fontSize'), defaults)).toBe(true);
		expect(sharedByAllProfiles('editor.tabSize', SETTINGS.find((s) => s.id === 'editor.tabSize'), defaults)).toBe(false);
		// The setting itself lives in the Default profile (application scope).
		expect(SETTINGS.find((s) => s.id === 'workbench.settings.applyToAllProfiles')?.scope).toBe('application');
		expect(applyToAllProfiles({})).toEqual(new Set());
	});
});
