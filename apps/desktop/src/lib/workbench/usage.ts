// Agent usage limits as Orca shows them in its status bar (UsageRosterPanel and ProviderSegment):
// the formats, the headline window, threshold colours, row states, error labels and the refresh
// policy. Data comes from the AI accounts service (#lib/accounts: the active account of each
// provider, OAuth usage endpoints) and, while a run is live, from Claude Code's `rate_limit_event`.

import type { RunSummary } from '#lib/ade/model.ts';
import type { UsageRow, UsageWindow } from '#lib/accounts/usage.ts';

export type ProviderId = 'claude' | 'codex' | 'gemini';
export const PROVIDERS: ProviderId[] = ['claude', 'codex', 'gemini'];
export const PROVIDER_NAME: Record<ProviderId, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };
/** Providers read through the AI accounts service; Gemini (kingu.usage.gemini) is read by Rust usage.rs. */
export const ACCOUNT_PROVIDERS: ProviderId[] = ['claude', 'codex'];

/** The providers whose usage is shown: detected ones (all while unknown), Gemini only when turned on. */
export function activeProviders(detected: ProviderId[] | null, gemini: boolean): ProviderId[] {
	return (detected ?? PROVIDERS).filter((p) => p !== 'gemini' || gemini);
}

export type Window = { usedPercent: number; windowMinutes: number; resetsAt: number | null };
export type ProviderStatus = 'idle' | 'fetching' | 'ok' | 'error' | 'unavailable';
export type ProviderState = {
	provider: ProviderId;
	status: ProviderStatus;
	session: Window | null;
	weekly: Window | null;
	planType: string | null;
	error: string | null;
	failureKind: string | null;
	retryAtMs: number | null;
	updatedAt: number;
	/** `live-session` when the windows came from a running Claude Code. */
	source?: 'api' | 'live-session';
};

export type UsageDisplay = 'used' | 'remaining';
export type UsageMode = 'detailed' | 'compact';

/** An accounts-service row (the provider's active account) as this panel's provider state. */
export function fromAccountRow(row: UsageRow): ProviderState {
	const win = (w: UsageWindow | null | undefined): Window | null => (w ? { usedPercent: w.used_percent, windowMinutes: w.window_minutes, resetsAt: w.resets_at } : null);
	// Rust's failures are snake_case; Orca's kinds (used for the labels here) are kebab-case.
	const failureKind = row.failure === 'not_signed_in' ? 'missing-credentials' : (row.failure?.replaceAll('_', '-') ?? null);
	const status: ProviderStatus = row.status === 'stale' ? 'ok' : row.status === 'api_key' ? 'unavailable' : row.status;
	return {
		provider: row.provider,
		status,
		session: win(row.usage?.session),
		weekly: win(row.usage?.weekly),
		planType: row.usage?.plan ?? null,
		error: row.error,
		failureKind,
		retryAtMs: null,
		updatedAt: row.updated_at ?? 0,
		source: 'api'
	};
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const clampPct = (x: number) => Math.round(Math.max(0, Math.min(100, x)));
/** The number shown: used, or what is left. */
export const shownPct = (x: number, display: UsageDisplay) => (display === 'used' ? Math.round(x) : 100 - Math.round(x));
export const percentLabel = (x: number, display: UsageDisplay) => `${shownPct(x, display)}% ${display === 'used' ? 'used' : 'left'}`;

/** Orca's countdown: `now`, `45m`, `2h 5m`, `3d 6h` (minutes dropped past a day). */
export function countdown(ms: number): string {
	if (ms <= 0) return 'now';
	const totalMin = Math.floor(ms / MIN);
	if (totalMin < 60) return `${totalMin}m`;
	const totalH = Math.floor(totalMin / 60);
	if (totalH >= 24) {
		const d = Math.floor(totalH / 24);
		const h = totalH % 24;
		return h ? `${d}d ${h}h` : `${d}d`;
	}
	const m = totalMin % 60;
	return m ? `${totalH}h ${m}m` : `${totalH}h`;
}
export const resetsIn = (ms: number) => (ms <= 0 ? 'Resets now' : `Resets in ${countdown(ms)}`);

/** The window's length, for windows without a reset time and the Detailed row labels. */
export function windowLength(minutes: number): string {
	if (minutes === 10_080) return 'wk';
	if (minutes === 300) return '5h';
	if (minutes === 60) return '1h';
	if (minutes < 60) return `${minutes}m`;
	if (minutes % 10_080 === 0) return `${minutes / 10_080}wk`;
	if (minutes % 1440 === 0) return `${minutes / 1440}d`;
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}
export const windowWhen = (w: Window, now: number) => (w.resetsAt !== null ? countdown(w.resetsAt - now) : windowLength(w.windowMinutes));

export type NamedWindow = { label: 'Session' | 'Weekly'; window: Window };
export function windowsOf(p: ProviderState | null): NamedWindow[] {
	if (!p) return [];
	const out: NamedWindow[] = [];
	if (p.session) out.push({ label: 'Session', window: p.session });
	if (p.weekly) out.push({ label: 'Weekly', window: p.weekly });
	return out;
}

/** The most used window; the earlier one wins a tie. */
export function headline(p: ProviderState | null): NamedWindow | null {
	let best: NamedWindow | null = null;
	for (const w of windowsOf(p)) if (!best || clampPct(w.window.usedPercent) > clampPct(best.window.usedPercent)) best = w;
	return best;
}

export const maxUsed = (p: ProviderState | null) => Math.max(-1, ...windowsOf(p).map((w) => clampPct(w.window.usedPercent)));

/** Popup only: bar fill and percent colour by the used share (also in "remaining" mode). */
export const barTone = (used: number) => (used < 60 ? 'neutral' : used < 80 ? 'warning' : 'critical');
export const textTone = (used: number) => (used >= 80 ? 'critical' : used >= 60 ? 'warning' : 'normal');

/** A state worth a chip: has data, or is loading/erroring rather than simply unavailable. */
export const hasValue = (p: ProviderState | null) => !!p && p.status !== 'unavailable' && !(p.status === 'fetching' && !windowsOf(p).length);

/** Claude waiting for its own CLI to refresh a stale system sign-in. */
export const isWaiting = (p: ProviderState) => p.provider === 'claude' && p.failureKind === 'stale-token';

const SIGN_IN = /not signed in|not logged in|logged out|authentication required|(sign|log) in required|please (sign|log) in|please reauthenticate/i;
const AUTHISH = /unauthori[sz]ed|forbidden|token|credential|auth/i;

/** Short status (`an`). */
export function errorLabel(p: ProviderState): string {
	const k = p.failureKind;
	if (p.provider === 'claude') {
		if (k === 'stale-token') return 'Updates when Claude runs';
		if (k === 'refreshable-credentials-without-token') return 'Refreshing sign-in';
		if (k === 'network') return 'Network issue';
		if (k === 'keychain-unavailable') return 'Sign-in unavailable';
		if (k === 'usage-unavailable' || k === 'server' || k === 'parse') return 'Usage unavailable';
		if (k === 'missing-credentials') return 'Sign in again';
	}
	if (p.provider === 'codex' && k === 'stale-token') return 'Sign-in expired';
	if (p.provider === 'gemini' && k === 'stale-token') return 'Updates when Gemini runs';
	if (k === 'no-subscription') return 'No subscription';
	if (/rate[- ]?limit(s|ed)?/i.test(p.error ?? '')) return 'Limited';
	return 'Refresh failed';
}

/** Long message (`on`). */
export function errorMessage(p: ProviderState): string {
	const k = p.failureKind;
	if (p.provider === 'claude') {
		if (k === 'stale-token') return 'Claude usage updates the next time Claude runs.';
		if (k === 'refreshable-credentials-without-token') return 'Claude sign-in is being refreshed. Agent sessions may still be signed in.';
		if (k === 'network') return 'Claude usage could not be refreshed because the network request failed.';
		if (k === 'keychain-unavailable') return 'Claude sign-in credentials could not be read.';
		if (k === 'usage-unavailable' || k === 'server' || k === 'parse') return 'Claude usage is unavailable right now.';
		if (k === 'missing-credentials') return 'The selected Claude account needs you to sign in again. Open Settings > AI Provider Accounts, or choose System default.';
	}
	if (p.error && AUTHISH.test(p.error) && k !== 'rate-limited') return `${PROVIDER_NAME[p.provider]} usage could not be refreshed. Agent sessions may still be signed in.`;
	return p.error || 'Unable to fetch usage';
}

export type RowKind = 'usage' | 'loading' | 'sign-in' | 'error' | 'unavailable' | 'empty';
export function rowState(p: ProviderState | null): { kind: RowKind; label: string } {
	if (windowsOf(p).length) return { kind: 'usage', label: '' };
	if (!p || p.status === 'idle' || p.status === 'fetching') return { kind: 'loading', label: 'Loading usage…' };
	if (p.failureKind === 'missing-credentials' || (!p.failureKind && SIGN_IN.test(p.error ?? ''))) return { kind: 'sign-in', label: 'not signed in' };
	if (p.status === 'error') return { kind: 'error', label: errorLabel(p) };
	if (p.status === 'unavailable') return { kind: 'unavailable', label: 'Usage unavailable' };
	return { kind: 'empty', label: 'No usage data' };
}

export function updatedLabel(updatedAt: number | null, now: number): string {
	if (!updatedAt) return 'Not yet updated';
	const s = Math.max(0, now - updatedAt);
	if (s < MIN) return 'Updated just now';
	if (s < HOUR) return `Updated ${Math.floor(s / MIN)}m ago`;
	return `Updated ${Math.floor(s / HOUR)}h ago`;
}

/** `chatgpt_plus` → `ChatGPT Plus`. */
export const planName = (plan: string | null) =>
	plan
		? plan
				.split(/[\s_-]+/)
				.filter(Boolean)
				.map((w) => (w.toLowerCase() === 'chatgpt' ? 'ChatGPT' : w[0].toUpperCase() + w.slice(1).toLowerCase()))
				.join(' ')
		: '';

/** The earliest reset among a provider's windows. */
export function soonestReset(p: ProviderState | null): number | null {
	const r = windowsOf(p)
		.map((w) => w.window.resetsAt)
		.filter((x): x is number => x !== null);
	return r.length ? Math.min(...r) : null;
}

// --- Refresh policy (Orca's rate-limit service) -----------------------------------------------

export const POLL_MS = 15 * MIN;
export const STALE_AFTER_MS = 5 * MIN;
export const LIVE_FRESH_MS = 5 * MIN;

/** On a failed refresh, recent windows stay on screen with the error (30 min, a day if rate limited). */
export function applyStale(prev: ProviderState | null, next: ProviderState, now: number): ProviderState {
	if (next.status !== 'error' || !prev || !windowsOf(prev).length) return next;
	const keep = next.failureKind === 'rate-limited' ? DAY : 30 * MIN;
	if (now - prev.updatedAt > keep) return next;
	return { ...next, session: prev.session, weekly: prev.weekly, planType: next.planType ?? prev.planType, updatedAt: prev.updatedAt, source: prev.source };
}

/** Retry delay after `streak` failures in a row: 30 s doubling, at most 15 min. */
export const backoff = (streak: number) => Math.min(30_000 * 2 ** (Math.min(streak, 8) - 1), 15 * MIN);

/** Milliseconds until any shown countdown changes (once a minute, hourly beyond a day). */
export function nextTick(resets: (number | null)[], now: number): number {
	let best = Infinity;
	for (const r of resets) {
		if (r === null) continue;
		const t = r - now;
		if (t <= 0) continue;
		best = Math.min(best, (t % (t >= DAY ? HOUR : MIN)) + 1);
	}
	return Number.isFinite(best) ? best : MIN;
}

/**
 * A `raw` agent event holding Claude Code's `rate_limit_event`, as a session or weekly window
 * (`utilization` arrives as a fraction). Anything else is null.
 */
export function parseLiveLimit(line: string): { key: 'session' | 'weekly'; window: Window } | null {
	let msg: unknown;
	try {
		msg = JSON.parse(line);
	} catch {
		return null;
	}
	if (!msg || typeof msg !== 'object' || (msg as { type?: unknown }).type !== 'rate_limit_event') return null;
	const info = (msg as { rate_limit_info?: Record<string, unknown> }).rate_limit_info;
	if (!info || typeof info !== 'object') return null;
	const key = info.rateLimitType === 'five_hour' ? 'session' : info.rateLimitType === 'seven_day' ? 'weekly' : null;
	if (!key) return null;
	const u = typeof info.utilization === 'number' && Number.isFinite(info.utilization) ? info.utilization : info.status === 'rejected' ? 1 : null;
	if (u === null) return null;
	const reset = typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt) ? info.resetsAt : null;
	return {
		key,
		window: {
			usedPercent: Math.max(0, Math.min(100, u <= 1 ? u * 100 : u)),
			windowMinutes: key === 'session' ? 300 : 10_080,
			resetsAt: reset === null ? null : reset < 1e12 ? reset * 1000 : reset
		}
	};
}

// --- Kingu's own spend (Settings › Stats & Usage) ----------------------------------------------

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
