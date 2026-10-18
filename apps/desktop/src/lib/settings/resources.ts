// Text editor resources beyond workspace files: the user settings.json lives in the app config
// dir, so its tab key routes reads and saves through the settings commands. Saving either
// settings file re-reads the settings so the change applies at once.

import { invoke } from '@tauri-apps/api/core';
import { settings, USER_SETTINGS_KEY, WORKSPACE_SETTINGS_PATH, SETTINGS_EDITOR_KEY } from './settings.svelte';
import { isAdeEditor } from '#lib/ade/keys.ts';

/** Tabs with no text model (the Settings editor UI, ADE task pages and the board). */
export const isNonTextEditor = (key: string) => key === SETTINGS_EDITOR_KEY || isAdeEditor(key);

/** A user snap's manifest (`snap://user/<id>/snap.toml`): it lives in the app config dir, outside the workspace. */
const userSnapId = (key: string) => /^snap:\/\/user\/([a-z0-9][a-z0-9-]{0,39})\/snap\.toml$/.exec(key)?.[1];

export async function readResource(key: string): Promise<string> {
	const snapId = userSnapId(key);
	if (snapId) return invoke<string>('snap_manifest_read', { id: snapId });
	if (key === USER_SETTINGS_KEY) {
		const file = await invoke<{ content: string | null }>('settings_read', { scope: 'user' });
		return file.content ?? '{\n}\n';
	}
	return invoke<string>('read_workspace_file', { rel: key });
}

export async function writeResource(key: string, content: string): Promise<void> {
	const snapId = userSnapId(key);
	if (key === USER_SETTINGS_KEY) await invoke('settings_write', { scope: 'user', content });
	else if (snapId) await invoke('snap_manifest_write', { id: snapId, content });
	else await invoke('fs_write_file', { rel: key, content });
	if (key === USER_SETTINGS_KEY || key === WORKSPACE_SETTINGS_PATH) await settings.load();
	// The user snaps dir is not watched; loaded lazily to keep the snaps store out of this module's imports.
	if (snapId) await import('#lib/snaps/snaps.svelte.ts').then((m) => m.snaps.load());
}
