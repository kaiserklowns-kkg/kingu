// Layout and title bar commands (VS Code: layoutActions.ts — Customize Layout…, the title bar
// context menu toggles). Settings are written to the user settings.json, so they apply live.

import { untrack } from 'svelte';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { settings } from '#lib/settings/settings.svelte.ts';
import { commands } from './commands.svelte';
import { EDITOR_LAYOUTS } from './editorGroups';
import { editors } from './editors.svelte';
import { isMac } from './keys';
import { menuBarToggled } from './workbenchOptions';
import { layout } from './layout.svelte';
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
