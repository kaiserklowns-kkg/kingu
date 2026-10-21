import { describe, expect, test } from 'bun:test';
import { customSemanticColors, customTokenColors, themeSpecific, withTokenCustomizations } from './tokenCustomizations.ts';
import type { FlatTheme } from '../editor/textmate/theme.ts';

const names = ['Dark Modern', 'Dark Modern'];

describe('editor.tokenColorCustomizations', () => {
	test('groups become their scopes, then textMateRules, then the theme’s own block', () => {
		const { rules } = customTokenColors(
			{
				comments: '#00ff00',
				numbers: { foreground: '#ff0000', fontStyle: 'bold' },
				textMateRules: [{ scope: 'string.interpolated', settings: { foreground: '#123456' } }, { scope: 'bad' }, 'x'],
				'[Dark Modern]': { keywords: '#0000ff', textMateRules: [{ scope: ['a', 'b'], settings: { fontStyle: 'italic' } }] },
				'[Light+]': { strings: '#ffffff' }
			},
			names
		);
		expect(rules).toEqual([
			{ scope: 'comment', settings: { foreground: '#00ff00' } },
			{ scope: 'punctuation.definition.comment', settings: { foreground: '#00ff00' } },
			{ scope: 'constant.numeric', settings: { foreground: '#ff0000', fontStyle: 'bold' } },
			{ scope: 'string.interpolated', settings: { foreground: '#123456' } },
			{ scope: 'keyword - keyword.operator', settings: { foreground: '#0000ff' } },
			{ scope: 'keyword.control', settings: { foreground: '#0000ff' } },
			{ scope: 'storage', settings: { foreground: '#0000ff' } },
			{ scope: 'storage.type', settings: { foreground: '#0000ff' } },
			{ scope: ['a', 'b'], settings: { fontStyle: 'italic' } }
		]);
	});

	test('theme blocks: wildcards, several names, lists concatenated', () => {
		const custom = {
			'[Dark*]': { textMateRules: [{ scope: 'a', settings: {} }], comments: '#111111' },
			'[*Modern]': { textMateRules: [{ scope: 'b', settings: {} }] },
			'[Light+][Dark Modern]': { comments: '#222222' },
			'[*ark Mo*]': { numbers: '#333333' },
			'[Kingu*]': { strings: '#444444' }
		};
		expect(themeSpecific(custom, names)).toEqual({ textMateRules: [{ scope: 'a', settings: {} }, { scope: 'b', settings: {} }], comments: '#222222', numbers: '#333333' });
		expect(themeSpecific(custom, ['Light 2026', '2026 Light'])).toBeNull();
		expect(themeSpecific('nope', names)).toBeNull();
	});

	test('semanticHighlighting (deprecated here) is read', () => {
		expect(customTokenColors({ semanticHighlighting: false }, names).semanticHighlighting).toBe(false);
		expect(customTokenColors({ '[Dark Modern]': { semanticHighlighting: true } }, names).semanticHighlighting).toBe(true);
		expect(customTokenColors(null, names)).toEqual({ rules: [], semanticHighlighting: undefined });
	});
});

describe('editor.semanticTokenColorCustomizations', () => {
	test('rules and enabled, the theme’s block winning', () => {
		const out = customSemanticColors(
			{ enabled: false, rules: { variable: '#ff0000', 'function.declaration': { bold: true }, '[x]': '#000' }, '[Dark Modern]': { enabled: true, rules: { variable: '#00ff00' } } },
			names
		);
		expect(out).toEqual({ enabled: true, rules: { variable: '#00ff00', 'function.declaration': { bold: true } } });
		expect(customSemanticColors(undefined, names)).toEqual({ enabled: undefined, rules: {} });
	});
});

describe('the customized theme', () => {
	const flat: FlatTheme = {
		name: 'Dark Modern',
		colors: { 'editor.foreground': '#cccccc' },
		tokenColors: [{ scope: 'comment', settings: { foreground: '#6a9955' } }],
		semanticHighlighting: true,
		semanticTokenColors: { 'variable.readonly': '#4fc1ff', parameter: '#9cdcfe' }
	};

	test('nothing to customize: the same theme', () => {
		expect(withTokenCustomizations(flat, {}, {}, names)).toBe(flat);
	});

	test('rules after the theme’s, semantic rules merged, enabled overriding the theme', () => {
		const out = withTokenCustomizations(flat, { comments: '#ff0000' }, { enabled: false, rules: { parameter: '#ffffff', 'class:typescript': '#aaaaaa' } }, names);
		expect(out.tokenColors.at(0)).toEqual({ scope: 'comment', settings: { foreground: '#6a9955' } });
		expect(out.tokenColors.at(1)).toEqual({ scope: 'comment', settings: { foreground: '#ff0000' } });
		expect(out.semanticTokenColors).toEqual({ 'variable.readonly': '#4fc1ff', parameter: '#ffffff', 'class:typescript': '#aaaaaa' });
		expect(out.semanticHighlighting).toBe(false);
		// The theme itself is left alone (it is cached).
		expect(flat.tokenColors).toHaveLength(1);
	});

	test('editor.semanticTokenColorCustomizations.enabled wins over the older semanticHighlighting', () => {
		expect(withTokenCustomizations(flat, { semanticHighlighting: false }, { enabled: true }, names).semanticHighlighting).toBe(true);
		expect(withTokenCustomizations(flat, { semanticHighlighting: false }, {}, names).semanticHighlighting).toBe(false);
	});
});
