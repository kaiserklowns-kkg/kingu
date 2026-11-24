import { describe, expect, test } from 'bun:test';
import { buildInbox, foldInbox, isTriageCurrent, parseTriage, priorityOf, sectionOf, snoozeChoices, snoozeState, type InboxEntry } from './sessionInbox.ts';

const NOW = new Date(2026, 10, 24, 14, 0).getTime();

function entry(key: string, patch: Partial<InboxEntry> = {}): InboxEntry {
	return { key, source: 'task', need: 'review', title: key, detail: '', where: 'repo', updatedAt: NOW - 1000, activity: `${patch.need ?? 'review'}:1`, ...patch };
}

describe('sections (VS Code getSessionInboxSection)', () => {
	test('needs you, failures and finished work are Inbox; working is Working', () => {
		expect(sectionOf(entry('a', { need: 'approval' }), undefined)).toBe('inbox');
		expect(sectionOf(entry('a', { need: 'question' }), undefined)).toBe('inbox');
		expect(sectionOf(entry('a', { need: 'failed' }), undefined)).toBe('inbox');
		expect(sectionOf(entry('a', { need: 'review' }), undefined)).toBe('inbox');
		expect(sectionOf(entry('a', { need: 'working' }), undefined)).toBe('working');
	});

	test('triage places it: dismissed is Acknowledged, held and snoozed are On hold', () => {
		const e = entry('a', { need: 'approval' });
		expect(sectionOf(e, { kind: 'done', activity: e.activity })).toBe('acknowledged');
		expect(sectionOf(e, { kind: 'hold' })).toBe('onHold');
		expect(sectionOf(e, { kind: 'snoozed', until: NOW + 1 })).toBe('onHold');
		expect(sectionOf(e, { kind: 'untilActivity', activity: e.activity })).toBe('onHold');
		// Even a working session can be held (it keeps working; nothing is paused).
		expect(sectionOf(entry('w', { need: 'working' }), { kind: 'hold' })).toBe('onHold');
	});
});

describe('triage stays until (VS Code isSessionInboxStateCurrent)', () => {
	test('a dismissal ends with new activity', () => {
		const e = entry('a');
		const state = { kind: 'done' as const, activity: e.activity };
		expect(isTriageCurrent(state, e, NOW)).toBe(true);
		expect(isTriageCurrent(state, { ...e, activity: 'approval:2' }, NOW)).toBe(false);
	});

	test('Put on Hold lasts until resumed; a snooze ends at its time', () => {
		expect(isTriageCurrent({ kind: 'hold' }, entry('a', { activity: 'new' }), NOW + 1e9)).toBe(true);
		expect(isTriageCurrent({ kind: 'snoozed', until: NOW + 60_000 }, entry('a'), NOW)).toBe(true);
		expect(isTriageCurrent({ kind: 'snoozed', until: NOW }, entry('a'), NOW)).toBe(false);
	});

	test('kept while the session is not listed (another folder still loading)', () => {
		expect(isTriageCurrent({ kind: 'done', activity: 'x' }, undefined, NOW)).toBe(true);
	});
});

describe('buildInbox', () => {
	test('priority Now (needs input), Next (failed), Later; newest first within', () => {
		const list = [
			entry('review-old', { need: 'review', updatedAt: 1 }),
			entry('failed', { need: 'failed' }),
			entry('review-new', { need: 'review', updatedAt: 5 }),
			entry('question', { need: 'question' }),
			entry('approval', { need: 'approval' }),
			entry('working', { need: 'working' })
		];
		const v = buildInbox(list, {}, NOW);
		expect(v.inbox.map((e) => e.key)).toEqual(['approval', 'question', 'failed', 'review-new', 'review-old']);
		expect(v.working.map((e) => e.key)).toEqual(['working']);
		expect([priorityOf('approval'), priorityOf('question'), priorityOf('failed'), priorityOf('review')]).toEqual([0, 0, 1, 2]);
	});

	test('triage moves entries and expired triage is reported and ignored', () => {
		const a = entry('a', { need: 'approval' });
		const b = entry('b', { need: 'review' });
		const c = entry('c', { need: 'failed' });
		const v = buildInbox([a, b, c], { a: { kind: 'done', activity: a.activity }, b: { kind: 'snoozed', until: NOW - 1 }, c: { kind: 'done', activity: 'older' } }, NOW);
		expect(v.acknowledged.map((e) => e.key)).toEqual(['a']);
		// b's snooze ended and c has new activity: both back where their status puts them.
		expect(v.inbox.map((e) => e.key)).toEqual(['c', 'b']);
		expect(v.expired.sort()).toEqual(['b', 'c']);
	});

	test('the three sources share one list', () => {
		const v = buildInbox([entry('task:/r:x', { source: 'task', need: 'approval' }), entry('chat:/r:1', { source: 'chat', need: 'question' }), entry('ssh:tab', { source: 'ssh', need: 'approval' })], {}, NOW);
		expect(v.inbox.map((e) => e.source).sort()).toEqual(['chat', 'ssh', 'task']);
	});
});

describe('fold (Orca needsYouFold)', () => {
	const rows = (n: number, approvals = 0) => Array.from({ length: n }, (_, i) => entry(`r${i}`, { need: i < approvals ? 'approval' : 'review' }));

	test('five rows, then a footer only when it hides two or more', () => {
		expect(foldInbox(rows(6), false)).toMatchObject({ folds: false, hidden: 0 });
		const f = foldInbox(rows(8), false);
		expect([f.folds, f.hidden, f.visible.length]).toEqual([true, 3, 5]);
		expect(foldInbox(rows(8), true)).toMatchObject({ folds: true, hidden: 0 });
	});

	test('approvals come first and never fold', () => {
		const list = [...rows(3).map((e) => ({ ...e, key: `q${e.key}` })), ...rows(9, 9)];
		const f = foldInbox(list, false);
		expect(f.visible.length).toBe(9);
		expect(f.visible.every((e) => e.need === 'approval')).toBe(true);
		expect(f.hidden).toBe(3);
	});

	test('the focused row stays visible', () => {
		const f = foldInbox(rows(9), false, 'r8');
		expect(f.visible.map((e) => e.key)).toContain('r8');
		expect(f.hidden).toBe(3);
	});
});

describe('snooze (VS Code Snooze… choices)', () => {
	test('times and until new activity', () => {
		const c = snoozeChoices(NOW);
		expect(c.map((x) => x.id)).toEqual(['10m', '30m', '1h', 'tomorrow', 'week', 'activity']);
		expect(c[0]!.until).toBe(NOW + 600_000);
		expect(c[3]!.until).toBe(new Date(2026, 10, 25, 9).getTime());
		expect(c[4]!.until).toBe(new Date(2026, 11, 1, 9).getTime());
		const e = entry('a');
		expect(snoozeState(c[5]!, e)).toEqual({ kind: 'untilActivity', activity: e.activity });
		expect(snoozeState(c[0]!, e)).toEqual({ kind: 'snoozed', until: NOW + 600_000 });
	});
});

describe('parseTriage', () => {
	test('keeps only well-formed states', () => {
		expect(parseTriage({ a: { kind: 'hold' }, b: { kind: 'snoozed', until: 5 }, c: { kind: 'done', activity: 'x' }, d: { kind: 'snoozed', until: 'x' }, e: null, f: { kind: 'nope' } })).toEqual({
			a: { kind: 'hold' },
			b: { kind: 'snoozed', until: 5 },
			c: { kind: 'done', activity: 'x' }
		});
		expect(parseTriage([1, 2])).toEqual({});
		expect(parseTriage('x')).toEqual({});
	});
});
