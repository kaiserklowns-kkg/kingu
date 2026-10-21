// Pure helpers that turn VS Code color-theme files into what vscode-textmate and
// Monaco need. No Monaco or DOM imports here so `bun test` can exercise them.
// Mirrors _loadColorTheme / ColorThemeData.tokenColors in
// microsoft/vscode src/vs/workbench/services/themes/common/colorThemeData.ts.

import { parseJsonc } from '../../settings/jsonc';

export interface TokenColorRule {
	name?: string;
	scope?: string | string[];
	settings: { foreground?: string; background?: string; fontStyle?: string };
}

export interface VsCodeThemeFile {
	name?: string;
	include?: string;
	colors?: Record<string, string>;
	tokenColors?: TokenColorRule[];
	semanticHighlighting?: boolean;
	semanticTokenColors?: Record<string, SemanticColorValue>;
}

/** A `semanticTokenColors` value: a color, or a style object (colorThemeData.ts readSemanticTokenRule). */
export type SemanticColorValue = string | boolean | { foreground?: string; bold?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean; fontStyle?: string };

export interface FlatTheme {
	name: string;
	colors: Record<string, string>;
	tokenColors: TokenColorRule[];
	/** Whether the theme (or one it includes) turns semantic highlighting on. */
	semanticHighlighting?: boolean;
	/** `semanticTokenColors` of the include chain, the including theme's rules winning. */
	semanticTokenColors?: Record<string, SemanticColorValue>;
}

export { parseJsonc };

/** Resolves a theme's `include` chain: included colors are overridden, included tokenColors come first. */
export function flattenTheme(entry: string, read: (path: string) => string): FlatTheme {
	const seen = new Set<string>();
	const result: FlatTheme = { name: '', colors: {}, tokenColors: [] };
	const load = (path: string) => {
		if (seen.has(path)) throw new Error(`theme include cycle at ${path}`);
		seen.add(path);
		const theme = parseJsonc<VsCodeThemeFile>(read(path));
		if (theme.include) load(joinPath(path, theme.include));
		for (const [id, value] of Object.entries(theme.colors ?? {})) {
			if (value === 'default') delete result.colors[id];
			else result.colors[id] = value;
		}
		if (Array.isArray(theme.tokenColors)) result.tokenColors.push(...theme.tokenColors);
		if (theme.semanticHighlighting) result.semanticHighlighting = true;
		if (theme.semanticTokenColors && typeof theme.semanticTokenColors === 'object') result.semanticTokenColors = { ...result.semanticTokenColors, ...theme.semanticTokenColors };
		if (theme.name) result.name = theme.name;
	};
	load(entry);
	return result;
}

export function joinPath(from: string, relative: string): string {
	const parts = from.split('/').slice(0, -1);
	for (const seg of relative.split('/')) {
		if (seg === '..') parts.pop();
		else if (seg !== '.' && seg !== '') parts.push(seg);
	}
	return parts.join('/');
}

/** Normalizes #rgb/#rgba/#rrggbb/#rrggbbaa to upper-case long form, like VS Code's normalizeColor. */
export function normalizeColor(color: string | undefined): string | undefined {
	if (!color || !/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color)) return undefined;
	const hex = color.slice(1).toUpperCase();
	return '#' + (hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex);
}

/** VS Code's theme kinds (ColorScheme): `vs-dark`, `vs`, `hc-black`, `hc-light` themes. */
export type ThemeType = 'dark' | 'light' | 'hcDark' | 'hcLight';

const tokens = (info: string, warn: string, error: string, debug: string): TokenColorRule[] => [
	{ scope: 'token.info-token', settings: { foreground: info } },
	{ scope: 'token.warn-token', settings: { foreground: warn } },
	{ scope: 'token.error-token', settings: { foreground: error } },
	{ scope: 'token.debug-token', settings: { foreground: debug } }
];

// colorThemeData.ts defaultThemeColors and the editor.foreground/background registry defaults.
const defaultTokens: Record<ThemeType, TokenColorRule[]> = {
	dark: tokens('#6796e6', '#cd9731', '#f44747', '#b267e6'),
	light: tokens('#316bcd', '#cd9731', '#cd3131', '#800080'),
	hcDark: tokens('#6796e6', '#008000', '#FF0000', '#b267e6'),
	hcLight: tokens('#316bcd', '#cd9731', '#cd3131', '#800080')
};
const defaultEditor: Record<ThemeType, [fg: string, bg: string]> = {
	dark: ['#BBBBBB', '#1E1E1E'],
	light: ['#333333', '#FFFFFF'],
	hcDark: ['#FFFFFF', '#000000'],
	hcLight: ['#292929', '#FFFFFF']
};

/**
 * The TextMate theme rules VS Code feeds its tokenizer: a scope-less default rule
 * from editor.foreground/background first, then the theme's scoped rules.
 */
export function textMateRules(theme: FlatTheme, type: ThemeType = 'dark'): TokenColorRule[] {
	const rules: TokenColorRule[] = [
		{
			settings: {
				foreground: normalizeColor(theme.colors['editor.foreground']) ?? defaultEditor[type][0],
				background: normalizeColor(theme.colors['editor.background']) ?? defaultEditor[type][1]
			}
		}
	];
	let hasDefaultTokens = false;
	const add = (rule: TokenColorRule) => {
		if (!rule.scope || !rule.settings) return;
		if (rule.scope === 'token.info-token') hasDefaultTokens = true;
		rules.push({
			scope: rule.scope,
			settings: {
				foreground: normalizeColor(rule.settings.foreground),
				background: normalizeColor(rule.settings.background),
				fontStyle: rule.settings.fontStyle
			}
		});
	};
	theme.tokenColors.forEach(add);
	if (!hasDefaultTokens) defaultTokens[type].forEach(add);
	return rules;
}

/** Workbench colors as Monaco's defineTheme expects them (valid hex values only). */
export function editorColors(theme: FlatTheme): Record<string, string> {
	const colors: Record<string, string> = {};
	for (const [id, value] of Object.entries(theme.colors)) {
		const hex = normalizeColor(value);
		if (hex) colors[id] = hex;
	}
	return colors;
}
