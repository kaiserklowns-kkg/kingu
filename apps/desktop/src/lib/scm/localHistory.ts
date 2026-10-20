// Local History helpers (VS Code: contrib/localHistory, services/workingCopy/common/
// workingCopyHistory*.ts), free of runes so they are unit-tested. The store is Rust
// local_history.rs; the model and commands are localHistory.svelte.ts.

import { t } from '#lib/i18n/index.ts';
import { enabledGlobs } from '#lib/settings/mappings.ts';

/** One entry (Rust `local_history::Entry`). `source` null is VS Code's default, "File Saved". */
export type HistoryEntry = { id: string; source: string | null; sourceDescription: string | null; timestamp: number };

/** What Rust `HistorySettings` reads, from `workbench.localHistory.*`. */
export type HistorySettings = { maxEntries: number; maxFileSizeKb: number; mergeWindowSecs: number; exclude: string[] };

export function historySettingsFrom(get: (id: string) => unknown): HistorySettings {
	const num = (id: string, fallback: number, min: number) => {
		const v = get(id);
		return typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.floor(v)) : fallback;
	};
	const exclude = get('workbench.localHistory.exclude');
	return {
		maxEntries: num('workbench.localHistory.maxFileEntries', 50, 0),
		maxFileSizeKb: num('workbench.localHistory.maxFileSize', 256, 1),
		mergeWindowSecs: num('workbench.localHistory.mergeWindow', 10, 1),
		exclude: exclude && typeof exclude === 'object' ? enabledGlobs(exclude as Record<string, unknown>) : []
	};
}

/** VS Code's registered save sources (SaveSourceRegistry ids) that Kingu writes. */
export const RESTORE_SOURCE = 'localHistoryRestore.source';
export const UNDO_REDO_SOURCE = 'undoRedo.source';

/** SaveSourceRegistry.getSourceLabel: a registered id's label, else the source itself (a name the user gave). */
export function sourceLabel(source: string | null): string {
	if (!source || source === 'default.source') return t('localHistory.source.saved');
	if (source === RESTORE_SOURCE) return t('localHistory.source.restored');
	if (source === UNDO_REDO_SOURCE) return t('localHistory.source.undoRedo');
	return source;
}

/** The read-only contents of an entry: `localhistory://<entry id>/<rel>` (Show Contents). */
export const LOCAL_HISTORY_PREFIX = 'localhistory://';
export const localHistoryKey = (id: string, rel: string) => `${LOCAL_HISTORY_PREFIX}${id}/${rel}`;
export const isLocalHistoryKey = (key: string) => key.startsWith(LOCAL_HISTORY_PREFIX);
export function parseLocalHistoryKey(key: string): { id: string; rel: string } | null {
	if (!isLocalHistoryKey(key)) return null;
	const rest = key.slice(LOCAL_HISTORY_PREFIX.length);
	const i = rest.indexOf('/');
	return i <= 0 || i === rest.length - 1 ? null : { id: rest.slice(0, i), rel: rest.slice(i + 1) };
}

/**
 * A compare of local history: `lhdiff://<left entry id>/<right entry id or _>/<rel>`, `_` being
 * the file as it is now (Compare with File); two ids are Compare with Previous / with Selected.
 */
export const LOCAL_HISTORY_DIFF_PREFIX = 'lhdiff://';
export const localHistoryDiffKey = (left: string, right: string | null, rel: string) => `${LOCAL_HISTORY_DIFF_PREFIX}${left}/${right ?? '_'}/${rel}`;
export const isLocalHistoryDiffKey = (key: string) => key.startsWith(LOCAL_HISTORY_DIFF_PREFIX);
export function parseLocalHistoryDiffKey(key: string): { left: string; right: string | null; rel: string } | null {
	if (!isLocalHistoryDiffKey(key)) return null;
	const [left, right, ...rest] = key.slice(LOCAL_HISTORY_DIFF_PREFIX.length).split('/');
	if (!left || !right || !rest.length || !rest.join('/')) return null;
	return { left, right: right === '_' ? null : right, rel: rest.join('/') };
}

/** `(source • date)` of an entry the model has loaded (set by localHistory.svelte.ts), for tab labels. */
export const entryLabels: { of: (rel: string, id: string) => string | null } = { of: () => null };

/** Tab labels like VS Code's localHistoryEditorLabel / CompareToFile / CompareToPrevious editor labels. */
export function localHistoryTabLabel(key: string): string | null {
	const name = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1);
	const label = (rel: string, id: string) => entryLabels.of(rel, id) ?? t('localHistory.title');
	const content = parseLocalHistoryKey(key);
	if (content) return `${name(content.rel)} (${label(content.rel, content.id)})`;
	const diff = parseLocalHistoryDiffKey(key);
	if (!diff) return null;
	const left = `${name(diff.rel)} (${label(diff.rel, diff.left)})`;
	return `${left} ↔ ${diff.right ? `${name(diff.rel)} (${label(diff.rel, diff.right)})` : name(diff.rel)}`;
}

/** The entry before `id` (entries are oldest first), for Compare with Previous; none for the first. */
export function previousEntry(entries: readonly HistoryEntry[], id: string): HistoryEntry | null {
	const i = entries.findIndex((e) => e.id === id);
	return i > 0 ? entries[i - 1] : null;
}

/** VS Code's toLocalHistoryEntryDateLabel: a short date and time. */
export const entryDateLabel = (timestamp: number, locale: string) =>
	new Date(timestamp).toLocaleString(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** The Timeline sources (VS Code's timeline providers), shown unless filtered out. */
export type TimelineSource = 'git' | 'local';

/** Rows of two Timeline sources merged newest first (VS Code's timeline sorts every provider's items by time). */
export function mergeByTime<A, B>(a: readonly A[], timeA: (x: A) => number, b: readonly B[], timeB: (x: B) => number): ({ from: 'a'; item: A } | { from: 'b'; item: B })[] {
	const out: ({ from: 'a'; item: A } | { from: 'b'; item: B })[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		if (j >= b.length || (i < a.length && timeA(a[i]) >= timeB(b[j]))) out.push({ from: 'a', item: a[i++] });
		else out.push({ from: 'b', item: b[j++] });
	}
	return out;
}

/**
 * VS Code's tracker skips a save whose content already has an entry (the model's version did not
 * change since the last one was added). Returns whether `version` of `path` is new, and records it.
 */
export class SavedVersions {
	#last = new Map<string, number>();
	isNew(path: string, version: number): boolean {
		if (this.#last.get(path) === version) return false;
		this.#last.set(path, version);
		return true;
	}
	forget(path: string) {
		this.#last.delete(path);
	}
}
