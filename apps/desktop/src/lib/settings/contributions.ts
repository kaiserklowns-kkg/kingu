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
import { USER_KEYBINDINGS_KEY } from '#lib/workbench/keybindings.svelte.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { themeSettingFor } from '#lib/workbench/workbenchOptions.ts';
import { t } from '#lib/i18n/index.ts';

const groupOf = (type: string) => (type === 'light' ? t('settings.contributions.lightThemes') : type === 'dark' ? t('settings.contributions.darkThemes') : t('settings.contributions.highContrastThemes'));

const report = (e: unknown) => notifications.error(t('settings.contributions.saveFailed', { error: String(e instanceof Error ? e.message : e) }));

/** Preferences: Color Theme — arrow keys preview, Enter keeps, Escape restores (like VS Code).
 * With window.autoDetectColorScheme (or high contrast detection) on, the pick sets the preferred theme in effect. */
export function pickColorTheme() {
	const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
	const highContrast = window.matchMedia?.('(prefers-contrast: more), (forced-colors: active)').matches ?? false;
	const target = themeSettingFor({
		autoDetectHighContrast: settings.get<boolean>('window.autoDetectHighContrast'),
		autoDetectColorScheme: settings.get<boolean>('window.autoDetectColorScheme'),
		highContrast,
		prefersDark: dark
	});
	const original = settings.get<string>(target);
	let lastGroup = '';
	const items: PickItem[] = THEMES.map((th) => {
		const group = groupOf(th.type);
		const separator = group !== lastGroup ? group : undefined;
		lastGroup = group;
		return { id: th.id, label: th.label, separator };
	});
	quick.pick({
		placeholder: t('settings.contributions.themePlaceholder'),
		items,
		activeId: findTheme(original).id,
		onActive: (item) => void theme.apply(item.id),
		onAccept: (item) => {
			void theme.apply(item.id);
			settings.set(target, item.id === SCHEMA.get(target)?.default ? undefined : item.id, 'user').catch(report);
		},
		onCancel: () => void theme.apply(original)
	});
}

function zoom(delta: number | null) {
	const level = settings.get<number>('window.zoomLevel');
	const next = delta === null ? 0 : Math.max(-8, Math.min(8, level + delta));
	settings.set('window.zoomLevel', next === 0 ? undefined : next, 'user').catch(report);
}

/** Configure Language Specific Settings…: a language, then the user settings.json with its
 * `"[language]": {}` block added when missing (VS Code opens the settings editor at `@lang:`). */
async function configureLanguageSettings() {
	const { monaco } = await import('#lib/editor/monaco.ts');
	const current = editors.language;
	const items: PickItem[] = monaco.languages
		.getLanguages()
		.map((l) => ({ id: l.id, label: l.aliases?.[0] ?? l.id, description: `(${l.id})` }))
		.sort((a, b) => (a.id === current ? -1 : b.id === current ? 1 : a.label.localeCompare(b.label)));
	const pick = await quick.choose({ placeholder: t('settings.languageBlock.placeholder'), items });
	if (!pick) return;
	const key = `[${pick.id}]`;
	try {
		if (settings.inspect(key, 'user') === undefined) await settings.set(key, {}, 'user');
	} catch (e) {
		notifications.error(String(e));
		return;
	}
	systemSettings.close();
	editors.open(USER_SETTINGS_KEY, { preview: false });
}

export function registerSettingsCommands(): () => void {
	const all = [
		commands.register({
			id: 'workbench.action.openSettings',
			title: 'Open Settings (UI)',
			category: 'Preferences',
			key: 'cmd+,',
			// workbench.settings.editor: the settings page, or settings.json like VS Code's JSON editor.
			run: () => (settings.get('workbench.settings.editor') === 'json' ? commands.run('workbench.action.openSettingsJson') : systemSettings.show())
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
		commands.register({
			id: 'workbench.action.configureLanguageBasedSettings',
			title: 'Configure Language Specific Settings...',
			category: 'Preferences',
			run: configureLanguageSettings
		}),
		commands.register({
			id: 'workbench.action.openGlobalKeybindingsFile',
			title: 'Open Keyboard Shortcuts (JSON)',
			category: 'Preferences',
			run: () => (systemSettings.close(), editors.open(USER_KEYBINDINGS_KEY, { preview: false }))
		}),
		commands.register({ id: 'workbench.action.selectTheme', title: 'Color Theme', category: 'Preferences', key: 'cmd+k cmd+t', run: pickColorTheme }),
		commands.register({ id: 'workbench.action.zoomIn', title: 'Zoom In', category: 'View', key: 'cmd+=', run: () => zoom(1) }),
		commands.register({ id: 'workbench.action.zoomOut', title: 'Zoom Out', category: 'View', key: 'cmd+-', run: () => zoom(-1) }),
		commands.register({ id: 'workbench.action.zoomReset', title: 'Reset Zoom', category: 'View', key: 'cmd+0', run: () => zoom(null) })
	];
	return () => all.forEach((u) => u());
}
