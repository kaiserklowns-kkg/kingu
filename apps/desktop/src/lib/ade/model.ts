// ADE task model: pure types and functions (no runes, no Tauri) so they are unit-testable.
// Shapes mirror Rust `agent/tasks.rs` and `agent/review.rs`.

import { firstLine, slugify, toolArg, type AgentEvent } from '#lib/agent/events.ts';

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
	merged_at: number | null;
};

/**
 * What the Agents view needs from whatever runs the agents. Today the adapter in runtime.svelte.ts
 * derives it from the webview-side runner events; a sidecar agent host can provide the same shape.
 */
export type TaskRuntime = {
	slug: string;
	status: TaskStatus;
	/** One-line summary of the latest event. */
	lastEvent?: string;
	pendingPermissions: number;
	model?: string;
	/** Unix ms of the latest event. */
	updatedAt?: number;
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
	{ id: 'attention', label: 'รอคุณ', hint: 'รออนุญาต รอรีวิว หรือมีปัญหา' },
	{ id: 'active', label: 'กำลังทำ', hint: 'agent กำลังทำงาน' },
	{ id: 'done', label: 'เสร็จแล้ว', hint: 'merge หรือปิดงานแล้ว' }
];

export const STATUS_LABEL: Record<TaskStatus, string> = {
	running: 'กำลังทำ',
	waiting: 'รออนุญาต',
	review: 'รอรีวิว',
	done: 'เสร็จแล้ว',
	failed: 'ล้มเหลว'
};

// ---------------------------------------------------------------------------------------------
// tasks.json reducers (immutable: each returns a new list)

export function newTask(input: { slug: string; title: string; prompt: string; base: string; agent?: string }, now: number): TaskMeta {
	return {
		slug: input.slug,
		title: input.title.trim(),
		prompt: input.prompt,
		base: input.base,
		created_at: now,
		updated_at: now,
		agent: input.agent ?? 'claude-code',
		model: null,
		status: 'running',
		pr_url: null,
		accepted: [],
		merged_at: null
	};
}

/** Replaces the task with the same slug, else appends. */
export function upsertTask(list: TaskMeta[], task: TaskMeta): TaskMeta[] {
	const i = list.findIndex((t) => t.slug === task.slug);
	return i < 0 ? [...list, task] : list.map((t, k) => (k === i ? task : t));
}

export function removeTask(list: TaskMeta[], slug: string): TaskMeta[] {
	return list.filter((t) => t.slug !== slug);
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
// Runtime events → TaskRuntime (the adapter's reducer)

/** Runner events plus the permission events a sidecar host adds. */
export type RuntimeEvent =
	| AgentEvent
	| { kind: 'permission_request'; id: string; tool: string; input?: unknown }
	| { kind: 'permission_resolved'; id: string; allowed: boolean };

export type RunState = { runtime: TaskRuntime; failed: boolean; pending: string[] };

export function startRun(slug: string, now: number): RunState {
	return { runtime: { slug, status: 'running', pendingPermissions: 0, updatedAt: now, lastEvent: 'เริ่มงาน' }, failed: false, pending: [] };
}

export function summarizeEvent(ev: RuntimeEvent): string | undefined {
	switch (ev.kind) {
		case 'tool_use':
			return `${ev.name}(${toolArg(ev.input, 60)})`;
		case 'message':
			return ev.role === 'assistant' ? firstLine(ev.text, 100) || undefined : undefined;
		case 'result':
			return ev.is_error ? `ล้มเหลว: ${firstLine(ev.result ?? ev.subtype, 80)}` : 'agent ทำงานเสร็จ';
		case 'exit':
			return ev.stopped ? 'หยุดแล้ว' : ev.code === 0 ? undefined : `จบการทำงาน (exit ${ev.code ?? `signal ${ev.signal}`})`;
		case 'stderr':
			return firstLine(ev.line, 80);
		case 'permission_request':
			return `ขออนุญาตใช้ ${ev.tool}`;
		case 'system':
			return ev.subtype === 'init' ? 'เริ่ม session' : undefined;
		default:
			return undefined;
	}
}

export function reduceRun(state: RunState, ev: RuntimeEvent, now: number): RunState {
	const rt = { ...state.runtime, updatedAt: now };
	let { failed, pending } = state;
	const summary = summarizeEvent(ev);
	if (summary) rt.lastEvent = summary;
	switch (ev.kind) {
		case 'system':
			if (ev.model) rt.model = ev.model;
			break;
		case 'result':
			failed = ev.is_error;
			break;
		case 'permission_request':
			pending = [...pending, ev.id];
			break;
		case 'permission_resolved':
			pending = pending.filter((p) => p !== ev.id);
			break;
		case 'exit':
			pending = [];
			rt.status = ev.stopped ? 'review' : failed || ev.code !== 0 ? 'failed' : 'review';
			break;
	}
	rt.pendingPermissions = pending.length;
	if (rt.status === 'running' || rt.status === 'waiting') rt.status = pending.length ? 'waiting' : 'running';
	return { runtime: rt, failed, pending };
}

// ---------------------------------------------------------------------------------------------
// Grouping, sorting and stats

/** A live run wins; a saved `running`/`waiting` with no live run was interrupted (app restart). */
export function effectiveStatus(meta: TaskMeta, runtime?: TaskRuntime): TaskStatus {
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
	if (meta.merged_at) return { label: 'merge แล้ว', tone: 'ok' };
	if (meta.pr_url) return { label: 'เปิด PR แล้ว', tone: 'info' };
	if (view.statError) return { label: 'ไม่มี worktree', tone: 'error' };
	if (!stat) return { label: '…', tone: 'neutral' };
	if (stat.dirty) return { label: 'ยังไม่ commit', tone: 'warn' };
	if (stat.ahead > 0) return { label: `${stat.ahead} commit รอ merge`, tone: 'info' };
	return { label: 'ไม่มีการเปลี่ยนแปลง', tone: 'neutral' };
}

/** Thai relative time: เมื่อสักครู่, 5 นาทีที่แล้ว, 3 ชม.ที่แล้ว, 2 วันที่แล้ว. */
export function timeAgo(then: number, now: number): string {
	const s = Math.max(0, Math.floor((now - then) / 1000));
	if (s < 60) return 'เมื่อสักครู่';
	const m = Math.floor(s / 60);
	if (m < 60) return `${m} นาทีที่แล้ว`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h} ชม.ที่แล้ว`;
	const d = Math.floor(h / 24);
	return d < 30 ? `${d} วันที่แล้ว` : new Date(then).toLocaleDateString('th-TH');
}

/** Default commit message: the task title, with the slug for traceability. */
export function commitMessage(meta: TaskMeta): string {
	return meta.title === meta.slug ? meta.title : `${meta.title}\n\nKingu task: ${meta.slug}`;
}
