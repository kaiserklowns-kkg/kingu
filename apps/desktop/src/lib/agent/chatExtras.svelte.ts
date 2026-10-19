/**
 * `chatExtras` — the smaller chat features around the list (chatExtras.ts has the pure parts):
 *
 *   chatExtras.vote(id, request, vote)   thumbs up / down on an answer (null takes it back); kept
 *                                        in the chat's transcript (Rust `chat_feedback`)
 *   chatExtras.remember(text)            "Remember this": a bullet in CLAUDE.local.md or AGENTS.md
 *                                        (Rust memories.rs); Settings › Memories edits them
 *   chatExtras.followups(id) / clearFollowups(id)   follow-up chips after a finished answer
 *                                        (kingu.chat.followups, the source-control AI agent)
 *   chatExtras.openInEditor(id) / moveToSideBar(id) a chat in an editor tab and back (VS Code's
 *                                        chatMoveActions)
 *   installChatExtras()                  follow-ups and the completion chime
 *                                        (kingu.chat.completionSound) for the life of the workbench
 */

import { invoke } from '@tauri-apps/api/core';
import { clientLog } from '#lib/client-log.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { playTone } from '#lib/workbench/signals.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { t } from '#lib/i18n/index.ts';
import { buildTurns, lastRequest } from './chatParts.ts';
import { chatEditorKey, chimeFor, followupPrompt, memoryText, parseFollowups } from './chatExtras.ts';
import { openChat } from './chatCommands.svelte.ts';
import { chats } from './chats.svelte.ts';
import { runKey } from './chats.ts';
import { applyEvent, type Vote } from './events';

/** The memory files "Remember this" offers (Rust memories::FILES). */
export const MEMORY_FILES = ['CLAUDE.local.md', 'AGENTS.md'] as const;
export type MemoryFile = (typeof MEMORY_FILES)[number];
export type Memory = { file: MemoryFile; index: number; text: string };

class ChatExtras {
	/** Follow-up suggestions by run key, for the chat's last answer. */
	#followups = $state<Record<string, string[]>>({});

	followups(id: string): string[] {
		return (chats.root && this.#followups[runKey(chats.root, id)]) || [];
	}

	clearFollowups(id: string) {
		if (chats.root) delete this.#followups[runKey(chats.root, id)];
	}

	/** The vote on the answer to request `request`, shown at once and kept in the transcript. */
	async vote(id: string, request: number, vote: Vote | null) {
		const run = chats.run(id);
		if (!run) return;
		try {
			await invoke('chat_feedback', { id, request, vote });
			applyEvent(run, { kind: 'feedback', request, vote });
			if (vote) status.flash(t('chatExtras.feedback.thanks'), 3000);
		} catch (e) {
			notifications.error(t('chatExtras.feedback.failed', { error: String(e) }));
		}
	}

	/** "Remember this": `text` (one line) as a memory in the file the user picks. */
	async remember(text: string) {
		const memory = memoryText(text);
		if (!memory) return;
		const pick = await quick.choose({
			placeholder: t('chatExtras.remember.where', { text: memory.length > 60 ? `${memory.slice(0, 59)}…` : memory }),
			items: [
				{ id: 'CLAUDE.local.md', label: 'CLAUDE.local.md', description: t('chatExtras.remember.local') },
				{ id: 'AGENTS.md', label: 'AGENTS.md', description: t('chatExtras.remember.shared') }
			]
		});
		if (!pick) return;
		try {
			await invoke('memory_add', { file: pick.id, text: memory });
			status.flash(t('chatExtras.remember.saved', { file: pick.id }), 5000);
		} catch (e) {
			notifications.error(t('chatExtras.remember.failed', { error: String(e) }));
		}
	}

	listMemories(): Promise<Memory[]> {
		return invoke<Memory[]>('memories_list');
	}

	/** Edits a memory (`text`) or deletes it (null); `expected` is its text as listed. */
	changeMemory(m: Memory, text: string | null): Promise<void> {
		return invoke('memory_change', { file: m.file, index: m.index, expected: m.text, text });
	}

	/** Open Chat in Editor: the chat in its own editor tab (the side bar goes on to a new chat). */
	openInEditor(id: string) {
		editors.open(chatEditorKey(id), { preview: false });
	}

	/** Move Chat to Side Bar: the editor tab closes and the side bar shows the chat. */
	moveToSideBar(id: string) {
		editors.closeEverywhere(chatEditorKey(id));
		openChat(id);
	}

	/** Suggestions for chat `id` after an answer, when the user turned them on. */
	async suggest(id: string, answer: string | null) {
		const root = chats.root;
		const run = chats.run(id);
		const request = run && lastRequest(buildTurns(run));
		if (!root || !request || !answer?.trim() || settings.get<boolean>('kingu.chat.followups') !== true) return;
		const key = runKey(root, id);
		const requests = () => chats.run(id)?.items.filter((e) => e.kind === 'message' && e.role === 'user' && !e.parent_tool_use_id).length ?? -1;
		const before = requests();
		try {
			const text = await invoke<string | null>('ai_chat_followups', { prompt: followupPrompt(request.text, answer) });
			const list = text ? parseFollowups(text) : [];
			// Only while that answer is still the last one (no new request meanwhile).
			if (list.length && chats.root === root && requests() === before) this.#followups[key] = list;
		} catch (e) {
			clientLog('info', `chat ${id}: no follow-ups: ${String(e).slice(0, 200)}`);
		}
	}
}

export const chatExtras = new ChatExtras();

/** The completion chime: a macOS sound (Rust `chat_chime`), else Kingu's own "done" tone. */
export function playChime(sound: string) {
	if (sound === 'tone') return playTone('done');
	invoke('chat_chime', { sound }).catch((e) => {
		clientLog('info', `chat chime: ${String(e).slice(0, 200)}`);
		playTone('done');
	});
}

/** Follow-ups and the chime for every chat of the open folder; returns the cleanup. */
export function installChatExtras(): () => void {
	return chats.onEvent((id, ev) => {
		if (ev.kind === 'message' && ev.role === 'user' && !ev.parent_tool_use_id) chatExtras.clearFollowups(id);
		if (ev.kind !== 'result') return;
		const sound = chimeFor(ev, settings.get<string>('kingu.chat.completionSound'));
		if (sound) playChime(sound);
		if (!ev.is_error) void chatExtras.suggest(id, ev.result);
	});
}
