// Unsaved work and files that cannot open as text, the way VS Code's text file and working copy
// services handle them:
// - closing a dirty editor asks Save / Don't Save / Cancel (editorGroupView.handleDirtyClosing);
// - quitting, closing the window or switching folders backs unsaved editors up (`files.hotExit`)
//   or asks (nativeWorkingCopyBackupTracker); backups are also written a second after each edit,
//   so a crash loses at most that, and restored when the folder opens again;
// - a save that finds a newer file on disk offers Compare / Overwrite / Revert
//   (textFileSaveErrorHandler);
// - binary, very large and unreadable files open as a placeholder with "Open Anyway"
//   (binaryEditor.ts, textFileEditor.ts) instead of closing the tab.
// The decisions themselves are pure (textFiles.ts).

import { untrack } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import { invoke } from '@tauri-apps/api/core';
import { message } from '@tauri-apps/plugin-dialog';
import { clientLog } from '#lib/client-log.ts';
import { adeLayout } from '#lib/ade/adeLayout.svelte.ts';
import type { FileStat, ReadOptions } from '#lib/settings/resources.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { editors } from './editors.svelte';
import { editorLabel } from './editorLabel';
import { getEntry, modelEntry, OpenError, restoreText, revertFile, saveFile, diskText, textFileHooks, type ModelEntry } from './editorModels';
import { quick } from './quick.svelte';
import { isDiffKey } from './scm';
import { status } from './status.svelte';
import {
	backsUpOnShutdown,
	backupDelay,
	closeAction,
	confirmResult,
	conflictMessage,
	encodingLabel,
	formatSize,
	isLargeModel,
	restorePlan,
	saveConfirm,
	type AutoSaveMode,
	type BackupHeader,
	type BackupMeta,
	type ConfirmResult,
	type HotExit,
	type ShutdownReason
} from './textFiles';
import { workspace } from './workspace.svelte';

export type Placeholder = { kind: 'binary' | 'tooLarge' | 'error'; size?: number; limit?: number; message?: string };
type Backup = { key: string; meta: (BackupMeta & { stat?: FileStat }) | null; content: string };

const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');
const autoSaveMode = () => settings.get<AutoSaveMode>('files.autoSave');

class TextFileService {
	/** Editors shown as a placeholder instead of text, by key. */
	placeholders = new SvelteMap<string, Placeholder>();
	/** Encoding id per open file (the status bar item). */
	encodings = new SvelteMap<string, string>();
	/** The save conflict compare: the file and its contents on disk. */
	compare = $state<{ path: string; disk: string } | null>(null);
	#accept = new Map<string, ReadOptions>();
	#pendingRestore = new Map<string, Backup>();
	#timers = new Map<string, ReturnType<typeof setTimeout>>();

	placeholder(path: string | null): Placeholder | undefined {
		return path ? this.placeholders.get(path) : undefined;
	}

	encodingOf(path: string | null): string {
		return path ? encodingLabel(this.encodings.get(path) ?? 'utf8') : '';
	}

	/** The open failed: show why in the editor instead of closing the tab. */
	openFailed(path: string, e: unknown) {
		const r = e instanceof OpenError ? e.result : { kind: 'error' as const, message: String(e) };
		const ph: Placeholder = r.kind === 'binary' ? { kind: 'binary', size: r.size } : r.kind === 'tooLarge' ? { kind: 'tooLarge', size: r.size, limit: r.limit } : { kind: 'error', message: r.kind === 'error' ? r.message : String(e) };
		this.placeholders.set(path, ph);
		clientLog('info', `${path}: shown as ${ph.kind} placeholder`);
	}

	/** "Open Anyway" / "Try Again": the editor reloads the file with the check turned off. */
	openAnyway(path: string) {
		const ph = this.placeholders.get(path);
		const accept = { ...this.#accept.get(path) };
		if (ph?.kind === 'binary') accept.acceptBinary = true;
		if (ph?.kind === 'tooLarge') accept.acceptLarge = true;
		this.#accept.set(path, accept);
		this.placeholders.delete(path);
	}

	/** Closed editors forget their placeholder and "Open Anyway", so reopening checks again. */
	prune(open: ReadonlySet<string>) {
		for (const p of [...this.placeholders.keys()]) if (!open.has(p)) this.placeholders.delete(p);
		for (const p of [...this.#accept.keys()]) if (!open.has(p)) this.#accept.delete(p);
		if (this.compare && !open.has(this.compare.path)) this.compare = null;
	}

	install(): () => void {
		textFileHooks.readOptions = (path) => this.#accept.get(path) ?? {};
		textFileHooks.created = (path, entry) => this.#created(path, entry);
		textFileHooks.clean = (path) => this.#discardBackup(path);
		textFileHooks.conflict = (path) => void this.#onConflict(path);
		textFileHooks.unencodable = (path, ch) =>
			status.flash(`บันทึก ${editorLabel(path)} ไม่ได้: encoding ${encodingLabel(getEntry(path)?.encoding ?? '')} ไม่มีอักขระ '${ch}' — ใช้ Save with Encoding (เช่น UTF-8)`, 10000);

		// Backups of the folder being shown come back once it is open (startup, Open Folder).
		let restoredFor: string | null | undefined;
		const stop = $effect.root(() => {
			$effect(() => {
				if (!workspace.ready || !settings.loaded) return;
				const root = workspace.root;
				if (root === restoredFor) return;
				restoredFor = root;
				untrack(() => void this.restoreBackups().catch((e) => clientLog('error', `restore backups: ${e}`)));
			});
		});
		return () => {
			stop();
			for (const t of this.#timers.values()) clearTimeout(t);
			this.#timers.clear();
		};
	}

	#created(path: string, entry: ModelEntry) {
		this.#accept.delete(path);
		this.encodings.set(path, entry.encoding);
		const { model } = entry;
		const backup = this.#pendingRestore.get(path);
		if (backup) {
			this.#pendingRestore.delete(path);
			this.#apply(entry, backup);
		}
		model.onDidChangeContent(() => {
			if (editors.isDirty(path)) this.#scheduleBackup(path);
		});
		model.onWillDispose(() => {
			this.#cancelBackup(path);
			this.encodings.delete(path);
		});
		if (entry.lossy) status.flash(`${editorLabel(path)}: มีไบต์ที่ไม่ถูกต้องใน ${encodingLabel(entry.encoding)} — ใช้ Reopen with Encoding ก่อนแก้ไข`, 10000);
		// VS Code's largeFileOptimizations notice.
		if (isLargeModel(model.getValueLength(), model.getLineCount()))
			status.flash(`${editorLabel(path)}: ปิด tokenization, wrapping และ folding สำหรับไฟล์ใหญ่นี้เพื่อลดหน่วยความจำ`, 10000);
	}

	syncEncoding(path: string) {
		const entry = getEntry(path);
		if (entry) this.encodings.set(path, entry.encoding);
	}

	// --- Backups

	#scheduleBackup(path: string) {
		this.#cancelBackup(path);
		const delay = backupDelay(autoSaveMode(), settings.get<number>('files.autoSaveDelay'));
		this.#timers.set(
			path,
			setTimeout(() => {
				this.#timers.delete(path);
				void this.#backup(path).catch((e) => clientLog('error', `backup ${path}: ${e}`));
			}, delay)
		);
	}

	#cancelBackup(path: string) {
		clearTimeout(this.#timers.get(path));
		this.#timers.delete(path);
	}

	async #backup(path: string) {
		const entry = getEntry(path);
		if (!entry || entry.model.isDisposed() || !editors.isDirty(path)) return;
		const meta = { encoding: entry.encoding, stat: entry.stat };
		await invoke('backup_write', { key: path, meta, content: entry.model.getValue() });
	}

	#discardBackup(path: string) {
		this.#cancelBackup(path);
		void invoke('backup_discard', { key: path }).catch(() => {});
	}

	/** Writes every given editor's backup now (shutdown); throws when one fails. */
	async backupNow(paths: string[]) {
		for (const p of paths) this.#cancelBackup(p);
		await Promise.all(paths.map((p) => this.#backup(p)));
	}

	#apply(entry: ModelEntry, backup: Backup) {
		restoreText(entry, backup.content, { encoding: backup.meta?.encoding, stat: backup.meta?.stat });
		this.encodings.set(backup.key, entry.encoding);
		// The disk already has what the backup held.
		if (!editors.isDirty(backup.key)) this.#discardBackup(backup.key);
	}

	/** VS Code's restoreBackups: every backup of this folder gets a (pinned) editor with its unsaved text. */
	async restoreBackups() {
		const headers = await invoke<BackupHeader[]>('backup_list');
		if (!headers.length) return;
		const plan = restorePlan(headers, editors.openPaths());
		const m = await import('#lib/editor/monaco.ts');
		await m.setupTextMate();
		const active = editors.active;
		for (const key of plan.restore) {
			const backup = await invoke<Backup | null>('backup_read', { key });
			if (!backup) continue;
			const entry = getEntry(key);
			if (entry) this.#apply(entry, backup);
			else this.#pendingRestore.set(key, backup);
		}
		for (const key of plan.open) editors.open(key, { preview: false });
		if (active) editors.active = active;
		// Load every restored model so its tab shows as dirty (and is saved on Save All) before it is shown.
		await Promise.all(plan.restore.map((key) => modelEntry(m, key).catch((e) => this.openFailed(key, e))));
		clientLog('info', `restored ${plan.restore.length} backup(s)`);
	}

	// --- Save conflict

	async #onConflict(path: string) {
		const name = editorLabel(path);
		const choice = await quick.choose({
			placeholder: conflictMessage(name),
			items: [
				{ id: 'compare', label: 'เปรียบเทียบ (Compare)', description: 'ดูเวอร์ชันบนดิสก์คู่กับของคุณ' },
				{ id: 'overwrite', label: 'เขียนทับ (Overwrite)', description: 'บันทึกการแก้ไขของคุณทับไฟล์บนดิสก์' },
				{ id: 'revert', label: 'ใช้เวอร์ชันบนดิสก์ (Revert)', description: 'ทิ้งการแก้ไขของคุณ' }
			]
		});
		if (choice?.id === 'overwrite') await this.overwrite(path);
		else if (choice?.id === 'revert') await this.revert(path);
		else if (choice?.id === 'compare') await this.openCompare(path);
		else status.flash(`ยังไม่ได้บันทึก ${name}: ไฟล์บนดิสก์ใหม่กว่า`, 8000);
	}

	async openCompare(path: string) {
		try {
			this.compare = { path, disk: await diskText(path) };
			editors.open(path, { preview: false });
		} catch (e) {
			status.flash(`อ่าน ${editorLabel(path)} จากดิสก์ไม่ได้: ${e}`, 8000);
		}
	}

	closeCompare() {
		this.compare = null;
	}

	/** VS Code's "Overwrite" / "Accept Your Changes". */
	async overwrite(path: string) {
		if (this.compare?.path === path) this.compare = null;
		await saveFile(path, { overwrite: true }).catch((e) => status.flash(`บันทึกไม่สำเร็จ: ${e}`, 8000));
	}

	/** VS Code's "Revert" / "Revert Your Changes": the disk contents win. */
	async revert(path: string) {
		if (this.compare?.path === path) this.compare = null;
		await revertFile(path).catch((e) => status.flash(`โหลดจากดิสก์ไม่สำเร็จ: ${e}`, 8000));
		this.syncEncoding(path);
	}

	// --- Closing editors

	/** Save / Don't Save / Cancel for `paths` (VS Code's showSaveConfirm). */
	async confirmSave(paths: string[]): Promise<ConfirmResult> {
		const c = saveConfirm(paths.map(editorLabel));
		const answer = await message(c.detail, { title: c.message, kind: 'warning', buttons: { yes: c.save, no: c.dontSave, cancel: c.cancel } });
		return confirmResult(answer, c);
	}

	/**
	 * Closes `paths` in `group`, asking about the dirty ones that are not open anywhere else (one
	 * dialog for all of them, like VS Code's Close All). `discard` closes without asking (⌥-click).
	 * Resolves to the paths that stayed open.
	 */
	async closeEditors(paths: string[], group = editors.activeGroupId, { discard = false } = {}): Promise<string[]> {
		const elsewhere = (p: string) => adeLayout.openFiles().includes(p) || editors.groups.some((g) => g.id !== group && g.tabs.some((t) => t.path === p));
		const close = (p: string) => editors.close(p, { force: true, group });
		const ask: string[] = [];
		for (const p of paths) {
			const dirty = editors.isDirty(p) && !isDiffKey(p);
			if (dirty && discard && !elsewhere(p)) this.#discardBackup(p);
			const action = discard ? 'close' : closeAction({ dirty, openElsewhere: elsewhere(p), autoSave: autoSaveMode(), isMac });
			if (action === 'close') close(p);
			else if (action === 'save' && (await saveFile(p, autoSaveMode() === 'onFocusChange' ? 'focusChange' : 'windowChange'))) close(p);
			else ask.push(p);
		}
		if (!ask.length) return [];
		if (ask.length === 1) editors.open(ask[0], { preview: false, group });
		const choice = await this.confirmSave(ask);
		if (choice === 'cancel') return ask;
		const left: string[] = [];
		for (const p of ask) {
			if (choice === 'save' && !(await saveFile(p))) left.push(p);
			else {
				if (choice === 'dontSave') this.#discardBackup(p);
				close(p);
			}
		}
		return left;
	}

	// --- Shutdown

	/**
	 * Before quitting, closing the window or switching folders: auto save if it is on, then back
	 * up (hot exit) or ask. Resolves to whether to go ahead (VS Code's veto, inverted).
	 */
	async beforeShutdown(reason: ShutdownReason): Promise<boolean> {
		const dirty = () => editors.dirtyPaths().filter((p) => !isDiffKey(p));
		if (!dirty().length) return true;
		if (autoSaveMode() !== 'off') {
			for (const p of dirty()) await saveFile(p, 'windowChange').catch((e) => clientLog('error', `save ${p}: ${e}`));
			if (!dirty().length) return true;
		}
		const remaining = dirty();
		const hotExit = settings.get<HotExit>('files.hotExit');
		if (backsUpOnShutdown({ reason, hotExit, hasFolder: workspace.root !== null, isMac })) {
			try {
				await this.backupNow(remaining);
				return true;
			} catch (e) {
				clientLog('error', `backup before shutdown: ${e}`);
				const force = reason === 'quit' ? 'ออกอยู่ดี (Quit Anyway)' : 'ปิดอยู่ดี (Close Anyway)';
				const answer = await message(`${remaining.map(editorLabel).join('\n')}\nลองบันทึกหรือย้อนการแก้ไขก่อนแล้วลองใหม่ (${e})`, {
					title: 'สำรองไฟล์ที่ยังไม่บันทึกไม่สำเร็จ (The following editors with unsaved changes could not be saved to the backup location.)',
					kind: 'error',
					buttons: { ok: 'OK', cancel: force }
				});
				return answer === force;
			}
		}
		const choice = await this.confirmSave(remaining);
		if (choice === 'cancel') return false;
		if (choice === 'save') {
			for (const p of remaining) await saveFile(p).catch((e) => status.flash(`บันทึก ${editorLabel(p)} ไม่สำเร็จ: ${e}`, 8000));
			return dirty().length === 0;
		}
		for (const p of remaining) this.#discardBackup(p);
		return true;
	}

	/** A one-line description of a placeholder, for its editor. */
	placeholderText(ph: Placeholder): string {
		if (ph.kind === 'binary') return 'ไม่แสดงไฟล์นี้ในตัวแก้ไขข้อความ เพราะเป็นไฟล์ไบนารีหรือใช้ encoding ที่ไม่รองรับ (The file is not displayed in the text editor because it is either binary or uses an unsupported text encoding.)';
		if (ph.kind === 'tooLarge')
			return ph.limit !== undefined && ph.size !== undefined && ph.size > ph.limit && ph.limit >= 1024 ** 3
				? `ไฟล์ใหญ่เกินกว่าจะเปิดได้ (${formatSize(ph.size)}) (The file is too large to open.)`
				: `ไม่แสดงไฟล์นี้ในตัวแก้ไขข้อความ เพราะใหญ่มาก (${formatSize(ph.size ?? 0)}) (The file is not displayed in the text editor because it is very large.)`;
		return `เปิดไฟล์ไม่ได้ (The editor could not be opened): ${ph.message ?? ''}`;
	}
}

export const textFiles = new TextFileService();
