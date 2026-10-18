// Closing the window or quitting (VS Code: the lifecycle veto + window.confirmBeforeClose). Rust
// holds a close back only while the guard is armed (unsaved files, or confirmBeforeClose:
// always), so an idle or hung page never blocks quitting; this side asks and then quits.
// Unsaved files go through the text file service: hot exit backs them up, else Save / Don't Save.

import { untrack } from 'svelte';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ask } from '@tauri-apps/plugin-dialog';
import { settings } from '#lib/settings/settings.svelte.ts';
import { editors } from './editors.svelte';
import { textFiles } from './textFileService.svelte';
import type { ShutdownReason } from './textFiles';

/** Whether quitting may go ahead: unsaved files are backed up or asked about, then window.confirmBeforeClose decides. */
export async function confirmClose(reason: ShutdownReason = 'quit'): Promise<boolean> {
	const hadDirty = editors.hasDirty();
	if (!(await textFiles.beforeShutdown(reason))) return false;
	if (!hadDirty && settings.get('window.confirmBeforeClose') === 'always') return ask('ออกจาก Kingu?', { title: 'Kingu', kind: 'info', okLabel: 'ออก', cancelLabel: 'ยกเลิก' });
	return true;
}

/** Quits after `confirmClose` (File > Exit, and every close Rust held back). */
export async function quit(reason: ShutdownReason = 'quit') {
	if (await confirmClose(reason)) await invoke('window_close_confirmed');
}

export function installCloseGuard(): () => void {
	let asking = false;
	let gone = false;
	let unlisten: (() => void) | undefined;
	// Rust says whether the window was closed or the app was quit (⌘Q).
	listen<string | null>('window:close-requested', async (e) => {
		if (asking) return;
		asking = true;
		try {
			await quit(e.payload === 'close' ? 'close' : 'quit');
		} finally {
			asking = false;
		}
	}).then((u) => (gone ? u() : (unlisten = u)));
	const dispose = $effect.root(() => {
		$effect(() => {
			const armed = editors.hasDirty() || settings.get('window.confirmBeforeClose') === 'always';
			untrack(() => void invoke('window_close_guard', { armed }).catch(() => {}));
		});
	});
	return () => {
		gone = true;
		unlisten?.();
		dispose();
		void invoke('window_close_guard', { armed: false }).catch(() => {});
	};
}
