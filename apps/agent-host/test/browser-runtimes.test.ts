// The browser tools (src/browser.ts) for the runtimes that are not the Claude SDK: Arkai's own
// tools, and Kingu's loopback MCP server (src/browserMcp.ts) that Codex and ACP agents get. What
// asks (VS Code's confirmations), what reaches the app (the app's session, never the agent's),
// and that the run's secret goes to the agent over its stdio only, never in its env or argv.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHost } from '../src/host.ts';
import { BROWSER_TOOLS, browserGateFor, browserToolSpecs, UNASKED_BROWSER_TOOLS } from '../src/browser.ts';
import { BrowserMcpServer, codexBrowserConfig, codexHasServer } from '../src/browserMcp.ts';
import { spawnChild, type Child, type SpawnFn } from '../src/runtimes/session.ts';
import type { AgentEvent } from '../src/protocol.ts';
import { FakeLlm } from './fixtures/fake-llm.ts';

type Out = { id?: number | string | null; method?: string; params?: any; result?: unknown; error?: { code: number; message: string } };
type Obj = Record<string, any>;

const ACP = { kind: 'acp', command: process.execPath, args: [join(import.meta.dir, 'fixtures/fake-acp.ts')] };
const CODEX = { kind: 'codex', command: process.execPath, args: [join(import.meta.dir, 'fixtures/fake-codex.ts')] };

const dirs: string[] = [];
const hosts: AgentHost[] = [];
const llms: FakeLlm[] = [];
afterEach(async () => {
	await Promise.all(hosts.splice(0).map((h) => h.dispatch('shutdown', null)));
	for (const s of llms.splice(0)) s.stop();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** An agent's stdout lines (JSON-RPC, one per line), each message passed through `edit`. */
function rewrite(stream: ReadableStream<Uint8Array>, edit: (m: Obj) => Obj): ReadableStream<Uint8Array> {
	let buf = '';
	const dec = new TextDecoder();
	const enc = new TextEncoder();
	const one = (line: string) => {
		try {
			return JSON.stringify(edit(JSON.parse(line)));
		} catch {
			return line;
		}
	};
	return stream.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, ctl) {
				buf += dec.decode(chunk, { stream: true });
				const lines = buf.split('\n');
				buf = lines.pop()!;
				for (const line of lines) ctl.enqueue(enc.encode(`${one(line)}\n`));
			},
			flush(ctl) {
				if (buf) ctl.enqueue(enc.encode(one(buf)));
			}
		})
	);
}

function setup(o: { acpHttp?: boolean } = {}) {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'kingu-browser-rt-')));
	dirs.push(cwd);
	const out: Out[] = [];
	const logs: string[] = [];
	const appCalls: [string, Obj][] = [];
	/** What Kingu wrote to each agent, and how it started it. */
	const sent: Obj[] = [];
	const spawned: { cmd: string[]; env: Record<string, string | undefined> }[] = [];
	const spawn: SpawnFn = (cmd, opts) => {
		spawned.push({ cmd, env: opts.env });
		const c = spawnChild(cmd, opts);
		const child: Child = {
			stdin: {
				write: (d: string) => {
					for (const line of String(d).split('\n'))
						try {
							if (line.trim()) sent.push(JSON.parse(line));
						} catch {
							// Not one whole message.
						}
					return c.stdin.write(d);
				},
				end: () => c.stdin.end()
			},
			stdout: o.acpHttp ? rewrite(c.stdout, (m) => (m.result?.agentCapabilities ? { ...m, result: { ...m.result, agentCapabilities: { ...m.result.agentCapabilities, mcpCapabilities: { http: true } } } } : m)) : c.stdout,
			stderr: c.stderr,
			exited: c.exited,
			kill: (s) => c.kill(s)
		};
		return child;
	};
	const waiters: { pred: (o: Out) => boolean; resolve: (o: Out) => void }[] = [];
	let n = 0;
	const host = new AgentHost({
		query: () => {
			throw new Error('the Claude SDK must not run');
		},
		write: (m) => {
			const x = JSON.parse(JSON.stringify(m)) as Out;
			out.push(x);
			for (const w of [...waiters]) if (w.pred(x)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(x));
		},
		newId: () => `req-${++n}`,
		log: (l) => logs.push(l),
		spawn,
		callApp: async (method, params) => {
			appCalls.push([method, params as Obj]);
			return { text: `${method} ok` };
		}
	});
	hosts.push(host);
	const events = (runId = 1) => out.filter((x) => x.method === 'event' && x.params.runId === runId).map((x) => x.params.event as AgentEvent);
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
		return out.findLast((x) => x.id === id)!;
	};
	const sentNow = async (method: string, ms = 8000) => {
		const until = Date.now() + ms;
		for (;;) {
			const hit = sent.find((m) => m.method === method);
			if (hit) return hit;
			if (Date.now() > until) throw new Error(`no ${method} sent`);
			await Bun.sleep(20);
		}
	};
	return { host, cwd, out, logs, appCalls, sent, spawned, events, nth, call, sentNow };
}

/** One MCP request to the server, as an agent sends it. */
async function mcp(url: string, headers: Record<string, string>, body: unknown, extra: Record<string, string> = {}) {
	return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers, ...extra }, body: JSON.stringify(body) });
}

describe('the tools', () => {
	test("Orca's reads are tools too, and run without asking like VS Code's reads", () => {
		expect(BROWSER_TOOLS).toMatchObject({ wait_for_page: 'browser.wait', read_console: 'browser.console', read_network: 'browser.network', read_cookies: 'browser.cookies' });
		for (const t of ['wait_for_page', 'read_console', 'read_network', 'read_cookies']) expect(UNASKED_BROWSER_TOOLS).toContain(`mcp__kingu__${t}`);
		const specs = browserToolSpecs();
		expect(specs.map((s) => s.name)).toEqual(Object.keys(BROWSER_TOOLS) as any);
		const wait = specs.find((s) => s.name === 'wait_for_page')!;
		expect(wait.inputSchema).toMatchObject({ type: 'object', required: ['pageId'] });
		expect(Object.keys((wait.inputSchema as Obj).properties)).toEqual(['pageId', 'selector', 'state', 'text', 'url', 'load', 'timeout']);
		// No Orca `--fn`: an agent runs no JavaScript of its own in a page.
		expect((wait.inputSchema as Obj).properties.fn).toBeUndefined();
		expect(specs.every((s) => !('$schema' in s.inputSchema))).toBe(true);
	});

	test('the gate: VS Code asks on open and navigate; plan mode asks for all; Allow all for none', () => {
		const ask = { title: 'Open Browser Page?', message: "This will open https://a.dev in Kingu's browser. The agent will be able to read and interact with its contents." };
		expect(browserGateFor('open_browser_page', { url: 'https://a.dev' }, 'default')).toEqual(ask);
		expect(browserGateFor('navigate_page', { pageId: 'p', url: 'https://b.dev' }, 'acceptEdits')).toMatchObject({ title: 'Navigate Browser?' });
		expect(browserGateFor('navigate_page', { pageId: 'p', type: 'back' }, 'default')).toBe('allow');
		expect(browserGateFor('read_cookies', { pageId: 'p' }, 'default')).toBe('allow');
		expect(browserGateFor('read_console', { pageId: 'p' }, 'plan')).toEqual({ title: null, message: null });
		expect(browserGateFor('open_browser_page', { url: 'https://a.dev' }, 'bypassPermissions')).toBe('allow');
	});

	test("Codex's thread config: url, secret header, Kingu's own asks, a long timeout; a name the user's config has is theirs", () => {
		expect(codexBrowserConfig('kingu', { url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer s' } })).toEqual({
			'mcp_servers.kingu.url': 'http://127.0.0.1:1/mcp',
			'mcp_servers.kingu.http_headers': { Authorization: 'Bearer s' },
			'mcp_servers.kingu.default_tools_approval_mode': 'approve',
			'mcp_servers.kingu.tool_timeout_sec': 600
		});
		expect(codexHasServer('[mcp_servers.kingu]\ncommand = "x"\n', 'kingu')).toBe(true);
		expect(codexHasServer('[mcp_servers."kingu".env]\nA = "1"\n', 'kingu')).toBe(true);
		expect(codexHasServer('[mcp_servers.kingu_two]\n[mcp_servers.other]\n', 'kingu')).toBe(false);
		expect(codexHasServer('', 'kingu')).toBe(false);
	});
});

describe("Kingu's MCP server", () => {
	test('only loopback POSTs with the run secret; MCP answers; released runs end; the last stops it', async () => {
		const seen: [string, Obj][] = [];
		const server = new BrowserMcpServer(() => {});
		const a = server.register(async (tool, args) => (seen.push([tool, args]), { content: [{ type: 'text', text: `${tool} done` }] }));
		const b = server.register(async () => ({ content: [{ type: 'text', text: 'b' }] }));
		expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
		expect(a.headers.Authorization).toMatch(/^Bearer [\w-]{40,}$/);
		expect(a.headers.Authorization).not.toBe(b.headers.Authorization);
		const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };

		expect((await mcp(a.url, {}, init)).status).toBe(401);
		expect((await mcp(a.url, { Authorization: 'Bearer nope' }, init)).status).toBe(401);
		expect((await mcp(a.url, a.headers, init, { origin: 'https://evil.dev' })).status).toBe(403);
		expect((await fetch(a.url, { headers: a.headers })).status).toBe(405);
		expect((await mcp(a.url.replace('/mcp', '/other'), a.headers, init)).status).toBe(404);

		const r = (await (await mcp(a.url, a.headers, init)).json()) as Obj;
		expect(r.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'kingu' } });
		expect((await mcp(a.url, a.headers, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
		const list = (await (await mcp(a.url, a.headers, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()) as Obj;
		expect(list.result.tools.map((t: Obj) => t.name)).toContain('read_cookies');
		const called = (await (await mcp(a.url, a.headers, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_console', arguments: { pageId: 'p', limit: 5 } } })).json()) as Obj;
		expect(called.result).toEqual({ content: [{ type: 'text', text: 'read_console done' }] });
		expect(seen).toEqual([['read_console', { pageId: 'p', limit: 5 }]]);
		const unknown = (await (await mcp(a.url, a.headers, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'eval', arguments: {} } })).json()) as Obj;
		expect(unknown.error.code).toBe(-32602);
		const batch = (await (await mcp(a.url, a.headers, [{ jsonrpc: '2.0', id: 5, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/cancelled' }])).json()) as Obj[];
		expect(batch).toEqual([{ jsonrpc: '2.0', id: 5, result: {} }]);

		a.release();
		expect((await mcp(a.url, a.headers, init)).status).toBe(401);
		expect(server.size).toBe(1);
		b.release();
		expect(server.size).toBe(0);
		await expect(mcp(b.url, b.headers, init)).rejects.toThrow();
	});
});

describe('Codex', () => {
	test('the thread gets the server over stdio; its env and argv never hold a secret; calls ask like VS Code and carry the app session', async () => {
		const { host, cwd, call, sent, spawned, appCalls, nth, events, sentNow } = setup();
		expect((await call(1, 'start', { runId: 1, cwd, prompt: 'browse', runtime: CODEX, browser: { session: 'app-token' } })).result).toEqual({ runId: 1 });
		const start = await sentNow('thread/start');
		const config = start.params.config as Obj;
		const url = config['mcp_servers.kingu.url'] as string;
		const headers = config['mcp_servers.kingu.http_headers'] as Record<string, string>;
		expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
		expect(config['mcp_servers.kingu.default_tools_approval_mode']).toBe('approve');
		const secret = headers.Authorization!.slice('Bearer '.length);
		// Never where another process can read it, and never the app's own token.
		const launch = JSON.stringify(spawned);
		expect(launch).not.toContain(secret);
		expect(launch).not.toContain('app-token');
		expect(JSON.stringify(sent)).not.toContain('app-token');
		expect(host.browserMcpRuns).toBe(1);

		// A read runs at once, with the app's session and the run's folder.
		const read = (await (await mcp(url, headers, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_network', arguments: { pageId: 'p', session: 'forged' } } })).json()) as Obj;
		expect(read.result).toEqual({ content: [{ type: 'text', text: 'browser.network ok' }] });
		expect(appCalls[0]).toEqual(['browser.network', { pageId: 'p', session: 'app-token', cwd }]);

		// Opening a page asks first, with VS Code's words; "Allow in this Session" covers the next open.
		const opening = mcp(url, headers, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'open_browser_page', arguments: { url: 'https://a.dev' } } });
		const req = await nth('permission_request');
		expect(req).toMatchObject({ tool: 'mcp__kingu__open_browser_page', title: 'Open Browser Page?', can_always: true, rules: ['mcp__kingu__open_browser_page'] });
		expect(req.detail).toContain('This will open https://a.dev');
		expect(appCalls).toHaveLength(1);
		await call(2, 'answer', { runId: 1, requestId: req.request_id, decision: 'allow_always' });
		expect(((await (await opening).json()) as Obj).result.content[0].text).toBe('browser.open ok');
		await mcp(url, headers, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'open_browser_page', arguments: { url: 'https://b.dev' } } });
		expect(events().filter((e) => e.kind === 'permission_request')).toHaveLength(1);
		expect(appCalls.map(([m]) => m)).toEqual(['browser.network', 'browser.open', 'browser.open']);

		// Declined: the agent is told, nothing reaches the app.
		const navigating = mcp(url, headers, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'navigate_page', arguments: { pageId: 'p', url: 'https://c.dev' } } });
		const nav = await nth('permission_request', 2);
		expect(nav.title).toBe('Navigate Browser?');
		await call(3, 'answer', { runId: 1, requestId: nav.request_id, decision: 'deny', message: 'not that site' });
		const declined = ((await (await navigating).json()) as Obj).result;
		expect(declined).toEqual({ content: [{ type: 'text', text: 'The user declined this browser action. They said: not that site' }], isError: true });
		expect(appCalls).toHaveLength(3);

		// The run ends: its secret with it.
		await call(4, 'stop', { runId: 1 });
		await nth('exit');
		expect(host.browserMcpRuns).toBe(0);
	});

	test('without a session from the app (the setting off) the thread gets no server', async () => {
		const { cwd, call, sentNow, host } = setup();
		await call(1, 'start', { runId: 1, cwd, prompt: 'x', runtime: CODEX });
		expect((await sentNow('thread/start')).params.config).toBeUndefined();
		expect(host.browserMcpRuns).toBe(0);
	});

	test("a kingu server in the user's Codex config wins: no browser tools", async () => {
		const { cwd, call, sentNow, logs } = setup();
		const home = join(cwd, '.codex-home');
		require('node:fs').mkdirSync(home);
		writeFileSync(join(home, 'config.toml'), '[mcp_servers.kingu]\ncommand = "kingu-mcp"\n');
		await call(1, 'start', { runId: 1, cwd, prompt: 'x', runtime: CODEX, browser: { session: 'app-token' }, env: { CODEX_HOME: home } });
		expect((await sentNow('thread/start')).params.config).toBeUndefined();
		expect(logs.some((l) => l.includes('Codex config has its own mcp_servers.kingu'))).toBe(true);
	});
});

describe('ACP', () => {
	test('an agent that takes HTTP MCP servers gets kingu in session/new, the secret in a header', async () => {
		const { cwd, call, sentNow, spawned } = setup({ acpHttp: true });
		await call(1, 'start', { runId: 1, cwd, prompt: 'x', runtime: ACP, browser: { session: 'app-token' } });
		const s = await sentNow('session/new');
		const server = (s.params.mcpServers as Obj[]).find((m) => m.name === 'kingu')!;
		expect(server).toMatchObject({ type: 'http', name: 'kingu' });
		expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
		const auth = (server.headers as { name: string; value: string }[]).find((h) => h.name === 'Authorization')!;
		expect(JSON.stringify(spawned)).not.toContain(auth.value.slice(7));
		expect(JSON.stringify(s)).not.toContain('app-token');
	});

	test('an agent that takes only stdio servers gets none (the secret would sit in its env or argv)', async () => {
		const { cwd, call, sentNow, logs } = setup();
		await call(1, 'start', { runId: 1, cwd, prompt: 'x', runtime: ACP, browser: { session: 'app-token' } });
		const s = await sentNow('session/new');
		expect((s.params.mcpServers as Obj[]).some((m) => m.name === 'kingu')).toBe(false);
		expect(logs.some((l) => l.includes('browser tools left out: this agent takes no HTTP MCP servers'))).toBe(true);
	});
});

describe('Arkai', () => {
	function arkai(llm: FakeLlm, over: Obj = {}) {
		return {
			kind: 'arkai',
			provider: { id: 'local', name: 'Local', api: 'openai', baseUrl: `${llm.url}/v1`, apiKey: 'sk', models: [{ id: 'coder', contextWindow: 64_000 }] },
			model: 'coder',
			...over
		};
	}

	test('its own tools as mcp__kingu__*: reads run, opening asks with VS Code\'s words, the app gets its session', async () => {
		const { cwd, call, nth, appCalls, events } = setup();
		const llm = new FakeLlm();
		llms.push(llm);
		llm.reply(
			{ calls: [{ id: 'c1', name: 'mcp__kingu__read_console', args: JSON.stringify({ pageId: 'p', limit: 3 }) }] },
			{ calls: [{ id: 'c2', name: 'mcp__kingu__open_browser_page', args: JSON.stringify({ url: 'https://a.dev' }) }] },
			{ text: ['Looked.'] }
		);
		await call(1, 'start', { runId: 1, cwd, prompt: 'look', runtime: arkai(llm), browser: { session: 'app-token' } });
		const req = await nth('permission_request');
		expect(req).toMatchObject({ tool: 'mcp__kingu__open_browser_page', tool_use_id: 'c2', title: 'Open Browser Page?' });
		expect(appCalls).toEqual([['browser.console', { pageId: 'p', limit: 3, session: 'app-token', cwd }]]);
		await call(2, 'answer', { runId: 1, requestId: req.request_id, decision: 'allow' });
		expect(await nth('result')).toMatchObject({ is_error: false, result: 'Looked.' });
		expect(appCalls.map(([m]) => m)).toEqual(['browser.console', 'browser.open']);
		expect(events().filter((e) => e.kind === 'tool_result').map((e) => (e as Obj).content)).toEqual(['browser.console ok', 'browser.open ok']);
		const names = llm.requests[0]!.body.tools.map((t: Obj) => t.function.name);
		expect(names).toContain('mcp__kingu__wait_for_page');
		expect(names).toContain('mcp__kingu__read_cookies');
	});

	test('no session, no tools; a run whose server is named kingu keeps its own', async () => {
		const { cwd, call, nth } = setup();
		const llm = new FakeLlm();
		llms.push(llm);
		llm.reply({ text: ['a'] }, { text: ['b'] });
		await call(1, 'start', { runId: 1, cwd, prompt: 'x', runtime: arkai(llm) });
		await nth('result');
		expect(llm.requests[0]!.body.tools.map((t: Obj) => t.function.name).some((n: string) => n.startsWith('mcp__kingu__'))).toBe(false);
	});
});
