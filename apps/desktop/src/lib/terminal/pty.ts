// PTY lifetime from the page's side: terminals are killed only by explicit close actions (a tab
// closed, a task removed, Kill All Background Sessions), never by a component unmount, which a
// reload or another folder also causes.

import { invoke } from '@tauri-apps/api/core';
import type { PtyInfo } from './sessions.ts';

export function killPty(key: string) {
	invoke('pty_kill', { key }).catch(() => {});
}

/** Live sessions; empty when the backend cannot be reached. */
export function listPtys(): Promise<PtyInfo[]> {
	return invoke<PtyInfo[]>('pty_list').catch(() => [] as PtyInfo[]);
}
