// A worktree of an SSH project opened as the folder you work in (Orca opens a remote repository's
// worktree like a local one, its files and git served by its remote server). Kingu shows it in its
// own window-sized view (SshRemoteFolder.svelte): the file tree, an editor that saves over ssh, Source
// Control (stage, unstage, commit, push, diff) and Create Pull Request, with terminals and the agent
// CLI in the floating workspace. Every read and write is one ssh call (Rust ssh_remote.rs); nothing
// is copied to this computer. The last opened one comes back on the next start when no local folder
// is open (Kingu's choice, **estimated**).

import { invoke } from '@tauri-apps/api/core';
import { t } from '#lib/i18n/index.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { status as statusBar } from '#lib/workbench/status.svelte.ts';
import { trustedDomains } from '#lib/workbench/trustedDomains.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { projectName } from './projects';
import { baseChoices, type ChangeRow, type RemoteHits, type RemotePoll, type RemoteBranches, type RemoteDiff, type RemoteFile, type RemoteListing, type RemoteStatus } from './sshRemote';
import type { RemoteProject } from './sshProjects';
import { sshConnections } from './sshConnections.svelte';

type Dir = { listing: RemoteListing | null; loading: boolean; error: string | null };
type OpenFile = { rel: string; text: string; saved: string; loading: boolean; error: string | null; note: string | null; saving: boolean };
type Busy = 'stage' | 'unstage' | 'commit' | 'push' | 'pr' | 'discard' | 'fetch' | 'pull';
type ShownDiff = { rel: string; staged: boolean; data: RemoteDiff | null; error: string | null };

const LAST = 'kingu.ssh.openWorkspace';
/** Auto-refresh: one cheap ssh call (status + the open file's cksum) this often while the window shows (**estimated**). */
const POLL_MS = 5000;

function remember(v: { host: string; root: string; path: string } | null) {
	try {
		if (v) localStorage.setItem(LAST, JSON.stringify(v));
		else localStorage.removeItem(LAST);
	} catch {
		// A convenience only.
	}
}

class SshWorkspace {
	current = $state<{ project: RemoteProject; path: string } | null>(null);
	dirs = $state<Record<string, Dir>>({});
	expanded = $state<Record<string, boolean>>({});
	file = $state<OpenFile | null>(null);
	diff = $state<ShownDiff | null>(null);
	git = $state<RemoteStatus | null>(null);
	gitError = $state<string | null>(null);
	gitLoading = $state(false);
	message = $state('');
	busy = $state<Busy | null>(null);
	/** A line to reveal once the open file shows (a search hit). */
	reveal = $state<{ rel: string; line: number } | null>(null);
	#timer: ReturnType<typeof setInterval> | undefined;
	#polling = false;
	#lastStatus = '';
	#lastSum: string | null = null;

	get dirty(): boolean {
		return !!this.file && !this.file.loading && this.file.text !== this.file.saved;
	}

	#args() {
		const c = this.current;
		if (!c) throw new Error('no SSH worktree open');
		return { host: c.project.host, root: c.project.path, path: c.path };
	}

	/** The title: `app · host:path` (the worktree's own folder name for a task worktree). */
	label(hostLabel: string): string {
		const c = this.current;
		if (!c) return '';
		const leaf = c.path === c.project.path ? projectName(c.project.path) : `${projectName(c.project.path)} / ${c.path.split('/').pop()}`;
		return `${leaf} · ${hostLabel}`;
	}

	async open(project: RemoteProject, path = project.path) {
		if (this.dirty && !(await this.#discardOk())) return;
		this.current = { project, path };
		this.dirs = {};
		this.expanded = { '': true };
		this.file = null;
		this.diff = null;
		this.git = null;
		this.message = '';
		remember({ host: project.host, root: project.path, path });
		this.#lastStatus = '';
		this.#lastSum = null;
		void this.list('');
		void this.refreshGit();
		clearInterval(this.#timer);
		this.#timer = setInterval(() => void this.#poll(), POLL_MS);
	}

	/**
	 * Auto-refresh without a watcher on the host: every 5 s (while the window shows and nothing is
	 * busy) one ssh call over the shared connection returns git status and the open file's
	 * checksum. A different status re-reads git and the open folders; a different checksum
	 * re-reads a file with no unsaved edits (an agent changed it). Orca's server watches files.
	 */
	async #poll() {
		if (!this.current || this.#polling || this.busy || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
		// Only a connected host is polled: one that dropped is being redialled (sshConnections), one
		// the user disconnected stays so, and one nobody dialled yet is dialled first.
		const host = this.current.project.host;
		const conn = sshConnections.state(host).status;
		if (conn !== 'connected') {
			if (conn === 'disconnected') void sshConnections.connect(host, false);
			return;
		}
		this.#polling = true;
		const at = this.current;
		const rel = this.file && !this.file.loading && !this.file.note ? this.file.rel : null;
		try {
			const r = await invoke<RemotePoll>('ssh_remote_poll', { ...this.#args(), rel });
			if (this.current !== at) return;
			const key = JSON.stringify(r.status);
			if (this.#lastStatus && key !== this.#lastStatus) {
				this.git = r.status;
				for (const d of Object.keys(this.dirs)) if (this.expanded[d]) void this.list(d);
			}
			this.#lastStatus = key;
			if (rel && this.file?.rel === rel) {
				if (this.#lastSum !== null && r.sum !== this.#lastSum && !this.dirty) void this.#reload(rel);
				this.#lastSum = r.sum;
			} else this.#lastSum = null;
		} catch {
			// Unreachable for now; the next round tries again, and the connection is checked.
			void sshConnections.suspect(host);
		} finally {
			this.#polling = false;
		}
	}

	async #reload(rel: string) {
		try {
			const r = await invoke<RemoteFile>('ssh_remote_read', { ...this.#args(), rel });
			if (this.file?.rel === rel && !this.dirty && r.text !== null) this.file = { ...this.file, text: r.text, saved: r.text };
		} catch {
			// Shown as it was.
		}
	}

	async close() {
		if (this.dirty && !(await this.#discardOk())) return;
		this.current = null;
		this.file = null;
		this.diff = null;
		clearInterval(this.#timer);
		this.#timer = undefined;
		remember(null);
	}

	/** On start: the last open one, when no local folder is open and its project still exists. */
	restore(list: readonly RemoteProject[]) {
		if (workspace.root || this.current) return;
		let last: { host: string; root: string; path: string } | null = null;
		try {
			last = JSON.parse(localStorage.getItem(LAST) ?? 'null');
		} catch {
			last = null;
		}
		const p = last && list.find((x) => x.host === last!.host && x.path === last!.root);
		if (p && last) void this.open(p, last.path);
	}

	async #discardOk(): Promise<boolean> {
		const ok = await quick.choose({ placeholder: t('sshRemote.discardAsk', { file: this.file?.rel ?? '' }), items: [{ id: 'discard', label: t('sshRemote.discard') }] });
		return !!ok;
	}

	async list(rel: string) {
		this.dirs[rel] = { listing: this.dirs[rel]?.listing ?? null, loading: true, error: null };
		try {
			const listing = await invoke<RemoteListing>('ssh_remote_dir', { ...this.#args(), rel });
			this.dirs[rel] = { listing, loading: false, error: null };
		} catch (e) {
			this.dirs[rel] = { listing: this.dirs[rel]?.listing ?? null, loading: false, error: String(e) };
		}
	}

	toggle(rel: string) {
		this.expanded[rel] = !this.expanded[rel];
		if (this.expanded[rel] && !this.dirs[rel]) void this.list(rel);
	}

	async openFile(rel: string) {
		if (this.file?.rel === rel && !this.diff && !this.file.error) return;
		if (this.dirty && !(await this.#discardOk())) return;
		this.diff = null;
		this.file = { rel, text: '', saved: '', loading: true, error: null, note: null, saving: false };
		try {
			const r = await invoke<RemoteFile>('ssh_remote_read', { ...this.#args(), rel });
			if (this.file?.rel !== rel) return;
			const note = r.too_large ? t('sshRemote.tooLarge') : r.binary ? t('sshRemote.binary') : null;
			this.file = { rel, text: r.text ?? '', saved: r.text ?? '', loading: false, error: null, note, saving: false };
		} catch (e) {
			if (this.file?.rel === rel) this.file = { ...this.file, loading: false, error: String(e) };
		}
	}

	/** Saves the open file on the host (only text that opened as text). */
	async save() {
		const f = this.file;
		if (!f || f.loading || f.note || f.saving) return;
		const text = f.text;
		this.file = { ...f, saving: true };
		try {
			await invoke('ssh_remote_write', { ...this.#args(), rel: f.rel, text });
			if (this.file?.rel === f.rel) this.file = { ...this.file, saved: text, saving: false };
			statusBar.flash(t('sshRemote.saved', { file: f.rel }), 3000);
			void this.refreshGit();
		} catch (e) {
			if (this.file?.rel === f.rel) this.file = { ...this.file, saving: false };
			notifications.error(t('sshRemote.saveFailed', { file: f.rel, error: String(e) }));
		}
	}

	async refreshGit() {
		if (!this.current) return;
		this.gitLoading = true;
		try {
			this.git = await invoke<RemoteStatus>('ssh_remote_status', this.#args());
			this.gitError = null;
		} catch (e) {
			this.gitError = String(e);
		} finally {
			this.gitLoading = false;
		}
	}

	async showDiff(row: ChangeRow) {
		if (this.dirty && !(await this.#discardOk())) return;
		this.file = null;
		this.diff = { rel: row.path, staged: row.staged, data: null, error: null };
		try {
			const data = await invoke<RemoteDiff>('ssh_remote_diff', { ...this.#args(), rel: row.path, staged: row.staged });
			if (this.diff?.rel === row.path && this.diff.staged === row.staged) this.diff = { ...this.diff, data };
		} catch (e) {
			if (this.diff?.rel === row.path) this.diff = { ...this.diff, error: String(e) };
		}
	}

	async #git<T>(label: Busy, run: () => Promise<T>): Promise<T | undefined> {
		if (this.busy) return;
		this.busy = label;
		try {
			return await run();
		} catch (e) {
			notifications.error(t('sshRemote.gitFailed', { error: String(e) }));
		} finally {
			this.busy = null;
			void this.refreshGit();
		}
	}

	/** Stage or unstage rows (a renamed file takes its old path along). */
	stage(rows: readonly ChangeRow[], stage: boolean) {
		const paths = [...new Set(rows.flatMap((r) => (r.orig ? [r.path, r.orig] : [r.path])))];
		if (!paths.length) return;
		return this.#git(stage ? 'stage' : 'unstage', () => invoke('ssh_remote_stage', { ...this.#args(), paths, stage }));
	}

	async commit() {
		const message = this.message.trim();
		if (!message) return void statusBar.flash(t('sshRemote.needMessage'), 4000);
		const id = await this.#git('commit', () => invoke<string>('ssh_remote_commit', { ...this.#args(), message }));
		if (id) {
			this.message = '';
			statusBar.flash(t('sshRemote.committed', { id }), 5000);
		}
	}

	async push() {
		const ok = await this.#git('push', () => invoke('ssh_remote_push', this.#args()).then(() => true));
		if (ok) statusBar.flash(t('sshRemote.pushed'), 4000);
	}

	/** Discard changes (Orca `discardChanges`): asks first; an untracked file is deleted. */
	async discard(rows: readonly ChangeRow[]) {
		const paths = [...new Set(rows.map((r) => r.path))];
		if (!paths.length) return;
		const ok = await quick.choose({
			placeholder: paths.length === 1 ? t('sshRemote.discardOneAsk', { file: paths[0]! }) : t('sshRemote.discardManyAsk', { count: paths.length }),
			items: [{ id: 'yes', label: t('sshRemote.discardYes') }]
		});
		if (!ok) return;
		await this.#git('discard', () => invoke('ssh_remote_discard', { ...this.#args(), paths }));
		if (this.file && paths.includes(this.file.rel) && !this.dirty) void this.#reload(this.file.rel);
		if (this.diff && paths.includes(this.diff.rel)) this.diff = null;
	}

	/** Fetch (Orca `fetchRemote`) or Pull (Orca `pullBranch`) on the host. */
	async sync(pull: boolean) {
		const ok = await this.#git(pull ? 'pull' : 'fetch', () => invoke('ssh_remote_sync', { ...this.#args(), pull }).then(() => true));
		if (ok) statusBar.flash(t(pull ? 'sshRemote.pulled' : 'sshRemote.fetched'), 4000);
		if (ok && pull && this.file && !this.dirty) void this.#reload(this.file.rel);
	}

	/** Go to File: every file git sees on the host (tracked and untracked, not ignored). */
	async quickOpen() {
		if (!this.current) return;
		statusBar.flash(t('sshRemote.loadingFiles'), 15000);
		const files = await invoke<string[]>('ssh_remote_files', this.#args()).catch((e) => (notifications.error(t('sshRemote.gitFailed', { error: String(e) })), null));
		statusBar.flash('');
		if (!files) return;
		const pick = await quick.choose({ placeholder: t('sshRemote.goToFile'), items: files.map((f) => ({ id: f, label: f.split('/').pop() ?? f, description: f, icon: f })) });
		if (pick) await this.openFile(pick.id);
	}

	/** Search: fixed text in the worktree's files on the host (`git grep`), hits listed to open. */
	async search() {
		if (!this.current) return;
		const query = await quick.input({ placeholder: t('sshRemote.searchPlaceholder'), hint: (v) => (v ? t('sshRemote.searchHint', { query: v }) : t('sshRemote.searchPlaceholder')) });
		if (!query) return;
		statusBar.flash(t('sshRemote.searching', { query }), 15000);
		const r = await invoke<RemoteHits>('ssh_remote_grep', { ...this.#args(), query, caseSensitive: false }).catch((e) => (notifications.error(t('sshRemote.gitFailed', { error: String(e) })), null));
		statusBar.flash('');
		if (!r) return;
		if (!r.hits.length) return void statusBar.flash(t('sshRemote.noHits', { query }), 4000);
		const pick = await quick.choose({
			placeholder: r.truncated ? t('sshRemote.hitsTruncated', { count: r.hits.length }) : t('sshRemote.hits', { count: r.hits.length }),
			items: r.hits.map((h, i) => ({ id: String(i), label: h.text.trim() || '…', description: `${h.path}:${h.line}`, icon: h.path }))
		});
		const hit = pick && r.hits[Number(pick.id)];
		if (!hit) return;
		this.reveal = { rel: hit.path, line: hit.line };
		await this.openFile(hit.path);
	}

	/** Create Pull Request: title, then the base branch; pushes on the host and opens it here. */
	async createPr() {
		const c = this.current;
		if (!c || this.busy) return;
		const branch = this.git?.branch ?? '';
		const title = await quick.input({ placeholder: t('sshRemote.prTitle'), value: branch.split('/').pop()?.replace(/[-_]/g, ' ') ?? '', hint: (v) => (v.trim() ? t('sshRemote.prTitleHint', { title: v.trim() }) : t('sshRemote.prTitle')) });
		if (!title?.trim()) return;
		const branches = await invoke<RemoteBranches>('ssh_remote_branches', { host: c.project.host, root: c.project.path }).catch(() => ({ branches: [], default: null }));
		const bases = baseChoices(branches).filter((b) => b !== branch && b !== `origin/${branch}`);
		const pick = await quick.choose({ placeholder: t('sshRemote.prBase'), items: bases.map((b) => ({ id: b, label: b })) });
		if (!pick) return;
		const url = await this.#git('pr', () => invoke<string>('ssh_remote_pr_create', { ...this.#args(), base: pick.id, title: title.trim(), body: '', draft: false }));
		if (url) {
			statusBar.flash(t('sshRemote.prCreated', { url }), 8000);
			void trustedDomains.openLink(url, { fromWorkspace: false });
		}
	}
}

export const sshWorkspace = new SshWorkspace();
