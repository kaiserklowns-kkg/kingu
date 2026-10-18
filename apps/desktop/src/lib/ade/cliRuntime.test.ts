import { describe, expect, test } from 'bun:test';
import { cliTaskRuntime } from './cliRuntime';
import { applyHook, initialHookState, type HookState } from './agentHooks';
import { applyTitle } from './agentTitle';
import { STALE_AFTER_MS } from './agentPresence';

const hooked = (phase: HookState['phase'], extra: Partial<HookState> = {}): HookState => ({ ...initialHookState(1000), phase, hooks: true, at: 1000, ...extra });

describe('cliTaskRuntime', () => {
	test('hooks first: working, waiting on a permission, ended', () => {
		expect(cliTaskRuntime('a', { run: ['claude'], hook: hooked('working'), working: false, now: 2000 })).toMatchObject({ status: 'running', working: true, live: true });
		const asks = cliTaskRuntime('a', { run: ['claude'], hook: hooked('waiting', { permission: true }), working: false, now: 2000 });
		expect(asks).toMatchObject({ status: 'waiting', pendingPermissions: 1 });
		const gone = applyHook(hooked('working'), { kingu_hook: 'kingu', event: 'ProcessExit' }, 3000);
		expect(cliTaskRuntime('a', { run: ['claude'], hook: gone, working: false, now: 3000 })).toMatchObject({ runStatus: 'done', live: false, working: false });
	});

	test('a "working" hook that went silent for 30 minutes is not trusted', () => {
		const r = cliTaskRuntime('a', { run: ['claude'], hook: hooked('working'), working: false, now: 1000 + STALE_AFTER_MS + 1 });
		expect(r.working).toBe(false);
	});

	test('then the title, then output timing', () => {
		expect(cliTaskRuntime('a', { run: ['gemini'], title: applyTitle(undefined, '✦ gemini', 1500), working: false, now: 2000 })).toMatchObject({ status: 'running', updatedAt: 1500 });
		expect(cliTaskRuntime('a', { run: ['claude'], title: applyTitle(undefined, 'claude - action required', 1500), working: true, now: 2000 })).toMatchObject({ status: 'waiting', pendingPermissions: 1 });
		expect(cliTaskRuntime('a', { run: ['aider'], working: true, lastOutput: 1900, now: 2000 })).toMatchObject({ status: 'running', updatedAt: 1900 });
		// Another project's CLI without hooks: nothing tells, so it waits for you.
		expect(cliTaskRuntime('a', { run: ['aider'], working: false, now: 2000 })).toMatchObject({ status: 'review', live: true, working: false });
	});

	test('a hooked CLI whose hooks have not reported yet falls back to the other evidence', () => {
		expect(cliTaskRuntime('a', { run: ['claude'], hook: initialHookState(1000), working: true, now: 2000 }).status).toBe('running');
	});
});
