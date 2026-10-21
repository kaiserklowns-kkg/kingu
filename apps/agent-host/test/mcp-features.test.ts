// MCP client features in a chat (src/mcpAsks.ts, src/mcpQuery.ts): an MCP server's forms
// (elicitation) from Arkai's client, codex app-server and the Claude SDK; sampling on Arkai's
// provider after the user allowed it; resources and prompts read for the chat. Fake servers
// (fixtures/fake-mcp*.ts), a fake codex and a fake model only: no network, no real model.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { AgentHost } from '../src/host.ts';
import { checkContent, contentText, elicitAsk, formFields, McpAsks } from '../src/mcpAsks.ts';
import { pipeConnection } from '../src/arkai/mcp.ts';
import type { AgentEvent } from '../src/protocol.ts';
import { FakeMcp, FORM } from './fixtures/fake-mcp.ts';
import { FakeLlm } from './fixtures/fake-llm.ts';

type Out = { id?: number; method?: string; params?: any; result?: any; error?: { code: number; message: string } };
type McpRequest = Extract<AgentEvent, { kind: 'mcp_request' }>;

const STDIO_MCP = { command: process.execPath, args: [join(import.meta.dir, 'fixtures/fake-mcp-stdio.ts')] };
const CODEX = { kind: 'codex', command: process.execPath, args: [join(import.meta.dir, 'fixtures/fake-codex.ts')] };

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c();
});

function setup(deps: Partial<ConstructorParameters<typeof AgentHost>[0]> = {}) {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'kingu-mcpf-')));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	const out: Out[] = [];
	let n = 0;
	const host = new AgentHost({
		query: () => {
			throw new Error('the Claude SDK must not run');
		},
		write: (m) => void out.push(JSON.parse(JSON.stringify(m))),
		newId: () => `req-${++n}`,
		...deps
	});
	cleanups.push(() => host.dispatch('shutdown', null));
	const events = (runId = 1) => out.filter((o) => o.method === 'event' && o.params.runId === runId).map((o) => o.params.event as AgentEvent);
	const until = async (pred: () => boolean, ms = 8000) => {
		for (let i = 0; i < ms / 10 && !pred(); i++) await Bun.sleep(10);
		expect(pred()).toBe(true);
	};
	const event = async <K extends AgentEvent['kind']>(kind: K, nth = 1) => {
		const seen = () => events().filter((e) => e.kind === kind);
		await until(() => seen().length >= nth);
		return seen()[nth - 1] as Extract<AgentEvent, { kind: K }>;
	};
	let id = 100;
	const call = async (method: string, params: unknown) => {
		const rid = ++id;
		await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }));
		return out.findLast((o) => o.id === rid)!;
	};
	return { host, cwd, out, events, until, event, call };
}

function llm() {
	const l = new FakeLlm();
	cleanups.push(() => l.stop());
	return l;
}

const arkai = (url: string) => ({ kind: 'arkai', provider: { id: 'local', name: 'Local', api: 'openai', baseUrl: `${url}/v1`, models: [{ id: 'coder', contextWindow: 64_000 }] }, model: 'coder' });

describe('forms', () => {
	test("the spec's restricted schema: fields, required, enums; other shapes refused", () => {
		expect(formFields(FORM)).toEqual([
			{ name: 'title', type: 'string', required: true, options: null, min: 1, max: null },
			{ name: 'priority', type: 'string', required: false, options: ['low', 'high'], min: null, max: null },
			{ name: 'count', type: 'integer', required: false, options: null, min: 1, max: null },
			{ name: 'urgent', type: 'boolean', required: false, options: null, min: null, max: null }
		]);
		expect(formFields({ type: 'object', properties: { pick: { oneOf: [{ const: 'a', title: 'A' }, { const: 'b' }] } } })[0]!.options).toEqual(['a', 'b']);
		expect(() => formFields({ type: 'object', properties: { nested: { type: 'object' } } })).toThrow('unsupported type');
		expect(() => formFields({ type: 'array' })).toThrow();
	});

	test('answers are checked against the form', () => {
		expect(checkContent(FORM, { title: 'Bug', priority: 'high', count: 2, urgent: true })).toEqual({ title: 'Bug', priority: 'high', count: 2, urgent: true });
		// Empty optional fields are left out.
		expect(checkContent(FORM, { title: 'Bug', priority: '' })).toEqual({ title: 'Bug' });
		expect(() => checkContent(FORM, {})).toThrow('title is required');
		expect(() => checkContent(FORM, { title: 'x', priority: 'mid' })).toThrow('one of the options');
		expect(() => checkContent(FORM, { title: 'x', count: 1.5 })).toThrow('number');
		expect(() => checkContent(FORM, { title: 'x', count: 0 })).toThrow('range');
		expect(() => checkContent(FORM, { title: 'x', urgent: 'yes' })).toThrow('true or false');
		expect(() => checkContent(FORM, { title: 'x', extra: 1 })).toThrow('no field extra');
	});

	test('elicitation params as an ask: form, url, unusable', () => {
		expect(elicitAsk('s', { message: 'm', requestedSchema: FORM })).toMatchObject({ mode: 'form', schema: FORM, url: null });
		expect(elicitAsk('s', { mode: 'url', message: 'Sign in', url: 'https://example.com/auth' })).toMatchObject({ mode: 'url', url: 'https://example.com/auth' });
		expect(elicitAsk('s', { mode: 'url', url: 'javascript:alert(1)' })).toBeNull();
		expect(elicitAsk('s', { message: 'no schema' })).toBeNull();
		expect(contentText([{ type: 'text', text: 'a' }, { type: 'image', data: '' }])).toBe('a\n[image]');
	});
});

describe('McpAsks', () => {
	function asks(o: Partial<ConstructorParameters<typeof McpAsks>[0]> = {}) {
		const evs: AgentEvent[] = [];
		let n = 0;
		const a = new McpAsks({ emit: (e) => evs.push(e), newId: () => `a${++n}`, log: () => {}, ...o });
		return { a, evs };
	}

	test('a form: the card, a bad answer left waiting, the checked content back', async () => {
		const { a, evs } = asks();
		const r = a.elicit({ server: 'tickets', message: 'New ticket', mode: 'form', schema: FORM, url: null });
		expect(evs[0]).toMatchObject({ kind: 'mcp_request', request_id: 'a1', type: 'elicitation', server: 'tickets', message: 'New ticket', schema: FORM, sampling: null });
		expect(() => a.answer({ runId: 1, requestId: 'a1', action: 'accept', content: {} })).toThrow('required');
		expect(a.size).toBe(1);
		expect(() => a.answer({ runId: 1, requestId: 'a1', action: 'accept', content: { title: 'x' }, remember: 'session' })).toThrow('sampling');
		a.answer({ runId: 1, requestId: 'a1', action: 'accept', content: { title: 'Crash', urgent: false } });
		expect(await r).toEqual({ action: 'accept', content: { title: 'Crash', urgent: false } });
		expect(evs.at(-1)).toEqual({ kind: 'mcp_request_resolved', request_id: 'a1', action: 'accept' });
		expect(() => a.answer({ runId: 1, requestId: 'a1', action: 'decline' })).toThrow('no pending');
	});

	test('unanswered: cancelled after the timeout, on interrupt, and once closed nothing is asked', async () => {
		const { a, evs } = asks({ timeoutMs: 20 });
		const ask = { server: 's', message: '', mode: 'form' as const, schema: FORM, url: null };
		expect(await a.elicit(ask)).toEqual({ action: 'cancel' });
		expect(evs.at(-1)).toMatchObject({ kind: 'mcp_request_resolved', action: 'cancel' });
		const { a: b } = asks();
		const p = b.elicit(ask);
		b.cancelAll();
		expect(await p).toEqual({ action: 'cancel' });
		b.close();
		expect(await b.elicit(ask)).toEqual({ action: 'cancel' });
		// A form Kingu cannot show is declined without asking.
		const { a: c, evs: cevs } = asks();
		expect(await c.elicit({ ...ask, schema: { type: 'object', properties: { x: { type: 'array' } } } })).toEqual({ action: 'decline' });
		expect(cevs).toEqual([]);
	});

	test('sampling: the setting decides, else the user; "this session" is kept', async () => {
		const ask = { server: 'web', messages: [{ role: 'user', text: 'x'.repeat(5000) }], systemPrompt: null, maxTokens: 10 };
		const { a: allowed, evs: none } = asks({ sampling: { web: true } });
		expect(await allowed.allowSampling(ask)).toBe(true);
		const { a: refused } = asks({ sampling: { web: false } });
		expect(await refused.allowSampling(ask)).toBe(false);
		expect(none).toEqual([]);
		const { a, evs } = asks();
		const first = a.allowSampling(ask);
		const req = evs[0] as McpRequest;
		expect(req).toMatchObject({ type: 'sampling', server: 'web', sampling: { system_prompt: null, max_tokens: 10 } });
		expect(req.sampling!.messages[0]!.text.length).toBe(2000);
		a.answer({ runId: 1, requestId: req.request_id, action: 'accept', remember: 'session' });
		expect(await first).toBe(true);
		expect(await a.allowSampling(ask)).toBe(true);
		expect(evs.filter((e) => e.kind === 'mcp_request').length).toBe(1);
		const other = a.allowSampling({ ...ask, server: 'db' });
		a.answer({ runId: 1, requestId: (evs.at(-1) as McpRequest).request_id, action: 'decline' });
		expect(await other).toBe(false);
	});
});

describe('Arkai as the MCP client', () => {
	test('elicitation and sampling are announced only with handlers, and answered through them', async () => {
		const f = new FakeMcp();
		f.extras = true;
		const pipes = f.pipes();
		cleanups.push(() => (pipes.closed = true));
		const { McpClient, clientCapabilities } = await import('../src/arkai/mcp.ts');
		const client = new McpClient('fake', pipeConnection(pipes, '/w', () => {}, { elicit: async () => ({ action: 'accept', content: { title: 'Hi' } }), sample: async () => ({ role: 'assistant', content: { type: 'text', text: 'ok' } }) }), clientCapabilities({ elicit: async () => null, sample: async () => null }));
		await client.connect();
		expect(f.init.capabilities).toEqual({ roots: { listChanged: false }, elicitation: {}, sampling: {} });
		const sig = new AbortController().signal;
		expect(JSON.parse((await client.call('elicit', {}, sig)).content)).toEqual({ action: 'accept', content: { title: 'Hi' } });
		expect(JSON.parse((await client.call('sample', {}, sig)).content).content.text).toBe('ok');
		expect(clientCapabilities()).toEqual({ roots: { listChanged: false } });
		client.close();
	});

	test('a run: the form card, the answer back to the server; sampling on the run model once allowed', async () => {
		const model = llm();
		const { cwd, events, event, call } = setup();
		model.reply({ calls: [{ id: 'c1', name: 'mcp__tickets__elicit', args: '{}' }] }, { calls: [{ id: 'c2', name: 'mcp__tickets__sample', args: '{}' }] }, { text: ['short'] }, { text: ['Done.'] });
		const res = await call('start', { runId: 1, cwd, prompt: 'file a ticket', mcpServers: { tickets: STDIO_MCP }, permissionMode: 'bypassPermissions', runtime: arkai(model.url) });
		expect(res.error).toBeUndefined();
		const form = await event('mcp_request');
		expect(form).toMatchObject({ type: 'elicitation', server: 'tickets', message: 'New ticket', mode: 'form', schema: FORM });
		const bad = await call('mcp_answer', { runId: 1, requestId: form.request_id, action: 'accept', content: { priority: 'high' } });
		expect(bad.error?.message).toContain('title is required');
		expect((await call('mcp_answer', { runId: 1, requestId: form.request_id, action: 'accept', content: { title: 'Crash', priority: 'high' } })).error).toBeUndefined();
		const sample = await event('mcp_request', 2);
		expect(sample).toMatchObject({ type: 'sampling', server: 'tickets', sampling: { messages: [{ role: 'user', text: 'Summarise: hello' }], system_prompt: 'Be short', max_tokens: 50 } });
		await call('mcp_answer', { runId: 1, requestId: sample.request_id, action: 'accept', remember: 'session' });
		await event('result');
		const results = events().filter((e) => e.kind === 'tool_result') as Extract<AgentEvent, { kind: 'tool_result' }>[];
		expect(JSON.parse(results[0]!.content)).toEqual({ action: 'accept', content: { title: 'Crash', priority: 'high' } });
		const sampled = JSON.parse(results[1]!.content);
		expect(sampled).toMatchObject({ role: 'assistant', content: { type: 'text', text: 'short' }, model: 'local/coder', stopReason: 'endTurn' });
		// The sampling request went to the run's model, without tools, with the server's system prompt.
		const req = model.requests[2]!.body;
		expect(req.tools).toBeUndefined();
		expect(req.messages[0]).toMatchObject({ role: 'system', content: 'Be short' });
		expect(req.max_tokens ?? req.max_completion_tokens).toBe(50);
	});

	test('a refused sampling request is an error the server sees; the setting refuses without asking', async () => {
		const model = llm();
		const { cwd, events, event, call } = setup();
		model.reply({ calls: [{ id: 'c1', name: 'mcp__tickets__sample', args: '{}' }] }, { text: ['ok'] });
		await call('start', { runId: 1, cwd, prompt: 'go', mcpServers: { tickets: STDIO_MCP }, mcpSampling: { tickets: false }, permissionMode: 'bypassPermissions', runtime: arkai(model.url) });
		await event('result');
		expect(events().some((e) => e.kind === 'mcp_request')).toBe(false);
		const r = events().find((e) => e.kind === 'tool_result') as Extract<AgentEvent, { kind: 'tool_result' }>;
		expect(JSON.parse(r.content)).toEqual({ error: { code: -1, message: 'The user did not allow this model request.' } });
		expect(model.requests.length).toBe(2);
	});

	test('mcpSampling must be booleans', async () => {
		const { cwd, call } = setup();
		expect((await call('start', { runId: 1, cwd, prompt: 'x', mcpSampling: { a: 'yes' } })).error?.message).toContain('mcpSampling');
	});
});

describe('codex and the Claude SDK', () => {
	test("codex app-server's elicitation is a form card; the answer goes back", async () => {
		const { cwd, events, event, call, until } = setup();
		await call('start', { runId: 1, cwd, prompt: 'elicit', runtime: CODEX });
		const form = await event('mcp_request');
		expect(form).toMatchObject({ type: 'elicitation', server: 'tickets', message: 'Which project?', mode: 'form' });
		await call('mcp_answer', { runId: 1, requestId: form.request_id, action: 'accept', content: { project: 'api' } });
		await until(() => events().some((e) => e.kind === 'stderr' && e.line === 'elicited {"action":"accept","content":{"project":"api"}}'));
	});

	test("the SDK's onElicitation: a card, answered; an interrupt cancels it", async () => {
		const log: { options?: Options } = {};
		const { cwd, event, call, events } = setup({
			query: ({ prompt, options }) => {
				log.options = options;
				return Object.assign(
					(async function* () {
						yield { type: 'system', subtype: 'init', session_id: 's1', model: 'm' };
						for await (const _ of prompt as AsyncIterable<SDKUserMessage>) yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's1', num_turns: 1, duration_ms: 1, total_cost_usd: 0, usage: null };
					})(),
					{ interrupt: async () => {} }
				);
			}
		});
		await call('start', { runId: 1, cwd, prompt: 'hi' });
		const signal = new AbortController().signal;
		const answer = log.options!.onElicitation!({ serverName: 'tickets', message: 'New ticket', requestedSchema: FORM }, { signal, requestId: 'cr1' });
		const form = await event('mcp_request');
		expect(form).toMatchObject({ server: 'tickets', schema: FORM });
		await call('mcp_answer', { runId: 1, requestId: form.request_id, action: 'decline' });
		expect(await answer).toEqual({ action: 'decline' });
		const second = log.options!.onElicitation!({ serverName: 'tickets', message: 'Again', requestedSchema: FORM }, { signal, requestId: 'cr2' });
		await event('mcp_request', 2);
		await call('interrupt', { runId: 1 });
		expect(await second).toEqual({ action: 'cancel' });
		expect(events().filter((e) => e.kind === 'mcp_request_resolved').map((e) => (e as { action: string }).action)).toEqual(['decline', 'cancel']);
		expect(await log.options!.onElicitation!({ serverName: 't', message: '', mode: 'url', url: 'file:///etc' }, { signal, requestId: 'cr3' })).toEqual({ action: 'decline' });
	});
});

describe('mcp_query', () => {
	test("a server's resources, templates and prompts; a resource read; a prompt rendered", async () => {
		const f = new FakeMcp();
		f.extras = true;
		const conns: { closed: boolean }[] = [];
		const { cwd, call } = setup({
			mcpConnect: () => {
				const pipes = f.pipes();
				conns.push(pipes);
				return pipeConnection(pipes, '/w', () => (pipes.closed = true));
			}
		});
		const q = (params: object) => call('mcp_query', { cwd, name: 'notes', server: { command: '/bin/fake' }, ...params });
		const list = (await q({ op: 'list' })).result;
		expect(list.resources).toEqual([
			{ uri: 'memo://readme', name: 'Read me', description: 'The notes', mimeType: 'text/plain', size: null },
			{ uri: 'file:///logo.png', name: 'logo', description: '', mimeType: 'image/png', size: null }
		]);
		expect(list.templates).toEqual([{ uriTemplate: 'memo://notes/{topic}', name: 'notes', description: 'Notes on a topic', mimeType: null }]);
		expect(list.prompts).toEqual([
			{
				name: 'review',
				title: 'Review code',
				description: 'Reviews a file',
				arguments: [
					{ name: 'file', description: 'Which file', required: true },
					{ name: 'tone', description: '', required: false }
				]
			}
		]);
		// Opened for the query only: no tools listed, closed after.
		expect(f.asked).not.toContain('tools/list');
		expect(conns.every((c) => c.closed)).toBe(true);
		expect((await q({ op: 'read', uri: 'memo://notes/ai' })).result).toEqual([{ uri: 'memo://notes/ai', mimeType: 'text/plain', text: 'content of memo://notes/ai', bytes: 26, truncated: false }]);
		expect((await q({ op: 'read', uri: 'file:///logo.png' })).result).toEqual([{ uri: 'file:///logo.png', mimeType: 'image/png', text: null, bytes: 6, truncated: false }]);
		expect((await q({ op: 'read', uri: 'memo:nope' })).error?.message).toContain('resource not found');
		expect((await q({ op: 'prompt', prompt: 'review', arguments: { file: 'a.ts' } })).result).toEqual({
			description: 'Review',
			messages: [{ role: 'user', text: 'Review a.ts' }],
			resources: [{ uri: 'memo://style', mimeType: 'text/plain', text: 'style guide', bytes: 11, truncated: false }],
			images: 1
		});
		expect((await q({ op: 'prompt', prompt: 'review', arguments: { file: 1 } })).error?.message).toContain('arguments');
		expect((await q({ op: 'nope' })).error?.message).toContain('unknown op');
		expect((await call('mcp_query', { cwd, name: 'bad name!', server: { command: '/x' }, op: 'list' })).error?.message).toContain('invalid name');
	});

	test("a server without resources or prompts lists nothing; a live Arkai run's connection is used", async () => {
		const model = llm();
		model.reply({ text: ['hi'] });
		const { cwd, call, event } = setup({
			mcpConnect: () => {
				throw new Error('a live connection must be used');
			}
		});
		await call('start', { runId: 1, cwd, prompt: 'hi', mcpServers: { tickets: STDIO_MCP }, runtime: arkai(model.url) });
		await event('result');
		const live = await call('mcp_query', { runId: 1, cwd, name: 'tickets', server: STDIO_MCP, op: 'list' });
		expect(live.result.prompts.map((p: { name: string }) => p.name)).toEqual(['review']);
		const plain = new FakeMcp();
		const { cwd: cwd2, call: call2 } = setup({ mcpConnect: () => pipeConnection(plain.pipes(), '/w') });
		expect((await call2('mcp_query', { cwd: cwd2, name: 'x', server: { command: '/x' }, op: 'list' })).result).toEqual({ resources: [], templates: [], prompts: [] });
	});
});
