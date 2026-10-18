// The application menu (VS Code: menubar.ts + MenuId.MenubarFileMenu…). One model, two renderers:
// macOS gets a native menu bar built by Rust from `resolveMenubar(...)` (sent as JSON, see
// menu.rs), Windows/Linux get MenuBar.svelte inside the custom title bar (VS Code's
// `window.menuBarVisibility: classic`). Pure, so it is unit-testable; appMenu.svelte.ts feeds it
// the live command registry and pushes it to Rust.
//
// Items name a command id, never a callback: a click runs `commands.runFromMenu(id)`, so menus,
// keybindings and the command palette share one implementation. Accelerators come from the
// command's own keybinding (`keyOf`), so the menu always shows what the keyboard does. `key` on an
// item is only for commands whose key Monaco owns (Find ⌘F, Go to Definition F12): the webview
// registers no keybinding for those, the menu shows and binds it.

import { keyLabel, toAccelerator } from './keys';

export type Platform = 'mac' | 'other';

/** Native menu items the OS implements (Tauri `PredefinedMenuItem`). Edit roles act on the focused
 * webview element, so Undo/Copy/Paste work in Monaco, inputs and xterm alike. */
export type Role =
	| 'about'
	| 'services'
	| 'hide'
	| 'hideOthers'
	| 'showAll'
	| 'quit'
	| 'undo'
	| 'redo'
	| 'cut'
	| 'copy'
	| 'paste'
	| 'selectAll'
	| 'minimize'
	| 'zoom'
	| 'fullscreen'
	| 'bringAllToFront';

type Only = { platform?: Platform };
export type MenuItem =
	| ({
			command: string;
			label: string;
			key?: string;
			mac?: string;
			toggle?: boolean;
			/** A two-state item whose label names the other state (Open in Agents / Open in Editor) instead of a check mark. */
			checkedLabel?: string;
	  } & Only)
	| ({ role: Role; label?: string } & Only)
	| ({ separator: true } & Only)
	| ({ submenu: string; label: string; items: MenuItem[] } & Only)
	| ({ recent: true } & Only);

/** A top-level menu. `&` marks the mnemonic of the in-window menu bar (Alt+F opens File). */
export type Menu = { id: string; label: string; items: MenuItem[] } & Only;

/** Labels and keys of roles, for the in-window menu bar and the duplicate-accelerator check. */
export const ROLES: Record<Role, { label: string; key?: string; mac?: string }> = {
	about: { label: 'About Kingu' },
	services: { label: 'Services' },
	hide: { label: 'Hide Kingu', key: 'cmd+h' },
	hideOthers: { label: 'Hide Others', key: 'cmd+alt+h' },
	showAll: { label: 'Show All' },
	quit: { label: 'Quit Kingu', key: 'cmd+q' },
	undo: { label: 'Undo', key: 'cmd+z' },
	redo: { label: 'Redo', key: 'ctrl+y', mac: 'cmd+shift+z' },
	cut: { label: 'Cut', key: 'cmd+x' },
	copy: { label: 'Copy', key: 'cmd+c' },
	paste: { label: 'Paste', key: 'cmd+v' },
	selectAll: { label: 'Select All', key: 'cmd+a' },
	minimize: { label: 'Minimize', key: 'cmd+m' },
	zoom: { label: 'Zoom' },
	fullscreen: { label: 'Enter Full Screen', key: 'ctrl+cmd+f' },
	bringAllToFront: { label: 'Bring All to Front' }
};

/** Commands Monaco implements; the workbench registers them without a keybinding. */
export const EDITOR_ACTIONS: Record<string, string> = {
	'actions.find': 'Find',
	'editor.action.startFindReplaceAction': 'Replace',
	'editor.action.revealDefinition': 'Go to Definition',
	'editor.action.smartSelect.expand': 'Expand Selection',
	'editor.action.smartSelect.shrink': 'Shrink Selection'
};

const SEP = { separator: true } as const;

export const MENUS: Menu[] = [
	{
		id: 'app',
		label: 'Kingu',
		platform: 'mac',
		items: [
			{ role: 'about' },
			SEP,
			{ command: 'workbench.action.openSettings', label: 'Settings...' },
			SEP,
			{ role: 'services' },
			SEP,
			{ role: 'hide' },
			{ role: 'hideOthers' },
			{ role: 'showAll' },
			SEP,
			{ role: 'quit' }
		]
	},
	{
		id: 'file',
		label: '&File',
		items: [
			{ command: 'kingu.agents.newTask', label: 'New Task' },
			{ command: 'explorer.newFile', label: 'New File...' },
			SEP,
			{ command: 'workbench.action.files.openFolder', label: 'Open Folder...' },
			{ submenu: 'openRecent', label: 'Open Recent', items: [{ recent: true }] },
			SEP,
			{ command: 'workbench.action.files.save', label: 'Save' },
			{ command: 'workbench.action.files.saveAll', label: 'Save All' },
			SEP,
			{
				submenu: 'preferences',
				label: 'Preferences',
				platform: 'other',
				items: [
					{ command: 'workbench.action.openSettings', label: 'Settings' },
					{ command: 'workbench.action.selectTheme', label: 'Color Theme' }
				]
			},
			{ ...SEP, platform: 'other' },
			{ command: 'workbench.action.closeActiveEditor', label: 'Close Editor' },
			{ command: 'workbench.action.closeFolder', label: 'Close Folder' },
			{ ...SEP, platform: 'other' },
			{ command: 'workbench.action.quit', label: 'Exit', platform: 'other' }
		]
	},
	{
		id: 'edit',
		label: '&Edit',
		items: [
			{ role: 'undo' },
			{ role: 'redo' },
			SEP,
			{ role: 'cut' },
			{ role: 'copy' },
			{ role: 'paste' },
			SEP,
			{ command: 'actions.find', label: 'Find', key: 'cmd+f' },
			{ command: 'editor.action.startFindReplaceAction', label: 'Replace', key: 'ctrl+h', mac: 'cmd+alt+f' },
			SEP,
			{ command: 'workbench.action.findInFiles', label: 'Find in Files' }
		]
	},
	{
		id: 'selection',
		label: '&Selection',
		items: [
			{ role: 'selectAll' },
			{ command: 'editor.action.smartSelect.expand', label: 'Expand Selection', key: 'shift+alt+right', mac: 'ctrl+shift+cmd+right' },
			{ command: 'editor.action.smartSelect.shrink', label: 'Shrink Selection', key: 'shift+alt+left', mac: 'ctrl+shift+cmd+left' }
		]
	},
	{
		id: 'view',
		label: '&View',
		items: [
			{ command: 'workbench.action.showCommands', label: 'Command Palette...' },
			{ command: 'workbench.action.openView', label: 'Open View...' },
			SEP,
			{
				submenu: 'appearance',
				label: 'Appearance',
				items: [
					{ command: 'workbench.action.toggleSidebarVisibility', label: 'Primary Side Bar', toggle: true },
					{ command: 'workbench.action.toggleAuxiliaryBar', label: 'Secondary Side Bar', toggle: true },
					{ command: 'workbench.action.togglePanel', label: 'Panel', toggle: true },
					{ command: 'workbench.action.toggleZenMode', label: 'Zen Mode', toggle: true },
					{ command: 'workbench.action.customizeLayout', label: 'Customize Layout...' },
					SEP,
					{ command: 'workbench.action.zoomIn', label: 'Zoom In' },
					{ command: 'workbench.action.zoomOut', label: 'Zoom Out' },
					{ command: 'workbench.action.zoomReset', label: 'Reset Zoom' },
					SEP,
					{ command: 'workbench.action.selectTheme', label: 'Color Theme' }
				]
			},
			SEP,
			{ command: 'workbench.view.explorer', label: 'Explorer' },
			{ command: 'workbench.view.scm', label: 'Source Control' },
			{ command: 'workbench.actions.view.problems', label: 'Problems' },
			SEP,
			{ command: 'workbench.action.splitEditor', label: 'Split Editor' }
		]
	},
	{
		id: 'go',
		label: '&Go',
		items: [
			{ command: 'workbench.action.navigateBack', label: 'Back' },
			{ command: 'workbench.action.navigateForward', label: 'Forward' },
			SEP,
			{ command: 'workbench.action.quickOpen', label: 'Go to File...' },
			{ command: 'workbench.action.gotoLine', label: 'Go to Line/Column...' },
			SEP,
			{ command: 'editor.action.revealDefinition', label: 'Go to Definition', key: 'f12' }
		]
	},
	{
		id: 'agents',
		label: '&Agents',
		items: [
			{ command: 'kingu.agents.newTask', label: 'New Task' },
			{ command: 'kingu.agents.show', label: 'Show Agents' },
			{ command: 'kingu.agents.openBoard', label: 'Board' },
			SEP,
			{ command: 'workbench.action.toggleAgentsMode', label: 'Open in Agents', checkedLabel: 'Open in Editor' },
			SEP,
			{ command: 'kingu.agents.nextAttention', label: 'Next Task Needing Attention' }
		]
	},
	{
		id: 'terminal',
		label: '&Terminal',
		items: [{ command: 'workbench.action.terminal.toggleTerminal', label: 'Toggle Terminal' }]
	},
	{
		id: 'window',
		label: 'Window',
		platform: 'mac',
		items: [{ role: 'minimize' }, { role: 'zoom' }, SEP, { role: 'fullscreen' }, SEP, { role: 'bringAllToFront' }]
	},
	{
		id: 'help',
		label: '&Help',
		items: [
			{ command: 'kingu.welcome.show', label: 'Welcome' },
			{ command: 'workbench.action.openGlobalKeybindings', label: 'Keyboard Shortcuts' },
			SEP,
			{ command: 'workbench.action.showAboutDialog', label: 'About Kingu' }
		]
	}
];

/** `&File` → text `File`, mnemonic `f` at index 0. `&&` is a literal `&`. */
export function parseMnemonic(label: string): { text: string; mnemonic: string | null; index: number } {
	let text = '';
	let index = -1;
	for (let i = 0; i < label.length; i++) {
		if (label[i] === '&' && label[i + 1] === '&') {
			text += '&';
			i++;
		} else if (label[i] === '&' && index < 0 && i + 1 < label.length) index = text.length;
		else text += label[i];
	}
	return { text, mnemonic: index >= 0 ? text[index].toLowerCase() : null, index };
}

// --- Resolved menu: what the renderers draw ----------------------------------------------------

/** One node of the resolved menu. This JSON shape is what Rust's `menu::MenuNode` deserializes. */
export type MenuNode =
	| {
			type: 'item';
			/** Command id, or `recent:<path>` for an Open Recent folder. Sent back on click. */
			id: string;
			text: string;
			/** Native accelerator (`Shift+Cmd+P`), absent for two-part chords. */
			accelerator?: string;
			/** Display label of the keybinding (`⇧⌘P`, `Ctrl+K Ctrl+T`). */
			keyLabel?: string;
			enabled: boolean;
			/** Present for toggles (a check item). */
			checked?: boolean;
	  }
	| { type: 'role'; role: Role; text: string; keyLabel?: string }
	| { type: 'separator' }
	| { type: 'submenu'; id: string; text: string; mnemonic?: number; items: MenuNode[] };

export type RecentFolder = { path: string; label: string; detail?: string };

export type MenuContext = {
	mac: boolean;
	/** The command's keybinding on this platform; undefined when it has none (or is not registered). */
	keyOf: (command: string) => string | undefined;
	enabled: (command: string) => boolean;
	checked: (command: string) => boolean;
	recent: RecentFolder[];
};

export const RECENT_PREFIX = 'recent:';
export const MAX_RECENT_IN_MENU = 10;

const onPlatform = (x: Only, mac: boolean) => !x.platform || x.platform === (mac ? 'mac' : 'other');

function keyInfo(key: string | undefined, mac: boolean): { accelerator?: string; keyLabel?: string } {
	if (!key) return {};
	const accelerator = toAccelerator(key, mac) ?? undefined;
	return { accelerator, keyLabel: keyLabel(key, mac) };
}

function resolveItems(items: MenuItem[], ctx: MenuContext): MenuNode[] {
	const out: MenuNode[] = [];
	for (const item of items) {
		if (!onPlatform(item, ctx.mac)) continue;
		if ('separator' in item) out.push({ type: 'separator' });
		else if ('role' in item) {
			const info = ROLES[item.role];
			const key = (ctx.mac ? info.mac : undefined) ?? info.key;
			out.push({ type: 'role', role: item.role, text: item.label ?? info.label, keyLabel: key ? keyLabel(key, ctx.mac) : undefined });
		} else if ('submenu' in item) {
			const { text } = parseMnemonic(item.label);
			out.push({ type: 'submenu', id: item.submenu, text, items: resolveItems(item.items, ctx) });
		} else if ('recent' in item) out.push(...recentItems(ctx));
		else {
			const key = (ctx.mac ? item.mac : undefined) ?? item.key ?? ctx.keyOf(item.command);
			const text = item.checkedLabel && ctx.checked(item.command) ? item.checkedLabel : item.label;
			const node: MenuNode = { type: 'item', id: item.command, text, ...keyInfo(key, ctx.mac), enabled: ctx.enabled(item.command) };
			if (item.toggle) node.checked = ctx.checked(item.command);
			out.push(node);
		}
	}
	return tidySeparators(out);
}

/** VS Code's File > Open Recent: folders, then More… and Clear Recently Opened. */
function recentItems(ctx: MenuContext): MenuNode[] {
	const folders: MenuNode[] = ctx.recent.slice(0, MAX_RECENT_IN_MENU).map((f) => ({
		type: 'item',
		id: RECENT_PREFIX + f.path,
		text: f.detail ? `${f.label}  ${f.detail}` : f.label,
		enabled: true
	}));
	const more = ctx.keyOf('workbench.action.openRecent');
	return [
		...folders,
		{ type: 'separator' },
		{ type: 'item', id: 'workbench.action.openRecent', text: 'More...', ...keyInfo(more, ctx.mac), enabled: ctx.enabled('workbench.action.openRecent') },
		{ type: 'separator' },
		{ type: 'item', id: 'workbench.action.clearRecentFiles', text: 'Clear Recently Opened', enabled: ctx.recent.length > 0 && ctx.enabled('workbench.action.clearRecentFiles') }
	];
}

/** No leading, trailing or doubled separators once platform items are filtered out. */
function tidySeparators(nodes: MenuNode[]): MenuNode[] {
	const out: MenuNode[] = [];
	for (const n of nodes) {
		if (n.type === 'separator' && (out.length === 0 || out[out.length - 1].type === 'separator')) continue;
		out.push(n);
	}
	while (out.length && out[out.length - 1].type === 'separator') out.pop();
	return out;
}

/** The menu bar for this platform: one submenu node per top-level menu. */
export function resolveMenubar(ctx: MenuContext, menus: Menu[] = MENUS): Extract<MenuNode, { type: 'submenu' }>[] {
	return menus
		.filter((m) => onPlatform(m, ctx.mac))
		.map((m) => {
			const { text, index } = parseMnemonic(m.label);
			return { type: 'submenu', id: m.id, text, mnemonic: index >= 0 ? index : undefined, items: resolveItems(m.items, ctx) };
		});
}

/** Every item node, depth first (for state diffs and tests). */
export function flattenItems(nodes: MenuNode[]): Extract<MenuNode, { type: 'item' }>[] {
	return nodes.flatMap((n) => (n.type === 'item' ? [n] : n.type === 'submenu' ? flattenItems(n.items) : []));
}

/** Enabled/checked per item id, for pushing changes without rebuilding the native menu. */
export function itemStates(nodes: MenuNode[]): Map<string, { enabled: boolean; checked?: boolean }> {
	const states = new Map<string, { enabled: boolean; checked?: boolean }>();
	for (const n of flattenItems(nodes)) states.set(n.id, { enabled: n.enabled, checked: n.checked });
	return states;
}

/** The menu without its enabled/checked state: a change here needs a rebuild. */
export function structureKey(nodes: MenuNode[]): string {
	return JSON.stringify(nodes, (k, v) => (k === 'enabled' || k === 'checked' ? undefined : v));
}

/** Command ids referenced by the model (all platforms). */
export function menuCommands(menus: Menu[] = MENUS): string[] {
	const ids = new Set<string>();
	const walk = (items: MenuItem[]) => {
		for (const i of items) {
			if ('command' in i) ids.add(i.command);
			if ('submenu' in i) walk(i.items);
			if ('recent' in i) ['workbench.action.openRecent', 'workbench.action.clearRecentFiles'].forEach((id) => ids.add(id));
		}
	};
	menus.forEach((m) => walk(m.items));
	return [...ids];
}
