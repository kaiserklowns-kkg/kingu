// Product icons as VS Code draws them (iconRegistry.ts, productIconThemeData.ts,
// iconsStyleSheet.ts): an icon id (`plus`, `chat-view-icon`) is a glyph of a font, drawn as the
// `::before` of `.codicon.codicon-<id>`. The active product icon theme (`workbench.productIconTheme`)
// has a glyph for some ids; any other id follows the icon it was registered with
// (`registerIcon('chat-view-icon', Codicon.chatSparkle)`) until a codicon of codicon.ttf. Kingu's
// default is kingu-old's own theme, Kingu (Lucide), as kingu-old's is. Pure, for `bun test`; the
// stylesheet is installed by workbenchAppearance.svelte.ts.

import lucideTheme from '#lib/assets/icons/kingu-lucide-icon-theme.json';
import { CODICON_CHARS, ICON_DEFAULTS } from './codiconData.ts';

/** A product icon theme file (VS Code's `contributes.productIconThemes` JSON). */
export type ProductIconThemeFile = {
	fonts: { id: string; src: { path: string; format: string }[]; weight?: string; style?: string }[];
	iconDefinitions: Record<string, { fontCharacter: string; fontId?: string }>;
};

export type ProductIconTheme = {
	/** The `workbench.productIconTheme` value. */
	id: string;
	label: string;
	/** Glyphs by icon id: the CSS font family and the code point. */
	glyphs: ReadonlyMap<string, Glyph>;
};

export type Glyph = { font: string; char: number };

/**
 * The codicon font (codicon.ttf, with kingu-marks.ttf over some code points; codicon.css). VS Code
 * calls it `codicon`; Monaco declares its own `codicon` face when the editor loads, which would
 * win over kingu-marks.ttf, so Kingu's has a name of its own.
 */
export const CODICON_FONT = 'kg-codicon';

/** VS Code's id for "no product icon theme": every icon is its codicon. */
export const DEFAULT_PRODUCT_ICON_THEME_ID = 'Default';

/** kingu-old's default (`workbench.productIconTheme: 'kingu-lucide'`, kinguProductDefaults.ts). */
export const KINGU_PRODUCT_ICON_THEME_ID = 'kingu-lucide';

/** A theme font's CSS family: VS Code's `pi-<font id>` (what kingu-old's window shows, `pi-kingu-lucide`). */
export const productIconFontFamily = (fontId: string) => `pi-${fontId}`;

/** `"\\e063"` (a theme's fontCharacter) → 0xe063. */
function parseFontCharacter(ch: string): number | undefined {
	const hex = /^\\([0-9a-fA-F]{1,6})$/.exec(ch);
	if (hex) return parseInt(hex[1], 16);
	return ch.length ? ch.codePointAt(0) : undefined;
}

/** The glyphs of a product icon theme file (an unknown `fontId` uses the first font, as VS Code does). */
export function parseProductIconTheme(id: string, label: string, file: ProductIconThemeFile): ProductIconTheme {
	const fonts = new Set(file.fonts.map((f) => f.id));
	const first = file.fonts[0]?.id;
	const glyphs = new Map<string, Glyph>();
	for (const [icon, def] of Object.entries(file.iconDefinitions)) {
		const fontId = def.fontId && fonts.has(def.fontId) ? def.fontId : first;
		const char = parseFontCharacter(def.fontCharacter);
		if (fontId && char !== undefined) glyphs.set(icon, { font: productIconFontFamily(fontId), char });
	}
	return { id, label, glyphs };
}

/** The built-in product icon themes, in the order the picker lists them. */
export const PRODUCT_ICON_THEMES: readonly ProductIconTheme[] = [
	{ id: DEFAULT_PRODUCT_ICON_THEME_ID, label: 'Default', glyphs: new Map() },
	parseProductIconTheme(KINGU_PRODUCT_ICON_THEME_ID, 'Kingu (Lucide)', lucideTheme as ProductIconThemeFile)
];

/** The theme for a setting value: an unknown one is the default theme (Kingu's), like VS Code. */
export function findProductIconTheme(id: unknown): ProductIconTheme {
	return PRODUCT_ICON_THEMES.find((t) => t.id === id) ?? PRODUCT_ICON_THEMES.find((t) => t.id === KINGU_PRODUCT_ICON_THEME_ID)!;
}

/** Every icon id there is: the codicons and the registered icons. */
export const ALL_ICON_IDS: readonly string[] = [...new Set([...Object.keys(CODICON_CHARS), ...Object.keys(ICON_DEFAULTS)])].sort();

/** Whether `id` is an icon (a codicon or a registered icon). */
export const isIconId = (id: string) => id in CODICON_CHARS || id in ICON_DEFAULTS;

/**
 * The glyph an icon id draws with under `theme`: the theme's own, else the one of the icon it was
 * registered with, else its codicon. Undefined for an id that is not an icon.
 */
export function resolveIcon(id: string, theme: ProductIconTheme = findProductIconTheme(KINGU_PRODUCT_ICON_THEME_ID)): Glyph | undefined {
	for (let cur: string | undefined = id, n = 0; cur !== undefined && n < 16; cur = ICON_DEFAULTS[cur], n++) {
		const own = theme.glyphs.get(cur);
		if (own) return own;
		if (!(cur in ICON_DEFAULTS)) return cur in CODICON_CHARS ? { font: CODICON_FONT, char: CODICON_CHARS[cur] } : undefined;
	}
	return undefined;
}

/** VS Code's ThemeIcon modifiers (`sync~spin`). */
export type IconModifier = 'spin' | 'disabled';

/** `id~modifier` (VS Code's ThemeIcon syntax) → id and modifier. */
export function parseIconId(value: string): { id: string; modifier?: IconModifier } {
	const m = /^([\w-]+)(?:~(spin|disabled))?$/.exec(value);
	if (!m) return { id: value };
	return m[2] ? { id: m[1], modifier: m[2] as IconModifier } : { id: m[1] };
}

/** The class list of an icon element, as VS Code's ThemeIcon.asClassNameArray. */
export function iconClasses(id: string, modifier?: IconModifier): string {
	return `codicon codicon-${id}${modifier ? ` codicon-modifier-${modifier}` : ''}`;
}

/** A code point as a CSS string escape (`'\e063'`). */
export const cssContent = (char: number) => `'\\${char.toString(16)}'`;

/**
 * The icon rules of a product icon theme, as VS Code's iconsStyleSheet writes them: a
 * `--vscode-icon-<id>-content` / `-font-family` pair per icon on `:root`, and the `::before` of
 * `.codicon.codicon-<id>` drawing it. One sheet for every icon, rewritten when the theme changes.
 * Doubled selectors outrank the sheet Monaco writes for its own codicons (`:root`,
 * `.codicon-<id>:before`), so the editor's icons follow the product icon theme too, as VS Code's do.
 */
export function productIconsCss(theme: ProductIconTheme): string {
	const vars: string[] = [];
	const rules: string[] = [];
	for (const id of ALL_ICON_IDS) {
		const g = resolveIcon(id, theme);
		if (!g) continue;
		const content = cssContent(g.char);
		vars.push(`--vscode-icon-${id}-content: ${content}; --vscode-icon-${id}-font-family: '${g.font}';`);
		rules.push(`.codicon.codicon-${id}::before { content: ${content}; font-family: '${g.font}'; }`);
	}
	return `:root:root {\n${vars.join('\n')}\n}\n${rules.join('\n')}\n`;
}

/**
 * Kingu's own marks, drawn as a mask over the text colour so they follow the theme like a codicon
 * (kingu-old's kinguLook.css `.kingu-arkai-chat-icon`). `<Codicon id="arkai-chat" />` draws one.
 */
export const MASK_ICONS: Readonly<Record<string, string>> = {
	'arkai-chat': 'kingu-arkai-chat-icon',
	'arkai-mark': 'kingu-arkai-mark-icon'
};
