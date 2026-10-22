// The added projects (Orca's repos list) and the live state of every one that is not the open
// folder. The open folder keeps its full machinery (adeTasks, cliSessions, paneAgents); the others
// are lighter: their tasks and worktrees are read through Rust with an explicit root (checked
// against projects.json there), and their agents' status comes from the same evidence the open
// folder uses, minus what needs a mounted terminal (title, output timing):
//   - agent-host runs: the `agents` store keeps every folder's runs;
//   - launched CLIs: the folder's saved sessions (localStorage, per root tag) whose PTY is still
//     alive (kingu-ptyd keeps them running), their hook files and their liveness in `pty_list`;
//   - agents typed by hand in any task terminal: the pane's own hook file and its foreground job.
// Status tailing stays here rather than in Rust: the session registry lives in this webview's
// storage and the status rules (agentHooks.ts, agentPresence.ts, cliRuntime.ts) are shared with
// the open folder, so both read the same way. Notifications and the title bar read `all`.
// Opening another project's task switches the folder, then opens the task once it has loaded.

import { untrack } from 'svelte';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { agents } from '#lib/agent/agents.svelte.ts';
import type { WorktreeInfo } from '#lib/agent/events.ts';
import { clientLog } from '#lib/client-log.ts';
import { t } from '#lib/i18n/index.ts';
import { settings } from '#lib/settings/settings.svelte.ts';
import { cliKey, liveCliSessions, parseCliSessions, restore, rootTag, storeName, type CliSessionsState } from '#lib/terminal/sessions.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { applyHook, initialHookState, type HookState } from './agentHooks';
import { checkLiveness, paneRow, type Liveness, type PtyListing } from './agentPresence';
import { CLI_SESSIONS_STORE } from './cliSessions.svelte';
import { cliTaskRuntime } from './cliRuntime';
import { toTaskRuntime, type TaskMeta, type TaskRuntime, type TaskView } from './model';
import { pendingDue, projectName, projectView, rootPanes, sidebarProjects, type Project, type SidebarProject, type TaskEvidence } from './projects';
import { adeLayout } from './adeLayout.svelte';
import { adeTasks } from './tasks.svelte';

const POLL_MS = 2000;
/** Another project's tasks.json and worktrees are read again this often (and on window focus). */
const REFRESH_MS = 30_000;

/** The platform reports the job in front of a shell (procinfo.rs: macOS and Linux). */
const foregroundKnown = () => typeof navigator === 'undefined' || !/win/i.test(navigator.platform);

type Listing = { tasks: TaskMeta[]; worktrees: WorktreeInfo[]; error?: string };
type Pane = { hook?: HookState; hookAgent?: string; offset: number };
/** One other project's polling state (not reactive: `evidence` is what views read). */
type Tracker = { tag: string; cli: CliSessionsState; hooks: Record<string, HookState>; offsets: Record<string, number>; live: Record<string, Liveness>; panes: Record<string, Pane> };

class Projects {
	list = $state<Project[]>([]);
	loaded = $state(false);
	/** Tasks and worktrees of each other project. */
	listings = $state<Record<string, Listing>>({});
	/** Each other project's agent evidence per task, from the latest poll. */
	evidence = $state<Record<string, Record<string, TaskEvidence>>>({});
	/** Set every poll, for the side bar's "time ago" and stale hooks. */
	now = $state(Date.now());

	/** The side bar's projects, the open folder among them. */
	items: SidebarProject[] = $derived(
		sidebarProjects(this.list, workspace.root, {
			orderBy: settings.get<string>('kingu.projects.orderBy') === 'recent' ? 'recent' : 'manual',
			lastActive: (path) => this.lastActive(path)
		})
	);
	/** Added projects other than the open folder. */
	others: string[] = $derived(this.items.filter((p) => !p.open).map((p) => p.path));
	added: Set<string> = $derived(new Set(this.list.map((p) => p.path)));
	/** Every task of every other project, for notifications and the title bar. */
	all: { root: string; view: TaskView; hostRun: boolean }[] = $derived(
		this.others.flatMap((root) => {
			const runs = this.#hostRuns(root);
			return this.views(root).map((view) => ({ root, view, hostRun: runs.has(view.meta.slug) }));
		})
	);

	#trackers: Record<string, Tracker> = {};
	#polling = false;
	#refreshedAt: Record<string, number> = {};
	/** A task to open once its folder has loaded (`open`). */
	#pending = $state<{ root: string; slug: string } | null>(null);

	async load() {
		try {
			this.list = await invoke<Project[]>('projects_list');
		} catch (e) {
			clientLog('error', `projects_list: ${e}`);
		}
		this.loaded = true;
	}

	/** Adds `path`; `quiet`: no status message (a folder that was just opened). */
	async add(path: string, quiet = false): Promise<boolean> {
		try {
			const r = await invoke<{ project: Project; existed: boolean }>('projects_add', { path });
			if (!r.existed) this.list = [...this.list, r.project];
			if (!quiet) status.flash(t(r.existed ? 'adeProjects.already' : 'adeProjects.added', { name: projectName(r.project.path) }));
			return true;
		} catch (e) {
			if (!quiet) notifications.error(t('adeProjects.addFailed', { error: String(e) }));
			else clientLog('info', `projects_add ${path}: ${e}`);
			return false;
		}
	}

	/** "Agents: Add Project…": the native folder picker; the folder joins the side bar without being opened. */
	async pickAndAdd() {
		const dir = await open({ directory: true, multiple: false, title: t('adeProjects.pickTitle'), defaultPath: workspace.root ?? undefined });
		if (typeof dir === 'string') await this.add(dir);
	}

	/** `kingu.projects.orderBy = recent`: the newest task activity of a project (0 when it has none). */
	lastActive(path: string): number {
		const tasks = path === workspace.root ? adeTasks.list : (this.listings[path]?.tasks ?? []);
		let at = 0;
		for (const t of tasks) at = Math.max(at, t.updated_at);
		return at;
	}

	/** Manual project order: `path` moves in front of `before` (to the end when null). */
	async move(path: string, before: string | null) {
		try {
			await invoke('projects_move', { path, before });
			this.list = await invoke<Project[]>('projects_list');
		} catch (e) {
			notifications.error(t('adeProjects.moveFailed', { error: String(e) }));
		}
	}

	async remove(path: string) {
		try {
			await invoke('projects_remove', { path });
			this.list = this.list.filter((p) => p.path !== path);
			status.flash(t('adeProjects.removed', { name: projectName(path) }));
		} catch (e) {
			notifications.error(t('adeProjects.removeFailed', { error: String(e) }));
		}
	}

	/** Opens project `root` (switching the open folder), then its task `slug` when given. */
	async open(root: string, slug?: string) {
		if (root === workspace.root) {
			if (slug) this.#openTask(slug);
			return;
		}
		this.#pending = slug ? { root, slug } : null;
		if (!(await workspace.openFolder(root))) this.#pending = null;
	}

	#openTask(slug: string) {
		if (!adeTasks.list.some((t) => t.slug === slug)) return;
		adeLayout.board = false;
		adeTasks.openTask(slug);
	}

	/** Another project's tasks with their live state. */
	views(root: string): TaskView[] {
		const runs = this.#hostRuns(root);
		const ev = this.evidence[root] ?? {};
		return (this.listings[root]?.tasks ?? []).map((meta) => projectView(meta, runs.get(meta.slug), ev[meta.slug]));
	}

	/** Both the project's tasks and its agents' first poll are in. */
	ready(root: string): boolean {
		return root in this.listings && root in this.evidence;
	}

	worktrees(root: string): WorktreeInfo[] {
		return this.listings[root]?.worktrees ?? [];
	}

	/** Agent-host runs of `root` by task. */
	#hostRuns(root: string): Map<string, TaskRuntime> {
		return new Map(agents.list.filter((r) => r.root === root).map((r) => [r.slug, toTaskRuntime(r, r.startedAt)]));
	}

	/** Reads another project's tasks.json and worktrees (Rust checks that it is an added project). */
	async refresh(root: string) {
		this.#refreshedAt[root] = Date.now();
		try {
			const [tasks, worktrees] = await Promise.all([invoke<TaskMeta[]>('tasks_load', { root }), invoke<WorktreeInfo[]>('worktree_list', { root })]);
			if (!this.others.includes(root)) return;
			this.listings[root] = { tasks, worktrees: worktrees.filter((w) => w.slug) };
		} catch (e) {
			if (this.others.includes(root)) this.listings[root] = { tasks: [], worktrees: [], error: String(e) };
		}
	}

	/** Trackers and listings follow the set of other projects: one leaving (opened, removed) is dropped. */
	#sync() {
		const others = new Set(this.others);
		for (const root of Object.keys(this.#trackers)) if (!others.has(root)) delete this.#trackers[root];
		for (const root of Object.keys(this.listings)) if (!others.has(root)) delete this.listings[root];
		for (const root of Object.keys(this.evidence)) if (!others.has(root)) delete this.evidence[root];
		for (const root of others) if (!(root in this.listings) || Date.now() - (this.#refreshedAt[root] ?? 0) > REFRESH_MS) void this.refresh(root);
	}

	/** One round over every other project: PTY liveness, then new hook events. */
	async poll() {
		if (this.#polling || !this.others.length) return;
		this.#polling = true;
		try {
			// An error is not "every terminal is gone": skip this round.
			const list = await invoke<PtyListing[]>('pty_list').catch(() => null);
			if (!list) return;
			const now = Date.now();
			this.now = now;
			const byKey = new Map(list.map((p) => [p.key, p]));
			const alive = new Set(list.filter((p) => p.alive).map((p) => p.key));
			for (const root of this.others) {
				const tr = (this.#trackers[root] ??= this.#tracker(root, alive));
				const ev = await this.#pollRoot(tr, byKey, now);
				// The project was opened or removed meanwhile.
				if (this.#trackers[root] === tr) this.evidence[root] = ev;
			}
		} finally {
			this.#polling = false;
		}
	}

	/** A project's saved CLI sessions whose PTY is alive (the others are gone; the folder's next load clears them). */
	#tracker(root: string, alive: Set<string>): Tracker {
		const tag = rootTag(root);
		const saved = restore(storeName(CLI_SESSIONS_STORE, tag), parseCliSessions) ?? {};
		return { tag, cli: liveCliSessions(saved, tag, alive).kept, hooks: {}, offsets: {}, live: {}, panes: {} };
	}

	async #pollRoot(tr: Tracker, byKey: Map<string, PtyListing>, now: number): Promise<Record<string, TaskEvidence>> {
		const ev: Record<string, TaskEvidence> = {};
		const known = foregroundKnown();
		for (const [slug, s] of Object.entries(tr.cli)) {
			const was = tr.live[slug];
			const next = checkLiveness(was, byKey.get(cliKey(tr.tag, slug, s.startedAt)), now, known);
			tr.live[slug] = next;
			if (s.hookToken && !next.ended) {
				const r = await invoke<{ events: object[]; offset: number }>('agent_hook_read', { token: s.hookToken, offset: tr.offsets[slug] ?? 0 }).catch(() => null);
				if (r) {
					tr.offsets[slug] = r.offset;
					if (r.events.length) tr.hooks[slug] = r.events.reduce<HookState>((st, e) => applyHook(st, e, now), tr.hooks[slug] ?? initialHookState(now));
				}
			}
			if (next.ended && !was?.ended && tr.hooks[slug]?.phase !== 'ended') tr.hooks[slug] = applyHook(tr.hooks[slug] ?? initialHookState(now), { kingu_hook: 'kingu', event: 'ProcessExit' }, now);
			ev[slug] = { cli: cliTaskRuntime(slug, { run: s.run, hook: tr.hooks[slug] ?? (s.hookToken ? initialHookState(now) : undefined), working: false, now }), rows: [] };
		}
		const panes = rootPanes([...byKey.keys()], tr.tag);
		for (const key of Object.keys(tr.panes)) if (!panes.has(key)) delete tr.panes[key];
		for (const [key, slug] of panes) {
			const info = byKey.get(key)!;
			const foreground = info.alive && known ? (info.foreground?.name ?? null) : undefined;
			if (foreground === null) {
				// Back at the prompt: whatever ran there exited.
				delete tr.panes[key];
				continue;
			}
			const p = (tr.panes[key] ??= { offset: 0 });
			const r = await invoke<{ events: object[]; offset: number }>('agent_pane_hook_read', { key, offset: p.offset }).catch(() => null);
			if (r) {
				p.offset = r.offset;
				if (r.events.length) {
					p.hook = r.events.reduce<HookState>((st, e) => applyHook(st, e, now), p.hook ?? initialHookState(now));
					const last = r.events.at(-1) as { kingu_hook?: unknown } | undefined;
					if (typeof last?.kingu_hook === 'string') p.hookAgent = last.kingu_hook;
				}
			}
			const row = paneRow({ id: key, hook: p.hook, hookAgent: p.hookAgent, foreground }, now);
			if (row) (ev[slug] ??= { rows: [] }).rows.push(row);
		}
		return ev;
	}

	/** Workbench wiring: the list, adding the opened folder, polling, the palette command. */
	install(): () => void {
		void this.load();
		const stop = $effect.root(() => {
			// kingu.projects.addOnOpen (Orca adds every folder it works on to its projects).
			$effect(() => {
				const root = workspace.root;
				if (!root || !this.loaded || settings.get<boolean>('kingu.projects.addOnOpen') === false) return;
				untrack(() => !this.added.has(root) && void this.add(root, true));
			});
			$effect(() => {
				void this.others;
				untrack(() => this.#sync());
			});
			// The task a project switch was for, once that folder's tasks are in.
			$effect(() => {
				const p = this.#pending;
				if (!pendingDue(p, adeTasks.loadedRoot)) return;
				untrack(() => {
					this.#pending = null;
					this.#openTask(p!.slug);
				});
			});
		});
		const poll = setInterval(() => void this.poll(), POLL_MS);
		const refresh = setInterval(() => this.#sync(), REFRESH_MS);
		const onFocus = () => {
			for (const root of this.others) void this.refresh(root);
		};
		window.addEventListener('focus', onFocus);
		const unregister = commands.register({ id: 'kingu.agents.addProject', title: 'Add Project…', category: 'Agents', run: () => this.pickAndAdd() });
		return () => {
			stop();
			clearInterval(poll);
			clearInterval(refresh);
			window.removeEventListener('focus', onFocus);
			unregister();
		};
	}
}

export const projects = new Projects();
