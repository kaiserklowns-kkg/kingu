import { describe, expect, test } from 'bun:test';
import {
	autoContinueAt,
	claudeLimitLine,
	codexResetFromText,
	CONTINUE_MESSAGE,
	cutOf,
	limitPhase,
	MAX_OVERDUE_MS,
	nextAutoContinue,
	pooledLimit,
	rejectedRateLimit,
	turnUsageLimit,
	usageLimitOfText
} from './chatLimits';
import type { AgentEvent } from './events';

// 2026-11-24 10:00 in Bangkok (UTC+7, no DST).
const NOW = Date.UTC(2026, 10, 24, 3, 0);
const HOUR = 3600_000;

describe("Claude Code's limit line (Orca claude-limit-line.ts)", () => {
	test('legacy epoch form', () => {
		expect(claudeLimitLine('Claude AI usage limit reached|1795579200', NOW)).toEqual({ resetsAt: 1795579200_000 });
		// A reset more than a month away is not one to wait for.
		expect(claudeLimitLine('Claude AI usage limit reached|1900000000', NOW)).toEqual({});
	});
	test('"resets 3pm (Zone)": the next 3pm in that zone, with its window', () => {
		expect(claudeLimitLine("You've hit your session limit · resets 3pm (Asia/Bangkok)", NOW)).toEqual({ window: 'session', resetsAt: Date.UTC(2026, 10, 24, 8, 0) });
		// 9am has passed there today: tomorrow's.
		expect(claudeLimitLine('You’ve hit your weekly limit · resets 9:30am (Asia/Bangkok)', NOW)).toEqual({ window: 'weekly', resetsAt: Date.UTC(2026, 10, 25, 2, 30) });
		expect(claudeLimitLine("You've hit your limit · resets Nov 27, 3pm (Asia/Bangkok)", NOW)).toEqual({ resetsAt: Date.UTC(2026, 10, 27, 8, 0) });
		expect(claudeLimitLine("You've hit your Opus limit", NOW)).toEqual({});
	});
	test('only the line itself, never prose that mentions limits', () => {
		expect(claudeLimitLine('I think you hit your limit of patience', NOW)).toBeNull();
		expect(claudeLimitLine('resets 3pm', NOW)).toBeNull();
	});
	test('a pooled 429 with its earliest reset', () => {
		expect(pooledLimit('All available accounts have exhausted a shared session or weekly usage limit; earliest reset at 2026-11-24T05:00:00Z', NOW)).toEqual({ resetsAt: Date.UTC(2026, 10, 24, 5) });
		expect(pooledLimit('overloaded', NOW)).toBeNull();
	});
});

describe('other agents', () => {
	test("Codex's try-again time is this machine's, rounded up to the end of its minute", () => {
		const local = new Date(NOW);
		local.setHours(23, 5, 0, 0);
		const text = "You've hit your usage limit. Upgrade to Pro or try again at 11:05 PM.";
		const expected = local.getTime() + 60_000 > NOW ? local.getTime() + 60_000 : undefined;
		expect(codexResetFromText(text, NOW)).toBe(expected);
		expect(usageLimitOfText(text, NOW)).toEqual(expected ? { resetsAt: expected } : {});
		expect(codexResetFromText('try again at Feb 30th, 2027 3:05 PM.', NOW)).toBeUndefined();
	});
	test('quota errors without a reset; transient rate limits are not usage limits', () => {
		expect(usageLimitOfText('[429] RESOURCE_EXHAUSTED: Quota exceeded for model', NOW)).toEqual({});
		expect(usageLimitOfText('Rate limited, retrying', NOW)).toBeNull();
		expect(usageLimitOfText('Overloaded', NOW)).toBeNull();
	});
	test("a rejecting rate_limit_event gives the window and reset; overage or allowed ones don't", () => {
		const line = (info: Record<string, unknown>) => JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info });
		expect(rejectedRateLimit(line({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: NOW / 1000 + 3600 }), NOW)).toEqual({ window: 'weekly', resetsAt: NOW + HOUR });
		expect(rejectedRateLimit(line({ status: 'rejected', rateLimitType: 'five_hour', overageStatus: 'allowed' }), NOW)).toBeNull();
		expect(rejectedRateLimit(line({ status: 'allowed_warning' }), NOW)).toBeNull();
		expect(rejectedRateLimit('not json', NOW)).toBeNull();
	});
});

describe("the latest turn's usage limit", () => {
	const user = (text: string): AgentEvent => ({ kind: 'message', role: 'user', text });
	const said = (text: string): AgentEvent => ({ kind: 'message', role: 'assistant', text });
	const result = (is_error: boolean, text: string | null): AgentEvent => ({ kind: 'result', subtype: is_error ? 'error_during_execution' : 'success', is_error, result: text, session_id: 's', num_turns: 1, duration_ms: 1, total_cost_usd: 0 });
	const line = "You've hit your session limit · resets 3pm (Asia/Bangkok)";

	test('an error result naming the limit', () => {
		expect(turnUsageLimit([user('go'), said(line), result(true, line)], NOW)).toEqual({ window: 'session', resetsAt: Date.UTC(2026, 10, 24, 8) });
	});
	test('the words win; a rate_limit_event fills in what they lack', () => {
		const rejected = { window: 'weekly' as const, resetsAt: NOW + 5 * HOUR };
		expect(turnUsageLimit([user('go'), result(true, line)], NOW, rejected)).toEqual({ window: 'session', resetsAt: Date.UTC(2026, 10, 24, 8) });
		expect(turnUsageLimit([user('go'), result(true, 'Claude AI usage limit reached|bad')], NOW, rejected)).toEqual(rejected);
		expect(turnUsageLimit([user('go'), { kind: 'error', message: "You've hit your limit" }, { kind: 'exit', code: 1, signal: null, stopped: false }], NOW, rejected)).toEqual(rejected);
	});
	test('only the turn since the last request, and only when it failed', () => {
		expect(turnUsageLimit([user('a'), result(true, line), user('b'), said('done'), result(false, 'done')], NOW)).toBeNull();
		// A successful turn that quotes the line is not a cut.
		expect(turnUsageLimit([user('what does this mean?'), said(line), result(false, line)], NOW)).toBeNull();
		expect(turnUsageLimit([user('go'), result(true, 'Tool failed')], NOW)).toBeNull();
	});
});

describe('automatic continue (Orca native-chat-usage-limit-cut.ts)', () => {
	const cut = cutOf({ resetsAt: NOW + HOUR, window: 'session' }, NOW);
	test('at a known reset after the turn ended, up to a day late, unless cancelled', () => {
		expect(cut).toEqual({ at: NOW, resets_at: NOW + HOUR, window: 'session' });
		expect(autoContinueAt(cut, NOW)).toBe(NOW + HOUR);
		expect(autoContinueAt(cut, NOW + HOUR + MAX_OVERDUE_MS)).toBe(NOW + HOUR);
		expect(autoContinueAt(cut, NOW + HOUR + MAX_OVERDUE_MS + 1)).toBeNull();
		expect(autoContinueAt({ ...cut, auto_off: true }, NOW)).toBeNull();
		expect(autoContinueAt(cutOf({}, NOW), NOW)).toBeNull();
		expect(autoContinueAt({ ...cut, resets_at: NOW - 1 }, NOW), 'a reset before the turn ended').toBeNull();
		expect(autoContinueAt(null, NOW)).toBeNull();
	});
	test('the soonest chat goes first', () => {
		const list = [
			{ id: 'a', usage_limit: { ...cut, resets_at: NOW + 2 * HOUR } },
			{ id: 'b', usage_limit: cut },
			{ id: 'c', usage_limit: { ...cut, auto_off: true, resets_at: NOW + 1 } },
			{ id: 'd' }
		];
		expect(nextAutoContinue(list, NOW)).toEqual({ id: 'b', at: NOW + HOUR });
		expect(nextAutoContinue([{ id: 'd', usage_limit: null }], NOW)).toBeNull();
	});
	test('phases and the message', () => {
		expect(limitPhase(cut, NOW)).toBe('waiting');
		expect(limitPhase(cut, NOW + HOUR)).toBe('ready');
		expect(limitPhase(cutOf({}, NOW), NOW)).toBe('unknown');
		expect(CONTINUE_MESSAGE).toBe('Continue where you left off.');
	});
});
