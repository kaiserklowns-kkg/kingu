// ADE task model: pure types and functions (no runes, no Tauri) so they are unit-testable.
// Shapes mirror Rust `agent/tasks.rs` and `agent/review.rs`.

import { firstLine, formatUsage, slugify, toolArg, type AgentEvent, type RunState, type RunStatus } from '#lib/agent/events.ts';
import { isQuestionTool, questionText } from './agentHooks.ts';
import type { AgentRow } from './agentPresence.ts';
import type { SessionRef } from './sessionHistory.ts';
import { locale, t } from '#lib/i18n/index.ts';

export type TaskStatus = 'running' | 'waiting' | 'review' | 'done' | 'failed';

/** One row of `<root>/.kingu/tasks.json`. */
export type TaskMeta = {
	slug: string;
	title: string;
	prompt: string;
	/** Branch the task forked from and merges back into. */
	base: string;
	/** Unix ms. */
	created_at: number;
	updated_at: number;
	agent: string;
	model: string | null;
	status: TaskStatus;
	pr_url: string | null;
	/** Files accepted in review. */
	accepted: string[];
	/** Hunks accepted in review, by file (Rust `hunks::Hunk::id`); a file in `accepted` covers all of its hunks. */
	accepted_hunks?: Record<string, string[]>;
	merged_at: number | null;
	/** Claude session of the latest run, resumed by follow-ups (also after a restart). */
	session_id: string | null;
	/** How the latest run (or turn) ended, saved so the card can show it after a restart. */
	last_run: RunSummary | null;
	/** The issue the task was started from; its PR body says `Fixes #number` (`Fixes ENG-123` for Linear). */
	issue: IssueLink | null;
	/** `automation`: an automation started it (Orca's automation badge); absent when you did. */
	origin?: 'automation' | null;
	/** The branch still has the name made from the title and waits for one made from the work
	 *  (Orca's autoRenameBranchFromWork); absent once renamed, or for a branch you chose. */
	auto_name?: boolean;
	/** The board column you put it in (Orca's workspace status, workflow.ts); absent: the default column. */
	workflow_status?: string | null;
	/** Earlier agent sessions, newest first (sessionHistory.ts); `session_id` is the latest. */
	sessions?: SessionRef[];
	/** Best-of-N: the attempts of one prompt share this id; their slugs end `-a`, `-b`… (attempts.ts). */
	group?: string | null;
	/** The model the attempt was started with (`--model` of its CLI, or the timeline run's model). */
	attempt_model?: string | null;
	/** Stacked worktrees: the task whose branch this one forked from (its base and PR base). */
	parent?: string | null;
	/** Unix ms its idle agent CLI was closed by hibernation (hibernation.ts); absent once resumed. */
	hibernated_at?: number | null;
};

/**
 * Mirrors Rust `agent::tasks::IssueLink`. No `provider` means GitHub (links saved before Linear came).
 * `key`: `ENG-123` (Linear, Jira), `group/app#12` (GitLab), `acme/app#42` (GitHub, from a Project).
 */
export type IssueLink = { number: number; url: string; title: string; provider?: 'github' | 'linear' | 'gitlab' | 'jira'; key?: string };

/** Mirrors Rust `agent::tasks::RunSummary`. */
export type RunSummary = {
	/** The agent run status when saved (`idle` after a turn, `done`/`stopped`/`failed` once ended). */
	status: RunStatus;
	/** Unix ms. */
	at: number;
	summary: string | null;
	error: string | null;
	cost_usd: number | null;
	input_tokens: number | null;
	output_tokens: number | null;
	num_turns: number | null;
	/** Unix ms the run (agent process) started; the team server's run id. Older summaries lack it. */
	started_at?: number | null;
};

/**
 * What the Agents view needs from whatever runs the agents. The adapter in runtime.svelte.ts derives
 * it from the agent host's `agents` store with `toTaskRuntime`.
 */
export type TaskRuntime = {
	slug: string;
	status: TaskStatus;
	/** The agent host's own status (starting / running / waiting / idle / stopped / failed / done). */
	runStatus: RunStatus;
	/** The session is open (follow-ups go straight to it). */
	live: boolean;
	/** A turn is in progress or waiting for a permission answer. */
	working: boolean;
	/** One-line summary of the latest event. */
	lastEvent?: string;
	pendingPermissions: number;
	/** The agent asked you a question (AskUserQuestion, elicitation, request_user_input…), apart from a permission prompt. */
	question?: boolean;
	model?: string;
	sessionId: string | null;
	/** "$0.0123 · 12.3k in · 456 out · 3 turns" of the session so far. */
	usage?: string;
	error?: string;
	/** Unix ms of the latest event. */
	updatedAt?: number;
	/** Agents found in the task's other terminal panes (agentPresence.ts), one row each. */
	agents?: AgentRow[];
};

export type FileChange = {
	path: string;
	orig_path: string | null;
	/** `M`, `A`, `D`, `R`, `C`, `T`, or `?` for untracked. */
	status: string;
	/** null for binary files. */
	added: number | null;
	deleted: number | null;
};

export type DiffStat = {
	base: string;
	merge_base: string;
	head: string;
	ahead: number;
	behind: number;
	dirty: boolean;
	files: FileChange[];
};

export type GhStatus = { installed: boolean; authenticated: boolean; path: string | null; detail: string };
export type MergeResult = { commit: string; fast_forward: boolean; checkout: string | null };

export type TaskView = { meta: TaskMeta; runtime?: TaskRuntime; status: TaskStatus; stat?: DiffStat; statError?: string };

export type Column = 'attention' | 'active' | 'done';
export const COLUMNS: { id: Column; label: string; hint: string }[] = [
	{ id: 'attention', get label() { return t('ade.model.colAttention'); }, get hint() { return t('ade.model.colAttentionHint'); } },
	{ id: 'active', get label() { return t('ade.model.colActive'); }, get hint() { return t('ade.model.colActiveHint'); } },
	{ id: 'done', get label() { return t('ade.model.colDone'); }, get hint() { return t('ade.model.colDoneHint'); } }
];

/** The agent waits on your answer to its question (not a permission prompt). */
export const isQuestion = (v: { status: TaskStatus; runtime?: Pick<TaskRuntime, 'question'> }) => v.status === 'waiting' && !!v.runtime?.question;
export const questionLabel = () => t('ade.model.question');
export const statusLabel = (v: { status: TaskStatus; runtime?: Pick<TaskRuntime, 'question'> }) => (isQuestion(v) ? questionLabel() : STATUS_LABEL[v.status]);

/** Read at use time (getters), so the label follows kingu.uiLanguage. */
export const STATUS_LABEL: Record<TaskStatus, string> = {
	get running() {
		return t('ade.model.statusRunning');
	},
	get waiting() {
		return t('ade.model.statusWaiting');
	},
	get review() {
		return t('ade.model.statusReview');
	},
	get done() {
		return t('ade.model.statusDone');
	},
	get failed() {
		return t('ade.model.statusFailed');
	}
};

// ---------------------------------------------------------------------------------------------
// tasks.json reducers (immutable: each returns a new list)

export function newTask(
	input: {
		slug: string;
		title: string;
		prompt: string;
		base: string;
		agent?: string;
		issue?: IssueLink | null;
		origin?: 'automation';
		prUrl?: string;
		autoName?: boolean;
		status?: TaskStatus;
		/** Best-of-N group, the attempt's model, the stacked task's parent (attempts.ts). */
		group?: string;
		model?: string;
		parent?: string;
	},
	now: number
): TaskMeta {
	return {
		slug: input.slug,
		title: input.title.trim(),
		prompt: input.prompt,
		base: input.base,
		created_at: now,
		updated_at: now,
		agent: input.agent ?? 'claude-code',
		model: null,
		status: input.status ?? 'running',
		pr_url: input.prUrl ?? null,
		accepted: [],
		merged_at: null,
		session_id: null,
		last_run: null,
		issue: input.issue ?? null,
		...(input.origin ? { origin: input.origin } : {}),
		...(input.autoName ? { auto_name: true } : {}),
		...(input.group ? { group: input.group } : {}),
		...(input.model ? { attempt_model: input.model } : {}),
		...(input.parent ? { parent: input.parent } : {})
	};
}

/** Title length cap of tasks.json (Rust `MAX_TITLE`, in characters). */
export const MAX_TITLE = 200;

/** Orca's getWorktreeTitleRenameCommit: the trimmed new name, or null (cancel) when empty or unchanged. */
export function renamedTitle(current: string, next: string): string | null {
	const trimmed = [...next.trim()].slice(0, MAX_TITLE).join('').trim();
	return !trimmed || trimmed === current ? null : trimmed;
}

/** Replaces the task with the same slug, else appends. */
export function upsertTask(list: TaskMeta[], task: TaskMeta): TaskMeta[] {
	const i = list.findIndex((t) => t.slug === task.slug);
	return i < 0 ? [...list, task] : list.map((t, k) => (k === i ? task : t));
}

export function removeTask(list: TaskMeta[], slug: string): TaskMeta[] {
	return list.filter((t) => t.slug !== slug);
}

/** A change Rust's `tasks_update` applies to tasks.json as it is on disk (agent/tasks.rs `TaskChange`). */
export type TaskChange =
	| { kind: 'upsert'; task: TaskMeta }
	| { kind: 'patch'; slug: string; fields: Partial<Omit<TaskMeta, 'slug'>> }
	| { kind: 'remove'; slug: string };

/**
 * What turned `prev` into `next`, task by task: new or changed tasks are upserted, missing ones
 * removed. Sent instead of the whole list, so another window's edits to other tasks survive.
 */
export function taskChanges(prev: readonly TaskMeta[], next: readonly TaskMeta[]): TaskChange[] {
	const before = new Map(prev.map((t) => [t.slug, JSON.stringify(t)]));
	const after = new Set(next.map((t) => t.slug));
	const out: TaskChange[] = [];
	for (const t of next) if (before.get(t.slug) !== JSON.stringify(t)) out.push({ kind: 'upsert', task: t });
	for (const t of prev) if (!after.has(t.slug)) out.push({ kind: 'remove', slug: t.slug });
	return out;
}

/** `patchTask`'s fields as one patch change (with the bumped `updated_at`), for `tasks_update`. */
export function patchChange(slug: string, patch: Partial<Omit<TaskMeta, 'slug'>>, now: number): TaskChange {
	return { kind: 'patch', slug, fields: { ...patch, updated_at: now } };
}

/** Merges `patch` into the task and bumps `updated_at`; unknown slugs leave the list unchanged. */
export function patchTask(list: TaskMeta[], slug: string, patch: Partial<Omit<TaskMeta, 'slug'>>, now: number): TaskMeta[] {
	return list.map((t) => (t.slug === slug ? { ...t, ...patch, slug, updated_at: now } : t));
}

export function toggleAccepted(list: TaskMeta[], slug: string, path: string, now: number): TaskMeta[] {
	const t = list.find((x) => x.slug === slug);
	if (!t) return list;
	const accepted = t.accepted.includes(path) ? t.accepted.filter((p) => p !== path) : [...t.accepted, path].sort();
	return patchTask(list, slug, { accepted }, now);
}

/** Drops accepted marks for files that are no longer changed. */
export function pruneAccepted(accepted: string[], files: FileChange[]): string[] {
	const live = new Set(files.map((f) => f.path));
	return accepted.filter((p) => live.has(p));
}

/** Kingu worktrees with no tasks.json row (created before tasks were saved) become tasks. */
export function adoptOrphans(list: TaskMeta[], slugs: string[], base: string, now: number): TaskMeta[] {
	const known = new Set(list.map((t) => t.slug));
	const orphans = slugs.filter((s) => !known.has(s)).map((slug) => ({ ...newTask({ slug, title: slug, prompt: '', base }, now), status: 'review' as const }));
	return orphans.length ? [...list, ...orphans] : list;
}

/** Slug for a new task's title, suffixed `-2`, `-3`… when taken. */
export function uniqueSlug(title: string, taken: Set<string>): string {
	const base = slugify(title);
	if (!taken.has(base)) return base;
	for (let n = 2; ; n++) {
		const suffix = `-${n}`;
		const slug = base.slice(0, 48 - suffix.length).replace(/-+$/, '') + suffix;
		if (!taken.has(slug)) return slug;
	}
}

// ---------------------------------------------------------------------------------------------
// Agent run (agents store) → TaskRuntime (the adapter's pure mapping)

/** The parts of an agent-host run the ADE reads (`AgentRun` from agents.svelte.ts fits). */
export type RunView = Pick<RunState, 'status' | 'items' | 'draft' | 'pending' | 'sessionId' | 'model' | 'result' | 'error' | 'ended'> & { slug: string };

export function summarizeEvent(ev: AgentEvent): string | undefined {
	switch (ev.kind) {
		case 'tool_use':
			return `${ev.name}(${toolArg(ev.input, 60)})`;
		case 'message':
			return ev.role === 'assistant' ? firstLine(ev.text, 100) || undefined : undefined;
		case 'result':
			return ev.is_error ? t('ade.model.eventFailed', { reason: firstLine(ev.result ?? ev.subtype, 80) }) : t('ade.model.eventFinished');
		case 'exit':
			return ev.stopped ? t('ade.model.eventStopped') : ev.code == null && ev.signal == null ? undefined : ev.code === 0 ? undefined : t('ade.model.eventExited', { code: `exit ${ev.code ?? `signal ${ev.signal}`}` });
		case 'error':
			return t('ade.model.eventError', { message: firstLine(ev.message, 80) });
		case 'stderr':
			return firstLine(ev.line, 80);
		case 'permission_request':
			if (isQuestionTool(ev.tool)) return t('ade.model.eventQuestion', { question: firstLine(questionText(ev.input) ?? ev.input_summary, 80) });
			return ev.input_summary ? t('ade.model.eventPermissionDetail', { tool: ev.tool, detail: firstLine(ev.input_summary, 60) }) : t('ade.model.eventPermission', { tool: ev.tool });
		case 'system':
			return ev.subtype === 'init' ? t('ade.model.eventSessionStarted') : undefined;
		default:
			return undefined;
	}
}

/** How far back the summary looks for an event worth showing. */
const SUMMARY_LOOKBACK = 50;

/** The card line: an open permission request first, then streaming text, then the latest summarizable event. */
export function lastEventOf(run: Pick<RunView, 'items' | 'draft' | 'pending'>): string | undefined {
	if (run.pending.length) return summarizeEvent(run.pending[0]);
	if (run.draft.text.trim()) return firstLine(run.draft.text, 100);
	for (let i = run.items.length - 1; i >= Math.max(0, run.items.length - SUMMARY_LOOKBACK); i--) {
		const s = summarizeEvent(run.items[i]);
		if (s) return s;
	}
	return undefined;
}

/**
 * Agent run status → task status: a turn in progress is กำลังทำ, a permission prompt is รอคุณ
 * (waiting), a finished turn or ended run needs review, errors fail.
 */
export function taskStatusOf(run: Pick<RunView, 'status' | 'result' | 'error' | 'pending' | 'ended'>): TaskStatus {
	if (!run.ended && run.pending.length) return 'waiting';
	switch (run.status) {
		case 'starting':
		case 'running':
			return 'running';
		case 'waiting':
			return 'waiting';
		case 'failed':
			return 'failed';
		case 'stopped':
			return 'review';
		case 'idle':
		case 'done':
			return run.result?.is_error || (run.status === 'done' && run.error) ? 'failed' : 'review';
	}
}

export function toTaskRuntime(run: RunView, updatedAt?: number): TaskRuntime {
	return {
		slug: run.slug,
		status: taskStatusOf(run),
		runStatus: run.status,
		live: !run.ended,
		working: !run.ended && (run.status === 'starting' || run.status === 'running' || run.status === 'waiting'),
		lastEvent: lastEventOf(run) ?? (run.status === 'starting' ? t('ade.model.starting') : undefined),
		pendingPermissions: run.pending.length,
		question: !run.ended && run.pending.some((p) => p.kind === 'permission_request' && isQuestionTool(p.tool)),
		model: run.model ?? undefined,
		sessionId: run.sessionId,
		usage: run.result ? formatUsage(run.result) || undefined : undefined,
		error: run.error ?? undefined,
		updatedAt
	};
}

/** What tasks.json keeps of a run: written after each turn and when the run ends. `startedAt`: the run's start (Unix ms). */
export function runSummary(run: RunView, now: number, startedAt?: number): RunSummary {
	const r = run.result;
	const u = r?.usage;
	return {
		...(startedAt !== undefined ? { started_at: startedAt } : {}),
		status: run.status,
		at: now,
		summary: lastEventOf({ ...run, pending: [] }) ?? null,
		error: run.error ? firstLine(run.error, 200) : null,
		cost_usd: r?.total_cost_usd ?? null,
		input_tokens: u ? u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : null,
		output_tokens: u ? u.output_tokens : null,
		num_turns: r?.num_turns ?? null
	};
}

/** Same run outcome (ignores when it was saved). */
export function sameSummary(a: RunSummary | null, b: RunSummary | null): boolean {
	if (!a || !b) return a === b;
	return (Object.keys(a) as (keyof RunSummary)[]).every((k) => k === 'at' || a[k] === b[k]);
}

/** Usage line of a saved run, like `formatUsage`. */
export function formatSummaryUsage(s: RunSummary): string {
	const usage =
		s.input_tokens == null && s.output_tokens == null
			? null
			: { input_tokens: s.input_tokens ?? 0, output_tokens: s.output_tokens ?? 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
	return formatUsage({ total_cost_usd: s.cost_usd, num_turns: s.num_turns, usage });
}

/**
 * What a follow-up does: `send` through the agents store (into the open session, or resuming the
 * run's ended session), else start resuming the session saved in tasks.json (after a restart),
 * else start a fresh session.
 */
export function followUpPlan(run: Pick<RunView, 'ended' | 'sessionId'> | undefined, saved: string | null): { kind: 'send' } | { kind: 'start'; resume: string | null } {
	if (run && (!run.ended || run.sessionId)) return { kind: 'send' };
	return { kind: 'start', resume: saved ?? null };
}

// ---------------------------------------------------------------------------------------------
// Grouping, sorting and stats

/** A live run wins; a saved `running`/`waiting` with no live run was interrupted (app restart). */
export function effectiveStatus(meta: TaskMeta, runtime?: Pick<TaskRuntime, 'status' | 'pendingPermissions'>): TaskStatus {
	if (runtime && (runtime.status === 'running' || runtime.status === 'waiting')) return runtime.pendingPermissions > 0 ? 'waiting' : runtime.status;
	if (meta.status === 'running' || meta.status === 'waiting') return 'review';
	return meta.status;
}

export function columnOf(status: TaskStatus): Column {
	return status === 'running' ? 'active' : status === 'done' ? 'done' : 'attention';
}

const ATTENTION_RANK: Partial<Record<TaskStatus, number>> = { waiting: 0, failed: 1, review: 2 };

const lastActivity = (v: TaskView) => Math.max(v.meta.updated_at, v.runtime?.updatedAt ?? 0);

/**
 * รอคุณ: permission requests first, then failures, then reviews, oldest first (first come, first
 * served). กำลังทำ and เสร็จแล้ว: most recent first.
 */
export function groupTasks(views: TaskView[]): Record<Column, TaskView[]> {
	const out: Record<Column, TaskView[]> = { attention: [], active: [], done: [] };
	for (const v of views) out[columnOf(v.status)].push(v);
	out.attention.sort(
		(a, b) => (ATTENTION_RANK[a.status] ?? 9) - (ATTENTION_RANK[b.status] ?? 9) || lastActivity(a) - lastActivity(b) || a.meta.slug.localeCompare(b.meta.slug)
	);
	const recent = (a: TaskView, b: TaskView) => lastActivity(b) - lastActivity(a) || a.meta.slug.localeCompare(b.meta.slug);
	out.active.sort(recent);
	out.done.sort(recent);
	return out;
}

/** The task the title-bar badge opens: the head of รอคุณ. */
export function nextNeedingAttention(views: TaskView[], after?: string): TaskView | undefined {
	const list = groupTasks(views).attention;
	if (!after) return list[0];
	const i = list.findIndex((v) => v.meta.slug === after);
	return list[(i + 1) % list.length];
}

export type StatTotals = { files: number; added: number; deleted: number; binary: number };

export function aggregateStats(files: FileChange[]): StatTotals {
	const t: StatTotals = { files: files.length, added: 0, deleted: 0, binary: 0 };
	for (const f of files) {
		if (f.added === null || f.deleted === null) t.binary++;
		else {
			t.added += f.added;
			t.deleted += f.deleted;
		}
	}
	return t;
}

export type Chip = { label: string; tone: 'neutral' | 'info' | 'warn' | 'ok' | 'error' };

/** Review/PR state of a task for its card. */
export function reviewChip(view: Pick<TaskView, 'meta' | 'stat' | 'statError'>): Chip {
	const { meta, stat } = view;
	if (meta.merged_at) return { label: t('ade.model.chipMerged'), tone: 'ok' };
	if (meta.pr_url) return { label: t('ade.model.chipPrOpen'), tone: 'info' };
	if (view.statError) return { label: t('ade.model.chipNoWorktree'), tone: 'error' };
	if (!stat) return { label: '…', tone: 'neutral' };
	if (stat.dirty) return { label: t('ade.model.chipUncommitted'), tone: 'warn' };
	if (stat.ahead > 0) return { label: t('ade.model.chipAhead', { count: stat.ahead }), tone: 'info' };
	return { label: t('ade.model.chipNoChanges'), tone: 'neutral' };
}

/** Relative time in the UI language: just now / เมื่อสักครู่, 5 minutes ago / 5 นาทีที่แล้ว, … */
export function timeAgo(then: number, now: number): string {
	const s = Math.max(0, Math.floor((now - then) / 1000));
	if (s < 60) return t('ade.model.justNow');
	const m = Math.floor(s / 60);
	if (m < 60) return t('ade.model.minutesAgo', { count: m });
	const h = Math.floor(m / 60);
	if (h < 24) return t('ade.model.hoursAgo', { count: h });
	const d = Math.floor(h / 24);
	return d < 30 ? t('ade.model.daysAgo', { count: d }) : new Date(then).toLocaleDateString(locale() === 'th' ? 'th-TH' : 'en-US');
}

/** Default commit message: the task title, with the slug for traceability. */
export function commitMessage(meta: TaskMeta): string {
	return meta.title === meta.slug ? meta.title : `${meta.title}\n\nKingu task: ${meta.slug}`;
}
