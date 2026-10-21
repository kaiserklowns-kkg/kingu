// Arkai runs end to end through the host's protocol, against a fake OpenAI-compatible / Anthropic
// server (fixtures/fake-llm.ts): tool rows, permission prompts, snapshots, the safety checks,
// textual tool calls, a continued chat, a model switch and an interrupt. No real model.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHost } from '../src/host.ts';
import { NUDGE } from '../src/arkai/leftover.ts';
import type { AgentEvent } from '../src/protocol.ts';
import { FakeLlm } from './fixtures/fake-llm.ts';

type Out = { id?: number | string | null; method?: string; params?: any; result?: unknown; error?: { code: number; message: string } };

const dirs: string[] = [];
const hosts: AgentHost[] = [];
const servers: FakeLlm[] = [];
afterEach(async () => {
	await Promise.all(hosts.splice(0).map((h) => h.dispatch('shutdown', null)));
	for (const s of servers.splice(0)) s.stop();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'kingu-arkai-run-')));
	dirs.push(cwd);
	writeFileSync(join(cwd, 'a.txt'), 'old\n');
	const llm = new FakeLlm();
	servers.push(llm);
	const out: Out[] = [];
	const waiters: { pred: (o: Out) => boolean; resolve: (o: Out) => void }[] = [];
	let n = 0;
	const logs: string[] = [];
	const host = new AgentHost({
		query: () => {
			throw new Error('the Claude SDK must not run');
		},
		write: (m) => {
			const o = JSON.parse(JSON.stringify(m)) as Out;
			out.push(o);
			for (const w of [...waiters]) if (w.pred(o)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(o));
		},
		newId: () => `req-${++n}`,
		log: (l) => logs.push(l)
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
	const nth = async <K extends AgentEvent['kind']>(kind: K, k = 1) => {
		const seen = () => events().filter((e) => e.kind === kind);
		await next(() => seen().length >= k);
		return seen()[k - 1] as Extract<AgentEvent, { kind: K }>;
	};
	const call = async (id: number, method: string, params: unknown) => {
		await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
		return out.findLast((o) => o.id === id)!;
	};
	const runtime = (over: Record<string, unknown> = {}) => ({
		kind: 'arkai',
		provider: { id: 'local', name: 'Local', api: 'openai', baseUrl: `${llm.url}/v1`, apiKey: 'sk-secret', models: [{ id: 'coder', contextWindow: 64_000 }, { id: 'tiny', contextWindow: 8192 }] },
		model: 'coder',
		...over
	});
	return { host, cwd, llm, out, logs, events, nth, call, runtime };
}

describe('Arkai runtime', () => {
	test('a turn with an edit: tool row, permission, snapshot first, result, usage', async () => {
		const { cwd, llm, logs, events, nth, call, runtime } = setup();
		llm.reply(
			{ text: ['Changing it.'], calls: [{ id: 'c1', name: 'Edit', args: JSON.stringify({ path: 'a.txt', old_str: 'old', new_str: 'new' }) }], usage: { prompt_tokens: 900, completion_tokens: 20 } },
			{ text: ['Done: ', 'a.txt says new.'], usage: { prompt_tokens: 1000, completion_tokens: 10 } }
		);
		// A skill plugin folder: Arkai gets its index after the rules (skills.ts).
		const plugin = join(cwd, '.plugin');
		mkdirSync(join(plugin, 'skills', 'pdf'), { recursive: true });
		writeFileSync(join(plugin, 'skills', 'pdf', 'SKILL.md'), '---\nname: pdf\ndescription: PDFs\n---\n');
		expect((await call(1, 'start', { runId: 1, cwd, prompt: 'make it new', runtime: runtime(), snapshots: true, systemPromptAppend: '# Rules\nBe brief.', plugins: [plugin] })).result).toEqual({ runId: 1 });
		const req = await nth('permission_request');
		const file = join(cwd, 'a.txt');
		// The coach put the small model's argument names right before the row went out.
		expect(events().find((e) => e.kind === 'tool_use')).toEqual({ kind: 'tool_use', id: 'c1', name: 'Edit', input: { file_path: 'a.txt', old_string: 'old', new_string: 'new' } });
		expect(req).toMatchObject({ tool: 'Edit', tool_use_id: 'c1', can_always: true, rules: ['Edit'] });
		expect(events().some((e) => e.kind === 'file_snapshot')).toBe(false);
		await call(2, 'answer', { runId: 1, requestId: req.request_id, decision: 'allow_always' });
		const result = await nth('result');
		expect(result).toMatchObject({ is_error: false, result: 'Done: a.txt says new.', num_turns: 1, usage: { input_tokens: 1900, output_tokens: 30 } });
		expect(readFileSync(file, 'utf8')).toBe('new\n');
		const snap = events().find((e) => e.kind === 'file_snapshot');
		expect(snap).toMatchObject({ tool_use_id: 'c1', tool: 'Edit', path: file, existed: true, content_b64: Buffer.from('old\n').toString('base64') });
		expect(events().indexOf(snap!)).toBeGreaterThan(events().indexOf(req));
		expect(events().find((e) => e.kind === 'tool_result')).toEqual({ kind: 'tool_result', tool_use_id: 'c1', content: 'Edited a.txt', is_error: false });
		expect(events().find((e) => e.kind === 'system')).toMatchObject({ subtype: 'init', model: 'local/coder' });
		expect(events().filter((e) => e.kind === 'message' && e.role === 'assistant').map((e) => (e as { text: string }).text)).toEqual(['Changing it.', 'Done: a.txt says new.']);
		expect(events().findLast((e) => e.kind === 'context_usage')).toEqual({ kind: 'context_usage', used_tokens: 1010, max_tokens: 64_000 });

		// What the model was sent: the system prompt with the rules, the tools, then the tool result.
		const [first, second] = llm.requests;
		expect(first!.body.model).toBe('coder');
		expect(first!.body.messages[0].content).toContain('# Rules\nBe brief.\n\n# Skills\n');
		expect(first!.body.messages[0].content).toContain(`- pdf: PDFs\n  ${join(plugin, 'skills', 'pdf', 'SKILL.md')}`);
		expect(first!.body.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'TodoWrite']);
		expect(second!.body.messages.slice(-2)).toEqual([
			{ role: 'assistant', content: 'Changing it.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Edit', arguments: JSON.stringify({ path: 'a.txt', old_str: 'old', new_str: 'new' }) } }] },
			{ role: 'tool', tool_call_id: 'c1', content: 'Edited a.txt' }
		]);
		// The key went to the provider only.
		expect(first!.headers.authorization).toBe('Bearer sk-secret');
		expect(logs.join('\n')).not.toContain('sk-secret');

		// "Allow always" holds for the next edit of this run.
		writeFileSync(file, 'new\n');
		llm.reply({ calls: [{ id: 'c2', name: 'Write', args: JSON.stringify({ file_path: 'b.txt', content: 'b' }) }] }, { calls: [{ id: 'c3', name: 'Edit', args: JSON.stringify({ file_path: 'a.txt', old_string: 'new', new_string: 'newer' }) }] }, { text: ['ok'] });
		await call(3, 'send', { runId: 1, text: 'again' });
		const asked = await nth('permission_request', 2);
		expect(asked).toMatchObject({ tool: 'Write', rules: ['Write'] });
		await call(4, 'answer', { runId: 1, requestId: asked.request_id, decision: 'allow' });
		expect(await nth('result', 2)).toMatchObject({ is_error: false, result: 'ok' });
		expect(events().filter((e) => e.kind === 'permission_request').length).toBe(2);
		expect(readFileSync(file, 'utf8')).toBe('newer\n');
	});

	test('the safety checks: a catastrophic command is refused, a delete is asked about in every mode', async () => {
		const { cwd, llm, events, nth, call, runtime } = setup();
		llm.reply({ calls: [{ id: 'k1', name: 'Bash', args: '{"command": "rm -rf /"}' }] }, { calls: [{ id: 'k2', name: 'Bash', args: '{"command": "rm a.txt"}' }] }, { text: ['stopped'] });
		await call(1, 'start', { runId: 1, cwd, prompt: 'clean up', runtime: runtime(), permissionMode: 'bypassPermissions', guardAsks: { deletes: true } });
		expect(await nth('guard_blocked')).toMatchObject({ tool: 'Bash', tool_use_id: 'k1', check: 'security' });
		const asked = await nth('guard_asked');
		expect(asked).toMatchObject({ tool: 'Bash', tool_use_id: 'k2', check: 'delete' });
		const req = await nth('permission_request');
		expect(req).toMatchObject({ request_id: asked.request_id, can_always: false });
		await call(2, 'answer', { runId: 1, requestId: req.request_id, decision: 'deny', message: 'keep it' });
		await nth('result');
		expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('old\n');
		const results = llm.requests[2]!.body.messages.filter((m: { role: string }) => m.role === 'tool');
		expect(results[0].content).toContain("Kingu's safety check");
		expect(results[1].content).toContain('They said: keep it');
		expect(events().filter((e) => e.kind === 'tool_result').every((e) => (e as { is_error: boolean }).is_error)).toBe(true);
	});

	test('plan mode refuses changes without asking', async () => {
		const { cwd, llm, events, nth, call, runtime } = setup();
		llm.reply({ calls: [{ id: 'p1', name: 'Write', args: '{"file_path": "x.txt", "content": "x"}' }, { id: 'p2', name: 'Read', args: '{"file_path": "a.txt"}' }] }, { text: ['plan: write x.txt'] });
		await call(1, 'start', { runId: 1, cwd, prompt: 'plan it', runtime: runtime(), permissionMode: 'plan' });
		await nth('result');
		expect(events().some((e) => e.kind === 'permission_request')).toBe(false);
		const results = events().filter((e) => e.kind === 'tool_result') as Extract<AgentEvent, { kind: 'tool_result' }>[];
		expect(results.map((r) => [r.tool_use_id, r.is_error])).toEqual([
			['p1', true],
			['p2', false]
		]);
		expect(results[1]!.content).toBe('     1\told');
	});

	test('a small model: a call written as text runs, markup that is not a call sends it back (twice at most)', async () => {
		const { cwd, llm, events, nth, call, runtime } = setup();
		llm.reply(
			{ text: ['Reading.\n<function=Read>\n<parameter=file_path>\na.txt\n</parameter>\n</function>'] },
			{ text: ['<tool_call>\n{"name": "Unknown"'] },
			{ text: ['<tool_call>\n{"name": "Unknown"'] },
			{ text: ['<tool_call>still not'] }
		);
		await call(1, 'start', { runId: 1, cwd, prompt: 'what is in a.txt', runtime: runtime({ model: 'tiny' }) });
		const result = await nth('result');
		// Light mode: six tools and the short prompt.
		const first = llm.requests[0]!.body;
		expect(first.tools.length).toBe(6);
		expect(first.messages[0].content).toStartWith('You are Arkai, the coding agent of Kingu. You work');
		expect(events().find((e) => e.kind === 'tool_use')).toMatchObject({ name: 'Read', input: { file_path: 'a.txt' } });
		expect(events().find((e) => e.kind === 'tool_result')).toMatchObject({ content: '     1\told', is_error: false });
		const sent = llm.requests.map((r) => r.body.messages.at(-1));
		expect(sent[2]).toEqual({ role: 'user', content: NUDGE });
		expect(sent[3]).toEqual({ role: 'user', content: NUDGE });
		expect(llm.requests.length).toBe(4);
		// The markup never reaches the chat or the model again.
		expect(events().filter((e) => e.kind === 'message' && e.role === 'assistant').map((e) => (e as { text: string }).text)).toEqual(['Reading.']);
		expect(result).toMatchObject({ is_error: false });
		expect(JSON.stringify(llm.requests[3]!.body.messages)).not.toContain('<tool_call>');
	});

	test('a continued chat gets its conversation back and keeps its session id', async () => {
		const { cwd, llm, nth, call, runtime } = setup();
		llm.reply({ text: ['You asked about a.txt.'] });
		const history = [
			{ kind: 'message', role: 'user', text: 'read a.txt' },
			{ kind: 'tool_use', id: 'h1', name: 'Read', input: { file_path: 'a.txt' } },
			{ kind: 'tool_result', tool_use_id: 'h1', content: '1\told', is_error: false },
			{ kind: 'message', role: 'assistant', text: 'It says old.' }
		];
		await call(1, 'start', { runId: 1, cwd, prompt: 'what did I ask?', resume: 'sess-1', runtime: runtime({ history }) });
		expect(await nth('system')).toMatchObject({ session_id: 'sess-1' });
		expect(await nth('result')).toMatchObject({ session_id: 'sess-1', result: 'You asked about a.txt.' });
		const msgs = llm.requests[0]!.body.messages.slice(1);
		expect(msgs).toEqual([
			{ role: 'user', content: 'read a.txt' },
			{ role: 'assistant', content: null, tool_calls: [{ id: 'h1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"a.txt"}' } }] },
			{ role: 'tool', tool_call_id: 'h1', content: '1\told' },
			{ role: 'assistant', content: 'It says old.' },
			{ role: 'user', content: 'what did I ask?' }
		]);
		expect((await call(2, 'start', { runId: 2, cwd, prompt: 'x', runtime: runtime(), resumeAt: '00000000-0000-4000-8000-000000000000', resume: 'sess-1' })).error?.message).toContain('cannot resume at a message');
	});

	test('the model switches mid-session, also to another provider with its config', async () => {
		const { cwd, llm, nth, call, runtime } = setup();
		llm.reply({ text: ['one'] }, { text: ['two'] }, { text: ['three'] });
		await call(1, 'start', { runId: 1, cwd, prompt: 'hi', runtime: runtime() });
		await nth('result');
		expect((await call(2, 'set_options', { runId: 1, model: 'local/tiny' })).result).toEqual({ model: 'local/tiny', permissionMode: null });
		await call(3, 'send', { runId: 1, text: 'again' });
		await nth('result', 2);
		expect(llm.requests[1]!.body.model).toBe('tiny');
		expect((await call(4, 'set_options', { runId: 1, model: 'other/m' })).error?.code).toBe(2);
		const other = { id: 'other', name: 'Other', api: 'anthropic', baseUrl: llm.url, apiKey: 'sk-other' };
		expect((await call(5, 'set_options', { runId: 1, model: 'other/m', provider: other })).error).toBeUndefined();
		await call(6, 'send', { runId: 1, text: 'third' });
		await nth('result', 3);
		expect(llm.requests[2]!.path).toBe('/v1/messages');
		expect(llm.requests[2]!.headers['x-api-key']).toBe('sk-other');
		// The whole conversation went along to the other provider.
		expect(llm.requests[2]!.body.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
	});

	test('interrupt ends the turn; stop ends the run', async () => {
		const { cwd, llm, events, nth, call, runtime, host } = setup();
		llm.hold = true;
		await call(1, 'start', { runId: 1, cwd, prompt: 'slow', runtime: runtime() });
		await new Promise((r) => setTimeout(r, 50));
		await call(2, 'interrupt', { runId: 1 });
		expect(await nth('result')).toMatchObject({ is_error: true, subtype: 'error_during_execution', result: null });
		// The aborted request gets its reply too, unread.
		llm.reply({ text: ['lost'] }, { text: ['back'] });
		llm.release();
		await call(3, 'send', { runId: 1, text: 'go on' });
		expect(await nth('result', 2)).toMatchObject({ is_error: false, result: 'back' });
		await call(4, 'stop', { runId: 1 });
		expect(await nth('exit')).toEqual({ kind: 'exit', code: null, signal: null, stopped: true });
		expect(host.runCount).toBe(0);
		expect(events().filter((e) => e.kind === 'exit').length).toBe(1);
	});

	test('a provider error ends the turn with its message; a bad spec is refused', async () => {
		const { cwd, llm, nth, call, runtime } = setup();
		llm.reply({ status: 401, body: '{"error": {"message": "invalid api key"}}' });
		await call(1, 'start', { runId: 1, cwd, prompt: 'hi', runtime: runtime() });
		expect(await nth('result')).toMatchObject({ is_error: true, result: 'Local: HTTP 401: invalid api key' });
		const bad = await call(2, 'start', { runId: 2, cwd, prompt: 'hi', runtime: { kind: 'arkai', provider: { id: 'x', api: 'openai', baseUrl: 'ftp://x' }, model: 'm' } });
		expect(bad.error?.message).toContain('baseUrl');
	});
});
