// Source Control model (VS Code: ISCMService + the git extension's Model and Repository). A
// workspace has one repository per root folder, plus nested ones and a parent folder's as the
// git.* detection settings say (git_repos.rs finds them, scmRepos.ts holds the path rules).
// Status is re-read on view open, after every git operation, after a save and on window focus
// (`git.autorefresh`). VS Code's git.* settings shape every operation (scmSettings.ts).
//
// Status paths are workspace paths (relative in the first folder, absolute in another), so the
// Explorer, quick diff and diff editors use them as they are; a repository turns them back into
// its own relative paths for git.

import { invoke } from '@tauri-apps/api/core';
import { ask, messageBox, message as showMessage } from '#lib/workbench/messageBox.ts';
import { clientLog } from '#lib/client-log.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { terminals } from '#lib/terminal/terminals.svelte.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import {
	opLabel,
	checkoutItems,
	checkoutTarget,
	deletableBranches,
	isAuthError,
	stashItems,
	terminalCommand,
	type BranchRef,
	type CheckoutType,
	type DeleteResult,
	type NetOp,
	type Stash
} from '#lib/workbench/scmRemote.ts';
import { detectOptions, keyedStatus, relInRepo, repoLabel, repositoryOf, type Detection, type ParentRepo, type RepoInfo } from '#lib/workbench/scmRepos.ts';
import { commands } from './commands.svelte';
import { editors } from './editors.svelte';
import { saveFile } from './editorModels';
import { DIFF_PREFIX, fileOf, groups, isDiffKey, smartCommitPaths, type GitStatus, type Resource, type StatusEntry } from './scm';
import {
	autofetchMode,
	blockingProblems,
	branchName,
	branchNameError,
	commitOptions,
	countBadge,
	fetchOptions,
	filesToSave,
	isProtectedBranch,
	limitStatus,
	pullCommand,
	pullOptions,
	pushOptions,
	randomBranchName,
	splitUntracked,
	statusOptions,
	type Problem,
	type SavePrompt,
	type UntrackedMode
} from './scmSettings';
import { status } from './status.svelte';
import { repoDialog } from './repoDialog.svelte.ts';
import { workspace } from './workspace.svelte.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { isUntitled } from './untitled';
import { t } from '#lib/i18n/index.ts';

const get = <T>(id: string) => settings.get<T>(id);

let missingGitWarned = false;
/** VS Code's "Git not found" warning, once a session, unless `git.ignoreMissingGitWarning`. */
async function warnMissingGit() {
	if (missingGitWarned || get<boolean>('git.ignoreMissingGitWarning') || get<boolean>('git.enabled') === false) return;
	const probe = await invoke<{ version: string | null; hasRepository: boolean }>('git_probe').catch(() => null);
	if (!probe || probe.version !== null || !probe.hasRepository) return;
	missingGitWarned = true;
	const [download, never] = [t('workbench.scm.downloadGit'), t('workbench.scm.dontShowAgain')];
	const pick = await notifications.prompt('warning', t('workbench.scm.gitNotFound'), [download, never], { source: 'Git' });
	if (pick === download) void invoke('open_web_url', { url: 'https://git-scm.com/downloads' }).catch(() => {});
	else if (pick === never) void settings.set('git.ignoreMissingGitWarning', true, 'user');
}


/** A workspace path git may know (not untitled, a diff tab or one of Kingu's own resources). */
const isWorkspaceFile = (p: string) => !isUntitled(p) && !isDiffKey(p) && !p.includes(':');

const EMPTY_GROUPS: { staged: Resource[]; changes: Resource[]; untracked: Resource[] } = { staged: [], changes: [], untracked: [] };

/** One repository of the workspace (VS Code's git Repository). */
export class Repository {
	/** Tells the Source Control view this is a workspace repository, not a task worktree. */
	readonly workspaceRepo = true;
	info = $state.raw<RepoInfo>({ dir: '', folder: '', toplevel: '', kind: 'folder' });
	/** The Repositories view's name and where the repository is. */
	label = $derived(repoLabel(this.info, workspace.folders));
	repo = $state.raw<GitStatus | null>(null);
	/** False until the first status read. */
	loaded = $state(false);
	busy = $state(false);
	message = $state('');
	/** `git.untrackedChanges`: untracked files with the changes, in their own group, or hidden. */
	groups = $derived(splitUntracked(groups(this.repo?.entries ?? []), settings.get<UntrackedMode>('git.untrackedChanges')));
	/** This repository's part of the activity bar badge (`git.countBadge`). */
	count = $derived(countBadge(this.groups, settings.get<string>('git.countBadge'), 'all'));

	#owner: Scm;
	#inflight: Promise<void> | null = null;
	#again = false;

	constructor(owner: Scm, info: RepoInfo) {
		this.#owner = owner;
		this.info = info;
	}

	get dir() {
		return this.info.dir;
	}

	/** The first folder's own repository (the ADE, the window title and the old single-folder callers use it). */
	get primary() {
		return this.info.dir === workspace.root;
	}

	/** Every command names this repository; its paths are relative to it. */
	#args(args: Record<string, unknown> = {}) {
		return { ...args, repo: this.info.dir };
	}

	#rels(paths: string[]) {
		return paths.map((p) => relInRepo(this.info.dir, p, workspace.folders) ?? p);
	}

	/** Whether workspace path `key` is one of this repository's files. */
	holds(key: string) {
		return repositoryOf(key, this.#owner.repositories, workspace.folders) === this;
	}

	/** Coalesces overlapping calls: at most one read in flight plus one queued. */
	refresh(): Promise<void> {
		if (this.#inflight) {
			this.#again = true;
			return this.#inflight;
		}
		this.#inflight = (async () => {
			do {
				this.#again = false;
				try {
					const read = this.#owner.disabled ? null : await invoke<GitStatus | null>('git_status', this.#args({ options: statusOptions(get) }));
					this.repo = read && this.#owner.limit(keyedStatus(read, this.info.dir, workspace.folders));
				} catch (e) {
					clientLog('error', `git status ${this.info.dir}: ${e}`);
				}
				this.loaded = true;
			} while (this.#again);
			this.#inflight = null;
		})();
		return this.#inflight;
	}

	/** Runs a git command, reports failure in the status bar, then re-reads status. */
	async #run(cmd: string, args: Record<string, unknown>): Promise<boolean> {
		this.busy = true;
		try {
			await invoke(cmd, this.#args(args));
			return true;
		} catch (e) {
			notifications.error(e);
			clientLog('error', `${cmd}: ${e}`);
			return false;
		} finally {
			this.busy = false;
			await this.refresh();
		}
	}

	closeDiffs(paths?: string[]) {
		this.#owner.closeDiffs(paths);
	}

	async stage(paths: string[]) {
		const ok = await this.#run('git_stage', { paths: this.#rels(paths) });
		if (ok) this.closeDiffs(paths);
		return ok;
	}

	/** A staged rename needs its source unstaged too, or the deletion stays staged. */
	async unstage(paths: string[]) {
		const all = new Set(paths);
		for (const e of this.repo?.entries ?? []) if (all.has(e.path) && e.orig_path) all.add(e.orig_path);
		const ok = await this.#run('git_unstage', { paths: this.#rels([...all]) });
		if (ok) this.closeDiffs(paths);
		return ok;
	}

	/** Callers confirm first; `deleteUntracked` is only set after the user agreed to delete. */
	async discard(paths: string[], deleteUntracked: boolean) {
		const ok = await this.#run('git_discard', { paths: this.#rels(paths), deleteUntracked, toTrash: get<boolean>('git.discardUntrackedChangesToTrash') });
		if (ok) this.closeDiffs(paths);
		return ok;
	}

	// ---------------------------------------------------------------------------------------
	// Remotes, branches and stashes. One at a time across the window (Rust enforces it too); the
	// running one shows in the status bar as `scm.op` (`git.showProgress`) and can be cancelled.

	/** Runs `fn` as the one operation, shows its error, then re-reads status (and the branch). */
	async #exclusive<T>(label: string, fn: () => Promise<T>, terminal?: string[]): Promise<T | undefined> {
		const owner = this.#owner;
		if (owner.op) {
			status.flash(t('workbench.scm.busy'));
			return undefined;
		}
		owner.op = label;
		try {
			return await fn();
		} catch (e) {
			clientLog('error', `git: ${e}`);
			if (terminal && isAuthError(e)) void this.#offerTerminal(String(e), terminal);
			else void showMessage(String(e), { title: 'Git', kind: 'error' });
			return undefined;
		} finally {
			owner.op = null;
			await this.refresh();
			owner.syncBranch();
		}
	}

	/** git never prompts inside Kingu; a terminal running the same command can. */
	async #offerTerminal(text: string, run: string[]) {
		const open = await ask(text, { title: 'Git', kind: 'warning', okLabel: t('workbench.scm.openInTerminal'), cancelLabel: t('common.close') });
		if (!open) return;
		appMode.setMode('workbench');
		terminals.open({ title: run.slice(0, 2).join(' '), run, folder: this.info.folder });
		layout.showPanel('terminal');
	}

	async #net(op: NetOp, cmd: string, args: Record<string, unknown>, done: string, terminal: string[]) {
		const ok = await this.#exclusive(opLabel(op), () => invoke(cmd, this.#args(args)).then(() => true), terminal);
		if (ok) status.flash(done);
		return ok === true;
	}

	#unpublished() {
		return !!this.repo?.branch && (!this.repo.upstream || this.repo.upstream_gone);
	}

	fetch() {
		const options = fetchOptions(get);
		return this.#net('fetch', 'git_fetch', { options }, t('workbench.scm.fetched'), terminalCommand('fetch', { prune: options.prune }));
	}

	/** Pull, or Pull (Rebase) (VS Code's git.pullRebase command). */
	pull({ rebase = false } = {}) {
		const options = pullOptions(get, { rebase });
		return this.#net('pull', 'git_pull', { options }, t('workbench.scm.pulled'), terminalCommand('pull', { pull: pullCommand(options) }));
	}

	/** Push; a branch without an upstream is published instead (VS Code offers the same). */
	async push({ force = false } = {}) {
		if (this.#unpublished()) return this.publish();
		if (force && !(await this.#confirmForce())) return false;
		const ok = await this.#net('push', 'git_push', { options: pushOptions(get, { force }) }, t('workbench.scm.pushed'), terminalCommand('push'));
		if (ok && get<boolean>('git.showPushSuccessNotification')) notifications.info(t('workbench.scm.pushSucceeded'), { source: 'Git' });
		return ok;
	}

	/** Push (Force): `git.allowForcePush`, asked first unless `git.confirmForcePush` is off. */
	async #confirmForce(): Promise<boolean> {
		if (!get<boolean>('git.allowForcePush')) {
			notifications.warn(t('workbench.scm.forcePushDisabled'));
			return false;
		}
		if (!get<boolean>('git.confirmForcePush')) return true;
		const text = t('workbench.scm.confirmForcePush');
		const choice = await messageBox(text, { title: 'Git: Push (Force)', kind: 'warning', buttons: [t('common.ok'), t('workbench.scm.always'), t('common.cancel')] });
		if (choice === 1) await settings.set('git.confirmForcePush', false, 'user');
		return choice === 0 || choice === 1;
	}

	async sync() {
		if (this.#unpublished()) return this.publish();
		if (get<boolean>('git.confirmSync')) {
			const target = this.repo?.upstream ?? 'remote';
			const ok = await ask(t('workbench.scm.confirmSync', { target }), {
				title: 'Git: Sync',
				kind: 'info',
				okLabel: t('common.ok'),
				cancelLabel: t('common.cancel')
			});
			if (!ok) return false;
		}
		const options = pullOptions(get, { sync: true });
		const pushOpts = pushOptions(get, { sync: true });
		return this.#net('sync', 'git_sync', { options, pushOptions: pushOpts }, t('workbench.scm.synced'), terminalCommand('sync', { pull: pullCommand(options) }));
	}

	/** Publish Branch: `push -u <remote> <branch>`, to origin unless another remote is the only one. */
	async publish() {
		const branch = this.repo?.branch;
		const remotes = this.repo?.remotes ?? [];
		if (!branch) {
			notifications.warn(t('workbench.scm.publishDetached'));
			return false;
		}
		let remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : undefined;
		if (!remote && remotes.length) {
			remote = (await quick.choose({ placeholder: t('workbench.scm.pickPublishRemote', { branch }), items: remotes.map((r) => ({ id: r, label: r })) }))?.id;
			if (!remote) return false;
		}
		if (!remote) {
			await showMessage(t('workbench.scm.noRemotes'), { title: 'Git', kind: 'info' });
			return false;
		}
		const ok = await this.#net('publish', 'git_push', { remote, options: pushOptions(get) }, t('workbench.scm.published', { branch, remote }), terminalCommand('publish', { remote, branch }));
		if (ok && get<boolean>('git.showPushSuccessNotification')) notifications.info(t('workbench.scm.pushSucceeded'), { source: 'Git' });
		return ok;
	}

	/** Branches (and tags when `git.checkoutType` lists them), hashes `git.commitShortHashLength` long. */
	async #refs({ tags = false } = {}): Promise<BranchRef[] | null> {
		try {
			return await invoke<BranchRef[]>('git_refs', this.#args({ hashLength: get<number>('git.commitShortHashLength'), tags }));
		} catch (e) {
			notifications.error(e);
			return null;
		}
	}

	/** Checkout to…: create actions, then local and remote branches and tags (`git.checkoutType`). */
	async checkout() {
		const types = get<CheckoutType[]>('git.checkoutType');
		const refs = await this.#refs({ tags: types.includes('tags') });
		if (!refs) return;
		const items = checkoutItems(refs, { types, sort: get('git.branchSortOrder'), details: get<boolean>('git.showReferenceDetails') });
		const item = await quick.choose({ placeholder: t('workbench.scm.pickCheckout'), items });
		const target = item && checkoutTarget(item.id, refs);
		if (!target) return;
		if (target.kind === 'create') return this.createBranch();
		if (target.kind === 'createFrom') return this.createBranchFrom(refs);
		if (target.kind === 'worktree') {
			const text = t('workbench.scm.checkedOutElsewhere', { branch: target.ref.name, worktree: target.ref.worktree ?? '' });
			await showMessage(text, { title: 'Git', kind: 'info' });
			return;
		}
		const { name, remote, tag = false } = target.ref;
		const options = { tag, pullBefore: get<boolean>('git.pullBeforeCheckout') };
		const local = await this.#exclusive(t('workbench.scm.checkingOut'), () => invoke<string>('git_checkout', this.#args({ name, remote, options })));
		if (local) status.flash(t('workbench.scm.checkedOut', { branch: local }));
	}

	/**
	 * Create Branch: asks for a name (`git.branchPrefix`, `git.branchWhitespaceChar`,
	 * `git.branchValidationRegex`; Enter on an empty input takes a random name with
	 * `git.branchRandomName.enable`), creates it from `from` (default HEAD) and checks it out.
	 * Resolves to the branch created.
	 */
	async createBranch(from?: string): Promise<string | undefined> {
		const prefix = get<string>('git.branchPrefix');
		const whitespaceChar = get<string>('git.branchWhitespaceChar');
		const random = get<boolean>('git.branchRandomName.enable') ? randomBranchName(get<string[]>('git.branchRandomName.dictionary'), whitespaceChar) : '';
		const typed = await quick.input({
			placeholder: from ? t('workbench.scm.branchNameFrom', { from }) : t('workbench.scm.branchName'),
			hint: (v) => {
				const name = branchName(v || random, { prefix, whitespaceChar });
				if (!name) return t('workbench.scm.branchNameHint');
				return branchNameError(name, get<string>('git.branchValidationRegex')) ?? t('workbench.scm.branchCreateHint', { name });
			}
		});
		if (typed === undefined) return;
		const name = branchName(typed || random, { prefix, whitespaceChar });
		if (!name) return;
		const invalid = branchNameError(name, get<string>('git.branchValidationRegex'));
		if (invalid) {
			notifications.warn(invalid);
			return;
		}
		const ok = await this.#exclusive(t('workbench.scm.creatingBranch'), () => invoke('git_create_branch', this.#args({ name, from: from ?? null })).then(() => true));
		if (!ok) return;
		status.flash(t('workbench.scm.branchCreated', { name }));
		return name;
	}

	async createBranchFrom(refs?: BranchRef[]) {
		const all = refs ?? (await this.#refs());
		if (!all) return;
		const details = get<boolean>('git.showReferenceDetails');
		const items = all.filter((r) => !r.tag).map((r) => ({ id: r.name, label: r.name, description: details ? `${r.commit} ${r.subject}`.trim() : undefined }));
		const from = await quick.choose({ placeholder: t('workbench.scm.pickBranchFrom'), items });
		if (from) await this.createBranch(from.id);
	}

	/** Delete Branch: `-d`, then `-D` only after the user agrees to lose unmerged commits. */
	async deleteBranch() {
		const refs = await this.#refs();
		if (!refs) return;
		const items = deletableBranches(refs);
		if (!items.length) {
			notifications.info(t('workbench.scm.noDeletableBranches'));
			return;
		}
		const pick = await quick.choose({ placeholder: t('workbench.scm.pickDeleteBranch'), items });
		if (!pick) return;
		const name = pick.id;
		const result = await this.#exclusive(t('workbench.scm.deletingBranch'), () => invoke<DeleteResult>('git_delete_branch', this.#args({ name, force: false })));
		if (result === 'deleted') status.flash(t('workbench.scm.branchDeleted', { name }));
		if (result !== 'not_merged') return;
		const force = await ask(t('workbench.scm.confirmForceDeleteBranch', { name }), {
			title: t('workbench.scm.deleteBranch'),
			kind: 'warning',
			okLabel: t('workbench.scm.deleteBranch'),
			cancelLabel: t('common.cancel')
		});
		if (!force) return;
		const forced = await this.#exclusive(t('workbench.scm.deletingBranch'), () => invoke<DeleteResult>('git_delete_branch', this.#args({ name, force: true })));
		if (forced === 'deleted') status.flash(t('workbench.scm.branchDeleted', { name }));
	}

	/** Unsaved editors that are files of this repository. */
	#dirtyFiles() {
		return editors.dirtyPaths().filter((p) => isWorkspaceFile(p) && this.holds(p));
	}

	/**
	 * `git.promptToSaveFilesBeforeCommit` / `…BeforeStash`: offers to save unsaved files first.
	 * False when the user cancels.
	 */
	async #saveFirst(setting: string, action: string): Promise<boolean> {
		const staged = new Set(this.groups.staged.map((r) => r.entry.path));
		const files = filesToSave(this.#dirtyFiles(), get<SavePrompt>(setting), staged);
		if (!files.length) return true;
		const list = files.length === 1 ? files[0] : t('workbench.scm.nFiles', { count: files.length });
		const params = { files: list };
		const text = action === 'stash' ? t('workbench.scm.saveBeforeStash', params) : t('workbench.scm.saveBeforeCommit', params);
		const choice = await messageBox(text, { title: 'Git', kind: 'warning', buttons: [t('workbench.scm.saveAllAndContinue'), t('common.continue'), t('common.cancel')] });
		if (choice === 2) return false;
		if (choice === 0) for (const f of files) await saveFile(f);
		return true;
	}

	/**
	 * Stash (VS Code's git.stash / git.stashIncludeUntracked), with an optional message: Enter on
	 * an empty input takes the commit message with `git.useCommitInputAsStashMessage`.
	 */
	async stash({ includeUntracked = false } = {}) {
		if (!(await this.#saveFirst('git.promptToSaveFilesBeforeStash', 'stash'))) return;
		const fromInput = get<boolean>('git.useCommitInputAsStashMessage') ? this.message.trim().split('\n')[0] : '';
		const typed = await quick.input({
			placeholder: t('workbench.scm.stashMessage'),
			hint: (v) => (v || fromInput ? t('workbench.scm.stashWithMessage', { message: v || fromInput }) : t('workbench.scm.stashNoMessage'))
		});
		if (typed === undefined) return;
		const message = typed || fromInput;
		const ok = await this.#exclusive(t('workbench.scm.stashing'), () => invoke('git_stash_push', this.#args({ message: message || null, includeUntracked })).then(() => true));
		if (ok) {
			status.flash(t('workbench.scm.stashed'));
			this.closeDiffs();
		}
	}

	async #pickStash(placeholder: string): Promise<Stash | undefined> {
		let list: Stash[];
		try {
			list = await invoke<Stash[]>('git_stash_list', this.#args());
		} catch (e) {
			notifications.error(e);
			return undefined;
		}
		if (!list.length) {
			status.flash(t('workbench.scm.noStashes'));
			return undefined;
		}
		const pick = await quick.choose({ placeholder, items: stashItems(list) });
		return pick && list.find((s) => String(s.index) === pick.id);
	}

	async stashApply({ pop = false } = {}) {
		const s = await this.#pickStash(pop ? t('workbench.scm.pickStashPop') : t('workbench.scm.pickStashApply'));
		if (!s) return;
		const ok = await this.#exclusive(t('workbench.scm.applyingStash'), () => invoke('git_stash_apply', this.#args({ index: s.index, pop })).then(() => true));
		if (ok) status.flash(pop ? t('workbench.scm.stashPopped') : t('workbench.scm.stashApplied'));
	}

	async stashDrop() {
		const s = await this.#pickStash(t('workbench.scm.pickStashDrop'));
		if (!s) return;
		const sure = await ask(t('workbench.scm.confirmDropStash', { ref: `stash@{${s.index}}`, message: s.message }), { title: t('workbench.scm.dropStash'), kind: 'warning', okLabel: t('workbench.scm.drop'), cancelLabel: t('common.cancel') });
		if (!sure) return;
		const ok = await this.#exclusive(t('workbench.scm.droppingStash'), () => invoke('git_stash_drop', this.#args({ index: s.index })).then(() => true));
		if (ok) status.flash(t('workbench.scm.stashDropped'));
	}

	/** An OK / Always / Cancel question whose Always turns `setting` off. */
	async #confirm(setting: string, text: string, title: string): Promise<boolean> {
		if (!get<boolean>(setting)) return true;
		const choice = await messageBox(text, { title, kind: 'warning', buttons: [t('common.ok'), t('workbench.scm.always'), t('common.cancel')] });
		if (choice === 1) await settings.set(setting, false, 'user');
		return choice === 0 || choice === 1;
	}

	/** `git.branchProtection` / `git.branchProtectionPrompt`: false to stop, `'newBranch'` to commit on a new branch. */
	async #protectedBranch(): Promise<boolean | 'newBranch'> {
		if (!isProtectedBranch(this.repo?.branch ?? null, get<string[]>('git.branchProtection'))) return true;
		const mode = get<string>('git.branchProtectionPrompt');
		if (mode === 'alwaysCommit') return true;
		if (mode === 'alwaysCommitToNewBranch') return 'newBranch';
		const text = t('workbench.scm.protectedBranch', { branch: this.repo?.branch ?? '' });
		const choice = await messageBox(text, { title: 'Git', kind: 'warning', buttons: [t('workbench.scm.commit'), t('workbench.scm.commitToNewBranch'), t('common.cancel')] });
		return choice === 0 ? true : choice === 1 ? 'newBranch' : false;
	}

	/** `git.diagnosticsCommitHook.*`: errors (or what `sources` says) in the files being committed. */
	async #diagnosticsOk(paths: string[]): Promise<boolean> {
		if (!get<boolean>('git.diagnosticsCommitHook.enabled')) return true;
		const { openModels } = await import('./editorModels');
		const monaco = await import('monaco-editor');
		const severity = (s: number): Problem['severity'] => (s >= 8 ? 'error' : s >= 4 ? 'warning' : s >= 2 ? 'information' : 'hint');
		const problems: Problem[] = openModels().flatMap(([path, model]) =>
			monaco.editor.getModelMarkers({ resource: model.uri }).map((m) => ({ path, source: m.source ?? m.owner, severity: severity(m.severity), message: m.message }))
		);
		const blocking = blockingProblems(problems, get<Record<string, string>>('git.diagnosticsCommitHook.sources'), new Set(paths));
		if (!blocking.length) return true;
		const text = t('workbench.scm.diagnostics', { count: blocking.length, path: blocking[0].path, message: blocking[0].message });
		const choice = await messageBox(text, { title: 'Git', kind: 'warning', buttons: [t('workbench.scm.commitAnyway'), t('workbench.scm.showProblems'), t('common.cancel')] });
		if (choice === 1) {
			appMode.setMode('workbench');
			layout.showPanel('problems');
		}
		return choice === 0;
	}

	/**
	 * Commit, Commit (Amend), Commit (No Verify) and Commit Empty, with VS Code's checks: user
	 * config, unsaved files, protected branches, diagnostics, smart commit and its suggestion.
	 */
	async commit({ amend = false, noVerify = false, empty = false } = {}) {
		const message = this.message.trim();
		if (!message) {
			status.flash(t('workbench.scm.enterMessage'));
			return;
		}
		if (get<boolean>('git.requireGitUserConfig') && !(await invoke<boolean>('git_user_configured', this.#args()).catch(() => true))) {
			await showMessage(t('workbench.scm.userConfig'), { title: 'Git', kind: 'warning' });
			return;
		}
		if (noVerify) {
			if (!get<boolean>('git.allowNoVerifyCommit')) return;
			const text = t('workbench.scm.confirmNoVerify');
			if (!(await this.#confirm('git.confirmNoVerifyCommit', text, 'Git: Commit (No Verify)'))) return;
		}
		if (empty && !(await this.#confirm('git.confirmEmptyCommits', t('workbench.scm.confirmEmpty'), 'Git: Commit Empty'))) return;
		if (!(await this.#saveFirst('git.promptToSaveFilesBeforeCommit', 'commit'))) return;
		if (!amend && !empty && !this.groups.staged.length) {
			const changes = [...this.groups.changes, ...this.groups.untracked];
			let smart = get<boolean>('git.enableSmartCommit');
			if (!smart && changes.length && get<boolean>('git.suggestSmartCommit')) {
				const [yes, always, never] = [t('common.yes'), t('workbench.scm.always'), t('workbench.scm.never')];
				const choice = await notifications.prompt('info', t('workbench.scm.suggestSmartCommit'), [yes, always, never], { source: 'Git' });
				if (choice === always) await settings.set('git.enableSmartCommit', true, 'user');
				if (choice === never) await settings.set('git.suggestSmartCommit', false, 'user');
				if (choice !== yes && choice !== always) return;
				smart = true;
			}
			// git.enableSmartCommit: nothing staged commits the changes (all, or tracked only).
			const paths = smart ? smartCommitPaths(changes, get('git.smartCommitChanges')) : [];
			if (!paths.length) {
				status.flash(changes.length ? t('workbench.scm.nothingStaged') : t('workbench.scm.noChanges'));
				return;
			}
			if (!(await this.stage(paths))) return;
		}
		const committed = this.groups.staged.map((r) => r.entry.path);
		if (!(await this.#diagnosticsOk(committed))) return;
		const target = await this.#protectedBranch();
		if (!target) return;
		if (target === 'newBranch' && !(await this.createBranch())) return;
		if (await this.#run('git_commit', { message, options: commitOptions(get, { amend, noVerify, empty }) })) {
			this.message = '';
			status.flash(amend ? t('workbench.scm.amended') : t('workbench.scm.committed'));
			this.closeDiffs(committed);
			// git.postCommitCommand
			const after = get<string>('git.postCommitCommand');
			if (after === 'push') await this.push();
			else if (after === 'sync') await this.sync();
		}
	}

	/** git.autofetch: a quiet fetch (every remote with `"all"`); failures only go to the log, like VS Code. */
	async autoFetch() {
		const owner = this.#owner;
		if (owner.op || !this.repo?.remotes.length) return;
		owner.op = opLabel('fetch');
		try {
			await invoke('git_fetch', this.#args({ options: fetchOptions(get, { auto: true }) }));
		} catch (e) {
			clientLog('info', `git autofetch: ${e}`);
		} finally {
			owner.op = null;
			await this.refresh();
		}
	}

	/** The status bar's and Repositories view's remote commands, by VS Code id, on this repository. */
	run(id: string) {
		switch (id) {
			case 'git.sync':
				return this.sync();
			case 'git.publish':
				return this.publish();
			case 'git.push':
				return this.push();
			case 'git.pull':
				return this.pull();
			case 'git.fetch':
				return this.fetch();
			case 'git.checkout':
				return this.checkout();
		}
	}
}

/** The workspace's repositories (VS Code's ISCMService) and the single-repository view of them older callers use. */
class Scm {
	/** In discovery order (folders first, then what was found below them). */
	repositories = $state.raw<Repository[]>([]);
	/** False until the first read; then `repositories` is the workspace's. */
	loaded = $state(false);
	/** `git.enabled` is off: no git runs at all. */
	disabled = $state(false);
	/** Status bar progress text of the running remote/branch operation (one per window). */
	op = $state<string | null>(null);
	/** The repositories picked in the Repositories view, by directory (`scm.repositories.selectionMode`). */
	selected = $state.raw<string[]>([]);
	/** The repository of the last active editor that had one (the status bar's branch follows it). */
	#lastActive = $state<string | null>(null);

	/** The first folder's own repository, null when it has none (the ADE initializes one then). */
	primary = $derived(this.repositories.find((r) => r.primary) ?? null);
	/** VS Code's active repository: the active editor's, else the last one used, else the first. */
	active = $derived(this.repositories.find((r) => r.dir === this.#lastActive) ?? this.primary ?? this.repositories[0] ?? null);

	// The single-repository view (the ADE and older callers work on the first folder).
	get repo(): GitStatus | null {
		return this.primary?.repo ?? null;
	}
	get groups() {
		return this.primary?.groups ?? EMPTY_GROUPS;
	}
	get message() {
		return this.primary?.message ?? '';
	}
	set message(v: string) {
		if (this.primary) this.primary.message = v;
	}
	get busy() {
		return this.repositories.some((r) => r.busy);
	}

	/** Every repository's changes (Explorer, Search and tab decorations). */
	entries = $derived(this.repositories.flatMap((r) => r.repo?.entries ?? []));

	/** Activity bar badge (`scm.countBadge`: every repository, the active one, or none). */
	count = $derived.by(() => {
		const mode = settings.get<string>('scm.countBadge');
		if (mode === 'off') return 0;
		if (mode === 'focused') return this.active?.count ?? 0;
		return this.repositories.reduce((n, r) => n + r.count, 0);
	});

	#inflight: Promise<void> | null = null;
	#again = false;
	#rescan = true;
	#limitWarned = false;
	/** Parent repositories the user agreed to open this session, and the ones already asked about. */
	#allowedParents: string[] = [];
	#askedParents = new Set<string>();

	/** The repository holding workspace path `key`. */
	repositoryOf(key: string | null | undefined): Repository | null {
		if (!key || !isWorkspaceFile(key)) return null;
		return repositoryOf(key, this.repositories, workspace.folders);
	}

	/** The status entry of workspace path `key`, in whichever repository has it. */
	entry(key: string): StatusEntry | undefined {
		return this.repositoryOf(key)?.repo?.entries.find((e) => e.path === key);
	}

	/** The repositories again (detection) on the next refresh: folders or detection settings changed. */
	rescan(): Promise<void> {
		this.#rescan = true;
		return this.refresh();
	}

	/** Re-reads every repository's status (finding them first when needed). Coalesces overlapping calls. */
	refresh(): Promise<void> {
		if (this.#inflight) {
			this.#again = true;
			return this.#inflight;
		}
		this.#inflight = (async () => {
			do {
				this.#again = false;
				this.disabled = get<boolean>('git.enabled') === false;
				if (this.disabled || !workspace.root) {
					this.repositories = [];
				} else if (this.#rescan || !this.loaded) {
					this.#rescan = false;
					await this.#detect();
				}
				await Promise.all(this.repositories.map((r) => r.refresh()));
				this.syncBranch();
				this.loaded = true;
			} while (this.#again);
			this.#inflight = null;
		})();
		return this.#inflight;
	}

	/** `status.branch`: the first folder's branch (the ADE's primary row and the window title). */
	syncBranch() {
		const repo = this.primary?.repo;
		status.branch = repo ? (repo.branch ?? repo.head) : null;
	}

	async #detect() {
		let found: Detection;
		try {
			const openEditors = [...editors.openPaths()].filter(isWorkspaceFile);
			found = await invoke<Detection>('git_repositories', { options: detectOptions(get, { allowedParents: this.#allowedParents, openEditors }) });
		} catch (e) {
			clientLog('error', `git repositories: ${e}`);
			const root = workspace.root;
			found = { repositories: root ? [{ dir: root, folder: root, toplevel: root, kind: 'folder' }] : [], parents: [] };
		}
		// A repository found again keeps its object (and its commit message).
		const old = new Map(this.repositories.map((r) => [r.dir, r]));
		this.repositories = found.repositories.map((info) => {
			const r = old.get(info.dir);
			if (!r) return new Repository(this, info);
			r.info = info;
			return r;
		});
		const dirs = new Set(this.repositories.map((r) => r.dir));
		this.selected = this.selected.filter((d) => dirs.has(d));
		for (const p of found.parents) void this.#askParent(p);
	}

	/** `git.openRepositoryInParentFolders: prompt`: asks once per session for each parent repository. */
	async #askParent(p: ParentRepo) {
		if (this.#askedParents.has(p.toplevel)) return;
		this.#askedParents.add(p.toplevel);
		const [yes, always, never] = [t('scmRepos.parentOpen'), t('scmRepos.parentAlways'), t('scmRepos.parentNever')];
		const choice = await notifications.prompt('info', t('scmRepos.parentFound', { folder: p.folder, repository: p.toplevel }), [yes, always, never], { source: 'Git' });
		if (choice === never) await settings.set('git.openRepositoryInParentFolders', 'never', 'user');
		if (choice === always) await settings.set('git.openRepositoryInParentFolders', 'always', 'user');
		if (choice === yes) this.#allowedParents = [...this.#allowedParents, p.toplevel];
		if (choice === yes || choice === always) await this.rescan();
	}

	/** `git.statusLimit`, warning once unless `git.ignoreLimitWarning`. */
	limit(read: GitStatus): GitStatus {
		const limit = get<number>('git.statusLimit');
		const { entries, hitLimit } = limitStatus(read.entries, limit);
		if (hitLimit && !this.#limitWarned && !get<boolean>('git.ignoreLimitWarning')) {
			this.#limitWarned = true;
			void notifications
				.prompt('warning', t('workbench.scm.tooManyChanges', { limit }), [t('workbench.scm.dontShowAgain')], { source: 'Git' })
				.then((c) => {
					if (c) void settings.set('git.ignoreLimitWarning', true, 'user');
				});
		}
		return hitLimit ? { ...read, entries } : read;
	}

	/** The workspace changed: nothing of the old one stays. */
	reset() {
		this.repositories = [];
		this.selected = [];
		this.loaded = false;
		this.#lastActive = null;
		this.#rescan = true;
		this.#allowedParents = [];
		this.#askedParents.clear();
		status.branch = null;
	}

	/** The active editor's repository becomes the active one (VS Code's status bar follows it). */
	follow(key: string | null) {
		const r = this.repositoryOf(key ? fileOf(key) : null);
		if (r) this.#lastActive = r.dir;
	}

	/** The Repositories view picked `r` (`add`: Cmd/Ctrl-click keeps the others, `multiple` mode). */
	select(r: Repository, add = false) {
		this.#lastActive = r.dir;
		const multiple = settings.get<string>('scm.repositories.selectionMode') !== 'single';
		this.selected = add && multiple ? (this.selected.includes(r.dir) ? this.selected.filter((d) => d !== r.dir) : [...this.selected, r.dir]) : [r.dir];
	}

	/**
	 * The repository a palette command acts on (VS Code asks "Choose a repository" when there are
	 * several): the only one, else the user's pick, the active one first.
	 */
	async pick(filter: (r: Repository) => boolean = () => true): Promise<Repository | undefined> {
		const list = this.repositories.filter(filter);
		if (list.length <= 1) return list[0];
		const ordered = this.active && list.includes(this.active) ? [this.active, ...list.filter((r) => r !== this.active)] : list;
		const item = await quick.choose({
			placeholder: t('scmRepos.pickRepository'),
			items: ordered.map((r) => ({ id: r.dir, label: r.label.name, description: [r.repo?.branch ?? r.repo?.head ?? '', r.label.description].filter(Boolean).join(' · ') }))
		});
		return item ? list.find((r) => r.dir === item.id) : undefined;
	}

	/** Runs `fn` on the picked repository. */
	async #on(fn: (r: Repository) => unknown, filter?: (r: Repository) => boolean) {
		const r = await this.pick(filter);
		if (r) return fn(r);
	}

	/** Stages workspace paths, each in its own repository (the merge editor, quick diff). */
	async stage(paths: string[]): Promise<boolean> {
		let ok = true;
		for (const [r, list] of this.#byRepository(paths)) ok = (await r.stage(list)) && ok;
		return ok;
	}

	async unstage(paths: string[]): Promise<boolean> {
		let ok = true;
		for (const [r, list] of this.#byRepository(paths)) ok = (await r.unstage(list)) && ok;
		return ok;
	}

	#byRepository(paths: string[]): Map<Repository, string[]> {
		const out = new Map<Repository, string[]>();
		for (const p of paths) {
			const r = this.repositoryOf(p);
			if (r) out.set(r, [...(out.get(r) ?? []), p]);
		}
		return out;
	}

	/**
	 * VS Code's Initialize Repository (`git.defaultBranchName`): the first folder, or the folder
	 * picked when several have none. `initialCommit` (the ADE, on the first folder) adds an empty
	 * first commit so worktrees have a branch to fork from (Orca's new projects start that way).
	 */
	async init(initialCommit = false, folder?: string): Promise<boolean> {
		let target = folder ?? (initialCommit ? workspace.root : null);
		if (!target) {
			const bare = workspace.folders.filter((f) => !this.repositories.some((r) => r.info.folder === f.path && (r.info.kind === 'folder' || r.info.kind === 'parent')));
			if (bare.length > 1) target = (await quick.choose({ placeholder: t('scmRepos.pickInitFolder'), items: bare.map((f) => ({ id: f.path, label: f.name, description: f.path })) }))?.id ?? null;
			else target = bare[0]?.path ?? workspace.root;
		}
		if (!target) return false;
		let ok = true;
		try {
			await invoke('git_init', { initialCommit, defaultBranch: get<string>('git.defaultBranchName'), folder: target });
		} catch (e) {
			ok = false;
			notifications.error(e);
			clientLog('error', `git_init: ${e}`);
		}
		await this.rescan();
		if (ok) status.flash(initialCommit ? t('workbench.scm.initializedWithCommit') : t('workbench.scm.initialized'));
		return ok;
	}

	/** `git.closeDiffOnOperation`: closes the HEAD diff tabs of `paths` (all of them when omitted). */
	closeDiffs(paths?: string[]) {
		if (!get<boolean>('git.closeDiffOnOperation')) return;
		const only = paths && new Set(paths);
		for (const g of editors.model.groups)
			for (const t of [...g.tabs]) if (t.path.startsWith(DIFF_PREFIX) && (!only || only.has(fileOf(t.path)))) editors.close(t.path, { group: g.id, force: true });
	}

	cancel() {
		void invoke('git_cancel');
	}

	// Palette commands on the picked repository.
	commit(opts?: { amend?: boolean; noVerify?: boolean; empty?: boolean }) {
		return this.#on((r) => r.commit(opts));
	}
	fetch() {
		return this.#on((r) => r.fetch(), (r) => !!r.repo?.remotes.length);
	}
	pull(opts?: { rebase?: boolean }) {
		return this.#on((r) => r.pull(opts), tracked);
	}
	push(opts?: { force?: boolean }) {
		return this.#on((r) => r.push(opts), onBranch);
	}
	sync() {
		return this.#on((r) => r.sync(), tracked);
	}
	publish() {
		return this.#on((r) => r.publish(), (r) => onBranch(r) && !tracked(r) && !!r.repo?.remotes.length);
	}
	checkout() {
		return this.#on((r) => r.checkout());
	}
	createBranch() {
		return this.#on((r) => r.createBranch());
	}
	createBranchFrom() {
		return this.#on((r) => r.createBranchFrom());
	}
	deleteBranch() {
		return this.#on((r) => r.deleteBranch());
	}
	stash(opts?: { includeUntracked?: boolean }) {
		return this.#on((r) => r.stash(opts));
	}
	stashApply(opts?: { pop?: boolean }) {
		return this.#on((r) => r.stashApply(opts));
	}
	stashDrop() {
		return this.#on((r) => r.stashDrop());
	}
}

const onBranch = (r: Repository) => !!r.repo?.branch;
const tracked = (r: Repository) => !!r.repo?.upstream && !r.repo.upstream_gone;

export const scm = new Scm();

/** Workbench-level wiring: initial read, refresh on focus and after saves, palette commands. */
export function installScm(): () => void {
	void scm.refresh();
	// git.autorefresh: re-read on window focus and after saves (a repository created outside
	// Kingu shows up on focus too).
	const onFocus = () => {
		if (get<boolean>('git.autorefresh')) void scm.rescan();
	};
	window.addEventListener('focus', onFocus);

	// A save turns a dirty tab clean; re-read status then (a fall in the dirty count).
	let dirty = 0;
	const stopEffect = $effect.root(() => {
		$effect(() => {
			const now = editors.dirtyCount();
			if (now < dirty && get<boolean>('git.autorefresh')) void scm.refresh();
			dirty = now;
		});
		// git.enabled, git.similarityThreshold, git.ignoreSubmodules, git.statusLimit: re-read.
		$effect(() => {
			for (const id of ['git.enabled', 'git.similarityThreshold', 'git.ignoreSubmodules', 'git.statusLimit']) void get(id);
			void scm.refresh();
		});
		// The settings that pick repositories: look for them again.
		$effect(() => {
			const ids = ['git.autoRepositoryDetection', 'git.repositoryScanMaxDepth', 'git.repositoryScanIgnoredFolders', 'git.scanRepositories', 'git.ignoredRepositories', 'git.openRepositoryInParentFolders'];
			for (const id of ids) void JSON.stringify(get(id));
			void scm.rescan();
		});
		// git.autoRepositoryDetection openEditors: an editor opened in a repository not open yet.
		$effect(() => {
			const mode = get<boolean | string>('git.autoRepositoryDetection');
			const active = editors.active;
			if (mode !== true && mode !== 'openEditors') return;
			const file = active ? fileOf(active) : null;
			if (file && isWorkspaceFile(file) && scm.loaded && !scm.repositoryOf(file)) void scm.rescan();
		});
		// The status bar's branch follows the active editor's repository.
		$effect(() => {
			const active = editors.active;
			void scm.repositories;
			scm.follow(active);
		});
		// git.path: Rust re-reads it from the user settings file.
		$effect(() => {
			void get('git.path');
			if (settings.loaded) void invoke('git_reload_path').then(() => (void scm.rescan(), warnMissingGit())).catch(() => {});
		});
		// git.autofetch every git.autofetchPeriod seconds, each repository with a remote.
		$effect(() => {
			const remotes = scm.repositories.filter((r) => r.repo?.remotes.length);
			if (autofetchMode(get) === 'off' || !remotes.length) return;
			const timer = setInterval(() => {
				for (const r of scm.repositories) void r.autoFetch();
			}, get<number>('git.autofetchPeriod') * 1000);
			return () => clearInterval(timer);
		});
	});

	const any = () => scm.repositories.length > 0;
	const unstaged = (r: Repository) => r.groups.changes.length + r.groups.untracked.length > 0;
	const unregister = [
		commands.register({ id: 'git.refresh', title: 'Git: Refresh', run: () => scm.rescan() }),
		commands.register({
			id: 'git.init',
			title: 'Git: Initialize Repository',
			when: () => scm.loaded && !scm.disabled && workspace.root !== null && workspace.folders.some((f) => !scm.repositories.some((r) => r.info.folder === f.path && r.info.kind !== 'nested' && r.info.kind !== 'editor')),
			run: () => scm.init()
		}),
		commands.register({ id: 'git.clone', title: 'Git: Clone', run: () => repoDialog.show('clone') }),
		commands.register({ id: 'git.commit', title: 'Git: Commit', when: any, run: () => scm.commit() }),
		commands.register({ id: 'git.commitAmend', title: 'Git: Commit (Amend)', when: any, run: () => scm.commit({ amend: true }) }),
		commands.register({
			id: 'git.commitNoVerify',
			title: 'Git: Commit (No Verify)',
			when: () => any() && get<boolean>('git.allowNoVerifyCommit'),
			run: () => scm.commit({ noVerify: true })
		}),
		commands.register({ id: 'git.commitEmpty', title: 'Git: Commit Empty', when: any, run: () => scm.commit({ empty: true }) }),
		commands.register({
			id: 'git.stageAll',
			title: 'Git: Stage All Changes',
			when: () => scm.repositories.some(unstaged),
			run: async () => {
				const r = await scm.pick(unstaged);
				if (r) await r.stage([...r.groups.changes, ...r.groups.untracked].map((x) => x.entry.path));
			}
		}),
		commands.register({
			id: 'git.unstageAll',
			title: 'Git: Unstage All Changes',
			when: () => scm.repositories.some((r) => r.groups.staged.length > 0),
			run: async () => {
				const r = await scm.pick((x) => x.groups.staged.length > 0);
				if (r) await r.unstage(r.groups.staged.map((x) => x.entry.path));
			}
		}),
		...remoteCommands()
	];

	return () => {
		window.removeEventListener('focus', onFocus);
		stopEffect();
		unregister.forEach((u) => u());
	};
}

/** Remote, branch and stash commands, with VS Code's ids. */
function remoteCommands(): (() => void)[] {
	const some = (f: (r: Repository) => boolean) => () => scm.repositories.some(f);
	const repo = () => scm.repositories.length > 0;
	const hasRemote = (r: Repository) => (r.repo?.remotes.length ?? 0) > 0;
	return [
		{ id: 'git.fetch', title: 'Git: Fetch', when: some(hasRemote), run: () => scm.fetch() },
		{ id: 'git.pull', title: 'Git: Pull', when: some(tracked), run: () => scm.pull() },
		{ id: 'git.pullRebase', title: 'Git: Pull (Rebase)', when: some(tracked), run: () => scm.pull({ rebase: true }) },
		{ id: 'git.push', title: 'Git: Push', when: some(onBranch), run: () => scm.push() },
		{ id: 'git.pushForce', title: 'Git: Push (Force)', when: () => some(tracked)() && get<boolean>('git.allowForcePush'), run: () => scm.push({ force: true }) },
		{ id: 'git.sync', title: 'Git: Sync', when: some(tracked), run: () => scm.sync() },
		{ id: 'git.publish', title: 'Git: Publish Branch...', when: some((r) => onBranch(r) && !tracked(r) && hasRemote(r)), run: () => scm.publish() },
		{ id: 'git.checkout', title: 'Git: Checkout to...', when: repo, run: () => scm.checkout() },
		{ id: 'git.branch', title: 'Git: Create Branch...', when: repo, run: () => scm.createBranch() },
		{ id: 'git.branchFrom', title: 'Git: Create Branch From...', when: repo, run: () => scm.createBranchFrom() },
		{ id: 'git.deleteBranch', title: 'Git: Delete Branch...', when: repo, run: () => scm.deleteBranch() },
		{ id: 'git.stash', title: 'Git: Stash', when: repo, run: () => scm.stash() },
		{ id: 'git.stashIncludeUntracked', title: 'Git: Stash (Include Untracked)', when: repo, run: () => scm.stash({ includeUntracked: true }) },
		{ id: 'git.stashPop', title: 'Git: Pop Stash...', when: repo, run: () => scm.stashApply({ pop: true }) },
		{ id: 'git.stashApply', title: 'Git: Apply Stash...', when: repo, run: () => scm.stashApply() },
		{ id: 'git.stashDrop', title: 'Git: Drop Stash...', when: repo, run: () => scm.stashDrop() }
	].map((c) => commands.register(c));
}
