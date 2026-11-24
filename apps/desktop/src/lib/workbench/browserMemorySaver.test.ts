import { describe, expect, test } from 'bun:test';
import { createAwakeClock, createMemorySaver, memorySaverHours, memorySaverPolicy, MEMORY_SAVER_RETRY_MS } from './browserMemorySaver';

const HOUR = 60 * 60_000;

/** A clock and timers the test moves by hand. */
function harness() {
	let now = 0;
	let timers: { at: number; run: () => void }[] = [];
	const saver = createMemorySaver({
		now: () => now,
		setTimer: (run, ms) => {
			const t = { at: now + ms, run };
			timers.push(t);
			return t;
		},
		clearTimer: (t) => {
			timers = timers.filter((x) => x !== t);
		}
	});
	return {
		saver,
		/** Moves the clock, running the timers that come due, then lets the answers settle. */
		async advance(ms: number) {
			const end = now + ms;
			for (;;) {
				const next = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
				if (!next) break;
				now = Math.max(now, next.at);
				timers = timers.filter((t) => t !== next);
				next.run();
				await new Promise((r) => setTimeout(r, 0));
			}
			now = end;
			await new Promise((r) => setTimeout(r, 0));
		}
	};
}

/** A tab's page: counts the times it was asked, and answers `ok`. */
function page(ok: boolean | (() => boolean) = true) {
	const p = { asked: 0, free: async () => ((p.asked += 1), typeof ok === 'function' ? ok() : ok) };
	return p;
}

describe('memory saver settings (Orca browser-memory-saver.ts)', () => {
	test('hours are whole, in range, and default to 4', () => {
		expect(memorySaverHours(undefined)).toBe(4);
		expect(memorySaverHours('8')).toBe(4);
		expect(memorySaverHours(Number.NaN)).toBe(4);
		expect(memorySaverHours(0)).toBe(1);
		expect(memorySaverHours(2.6)).toBe(3);
		expect(memorySaverHours(1000)).toBe(168);
	});
	test('on unless switched off', () => {
		expect(memorySaverPolicy(undefined, undefined)).toEqual({ enabled: true, idleMs: 4 * HOUR });
		expect(memorySaverPolicy(false, 2)).toEqual({ enabled: false, idleMs: 2 * HOUR });
		expect(memorySaverPolicy('no', 2).enabled).toBe(true);
	});
});

describe('awake clock', () => {
	test('time asleep does not count', () => {
		let wall = 1_000_000;
		const clock = createAwakeClock(() => wall, 120_000);
		wall += 60_000;
		expect(clock.now()).toBe(60_000);
		// The lid was closed for eight hours: one step at most.
		wall += 8 * HOUR;
		expect(clock.now()).toBe(180_000);
		// A clock set back never runs the time backwards.
		wall -= HOUR;
		expect(clock.now()).toBe(180_000);
		wall += 30_000;
		clock.tick();
		expect(clock.now()).toBe(210_000);
	});
});

describe('memory saver', () => {
	test('a hidden tab is freed after the hours, a shown one never', async () => {
		const h = harness();
		const [hidden, shown] = [page(), page()];
		h.saver.report('hidden', false, hidden.free);
		h.saver.report('shown', true, shown.free);
		await h.advance(4 * HOUR - 1);
		expect(hidden.asked).toBe(0);
		await h.advance(1);
		expect(hidden.asked).toBe(1);
		await h.advance(100 * HOUR);
		// Freed once; the shown tab was never asked.
		expect(hidden.asked).toBe(1);
		expect(shown.asked).toBe(0);
		expect(h.saver.waiting()).toBe(0);
	});

	test('showing a tab starts its time over, and frees it again after the next hidden spell', async () => {
		const h = harness();
		const p = page();
		h.saver.report('a', false, p.free);
		await h.advance(3 * HOUR);
		h.saver.report('a', true, p.free);
		await h.advance(10 * HOUR);
		expect(p.asked).toBe(0);
		h.saver.report('a', false, p.free);
		await h.advance(4 * HOUR);
		expect(p.asked).toBe(1);
		// Shown (the page loads again), hidden again: a new spell.
		h.saver.report('a', true, p.free);
		h.saver.report('a', false, p.free);
		await h.advance(4 * HOUR);
		expect(p.asked).toBe(2);
	});

	test('a page that refuses stays, and is asked again later while it stays hidden', async () => {
		const h = harness();
		let ok = false;
		const p = page(() => ok);
		h.saver.report('a', false, p.free);
		await h.advance(4 * HOUR);
		expect(p.asked).toBe(1);
		await h.advance(MEMORY_SAVER_RETRY_MS - 1);
		expect(p.asked).toBe(1);
		ok = true;
		await h.advance(1);
		expect(p.asked).toBe(2);
		await h.advance(10 * HOUR);
		expect(p.asked).toBe(2);
	});

	test('a failing free counts as a refusal', async () => {
		const h = harness();
		const p = { asked: 0, free: async (): Promise<boolean> => ((p.asked += 1), Promise.reject(new Error('gone'))) };
		h.saver.report('a', false, p.free);
		await h.advance(4 * HOUR);
		expect(p.asked).toBe(1);
		expect(h.saver.waiting()).toBe(1);
	});

	test('switched off frees nothing; switching on or shortening the hours applies at once', async () => {
		const h = harness();
		const p = page();
		h.saver.configure(memorySaverPolicy(false, 4));
		h.saver.report('a', false, p.free);
		await h.advance(50 * HOUR);
		expect(p.asked).toBe(0);
		h.saver.configure(memorySaverPolicy(true, 4));
		await h.advance(0);
		expect(p.asked).toBe(1);

		const q = page();
		h.saver.report('b', false, q.free);
		await h.advance(2 * HOUR);
		expect(q.asked).toBe(0);
		h.saver.configure(memorySaverPolicy(true, 1));
		await h.advance(0);
		expect(q.asked).toBe(1);
	});

	test('a closed tab is never asked', async () => {
		const h = harness();
		const p = page();
		h.saver.report('a', false, p.free);
		h.saver.close('a');
		await h.advance(10 * HOUR);
		expect(p.asked).toBe(0);
	});

	test('a tab the user keeps coming back to is left alone (Orca: more than 15 revisits)', async () => {
		const h = harness();
		const p = page();
		h.saver.report('a', false, p.free);
		for (let i = 0; i < 16; i++) {
			h.saver.report('a', true, p.free);
			h.saver.report('a', false, p.free);
		}
		await h.advance(100 * HOUR);
		expect(p.asked).toBe(0);
		expect(h.saver.waiting()).toBe(0);
	});

	test('at most four pages are asked at a time, longest hidden first', async () => {
		const h = harness();
		const order: string[] = [];
		const release: (() => void)[] = [];
		for (let i = 0; i < 6; i++) {
			h.saver.report(`t${i}`, false, () => {
				order.push(`t${i}`);
				return new Promise<boolean>((r) => release.push(() => r(true)));
			});
			await h.advance(1000);
		}
		await h.advance(4 * HOUR);
		expect(order).toEqual(['t0', 't1', 't2', 't3']);
		release.splice(0).forEach((r) => r());
		// The answers settle first, then the next batch's timer runs.
		await h.advance(0);
		await h.advance(0);
		expect(order).toEqual(['t0', 't1', 't2', 't3', 't4', 't5']);
	});

	test('the latest free of a tab is the one called', async () => {
		const h = harness();
		const [old, latest] = [page(), page()];
		h.saver.report('a', false, old.free);
		h.saver.report('a', false, latest.free);
		await h.advance(4 * HOUR);
		expect([old.asked, latest.asked]).toEqual([0, 1]);
	});
});
