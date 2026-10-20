// Local History (VS Code: contrib/localHistory — localHistoryCommands.ts, localHistoryTimeline.ts;
// services/workingCopy/common/workingCopyHistoryTracker.ts). Every save of a workspace file adds an
// entry (a copy kept by Rust local_history.rs) unless `workbench.localHistory.enabled` is off, the
// file is larger than `maxFileSize` or `exclude` matches it; a save within `mergeWindow` of the
// last entry replaces it. Entries show in the Timeline next to the git history, with Compare with
// File / Previous / Selected, Show Contents, Restore, Rename and Delete.

import { invoke } from '@tauri-apps/api/core';
import { clientLog } from '#lib/client-log.ts';
import { locale, t } from '#lib/i18n/index.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { getEntry, revertFile, textFileHooks } from '#lib/workbench/editorModels.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { messageBox, cancelLabel } from '#lib/workbench/messageBox.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { fileOf, isDiffKey } from '#lib/workbench/scm.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { fromNow } from './blame';
import {
	RESTORE_SOURCE,
	SavedVersions,
	entryDateLabel,
	entryLabels,
	historySettingsFrom,
	isLocalHistoryKey,
	localHistoryDiffKey,
	localHistoryKey,
	parseLocalHistoryKey,
	previousEntry,
	sourceLabel,
	type HistoryEntry
} from './localHistory';
import { isRepoFile } from './scmViews.svelte';

const enabled = () => settings.get<boolean>('workbench.localHistory.enabled') !== false;
const baseName = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1);

/** The workspace file an editor key is about: the file, a diff of it, or one of its history entries. */
export function historyFile(key: string | null): string | null {
	if (!key) return null;
	const file = isDiffKey(key) || isLocalHistoryKey(key) ? fileOf(key) : key;
	return isRepoFile(file) ? file : null;
}

class LocalHistory {
	/** Loaded entries by file, oldest first (reactive: the Timeline and tab labels read them). */
	entries = $state<Record<string, HistoryEntry[]>>({});
	/** Select for Compare: the entry Compare with Selected compares against. */
	selected = $state<{ rel: string; id: string } | null>(null);
	#saved = new SavedVersions();

	constructor() {
		entryLabels.of = (rel, id) => {
			const e = this.entries[rel]?.find((x) => x.id === id);
			return e ? `${sourceLabel(e.source)} • ${entryDateLabel(e.timestamp, locale())}` : null;
		};
	}

	label = (e: HistoryEntry) => sourceLabel(e.source);
	ago = (e: HistoryEntry) => fromNow(e.timestamp / 1000, Date.now(), locale());
	tooltip = (rel: string, e: HistoryEntry) => `${baseName(rel)} • ${sourceLabel(e.source)}\n${new Date(e.timestamp).toLocaleString(locale())}`;

	/** Reads the entries of `rel` again. */
	async load(rel: string): Promise<HistoryEntry[]> {
		try {
			const list = await invoke<HistoryEntry[]>('local_history_list', { rel });
			this.entries = { ...this.entries, [rel]: list };
			return list;
		} catch (e) {
			clientLog('info', `local history ${rel}: ${e}`);
			return this.entries[rel] ?? [];
		}
	}

	/** Adds an entry of `rel` as it is on disk (`source` null: "File Saved"). */
	async add(rel: string, source: string | null = null): Promise<HistoryEntry | null> {
		if (!enabled() || !isRepoFile(rel) || !workspace.root) return null;
		try {
			const entry = await invoke<HistoryEntry | null>('local_history_add', { rel, source, settings: historySettingsFrom((id) => settings.get(id)) });
			if (entry && this.entries[rel]) await this.load(rel);
			return entry;
		} catch (e) {
			clientLog('info', `local history add ${rel}: ${e}`);
			return null;
		}
	}

	/** The save hook: skips a save whose content already has an entry (VS Code's tracker). */
	onSaved(rel: string, version: number) {
		if (!isRepoFile(rel) || !this.#saved.isNew(rel, version)) return;
		void this.add(rel);
	}

	compareWithFile(rel: string, e: HistoryEntry, preview = true) {
		editors.open(localHistoryDiffKey(e.id, null, rel), { preview });
	}

	compareWithPrevious(rel: string, e: HistoryEntry) {
		const prev = previousEntry(this.entries[rel] ?? [], e.id);
		// The first entry has nothing before it: VS Code then compares it with the file.
		if (!prev) return this.compareWithFile(rel, e, false);
		editors.open(localHistoryDiffKey(prev.id, e.id, rel), { preview: false });
	}

	selectForCompare(rel: string, e: HistoryEntry) {
		this.selected = { rel, id: e.id };
	}

	canCompareWithSelected(rel: string, e: HistoryEntry) {
		return this.selected !== null && this.selected.rel === rel && this.selected.id !== e.id;
	}

	compareWithSelected(rel: string, e: HistoryEntry) {
		if (!this.canCompareWithSelected(rel, e)) return;
		editors.open(localHistoryDiffKey(this.selected!.id, e.id, rel), { preview: false });
	}

	/** Show Contents: the entry in a read-only editor. */
	show(rel: string, e: HistoryEntry) {
		editors.open(localHistoryKey(e.id, rel), { preview: false });
	}

	/** Restore Contents: asks, then the entry replaces the file (unsaved changes are dropped). */
	async restore(rel: string, e: HistoryEntry) {
		const restore = t('localHistory.restoreButton');
		const answer = await messageBox(t('localHistory.confirmRestore', { name: baseName(rel) }) + '\n\n' + t('localHistory.confirmRestoreDetail'), {
			kind: 'warning',
			buttons: [restore, cancelLabel()],
			cancelId: 1
		});
		if (answer !== 0) return;
		try {
			await invoke('local_history_restore', { rel, id: e.id });
		} catch (err) {
			notifications.error(t('localHistory.restoreFailed', { name: baseName(rel), error: String(err) }));
			return;
		}
		// The open editor takes the restored contents (and is no longer dirty).
		if (getEntry(rel)) await revertFile(rel).catch((err) => clientLog('error', `local history revert ${rel}: ${err}`));
		editors.open(rel, { preview: false });
		await this.add(rel, RESTORE_SOURCE);
		await this.load(rel);
	}

	async rename(rel: string, e: HistoryEntry) {
		const name = await quick.input({ placeholder: t('localHistory.renamePlaceholder'), hint: (v) => (v ? t('localHistory.renameHint', { name: v }) : t('localHistory.renamePlaceholder')), value: sourceLabel(e.source) });
		if (!name) return;
		try {
			await invoke('local_history_rename', { rel, id: e.id, name });
		} catch (err) {
			return notifications.error(err);
		}
		await this.load(rel);
	}

	async remove(rel: string, e: HistoryEntry) {
		const answer = await messageBox(
			t('localHistory.confirmDelete', { name: baseName(rel), date: entryDateLabel(e.timestamp, locale()) }) + '\n\n' + t('localHistory.irreversible'),
			{ kind: 'warning', buttons: [t('localHistory.deleteButton'), cancelLabel()], cancelId: 1 }
		);
		if (answer !== 0) return;
		try {
			await invoke('local_history_delete', { rel, id: e.id });
		} catch (err) {
			return notifications.error(err);
		}
		if (this.selected?.id === e.id) this.selected = null;
		await this.load(rel);
	}

	/** Delete All: every entry of every file, after asking. */
	async removeAll() {
		const answer = await messageBox(t('localHistory.confirmDeleteAll') + '\n\n' + t('localHistory.irreversible'), {
			kind: 'warning',
			buttons: [t('localHistory.deleteButton'), cancelLabel()],
			cancelId: 1
		});
		if (answer !== 0) return;
		try {
			await invoke('local_history_delete_all');
		} catch (err) {
			return notifications.error(err);
		}
		this.selected = null;
		this.entries = {};
	}

	/** Create Entry: a named entry of the active file as it is on disk. */
	async create() {
		const rel = historyFile(editors.active);
		if (!rel) return status.flash(t('localHistory.noFile'));
		const name = await quick.input({
			placeholder: t('localHistory.createPlaceholder', { name: baseName(rel) }),
			hint: (v) => (v ? t('localHistory.createHint', { name: v }) : t('localHistory.createPlaceholder', { name: baseName(rel) }))
		});
		if (!name) return;
		const entry = await this.add(rel, name);
		if (!entry) return status.flash(t('localHistory.notTracked', { name: baseName(rel) }));
		await this.load(rel);
	}

	/** Find Entry to Restore: a file with history, then one of its entries; the pick opens Compare with File. */
	async restoreViaPicker() {
		let files: string[];
		try {
			files = await invoke<string[]>('local_history_files');
		} catch (e) {
			return notifications.error(e);
		}
		if (!files.length) return status.flash(t('localHistory.none'));
		const file = await quick.choose({
			placeholder: t('localHistory.pickFile'),
			items: files.map((rel) => ({ id: rel, label: baseName(rel), description: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '' }))
		});
		if (!file) return;
		const list = [...(await this.load(file.id))].reverse();
		if (!list.length) return status.flash(t('localHistory.none'));
		const pick = await quick.choose({
			placeholder: t('localHistory.pickEntry'),
			items: list.map((e) => ({ id: e.id, label: sourceLabel(e.source), description: entryDateLabel(e.timestamp, locale()) }))
		});
		const entry = pick && list.find((e) => e.id === pick.id);
		if (entry) this.compareWithFile(file.id, entry, false);
	}

	/** The active editor's entry (Restore Contents from a Show Contents or compare tab). */
	activeEntry(): { rel: string; entry: HistoryEntry } | null {
		const key = editors.active;
		const parsed = key ? parseLocalHistoryKey(key) : null;
		const entry = parsed && this.entries[parsed.rel]?.find((e) => e.id === parsed.id);
		return parsed && entry ? { rel: parsed.rel, entry } : null;
	}
}

export const localHistory = new LocalHistory();

export function installLocalHistory(): () => void {
	textFileHooks.saved = (path, _entry, version) => localHistory.onSaved(path, version);
	const off = [
		commands.register({ id: 'workbench.action.localHistory.create', title: 'Local History: Create Entry', when: () => enabled() && historyFile(editors.active) !== null, run: () => localHistory.create() }),
		commands.register({ id: 'workbench.action.localHistory.restoreViaPicker', title: 'Local History: Find Entry to Restore', when: enabled, run: () => localHistory.restoreViaPicker() }),
		commands.register({ id: 'workbench.action.localHistory.deleteAll', title: 'Local History: Delete All', run: () => localHistory.removeAll() }),
		// VS Code's restoreViaEditor: the editor title action of a history entry's editor.
		commands.register({
			id: 'workbench.action.localHistory.restoreViaEditor',
			title: 'Local History: Restore Contents',
			when: () => localHistory.activeEntry() !== null,
			run: () => {
				const a = localHistory.activeEntry();
				if (a) void localHistory.restore(a.rel, a.entry);
			}
		})
	];
	return () => {
		textFileHooks.saved = () => {};
		off.forEach((u) => u());
	};
}
