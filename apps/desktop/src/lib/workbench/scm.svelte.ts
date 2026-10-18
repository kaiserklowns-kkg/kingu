// Source Control model (VS Code: ISCMService + the git extension's Repository). Status is
// re-read on view open, after every git operation, after a save and on window focus
// (`git.autorefresh`). VS Code's git.* settings shape every operation (scmSettings.ts).

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
import { commands } from './commands.svelte';
import { editors } from './editors.svelte';
import { saveFile } from './editorModels';
import { DIFF_PREFIX, fileOf, groups, isDiffKey, smartCommitPaths, type GitStatus } from './scm';
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

/** Unsaved editors that are files of the open folder (not untitled, diffs or Kingu's own files). */
const dirtyRepoFiles = () => editors.dirtyPaths().filter((p) => !isUntitled(p) && !isDiffKey(p) && !p.includes(':') && !p.startsWith('/'));

class Scm {
	repo = $state<GitStatus | null>(null);
	/** False until the first status read; then whether the workspace is a git repository. */
	loaded = $state(false);
	/** `git.enabled` is off: no git runs at all. */
	disabled = $state(false);
	busy = $state(false);
	syncing = $state(false);
	message = $state('');
	/** `git.untrackedChanges`: untracked files with the changes, in their own group, or hidden. */
	groups = $derived(splitUntracked(groups(this.repo?.entries ?? []), settings.get<UntrackedMode>('git.untrackedChanges')));
	/** Activity bar badge (`scm.countBadge`, `git.countBadge`). */
	count = $derived(countBadge(this.groups, settings.get<string>('git.countBadge'), settings.get<string>('scm.countBadge')));

	#inflight: Promise<void> | null = null;
	#again = false;
	#limitWarned = false;

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
					this.disabled = get<boolean>('git.enabled') === false;
					const read = this.disabled ? null : await invoke<GitStatus | null>('git_status', { options: statusOptions(get) });
					this.repo = read && this.#limit(read);
					status.branch = this.repo ? (this.repo.branch ?? this.repo.head) : null;
				} catch (e) {
					clientLog('error', `git status: ${e}`);
				}
				this.loaded = true;
			} while (this.#again);
			this.#inflight = null;
		})();
		return this.#inflight;
	}

	/** `git.statusLimit`, warning once unless `git.ignoreLimitWarning`. */
	#limit(read: GitStatus): GitStatus {
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

	/**
	 * VS Code's Initialize Repository for the open folder (`git.defaultBranchName`). `initialCommit`
	 * (the ADE) adds an empty first commit so worktrees have a branch to fork from (Orca's new
	 * projects start that way).
	 */
	async init(initialCommit = false): Promise<boolean> {
		const ok = await this.#run('git_init', { initialCommit, defaultBranch: get<string>('git.defaultBranchName') });
		if (ok) status.flash(initialCommit ? t('workbench.scm.initializedWithCommit') : t('workbench.scm.initialized'));
		return ok;
	}

	/** Runs a git command, reports failure in the status bar, then re-reads status. */
	async #run(cmd: string, args: Record<string, unknown>): Promise<boolean> {
		this.busy = true;
		try {
			await invoke(cmd, args);
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

	/** `git.closeDiffOnOperation`: closes the HEAD diff tabs of `paths` (all of them when omitted). */
	closeDiffs(paths?: string[]) {
		if (!get<boolean>('git.closeDiffOnOperation')) return;
		const only = paths && new Set(paths);
		for (const g of editors.model.groups)
			for (const t of [...g.tabs]) if (t.path.startsWith(DIFF_PREFIX) && (!only || only.has(fileOf(t.path)))) editors.close(t.path, { group: g.id, force: true });
	}

	async stage(paths: string[]) {
		const ok = await this.#run('git_stage', { paths });
		if (ok) this.closeDiffs(paths);
		return ok;
	}

	/** A staged rename needs its source unstaged too, or the deletion stays staged. */
	async unstage(paths: string[]) {
		const all = new Set(paths);
		for (const e of this.repo?.entries ?? []) if (all.has(e.path) && e.orig_path) all.add(e.orig_path);
		const ok = await this.#run('git_unstage', { paths: [...all] });
		if (ok) this.closeDiffs(paths);
		return ok;
	}

	/** Callers confirm first; `deleteUntracked` is only set after the user agreed to delete. */
	async discard(paths: string[], deleteUntracked: boolean) {
		const ok = await this.#run('git_discard', { paths, deleteUntracked, toTrash: get<boolean>('git.discardUntrackedChangesToTrash') });
		if (ok) this.closeDiffs(paths);
		return ok;
	}

	// ---------------------------------------------------------------------------------------
	// Remotes, branches and stashes. One at a time (Rust enforces it too); the running one shows
	// in the status bar as `op` (`git.showProgress`) and can be cancelled from there.

	/** Status bar progress text of the running remote/branch operation. */
	op = $state<string | null>(null);

	/** Runs `fn` as the one operation, shows its error, then re-reads status (and the branch). */
	async #exclusive<T>(label: string, fn: () => Promise<T>, terminal?: string[]): Promise<T | undefined> {
		if (this.op) {
			status.flash(t('workbench.scm.busy'));
			return undefined;
		}
		this.op = label;
		try {
			return await fn();
		} catch (e) {
			clientLog('error', `git: ${e}`);
			if (terminal && isAuthError(e)) void this.#offerTerminal(String(e), terminal);
			else void showMessage(String(e), { title: 'Git', kind: 'error' });
			return undefined;
		} finally {
			this.op = null;
			await this.refresh();
		}
	}

	/** git never prompts inside Kingu; a terminal running the same command can. */
	async #offerTerminal(text: string, run: string[]) {
		const open = await ask(text, { title: 'Git', kind: 'warning', okLabel: t('workbench.scm.openInTerminal'), cancelLabel: t('common.close') });
		if (!open) return;
		appMode.setMode('workbench');
		terminals.open({ title: run.slice(0, 2).join(' '), run });
		layout.showPanel('terminal');
	}

	async #net(op: NetOp, cmd: string, args: Record<string, unknown>, done: string, terminal: string[]) {
		const ok = await this.#exclusive(opLabel(op), () => invoke(cmd, args).then(() => true), terminal);
		if (ok) status.flash(done);
		return ok === true;
	}

	cancel() {
		void invoke('git_cancel');
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
			return await invoke<BranchRef[]>('git_refs', { hashLength: get<number>('git.commitShortHashLength'), tags });
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
		const local = await this.#exclusive(t('workbench.scm.checkingOut'), () => invoke<string>('git_checkout', { name, remote, options }));
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
		const ok = await this.#exclusive(t('workbench.scm.creatingBranch'), () => invoke('git_create_branch', { name, from: from ?? null }).then(() => true));
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
		const result = await this.#exclusive(t('workbench.scm.deletingBranch'), () => invoke<DeleteResult>('git_delete_branch', { name, force: false }));
		if (result === 'deleted') status.flash(t('workbench.scm.branchDeleted', { name }));
		if (result !== 'not_merged') return;
		const force = await ask(t('workbench.scm.confirmForceDeleteBranch', { name }), {
			title: t('workbench.scm.deleteBranch'),
			kind: 'warning',
			okLabel: t('workbench.scm.deleteBranch'),
			cancelLabel: t('common.cancel')
		});
		if (!force) return;
		const forced = await this.#exclusive(t('workbench.scm.deletingBranch'), () => invoke<DeleteResult>('git_delete_branch', { name, force: true }));
		if (forced === 'deleted') status.flash(t('workbench.scm.branchDeleted', { name }));
	}

	/**
	 * `git.promptToSaveFilesBeforeCommit` / `…BeforeStash`: offers to save unsaved files first.
	 * False when the user cancels.
	 */
	async #saveFirst(setting: string, action: string): Promise<boolean> {
		const staged = new Set(this.groups.staged.map((r) => r.entry.path));
		const files = filesToSave(dirtyRepoFiles(), get<SavePrompt>(setting), staged);
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
		const ok = await this.#exclusive(t('workbench.scm.stashing'), () => invoke('git_stash_push', { message: message || null, includeUntracked }).then(() => true));
		if (ok) {
			status.flash(t('workbench.scm.stashed'));
			this.closeDiffs();
		}
	}

	async #pickStash(placeholder: string): Promise<Stash | undefined> {
		let list: Stash[];
		try {
			list = await invoke<Stash[]>('git_stash_list');
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
		const ok = await this.#exclusive(t('workbench.scm.applyingStash'), () => invoke('git_stash_apply', { index: s.index, pop }).then(() => true));
		if (ok) status.flash(pop ? t('workbench.scm.stashPopped') : t('workbench.scm.stashApplied'));
	}

	async stashDrop() {
		const s = await this.#pickStash(t('workbench.scm.pickStashDrop'));
		if (!s) return;
		const sure = await ask(t('workbench.scm.confirmDropStash', { ref: `stash@{${s.index}}`, message: s.message }), { title: t('workbench.scm.dropStash'), kind: 'warning', okLabel: t('workbench.scm.drop'), cancelLabel: t('common.cancel') });
		if (!sure) return;
		const ok = await this.#exclusive(t('workbench.scm.droppingStash'), () => invoke('git_stash_drop', { index: s.index }).then(() => true));
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
		if (get<boolean>('git.requireGitUserConfig') && !(await invoke<boolean>('git_user_configured').catch(() => true))) {
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
		if (this.op || !this.repo?.remotes.length) return;
		this.op = opLabel('fetch');
		try {
			await invoke('git_fetch', { options: fetchOptions(get, { auto: true }) });
		} catch (e) {
			clientLog('info', `git autofetch: ${e}`);
		} finally {
			this.op = null;
			await this.refresh();
		}
	}
}

export const scm = new Scm();

/** Workbench-level wiring: initial read, refresh on focus and after saves, palette commands. */
export function installScm(): () => void {
	void scm.refresh();
	// git.autorefresh: re-read on window focus and after saves.
	const onFocus = () => {
		if (get<boolean>('git.autorefresh')) void scm.refresh();
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
		// git.path: Rust re-reads it from the user settings file.
		$effect(() => {
			void get('git.path');
			if (settings.loaded) void invoke('git_reload_path').then(() => scm.refresh()).catch(() => {});
		});
		// git.autofetch every git.autofetchPeriod seconds while a repository with a remote is open.
		$effect(() => {
			if (autofetchMode(get) === 'off' || !scm.repo?.remotes.length) return;
			const timer = setInterval(() => void scm.autoFetch(), get<number>('git.autofetchPeriod') * 1000);
			return () => clearInterval(timer);
		});
	});

	const unregister = [
		commands.register({ id: 'git.refresh', title: 'Git: Refresh', run: () => scm.refresh() }),
		commands.register({ id: 'git.init', title: 'Git: Initialize Repository', when: () => scm.loaded && scm.repo === null && !scm.disabled && workspace.root !== null, run: () => scm.init() }),
		commands.register({ id: 'git.clone', title: 'Git: Clone', run: () => repoDialog.show('clone') }),
		commands.register({ id: 'git.commit', title: 'Git: Commit', when: () => scm.repo !== null, run: () => scm.commit() }),
		commands.register({ id: 'git.commitAmend', title: 'Git: Commit (Amend)', when: () => scm.repo !== null, run: () => scm.commit({ amend: true }) }),
		commands.register({
			id: 'git.commitNoVerify',
			title: 'Git: Commit (No Verify)',
			when: () => scm.repo !== null && get<boolean>('git.allowNoVerifyCommit'),
			run: () => scm.commit({ noVerify: true })
		}),
		commands.register({ id: 'git.commitEmpty', title: 'Git: Commit Empty', when: () => scm.repo !== null, run: () => scm.commit({ empty: true }) }),
		commands.register({
			id: 'git.stageAll',
			title: 'Git: Stage All Changes',
			when: () => scm.groups.changes.length + scm.groups.untracked.length > 0,
			run: () => scm.stage([...scm.groups.changes, ...scm.groups.untracked].map((r) => r.entry.path))
		}),
		commands.register({
			id: 'git.unstageAll',
			title: 'Git: Unstage All Changes',
			when: () => scm.groups.staged.length > 0,
			run: () => scm.unstage(scm.groups.staged.map((r) => r.entry.path))
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
	const repo = () => scm.repo !== null;
	const onBranch = () => !!scm.repo?.branch;
	const tracked = () => !!scm.repo?.upstream && !scm.repo.upstream_gone;
	const hasRemote = () => (scm.repo?.remotes.length ?? 0) > 0;
	return [
		{ id: 'git.fetch', title: 'Git: Fetch', when: hasRemote, run: () => scm.fetch() },
		{ id: 'git.pull', title: 'Git: Pull', when: tracked, run: () => scm.pull() },
		{ id: 'git.pullRebase', title: 'Git: Pull (Rebase)', when: tracked, run: () => scm.pull({ rebase: true }) },
		{ id: 'git.push', title: 'Git: Push', when: onBranch, run: () => scm.push() },
		{ id: 'git.pushForce', title: 'Git: Push (Force)', when: () => tracked() && get<boolean>('git.allowForcePush'), run: () => scm.push({ force: true }) },
		{ id: 'git.sync', title: 'Git: Sync', when: tracked, run: () => scm.sync() },
		{ id: 'git.publish', title: 'Git: Publish Branch...', when: () => onBranch() && !tracked() && hasRemote(), run: () => scm.publish() },
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
