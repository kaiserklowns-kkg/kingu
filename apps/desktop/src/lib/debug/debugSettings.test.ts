import { describe, expect, test } from 'bun:test';
import {
	breakpointRows,
	canSetBreakpoint,
	collapseLines,
	consoleFont,
	editorsToSave,
	historyMatches,
	inlineValues,
	localsScope,
	opensOnBreak,
	statusItemShown,
	toolbarShown,
	variableLabel,
	autoExpandsLazy,
	launcherWhileDebugging,
	lazyValue,
	rootSession,
	toolbarSessions,
	toolbarTarget
} from './debugSettings.ts';
import { breakpointKey, glyphs, parseStored, setLogMessage, setTriggeredBy, sourceBreakpoints } from './breakpoints.ts';
import { appendOutput, initialModel, outputLimit, OUTPUT_LIMIT } from './model.ts';
import { opensOnStart } from '#lib/settings/mappings.ts';

describe('debug settings', () => {
	test('debug.toolBarLocation picks one placement; commandCenter floats without the command center', () => {
		expect(toolbarShown('floating', 'floating', true)).toBe(true);
		expect(toolbarShown('docked', 'floating', true)).toBe(false);
		expect(toolbarShown('docked', 'docked', true)).toBe(true);
		expect(toolbarShown('commandCenter', 'commandCenter', true)).toBe(true);
		expect(toolbarShown('floating', 'commandCenter', true)).toBe(false);
		expect(toolbarShown('floating', 'commandCenter', false)).toBe(true);
		expect(toolbarShown('commandCenter', 'commandCenter', false)).toBe(false);
		for (const p of ['floating', 'docked', 'commandCenter'] as const) expect(toolbarShown(p, 'hidden', true)).toBe(false);
	});

	test('debug.openDebug: openOnDebugBreak opens on a break, not at the start', () => {
		expect(opensOnBreak('openOnDebugBreak')).toBe(true);
		expect(opensOnBreak('openOnSessionStart')).toBe(false);
		expect(opensOnStart('openOnDebugBreak', true)).toBe(false);
	});

	test('debug.showInStatusBar', () => {
		expect(statusItemShown('always', 0)).toBe(true);
		expect(statusItemShown('never', 3)).toBe(false);
		expect(statusItemShown('onFirstSessionStart', 0)).toBe(false);
		expect(statusItemShown('onFirstSessionStart', 1)).toBe(true);
	});

	test('debug.saveBeforeStart saves the active group’s dirty editors (not untitled with nonUntitled…)', () => {
		const tabs = ['a.rs', 'untitled:Untitled-1', 'b.rs'];
		const dirty = (p: string) => p !== 'b.rs';
		const untitled = (p: string) => p.startsWith('untitled:');
		expect(editorsToSave('allEditorsInActiveGroup', tabs, dirty, untitled)).toEqual(['a.rs', 'untitled:Untitled-1']);
		expect(editorsToSave('nonUntitledEditorsInActiveGroup', tabs, dirty, untitled)).toEqual(['a.rs']);
		expect(editorsToSave('none', tabs, dirty, untitled)).toEqual([]);
	});

	test('debug.allowBreakpointsEverywhere', () => {
		expect(canSetBreakpoint('rust', false)).toBe(true);
		// js-debug's languages, whether or not it is installed yet (VS Code ships it built in).
		for (const language of ['javascript', 'typescript', 'typescriptreact']) expect(canSetBreakpoint(language, false)).toBe(true);
		expect(canSetBreakpoint('markdown', false)).toBe(false);
		expect(canSetBreakpoint('markdown', true)).toBe(true);
	});

	test('debug.console.collapseIdenticalLines collapses consecutive identical whole lines of one kind', () => {
		const out = [
			{ category: 'stdout', text: 'tick\n' },
			{ category: 'stdout', text: 'tick\n' },
			{ category: 'stderr', text: 'tick\n' },
			{ category: 'stdout', text: 'part' },
			{ category: 'stdout', text: 'part' }
		];
		expect(collapseLines(out, true).map((l) => [l.category, l.text, l.count])).toEqual([
			['stdout', 'tick\n', 2],
			['stderr', 'tick\n', 1],
			['stdout', 'part', 1],
			['stdout', 'part', 1]
		]);
		expect(collapseLines(out, false)).toHaveLength(5);
	});

	test('debug.console.maximumLines caps the console', () => {
		expect(OUTPUT_LIMIT).toBe(10000);
		outputLimit.max = 3;
		let m = initialModel();
		for (let i = 0; i < 10; i++) m = appendOutput(m, 'stdout', `${i}\n`);
		expect(m.output.map((l) => l.text)).toEqual(['7\n', '8\n', '9\n']);
		outputLimit.max = OUTPUT_LIMIT;
	});

	test('debug.console font, line height and history suggestions', () => {
		expect(consoleFont('default', 12, 0)).toEqual({ family: null, size: '12px', lineHeight: 'normal' });
		expect(consoleFont('Fira Code', 14, 20)).toEqual({ family: 'Fira Code', size: '14px', lineHeight: '20px' });
		expect(historyMatches(['foo.bar', 'x', 'foo'], 'fo', true)).toEqual(['foo.bar', 'foo']);
		expect(historyMatches(['foo'], 'foo', true)).toEqual([]);
		expect(historyMatches(['foo'], 'f', false)).toEqual([]);
	});

	test('debug.showVariableTypes', () => {
		expect(variableLabel({ name: 'n', type: 'i32' }, true)).toBe('n: i32');
		expect(variableLabel({ name: 'n', type: 'i32' }, false)).toBe('n');
		expect(variableLabel({ name: 'n' }, true)).toBe('n');
	});

	test('debug.breakpointsView.presentation', () => {
		const files = [['a.rs', [1, 2]] as const, ['b.rs', [3]] as const];
		expect(breakpointRows(files, 'list').map((r) => r.kind)).toEqual(['breakpoint', 'breakpoint', 'breakpoint']);
		expect(breakpointRows(files, 'tree').map((r) => (r.kind === 'file' ? `${r.rel}(${r.count})` : r.depth))).toEqual(['a.rs(2)', 1, 1, 'b.rs(1)', 1]);
	});

	test('debug.inlineValues: on shows each local once, nearest the stop', () => {
		const lines = ['let x = 1;', 'let y = x + 2;', 'print(y, z)'];
		const vars = [
			{ name: 'x', value: '1' },
			{ name: 'y', value: '3' },
			{ name: 'self.inner', value: 'skip' }
		];
		expect(inlineValues(lines, 10, vars)).toEqual([
			{ line: 11, text: 'x = 1' },
			{ line: 12, text: 'y = 3' }
		]);
		expect(inlineValues(['s'], 1, [{ name: 's', value: 'x'.repeat(60) }], 5)).toEqual([{ line: 1, text: 's = xxxxx…' }]);
		expect(localsScope([{ name: 'Registers', variablesReference: 1, expensive: true }, { name: 'Locals', variablesReference: 2, expensive: false }])?.name).toBe('Locals');
	});

	test('debug.gutterMiddleClickAction: logpoints and triggered breakpoints', () => {
		let m = setLogMessage({}, 'a.py', 4, 'x={x}');
		expect(sourceBreakpoints(m['a.py'])).toEqual([{ line: 4, logMessage: 'x={x}' }]);
		expect(glyphs(m['a.py'], undefined)[0].kind).toBe('log');
		m = setTriggeredBy(m, 'a.py', 9, breakpointKey('a.py', 4));
		// Not sent (and drawn as waiting) until a.py:4 is hit; then sent, and verification lines up.
		expect(sourceBreakpoints(m['a.py'])).toEqual([{ line: 4, logMessage: 'x={x}' }]);
		expect(glyphs(m['a.py'], [{ verified: true }])[1].kind).toBe('triggered');
		const hit = new Set(['a.py:4']);
		expect(sourceBreakpoints(m['a.py'], hit)).toEqual([{ line: 4, logMessage: 'x={x}' }, { line: 9 }]);
		expect(glyphs(m['a.py'], [{ verified: true }, { verified: true }], hit).map((g) => g.kind)).toEqual(['log', 'verified']);
		expect(parseStored(JSON.stringify(m))).toEqual(m);
		expect(setLogMessage(m, 'a.py', 4, ' ')['a.py'][0].logMessage).toBeUndefined();
	});
});

describe('debug settings without a view of their own', () => {
	// A js-debug launch (1) with its child (2) and grandchild (3), and a second top-level session (4).
	const sessions = [
		{ key: 1, parentKey: null, name: 'Launch' },
		{ key: 2, parentKey: 1, name: 'child' },
		{ key: 3, parentKey: 2, name: 'worker' },
		{ key: 4, parentKey: null, name: 'Server' }
	];
	test('debug.showSubSessionsInToolBar: the picker and the Stop/Restart target', () => {
		expect(toolbarSessions(sessions, false).map((s) => s.key)).toEqual([1, 4]);
		expect(toolbarSessions(sessions, true).map((s) => s.key)).toEqual([1, 2, 3, 4]);
		expect(rootSession(sessions, 3)).toBe(1);
		expect(toolbarTarget(sessions, 3, false)).toBe(1);
		expect(toolbarTarget(sessions, 3, true)).toBe(3);
		expect(toolbarTarget(sessions, null, true)).toBeNull();
	});
	test('debug.autoExpandLazyVariables', () => {
		expect(autoExpandsLazy('on', false)).toBe(true);
		expect(autoExpandsLazy('auto', false)).toBe(false);
		expect(autoExpandsLazy('auto', true)).toBe(true);
		expect(autoExpandsLazy('off', true)).toBe(false);
		const getter = { name: 'size', value: '(...)', variablesReference: 9, presentationHint: { lazy: true } };
		expect(lazyValue({ name: 'n', value: '1', variablesReference: 0 }, undefined)).toBeUndefined();
		expect(lazyValue(getter, undefined)).toBeNull();
		expect(lazyValue(getter, [{ name: 'size', value: '3', variablesReference: 0 }])?.value).toBe('3');
	});
	test('debug.hideLauncherWhileDebugging', () => {
		expect(launcherWhileDebugging(false, 'floating')).toBe(true);
		expect(launcherWhileDebugging(true, 'floating')).toBe(false);
		expect(launcherWhileDebugging(false, 'docked')).toBe(false);
	});
});
