// Plan usage for the footer and its popover (Orca's usage meter). Rust fetches; this file only
// shapes what it returns. Pure, so `bun test` covers it.

import { t } from '#lib/i18n/index.ts';

export type Provider = 'claude' | 'codex';
export type Kind = 'subscription' | 'api_key';

export type UsageWindow = { used_percent: number; window_minutes: number; resets_at: number | null };
export type Usage = { session: UsageWindow | null; weekly: UsageWindow | null; models?: Record<string, UsageWindow>; plan: string | null };
export type UsageStatus = 'ok' | 'stale' | 'error' | 'unavailable' | 'api_key' | 'idle';

export type UsageRow = {
	key: string;
	provider: Provider;
	account_id: string | null;
	label: string;
	email: string | null;
	active: boolean;
	status: UsageStatus;
	usage: Usage | null;
	updated_at: number | null;
	failure: string | null;
	error: string | null;
};

export type Identity = { signed_in: boolean; email: string | null; org: string | null; plan: string | null };
export type AccountView = {
	id: string;
	provider: Provider;
	kind: Kind;
	label: string;
	created_at: number;
	active: boolean;
	signed_in: boolean;
	email: string | null;
	org: string | null;
	plan: string | null;
};
export type AccountsView = { accounts: AccountView[]; own: Record<Provider, Identity> };
export type Sample = { t: number; session: number | null; weekly: number | null };

export const PROVIDERS: Provider[] = ['claude', 'codex'];
export const PROVIDER_TITLE: Record<Provider, string> = { claude: 'Claude', codex: 'Codex' };

/** Time left as Orca shows it: `now`, `42m`, `3h 5m`, `3d 6h`. */
export function formatDuration(ms: number): string {
	if (ms <= 0) return 'now';
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const m = minutes % 60;
	if (hours >= 24) {
		const days = Math.floor(hours / 24);
		const h = hours % 24;
		return h > 0 ? `${days}d ${h}h` : `${days}d`;
	}
	return m > 0 ? `${hours}h ${m}m` : `${hours}h`;
}

/** A window's length when its reset time is unknown: `5h`, `wk`, `2d`. */
export function windowLabel(minutes: number): string {
	if (minutes === 10080) return 'wk';
	if (minutes === 300) return '5h';
	if (minutes < 60) return `${minutes}m`;
	if (minutes % 10080 === 0) return `${minutes / 10080}wk`;
	if (minutes % 1440 === 0) return `${minutes / 1440}d`;
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}

/** Time to the window's reset, else its length. */
export function resetLabel(w: UsageWindow, now: number): string {
	return w.resets_at == null ? windowLabel(w.window_minutes) : formatDuration(w.resets_at - now);
}

export const pct = (v: number) => Math.round(Math.min(100, Math.max(0, v)));

export type Level = 'normal' | 'warning' | 'urgent';
/** Orca's colours: warning from 60%, urgent from 80%. */
export function level(percent: number): Level {
	const p = pct(percent);
	return p >= 80 ? 'urgent' : p >= 60 ? 'warning' : 'normal';
}

export type NamedWindow = { name: 'session' | 'weekly' | string; window: UsageWindow };

/** Session and weekly windows, then per-model ones. */
export function windows(u: Usage | null): NamedWindow[] {
	if (!u) return [];
	const out: NamedWindow[] = [];
	if (u.session) out.push({ name: 'session', window: u.session });
	if (u.weekly) out.push({ name: 'weekly', window: u.weekly });
	for (const [name, window] of Object.entries(u.models ?? {})) out.push({ name, window });
	return out;
}

/** The tightest of the session and weekly windows: what the compact footer shows. */
export function headline(u: Usage | null): NamedWindow | null {
	const main = windows(u).filter((w) => w.name === 'session' || w.name === 'weekly');
	return main.length ? main.reduce((a, b) => (pct(b.window.used_percent) > pct(a.window.used_percent) ? b : a)) : null;
}

/** Rows the footer shows: what agents use now, per provider, when that login exists. */
export function footerRows(rows: UsageRow[]): UsageRow[] {
	return PROVIDERS.flatMap((p) => rows.filter((r) => r.provider === p && r.active && r.status !== 'unavailable').slice(0, 1));
}

/** `71% used 3d 6h`, `API key`, `···` (not fetched yet), `—` (failed, nothing to show). */
/** `kingu.statusBar.usage.display` (Orca's usagePercentageDisplay): percent used, or what is left. */
export type UsageDisplay = 'used' | 'remaining';
export const usageLabel = (usedPercent: number, display: UsageDisplay = 'used') =>
	display === 'remaining' ? t('team.usage.left', { percent: pct(100 - usedPercent) }) : t('team.usage.used', { percent: pct(usedPercent) });

export function chipText(row: UsageRow, now: number, mode: 'compact' | 'detailed' = 'compact', display: UsageDisplay = 'used'): string {
	if (row.status === 'api_key') return 'API key';
	if (row.status === 'idle') return '···';
	const shown = mode === 'compact' ? [headline(row.usage)].filter((w) => w !== null) : windows(row.usage).filter((w) => w.name === 'session' || w.name === 'weekly');
	if (!shown.length) return '—';
	return shown.map((w) => `${usageLabel(w.window.used_percent, display)} ${resetLabel(w.window, now)}`).join(' · ');
}

/** The level of a row: its tightest window. */
export function rowLevel(row: UsageRow): Level {
	const h = headline(row.usage);
	return h ? level(h.window.used_percent) : 'normal';
}

export function windowTitle(name: string): string {
	if (name === 'session') return t('team.usage.session');
	if (name === 'weekly') return t('team.usage.weekly');
	return t('team.usage.model', { name });
}

/** Points for an SVG polyline of percentages on a fixed 0–100 scale. */
export function percentLine(values: number[], width: number, height: number): string {
	if (values.length === 0) return '';
	const pts = values.length === 1 ? [values[0], values[0]] : values;
	const step = width / (pts.length - 1);
	return pts.map((v, i) => `${(i * step).toFixed(1)},${(height - 1 - (pct(v) / 100) * (height - 2)).toFixed(1)}`).join(' ');
}

/** "Updated 5 minutes ago". */
export function updatedAgo(at: number | null, now: number): string {
	if (at == null) return t('team.usage.neverUpdated');
	const m = Math.floor((now - at) / 60_000);
	if (m < 1) return t('team.usage.updatedJustNow');
	if (m < 60) return t('team.usage.updatedMinutes', { count: m });
	const h = Math.floor(m / 60);
	return h < 24 ? t('team.usage.updatedHours', { count: h }) : t('team.usage.updatedDays', { count: Math.floor(h / 24) });
}
