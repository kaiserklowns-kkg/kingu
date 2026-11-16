import { expect, test } from 'bun:test';
import { parseJsonc } from './jsonc.ts';
import { defaultKeybindingsJson, defaultSettingsJson, isDefaultsKey, DEFAULT_SETTINGS_KEY } from './defaultsJson.ts';
import { SETTINGS } from './registry';

test('Default Settings (JSON) parses as JSONC and has every default', () => {
	const text = defaultSettingsJson(SETTINGS, 'Read-only.');
	const parsed = parseJsonc(text) as Record<string, unknown>;
	expect(Object.keys(parsed).length).toBe(new Set(SETTINGS.map((s) => s.id)).size);
	for (const s of SETTINGS.slice(0, 50)) expect(parsed[s.id]).toEqual(s.default as never);
	expect(text.startsWith('// Read-only.')).toBe(true);
});

test('Default Keyboard Shortcuts (JSON): platform keys, layout notes, unbound commands as comments', () => {
	const text = defaultKeybindingsJson(
		[
			{ id: 'a.cmd', title: 'A', category: 'X', key: 'ctrl+-', mac: 'cmd+-' },
			{ id: 'b.cmd', title: 'B', key: 'cmd+t', scope: 'agents' },
			{ id: 'c.cmd', title: 'C' }
		],
		true,
		'Header',
		(s) => `${s} layout`
	);
	const parsed = parseJsonc(text) as { key: string; command: string }[];
	expect(parsed).toEqual([
		{ key: 'cmd+-', command: 'a.cmd' },
		{ key: 'cmd+t', command: 'b.cmd' }
	]);
	expect(text).toContain('// B (agents layout)');
	expect(text).toContain('// - c.cmd: C');
	expect(isDefaultsKey(DEFAULT_SETTINGS_KEY)).toBe(true);
});
