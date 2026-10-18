/**
 * `chatRewind` — going back in an agent chat like VS Code's chat checkpoints: the conversation
 * rewinds with the files, so the agent's memory matches the disk again.
 *
 *   chatRewind.restore(chatId, request)         Restore Checkpoint / Start Over: after a confirm
 *                                               (with "don't ask again"), request `request` and
 *                                               every later one are gone and their edits undone
 *   chatRewind.editAndSend(chatId, request, m)  Edit request: rewind to it, then send `m` instead
 *   chatRewind.retry(chatId)                    Retry: rewind the last request, then send it again
 *   chatRewind.canRedo(chatId) / redo(chatId)   Redo of the rewinds since the chat's last message
 *
 * A live run of the chat is stopped first. Rust (`chat_rewind` / `chat_rewind_redo`) restores
 * the files, cuts the transcript and says where the next run continues the session (in a fork
 * of it, so Redo can go back to the original). Sending a message makes the rewind final.
 */

import { invoke } from '@tauri-apps/api/core';
import { t } from '#lib/i18n/index.ts';
import { cancelLabel, messageBox } from '#lib/workbench/messageBox.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { reloadClean } from '#lib/workbench/editorModels.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { chats, type OutgoingMessage } from './chats.svelte.ts';
import { runKey } from './chats.ts';
import { chatEdits } from './chatEdits.svelte.ts';
import { restoreTargets, workspacePath, type Report } from './chatEdits.ts';
import { buildTurns, lastRequest } from './chatParts.ts';
import { withoutImagesLine } from './chatPrompt.ts';
import { confirmAnswer, lastCheckpoint, rewoundMeta, type ForkPoint, type Rewound } from './chatRewind.ts';

/** `kingu.chat.confirmRewind`: ask before a rewind removes requests (VS Code's chat.editing.confirmEditRequestRemoval). */
export const CONFIRM_SETTING = 'kingu.chat.confirmRewind';

type Options = {
	/** 'always' asks (Restore Checkpoint); 'files' only when file edits would be undone (Edit, Retry). */
	confirm: 'always' | 'files';
};

class ChatRewindStore {
	/** Chats whose last rewinds Redo can undo, by run key: where the chat resumed before the first of them. */
	redoable = $state<Record<string, ForkPoint>>({});

	constructor() {
		// A message sent makes the rewind final (Rust drops its Redo data when the run starts).
		chats.onEvent((id, ev) => {
			if (ev.kind === 'message' && ev.role === 'user' && chats.root) delete this.redoable[runKey(chats.root, id)];
		});
	}

	#key(chatId: string): string | null {
		return chats.root ? runKey(chats.root, chatId) : null;
	}

	canRedo(chatId: string): boolean {
		const key = this.#key(chatId);
		return !!key && !!this.redoable[key];
	}

	/** Rewinds to before request `request`; true when it happened. */
	async rewind(chatId: string, request: number, o: Options): Promise<boolean> {
		const meta = chats.get(chatId);
		const key = this.#key(chatId);
		if (!meta || !key) return false;
		await chatEdits.refresh(chatId);
		const view = chatEdits.views[chatId];
		const targets = view ? restoreTargets(view, request) : [];
		if (settings.get<boolean>(CONFIRM_SETTING) !== false && (o.confirm === 'always' || targets.length)) {
			const button = await messageBox(targets.length ? t('chatRewind.confirm', { count: targets.length }) : t('chatRewind.confirmNoFiles'), {
				kind: 'warning',
				buttons: [t('chatRewind.ok'), t('chatRewind.okDontAsk'), cancelLabel()],
				cancelId: 2
			});
			const answer = confirmAnswer(button);
			if (!answer.go) return false;
			if (answer.dontAsk) void settings.set(CONFIRM_SETTING, false, 'user').catch((e) => notifications.error(String(e)));
		}
		if (!(await chatEdits.confirmDirty(targets))) return false;
		if (!(await chats.stopAndWait(chatId))) {
			notifications.error(t('chatRewind.stopTimeout'));
			return false;
		}
		const before = this.redoable[key] ?? { session_id: meta.session_id, resume_at: meta.resume_at ?? null };
		try {
			const r = await invoke<Rewound>('chat_rewind', { id: chatId, request, stack: !!this.redoable[key] });
			await chats.reload(chatId, rewoundMeta(r));
			this.redoable[key] = before;
			const n = r.report.restored.length + r.report.deleted.length;
			this.#done(view?.prefix ?? '', r.report, n ? t('chatRewind.restoredFiles', { count: n }) : t('chatRewind.restored'));
			return true;
		} catch (e) {
			notifications.error(t('chatRewind.failed', { error: String(e) }));
			return false;
		} finally {
			void chatEdits.refresh(chatId);
		}
	}

	/** Restore Checkpoint (Start Over on the first request), always after a confirm unless turned off. */
	restore(chatId: string, request: number): Promise<boolean> {
		return this.rewind(chatId, request, { confirm: 'always' });
	}

	/** Edit request: the request and the rest go, then `message` is sent in its place. */
	async editAndSend(chatId: string, request: number, message: OutgoingMessage): Promise<boolean> {
		return (await this.rewind(chatId, request, { confirm: 'files' })) && chats.send(chatId, message);
	}

	/** Retry: the last request goes and is sent again (with its images while they are known). */
	async retry(chatId: string): Promise<boolean> {
		const run = chats.run(chatId);
		const turns = run ? buildTurns(run) : [];
		const last = lastRequest(turns);
		const checkpoint = lastCheckpoint(turns);
		// Not a chat request Rust numbered (an older transcript): send it again after the rest.
		if (!last || checkpoint === null) return chats.retry(chatId);
		const text = withoutImagesLine(last.sent);
		const known = chats.lastSent(chatId);
		return this.editAndSend(chatId, checkpoint, { text, images: known?.text === text ? known.images : [] });
	}

	async redo(chatId: string): Promise<boolean> {
		const key = this.#key(chatId);
		const before = key ? this.redoable[key] : undefined;
		if (!key || !before) return false;
		try {
			const report = await invoke<Report>('chat_rewind_redo', { id: chatId });
			delete this.redoable[key];
			await chats.reload(chatId, before);
			this.#done(chatEdits.views[chatId]?.prefix ?? '', report, t('chatRewind.redone'));
			return true;
		} catch (e) {
			notifications.error(t('chatRewind.redoFailed', { error: String(e) }));
			return false;
		} finally {
			void chatEdits.refresh(chatId);
		}
	}

	#done(prefix: string, report: Report, message: string) {
		// Clean editors show the restored contents now (the watcher would, a moment later).
		void reloadClean([...report.restored, ...report.deleted].map((p) => workspacePath(prefix, p)));
		status.flash(message);
		if (report.skipped.length) notifications.info(t('chatEdits.skipped', { count: report.skipped.length }));
	}
}

export const chatRewind = new ChatRewindStore();
