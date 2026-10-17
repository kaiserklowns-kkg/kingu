// The active color theme as a plain observable, so the Monaco/TextMate side (loaded lazily)
// can follow it without importing the workbench theme service.

import type { FlatTheme } from '../editor/textmate/theme';
import type { ThemeInfo } from './themes';

export type ActiveTheme = { info: ThemeInfo; flat: FlatTheme };

let active: ActiveTheme | null = null;
const listeners = new Set<(theme: ActiveTheme) => void>();

export function setActiveTheme(theme: ActiveTheme) {
	active = theme;
	for (const l of listeners) l(theme);
}

export function activeTheme(): ActiveTheme | null {
	return active;
}

/** Calls `listener` now (if a theme is active) and on every change. */
export function onActiveTheme(listener: (theme: ActiveTheme) => void): () => void {
	listeners.add(listener);
	if (active) listener(active);
	return () => listeners.delete(listener);
}
