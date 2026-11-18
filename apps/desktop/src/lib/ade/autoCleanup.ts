// Workspace Cleanup, automatic runs (Orca's "auto cleanup"): when to run, and the activity list.
// Pure, so the schedule and the list are tested without a window. The run itself is
// `cleanup.runRules()` (cleanup.svelte.ts): the same scan, the same evaluator, the same removal as
// the dialog and `kingu cleanup run`.

/** How often an open window looks (the rules decide whether anything is due). */
export const AUTO_CHECK_MS = 60 * 60 * 1000;
/** After the window opens, so startup work (restoring tabs, git reads) is not competing with a scan. */
export const AUTO_FIRST_MS = 2 * 60 * 1000;
export const ACTIVITY_LIMIT = 20;

export type CleanupSource = 'auto' | 'cli' | 'dialog';

export type CleanupActivity = {
	at: number;
	source: CleanupSource;
	removed: string[];
	archived: string[];
	failed: { slug: string; error: string }[];
	kept: number;
};

export type AutoState = {
	enabled: boolean;
	/** At least one rule is on for the open folder (a folder with cleanup off never runs). */
	rulesOn: boolean;
	hasFolder: boolean;
	/** The review dialog is open, or a scan or run is going: never start under the user's hands. */
	busy: boolean;
	lastRunAt: number | null;
	now: number;
};

/** Run when asked for, a rule is on, nothing else is going, and the last run was a check interval ago. */
export function autoRunDue(s: AutoState, intervalMs = AUTO_CHECK_MS): boolean {
	if (!s.enabled || !s.rulesOn || !s.hasFolder || s.busy) return false;
	return s.lastRunAt === null || s.now - s.lastRunAt >= intervalMs;
}

/**
 * When the next automatic check is expected, for `kingu cleanup report`: null when automatic cleanup is off,
 * nothing has run yet, or a check is already due (it then runs at the next look, not at a time in the past).
 */
export function nextAutoRunAt(auto: boolean, lastRunAt: number | null, now: number, intervalMs = AUTO_CHECK_MS): number | null {
	if (!auto || lastRunAt === null) return null;
	const next = lastRunAt + intervalMs;
	return next > now ? next : null;
}

/** Newest first, bounded; a run that found nothing to do is not worth a row unless it was asked for. */
export function withActivity(list: readonly CleanupActivity[], entry: CleanupActivity): CleanupActivity[] {
	if (entry.source === 'auto' && !entry.removed.length && !entry.archived.length && !entry.failed.length) return [...list];
	return [entry, ...list].slice(0, ACTIVITY_LIMIT);
}

/** Legacy shared key: used only while no folder is open; open folders get their own key (`activityKey`). */
export const ACTIVITY_KEY = 'kingu.cleanup.activity';

/** Activity and the last run belong to one folder: a run in one project must not delay another's schedule. */
export const activityKey = (root: string | null): string => (root ? `${ACTIVITY_KEY}:${root}` : ACTIVITY_KEY);
const ACTIVITY_VERSION = 1;

export type StoredActivity = { activity: CleanupActivity[]; lastRunAt: number | null };

const SOURCES: readonly CleanupSource[] = ['auto', 'cli', 'dialog'];
const time = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const text = (v: unknown): v is string => typeof v === 'string';
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One stored row, repaired field by field; null when it has no usable time or source. */
export function normalizeActivity(raw: unknown): CleanupActivity | null {
	if (!isRecord(raw)) return null;
	const at = time(raw.at);
	const source = SOURCES.find((s) => s === raw.source);
	if (at === null || !source) return null;
	const removed = Array.isArray(raw.removed) ? raw.removed.filter(text) : [];
	const archived = Array.isArray(raw.archived) ? raw.archived.filter(text) : [];
	const failed = Array.isArray(raw.failed)
		? raw.failed.filter((f): f is { slug: string; error: string } => isRecord(f) && text(f.slug) && text(f.error)).map(({ slug, error }) => ({ slug, error }))
		: [];
	const kept = time(raw.kept);
	return { at, source, removed, archived, failed, kept: kept === null ? 0 : Math.floor(kept) };
}

/** The stored payload, newest first and bounded; anything unreadable is empty rather than an error. */
export function parseStoredActivity(raw: string | null): StoredActivity {
	let data: unknown = null;
	try {
		data = raw ? JSON.parse(raw) : null;
	} catch {
		data = null;
	}
	if (!isRecord(data) || data.v !== ACTIVITY_VERSION) return { activity: [], lastRunAt: null };
	const activity = (Array.isArray(data.activity) ? data.activity : [])
		.map(normalizeActivity)
		.filter((a): a is CleanupActivity => a !== null)
		.sort((a, b) => b.at - a.at)
		.slice(0, ACTIVITY_LIMIT);
	return { activity, lastRunAt: time(data.lastRunAt) };
}

export function serializeActivity(s: StoredActivity): string {
	return JSON.stringify({ v: ACTIVITY_VERSION, activity: s.activity.slice(0, ACTIVITY_LIMIT), lastRunAt: s.lastRunAt });
}

type LockManagerLike = { request<T>(name: string, cb: () => T): Promise<T> };

/**
 * Runs `fn` under a Web Lock named `name`, so read-modify-write of one folder's Activity entry is serial across
 * windows. Without the API (an old WebView) it just runs `fn`.
 */
export function withActivityLock<T>(fn: () => T, key: string = ACTIVITY_KEY, locks: LockManagerLike | undefined = (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks): Promise<T> {
	return locks ? locks.request(key, fn) : new Promise<T>((resolve) => resolve(fn()));
}
