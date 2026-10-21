import { t } from '#lib/i18n/index.ts';
// The decisions behind saving, closing and quitting with unsaved editors, and the encoding and
// status bar tables, kept pure so `bun test` covers them. Each follows the VS Code source named
// beside it; textFileService.svelte.ts runs them against the real editors and dialogs.

// --- Encodings (workbench/services/textfile/common/encoding.ts SUPPORTED_ENCODINGS): the ones
// Rust's encoding_rs implements (src-tauri/src/textfile.rs), in VS Code's picker order.

export type EncodingInfo = { labelLong: string; labelShort: string; order: number };

const E = (labelLong: string, labelShort: string, order: number): EncodingInfo => ({ labelLong, labelShort, order });

export const ENCODINGS: Record<string, EncodingInfo> = {
	utf8: E('UTF-8', 'UTF-8', 1),
	utf8bom: E('UTF-8 with BOM', 'UTF-8 with BOM', 2),
	utf16le: E('UTF-16 LE', 'UTF-16 LE', 3),
	utf16be: E('UTF-16 BE', 'UTF-16 BE', 4),
	windows1252: E('Western (Windows 1252)', 'Windows 1252', 5),
	iso88591: E('Western (ISO 8859-1)', 'ISO 8859-1', 6),
	iso88593: E('Western (ISO 8859-3)', 'ISO 8859-3', 7),
	iso885915: E('Western (ISO 8859-15)', 'ISO 8859-15', 8),
	macroman: E('Western (Mac Roman)', 'Mac Roman', 9),
	windows1256: E('Arabic (Windows 1256)', 'Windows 1256', 11),
	iso88596: E('Arabic (ISO 8859-6)', 'ISO 8859-6', 12),
	windows1257: E('Baltic (Windows 1257)', 'Windows 1257', 13),
	iso88594: E('Baltic (ISO 8859-4)', 'ISO 8859-4', 14),
	iso885914: E('Celtic (ISO 8859-14)', 'ISO 8859-14', 15),
	windows1250: E('Central European (Windows 1250)', 'Windows 1250', 16),
	iso88592: E('Central European (ISO 8859-2)', 'ISO 8859-2', 17),
	windows1251: E('Cyrillic (Windows 1251)', 'Windows 1251', 19),
	cp866: E('Cyrillic (CP 866)', 'CP 866', 20),
	iso88595: E('Cyrillic (ISO 8859-5)', 'ISO 8859-5', 22),
	koi8r: E('Cyrillic (KOI8-R)', 'KOI8-R', 23),
	koi8u: E('Cyrillic (KOI8-U)', 'KOI8-U', 24),
	iso885913: E('Estonian (ISO 8859-13)', 'ISO 8859-13', 25),
	windows1253: E('Greek (Windows 1253)', 'Windows 1253', 26),
	iso88597: E('Greek (ISO 8859-7)', 'ISO 8859-7', 27),
	windows1255: E('Hebrew (Windows 1255)', 'Windows 1255', 28),
	iso88598: E('Hebrew (ISO 8859-8)', 'ISO 8859-8', 29),
	iso885910: E('Nordic (ISO 8859-10)', 'ISO 8859-10', 30),
	iso885916: E('Romanian (ISO 8859-16)', 'ISO 8859-16', 31),
	windows1254: E('Turkish (Windows 1254)', 'Windows 1254', 32),
	iso88599: E('Turkish (ISO 8859-9)', 'ISO 8859-9', 33),
	windows1258: E('Vietnamese (Windows 1258)', 'Windows 1258', 35),
	gbk: E('Simplified Chinese (GBK)', 'GBK', 36),
	gb18030: E('Simplified Chinese (GB18030)', 'GB18030', 37),
	cp950: E('Traditional Chinese (Big5)', 'Big5', 38),
	big5hkscs: E('Traditional Chinese (Big5-HKSCS)', 'Big5-HKSCS', 39),
	shiftjis: E('Japanese (Shift JIS)', 'Shift JIS', 40),
	eucjp: E('Japanese (EUC-JP)', 'EUC-JP', 41),
	euckr: E('Korean (EUC-KR)', 'EUC-KR', 42),
	windows874: E('Thai (Windows 874)', 'Windows 874', 43),
	iso885911: E('Latin/Thai (ISO 8859-11)', 'ISO 8859-11', 44),
	koi8ru: E('Cyrillic (KOI8-RU)', 'KOI8-RU', 45),
	gb2312: E('Simplified Chinese (GB 2312)', 'GB 2312', 47)
};

export const encodingLabel = (id: string) => ENCODINGS[id]?.labelShort ?? id;

export type EncodingPick = { id: string; label: string; description?: string };

/**
 * Items of "Reopen with Encoding" / "Save with Encoding" (VS Code's ChangeEncodingAction): the
 * configured encoding first, then picker order; a guessed encoding that differs from the
 * configured one goes on top as "Guessed from content". `activeId` is the editor's encoding.
 */
export function encodingPicks(configured: string, guessed?: string): EncodingPick[] {
	const ids = Object.keys(ENCODINGS)
		.sort((a, b) => (a === configured ? -1 : b === configured ? 1 : ENCODINGS[a].order - ENCODINGS[b].order))
		.filter((k) => !(k === guessed && guessed !== configured));
	const picks: EncodingPick[] = ids.map((id) => ({ id, label: ENCODINGS[id].labelLong, description: id }));
	if (guessed && guessed !== configured && ENCODINGS[guessed]) {
		picks.unshift({ id: guessed, label: ENCODINGS[guessed].labelLong, description: 'Guessed from content' });
	}
	return picks;
}

// --- Save confirmation (abstractFileDialogService.doShowSaveConfirm + dialogs.getFileNamesMessage)

export const MAX_CONFIRM_FILES = 10;
export type ConfirmResult = 'save' | 'dontSave' | 'cancel';

export function fileNamesMessage(names: string[]): string {
	const lines = names.slice(0, MAX_CONFIRM_FILES);
	const more = names.length - MAX_CONFIRM_FILES;
	if (more > 0) lines.push(t('workbench.textFiles.moreNotShown', { count: more }));
	lines.push('');
	return lines.join('\n');
}

export type SaveConfirm = { message: string; detail: string; save: string; dontSave: string; cancel: string };

export function saveConfirm(names: string[]): SaveConfirm {
	const lost = t('workbench.textFiles.changesLost');
	if (names.length === 1)
		return {
			message: t('workbench.textFiles.saveOne', { name: names[0] }),
			detail: lost,
			save: t('common.save'),
			dontSave: t('common.dontSave'),
			cancel: t('common.cancel')
		};
	return {
		message: t('workbench.textFiles.saveMany', { count: names.length }),
		detail: fileNamesMessage(names) + '\n' + lost,
		save: t('workbench.textFiles.saveAll'),
		dontSave: t('common.dontSave'),
		cancel: t('common.cancel')
	};
}

/** The dialog's answer (the label of the pressed button, or Tauri's Yes/No/Cancel) as a choice. */
export function confirmResult(answer: string, c: SaveConfirm): ConfirmResult {
	if (answer === c.save || answer === 'Yes') return 'save';
	if (answer === c.dontSave || answer === 'No') return 'dontSave';
	return 'cancel';
}

// --- Closing a dirty editor (editorGroupView.doHandleCloseConfirmation)

export type AutoSaveMode = 'off' | 'afterDelay' | 'onFocusChange' | 'onWindowChange';

/**
 * `close`: no question (the file stays open elsewhere, or is not dirty); `save`: save without
 * asking because a dialog would itself trigger auto save (onFocusChange everywhere,
 * onWindowChange on Windows/Linux); `ask`: Save / Don't Save / Cancel.
 */
export function closeAction(o: { dirty: boolean; openElsewhere: boolean; autoSave: AutoSaveMode; isMac: boolean }): 'close' | 'save' | 'ask' {
	if (!o.dirty || o.openElsewhere) return 'close';
	if (o.autoSave === 'onFocusChange' || (o.autoSave === 'onWindowChange' && !o.isMac)) return 'save';
	return 'ask';
}

/** What closing editors needs from the workbench (the IDE's groups or the Agents layout's tabs). */
export type ClosePorts = {
	isDirty: (path: string) => boolean;
	/** Another editor keeps showing the file's model, so closing this one loses nothing. */
	openElsewhere: (path: string) => boolean;
	autoSave: AutoSaveMode;
	isMac: boolean;
	save: (path: string, reason?: 'focusChange' | 'windowChange') => Promise<boolean>;
	/** Save / Don't Save / Cancel for these paths. */
	confirm: (paths: string[]) => Promise<ConfirmResult>;
	/** Unsaved edits are thrown away: their hot exit backup goes too. */
	discardBackup: (path: string) => void;
	/** Shows the only file asked about, so the user sees what the question is about. */
	reveal?: (path: string) => void;
};

/**
 * VS Code's handleDirtyClosing for `paths`: resolves to the ones that may close now, in order.
 * `discard` closes without asking (⌥-click). One dialog covers every dirty file.
 */
export async function settleClose(paths: string[], p: ClosePorts, { discard = false } = {}): Promise<string[]> {
	const ok: string[] = [];
	const ask: string[] = [];
	for (const path of paths) {
		const dirty = p.isDirty(path);
		const elsewhere = p.openElsewhere(path);
		if (dirty && discard && !elsewhere) p.discardBackup(path);
		const action = discard ? 'close' : closeAction({ dirty, openElsewhere: elsewhere, autoSave: p.autoSave, isMac: p.isMac });
		if (action === 'close') ok.push(path);
		else if (action === 'save' && (await p.save(path, p.autoSave === 'onFocusChange' ? 'focusChange' : 'windowChange'))) ok.push(path);
		else ask.push(path);
	}
	if (!ask.length) return ok;
	if (ask.length === 1) p.reveal?.(ask[0]);
	const choice = await p.confirm(ask);
	if (choice === 'cancel') return ok;
	for (const path of ask) {
		if (choice === 'save' && !(await p.save(path))) continue;
		if (choice === 'dontSave') p.discardBackup(path);
		ok.push(path);
	}
	return ok;
}

// --- Quitting, closing the window, switching folders (nativeWorkingCopyBackupTracker)

export type HotExit = 'off' | 'onExit' | 'onExitAndWindowClose';
export type ShutdownReason = 'quit' | 'close' | 'load' | 'reload';

/**
 * Whether unsaved editors are backed up and restored next time (hot exit) instead of asking
 * (VS Code's nativeWorkingCopyBackupTracker). Closing a window backs up with a folder open and
 * `onExitAndWindowClose`; otherwise only when it quits the app: the last window on
 * Windows/Linux (`lastWindow`), never on macOS, where the app keeps running.
 */
export function backsUpOnShutdown(o: { reason: ShutdownReason; hotExit: HotExit; hasFolder: boolean; isMac: boolean; lastWindow?: boolean }): boolean {
	if (o.hotExit === 'off') return false;
	switch (o.reason) {
		case 'quit':
		case 'reload':
			return true;
		case 'close':
			if (o.hasFolder && o.hotExit === 'onExitAndWindowClose') return true;
			return !o.isMac && (o.lastWindow ?? true);
		case 'load':
			return o.hasFolder && o.hotExit === 'onExitAndWindowClose';
	}
}

/** VS Code's DEFAULT_BACKUP_SCHEDULE_DELAYS: later when auto save is about to save anyway. */
export function backupDelay(autoSave: AutoSaveMode, autoSaveDelay: number): number {
	return autoSave === 'afterDelay' && autoSaveDelay <= 1000 ? 2000 : 1000;
}

// --- Backups

/** What a backup records besides the text, so the restored editor saves like the original would. */
export type BackupMeta = { encoding?: string; mtime?: number; hash?: string };
export type BackupHeader = { key: string; meta: BackupMeta | null };

/**
 * Restoring backups (workingCopyBackupTracker.restoreBackups): every backup gets an editor;
 * the ones not open already open pinned in the background, in key order.
 */
export function restorePlan(backups: BackupHeader[], open: ReadonlySet<string>): { open: string[]; restore: string[] } {
	const keys = [...new Set(backups.map((b) => b.key))].sort();
	return { open: keys.filter((k) => !open.has(k)), restore: keys };
}

// --- Save conflict (textFileSaveErrorHandler)

export type ConflictChoice = 'compare' | 'overwrite' | 'revert';

export function conflictMessage(name: string): string {
	return t('workbench.textFiles.conflict', { name });
}

/**
 * The watcher saw an open file change on disk (an agent writing into a task worktree, a git
 * checkout, another program). A clean editor reloads. A dirty one is never overwritten silently:
 * when its disk content really differs it goes into conflict mode, which pauses auto save
 * (`inConflict`), and with auto save on the save conflict prompt shows right away (auto save
 * would otherwise have hit it on its own). With auto save off the next explicit save shows it.
 */
export function diskChangeAction(o: { dirty: boolean; inConflict: boolean; diskDiffers: boolean; autoSave: AutoSaveMode }): 'reload' | 'conflict' | 'pause' | 'none' {
	if (!o.dirty) return 'reload';
	if (o.inConflict || !o.diskDiffers) return 'none';
	return o.autoSave === 'off' ? 'pause' : 'conflict';
}

// --- Status bar (editorStatus.ts)

/** The indentation item: `Spaces: 4`, `Spaces: 2 (4 wide tabs)` or `Tab Size: 4`. */
export function indentLabel(o: { insertSpaces: boolean; tabSize: number; indentSize: number }): string {
	if (!o.insertSpaces) return `Tab Size: ${o.tabSize}`;
	return o.indentSize !== o.tabSize ? `Spaces: ${o.indentSize} (${o.tabSize} wide tabs)` : `Spaces: ${o.indentSize}`;
}

/** Tab size picks 1–8 (indentation.ts ChangeIndentationSizeAction) with VS Code's descriptions. */
export function tabSizePicks(configured: number, current: number): { id: string; label: string; description?: string }[] {
	return [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
		id: String(n),
		label: String(n),
		description: n === configured && n === current ? 'Configured Tab Size' : n === configured ? 'Default Tab Size' : n === current ? 'Current Tab Size' : undefined
	}));
}

/** "Configure File Association for '.ext'": `*.ext` for `name.ext`, else the whole name (`Dockerfile`, `.gitignore`). */
export function associationKey(path: string): string {
	const base = path.split('/').pop() ?? path;
	const dot = base.lastIndexOf('.');
	return dot > 0 ? `*${base.slice(dot)}` : base;
}

/** VS Code's large file thresholds for turning off tokenization and other features (textModel.ts). */
export const LARGE_FILE_SIZE = 20 * 1024 * 1024;
export const LARGE_FILE_LINES = 300_000;
export const isLargeModel = (length: number, lines: number) => length > LARGE_FILE_SIZE || lines > LARGE_FILE_LINES;

/** Bytes as VS Code's ByteSize.formatSize does. */
export function formatSize(size: number): string {
	const KB = 1024, MB = KB * 1024, GB = MB * 1024;
	if (size < KB) return `${size}B`;
	if (size < MB) return `${(size / KB).toFixed(2)}KB`;
	if (size < GB) return `${(size / MB).toFixed(2)}MB`;
	return `${(size / GB).toFixed(2)}GB`;
}
