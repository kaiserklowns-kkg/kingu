import { describe, expect, test } from 'bun:test';
import { isIpv4, liveRow, minutesLeft, refreshDue, sortDevices, REFRESH_LEAD_MS } from './mobile';

describe('mobile pairing helpers', () => {
	test('minutes left round up and stop at zero', () => {
		expect(minutesLeft(600_000, 0)).toBe(10);
		expect(minutesLeft(600_000, 1)).toBe(10);
		expect(minutesLeft(600_000, 540_001)).toBe(1);
		expect(minutesLeft(600_000, 700_000)).toBe(0);
	});

	test('a code is refreshed a minute before it expires', () => {
		expect(refreshDue(600_000, 600_000 - REFRESH_LEAD_MS - 1)).toBe(false);
		expect(refreshDue(600_000, 600_000 - REFRESH_LEAD_MS)).toBe(true);
	});

	test('IPv4 check', () => {
		expect(isIpv4('192.168.1.5')).toBe(true);
		expect(isIpv4(' 100.64.0.1 ')).toBe(true);
		expect(isIpv4('256.1.1.1')).toBe(false);
		expect(isIpv4('example.com')).toBe(false);
		expect(isIpv4('::1')).toBe(false);
	});

	test('devices newest first', () => {
		const d = (id: string, paired_at: number) => ({ id, name: id, paired_at, last_seen_at: 0 });
		expect(sortDevices([d('a', 1), d('b', 3), d('c', 2)]).map((x) => x.id)).toEqual(['b', 'c', 'a']);
	});
});

describe('live rows for the phone', () => {
	const base = { live: true, working: false, pendingPermissions: 0 };
	test('needs-you states win over working', () => {
		expect(liveRow('a', { ...base, working: true, pendingPermissions: 1 }, 5).phase).toBe('permission');
		expect(liveRow('a', { ...base, question: true, ask: { questions: [] } }, 5)).toEqual({ slug: 'a', phase: 'question', message: null, ask: { questions: [] }, at: 5 });
		expect(liveRow('a', { ...base, working: true, lastEvent: 'Using Bash', updatedAt: 9 }, 5)).toEqual({ slug: 'a', phase: 'working', message: 'Using Bash', ask: null, at: 9 });
		expect(liveRow('a', base, 5).phase).toBe('idle');
		expect(liveRow('a', { ...base, live: false }, 5).phase).toBe('ended');
	});
});
