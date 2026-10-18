/// <reference types="bun" />
// The settings editor at VS Code's size: sub-groups in the table of contents, search over keys and
// descriptions, the @modified / @id: filters, and validation of every schema kind (enums, arrays,
// glob maps and VS Code's json schemas such as unions and nullable values).
import { describe, expect, test } from 'bun:test';
import { describeSchema, matchesSchema, schemaChoices, schemaTypes } from './jsonSchema';
import { hiddenBySibling, searchSettingsFrom, siblingClauses } from './mappings';
import { mergesByKey, resolveSettings, SCHEMA, SETTINGS, settingProblems, settingsInView, settingSubgroup, subgroupsOf, tocKey, validate } from './registry';

describe('table of contents sub-groups (VS Code settingsLayout)', () => {
	test('a setting goes to the first matching sub-group of its group', () => {
		expect(settingSubgroup({ id: 'editor.cursorStyle', group: 'Text Editor' })).toBe('Cursor');
		expect(settingSubgroup({ id: 'editor.find.loop', group: 'Text Editor' })).toBe('Find');
		expect(settingSubgroup({ id: 'editor.suggest.showWords', group: 'Text Editor' })).toBe('Suggestions');
		expect(settingSubgroup({ id: 'editor.quickSuggestionsDelay', group: 'Text Editor' })).toBe('Suggestions');
		expect(settingSubgroup({ id: 'editor.tabSize', group: 'Text Editor' })).toBeNull();
		expect(settingSubgroup({ id: 'breadcrumbs.enabled', group: 'Workbench' })).toBe('Breadcrumbs');
		expect(settingSubgroup({ id: 'workbench.editor.showTabs', group: 'Workbench' })).toBe('Editor Management');
		expect(settingSubgroup({ id: 'keyboard.dispatch', group: 'Application' })).toBe('Keyboard');
	});

	test('only sub-groups that hold settings are listed, in VS Code’s order', () => {
		expect(subgroupsOf('Text Editor')).toEqual(['Cursor', 'Find', 'Font', 'Formatting', 'Minimap', 'Suggestions']);
		expect(subgroupsOf('Workbench')).toContain('Editor Management');
		expect(subgroupsOf('Terminal')).toEqual([]);
	});

	test('a sub-group selection shows only its settings; a search still spans everything', () => {
		const cursor = settingsInView('', tocKey('Text Editor', 'Cursor'));
		expect(cursor.length).toBeGreaterThan(5);
		expect(cursor.every((s) => s.id.startsWith('editor.cursor'))).toBe(true);
		expect(settingsInView('', 'Text Editor').length).toBeGreaterThan(200);
		expect(settingsInView('minimap', tocKey('Text Editor', 'Cursor')).some((s) => s.id === 'editor.minimap.enabled')).toBe(true);
	});

	test('search matches keys, Thai and English descriptions; @id: and @modified filter', () => {
		expect(settingsInView('bracket pair guides', null).map((s) => s.id)).toContain('editor.guides.bracketPairs');
		expect(settingsInView('คู่วงเล็บ', null).map((s) => s.id)).toContain('editor.guides.highlightActiveBracketPair');
		expect(settingsInView('@id:editor.minimap', null).every((s) => s.id.startsWith('editor.minimap'))).toBe(true);
		const modified = (id: string) => id === 'editor.minimap.size';
		expect(settingsInView('@modified', null, SETTINGS, modified).map((s) => s.id)).toEqual(['editor.minimap.size']);
	});
});

describe('json settings (VS Code schemas the simple types cannot hold)', () => {
	const schema = (id: string) => {
		const s = SCHEMA.get(id)!;
		if (s.type !== 'json') throw new Error(`${id} is not a json setting`);
		return s.schema;
	};

	test('unions, numbers in a range and patterns validate like VS Code', () => {
		const weight = SCHEMA.get('editor.fontWeight')!;
		expect(validate(weight, 'bold')).toBe('bold');
		expect(validate(weight, 600)).toBe(600);
		expect(validate(weight, '600')).toBe('600');
		expect(validate(weight, 1001)).toBeUndefined();
		expect(validate(weight, 'heavy')).toBeUndefined();
		const pairs = SCHEMA.get('editor.guides.bracketPairs')!;
		expect([true, 'active', false].map((v) => validate(pairs, v))).toEqual([true, 'active', false]);
		expect(validate(pairs, 'sometimes')).toBeUndefined();
		const quick = SCHEMA.get('editor.quickSuggestions')!;
		expect(validate(quick, { other: 'on', comments: false, strings: 'inline' })).toBeTruthy();
		expect(validate(quick, { other: 'loud' })).toBeUndefined();
		expect(validate(quick, { nope: 'on' })).toBeUndefined();
	});

	test('dropdown choices for finite unions; open ones are edited in settings.json', () => {
		expect(schemaChoices(schema('editor.guides.bracketPairs'))).toEqual([true, 'active', false]);
		expect(schemaChoices(schema('editor.minimap.scale'))).toEqual([1, 2, 3]);
		expect(schemaChoices(schema('editor.fontWeight'))).toBeNull();
		expect(schemaChoices(schema('editor.quickSuggestions'))).toBeNull();
		expect(schemaChoices({ type: ['boolean', 'null'] })).toEqual([true, false, null]);
	});

	test('types, descriptions and problems', () => {
		expect(schemaTypes(schema('editor.fontWeight'))).toEqual(['number', 'string']);
		expect(describeSchema(schema('editor.guides.bracketPairs'))).toBe('one of true, "active", false');
		expect(settingProblems({ 'editor.guides.bracketPairs': 'x' }, 'user')[0].message).toContain('"active"');
		expect(matchesSchema({ type: 'string', pattern: '^[a-z]+$' }, 'abc')).toBe(true);
		expect(matchesSchema({ type: 'string', pattern: '^[a-z]+$' }, 'ABC')).toBe(false);
	});

	test('object-valued json settings merge key by key across layers', () => {
		const allowed = SCHEMA.get('editor.unicodeHighlight.allowedLocales')!;
		expect(mergesByKey(allowed)).toBe(true);
		expect(mergesByKey(SCHEMA.get('editor.fontWeight')!)).toBe(false);
		const m = resolveSettings({ 'editor.unicodeHighlight.allowedLocales': { th: true } }, {});
		expect(m.get('editor.unicodeHighlight.allowedLocales')?.value).toEqual({ _os: true, _vscode: true, th: true });
	});

	test('exclude maps take VS Code’s sibling clauses, and they hide a file next to its source', () => {
		const exclude = SCHEMA.get('files.exclude')!;
		const map = { '**/*.js': { when: '$(basename).ts' }, '**/dist': true };
		expect(validate(exclude, map)).toEqual(map);
		expect(validate(exclude, { '**/*.js': { when: 1 } })).toBeUndefined();
		expect(validate(SCHEMA.get('files.watcherExclude')!, { '**/*.js': { when: '$(basename).ts' } })).toBeUndefined();
		const clauses = siblingClauses(map, { '**/*.map': { when: '$(basename)' } });
		expect(clauses).toEqual([
			{ glob: '**/*.js', when: '$(basename).ts' },
			{ glob: '**/*.map', when: '$(basename)' }
		]);
		const files = new Set(['src/a.ts', 'src/a.js', 'src/b.js', 'out/x.js', 'out/x.js.map']);
		const exists = (p: string) => files.has(p);
		expect(['src/a.js', 'src/b.js', 'src/a.ts', 'out/x.js.map'].map((f) => hiddenBySibling(f, clauses, exists))).toEqual([true, false, false, true]);
		const search = searchSettingsFrom(<T>(id: string) => resolveSettings({ 'files.exclude': map }, {}).get(id)!.value as T, true);
		expect(search.sibling_clauses).toEqual([{ glob: '**/*.js', when: '$(basename).ts' }]);
		expect(search.exclude_globs).toContain('**/dist');
	});

	test('editor.codeActionsOnSave takes VS Code’s map (with legacy true/false) or a list', () => {
		const s = SCHEMA.get('editor.codeActionsOnSave')!;
		expect(validate(s, { 'source.fixAll': 'explicit', 'source.organizeImports': true })).toBeTruthy();
		expect(validate(s, ['source.organizeImports'])).toEqual(['source.organizeImports']);
		expect(validate(s, { 'source.fixAll': 'sometimes' })).toBeUndefined();
	});
});
