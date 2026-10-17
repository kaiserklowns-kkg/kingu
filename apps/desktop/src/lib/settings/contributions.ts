// Preferences commands (VS Code: preferences.contribution.ts, themes.contribution.ts, zoom actions).

import { commands } from '#lib/workbench/commands.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { quick, type PickItem } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { theme } from '#lib/theme/theme.svelte.ts';
import { findTheme, THEMES } from '#lib/theme/themes.ts';
import { SCHEMA } from './registry';
import { settings, USER_SETTINGS_KEY, WORKSPACE_SETTINGS_PATH } from './settings.svelte';
import { systemSettings } from './systemSettings.svelte';

const GROUPS: Record<string, string> = { light: 'light themes', dark: 'dark themes', hcDark: 'high contrast themes', hcLight: 'high contrast themes' };

const report = (e: unknown) => status.flash(`บันทึกการตั้งค่าไม่สำเร็จ: ${e instanceof Error ? e.message : e}`);

/** Preferences: Color Theme — arrow keys preview, Enter keeps, Escape restores (like VS Code). */
export function pickColorTheme() {
	const original = settings.get<string>('workbench.colorTheme');
	let lastGroup = '';
	const items: PickItem[] = THEMES.map((t) => {
		const group = GROUPS[t.type];
		const separator = group !== lastGroup ? group : undefined;
		lastGroup = group;
		return { id: t.id, label: t.label, separator };
	});
	quick.pick({
		placeholder: 'เลือกธีมสี (ลูกศรขึ้น/ลงเพื่อดูตัวอย่าง) — Select Color Theme',
		items,
		activeId: findTheme(original).id,
		onActive: (item) => void theme.apply(item.id),
		onAccept: (item) => {
			void theme.apply(item.id);
			settings.set('workbench.colorTheme', item.id === SCHEMA.get('workbench.colorTheme')?.default ? undefined : item.id, 'user').catch(report);
		},
		onCancel: () => void theme.apply(original)
	});
}

function zoom(delta: number | null) {
	const level = settings.get<number>('window.zoomLevel');
	const next = delta === null ? 0 : Math.max(-8, Math.min(8, level + delta));
	settings.set('window.zoomLevel', next === 0 ? undefined : next, 'user').catch(report);
}

export function registerSettingsCommands(): () => void {
	const all = [
		commands.register({
			id: 'workbench.action.openSettings',
			title: 'Open Settings (UI)',
			category: 'Preferences',
			key: 'cmd+,',
			run: () => systemSettings.show()
		}),
		commands.register({
			id: 'workbench.action.openSettingsJson',
			title: 'Open User Settings (JSON)',
			category: 'Preferences',
			run: () => (systemSettings.close(), editors.open(USER_SETTINGS_KEY, { preview: false }))
		}),
		commands.register({
			id: 'workbench.action.openWorkspaceSettingsFile',
			title: 'Open Workspace Settings (JSON)',
			category: 'Preferences',
			// Workspace settings live in the open folder.
			when: () => workspace.root !== null,
			run: async () => {
				await settings.ensureFile('workspace');
				systemSettings.close();
				editors.open(WORKSPACE_SETTINGS_PATH, { preview: false });
			}
		}),
		commands.register({ id: 'workbench.action.selectTheme', title: 'Color Theme', category: 'Preferences', key: 'cmd+k cmd+t', run: pickColorTheme }),
		commands.register({ id: 'workbench.action.zoomIn', title: 'Zoom In', category: 'View', key: 'cmd+=', run: () => zoom(1) }),
		commands.register({ id: 'workbench.action.zoomOut', title: 'Zoom Out', category: 'View', key: 'cmd+-', run: () => zoom(-1) }),
		commands.register({ id: 'workbench.action.zoomReset', title: 'Reset Zoom', category: 'View', key: 'cmd+0', run: () => zoom(null) })
	];
	return () => all.forEach((u) => u());
}
