// ADE tasks (Orca-style: one task = one git worktree with an agent). Task metadata is persisted in
// `<root>/.kingu/tasks.json` through Rust; live state comes from the TaskRuntime adapter; diff
// stats come from `worktree_diff_stat`. Runs go through the agent host's `agents` store (via the
// runtime adapter); when a turn or run ends its status, usage and session id are saved here so a
// task can be continued after a restart. Views read `adeTasks.views / groups`; actions confirm
// destructive steps with a native dialog and report results in the status bar.

import { team } from '#lib/team/team.svelte.ts';
import { syncKey, toTeamTask } from './teamSync.ts';
import { untrack } from 'svelte';
import { invoke } from '@tauri-apps/api/core';
import { ask, confirm, message } from '#lib/workbench/dialogService.svelte.ts';
import { clientLog } from '#lib/client-log.ts';
import { agents } from '#lib/agent/agents.svelte.ts';
import type { Decision, WorktreeInfo } from '#lib/agent/events.ts';
import { commands } from '#lib/workbench/commands.svelte.ts';
import { editors } from '#lib/workbench/editors.svelte.ts';
import { layout } from '#lib/workbench/layout.svelte.ts';
import { quick } from '#lib/workbench/quick.svelte.ts';
import { status } from '#lib/workbench/status.svelte.ts';
import { workspace } from '#lib/workbench/workspace.svelte.ts';
import { taskDiffKey, parseTaskDiffKey } from '#lib/workbench/scm.ts';
import { appMode } from '#lib/workbench/mode.svelte.ts';
import { countSessions, inFilter, type AgentsFilter, type SessionState } from '#lib/workbench/titlebar.ts';
import { BOARD_KEY, slugOfTaskKey, taskKey, worktreeDir } from './keys';
import {
	adoptOrphans,
	commitMessage,
	effectiveStatus,
	groupTasks,
	newTask,
	nextNeedingAttention,
	patchTask,
	pruneAccepted,
	removeTask,
	runSummary,
	toTaskRuntime,
	sameSummary,
	toggleAccepted,
	uniqueSlug,
	type DiffStat,
	type GhStatus,
	type MergeResult,
	type TaskMeta,
	type TaskView
} from './model';
import { runtime } from './runtime.svelte';
import { adeLayout } from './adeLayout.svelte';
import { cliAgent, cliOf, cliResume, cliStart, parseCliCommand, type RunMode } from './agentCli';
import { cliSessions } from './cliSessions.svelte';
import { cliWithMcp, mcpServers, skillPlugins } from './mcp';
import { settings } from '#lib/settings/settings.svelte.ts';

class AdeTasks {
	list = $state<TaskMeta[]>([]);
	worktrees = $state<WorktreeInfo[]>([]);
	stats = $state<Record<string, DiffStat>>({});
	statErrors = $state<Record<string, string>>({});
	branches = $state<string[]>([]);
	gh = $state<GhStatus | null>(null);
	loaded = $state(false);
	busy = $state<Record<string, string>>({});
	/** Ticks every 30s so "time ago" labels move. */
	now = $state(Date.now());
	/** The New Task form is open (side bar or board). */
	composing = $state(false);

	views: TaskView[] = $derived(
		this.list.map((meta) => {
			const rt = runtime.get(meta.slug);
			return { meta, runtime: rt, status: effectiveStatus(meta, rt), stat: this.stats[meta.slug], statError: this.statErrors[meta.slug] };
		})
	);
	groups = $derived(groupTasks(this.views));
	attentionCount = $derived(this.groups.attention.length);
	/** Tasks of the open folder that need a review (or failed); permission prompts are counted by `agents`. */
	reviewCount = $derived(this.groups.attention.filter((v) => v.status !== 'waiting').length);
	/** The title-bar "รอคุณ" badge: pending permission requests (every folder) + tasks to review. */
	badgeCount = $derived(agents.pendingCount + this.reviewCount);
	/**
	 * Every agent session for the title bar's agents status: this folder's tasks, plus runs started
	 * in other folders (they can still need input or be working).
	 */
	sessionStates: (SessionState & { slug: string })[] = $derived.by(() => {
		const here = this.views.map((v) => ({ slug: v.meta.slug, ...this.stateOf(v) }));
		const others = agents.list
			.filter((r) => r.root !== workspace.root)
			.map((r) => ({ slug: r.slug, status: toTaskRuntime(r).status, pending: r.pending.length }));
		return [...here, ...others];
	});
	/** Needs input / in progress / unread, for the agents status widget and the session pill. */
	counts = $derived(countSessions(this.sessionStates));

	#saving: Promise<void> = Promise.resolve();
	#root: string | null = null;

	/** A task as the agents status sees it (unread = finished after it was last viewed). */
	stateOf(v: TaskView): SessionState {
		const finished = v.status === 'review' || v.status === 'failed';
		return {
			status: v.status,
			pending: v.runtime?.pendingPermissions ?? 0,
			finishedAt: finished ? (v.runtime?.updatedAt ?? v.meta.last_run?.at ?? v.meta.updated_at) : undefined,
			viewedAt: appMode.viewedAt[v.meta.slug]
		};
	}

	/** This folder's tasks in a status group of the Agents layout. */
	filtered(filter: AgentsFilter): TaskView[] {
		return this.views.filter((v) => inFilter(this.stateOf(v), filter));
	}

	find(slug: string): TaskView | undefined {
		return this.views.find((v) => v.meta.slug === slug);
	}

	async load() {
		const root = workspace.root;
		this.#root = root;
		this.list = [];
		this.stats = {};
		this.statErrors = {};
		this.worktrees = [];
		this.loaded = false;
		if (!root) return;
		try {
			const [tasks, worktrees, branches] = await Promise.all([
				invoke<TaskMeta[]>('tasks_load'),
				invoke<WorktreeInfo[]>('worktree_list'),
				invoke<string[]>('git_branches').catch(() => [] as string[])
			]);
			if (this.#root !== root) return;
			this.worktrees = worktrees.filter((w) => w.slug);
			this.branches = branches;
			const base = status.branch && branches.includes(status.branch) ? status.branch : (branches[0] ?? 'HEAD');
			const adopted = adoptOrphans(tasks, this.worktrees.map((w) => w.slug!), base, Date.now());
			this.list = adopted;
			if (adopted !== tasks) await this.#save(adopted);
		} catch (e) {
			status.error(`โหลดงานไม่ได้: ${e}`, 8000);
			clientLog('error', `tasks_load: ${e}`);
		}
		this.loaded = true;
		await this.refreshStats();
	}

	async refreshBranches() {
		this.branches = await invoke<string[]>('git_branches').catch(() => this.branches);
	}

	async refreshStats() {
		await Promise.all(this.list.map((t) => this.refreshStat(t.slug)));
	}

	async refreshStat(slug: string): Promise<DiffStat | undefined> {
		const meta = this.list.find((t) => t.slug === slug);
		if (!meta) return;
		try {
			const stat = await invoke<DiffStat>('worktree_diff_stat', { slug, base: meta.base });
			this.stats[slug] = stat;
			delete this.statErrors[slug];
			const accepted = pruneAccepted(meta.accepted, stat.files);
			if (accepted.length !== meta.accepted.length) await this.#patch(slug, { accepted });
			return stat;
		} catch (e) {
			this.statErrors[slug] = String(e);
			delete this.stats[slug];
		}
	}

	#save(next: TaskMeta[]): Promise<void> {
		this.list = next;
		const snapshot = $state.snapshot(next) as TaskMeta[];
		this.#saving = this.#saving.then(() =>
			invoke<void>('tasks_save', { tasks: snapshot }).catch((e) => {
				status.error(`บันทึก tasks.json ไม่ได้: ${e}`, 8000);
				clientLog('error', `tasks_save: ${e}`);
			})
		);
		return this.#saving;
	}

	#patch(slug: string, patch: Partial<Omit<TaskMeta, 'slug'>>) {
		return this.#save(patchTask(this.list, slug, patch, Date.now()));
	}

	async #step<T>(slug: string, label: string, f: () => Promise<T>): Promise<T | undefined> {
		this.busy[slug] = label;
		try {
			return await f();
		} catch (e) {
			status.error(`${label}ไม่สำเร็จ: ${e}`, 10000);
			clientLog('error', `${slug} ${label}: ${e}`);
		} finally {
			delete this.busy[slug];
		}
	}

	// -------------------------------------------------------------------------------------------
	// Lifecycle

	/**
	 * Creates the worktree, saves the task and starts the agent; opens the task page. `mode`:
	 * `terminal` runs the agent CLI (`kingu.agent.cli`) in a terminal of the worktree, the Orca way;
	 * `timeline` runs it through the agent host. Without one, `kingu.agent.runMode` decides.
	 */
	async create(input: { title: string; prompt: string; base: string; mode?: RunMode }): Promise<string | undefined> {
		const title = input.title.trim();
		if (!title || !workspace.root) return;
		const taken = new Set([...this.list.map((t) => t.slug), ...this.worktrees.map((w) => w.slug ?? '')]);
		const slug = uniqueSlug(title, taken);
		const prompt = input.prompt.trim() || title;
		// Without a pick, fork from the folder's current branch (so merging back has a branch).
		const base = input.base || status.branch || 'HEAD';
		const mode = input.mode ?? (settings.get<RunMode>('kingu.agent.runMode') === 'timeline' ? 'timeline' : 'terminal');
		const cli = mode === 'terminal' ? parseCliCommand(settings.get<string>('kingu.agent.cli') ?? '') : null;
		if (mode === 'terminal' && !cli) {
			status.flash('kingu.agent.cli ต้องเป็นคำสั่งธรรมดา เช่น claude หรือ codex --full-auto (ไม่มีอักขระของ shell)', 10000);
			return;
		}
		try {
			await invoke<WorktreeInfo>('worktree_create', { slug, base });
		} catch (e) {
			status.error(`สร้าง worktree ไม่ได้: ${e}`, 10000);
			return;
		}
		await this.#save([...this.list, newTask({ slug, title, prompt, base, agent: cli ? cliAgent(cli) : undefined }, Date.now())]);
		this.worktrees = (await invoke<WorktreeInfo[]>('worktree_list').catch(() => this.worktrees)).filter((w) => w.slug);
		this.openTask(slug);
		// After the prompt: claude's --mcp-config takes several values and would swallow it.
		if (cli) cliSessions.start(slug, cliWithMcp(cliStart(cli, prompt), mcpServers(), await skillPlugins()));
		else await this.run(slug, prompt);
		return slug;
	}

	/** After a restart: start the task's CLI again in its worktree, continuing its latest session where the CLI can. */
	async resumeCli(slug: string, fresh = false) {
		const meta = this.list.find((t) => t.slug === slug);
		const cli = meta && cliOf(meta.agent);
		if (!cli) return;
		const resume = fresh ? null : cliResume(cli);
		cliSessions.start(slug, cliWithMcp(resume ?? cli, mcpServers(), await skillPlugins()));
	}

	/** Starts the agent in the task worktree through the agents store. */
	async run(slug: string, prompt: string) {
		try {
			await runtime.start(slug, prompt);
			await this.#patch(slug, { status: 'running' });
		} catch (e) {
			status.error(`เริ่ม agent ไม่ได้: ${e}`, 10000);
			await this.#patch(slug, { status: 'failed' });
		}
	}

	/** Follow-up message: into the open session, else resuming the task's session (saved in tasks.json). */
	async followUp(slug: string, text: string) {
		const meta = this.list.find((t) => t.slug === slug);
		if (!meta || !text.trim()) return;
		try {
			await runtime.followUp(slug, text, meta.session_id);
			if (meta.status !== 'running') await this.#patch(slug, { status: 'running' });
		} catch (e) {
			status.error(`ส่งข้อความถึง agent ไม่ได้: ${e}`, 10000);
		}
	}

	answer(slug: string, requestId: string, decision: Decision, message?: string) {
		return runtime.answer(slug, requestId, decision, message).catch((e) => status.error(`ตอบคำขออนุญาตไม่ได้: ${e}`, 8000));
	}

	/** Stops the current turn; the session stays open for follow-ups. */
	interrupt(slug: string) {
		return runtime.interrupt(slug).catch((e) => status.error(String(e), 8000));
	}

	/** Ends the run (continue later with a follow-up, which resumes the session). */
	stop(slug: string) {
		return runtime.stop(slug).catch((e) => status.error(String(e), 8000));
	}

	/**
	 * Called when a run's state changes, so tasks.json follows it: status, model, the session id
	 * (to resume after a restart) and, after each turn and when the run ends, its summary and usage.
	 */
	syncRuntime(slug: string) {
		const run = runtime.run(slug);
		const rt = runtime.get(slug);
		const meta = this.list.find((t) => t.slug === slug);
		if (!run || !rt || !meta) return;
		const patch: Partial<TaskMeta> = {};
		if (rt.status !== meta.status && !(meta.status === 'done' && rt.status === 'review')) patch.status = rt.status;
		if (rt.model && rt.model !== meta.model) patch.model = rt.model;
		if (run.sessionId && run.sessionId !== meta.session_id) patch.session_id = run.sessionId;
		if (run.ended || run.status === 'idle') {
			const summary = runSummary(run, Date.now());
			if (!sameSummary(summary, meta.last_run)) patch.last_run = summary;
		}
		if (Object.keys(patch).length) void this.#patch(slug, patch);
		if (rt.status === 'review' || rt.status === 'failed') void this.refreshStat(slug);
	}

	/**
	 * Removes the worktree and forgets the task. `confirmed` skips the first question (a caller that
	 * already asked, like Clean Up Tasks); a worktree with uncommitted work still asks before forcing.
	 */
	async remove(slug: string, opts: { confirmed?: boolean; deleteBranch?: boolean } = {}) {
		if (runtime.isWorking(slug)) {
			status.flash('หยุด agent ก่อนลบงาน');
			return;
		}
		const path = worktreeDir(slug);
		const hasWorktree = this.worktrees.some((w) => w.slug === slug);
		if (hasWorktree) {
			const choice = opts.confirmed
				? { ok: true, checked: opts.deleteBranch ?? false }
				: await confirm(`ลบ worktree ${path}?`, { title: 'ลบงาน', kind: 'warning', okLabel: 'ลบ', cancelLabel: 'ยกเลิก', checkbox: { label: `ลบ branch kingu/${slug} ด้วย` } });
			if (!choice.ok) return;
			const deleteBranch = choice.checked;
			// An idle session still runs in the worktree: end it with the task.
			if (runtime.isLive(slug)) await this.stop(slug);
			try {
				await invoke('worktree_remove', { slug, force: false, deleteBranch });
			} catch (e) {
				const dirty = /modified|untracked|dirty/i.test(String(e));
				if (!dirty) {
					status.error(`ลบไม่ได้: ${e}`, 10000);
					return;
				}
				const force = await ask(`worktree ${path} มีการแก้ไขที่ยังไม่ commit\n\nลบทิ้งทั้งหมด? กู้คืนไม่ได้`, { title: 'มีงานที่ยังไม่ commit', kind: 'warning', okLabel: 'ลบทิ้ง', cancelLabel: 'ยกเลิก' });
				if (!force) return;
				try {
					await invoke('worktree_remove', { slug, force: true, deleteBranch });
				} catch (e2) {
					status.error(`ลบไม่ได้: ${e2}`, 10000);
					return;
				}
			}
		} else if (!opts.confirmed && !(await ask(`ลบงาน "${this.list.find((t) => t.slug === slug)?.title ?? slug}" ออกจากรายการ?`, { title: 'ลบงาน', okLabel: 'ลบ', cancelLabel: 'ยกเลิก' }))) return;
		if (!hasWorktree && runtime.isLive(slug)) await this.stop(slug);
		runtime.forget(slug);
		cliSessions.end(slug);
		for (const t of editors.allTabs().map((t) => t.path)) {
			if (slugOfTaskKey(t) === slug || parseTaskDiffKey(t)?.slug === slug) editors.closeEverywhere(t);
		}
		this.worktrees = this.worktrees.filter((w) => w.slug !== slug);
		delete this.stats[slug];
		delete this.statErrors[slug];
		await this.#save(removeTask(this.list, slug));
		appMode.forget(slug);
		status.flash(`ลบงาน ${slug} แล้ว`);
	}

	// -------------------------------------------------------------------------------------------
	// Review

	toggleAccept(slug: string, path: string) {
		return this.#save(toggleAccepted(this.list, slug, path, Date.now()));
	}

	/** Restores files from the base after confirming; `paths` includes a rename's source. */
	async reject(slug: string, paths: string[], label: string) {
		const meta = this.list.find((t) => t.slug === slug);
		if (!meta || !paths.length) return;
		const ok = await ask(`ทิ้งการเปลี่ยนแปลงของ ${label} ใน worktree ${slug}?\n\nไฟล์จะกลับเป็นแบบใน ${meta.base} (ไฟล์ที่เพิ่มใหม่จะถูกลบ) กู้คืนไม่ได้`, {
			title: 'ปฏิเสธการเปลี่ยนแปลง',
			kind: 'warning',
			okLabel: 'ทิ้งการเปลี่ยนแปลง',
			cancelLabel: 'ยกเลิก'
		});
		if (!ok) return;
		await this.#step(slug, 'ปฏิเสธไฟล์', () => invoke('worktree_reject', { slug, base: meta.base, paths }));
		await this.refreshStat(slug);
	}

	async commit(slug: string, msg: string) {
		if (!msg.trim()) {
			status.flash('ใส่ข้อความ commit ก่อน');
			return false;
		}
		const done = await this.#step(slug, 'commit', () => invoke('worktree_commit', { slug, message: msg }).then(() => true));
		await this.refreshStat(slug);
		if (done) status.flash(`commit ใน kingu/${slug} แล้ว`);
		return !!done;
	}

	defaultCommitMessage(slug: string) {
		const meta = this.list.find((t) => t.slug === slug);
		return meta ? commitMessage(meta) : '';
	}

	async merge(slug: string, mode: 'ff' | 'merge') {
		const meta = this.list.find((t) => t.slug === slug);
		if (!meta) return;
		const how = mode === 'ff' ? 'แบบ fast-forward' : 'แบบ merge commit';
		const ok = await ask(`รวม kingu/${slug} เข้า ${meta.base} ${how} ในเครื่อง?`, { title: 'Merge เข้า base', okLabel: 'Merge', cancelLabel: 'ยกเลิก' });
		if (!ok) return;
		const r = await this.#step(slug, 'merge', () => invoke<MergeResult>('worktree_merge', { slug, base: meta.base, mode }));
		if (r) {
			await this.#patch(slug, { merged_at: Date.now(), status: 'done' });
			status.flash(`merge เข้า ${meta.base} แล้ว (${r.fast_forward ? 'fast-forward' : 'merge commit'} ${r.commit.slice(0, 8)})`, 8000);
		}
		await this.refreshStat(slug);
	}

	async checkGh(): Promise<GhStatus | null> {
		this.gh = await invoke<GhStatus>('gh_status').catch(() => null);
		return this.gh;
	}

	async createPr(slug: string) {
		const meta = this.list.find((t) => t.slug === slug);
		if (!meta) return;
		const gh = await this.checkGh();
		if (!gh?.installed) {
			await message('ยังไม่ได้ติดตั้ง GitHub CLI (gh)\n\nติดตั้ง: brew install gh\nแล้วเข้าสู่ระบบ: gh auth login', { title: 'สร้าง PR', kind: 'info' });
			return;
		}
		if (!gh.authenticated) {
			await message(`gh ยังไม่ได้เข้าสู่ระบบ\n\nรันในเทอร์มินัล: gh auth login\n\n${gh.detail}`, { title: 'สร้าง PR', kind: 'info' });
			return;
		}
		const stat = this.stats[slug];
		if (stat?.dirty && !(await ask('มีการแก้ไขที่ยังไม่ commit ซึ่งจะไม่อยู่ใน PR\n\nสร้าง PR ต่อไหม?', { title: 'สร้าง PR', okLabel: 'สร้าง PR', cancelLabel: 'ยกเลิก' })))
			return;
		if (!(await ask(`push kingu/${slug} ไปที่ origin แล้วเปิด PR เข้า ${meta.base}?`, { title: 'สร้าง PR', okLabel: 'สร้าง PR', cancelLabel: 'ยกเลิก' }))) return;
		const body = `${meta.prompt}\n\n---\nสร้างจากงาน Kingu \`${slug}\``;
		const url = await this.#step(slug, 'สร้าง PR', () => invoke<string>('worktree_pr_create', { slug, base: meta.base, title: meta.title, body }));
		if (url !== undefined) {
			await this.#patch(slug, { pr_url: url || null });
			status.flash(url ? `เปิด PR แล้ว: ${url}` : 'เปิด PR แล้ว', 10000);
		}
	}

	markDone(slug: string, done = true) {
		return this.#patch(slug, { status: done ? 'done' : 'review' });
	}

	/** Renames a task (its branch and worktree keep their slug). */
	rename(slug: string, title: string) {
		const t = title.trim();
		return t ? this.#patch(slug, { title: t }) : undefined;
	}

	// -------------------------------------------------------------------------------------------
	// Navigation

	/** The task page: the Agents layout's session in Agents mode, else an editor tab. */
	openTask(slug: string) {
		if (appMode.isAgents) adeLayout.show(slug);
		else editors.open(taskKey(slug), { preview: false });
	}

	openBoard() {
		if (appMode.isAgents) adeLayout.board = true;
		else editors.open(BOARD_KEY, { preview: false });
	}

	/** The Agents side bar view (in Agents mode: the sessions side bar). */
	showView() {
		if (appMode.isAgents) {
			appMode.sessionsVisible = true;
			return;
		}
		layout.sideView = 'agents';
		layout.sidebarVisible = true;
	}

	/** Title-bar badge: the next task in รอคุณ (cycling when the current tab is already one). */
	openNext() {
		const current = editors.active ? slugOfTaskKey(editors.active) : null;
		const next = nextNeedingAttention(this.views, current ?? undefined);
		if (next) this.openTask(next.meta.slug);
		else if (agents.pendingCount) {
			// Permission requests of runs started in another folder.
			const other = agents.list.find((r) => r.pending.length);
			status.flash(`agent ในโฟลเดอร์ ${other?.root ?? 'อื่น'} รอคุณอนุญาต (งาน ${other?.slug ?? ''})`, 8000);
		} else status.flash('ไม่มีงานที่รอคุณ');
	}

	/** Diff of a worktree file against the task's fork point, in a `taskdiff://` tab. */
	async openDiff(slug: string, rel: string) {
		if (!this.stats[slug]) await this.refreshStat(slug);
		editors.open(taskDiffKey(slug, rel), { preview: true });
	}

	/** For DiffHost: the revision and path to show on the left of a task diff tab. */
	diffBase(key: string): { slug: string; rel: string; rev: string; orig: string } | null {
		const k = parseTaskDiffKey(key);
		if (!k) return null;
		const stat = this.stats[k.slug];
		if (!stat) return null;
		const orig = stat.files.find((f) => f.path === k.rel)?.orig_path ?? k.rel;
		return { ...k, rev: stat.merge_base, orig };
	}

	/** Quick open scoped to the worktree: files open as `.kingu/worktrees/<slug>/<file>`. */
	async quickOpen(slug: string) {
		let files: string[];
		try {
			files = await invoke<string[]>('worktree_list_files', { slug });
		} catch (e) {
			status.error(String(e), 8000);
			return;
		}
		const changed = new Set(this.stats[slug]?.files.map((f) => f.path));
		quick.pick({
			placeholder: `เปิดไฟล์ใน worktree ${slug}`,
			items: files.map((f) => ({ id: f, label: f, description: changed.has(f) ? 'แก้ไข' : undefined })),
			onAccept: (item) => editors.open(`${worktreeDir(slug)}/${item.id}`, { preview: true })
		});
	}

	/** Palette: pick a task to open. */
	pickTask() {
		quick.pick({
			placeholder: 'เลือกงาน',
			items: this.views.map((v) => ({ id: v.meta.slug, label: v.meta.title, description: `kingu/${v.meta.slug}` })),
			onAccept: (item) => this.openTask(item.id)
		});
	}
}

export const adeTasks = new AdeTasks();

/** Workbench wiring: loads tasks per folder, follows runtime changes, registers commands. */
export function installAde(): () => void {
	const synced = new Map<string, string>();
	const stopEffects = $effect.root(() => {
		$effect(() => {
			void workspace.root;
			untrack(() => {
				// Runs stay in the agents store across folders; re-sync this folder's after loading.
				synced.clear();
				void adeTasks.load();
			});
		});
		// Team server: send each task's metadata when its status, branch or diff stats change.
		const teamSent = new Map<string, string>();
		$effect(() => {
			if (!adeTasks.loaded || !workspace.root) return;
			const folder = workspace.name;
			for (const view of adeTasks.views) {
				const task = toTeamTask(view, folder);
				const key = syncKey(task);
				if (teamSent.get(task.id) === key) continue;
				teamSent.set(task.id, key);
				untrack(() => void team.syncTask(task));
			}
		});
		// "Unread": a session counts as seen while its task page is in front (tab or Agents layout).
		$effect(() => {
			const slug = appMode.isAgents ? appMode.activeSession : editors.active ? slugOfTaskKey(editors.active) : null;
			if (!slug) return;
			const v = adeTasks.find(slug);
			void v?.status;
			void v?.runtime?.updatedAt;
			void v?.meta.updated_at;
			untrack(() => appMode.markViewed(slug));
		});
		$effect(() => {
			if (!adeTasks.loaded) return;
			for (const rt of runtime.all()) {
				const sig = `${rt.status}|${rt.runStatus}|${rt.model ?? ''}|${rt.sessionId ?? ''}|${rt.usage ?? ''}|${rt.error ?? ''}`;
				if (synced.get(rt.slug) === sig) continue;
				synced.set(rt.slug, sig);
				untrack(() => adeTasks.syncRuntime(rt.slug));
			}
		});
	});
	const tick = setInterval(() => (adeTasks.now = Date.now()), 30_000);
	// Refresh stats when the window regains focus (agents and terminals change worktrees).
	const onFocus = () => void adeTasks.refreshStats();
	window.addEventListener('focus', onFocus);
	const hasRoot = () => workspace.root !== null;
	const unregister = [
		// No keybinding: ⌘⇧A (Ctrl+Shift+A) switches to the Agents layout (workbench.action.toggleAgentsMode).
		commands.register({ id: 'kingu.agents.show', title: 'Show Agents', category: 'View', run: () => adeTasks.showView() }),
		commands.register({ id: 'kingu.agents.newTask', title: 'งานใหม่ (New Task)', category: 'Agents', when: hasRoot, run: () => (adeTasks.showView(), (adeTasks.composing = true)) }),
		commands.register({ id: 'kingu.agents.openBoard', title: 'Open Board', category: 'Agents', when: hasRoot, run: () => adeTasks.openBoard() }),
		commands.register({ id: 'kingu.agents.nextAttention', title: 'เปิดงานถัดไปที่รอคุณ (Next Task Needing Attention)', category: 'Agents', when: hasRoot, run: () => adeTasks.openNext() }),
		commands.register({ id: 'kingu.agents.openTask', title: 'Open Task...', category: 'Agents', when: () => adeTasks.list.length > 0, run: () => adeTasks.pickTask() }),
		commands.register({ id: 'kingu.agents.refresh', title: 'Refresh Tasks', category: 'Agents', when: hasRoot, run: () => adeTasks.load() })
	];
	return () => {
		stopEffects();
		clearInterval(tick);
		window.removeEventListener('focus', onFocus);
		unregister.forEach((u) => u());
	};
}
