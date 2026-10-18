// VS Code's git.* and scm.* settings as what Source Control does (pure, so `bun test` checks each):
// git arguments, branch names, commit message checks, protected branches, the count badge,
// resource grouping and sorting. scm.svelte.ts, ScmView.svelte and the status/activity bars call
// these with `settings.get`.

import type { Get } from '#lib/settings/mappings.ts';
import { globToRegExp } from '#lib/settings/mappings.ts';
import type { Resource, StatusEntry } from './scm';
import { t } from '#lib/i18n/index.ts';

// ---------------------------------------------------------------------------------------------
// git arguments (Rust takes these as option structs: git.rs / git_remote.rs)

export type FetchOptions = { all: boolean; prune: boolean };
export type PullOptions = { rebase: boolean; tags: boolean; autoStash: boolean; fetchAll: boolean; replaceTags: boolean };
export type ForcePush = 'force' | 'withLease' | 'withLeaseIfIncludes';
export type PushOptions = { force: ForcePush | null; followTags: boolean };
export type CommitOptions = { amend: boolean; signoff: boolean; sign: boolean; noVerify: boolean; empty: boolean };
export type StatusOptions = { similarityThreshold: number; ignoreSubmodules: boolean };

/** `git.autofetch`: `true` fetches the default remote, `"all"` every remote. */
export function autofetchMode(get: Get): 'off' | 'default' | 'all' {
	const v = get<boolean | 'all'>('git.autofetch');
	return v === 'all' ? 'all' : v === true ? 'default' : 'off';
}

/** Fetch (`git.pruneOnFetch`); autofetch with `git.autofetch: "all"` fetches every remote. */
export function fetchOptions(get: Get, { auto = false } = {}): FetchOptions {
	return { all: auto && autofetchMode(get) === 'all', prune: get<boolean>('git.pruneOnFetch') };
}

/** Pull, Pull (Rebase) and the pull half of Sync (`git.rebaseWhenSync`). */
export function pullOptions(get: Get, { rebase = false, sync = false } = {}): PullOptions {
	return {
		rebase: rebase || (sync && get<boolean>('git.rebaseWhenSync')),
		tags: get<boolean>('git.pullTags'),
		autoStash: get<boolean>('git.autoStash'),
		fetchAll: get<boolean>('git.fetchOnPull'),
		replaceTags: get<boolean>('git.replaceTagsWhenPull')
	};
}

/** Push, Push (Force) and the push half of Sync (`git.followTagsWhenSync`). */
export function pushOptions(get: Get, { force = false, sync = false } = {}): PushOptions {
	let mode: ForcePush | null = null;
	if (force) mode = !get<boolean>('git.useForcePushWithLease') ? 'force' : get<boolean>('git.useForcePushIfIncludes') ? 'withLeaseIfIncludes' : 'withLease';
	return { force: mode, followTags: sync && get<boolean>('git.followTagsWhenSync') };
}

export function commitOptions(get: Get, { amend = false, noVerify = false, empty = false } = {}): CommitOptions {
	return { amend, signoff: get<boolean>('git.alwaysSignOff'), sign: get<boolean>('git.enableCommitSigning'), noVerify, empty };
}

export function statusOptions(get: Get): StatusOptions {
	return { similarityThreshold: get<number>('git.similarityThreshold'), ignoreSubmodules: get<boolean>('git.ignoreSubmodules') };
}

/** The same pull for a terminal (where the user can authenticate). */
export function pullCommand(o: PullOptions): string[] {
	const out = ['git', 'pull'];
	if (o.tags) out.push('--tags');
	if (o.autoStash) out.push('--autostash');
	out.push(...(o.rebase ? ['--rebase'] : ['--no-rebase', '--ff-only']));
	return out;
}

// ---------------------------------------------------------------------------------------------
// Branch names

const DICTIONARIES: Record<string, readonly string[]> = {
	adjectives: ['brave', 'calm', 'eager', 'fancy', 'gentle', 'happy', 'jolly', 'kind', 'lively', 'nice', 'proud', 'quick', 'silly', 'swift', 'witty', 'zany'],
	animals: ['badger', 'bear', 'crane', 'dolphin', 'eagle', 'falcon', 'gecko', 'heron', 'koala', 'lemur', 'otter', 'panda', 'quail', 'tiger', 'walrus', 'zebra'],
	colors: ['amber', 'aqua', 'azure', 'coral', 'crimson', 'gold', 'indigo', 'ivory', 'jade', 'lime', 'navy', 'olive', 'plum', 'ruby', 'teal', 'violet'],
	numbers: []
};

/** `git.branchRandomName.*`: one word per dictionary, joined by `git.branchWhitespaceChar`. */
export function randomBranchName(dictionaries: readonly string[], separator: string, random: () => number = Math.random): string {
	const words = dictionaries.map((d) => {
		if (d === 'numbers') return String(100 + Math.floor(random() * 900));
		const list = DICTIONARIES[d] ?? [];
		return list[Math.floor(random() * list.length)] ?? '';
	});
	return words.filter(Boolean).join(separator);
}

/** A typed branch name: whitespace becomes `git.branchWhitespaceChar`, then `git.branchPrefix` is added (once). */
export function branchName(input: string, { prefix = '', whitespaceChar = '-' } = {}): string {
	const name = input.trim().replace(/\s+/g, whitespaceChar);
	if (!name) return '';
	return prefix && !name.startsWith(prefix) ? prefix + name : name;
}

/** `git.branchValidationRegex`: an error for a name it rejects (an invalid regex accepts everything). */
export function branchNameError(name: string, regex: string): string | null {
	if (!regex) return null;
	let re: RegExp;
	try {
		re = new RegExp(regex);
	} catch {
		return null;
	}
	return re.test(name) ? null : t('workbench.scmSettings.branchNameRegex', { regex });
}

/** `git.branchProtection`: whether `branch` matches one of the glob patterns. */
export function isProtectedBranch(branch: string | null, patterns: readonly string[]): boolean {
	return !!branch && patterns.some((p) => p.trim() && globToRegExp(p.trim()).test(branch));
}

// ---------------------------------------------------------------------------------------------
// Commit message (git.inputValidation)

export type InputWarning = { line: number; message: string };

/**
 * VS Code's commit input diagnostics: the subject over `git.inputValidationSubjectLength` (or
 * `git.inputValidationLength` when that is null), other lines over `git.inputValidationLength`.
 */
export function commitMessageWarnings(message: string, { length, subjectLength }: { length: number; subjectLength: number | null }): InputWarning[] {
	const out: InputWarning[] = [];
	message.split('\n').forEach((text, i) => {
		const max = i === 0 ? (subjectLength ?? length) : length;
		if (text.length > max) out.push({ line: i + 1, message: `${text.length - max} characters over ${max} in current line` });
	});
	return out;
}

// ---------------------------------------------------------------------------------------------
// Resources: grouping, count, sort

export type UntrackedMode = 'mixed' | 'separate' | 'hidden';
export type ResourceGroups = { staged: Resource[]; changes: Resource[]; untracked: Resource[] };

const isUntracked = (r: Resource) => r.entry.worktree === '?' && !r.staged;

/** `git.untrackedChanges`: untracked files with the changes, in their own group, or not shown. */
export function splitUntracked(g: { staged: Resource[]; changes: Resource[] }, mode: UntrackedMode): ResourceGroups {
	if (mode === 'mixed') return { ...g, untracked: [] };
	const changes = g.changes.filter((r) => !isUntracked(r));
	return { staged: g.staged, changes, untracked: mode === 'separate' ? g.changes.filter(isUntracked) : [] };
}

/**
 * The activity bar badge: `scm.countBadge` (`focused` is the one repository Kingu shows) over
 * `git.countBadge` (`tracked` leaves untracked files out).
 */
export function countBadge(g: ResourceGroups, gitBadge: string, scmBadge: string): number {
	if (scmBadge === 'off' || gitBadge === 'off') return 0;
	const all = [...g.staged, ...g.changes, ...g.untracked];
	return gitBadge === 'tracked' ? all.filter((r) => !isUntracked(r)).length : all.length;
}

export type SortKey = 'name' | 'path' | 'status';
const name = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** `scm.defaultViewSortKey` in list view. */
export function sortResources(list: readonly Resource[], key: SortKey): Resource[] {
	const byPath = (a: Resource, b: Resource) => a.entry.path.localeCompare(b.entry.path);
	const cmp: Record<SortKey, (a: Resource, b: Resource) => number> = {
		path: byPath,
		name: (a, b) => name(a.entry.path).localeCompare(name(b.entry.path)) || byPath(a, b),
		status: (a, b) => a.letter.localeCompare(b.letter) || byPath(a, b)
	};
	return [...list].sort(cmp[key] ?? byPath);
}

export type TreeRow = { kind: 'folder'; path: string; label: string; depth: number } | { kind: 'file'; resource: Resource; depth: number };

/**
 * `scm.defaultViewMode: tree`: resources under their folders, folders first. `compact`
 * (`scm.compactFolders`) joins a chain of single-child folders into one row (`src/lib`).
 * `collapsed` holds folder paths whose children are hidden.
 */
export function resourceTree(list: readonly Resource[], { compact = true, collapsed = new Set<string>() }: { compact?: boolean; collapsed?: ReadonlySet<string> } = {}): TreeRow[] {
	type Node = { dirs: Map<string, Node>; files: Resource[] };
	const root: Node = { dirs: new Map(), files: [] };
	for (const r of list) {
		const parts = r.entry.path.split('/');
		let node = root;
		for (const dir of parts.slice(0, -1)) {
			let next = node.dirs.get(dir);
			if (!next) node.dirs.set(dir, (next = { dirs: new Map(), files: [] }));
			node = next;
		}
		node.files.push(r);
	}
	const rows: TreeRow[] = [];
	const walk = (node: Node, prefix: string, depth: number) => {
		for (const [dir, child0] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
			let child = child0;
			let label = dir;
			let path = prefix + dir;
			while (compact && child.files.length === 0 && child.dirs.size === 1) {
				const [[sub, next]] = [...child.dirs];
				label += `/${sub}`;
				path += `/${sub}`;
				child = next;
			}
			rows.push({ kind: 'folder', path, label, depth });
			if (!collapsed.has(path)) walk(child, `${path}/`, depth + 1);
		}
		for (const r of [...node.files].sort((a, b) => a.entry.path.localeCompare(b.entry.path))) rows.push({ kind: 'file', resource: r, depth });
	};
	walk(root, '', 0);
	return rows;
}

/** `git.statusLimit` (0 = no limit): the entries kept, and whether some were dropped. */
export function limitStatus(entries: StatusEntry[], limit: number): { entries: StatusEntry[]; hitLimit: boolean } {
	if (!limit || entries.length <= limit) return { entries, hitLimit: false };
	return { entries: entries.slice(0, limit), hitLimit: true };
}

// ---------------------------------------------------------------------------------------------
// Saving, commit hooks

export type SavePrompt = 'always' | 'staged' | 'never';

/**
 * `git.promptToSaveFilesBeforeCommit` / `…BeforeStash`: the unsaved files to ask about. `always`:
 * every dirty file in the repository; `staged`: only dirty files that are staged.
 */
export function filesToSave(dirty: readonly string[], mode: SavePrompt, staged: ReadonlySet<string>): string[] {
	if (mode === 'never') return [];
	return dirty.filter((p) => mode === 'always' || staged.has(p));
}

export type HookSeverity = 'error' | 'warning' | 'information' | 'hint';
export type Problem = { path: string; source: string; severity: HookSeverity; message: string };
const RANK: Record<HookSeverity, number> = { hint: 0, information: 1, warning: 2, error: 3 };

/**
 * `git.diagnosticsCommitHook.sources`: a diagnostic blocks the commit when its source (or `*`)
 * is listed and it is at least that severe. Only the files being committed count.
 */
export function blockingProblems(problems: readonly Problem[], sources: Readonly<Record<string, string>>, committed: ReadonlySet<string>): Problem[] {
	return problems.filter((p) => {
		if (!committed.has(p.path)) return false;
		const min = (sources[p.source] ?? sources['*']) as HookSeverity | undefined;
		return min !== undefined && RANK[p.severity] >= (RANK[min] ?? 4);
	});
}

// ---------------------------------------------------------------------------------------------
// Action button (git.showActionButton, scm.showActionButton)

export type ActionButton = { kind: 'commit' } | { kind: 'publish' } | { kind: 'sync'; ahead: number; behind: number } | null;

/**
 * VS Code's Source Control action button: Commit while there is anything to commit, else
 * Publish Branch for an unpublished branch, else Sync Changes when ahead or behind.
 */
export function actionButton(
	o: { changes: number; branch: string | null; upstream: string | null; upstreamGone: boolean; remotes: number; ahead: number; behind: number },
	show: { commit: boolean; publish: boolean; sync: boolean },
	enabled: boolean
): ActionButton {
	if (!enabled) return null;
	if (o.changes > 0) return show.commit ? { kind: 'commit' } : null;
	if (o.branch && (!o.upstream || o.upstreamGone)) return show.publish && o.remotes > 0 ? { kind: 'publish' } : null;
	if (o.upstream && (o.ahead || o.behind)) return show.sync ? { kind: 'sync', ahead: o.ahead, behind: o.behind } : null;
	return show.commit ? { kind: 'commit' } : null;
}

/** `git.showActionButton` with VS Code's defaults for missing keys. */
export function actionButtonFlags(v: unknown): { commit: boolean; publish: boolean; sync: boolean } {
	const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
	return { commit: o.commit !== false, publish: o.publish !== false, sync: o.sync !== false };
}

/** `scm.inputFontFamily`: `default` (workbench font), `editor`, or a font family. */
export function inputFontFamily(v: string, editorFont: string): string | undefined {
	if (!v || v === 'default') return undefined;
	return v === 'editor' ? editorFont : v;
}
