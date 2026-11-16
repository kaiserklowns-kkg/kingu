import { describe, expect, test } from 'bun:test';
import { isStaleAttach, reactToDaemonEvent, uptime } from './daemonGeneration';

const ev = (over: Partial<{ epoch: number; previous: number | null; restarted: boolean }> = {}) => ({ epoch: 20, previous: 10, restarted: false, ...over });

describe('terminal daemon generations', () => {
	test('a terminal without a session ignores the event', () => {
		expect(reactToDaemonEvent(ev({ restarted: true }), 10, false)).toBe('ignore');
	});

	test('the same daemon came back: re-attach, whatever the epoch the terminal remembers', () => {
		for (const seen of [0, 10, 20]) expect([seen, reactToDaemonEvent(ev(), seen, true)]).toEqual([seen, 'reattach']);
	});

	test('a restarted daemon: a session of the old generation (or an unknown one) starts over', () => {
		expect(reactToDaemonEvent(ev({ restarted: true }), 10, true)).toBe('start-over');
		expect(reactToDaemonEvent(ev({ restarted: true }), 0, true)).toBe('start-over');
	});

	test('a restarted daemon: a session already started in the new generation re-attaches', () => {
		expect(reactToDaemonEvent(ev({ restarted: true }), 20, true)).toBe('reattach');
	});

	test('only the daemon’s own refusal counts as a stale attach', () => {
		expect(isStaleAttach('stale-attach: k was in terminal daemon generation 1; this is generation 2')).toBe(true);
		expect(isStaleAttach(new Error('stale-attach: x'))).toBe(false);
		expect(isStaleAttach('The terminal daemon disconnected')).toBe(false);
	});

	test('uptime in the largest two units', () => {
		const now = 1_000_000_000_000;
		const at = (secondsAgo: number) => now / 1000 - secondsAgo;
		expect(uptime(at(30), now)).toBe('0 min');
		expect(uptime(at(185), now)).toBe('3 min');
		expect(uptime(at(2 * 3600 + 5 * 60), now)).toBe('2 h 5 min');
		expect(uptime(at(4 * 86400 + 3600), now)).toBe('4 d 1 h');
		expect(uptime(at(-50), now)).toBe('0 min');
	});
});
