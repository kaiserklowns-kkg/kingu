// Review notes store: each worktree's notes ('' = the folder, else a task slug), saved through
// Rust after every change (a failed save rolls the list back, like Orca), and "send review notes
// to agent" — the notes in Orca's prompt format, delivered to the task's agent; delivered notes
// are deleted (only while they still match what was sent).

import { invoke } from '@tauri-apps/api/core';
import { clientLog } from '#lib/client-log.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { adeLayout } from './adeLayout.svelte.ts';
import { cliOf } from './agentCli.ts';
import { cliSessions } from './cliSessions.svelte.ts';
import { addNote, clearDelivered, deleteNote, deliveryFor, formatNotes, parseNotes, updateNote, type DiffNote, type NoteTarget, type NotesByWorktree } from './diffNotes.ts';
import { adeTasks } from './tasks.svelte.ts';
import { t } from '#lib/i18n/index.ts';

class DiffNotes {
	byKey = $state<NotesByWorktree>({});
	/** Notes being sent: hidden from another send until it ends (Orca's holdNotesForSend). */
	sending = $state<Record<string, true>>({});
	/** A note picked in a notes list: the diff tab that shows it scrolls to its line. */
	revealRequest = $state<{ diffKey: string; line: number } | null>(null);
	#root: string | null = null;
	#saving: Promise<void> = Promise.resolve();

	async load() {
		const root = workspace.root;
		this.#root = root;
		this.byKey = {};
		if (!root) return;
		try {
			const all = parseNotes(await invoke<unknown>('diff_notes_load'));
			if (this.#root === root) this.byKey = all;
		} catch (e) {
			status.flash(t('ade.diffNotes.loadFailed', { error: String(e) }), 8000);
		}
	}

	list(key: string): DiffNote[] {
		return this.byKey[key] ?? [];
	}

	count(key: string): number {
		return this.byKey[key]?.length ?? 0;
	}

	#set(key: string, next: DiffNote[]): Promise<boolean> {
		const before = this.byKey[key] ?? [];
		if (next === before) return Promise.resolve(true);
		const root = this.#root;
		if (next.length) this.byKey[key] = next;
		else delete this.byKey[key];
		const snapshot = $state.snapshot(next) as DiffNote[];
		const done = this.#saving.then(() =>
			invoke('diff_notes_save', { key, notes: snapshot }).then(
				() => true,
				(e) => {
					// Back to what is on disk, unless the folder changed meanwhile.
					if (this.#root === root) {
						if (before.length) this.byKey[key] = before;
						else delete this.byKey[key];
					}
					status.flash(t('ade.diffNotes.saveFailed', { error: String(e) }), 8000);
					clientLog('error', `diff_notes_save ${key}: ${e}`);
					return false;
				}
			)
		);
		this.#saving = done.then(() => {});
		return done;
	}

	add(key: string, filePath: string, target: NoteTarget, body: string): Promise<boolean> {
		return this.#set(key, addNote(this.list(key), { id: crypto.randomUUID(), filePath, body, ...target }, Date.now()));
	}

	update(key: string, id: string, body: string): Promise<boolean> {
		return this.#set(key, updateNote(this.list(key), id, body, Date.now()));
	}

	remove(key: string, id: string): Promise<boolean> {
		return this.#set(key, deleteNote(this.list(key), id));
	}

	clear(key: string): Promise<boolean> {
		return this.#set(key, []);
	}

	/** A removed task: its notes go with it. */
	forget(key: string) {
		if (this.byKey[key]) void this.#set(key, []);
	}

	/** Where "send" goes for worktree `key`, for labels: see `deliveryFor`. */
	delivery(key: string) {
		const meta = key ? adeTasks.list.find((t) => t.slug === key) : undefined;
		const cli = meta ? cliOf(meta.agent) : null;
		return deliveryFor({ isTask: !!meta, cli: !!cli, cliRunning: !!meta && cliSessions.has(key) });
	}

	async copy(notes: DiffNote[]) {
		try {
			await navigator.clipboard.writeText(formatNotes(notes));
			status.flash(t('ade.diffNotes.copied', { count: notes.length }));
		} catch {
			status.flash(t('ade.diffNotes.copyFailed'));
		}
	}

	/**
	 * Sends `notes` of worktree `key` to its agent (Orca's "Send review notes to agent"); the
	 * folder has no agent, so its notes are copied instead. Delivered notes are deleted.
	 */
	async send(key: string, notes: DiffNote[]) {
		const pending = notes.filter((n) => !this.sending[n.id]);
		if (!pending.length) return;
		const how = this.delivery(key);
		if (how === 'none') return this.copy(pending);
		const prompt = formatNotes(pending);
		for (const n of pending) this.sending[n.id] = true;
		status.flash(t('ade.diffNotes.sending'));
		try {
			const ok = how === 'cli' ? await cliSessions.send(key, prompt) : await adeTasks.followUp(key, prompt);
			if (!ok) return;
			await this.#set(key, clearDelivered(this.list(key), pending));
			status.flash(t('ade.diffNotes.sent', { count: pending.length }));
			// Show the agent that got them.
			adeLayout.select(key, 'main');
		} finally {
			for (const n of pending) delete this.sending[n.id];
		}
	}
}

export const diffNotes = new DiffNotes();
