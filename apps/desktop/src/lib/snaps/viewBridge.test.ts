/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { NOTIFY_LIMIT, NOTIFY_WINDOW_MS, parseRequest, TASK_LIMIT, themeMessage, ViewBridge } from './viewBridge.ts';
import type { SnapView } from './contributions.ts';

const view: SnapView = { id: 'board', name: 'Board', location: 'panel', path: 'views/board.html', settings: ['greeting'], tasks: ['hello'], notifications: true };

function harness(v: SnapView = view) {
	let now = 0;
	const ran: string[] = [];
	const notes: [string, string][] = [];
	const bridge = new ViewBridge('example', v, {
		setting: (key) => ({ greeting: 'hi', secret: 'nope' })[key],
		runTask: (id) => ran.push(id),
		notify: (sev, msg) => notes.push([sev, msg]),
		theme: () => 'dark',
		now: () => now
	});
	const call = (method: string, params: Record<string, unknown> = {}, id = 1) => bridge.handle({ kinguSnapView: 1, id, method, params });
	return { bridge, call, ran, notes, tick: (ms: number) => (now += ms) };
}

describe('snap view bridge', () => {
	test('ignores anything that is not a bridge request', () => {
		const { bridge } = harness();
		for (const data of [null, 'x', { id: 1, method: 'context' }, { kinguSnapView: 2, id: 1, method: 'context' }, { kinguSnapView: 1, id: '1', method: 'context' }, { kinguSnapView: 1, id: 1.5, method: 'x' }]) expect(bridge.handle(data)).toBeNull();
		expect(parseRequest({ kinguSnapView: 1, id: 3, method: 'm', params: [1] })).toEqual({ id: 3, method: 'm', params: {} });
	});

	test('reads only the settings the view declares', () => {
		const { call } = harness();
		expect(call('getSetting', { key: 'greeting' })).toEqual({ kinguSnapView: 1, id: 1, result: 'hi' });
		expect(call('getSetting', { key: 'secret' })?.error).toContain('not declared');
		expect(call('getSetting', {})?.error).toContain('not declared');
	});

	test('runs only declared tasks, rate-limited', () => {
		const { call, ran, tick } = harness();
		expect(call('runTask', { task: 'deploy' })?.error).toContain('not declared');
		for (let i = 0; i < TASK_LIMIT; i++) expect(call('runTask', { task: 'hello' })?.result).toBe(true);
		expect(call('runTask', { task: 'hello' })?.error).toContain('too many');
		expect(ran).toEqual(Array(TASK_LIMIT).fill('hello'));
		tick(6000);
		expect(call('runTask', { task: 'hello' })?.result).toBe(true);
	});

	test('notifications need the permission, are clipped and rate-limited', () => {
		const { call, notes, tick } = harness();
		expect(call('notify', { message: '  hello ', severity: 'warning' })?.result).toBe(true);
		expect(call('notify', { message: 'x'.repeat(900), severity: 'shout' })?.result).toBe(true);
		expect(notes[0]).toEqual(['warning', 'hello']);
		expect(notes[1][0]).toBe('info');
		expect(notes[1][1]).toHaveLength(500);
		expect(call('notify', { message: '' })?.error).toBe('empty message');
		for (let i = notes.length; i < NOTIFY_LIMIT; i++) call('notify', { message: 'n' });
		expect(call('notify', { message: 'flood' })?.error).toContain('too many');
		tick(NOTIFY_WINDOW_MS);
		expect(call('notify', { message: 'later' })?.result).toBe(true);
		const silent = harness({ ...view, notifications: false });
		expect(silent.call('notify', { message: 'hi' })?.error).toContain('not declared');
		expect(silent.notes).toEqual([]);
	});

	test('context and unknown methods', () => {
		const { call } = harness();
		expect(call('context', {}, 7)).toEqual({ kinguSnapView: 1, id: 7, result: { snap: 'example', view: 'board', theme: 'dark' } });
		// Nothing like Tauri's invoke is reachable through the bridge.
		for (const m of ['invoke', 'readFile', '__proto__', 'constructor']) expect(call(m)?.error).toContain('unknown method');
		expect(themeMessage('light')).toEqual({ kinguSnapView: 1, event: 'theme', kind: 'light' });
	});
});
