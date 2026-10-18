/**
 * `chatEdits` — the open folder's agent chats' file edits (VS Code's chat editing session):
 * the working set above the composer and "Restore checkpoint" on a request.
 *
 *   chatEdits.view(chatId)                 EditsView | undefined (loaded on demand, reloaded on
 *                                          the run's `edits_changed` / `checkpoint` / `exit`)
 *   chatEdits.keep(chatId, paths | null)   Keep: the files leave the working set as they are
 *   chatEdits.undo(chatId, paths | null)   Undo: back to before the agent's first pending change
 *                                          (asks first about files with unsaved editor changes)
 *   restoreCheckpoint(chatId, request)     reverts request `request` and every later one, after a confirm
 *   chatEdits.openDiff(chatId, path)       snapshot vs current in a `chatedit://` diff tab
 *   chatEdits.openAll(chatId, paths)       View All File Changes of a request (one tab per file)
 *   chatEdits.openEdited(chatId, rel, …)   an edited-file pill: the diff, or the file once kept
 *   chatEdits.isReverted(chatId, request)  for the timeline to grey reverted responses
 *
 * Rust does the work (`chat_edits_*` commands): path checks, the git queue lane, and refusing
 * while the chat's turn runs. Clean editors of the files take the new contents right away.
 */

import { invoke } from '@tauri-apps/api/core';
import { t } from '#lib/i18n/index.ts';
import { ask } from '#lib/workbench/messageBox.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { reloadClean } from '#lib/workbench/editorModels.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { chats } from './chats.svelte.ts';
import { applyKeep, applyRestore, applyUndo, chatEditKey, cwdRelative, dirtyOf, emptyView, parseChatEditKey, restoreTargets, undoTargets, workspacePath, type EditsView, type Report } from './chatEdits.ts';

class ChatEditsStore {
	/** By chat id, for the open folder. */
	views = $state<Record<string, EditsView>>({});
	#root: string | null = null;
	#loading = new Map<string, Promise<void>>();

	constructor() {
		chats.onEvent((id, ev) => {
			if (ev.kind === 'edits_changed' || ev.kind === 'checkpoint' || ev.kind === 'exit') void this.refresh(id);
		});
	}

	/** Safe inside $derived / markup: loading is scheduled, never done while reading. */
	view(chatId: string): EditsView | undefined {
		if (workspace.root !== this.#root || (!this.views[chatId] && !this.#loading.has(chatId))) queueMicrotask(() => void this.#ensure(chatId));
		return workspace.root === this.#root ? this.views[chatId] : undefined;
	}

	isReverted(chatId: string, request: number): boolean {
		return this.views[chatId]?.requests.some((r) => r.index === request && r.reverted) ?? false;
	}

	#sync() {
		if (workspace.root === this.#root) return;
		this.#root = workspace.root;
		this.views = {};
		this.#loading.clear();
	}

	async #ensure(chatId: string) {
		this.#sync();
		if (!this.views[chatId] && !this.#loading.has(chatId)) await this.refresh(chatId);
	}

	async refresh(chatId: string) {
		this.#sync();
		const root = this.#root;
		if (!root) return;
		const p = invoke<EditsView | null>('chat_edits_list', { id: chatId })
			.then((v) => {
				if (workspace.root === root) this.views[chatId] = v ?? emptyView();
			})
			.catch((e) => {
				notifications.error(t('chatEdits.loadFailed', { error: String(e) }));
			})
			.finally(() => this.#loading.delete(chatId));
		this.#loading.set(chatId, p);
		await p;
	}

	async keep(chatId: string, paths: string[] | null) {
		const v = this.views[chatId];
		try {
			await invoke('chat_edits_keep', { id: chatId, paths });
			if (v) this.views[chatId] = applyKeep(v, paths);
		} catch (e) {
			notifications.error(t('chatEdits.failed', { error: String(e) }));
		}
		void this.refresh(chatId);
	}

	/** Undo; asks before writing over unsaved editor changes, and for Undo All. */
	async undo(chatId: string, paths: string[] | null): Promise<boolean> {
		const v = this.views[chatId];
		if (!v) return false;
		if (v.running) {
			status.flash(t('chatEdits.running'));
			return false;
		}
		const targets = undoTargets(v, paths);
		if (paths === null && targets.length > 1 && !(await ask(t('chatEdits.undoAllConfirm', { count: targets.length }), { kind: 'warning', okLabel: t('chatEdits.undoAll') }))) return false;
		if (!(await this.#confirmDirty(targets))) return false;
		try {
			const report = await invoke<Report>('chat_edits_undo', { id: chatId, paths });
			this.views[chatId] = applyUndo(v, report);
			this.#done(v.prefix, report, t('chatEdits.undone', { count: report.restored.length + report.deleted.length }));
			return true;
		} catch (e) {
			notifications.error(t('chatEdits.failed', { error: String(e) }));
			return false;
		} finally {
			void this.refresh(chatId);
		}
	}

	/** Restore checkpoint: reverts request `request` and every later one, after a confirm. */
	async restoreCheckpoint(chatId: string, request: number): Promise<boolean> {
		if (!this.views[chatId]) await this.refresh(chatId);
		const v = this.views[chatId];
		if (!v) return false;
		if (v.running) {
			status.flash(t('chatEdits.running'));
			return false;
		}
		const targets = restoreTargets(v, request);
		if (!(await ask(t('chatEdits.restoreConfirm', { count: targets.length }), { kind: 'warning', okLabel: t('chatEdits.restoreOk') }))) return false;
		if (!(await this.#confirmDirty(targets))) return false;
		try {
			const report = await invoke<Report>('chat_edits_restore', { id: chatId, request });
			this.views[chatId] = applyRestore(v, request);
			this.#done(v.prefix, report, t('chatEdits.restored', { count: report.restored.length + report.deleted.length }));
			return true;
		} catch (e) {
			notifications.error(t('chatEdits.failed', { error: String(e) }));
			return false;
		} finally {
			void this.refresh(chatId);
		}
	}

	async #confirmDirty(targets: string[]): Promise<boolean> {
		const dirty = dirtyOf(targets, (p) => editors.isDirty(p));
		if (!dirty.length) return true;
		return ask(t('chatEdits.dirtyConfirm', { count: dirty.length, paths: dirty.slice(0, 3).join(', ') + (dirty.length > 3 ? ', …' : '') }), {
			kind: 'warning',
			okLabel: t('chatEdits.dirtyOk')
		});
	}

	#done(prefix: string, report: Report, message: string) {
		// Clean editors show the restored contents now (the watcher would, a moment later).
		void reloadClean([...report.restored, ...report.deleted].map((p) => workspacePath(prefix, p)));
		status.flash(message);
		if (report.skipped.length) notifications.info(t('chatEdits.skipped', { count: report.skipped.length }));
	}

	/**
	 * The file's diff (snapshot vs now); a file without a snapshot opens as itself. False when the
	 * file is not in the working set (kept, undone, or not changed by this chat).
	 */
	openDiff(chatId: string, path: string, preview = true): boolean {
		const v = this.views[chatId];
		const f = v?.files.find((x) => x.path === path);
		if (!v || !f) return false;
		if (f.restorable) editors.open(chatEditKey(chatId, workspacePath(v.prefix, path)), { preview });
		else if (!f.deleted) editors.open(workspacePath(v.prefix, path), { preview });
		return true;
	}

	/** View All File Changes of a request: each file's diff in its own tab (a file that left the working set opens as itself). */
	openAll(chatId: string, paths: readonly string[]) {
		const v = this.views[chatId];
		if (!v) return;
		for (const p of paths) if (!this.openDiff(chatId, p, false)) editors.open(workspacePath(v.prefix, p), { preview: false });
	}

	/** An edit tool's file (relative to the chat's cwd): its diff while in the working set, else the file. */
	openEdited(chatId: string | null, rel: string, fallback: string) {
		if (chatId && this.openDiff(chatId, rel)) return;
		const v = chatId ? this.views[chatId] : undefined;
		editors.open(v ? workspacePath(v.prefix, rel) : fallback, { preview: true });
	}

	/** For DiffHost: the left side of a `chatedit://` tab. */
	async original(key: string): Promise<{ text: string; path: string }> {
		const k = parseChatEditKey(key);
		if (!k) throw new Error('not a chat edit diff');
		if (!this.views[k.chatId]) await this.refresh(k.chatId);
		const rel = cwdRelative(this.views[k.chatId]?.prefix ?? '', k.rel);
		if (rel === null) throw new Error('outside the chat folder');
		const text = await invoke<string>('chat_edits_original', { id: k.chatId, path: rel });
		return { text, path: `chat-before/${k.rel}` };
	}
}

export const chatEdits = new ChatEditsStore();

/** Restore checkpoint for the chat list's request rows: reverts request `requestIndex` and later ones. */
export function restoreCheckpoint(chatId: string, requestIndex: number): Promise<boolean> {
	return chatEdits.restoreCheckpoint(chatId, requestIndex);
}
