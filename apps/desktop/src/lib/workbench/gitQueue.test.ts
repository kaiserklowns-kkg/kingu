import { describe, expect, test } from 'bun:test';
import { applyQueueEvent, firstWaiter, type QueueEvent } from './gitQueue';

const ev = (op: string, waiting: boolean, repo = '/r/.git'): QueueEvent => ({ repo, op, running: 'merge kingu/a', waiting });

describe('git queue waiters', () => {
	test('a start adds, a stop removes one matching wait', () => {
		let w = applyQueueEvent([], ev('commit', true));
		w = applyQueueEvent(w, ev('add', true));
		w = applyQueueEvent(w, ev('commit', true, '/other/.git'));
		expect(firstWaiter(w)).toEqual({ op: 'commit', running: 'merge kingu/a', count: 3 });
		w = applyQueueEvent(w, ev('commit', false));
		expect(w.map((x) => [x.op, x.repo])).toEqual([
			['add', '/r/.git'],
			['commit', '/other/.git']
		]);
		w = applyQueueEvent(w, ev('add', false));
		w = applyQueueEvent(w, ev('commit', false, '/other/.git'));
		expect(firstWaiter(w)).toBeNull();
	});

	test('a stop without a start changes nothing', () => {
		expect(applyQueueEvent([ev('add', true)], ev('commit', false))).toHaveLength(1);
	});
});
