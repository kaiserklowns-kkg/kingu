// Team sync, pure parts (testable with `bun test`): the payloads sent through `team_sync_task` and
// `team_sync_run`, and the status bar label. Metadata only: never code, diffs, prompts or secrets.

import type { StreamState } from './teamEvents.ts';

export const TASK_STATUSES = ['backlog', 'running', 'needs_input', 'review', 'done', 'failed'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Mirrors `team::payload::TaskSync` in Rust (snake_case, like the server). */
export type TaskSync = {
	client_task_id: string;
	title: string;
	status: TaskStatus;
	branch?: string;
	agent?: string;
	model?: string;
	diff_stats?: { additions: number; deletions: number; files_changed: number };
	started_at?: string;
	finished_at?: string;
	source?: TaskSource;
	external_ref?: string;
	updated_at: string;
};

export type TaskSource = 'manual' | 'github' | 'linear' | 'jira';

/** The issue a task came from (shape of the ADE's `IssueLink`). */
export type TeamIssue = { provider?: 'github' | 'linear'; number: number; url: string; key?: string };

/** Mirrors `team::payload::RunSync` in Rust. */
export type RunSync = {
	client_task_id: string;
	client_run_id: string;
	adapter: string;
	model?: string;
	exit_reason?: string;
	started_at: string;
	ended_at?: string;
	input_tokens: number;
	output_tokens: number;
	cost_usd?: number;
	updated_at: string;
};

/** One run (agent process) of a task, as tasks.json's `last_run` knows it. */
export type TeamRunInput = {
	/** The task's id, as given to `buildTaskSync`. */
	taskId: string;
	agent: string;
	model?: string | null;
	/** Agent host run status: `idle` after a turn, `done`/`stopped`/`failed` once ended. */
	status: string;
	startedAt: number;
	/** When the latest turn (or the run) ended. */
	at: number;
	inputTokens?: number | null;
	outputTokens?: number | null;
	costUsd?: number | null;
};

/** What callers (agent panel, ADE board) know about a task. */
export type TeamTaskInput = {
	id: string;
	title: string;
	status: TaskStatus;
	branch?: string | null;
	agent?: string | null;
	model?: string | null;
	additions?: number;
	deletions?: number;
	filesChanged?: number;
	startedAt?: Date | string | number | null;
	finishedAt?: Date | string | number | null;
	issue?: TeamIssue | null;
};

/** Mirrors `team::TeamStatus` in Rust. */
export type TeamStatus = {
	server: string;
	signed_in: boolean;
	online: boolean | null;
	pending: number;
	last_error: string | null;
	stream: StreamState;
};

const iso = (v: Date | string | number | null | undefined) => (v === null || v === undefined || v === '' ? undefined : new Date(v).toISOString());
const opt = (v: string | null | undefined) => (v && v.trim() ? v.trim() : undefined);
const count = (v: number | undefined) => Math.max(0, Math.floor(Number.isFinite(v) ? (v as number) : 0));

/** Client ids must match the server's `[A-Za-z0-9._:-]{1,128}`. */
export const clientTaskId = (id: string) => id.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 128) || 'task';

/**
 * The issue as the team server names it: `owner/repo#42` for GitHub (`#42` when the URL is not a
 * github.com issue), the identifier (`ENG-123`) for Linear. Never carries the URL's query or more.
 */
export function issueSource(issue: TeamIssue | null | undefined): { source: TaskSource; external_ref: string } | undefined {
	if (!issue) return undefined;
	if (issue.provider === 'linear') return issue.key && /^[A-Za-z0-9]+-\d+$/.test(issue.key) ? { source: 'linear', external_ref: issue.key } : undefined;
	if (!Number.isSafeInteger(issue.number) || issue.number <= 0) return undefined;
	const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(?:issues|pull)\/\d+(?:[?#].*)?$/.exec(issue.url);
	return { source: 'github', external_ref: m ? `${m[1]}/${m[2]}#${issue.number}` : `#${issue.number}` };
}

/** Builds the sync payload; Rust validates it again before it enters the outbox. */
export function buildTaskSync(t: TeamTaskInput, now: Date = new Date()): TaskSync {
	const hasStats = t.additions !== undefined || t.deletions !== undefined || t.filesChanged !== undefined;
	const out: TaskSync = {
		client_task_id: clientTaskId(t.id),
		// One line, bounded: a title is never a place for content.
		title: t.title.replace(/\s+/g, ' ').trim().slice(0, 300) || '(untitled)',
		status: t.status,
		branch: opt(t.branch),
		agent: opt(t.agent),
		model: opt(t.model),
		diff_stats: hasStats ? { additions: count(t.additions), deletions: count(t.deletions), files_changed: count(t.filesChanged) } : undefined,
		started_at: iso(t.startedAt),
		finished_at: iso(t.finishedAt),
		...issueSource(t.issue),
		updated_at: now.toISOString()
	};
	for (const k of Object.keys(out) as (keyof TaskSync)[]) if (out[k] === undefined) delete out[k];
	return out;
}

/** Run statuses worth reporting: a turn finished (`idle`) or the run ended. */
export const REPORTED_RUN_STATUSES = ['idle', 'done', 'stopped', 'failed'] as const;

/** Builds a run's sync payload, or null when there is nothing to report yet. */
export function buildRunSync(r: TeamRunInput, now: Date = new Date()): RunSync | null {
	if (!(REPORTED_RUN_STATUSES as readonly string[]).includes(r.status)) return null;
	if (!Number.isFinite(r.startedAt) || r.startedAt <= 0) return null;
	const cost = r.costUsd != null && Number.isFinite(r.costUsd) && r.costUsd >= 0 ? r.costUsd : undefined;
	const out: RunSync = {
		client_task_id: clientTaskId(r.taskId),
		client_run_id: String(Math.floor(r.startedAt)),
		adapter: opt(r.agent) ?? 'unknown',
		model: opt(r.model),
		exit_reason: r.status,
		started_at: new Date(r.startedAt).toISOString(),
		// A turn's end is never before the run's start (clocks can step back).
		ended_at: new Date(Math.max(r.at, r.startedAt)).toISOString(),
		input_tokens: count(r.inputTokens ?? undefined),
		output_tokens: count(r.outputTokens ?? undefined),
		cost_usd: cost,
		updated_at: now.toISOString()
	};
	for (const k of Object.keys(out) as (keyof RunSync)[]) if (out[k] === undefined) delete out[k];
	return out;
}

export const STREAM_LABEL: Record<string, string> = { connected: 'เชื่อมต่อแล้ว', reconnecting: 'กำลังเชื่อมต่อใหม่', off: 'ปิด' };

export type StatusLabel ={ text: string; tooltip: string; warn: boolean };

/** Status bar item: "ทีม ✓" when connected, "ทีม: ออฟไลน์" when the server is unreachable. */
export function teamStatusLabel(serverUrl: string, s: TeamStatus | null): StatusLabel | null {
	if (!serverUrl) return null;
	const pending = s && s.pending > 0 ? ` • รอส่ง ${s.pending} รายการ` : '';
	if (!s || !s.signed_in) {
		return { text: 'ทีม: ยังไม่ได้ลงชื่อเข้าใช้', tooltip: `${serverUrl} — คลิกเพื่อลงชื่อเข้าใช้${pending}`, warn: true };
	}
	if (s.online === false) {
		return { text: 'ทีม: ออฟไลน์', tooltip: `${s.server} ติดต่อไม่ได้ จะลองใหม่อัตโนมัติ${pending}${s.last_error ? ` (${s.last_error})` : ''}`, warn: true };
	}
	return { text: s.stream === 'reconnecting' ? 'ทีม ↻' : 'ทีม ✓', tooltip: `เชื่อมต่อ ${s.server} แล้ว • อัปเดตสด: ${STREAM_LABEL[s.stream] ?? STREAM_LABEL.off}${pending}`, warn: false };
}
