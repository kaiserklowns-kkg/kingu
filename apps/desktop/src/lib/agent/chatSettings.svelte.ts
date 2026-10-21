// The chat.* settings that act on the app (chatSettings.ts decides the rest):
//   saveBeforeSend()      chat.saveBeforeSend: dirty editors are saved before a message goes, so
//                         the agent reads what you see (untitled ones, diffs and Kingu's own
//                         resources stay as they are)
//   requestAttention()    the window badge part of chat.notifyWindowOn*: the Dock icon bounces
//                         once (Tauri's requestUserAttention, informational)
//   chatProgress.busy     chat.viewProgressBadge.enabled: a chat of the open folder is working

import { getCurrentWindow, UserAttentionType } from '@tauri-apps/api/window';
import { clientLog } from '#lib/client-log.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { saveFile } from '#lib/workbench/editorModels.ts';
import { chats } from './chats.svelte.ts';
import { turnBusy } from './chatInput.ts';
import { savedBeforeSend } from './chatSettings.ts';

export async function saveBeforeSend(): Promise<void> {
	if (settings.get<boolean>('chat.saveBeforeSend') === false) return;
	const paths = savedBeforeSend(editors.dirtyPaths());
	if (!paths.length) return;
	const done = await Promise.allSettled(paths.map((p) => saveFile(p, 'explicit')));
	for (const [i, r] of done.entries()) if (r.status === 'rejected') clientLog('info', `chat.saveBeforeSend ${paths[i]}: ${r.reason}`);
}

export function requestAttention() {
	void getCurrentWindow()
		.requestUserAttention(UserAttentionType.Informational)
		.catch((e) => clientLog('info', `chat request attention: ${e}`));
}

class ChatProgress {
	/** A chat of the open folder has a turn running (VS Code's view progress badge). */
	busy = $derived(!!chats.root && Object.values(chats.runs).some((r) => r.root === chats.root && turnBusy(r)));
	/** The badge shows: the setting is on and a chat works. */
	badge = $derived(this.busy && settings.get<boolean>('chat.viewProgressBadge.enabled') === true);
}

export const chatProgress = new ChatProgress();
