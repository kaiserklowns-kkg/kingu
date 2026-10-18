// Source Control model (VS Code: ISCMService + the git extension's Repository). Status is
// re-read on view open, after every git operation, after a save and on window focus.

import { invoke } from '@tauri-apps/api/core';
import { ask, message as showMessage } from '@tauri-apps/plugin-dialog';
import { clientLog } from '#lib/client-log.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { terminals } from '#lib/terminal/terminals.svelte.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import {
	OP_LABELS,
	checkoutItems,
	checkoutTarget,
	cleanBranchName,
	deletableBranches,
	isAuthError,
	stashItems,
	terminalCommand,
	type BranchRef,
	type DeleteResult,
	type NetOp,
	type Stash
} from '#lib/workbench/scmRemote.ts';
import { commands } from './commands.svelte';
import { editors } from './editors.svelte';
import { groups, smartCommitPaths, type GitStatus } from './scm';
import { status } from './status.svelte';

class Scm {
	repo = $state<GitStatus | null>(null);
	/** False until the first status read; then whether the workspace is a git repository. */
	loaded = $state(false);
	busy = $state(false);
	message = $state('');
	groups = $derived(groups(this.repo?.entries ?? []));
	/** Activity bar badge: resources across both groups, like VS Code's `scm.countBadge: all`. */
	count = $derived(this.groups.staged.length + this.groups.changes.length);

	#inflight: Promise<void> | null = null;
	#again = false;

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
					this.repo = await invoke<GitStatus | null>('git_status');
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

	/** Runs a git command, reports failure in the status bar, then re-reads status. */
	async #run(cmd: string, args: Record<string, unknown>): Promise<boolean> {
		this.busy = true;
		try {
			await invoke(cmd, args);
			return true;
		} catch (e) {
			status.flash(String(e), 8000);
			clientLog('error', `${cmd}: ${e}`);
			return false;
		} finally {
			this.busy = false;
			await this.refresh();
		}
	}

	stage(paths: string[]) {
		return this.#run('git_stage', { paths });
	}

	/** A staged rename needs its source unstaged too, or the deletion stays staged. */
	unstage(paths: string[]) {
		const all = new Set(paths);
		for (const e of this.repo?.entries ?? []) if (all.has(e.path) && e.orig_path) all.add(e.orig_path);
		return this.#run('git_unstage', { paths: [...all] });
	}

	/** Callers confirm first; `deleteUntracked` is only set after the user agreed to delete. */
	discard(paths: string[], deleteUntracked: boolean) {
		return this.#run('git_discard', { paths, deleteUntracked });
	}

	// ---------------------------------------------------------------------------------------
	// Remotes, branches and stashes. One at a time (Rust enforces it too); the running one shows
	// in the status bar as `op` and can be cancelled from there.

	/** Status bar progress text of the running remote/branch operation. */
	op = $state<string | null>(null);

	get #rebase(): boolean {
		return settings.get<boolean>('git.pullRebase') === true;
	}

	/** Runs `fn` as the one operation, shows its error, then re-reads status (and the branch). */
	async #exclusive<T>(label: string, fn: () => Promise<T>, terminal?: string[]): Promise<T | undefined> {
		if (this.op) {
			status.flash('มีคำสั่ง git อื่นกำลังทำงานอยู่ รอให้เสร็จก่อน');
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
		const open = await ask(text, { title: 'Git', kind: 'warning', okLabel: 'Open in Terminal', cancelLabel: 'ปิด' });
		if (!open) return;
		appMode.setMode('workbench');
		terminals.open({ title: run.slice(0, 2).join(' '), run });
		layout.showPanel('terminal');
	}

	async #net(op: NetOp, cmd: string, args: Record<string, unknown>, done: string, terminal: string[]) {
		const ok = await this.#exclusive(OP_LABELS[op], () => invoke(cmd, args).then(() => true), terminal);
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
		return this.#net('fetch', 'git_fetch', {}, 'fetch แล้ว', terminalCommand('fetch'));
	}

	pull() {
		const rebase = this.#rebase;
		return this.#net('pull', 'git_pull', { rebase }, 'pull แล้ว', terminalCommand('pull', { rebase }));
	}

	/** Push; a branch without an upstream is published instead (VS Code offers the same). */
	push() {
		if (this.#unpublished()) return this.publish();
		return this.#net('push', 'git_push', {}, 'push แล้ว', terminalCommand('push'));
	}

	async sync() {
		if (this.#unpublished()) return this.publish();
		if (settings.get<boolean>('git.confirmSync')) {
			const target = this.repo?.upstream ?? 'remote';
			const ok = await ask(`จะ pull และ push commit จากและไปยัง '${target}' (This action will pull and push commits from and to '${target}'.)`, {
				title: 'Git: Sync',
				kind: 'info',
				okLabel: 'OK',
				cancelLabel: 'Cancel'
			});
			if (!ok) return false;
		}
		const rebase = this.#rebase;
		return this.#net('sync', 'git_sync', { rebase }, 'sync แล้ว', terminalCommand('sync', { rebase }));
	}

	/** Publish Branch: `push -u <remote> <branch>`, to origin unless another remote is the only one. */
	async publish() {
		const branch = this.repo?.branch;
		const remotes = this.repo?.remotes ?? [];
		if (!branch) {
			status.flash('HEAD ไม่ได้อยู่บน branch สร้าง branch ก่อนแล้วจึง publish');
			return false;
		}
		let remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : undefined;
		if (!remote && remotes.length) {
			remote = (await quick.choose({ placeholder: `เลือก remote ที่จะ publish branch '${branch}' ไป`, items: remotes.map((r) => ({ id: r, label: r })) }))?.id;
			if (!remote) return false;
		}
		if (!remote) {
			await showMessage('repository นี้ยังไม่มี remote ให้เพิ่มด้วย git remote add ก่อน', { title: 'Git', kind: 'info' });
			return false;
		}
		return this.#net('publish', 'git_push', { remote }, `publish ${branch} ไปที่ ${remote} แล้ว`, terminalCommand('publish', { remote, branch }));
	}

	async #refs(): Promise<BranchRef[] | null> {
		try {
			return await invoke<BranchRef[]>('git_refs');
		} catch (e) {
			status.flash(String(e), 8000);
			return null;
		}
	}

	/** Checkout to…: local and remote branches, plus Create new branch (from…). */
	async checkout() {
		const refs = await this.#refs();
		if (!refs) return;
		const item = await quick.choose({ placeholder: 'เลือก branch ที่จะ checkout (Select a branch to checkout)', items: checkoutItems(refs) });
		const target = item && checkoutTarget(item.id, refs);
		if (!target) return;
		if (target.kind === 'create') return this.createBranch();
		if (target.kind === 'createFrom') return this.createBranchFrom(refs);
		if (target.kind === 'worktree') {
			const text = `branch ${target.ref.name} ถูก check out อยู่ใน worktree อื่น (${target.ref.worktree}) git ไม่ยอมให้ branch เดียวกันถูก check out สองที่ เปิดงานนั้นใน Agents แทน`;
			await showMessage(text, { title: 'Git', kind: 'info' });
			return;
		}
		const { name, remote } = target.ref;
		const local = await this.#exclusive('กำลัง checkout...', () => invoke<string>('git_checkout', { name, remote }));
		if (local) status.flash(`checkout ${local} แล้ว`);
	}

	/** Create Branch: asks for a name, creates it from `from` (default HEAD) and checks it out. */
	async createBranch(from?: string) {
		const typed = await quick.input({
			placeholder: from ? `ชื่อ branch ใหม่จาก ${from} (Branch name)` : 'ชื่อ branch ใหม่ (Branch name)',
			hint: (v) => (v ? `สร้าง branch '${cleanBranchName(v)}' แล้ว checkout` : 'พิมพ์ชื่อ branch แล้วกด Enter')
		});
		const name = cleanBranchName(typed ?? '');
		if (!name) return;
		const ok = await this.#exclusive('กำลังสร้าง branch...', () => invoke('git_create_branch', { name, from: from ?? null }).then(() => true));
		if (ok) status.flash(`สร้างและ checkout ${name} แล้ว`);
	}

	async createBranchFrom(refs?: BranchRef[]) {
		const all = refs ?? (await this.#refs());
		if (!all) return;
		const items = all.map((r) => ({ id: r.name, label: r.name, description: `${r.commit} ${r.subject}`.trim() }));
		const from = await quick.choose({ placeholder: 'เลือก ref ที่จะสร้าง branch ใหม่จาก (Select a ref to create the branch from)', items });
		if (from) await this.createBranch(from.id);
	}

	/** Delete Branch: `-d`, then `-D` only after the user agrees to lose unmerged commits. */
	async deleteBranch() {
		const refs = await this.#refs();
		if (!refs) return;
		const items = deletableBranches(refs);
		if (!items.length) {
			status.flash('ไม่มี branch ที่ลบได้ (branch ปัจจุบันและ branch ของ worktree ลบไม่ได้)');
			return;
		}
		const pick = await quick.choose({ placeholder: 'เลือก branch ที่จะลบ (Select a branch to delete)', items });
		if (!pick) return;
		const name = pick.id;
		const result = await this.#exclusive('กำลังลบ branch...', () => invoke<DeleteResult>('git_delete_branch', { name, force: false }));
		if (result === 'deleted') status.flash(`ลบ branch ${name} แล้ว`);
		if (result !== 'not_merged') return;
		const force = await ask(`branch ${name} ยังไม่ได้ merge ลบทิ้งเลยไหม? commit ที่มีเฉพาะใน branch นี้จะหายไป`, {
			title: 'Delete Branch',
			kind: 'warning',
			okLabel: 'Delete Branch',
			cancelLabel: 'Cancel'
		});
		if (!force) return;
		const forced = await this.#exclusive('กำลังลบ branch...', () => invoke<DeleteResult>('git_delete_branch', { name, force: true }));
		if (forced === 'deleted') status.flash(`ลบ branch ${name} แล้ว`);
	}

	/** Stash (VS Code's git.stash / git.stashIncludeUntracked), with an optional message. */
	async stash({ includeUntracked = false } = {}) {
		const message = await quick.input({
			placeholder: 'ข้อความ stash (ไม่ใส่ก็ได้) — Stash message',
			hint: (v) => (v ? `stash ด้วยข้อความ '${v}'` : 'กด Enter เพื่อ stash โดยไม่ใส่ข้อความ')
		});
		if (message === undefined) return;
		const ok = await this.#exclusive('กำลัง stash...', () => invoke('git_stash_push', { message: message || null, includeUntracked }).then(() => true));
		if (ok) status.flash('stash แล้ว');
	}

	async #pickStash(placeholder: string): Promise<Stash | undefined> {
		let list: Stash[];
		try {
			list = await invoke<Stash[]>('git_stash_list');
		} catch (e) {
			status.flash(String(e), 8000);
			return undefined;
		}
		if (!list.length) {
			status.flash('ไม่มี stash');
			return undefined;
		}
		const pick = await quick.choose({ placeholder, items: stashItems(list) });
		return pick && list.find((s) => String(s.index) === pick.id);
	}

	async stashApply({ pop = false } = {}) {
		const s = await this.#pickStash(pop ? 'เลือก stash ที่จะ pop (Pick a stash to pop)' : 'เลือก stash ที่จะ apply (Pick a stash to apply)');
		if (!s) return;
		const ok = await this.#exclusive('กำลังนำ stash กลับมา...', () => invoke('git_stash_apply', { index: s.index, pop }).then(() => true));
		if (ok) status.flash(pop ? 'pop stash แล้ว' : 'apply stash แล้ว');
	}

	async stashDrop() {
		const s = await this.#pickStash('เลือก stash ที่จะลบ (Pick a stash to drop)');
		if (!s) return;
		const sure = await ask(`ลบ stash@{${s.index}}: ${s.message}? กู้คืนไม่ได้`, { title: 'Drop Stash', kind: 'warning', okLabel: 'Drop', cancelLabel: 'Cancel' });
		if (!sure) return;
		const ok = await this.#exclusive('กำลังลบ stash...', () => invoke('git_stash_drop', { index: s.index }).then(() => true));
		if (ok) status.flash('ลบ stash แล้ว');
	}

	async commit({ amend = false } = {}) {
		const message = this.message.trim();
		if (!message) {
			status.flash('ใส่ข้อความ commit ก่อน');
			return;
		}
		if (!amend && !this.groups.staged.length) {
			// git.enableSmartCommit: nothing staged commits the changes (all, or tracked only).
			const smart = settings.get<boolean>('git.enableSmartCommit') ? smartCommitPaths(this.groups.changes, settings.get('git.smartCommitChanges')) : [];
			if (!smart.length) {
				status.flash(this.groups.changes.length ? 'ยังไม่มีไฟล์ที่ stage: กด + ที่ไฟล์ก่อน commit' : 'ไม่มีการเปลี่ยนแปลงให้ commit');
				return;
			}
			if (!(await this.stage(smart))) return;
		}
		if (await this.#run('git_commit', { message, amend })) {
			this.message = '';
			status.flash(amend ? 'แก้ commit ล่าสุดแล้ว' : 'commit แล้ว');
			// git.postCommitCommand
			const after = settings.get<string>('git.postCommitCommand');
			if (after === 'push') await this.push();
			else if (after === 'sync') await this.sync();
		}
	}

	/** git.autofetch: a quiet fetch; failures (offline, no credentials) only go to the log, like VS Code. */
	async autoFetch() {
		if (this.op || !this.repo?.remotes.length) return;
		this.op = OP_LABELS.fetch;
		try {
			await invoke('git_fetch');
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
	const onFocus = () => void scm.refresh();
	window.addEventListener('focus', onFocus);

	// A save turns a dirty tab clean; re-read status then (a fall in the dirty count).
	let dirty = 0;
	const stopEffect = $effect.root(() => {
		$effect(() => {
			const now = editors.dirtyCount();
			if (now < dirty) void scm.refresh();
			dirty = now;
		});
		// git.autofetch every git.autofetchPeriod seconds while a repository with a remote is open.
		$effect(() => {
			if (!settings.get<boolean>('git.autofetch') || !scm.repo?.remotes.length) return;
			const timer = setInterval(() => void scm.autoFetch(), settings.get<number>('git.autofetchPeriod') * 1000);
			return () => clearInterval(timer);
		});
	});

	const unregister = [
		commands.register({ id: 'git.refresh', title: 'Git: Refresh', run: () => scm.refresh() }),
		commands.register({ id: 'git.commit', title: 'Git: Commit', when: () => scm.repo !== null, run: () => scm.commit() }),
		commands.register({ id: 'git.commitAmend', title: 'Git: Commit (Amend)', when: () => scm.repo !== null, run: () => scm.commit({ amend: true }) }),
		commands.register({
			id: 'git.stageAll',
			title: 'Git: Stage All Changes',
			when: () => scm.groups.changes.length > 0,
			run: () => scm.stage(scm.groups.changes.map((r) => r.entry.path))
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
		{ id: 'git.push', title: 'Git: Push', when: onBranch, run: () => scm.push() },
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
