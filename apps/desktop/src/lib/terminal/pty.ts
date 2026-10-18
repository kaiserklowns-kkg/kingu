// PTY lifetime from the page's side: terminals are killed only by explicit close actions (a tab
// closed, a task removed, another folder), never by a component unmount, which a reload also causes.

import { invoke } from '@tauri-apps/api/core';
import { orphanKeys } from './sessions.ts';

export function killPty(key: string) {
	invoke('pty_kill', { key }).catch(() => {});
}

/** Kills live PTYs whose terminal the page no longer has (closed while the page was reloading). */
export async function reapOrphans(wanted: () => Set<string>) {
	const live = await invoke<string[]>('pty_list').catch(() => [] as string[]);
	// `wanted` is read after the list arrives: a terminal spawned meanwhile is already in it.
	for (const key of orphanKeys(live, wanted())) killPty(key);
}
