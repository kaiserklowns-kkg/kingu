// The color themes (VS Code: `contributes.themes` of the installed extensions). Kingu's come from
// snaps: the built-in snap `kingu-themes` (its own two and VS Code's theme-defaults, in the order
// they always had) and any active snap's `[[themes]]`. Pure: files are read through `read`, so
// tests can pass the file system.

import { flattenTheme, type FlatTheme, type ThemeType } from '../editor/textmate/theme';
import { BUILTIN_SNAPS } from '../snaps/builtinSnaps';
import type { SnapRef, UiTheme } from '../snaps/contributions';

export type ThemeInfo = {
	/** The `workbench.colorTheme` value (VS Code's theme `id`). */
	id: string;
	label: string;
	/** The theme file, a path in its snap (`themes/dark_modern.json`). */
	file: string;
	type: ThemeType;
	/** The snap it comes from (the built-in `kingu-themes` for Kingu's own). */
	snap: SnapRef;
	/** SHA-256 it was listed with (user and repo snaps). */
	sha256?: string;
};

const TYPE_OF: Record<UiTheme, ThemeType> = { vs: 'light', 'vs-dark': 'dark', 'hc-black': 'hcDark', 'hc-light': 'hcLight' };

/** VS Code's `uiTheme` as a theme type (an unknown one reads as dark, VS Code's default). */
export const themeTypeOf = (ui: string): ThemeType => TYPE_OF[ui as UiTheme] ?? 'dark';

type ThemeSnap = { source: SnapRef['source']; id: string; contributes?: { themes: { id: string; label: string; uiTheme: string; path: string }[]; files?: { path: string; sha256: string }[] } };

/** The themes of `snaps`, in their manifests' order. */
export function themesOfSnaps(snaps: readonly ThemeSnap[]): ThemeInfo[] {
	return snaps.flatMap((s) =>
		(s.contributes?.themes ?? []).map((t) => {
			const sha256 = s.contributes?.files?.find((f) => f.path === t.path)?.sha256;
			return { id: t.id, label: t.label, file: t.path, type: themeTypeOf(t.uiTheme), snap: { source: s.source, id: s.id }, ...(s.source !== 'builtin' && sha256 ? { sha256 } : {}) };
		})
	);
}

/** The built-in themes: what the settings registry lists and what is there before snaps load. */
export const THEMES: ThemeInfo[] = themesOfSnaps(BUILTIN_SNAPS);

export const DEFAULT_THEME = 'Dark Modern';

let contributed: ThemeInfo[] = [];

/** Themes of active user and repo snaps (contrib.svelte.ts). A built-in theme's id stays the built-in's. */
export function setContributedThemes(list: readonly ThemeInfo[]) {
	const seen = new Set(THEMES.map((t) => t.id));
	contributed = list.filter((t) => !seen.has(t.id) && (seen.add(t.id), true));
}

/** Every theme: the built-in ones, then those of snaps. */
export const allThemes = (): ThemeInfo[] => [...THEMES, ...contributed];

/** VS Code's older `Default …` ids and the display labels also select a theme. */
const ALIASES: Record<string, string> = {
	'Default Dark Modern': 'Dark Modern',
	'Default Light Modern': 'Light Modern',
	'Default Dark+': 'Dark+',
	'Default Light+': 'Light+',
	'Dark High Contrast': 'Default High Contrast',
	'Light High Contrast': 'Default High Contrast Light'
};

/** The theme for a setting value, falling back to Dark Modern like VS Code does for unknown ids. */
export function findTheme(id: unknown): ThemeInfo {
	const key = typeof id === 'string' ? (ALIASES[id] ?? id) : '';
	return allThemes().find((t) => t.id === key) ?? THEMES.find((t) => t.id === DEFAULT_THEME)!;
}

/** Monaco's built-in base theme for a VS Code theme type. */
export const monacoBase = (type: ThemeType) => ({ dark: 'vs-dark', light: 'vs', hcDark: 'hc-black', hcLight: 'hc-light' })[type] as 'vs-dark' | 'vs' | 'hc-black' | 'hc-light';

export const isDarkType = (type: ThemeType) => type === 'dark' || type === 'hcDark';

/** The built-in snap with Kingu's theme files. */
export const BUILTIN_THEMES_SNAP: SnapRef = { source: 'builtin', id: 'kingu-themes' };

/**
 * Where an include that a user's or repo snap does not ship is read from instead: the built-in
 * theme file of the same name (VS Code themes build on `./dark_modern.json` and the like), so a
 * snap can extend Kingu's themes without copying them. None for a built-in snap's own files.
 */
export function builtinThemeFile(snap: SnapRef, path: string): { snap: SnapRef; path: string } | undefined {
	const name = path.split('/').pop() ?? '';
	if (snap.source === 'builtin' || !/^[\w.-]+\.json$/.test(name)) return undefined;
	return { snap: BUILTIN_THEMES_SNAP, path: `themes/${name}` };
}

/** `read` takes a path in the theme's snap (the theme file, then the files it includes). */
export function loadTheme(theme: ThemeInfo, read: (file: string) => string): FlatTheme {
	return flattenTheme(theme.file, read);
}
