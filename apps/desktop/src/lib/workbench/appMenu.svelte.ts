// Live side of the application menu (menus.ts): resolves the model against the command registry
// and workbench state, keeps the native macOS menu in sync, and runs clicked items.
//
// Keyboard ownership: the webview's capture-phase keybinding listener (commands.svelte.ts) is the
// only executor of keybindings. The native menu binds the same accelerators so they show, but
// WKWebView hands key equivalents to the page first and AppKit only tries the menu when the page
// did not preventDefault, so a chord the listener ran never also fires the menu item. Should both
// ever fire, `commands.runFromMenu` drops the menu event as an echo of the key (MENU_ECHO_MS).

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { clientLog } from '#lib/client-log.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { commands, keyOf } from './commands.svelte';
import { editors } from './editors.svelte';
import { isMac } from './keys';
import { layout } from './layout.svelte';
import { appMode } from './mode.svelte';
import { itemStates, RECENT_PREFIX, resolveMenubar, structureKey, type MenuNode, type Role } from './menus';
import { workspace } from './workspace.svelte';

const CHECKED: Record<string, () => boolean> = {
	'workbench.action.toggleSidebarVisibility': () => layout.sidebarVisible,
	'workbench.action.toggleAuxiliaryBar': () => layout.auxVisible,
	'workbench.action.togglePanel': () => layout.panelVisible,
	'workbench.action.toggleZenMode': () => layout.zen,
	'workbench.action.toggleCenteredLayout': () => layout.centered,
	'workbench.action.toggleFullScreen': () => layout.fullscreen,
	'workbench.action.toggleStatusbarVisibility': () => settings.get<boolean>('workbench.statusBar.visible'),
	'workbench.action.toggleMenuBar': () => ['classic', 'visible'].includes(settings.get<string>('window.menuBarVisibility')),
	// Not a check mark: the item reads "Move Primary Side Bar Left" while it is on the right.
	'workbench.action.toggleSidebarPosition': () => settings.get<string>('workbench.sideBar.location') === 'right',
	// Not a check mark: the Agents menu item reads "Open in Editor" while in Agents mode.
	'workbench.action.toggleAgentsMode': () => appMode.isAgents
};

/** The menu bar as it should look now (reactive: reads commands, `when` state and layout). */
export function currentMenubar(mac = isMac) {
	return resolveMenubar({
		mac,
		keyOf: (id) => {
			const cmd = commands.get(id);
			return cmd ? keyOf(cmd, mac) : undefined;
		},
		enabled: (id) => commands.enabled(id),
		checked: (id) => CHECKED[id]?.() ?? false,
		recent: workspace.recentFolders()
	});
}

/** A click on a menu item (native or in-window). */
export function runMenuItem(id: string) {
	if (id.startsWith(RECENT_PREFIX)) void workspace.openFolder(id.slice(RECENT_PREFIX.length));
	else void commands.runFromMenu(id);
}

const EDITOR_ROLE_ACTIONS: Partial<Record<Role, string>> = {
	undo: 'undo',
	redo: 'redo',
	cut: 'editor.action.clipboardCutAction',
	copy: 'editor.action.clipboardCopyAction',
	paste: 'editor.action.clipboardPasteAction',
	selectAll: 'editor.action.selectAll'
};

/** Edit roles of the in-window menu bar (macOS runs them natively): Monaco's own actions in the
 * editor, the browser's editing commands in inputs and the terminal. */
export async function runRole(role: Role) {
	const inEditor = document.activeElement?.closest('.monaco-editor');
	const action = EDITOR_ROLE_ACTIONS[role];
	if (inEditor && action && editors.trigger(action)) return;
	if (role === 'quit') return void commands.run('workbench.action.quit');
	if (role === 'paste') {
		const text = await navigator.clipboard.readText().catch(() => '');
		if (text) document.execCommand('insertText', false, text);
		return;
	}
	if (action) document.execCommand(role);
}

/** macOS: builds the native menu bar and keeps it current. Returns the uninstaller. */
export function installNativeMenu(): () => void {
	if (!isMac) return () => {};
	let unlisten: (() => void) | undefined;
	let gone = false;
	listen<string>('menu://command', (e) => runMenuItem(e.payload))
		.then((u) => (gone ? u() : (unlisten = u)))
		.catch(() => {});

	let lastKey = '';
	let lastStates = new Map<string, { enabled: boolean; checked?: boolean }>();
	const report = (what: string) => (e: unknown) => clientLog('error', `${what}: ${e}`);
	const stopEffect = $effect.root(() => {
		$effect(() => {
			const nodes: MenuNode[] = currentMenubar(true);
			const key = structureKey(nodes);
			const states = itemStates(nodes);
			if (key !== lastKey) {
				lastKey = key;
				void invoke('menu_set_model', { model: nodes }).catch(report('menu_set_model'));
			} else {
				// Same items: only push what changed instead of rebuilding the menu.
				for (const [id, s] of states) {
					const prev = lastStates.get(id);
					if (prev?.enabled !== s.enabled) void invoke('menu_set_enabled', { id, enabled: s.enabled }).catch(report('menu_set_enabled'));
					if (s.checked !== undefined && prev?.checked !== s.checked) void invoke('menu_set_checked', { id, checked: s.checked }).catch(report('menu_set_checked'));
				}
			}
			lastStates = states;
		});
	});
	return () => {
		gone = true;
		unlisten?.();
		stopEffect();
	};
}
