// Layout and title bar commands (VS Code: layoutActions.ts — Customize Layout…, the title bar
// context menu toggles). Settings are written to the user settings.json, so they apply live.

import { untrack } from 'svelte';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { settings } from '#lib/settings/settings.svelte.ts';
import { commands } from './commands.svelte';
import { EDITOR_LAYOUTS } from './editorGroups';
import { editors } from './editors.svelte';
import { editorKeyFor } from './externalFiles';
import { workspace } from './workspace.svelte';
import { isMac } from './keys';
import { menuBarToggled } from './workbenchOptions';
import { layout } from './layout.svelte';
import { panelSize } from './panelSize.svelte';
import { appMode } from './mode.svelte';
import { quick, type PickItem } from './quick.svelte';
import { status } from './status.svelte';
import { TITLE_BAR_TOGGLES, toggleChecked } from './titlebar';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { t } from '#lib/i18n/index.ts';

export function setUserSetting(id: string, value: unknown) {
	settings.set(id, value, 'user').catch((e) => notifications.error(t('workbench.layoutControls.saveFailed', { id, error: String(e) })));
}

function toggleSetting(id: string) {
	const value = settings.get(id);
	if (id === 'kingu.agentsControl.enabled') setUserSetting(id, value === 'hidden' ? 'compact' : 'hidden');
	else setUserSetting(id, !value);
}

type Choice = { id: string; label: string; checked: () => boolean; run: () => void; section: string };

function choices(): Choice[] {
	const setting = (section: string, id: string, values: [string, string][]): Choice[] =>
		values.map(([value, label]) => ({
			id: `${id}=${value}`,
			label,
			section,
			checked: () => settings.get(id) === value,
			run: () => setUserSetting(id, value)
		}));
	return [
		{ id: 'sidebar', label: 'Primary Side Bar', section: 'Visibility', checked: () => layout.sidebarVisible, run: () => (layout.sidebarVisible = !layout.sidebarVisible) },
		{ id: 'aux', label: 'Secondary Side Bar (Agent)', section: 'Visibility', checked: () => layout.auxVisible, run: () => (layout.auxVisible = !layout.auxVisible) },
		{ id: 'panel', label: 'Panel', section: 'Visibility', checked: () => layout.panelVisible, run: () => (layout.panelVisible = !layout.panelVisible) },
		...TITLE_BAR_TOGGLES.map((t) => ({
			id: t.command,
			label: t.label,
			section: 'Visibility',
			checked: () => toggleChecked(settings.get(t.setting)),
			run: () => toggleSetting(t.setting)
		})),
		...setting('Primary Side Bar Position', 'workbench.sideBar.location', [
			['left', 'Left'],
			['right', 'Right']
		]),
		...setting('Panel Position', 'workbench.panel.defaultLocation', [
			['bottom', 'Bottom'],
			['top', 'Top'],
			['left', 'Left'],
			['right', 'Right']
		]),
		...setting('Panel Alignment', 'workbench.panel.alignment', [
			['center', 'Center'],
			['justify', 'Justify'],
			['left', 'Left'],
			['right', 'Right']
		]),
		...setting('Activity Bar Position', 'workbench.activityBar.location', [
			['default', 'Default'],
			['top', 'Top'],
			['bottom', 'Bottom'],
			['hidden', 'Hidden']
		]),
		// VS Code's Customize Layout "Quick Input Position" section.
		{ id: 'quickInputTop', label: 'Top', section: 'Quick Input Position', checked: () => quick.alignment === 'top', run: () => quick.setAlignment('top') },
		{ id: 'quickInputCenter', label: 'Center', section: 'Quick Input Position', checked: () => quick.alignment === 'center', run: () => quick.setAlignment('center') },
		// VS Code's Customize Layout "Modes" section.
		{ id: 'centered', label: 'Centered Layout', section: 'Modes', checked: () => layout.centered, run: () => (layout.centered = !layout.centered) },
		{ id: 'fullscreen', label: 'Full Screen', section: 'Modes', checked: () => layout.fullscreen, run: () => void layout.setFullScreen(!layout.fullscreen) },
		{ id: 'zen', label: 'Zen Mode', section: 'Modes', checked: () => layout.zen, run: () => layout.toggleZen() }
	];
}

/** Customize Layout…: a quick pick that stays open while toggling, like VS Code's. */
export function customizeLayout(activeId?: string) {
	const all = choices();
	const items: PickItem[] = all.map((c, i) => ({
		id: c.id,
		label: `${c.checked() ? '✓' : ' '} ${c.label}`,
		separator: i === 0 || all[i - 1].section !== c.section ? c.section : undefined
	}));
	quick.pick({
		placeholder: t('workbench.layoutControls.placeholder'),
		items,
		activeId,
		onAccept: (item) => {
			all.find((c) => c.id === item.id)?.run();
			// Re-open after the setting write lands, so the check marks are current.
			setTimeout(() => customizeLayout(item.id), 60);
		}
	});
}

const ide = () => !appMode.isAgents;

type Part = 'editor' | 'panel' | 'auxiliarybar' | 'statusbar' | 'activitybar' | 'sidebar';
/** VS Code's Focus Next Part order (navigationActions.ts findVisibleNeighbour). */
const PART_ORDER: Part[] = ['editor', 'panel', 'auxiliarybar', 'statusbar', 'activitybar', 'sidebar'];
const partRoot = (part: Part) => document.querySelector<HTMLElement>(`[data-part="${part}"], .part.${part}`);
const partShown = (part: Part) => {
	const el = partRoot(part);
	return !!el && el.offsetParent !== null && el.getClientRects().length > 0;
};

/** Focus Next / Previous Part (F6 / ⇧F6): the next visible part after the focused one, the editor when none has focus. */
function focusNeighbourPart(step: 1 | -1) {
	const active = document.activeElement;
	const current = PART_ORDER.find((p) => partRoot(p)?.contains(active)) ?? null;
	let next: Part = 'editor';
	if (current) {
		let i = PART_ORDER.indexOf(current);
		for (let n = 0; n < PART_ORDER.length; n++) {
			i = (i + step + PART_ORDER.length) % PART_ORDER.length;
			if (PART_ORDER[i] === 'editor' || partShown(PART_ORDER[i])) {
				next = PART_ORDER[i];
				break;
			}
		}
	}
	if (next === 'editor') editors.focusGroup(editors.activeGroupId);
	else focusPart(next, () => {});
}

/** VS Code's `statusBarFocused`: keyboard focus is on a status bar item. */
const statusBarFocused = () => !!document.activeElement?.closest('[data-part="statusbar"]');

/** Status bar keyboard navigation (statusbarActions.ts): previous / next item (wrapping), first, last. */
export function focusStatusBarItem(to: 'previous' | 'next' | 'first' | 'last') {
	const items = [...(partRoot('statusbar')?.querySelectorAll<HTMLElement>('button, a[href], [tabindex="0"]') ?? [])].filter((el) => el.offsetParent !== null && !(el as HTMLButtonElement).disabled);
	if (!items.length) return;
	const at = items.findIndex((el) => el === document.activeElement || el.contains(document.activeElement));
	const n = items.length;
	const i = to === 'first' ? 0 : to === 'last' ? n - 1 : at < 0 ? 0 : (at + (to === 'next' ? 1 : -1) + n) % n;
	items[i].focus();
}

/** Shows a part (`data-part` or VS Code's `.part.<name>` on its root) and moves focus into it: its tree or list, else its first input or button. */
function focusPart(part: Exclude<Part, 'editor'>, show: () => void) {
	show();
	const tryFocus = (tries: number) => {
		const root = document.querySelector<HTMLElement>(`[data-part="${part}"], .part.${part}`);
		const target = ['[role="tree"]', '[role="list"]', '[role="listbox"]', '.xterm-helper-textarea', 'input, textarea', 'button'].map((q) => root?.querySelector<HTMLElement>(q)).find(Boolean);
		if (target) target.focus();
		else if (tries > 0) setTimeout(() => tryFocus(tries - 1), 30);
	};
	queueMicrotask(() => tryFocus(10));
}

export function installLayoutCommands(): () => void {
	const unregister = [
		commands.register({ id: 'workbench.action.customizeLayout', title: 'Customize Layout...', category: 'View', run: () => customizeLayout() }),
		...TITLE_BAR_TOGGLES.map((t) =>
			commands.register({ id: t.command, title: `Toggle ${t.label}`, category: 'View', run: () => toggleSetting(t.setting) })
		),
		// Zen Mode (workbench.zenMode.contribution.ts): Escape twice leaves it.
		// Not while an input, menu or dialog has focus: their own Escape (close the quick pick) comes first.
		commands.register({
			id: 'workbench.action.exitZenMode',
			title: 'Exit Zen Mode',
			category: 'View',
			key: 'escape escape',
			keyWhen: () => !document.activeElement?.closest('input, select, [role="dialog"], [role="menu"], [role="listbox"]'),
			when: () => layout.zen,
			run: () => layout.toggleZen()
		}),
		commands.register({ id: 'workbench.action.zenHideEditorTabs', title: 'Hide Editor Tabs in Zen Mode', category: 'View', when: () => layout.zen, run: () => setUserSetting('zenMode.showTabs', 'none') }),
		commands.register({ id: 'workbench.action.zenShowMultipleEditorTabs', title: 'Show Multiple Editor Tabs in Zen Mode', category: 'View', when: () => layout.zen, run: () => setUserSetting('zenMode.showTabs', 'multiple') }),
		commands.register({ id: 'workbench.action.zenShowSingleEditorTab', title: 'Show Single Editor Tab in Zen Mode', category: 'View', when: () => layout.zen, run: () => setUserSetting('zenMode.showTabs', 'single') }),
		commands.register({ id: 'workbench.action.alignQuickInputTop', title: 'Align Quick Input Top', palette: false, run: () => quick.setAlignment('top') }),
		commands.register({ id: 'workbench.action.alignQuickInputCenter', title: 'Align Quick Input Center', palette: false, run: () => quick.setAlignment('center') }),
		// Close / focus the parts (VS Code's layoutActions.ts, sidebarActions.ts, panelActions.ts).
		commands.register({ id: 'workbench.action.closeSidebar', title: 'Close Primary Side Bar', category: 'View', when: () => ide() && layout.sidebarVisible, run: () => (layout.sidebarVisible = false) }),
		commands.register({ id: 'workbench.action.closePanel', title: 'Hide Panel', category: 'View', when: () => ide() && layout.panelVisible, run: () => (layout.panelVisible = false) }),
		commands.register({ id: 'workbench.action.closeAuxiliaryBar', title: 'Hide Secondary Side Bar', category: 'View', when: () => ide() && layout.auxVisible, run: () => (layout.auxVisible = false) }),
		// ⌘0 (VS Code's key; Reset Zoom is ⌘Numpad0).
		commands.register({ id: 'workbench.action.focusSideBar', title: 'Focus into Primary Side Bar', category: 'View', key: 'cmd+0', when: ide, run: () => focusPart('sidebar', () => (layout.sidebarVisible = true)) }),
		commands.register({ id: 'workbench.action.focusPanel', title: 'Focus into Panel', category: 'View', when: ide, run: () => focusPart('panel', () => (layout.panelVisible = true)) }),
		commands.register({ id: 'workbench.action.focusAuxiliaryBar', title: 'Focus into Secondary Side Bar', category: 'View', when: ide, run: () => focusPart('auxiliarybar', () => (layout.auxVisible = true)) }),
		commands.register({ id: 'workbench.action.moveSideBarLeft', title: 'Move Primary Side Bar Left', category: 'View', when: () => settings.get('workbench.sideBar.location') === 'right', run: () => setUserSetting('workbench.sideBar.location', 'left') }),
		commands.register({ id: 'workbench.action.moveSideBarRight', title: 'Move Primary Side Bar Right', category: 'View', when: () => settings.get('workbench.sideBar.location') !== 'right', run: () => setUserSetting('workbench.sideBar.location', 'right') }),
		commands.register({ id: 'workbench.files.action.focusFilesExplorer', title: 'Focus on Files Explorer', category: 'File', when: ide, run: () => focusPart('sidebar', () => ((layout.sideView = 'explorer'), (layout.sidebarVisible = true))) }),
		commands.register({
			id: 'workbench.action.openWorkspaceConfigFile',
			title: 'Open Workspace Configuration File',
			category: 'Workspaces',
			when: () => ide() && workspace.workspaceFile !== null,
			run: () => workspace.workspaceFile && editors.open(editorKeyFor(workspace.workspaceFile, workspace.root), { preview: false })
		}),
		// VS Code runs Toggle Maximized Panel for this: the panel takes the editor area, again restores it.
		commands.register({ id: 'workbench.action.toggleEditorVisibility', title: 'Toggle Editor Area Visibility', category: 'View', when: ide, run: () => panelSize.toggle() }),
		commands.register({ id: 'workbench.action.focusStatusBar', title: 'Focus Status Bar', category: 'View', when: () => settings.get<boolean>('workbench.statusBar.visible') !== false, run: () => focusPart('statusbar', () => {}) }),
		// ← / → (↑ / ↓ too, in StatusBar.svelte), Home / End and Escape while a status bar item has focus.
		commands.register({ id: 'workbench.statusBar.focusPrevious', title: 'Focus Previous Status Bar Item', category: 'View', key: 'left', palette: false, keyWhen: statusBarFocused, run: () => focusStatusBarItem('previous') }),
		commands.register({ id: 'workbench.statusBar.focusNext', title: 'Focus Next Status Bar Item', category: 'View', key: 'right', palette: false, keyWhen: statusBarFocused, run: () => focusStatusBarItem('next') }),
		commands.register({ id: 'workbench.statusBar.focusFirst', title: 'Focus First Status Bar Item', category: 'View', key: 'home', palette: false, keyWhen: statusBarFocused, run: () => focusStatusBarItem('first') }),
		commands.register({ id: 'workbench.statusBar.focusLast', title: 'Focus Last Status Bar Item', category: 'View', key: 'end', palette: false, keyWhen: statusBarFocused, run: () => focusStatusBarItem('last') }),
		commands.register({ id: 'workbench.statusBar.clearFocus', title: 'Clear Status Bar Focus', category: 'View', key: 'escape', palette: false, weight: 1, keyWhen: statusBarFocused, run: () => editors.focusGroup(editors.activeGroupId) }),
		// F6 / ⇧F6 (F6 pauses a running debug session first: workbench.action.debug.pause has the higher weight).
		commands.register({ id: 'workbench.action.focusNextPart', title: 'Focus Next Part', category: 'View', key: 'f6', when: ide, weight: -1, run: () => focusNeighbourPart(1) }),
		commands.register({ id: 'workbench.action.focusPreviousPart', title: 'Focus Previous Part', category: 'View', key: 'shift+f6', when: ide, run: () => focusNeighbourPart(-1) }),
		commands.register({
			id: 'workbench.action.toggleActivityBarVisibility',
			title: 'Toggle Activity Bar Visibility',
			category: 'View',
			when: ide,
			// VS Code: hidden ↔ the default position.
			run: () => setUserSetting('workbench.activityBar.location', settings.get('workbench.activityBar.location') === 'hidden' ? 'default' : 'hidden')
		}),
		commands.register({ id: 'workbench.action.toggleCenteredLayout', title: 'Toggle Centered Layout', category: 'View', when: ide, run: () => (layout.centered = !layout.centered) }),
		// F11 off macOS, like VS Code; Step Into shares it and wins while the debugger is stopped (weight).
		commands.register({ id: 'workbench.action.toggleFullScreen', title: 'Toggle Full Screen', category: 'View', key: 'f11', mac: 'ctrl+cmd+f', weight: -1, run: () => layout.setFullScreen(!layout.fullscreen) }),
		commands.register({ id: 'workbench.action.toggleStatusbarVisibility', title: 'Toggle Status Bar Visibility', category: 'View', run: () => toggleSetting('workbench.statusBar.visible') }),
		commands.register({
			id: 'workbench.action.toggleSidebarPosition',
			title: 'Toggle Primary Side Bar Position',
			category: 'View',
			run: () => setUserSetting('workbench.sideBar.location', settings.get('workbench.sideBar.location') === 'right' ? 'left' : 'right')
		}),
		...(['Bottom', 'Top', 'Left', 'Right'] as const).map((p) =>
			commands.register({ id: `workbench.action.positionPanel${p}`, title: `Move Panel ${p}`, category: 'View', run: () => setUserSetting('workbench.panel.defaultLocation', p.toLowerCase()) })
		),
		// Windows and Linux draw the menu bar in the title bar (macOS has the native one): VS Code's
		// Toggle Menu Bar switches window.menuBarVisibility between classic and compact.
		commands.register({
			id: 'workbench.action.toggleMenuBar',
			title: 'Toggle Menu Bar',
			category: 'View',
			when: () => !isMac,
			run: () => setUserSetting('window.menuBarVisibility', menuBarToggled(settings.get<string>('window.menuBarVisibility')))
		}),
		// Editor layouts (VS Code's editorActions.ts EditorLayout*Action).
		commands.register({ id: 'workbench.action.editorLayoutSingle', title: 'Single Column Editor Layout', category: 'View', when: ide, run: () => editors.applyLayout(EDITOR_LAYOUTS.editorLayoutSingle) }),
		commands.register({ id: 'workbench.action.editorLayoutTwoColumns', title: 'Two Columns Editor Layout', category: 'View', when: ide, run: () => editors.applyLayout(EDITOR_LAYOUTS.editorLayoutTwoColumns) }),
		commands.register({ id: 'workbench.action.editorLayoutThreeColumns', title: 'Three Columns Editor Layout', category: 'View', when: ide, run: () => editors.applyLayout(EDITOR_LAYOUTS.editorLayoutThreeColumns) }),
		commands.register({ id: 'workbench.action.editorLayoutTwoRows', title: 'Two Rows Editor Layout', category: 'View', when: ide, run: () => editors.applyLayout(EDITOR_LAYOUTS.editorLayoutTwoRows) }),
		commands.register({ id: 'workbench.action.editorLayoutThreeRows', title: 'Three Rows Editor Layout', category: 'View', when: ide, run: () => editors.applyLayout(EDITOR_LAYOUTS.editorLayoutThreeRows) }),
		commands.register({ id: 'workbench.action.editorLayoutTwoByTwoGrid', title: 'Grid Editor Layout (2x2)', category: 'View', when: ide, run: () => editors.applyLayout(EDITOR_LAYOUTS.editorLayoutTwoByTwoGrid) }),
		commands.register({ id: 'workbench.action.editorLayoutTwoColumnsBottom', title: 'Two Columns Bottom Editor Layout', category: 'View', when: ide, run: () => editors.applyLayout(EDITOR_LAYOUTS.editorLayoutTwoColumnsBottom) }),
		commands.register({ id: 'workbench.action.editorLayoutTwoRowsRight', title: 'Two Rows Right Editor Layout', category: 'View', when: ide, run: () => editors.applyLayout(EDITOR_LAYOUTS.editorLayoutTwoRowsRight) }),
		commands.register({ id: 'workbench.action.toggleEditorGroupLayout', title: 'Toggle Vertical/Horizontal Editor Layout', category: 'View', key: 'cmd+alt+0', when: ide, run: () => editors.flipLayout() }),
		commands.register({ id: 'workbench.action.joinAllGroups', title: 'Combine All Editor Groups', category: 'View', when: () => ide() && editors.groups.length > 1, run: () => editors.joinAllGroups() }),
		commands.register({ id: 'workbench.action.evenEditorWidths', title: 'Reset Editor Group Sizes', category: 'View', when: () => ide() && editors.groups.length > 1, run: () => editors.evenAll() })
	];
	// Native full screen can also be entered and left from the window's green button or the Window menu.
	let gone = false;
	let unlisten: (() => void) | undefined;
	try {
		const win = getCurrentWindow();
		const sync = () => win.isFullscreen().then((on) => layout.fullscreenChanged(on), () => {});
		void sync();
		void win.onResized(() => void sync()).then((u) => (gone ? u() : (unlisten = u)), () => {});
	} catch {
		// Not in a Tauri window (tests).
	}
	// zenMode.restore needs the settings, which load after the layout's saved state.
	const stopRestore = $effect.root(() => {
		let done = false;
		$effect(() => {
			if (done || !settings.loaded) return;
			done = true;
			untrack(() => layout.restoreZen());
		});
	});
	return () => {
		gone = true;
		unlisten?.();
		stopRestore();
		unregister.forEach((u) => u());
	};
}

/** Checked state of the title bar toggles, for the context menu. */
export const titleBarToggleChecked = (command: string) => {
	const t = TITLE_BAR_TOGGLES.find((x) => x.command === command);
	return t ? toggleChecked(settings.get(t.setting)) : false;
};
