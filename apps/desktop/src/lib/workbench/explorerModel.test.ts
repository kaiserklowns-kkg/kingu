/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { compactChain, compactLabel, dropTarget, incrementFileName, pasteName, planTransfer, rangeSelection, topLevel } from './explorerModel';
import { nextUntitledKey, suggestedName, untitledName } from './untitled';
import { toMonacoKeybinding } from './monacoKeys';

describe('paste naming (VS Code incrementFileName, simple)', () => {
	test('copies get "copy", then a number', () => {
		expect(incrementFileName('file.ts', false)).toBe('file copy.ts');
		expect(incrementFileName('file copy.ts', false)).toBe('file copy 2.ts');
		expect(incrementFileName('file copy 9.ts', false)).toBe('file copy 10.ts');
		expect(incrementFileName('Makefile', false)).toBe('Makefile copy');
		expect(incrementFileName('.gitignore', false)).toBe('.gitignore copy');
		expect(incrementFileName('v1.2', true)).toBe('v1.2 copy');
		expect(incrementFileName('src copy', true)).toBe('src copy 2');
	});

	test('pasting next to existing names picks the first free one', () => {
		expect(pasteName('a.ts', false, new Set(['b.ts']))).toBe('a.ts');
		expect(pasteName('a.ts', false, new Set(['a.ts', 'a copy.ts']))).toBe('a copy 2.ts');
	});
});

describe('explorer selection, drag and drop', () => {
	test('nested selections collapse to their top folders', () => {
		expect(topLevel(['src', 'src/a.ts', 'lib/b.ts', 'src'])).toEqual(['src', 'lib/b.ts']);
	});

	test('a move plans every item, skips no-ops and refuses a folder into itself', () => {
		expect(planTransfer(['src/a.ts', 'lib'], 'dest', false)).toEqual({ ops: [{ from: 'src/a.ts', to: 'dest/a.ts' }, { from: 'lib', to: 'dest/lib' }], refused: [] });
		expect(planTransfer(['src/a.ts'], 'src', false)).toEqual({ ops: [], refused: [] });
		expect(planTransfer(['src'], 'src/deep', false)).toEqual({ ops: [], refused: ['src'] });
		expect(planTransfer(['a.ts'], '', false)).toEqual({ ops: [], refused: [] });
		// A copy into the same folder duplicates (Rust names it `a copy.ts`).
		expect(planTransfer(['src/a.ts'], 'src', true)).toEqual({ ops: [{ from: 'src/a.ts', to: 'src/a.ts' }], refused: [] });
	});

	test('drop targets: a folder row, a file’s folder, the root', () => {
		expect(dropTarget('src', true)).toBe('src');
		expect(dropTarget('src/a.ts', false)).toBe('src');
		expect(dropTarget('a.ts', false)).toBe('');
		expect(dropTarget(null, true)).toBe('');
	});

	test('⇧-click selects the range in display order', () => {
		const rows = ['a', 'b', 'c', 'd'];
		expect(rangeSelection(rows, 'b', 'd')).toEqual(['b', 'c', 'd']);
		expect(rangeSelection(rows, 'd', 'b')).toEqual(['b', 'c', 'd']);
		expect(rangeSelection(rows, null, 'c')).toEqual(['c']);
		expect(rangeSelection(rows, 'a', 'zz')).toEqual([]);
	});

	test('compact folders follow single-folder chains that are loaded', () => {
		const tree: Record<string, { rel: string; is_dir: boolean }[]> = {
			src: [{ rel: 'src/lib', is_dir: true }],
			'src/lib': [{ rel: 'src/lib/utils', is_dir: true }],
			'src/lib/utils': [{ rel: 'src/lib/utils/a.ts', is_dir: false }, { rel: 'src/lib/utils/b.ts', is_dir: false }],
			docs: [{ rel: 'docs/x.md', is_dir: false }]
		};
		const childrenOf = (rel: string) => tree[rel] ?? null;
		expect(compactChain('src', childrenOf)).toEqual(['src', 'src/lib', 'src/lib/utils']);
		expect(compactLabel(compactChain('src', childrenOf))).toBe('src/lib/utils');
		expect(compactChain('docs', childrenOf)).toEqual(['docs']);
		expect(compactChain('unloaded', childrenOf)).toEqual(['unloaded']);
	});
});

describe('untitled editors', () => {
	test('lowest free Untitled-N and Save As name', () => {
		expect(nextUntitledKey([])).toBe('untitled:Untitled-1');
		expect(nextUntitledKey(['untitled:Untitled-1', 'untitled:Untitled-3', 'a.ts'])).toBe('untitled:Untitled-2');
		expect(untitledName('untitled:Untitled-2')).toBe('Untitled-2');
		expect(suggestedName('untitled:Untitled-1', '')).toBe('Untitled-1.txt');
		expect(suggestedName('untitled:Untitled-1', '  # Notes: a/b?\nmore')).toBe('# Notes ab');
		expect(suggestedName('src/a.ts', '')).toBe('a.ts');
	});
});

describe('keybindings.json keys as Monaco keybindings', () => {
	const KeyMod = { CtrlCmd: 1 << 11, Shift: 1 << 10, Alt: 1 << 9, WinCtrl: 1 << 8, chord: (a: number, b: number) => (a | (b << 16)) >>> 0 };
	const KeyCode = { KeyK: 41, KeyC: 33, Slash: 90, Digit1: 22, F12: 70, LeftArrow: 15 } as Record<string, number>;
	const e = { KeyMod, KeyCode };
	test('modifiers map per platform', () => {
		expect(toMonacoKeybinding('cmd+/', e, true)).toBe(KeyMod.CtrlCmd | 90);
		expect(toMonacoKeybinding('ctrl+/', e, true)).toBe(KeyMod.WinCtrl | 90);
		expect(toMonacoKeybinding('ctrl+/', e, false)).toBe(KeyMod.CtrlCmd | 90);
		expect(toMonacoKeybinding('shift+alt+f12', e, false)).toBe(KeyMod.Shift | KeyMod.Alt | 70);
		expect(toMonacoKeybinding('cmd+k cmd+c', e, true)).toBe(KeyMod.chord(KeyMod.CtrlCmd | 41, KeyMod.CtrlCmd | 33));
		expect(toMonacoKeybinding('cmd+nosuchkey', e, true)).toBeNull();
	});
});
