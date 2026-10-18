import { describe, expect, test } from 'bun:test';
import { headline, liveWindows, parseRateLimit, percentLabel, resetIn, severity, spend, type LimitWindow } from './usage';

const NOW = Date.UTC(2026, 9, 18, 12, 0);
const event = (info: Record<string, unknown>) => JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info, uuid: 'u', session_id: 's' });
const win = (id: LimitWindow['id'], utilization: number, resetsAt: number | null = null): LimitWindow => ({ id, utilization, resetsAt, status: 'allowed', seenAt: NOW });

describe('parseRateLimit', () => {
	test('reads a fraction and a reset in seconds', () => {
		const w = parseRateLimit(event({ status: 'allowed', rateLimitType: 'seven_day', utilization: 0.71, resetsAt: 1_760_800_000 }), NOW);
		expect(w).toEqual({ id: 'seven_day', utilization: 71, resetsAt: 1_760_800_000_000, status: 'allowed', seenAt: NOW });
	});
	test('a rejected window without utilization is full', () => {
		expect(parseRateLimit(event({ status: 'rejected', rateLimitType: 'five_hour' }), NOW)?.utilization).toBe(100);
	});
	test('ignores other messages, unknown windows and bad JSON', () => {
		expect(parseRateLimit(JSON.stringify({ type: 'system' }), NOW)).toBeNull();
		expect(parseRateLimit(event({ rateLimitType: 'hourly', utilization: 0.5 }), NOW)).toBeNull();
		expect(parseRateLimit(event({ status: 'allowed', rateLimitType: 'five_hour' }), NOW)).toBeNull();
		expect(parseRateLimit('{oops', NOW)).toBeNull();
	});
});

test('liveWindows drops windows that have reset and keeps Claude order', () => {
	const ws = [win('seven_day', 40, NOW + 1000), win('five_hour', 10, NOW + 1000), win('seven_day_opus', 90, NOW - 1)];
	expect(liveWindows(ws, NOW).map((w) => w.id)).toEqual(['five_hour', 'seven_day']);
});

test('headline is the most used window, earliest reset on a tie', () => {
	expect(headline([win('five_hour', 30), win('seven_day', 71)])?.id).toBe('seven_day');
	expect(headline([win('seven_day', 50, NOW + 9), win('five_hour', 50, NOW + 1)])?.id).toBe('five_hour');
	expect(headline([])).toBeNull();
});

test('labels', () => {
	expect(percentLabel(71.4, 'used')).toBe('71% used');
	expect(percentLabel(71.4, 'remaining')).toBe('29% left');
	expect(resetIn(NOW + (3 * 24 + 6) * 3_600_000 + 5 * 60_000, NOW)).toBe('3d 6h');
	expect(resetIn(NOW + 134 * 60_000, NOW)).toBe('2h 14m');
	expect(resetIn(NOW + 45 * 60_000, NOW)).toBe('45m');
	expect(resetIn(NOW + 10_000, NOW)).toBe('<1m');
	expect(resetIn(null, NOW)).toBe('');
	expect(severity({ utilization: 50, status: 'allowed' })).toBe('ok');
	expect(severity({ utilization: 71, status: 'allowed' })).toBe('warn');
	expect(severity({ utilization: 20, status: 'rejected' })).toBe('critical');
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
	expect(s.days).toHaveLength(7);
});
