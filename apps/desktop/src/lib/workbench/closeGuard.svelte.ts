// Closing the window or quitting (VS Code: the lifecycle veto + window.confirmBeforeClose). Rust
// holds a close back only while the guard is armed (unsaved files, or confirmBeforeClose:
// always), so an idle or hung page never blocks quitting; this side asks and then quits.
// Unsaved files go through the text file service: hot exit backs them up, else Save / Don't Save.

import { untrack } from 'svelte';
import { invoke } from '@tauri-apps/api/core';
import { listenWindow } from '#lib/workbench/windowEvents.ts';
import { ask } from '#lib/workbench/messageBox.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { confirmTerminalExit } from '#lib/terminal/confirmKill.ts';
import { debug } from '#lib/debug/debug.svelte.ts';
import { editors } from './editors.svelte';
import { saveEditorLayout } from './editorRestore.svelte';
import { textFiles } from './textFileService.svelte';
import type { ShutdownReason } from './textFiles';
import { t } from '#lib/i18n/index.ts';

const debugConfirmsExit = () => debug.active && settings.get('debug.confirmOnExit') === 'always';

/** Whether quitting may go ahead: unsaved files are backed up or asked about, then window.confirmBeforeClose decides. */
export async function confirmClose(reason: ShutdownReason = 'quit'): Promise<boolean> {
	// The workspace's editors as they are now (scroll and cursor included) for the next time.
	saveEditorLayout();
	const hadDirty = editors.hasDirty();
	if (!(await textFiles.beforeShutdown(reason))) return false;
	// terminal.integrated.confirmOnExit: live terminal sessions.
	if (!(await confirmTerminalExit())) return false;
	// debug.confirmOnExit: a debug session is running.
	if (debugConfirmsExit() && !(await ask(t('workbench.closeGuard.debugRunning'), { title: 'Kingu', kind: 'warning', okLabel: t('workbench.closeGuard.stopDebugAndQuit'), cancelLabel: t('common.cancel') }))) return false;
	if (!hadDirty && settings.get('window.confirmBeforeClose') === 'always') return ask(t('workbench.closeGuard.quitQuestion'), { title: 'Kingu', kind: 'info', okLabel: t('workbench.closeGuard.quit'), cancelLabel: t('common.cancel') });
	return true;
}

/**
 * After `confirmClose`: `close` closes this window, `quit` (File > Exit, ⌘Q) quits once every
 * other window with something to ask has agreed too (Rust asks them in turn). A refusal stops
 * a quit under way.
 */
export async function quit(reason: ShutdownReason = 'quit') {
	if (await confirmClose(reason)) await invoke('window_close_confirmed', { reason: reason === 'close' ? 'close' : 'quit' });
	else await invoke('window_close_cancelled').catch(() => {});
}

export function installCloseGuard(): () => void {
	let asking = false;
	let gone = false;
	let unlisten: (() => void) | undefined;
	// Rust says whether the window was closed or the app was quit (⌘Q).
	listenWindow<string | null>('window:close-requested', async (e) => {
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
			const armed = editors.hasDirty() || settings.get('window.confirmBeforeClose') === 'always' || settings.get('terminal.integrated.confirmOnExit') !== 'never' || debugConfirmsExit();
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
