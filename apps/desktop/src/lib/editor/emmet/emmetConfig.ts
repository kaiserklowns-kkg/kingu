// Emmet in the editor (VS Code: the emmet extension and @vscode/emmet-helper, reimplemented over
// the `emmet` package VS Code's helper also uses): which syntax a language expands as, the
// `emmet.*` settings as emmet options, abbreviation extraction at the cursor, expansion to snippet
// syntax, and VS Code's rules for when a suggestion would only be noise. Pure.

import expand, { extract, resolveConfig, type UserConfig } from 'emmet';

export type EmmetSettings = {
	includeLanguages: Readonly<Record<string, unknown>>;
	excludeLanguages: readonly string[];
	variables: Readonly<Record<string, unknown>>;
	syntaxProfiles: Readonly<Record<string, unknown>>;
	preferences: Readonly<Record<string, unknown>>;
};

export const NO_EMMET_SETTINGS: EmmetSettings = { includeLanguages: {}, excludeLanguages: ['markdown'], variables: {}, syntaxProfiles: {}, preferences: {} };

const MARKUP = ['html', 'xml', 'xsl', 'jsx', 'pug', 'slim', 'haml'];
const STYLESHEET = ['css', 'scss', 'sass', 'less', 'stylus'];
/** VS Code's own mappings before `emmet.includeLanguages` (util.ts MAPPED_MODES). */
const MAPPED: Record<string, string> = { handlebars: 'html', php: 'html' };
/** The languages Emmet works in out of the box (VS Code LANGUAGE_MODES), with their trigger characters. */
const DIGITS = '0123456789'.split('');
export const TRIGGER_CHARACTERS: Readonly<Record<string, readonly string[]>> = {
	html: ['!', '.', '}', ':', '*', '$', ']', '/', '>', ...DIGITS],
	pug: ['!', '.', '}', ':', '*', '$', ']', '/', '>', ...DIGITS],
	slim: ['!', '.', '}', ':', '*', '$', ']', '/', '>', ...DIGITS],
	haml: ['!', '.', '}', ':', '*', '$', ']', '/', '>', ...DIGITS],
	xml: ['.', '}', '*', '$', ']', '/', '>', ...DIGITS],
	xsl: ['!', '.', '}', '*', '$', '/', ']', '>', ...DIGITS],
	css: [':', '!', '-', ...DIGITS],
	scss: [':', '!', '-', ...DIGITS],
	sass: [':', '!', ...DIGITS],
	less: [':', '!', '-', ...DIGITS],
	stylus: [':', '!', ...DIGITS],
	jsx: ['!', '.', '}', '*', '$', ']', '/', '>', ...DIGITS]
};
export const ALL_TRIGGER_CHARACTERS = [...new Set(Object.values(TRIGGER_CHARACTERS).flat())];

export const isStylesheet = (syntax: string) => STYLESHEET.includes(syntax);
/** The languages `emmet.showExpandedAbbreviation: inMarkupAndStylesheetFilesOnly` means. */
export const isMarkupOrStylesheetLanguage = (languageId: string) => ['html', 'haml', 'jade', 'pug', 'slim', 'xml', 'xsl', ...STYLESHEET].includes(languageId);

/** A language id as an emmet syntax (VS Code getEmmetMode): `typescriptreact` → jsx, `pug` → pug. */
function syntaxOfMode(language: string): string | undefined {
	if (/\b(typescriptreact|javascriptreact|jsx-tags)\b/.test(language)) return 'jsx';
	if (language === 'sass-indented') return 'sass';
	if (language === 'jade' || language === 'pug') return 'pug';
	return MARKUP.includes(language) || STYLESHEET.includes(language) ? language : undefined;
}

/** The emmet syntax of a language, or undefined where Emmet is off (not supported, or `emmet.excludeLanguages`). */
export function emmetSyntax(languageId: string, s: Pick<EmmetSettings, 'includeLanguages' | 'excludeLanguages'>): string | undefined {
	if (!languageId || s.excludeLanguages.includes(languageId)) return undefined;
	const mapped: Record<string, string> = {};
	for (const [lang, target] of Object.entries({ ...MAPPED, ...s.includeLanguages })) if (typeof target === 'string' && syntaxOfMode(target)) mapped[lang] = target;
	return syntaxOfMode(mapped[languageId] ?? languageId);
}

const list = (v: unknown) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);

/** `"p:%,e:em"` → `{ p: '%', e: 'em' }` (emmet.preferences css.unitAliases). */
function unitAliases(v: unknown): Record<string, string> | undefined {
	if (typeof v !== 'string') return undefined;
	const out: Record<string, string> = {};
	for (const pair of v.split(',')) {
		const [k, val] = pair.split(':').map((x) => x.trim());
		if (k && val !== undefined) out[k] = val;
	}
	return out;
}

/** `emmet.preferences` (VS Code's names) as emmet options for `syntax`. */
function preferenceOptions(p: Readonly<Record<string, unknown>>, syntax: string): Record<string, unknown> {
	const o: Record<string, unknown> = { 'stylesheet.fuzzySearchMinScore': 0.3 };
	const set = (key: string, value: unknown) => value !== undefined && (o[key] = value);
	const stylesheetPrefix = syntax === 'sass' || syntax === 'stylus' ? syntax : 'css';
	set('stylesheet.intUnit', p['css.intUnit']);
	set('stylesheet.floatUnit', p['css.floatUnit']);
	set('stylesheet.unitAliases', unitAliases(p['css.unitAliases']));
	set('stylesheet.after', p[`${stylesheetPrefix}.propertyEnd`]);
	set('stylesheet.between', p[`${stylesheetPrefix}.valueSeparator`]);
	set('stylesheet.shortHex', p['css.color.short']);
	set('stylesheet.fuzzySearchMinScore', p['css.fuzzySearchMinScore']);
	set('bem.element', p['bem.elementSeparator']);
	set('bem.modifier', p['bem.modifierSeparator']);
	set('comment.before', p['filter.commentBefore']);
	set('comment.after', p['filter.commentAfter']);
	set('comment.trigger', list(p['filter.commentTrigger']));
	set('output.formatSkip', list(p['format.noIndentTags']));
	set('output.formatForce', list(p['format.forceIndentationForTags']));
	set('output.compactBoolean', p['profile.allowCompactBoolean']);
	set('output.inlineBreak', p['output.inlineBreak']);
	set('output.reverseAttributes', p['output.reverseAttributes']);
	set('output.selfClosingStyle', p['output.selfClosingStyle']);
	set('markup.attributes', p['markup.attributes']);
	set('markup.valuePrefix', p['markup.valuePrefix']);
	return o;
}

/** `emmet.syntaxProfiles[syntax]` (Emmet 1 profile names) as emmet options. */
function profileOptions(profile: unknown): Record<string, unknown> {
	if (profile === 'xhtml') return { 'output.selfClosingStyle': 'xhtml' };
	if (profile === 'xml') return { 'output.selfClosingStyle': 'xml' };
	if (!profile || typeof profile !== 'object') return {};
	const p = profile as Record<string, unknown>;
	const o: Record<string, unknown> = {};
	const caseOf = (v: unknown) => (v === 'upper' || v === 'lower' ? v : undefined);
	if (p.attr_quotes === 'single' || p.attr_quotes === 'double') o['output.attributeQuotes'] = p.attr_quotes;
	if (caseOf(p.tag_case)) o['output.tagCase'] = p.tag_case;
	if (caseOf(p.attr_case)) o['output.attributeCase'] = p.attr_case;
	if (p.self_closing_tag !== undefined) o['output.selfClosingStyle'] = p.self_closing_tag === 'xhtml' ? 'xhtml' : p.self_closing_tag === true ? 'xml' : 'html';
	if (typeof p.compact_bool === 'boolean') o['output.compactBoolean'] = p.compact_bool;
	if (typeof p.inline_break === 'number') o['output.inlineBreak'] = p.inline_break;
	if (p.format === false || p.indent === false) o['output.format'] = false;
	return o;
}

const escapeSnippet = (text: string) => text.replace(/[$}\\]/g, (c) => `\\${c}`);

/** emmet's config for an expansion as a Monaco snippet (fields `${1:x}`, other text escaped). */
export function expandConfig(syntax: string, s: EmmetSettings, extra: { bem?: boolean; comment?: boolean } = {}): UserConfig {
	const options: Record<string, unknown> = {
		...preferenceOptions(s.preferences, syntax),
		...profileOptions(s.syntaxProfiles[syntax === 'jsx' ? 'jsx' : syntax]),
		'output.field': (index: number, placeholder: string) => (placeholder ? `\${${index}:${escapeSnippet(placeholder)}}` : `\${${index}}`),
		'output.text': (text: string) => escapeSnippet(text)
	};
	if (extra.bem) options['bem.enabled'] = true;
	if (extra.comment) options['comment.enabled'] = true;
	const variables = Object.fromEntries(Object.entries(s.variables).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
	return { type: isStylesheet(syntax) ? 'stylesheet' : 'markup', syntax, options, variables };
}

/** VS Code's abbreviation filters: `ul>li|bem`, `|c` (comment), `|t` (trim list markers). */
export function splitFilters(abbreviation: string): { abbreviation: string; bem: boolean; comment: boolean; trim: boolean } {
	const out = { abbreviation, bem: false, comment: false, trim: false };
	for (let i = 0; i < 3; i++) {
		const m = /\|(bem|c|t)$/.exec(out.abbreviation);
		if (!m) break;
		out.abbreviation = out.abbreviation.slice(0, m.index);
		if (m[1] === 'bem') out.bem = true;
		else if (m[1] === 'c') out.comment = true;
		else out.trim = true;
	}
	return out;
}

/** `|t`: list markers (`1.`, `*`, `-`) off the wrapped lines. */
const trimMarkers = (lines: string[]) => lines.map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''));

/** The abbreviation expanded as a Monaco snippet, or undefined when it does not parse. `text`:
 * Wrap with Abbreviation's lines. */
export function expandAbbreviation(abbreviation: string, syntax: string, s: EmmetSettings, text?: string[]): string | undefined {
	const f = splitFilters(abbreviation);
	if (!f.abbreviation) return undefined;
	const config = expandConfig(syntax, s, f);
	// The text goes through `output.text`, which escapes it.
	if (text) config.text = f.trim ? trimMarkers(text) : text;
	try {
		const out = expand(f.abbreviation, config);
		return out || undefined;
	} catch {
		return undefined;
	}
}

/** The text a snippet shows in a preview: fields replaced by their placeholders. */
export function snippetPreview(snippet: string): string {
	let out = snippet;
	// Innermost first, so nested fields come out too.
	for (let prev = ''; prev !== out; ) {
		prev = out;
		out = out.replace(/\$\{\d+:((?:[^{}\\]|\\.)*)\}/g, '$1').replace(/\$\{\d+\}/g, '');
	}
	return out.replace(/\\([$}\\])/g, '$1');
}

/** The abbreviation that ends at `column` (1-based) of `line` (emmet's extract with look-ahead,
 * so `ul>li|` inside `ul>li></li>` still works), with its 1-based start and end columns. */
export function abbreviationAt(line: string, column: number, syntax: string): { abbreviation: string; start: number; end: number } | undefined {
	const type = isStylesheet(syntax) ? 'stylesheet' : 'markup';
	try {
		const found = extract(line, column - 1, { type, lookAhead: type === 'markup' });
		if (!found?.abbreviation) return undefined;
		return { abbreviation: found.abbreviation, start: found.start + 1, end: found.end + 1 };
	} catch {
		return undefined;
	}
}

const HEX_COLOR = /^#[\da-fA-F]{0,6}$/;

/** VS Code's isAbbreviationValid: rules out text that only looks like an abbreviation. */
export function isAbbreviationValid(syntax: string, abbreviation: string): boolean {
	if (!abbreviation) return false;
	if (isStylesheet(syntax)) {
		if (abbreviation.includes('#')) {
			if (abbreviation.startsWith('#')) return HEX_COLOR.test(abbreviation);
			if (HTML_TAGS.has(abbreviation.slice(0, abbreviation.indexOf('#')))) return false;
		}
		return /^-?[a-zA-Z!@#]/.test(abbreviation);
	}
	if (abbreviation.startsWith('!')) return !/[^!]/.test(abbreviation);
	// `(some text)` is not a group unless a nesting/sibling/repeat/climb operator is next to it.
	if (/[()]/.test(abbreviation) && !/\{[^{}]*[()]+[^{}]*\}(?:[>+*^]|$)/.test(abbreviation) && !/\(.*\)[>+*^]/.test(abbreviation) && !/[>+*^]\(.*\)/.test(abbreviation)) return false;
	const start = syntax === 'jsx' ? /^[a-zA-Z!([#{]/ : /^[a-zA-Z!([#.{]/;
	return start.test(abbreviation) && /[a-zA-Z.]/.test(abbreviation);
}

let markupSnippetNames: Map<string, string[]> | undefined;
/** emmet's own snippet names of a markup syntax (`a:link`, `link:css`, `!`…). */
export function markupSnippets(syntax: string): string[] {
	markupSnippetNames ??= new Map();
	let names = markupSnippetNames.get(syntax);
	if (!names) {
		names = Object.keys(resolveConfig({ type: 'markup', syntax }).snippets ?? {});
		markupSnippetNames.set(syntax, names);
	}
	return names;
}

/** VS Code's isExpandedTextNoise: an expansion that is just the typed word as a tag (`abc` →
 * `<abc></abc>`) or an empty property (`abc` → `abc: ;`) is not suggested. */
export function isExpansionNoise(syntax: string, abbreviation: string, expanded: string, s: EmmetSettings): boolean {
	const plain = snippetPreview(expanded);
	if (isStylesheet(syntax)) {
		const between = String(s.preferences[`${syntax === 'sass' || syntax === 'stylus' ? syntax : 'css'}.valueSeparator`] ?? ': ');
		const after = String(s.preferences[`${syntax === 'sass' || syntax === 'stylus' ? syntax : 'css'}.propertyEnd`] ?? ';');
		const cut = abbreviation.indexOf(between[0], Math.max(abbreviation.length - between.length, 0));
		const abbr = cut >= 0 ? abbreviation.slice(0, cut) : abbreviation;
		return plain === `${abbr}${between}${after}` || plain.replace(/\s/g, '') === abbreviation.replace(/\s/g, '') + after;
	}
	const low = abbreviation.toLowerCase();
	if (syntax === 'xml' && [...HTML_TAGS].some((tag) => tag.startsWith(low))) return true;
	if (HTML_TAGS.has(low) || low === 'lorem' || markupSnippets(syntax).includes(abbreviation)) return false;
	// Custom elements have `-` or `:`.
	if (/[-:]/.test(abbreviation) && !/--|::/.test(abbreviation) && !abbreviation.endsWith(':')) return false;
	if (abbreviation === '.') return false;
	const dot = /^([a-zA-Z\d]*)\.$/.exec(abbreviation);
	if (dot) return !(dot[1] && HTML_TAGS.has(dot[1]));
	// PascalCase components in JSX.
	if (syntax === 'jsx' && /^([A-Z][A-Za-z0-9]*)+$/.test(abbreviation)) return false;
	return plain.toLowerCase() === `<${low}></${low}>`;
}

/**
 * Whether the cursor is somewhere an abbreviation may expand, from the text before the
 * abbreviation (at most the last 500 characters are looked at): not inside a tag (`<div |`), for
 * markup; inside a rule's braces and before the property's `:`, for stylesheets.
 */
export function isValidLocation(syntax: string, textBefore: string, abbreviation: string): boolean {
	const text = textBefore.slice(-2000);
	if (isStylesheet(syntax)) {
		const noComments = text.replace(/\/\*[\s\S]*?\*\//g, '');
		if (/\/\*(?![\s\S]*\*\/)/.test(noComments)) return false;
		if (abbreviation.startsWith('@')) return true;
		// sass and stylus have no braces; elsewhere the cursor is inside one.
		if (syntax !== 'sass' && syntax !== 'stylus') {
			let depth = 0;
			for (const c of noComments) depth += c === '{' ? 1 : c === '}' ? -1 : 0;
			if (depth <= 0) return false;
		}
		// After the property's `:` only a color or `!` (important) is an abbreviation.
		const decl = /[^{};]*$/.exec(noComments)![0];
		if (decl.includes(':')) return HEX_COLOR.test(abbreviation) || abbreviation === '!';
		return !HEX_COLOR.test(abbreviation) && abbreviation !== '!';
	}
	const back = text.slice(-500);
	if (!back.trim()) return true;
	if (back.endsWith('<')) return false;
	let foundSpace = false;
	for (let i = back.length - 1; i >= 0; i--) {
		const c = back[i];
		if (!foundSpace && /\s/.test(c)) {
			foundSpace = true;
			continue;
		}
		// `<?` (processing instructions) and `< ` (a comparison) are not tags.
		if ((c === '?' || /\s/.test(c)) && back[i - 1] === '<') {
			i--;
			continue;
		}
		if (c !== '<' && c !== '>') continue;
		if (back[i - 1] === '\\') {
			i--;
			continue;
		}
		if (c === '>') {
			// `=>` in JSX and `->` are not the end of a tag.
			if (back[i - 1] === '=' || back[i - 1] === '-') continue;
			return true;
		}
		// A `<` before any whitespace: the abbreviation is glued to a tag name being typed (`<my-el.x`),
		// which emmet extracts on its own; after whitespace it is inside a tag (`<div class="a" |`).
		return !foundSpace;
	}
	return true;
}

/** HTML's element names (for the noise rules: `div` alone is an abbreviation, `foo` is not). */
export const HTML_TAGS: ReadonlySet<string> = new Set(
	'a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup option output p param picture pre progress q rp rt ruby s samp script search section select slot small source span strong style sub summary sup table tbody td template textarea tfoot th thead time title tr track u ul var video wbr svg math'.split(
		' '
	)
);
