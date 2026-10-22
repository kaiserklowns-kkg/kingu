/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJsonc } from '#lib/settings/jsonc.ts';
import { languageFor, languageName, setContributedAssociations } from '#lib/editor/languages.ts';
import { parseSnippetFile } from '#lib/editor/snippets/snippetFiles.ts';
import { flattenTheme } from '#lib/editor/textmate/theme.ts';
import { SERVERS, serverFor, TABLE_SERVERS } from '#lib/lsp/model.ts';
import { allThemes, findTheme, setContributedThemes, THEMES, themesOfSnaps } from '#lib/theme/themes.ts';
import { withEnumValues } from '#lib/settings/enumValues.ts';
import { BUILTIN_SNAPS } from './builtinSnaps.ts';
import {
	contributionGroups,
	grammarsOf,
	languageAssociations,
	languageConfiguration,
	languagesOf,
	lspServersOf,
	resolveSnapPath,
	snapServerSettings,
	snippetsOf,
	viewKey,
	viewsOf,
	withBuiltins,
	type SnapContributions
} from './contributions.ts';
import { iconIdFor, iconPathFor, parseIconTheme } from './iconTheme.ts';
import { trustSummary, type SnapInfo } from './snapModel.ts';

const FIXTURE = join(import.meta.dir, '../../../tests/fixtures/snaps/example');
const fixture = (p: string) => readFileSync(join(FIXTURE, p), 'utf8');

/** The example fixture as `snap_list` returns it (src-tauri checks the same folder). */
const contributes: SnapContributions = {
	languages: [{ id: 'knote', aliases: ['Kingu Note', 'knote'], extensions: ['.knote'], filenames: ['NOTES.knote'], filenamePatterns: [], firstLine: null, configuration: 'language-configuration.json' }],
	grammars: [{ language: 'knote', scopeName: 'text.knote', path: 'syntaxes/knote.tmLanguage.json', embeddedLanguages: {}, tokenTypes: { 'string.quoted': 'string' }, injectTo: [], balancedBracketScopes: [], unbalancedBracketScopes: [] }],
	snippets: [{ language: 'knote', path: 'snippets/knote.code-snippets' }],
	lsp: [{ key: 'knote', name: 'Kingu Note language server', languages: ['knote'], command: ['${setting:serverPath}', '--stdio'], env: {}, initializationOptions: { lint: true }, settingsSection: 'knote', install: [{ tool: 'npm', package: 'knote-ls' }] }],
	themes: [{ id: 'Example Night', label: 'Example Night', uiTheme: 'vs-dark', path: 'themes/night.json' }],
	iconThemes: [{ id: 'example-icons', label: 'Example Icons', path: 'icons/icon-theme.json' }],
	views: [{ id: 'board', name: 'Board', location: 'panel', path: 'views/board.html', settings: ['greeting'], tasks: ['hello'], notifications: true }],
	files: [{ path: 'views/board.html', sha256: 'ab' }, { path: 'themes/night.json', sha256: 'cd' }]
};

const snap = (over: Partial<SnapInfo> = {}): SnapInfo => ({
	id: 'example',
	name: 'Example',
	version: '0.1.0',
	description: '',
	source: 'user',
	dir: FIXTURE,
	trusted: true,
	error: null,
	overridden: false,
	hash: 'h',
	permissions: { network: false, fs: 'worktree', secrets: [] },
	tasks: [{ id: 'hello', title: 'Say Hello', command: ['echo', '${setting:greeting}'] }],
	settings: [
		{ key: 'greeting', type: 'string', default: 'Hello from the board', description: '' },
		{ key: 'serverPath', type: 'string', default: 'knote-ls', description: '' }
	],
	mcp: [],
	skills: [],
	hooks: [],
	requires: [],
	services: [],
	readme: null,
	runFiles: [],
	contributes,
	scripts: [],
	approvedPermissions: null,
	origin: null,
	lock: null,
	...over
});

describe('built-in snaps', () => {
	test('the themes are the ones Kingu always had, in the same order', () => {
		// The table themes.ts had before the themes moved into the `kingu-themes` built-in snap.
		const before = [
			['Kingu Dark', 'Kingu Dark', 'kingu-dark.json', 'dark'],
			['Kingu Light', 'Kingu Light', 'kingu-light.json', 'light'],
			['Light 2026', '2026 Light', '2026-light.json', 'light'],
			['Dark 2026', '2026 Dark', '2026-dark.json', 'dark'],
			['Light Modern', 'Light Modern', 'light_modern.json', 'light'],
			['Light+', 'Light+', 'light_plus.json', 'light'],
			['Dark Modern', 'Dark Modern', 'dark_modern.json', 'dark'],
			['Dark+', 'Dark+', 'dark_plus.json', 'dark'],
			['Default High Contrast', 'Dark High Contrast', 'hc_black.json', 'hcDark'],
			['Default High Contrast Light', 'Light High Contrast', 'hc_light.json', 'hcLight']
		];
		expect(THEMES.map((t) => [t.id, t.label, t.file.replace(/^themes\//, ''), t.type])).toEqual(before);
		expect(THEMES.every((t) => t.snap.source === 'builtin' && t.snap.id === 'kingu-themes' && t.sha256 === undefined)).toBe(true);
	});

	test('rust-analyzer is the same server as the table row it replaced', () => {
		const ra = serverFor('rust')!;
		expect([ra.key, ra.name, ra.languages]).toEqual(['rust', 'rust-analyzer', ['rust']]);
		expect(ra.snap).toEqual({ source: 'builtin', id: 'rust-analyzer', server: 'rust', command: ['rust-analyzer'], env: {}, settingsSection: null });
		expect(ra.initializationOptions).toBeUndefined();
		expect(SERVERS[0]).toBe(ra);
		expect(SERVERS.slice(1)).toEqual(TABLE_SERVERS);
	});

	test('a user snap with the same id overrides a built-in one', () => {
		const ra = BUILTIN_SNAPS.find((s) => s.id === 'rust-analyzer')!;
		const mine = snap({ id: 'rust-analyzer', contributes: { ...contributes, lsp: [] } });
		const all = withBuiltins(BUILTIN_SNAPS, [mine]);
		expect(all.find((s) => s.source === 'builtin' && s.id === 'rust-analyzer')!.overridden).toBe(true);
		expect(lspServersOf(all).some((s) => s.key === 'rust')).toBe(false);
		// An untrusted repo snap cannot switch a built-in off.
		const repo = snap({ id: 'rust-analyzer', source: 'repo', trusted: false });
		expect(withBuiltins(BUILTIN_SNAPS, [repo]).find((s) => s.source === 'builtin' && s.id === 'rust-analyzer')).toEqual(ra);
	});
});

describe('language contributions', () => {
	test('associations: a snap language opens its files, and wins among equals', () => {
		const langs = languagesOf([snap()]);
		expect(languageFor('a.knote')).toBe('plaintext');
		setContributedAssociations(languageAssociations(langs), { knote: 'Kingu Note' });
		expect(languageFor('notes/a.knote')).toBe('knote');
		expect(languageFor('NOTES.knote')).toBe('knote');
		expect(languageName('knote')).toBe('Kingu Note');
		setContributedAssociations(languageAssociations(languagesOf([snap({ contributes: { ...contributes, languages: [{ ...contributes.languages[0], extensions: ['.md'] }] } })])));
		expect(languageFor('README.md')).toBe('knote');
		setContributedAssociations([]);
		expect(languageFor('README.md')).toBe('markdown');
		expect(languageFor('a.knote')).toBe('plaintext');
	});

	test('untrusted, broken or overridden snaps contribute nothing', () => {
		for (const s of [snap({ source: 'repo', trusted: false }), snap({ error: 'bad' }), snap({ overridden: true })]) {
			expect(languagesOf([s])).toEqual([]);
			expect(grammarsOf([s])).toEqual([]);
			expect(lspServersOf([s])).toEqual([]);
			expect(viewsOf([s])).toEqual([]);
		}
	});

	test('language-configuration.json becomes Monaco language configuration', () => {
		const c = languageConfiguration(parseJsonc(fixture('language-configuration.json')));
		expect(c.comments).toEqual({ lineComment: '#', blockComment: ['<!--', '-->'] });
		expect(c.brackets).toEqual([['[', ']'], ['(', ')']]);
		expect(c.autoClosingPairs).toEqual([{ open: '[', close: ']' }, { open: '"', close: '"', notIn: ['string'] }]);
		expect(c.surroundingPairs).toEqual([{ open: '*', close: '*' }]);
		expect(c.wordPattern?.source).toBe('[\\w-]+');
		expect(c.indentationRules?.increaseIndentPattern.test('  - a:')).toBe(true);
		expect(c.folding?.markers?.start.test('## x')).toBe(true);
		expect(c.onEnterRules).toEqual([{ beforeText: /^\s*- /, action: { indentAction: 0, appendText: '- ' } }]);
	});

	test('bad regexes and shapes are left out instead of failing', () => {
		const c = languageConfiguration({ wordPattern: '([', indentationRules: { increaseIndentPattern: 'a' }, onEnterRules: [{ beforeText: 'x', action: { indent: 'sideways' } }, { beforeText: { pattern: 'y', flags: 'i' }, action: { indent: 'indentOutdent' } }], brackets: [['(']] });
		expect(c.wordPattern).toBeUndefined();
		expect(c.indentationRules).toBeUndefined();
		expect(c.brackets).toEqual([]);
		expect(c.onEnterRules).toEqual([{ beforeText: /y/i, action: { indentAction: 2 } }]);
		expect(languageConfiguration(null)).toEqual({});
		expect(languageConfiguration({ comments: { lineComment: { comment: '--', noIndent: true } } }).comments).toEqual({ lineComment: '--' });
	});

	test('grammars carry their listed hash and token types', () => {
		const [g] = grammarsOf([snap()]);
		expect(g.scopeName).toBe('text.knote');
		expect(g.tokenTypes).toEqual({ 'string.quoted': 2 });
		expect(g.snap).toEqual({ source: 'user', id: 'example' });
	});

	test('snippets are for the language the manifest names', () => {
		const [f] = snippetsOf([snap()]);
		expect([f.language, f.path, f.snapName]).toEqual(['knote', 'snippets/knote.code-snippets', 'Example']);
		const { snippets } = parseSnippetFile(fixture(f.path), `${f.snapName}: ${f.path}`, 'snap', f.language);
		expect(snippets.map((s) => [s.prefix, s.scopes, s.source, s.language])).toEqual([['todo', ['knote'], 'snap', 'knote']]);
	});
});

describe('language servers', () => {
	test('a snap server is a namespaced row before the table, with its settings section', () => {
		const rows = lspServersOf([...BUILTIN_SNAPS, snap()]);
		expect(rows.map((r) => r.key)).toEqual(['example/knote', 'rust']);
		const k = rows[0];
		expect(k.initializationOptions).toEqual({ lint: true });
		expect(k.snap).toEqual({ source: 'user', id: 'example', server: 'knote', command: ['${setting:serverPath}', '--stdio'], env: {}, settingsSection: 'knote' });
		expect(serverFor('knote', [...rows, ...TABLE_SERVERS])?.key).toBe('example/knote');
		const settings = snapServerSettings(snap(), 'knote', (id) => (id === 'snap.example.serverPath' ? '/opt/knote' : undefined));
		expect(settings).toEqual({ knote: { greeting: 'Hello from the board', serverPath: '/opt/knote' } });
		expect(snapServerSettings(snap(), null, () => 1)).toEqual({});
	});

	test('the trust confirm lists the server command and the views', () => {
		const text = trustSummary(snap({ source: 'repo', trusted: false }));
		expect(text).toContain('Kingu Note language server: ${setting:serverPath} --stdio');
		expect(text).toContain('Board');
	});
});

describe('themes', () => {
	test('a snap color theme loads with its include, tokenColors and semanticTokenColors', () => {
		const [info] = themesOfSnaps([snap()]);
		expect([info.id, info.type, info.file, info.sha256]).toEqual(['Example Night', 'dark', 'themes/night.json', 'cd']);
		const flat = flattenTheme(info.file, (p) => fixture(p));
		expect(flat.colors['editor.background']).toBe('#101820');
		expect(flat.colors['sideBar.background']).toBe('#0C1218');
		expect(flat.tokenColors.map((r) => r.scope)).toEqual(['comment', 'keyword.other.todo']);
		expect(flat.semanticHighlighting).toBe(true);
		expect(flat.semanticTokenColors).toEqual({ 'variable.readonly': '#80C0FF' });
	});

	test('snap themes join the pickers; a built-in id stays the built-in', () => {
		setContributedThemes([...themesOfSnaps([snap()]), { ...THEMES[0], snap: { source: 'user', id: 'x' } }]);
		expect(allThemes().map((t) => t.id)).toEqual([...THEMES.map((t) => t.id), 'Example Night']);
		expect(findTheme('Example Night').snap.id).toBe('example');
		expect(findTheme('Kingu Dark').snap.id).toBe('kingu-themes');
		setContributedThemes([]);
		expect(findTheme('Example Night').id).toBe('Kingu Dark');
	});

	test('their ids extend the theme settings enums', () => {
		const colorTheme = { id: 'workbench.colorTheme', group: 'Workbench', type: 'string' as const, default: 'Dark Modern', enum: ['Dark Modern'], enumDescriptions: ['Dark Modern'], description: '' };
		expect(withEnumValues(colorTheme, { values: ['Example Night', 'Dark Modern'], labels: ['Example Night', 'x'] })).toMatchObject({ enum: ['Dark Modern', 'Example Night'], enumDescriptions: ['Dark Modern', 'Example Night'] });
		const iconTheme = { id: 'workbench.iconTheme', group: 'Workbench', type: 'json' as const, schema: { type: ['null', 'string'] as ('null' | 'string')[], enum: [null, 'vs-seti'] }, default: 'vs-seti', description: '' };
		expect(withEnumValues(iconTheme, { values: ['example-icons'], labels: ['Example Icons'] })).toMatchObject({ schema: { enum: [null, 'vs-seti', 'example-icons'] } });
	});

	test('file icon themes resolve like VS Code (name, longest extension, language, default)', () => {
		const theme = parseIconTheme(parseJsonc(fixture('icons/icon-theme.json')), 'icons/icon-theme.json');
		expect(theme.icons).toEqual({ _file: 'icons/file.svg', _note: 'icons/note.svg', _folder: 'icons/file.svg' });
		expect(iconIdFor(theme, 'NOTES.md', 'file')).toBe('_note');
		expect(iconIdFor(theme, 'a.knote', 'file')).toBe('_note');
		expect(iconIdFor(theme, 'README.md', 'file', 'markdown')).toBe('_note');
		expect(iconIdFor(theme, 'x.txt', 'file')).toBe('_file');
		expect(iconIdFor(theme, '.knote', 'file')).toBe('_file');
		expect(iconIdFor(theme, 'a.knote', 'file', undefined, 'light')).toBe('_file');
		expect(iconIdFor(theme, 'src', 'folderOpen')).toBe('_folder');
		// A font icon has no image: Kingu's own icon stays.
		expect(iconPathFor(theme, 'a.d.knote', 'file')).toBeUndefined();
		expect(iconPathFor(theme, 'a.knote', 'file')).toBe('icons/note.svg');
	});

	test('icon paths stay inside the snap', () => {
		expect(resolveSnapPath('icons/theme.json', './a.svg')).toBe('icons/a.svg');
		expect(resolveSnapPath('icons/theme.json', '../img/a.svg')).toBe('img/a.svg');
		expect(resolveSnapPath('icons/theme.json', '../../a.svg')).toBeNull();
		expect(resolveSnapPath('theme.json', '/etc/a.svg')).toBeNull();
		expect(resolveSnapPath('theme.json', 'https://x/a.svg')).toBeNull();
	});
});

describe('views and the details page', () => {
	test('views of active user and repo snaps, keyed per window', () => {
		const [v] = viewsOf([snap()], 'panel');
		expect(v.key).toBe('user:example:board');
		expect(viewKey({ source: 'repo', id: 'example' }, { id: 'board' })).toBe('repo:example:board');
		expect(viewsOf([snap()], 'sidebar')).toEqual([]);
	});

	test('the details page lists every kind of contribution', () => {
		const groups = contributionGroups(snap());
		expect(groups.map((g) => g.kind)).toEqual(['languages', 'grammars', 'snippets', 'lsp', 'themes', 'iconThemes', 'views', 'commands', 'settings']);
		expect(groups.find((g) => g.kind === 'languages')!.items).toEqual([{ label: 'Kingu Note', detail: 'knote .knote NOTES.knote' }]);
		expect(groups.find((g) => g.kind === 'settings')!.items[0].label).toBe('snap.example.greeting');
		expect(contributionGroups(snap({ contributes: undefined, tasks: [], settings: [] }))).toEqual([]);
	});
});
