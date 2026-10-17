/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { jsonSchema, matchesQuery, resolveSettings, SCHEMA, SETTINGS, SETTINGS_SECTIONS, settingsInView, settingTitle, validate } from './registry';

const value = (m: ReturnType<typeof resolveSettings>, id: string) => m.get(id);

describe('resolveSettings', () => {
	test('defaults when nothing is set', () => {
		const m = resolveSettings({}, {});
		expect(value(m, 'editor.fontSize')).toEqual({ value: 12, source: 'default' });
		expect(value(m, 'files.autoSave')).toEqual({ value: 'off', source: 'default' });
		expect(value(m, 'files.autoSaveDelay')).toEqual({ value: 1000, source: 'default' });
		expect(value(m, 'workbench.colorTheme')).toEqual({ value: 'Dark Modern', source: 'default' });
	});

	test('workspace overrides user overrides default', () => {
		const m = resolveSettings({ 'editor.fontSize': 14, 'editor.tabSize': 2 }, { 'editor.fontSize': 16 });
		expect(value(m, 'editor.fontSize')).toEqual({ value: 16, source: 'workspace' });
		expect(value(m, 'editor.tabSize')).toEqual({ value: 2, source: 'user' });
	});

	test('invalid values fall through to the next layer', () => {
		const m = resolveSettings(
			{ 'editor.fontSize': 15, 'files.autoSave': 'sometimes', 'editor.tabSize': 2.5 },
			{ 'editor.fontSize': '16', 'editor.minimap.enabled': 'no', 'window.zoomLevel': 99 }
		);
		expect(value(m, 'editor.fontSize')).toEqual({ value: 15, source: 'user' });
		expect(value(m, 'files.autoSave')?.source).toBe('default');
		expect(value(m, 'editor.tabSize')?.source).toBe('default');
		expect(value(m, 'editor.minimap.enabled')).toEqual({ value: true, source: 'default' });
		expect(value(m, 'window.zoomLevel')?.source).toBe('default');
	});

	test('application settings ignore the workspace file', () => {
		const m = resolveSettings({ 'workbench.colorTheme': 'Light+' }, { 'workbench.colorTheme': 'Dark+', 'window.zoomLevel': 2 });
		expect(value(m, 'workbench.colorTheme')).toEqual({ value: 'Light+', source: 'user' });
		expect(value(m, 'window.zoomLevel')?.source).toBe('default');
	});

	test('unknown keys are ignored', () => {
		const m = resolveSettings({ 'nope.nothing': 1 }, {});
		expect(m.has('nope.nothing')).toBe(false);
		expect(m.size).toBe(SETTINGS.length);
	});
});

describe('schema', () => {
	test('has the required settings with VS Code defaults', () => {
		for (const id of [
			'workbench.colorTheme',
			'editor.fontSize',
			'editor.fontFamily',
			'editor.tabSize',
			'editor.insertSpaces',
			'editor.wordWrap',
			'editor.minimap.enabled',
			'editor.renderWhitespace',
			'files.autoSave',
			'files.autoSaveDelay',
			'terminal.integrated.fontSize',
			'window.zoomLevel',
			'workbench.editor.enablePreview'
		])
			expect(SCHEMA.has(id)).toBe(true);
		expect(SCHEMA.get('editor.renderWhitespace')?.default).toBe('selection');
		expect(SCHEMA.get('workbench.editor.enablePreview')?.default).toBe(true);
	});

	test('every default validates against its own schema', () => {
		for (const s of SETTINGS) expect(validate(s, s.default)).toEqual(s.default);
	});

	test('titles read like VS Code', () => {
		expect(settingTitle(SCHEMA.get('editor.minimap.enabled')!)).toEqual({ category: 'Editor › Minimap', label: 'Enabled' });
		expect(settingTitle(SCHEMA.get('files.autoSaveDelay')!)).toEqual({ category: 'Files', label: 'Auto Save Delay' });
	});

	test('search matches id, title words and description', () => {
		const s = SCHEMA.get('files.autoSave')!;
		expect(matchesQuery(s, 'autosave')).toBe(true);
		expect(matchesQuery(s, 'auto save')).toBe(true);
		expect(matchesQuery(s, 'บันทึก')).toBe(true);
		expect(matchesQuery(s, 'minimap')).toBe(false);
	});

	test('JSON schema lists every setting', () => {
		const schema = jsonSchema() as { properties: Record<string, { type: string; enum?: string[] }> };
		expect(Object.keys(schema.properties)).toHaveLength(SETTINGS.length);
		expect(schema.properties['editor.tabSize'].type).toBe('integer');
		expect(schema.properties['files.autoSave'].enum).toEqual(['off', 'afterDelay', 'onFocusChange']);
	});

	test('title bar and layout settings, with VS Code defaults and Thai + English descriptions', () => {
		const m = resolveSettings({}, {});
		const expected: Record<string, unknown> = {
			'window.commandCenter': true,
			'window.menuBarVisibility': 'classic',
			'window.titleSeparator': ' — ',
			'workbench.navigationControl.enabled': true,
			'workbench.layoutControl.enabled': true,
			'workbench.layoutControl.type': 'both',
			'workbench.activityBar.location': 'default',
			'workbench.sideBar.location': 'left',
			'workbench.panel.defaultLocation': 'bottom',
			'workbench.panel.alignment': 'center',
			'kingu.agentsControl.enabled': 'compact',
			'kingu.titleBar.openInAgents.enabled': true
		};
		for (const [id, v] of Object.entries(expected)) expect([id, m.get(id)?.value]).toEqual([id, v]);
		expect(String(m.get('window.title')?.value)).toContain('${activeEditorShort}${separator}${rootName}');
		for (const id of [...Object.keys(expected), 'window.title']) {
			const d = SCHEMA.get(id)!.description;
			expect([id, /[฀-๿]/.test(d), /\([A-Z][^)]*\.\)/.test(d)]).toEqual([id, true, true]);
		}
		expect(SCHEMA.get('kingu.agentsControl.enabled')).toMatchObject({ enum: ['hidden', 'badge', 'compact'] });
		expect(resolveSettings({ 'workbench.layoutControl.type': 'sideways' }, {}).get('workbench.layoutControl.type')?.source).toBe('default');
	});
});

describe('settings sections', () => {
	test('every group belongs to exactly one section', () => {
		const groups = new Set(SETTINGS.map((s) => s.group));
		for (const g of groups) expect(SETTINGS_SECTIONS.filter((sec) => sec.groups.includes(g))).toHaveLength(1);
		for (const sec of SETTINGS_SECTIONS) for (const g of sec.groups) expect(groups.has(g)).toBe(true);
	});
	test('a group filters, a query searches everything', () => {
		expect(settingsInView('', 'Terminal').every((s) => s.group === 'Terminal')).toBe(true);
		expect(settingsInView('', null)).toHaveLength(SETTINGS.length);
		expect(settingsInView('fontSize', 'Agent').map((s) => s.id)).toEqual(['editor.fontSize', 'terminal.integrated.fontSize']);
	});
});
