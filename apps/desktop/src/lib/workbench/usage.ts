// Agent usage for the status bar and its popup (Orca's UsageRosterPanel): Claude's rate-limit
// windows, read from the `rate_limit_event` messages Claude Code sends during a run (the agent
// host passes them through as `raw` events), and Kingu's own spend from saved run summaries.

import type { RunSummary } from '#lib/ade/model.ts';

export type LimitId = 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'seven_day_overage_included' | 'overage';

export type LimitWindow = {
	id: LimitId;
	/** 0–100. */
	utilization: number;
	/** Unix ms, or null when Claude did not say. */
	resetsAt: number | null;
	/** `allowed`, `allowed_warning` or `rejected`. */
	status: string | null;
	/** Unix ms of the event. */
	seenAt: number;
};

export type UsageDisplay = 'used' | 'remaining';
export type UsageMode = 'detailed' | 'compact';

export const LIMIT_LABEL: Record<LimitId, string> = {
	five_hour: 'Session',
	seven_day: 'Weekly',
	seven_day_opus: 'Weekly Opus',
	seven_day_sonnet: 'Weekly Sonnet',
	seven_day_overage_included: 'Weekly (รวม extra)',
	overage: 'Extra usage'
};
const ORDER = Object.keys(LIMIT_LABEL) as LimitId[];

/** A `raw` agent event line holding a `rate_limit_event`, as a window; anything else is null. */
export function parseRateLimit(line: string, now: number): LimitWindow | null {
	let msg: unknown;
	try {
		msg = JSON.parse(line);
	} catch {
		return null;
	}
	if (!msg || typeof msg !== 'object' || (msg as { type?: unknown }).type !== 'rate_limit_event') return null;
	const info = (msg as { rate_limit_info?: Record<string, unknown> }).rate_limit_info;
	if (!info || typeof info !== 'object') return null;
	const id = info.rateLimitType;
	if (typeof id !== 'string' || !ORDER.includes(id as LimitId)) return null;
	const util = typeof info.utilization === 'number' && Number.isFinite(info.utilization) ? info.utilization : null;
	const status = typeof info.status === 'string' ? info.status : null;
	// Claude sends a fraction (0.71); a rejected window without one is full.
	const utilization = util === null ? (status === 'rejected' ? 100 : null) : util <= 1 ? util * 100 : util;
	if (utilization === null) return null;
	const reset = typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt) ? info.resetsAt : null;
	return {
		id: id as LimitId,
		utilization: Math.max(0, Math.min(100, utilization)),
		resetsAt: reset === null ? null : reset < 1e12 ? reset * 1000 : reset,
		status,
		seenAt: now
	};
}

/** Windows still worth showing, in Claude's order; a window that has reset is dropped. */
export function liveWindows(windows: LimitWindow[], now: number): LimitWindow[] {
	return windows.filter((w) => w.resetsAt === null || w.resetsAt > now).sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
}

/** The compact summary: the most used window (ties go to the one that resets first). */
export function headline(windows: LimitWindow[]): LimitWindow | null {
	return [...windows].sort((a, b) => b.utilization - a.utilization || (a.resetsAt ?? Infinity) - (b.resetsAt ?? Infinity))[0] ?? null;
}

export function percentLabel(utilization: number, display: UsageDisplay): string {
	const used = Math.round(utilization);
	return display === 'used' ? `${used}% used` : `${100 - used}% left`;
}

/** Time until a reset, Orca style: `3d 6h`, `2h 14m`, `45m`, `<1m`. */
export function resetIn(resetsAt: number | null, now: number): string {
	if (resetsAt === null) return '';
	const mins = Math.floor((resetsAt - now) / 60_000);
	if (mins < 1) return '<1m';
	const d = Math.floor(mins / 1440);
	const h = Math.floor((mins % 1440) / 60);
	const m = mins % 60;
	if (d > 0) return h ? `${d}d ${h}h` : `${d}d`;
	if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
	return `${m}m`;
}

export type Severity = 'ok' | 'warn' | 'critical';
export function severity(w: Pick<LimitWindow, 'utilization' | 'status'>): Severity {
	if (w.status === 'rejected' || w.utilization >= 90) return 'critical';
	if (w.status === 'allowed_warning' || w.utilization >= 70) return 'warn';
	return 'ok';
}

const DAY = 86_400_000;

export type SpendRow = { slug: string; title: string; run: RunSummary };
export type SpendDay = { start: number; cost: number; runs: number };
export type Spend = { today: number; week: number; tokens: number; days: SpendDay[]; rows: SpendRow[] };

/**
 * Kingu's spend from each task's latest saved run (cost is cumulative for its session), with the
 * last seven days bucketed by local day. Older runs of a task are not kept, so this is a floor.
 */
export function spend(tasks: { slug: string; title: string; last_run: RunSummary | null }[], now: number): Spend {
	const midnight = new Date(now);
	midnight.setHours(0, 0, 0, 0);
	const today = midnight.getTime();
	const days: SpendDay[] = Array.from({ length: 7 }, (_, i) => ({ start: today - (6 - i) * DAY, cost: 0, runs: 0 }));
	const rows: SpendRow[] = tasks.flatMap((t) => (t.last_run ? [{ slug: t.slug, title: t.title, run: t.last_run }] : [])).sort((a, b) => b.run.at - a.run.at);
	let tokens = 0;
	for (const r of rows) {
		tokens += (r.run.input_tokens ?? 0) + (r.run.output_tokens ?? 0);
		const day = days.find((d) => r.run.at >= d.start && r.run.at < d.start + DAY);
		if (day) {
			day.cost += r.run.cost_usd ?? 0;
			day.runs++;
		}
	}
	return { today: days[6].cost, week: days.reduce((n, d) => n + d.cost, 0), tokens, days, rows };
}
