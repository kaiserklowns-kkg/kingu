/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { IDE_SETTINGS } from './ideSettings';
import { jsonSchema, matchesQuery, parseQuery, resolveSettings, SCHEMA, SETTINGS, SETTINGS_SECTIONS, settingProblems, settingsInView, settingsSections, settingTitle, validate, type SettingSchema } from './registry';

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
		expect(schema.properties['files.autoSave'].enum).toEqual(['off', 'afterDelay', 'onFocusChange', 'onWindowChange']);
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
			'workbench.activityBar.location': 'top',
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

describe('ADE settings', () => {
	test('worktree and agent settings with Orca-like defaults and Thai + English descriptions', () => {
		const m = resolveSettings({}, {});
		const expected: Record<string, unknown> = {
			'kingu.worktree.branchPrefix': 'kingu/',
			'kingu.worktree.baseBranch': '',
			'kingu.worktree.setupScript': 'auto',
			'kingu.worktree.deleteBranchOnRemove': 'deleteMerged',
			'kingu.worktree.archiveScript': 'auto',
			'kingu.worktree.confirmRemove': true,
			'kingu.worktree.refreshBaseOnCreate': false,
			'kingu.pr.draft': false,
			'kingu.pr.openAfterCreate': false,
			'kingu.statusBar.usage.display': 'used',
			'kingu.agent.notifications': true,
			'kingu.agent.notifications.suppressWhenFocused': true,
			'kingu.agent.notifications.events': 'all',
			'kingu.agent.notifications.sound': 'default',
			'kingu.agent.args.claude': '',
			'kingu.agent.args.codex': ''
		};
		for (const [id, v] of Object.entries(expected)) {
			expect([id, m.get(id)?.value]).toEqual([id, v]);
			const d = SCHEMA.get(id)!.description;
			expect([id, /[฀-๿]/.test(d), /\([A-Z][^)]*\.\)/.test(d)]).toEqual([id, true, true]);
		}
		expect(settingsSections().find((s) => s.id === 'ade')?.groups).toEqual(['Agent', 'Worktrees', 'Pull Requests']);
	});

	test('settings that run commands, loosen prompts or delete branches are user-only', () => {
		const userOnly = [
			'kingu.agent.cli',
			'kingu.agent.permissionMode',
			'kingu.worktree.setupScript',
			'kingu.worktree.deleteBranchOnRemove',
			'kingu.worktree.archiveScript',
			'kingu.worktree.refreshBaseOnCreate',
			'kingu.automations.enabled',
			'kingu.snaps.sandbox',
			...SETTINGS.filter((s) => s.id.startsWith('kingu.agent.args.')).map((s) => s.id)
		];
		expect(userOnly.length).toBeGreaterThan(10);
		const workspace = Object.fromEntries(userOnly.map((id) => [id, SCHEMA.get(id)!.type === 'string' ? 'x' : true]));
		workspace['kingu.agent.cli'] = './evil.sh';
		workspace['kingu.agent.args.claude'] = '--dangerously-skip-permissions';
		workspace['kingu.worktree.setupScript'] = 'auto';
		workspace['kingu.worktree.deleteBranchOnRemove'] = 'delete';
		const m = resolveSettings({}, workspace);
		for (const id of userOnly) expect([id, m.get(id)?.source]).toEqual([id, 'default']);
		// A team convention may come from the repository.
		const ws = resolveSettings({}, { 'kingu.worktree.branchPrefix': 'feature/', 'kingu.worktree.baseBranch': 'develop' });
		expect(ws.get('kingu.worktree.branchPrefix')).toEqual({ value: 'feature/', source: 'workspace' });
		expect(ws.get('kingu.worktree.baseBranch')).toEqual({ value: 'develop', source: 'workspace' });
	});
});

describe('settings sections', () => {
	// Contributed (Snap) settings, as snapModel.snapSettingSchemas makes them.
	const contributed: SettingSchema[] = [
		{ id: 'snap.go.testFlags', group: 'Snap: Go', type: 'string', default: '-race', description: 'flags', scope: 'application' },
		{ id: 'snap.go.verbose', group: 'Snap: Go', type: 'boolean', default: false, description: 'v', scope: 'application' },
		{ id: 'snap.lint.strict', group: 'Snap: Lint', type: 'boolean', default: true, description: 's' }
	];

	test('every group belongs to exactly one section', () => {
		for (const schemas of [SETTINGS, [...SETTINGS, ...contributed]]) {
			const sections = settingsSections(schemas);
			const groups = new Set(schemas.map((s) => s.group));
			for (const g of groups) expect([g, sections.filter((sec) => sec.groups.includes(g)).length]).toEqual([g, 1]);
			for (const sec of sections) for (const g of sec.groups) expect(groups.has(g)).toBe(true);
		}
		// The static sections only hold static groups.
		const staticGroups = new Set(SETTINGS.map((s) => s.group));
		for (const sec of SETTINGS_SECTIONS) for (const g of sec.groups) expect(staticGroups.has(g)).toBe(true);
	});
	test('contributed groups go to the Snaps section, which is always there', () => {
		expect(settingsSections().at(-1)).toEqual({ id: 'snaps', label: 'Snaps', groups: [] });
		expect(settingsSections([...SETTINGS, ...contributed]).at(-1)?.groups).toEqual(['Snap: Go', 'Snap: Lint']);
		const all = [...SETTINGS, ...contributed];
		expect(settingsInView('', 'Snap: Go', all).map((s) => s.id)).toEqual(['snap.go.testFlags', 'snap.go.verbose']);
		expect(Object.keys((jsonSchema(all) as { properties: object }).properties)).toContain('snap.lint.strict');
		expect(resolveSettings({ 'snap.go.testFlags': '-v' }, { 'snap.go.testFlags': '-exec=x', 'snap.lint.strict': false }, all).get('snap.go.testFlags')).toEqual({ value: '-v', source: 'user' });
		expect(resolveSettings({}, { 'snap.lint.strict': false }, all).get('snap.lint.strict')).toEqual({ value: false, source: 'workspace' });
	});
	test('a group filters, a query searches everything', () => {
		expect(settingsInView('', 'Terminal').every((s) => s.group === 'Terminal')).toBe(true);
		expect(settingsInView('', null)).toHaveLength(SETTINGS.length);
		expect(settingsInView('fontSize', 'Agent').map((s) => s.id)).toEqual(['editor.fontSize', 'terminal.integrated.fontSize']);
	});
});

describe('VS Code IDE settings', () => {
	test('object settings merge key by key, workspace over user over default', () => {
		const m = resolveSettings({ 'files.exclude': { '**/tmp': true, '**/.git': false } }, { 'files.exclude': { '**/out': true } });
		expect(m.get('files.exclude')).toEqual({
			value: { '**/.git': false, '**/.svn': true, '**/.hg': true, '**/CVS': true, '**/.DS_Store': true, '**/Thumbs.db': true, '**/tmp': true, '**/out': true },
			source: 'workspace'
		});
		expect(resolveSettings({ 'files.exclude': { x: 'yes' } }, {}).get('files.exclude')?.source).toBe('default');
	});

	test('arrays and maps validate their items', () => {
		expect(validate(SCHEMA.get('editor.rulers')!, [80, 120])).toEqual([80, 120]);
		expect(validate(SCHEMA.get('editor.rulers')!, [80, '120'])).toBeUndefined();
		expect(validate(SCHEMA.get('terminal.integrated.shellArgs.osx')!, ['-l'])).toEqual(['-l']);
		expect(validate(SCHEMA.get('editor.codeActionsOnSave')!, { 'source.fixAll': 'explicit', 'source.organizeImports': true })).toBeTruthy();
		expect(validate(SCHEMA.get('editor.codeActionsOnSave')!, { 'source.fixAll': 1 })).toBeUndefined();
		expect(validate(SCHEMA.get('files.exclude')!, ['**/.git'])).toBeUndefined();
	});

	test('problems list ignored values with a reason', () => {
		const problems = settingProblems({ 'editor.fontSize': 'big', 'editor.tabSize': 4, 'nope.unknown': 1, 'terminal.integrated.shell.osx': '/bin/zsh' }, 'workspace');
		expect(problems.map((p) => p.id)).toEqual(['editor.fontSize', 'terminal.integrated.shell.osx']);
		expect(problems[0].message).toContain('a number');
		expect(problems[1].message).toContain('user settings');
		expect(settingProblems({ 'files.autoSave': 'sometimes' }, 'user')[0].message).toContain('"onWindowChange"');
	});

	test('@modified and @id: filters', () => {
		const modified = (id: string) => id === 'editor.fontSize' || id === 'files.autoSave';
		expect(settingsInView('@modified', null, SETTINGS, modified).map((s) => s.id)).toEqual(['editor.fontSize', 'files.autoSave']);
		expect(settingsInView('@modified font', 'Agent', SETTINGS, modified).map((s) => s.id)).toEqual(['editor.fontSize']);
		expect(settingsInView('@id:files.autoSave', null).map((s) => s.id)).toEqual(['files.autoSave', 'files.autoSaveDelay']);
		expect(parseQuery('@modified  tab size')).toEqual({ filters: { modified: true, id: null }, text: 'tab size' });
	});

	test('search finds Thai and English descriptions', () => {
		expect(settingsInView('ช่องว่างท้ายบรรทัด', null).map((s) => s.id)).toContain('files.trimTrailingWhitespace');
		expect(settingsInView('trailing whitespace', null).map((s) => s.id)).toContain('files.trimTrailingWhitespace');
	});

	test('every IDE setting: Thai + English description, a valid default, a known section', () => {
		const sectionGroups = new Set(SETTINGS_SECTIONS.flatMap((s) => s.groups));
		for (const s of IDE_SETTINGS) {
			expect([s.id, /[฀-๿]/.test(s.description), /\([A-Z][^)]*\.\)/.test(s.description)]).toEqual([s.id, true, true]);
			expect([s.id, validate(s, s.default) !== undefined]).toEqual([s.id, true]);
			expect([s.id, sectionGroups.has(s.group)]).toEqual([s.id, true]);
		}
		expect(new Set(SETTINGS.map((s) => s.id)).size).toBe(SETTINGS.length);
	});

	test('every VS Code-derived setting is read somewhere outside the registry (webview or Rust)', () => {
		const sources: string[] = [];
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const p = join(dir, name);
				if (statSync(p).isDirectory()) walk(p);
				else if (/\.(ts|svelte|rs)$/.test(name) && !/\.test\.ts$|registry\.ts$|ideSettings\.ts$/.test(name)) sources.push(readFileSync(p, 'utf8'));
			}
		};
		walk(join(import.meta.dir, '..'));
		// Some are read by Rust before the webview runs (window.restoreWindows).
		walk(join(import.meta.dir, '../../../src-tauri/src'));
		const all = sources.join('\n').replaceAll('"', "'");
		// Per-platform terminal settings are read as `terminal.integrated.shell.${platform}`.
		const asRead = (id: string) => id.replace(/\.(osx|linux)$/, '.${platform}');
		for (const s of SETTINGS.filter((x) => !x.id.startsWith('kingu.'))) expect([s.id, all.includes(`'${s.id}'`) || all.includes(asRead(s.id))]).toEqual([s.id, true]);
	});
});
