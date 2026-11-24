import { describe, expect, test } from 'bun:test';
import { answerScope, isIpv4, liveRequest, liveRow, minutesLeft, refreshDue, sortDevices, REFRESH_LEAD_MS } from './mobile';

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
		expect(liveRow('a', { ...base, question: true, ask: { questions: [] } }, 5)).toEqual({ slug: 'a', phase: 'question', message: null, ask: { questions: [] }, at: 5, request: null });
		expect(liveRow('a', { ...base, working: true, lastEvent: 'Using Bash', updatedAt: 9 }, 5)).toEqual({ slug: 'a', phase: 'working', message: 'Using Bash', ask: null, at: 9, request: null });
		expect(liveRow('a', base, 5).phase).toBe('idle');
		expect(liveRow('a', { ...base, live: false }, 5).phase).toBe('ended');
	});
	test('a permission row carries its request; grants only while the hook waits', () => {
		const ask = { tool: 'Bash', detail: 'npm test', grants: [{ kind: 'rule' as const, value: 'Bash(npm test:*)' }] };
		expect(liveRequest(ask, true)).toEqual({ tool: 'Bash', detail: 'npm test', unsandboxed: false, grants: ['rule:Bash(npm test:*)'], rules: ['rule:Bash(npm test:*)'], project_tracked: false, user_tracked: false, held: true });
		expect(liveRequest(ask, false)).toMatchObject({ grants: [], rules: [] });
		expect(liveRequest({ ...ask, unsandboxed: true }, true)).toMatchObject({ unsandboxed: true, grants: [], rules: [] });
		expect(liveRequest(undefined, false)).toBeNull();
		expect(liveRequest(undefined, true)).toEqual({ tool: null, detail: null, unsandboxed: false, grants: [], rules: [], project_tracked: false, user_tracked: false, held: true });
		// "Always allow" saves only the allow rules; a folder or a mode stays a session grant.
		const mixed = { ...ask, grants: [...ask.grants, { kind: 'dir' as const, value: '/w' }, { kind: 'mode' as const, value: 'acceptEdits' }] };
		expect(liveRequest(mixed, true, { project: true })).toMatchObject({ grants: ['rule:Bash(npm test:*)', 'dir:/w', 'mode:acceptEdits'], rules: ['rule:Bash(npm test:*)'], project_tracked: true, user_tracked: false });
		expect(answerScope('allow_session')).toBe('session');
		expect(answerScope('allow_project')).toBe('project');
		expect(answerScope('allow_user')).toBe('user');
		expect(answerScope('allow')).toBeUndefined();
		expect(answerScope('deny')).toBeUndefined();
		const request = liveRequest(ask, true);
		expect(liveRow('a', { ...base, pendingPermissions: 1, request }, 5).request).toEqual(request);
		// Only a permission row has one.
		expect(liveRow('a', { ...base, working: true, request }, 5).request).toBeNull();
	});
});
