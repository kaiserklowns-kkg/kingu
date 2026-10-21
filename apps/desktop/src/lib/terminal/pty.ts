// PTY lifetime from the page's side: terminals are killed only by explicit close actions (a tab
// closed, a task removed, Kill All Background Sessions), never by a component unmount, which a
// reload or another folder also causes.

import { invoke } from '@tauri-apps/api/core';
import type { PtyInfo } from './sessions.ts';

export function killPty(key: string) {
	invoke('pty_kill', { key }).catch(() => {});
	// A task pane's agent status file (paneAgents.svelte.ts) goes with its shell.
	if (key.startsWith('ade:')) invoke('agent_pane_hook_clear', { key }).catch(() => {});
}

/** Live sessions; empty when the backend cannot be reached. */
export function listPtys(): Promise<PtyInfo[]> {
	return invoke<PtyInfo[]>('pty_list').catch(() => [] as PtyInfo[]);
}

/** What runs in front of each shell of `keys` (only terminals not at their prompt are listed). */
export function foregroundJobs(keys: string[]): Promise<Record<string, { pid: number; name: string }>> {
	return invoke<Record<string, { pid: number; name: string }>>('pty_foreground', { keys }).catch(() => ({}));
}

/** The open folder's file a terminal link names (relative to the folder), or null when there is none. */
export function linkTarget(key: string, text: string): Promise<string | null> {
	return invoke<{ rel: string } | null>('terminal_link_target', { key, text })
		.then((t) => t?.rel ?? null)
		.catch(() => null);
}

/**
 * Opens a terminal link; `allowed` is terminal.integrated.allowedLinkSchemes (Rust checks it
 * again). A web link to an untrusted domain asks first (outgoing link protection).
 */
export async function openUrl(url: string, allowed?: string[]): Promise<void> {
	const { trustedDomains } = await import('#lib/workbench/trustedDomains.svelte.ts');
	if (!(await trustedDomains.confirm(url, { fromWorkspace: false }))) return;
	return invoke('terminal_open_url', { url, allowed: allowed ?? null });
}
