// Pure Source Control helpers (no runes, so they are unit-testable). Shapes mirror Rust `git.rs`.

import { compareLabel, isCompareKey, parseCompareKey } from './compare';
import { isPreviewKey, previewTarget } from './viewers';
import { t } from '#lib/i18n/index.ts';
import { isChatEditKey, parseChatEditKey } from '#lib/agent/chatEdits.ts';
import { isLocalHistoryDiffKey, localHistoryTabLabel, parseLocalHistoryDiffKey, parseLocalHistoryKey } from '#lib/scm/localHistory.ts';
import { isOutputKey, outputChannelOf } from '#lib/output/output.ts';

export type StatusEntry = {
	path: string;
	orig_path: string | null;
	/** git's X letter (staged side), null when unchanged. */
	index: string | null;
	/** git's Y letter (working tree side), `?` when untracked, null when unchanged. */
	worktree: string | null;
	conflict: boolean;
};

export type GitStatus = {
	branch: string | null;
	head: string | null;
	upstream: string | null;
	ahead: number;
	behind: number;
	detached: boolean;
	/** The upstream is configured but its remote branch is gone. */
	upstream_gone: boolean;
	remotes: string[];
	/** A merge, rebase, cherry-pick or revert stopped half-way (usually on conflicts). */
	operation?: GitOperation | null;
	entries: StatusEntry[];
	/** The repository is in a parent folder of the open folder (`git.openRepositoryInParentFolders`). */
	in_parent?: boolean;
};

export type GitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

/** A row in one of the two groups ("Staged Changes" / "Changes"). */
export type Resource = { entry: StatusEntry; staged: boolean; letter: string; color: string; deleted: boolean };

/** What the Source Control view drives: the open folder's repository, or one task worktree's. */
export interface ScmSource {
	readonly repo: GitStatus | null;
	readonly loaded: boolean;
	readonly busy: boolean;
	message: string;
	/** `untracked`: untracked files in their own group (`git.untrackedChanges: separate`). */
	readonly groups: { staged: Resource[]; changes: Resource[]; untracked?: Resource[] };
	refresh(): Promise<void>;
	stage(paths: string[]): Promise<boolean>;
	unstage(paths: string[]): Promise<boolean>;
	discard(paths: string[], deleteUntracked: boolean): Promise<boolean>;
	commit(opts?: { amend?: boolean }): Promise<void>;
}

// VS Code gitDecoration.* dark colors.
export const COLORS = {
	modified: '#E2C08D',
	added: '#73C991',
	deleted: '#F48771',
	conflict: '#E4676B'
};

/** VS Code's decoration letter and color for a git status code. */
export function decoration(code: string, conflict = false): { letter: string; color: string } {
	if (conflict) return { letter: '!', color: COLORS.conflict };
	switch (code) {
		case '?':
			return { letter: 'U', color: COLORS.added };
		case 'A':
		case 'C':
			return { letter: code, color: COLORS.added };
		case 'R':
			return { letter: 'R', color: COLORS.added };
		case 'D':
			return { letter: 'D', color: COLORS.deleted };
		default:
			return { letter: code === 'T' ? 'T' : 'M', color: COLORS.modified };
	}
}

/** A change to show in a file tree: git's status code for the path, relative to the tree's root. */
export type TreeChange = { path: string; code: string; conflict?: boolean };
export type Decoration = { letter: string; color: string };

// Which color a folder takes when its children differ (VS Code: the most important change wins).
const RANK: Record<string, number> = { [COLORS.conflict]: 3, [COLORS.modified]: 2, [COLORS.added]: 1, [COLORS.deleted]: 0 };

/**
 * File tree decorations like VS Code's explorer and Orca's file panel: each changed file gets its
 * letter and color; each folder above it gets the color only (`letter: ''`). `prefix` is prepended to
 * every path, for trees whose rows are relative to an outer root (a worktree under `.kingu/`).
 */
export function fileDecorations(changes: TreeChange[], prefix = ''): Map<string, Decoration> {
	const out = new Map<string, Decoration>();
	for (const c of changes) {
		const d = decoration(c.code, c.conflict);
		const path = prefix + c.path;
		out.set(path, d);
		for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) {
			const dir = path.slice(0, i);
			const prev = out.get(dir);
			if (prev && RANK[prev.color] >= RANK[d.color]) break;
			out.set(dir, { letter: '', color: d.color });
		}
	}
	return out;
}

/** `git status` entries as tree changes: the working-tree letter wins over the staged one, like VS Code's explorer. */
export const entryChanges = (entries: StatusEntry[]): TreeChange[] =>
	entries.map((e) => ({ path: e.path, code: e.worktree ?? e.index ?? 'M', conflict: e.conflict }));

const byPath = (a: Resource, b: Resource) => a.entry.path.localeCompare(b.entry.path);

/** Splits entries like VS Code: a file staged and then edited again is in both groups. Conflicts go to Changes. */
export function groups(entries: StatusEntry[]): { staged: Resource[]; changes: Resource[] } {
	const staged: Resource[] = [];
	const changes: Resource[] = [];
	for (const entry of entries) {
		if (entry.conflict) {
			changes.push({ entry, staged: false, ...decoration('U', true), deleted: false });
			continue;
		}
		if (entry.index) staged.push({ entry, staged: true, ...decoration(entry.index), deleted: entry.index === 'D' });
		if (entry.worktree) changes.push({ entry, staged: false, ...decoration(entry.worktree), deleted: entry.worktree === 'D' });
	}
	return { staged: staged.sort(byPath), changes: changes.sort(byPath) };
}

/** git.enableSmartCommit with nothing staged: what to stage first (`git.smartCommitChanges`). Conflicts are left to the user. */
export function smartCommitPaths(changes: readonly Resource[], mode: 'all' | 'tracked'): string[] {
	return changes.filter((r) => !r.entry.conflict && (mode === 'all' || r.entry.worktree !== '?')).map((r) => r.entry.path);
}

/** `src/lib/a.ts` → `['a.ts', 'src/lib']`. */
export function splitPath(path: string): [name: string, dir: string] {
	const i = path.lastIndexOf('/');
	return i < 0 ? [path, ''] : [path.slice(i + 1), path.slice(0, i)];
}

/** Editor tab key for a diff of a workspace file against HEAD. */
export const DIFF_PREFIX = 'diff:';
export const diffKey = (rel: string) => DIFF_PREFIX + rel;
/** Diff of a file in a task worktree against the task's fork point: `taskdiff://<slug>/<rel>`. */
export const TASK_DIFF_PREFIX = 'taskdiff://';
export const taskDiffKey = (slug: string, rel: string) => `${TASK_DIFF_PREFIX}${slug}/${rel}`;
export const isTaskDiffKey = (key: string) => key.startsWith(TASK_DIFF_PREFIX);
/** `{ slug, rel }` of a task diff key (`rel` is relative to the worktree), else null. */
export function parseTaskDiffKey(key: string): { slug: string; rel: string } | null {
	if (!isTaskDiffKey(key)) return null;
	const rest = key.slice(TASK_DIFF_PREFIX.length);
	const i = rest.indexOf('/');
	return i <= 0 ? null : { slug: rest.slice(0, i), rel: rest.slice(i + 1) };
}

/** A file as one commit changed it: `commitdiff://<slug or _>/<hash>/<rel>` (Commits panel). */
export const COMMIT_DIFF_PREFIX = 'commitdiff://';
export const commitDiffKey = (slug: string, hash: string, rel: string) => `${COMMIT_DIFF_PREFIX}${slug || '_'}/${hash}/${rel}`;
export const isCommitDiffKey = (key: string) => key.startsWith(COMMIT_DIFF_PREFIX);
export function parseCommitDiffKey(key: string): { slug: string; hash: string; rel: string } | null {
	if (!isCommitDiffKey(key)) return null;
	const [slug, hash, ...rest] = key.slice(COMMIT_DIFF_PREFIX.length).split('/');
	return slug && hash && rest.length ? { slug: slug === '_' ? '' : slug, hash, rel: rest.join('/') } : null;
}

/** Staged Changes: HEAD ↔ index of a file, `indexdiff:<rel>` (VS Code's "a.ts (Index)"). `diff:` is index ↔ working tree. */
export const INDEX_DIFF_PREFIX = 'indexdiff:';
export const indexDiffKey = (rel: string) => INDEX_DIFF_PREFIX + rel;
export const isIndexDiffKey = (key: string) => key.startsWith(INDEX_DIFF_PREFIX);
export const parseIndexDiffKey = (key: string) => (isIndexDiffKey(key) ? key.slice(INDEX_DIFF_PREFIX.length) : null);

/**
 * A file as one commit of its history changed it, with the path it had before (Timeline, View
 * File History): `histdiff://<hash>/<encoded path before or _>/<rel>`.
 */
export const HISTORY_DIFF_PREFIX = 'histdiff://';
export const historyDiffKey = (hash: string, rel: string, before?: string | null) => `${HISTORY_DIFF_PREFIX}${hash}/${before && before !== rel ? encodeURIComponent(before) : '_'}/${rel}`;
export const isHistoryDiffKey = (key: string) => key.startsWith(HISTORY_DIFF_PREFIX);
export function parseHistoryDiffKey(key: string): { hash: string; rel: string; before: string } | null {
	if (!isHistoryDiffKey(key)) return null;
	const [hash, before, ...rest] = key.slice(HISTORY_DIFF_PREFIX.length).split('/');
	if (!hash || !before || !rest.length) return null;
	const rel = rest.join('/');
	return { hash, rel, before: before === '_' ? rel : decodeURIComponent(before) };
}

/**
 * A file at one revision ↔ at another, or ↔ the working copy (Source Control Graph, a stash,
 * Compare with Branch or Tag): `refdiff://<left>/<right or ~>/<path before or _>/<rel>`, the
 * revisions and the earlier path URI-encoded (branch names have slashes).
 */
export const REF_DIFF_PREFIX = 'refdiff://';
export const refDiffKey = (left: string, right: string | null, rel: string, before?: string | null) =>
	`${REF_DIFF_PREFIX}${encodeURIComponent(left)}/${right === null ? '~' : encodeURIComponent(right)}/${before && before !== rel ? encodeURIComponent(before) : '_'}/${rel}`;
export const isRefDiffKey = (key: string) => key.startsWith(REF_DIFF_PREFIX);
export function parseRefDiffKey(key: string): { left: string; right: string | null; rel: string; before: string } | null {
	if (!isRefDiffKey(key)) return null;
	const [left, right, before, ...rest] = key.slice(REF_DIFF_PREFIX.length).split('/');
	if (!left || !right || !before || !rest.length) return null;
	const rel = rest.join('/');
	try {
		return { left: decodeURIComponent(left), right: right === '~' ? null : decodeURIComponent(right), rel, before: before === '_' ? rel : decodeURIComponent(before) };
	} catch {
		return null;
	}
}
/** A revision as a tab shows it: a commit id shortened, a ref name as it is (`HEAD~1`, `origin/main`). */
const revLabel = (rev: string) => rev.replace(/^([0-9a-f]{7})[0-9a-f]{33}(?:[0-9a-f]{24})?/, '$1');

/** merge-conflict.compare: the file with every conflict as its current side ↔ as its incoming side. */
export const CONFLICT_COMPARE_PREFIX = 'conflictcompare:';
export const conflictCompareKey = (rel: string) => CONFLICT_COMPARE_PREFIX + rel;
export const isConflictCompareKey = (key: string) => key.startsWith(CONFLICT_COMPARE_PREFIX);

/** The 3-way merge editor of a conflicted file: `merge://<rel>`. */
export const MERGE_PREFIX = 'merge://';
export const mergeKey = (rel: string) => MERGE_PREFIX + rel;
export const isMergeKey = (key: string) => key.startsWith(MERGE_PREFIX);

/** A chat's working-set file, its snapshot before the agent's edits vs now: `chatedit://<chat id>/<file>` (agent/chatEdits.ts). */
export const isDiffKey = (key: string) =>
	key.startsWith(DIFF_PREFIX) || isIndexDiffKey(key) || isHistoryDiffKey(key) || isRefDiffKey(key) || isConflictCompareKey(key) || isTaskDiffKey(key) || isCommitDiffKey(key) || isChatEditKey(key) || isLocalHistoryDiffKey(key) || isCompareKey(key);
/** The workspace file behind an editor tab key (itself for plain file tabs; a task diff's file
 * lives in the worktree under `.kingu/worktrees/<slug>/`). */
export function fileOf(key: string): string {
	if (isPreviewKey(key)) return previewTarget(key);
	const chatEdit = parseChatEditKey(key);
	if (chatEdit) return chatEdit.rel;
	const compare = parseCompareKey(key);
	if (compare) return compare.right;
	const task = parseTaskDiffKey(key);
	if (task) return `.kingu/worktrees/${task.slug}/${task.rel}`;
	const commit = parseCommitDiffKey(key);
	if (commit) return commit.slug ? `.kingu/worktrees/${commit.slug}/${commit.rel}` : commit.rel;
	const history = parseHistoryDiffKey(key);
	if (history) return history.rel;
	const ref = parseRefDiffKey(key);
	if (ref) return ref.rel;
	const local = parseLocalHistoryDiffKey(key) ?? parseLocalHistoryKey(key);
	if (local) return local.rel;
	for (const prefix of [INDEX_DIFF_PREFIX, CONFLICT_COMPARE_PREFIX, MERGE_PREFIX]) if (key.startsWith(prefix)) return key.slice(prefix.length);
	return key.startsWith(DIFF_PREFIX) ? key.slice(DIFF_PREFIX.length) : key;
}

/** Tab label: `a.ts`, or `a.ts (Working Tree)` for a diff, like VS Code; `a.ts (task slug)` for a task diff. */
export function tabLabel(key: string): string {
	if (isOutputKey(key)) return outputChannelOf(key);
	const [name] = splitPath(fileOf(key));
	const local = localHistoryTabLabel(key);
	if (local) return local;
	const task = parseTaskDiffKey(key);
	if (task) return t('workbench.scm.taskDiffLabel', { name, slug: task.slug });
	const compare = parseCompareKey(key);
	if (compare) return compareLabel(compare.left, compare.right, { saved: t('workbench.compare.saved'), clipboard: t('workbench.compare.clipboard') });
	const commit = parseCommitDiffKey(key);
	if (commit) return `${name} (${commit.hash.slice(0, 7)})`;
	if (isChatEditKey(key)) return t('chatEdits.diffLabel', { name });
	if (isIndexDiffKey(key)) return `${name} (Index)`;
	const history = parseHistoryDiffKey(key);
	if (history) return `${name} (${history.hash.slice(0, 7)})`;
	const ref = parseRefDiffKey(key);
	if (ref) return `${name} (${revLabel(ref.left)} ↔ ${ref.right === null ? 'Working Tree' : revLabel(ref.right)})`;
	if (isConflictCompareKey(key)) return t('scmEditor.compareLabel', { name });
	if (isMergeKey(key)) return t('scmEditor.merge.tabLabel', { name });
	if (isPreviewKey(key)) return `Preview ${name}`;
	return isDiffKey(key) ? `${name} (Working Tree)` : name;
}
