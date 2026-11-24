// Per-agent ACP differences (src/runtimes/acpDialects.ts, Orca's dialects and permissionModeConfig):
// the table itself, then the session against the fake agent (fixtures/fake-acp.ts) started under
// the agent's program name, the way Rust starts the real one.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHost } from '../src/host.ts';
import type { AgentEvent, PermissionMode } from '../src/protocol.ts';
import { acpDialect, enforcedMode, modeSetting, withheldCommand } from '../src/runtimes/acpDialects.ts';

type Out = { id?: number | string | null; method?: string; params?: any; result?: unknown; error?: { code: number; message: string } };

const dirs: string[] = [];
const hosts: AgentHost[] = [];
afterEach(async () => {
	await Promise.all(hosts.splice(0).map((h) => h.dispatch('shutdown', null)));
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A run of the fake agent whose program is called `program` (a link to this bun). */
function setup(program: string) {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'kingu-dialect-')));
	dirs.push(cwd);
	const command = join(cwd, program);
	symlinkSync(process.execPath, command);
	const runtime = { kind: 'acp', command, args: [join(import.meta.dir, 'fixtures/fake-acp.ts')] };
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
	const next = (pred: (o: Out) => boolean, ms = 8000) =>
		new Promise<Out>((resolve, reject) => {
			const hit = out.find(pred);
			if (hit) return resolve(hit);
			waiters.push({ pred, resolve });
			setTimeout(() => reject(new Error('timed out waiting for host output')), ms);
		});
	const events = () => out.filter((o) => o.method === 'event').map((o) => o.params.event as AgentEvent);
	const event = <K extends AgentEvent['kind']>(kind: K, after = 0) =>
		next((o) => o.method === 'event' && o.params.event.kind === kind && out.indexOf(o) >= after).then((o) => o.params.event as Extract<AgentEvent, { kind: K }>);
	const stderr = (line: string, after = 0) => next((o) => o.method === 'event' && o.params.event.kind === 'stderr' && o.params.event.line === line && out.indexOf(o) >= after);
	const lines = () => events().flatMap((e) => (e.kind === 'stderr' ? [e.line] : []));
	const call = async (id: number, method: string, params: unknown) => {
		await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
		return out.findLast((o) => o.id === id)!;
	};
	const start = (o: { prompt?: string; permissionMode?: PermissionMode; env?: Record<string, string> }) => call(1, 'start', { runId: 1, cwd, prompt: o.prompt ?? 'hi', runtime, ...(o.permissionMode ? { permissionMode: o.permissionMode } : {}), env: o.env ?? {} });
	return { cwd, out, events, event, stderr, lines, call, start };
}

describe('the dialect table', () => {
	test("each agent's own mode ids are Orca's (permissionModeConfig.values)", () => {
		expect(acpDialect('/usr/local/bin/droid').modes).toEqual({ ask: 'normal', auto: 'auto-medium', fullAccess: 'auto-high' });
		expect(acpDialect('kimi').modes).toEqual({ ask: 'default', auto: 'yolo', fullAccess: 'auto' });
		expect(acpDialect('/h/.hermes/bin/hermes').modes).toEqual({ ask: 'ask', acceptEdits: 'workspace_session', fullAccess: 'session' });
		expect(acpDialect('qwen').modes).toEqual({ ask: 'default', acceptEdits: 'auto-edit', auto: 'auto', fullAccess: 'yolo' });
		expect(acpDialect('C:\\Tools\\Goose.EXE').modes).toEqual({ ask: 'approve', auto: 'smart_approve', fullAccess: 'auto' });
		// Agents whose requests Kingu answers itself, and anything unknown, have no mode table.
		for (const other of ['gemini', 'opencode', 'cursor-agent', 'copilot', 'kiro-cli', 'grok', 'my-agent', 'constructor', '']) expect([other, acpDialect(other).modes]).toEqual([other, undefined]);
	});

	test("Kingu's permission modes as the agent's: never wider than asked", () => {
		const kimi = acpDialect('kimi').modes!;
		// Kimi's `yolo` is ask-when-needed: Allow all is its `auto`, and nothing else reaches either.
		expect((['default', 'assisted', 'acceptEdits', 'plan', 'bypassPermissions'] as const).map((m) => enforcedMode(kimi, m))).toEqual(['default', 'default', 'default', null, 'auto']);
		const qwen = acpDialect('qwen').modes!;
		expect((['default', 'assisted', 'acceptEdits', 'plan', 'bypassPermissions'] as const).map((m) => enforcedMode(qwen, m))).toEqual(['default', 'default', 'auto-edit', null, 'yolo']);
		// Every table: only "Allow all" gives full access, and Orca's auto is not a Kingu chat mode.
		for (const program of ['droid', 'kimi', 'hermes', 'qwen', 'goose']) {
			const modes = acpDialect(program).modes!;
			for (const m of ['default', 'assisted', 'acceptEdits', 'plan'] as const) expect([program, m, enforcedMode(modes, m) === modes.fullAccess || (modes.auto !== undefined && enforcedMode(modes, m) === modes.auto)]).toEqual([program, m, false]);
			expect(enforcedMode(modes, 'bypassPermissions')).toBe(modes.fullAccess!);
		}
	});

	test('the mode config option is found by its category', () => {
		const options = [
			{ id: 'model', category: 'model', type: 'select', currentValue: 'm', options: [{ value: 'm', name: 'M' }] },
			{ id: 'autonomy', category: 'mode', type: 'select', currentValue: 'normal', options: [{ group: 'g', options: [{ value: 'normal', name: 'Normal' }] }, { value: 'auto-high', name: 'High' }] }
		];
		expect(modeSetting(options)).toEqual({ configId: 'autonomy', values: ['normal', 'auto-high'], current: 'normal' });
		expect(modeSetting([{ configId: 'mode', category: 'mode', options: [] }])).toEqual({ configId: 'mode', values: [], current: null });
		expect(modeSetting([options[0]])).toBeNull();
		expect(modeSetting(null)).toBeNull();
	});

	test('withheld commands, questions, settled requests and sign-in errors', () => {
		expect(acpDialect('copilot').withheld).toEqual(['allow-all', 'permissions', 'autopilot']);
		expect(withheldCommand(acpDialect('copilot'), '/allow-all')).toBe('allow-all');
		expect(withheldCommand(acpDialect('qwen'), '  /CLEAR now')).toBe('clear');
		expect(withheldCommand(acpDialect('qwen'), 'please /clear')).toBeNull();
		expect(withheldCommand(acpDialect('qwen'), '/init')).toBeNull();
		expect(withheldCommand(acpDialect('gemini'), '/clear')).toBeNull();
		const hermes = acpDialect('hermes');
		expect([hermes.userOnly!('clarify-1'), hermes.userOnly!('model-confirm-x'), hermes.userOnly!('call-1')]).toEqual([true, true, false]);
		expect(acpDialect('qwen').settle!('craft/drainMidTurnQueue')).toEqual({ messages: [], hasQueuedPrompt: false });
		expect(acpDialect('qwen').settle!('_qwencode/start_turn')).toEqual({ accepted: true });
		expect(acpDialect('qwen').settle!('fs/read_text_file')).toBeUndefined();
		expect(acpDialect('cursor-agent').settle!('cursor/update_todos')).toEqual({});
		expect(acpDialect('cursor-agent').settle!('cursor/ask_question')).toBeUndefined();
		expect(acpDialect('gemini').authRequired!(401, null)).toBe(true);
		expect(acpDialect('goose').authRequired!(-32603, 'Failed to resolve provider and model: Configuration value not found: GOOSE_PROVIDER')).toBe(true);
		expect(acpDialect('goose').authRequired!(-32603, 'boom')).toBe(false);
		expect(acpDialect('omp').authRequired!(-32603, { details: 'No API key found for anthropic' })).toBe(true);
		expect(acpDialect('auggie').authRequired!(-32603, { details: 'other' })).toBe(false);
	});
});

describe('an agent that enforces its own permission mode', () => {
	const GOOSE = { FAKE_ACP_MODES: 'smart_approve,approve,auto' };

	test("the chat's mode is written to the agent's own mode option at start, and again when it changes", async () => {
		const { event, stderr, lines, call, start, out } = setup('goose');
		// goose is configured smart_approve; an asking chat must put it in `approve`.
		await start({ env: GOOSE });
		await stderr('got session/set_config_option permission=approve');
		await event('result');
		const mark = out.length;
		expect((await call(2, 'set_options', { runId: 1, permissionMode: 'bypassPermissions' })).error).toBeUndefined();
		await stderr('got session/set_config_option permission=auto', mark);
		await call(3, 'set_options', { runId: 1, permissionMode: 'acceptEdits' });
		// goose has no accept-edits mode: back to asking (Kingu allows the edits it is asked about).
		await stderr('got session/set_config_option permission=approve', mark);
		expect(lines().some((l) => l.startsWith('got session/set_mode'))).toBe(false);
	});

	test('a mode already in effect is not written again', async () => {
		const { event, lines, start } = setup('goose');
		await start({ env: { FAKE_ACP_MODES: 'approve,smart_approve,auto' } });
		await event('result');
		expect(lines().filter((l) => l.startsWith('got session/set_config_option'))).toEqual([]);
	});

	test('"Allow all" is the agent\'s full access, not a mode that merely shares the name', async () => {
		const { event, stderr, lines, start } = setup('kimi');
		await start({ permissionMode: 'bypassPermissions', env: { FAKE_ACP_MODES: 'default,yolo,auto' } });
		await stderr('got session/set_config_option permission=auto');
		await event('result');
		expect(lines()).not.toContain('got session/set_config_option permission=yolo');
	});

	test('a mode the agent does not confirm fails the start', async () => {
		const { event, lines, start } = setup('goose');
		await start({ env: { ...GOOSE, FAKE_ACP_MODE_STUCK: '1' } });
		expect((await event('error')).message).toContain('did not confirm its "approve" permission mode');
		expect((await event('exit')).code).not.toBe(0);
		expect(lines()).not.toContain('got session/prompt');
	});

	test('without a mode option the session modes are used (session/set_mode)', async () => {
		const { event, stderr, start } = setup('droid');
		await start({ permissionMode: 'bypassPermissions', env: { FAKE_ACP_SESSION_MODES: 'normal,auto-medium,auto-high' } });
		await stderr('got session/set_mode auto-high');
		await event('result');
	});

	test('a mode this release does not offer is said in the chat, once, and nothing is guessed', async () => {
		const { event, lines, call, start } = setup('qwen');
		// The fake's session modes are default / yolo: "Accept edits" (auto-edit) is not offered.
		await start({ permissionMode: 'acceptEdits' });
		await event('result');
		await call(2, 'set_options', { runId: 1, permissionMode: 'acceptEdits' });
		const notices = lines().filter((l) => l.includes('does not offer its "auto-edit" permission mode'));
		expect(notices.length).toBe(1);
		expect(lines().some((l) => l.startsWith('got session/set_mode') || l.startsWith('got session/set_config_option'))).toBe(false);
	});

	test('plan uses a mode the agent itself calls plan, else its ask mode', async () => {
		const a = setup('qwen');
		await a.start({ permissionMode: 'plan', env: { FAKE_ACP_MODES: 'yolo,default,plan' } });
		await a.stderr('got session/set_config_option permission=plan');
		await a.event('result');
		const b = setup('goose');
		await b.start({ permissionMode: 'plan', env: GOOSE });
		await b.stderr('got session/set_config_option permission=approve');
		await b.event('result');
	});

	test('another agent keeps the usual ids: nothing changes for it', async () => {
		const { event, stderr, lines, start } = setup('gemini');
		await start({ permissionMode: 'bypassPermissions', env: { FAKE_ACP_MODES: 'approve,auto' } });
		await stderr('got session/set_mode yolo');
		await event('result');
		expect(lines().some((l) => l.startsWith('got session/set_config_option'))).toBe(false);
	});
});

describe('other dialect differences in a run', () => {
	test('withheld commands are not offered and not sent', async () => {
		const { event, lines, call, start, out } = setup('copilot');
		await start({ env: { FAKE_ACP_COMMANDS: 'init,allow-all,autopilot' } });
		expect((await event('commands')).commands.map((c) => c.name)).toEqual(['init']);
		await event('result');
		const mark = out.length;
		await call(2, 'send', { runId: 1, text: '/allow-all' });
		const result = await event('result', mark);
		expect(result.is_error).toBe(true);
		expect(String(result.result)).toContain('/allow-all is not available');
		expect(lines().filter((l) => l === 'got session/prompt').length).toBe(1);
	});

	test("Hermes' question is the person's to answer even under Allow all", async () => {
		const { event, stderr, call, start } = setup('hermes');
		await start({ prompt: 'ask clarify-7', permissionMode: 'bypassPermissions', env: { FAKE_ACP_MODES: 'ask,workspace_session,session' } });
		const req = await event('permission_request');
		await call(2, 'answer', { runId: 1, requestId: req.request_id, decision: 'deny' });
		await stderr('permission selected:no');
		await event('result');
	});

	test('an ordinary request under Allow all is still answered by Kingu', async () => {
		const { event, stderr, events, start } = setup('hermes');
		await start({ prompt: 'ask call-7', permissionMode: 'bypassPermissions', env: { FAKE_ACP_MODES: 'ask,workspace_session,session' } });
		await stderr('permission selected:yes');
		await event('result');
		expect(events().some((e) => e.kind === 'permission_request')).toBe(false);
	});

	test("the agent's own requests get the reply it waits for; another agent's are refused as before", async () => {
		const q = setup('qwen');
		await q.start({ prompt: 'call craft/drainMidTurnQueue' });
		await q.stderr('reply {"messages":[],"hasQueuedPrompt":false}');
		await q.event('result');
		const g = setup('gemini');
		await g.start({ prompt: 'call craft/drainMidTurnQueue' });
		await g.stderr('reply null');
		await g.event('result');
	});

	test("the agent's own not-configured error reads as sign in first", async () => {
		const { event, start } = setup('goose');
		await start({ env: { FAKE_ACP_PROMPT_ERROR: JSON.stringify({ code: -32603, message: 'Internal error', data: 'Failed to resolve provider and model: Configuration value not found: GOOSE_PROVIDER' }) } });
		const result = await event('result');
		expect(result.is_error).toBe(true);
		expect(String(result.result)).toContain('Sign in to goose in a terminal first');
	});
});
