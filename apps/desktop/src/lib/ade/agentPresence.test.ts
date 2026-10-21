import { describe, expect, test } from 'bun:test';
import { checkLiveness, EXIT_GRACE_MS, hookFresh, paneRow, removalGate, rowCardStatus, rowText, STALE_AFTER_MS, topRow, withPaneAgents, type Liveness } from './agentPresence';
import { initialHookState, type HookState } from './agentHooks';
import { applyTitle } from './agentTitle';
import type { TaskRuntime } from './model';

const fg = (name = 'claude') => ({ key: 'k', alive: true, foreground: { pid: 7, name } });
const shell = { key: 'k', alive: true, foreground: null };

describe('checkLiveness', () => {
	test('a key never listed (shell not spawned yet) is not an exit', () => {
		let l: Liveness | undefined;
		for (let i = 0; i < 5; i++) l = checkLiveness(l, undefined, 100_000 * i);
		expect(l!.ended).toBe(false);
	});

	test('the CLI in front, then the shell back in front twice: ended', () => {
		let l = checkLiveness(undefined, fg(), 0);
		expect(l).toMatchObject({ seen: true, ended: false });
		l = checkLiveness(l, shell, 1000);
		expect(l.ended).toBe(false);
		l = checkLiveness(l, shell, 2000);
		expect(l.ended).toBe(true);
		// Ended stays ended.
		expect(checkLiveness(l, fg(), 3000).ended).toBe(true);
	});

	test('a blip of the shell in front between two CLI readings is forgiven', () => {
		let l = checkLiveness(undefined, fg(), 0);
		l = checkLiveness(l, shell, 1000);
		l = checkLiveness(l, fg(), 2000);
		l = checkLiveness(l, shell, 3000);
		expect(l.ended).toBe(false);
	});

	test('a new shell gets a grace period before its idle prompt counts', () => {
		let l = checkLiveness(undefined, shell, 0);
		l = checkLiveness(l, shell, 5000);
		l = checkLiveness(l, shell, EXIT_GRACE_MS - 1);
		expect(l.ended).toBe(false);
		l = checkLiveness(l, shell, EXIT_GRACE_MS + 1);
		l = checkLiveness(l, shell, EXIT_GRACE_MS + 2);
		expect(l.ended).toBe(true);
	});

	test('a dead shell or a key gone from the list ends it', () => {
		expect(checkLiveness(undefined, { key: 'k', alive: false }, 0).ended).toBe(true);
		let l = checkLiveness(undefined, fg(), 0);
		l = checkLiveness(l, undefined, 1);
		l = checkLiveness(l, undefined, 2);
		expect(l.ended).toBe(true);
	});

	test('without foreground reports (Windows) only a dead shell ends it', () => {
		let l = checkLiveness(undefined, shell, 0, false);
		for (let i = 1; i < 5; i++) l = checkLiveness(l, shell, EXIT_GRACE_MS * i, false);
		expect(l.ended).toBe(false);
	});
});

describe('hookFresh', () => {
	const working: HookState = { ...initialHookState(0), phase: 'working', hooks: true, at: 0 };
	test('working decays after 30 minutes without events; other phases do not', () => {
		expect(hookFresh(working, STALE_AFTER_MS)).toBe(true);
		expect(hookFresh(working, STALE_AFTER_MS + 1)).toBe(false);
		expect(hookFresh({ ...working, phase: 'idle' }, STALE_AFTER_MS * 3)).toBe(true);
	});
});

describe('paneRow', () => {
	const hook = (patch: Partial<HookState>): HookState => ({ ...initialHookState(0), hooks: true, ...patch });
	test('the shell at its prompt: no agent', () => {
		expect(paneRow({ id: 'p', foreground: null, title: applyTitle(undefined, '⠂ x', 0) }, 1)).toBe(null);
	});
	test('hooks win over the title', () => {
		const r = paneRow({ id: 'p', foreground: 'node', hookAgent: 'gemini', hook: hook({ phase: 'waiting', permission: true, message: 'Allow?', at: 5 }), title: applyTitle(undefined, '✦ gemini', 1) }, 10);
		expect(r).toEqual({ id: 'p', agent: 'gemini', state: 'permission', message: 'Allow?', at: 5 });
	});
	test('a stale working hook falls back to the title', () => {
		const r = paneRow({ id: 'p', hook: hook({ phase: 'working', at: 0 }), title: applyTitle(undefined, '✳ done', 1) }, STALE_AFTER_MS + 10);
		expect(r?.state).toBe('idle');
		expect(r?.agent).toBe('claude');
	});
	test('a question from hooks', () => {
		expect(paneRow({ id: 'p', hook: hook({ phase: 'waiting', question: true, at: 1 }) }, 2)?.state).toBe('question');
	});
	test('a hookless, titleless agent program uses output timing; other programs are no agent', () => {
		expect(paneRow({ id: 'p', foreground: 'aider', lastOutput: 1000 }, 2000)?.state).toBe('working');
		expect(paneRow({ id: 'p', foreground: 'aider', lastOutput: 1000 }, 10_000)?.state).toBe('idle');
		expect(paneRow({ id: 'p', foreground: 'vim', lastOutput: 1000 }, 2000)).toBe(null);
	});
});

describe('withPaneAgents', () => {
	const base: TaskRuntime = { slug: 's', status: 'review', runStatus: 'idle', live: true, working: false, lastEvent: 'done', pendingPermissions: 0, sessionId: 'x', updatedAt: 5 };
	test('no rows: the base as it is', () => {
		expect(withPaneAgents('s', base, [])).toBe(base);
		expect(withPaneAgents('s', undefined, [])).toBeUndefined();
	});
	test('panes alone make a runtime', () => {
		const rt = withPaneAgents('s', undefined, [{ id: 'a', agent: 'claude', state: 'working', at: 3 }]);
		expect(rt).toMatchObject({ status: 'running', working: true, live: true, updatedAt: 3 });
	});
	test('a pane that needs you raises an idle base; a working base is not lowered by an idle pane', () => {
		const up = withPaneAgents('s', base, [{ id: 'a', agent: 'codex', state: 'permission', message: 'Allow rm?', at: 9 }]);
		expect(up).toMatchObject({ status: 'waiting', lastEvent: 'Allow rm?', pendingPermissions: 1, updatedAt: 9, sessionId: 'x' });
		const busy = { ...base, status: 'running' as const, working: true };
		expect(withPaneAgents('s', busy, [{ id: 'a', agent: null, state: 'idle', at: 1 }])).toMatchObject({ status: 'running', working: true });
	});
	test('topRow: needs you, then working, newest first', () => {
		expect(topRow([{ id: 'a', agent: null, state: 'working', at: 1 }, { id: 'b', agent: null, state: 'question', at: 0 }])?.id).toBe('b');
		expect(topRow([{ id: 'a', agent: null, state: 'idle', at: 1 }, { id: 'b', agent: null, state: 'idle', at: 2 }])?.id).toBe('b');
	});
});

describe('rowText', () => {
	test('agent name and message, else the state', () => {
		expect(rowText({ id: 'a', agent: 'claude', state: 'working', message: 'Using Bash', at: 0 })).toBe('Claude - Using Bash');
		expect(rowText({ id: 'a', agent: null, state: 'idle', at: 0 })).toBe('Agent - Waiting for you');
		expect(rowCardStatus({ id: 'a', agent: null, state: 'question', at: 0 })).toBe('permission');
	});
});

describe('removalGate', () => {
	test('a working timeline run blocks; a terminal agent asks; otherwise go', () => {
		expect(removalGate(true, true)).toBe('block');
		expect(removalGate(false, true)).toBe('confirm');
		expect(removalGate(false, false)).toBe('ok');
	});
});
