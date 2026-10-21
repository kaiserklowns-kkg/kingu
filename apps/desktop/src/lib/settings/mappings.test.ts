/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
	associatedLanguage,
	codeActionsOnFocusChange,
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
	terminalFontWeight,
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
	test('defaults are VS Code’s editor configuration, as Monaco options', () => {
		const o = editorOptionsFrom(getter());
		expect(o).toMatchObject({
			fontSize: 12,
			wordWrap: 'off',
			wordWrapColumn: 80,
			lineNumbers: 'on',
			rulers: [],
			minimap: { enabled: true, side: 'right', renderCharacters: true, size: 'proportional', autohide: 'none' },
			cursorStyle: 'line',
			cursorBlinking: 'blink',
			bracketPairColorization: { enabled: true, independentColorPoolPerBracketType: false },
			guides: { bracketPairs: false, indentation: true, bracketPairsHorizontal: 'active' },
			stickyScroll: { enabled: true, maxLineCount: 5 },
			quickSuggestions: { other: 'offWhenInlineCompletions', comments: 'off', strings: 'off' },
			acceptSuggestionOnEnter: 'on',
			autoClosingBrackets: 'languageDefined',
			formatOnPaste: false,
			hover: { enabled: 'on', delay: 300, sticky: true },
			suggest: { showWords: true, insertMode: 'insert' },
			find: { loop: true, seedSearchStringFromSelection: 'always' },
			mouseWheelZoom: false,
			wordBasedSuggestions: 'offWithInlineSuggestions'
		});
	});

	test('user values reach Monaco, invalid ones fall back', () => {
		const o = editorOptionsFrom(
			getter({
				'editor.fontSize': 15,
				'editor.fontLigatures': true,
				'editor.fontWeight': 300,
				'editor.rulers': [80, { column: 120, color: '#ff0000' }],
				'editor.lineNumbers': 'interval',
				'editor.quickSuggestions': false,
				'editor.hover.enabled': 'onKeyboardModifier',
				'editor.cursorStyle': 'triangle',
				'editor.minimap.side': 'left',
				'editor.minimap.scale': 2,
				'editor.formatOnPaste': true,
				'editor.wordBasedSuggestions': 'currentDocument',
				'editor.guides.bracketPairs': 'active',
				'editor.suggest.showWords': false,
				'editor.scrollbar.vertical': 'hidden'
			})
		);
		expect(o).toMatchObject({
			fontSize: 15,
			fontLigatures: true,
			fontWeight: 300,
			rulers: [80, { column: 120, color: '#ff0000' }],
			lineNumbers: 'interval',
			quickSuggestions: false,
			hover: { enabled: 'onKeyboardModifier' },
			cursorStyle: 'line',
			minimap: { side: 'left', scale: 2 },
			formatOnPaste: true,
			wordBasedSuggestions: 'currentDocument',
			guides: { bracketPairs: 'active' },
			suggest: { showWords: false },
			scrollbar: { vertical: 'hidden' }
		});
		expect(editorOptionsFrom(getter({ 'editor.rulers': [80, 'x'] })).rulers).toEqual([]);
		expect(editorOptionsFrom(getter({ 'editor.fontWeight': 'heavy' })).fontWeight).toBe('normal');
		expect(editorOptionsFrom(getter({ 'editor.minimap.scale': 4 })).minimap?.scale).toBe(1);
	});

	test('indent settings, workspace over user', () => {
		expect(indentFrom(getter({ 'editor.tabSize': 2 }, { 'editor.insertSpaces': false }))).toEqual({ tabSize: 2, indentSize: 'tabSize', insertSpaces: false, detect: true, trimAutoWhitespace: true });
		expect(indentFrom(getter({ 'editor.indentSize': 3 })).indentSize).toBe(3);
		expect(indentFrom(getter({ 'editor.indentSize': 'two' })).indentSize).toBe('tabSize');
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

	test('VS Code defaults reach xterm like xtermTerminal.ts', () => {
		expect(terminalOptionsFrom(getter())).toMatchObject({
			fontWeight: 'normal',
			fontWeightBold: 'bold',
			cursorInactiveStyle: 'outline',
			tabStopWidth: 8,
			wordSeparator: getter()('terminal.integrated.wordSeparators'),
			macOptionClickForcesSelection: false,
			// Alt+click is the multi-cursor modifier by default, so it moves the shell cursor.
			altClickMovesCursor: true,
			// VS Code's macOS default (selectWord).
			rightClickSelectsWord: true,
			smoothScrollDuration: 0,
			ignoreBracketedPasteMode: false
		});
		const o = terminalOptionsFrom(
			getter({
				'terminal.integrated.fontWeight': 300,
				'terminal.integrated.fontWeightBold': '800',
				'terminal.integrated.cursorStyleInactive': 'line',
				'terminal.integrated.tabStopWidth': 4,
				'terminal.integrated.wordSeparators': ' ',
				'terminal.integrated.rightClickBehavior': 'default',
				'terminal.integrated.smoothScrolling': true,
				'terminal.integrated.ignoreBracketedPasteMode': true,
				'terminal.integrated.macOptionClickForcesSelection': true,
				'editor.multiCursorModifier': 'ctrlCmd'
			})
		);
		expect(o).toMatchObject({
			fontWeight: 300,
			fontWeightBold: 800,
			cursorInactiveStyle: 'bar',
			tabStopWidth: 4,
			wordSeparator: ' ',
			rightClickSelectsWord: false,
			smoothScrollDuration: 125,
			ignoreBracketedPasteMode: true,
			macOptionClickForcesSelection: true,
			altClickMovesCursor: false
		});
	});

	test('font weights normalize like VS Code', () => {
		expect(terminalFontWeight('bold', 'normal')).toBe('bold');
		expect(terminalFontWeight(2000, 'normal')).toBe(1000);
		expect(terminalFontWeight('0', 'normal')).toBe(1);
		expect(terminalFontWeight('heavy', 'bold')).toBe('bold');
	});

	test('shell settings are user-only and per platform', () => {
		const user = { 'terminal.integrated.shell.osx': '/bin/bash', 'terminal.integrated.shellArgs.osx': ['--login'], 'terminal.integrated.env.osx': { A: '1', B: null }, 'terminal.integrated.cwd': 'apps' };
		const rest = { inheritEnv: true, detectLocale: 'auto', locale: 'th-TH', splitCwd: 'inherited' };
		expect(shellFrom(getter(user), 'osx', 'th-TH')).toEqual({ shell: '/bin/bash', paths: [], args: ['--login'], env: { A: '1', B: null }, cwd: 'apps', ...rest });
		expect(shellFrom(getter(user), 'linux', 'th-TH')).toEqual({ shell: null, paths: [], args: ['-l'], env: {}, cwd: 'apps', ...rest });
		// A repository's workspace settings cannot choose the program a terminal runs, its environment or whether it inherits Kingu's.
		expect(
			shellFrom(getter({}, { 'terminal.integrated.shell.osx': '/tmp/evil', 'terminal.integrated.env.osx': { X: '1' }, 'terminal.integrated.inheritEnv': false }), 'osx', 'th-TH')
		).toEqual({ shell: null, paths: [], args: ['-l'], env: {}, cwd: null, ...rest });
		expect(shellFrom(getter({ 'terminal.integrated.inheritEnv': false, 'terminal.integrated.detectLocale': 'off', 'terminal.integrated.splitCwd': 'initial' }), 'osx', null)).toMatchObject({
			inheritEnv: false,
			detectLocale: 'off',
			locale: null,
			splitCwd: 'initial'
		});
	});

	test('terminal profiles (defaultProfile / profiles) like VS Code', () => {
		// A workspace cannot pick the profile (user-only, like the shell).
		expect(shellFrom(getter({}, { 'terminal.integrated.defaultProfile.osx': 'evil', 'terminal.integrated.profiles.osx': { evil: { path: '/tmp/evil' } } }), 'osx')).toMatchObject({ paths: [], args: ['-l'] });
		const user = {
			'terminal.integrated.shell.osx': '/bin/bash',
			'terminal.integrated.env.osx': { A: '1', B: '2' },
			'terminal.integrated.defaultProfile.osx': 'fish',
			'terminal.integrated.profiles.osx': { mine: { path: ['/opt/x/bin/zsh', 'zsh'], args: ['-i'], env: { B: null, C: '3' } } }
		};
		// VS Code's default profiles stay available next to the user's.
		expect(shellFrom(getter(user), 'osx')).toMatchObject({ shell: '/bin/bash', paths: ['fish'], args: ['-l'], env: { A: '1', B: '2' } });
		expect(shellFrom(getter({ ...user, 'terminal.integrated.defaultProfile.osx': 'mine' }), 'osx')).toMatchObject({ paths: ['/opt/x/bin/zsh', 'zsh'], args: ['-i'], env: { A: '1', B: null, C: '3' } });
		expect(shellFrom(getter({ ...user, 'terminal.integrated.defaultProfile.osx': 'tmux' }), 'osx')).toMatchObject({ paths: ['tmux'], args: [] });
		// `null` removes a default profile; an unknown name falls back to the legacy shell settings.
		expect(shellFrom(getter({ ...user, 'terminal.integrated.defaultProfile.osx': 'bash', 'terminal.integrated.profiles.osx': { bash: null } }), 'osx')).toMatchObject({ paths: [], args: ['-l'] });
		expect(shellFrom(getter({ 'terminal.integrated.defaultProfile.linux': 'nope' }), 'linux')).toMatchObject({ paths: [], args: ['-l'] });
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
	test('modified: folders first, newest first, then by name', () => {
		const dated = [
			{ name: 'old.ts', is_dir: false, modified: 1 },
			{ name: 'new.ts', is_dir: false, modified: 9 },
			{ name: 'dir', is_dir: true, modified: 0 },
			{ name: 'b.ts', is_dir: false, modified: 5 },
			{ name: 'a.ts', is_dir: false, modified: 5 }
		];
		expect(sortEntries(dated, 'modified').map((e) => e.name)).toEqual(['dir', 'new.ts', 'a.ts', 'b.ts', 'old.ts']);
	});
});

describe('save', () => {
	test('files.eol for new files', () => {
		expect(eolFor('auto')).toBe('\n');
		expect(eolFor('\r\n')).toBe('\r\n');
		expect(eolFor('\n')).toBe('\n');
	});

	test('editor.codeActionsOnSave by save reason, like VS Code’s CodeActionOnSaveParticipant', () => {
		const map = { 'source.organizeImports': 'explicit', 'source.fixAll': 'always', 'source.addMissingImports': true, 'source.sortMembers': 'never', x: false };
		// Fix-all kinds run first.
		expect(codeActionsOnSave(map, 'explicit')).toEqual(['source.fixAll', 'source.organizeImports', 'source.addMissingImports']);
		expect(codeActionsOnSave(map, 'afterDelay')).toEqual([]);
		expect(codeActionsOnSave(map, 'focusChange')).toEqual(['source.fixAll']);
		expect(codeActionsOnSave(map, 'windowChange')).toEqual(['source.fixAll']);
		// The list form runs on explicit saves only.
		expect(codeActionsOnSave(['source.organizeImports'], 'explicit')).toEqual(['source.organizeImports']);
		expect(codeActionsOnSave(['source.organizeImports'], 'focusChange')).toEqual([]);
	});

	test('editor.codeActions.triggerOnFocusChange: always source actions, with auto save after a delay only', () => {
		const map = { 'source.organizeImports': 'always', 'source.fixAll': 'explicit', 'quickfix.x': 'always' };
		expect(codeActionsOnFocusChange(true, 'afterDelay', map)).toEqual(['source.organizeImports']);
		expect(codeActionsOnFocusChange(false, 'afterDelay', map)).toEqual([]);
		expect(codeActionsOnFocusChange(true, 'onFocusChange', map)).toEqual([]);
		expect(codeActionsOnFocusChange(true, 'afterDelay', ['source.organizeImports'])).toEqual([]);
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
		// window.autoDetectHighContrast (on by default) wins while the OS asks for more contrast.
		expect(effectiveTheme(auto, true, true)).toBe('Default High Contrast');
		expect(effectiveTheme(auto, false, true)).toBe('Default High Contrast Light');
		expect(effectiveTheme(getter({ 'window.autoDetectHighContrast': false, 'workbench.colorTheme': 'Dark+' }), true, true)).toBe('Dark+');
	});
});

describe('diff editor options (diffEditor.*)', () => {
	test('defaults follow VS Code: side by side, unchanged shown, trim whitespace ignored, wrap inherited', () => {
		expect(diffEditorOptionsFrom(getter())).toMatchObject({
			renderSideBySide: true,
			hideUnchangedRegions: { enabled: false, contextLineCount: 3, minimumLineCount: 3, revealLineCount: 20 },
			ignoreTrimWhitespace: true,
			diffWordWrap: 'inherit',
			diffAlgorithm: 'advanced',
			maxComputationTime: 5000,
			maxFileSize: 50,
			renderIndicators: true,
			useInlineViewWhenSpaceIsLimited: true,
			experimental: { showMoves: false, showEmptyDecorations: true, useTrueInlineView: false }
		});
		expect(diffWraps(getter())).toBe(false);
	});

	test('settings map to Monaco, and a view toggle wins over the setting', () => {
		const get = getter({
			'diffEditor.renderSideBySide': false,
			'diffEditor.hideUnchangedRegions.enabled': true,
			'diffEditor.ignoreTrimWhitespace': false,
			'diffEditor.wordWrap': 'on',
			'diffEditor.experimental.showMoves': true,
			'diffEditor.diffAlgorithm': 'legacy'
		});
		expect(diffEditorOptionsFrom(get)).toMatchObject({
			renderSideBySide: false,
			hideUnchangedRegions: { enabled: true },
			ignoreTrimWhitespace: false,
			diffWordWrap: 'on',
			experimental: { showMoves: true },
			diffAlgorithm: 'legacy'
		});
		expect(diffEditorOptionsFrom(get, true).renderSideBySide).toBe(true);
		expect(diffWraps(get)).toBe(true);
	});

	test('inherit follows editor.wordWrap', () => {
		expect(diffWraps(getter({ 'editor.wordWrap': 'bounded' }))).toBe(true);
		expect(diffWraps(getter({ 'editor.wordWrap': 'on', 'diffEditor.wordWrap': 'off' }))).toBe(false);
	});
});
