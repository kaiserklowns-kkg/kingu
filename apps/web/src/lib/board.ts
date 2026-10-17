// Team board model: task metadata from GET /v1/tasks plus the reducer that applies the
// /v1/events SSE stream. Pure, so `bun test` covers it.

export type TaskStatus = 'backlog' | 'running' | 'needs_input' | 'review' | 'done' | 'failed';

export type Task = {
	id: string;
	project_id: string;
	client_task_id?: string | null;
	title: string;
	status: TaskStatus;
	branch?: string | null;
	agent?: string | null;
	model?: string | null;
	additions: number;
	deletions: number;
	files_changed: number;
	created_by: string;
	updated_by?: string | null;
	started_at?: string | null;
	finished_at?: string | null;
	created_at: string;
	updated_at: string;
};

/** One SSE message body from GET /v1/events. */
export type TeamEvent = {
	id: number;
	kind: 'task.created' | 'task.updated' | 'run.created' | 'run.updated';
	project_id: string | null;
	task_id: string | null;
	at: string;
	data: Record<string, unknown>;
};

export type Board = {
	tasks: Record<string, Task>;
	/** Highest event id applied; replays at or below it are ignored. */
	lastEventId: number;
};

export type ColumnId = 'waiting' | 'active' | 'done';

export const COLUMNS: { id: ColumnId; label: string; statuses: TaskStatus[] }[] = [
	{ id: 'waiting', label: 'รอคุณ', statuses: ['needs_input', 'review', 'failed'] },
	{ id: 'active', label: 'กำลังทำ', statuses: ['backlog', 'running'] },
	{ id: 'done', label: 'เสร็จแล้ว', statuses: ['done'] }
];

export const STATUS_LABELS: Record<TaskStatus, string> = {
	backlog: 'รอเริ่ม',
	running: 'กำลังทำ',
	needs_input: 'รอข้อมูลจากคุณ',
	review: 'รอรีวิว',
	done: 'เสร็จแล้ว',
	failed: 'ล้มเหลว'
};

const STATUSES = new Set<string>(Object.keys(STATUS_LABELS));

export function columnOf(status: TaskStatus): ColumnId {
	return COLUMNS.find((c) => c.statuses.includes(status))?.id ?? 'active';
}

export function initBoard(tasks: Task[], lastEventId = 0): Board {
	const map: Record<string, Task> = {};
	for (const t of tasks) map[t.id] = t;
	return { tasks: map, lastEventId };
}

/**
 * Merges a fresh GET /v1/tasks snapshot (after connecting or a `reset` event) without
 * regressing tasks the stream already moved further.
 */
export function mergeSnapshot(board: Board, tasks: Task[]): Board {
	const map: Record<string, Task> = { ...board.tasks };
	for (const t of tasks) {
		const cur = map[t.id];
		if (!cur || Date.parse(cur.updated_at) <= Date.parse(t.updated_at)) map[t.id] = t;
	}
	return { tasks: map, lastEventId: board.lastEventId };
}

const str = (v: unknown) => (typeof v === 'string' ? v : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** Validates an event payload into a Task, or null if it is not a usable task snapshot. */
export function taskFromEvent(data: Record<string, unknown>): Task | null {
	const id = str(data.id);
	const projectId = str(data.project_id);
	const title = str(data.title);
	const status = str(data.status);
	const updatedAt = str(data.updated_at);
	if (!id || !projectId || !title || !status || !STATUSES.has(status) || !updatedAt) return null;
	return {
		id,
		project_id: projectId,
		client_task_id: str(data.client_task_id),
		title,
		status: status as TaskStatus,
		branch: str(data.branch),
		agent: str(data.agent),
		model: str(data.model),
		additions: num(data.additions),
		deletions: num(data.deletions),
		files_changed: num(data.files_changed),
		created_by: str(data.created_by) ?? '',
		updated_by: str(data.updated_by),
		started_at: str(data.started_at),
		finished_at: str(data.finished_at),
		created_at: str(data.created_at) ?? updatedAt,
		updated_at: updatedAt
	};
}

/**
 * Applies one event. Returns the same object when nothing changed, so callers can skip
 * re-rendering and announcements. Duplicate (replayed) and out-of-order snapshots are ignored.
 */
export function applyEvent(board: Board, ev: TeamEvent): Board {
	if (!Number.isFinite(ev.id) || ev.id <= board.lastEventId) return board;
	if (ev.kind !== 'task.created' && ev.kind !== 'task.updated') return { ...board, lastEventId: ev.id };
	const next = taskFromEvent(ev.data);
	if (!next) return { ...board, lastEventId: ev.id };
	const prev = board.tasks[next.id];
	if (prev && Date.parse(prev.updated_at) > Date.parse(next.updated_at)) return { ...board, lastEventId: ev.id };
	return { tasks: { ...board.tasks, [next.id]: next }, lastEventId: ev.id };
}

/** Column contents, most recently updated first, optionally filtered by project. */
export function columns(board: Board, projectId = ''): Record<ColumnId, Task[]> {
	const out: Record<ColumnId, Task[]> = { waiting: [], active: [], done: [] };
	for (const t of Object.values(board.tasks)) {
		if (projectId && t.project_id !== projectId) continue;
		out[columnOf(t.status)].push(t);
	}
	for (const list of Object.values(out)) list.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at) || a.id.localeCompare(b.id));
	return out;
}

/** "เมื่อสักครู่", "5 นาทีที่แล้ว", "3 ชั่วโมงที่แล้ว", "2 วันที่แล้ว". */
export function timeAgo(iso: string | null | undefined, now: number = Date.now()): string {
	if (!iso) return '';
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return '';
	const s = Math.max(0, Math.round((now - t) / 1000));
	if (s < 45) return 'เมื่อสักครู่';
	const m = Math.round(s / 60);
	if (m < 60) return `${m} นาทีที่แล้ว`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h} ชั่วโมงที่แล้ว`;
	const d = Math.round(h / 24);
	if (d < 30) return `${d} วันที่แล้ว`;
	return new Date(t).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Screen-reader announcement for an applied event. */
export function describeChange(prev: Task | undefined, next: Task): string {
	const who = next.updated_by ?? next.created_by;
	if (!prev) return `งานใหม่: ${next.title} (${STATUS_LABELS[next.status]})${who ? ` โดย ${who}` : ''}`;
	if (prev.status !== next.status) return `${next.title}: ${STATUS_LABELS[prev.status]} → ${STATUS_LABELS[next.status]}`;
	return `อัปเดต: ${next.title}`;
}
