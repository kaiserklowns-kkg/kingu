/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
	associatedLanguage,
	codeActionsOnSave,
	diffEditorOptionsFrom,
	diffWraps,
	editorOptionsFrom,
	effectiveTheme,
	enabledGlobs,
	eolFor,
	formatsOnSave,
	globToRegExp,
	indentFrom,
	isExcluded,
	opensOnStart,
	searchSettingsFrom,
	shellFrom,
	sortEntries,
	terminalOptionsFrom,
	type Get
} from './mappings';
import { resolveSettings } from './registry';

/** `settings.get` over the defaults plus `user` (validated and layered like the service). */
const getter = (user: Record<string, unknown> = {}, workspace: Record<string, unknown> = {}): Get => {
	const m = resolveSettings(user, workspace);
	return (<T>(id: string) => {
		if (!m.has(id)) throw new Error(`unknown setting ${id}`);
		return m.get(id)!.value as T;
	}) as Get;
};

describe('editor options', () => {
	test('defaults map to VS Code-like Monaco options', () => {
		const o = editorOptionsFrom(getter());
		expect(o).toMatchObject({
			fontSize: 12,
			wordWrap: 'off',
			wordWrapColumn: 80,
			lineNumbers: 'on',
			rulers: [],
			minimap: { enabled: true, side: 'right', renderCharacters: true },
			cursorStyle: 'line',
			cursorBlinking: 'blink',
			bracketPairColorization: { enabled: true },
			guides: { bracketPairs: false, indentation: true },
			stickyScroll: { enabled: true },
			quickSuggestions: { other: 'on', comments: 'off', strings: 'off' },
			acceptSuggestionOnEnter: 'on',
			autoClosingBrackets: 'languageDefined',
			formatOnPaste: false,
			hover: { enabled: 'on' },
			mouseWheelZoom: false
		});
	});

	test('user values reach Monaco, invalid ones fall back', () => {
		const o = editorOptionsFrom(
			getter({
				'editor.fontSize': 15,
				'editor.fontLigatures': true,
				'editor.rulers': [80, 120],
				'editor.lineNumbers': 'relative',
				'editor.quickSuggestions': false,
				'editor.hover.enabled': false,
				'editor.cursorStyle': 'triangle',
				'editor.minimap.side': 'left',
				'editor.formatOnPaste': true,
				'editor.wordBasedSuggestions': 'currentDocument'
			})
		);
		expect(o).toMatchObject({
			fontSize: 15,
			fontLigatures: true,
			rulers: [80, 120],
			lineNumbers: 'relative',
			quickSuggestions: false,
			hover: { enabled: 'off' },
			cursorStyle: 'line',
			minimap: { side: 'left' },
			formatOnPaste: true,
			wordBasedSuggestions: 'currentDocument'
		});
		expect(editorOptionsFrom(getter({ 'editor.rulers': [80, 'x'] })).rulers).toEqual([]);
	});

	test('interval line numbers show every tenth line', () => {
		const fn = editorOptionsFrom(getter({ 'editor.lineNumbers': 'interval' })).lineNumbers as (n: number) => string;
		expect([1, 2, 10, 15, 20].map(fn)).toEqual(['1', '', '10', '', '20']);
	});

	test('indent settings, workspace over user', () => {
		expect(indentFrom(getter({ 'editor.tabSize': 2 }, { 'editor.insertSpaces': false }))).toEqual({ tabSize: 2, insertSpaces: false, detect: true });
	});
});

describe('terminal', () => {
	test('xterm options', () => {
		expect(terminalOptionsFrom(getter())).toMatchObject({
			fontSize: 12,
			fontFamily: getter()('editor.fontFamily'),
			lineHeight: 1,
			cursorStyle: 'block',
			cursorBlink: false,
			scrollback: 1000,
			macOptionIsMeta: false,
			minimumContrastRatio: 4.5
		});
		const o = terminalOptionsFrom(getter({ 'terminal.integrated.fontFamily': 'JetBrains Mono', 'terminal.integrated.cursorStyle': 'line', 'terminal.integrated.scrollback': 5000 }));
		expect(o).toMatchObject({ fontFamily: 'JetBrains Mono', cursorStyle: 'bar', scrollback: 5000 });
	});

	test('shell settings are user-only and per platform', () => {
		const user = { 'terminal.integrated.shell.osx': '/bin/bash', 'terminal.integrated.shellArgs.osx': ['--login'], 'terminal.integrated.env.osx': { A: '1' }, 'terminal.integrated.cwd': 'apps' };
		expect(shellFrom(getter(user), 'osx')).toEqual({ shell: '/bin/bash', args: ['--login'], env: { A: '1' }, cwd: 'apps' });
		expect(shellFrom(getter(user), 'linux')).toEqual({ shell: null, args: ['-l'], env: {}, cwd: 'apps' });
		// A repository's workspace settings cannot choose the program a terminal runs.
		expect(shellFrom(getter({}, { 'terminal.integrated.shell.osx': '/tmp/evil', 'terminal.integrated.env.osx': { X: '1' } }), 'osx')).toEqual({ shell: null, args: ['-l'], env: {}, cwd: null });
	});
});

describe('globs and excludes', () => {
	test('VS Code glob syntax', () => {
		expect(globToRegExp('**/node_modules').test('a/b/node_modules')).toBe(true);
		expect(globToRegExp('**/node_modules').test('node_modules')).toBe(true);
		expect(globToRegExp('*.log').test('a.log')).toBe(true);
		expect(globToRegExp('*.log').test('logs/a.log')).toBe(false);
		expect(globToRegExp('**/*.{js,ts}').test('src/x.ts')).toBe(true);
		expect(globToRegExp('**/*.{js,ts}').test('src/x.rs')).toBe(false);
		expect(globToRegExp('build[0-9]').test('build7')).toBe(true);
		expect(globToRegExp('a.b').test('axb')).toBe(false);
	});

	test('a folder match hides what is inside', () => {
		const globs = enabledGlobs({ '**/.git': true, '**/dist': true, '**/keep': false });
		expect(globs).toEqual(['**/.git', '**/dist']);
		expect(isExcluded('pkg/dist/x.js', globs)).toBe(true);
		expect(isExcluded('.git', globs)).toBe(true);
		expect(isExcluded('keep/a', globs)).toBe(false);
		expect(isExcluded('src/dist.ts', globs)).toBe(false);
	});

	test('files.exclude merges key by key across layers; false re-includes a default', () => {
		const get = getter({ 'files.exclude': { '**/.DS_Store': false, '**/tmp': true } });
		const globs = enabledGlobs(get('files.exclude'));
		expect(globs).toContain('**/.git');
		expect(globs).toContain('**/tmp');
		expect(globs).not.toContain('**/.DS_Store');
	});

	test('search settings become ripgrep options', () => {
		const s = searchSettingsFrom(getter({ 'search.exclude': { '**/fixtures': true }, 'search.smartCase': true, 'search.maxResults': 50 }), true);
		expect(s.exclude_globs).toContain('**/.git');
		expect(s.exclude_globs).toContain('**/node_modules');
		expect(s.exclude_globs).toContain('**/fixtures');
		expect(s).toMatchObject({ follow_symlinks: true, smart_case: true, max_results: 50, use_global_ignore: false, use_parent_ignore: false });
		// "Use Exclude Settings and Ignore Files" off: no exclude globs at all.
		expect(searchSettingsFrom(getter(), false).exclude_globs).toEqual([]);
	});

	test('files.associations', () => {
		const assoc = { '*.tmpl': 'html', 'config/*.conf': 'ini', '*.md': 'plaintext' };
		expect(associatedLanguage('views/a.tmpl', assoc)).toBe('html');
		expect(associatedLanguage('config/app.conf', assoc)).toBe('ini');
		expect(associatedLanguage('other/app.conf', assoc)).toBeUndefined();
		expect(associatedLanguage('README.md', assoc)).toBe('plaintext');
	});
});

describe('explorer sort order', () => {
	const entries = [
		{ name: 'b.ts', is_dir: false },
		{ name: 'src', is_dir: true },
		{ name: 'A.md', is_dir: false },
		{ name: 'lib', is_dir: true },
		{ name: 'c.md', is_dir: false },
		{ name: 'file10.ts', is_dir: false },
		{ name: 'file2.ts', is_dir: false }
	];
	const names = (order: Parameters<typeof sortEntries>[1]) => sortEntries(entries, order).map((e) => e.name);
	test('default, mixed, filesFirst, type', () => {
		expect(names('default')).toEqual(['lib', 'src', 'A.md', 'b.ts', 'c.md', 'file2.ts', 'file10.ts']);
		expect(names('mixed')).toEqual(['A.md', 'b.ts', 'c.md', 'file2.ts', 'file10.ts', 'lib', 'src']);
		expect(names('filesFirst')).toEqual(['A.md', 'b.ts', 'c.md', 'file2.ts', 'file10.ts', 'lib', 'src']);
		expect(names('type')).toEqual(['lib', 'src', 'A.md', 'c.md', 'b.ts', 'file2.ts', 'file10.ts']);
	});
});

describe('save', () => {
	test('files.eol for new files', () => {
		expect(eolFor('auto')).toBe('\n');
		expect(eolFor('\r\n')).toBe('\r\n');
		expect(eolFor('\n')).toBe('\n');
	});

	test('editor.codeActionsOnSave by save reason', () => {
		const map = { 'source.organizeImports': 'explicit', 'source.fixAll': 'always', 'source.addMissingImports': true, 'source.sortMembers': 'never', x: false };
		expect(codeActionsOnSave(map, 'explicit')).toEqual(['source.organizeImports', 'source.fixAll', 'source.addMissingImports']);
		expect(codeActionsOnSave(map, 'afterDelay')).toEqual(['source.fixAll']);
		expect(codeActionsOnSave(map, 'focusChange')).toEqual(['source.fixAll']);
	});

	test('editor.formatOnSave skips auto save after a delay', () => {
		expect(formatsOnSave(true, 'explicit')).toBe(true);
		expect(formatsOnSave(true, 'windowChange')).toBe(true);
		expect(formatsOnSave(true, 'afterDelay')).toBe(false);
		expect(formatsOnSave(false, 'explicit')).toBe(false);
	});
});

describe('workbench', () => {
	test('debug view and console open on session start per setting', () => {
		expect(opensOnStart('openOnFirstSessionStart', true)).toBe(true);
		expect(opensOnStart('openOnFirstSessionStart', false)).toBe(false);
		expect(opensOnStart('openOnSessionStart', false)).toBe(true);
		expect(opensOnStart('neverOpen', true)).toBe(false);
	});

	test('window.autoDetectColorScheme picks the preferred theme for the OS scheme', () => {
		expect(effectiveTheme(getter({ 'workbench.colorTheme': 'Dark+' }), false)).toBe('Dark+');
		const auto = getter({ 'window.autoDetectColorScheme': true, 'workbench.preferredLightColorTheme': 'Light+' });
		expect(effectiveTheme(auto, false)).toBe('Light+');
		expect(effectiveTheme(auto, true)).toBe('Dark Modern');
	});
});

describe('diff editor options (diffEditor.*)', () => {
	test('defaults follow VS Code: side by side, unchanged shown, trim whitespace ignored, wrap inherited', () => {
		expect(diffEditorOptionsFrom(getter())).toEqual({ renderSideBySide: true, hideUnchangedRegions: { enabled: false }, ignoreTrimWhitespace: true, diffWordWrap: 'inherit' });
		expect(diffWraps(getter())).toBe(false);
	});

	test('settings map to Monaco, and a view toggle wins over the setting', () => {
		const get = getter({ 'diffEditor.renderSideBySide': false, 'diffEditor.hideUnchangedRegions.enabled': true, 'diffEditor.ignoreTrimWhitespace': false, 'diffEditor.wordWrap': 'on' });
		expect(diffEditorOptionsFrom(get)).toEqual({ renderSideBySide: false, hideUnchangedRegions: { enabled: true }, ignoreTrimWhitespace: false, diffWordWrap: 'on' });
		expect(diffEditorOptionsFrom(get, true).renderSideBySide).toBe(true);
		expect(diffWraps(get)).toBe(true);
	});

	test('inherit follows editor.wordWrap', () => {
		expect(diffWraps(getter({ 'editor.wordWrap': 'bounded' }))).toBe(true);
		expect(diffWraps(getter({ 'editor.wordWrap': 'on', 'diffEditor.wordWrap': 'off' }))).toBe(false);
	});
});
