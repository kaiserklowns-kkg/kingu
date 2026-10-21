// Chat observability, history and tools commands (VS Code's ids), in the palette:
//   workbench.action.chat.openAgentDebugPanelForSession  Show Agent Debug Logs: the current chat's
//                                     debug log in an editor tab (ChatDebugView.svelte)
//   workbench.action.chat.exportAgentDebugLog  Export Agent Debug Log...: the current chat's log as JSON
//   workbench.action.chat.history     Agent: Show Chats...: a quick pick of the folder's chats,
//                                     searching titles and transcripts (chatHistory.svelte.ts)
//   workbench.action.chat.configureTools  Configure Tools...: the current chat's tool picker
// "The current chat" is the one the chat panel (or a chat editor) shows (`chatTools.current`).

import { invoke } from '@tauri-apps/api/core';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { t } from '#lib/i18n/index.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { chats } from './chats.svelte.ts';
import { chatDebugKey } from './chatDebug.ts';
import { chatHistory } from './chatHistory.svelte.ts';
import { chatTools } from './chatTools.svelte.ts';

/** Opens chat `id`'s Agent Debug Log (the current chat when omitted). */
export function openChatDebug(id: string | null = chatTools.current) {
	if (!id || !chats.get(id)) return status.flash(t('chatDebug.noChat'), 5000);
	editors.open(chatDebugKey(id), { preview: false });
}

async function exportChatDebug(id: string | null = chatTools.current) {
	const meta = id ? chats.get(id) : undefined;
	if (!meta) return status.flash(t('chatDebug.noChat'), 5000);
	const path = await saveDialog({ title: t('chatDebug.export'), defaultPath: 'agent-debug-log.json', filters: [{ name: t('chatDebug.title'), extensions: ['json'] }] }).catch(() => null);
	if (!path) return;
	try {
		await invoke('chat_debug_export', { chatId: meta.id, path, kinds: null });
		status.flash(t('chatDebug.exported', { path }), 6000);
	} catch (e) {
		status.flash(t('chatDebug.exportFailed', { error: String(e) }), 10000);
	}
}

export function registerChatDebugCommands(): () => void {
	const off = [
		commands.register({ id: 'workbench.action.chat.openAgentDebugPanelForSession', title: 'Show Agent Debug Logs', category: 'Chat', run: () => openChatDebug() }),
		commands.register({ id: 'workbench.action.chat.exportAgentDebugLog', title: 'Export Agent Debug Log...', category: 'Chat', run: () => void exportChatDebug() }),
		commands.register({ id: 'workbench.action.chat.history', title: 'Show Chats...', category: 'Agent', run: () => chatHistory.showChats() }),
		commands.register({ id: 'workbench.action.chat.configureTools', title: 'Configure Tools...', category: 'Chat', run: () => void chatTools.configure() })
	];
	return () => off.forEach((f) => f());
}
