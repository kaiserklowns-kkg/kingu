// ADE tasks (Orca-style: one task = one git worktree with an agent). Task metadata is persisted in
// `<root>/.kingu/tasks.json` through Rust; live state comes from the TaskRuntime adapter; diff
// stats come from `worktree_diff_stat`. Runs go through the agent host's `agents` store (via the
// runtime adapter); when a turn or run ends its status, usage and session id are saved here so a
// task can be continued after a restart. Views read `adeTasks.views / groups`; actions confirm
// destructive steps with a native dialog and report results in the status bar.

import { team } from '#lib/team/team.svelte.ts';
import { runKey, syncKey, toTeamRun, toTeamTask } from './teamSync.ts';
import { untrack } from 'svelte';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ask, message } from '#lib/workbench/messageBox.ts';
import { removalGate } from './agentPresence';
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
	patchChange,
	patchTask,
	pruneAccepted,
	removeTask,
	taskChanges,
	type TaskChange,
	renamedTitle,
	runSummary,
	toTaskRuntime,
	sameSummary,
	toggleAccepted,
	uniqueSlug,
	type DiffStat,
	type GhStatus,
	type IssueLink,
	type MergeResult,
	type TaskMeta,
	type TaskView
} from './model';
import { runtime } from './runtime.svelte';
import { tabsOfTask, touchedTasks } from './agentGuard';
import { confirmAgentIdle } from './agentGuard.svelte';
import { adeLayout } from './adeLayout.svelte';
import { agentCommand, cliAgent, cliOf, launchOptions, withLaunchOptions, type RunMode } from './agentCli';
import { profileOf, programOf } from '#lib/ade/agentProfiles.ts';
import { chooseAgentCli } from '#lib/ade/agentPicker.ts';
import { composeMessage, promptWithAttachments, type Attachment } from '#lib/agent/attachments.ts';
import { cliSessions } from './cliSessions.svelte';
import { projects } from './projects.svelte';
import { projectBadge, strayRuns } from './projects';
import { mcpServers, skillPlugins } from './mcp';
import { prStatuses } from './prStatus.svelte';
import { quickOpenWorktree } from './quickOpen.svelte.ts';
import { diffNotes } from './diffNotes.svelte.ts';
import { pruneAcceptedHunks, sameMarks } from './hunkReview.ts';
import { adeDialogs } from './dialogs.svelte.ts';
import { commentOnLink } from './trackerApi.ts';
import { issueBranchLeaf } from './issueBranch.ts';
import { prefillPr, prFormProblem, type Commit, type PrForm } from './prForm.ts';
import { isFolderGithub, isLinear, issueLink, issuePrompt, issueRef, issueSlug, issueTaskTitle, prBody, prComment, taskForIssue, type Issue, type IssueDetail } from './issues.ts';
import { linearLink, linearPrompt, linearSlug, linearTaskTitle, taskForLinearIssue, type LinearIssue, type LinearIssueDetail } from './linear.ts';
import { brokenChecks, methodLabel, type MergeMethod } from './prChecks.ts';
import { forgeFor, forgeOf, ft } from './forge.ts';
import { buildCommentsPrompt, buildFixChecksPrompt, type CheckLog } from './prPrompts.ts';
import type { ReviewThread } from './prComments.ts';

/** Rust `worktree_pr_merge`'s answer. */
type MergeOutcome = { deleted_branch: string | null; branch_note: string | null };
import { settings } from '#lib/settings/settings.svelte.ts';
import {
	agentStartup,
	branchPrefix,
	branchRemoval,
	type BranchRemoval,
	defaultBaseBranch,
	defaultTabsToOpen,
	issueCommandArgv,
	type KinguYamlStatus,
	scriptPreview,
	scriptRunSummary,
	setupCommand,
	setupPolicy,
	type ScriptKind,
	type ScriptPlan,
	type ScriptRun
} from './worktreeSettings.ts';
import { notifications } from '#lib/workbench/notifications.svelte.ts';
import { t } from '#lib/i18n/index.ts';
import { aiTextEnabled } from './aiText.svelte.ts';
import type { BranchRef } from '#lib/workbench/scmRemote.ts';
import { branchChoices, branchNamePrompt, branchSlug, branchTitle, looksLikePr, prTitle, type PrHead, type TaskSource } from './worktreeSource.ts';
import { canResumeWith, handOffPrompt, withSession, type SessionRef } from './sessionHistory.ts';
import { isStackedBase, withModel } from './attempts.ts';
import { workflowLabel } from './workflow.ts';
import { isRustError } from '#lib/i18n/rustErrors.ts';

const scriptTitle = (kind: ScriptKind): string =>
	({
		setup: t('adeTasks.tasks.scriptTitle.setup'),
		archive: t('adeTasks.tasks.scriptTitle.archive'),
		tabs: t('adeTasks.tasks.scriptTitle.tabs'),
		issue: t('adeTasks.tasks.scriptTitle.issue')
	})[kind];

class AdeTasks {
	list = $state<TaskMeta[]>([]);
	worktrees = $state<WorktreeInfo[]>([]);
	/** Every worktree git lists for the folder, Kingu's or not (the side bar's external worktree cards). */
	listed = $state<WorktreeInfo[]>([]);
	stats = $state<Record<string, DiffStat>>({});
	statErrors = $state<Record<string, string>>({});
	branches = $state<string[]>([]);
	gh = $state<GhStatus | null>(null);
	loaded = $state(false);
	/**
	 * The folder whose tasks.json and worktrees were last read without an error. `loaded` is also
	 * set after a failed read (with an empty list); only this says the list can be trusted to end
	 * the terminals and agent CLIs of tasks that are gone.
	 */
	loadedRoot = $state<string | null>(null);
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
	/**
	 * The title-bar "รอคุณ" badge: pending permission requests (every folder) + tasks to review,
	 * with the other added projects' CLI prompts and reviews (projects.ts projectBadge).
	 */
	badgeCount = $derived(agents.pendingCount + this.reviewCount + projectBadge(projects.all));
	/**
	 * Every agent session for the title bar's agents status: this folder's tasks, the other added
	 * projects' tasks (agent-host runs and CLIs alike), plus runs started in folders that are not
	 * added (they can still need input or be working).
	 */
	sessionStates: (SessionState & { slug: string })[] = $derived.by(() => {
		const here = this.views.map((v) => ({ slug: v.meta.slug, ...this.stateOf(v) }));
		const projectTasks = projects.all.map(({ view }) => ({ slug: view.meta.slug, ...this.stateOf(view) }));
		const others = strayRuns(agents.list, workspace.root, projects.added).map((r) => ({ slug: r.slug, status: toTaskRuntime(r).status, pending: r.pending.length }));
		return [...here, ...projectTasks, ...others];
	});
	/** Needs input / in progress / unread, for the agents status widget and the session pill. */
	counts = $derived(countSessions(this.sessionStates));

	#saving: Promise<void> = Promise.resolve();
	#root: string | null = null;
	/** Tasks whose worktree git is removing now (Orca's "removing" row). */
	#removing = new Set<string>();

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

	/** The base branch new tasks start from: `kingu.worktree.baseBranch`, else the folder's current branch. */
	defaultBase(): string {
		return defaultBaseBranch(settings.get<string>('kingu.worktree.baseBranch'), status.branch, this.branches);
	}

	/** The branch checked out in the task's worktree (its prefix came from `kingu.worktree.branchPrefix`). */
	branchOf(slug: string): string {
		return this.worktrees.find((w) => w.slug === slug)?.branch ?? `kingu/${slug}`;
	}

	async load() {
		const root = workspace.root;
		this.#root = root;
		this.list = [];
		this.stats = {};
		this.statErrors = {};
		this.worktrees = [];
		this.listed = [];
		this.loaded = false;
		this.loadedRoot = null;
		if (!root) return;
		try {
			const [tasks, worktrees, branches] = await Promise.all([
				invoke<TaskMeta[]>('tasks_load'),
				invoke<WorktreeInfo[]>('worktree_list'),
				invoke<string[]>('git_branches').catch(() => [] as string[])
			]);
			if (this.#root !== root) return;
			this.worktrees = worktrees.filter((w) => w.slug);
			this.listed = worktrees;
			this.branches = branches;
			const base = status.branch && branches.includes(status.branch) ? status.branch : (branches[0] ?? 'HEAD');
			const adopted = adoptOrphans(tasks, this.worktrees.map((w) => w.slug!), base, Date.now());
			this.list = adopted;
			if (adopted !== tasks) await this.#save(adopted);
			if (this.#root === root) this.loadedRoot = root;
		} catch (e) {
			notifications.error(t('adeTasks.tasks.loadFailed', { error: String(e) }));
			clientLog('error', `tasks_load: ${e}`);
		}
		this.loaded = true;
		await this.refreshStats();
		// Tasks whose first-work branch name was still coming when Kingu closed.
		for (const t of this.list) if (t.auto_name) void this.autoNameBranch(t.slug);
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
			// kingu.git.compareAgainstUpstream (Orca): the base's upstream (origin/main) when it has one.
			const upstream = settings.get<boolean>('kingu.git.compareAgainstUpstream') === true ? await invoke<string | null>('git_base_upstream', { base: meta.base }).catch(() => null) : null;
			const stat = await invoke<DiffStat>('worktree_diff_stat', { slug, base: upstream ?? meta.base });
			this.stats[slug] = stat;
			delete this.statErrors[slug];
			const accepted = pruneAccepted(meta.accepted, stat.files);
			const accepted_hunks = pruneAcceptedHunks(meta.accepted_hunks, stat.files);
			if (accepted.length !== meta.accepted.length || !sameMarks(meta.accepted_hunks, accepted_hunks)) await this.#patch(slug, { accepted, accepted_hunks });
			return stat;
		} catch (e) {
			this.statErrors[slug] = String(e);
			delete this.stats[slug];
		}
	}

	/** Writes of ours still queued; the stored list comes back only when the last one lands. */
	#pending = 0;

	/**
	 * Sends `changes` (not the whole list): Rust applies them to tasks.json as it is on disk under
	 * one lock per file, so another window's (or a later Kingu's) edits to other tasks and fields
	 * are kept, and returns the stored list, which this window then shows.
	 */
	#write(changes: TaskChange[]): Promise<void> {
		if (!changes.length) return this.#saving;
		const root = this.#root;
		const payload = $state.snapshot(changes) as TaskChange[];
		this.#pending++;
		this.#saving = this.#saving.then(async () => {
			try {
				const stored = await invoke<TaskMeta[]>('tasks_update', { changes: payload });
				if (this.#pending === 1 && this.#root === root) this.list = stored;
			} catch (e) {
				notifications.error(t('adeTasks.tasks.saveFailed', { error: String(e) }));
				clientLog('error', `tasks_update: ${e}`);
			} finally {
				this.#pending--;
			}
		});
		return this.#saving;
	}

	#save(next: TaskMeta[]): Promise<void> {
		const changes = taskChanges(this.list, next);
		this.list = next;
		return this.#write(changes);
	}

	/** A PR created for the task outside its Review page (Source Control's composer). */
	linkPr(slug: string, url: string) {
		return this.#patch(slug, { pr_url: url || null });
	}

	/** Only these fields of the task are written: another window's edits to its other fields stay. */
	#patch(slug: string, patch: Partial<Omit<TaskMeta, 'slug'>>) {
		const meta = this.list.find((t) => t.slug === slug);
		if (!meta) return this.#saving;
		const now = Date.now();
		// Every session the task runs is kept for Continue Session… (sessionHistory.ts).
		if (patch.session_id && !patch.sessions) {
			const sessions = withSession(meta.sessions, patch.session_id, patch.agent ?? meta.agent, now);
			if (JSON.stringify(sessions) !== JSON.stringify(meta.sessions ?? [])) patch = { ...patch, sessions };
		}
		this.list = patchTask(this.list, slug, patch, now);
		return this.#write([patchChange(slug, patch, now)]);
	}

	async #step<T>(slug: string, label: string, f: () => Promise<T>): Promise<T | undefined> {
		this.busy[slug] = label;
		try {
			return await f();
		} catch (e) {
			notifications.error(t('adeTasks.tasks.stepFailed', { step: label, error: String(e) }));
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
	 * `open: false` (automations) leaves the user's view alone.
	 */
	/** `slugHint`: the branch name to start from when the title has no Latin letters (e.g. an automation id).
	 *  `slug`: the whole branch name base instead (made unique). `issue`: the GitHub issue it comes from. */
	async create(input: {
		title: string;
		prompt: string;
		base: string;
		mode?: RunMode;
		open?: boolean;
		slugHint?: string;
		slug?: string;
		issue?: IssueLink;
		/** `automation`: an automation started it (kingu.sidebar.hideAutomationTasks). */
		origin?: 'automation';
		/** Composer attachments: image blocks for a timeline run, path references for a CLI. */
		attachments?: Attachment[];
		/** Where the branch comes from: a new one from `base` (default), an existing branch, or a PR. */
		source?: TaskSource;
		/** Best-of-N (attempts.svelte.ts): the attempts' group and this one's model. */
		group?: string;
		model?: string;
		/** Stacked worktrees: the task whose branch `base` is. */
		parent?: string;
	}): Promise<string | undefined> {
		const title = input.title.trim();
		if (!title || !workspace.root) return;
		const source = input.source ?? { kind: 'new' };
		const taken = new Set([...this.list.map((t) => t.slug), ...this.worktrees.map((w) => w.slug ?? '')]);
		const slug = uniqueSlug(input.slug ?? (input.slugHint ? `${input.slugHint} ${title}` : title), taken);
		// A branch or PR you start from may need no instructions yet: its agent then starts without a prompt.
		const prompt = input.prompt.trim() || (source.kind === 'new' ? title : '');
		// Without a pick, fork from kingu.worktree.baseBranch or the folder's current branch (so merging back has a branch).
		const base = input.base || this.defaultBase() || status.branch || 'HEAD';
		const mode = input.mode ?? (settings.get<RunMode>('kingu.agent.runMode') === 'timeline' ? 'timeline' : 'terminal');
		const configured = mode === 'terminal' ? agentCommand((k) => settings.get<string>(k)) : null;
		// An attempt's model goes into its command, so a resume keeps it.
		const cli = configured && input.model ? withModel(configured, input.model) : configured;
		if (mode === 'terminal' && !cli) {
			status.flash(t('adeTasks.tasks.badCli'), 10000);
			return;
		}
		const prefix = branchPrefix(settings.get<string>('kingu.worktree.branchPrefix'));
		if (prefix === null) {
			status.flash(t('adeTasks.tasks.badBranchPrefix'), 10000);
			return;
		}
		// A base checked out in a task worktree whose agent works is left alone unless the user says so.
		const refresh = source.kind === 'new' && !input.parent && settings.get<boolean>('kingu.worktree.refreshBaseOnCreate') === true && base !== 'HEAD';
		if (refresh && (await this.#agentIdleOrConfirmed(null, base, t('adeTasks.tasks.step.refreshBase', { base })))) {
			const note = await invoke<string | null>('worktree_refresh_base', { base }).catch((e) => t('adeTasks.tasks.refreshBaseFailed', { base, error: String(e) }));
			if (note) status.flash(note, 8000);
		}
		let pr: PrHead | null = null;
		try {
			if (source.kind === 'branch') await invoke<WorktreeInfo>('worktree_create_from_branch', { slug, branch: source.branch });
			else if (source.kind === 'pr') pr = (await invoke<{ worktree: WorktreeInfo; pr: PrHead }>('worktree_create_from_pr', { slug, pr: source.pr })).pr;
			else await invoke<WorktreeInfo>('worktree_create', { slug, base, prefix, branch: issueBranchLeaf(slug, input.issue) });
		} catch (e) {
			notifications.error(t('adeTasks.tasks.createWorktreeFailed', { error: String(e) }));
			return;
		}
		// Orca's autoRenameBranchFromWork: only a branch Kingu named from the title (not an issue's, a PR's or one you picked).
		// Attempts keep their `-a`, `-b` branches, so they read as one group.
		const autoName = source.kind === 'new' && !input.slug && !input.group && settings.get<boolean>('kingu.worktree.autoRenameBranch') !== false && aiTextEnabled();
		const task = newTask(
			{
				slug,
				title,
				prompt,
				base,
				agent: cli ? cliAgent(cli) : undefined,
				issue: input.issue,
				origin: input.origin,
				prUrl: pr?.url || undefined,
				autoName,
				status: prompt || cli ? 'running' : 'review',
				group: input.group,
				model: input.model,
				parent: input.parent
			},
			Date.now()
		);
		await this.#save([...this.list, task]);
		const listed = await invoke<WorktreeInfo[]>('worktree_list').catch(() => this.listed);
		this.listed = listed;
		this.worktrees = listed.filter((w) => w.slug);
		if (input.open !== false) this.openTask(slug);
		const yaml = await this.#kinguYaml();
		// kingu.yaml worktree.sharedDirectories and kingu.repo.symlinkPaths (Orca): linked from the main checkout.
		await invoke<string[]>('worktree_link_shared', { slug }).catch((e) => clientLog('info', `link shared ${slug}: ${e}`));
		const marker = await this.#runSetup(slug, input.open !== false, yaml);
		await this.#openDefaultTabs(slug, input.open !== false, yaml);
		if (input.issue && isFolderGithub(input.issue)) await this.#runIssueCommand(slug, input.issue, input.open !== false);
		if (marker) await this.#waitForSetup(slug, marker);
		// After the prompt: claude's --mcp-config takes several values and would swallow it.
		const attachments = input.attachments ?? [];
		if (cli) await this.#launchCli(slug, cli, prompt ? { prompt: promptWithAttachments(prompt, attachments) } : { fresh: true });
		else if (prompt) {
			const message = composeMessage(prompt, attachments);
			await this.run(slug, message.text, message.images);
		}
		if (autoName) void this.autoNameBranch(slug);
		if (pr) void prStatuses.refresh(slug);
		return slug;
	}

	/** Branches being named, so a slow generation is not started twice. */
	#naming = new Set<string>();

	/**
	 * Orca's first-work branch rename: once the agent has its first prompt, the source-control AI
	 * (kingu.git.ai.*, read-only, in the worktree) names the branch from the work, and the branch is
	 * renamed when it was never pushed (Rust refuses otherwise). Any failure keeps the title's
	 * name; either way the task is settled and not tried again.
	 */
	async autoNameBranch(slug: string) {
		const meta = this.list.find((t) => t.slug === slug);
		const from = this.worktrees.find((w) => w.slug === slug)?.branch;
		if (!meta?.auto_name || !from || this.#naming.has(slug)) return;
		if (settings.get<boolean>('kingu.worktree.autoRenameBranch') === false || !aiTextEnabled()) return;
		this.#naming.add(slug);
		try {
			const prefix = branchPrefix(settings.get<string>('kingu.worktree.branchPrefix')) ?? '';
			const answer = await invoke<string>('ai_generate', { slug, prompt: branchNamePrompt(meta.prompt || meta.title, settings.get<string>('kingu.git.ai.branchNameInstructions')) });
			const leaf = branchSlug(answer, prefix);
			if (leaf && this.find(slug)) {
				const to = await invoke<string>('worktree_rename_branch', { slug, from, leaf, prefix });
				if (to !== from) {
					// Tasks stacked on it fork from (and open their PRs against) the new name.
					for (const c of this.list.filter((x) => x.parent === slug && x.base === from)) await this.#patch(c.slug, { base: to });
					status.flash(t('adeWorktrees.renamed', { from, to }), 6000);
					await this.refreshWorktrees();
				}
			}
		} catch (e) {
			clientLog('info', `auto-name branch of ${slug}: ${e}`);
		} finally {
			this.#naming.delete(slug);
		}
		await this.#patch(slug, { auto_name: false });
	}

	/** A task on the existing branch `branch` (local, `origin/x`, or only on origin), like Orca's "Reuse branch". */
	createFromBranch(branch: string, opts: { title?: string; prompt?: string; base?: string; mode?: RunMode } = {}) {
		return this.create({ title: opts.title?.trim() || branchTitle(branch), prompt: opts.prompt ?? '', base: opts.base ?? '', mode: opts.mode, source: { kind: 'branch', branch } });
	}

	/**
	 * A task on a GitHub pull request (number, link or one from `gh_pr_list`), compared against its
	 * base. When a task for the PR exists, offers to open it instead.
	 */
	async createFromPr(input: string | PrHead, opts: { title?: string; prompt?: string; base?: string; mode?: RunMode } = {}): Promise<string | undefined> {
		let pr: PrHead;
		try {
			pr = typeof input === 'string' ? await invoke<PrHead>('gh_pr_lookup', { input }) : input;
		} catch (e) {
			notifications.error(t('adeWorktrees.prLookupFailed', { error: String(e) }));
			return;
		}
		const existing = this.list.find((t) => t.pr_url === pr.url);
		if (existing) {
			const open = await ask(t('adeWorktrees.prTaskExists', { number: pr.number, title: existing.title }), { title: t('adeWorktrees.prTaskTitle'), okLabel: t('adeTasks.tasks.openExisting'), cancelLabel: t('common.cancel') });
			if (open) this.openTask(existing.slug);
			return;
		}
		const base = opts.base || (this.branches.includes(pr.base_ref) ? pr.base_ref : '');
		return this.create({ title: opts.title?.trim() || prTitle(pr), prompt: opts.prompt ?? '', base, mode: opts.mode, slug: `pr ${pr.number} ${pr.title}`, source: { kind: 'pr', pr: String(pr.number) } });
	}

	/** Palette: pick a branch to start a task on (branches checked out elsewhere are left out). */
	async pickBranchForTask() {
		const refs = await invoke<BranchRef[]>('git_refs', {}).catch((e) => {
			notifications.error(e);
			return null;
		});
		if (!refs) return;
		const items = branchChoices(refs)
			.filter((b) => !b.busy)
			.map((b) => ({ id: b.name, label: b.name, description: b.remote ? t('adeWorktrees.remoteBranch') : undefined }));
		const item = await quick.choose({ placeholder: t('adeWorktrees.pickBranch'), items });
		if (item) await this.createFromBranch(item.id);
	}

	/** Palette: the open PRs, or a typed number or link. */
	async pickPrForTask() {
		if ((await this.checkGh())?.provider === 'gitlab') return void status.flash(t('forge.prStart.notOnGitlab'), 8000);
		let prs: PrHead[] = [];
		try {
			prs = await invoke<PrHead[]>('gh_pr_list', { limit: 50 });
		} catch (e) {
			status.flash(t('adeWorktrees.prListFailed', { error: String(e) }), 8000);
		}
		const row = (p: PrHead) => ({ id: String(p.number), label: prTitle(p), description: `${p.head_ref}${p.cross_repo ? ` · ${p.head_owner}` : ''}${p.draft ? ` · ${t('adeWorktrees.draft')}` : ''}` });
		const item = await quick.choose({
			placeholder: t('adeWorktrees.pickPr'),
			items: [],
			dynamic: (value) => {
				const q = value.trim().toLowerCase();
				const typed = looksLikePr(value) && !prs.some((p) => String(p.number) === q.replace('#', '')) ? [{ id: value.trim(), label: t('adeWorktrees.usePr', { pr: value.trim() }) }] : [];
				return [...typed, ...prs.filter((p) => !q || prTitle(p).toLowerCase().includes(q) || p.head_ref.toLowerCase().includes(q)).map(row)];
			}
		});
		if (!item) return;
		await this.createFromPr(prs.find((p) => String(p.number) === item.id) ?? item.id);
	}

	/**
	 * The worktree list again without resetting anything (Rust's git watcher: a branch switched,
	 * a commit, a worktree added or removed outside Kingu). A task whose branch changed reads its
	 * PR again (PRs are found by branch); one whose commit moved, its diff stats.
	 */
	async refreshWorktrees() {
		const root = this.#root;
		if (!root) return;
		const listed = await invoke<WorktreeInfo[]>('worktree_list').catch(() => null);
		if (!listed || this.#root !== root) return;
		const before = new Map(this.listed.map((w) => [w.path, w]));
		this.listed = listed;
		this.worktrees = listed.filter((w) => w.slug);
		listed.forEach((w, i) => {
			const old = before.get(w.path);
			// The folder's own PR is keyed '' (the first entry is the main checkout).
			const key = w.slug ?? (i === 0 ? '' : null);
			if (!old || key === null) return;
			if (old.branch !== w.branch && prStatuses.bySlug[key]) void prStatuses.refresh(key);
			if (old.head !== w.head && w.slug && this.list.some((t) => t.slug === w.slug)) void this.refreshStat(w.slug);
		});
		void this.refreshBranches();
	}

	/** The open folder's kingu.yaml; its problems are reported once per folder (the file is then ignored or partly used). */
	#yamlReported = new Set<string>();
	async #kinguYaml(): Promise<KinguYamlStatus | null> {
		const st = await invoke<KinguYamlStatus>('kingu_yaml').catch((e) => {
			clientLog('info', `kingu_yaml: ${e}`);
			return null;
		});
		const root = workspace.root ?? '';
		if (st && !this.#yamlReported.has(root) && (st.error || st.config?.warnings.length)) {
			this.#yamlReported.add(root);
			if (st.error) notifications.warn(t('adeTasks.tasks.yamlIgnored', { error: st.error }));
			else notifications.warn(t('adeTasks.tasks.yamlPartial', { warnings: st.config!.warnings.slice(0, 5).join('; ') }));
		}
		return st;
	}

	/**
	 * What may run for `kind` (Rust `scripts::plan`): the repository's text (kingu.yaml, or the older
	 * `.kingu/<kind>.sh`) needs your trust in exactly this content, like a repo snap (Orca asks the
	 * same way); your own per-repository script (kingu.repo.*) does not. `ask: true`
	 * (kingu.worktree.setupScript = ask) confirms even a trusted one. `interactive: false`
	 * (automations) never asks and skips anything untrusted. Returns the plan when it may run, else null.
	 */
	async #approvedPlan(kind: ScriptKind, opts: { interactive: boolean; ask?: boolean; what: string }): Promise<ScriptPlan | null> {
		const plan = await invoke<ScriptPlan | null>('worktree_script', { kind }).catch((e) => {
			notifications.error(t('adeTasks.tasks.readScriptFailed', { kind, error: String(e) }));
			return null;
		});
		if (!plan) return null;
		const shared = plan.shared;
		const untrusted = !!shared && !shared.trusted;
		if (!untrusted && !opts.ask) return plan;
		if (!opts.interactive) {
			if (untrusted) notifications.warn(t('adeTasks.tasks.scriptNotTrusted', { path: shared!.path }));
			return untrusted ? null : plan;
		}
		const parts = [
			...(shared ? [t(untrusted ? 'adeTasks.tasks.scriptSharedUntrusted' : 'adeTasks.tasks.scriptShared', { path: shared.path, preview: scriptPreview(shared.content) })] : []),
			...(plan.local ? [t('adeTasks.tasks.scriptLocal', { preview: scriptPreview(plan.local) })] : [])
		];
		const intro = t(untrusted ? 'adeTasks.tasks.introUntrusted' : 'adeTasks.tasks.introTrusted', { where: opts.what });
		const ok = await ask(`${intro}\n\n${parts.join('\n\n')}${untrusted ? `\n\n${t('adeTasks.tasks.trustQuestion')}` : ''}`, {
			title: scriptTitle(kind),
			kind: 'warning',
			okLabel: untrusted ? t('adeTasks.tasks.trustAndRun') : t('common.run'),
			cancelLabel: t('adeTasks.tasks.dontRun')
		});
		if (!ok) return null;
		if (untrusted) {
			try {
				await invoke('worktree_script_trust', { kind, trusted: true, hash: shared!.hash });
			} catch (e) {
				notifications.error(e);
				return null;
			}
		}
		return plan;
	}

	/**
	 * The setup (`kingu.worktree.setupScript`) in a background "Setup" terminal of the new worktree
	 * (Orca's new-tab mode). Returns the file its exit status goes to when the agent waits for it
	 * (`kingu.worktree.setupAgentStartup`, else kingu.yaml setupAgentStartupPolicy).
	 */
	async #runSetup(slug: string, interactive: boolean, yaml: KinguYamlStatus | null): Promise<string | null> {
		const root = workspace.root;
		const policy = setupPolicy(settings.get<string>('kingu.worktree.setupScript'));
		if (!root || policy === 'off') return null;
		const plan = await this.#approvedPlan('setup', { interactive, ask: policy === 'ask', what: t('adeTasks.tasks.where.setup') });
		if (!plan) return null;
		try {
			const file = await invoke<string | null>('worktree_script_prepare', { kind: 'setup' });
			if (!file) return null;
			const startup = agentStartup(settings.get<string>('kingu.worktree.setupAgentStartup'), settings.sourceOf('kingu.worktree.setupAgentStartup') !== 'default', yaml?.config?.setupAgentStartupPolicy);
			const marker = startup === 'wait-for-setup' ? await invoke<string>('worktree_setup_marker', { slug }) : undefined;
			adeLayout.newTerminal(slug, { title: 'Setup', run: setupCommand(file, root, `${root}/${worktreeDir(slug)}`, slug, marker), background: true });
			return marker ?? null;
		} catch (e) {
			notifications.error(t('adeTasks.tasks.setupRunFailed', { error: String(e) }));
			return null;
		}
	}

	/** Orca's wait-for-setup: the agent starts once the Setup terminal finished (at most 30 minutes). */
	async #waitForSetup(slug: string, marker: string) {
		const until = Date.now() + 30 * 60_000;
		this.busy[slug] = t('adeTasks.tasks.busy.waitingSetup');
		try {
			while (Date.now() < until && this.find(slug)) {
				const code = await invoke<number | null>('worktree_setup_status', { marker }).catch(() => null);
				if (code !== null) {
					if (code !== 0) notifications.warn(t('adeTasks.tasks.setupExited', { slug, code }));
					return;
				}
				await new Promise((r) => setTimeout(r, 1000));
			}
		} finally {
			delete this.busy[slug];
		}
	}

	/** kingu.yaml `defaultTabs` (Orca): terminal tabs made once for a new worktree; their commands need your trust. */
	async #openDefaultTabs(slug: string, interactive: boolean, yaml: KinguYamlStatus | null) {
		const tabs = yaml?.config?.defaultTabs ?? [];
		if (!tabs.length) return;
		const withCommands = tabs.some((t) => t.command);
		const plan = withCommands ? await this.#approvedPlan('tabs', { interactive, what: t('adeTasks.tasks.where.tabs') }) : null;
		for (const t of defaultTabsToOpen(tabs, plan?.shared?.content ?? null)) adeLayout.newTerminal(slug, { ...t, background: true });
	}

	/** Orca's issue command: kingu.repo.issueCommand, else kingu.yaml issueCommand (trusted), in a terminal of an issue's task. */
	async #runIssueCommand(slug: string, issue: IssueLink, interactive: boolean) {
		const plan = await this.#approvedPlan('issue', { interactive, what: t('adeTasks.tasks.where.issue', { number: issue.number }) });
		const command = plan?.local ?? plan?.shared?.content;
		if (!command?.trim()) return;
		adeLayout.newTerminal(slug, { title: `#${issue.number}`, run: issueCommandArgv(command, issue.number, issue.url), background: true });
	}

	/**
	 * Orca's archive script: `.kingu/archive.sh` in the worktree before it is removed. False when
	 * it failed and you chose to keep the worktree.
	 */
	async #runArchive(slug: string): Promise<boolean> {
		if (settings.get<string>('kingu.worktree.archiveScript') === 'off') return true;
		const plan = await this.#approvedPlan('archive', { interactive: true, what: t('adeTasks.tasks.where.archive') });
		if (!plan) return true;
		const script = { path: plan.shared?.path ?? t('adeTasks.tasks.yourArchiveScript') };
		this.busy[slug] = t('adeTasks.tasks.busy.running', { path: script.path });
		try {
			const r = await invoke<ScriptRun | null>('worktree_archive_run', { slug });
			if (!r || (r.code === 0 && !r.timed_out)) return true;
			return await ask(t('adeTasks.tasks.archiveResult', { path: script.path, summary: scriptRunSummary(r), output: r.output.trim().slice(-1500) }), {
				title: scriptTitle('archive'),
				kind: 'warning',
				okLabel: t('adeTasks.tasks.deleteAnyway'),
				cancelLabel: t('common.cancel')
			});
		} catch (e) {
			return await ask(t('adeTasks.tasks.archiveRunFailed', { path: script.path, error: String(e) }), { title: scriptTitle('archive'), kind: 'warning', okLabel: t('adeTasks.tasks.deleteAnyway'), cancelLabel: t('common.cancel') });
		} finally {
			delete this.busy[slug];
		}
	}

	/**
	 * A task for a GitHub issue: the prompt carries the issue (with its latest comments when
	 * `gh issue view` answers) and asks for "Fixes #N"; the branch is `kingu/issue-<n>-<words>`.
	 * When a task for the issue already exists, offers to open it instead of starting another.
	 */
	async createFromIssue(issue: Issue, opts: { base: string; mode?: RunMode }): Promise<string | undefined> {
		const existing = taskForIssue(this.list, issue.number);
		if (existing) {
			const open = await ask(t('adeTasks.tasks.issueTaskExists', { number: issue.number, title: existing.title, branch: this.branchOf(existing.slug) }), {
				title: t('adeTasks.tasks.issueTaskTitle'),
				okLabel: t('adeTasks.tasks.openExisting'),
				cancelLabel: t('common.cancel')
			});
			if (open) this.openTask(existing.slug);
			return;
		}
		const detail = await invoke<IssueDetail>('gh_issue_view', { number: issue.number }).catch((e) => {
			clientLog('info', `gh_issue_view #${issue.number}: ${e}`);
			return issue;
		});
		return this.create({
			title: issueTaskTitle(issue),
			prompt: issuePrompt(detail),
			base: opts.base,
			mode: opts.mode,
			slug: issueSlug(issue),
			issue: issueLink(issue)
		});
	}

	/**
	 * A task for a Linear issue: like `createFromIssue`, with the description and latest comments
	 * from Linear, "Fixes ENG-123", and a branch `kingu/eng-123-<words>` that Linear links to the PR.
	 */
	async createFromLinearIssue(issue: LinearIssue, opts: { base: string; mode?: RunMode }): Promise<string | undefined> {
		const existing = taskForLinearIssue(this.list, issue.identifier);
		if (existing) {
			const open = await ask(t('adeTasks.tasks.linearTaskExists', { id: issue.identifier, title: existing.title, branch: this.branchOf(existing.slug) }), {
				title: t('adeTasks.tasks.linearTaskTitle'),
				okLabel: t('adeTasks.tasks.openExisting'),
				cancelLabel: t('common.cancel')
			});
			if (open) this.openTask(existing.slug);
			return;
		}
		const detail = await invoke<LinearIssueDetail>('linear_issue_view', { id: issue.identifier }).catch((e) => {
			clientLog('info', `linear_issue_view ${issue.identifier}: ${e}`);
			return issue;
		});
		return this.create({
			title: linearTaskTitle(issue),
			prompt: linearPrompt(detail),
			base: opts.base,
			mode: opts.mode,
			slug: linearSlug(issue),
			issue: linearLink(issue)
		});
	}

	/**
	 * Agent hibernation (hibernation.svelte.ts): closes the task's idle agent CLI to free its
	 * process; the task remembers it, and `resumeCli` continues its session with one click.
	 */
	async hibernate(slug: string) {
		if (!cliSessions.has(slug)) return;
		cliSessions.end(slug);
		await this.#patch(slug, { hibernated_at: Date.now() });
	}

	/** Pick winner (attempts.svelte.ts): the attempt leaves its best-of-N group and stays as a task of its own. */
	leaveGroup(slug: string) {
		return this.#patch(slug, { group: null });
	}

	/** After a restart: start the task's CLI again in its worktree, continuing its latest session where the CLI can. */
	async resumeCli(slug: string, fresh = false) {
		const meta = this.list.find((t) => t.slug === slug);
		const cli = meta && cliOf(meta.agent);
		if (!cli) return;
		await this.#launchCli(slug, cli, fresh ? { fresh: true } : { resume: meta.session_id });
	}

	/**
	 * Starts the task's CLI in its worktree terminal the way its profile says (agentProfiles.ts):
	 * claude gets a session id we choose (saved, so a restart resumes exactly it) and hooks
	 * reporting its state; codex a notify program reporting finished turns and its session id;
	 * others run as configured, with the Snap MCP servers where the CLI takes them.
	 */
	async #launchCli(slug: string, cli: string[], how: { prompt: string } | { resume: string | null } | { fresh: true }) {
		const root = workspace.root ? `${workspace.root}/${worktreeDir(slug)}` : null;
		const profile = profileOf(cli);
		const token = crypto.randomUUID();
		const hookSettings =
			profile.status === 'hooks'
				? await invoke<string>('agent_hook_settings', { token }).catch((e) => {
						clientLog('error', `agent hooks for ${slug}: ${e}`);
						return null;
					})
				: null;
		const hookFile =
			profile.status === 'notify' || profile.status === 'agent-hooks'
				? await invoke<string>('agent_hook_file', { token }).catch((e) => {
						clientLog('error', `agent status file for ${slug}: ${e}`);
						return null;
					})
				: null;
		// Orca's managed agent hooks: the CLI's status hooks are in place before it starts.
		let opencodeDir: string | null = null;
		if (hookFile && settings.get<boolean>('kingu.agent.statusHooks') !== false) {
			opencodeDir = await invoke<string | null>('agent_status_hooks_install', { agent: profile.id, program: programOf(cli) }).catch((e) => {
				status.flash(t('adeTasks.tasks.hooksFailed', { agent: profile.title, error: String(e) }), 8000);
				return null;
			});
		}
		// Orca's trust presets: the CLI's first-run "trust this folder?" prompt would swallow the prompt.
		if (settings.get<boolean>('kingu.agent.trustWorkspace') !== false)
			await invoke('agent_trust_workspace', { slug, program: programOf(cli) }).catch((e) => clientLog('info', `trust ${slug}: ${e}`));
		const sessionId = profile.ownsSessionId && !('resume' in how) ? crypto.randomUUID() : undefined;
		// Orca's agentCmdOverrides / agentDefaultEnv / claudeAgentTeamsMode (user settings only).
		const options = launchOptions(profile.id, (k) => settings.get(k));
		if (typeof options === 'string') {
			notifications.error(options);
			return;
		}
		const launch = profile.launch(cli, how, { sessionId, hookSettings, hookFile, opencodeDir, servers: mcpServers(root), plugins: profile.skills ? await skillPlugins() : [] });
		if (sessionId) await this.#patch(slug, { session_id: sessionId });
		// A hibernated CLI (hibernation.svelte.ts) is awake again.
		if (this.list.find((t) => t.slug === slug)?.hibernated_at) await this.#patch(slug, { hibernated_at: null });
		cliSessions.start(slug, withLaunchOptions(launch.argv, options), hookSettings || hookFile ? token : undefined, launch.typePrompt);
	}

	/** A CLI reported its session id (codex notify): saved so a restart resumes exactly it. */
	learnCliSession(slug: string, id: string) {
		const meta = this.list.find((t) => t.slug === slug);
		const cli = meta && cliOf(meta.agent);
		if (cli && profileOf(cli).status === 'notify' && meta.session_id !== id) void this.#patch(slug, { session_id: id });
	}

	/** Moves the task to a board column (Orca's Move to Status); the agent's own status is untouched. */
	async setWorkflowStatus(slug: string, id: string, quiet = false) {
		const meta = this.list.find((t) => t.slug === slug);
		if (!meta || meta.workflow_status === id) return;
		await this.#patch(slug, { workflow_status: id });
		if (!quiet) status.flash(t('adeWorkflow.moved', { title: meta.title, status: workflowLabel(id) }));
	}

	/**
	 * Continue Session… (Orca's agent session continuation): picks an earlier session of the task
	 * up again. A CLI task restarts its CLI resuming it; a timeline task resumes it with the next
	 * message. A session the task's agent cannot resume (another CLI's) is handed off instead.
	 */
	async continueSession(slug: string, session: SessionRef) {
		const meta = this.list.find((t) => t.slug === slug);
		if (!meta) return;
		const cli = cliOf(meta.agent);
		if (!canResumeWith(meta.agent, session.agent)) return this.handOff(slug, session, cli);
		if (runtime.isWorking(slug) || cliSessions.working(slug)) return status.flash(t('adeWorkflow.stopFirst', { title: meta.title }));
		if (cli) {
			await this.#patch(slug, { session_id: session.id });
			status.flash(t('adeWorkflow.resuming', { id: session.id.slice(0, 8), agent: programOf(cli) }));
			await this.#launchCli(slug, cli, { resume: session.id });
			return;
		}
		if (runtime.isLive(slug)) await this.stop(slug);
		await this.#patch(slug, { session_id: session.id });
		status.flash(t('adeWorkflow.nextMessageResumes', { id: session.id.slice(0, 8) }));
	}

	/**
	 * Hand Off to Another Agent (Orca's AgentSessionContinuationDialog): starts `cli` (or the
	 * timeline agent for null) in the task's worktree with a prompt pointing at the session's
	 * transcript; the task's agent becomes that one.
	 */
	async handOff(slug: string, session: SessionRef, cli: string[] | null) {
		const meta = this.list.find((t) => t.slug === slug);
		if (!meta || !workspace.root) return;
		if (runtime.isWorking(slug) || cliSessions.working(slug)) return status.flash(t('adeWorkflow.stopFirst', { title: meta.title }));
		const prompt = handOffPrompt({ agent: session.agent, id: session.id, cwd: `${workspace.root}/${worktreeDir(slug)}`, title: meta.title, prompt: meta.prompt, summary: meta.last_run?.summary });
		if (cli) {
			await this.#patch(slug, { agent: cliAgent(cli) });
			await this.#launchCli(slug, cli, { prompt });
		} else {
			if (runtime.isLive(slug)) await this.stop(slug);
			cliSessions.end(slug);
			await this.#patch(slug, { agent: 'claude-code', session_id: null });
			await this.run(slug, prompt);
		}
		status.flash(t('adeWorkflow.handedOff', { title: meta.title, agent: cli ? programOf(cli) : 'Claude' }));
	}

	/** Starts the agent in the task worktree through the agents store. */
	async run(slug: string, prompt: string, images: string[] = []) {
		try {
			await runtime.start(slug, prompt, null, images, this.list.find((t) => t.slug === slug)?.attempt_model ?? null);
			await this.#patch(slug, { status: 'running' });
		} catch (e) {
			notifications.error(t('adeTasks.tasks.startAgentFailed', { error: String(e) }));
			await this.#patch(slug, { status: 'failed' });
		}
	}

	/** Follow-up message: into the open session, else resuming the task's session (saved in tasks.json). */
	async followUp(slug: string, text: string, attachments: Attachment[] = []): Promise<boolean> {
		const meta = this.list.find((t) => t.slug === slug);
		if (!meta || !text.trim()) return false;
		const message = composeMessage(text, attachments);
		try {
			await runtime.followUp(slug, message.text, meta.session_id, message.images, meta.attempt_model ?? null);
			if (meta.status !== 'running') await this.#patch(slug, { status: 'running' });
			return true;
		} catch (e) {
			notifications.error(t('adeTasks.tasks.sendMessageFailed', { error: String(e) }));
			return false;
		}
	}

	/** Starts the task's CLI again in its worktree with `prompt` (Orca's "New agent" for review notes). */
	async startCliWith(slug: string, prompt: string): Promise<boolean> {
		const meta = this.list.find((t) => t.slug === slug);
		const cli = meta && cliOf(meta.agent);
		if (!cli) return false;
		await this.#launchCli(slug, cli, { prompt });
		return true;
	}

	answer(slug: string, requestId: string, decision: Decision, message?: string, answers?: Record<string, string>) {
		return runtime.answer(slug, requestId, decision, message, answers).catch((e) => notifications.error(t('adeTasks.tasks.answerFailed', { error: String(e) })));
	}

	/** Stops the current turn; the session stays open for follow-ups. */
	interrupt(slug: string) {
		return runtime.interrupt(slug).catch((e) => notifications.error(e));
	}

	/** Ends the run (continue later with a follow-up, which resumes the session). */
	stop(slug: string) {
		return runtime.stop(slug).catch((e) => notifications.error(e));
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
			const summary = runSummary(run, Date.now(), run.startedAt);
			if (!sameSummary(summary, meta.last_run)) patch.last_run = summary;
		}
		if (Object.keys(patch).length) void this.#patch(slug, patch);
		if (rt.status === 'review' || rt.status === 'failed') void this.refreshStat(slug);
	}

	/** The branch removal a task gets by default (`kingu.worktree.deleteBranchOnRemove`, merged or not). */
	defaultBranchRemoval(slug: string): BranchRemoval {
		const meta = this.list.find((t) => t.slug === slug);
		const merged = !!meta?.merged_at || prStatuses.bySlug[slug]?.pr?.state === 'MERGED';
		return branchRemoval(settings.get<string>('kingu.worktree.deleteBranchOnRemove'), { merged });
	}

	hasWorktree(slug: string): boolean {
		return this.worktrees.some((w) => w.slug === slug);
	}

	/**
	 * Remove a task: the remove dialog (Orca's Delete Workspace: changes, branch choice, "don't ask
	 * again"), or straight away when kingu.worktree.confirmRemove is off.
	 */
	async remove(slug: string) {
		// A dead agent never blocks this: its status ends with its process (agentPresence.ts).
		if (removalGate(runtime.timelineWorking(slug), false) === 'block') {
			status.flash(t('adeTasks.tasks.stopAgentFirst'));
			return;
		}
		if (settings.get<boolean>('kingu.worktree.confirmRemove') !== false) adeDialogs.open({ kind: 'remove', slug });
		else await this.removeConfirmed(slug, { deleteBranch: this.defaultBranchRemoval(slug), force: false });
	}

	/**
	 * Removes the worktree (the branch per `deleteBranch`) and forgets the task. `force`: the user
	 * saw the uncommitted changes in the dialog and removes them too; without it a dirty worktree
	 * still asks. False when nothing was removed.
	 */
	async removeConfirmed(slug: string, opts: { deleteBranch: BranchRemoval; force: boolean }): Promise<boolean> {
		if (this.#removing.has(slug)) {
			status.flash(t('adeWorkflow.alreadyRemoving', { slug }));
			return false;
		}
		const gate = removalGate(runtime.timelineWorking(slug), runtime.isWorking(slug));
		if (gate === 'block') {
			status.flash(t('adeTasks.tasks.stopAgentFirst'));
			return false;
		}
		// An agent working in one of the task's terminals ends with them: ask first.
		if (gate === 'confirm' && !(await ask(t('adeTasks.tasks.terminalAgentAsk'), { title: t('adeTasks.tasks.terminalAgentTitle'), kind: 'warning', okLabel: t('adeTasks.tasks.stopAndRemove'), cancelLabel: t('common.cancel') }))) return false;
		const path = worktreeDir(slug);
		const hasWorktree = this.hasWorktree(slug);
		const deleteBranch = opts.deleteBranch;
		// kingu.worktree.alwaysForceDelete (Orca): uncommitted changes go without asking again.
		opts = { ...opts, force: opts.force || settings.get<boolean>('kingu.worktree.alwaysForceDelete') === true };
		let kept: string | null = null;
		// Unsaved editors of the task (its worktree files, an edited diff) would be lost with it: ask.
		const tabs = tabsOfTask(
			editors.allTabs().map((t) => t.path),
			slug,
			(p) => parseTaskDiffKey(p)?.slug
		);
		const unsaved = tabs.filter((p) => editors.isDirty(p));
		if (unsaved.length) {
			const go = await ask(t('adeTasks.tasks.removeUnsavedAsk', { slug, count: unsaved.length }), {
				title: t('adeTasks.tasks.removeUnsavedTitle'),
				kind: 'warning',
				okLabel: t('adeTasks.tasks.removeUnsavedOk'),
				cancelLabel: t('common.cancel')
			});
			if (!go) return false;
		}
		if (hasWorktree) {
			// An idle session still runs in the worktree: end it with the task.
			if (runtime.isLive(slug)) await this.stop(slug);
			if (!(await this.#runArchive(slug))) return false;
		}
		// Also without a worktree git lists: Rust prunes a folder deleted by hand and finds one git lost track of.
		{
			// Orca's background removal: the card shows "Removing…" while git deletes the folder
			// (Rust runs it off the main thread), and a second remove of it waits for this one.
			const remove = async (force: boolean) => {
				this.#removing.add(slug);
				this.busy[slug] = t('adeWorkflow.removing');
				try {
					return await invoke<string | null>('worktree_remove', { slug, force, deleteBranch });
				} finally {
					this.#removing.delete(slug);
					delete this.busy[slug];
				}
			};
			try {
				kept = await remove(opts.force);
			} catch (e) {
				const dirty = /modified|untracked|dirty/i.test(String(e));
				// Git lost track of the folder (Rust `RemoveOrphan`): deleting it needs a yes, forced or not.
				const orphan = isRustError(e, 'worktreeOrphan');
				if (!orphan && (!dirty || opts.force)) {
					notifications.error(t('adeTasks.tasks.removeFailed', { error: String(e) }));
					return false;
				}
				const force = orphan
					? await ask(t('adeWorkflow.orphanAsk', { path }), { title: t('adeWorkflow.orphanTitle'), kind: 'warning', okLabel: t('adeWorkflow.orphanOk'), cancelLabel: t('common.cancel') })
					: await ask(t('adeTasks.tasks.dirtyAsk', { path }), { title: t('adeTasks.tasks.dirtyTitle'), kind: 'warning', okLabel: t('adeTasks.tasks.discard'), cancelLabel: t('common.cancel') });
				if (!force) return false;
				try {
					kept = await remove(true);
				} catch (e2) {
					notifications.error(t('adeTasks.tasks.removeFailed', { error: String(e2) }));
					return false;
				}
			}
		}
		if (!hasWorktree && runtime.isLive(slug)) await this.stop(slug);
		runtime.forget(slug);
		cliSessions.end(slug);
		diffNotes.forget(slug);
		// The user saw (and accepted) the unsaved ones above; the files are gone with the worktree.
		for (const p of tabs) editors.closeEverywhere(p);
		this.worktrees = this.worktrees.filter((w) => w.slug !== slug);
		this.listed = this.listed.filter((w) => w.slug !== slug);
		delete this.stats[slug];
		delete this.statErrors[slug];
		await this.#save(removeTask(this.list, slug));
		appMode.forget(slug);
		status.flash(kept ? t('adeTasks.tasks.removedKeptBranch', { slug, branch: kept }) : t('adeTasks.tasks.removed', { slug }), kept ? 10000 : undefined);
		return true;
	}

	// -------------------------------------------------------------------------------------------
	// Review

	toggleAccept(slug: string, path: string) {
		const accepted = toggleAccepted(this.list, slug, path, Date.now()).find((t) => t.slug === slug)?.accepted;
		return accepted ? this.#patch(slug, { accepted }) : this.#saving;
	}

	/** Accepted file and hunk marks from the hunkReview.ts reducers (saved like toggleAccept). */
	setReviewMarks(slug: string, marks: Pick<TaskMeta, 'accepted' | 'accepted_hunks'>) {
		return this.#patch(slug, marks);
	}

	/** Drops hunk marks of `path` that are not among its `live` hunk ids any more. */
	pruneHunkMarks(slug: string, path: string, live: string[]) {
		const meta = this.list.find((t) => t.slug === slug);
		const stat = this.stats[slug];
		if (!meta || !stat) return;
		const next = pruneAcceptedHunks(meta.accepted_hunks, stat.files, path, live);
		if (!sameMarks(meta.accepted_hunks, next)) return this.#patch(slug, { accepted_hunks: next });
	}

	/**
	 * Commit, reject, merge and refresh-base touch a task worktree (and, for merge and refresh, the
	 * checkout of `branch`). While an agent works there they ask first, with the native message
	 * box (VS Code's Agents window keeps a working session's worktree to the agent). True: go on.
	 */
	#agentIdleOrConfirmed(slug: string | null, branch: string | null, action: string): Promise<boolean> {
		return confirmAgentIdle(touchedTasks(slug, branch, this.worktrees), action);
	}

	/** Takes back hunks `ids` of `path` (no confirmation: one change at a time, like VS Code's Undo this Change). */
	async rejectHunks(slug: string, path: string, ids: string[]): Promise<boolean> {
		const stat = this.stats[slug];
		const meta = this.list.find((t) => t.slug === slug);
		if (!meta || !ids.length) return false;
		if (!(await this.#agentIdleOrConfirmed(slug, null, t('adeTasks.tasks.step.rejectChanges')))) return false;
		const n = await this.#step(slug, t('adeTasks.tasks.step.rejectChanges'), () => invoke<number>('worktree_reject_hunks', { slug, base: stat?.base ?? meta.base, path, ids }));
		await this.refreshStat(slug);
		return n !== undefined;
	}

	/** Restores files from the base after confirming; `paths` includes a rename's source. True when
	 * confirmed. `confirmEmpty`: ask even without paths (the caller then takes back hunks). */
	async reject(slug: string, paths: string[], label: string, confirmEmpty = false): Promise<boolean> {
		const meta = this.list.find((t) => t.slug === slug);
		if (!meta || (!paths.length && !confirmEmpty)) return false;
		if (!(await this.#agentIdleOrConfirmed(slug, null, t('adeTasks.tasks.step.rejectFiles')))) return false;
		const ok = await ask(t('adeTasks.tasks.rejectAsk', { label, slug, base: meta.base }), {
			title: t('adeTasks.tasks.rejectTitle'),
			kind: 'warning',
			okLabel: t('adeTasks.tasks.rejectOk'),
			cancelLabel: t('common.cancel')
		});
		if (!ok) return false;
		if (paths.length) {
			await this.#step(slug, t('adeTasks.tasks.step.rejectFiles'), () => invoke('worktree_reject', { slug, base: meta.base, paths }));
			await this.refreshStat(slug);
		}
		return true;
	}

	async commit(slug: string, msg: string) {
		if (!msg.trim()) {
			status.flash(t('adeTasks.git.commitMessageFirst'));
			return false;
		}
		if (!(await this.#agentIdleOrConfirmed(slug, null, t('adeTasks.tasks.step.commit')))) return false;
		const done = await this.#step(slug, t('adeTasks.tasks.step.commit'), () => invoke('worktree_commit', { slug, message: msg }).then(() => true));
		await this.refreshStat(slug);
		if (done) status.flash(t('adeTasks.git.committed', { branch: this.branchOf(slug) }));
		return !!done;
	}

	defaultCommitMessage(slug: string) {
		const meta = this.list.find((t) => t.slug === slug);
		return meta ? commitMessage(meta) : '';
	}

	async merge(slug: string, mode: 'ff' | 'merge') {
		const meta = this.list.find((t) => t.slug === slug);
		if (!meta) return;
		const how = mode === 'ff' ? t('adeTasks.tasks.mergeFastForward') : t('adeTasks.tasks.mergeCommit');
		if (!(await this.#agentIdleOrConfirmed(slug, meta.base, t('adeTasks.tasks.step.merge')))) return;
		const ok = await ask(t('adeTasks.tasks.mergeAsk', { branch: this.branchOf(slug), base: meta.base, how }), { title: t('adeTasks.tasks.mergeTitle'), okLabel: t('adeTasks.tasks.mergeOk'), cancelLabel: t('common.cancel') });
		if (!ok) return;
		const r = await this.#step(slug, t('adeTasks.tasks.step.merge'), () => invoke<MergeResult>('worktree_merge', { slug, base: meta.base, mode }));
		if (r) {
			await this.#patch(slug, { merged_at: Date.now(), status: 'done' });
			status.flash(t('adeTasks.tasks.merged', { base: meta.base, kind: r.fast_forward ? 'fast-forward' : 'merge commit', commit: r.commit.slice(0, 8) }), 8000);
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
		const title = ft('forge.create.title', forgeOf(gh));
		if (gh?.provider === 'gitlab' && !gh.authenticated) {
			await message(gh.detail, { title, kind: 'info' });
			return;
		}
		if (!gh?.installed) {
			await message(t('adeTasks.tasks.ghMissing'), { title, kind: 'info' });
			return;
		}
		if (!gh.authenticated) {
			await message(t('adeTasks.tasks.ghSignedOut', { detail: gh.detail }), { title, kind: 'info' });
			return;
		}
		adeDialogs.open({ kind: 'pr', slug });
	}

	/** The PR form's first values (Orca seeds them once per open): from the branch's commits and the task. */
	/** A PR description from `text` (a template or the agent's draft) with the task's `Fixes …` line. */
	prBodyFrom(slug: string, text: string): string {
		const meta = this.list.find((t) => t.slug === slug);
		return meta ? prBody({ slug, issue: meta.issue, prompt: text.trim() }) : text;
	}

	async prDefaults(slug: string): Promise<PrForm | null> {
		const meta = this.list.find((t) => t.slug === slug);
		if (!meta) return null;
		const commits = await invoke<Commit[]>('worktree_commits', { slug, base: meta.base }).catch((e) => {
			clientLog('info', `worktree_commits ${slug}: ${e}`);
			return [] as Commit[];
		});
		return prefillPr(meta, this.branchOf(slug), commits, settings.get<boolean>('kingu.pr.draft') === true);
	}

	/** Pushes the branch and opens the PR from the form; the error text when it failed (the form shows it). */
	async submitPr(slug: string, form: PrForm): Promise<string | null> {
		const meta = this.list.find((t) => t.slug === slug);
		if (!meta) return t('adeTasks.tasks.taskNotFound');
		const forge = forgeOf(this.gh);
		const problem = prFormProblem(form, this.branchOf(slug), forge);
		if (problem) return problem;
		this.busy[slug] = ft('forge.create.busy', forge);
		let url: string;
		try {
			url = await invoke<string>('worktree_pr_create', {
				slug,
				base: form.base.trim(),
				title: form.title.trim(),
				body: form.body,
				draft: form.draft,
				open: settings.get<boolean>('kingu.pr.openAfterCreate') === true,
				// Stacked worktrees: a PR into the parent task's branch pushes that branch first.
				stacked: isStackedBase(meta, form.base.trim(), (s) => (this.find(s) ? this.branchOf(s) : null))
			});
		} catch (e) {
			clientLog('error', `${slug} create PR: ${e}`);
			return String(e);
		} finally {
			delete this.busy[slug];
		}
		await this.#patch(slug, { pr_url: url || null });
		status.flash(url ? ft('forge.create.openedUrl', forgeFor(url, this.gh), { url }) : ft('forge.create.opened', forge), 10000);
		void prStatuses.refresh(slug);
		if (url && meta.issue && settings.get<boolean>('kingu.issues.commentOnPr') === true) {
			const link = meta.issue;
			const posted = isLinear(link) ? invoke('linear_issue_comment', { id: link.key, body: prComment(url) }) : isFolderGithub(link) ? invoke('gh_issue_comment', { number: link.number, body: prComment(url) }) : commentOnLink(link, prComment(url));
			posted.catch((e) => status.flash(t('adeTasks.tasks.issueCommentFailed', { ref: issueRef(link), error: String(e) }), 8000));
		}
		return null;
	}

	/** Orca's rename: the task's display name only; its branch and worktree folder stay. Empty or unchanged keeps the old name. */
	async rename(slug: string, title: string) {
		const meta = this.list.find((t) => t.slug === slug);
		const next = meta ? renamedTitle(meta.title, title) : null;
		if (next !== null) await this.#patch(slug, { title: next });
	}

	/** The task whose side bar card shows the inline rename box (⌥⌘R, the card menu). */
	renaming = $state<string | null>(null);

	startRename(slug: string) {
		if (!this.list.some((t) => t.slug === slug)) return;
		if (appMode.isAgents) appMode.sessionsVisible = true;
		this.renaming = slug;
	}

	// -------------------------------------------------------------------------------------------
	// Landing the PR (Orca's Checks panel: merge, fix failing checks, review comments)

	/**
	 * Hands `prompt` to the task's agent: pasted into its running CLI, a new CLI session when none
	 * runs, or a follow-up in the timeline. The folder itself (`''`) has no agent, so the prompt
	 * is copied for the user to paste where they like.
	 */
	async sendToAgent(slug: string, prompt: string, what: string): Promise<boolean> {
		const meta = slug ? this.list.find((t) => t.slug === slug) : undefined;
		if (!meta) {
			const copied = await navigator.clipboard.writeText(prompt).then(
				() => true,
				() => false
			);
			status.flash(copied ? t('adeTasks.tasks.promptCopied', { what }) : t('adeTasks.tasks.promptCopyFailed', { what }), 8000);
			return copied;
		}
		const cli = cliOf(meta.agent);
		try {
			if (cli && cliSessions.has(slug)) await cliSessions.paste(slug, prompt);
			else if (cli) await this.#launchCli(slug, cli, { prompt });
			else await this.followUp(slug, prompt);
		} catch (e) {
			status.flash(t('adeTasks.tasks.sendToAgentFailed', { what, error: String(e) }), 10000);
			return false;
		}
		this.openTask(slug);
		status.flash(t('adeTasks.tasks.sentToAgent', { what }));
		return true;
	}

	/** Merges the PR on its host after confirming (Orca's merge button); the task becomes done. */
	async mergePr(slug: string, method: MergeMethod, deleteBranch: boolean) {
		const pr = prStatuses.bySlug[slug]?.pr;
		if (!pr) return;
		const forge = forgeFor(pr.url, this.gh);
		const branchNote = deleteBranch && pr.head_ref ? `\n${ft('forge.merge.askDeleteBranch', forge, { branch: pr.head_ref })}` : '';
		const ok = await ask(`${ft('forge.merge.ask', forge, { method: methodLabel(method), number: pr.number })}${branchNote}`, { title: ft('forge.merge.title', forge), okLabel: methodLabel(method), cancelLabel: t('common.cancel') });
		if (!ok) return;
		const r = await this.#step(slug, ft('forge.merge.title', forge), () => invoke<MergeOutcome>('worktree_pr_merge', { slug, url: pr.url, number: pr.number, method, deleteBranch }));
		if (!r) return;
		if (slug && this.list.some((t) => t.slug === slug)) await this.#patch(slug, { merged_at: Date.now(), status: 'done' });
		status.flash([ft('forge.merge.done', forge, { number: pr.number }), r.deleted_branch ? ft('forge.merge.deletedBranch', forge, { branch: r.deleted_branch }) : '', r.branch_note ?? ''].filter(Boolean).join(' · '), 10000);
		await prStatuses.refresh(slug);
	}

	/** Orca's "fix failing checks": the broken checks with their failed jobs' log tails, sent to the agent. */
	async fixChecks(slug: string) {
		const pr = prStatuses.bySlug[slug]?.pr;
		if (!pr) return;
		const checks = brokenChecks(pr.checks).map((c) => ({ name: c.name, url: c.url, run_id: c.run_id ?? null, job_id: c.job_id ?? null }));
		const logs = checks.length ? ((await this.#step(slug, t('adeTasks.tasks.step.checkLogs'), () => invoke<CheckLog[]>('worktree_pr_check_logs', { slug, url: pr.url, checks }))) ?? []) : [];
		await this.sendToAgent(slug, buildFixChecksPrompt(pr, logs), t('adeTasks.tasks.what.fixChecks'));
	}

	/** Orca's "resolve comments": the selected unresolved review threads, sent to the agent. */
	async fixComments(slug: string, threads: ReviewThread[]) {
		const pr = prStatuses.bySlug[slug]?.pr;
		if (!pr || !threads.length) return;
		const path = workspace.root ? (slug ? `${workspace.root}/${worktreeDir(slug)}` : workspace.root) : null;
		await this.sendToAgent(slug, buildCommentsPrompt(pr, threads, path), t('adeTasks.tasks.what.reviewComments', { count: threads.length }));
	}

	/** Resolves (or reopens) a review thread on its host (a discussion on GitLab). */
	async resolveThread(slug: string, id: string, resolve = true) {
		const pr = prStatuses.bySlug[slug]?.pr;
		if (!pr) return;
		const done = await this.#step(slug, resolve ? t('adeTasks.tasks.step.resolveThread') : t('adeTasks.tasks.step.reopenThread'), () => invoke<boolean>('gh_resolve_thread', { slug, url: pr.url, threadId: id, resolve }));
		if (done !== undefined) prStatuses.markResolved(slug, id, done);
	}

	markDone(slug: string, done = true) {
		return this.#patch(slug, { status: done ? 'done' : 'review' });
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
			const slug = other?.slug ?? '';
			status.flash(other?.root ? t('adeTasks.tasks.otherFolderWaiting', { folder: other.root, slug }) : t('adeTasks.tasks.anotherFolderWaiting', { slug }), 8000);
		} else status.flash(t('adeTasks.tasks.nothingWaiting'));
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

	/** Quick open scoped to the worktree: files open as `.kingu/worktrees/<slug>/<file>` (in the Agents layout, as its tabs). */
	async quickOpen(slug: string) {
		if (appMode.isAgents) {
			adeLayout.show(slug);
			return quickOpenWorktree(slug);
		}
		let files: string[];
		try {
			files = await invoke<string[]>('worktree_list_files', { slug });
		} catch (e) {
			notifications.error(e);
			return;
		}
		const changed = new Set(this.stats[slug]?.files.map((f) => f.path));
		quick.pick({
			placeholder: t('adeTasks.tasks.quickOpenPlaceholder', { slug }),
			items: files.map((f) => ({ id: f, label: f, description: changed.has(f) ? t('adeTasks.tasks.modified') : undefined })),
			onAccept: (item) => editors.open(`${worktreeDir(slug)}/${item.id}`, { preview: true })
		});
	}

	/** Palette: pick a task to open. */
	pickTask() {
		quick.pick({
			placeholder: t('adeTasks.tasks.pickTask'),
			items: this.views.map((v) => ({ id: v.meta.slug, label: v.meta.title, description: this.branchOf(v.meta.slug) })),
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
				void diffNotes.load();
			});
		});
		// Team server: send each task's metadata when its status, branch or diff stats change, and
		// its latest run's timings, tokens and cost after each turn and when the run ends.
		const teamSent = new Map<string, string>();
		const teamRunSent = new Map<string, string>();
		$effect(() => {
			if (!adeTasks.loaded || !workspace.root) return;
			const folder = workspace.name;
			for (const view of adeTasks.views) {
				const task = toTeamTask(view, folder, adeTasks.branchOf(view.meta.slug));
				const key = syncKey(task);
				if (teamSent.get(task.id) !== key) {
					teamSent.set(task.id, key);
					untrack(() => void team.syncTask(task));
				}
				const run = toTeamRun(view, folder);
				if (!run) continue;
				const rkey = runKey(run);
				if (teamRunSent.get(task.id) === rkey) continue;
				teamRunSent.set(task.id, rkey);
				untrack(() => void team.syncRun(run));
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
	// The other added projects of the side bar (their tasks, agent status and notifications).
	const uninstallProjects = projects.install();
	// Refresh stats when the window regains focus (agents and terminals change worktrees).
	const onFocus = () => void adeTasks.refreshStats();
	window.addEventListener('focus', onFocus);
	const hasRoot = () => workspace.root !== null;
	const unregister = [
		// No keybinding: ⌘⇧A (Ctrl+Shift+A) switches to the Agents layout (workbench.action.toggleAgentsMode).
		commands.register({ id: 'kingu.agents.show', title: 'Show Agents', category: 'View', run: () => adeTasks.showView() }),
		commands.register({ id: 'kingu.agents.newTask', title: 'New Task', category: 'Agents', when: hasRoot, run: () => (adeTasks.showView(), (adeTasks.composing = true)) }),
		commands.register({ id: 'kingu.agents.newTaskFromBranch', title: 'New Task from Branch…', category: 'Agents', when: hasRoot, run: () => adeTasks.pickBranchForTask() }),
		commands.register({ id: 'kingu.agents.newTaskFromPr', title: 'New Task from Pull Request…', category: 'Agents', when: hasRoot, run: () => adeTasks.pickPrForTask() }),
		commands.register({ id: 'kingu.agents.openBoard', title: 'Open Board', category: 'Agents', when: hasRoot, run: () => adeTasks.openBoard() }),
		commands.register({ id: 'kingu.agents.nextAttention', title: 'Next Task Needing Attention', category: 'Agents', when: hasRoot, run: () => adeTasks.openNext() }),
		commands.register({ id: 'kingu.agents.openTask', title: 'Open Task...', category: 'Agents', when: () => adeTasks.list.length > 0, run: () => adeTasks.pickTask() }),
		// Orca's sourceControl.sendReviewNotes (unbound): the notes of the worktree in front.
		commands.register({
			id: 'kingu.agents.sendReviewNotes',
			title: 'Send Review Notes to Agent',
			category: 'Agents',
			when: hasRoot,
			run: () => {
				const active = editors.active;
				const key = appMode.isAgents ? adeLayout.key : active ? (slugOfTaskKey(active) ?? parseTaskDiffKey(active)?.slug ?? '') : '';
				const notes = diffNotes.list(key);
				if (!notes.length) return status.flash(t('adeTasks.tasks.noReviewNotes'));
				return diffNotes.send(key, notes);
			}
		}),
		commands.register({
			id: 'kingu.agents.renameTask',
			title: 'Rename Task',
			category: 'Agents',
			key: 'cmd+alt+r',
			when: () => appMode.isAgents && !!appMode.activeSession && !!adeTasks.find(appMode.activeSession),
			run: () => appMode.activeSession && adeTasks.startRename(appMode.activeSession)
		}),
		commands.register({ id: 'kingu.agents.refresh', title: 'Refresh Tasks', category: 'Agents', when: hasRoot, run: () => adeTasks.load() }),
		commands.register({ id: 'kingu.agent.chooseCli', title: 'Choose CLI…', category: 'Agent', run: () => chooseAgentCli() }),
		commands.register({
			id: 'kingu.agents.untrustWorktreeScripts',
			title: 'Untrust Worktree Scripts',
			category: 'Agents',
			when: hasRoot,
			run: () =>
				Promise.all(['setup', 'archive', 'tabs', 'issue'].map((kind) => invoke('worktree_script_trust', { kind, trusted: false, hash: null })))
					.then(() => status.flash(t('adeTasks.tasks.untrusted')))
					.catch((e) => notifications.error(e))
		})
	];
	cliSessions.onSessionId = (slug, id) => adeTasks.learnCliSession(slug, id);
	// Rust's git watcher (watcher.rs GitWatcher): branches and worktrees changed in the open folder's repository.
	let stopGitWatch: (() => void) | null = null;
	let disposed = false;
	void listen<{ root: string }>('ade:worktrees-changed', (e) => {
		if (e.payload.root === workspace.root && adeTasks.loaded) void adeTasks.refreshWorktrees();
	})
		.then((un) => (disposed ? un() : (stopGitWatch = un)))
		.catch((e) => clientLog('info', `ade:worktrees-changed: ${e}`));
	return () => {
		disposed = true;
		stopGitWatch?.();
		stopEffects();
		uninstallProjects();
		clearInterval(tick);
		window.removeEventListener('focus', onFocus);
		cliSessions.onSessionId = null;
		unregister.forEach((u) => u());
	};
}
