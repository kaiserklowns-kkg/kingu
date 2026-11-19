// Projects on SSH hosts (Orca's "Open project on SSH host"): a git repository on a saved SSH host
// joins the side bar under its own heading. Its worktrees (with branch and git status) are read
// over ssh, a task makes a worktree there, and its terminals and agent CLI run there over
// `ssh -t`. Rust's ssh_projects.rs keeps the record in projects.json (with `host` set) and runs
// every git command on the host; nothing of the project is copied to this computer.
import { invoke } from '@tauri-apps/api/core';
import { t } from '#lib/i18n/index.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { floating } from '#lib/workbench/floating.svelte.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { cliName } from './agentCli';
import { adeCommand } from '#lib/agent/launchSpec.ts';
import { projectName } from './projects';
import { sshHosts } from './sshHosts.svelte';
import type { SshTarget } from './sshHosts';
import { hostPath, remoteKey, remoteSlug, remoteWorktreePath, sortWorktrees, type RemoteProject, type RemoteWorktree } from './sshProjects';
import { baseChoices, parseFolders, remoteAgentHooks, remoteAgentStatus, remoteAgentTitle, worktreeKey, type RemoteAgent, type RemoteBranches, type SparsePreset } from './sshRemote';
import { sshWorkspace } from './sshWorkspace.svelte';
import { agentNotifyAllowed, notify } from './agentNotify.svelte';
import { noticeFor, noticeState, type NoticeState } from './agentNotify';
import type { TaskStatus } from './model';

type Listing = { rows: RemoteWorktree[] | null; loading: boolean; error: string | null };
/** An agent CLI started in a floating terminal tab, with the worktree it runs in. */
type AgentTab = RemoteAgent & { host: string; root: string; path: string; name: string };

/** How often agent states are judged again while one runs (output timing moves without events). */
const TICK_MS = 1000;
/** Output of the same tab is recorded at most this often. */
const OUTPUT_THROTTLE_MS = 500;
/** How often a claude's hook file on the host is read (one ssh call, shared connection; **estimated**). */
const HOOK_POLL_MS = 2000;

/** Kingu's default branch prefix setting (agent/worktree.rs reads the same one for local tasks). */
const prefix = () => settings.get<string>('kingu.worktree.branchPrefix') || undefined;

class SshProjects {
	list = $state<RemoteProject[]>([]);
	listings = $state<Record<string, Listing>>({});
	collapsed = $state<Record<string, boolean>>({});
	/** Agent CLIs running in SSH terminals, by floating tab id. */
	agents = $state<Record<string, AgentTab>>({});
	now = $state(Date.now());
	#seen = new Map<string, NoticeState>();
	#timer: ReturnType<typeof setInterval> | undefined;

	async load() {
		this.list = (await invoke<RemoteProject[]>('ssh_projects_list').catch(() => [])) ?? [];
		if (!sshHosts.targets.length && this.list.length) await sshHosts.refresh();
	}

	host(p: RemoteProject): SshTarget | undefined {
		return sshHosts.targets.find((x) => x.id === p.host);
	}

	/** Open Project on SSH Host…: pick the host, then type the path (Orca's "Host path"). */
	async addInteractive() {
		await sshHosts.refresh();
		if (!sshHosts.targets.length) return void status.flash(t('adeProjects.sshNoHosts'), 6000);
		const pick =
			sshHosts.targets.length === 1
				? { id: sshHosts.targets[0]!.id }
				: await quick.choose({
						placeholder: t('adeProjects.sshPickHost'),
						items: sshHosts.targets.map((h) => ({ id: h.id, label: h.label, description: `${h.username ? `${h.username}@` : ''}${h.host}` }))
					});
		const target = pick && sshHosts.targets.find((h) => h.id === pick.id);
		if (!target) return;
		const text = await quick.input({
			placeholder: t('adeProjects.sshPathPlaceholder', { host: target.label }),
			value: '~/',
			hint: (v) => (hostPath(v) ? t('adeProjects.sshPathAdd', { path: v.trim(), host: target.label }) : t('adeProjects.sshPathHint'))
		});
		const path = text ? hostPath(text) : null;
		if (path) await this.add(target, path);
	}

	/** Adds `path` of `target` (Rust resolves it to the repository on the host). */
	async add(target: SshTarget, path: string): Promise<boolean> {
		status.flash(t('adeProjects.sshAdding', { path, host: target.label }), 15000);
		try {
			const r = await invoke<{ project: RemoteProject; existed: boolean }>('ssh_project_add', { host: target.id, path });
			const name = `${projectName(r.project.path)} · ${target.label}`;
			status.flash(t(r.existed ? 'adeProjects.already' : 'adeProjects.added', { name }));
			await this.load();
			void this.refresh(r.project);
			return true;
		} catch (e) {
			status.flash('');
			notifications.error(t('adeProjects.sshFailed', { error: String(e) }));
			return false;
		}
	}

	async remove(p: RemoteProject) {
		try {
			await invoke('ssh_project_remove', { host: p.host, path: p.path });
			delete this.listings[remoteKey(p)];
			await this.load();
			status.flash(t('adeProjects.removed', { name: projectName(p.path) }));
		} catch (e) {
			notifications.error(t('adeProjects.removeFailed', { error: String(e) }));
		}
	}

	/** The project's worktrees with branch and status, read on the host. */
	async refresh(p: RemoteProject) {
		const key = remoteKey(p);
		const prev = this.listings[key];
		this.listings[key] = { rows: prev?.rows ?? null, loading: true, error: null };
		try {
			const rows = await invoke<RemoteWorktree[]>('ssh_project_worktrees', { host: p.host, root: p.path });
			this.listings[key] = { rows: sortWorktrees(rows, p.path), loading: false, error: null };
		} catch (e) {
			this.listings[key] = { rows: prev?.rows ?? null, loading: false, error: String(e) };
		}
	}

	toggle(p: RemoteProject) {
		const key = remoteKey(p);
		this.collapsed[key] = !this.collapsed[key];
		if (!this.collapsed[key] && !this.listings[key]) void this.refresh(p);
	}

	/** New Task on the host: a name, a base branch and a sparse checkout preset → `git worktree add` of `<root>/.kingu/worktrees/<slug>`. */
	async newTask(p: RemoteProject) {
		const label = this.host(p)?.label ?? p.host;
		const pre = prefix() ?? 'kingu/';
		const title = await quick.input({
			placeholder: t('adeProjects.sshTaskPlaceholder'),
			hint: (v) => {
				const slug = remoteSlug(v || 'task');
				return t('adeProjects.sshTaskHint', { path: remoteWorktreePath(p.path, slug), branch: `${pre}${slug}` });
			}
		});
		if (!title) return;
		const slug = remoteSlug(title);
		const base = await this.#pickBase(p);
		if (base === undefined) return;
		const sparse = await this.#pickSparse(p);
		if (sparse === undefined) return;
		status.flash(t('adeProjects.sshCreating', { slug, host: label }), 120000);
		try {
			const path = await invoke<string>('ssh_project_worktree_add', { host: p.host, root: p.path, slug, base, prefix: prefix() ?? null, sparse: sparse.length ? sparse : null });
			status.flash(t('adeProjects.sshCreated', { slug, host: label }), 5000);
			await this.refresh(p);
			await this.terminal(p, path, true);
		} catch (e) {
			status.flash('');
			notifications.error(t('adeProjects.sshFailed', { error: String(e) }));
		}
	}

	/** The base branch (origin's default first; "current HEAD" keeps the old behaviour); undefined: cancelled. */
	async #pickBase(p: RemoteProject): Promise<string | null | undefined> {
		status.flash(t('sshRemote.readingBranches'), 15000);
		const b = await invoke<RemoteBranches>('ssh_remote_branches', { host: p.host, root: p.path }).catch(() => ({ branches: [], default: null }) as RemoteBranches);
		status.flash('');
		const items = [{ id: '', label: t('sshRemote.baseHead'), description: 'HEAD' }, ...baseChoices(b).map((x) => ({ id: x, label: x, description: x === b.default ? t('sshRemote.baseDefault') : undefined }))];
		const pick = await quick.choose({ placeholder: t('sshRemote.pickBase'), items, activeId: b.default ?? '' });
		return pick ? pick.id || null : undefined;
	}

	/** A sparse checkout preset of the project (kept on the host), typed folders, or the whole tree; undefined: cancelled. */
	async #pickSparse(p: RemoteProject): Promise<string[] | undefined> {
		const presets = await invoke<SparsePreset[]>('ssh_remote_presets', { host: p.host, root: p.path }).catch(() => [] as SparsePreset[]);
		const items = [
			{ id: '', label: t('sshRemote.sparseNone') },
			...presets.map((x) => ({ id: x.id, label: x.name, description: x.directories.join(', ') })),
			{ id: '\u0000custom', label: t('sshRemote.sparseCustom') }
		];
		const pick = await quick.choose({ placeholder: t('sshRemote.pickSparse'), items });
		if (!pick) return undefined;
		if (!pick.id) return [];
		if (pick.id === '\u0000custom') {
			const text = await quick.input({ placeholder: t('sshRemote.sparseFolders'), hint: (v) => (parseFolders(v).length ? t('sshRemote.sparseOnly', { folders: parseFolders(v).join(', ') }) : t('sshRemote.sparseFolders')) });
			const folders = text ? parseFolders(text) : [];
			return folders.length ? folders : undefined;
		}
		return presets.find((x) => x.id === pick.id)?.directories ?? [];
	}

	/**
	 * A terminal in `path` on the host, as a tab of the floating workspace (it needs no local folder
	 * open); `agent`: running the agent CLI (kingu.agent.cli), whose status the tab's title and
	 * output give (sshRemote.ts) and whose changes notify like a local task's.
	 */
	async terminal(p: RemoteProject, path: string, agent = false) {
		let argv: string[] | null = null;
		if (agent) {
			argv = adeCommand(null, (k) => settings.get(k));
			if (!argv) return void notifications.error(t('adeProjects.sshAgentBad'));
		}
		try {
			const { run, hook } = await invoke<{ run: string[]; hook: string | null }>('ssh_project_terminal', { host: p.host, root: p.path, path, agent: argv });
			const leaf = path === p.path ? projectName(p.path) : (path.split('/').pop() ?? path);
			const label = this.host(p)?.label ?? p.host;
			const title = `${argv ? cliName(argv) : 'ssh'} ${label}:${leaf}`;
			if (!argv) return void floating.newTerminal({ title, run });
			let id = '';
			id = floating.newTerminal({
				title,
				run,
				watch: {
					title: (x) => this.agents[id] && (this.agents[id] = remoteAgentTitle(this.agents[id]!, x, Date.now()) as AgentTab),
					output: () => {
						const a = this.agents[id];
						const now = Date.now();
						if (a && now - (a.lastOutput ?? 0) > OUTPUT_THROTTLE_MS) this.agents[id] = { ...a, lastOutput: now };
					},
					closed: () => {
						const a = this.agents[id];
						if (a?.hookToken) void invoke('ssh_remote_hook_clear', { host: a.host, root: a.root, token: a.hookToken }).catch(() => {});
						delete this.agents[id];
						this.#seen.delete(id);
					}
				}
			});
			this.agents[id] = { host: p.host, root: p.path, path, name: `${leaf} · ${label}`, startedAt: Date.now(), ...(hook ? { hookToken: hook, hookOffset: 0 } : {}) };
			this.#tick();
		} catch (e) {
			notifications.error(t('adeProjects.sshFailed', { error: String(e) }));
		}
	}

	/** The most urgent status of the agents running in a worktree (needs you > working > done), or null. */
	status(host: string, path: string): TaskStatus | null {
		const rank: Partial<Record<TaskStatus, number>> = { waiting: 0, failed: 0, running: 1, review: 2 };
		let best: TaskStatus | null = null;
		for (const a of Object.values(this.agents)) {
			if (worktreeKey(a.host, a.path) !== worktreeKey(host, path)) continue;
			const s = remoteAgentStatus(a, this.now);
			if (s && (best === null || (rank[s] ?? 3) < (rank[best] ?? 3))) best = s;
		}
		return best;
	}

	/** Judges every agent again and notifies its changes (Orca's notifications, agentNotify.ts rules). */
	#tick() {
		this.now = Date.now();
		const ids = Object.keys(this.agents);
		if (ids.length && !this.#timer) this.#timer = setInterval(() => this.#tick(), TICK_MS);
		if (!ids.length && this.#timer) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
		if (this.now - this.#hooksAt >= HOOK_POLL_MS) {
			this.#hooksAt = this.now;
			for (const id of ids) void this.#readHooks(id);
		}
		const events = settings.get<string>('kingu.agent.notifications.events');
		for (const id of ids) {
			const a = this.agents[id]!;
			const next = noticeState(remoteAgentStatus(a, this.now) ?? 'done', a.hook?.question);
			const notice = agentNotifyAllowed() ? noticeFor(this.#seen.get(id), next, { title: a.name, lastEvent: a.hook?.message }, events) : null;
			this.#seen.set(id, next);
			if (notice) void notify(notice.title, notice.body);
		}
	}

	#hooksAt = 0;
	#reading = new Set<string>();

	/** New hook events of a claude on the host (its file there, read over ssh; one read at a time per agent). */
	async #readHooks(id: string) {
		const a = this.agents[id];
		if (!a?.hookToken || this.#reading.has(id)) return;
		this.#reading.add(id);
		try {
			const r = await invoke<{ events: object[]; offset: number }>('ssh_remote_hook_read', { host: a.host, root: a.root, token: a.hookToken, offset: a.hookOffset ?? 0 });
			const cur = this.agents[id];
			if (cur && (r.events.length || r.offset !== cur.hookOffset)) this.agents[id] = remoteAgentHooks(cur, r.events, r.offset, Date.now()) as AgentTab;
		} catch {
			// The host is unreachable for now: the title still tells.
		} finally {
			this.#reading.delete(id);
		}
	}

	/** Removes a task worktree on the host (its branch stays); one with changes asks first. */
	async removeWorktree(p: RemoteProject, w: RemoteWorktree) {
		if (!w.slug) return;
		const force = (w.changes ?? 0) > 0;
		if (force) {
			const ok = await quick.choose({ placeholder: t('adeProjects.sshRemoveForce', { slug: w.slug }), items: [{ id: 'yes', label: t('adeProjects.sshRemoveForceYes') }] });
			if (!ok) return;
		}
		try {
			await invoke('ssh_project_worktree_remove', { host: p.host, root: p.path, slug: w.slug, force });
			status.flash(t('adeProjects.sshRemoved', { slug: w.slug }), 5000);
		} catch (e) {
			notifications.error(t('adeProjects.sshFailed', { error: String(e) }));
		}
		await this.refresh(p);
	}

	/** SSH: Open Remote Folder…: an added SSH project (or one of its task worktrees) as the folder you work in. */
	/** A worktree of an SSH project as this window's workspace, shown in the IDE (Rust remote_ws.rs). */
	async openWorktree(p: RemoteProject, path: string) {
		if (await workspace.openRemote(p.host, p.path, path)) appMode.setMode('workbench');
	}

	async openFolder(p?: RemoteProject, page = false) {
		if (!p) {
			await this.load();
			if (!this.list.length) return void this.addInteractive();
			const pick = await quick.choose({
				placeholder: t('sshRemote.pickProject'),
				items: this.list.map((x) => ({ id: remoteKey(x), label: projectName(x.path), description: `${this.host(x)?.label ?? x.host}:${x.path}` }))
			});
			p = pick ? this.list.find((x) => remoteKey(x) === pick.id) : undefined;
			if (!p) return;
		}
		await this.refresh(p);
		const rows = this.listings[remoteKey(p)]?.rows ?? [];
		const tasks = rows.filter((w) => w.slug);
		let path = p.path;
		if (tasks.length) {
			const pick = await quick.choose({
				placeholder: t('sshRemote.pickWorktree'),
				items: [{ id: p.path, label: t('adeProjects.sshMain'), description: p.path }, ...tasks.map((w) => ({ id: w.path, label: w.slug!, description: w.branch ?? '' }))]
			});
			if (!pick) return;
			path = pick.id;
		}
		if (page) await sshWorkspace.open(p, path);
		else await this.openWorktree(p, path);
	}

	install(): () => void {
		void this.load().then(() => {
			this.list.forEach((p) => void this.refresh(p));
			sshWorkspace.restore(this.list);
		});
		const offs = [
			commands.register({ id: 'kingu.ssh.addProject', title: 'SSH: Open Project on SSH Host…', category: 'Agents', run: () => void this.addInteractive() }),
			commands.register({ id: 'kingu.ssh.openFolder', title: 'SSH: Open Remote Folder…', category: 'Agents', run: () => void this.openFolder() }),
			commands.register({ id: 'kingu.ssh.openFolderPage', title: 'SSH: Open Remote Folder Page…', category: 'Agents', run: () => void this.openFolder(undefined, true) }),
			commands.register({ id: 'kingu.ssh.terminal', title: 'SSH: New Remote Terminal…', category: 'Agents', run: () => void this.pickTerminal() })
		];
		return () => {
			offs.forEach((off) => off());
			clearInterval(this.#timer);
			this.#timer = undefined;
		};
	}

	/** SSH: New Remote Terminal…: the open remote folder's, else an added project's root (no local folder needed). */
	async pickTerminal() {
		const c = sshWorkspace.current;
		if (c) return this.terminal(c.project, c.path);
		await this.load();
		const pick =
			this.list.length === 1
				? { id: remoteKey(this.list[0]!) }
				: await quick.choose({ placeholder: t('sshRemote.pickProject'), items: this.list.map((x) => ({ id: remoteKey(x), label: projectName(x.path), description: `${this.host(x)?.label ?? x.host}:${x.path}` })) });
		const p = pick && this.list.find((x) => remoteKey(x) === pick.id);
		if (p) await this.terminal(p, p.path);
		else if (!this.list.length) void this.addInteractive();
	}
}

export const sshProjects = new SshProjects();
