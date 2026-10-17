// Text editor resources beyond workspace files: the user settings.json lives in the app config
// dir, so its tab key routes reads and saves through the settings commands. Saving either
// settings file re-reads the settings so the change applies at once.

import { invoke } from '@tauri-apps/api/core';
import { settings, USER_SETTINGS_KEY, WORKSPACE_SETTINGS_PATH, SETTINGS_EDITOR_KEY } from './settings.svelte';

/** Tabs with no text model (the Settings editor UI). */
export const isNonTextEditor = (key: string) => key === SETTINGS_EDITOR_KEY;

export async function readResource(key: string): Promise<string> {
	if (key === USER_SETTINGS_KEY) {
		const file = await invoke<{ content: string | null }>('settings_read', { scope: 'user' });
		return file.content ?? '{\n}\n';
	}
	return invoke<string>('read_workspace_file', { rel: key });
}

export async function writeResource(key: string, content: string): Promise<void> {
	if (key === USER_SETTINGS_KEY) await invoke('settings_write', { scope: 'user', content });
	else await invoke('fs_write_file', { rel: key, content });
	if (key === USER_SETTINGS_KEY || key === WORKSPACE_SETTINGS_PATH) await settings.load();
}
