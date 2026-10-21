import { describe, expect, test } from 'bun:test';
import {
	activeProviders,
	applyStale,
	backoff,
	countdown,
	errorLabel,
	errorMessage,
	fromAccountRow,
	hasValue,
	headline,
	nextTick,
	parseLiveLimit,
	percentLabel,
	planName,
	poolsOf,
	PROVIDERS,
	resetsIn,
	rowState,
	spend,
	updatedLabel,
	usageOptions,
	windowLength,
	windowsOf,
	type ProviderState
} from './usage';

const NOW = Date.UTC(2026, 9, 18, 12, 0);
const MIN = 60_000;
const state = (o: Partial<ProviderState> = {}): ProviderState => ({
	provider: 'claude',
	status: 'ok',
	session: null,
	weekly: null,
	planType: null,
	error: null,
	failureKind: null,
	retryAtMs: null,
	updatedAt: NOW,
	...o
});
const win = (usedPercent: number, resetsAt: number | null = null, windowMinutes = 300) => ({ usedPercent, windowMinutes, resetsAt });

describe('formats (Orca)', () => {
	test('countdown', () => {
		expect(countdown(0)).toBe('now');
		expect(countdown(30_000)).toBe('0m');
		expect(countdown(45 * MIN)).toBe('45m');
		expect(countdown(125 * MIN)).toBe('2h 5m');
		expect(countdown(120 * MIN)).toBe('2h');
		expect(countdown((3 * 24 + 6) * 60 * MIN + 40 * MIN)).toBe('3d 6h');
		expect(countdown(48 * 60 * MIN)).toBe('2d');
		expect(resetsIn(-1)).toBe('Resets now');
	});
	test('window length', () => {
		expect([10_080, 300, 60, 30, 20_160, 2880, 120, 90].map(windowLength)).toEqual(['wk', '5h', '1h', '30m', '2wk', '2d', '2h', '90m']);
	});
	test('percent and plan', () => {
		expect(percentLabel(71.4, 'used')).toBe('71% used');
		expect(percentLabel(71.4, 'remaining')).toBe('29% left');
		expect(planName('chatgpt_plus')).toBe('ChatGPT Plus');
		expect(updatedLabel(NOW - 5 * MIN, NOW)).toBe('Updated 5m ago');
		expect(updatedLabel(null, NOW)).toBe('Not yet updated');
	});
});

test('headline is the most used window, the earlier one on a tie', () => {
	expect(headline(state({ session: win(30), weekly: win(71, null, 10_080) }))?.label).toBe('Weekly');
	expect(headline(state({ session: win(50), weekly: win(50, null, 10_080) }))?.label).toBe('Session');
	expect(headline(null)).toBeNull();
});

test('row states and chip visibility', () => {
	expect(rowState(null).kind).toBe('loading');
	expect(rowState(state({ status: 'unavailable', failureKind: 'missing-credentials' })).kind).toBe('sign-in');
	expect(rowState(state({ status: 'error', failureKind: 'stale-token' }))).toEqual({ kind: 'error', label: 'Updates when Claude runs' });
	expect(rowState(state({ session: win(5) })).kind).toBe('usage');
	expect(errorLabel(state({ status: 'error', error: 'Claude usage is rate limited right now.', failureKind: 'rate-limited' }))).toBe('Limited');
	expect(hasValue(state({ status: 'unavailable' }))).toBe(false);
	expect(hasValue(state({ status: 'fetching' }))).toBe(false);
	expect(hasValue(state({ status: 'error' }))).toBe(true);
});

test('a failed refresh keeps recent windows', () => {
	const prev = state({ session: win(40), updatedAt: NOW - 10 * MIN });
	const failed = state({ status: 'error', error: 'x', failureKind: 'network' });
	expect(applyStale(prev, failed, NOW).session?.usedPercent).toBe(40);
	expect(applyStale(state({ session: win(40), updatedAt: NOW - 31 * MIN }), failed, NOW).session).toBeNull();
	expect(applyStale(state({ session: win(40), updatedAt: NOW - 2 * 3600_000 }), { ...failed, failureKind: 'rate-limited' }, NOW).session?.usedPercent).toBe(40);
});

test('backoff and tick', () => {
	expect([1, 2, 3, 6, 20].map(backoff)).toEqual([30_000, 60_000, 120_000, 900_000, 900_000]);
	expect(nextTick([NOW + 90_500], NOW)).toBe(30_501);
	expect(nextTick([], NOW)).toBe(MIN);
});

test('live rate_limit_event', () => {
	const line = (info: Record<string, unknown>) => JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info });
	expect(parseLiveLimit(line({ rateLimitType: 'seven_day', utilization: 0.71, resetsAt: 1_792_324_800 }))).toEqual({
		key: 'weekly',
		window: { usedPercent: 71, windowMinutes: 10_080, resetsAt: 1_792_324_800_000 }
	});
	expect(parseLiveLimit(line({ rateLimitType: 'five_hour', status: 'rejected' }))?.window.usedPercent).toBe(100);
	expect(parseLiveLimit(line({ rateLimitType: 'seven_day_opus', utilization: 0.5 }))).toBeNull();
	expect(parseLiveLimit('{oops')).toBeNull();
});

test('spend buckets the latest run of each task by day', () => {
	const run = (at: number, cost: number) => ({ status: 'done' as const, at, summary: null, error: null, cost_usd: cost, input_tokens: 100, output_tokens: 50, num_turns: 2 });
	const s = spend(
		[
			{ slug: 'a', title: 'A', last_run: run(NOW, 1.5) },
			{ slug: 'b', title: 'B', last_run: run(NOW - 2 * 86_400_000, 0.5) },
			{ slug: 'c', title: 'C', last_run: run(NOW - 30 * 86_400_000, 9) },
			{ slug: 'd', title: 'D', last_run: null }
		],
		NOW
	);
	expect(s.today).toBe(1.5);
	expect(s.week).toBe(2);
	expect(s.tokens).toBe(450);
	expect(s.rows.map((r) => r.slug)).toEqual(['a', 'b', 'c']);
});

describe('fromAccountRow', () => {
	const row = { key: 'claude', provider: 'claude' as const, account_id: null, label: 'Claude', email: null, active: true, updated_at: 5, error: null };
	test('windows, plan and status map from the accounts service', () => {
		const p = fromAccountRow({ ...row, status: 'stale', failure: null, usage: { session: { used_percent: 42, window_minutes: 300, resets_at: 9 }, weekly: null, plan: 'max' } });
		expect(p).toMatchObject({ provider: 'claude', status: 'ok', session: { usedPercent: 42, windowMinutes: 300, resetsAt: 9 }, weekly: null, planType: 'max', updatedAt: 5 });
	});
	test('failures take Orca\'s kebab-case kinds; an API key has no plan limits', () => {
		expect(fromAccountRow({ ...row, status: 'error', failure: 'stale_token', usage: null }).failureKind).toBe('stale-token');
		expect(fromAccountRow({ ...row, status: 'error', failure: 'not_signed_in', usage: null }).failureKind).toBe('missing-credentials');
		expect(fromAccountRow({ ...row, status: 'api_key', failure: null, usage: null }).status).toBe('unavailable');
	});
});

describe('Gemini usage (kingu.usage.gemini)', () => {
	test('shown only when turned on and its CLI is installed (or detection has not answered)', () => {
		const cli = (l: string[]) => l.filter((p) => ['claude', 'codex', 'gemini'].includes(p));
		expect(cli(activeProviders(['claude', 'gemini'], { gemini: false }))).toEqual(['claude']);
		expect(cli(activeProviders(['claude', 'gemini'], { gemini: true }))).toEqual(['claude', 'gemini']);
		expect(cli(activeProviders(['codex'], { gemini: true }))).toEqual(['codex']);
		expect(cli(activeProviders(null, {}))).toEqual(['claude', 'codex']);
		expect(cli(activeProviders(null, { gemini: true }))).toEqual(['claude', 'codex', 'gemini']);
	});

	test('an expired Gemini sign-in waits for the CLI', () => {
		expect(errorLabel(state({ provider: 'gemini', status: 'error', failureKind: 'stale-token' }))).toBe('Updates when Gemini runs');
	});
});

describe("Orca's other usage providers", () => {
	test('CLI-gated ones need their CLI, Antigravity its setting, the rest are always read', () => {
		expect(activeProviders(['claude'], {})).toEqual(['claude', 'opencode', 'minimax', 'cursor']);
		expect(activeProviders(['kimi', 'grok', 'zcode', 'antigravity'], {})).toEqual(['opencode', 'kimi', 'minimax', 'grok', 'cursor', 'zcode']);
		expect(activeProviders(['antigravity'], { antigravity: true })).toEqual(['antigravity', 'opencode', 'minimax', 'cursor']);
		expect(activeProviders(null, { antigravity: true, gemini: true })).toEqual(PROVIDERS);
	});

	test('a monthly window and pools count like the others', () => {
		const cursor = state({ provider: 'cursor', monthly: win(40, null, 43_200), buckets: [{ name: 'Cursor Models', ...win(90, null, 43_200) }] });
		expect(windowsOf(cursor).map((w) => w.label)).toEqual(['Monthly']);
		expect(headline(cursor)?.window.usedPercent).toBe(40);
		expect(poolsOf(cursor).map((b) => b.name)).toEqual(['Cursor Models']);
		const pools = state({ provider: 'antigravity', buckets: [{ name: 'Gemini Models', ...win(20) }, { name: 'Claude and GPT models', ...win(60) }] });
		expect(headline(pools)?.label).toBe('Claude and GPT models');
		expect(poolsOf(pools)).toEqual([]);
		expect(windowLength(43_200)).toBe('30d');
		const kept = applyStale(cursor, state({ provider: 'cursor', status: 'error', failureKind: 'network', updatedAt: NOW + MIN }), NOW + MIN);
		expect([kept.monthly?.usedPercent, kept.buckets?.length]).toEqual([40, 1]);
	});

	test('labels: Grok and Kimi wait for their CLI; the providers\' own words stay', () => {
		expect(errorLabel(state({ provider: 'grok', status: 'error', failureKind: 'delegated-refresh-required' }))).toBe('Run Grok to refresh');
		expect(errorLabel(state({ provider: 'kimi', status: 'error', failureKind: 'delegated-refresh-required' }))).toBe('Run Kimi to refresh');
		expect(errorLabel(state({ provider: 'cursor', status: 'error', failureKind: 'stale-token' }))).toBe('Sign-in expired');
		const minimax = state({ provider: 'minimax', status: 'error', failureKind: 'missing-credentials', error: 'MiniMax auth cookie not found: paste a Cookie header with _token' });
		expect(errorMessage(minimax)).toBe(minimax.error!);
		expect(rowState(state({ provider: 'opencode', status: 'unavailable', failureKind: 'missing-credentials', error: 'x' })).kind).toBe('sign-in');
	});

	test('options sent to Rust come from settings, with Orca\'s defaults', () => {
		expect(usageOptions(() => undefined)).toEqual({ opencodeWorkspaceId: '', minimaxEndpoint: 'overseas', minimaxGroupId: '', minimaxModels: 'general', zcodeSite: 'zai' });
		expect(usageOptions((id) => (id === 'kingu.usage.zcode.site' ? 'bigmodel' : undefined)).zcodeSite).toBe('bigmodel');
	});
});
