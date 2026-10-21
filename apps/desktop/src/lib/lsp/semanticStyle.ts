// Semantic token styling the way VS Code's theme service does it (colorThemeData.ts
// getTokenStyle + tokenClassificationRegistry.ts): the theme's `semanticTokenColors` rules first,
// then the default token-type → TextMate scope fallbacks resolved against the theme's tokenColors.
// A token no rule styles keeps its TextMate color.
//
// Monaco's standalone theme cannot do this itself (it matches `type.mod1.mod2` against its token
// theme as a dotted prefix and paints unmatched tokens in the default color), so each resolved
// style gets a synthetic token type (`kg_<colorId>_<fontStyle>`) whose rule carries exactly that
// style, and the provider re-encodes the server's tokens with those types (languageFeatures.ts
// restyleSemanticTokens). Pure, so `bun test` covers the matching.

import { normalizeColor, textMateRules, type FlatTheme, type SemanticColorValue, type ThemeType, type TokenColorRule } from '../editor/textmate/theme';

export type TokenStyle = { foreground?: string; bold?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean };

type Selector = { type: string; modifiers: string[]; language?: string };

/** Token types with a super type (VS Code registers `member` as a deprecated `method`). */
const SUPER_TYPES: Record<string, string> = { member: 'method' };

function hierarchy(type: string): string[] {
	const out = [type];
	for (let t = SUPER_TYPES[type]; t && !out.includes(t); t = SUPER_TYPES[t]) out.push(t);
	return out;
}

/** `type.mod1.mod2:language` (VS Code's parseClassifierString); `*` is any type. */
export function parseSelector(s: string): Selector | null {
	const [classifier, language] = s.split(':');
	const parts = (classifier ?? '').split('.').filter(Boolean);
	if (!parts.length) return null;
	return { type: parts[0], modifiers: parts.slice(1), language: language || undefined };
}

/** VS Code's selector score: -1 for no match; higher is more specific. */
export function selectorScore(sel: Selector, type: string, modifiers: readonly string[], language: string): number {
	let score = 0;
	if (sel.language !== undefined) {
		if (sel.language !== language) return -1;
		score += 10;
	}
	if (sel.type !== '*') {
		const level = hierarchy(type).indexOf(sel.type);
		if (level === -1) return -1;
		score += 100 - level;
	}
	for (const m of sel.modifiers) if (!modifiers.includes(m)) return -1;
	return score + sel.modifiers.length * 100;
}

/** tokenClassificationRegistry.ts: the TextMate scopes each selector falls back to, in order. */
export const DEFAULT_SCOPES: readonly (readonly [string, readonly string[]])[] = [
	['comment', ['comment']],
	['string', ['string']],
	['keyword', ['keyword.control']],
	['number', ['constant.numeric']],
	['regexp', ['constant.regexp']],
	['operator', ['keyword.operator']],
	['namespace', ['entity.name.namespace']],
	['type', ['entity.name.type', 'support.type']],
	['struct', ['entity.name.type.struct']],
	['class', ['entity.name.type.class', 'support.class']],
	['interface', ['entity.name.type.interface']],
	['enum', ['entity.name.type.enum']],
	['typeParameter', ['entity.name.type.parameter']],
	['function', ['entity.name.function', 'support.function']],
	['method', ['entity.name.function.member', 'support.function']],
	['macro', ['entity.name.function.preprocessor']],
	['variable', ['variable.other.readwrite', 'entity.name.variable']],
	['parameter', ['variable.parameter']],
	['property', ['variable.other.property']],
	['enumMember', ['variable.other.enummember']],
	['event', ['variable.other.event']],
	['decorator', ['entity.name.decorator', 'entity.name.function']],
	['variable.readonly', ['variable.other.constant']],
	['property.readonly', ['variable.other.constant.property']],
	['type.defaultLibrary', ['support.type']],
	['class.defaultLibrary', ['support.class']],
	['interface.defaultLibrary', ['support.class']],
	['variable.defaultLibrary', ['support.variable', 'support.other.variable']],
	['variable.defaultLibrary.readonly', ['support.constant']],
	['property.defaultLibrary', ['support.variable.property']],
	['property.defaultLibrary.readonly', ['support.constant.property']],
	['function.defaultLibrary', ['support.function']],
	['member.defaultLibrary', ['support.function']]
];

const scopesMatch = (scope: string, selector: string) => scope === selector || (scope.length > selector.length && scope.startsWith(selector) && scope[selector.length] === '.');

/**
 * How well a theme rule's scope selector matches one probe scope (colorThemeData.ts nameMatcher on
 * a one-scope path): descendant selectors (`a b`) need deeper paths and never match; `a - b`
 * exclusions are ignored like VS Code does for probes.
 */
export function scopeScore(ruleScope: string | string[] | undefined, scope: string): number {
	if (!ruleScope) return -1;
	let best = -1;
	for (const raw of Array.isArray(ruleScope) ? ruleScope : ruleScope.split(',')) {
		const part = raw.split(/\s-\s/)[0].trim();
		const ids = part.split(/\s+/).filter(Boolean);
		if (ids.length !== 1) continue;
		if (scopesMatch(scope, ids[0])) best = Math.max(best, 0x10000 + ids[0].length);
	}
	return best;
}

function fontFlags(fontStyle: string): TokenStyle {
	const words = fontStyle.split(/\s+/);
	return { italic: words.includes('italic'), bold: words.includes('bold'), underline: words.includes('underline'), strikethrough: words.includes('strikethrough') };
}

/** colorThemeData.ts resolveScopes: the first probe scope any rule styles. */
export function resolveScopes(rules: readonly TokenColorRule[], scopes: readonly string[]): TokenStyle | undefined {
	for (const scope of scopes) {
		let foreground: string | undefined;
		let fontStyle: string | undefined;
		let fgScore = -1;
		let fsScore = -1;
		for (const r of rules) {
			const score = scopeScore(r.scope, scope);
			if (score < 0) continue;
			if (score >= fgScore && r.settings.foreground) {
				foreground = r.settings.foreground;
				fgScore = score;
			}
			if (score >= fsScore && typeof r.settings.fontStyle === 'string') {
				fontStyle = r.settings.fontStyle;
				fsScore = score;
			}
		}
		if (foreground !== undefined || fontStyle !== undefined) return { foreground: normalizeColor(foreground), ...(fontStyle !== undefined ? fontFlags(fontStyle) : {}) };
	}
	return undefined;
}

function themeRuleStyle(v: SemanticColorValue): TokenStyle | undefined {
	if (typeof v === 'string') return { foreground: normalizeColor(v) };
	if (typeof v !== 'object' || v === null) return undefined;
	const style: TokenStyle = { foreground: normalizeColor(v.foreground) };
	if (typeof v.fontStyle === 'string') Object.assign(style, fontFlags(v.fontStyle));
	for (const k of ['bold', 'italic', 'underline', 'strikethrough'] as const) if (typeof v[k] === 'boolean') style[k] = v[k];
	return style;
}

const PROPS = ['foreground', 'bold', 'italic', 'underline', 'strikethrough'] as const;

/** A semantic-styling view of one color theme. */
export class SemanticStyler {
	readonly #themeRules: { sel: Selector; style: TokenStyle }[] = [];
	readonly #defaults: { sel: Selector; scopes: readonly string[] }[] = [];
	readonly #tm: TokenColorRule[];
	readonly #cache = new Map<string, TokenStyle | null>();
	/** Colors by id (index 0 unused), the TextMate color map first, then the semantic rules' own colors. */
	readonly colorMap: string[];
	readonly #colorIds = new Map<string, number>();

	constructor(theme: Pick<FlatTheme, 'colors' | 'tokenColors' | 'semanticTokenColors'>, type: ThemeType, baseColorMap: readonly (string | undefined)[]) {
		this.#tm = textMateRules(theme as FlatTheme, type);
		for (const [selector, value] of Object.entries(theme.semanticTokenColors ?? {})) {
			const sel = parseSelector(selector);
			const style = themeRuleStyle(value);
			if (sel && style) this.#themeRules.push({ sel, style });
		}
		for (const [selector, scopes] of DEFAULT_SCOPES) this.#defaults.push({ sel: parseSelector(selector)!, scopes });
		this.colorMap = [...baseColorMap].map((c) => c ?? '');
		this.colorMap.forEach((c, i) => c && !this.#colorIds.has(c) && this.#colorIds.set(c, i));
		if (!this.colorMap.length) this.colorMap.push('');
		for (const { style } of this.#themeRules)
			if (style.foreground && !this.#colorIds.has(style.foreground)) {
				this.#colorIds.set(style.foreground, this.colorMap.length);
				this.colorMap.push(style.foreground);
			}
	}

	/** The id of `hex` in `colorMap`, or -1 (a color no theme rule uses). */
	colorId(hex: string): number {
		return this.#colorIds.get(normalizeColor(hex) ?? hex) ?? -1;
	}

	/** colorThemeData.ts getTokenStyle: undefined when nothing styles the token. */
	styleOf(type: string, modifiers: readonly string[], language: string): TokenStyle | undefined {
		const key = `${language}|${type}|${[...modifiers].sort().join('.')}`;
		const cached = this.#cache.get(key);
		if (cached !== undefined) return cached ?? undefined;
		const result: TokenStyle = {};
		const score: Record<(typeof PROPS)[number], number> = { foreground: -1, bold: -1, italic: -1, underline: -1, strikethrough: -1 };
		const take = (s: number, style: TokenStyle) => {
			for (const p of PROPS) {
				if (style[p] === undefined || score[p] > s) continue;
				score[p] = s;
				(result as Record<string, unknown>)[p] = style[p];
			}
		};
		for (const r of this.#themeRules) {
			const s = selectorScore(r.sel, type, modifiers, language);
			if (s >= 0) take(s, r.style);
		}
		// Properties the theme's semantic rules set are final; the defaults fill the others.
		if (PROPS.some((p) => score[p] === -1)) {
			for (const p of PROPS) if (score[p] !== -1) score[p] = Number.MAX_VALUE;
			for (const d of this.#defaults) {
				const s = selectorScore(d.sel, type, modifiers, language);
				if (s < 0) continue;
				const style = resolveScopes(this.#tm, d.scopes);
				if (style) take(s, style);
			}
		}
		const styled = PROPS.some((p) => result[p] !== undefined) ? result : null;
		this.#cache.set(key, styled);
		return styled ?? undefined;
	}

	/**
	 * The synthetic token type for a style, or null when Monaco cannot show it as VS Code would: a
	 * style without a color would paint the token in the default foreground.
	 */
	tokenName(style: TokenStyle | undefined): string | null {
		const id = style?.foreground ? this.colorId(style.foreground) : -1;
		return id > 0 ? `kg_${id}_${fontBits(style!)}` : null;
	}
}

/** Monaco FontStyle bits: italic 1, bold 2, underline 4, strikethrough 8. */
export const fontBits = (s: TokenStyle) => (s.italic ? 1 : 0) | (s.bold ? 2 : 0) | (s.underline ? 4 : 0) | (s.strikethrough ? 8 : 0);

export type MonacoThemeColors = {
	/** Monaco's `encodedTokensColors`: one distinct `#RRGGBB` per id so its ids equal `colorMap`'s. */
	seed: string[];
	/** Token theme rules for every synthetic token type. */
	rules: { token: string; foreground: string; fontStyle: string }[];
};

/**
 * The Monaco theme parts for a styler. Monaco keys colors by `RRGGBB` (alpha dropped), so a color
 * that repeats another's RGB, or the unused id 0, gets a unique placeholder in `seed`: Monaco's
 * ids then line up with `colorMap`, which is what `setColorMap` installs afterwards.
 */
export function monacoThemeColors(styler: SemanticStyler): MonacoThemeColors {
	const seed: string[] = [];
	const colors = styler.colorMap;
	const rgbOf = (c: string) => /^#([0-9A-F]{6})/i.exec(c)?.[1]?.toUpperCase();
	// Placeholders avoid every real color, not only the ones seen so far.
	const used = new Set<string>(colors.map(rgbOf).filter((x): x is string => !!x));
	const taken = new Set<string>();
	let dummy = 0;
	const placeholder = () => {
		for (;;) {
			const hex = `#${(0xfe0000 + dummy++).toString(16).toUpperCase().padStart(6, '0')}`;
			if (!used.has(hex.slice(1))) return hex;
		}
	};
	// Every id from 1; Monaco assigns 1, 2, … in seed order.
	for (let i = 1; i < colors.length; i++) {
		const rgb = rgbOf(colors[i]);
		const hex = rgb && !taken.has(rgb) ? `#${rgb}` : placeholder();
		taken.add(hex.slice(1));
		used.add(hex.slice(1));
		seed.push(hex);
	}
	const rules: MonacoThemeColors['rules'] = [];
	for (let id = 1; id < colors.length; id++)
		for (let f = 0; f < 16; f++) {
			const words = [f & 1 && 'italic', f & 2 && 'bold', f & 4 && 'underline', f & 8 && 'strikethrough'].filter(Boolean);
			rules.push({ token: `kg_${id}_${f}`, foreground: seed[id - 1], fontStyle: words.join(' ') });
		}
	return { seed, rules };
}

// --- The active theme's styler (set by the TextMate theme setup, read by the token providers) --

let active: SemanticStyler | null = null;
const listeners = new Set<(styler: SemanticStyler) => void>();

export function setSemanticStyler(styler: SemanticStyler) {
	active = styler;
	for (const l of listeners) l(styler);
}

export function semanticStyler(): SemanticStyler | null {
	return active;
}

export function onSemanticStyler(listener: (styler: SemanticStyler) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
