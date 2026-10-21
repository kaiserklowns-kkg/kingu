// VS Code's git commands beyond commit, sync, branches and stashes (scm.svelte.ts has those):
// Merge Branch, Rebase Branch, Create/Delete Tag, Push Tags, Cherry Pick, Checkout (Detached),
// Undo Last Commit, Add to .gitignore, Add/Remove/Rename Remote, View Stash and the latest/all
// stash commands, Compare with Branch or Tag, worktrees, and the commit message in an editor
// (`git.useEditorAsCommitInput`, `git.verboseCommit`). Each runs on the picked repository as the
// window's one git operation (Repository.exclusive); Rust is git_ops.rs.

import { invoke } from '@tauri-apps/api/core';
import { t } from '#lib/i18n/index.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { externalKey } from '#lib/workbench/externalFiles.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';
import { ask } from '#lib/workbench/messageBox.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { scm, type Repository } from '#lib/workbench/scm.svelte.ts';
import { fileOf, refDiffKey } from '#lib/workbench/scm.ts';
import { stashItems, type Stash } from '#lib/workbench/scmRemote.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { defaultRemote, defaultWorktreePath, refItems, remoteItems, suggestedRemoteName, summarize, tagItems, worktreeItems, type Outcome, type Remote, type Worktree } from './gitPicks';
import { stashChangesKey, stashChangesPrefix } from './rangeChanges';
import { isRepoFile } from './scmViews.svelte';

const get = <T>(id: string) => settings.get<T>(id);
const refLabels = () => ({ branches: t('scmGit.branches'), remotes: t('scmGit.remoteBranches'), tags: t('scmGit.tags') });

/** Runs `fn` on `r` as the one git operation; undefined when it failed (the error was shown). */
const run = <T>(r: Repository, label: string, cmd: string, args: Record<string, unknown> = {}) => r.exclusive(label, () => invoke<T>(cmd, r.args(args)));

/** A merge, rebase or cherry-pick that stopped on conflicts: the Source Control view shows them. */
function reportOutcome(outcome: Outcome | undefined, done: string) {
	if (outcome === 'done') status.flash(done);
	if (outcome !== 'conflicts') return;
	notifications.warn(t('scmGit.conflicts'), { source: 'Git' });
	appMode.setMode('workbench');
	layout.sideView = 'scm';
	layout.sidebarVisible = true;
}

// ---------------------------------------------------------------------------------------------
// Branches and commits

export async function mergeBranch(r: Repository) {
	const refs = await r.refs({ tags: true });
	if (!refs) return;
	const pick = await quick.choose({ placeholder: t('scmGit.pickMerge'), items: refItems(refs, refLabels()) });
	if (!pick) return;
	reportOutcome(await run<Outcome>(r, t('scmGit.merging'), 'git_merge_branch', { name: pick.id }), t('scmGit.merged', { name: pick.id }));
}

export async function rebaseBranch(r: Repository) {
	const refs = await r.refs({ tags: true });
	if (!refs) return;
	const branch = r.repo?.branch ?? 'HEAD';
	const pick = await quick.choose({ placeholder: t('scmGit.pickRebase', { branch }), items: refItems(refs, refLabels()) });
	if (!pick) return;
	reportOutcome(await run<Outcome>(r, t('scmGit.rebasing'), 'git_rebase_branch', { onto: pick.id }), t('scmGit.rebased', { branch, onto: pick.id }));
}

export async function cherryPick(r: Repository, hash?: string) {
	const target = hash ?? (await quick.input({ placeholder: t('scmGit.cherryPickHash'), hint: (v) => (v.trim() ? t('scmGit.cherryPickHint', { hash: v.trim() }) : t('scmGit.cherryPickHash')) }))?.trim();
	if (!target) return;
	reportOutcome(await run<Outcome>(r, t('scmGit.cherryPicking'), 'git_cherry_pick', { hash: target }), t('scmGit.cherryPicked', { hash: target.slice(0, 7) }));
}

/** Checkout (Detached): at `rev`, or a branch or tag the user picks. */
export async function checkoutDetached(r: Repository, rev?: string) {
	let target = rev;
	if (!target) {
		const refs = await r.refs({ tags: true });
		if (!refs) return;
		target = (await quick.choose({ placeholder: t('scmGit.pickDetached'), items: refItems(refs, refLabels(), { skipCurrent: false }) }))?.id;
	}
	if (!target) return;
	const ok = await run(r, t('workbench.scm.checkingOut'), 'git_checkout_detached', { rev: target });
	if (ok !== undefined) status.flash(t('scmGit.detached', { rev: target.length === 40 ? target.slice(0, 7) : target }));
}

export async function undoLastCommit(r: Repository) {
	const message = await run<string>(r, t('scmGit.undoing'), 'git_undo_commit');
	if (message === undefined) return;
	// VS Code puts the undone commit's message back into an empty input.
	if (!r.message.trim()) r.message = message;
	status.flash(t('scmGit.undone'));
}

// ---------------------------------------------------------------------------------------------
// Tags

const tagHint = (v: string) => (!v.trim() ? t('scmGit.tagNameHint') : /\s/.test(v.trim()) ? t('scmGit.tagNameSpaces') : t('scmGit.tagCreateHint', { name: v.trim() }));

/** Git: Create Tag (at `at`, default HEAD): a name, then an optional message (annotated). */
export async function createTag(r: Repository, at?: string) {
	const name = (await quick.input({ placeholder: t('scmGit.tagName'), hint: tagHint }))?.trim();
	if (!name) return;
	const message = await quick.input({ placeholder: t('scmGit.tagMessage'), hint: (v) => (v.trim() ? t('scmGit.tagAnnotated', { name }) : t('scmGit.tagLightweight', { name })) });
	if (message === undefined) return;
	const ok = await run(r, t('scmGit.tagging'), 'git_tag_create', { name, message: message.trim() || null, at: at ?? null });
	if (ok !== undefined) status.flash(t('scmGit.tagCreated', { name }));
}

export async function deleteTag(r: Repository) {
	const refs = await r.refs({ tags: true });
	if (!refs) return;
	const items = tagItems(refs);
	if (!items.length) return void notifications.info(t('scmGit.noTags'));
	const pick = await quick.choose({ placeholder: t('scmGit.pickDeleteTag'), items });
	if (!pick) return;
	const ok = await run(r, t('scmGit.deletingTag'), 'git_tag_delete', { name: pick.id });
	if (ok !== undefined) status.flash(t('scmGit.tagDeleted', { name: pick.id }));
}

async function remotesOf(r: Repository): Promise<Remote[] | null> {
	try {
		return await invoke<Remote[]>('git_remote_list', r.args());
	} catch (e) {
		notifications.error(e);
		return null;
	}
}

async function pickRemote(r: Repository, placeholder: string): Promise<string | undefined> {
	const list = await remotesOf(r);
	if (!list) return;
	if (!list.length) return void notifications.info(t('workbench.scm.noRemotes'));
	return defaultRemote(list) ?? (await quick.choose({ placeholder, items: remoteItems(list) }))?.id;
}

export async function pushTags(r: Repository) {
	const remote = await pickRemote(r, t('scmGit.pickPushTagsRemote'));
	if (!remote) return;
	const ok = await r.exclusive(t('scmGit.pushingTags'), () => invoke('git_tags_push', r.args({ remote })).then(() => true), ['git', 'push', '--tags', remote]);
	if (ok) status.flash(t('scmGit.tagsPushed', { remote }));
}

// ---------------------------------------------------------------------------------------------
// Remotes

export async function addRemote(r: Repository) {
	const list = await remotesOf(r);
	if (!list) return;
	const url = (await quick.input({ placeholder: t('scmGit.remoteUrl'), hint: (v) => (v.trim() ? t('scmGit.remoteUrlHint', { url: v.trim() }) : t('scmGit.remoteUrl')) }))?.trim();
	if (!url) return;
	const suggested = suggestedRemoteName(list);
	const typed = await quick.input({ placeholder: t('scmGit.remoteName'), value: suggested, hint: (v) => (v.trim() ? t('scmGit.remoteAddHint', { name: v.trim() }) : t('scmGit.remoteName')) });
	const name = typed?.trim();
	if (!name) return;
	const ok = await run(r, t('scmGit.addingRemote'), 'git_remote_add', { name, url });
	if (ok !== undefined) status.flash(t('scmGit.remoteAdded', { name }));
}

export async function removeRemote(r: Repository) {
	const list = await remotesOf(r);
	if (!list) return;
	if (!list.length) return void notifications.info(t('workbench.scm.noRemotes'));
	const pick = await quick.choose({ placeholder: t('scmGit.pickRemoveRemote'), items: remoteItems(list) });
	if (!pick) return;
	const sure = await ask(t('scmGit.confirmRemoveRemote', { name: pick.id }), { title: t('scmGit.removeRemote'), kind: 'warning', okLabel: t('scmGit.removeRemote'), cancelLabel: t('common.cancel') });
	if (!sure) return;
	const ok = await run(r, t('scmGit.removingRemote'), 'git_remote_remove', { name: pick.id });
	if (ok !== undefined) status.flash(t('scmGit.remoteRemoved', { name: pick.id }));
}

export async function renameRemote(r: Repository) {
	const list = await remotesOf(r);
	if (!list) return;
	if (!list.length) return void notifications.info(t('workbench.scm.noRemotes'));
	const pick = await quick.choose({ placeholder: t('scmGit.pickRenameRemote'), items: remoteItems(list) });
	if (!pick) return;
	const to = (await quick.input({ placeholder: t('scmGit.remoteNewName', { name: pick.id }), value: pick.id, hint: (v) => t('scmGit.remoteRenameHint', { from: pick.id, to: v.trim() || '…' }) }))?.trim();
	if (!to || to === pick.id) return;
	const ok = await run(r, t('scmGit.renamingRemote'), 'git_remote_rename', { from: pick.id, to });
	if (ok !== undefined) status.flash(t('scmGit.remoteRenamed', { from: pick.id, to }));
}

// ---------------------------------------------------------------------------------------------
// Stashes

async function pickStash(r: Repository, placeholder: string): Promise<Stash | undefined> {
	let list: Stash[];
	try {
		list = await invoke<Stash[]>('git_stash_list', r.args());
	} catch (e) {
		notifications.error(e);
		return;
	}
	if (!list.length) return void status.flash(t('workbench.scm.noStashes'));
	const pick = await quick.choose({ placeholder, items: stashItems(list) });
	return pick && list.find((s) => String(s.index) === pick.id);
}

/** Git: View Stash — the stash's files on one page, with Apply, Pop and Drop. */
export async function viewStash(r: Repository) {
	const s = await pickStash(r, t('scmGit.pickViewStash'));
	if (!s) return;
	try {
		const { hash } = await invoke<{ hash: string }>('git_stash_show', r.args({ index: s.index }));
		appMode.setMode('workbench');
		editors.open(stashChangesKey(r.dir, s.index, hash, `stash@{${s.index}}: ${s.message}`), { preview: false });
	} catch (e) {
		notifications.error(e);
	}
}

/** Closes the stash pages of `r` (their indexes move once a stash goes). */
function closeStashPages(r: Repository) {
	const prefix = stashChangesPrefix(r.dir);
	for (const g of editors.model.groups) for (const tab of [...g.tabs]) if (tab.path.startsWith(prefix)) editors.close(tab.path, { group: g.id, force: true });
}

/** Apply, Pop or Drop of one stash (the stash page's buttons, the latest-stash commands). */
export async function stashAction(dir: string, index: number, action: 'apply' | 'pop' | 'drop') {
	const r = scm.repositories.find((x) => x.dir === dir);
	if (!r) return;
	if (action === 'drop') {
		const ref = `stash@{${index}}`;
		const sure = await ask(t('scmGit.confirmDropStash', { ref }), { title: t('workbench.scm.dropStash'), kind: 'warning', okLabel: t('workbench.scm.drop'), cancelLabel: t('common.cancel') });
		if (!sure) return;
		const ok = await r.exclusive(t('workbench.scm.droppingStash'), () => invoke('git_stash_drop', r.args({ index })).then(() => true));
		if (ok) (status.flash(t('workbench.scm.stashDropped')), closeStashPages(r));
		return;
	}
	const pop = action === 'pop';
	const ok = await r.exclusive(t('workbench.scm.applyingStash'), () => invoke('git_stash_apply', r.args({ index, pop })).then(() => true));
	if (!ok) return;
	status.flash(pop ? t('workbench.scm.stashPopped') : t('workbench.scm.stashApplied'));
	if (pop) closeStashPages(r);
}

export async function stashDropAll(r: Repository) {
	const sure = await ask(t('scmGit.confirmDropAll'), { title: t('scmGit.dropAllStashes'), kind: 'warning', okLabel: t('workbench.scm.drop'), cancelLabel: t('common.cancel') });
	if (!sure) return;
	const ok = await run(r, t('workbench.scm.droppingStash'), 'git_stash_clear');
	if (ok !== undefined) (status.flash(t('scmGit.stashesDropped')), closeStashPages(r));
}

// ---------------------------------------------------------------------------------------------
// Files: Add to .gitignore, Compare with Branch or Tag

/** Git: Add to .gitignore — `paths` are workspace paths of `r`'s files. */
export async function ignore(r: Repository, paths: string[]) {
	if (!paths.length) return;
	try {
		await invoke('git_ignore_paths', r.args({ paths: r.rels(paths) }));
		status.flash(t('scmGit.ignored', { name: summarize(paths.map((p) => p.slice(p.lastIndexOf('/') + 1)), (count) => t('workbench.scm.nFiles', { count })) }));
	} catch (e) {
		notifications.error(e);
	}
	await r.refresh();
}

/** The active editor's file when it is one of a repository's. */
function activeFile(): { file: string; repo: Repository } | null {
	const file = editors.active ? fileOf(editors.active) : null;
	const repo = isRepoFile(file) ? scm.repositoryOf(file) : null;
	return file && repo ? { file, repo } : null;
}

/** Compare with Branch or Tag: the active file at a ref ↔ the working copy. */
export async function compareWithRef(file?: string) {
	const target = file ?? activeFile()?.file;
	const r = target ? scm.repositoryOf(target) : null;
	if (!target || !r) return void status.flash(t('scmGit.noFileToCompare'));
	const refs = await r.refs({ tags: true });
	if (!refs) return;
	const pick = await quick.choose({ placeholder: t('scmGit.pickCompare', { file: target.slice(target.lastIndexOf('/') + 1) }), items: refItems(refs, refLabels(), { skipCurrent: false }) });
	if (pick) editors.open(refDiffKey(pick.id, null, target), { preview: false });
}

// ---------------------------------------------------------------------------------------------
// Worktrees

async function worktreesOf(r: Repository): Promise<Worktree[] | null> {
	try {
		return await invoke<Worktree[]>('scm_worktree_list', r.args());
	} catch (e) {
		notifications.error(e);
		return null;
	}
}

/** Git: Create Worktree — a branch (or a new one), then where. */
export async function createWorktree(r: Repository) {
	const refs = await r.refs();
	if (!refs) return;
	const NEW = '__new';
	const free = refs.filter((x) => !x.tag && !x.current && !x.worktree);
	const pick = await quick.choose({
		placeholder: t('scmGit.pickWorktreeBranch'),
		items: [{ id: NEW, label: `+ ${t('scmGit.worktreeNewBranch')}` }, ...refItems(free, refLabels(), { tags: false })]
	});
	if (!pick) return;
	let branch: string | null = null;
	let newBranch: string | null = null;
	if (pick.id === NEW) {
		newBranch = (await quick.input({ placeholder: t('workbench.scm.branchName'), hint: (v) => (v.trim() ? t('workbench.scm.branchCreateHint', { name: v.trim() }) : t('workbench.scm.branchNameHint')) }))?.trim().replace(/\s+/g, '-') || null;
		if (!newBranch) return;
	} else {
		const ref = free.find((x) => x.name === pick.id);
		// A remote branch gets a local branch of the same name tracking it (VS Code does the same).
		if (ref?.remote) newBranch = ref.name.slice(ref.name.indexOf('/') + 1);
		branch = pick.id;
	}
	const suggested = defaultWorktreePath(r.info.toplevel || r.dir, newBranch ?? branch ?? 'worktree');
	const path = (await quick.input({ placeholder: t('scmGit.worktreePath'), value: suggested, hint: (v) => (v.trim().startsWith('/') ? t('scmGit.worktreeCreateHint', { path: v.trim() }) : t('scmGit.worktreePathAbsolute')) }))?.trim();
	if (!path) return;
	const from = newBranch && branch ? branch : null;
	const made = await run<Worktree>(r, t('scmGit.creatingWorktree'), 'scm_worktree_add', { path, branch: newBranch ? null : branch, newBranch, from });
	if (!made) return;
	const [open, openHere] = [t('scmGit.openInNewWindow'), t('scmGit.openInCurrentWindow')];
	const choice = await notifications.prompt('info', t('scmGit.worktreeCreated', { path }), [open, openHere], { source: 'Git' });
	if (choice === open) void workspace.openFolder(path, { newWindow: true });
	if (choice === openHere) void workspace.openFolder(path);
}

/** Git: Delete Worktree — never the main one or a task's; one with changes asks before Force Delete. */
export async function deleteWorktree(r: Repository) {
	const list = await worktreesOf(r);
	if (!list) return;
	const items = worktreeItems(list, r.dir);
	if (!items.length) return void notifications.info(t('scmGit.noWorktrees'));
	const pick = await quick.choose({ placeholder: t('scmGit.pickDeleteWorktree'), items });
	if (!pick) return;
	const sure = await ask(t('scmGit.confirmDeleteWorktree', { path: pick.id }), { title: t('scmGit.deleteWorktree'), kind: 'warning', okLabel: t('scmGit.deleteWorktree'), cancelLabel: t('common.cancel') });
	if (!sure) return;
	const result = await run<'removed' | 'has_changes'>(r, t('scmGit.deletingWorktree'), 'scm_worktree_remove', { path: pick.id, force: false });
	if (result === 'removed') return void status.flash(t('scmGit.worktreeDeleted', { path: pick.id }));
	if (result !== 'has_changes') return;
	const force = await ask(t('scmGit.confirmForceDeleteWorktree', { path: pick.id }), { title: t('scmGit.deleteWorktree'), kind: 'warning', okLabel: t('scmGit.forceDelete'), cancelLabel: t('common.cancel') });
	if (!force) return;
	const forced = await run<'removed' | 'has_changes'>(r, t('scmGit.deletingWorktree'), 'scm_worktree_remove', { path: pick.id, force: true });
	if (forced === 'removed') status.flash(t('scmGit.worktreeDeleted', { path: pick.id }));
}

/** Open Worktree in New Window / in Current Window. */
export async function openWorktree(r: Repository, newWindow: boolean) {
	const list = await worktreesOf(r);
	if (!list) return;
	const items = [...(list[0] && list[0].path !== r.dir ? [{ id: list[0].path, label: list[0].path.slice(list[0].path.lastIndexOf('/') + 1), description: [list[0].branch, list[0].path].filter(Boolean).join(' · ') }] : []), ...worktreeItems(list, r.dir)];
	if (!items.length) return void notifications.info(t('scmGit.noWorktrees'));
	const pick = await quick.choose({ placeholder: t('scmGit.pickOpenWorktree'), items });
	if (pick) void workspace.openFolder(pick.id, { newWindow });
}

// ---------------------------------------------------------------------------------------------
// The commit message in an editor

let editing: string | null = null;

/**
 * `git.useEditorAsCommitInput`: Commit with an empty input writes COMMIT_EDITMSG (the staged diff
 * below git's scissors line with `git.verboseCommit`) and opens it; closing the tab commits what
 * was saved there, an empty message cancels.
 */
export async function commitInEditor(r: Repository, opts: { amend?: boolean; noVerify?: boolean; empty?: boolean }) {
	if (editing) return void status.flash(t('scmGit.editorOpen'));
	let path: string;
	try {
		path = await invoke<string>('git_commit_editmsg_prepare', r.args({ message: '', amend: !!opts.amend, verbose: get<boolean>('git.verboseCommit') }));
	} catch (e) {
		return void notifications.error(e);
	}
	const key = externalKey(path);
	editing = key;
	appMode.setMode('workbench');
	editors.open(key, { preview: false });
	status.flash(t('scmGit.editorHint'));
	await new Promise<void>((resolve) => {
		const stop = $effect.root(() => {
			$effect(() => {
				if (editors.openPaths().has(key)) return;
				queueMicrotask(() => (stop(), resolve()));
			});
		});
	});
	editing = null;
	let message: string;
	try {
		message = await invoke<string>('git_commit_editmsg_read', r.args());
	} catch (e) {
		return void notifications.info(String(e), { source: 'Git' });
	}
	await r.commit({ ...opts, message });
}

// ---------------------------------------------------------------------------------------------
// Palette commands

export function installGitCommands(): () => void {
	const any = () => scm.repositories.length > 0;
	const some = (f: (r: Repository) => boolean) => () => scm.repositories.some(f);
	const onBranch = (r: Repository) => !!r.repo?.branch;
	const hasHead = (r: Repository) => !!r.repo?.head;
	const hasRemote = (r: Repository) => (r.repo?.remotes.length ?? 0) > 0;
	const on = (fn: (r: Repository) => unknown, filter?: (r: Repository) => boolean) => async () => {
		const r = await scm.pick(filter);
		if (r) await fn(r);
	};
	const list = [
		{ id: 'git.merge', title: 'Git: Merge...', when: some(hasHead), run: on(mergeBranch, hasHead) },
		{ id: 'git.rebase', title: 'Git: Rebase Branch...', when: some(onBranch), run: on(rebaseBranch, onBranch) },
		{ id: 'git.cherryPick', title: 'Git: Cherry Pick...', when: some(hasHead), run: on((r) => cherryPick(r), hasHead) },
		{ id: 'git.checkoutDetached', title: 'Git: Checkout to (Detached)...', when: any, run: on((r) => checkoutDetached(r)) },
		{ id: 'git.undoCommit', title: 'Git: Undo Last Commit', when: some(hasHead), run: on(undoLastCommit, hasHead) },
		{ id: 'git.createTag', title: 'Git: Create Tag', when: some(hasHead), run: on((r) => createTag(r), hasHead) },
		{ id: 'git.deleteTag', title: 'Git: Delete Tag...', when: any, run: on(deleteTag) },
		{ id: 'git.pushTags', title: 'Git: Push Tags', when: some(hasRemote), run: on(pushTags, hasRemote) },
		{ id: 'git.addRemote', title: 'Git: Add Remote...', when: any, run: on(addRemote) },
		{ id: 'git.removeRemote', title: 'Git: Remove Remote', when: some(hasRemote), run: on(removeRemote, hasRemote) },
		{ id: 'git.renameRemote', title: 'Git: Rename Remote...', when: some(hasRemote), run: on(renameRemote, hasRemote) },
		{ id: 'git.viewStash', title: 'Git: View Stash...', when: any, run: on(viewStash) },
		{ id: 'git.stashApplyLatest', title: 'Git: Apply Latest Stash', when: any, run: on((r) => stashAction(r.dir, 0, 'apply')) },
		{ id: 'git.stashPopLatest', title: 'Git: Pop Latest Stash', when: any, run: on((r) => stashAction(r.dir, 0, 'pop')) },
		{ id: 'git.stashDropAll', title: 'Git: Drop All Stashes...', when: any, run: on(stashDropAll) },
		{
			id: 'git.ignore',
			title: 'Git: Add to .gitignore',
			when: () => !!activeFile(),
			run: () => {
				const a = activeFile();
				if (a) return ignore(a.repo, [a.file]);
			}
		},
		{ id: 'git.compareWithRef', title: 'Git: Compare with Branch or Tag...', when: () => !!activeFile(), run: () => compareWithRef() },
		{ id: 'git.createWorktree', title: 'Git: Create Worktree...', when: some(hasHead), run: on(createWorktree, hasHead) },
		{ id: 'git.deleteWorktree', title: 'Git: Delete Worktree...', when: any, run: on(deleteWorktree) },
		{ id: 'git.openWorktreeInNewWindow', title: 'Git: Open Worktree in New Window', when: any, run: on((r) => openWorktree(r, true)) },
		{ id: 'git.openWorktree', title: 'Git: Open Worktree in Current Window', when: any, run: on((r) => openWorktree(r, false)) }
	].map((c) => commands.register(c));
	return () => list.forEach((u) => u());
}
