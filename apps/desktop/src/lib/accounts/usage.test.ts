import { describe, expect, test } from 'bun:test';
import { chipText, footerRows, formatDuration, headline, level, percentLine, resetLabel, rowLevel, updatedAgo, windowLabel, type UsageRow } from './usage';
import { setLocale } from '#lib/i18n/index.ts';

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const now = 1_800_000_000_000;

function row(over: Partial<UsageRow> = {}): UsageRow {
	return {
		key: 'claude:own',
		provider: 'claude',
		account_id: null,
		label: 'บัญชีของคุณเอง',
		email: null,
		active: true,
		status: 'ok',
		usage: {
			session: { used_percent: 23, window_minutes: 300, resets_at: now + 2 * H + 5 * MIN },
			weekly: { used_percent: 71.4, window_minutes: 10080, resets_at: now + 3 * D + 6 * H + 30 * MIN },
			plan: 'max'
		},
		updated_at: now,
		failure: null,
		error: null,
		...over
	};
}

describe('durations', () => {
	test('like Orca', () => {
		expect(formatDuration(0)).toBe('now');
		expect(formatDuration(-5)).toBe('now');
		expect(formatDuration(59 * 1000)).toBe('0m');
		expect(formatDuration(42 * MIN)).toBe('42m');
		expect(formatDuration(3 * H)).toBe('3h');
		expect(formatDuration(3 * H + 5 * MIN)).toBe('3h 5m');
		expect(formatDuration(3 * D + 6 * H + 59 * MIN)).toBe('3d 6h');
		expect(formatDuration(2 * D)).toBe('2d');
	});

	test('window lengths when the reset time is unknown', () => {
		expect(windowLabel(300)).toBe('5h');
		expect(windowLabel(10080)).toBe('wk');
		expect(windowLabel(1440)).toBe('1d');
		expect(windowLabel(20160)).toBe('2wk');
		expect(windowLabel(45)).toBe('45m');
		expect(resetLabel({ used_percent: 1, window_minutes: 300, resets_at: null }, now)).toBe('5h');
	});
});

describe('levels', () => {
	test('warning from 60%, urgent from 80%', () => {
		expect(level(59.4)).toBe('normal');
		expect(level(59.5)).toBe('warning');
		expect(level(79)).toBe('warning');
		expect(level(80)).toBe('urgent');
		expect(level(140)).toBe('urgent');
		expect(rowLevel(row())).toBe('warning');
		expect(rowLevel(row({ usage: null }))).toBe('normal');
	});
});

describe('chips', () => {
	test('compact shows the tightest window', () => {
		expect(headline(row().usage)?.name).toBe('weekly');
		expect(chipText(row(), now)).toBe('71% used 3d 6h');
	});

	test('detailed shows session and weekly', () => {
		expect(chipText(row(), now, 'detailed')).toBe('23% used 2h 5m · 71% used 3d 6h');
		expect(chipText(row(), now, 'compact', 'remaining')).toBe('29% left 3d 6h');
		expect(chipText(row(), now, 'detailed', 'remaining')).toBe('77% left 2h 5m · 29% left 3d 6h');
	});

	test('states without numbers', () => {
		expect(chipText(row({ status: 'api_key', usage: null }), now)).toBe('API key');
		expect(chipText(row({ status: 'idle', usage: null }), now)).toBe('···');
		expect(chipText(row({ status: 'error', usage: null }), now)).toBe('—');
		// Stale numbers still show.
		expect(chipText(row({ status: 'stale' }), now)).toBe('71% used 3d 6h');
	});
});

describe('footer rows', () => {
	test('one active, signed-in row per provider, Claude first', () => {
		const rows = [
			row({ key: 'codex:own', provider: 'codex' }),
			row({ key: 'claude:aaaaaaaaaaaa', account_id: 'aaaaaaaaaaaa', active: false }),
			row()
		];
		expect(footerRows(rows).map((r) => r.key)).toEqual(['claude:own', 'codex:own']);
		expect(footerRows([row({ status: 'unavailable' })])).toEqual([]);
	});
});

test('history line is on a fixed 0–100 scale', () => {
	expect(percentLine([], 10, 10)).toBe('');
	expect(percentLine([50], 10, 10)).toBe('0.0,5.0 10.0,5.0');
	expect(percentLine([0, 100], 10, 12)).toBe('0.0,11.0 10.0,1.0');
});

test('updated ago', () => {
	expect(updatedAgo(null, now)).toBe('Never updated');
	expect(updatedAgo(now - 30_000, now)).toBe('Updated just now');
	expect(updatedAgo(now - 5 * MIN, now)).toBe('Updated 5 minutes ago');
	expect(updatedAgo(now - 1 * MIN, now)).toBe('Updated 1 minute ago');
	expect(updatedAgo(now - 3 * H, now)).toBe('Updated 3 hours ago');
	setLocale('th');
	try {
		expect(updatedAgo(now - 5 * MIN, now)).toBe('อัปเดต 5 นาทีที่แล้ว');
		expect(chipText(row(), now)).toBe('ใช้ไป 71% 3d 6h');
	} finally {
		setLocale('en');
	}
});
