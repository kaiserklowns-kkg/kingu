// Quick open of the ADE's selected worktree (Orca's QuickOpen): files of that worktree, files
// visited recently first (most recent first, only those matching the query), then the rest by
// fuzzy score; `path:line[:col]` jumps to a line. Pure: history lives in localStorage through
// quickOpenHistory.svelte.ts.

import { fuzzyMatch, rank } from '#lib/workbench/fuzzy.ts';

/** Orca: QUICK_OPEN_RESULT_LIMIT, MAX_HISTORY_FILES, MAX_HISTORY_SCOPES. */
export const RESULT_LIMIT = 50;
export const HISTORY_FILES = 100;
export const HISTORY_SCOPES = 64;
/** The listing cap of `worktree_list_files` / `fs_list_files`: at it, the list may be incomplete. */
export const LISTING_CAP = 20_000;

/** Most recently used scope first; each scope's paths most recent first. */
export type QuickOpenHistory = [scope: string, paths: string[]][];

export type Ranked = { path: string; positions: number[]; recent: boolean };

/** History scope of a worktree: the folder plus the worktree key ('' = the folder itself). */
export const historyScope = (root: string, key: string) => JSON.stringify([root, key]);

/** A recent path must be a plain relative path (Orca's recent-candidate rules). */
const validRel = (p: unknown): p is string =>
	typeof p === 'string' && p.length > 0 && p.length < 4096 && !p.includes('\0') && !p.startsWith('/') && !p.split('/').includes('..');

export function parseHistory(raw: unknown): QuickOpenHistory {
	if (!Array.isArray(raw)) return [];
	const out: QuickOpenHistory = [];
	const seen = new Set<string>();
	for (const entry of raw) {
		if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Array.isArray(entry[1]) || seen.has(entry[0])) continue;
		seen.add(entry[0]);
		out.push([entry[0], [...new Set(entry[1].filter(validRel))].slice(0, HISTORY_FILES)]);
		if (out.length >= HISTORY_SCOPES) break;
	}
	return out;
}

export function historyOf(history: QuickOpenHistory, scope: string): string[] {
	return history.find(([s]) => s === scope)?.[1] ?? [];
}

/** `path` visited in `scope`: it moves to the front; the scope becomes the most recent one. Unchanged when already first. */
export function recordVisit(history: QuickOpenHistory, scope: string, path: string): QuickOpenHistory {
	if (!validRel(path)) return history;
	const current = historyOf(history, scope);
	if (current[0] === path && history[0]?.[0] === scope) return history;
	const paths = [path, ...current.filter((p) => p !== path)].slice(0, HISTORY_FILES);
	return [[scope, paths] as [string, string[]], ...history.filter(([s]) => s !== scope)].slice(0, HISTORY_SCOPES);
}

const collator = new Intl.Collator('en', { numeric: true });

/**
 * Orca's rankQuickOpenFilesWithHistory: recent files that are still in the listing and match the
 * query come first in recency order, then the other files by score (natural path order for an
 * empty query), `limit` in all.
 */
export function rankWithHistory(query: string, files: string[], history: string[], limit = RESULT_LIMIT): Ranked[] {
	const q = query.trim();
	const available = new Set(files);
	const recent: Ranked[] = [];
	for (const path of new Set(history)) {
		if (!available.has(path)) continue;
		const m = fuzzyMatch(q, path);
		if (m) recent.push({ path, positions: m.positions, recent: true });
	}
	const taken = new Set(recent.map((r) => r.path));
	const rest = files.filter((f) => !taken.has(f));
	const others: Ranked[] = q
		? rank(q, rest, (f) => f, limit).map(({ item, match }) => ({ path: item, positions: match.positions, recent: false }))
		: [...rest]
				.sort(collator.compare)
				.slice(0, limit)
				.map((path) => ({ path, positions: [], recent: false }));
	return [...recent, ...others].slice(0, limit);
}

/**
 * The query as a target: `path:line` / `path:line:col` (Orca's quick-open-query-target), unless
 * the whole query is a listed file. Line and column are 1 or more.
 */
export function parseTarget(query: string, files: ReadonlySet<string>): { query: string; line?: number; column?: number } {
	const q = query.trim();
	if (files.has(q)) return { query: q };
	const m = /^(.*?):([0-9]+)(?::([0-9]+))?$/.exec(q);
	if (!m || !m[1] || /^[a-zA-Z]$/.test(m[1])) return { query: q };
	const line = Number(m[2]);
	const column = m[3] !== undefined ? Number(m[3]) : undefined;
	if (line < 1 || (column !== undefined && column < 1)) return { query: q };
	return { query: m[1], line, column };
}

/** Where a worktree-relative file lives in the folder: `.kingu/worktrees/<slug>/<rel>` for a task. */
export const worktreeFile = (dir: string, rel: string) => (dir ? `${dir}/${rel}` : rel);

/** The worktree-relative path of a folder file key, or null when it is not in that worktree. */
export function relInWorktree(dir: string, file: string): string | null {
	if (!dir) return file.startsWith('.kingu/') ? null : file;
	return file.startsWith(`${dir}/`) ? file.slice(dir.length + 1) : null;
}
