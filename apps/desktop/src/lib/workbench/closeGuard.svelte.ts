// Closing the window or quitting (VS Code: the lifecycle veto + window.confirmBeforeClose). Rust
// holds a close back only while the guard is armed (unsaved files, or confirmBeforeClose:
// always), so an idle or hung page never blocks quitting; this side asks and then quits.

import { untrack } from 'svelte';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ask } from '@tauri-apps/plugin-dialog';
import { settings } from '#lib/settings/settings.svelte.ts';
import { editors } from './editors.svelte';

/** Whether quitting may go ahead: unsaved files always ask, otherwise window.confirmBeforeClose decides. */
export async function confirmClose(): Promise<boolean> {
	if (editors.hasDirty())
		return ask(`มี ${editors.dirtyCount()} ไฟล์ที่ยังไม่บันทึก ออกจาก Kingu และทิ้งการแก้ไข?`, { title: 'ยังไม่ได้บันทึก', kind: 'warning', okLabel: 'ออก', cancelLabel: 'ยกเลิก' });
	if (settings.get('window.confirmBeforeClose') === 'always') return ask('ออกจาก Kingu?', { title: 'Kingu', kind: 'info', okLabel: 'ออก', cancelLabel: 'ยกเลิก' });
	return true;
}

/** Quits after `confirmClose` (File > Exit, and every close Rust held back). */
export async function quit() {
	if (await confirmClose()) await invoke('window_close_confirmed');
}

export function installCloseGuard(): () => void {
	let asking = false;
	let gone = false;
	let unlisten: (() => void) | undefined;
	listen('window:close-requested', async () => {
		if (asking) return;
		asking = true;
		try {
			await quit();
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
