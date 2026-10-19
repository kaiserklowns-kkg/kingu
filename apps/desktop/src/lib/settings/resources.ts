// Text editor resources beyond workspace files: the user settings.json lives in the app config
// dir, so its tab key routes reads and saves through the settings commands. Saving either
// settings file re-reads the settings so the change applies at once.

import { invoke } from '@tauri-apps/api/core';
import { settings, USER_SETTINGS_KEY, WORKSPACE_SETTINGS_PATH, SETTINGS_EDITOR_KEY } from './settings.svelte';
import { isAdeEditor } from '#lib/ade/keys.ts';
import { isChangesKey, isImagePath, isPreviewKey } from '#lib/workbench/viewers.ts';
import { isNotebookPath } from '#lib/workbench/notebook.ts';
import { keybindings, USER_KEYBINDINGS_KEY } from '#lib/workbench/keybindings.svelte.ts';
import { KEYBINDINGS_TEMPLATE } from '#lib/workbench/keybindingsModel.ts';
import { isUntitled } from '#lib/workbench/untitled.ts';
import { isVaultKey } from '#lib/vault/vault.ts';
import { isArtifactKey } from '#lib/artifacts/artifacts.ts';
import { isChatEditorKey } from '#lib/agent/chatExtras.ts';
import { isMergeKey } from '#lib/workbench/scm.ts';

/** Kingu's user mcp.json (the MCP store's `USER_MCP_KEY`): in the app config dir, read and saved by Rust. */
const USER_MCP_KEY = 'mcp://user/mcp.json';

/** Tabs with no text model (the Settings editor UI, ADE task pages and the board, images, Markdown previews, AI Vault transcripts, chats). */
export const isNonTextEditor = (key: string) =>
	key === SETTINGS_EDITOR_KEY || isAdeEditor(key) || isImagePath(key) || isPreviewKey(key) || isNotebookPath(key) || isChangesKey(key) || isVaultKey(key) || isChatEditorKey(key) || isArtifactKey(key) || isMergeKey(key);

/** A user snap's manifest (`snap://user/<id>/snap.toml`): it lives in the app config dir, outside the workspace. */
const userSnapId = (key: string) => /^snap:\/\/user\/([a-z0-9][a-z0-9-]{0,39})\/snap\.toml$/.exec(key)?.[1];

export async function readResource(key: string): Promise<string> {
	// An untitled editor starts empty; it has nothing on disk.
	if (isUntitled(key)) return '';
	const snapId = userSnapId(key);
	if (snapId) return invoke<string>('snap_manifest_read', { id: snapId });
	if (key === USER_MCP_KEY) return invoke<string>('mcp_user_read');
	if (key === USER_SETTINGS_KEY) {
		const file = await invoke<{ content: string | null }>('settings_read', { scope: 'user' });
		return file.content ?? '{\n}\n';
	}
	if (key === USER_KEYBINDINGS_KEY) {
		const file = await invoke<{ content: string | null }>('settings_read', { scope: 'keybindings' });
		return file.content ?? KEYBINDINGS_TEMPLATE;
	}
	return invoke<string>('read_workspace_file', { rel: key });
}

export async function writeResource(key: string, content: string): Promise<void> {
	if (isUntitled(key)) throw new Error('an untitled editor is saved with Save As');
	const snapId = userSnapId(key);
	if (key === USER_SETTINGS_KEY) await invoke('settings_write', { scope: 'user', content });
	else if (key === USER_KEYBINDINGS_KEY) await invoke('settings_write', { scope: 'keybindings', content });
	else if (snapId) await invoke('snap_manifest_write', { id: snapId, content });
	else if (key === USER_MCP_KEY) await invoke('mcp_user_write', { content });
	else await invoke('fs_write_file', { rel: key, content });
	if (key === USER_SETTINGS_KEY || key === WORKSPACE_SETTINGS_PATH) await settings.load();
	if (key === USER_KEYBINDINGS_KEY) await keybindings.load();
	// The user snaps dir is not watched; loaded lazily to keep the snaps store out of this module's imports.
	if (snapId) await import('#lib/snaps/snaps.svelte.ts').then((m) => m.snaps.load());
	if (key === USER_MCP_KEY) await import('#lib/mcp/mcp.svelte.ts').then((m) => m.mcp.load());
}

/** Workspace files are read and saved with their encoding and checked for save conflicts; the
 * settings, keybindings and snap manifests are always UTF-8 and owned by Kingu. */
export const isWorkspaceTextFile = (key: string) => key !== USER_SETTINGS_KEY && key !== USER_KEYBINDINGS_KEY && key !== USER_MCP_KEY && !userSnapId(key);

/** `readonly`: the file's permissions say it cannot be written (files.readonlyFromPermissions). */
export type FileStat = { mtime: number; size: number; hash: string; readonly?: boolean };
export type ReadOptions = { encoding?: string; defaultEncoding?: string; autoGuess?: boolean; acceptBinary?: boolean; acceptLarge?: boolean; largeFileLimit?: number };
export type TextRead =
	| { kind: 'text'; content: string; encoding: string; lossy: boolean; stat?: FileStat }
	| { kind: 'binary'; size: number }
	| { kind: 'tooLarge'; size: number; limit: number };
export type TextWrite = { kind: 'saved'; stat?: FileStat } | { kind: 'conflict'; stat: FileStat } | { kind: 'unencodable'; ch: string };

/** `readResource` with encodings, binary and large file detection (Rust `textfile_read`). */
export async function readTextResource(key: string, options: ReadOptions = {}): Promise<TextRead> {
	if (!isWorkspaceTextFile(key)) return { kind: 'text', content: await readResource(key), encoding: 'utf8', lossy: false };
	return invoke<TextRead>('textfile_read', { rel: key, options });
}

/** `writeResource` with the file's encoding; `expected` is the stat it was loaded with (none: overwrite). */
export async function writeTextResource(key: string, content: string, encoding: string, expected?: FileStat): Promise<TextWrite> {
	if (!isWorkspaceTextFile(key)) {
		await writeResource(key, content);
		return { kind: 'saved' };
	}
	const result = await invoke<TextWrite>('textfile_write', { rel: key, content, encoding, expected: expected ? { mtime: expected.mtime, hash: expected.hash } : null });
	if (result.kind === 'saved' && key === WORKSPACE_SETTINGS_PATH) await settings.load();
	return result;
}
