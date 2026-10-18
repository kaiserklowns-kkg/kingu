// The built-in color themes (VS Code extensions/theme-defaults package.json `contributes.themes`).
// Pure: the vendored files are read through `read`, so tests can pass the file system.

import { flattenTheme, type FlatTheme, type ThemeType } from '../editor/textmate/theme';

export type ThemeInfo = {
	/** The `workbench.colorTheme` value (VS Code's theme `id`). */
	id: string;
	label: string;
	file: string;
	type: ThemeType;
};

export const THEMES: ThemeInfo[] = [
	// Kingu's own: VS Code 2026 with neutral, translucent chrome (selection and borders as white/black alpha) and monochrome buttons.
	{ id: 'Kingu Dark', label: 'Kingu Dark', file: 'kingu-dark.json', type: 'dark' },
	{ id: 'Kingu Light', label: 'Kingu Light', file: 'kingu-light.json', type: 'light' },
	{ id: 'Light 2026', label: '2026 Light', file: '2026-light.json', type: 'light' },
	{ id: 'Dark 2026', label: '2026 Dark', file: '2026-dark.json', type: 'dark' },
	{ id: 'Light Modern', label: 'Light Modern', file: 'light_modern.json', type: 'light' },
	{ id: 'Light+', label: 'Light+', file: 'light_plus.json', type: 'light' },
	{ id: 'Dark Modern', label: 'Dark Modern', file: 'dark_modern.json', type: 'dark' },
	{ id: 'Dark+', label: 'Dark+', file: 'dark_plus.json', type: 'dark' },
	{ id: 'Default High Contrast', label: 'Dark High Contrast', file: 'hc_black.json', type: 'hcDark' },
	{ id: 'Default High Contrast Light', label: 'Light High Contrast', file: 'hc_light.json', type: 'hcLight' }
];

export const DEFAULT_THEME = 'Dark Modern';

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
	return THEMES.find((t) => t.id === key) ?? THEMES.find((t) => t.id === DEFAULT_THEME)!;
}

/** Monaco's built-in base theme for a VS Code theme type. */
export const monacoBase = (type: ThemeType) => ({ dark: 'vs-dark', light: 'vs', hcDark: 'hc-black', hcLight: 'hc-light' })[type] as 'vs-dark' | 'vs' | 'hc-black' | 'hc-light';

export const isDarkType = (type: ThemeType) => type === 'dark' || type === 'hcDark';

export function loadTheme(theme: ThemeInfo, read: (file: string) => string): FlatTheme {
	return flattenTheme(theme.file, read);
}
