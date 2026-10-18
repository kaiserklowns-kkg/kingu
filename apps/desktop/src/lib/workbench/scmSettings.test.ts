import { describe, expect, test } from 'bun:test';
import { SCHEMA } from '#lib/settings/registry.ts';
import { groups, type StatusEntry } from './scm';
import {
	actionButton,
	actionButtonFlags,
	autofetchMode,
	blockingProblems,
	branchName,
	branchNameError,
	commitMessageWarnings,
	commitOptions,
	countBadge,
	fetchOptions,
	filesToSave,
	inputFontFamily,
	isProtectedBranch,
	limitStatus,
	pullCommand,
	pullOptions,
	pushOptions,
	randomBranchName,
	resourceTree,
	sortResources,
	splitUntracked,
	statusOptions
} from './scmSettings';

/** Settings at their registered defaults, with `over` on top. */
const getter =
	(over: Record<string, unknown> = {}) =>
	<T>(id: string): T => {
		if (id in over) return over[id] as T;
		const s = SCHEMA.get(id);
		if (!s) throw new Error(`unregistered: ${id}`);
		return s.default as T;
	};

const e = (path: string, index: string | null, worktree: string | null): StatusEntry => ({ path, orig_path: null, index, worktree, conflict: false });

describe('git arguments from settings', () => {
	test('VS Code defaults', () => {
		const get = getter();
		expect(fetchOptions(get)).toEqual({ all: false, prune: false });
		expect(pullOptions(get)).toEqual({ rebase: false, tags: true, autoStash: false, fetchAll: false, replaceTags: false });
		expect(pushOptions(get)).toEqual({ force: null, followTags: false });
		expect(commitOptions(get)).toEqual({ amend: false, signoff: false, sign: false, noVerify: false, empty: false });
		expect(statusOptions(get)).toEqual({ similarityThreshold: 50, ignoreSubmodules: false });
		expect(autofetchMode(get)).toBe('off');
	});

	test('autofetch, prune, rebase on sync, tags, autostash', () => {
		const get = getter({ 'git.autofetch': 'all', 'git.pruneOnFetch': true, 'git.rebaseWhenSync': true, 'git.autoStash': true, 'git.fetchOnPull': true, 'git.replaceTagsWhenPull': true });
		expect(autofetchMode(get)).toBe('all');
		expect(autofetchMode(getter({ 'git.autofetch': true }))).toBe('default');
		expect(fetchOptions(get, { auto: true })).toEqual({ all: true, prune: true });
		expect(fetchOptions(get)).toEqual({ all: false, prune: true });
		expect(pullOptions(get).rebase).toBe(false);
		expect(pullOptions(get, { sync: true })).toEqual({ rebase: true, tags: true, autoStash: true, fetchAll: true, replaceTags: true });
		expect(pullCommand(pullOptions(get, { rebase: true }))).toEqual(['git', 'pull', '--tags', '--autostash', '--rebase']);
		expect(pullCommand(pullOptions(getter({ 'git.pullTags': false })))).toEqual(['git', 'pull', '--no-rebase', '--ff-only']);
	});

	test('force push modes and follow tags', () => {
		expect(pushOptions(getter(), { force: true }).force).toBe('withLeaseIfIncludes');
		expect(pushOptions(getter({ 'git.useForcePushIfIncludes': false }), { force: true }).force).toBe('withLease');
		expect(pushOptions(getter({ 'git.useForcePushWithLease': false }), { force: true }).force).toBe('force');
		expect(pushOptions(getter({ 'git.followTagsWhenSync': true }), { sync: true }).followTags).toBe(true);
		expect(pushOptions(getter({ 'git.followTagsWhenSync': true })).followTags).toBe(false);
	});

	test('commit flags', () => {
		expect(commitOptions(getter({ 'git.alwaysSignOff': true, 'git.enableCommitSigning': true }), { noVerify: true })).toEqual({
			amend: false,
			signoff: true,
			sign: true,
			noVerify: true,
			empty: false
		});
		expect(statusOptions(getter({ 'git.similarityThreshold': 80, 'git.ignoreSubmodules': true }))).toEqual({ similarityThreshold: 80, ignoreSubmodules: true });
	});
});

describe('branch names', () => {
	test('prefix, whitespace char and validation regex', () => {
		expect(branchName('  my new  branch ')).toBe('my-new-branch');
		expect(branchName('fix bug', { prefix: 'feature/', whitespaceChar: '_' })).toBe('feature/fix_bug');
		expect(branchName('feature/x', { prefix: 'feature/' })).toBe('feature/x');
		expect(branchName('   ')).toBe('');
		expect(branchNameError('feature/x', '^feature/')).toBeNull();
		expect(branchNameError('x', '^feature/')).toContain('^feature/');
		expect(branchNameError('x', '')).toBeNull();
		expect(branchNameError('x', '(')).toBeNull();
	});

	test('random names from the dictionaries', () => {
		const zero = () => 0;
		expect(randomBranchName(['adjectives', 'animals'], '-', zero)).toBe('brave-badger');
		expect(randomBranchName(['colors', 'numbers'], '_', zero)).toBe('amber_100');
		expect(randomBranchName(['numbers'], '-', () => 0.999)).toBe('999');
	});

	test('protected branches match globs', () => {
		expect(isProtectedBranch('main', ['main'])).toBe(true);
		expect(isProtectedBranch('release/1.0', ['release/*'])).toBe(true);
		expect(isProtectedBranch('dev', ['main', 'release/*'])).toBe(false);
		expect(isProtectedBranch(null, ['main'])).toBe(false);
	});
});

test('commit message validation', () => {
	const o = { length: 72, subjectLength: 50 };
	expect(commitMessageWarnings('short', o)).toEqual([]);
	expect(commitMessageWarnings('x'.repeat(55), o)).toEqual([{ line: 1, message: '5 characters over 50 in current line' }]);
	expect(commitMessageWarnings(`ok\n\n${'y'.repeat(80)}`, o)).toEqual([{ line: 3, message: '8 characters over 72 in current line' }]);
	expect(commitMessageWarnings('x'.repeat(60), { length: 72, subjectLength: null })).toEqual([]);
});

describe('resources', () => {
	const g = groups([e('a.ts', 'M', null), e('b.ts', null, 'M'), e('new.ts', null, '?'), e('src/lib/c.ts', null, 'M')]);

	test('git.untrackedChanges', () => {
		expect(splitUntracked(g, 'mixed').changes.map((r) => r.entry.path)).toEqual(['b.ts', 'new.ts', 'src/lib/c.ts']);
		const sep = splitUntracked(g, 'separate');
		expect([sep.changes.length, sep.untracked.map((r) => r.entry.path)]).toEqual([2, ['new.ts']]);
		const hidden = splitUntracked(g, 'hidden');
		expect([hidden.changes.length, hidden.untracked.length]).toEqual([2, 0]);
	});

	test('count badge: scm.countBadge over git.countBadge', () => {
		const all = splitUntracked(g, 'mixed');
		expect(countBadge(all, 'all', 'all')).toBe(4);
		expect(countBadge(all, 'all', 'focused')).toBe(4);
		expect(countBadge(all, 'tracked', 'all')).toBe(3);
		expect(countBadge(all, 'all', 'off')).toBe(0);
		expect(countBadge(all, 'off', 'all')).toBe(0);
		expect(countBadge(splitUntracked(g, 'hidden'), 'all', 'all')).toBe(3);
	});

	test('scm.defaultViewSortKey', () => {
		const list = [...g.changes].reverse();
		expect(sortResources(list, 'path').map((r) => r.entry.path)).toEqual(['b.ts', 'new.ts', 'src/lib/c.ts']);
		expect(sortResources(list, 'name').map((r) => r.entry.path)).toEqual(['b.ts', 'src/lib/c.ts', 'new.ts']);
		expect(sortResources(list, 'status').map((r) => r.letter)).toEqual(['M', 'M', 'U']);
	});

	test('tree view with compact folders', () => {
		const rows = resourceTree(g.changes);
		expect(rows.map((r) => (r.kind === 'folder' ? `${r.depth}d:${r.label}` : `${r.depth}f:${r.resource.entry.path}`))).toEqual(['0d:src/lib', '1f:src/lib/c.ts', '0f:b.ts', '0f:new.ts']);
		const loose = resourceTree(g.changes, { compact: false });
		expect(loose.filter((r) => r.kind === 'folder').map((r) => r.kind === 'folder' && r.path)).toEqual(['src', 'src/lib']);
		expect(resourceTree(g.changes, { collapsed: new Set(['src/lib']) }).length).toBe(3);
	});

	test('git.statusLimit', () => {
		const many = Array.from({ length: 5 }, (_, i) => e(`f${i}`, null, 'M'));
		expect(limitStatus(many, 3)).toMatchObject({ hitLimit: true, entries: { length: 3 } });
		expect(limitStatus(many, 0).hitLimit).toBe(false);
		expect(limitStatus(many, 10).entries).toBe(many);
	});
});

test('files to save before commit or stash', () => {
	const dirty = ['a.ts', 'b.ts'];
	expect(filesToSave(dirty, 'always', new Set())).toEqual(dirty);
	expect(filesToSave(dirty, 'staged', new Set(['b.ts']))).toEqual(['b.ts']);
	expect(filesToSave(dirty, 'never', new Set(dirty))).toEqual([]);
});

test('diagnostics commit hook', () => {
	const problems = [
		{ path: 'a.ts', source: 'ts', severity: 'error' as const, message: 'x' },
		{ path: 'a.ts', source: 'eslint', severity: 'warning' as const, message: 'y' },
		{ path: 'other.ts', source: 'ts', severity: 'error' as const, message: 'z' }
	];
	const committed = new Set(['a.ts']);
	expect(blockingProblems(problems, { '*': 'error' }, committed).map((p) => p.message)).toEqual(['x']);
	expect(blockingProblems(problems, { eslint: 'warning' }, committed).map((p) => p.message)).toEqual(['y']);
	expect(blockingProblems(problems, { ts: 'hint', '*': 'error' }, committed).map((p) => p.message)).toEqual(['x']);
	expect(blockingProblems(problems, {}, committed)).toEqual([]);
});

test('action button: commit, then publish, then sync', () => {
	const flags = actionButtonFlags(SCHEMA.get('git.showActionButton')!.default);
	const base = { changes: 0, branch: 'main', upstream: 'origin/main', upstreamGone: false, remotes: 1, ahead: 0, behind: 0 };
	expect(actionButton({ ...base, changes: 2 }, flags, true)).toEqual({ kind: 'commit' });
	expect(actionButton({ ...base, upstream: null }, flags, true)).toEqual({ kind: 'publish' });
	expect(actionButton({ ...base, ahead: 1, behind: 2 }, flags, true)).toEqual({ kind: 'sync', ahead: 1, behind: 2 });
	expect(actionButton(base, flags, true)).toEqual({ kind: 'commit' });
	expect(actionButton({ ...base, changes: 2 }, flags, false)).toBeNull();
	expect(actionButton({ ...base, ahead: 1 }, actionButtonFlags({ sync: false }), true)).toBeNull();
	expect(actionButtonFlags(undefined)).toEqual({ commit: true, publish: true, sync: true });
});

test('scm.inputFontFamily', () => {
	expect(inputFontFamily('default', 'Menlo')).toBeUndefined();
	expect(inputFontFamily('editor', 'Menlo')).toBe('Menlo');
	expect(inputFontFamily('Fira Code', 'Menlo')).toBe('Fira Code');
});
