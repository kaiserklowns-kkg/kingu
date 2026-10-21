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

/**
 * Where the notifications bell is (VS Code's NotificationsStatus and title bar action): the
 * right-most status bar item, the left-most one for `bottom-left`, and for `top-right` the title
 * bar when `workbench.notifications.showInTitleBar` is on (else nowhere).
 */
export function bellPlacement(position: string, showInTitleBar: boolean): 'statusLeft' | 'statusRight' | 'titleBar' | 'none' {
	if (position === 'top-right') return showInTitleBar ? 'titleBar' : 'none';
	return position === 'bottom-left' ? 'statusLeft' : 'statusRight';
}

/** `window.customTitleBarVisibility`: `windowed` (and `never`) hide Kingu's title bar in full screen. */
export const customTitleBarShown = (visibility: string, fullscreen: boolean) => !fullscreen || visibility === 'auto';

/** `window.closeWhenEmpty`: closing the last editor of a window without a folder closes the window. */
export const closesWhenEmpty = (enabled: boolean, s: { hadEditors: boolean; editors: number; folderOpen: boolean }) => enabled && s.hadEditors && s.editors === 0 && !s.folderOpen;

/** A theme-name pattern of `workbench.colorCustomizations` (`[Dark*]`): `*` and `?` wildcards, any case. */
function themePattern(name: string): RegExp {
	return new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
}

/**
 * `workbench.colorCustomizations` for the theme `themeId`: the top-level colors, then every
 * `[Theme Name]` block (several names as `[A][B]`, `*` wildcards) that names this theme, which
 * win over the top level (VS Code's colorThemeData). Only string values are colors.
 */
export function colorCustomizationsFor(custom: unknown, themeId: string): Record<string, string> {
	if (!custom || typeof custom !== 'object' || Array.isArray(custom)) return {};
	const out: Record<string, string> = {};
	const scoped: Record<string, unknown>[] = [];
	for (const [key, value] of Object.entries(custom as Record<string, unknown>)) {
		if (key.startsWith('[')) {
			const names = [...key.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1].trim());
			if (value && typeof value === 'object' && names.some((n) => themePattern(n).test(themeId))) scoped.push(value as Record<string, unknown>);
		} else if (typeof value === 'string') out[key] = value;
	}
	for (const block of scoped) for (const [k, v] of Object.entries(block)) if (typeof v === 'string') out[k] = v;
	return out;
}

// --- Lists and trees (workbench.list.*, workbench.tree.*) --------------------------------------

export type MultiSelectModifier = 'ctrlCmd' | 'alt';
type Mods = Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'altKey'>;

/** `workbench.list.multiSelectModifier`: the click modifier that adds a row to the selection. */
export function isMultiSelect(e: Mods, modifier: MultiSelectModifier, mac: boolean): boolean {
	return modifier === 'alt' ? e.altKey : mac ? e.metaKey : e.ctrlKey;
}

/** VS Code's "open to side" click takes the other modifier, so the two never clash (listService.ts). */
export function isOpenToSide(e: Mods, modifier: MultiSelectModifier, mac: boolean): boolean {
	return modifier === 'alt' ? (mac ? e.metaKey : e.ctrlKey) : e.altKey;
}

export type ClickMode = 'singleClick' | 'doubleClick';

/**
 * What a click on a row does: `workbench.list.openMode` for a file, `workbench.tree.expandMode`
 * for a folder (`detail` is the click count). In doubleClick mode the second click of a double
 * click toggles a folder (a file's double click is the dblclick handler's: it opens pinned).
 */
export function rowClick(opts: { isDir: boolean; detail: number; openMode: ClickMode; expandMode: ClickMode }): 'open' | 'toggle' | 'select' {
	const mode = opts.isDir ? opts.expandMode : opts.openMode;
	if (opts.detail >= 2) return opts.isDir && mode === 'doubleClick' && opts.detail === 2 ? 'toggle' : 'select';
	if (mode === 'doubleClick') return 'select';
	return opts.isDir ? 'toggle' : 'open';
}

/** `workbench.tree.renderIndentGuides`: left offsets (px, in the row) of the guides of a row at `depth`. */
export function indentGuideOffsets(depth: number, indent: number, base = 8, twistie = 16): number[] {
	return Array.from({ length: Math.max(0, depth) }, (_, d) => base + d * indent + twistie / 2);
}

/**
 * `workbench.list.mouseWheelScrollSensitivity`, and `fastScrollSensitivity` while Alt is held: the
 * scroll distance for a wheel delta, or null when the browser's own scrolling is already right.
 */
export function wheelDelta(delta: { x: number; y: number }, alt: boolean, sensitivity: number, fast: number): { x: number; y: number } | null {
	const k = sensitivity * (alt ? fast : 1);
	if (k === 1 || !Number.isFinite(k)) return null;
	return { x: delta.x * k, y: delta.y * k };
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
