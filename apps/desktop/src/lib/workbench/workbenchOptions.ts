// Pure rules behind the workbench, window and keyboard settings (VS Code: workbench.contribution.ts,
// layout.ts, notificationsToasts.ts, quickInput, menubarControl.ts, themeService), so bun tests can
// check each one. The Svelte parts read the settings and call these.

/** `window.menuBarVisibility` on Windows and Linux (macOS uses the native menu): what the title bar shows. */
export type MenuBarVisibility = 'classic' | 'visible' | 'toggle' | 'hidden' | 'compact';
export function menuBarShown(visibility: MenuBarVisibility, state: { fullscreen: boolean; toggledOn: boolean }): 'bar' | 'button' | 'none' {
	switch (visibility) {
		case 'classic':
			return state.fullscreen ? 'none' : 'bar';
		case 'visible':
			return 'bar';
		case 'toggle':
			return state.toggledOn ? 'bar' : 'none';
		case 'compact':
			return 'button';
		default:
			return 'none';
	}
}

/** `workbench.panel.opensMaximized`: whether the panel is maximized when it is shown again. */
export function panelOpensMaximized(setting: string, wasMaximized: boolean): boolean {
	return setting === 'always' ? true : setting === 'never' ? false : wasMaximized;
}

/** `workbench.activityBar.iconClickBehavior`: a click on the active view's icon hides the side bar only with `toggle`. */
export const activityClickHides = (behavior: string, sideBarVisible: boolean, isActiveView: boolean) => behavior !== 'focus' && sideBarVisible && isActiveView;

/** `workbench.commandPalette.history`: the most recent first, at most `limit` (0 = none kept). */
export function recordCommand(history: readonly string[], id: string, limit: number): string[] {
	if (limit <= 0) return [];
	return [id, ...history.filter((h) => h !== id)].slice(0, limit);
}

/**
 * The command palette's order: recently used commands first (most recent first, VS Code's
 * "recently used" group), then the rest in their ranked order.
 */
export function withRecentFirst<T>(items: readonly T[], idOf: (item: T) => string, history: readonly string[]): { item: T; recent: boolean }[] {
	const pos = new Map(history.map((id, i) => [id, i]));
	const recent = items.filter((i) => pos.has(idOf(i))).sort((a, b) => pos.get(idOf(a))! - pos.get(idOf(b))!);
	return [...recent.map((item) => ({ item, recent: true })), ...items.filter((i) => !pos.has(idOf(i))).map((item) => ({ item, recent: false }))];
}

/** Which quick access a value belongs to, for `workbench.commandPalette.preserveInput` / `workbench.quickOpen.preserveInput`. */
export const quickInputKind = (prefix: string): 'commands' | 'files' | null => (prefix === '>' ? 'commands' : prefix === '' ? 'files' : null);

/** Which quick access a typed value is in (the other prefixes, `:` `@` `#` `?` `edt ` `view `, keep nothing). */
export const quickValueKind = (value: string): 'commands' | 'files' | null => (value.startsWith('>') ? 'commands' : /^([:@#?%]|edt |view )/.test(value) ? null : 'files');

/** The text a quick access opens with: the last input when the setting preserves it (and it is of the same kind). */
export function restoredInput(prefix: string, last: string | undefined, preserve: boolean): string {
	if (!preserve || last === undefined) return prefix;
	if (prefix === '>') return last.startsWith('>') ? last : prefix;
	return last.startsWith('>') ? prefix : last;
}

/** `workbench.notifications.position`: where the toasts and the notification center sit. */
export function notificationsCorner(position: string): { top: boolean; left: boolean } {
	return { top: position === 'top-right', left: position === 'bottom-left' };
}

/** `workbench.reduceMotion`: `auto` follows the OS (prefers-reduced-motion). */
export const reducedMotion = (setting: string, osReduced: boolean) => setting === 'on' || (setting === 'auto' && osReduced);

/** `workbench.fontAliasing` as `-webkit-font-smoothing`; `auto` is antialiased on high-DPI displays (VS Code's rule). */
export function fontSmoothing(setting: string, devicePixelRatio: number): 'auto' | 'antialiased' | 'none' {
	if (setting === 'antialiased') return 'antialiased';
	if (setting === 'none') return 'none';
	if (setting === 'auto') return devicePixelRatio >= 2 ? 'antialiased' : 'auto';
	return 'auto';
}

/** `window.density.editorTabHeight`: VS Code's tab heights (35px, 22px compact). */
export const editorTabHeight = (density: string) => (density === 'compact' ? 22 : 35);

/** `workbench.activityBar.compact`: VS Code's activity bar width, item height and icon size. */
export const activityBarMetrics = (compact: boolean) => (compact ? { width: 36, item: 28, icon: 16 } : { width: 48, item: 48, icon: 24 });

/**
 * `window.systemColorTheme`: the native window theme (dialogs, menus, the window frame), `null`
 * following the OS. VS Code ignores it while `window.autoDetectColorScheme` is on.
 */
export function nativeWindowTheme(setting: string, themeIsDark: boolean, autoDetectColorScheme: boolean): 'light' | 'dark' | null {
	if (autoDetectColorScheme) return null;
	if (setting === 'light' || setting === 'dark') return setting;
	if (setting === 'auto') return themeIsDark ? 'dark' : 'light';
	return null;
}

/** The theme setting in effect (VS Code themeConfiguration): high contrast when the OS asks for it, then the OS scheme, then `workbench.colorTheme`. */
export function themeSettingFor(opts: { autoDetectHighContrast: boolean; autoDetectColorScheme: boolean; highContrast: boolean; prefersDark: boolean }): string {
	if (opts.autoDetectHighContrast && opts.highContrast) return opts.prefersDark ? 'workbench.preferredHighContrastColorTheme' : 'workbench.preferredHighContrastLightColorTheme';
	if (opts.autoDetectColorScheme) return opts.prefersDark ? 'workbench.preferredDarkColorTheme' : 'workbench.preferredLightColorTheme';
	return 'workbench.colorTheme';
}

/** View: Toggle Menu Bar (VS Code's layout.ts toggleMenuBar, with no native menu): a shown menu
 * bar (`classic`, `visible`) becomes `compact`, any other becomes `classic`. */
export function menuBarToggled(current: string | undefined): MenuBarVisibility {
	return current === 'visible' || current === 'classic' || typeof current !== 'string' ? 'compact' : 'classic';
}
