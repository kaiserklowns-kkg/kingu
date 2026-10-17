// Pure helpers that turn VS Code color-theme files into what vscode-textmate and
// Monaco need. No Monaco or DOM imports here so `bun test` can exercise them.
// Mirrors _loadColorTheme / ColorThemeData.tokenColors in
// microsoft/vscode src/vs/workbench/services/themes/common/colorThemeData.ts.

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
}

export interface FlatTheme {
	name: string;
	colors: Record<string, string>;
	tokenColors: TokenColorRule[];
}

/** Parses JSONC: drops // and block comments and trailing commas, leaving strings untouched. */
export function parseJsonc<T = unknown>(text: string): T {
	let out = '';
	let i = 0;
	const n = text.length;
	while (i < n) {
		const ch = text[i];
		if (ch === '"') {
			const start = i++;
			while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
			out += text.slice(start, ++i);
		} else if (ch === '/' && text[i + 1] === '/') {
			while (i < n && text[i] !== '\n') i++;
		} else if (ch === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			i = end < 0 ? n : end + 2;
		} else {
			out += ch;
			i++;
		}
	}
	// Trailing commas: a comma followed only by whitespace before } or ].
	// Safe now that comments are gone; strings are skipped by matching them first.
	out = out.replace(/("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g, (m, str, close) => str ?? close);
	return JSON.parse(out) as T;
}

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
		if (theme.name) result.name = theme.name;
	};
	load(entry);
	return result;
}

function joinPath(from: string, relative: string): string {
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

const darkDefaultTokens: TokenColorRule[] = [
	{ scope: 'token.info-token', settings: { foreground: '#6796e6' } },
	{ scope: 'token.warn-token', settings: { foreground: '#cd9731' } },
	{ scope: 'token.error-token', settings: { foreground: '#f44747' } },
	{ scope: 'token.debug-token', settings: { foreground: '#b267e6' } }
];

/**
 * The TextMate theme rules VS Code feeds its tokenizer: a scope-less default rule
 * from editor.foreground/background first, then the theme's scoped rules.
 */
export function textMateRules(theme: FlatTheme): TokenColorRule[] {
	const rules: TokenColorRule[] = [
		{
			settings: {
				foreground: normalizeColor(theme.colors['editor.foreground']) ?? '#BBBBBB',
				background: normalizeColor(theme.colors['editor.background']) ?? '#1E1E1E'
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
	if (!hasDefaultTokens) darkDefaultTokens.forEach(add);
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
