// Team sync, pure parts (testable with `bun test`): the payload sent through `team_sync_task`
// and the status bar label. Metadata only: never code, diffs or secrets.

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
	updated_at: string;
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
};

/** Mirrors `team::TeamStatus` in Rust. */
export type TeamStatus = {
	server: string;
	signed_in: boolean;
	online: boolean | null;
	pending: number;
	last_error: string | null;
};

const iso = (v: Date | string | number | null | undefined) => (v === null || v === undefined || v === '' ? undefined : new Date(v).toISOString());
const opt = (v: string | null | undefined) => (v && v.trim() ? v.trim() : undefined);
const count = (v: number | undefined) => Math.max(0, Math.floor(Number.isFinite(v) ? (v as number) : 0));

/** Client ids must match the server's `[A-Za-z0-9._:-]{1,128}`. */
export const clientTaskId = (id: string) => id.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 128) || 'task';

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
		updated_at: now.toISOString()
	};
	for (const k of Object.keys(out) as (keyof TaskSync)[]) if (out[k] === undefined) delete out[k];
	return out;
}

export type StatusLabel = { text: string; tooltip: string; warn: boolean };

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
	return { text: 'ทีม ✓', tooltip: `เชื่อมต่อ ${s.server} แล้ว${pending}`, warn: false };
}
