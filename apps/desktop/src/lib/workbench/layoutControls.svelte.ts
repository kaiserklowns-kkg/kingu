// Layout and title bar commands (VS Code: layoutActions.ts — Customize Layout…, the title bar
// context menu toggles). Settings are written to the user settings.json, so they apply live.

import { settings } from '#lib/settings/settings.svelte.ts';
import { commands } from './commands.svelte';
import { layout } from './layout.svelte';
import { quick, type PickItem } from './quick.svelte';
import { status } from './status.svelte';
import { TITLE_BAR_TOGGLES, toggleChecked } from './titlebar';
import { notifications } from '#lib/workbench/notifications.svelte.ts';

export function setUserSetting(id: string, value: unknown) {
	settings.set(id, value, 'user').catch((e) => notifications.error(`บันทึกการตั้งค่า ${id} ไม่ได้: ${e}`));
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
		])
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
		placeholder: 'Customize Layout — เลือกเพื่อเปิด/ปิดหรือย้ายตำแหน่ง (Esc เพื่อปิด)',
		items,
		activeId,
		onAccept: (item) => {
			all.find((c) => c.id === item.id)?.run();
			// Re-open after the setting write lands, so the check marks are current.
			setTimeout(() => customizeLayout(item.id), 60);
		}
	});
}

export function installLayoutCommands(): () => void {
	const unregister = [
		commands.register({ id: 'workbench.action.customizeLayout', title: 'Customize Layout...', category: 'View', run: () => customizeLayout() }),
		...TITLE_BAR_TOGGLES.map((t) =>
			commands.register({ id: t.command, title: `Toggle ${t.label}`, category: 'View', run: () => toggleSetting(t.setting) })
		)
	];
	return () => unregister.forEach((u) => u());
}

/** Checked state of the title bar toggles, for the context menu. */
export const titleBarToggleChecked = (command: string) => {
	const t = TITLE_BAR_TOGGLES.find((x) => x.command === command);
	return t ? toggleChecked(settings.get(t.setting)) : false;
};
