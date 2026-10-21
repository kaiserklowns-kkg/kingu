import { describe, expect, test } from 'bun:test';
import { DEFAULT_IDLE_MINUTES, hibernationCandidates, idleMs, type HibernationRow } from './hibernation';

const MIN = 60_000;
const row = (slug: string, over: Partial<HibernationRow> = {}): HibernationRow => ({
	slug,
	phase: 'idle',
	waiting: false,
	ended: false,
	resumable: true,
	foreground: false,
	hookAt: 0,
	outputAt: 1,
	seenAt: undefined,
	...over
});

describe('agent hibernation', () => {
	test('idle time: the setting in minutes, else the default', () => {
		expect(idleMs(5)).toBe(5 * MIN);
		for (const bad of [undefined, 0, -3, NaN, 'x', 24 * 60 + 1]) expect(idleMs(bad)).toBe(DEFAULT_IDLE_MINUTES * MIN);
	});

	test('only a finished, resumable, unseen CLI idle for the whole time goes', () => {
		const now = 100 * MIN;
		const idle = 30 * MIN;
		const rows = [
			row('quiet', { outputAt: now - 31 * MIN }),
			row('recent-output', { outputAt: now - 5 * MIN }),
			row('just-seen', { outputAt: now - 60 * MIN, seenAt: now - 2 * MIN }),
			row('late-hook', { outputAt: now - 60 * MIN, hookAt: now - 10 * MIN }),
			row('working', { phase: 'working', outputAt: 1 }),
			row('no-hooks', { phase: undefined, outputAt: 1 }),
			row('asks', { waiting: true, outputAt: 1 }),
			row('gone', { ended: true, outputAt: 1 }),
			row('no-session', { resumable: false, outputAt: 1 }),
			row('on-screen', { foreground: true, outputAt: 1 }),
			row('never-seen', { outputAt: undefined, hookAt: undefined }),
			row('a-quiet', { outputAt: now - idle })
		];
		expect(hibernationCandidates(rows, now, idle)).toEqual(['a-quiet', 'quiet']);
	});
});
