// `editor.tokenColorCustomizations` and `editor.semanticTokenColorCustomizations` over the applied
// color theme (VS Code's colorThemeData.ts setCustomTokenColors / setCustomSemanticTokenColors):
// the general groups (`comments`, `strings`, … as their TextMate scopes) and `textMateRules` come
// after the theme's token colors, so they win; `[Theme Name]` blocks (`*` wildcards, several names
// as `[A][B]`) apply after the general ones. Semantic `rules` join the theme's semanticTokenColors,
// and `enabled` (or the older `semanticHighlighting`) overrides the theme's semanticHighlighting.
// Pure, so bun tests cover it.

import type { FlatTheme, SemanticColorValue, TokenColorRule } from '../editor/textmate/theme';

/** colorThemeData.ts tokenGroupToScopesMap. */
export const TOKEN_GROUP_SCOPES: Readonly<Record<string, readonly string[]>> = {
	comments: ['comment', 'punctuation.definition.comment'],
	strings: ['string', 'meta.embedded.assembly'],
	keywords: ['keyword - keyword.operator', 'keyword.control', 'storage', 'storage.type'],
	numbers: ['constant.numeric'],
	types: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'],
	functions: ['entity.name.function', 'support.function'],
	variables: ['variable', 'entity.name.variable']
};

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** VS Code's isThemeScopeMatch: an exact name, or `*` at the start, the end or both. */
function scopeMatches(pattern: string, name: string): boolean {
	const first = pattern.charAt(0) === '*';
	const last = pattern.length > 1 && pattern.charAt(pattern.length - 1) === '*';
	if (pattern === name) return true;
	if (first && last) return name.includes(pattern.slice(1, -1));
	if (last) return name.startsWith(pattern.slice(0, -1));
	if (first) return name.endsWith(pattern.slice(1));
	return false;
}

/**
 * The `[Theme]` blocks of a customization that name the theme (by id or label), merged in order:
 * lists concatenate, other values are replaced (VS Code's getThemeSpecificColors). Null when none.
 */
export function themeSpecific(custom: unknown, names: readonly string[]): Obj | null {
	if (!isObject(custom)) return null;
	let out: Obj | null = null;
	for (const [key, block] of Object.entries(custom)) {
		if (!key.startsWith('[') || !key.endsWith(']') || !isObject(block)) continue;
		for (const m of key.matchAll(/\[([^\]]*)\]/g)) {
			const pattern = m[1];
			if (!names.some((n) => scopeMatches(pattern, n))) continue;
			out ??= {};
			for (const [sub, value] of Object.entries(block)) {
				const prev = out[sub];
				if (Array.isArray(prev) && Array.isArray(value)) out[sub] = [...prev, ...value];
				else if (value) out[sub] = value;
			}
		}
	}
	return out;
}

const isRule = (r: unknown): r is TokenColorRule => isObject(r) && !!r.scope && isObject(r.settings);

function addTokenColors(out: TokenColorRule[], custom: Obj) {
	// The groups first, so specific textMateRules (`string.interpolated`) can override them.
	for (const [group, scopes] of Object.entries(TOKEN_GROUP_SCOPES)) {
		const value = custom[group];
		if (!value) continue;
		const settings = typeof value === 'string' ? { foreground: value } : isObject(value) ? (value as TokenColorRule['settings']) : null;
		if (settings) for (const scope of scopes) out.push({ scope, settings });
	}
	if (Array.isArray(custom.textMateRules)) for (const rule of custom.textMateRules) if (isRule(rule)) out.push(rule);
}

/** `editor.tokenColorCustomizations` for a theme: the TextMate rules to append, and its `semanticHighlighting`. */
export function customTokenColors(custom: unknown, names: readonly string[]): { rules: TokenColorRule[]; semanticHighlighting?: boolean } {
	const rules: TokenColorRule[] = [];
	let semanticHighlighting: boolean | undefined;
	for (const block of [isObject(custom) ? custom : null, themeSpecific(custom, names)]) {
		if (!block) continue;
		addTokenColors(rules, block);
		if (typeof block.semanticHighlighting === 'boolean') semanticHighlighting = block.semanticHighlighting;
	}
	return { rules, semanticHighlighting };
}

/** `editor.semanticTokenColorCustomizations` for a theme: its `enabled` and the rules by selector. */
export function customSemanticColors(custom: unknown, names: readonly string[]): { enabled?: boolean; rules: Record<string, SemanticColorValue> } {
	const rules: Record<string, SemanticColorValue> = {};
	let enabled: boolean | undefined;
	for (const block of [isObject(custom) ? custom : null, themeSpecific(custom, names)]) {
		if (!block) continue;
		if (typeof block.enabled === 'boolean') enabled = block.enabled;
		if (isObject(block.rules))
			for (const [selector, value] of Object.entries(block.rules)) {
				if (selector.startsWith('[')) continue;
				if (typeof value === 'string' || typeof value === 'boolean' || isObject(value)) rules[selector] = value as SemanticColorValue;
			}
	}
	return { enabled, rules };
}

/** The theme with both customizations applied (unchanged when there are none). */
export function withTokenCustomizations(flat: FlatTheme, tokenCustom: unknown, semanticCustom: unknown, names: readonly string[]): FlatTheme {
	const token = customTokenColors(tokenCustom, names);
	const semantic = customSemanticColors(semanticCustom, names);
	const semanticOn = semantic.enabled ?? token.semanticHighlighting;
	if (!token.rules.length && !Object.keys(semantic.rules).length && semanticOn === undefined) return flat;
	return {
		...flat,
		tokenColors: [...flat.tokenColors, ...token.rules],
		semanticTokenColors: Object.keys(semantic.rules).length ? { ...flat.semanticTokenColors, ...semantic.rules } : flat.semanticTokenColors,
		semanticHighlighting: semanticOn ?? flat.semanticHighlighting
	};
}
