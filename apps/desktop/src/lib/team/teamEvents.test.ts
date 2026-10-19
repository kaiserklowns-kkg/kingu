/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { createSnapEventRouter, createTeamEventRouter, needsFocusReload, type Timers } from './teamEvents.ts';

/** Manual clock: `advance` runs timers that come due. */
function fakeTimers() {
	let now = 0;
	let seq = 0;
	const due = new Map<number, { at: number; fn: () => void }>();
	const timers: Timers = {
		set: (fn, ms) => (due.set(++seq, { at: now + ms, fn }), seq),
		clear: (h) => void due.delete(h as number)
	};
	const advance = (ms: number) => {
		now += ms;
		for (const [id, t] of [...due].sort((a, b) => a[1].at - b[1].at)) {
			if (t.at <= now) {
				due.delete(id);
				t.fn();
			}
		}
	};
	return { timers, advance, pending: () => due.size };
}

describe('createSnapEventRouter', () => {
	test('snap events reload the catalog once per burst', () => {
		const clock = fakeTimers();
		let reloads = 0;
		const r = createSnapEventRouter(() => reloads++, 100, clock.timers);
		expect(r.event({ kind: 'snap.updated' })).toBe(true);
		clock.advance(60);
		expect(r.event({ kind: 'snap.removed' })).toBe(true);
		clock.advance(60);
		expect(reloads).toBe(0);
		clock.advance(40);
		expect(reloads).toBe(1);
		r.event({ kind: 'snap.updated' });
		clock.advance(100);
		expect(reloads).toBe(2);
	});

	test('reset reloads; task and run events are ignored', () => {
		const clock = fakeTimers();
		let reloads = 0;
		const r = createSnapEventRouter(() => reloads++, 50, clock.timers);
		for (const kind of ['task.created', 'task.updated', 'run.created', 'run.updated', 'message', 'snapshot']) expect(r.event({ kind })).toBe(false);
		clock.advance(100);
		expect(reloads).toBe(0);
		expect(r.event({ kind: 'reset' })).toBe(true);
		clock.advance(50);
		expect(reloads).toBe(1);
	});

	test('reloads when the stream (re)connects, not on every status update', () => {
		const clock = fakeTimers();
		let reloads = 0;
		const r = createSnapEventRouter(() => reloads++, 10, clock.timers);
		r.stream('reconnecting');
		r.stream('connected');
		r.stream('connected');
		clock.advance(10);
		expect(reloads).toBe(1);
		r.stream('reconnecting');
		r.stream('connected');
		clock.advance(10);
		expect(reloads).toBe(2);
		r.stream(undefined);
		r.stream('connected');
		clock.advance(10);
		expect(reloads).toBe(3);
	});

	test('dispose cancels a pending reload', () => {
		const clock = fakeTimers();
		let reloads = 0;
		const r = createSnapEventRouter(() => reloads++, 10, clock.timers);
		r.event({ kind: 'snap.updated' });
		r.dispose();
		expect(clock.pending()).toBe(0);
		clock.advance(20);
		expect(reloads).toBe(0);
	});
});

test('focus reload is only a fallback while the stream is down', () => {
	expect(needsFocusReload('connected')).toBe(false);
	expect(needsFocusReload('reconnecting')).toBe(true);
	expect(needsFocusReload('off')).toBe(true);
	expect(needsFocusReload(undefined)).toBe(true);
});

describe('createTeamEventRouter', () => {
	test('only its own kinds (and reset) reload', () => {
		const clock = fakeTimers();
		let reloads = 0;
		const r = createTeamEventRouter('skill.', () => reloads++, 10, clock.timers);
		for (const kind of ['snap.updated', 'artifact.shared', 'task.created', 'skills']) expect(r.event({ kind })).toBe(false);
		expect(r.event({ kind: 'skill.shared' })).toBe(true);
		expect(r.event({ kind: 'skill.removed' })).toBe(true);
		clock.advance(10);
		expect(reloads).toBe(1);
		expect(r.event({ kind: 'reset' })).toBe(true);
		clock.advance(10);
		expect(reloads).toBe(2);
	});
});
