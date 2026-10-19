// MCP servers in an Arkai chat: the same ones a Claude run gets (`start {mcpServers}`: Snaps, the
// user's mcp.json, trusted .vscode/.cursor servers, and for Arkai the trusted project .mcp.json
// ones Rust adds, since Claude Code is not there to read them). Arkai is the MCP client itself,
// with a small JSON-RPC client of its own (the MCP SDK is not a dependency of the agent host):
//
// - stdio: the server's program, one JSON message per line (runtimes/rpc.ts);
// - http: Streamable HTTP, each message POSTed, the answer as JSON or as an event stream;
// - sse: the older HTTP+SSE transport, an event stream that names where to POST.
//
// Each server is initialized and asked for its tools, which the model gets as
// `mcp__<server>__<tool>` (Claude Code's names, so permission rules, the always-ask MCP check and
// the chat's tool rows treat them alike). A call goes through the same gate as Kingu's own tools
// (session.ts). Servers connect in the background; `onChange` reports each change as an
// `mcp_status` list. Everything is closed when the run ends.
//
// Never log tool arguments, results or headers: they may hold secrets and file contents.

import { pathToFileURL } from 'node:url';
import type { McpServerLive, McpServerParams } from '../protocol.ts';
import { JsonRpcPeer, linesOf, RpcCallError, type Pipes } from '../runtimes/rpc.ts';
import { spawnChild, type SpawnFn } from '../runtimes/session.ts';
import type { ToolDef } from './messages.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export const PROTOCOL_VERSION = '2025-06-18';
/** How long a server may take to start and list its tools. */
export const CONNECT_TIMEOUT_MS = 30_000;
/** One `tools/list` page or other short request. */
const REQUEST_TIMEOUT_MS = 30_000;
/** One tool call (the turn's interrupt ends it sooner). */
export const CALL_TIMEOUT_MS = 10 * 60_000;
/** Tools per server, and the length of a description the model gets. */
const MAX_TOOLS = 200;
const MAX_DESCRIPTION = 2000;
/** Providers take function names of at most 64 characters from this set. */
const NAME_CHARS = /[^A-Za-z0-9_-]/g;
const MAX_NAME = 64;

/** A JSON-RPC link to one server. */
export interface McpConnection {
	request(method: string, params: unknown, o?: { signal?: AbortSignal; timeoutMs?: number }): Promise<unknown>;
	notify(method: string, params?: unknown): void;
	close(): void;
}

/** What a server may ask of Arkai: `ping`, and `roots/list` (the run's folder). */
function serverRequest(cwd: string) {
	return async (method: string): Promise<unknown> => {
		if (method === 'ping') return {};
		if (method === 'roots/list') return { roots: [{ uri: pathToFileURL(cwd).href, name: 'project' }] };
		throw new RpcCallError(-32601, `method not found: ${method}`);
	};
}

/** A promise that rejects when `signal` aborts or `ms` pass (0: never). */
function bounded<T>(p: Promise<T>, what: string, signal?: AbortSignal, ms = 0): Promise<T> {
	if (!signal && !ms) return p;
	return new Promise<T>((resolve, reject) => {
		const timer = ms ? setTimeout(() => done(new Error(`${what} timed out`)), ms) : null;
		(timer as { unref?: () => void } | null)?.unref?.();
		const onAbort = () => done(new Error('interrupted'));
		const done = (e: Error | null, v?: T) => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
			if (e) reject(e);
			else resolve(v as T);
		};
		if (signal?.aborted) return onAbort();
		signal?.addEventListener('abort', onAbort, { once: true });
		p.then(
			(v) => done(null, v),
			(e) => done(e instanceof Error ? e : new Error(String(e)))
		);
	});
}

/** A connection over line pipes (a child's stdio, or a fake server in the tests). */
export function pipeConnection(pipes: Pipes, cwd: string, onClose: () => void = () => {}): McpConnection {
	const peer = new JsonRpcPeer(pipes, { onRequest: serverRequest(cwd) });
	return {
		request: (method, params, o = {}) => bounded(peer.request(method, params), method, o.signal, o.timeoutMs ?? 0),
		notify: (method, params) => peer.notify(method, params),
		close: () => {
			peer.close('server closed');
			onClose();
		}
	};
}

/** A stdio server: its program started in the run's folder, with the server's env over the run's. */
export function stdioConnection(s: McpServerParams, cwd: string, env: Record<string, string | undefined>, spawn: SpawnFn = spawnChild): McpConnection {
	const child = spawn([s.command!, ...(s.args ?? [])], { cwd, env: { ...env, ...(s.env ?? {}) } });
	// Its stderr is read and dropped (a full pipe would stall it); never logged.
	void (async () => {
		try {
			for await (const _ of child.stderr);
		} catch {}
	})();
	return pipeConnection({ write: (line) => void child.stdin.write(line), lines: linesOf(child.stdout) }, cwd, () => {
		try {
			child.stdin.end();
		} catch {}
		try {
			child.kill();
		} catch {}
	});
}

type SseEvent = { event: string; data: string };

/** The events of a `text/event-stream` body. */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncIterable<SseEvent> {
	let event = '';
	let data: string[] = [];
	for await (const line of linesOf(body)) {
		if (line === '') {
			if (data.length) yield { event: event || 'message', data: data.join('\n') };
			event = '';
			data = [];
		} else if (line.startsWith(':')) continue;
		else {
			const colon = line.indexOf(':');
			const field = colon < 0 ? line : line.slice(0, colon);
			const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
			if (field === 'event') event = value;
			else if (field === 'data') data.push(value);
		}
	}
	if (data.length) yield { event: event || 'message', data: data.join('\n') };
}

/** The server wants a sign-in Arkai cannot do (OAuth): reported as `needs-auth`. */
export class McpAuthError extends Error {}

type Message = { id?: number | string | null; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } };

function answerOf(msg: Message): unknown {
	if (msg.error) throw new RpcCallError(Number(msg.error.code) || -32000, String(msg.error.message ?? 'error'));
	return msg.result;
}

/** HTTP transports' shared part: headers, the server's requests answered by POST. */
abstract class HttpBase implements McpConnection {
	protected next = 0;
	protected closer = new AbortController();
	protected protocol: string | null = null;

	constructor(
		protected url: string,
		protected headers: Record<string, string>,
		protected cwd: string,
		protected fetchFn: typeof fetch = fetch
	) {}

	abstract request(method: string, params: unknown, o?: { signal?: AbortSignal; timeoutMs?: number }): Promise<unknown>;
	protected abstract postUrl(): string;

	protected extraHeaders(): Record<string, string> {
		return {};
	}

	protected post(msg: Obj, signal?: AbortSignal): Promise<Response> {
		const signals = [this.closer.signal, ...(signal ? [signal] : [])];
		return this.fetchFn(this.postUrl(), {
			method: 'POST',
			headers: { ...this.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...this.extraHeaders() },
			body: JSON.stringify({ jsonrpc: '2.0', ...msg }),
			signal: AbortSignal.any(signals)
		});
	}

	notify(method: string, params?: unknown) {
		void this.post(params === undefined ? { method } : { method, params })
			.then((r) => r.body?.cancel())
			.catch(() => {});
	}

	/** A request or notification the server sent: answered (requests) by POST. */
	protected async fromServer(msg: Message) {
		if (typeof msg.method !== 'string' || msg.id === undefined || msg.id === null) return;
		let reply: Obj;
		try {
			reply = { id: msg.id, result: (await serverRequest(this.cwd)(msg.method)) ?? null };
		} catch (e) {
			reply = { id: msg.id, error: { code: e instanceof RpcCallError ? e.code : -32603, message: e instanceof Error ? e.message : String(e) } };
		}
		await this.post(reply)
			.then((r) => r.body?.cancel())
			.catch(() => {});
	}

	close() {
		this.closer.abort();
	}
}

/** Streamable HTTP: each request POSTed; the answer comes as JSON or on an event stream. */
export class HttpConnection extends HttpBase {
	private session: string | null = null;

	protected postUrl() {
		return this.url;
	}

	protected extraHeaders(): Record<string, string> {
		return { ...(this.session ? { 'mcp-session-id': this.session } : {}), ...(this.protocol ? { 'mcp-protocol-version': this.protocol } : {}) };
	}

	request(method: string, params: unknown, o: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
		const id = ++this.next;
		const run = async () => {
			const res = await this.post({ id, method, params }, o.signal);
			const sid = res.headers.get('mcp-session-id');
			if (sid) this.session = sid;
			if (!res.ok) {
				await res.body?.cancel().catch(() => {});
				if (res.status === 401 || res.status === 403) throw new McpAuthError(`HTTP ${res.status}: the server needs authorization`);
				throw new Error(`HTTP ${res.status}`);
			}
			const type = res.headers.get('content-type') ?? '';
			if (type.includes('text/event-stream') && res.body) {
				for await (const ev of sseEvents(res.body)) {
					if (ev.event !== 'message') continue;
					for (const msg of messagesOf(ev.data)) {
						if (msg.id === id && !msg.method) return answerOf(msg);
						void this.fromServer(msg);
					}
				}
				throw new Error(`${method}: the server closed the stream without an answer`);
			}
			const body: unknown = await res.json();
			const msg = messagesOf(body).find((m) => m.id === id && !m.method);
			if (!msg) throw new Error(`${method}: no answer in the server's reply`);
			return answerOf(msg);
		};
		const p = run().then((r) => {
			// Later requests carry the version the server agreed to.
			if (method === 'initialize' && isObj(r) && typeof r.protocolVersion === 'string') this.protocol = r.protocolVersion;
			return r;
		});
		return bounded(p, method, undefined, o.timeoutMs ?? 0);
	}

	close() {
		// Ends the session at the server (best effort), then everything in flight.
		if (this.session) void this.fetchFn(this.url, { method: 'DELETE', headers: { ...this.headers, ...this.extraHeaders() } }).catch(() => {});
		super.close();
	}
}

/** A message, or a batch of them, from a JSON body or event data. */
function messagesOf(v: unknown): Message[] {
	let parsed = v;
	if (typeof v === 'string') {
		try {
			parsed = JSON.parse(v);
		} catch {
			return [];
		}
	}
	return (Array.isArray(parsed) ? parsed : [parsed]).filter(isObj) as Message[];
}

/** The older HTTP+SSE transport: a GET event stream whose `endpoint` event says where to POST; answers come on the stream. */
export class SseConnection extends HttpBase {
	private endpoint: string | null = null;
	private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private ready: Promise<void>;

	constructor(url: string, headers: Record<string, string>, cwd: string, fetchFn: typeof fetch = fetch) {
		super(url, headers, cwd, fetchFn);
		this.ready = this.listen();
		this.ready.catch(() => {});
	}

	protected postUrl() {
		return this.endpoint!;
	}

	private listen(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			void (async () => {
				try {
					const res = await this.fetchFn(this.url, { headers: { ...this.headers, accept: 'text/event-stream' }, signal: this.closer.signal });
					if (res.status === 401 || res.status === 403) throw new McpAuthError(`HTTP ${res.status}: the server needs authorization`);
					if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
					for await (const ev of sseEvents(res.body)) {
						if (ev.event === 'endpoint') {
							const url = new URL(ev.data.trim(), this.url);
							// The server may only point at itself.
							if (url.origin !== new URL(this.url).origin) throw new Error('the server named an endpoint elsewhere');
							this.endpoint = url.href;
							resolve();
						} else if (ev.event === 'message') {
							for (const msg of messagesOf(ev.data)) {
								if (msg.method) void this.fromServer(msg);
								else if (typeof msg.id === 'number') {
									const w = this.waiting.get(msg.id);
									this.waiting.delete(msg.id);
									try {
										w?.resolve(answerOf(msg));
									} catch (e) {
										w?.reject(e as Error);
									}
								}
							}
						}
					}
					throw new Error('the server closed its event stream');
				} catch (e) {
					const err = e instanceof Error ? e : new Error(String(e));
					reject(err);
					for (const w of this.waiting.values()) w.reject(err);
					this.waiting.clear();
				}
			})();
		});
	}

	request(method: string, params: unknown, o: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
		const id = ++this.next;
		const p = this.ready.then(
			() =>
				new Promise<unknown>((resolve, reject) => {
					this.waiting.set(id, { resolve, reject });
					this.post({ id, method, params }, o.signal)
						.then(async (r) => {
							await r.body?.cancel().catch(() => {});
							if (!r.ok) throw new Error(`HTTP ${r.status}`);
						})
						.catch((e) => {
							this.waiting.delete(id);
							reject(e instanceof Error ? e : new Error(String(e)));
						});
				})
		);
		return bounded(p, method, o.signal, o.timeoutMs ?? 0).finally(() => this.waiting.delete(id));
	}

	close() {
		super.close();
		for (const w of this.waiting.values()) w.reject(new Error('server closed'));
		this.waiting.clear();
	}
}

export type McpToolInfo = { name: string; description: string; inputSchema: Obj };

/** A tool call's result as text for the model: text parts joined; images and other parts named. */
export function resultText(r: unknown): { content: string; isError: boolean } {
	if (!isObj(r)) return { content: '', isError: false };
	const parts: string[] = [];
	for (const c of Array.isArray(r.content) ? r.content.filter(isObj) : []) {
		if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
		else if (c.type === 'resource' && isObj(c.resource)) parts.push(typeof c.resource.text === 'string' ? c.resource.text : `[resource ${String(c.resource.uri ?? '')}]`);
		else if (c.type === 'resource_link') parts.push(`[resource ${String(c.uri ?? '')}]`);
		else if (c.type === 'image' || c.type === 'audio') parts.push(`[${c.type} ${String(c.mimeType ?? '')}]`.replace(' ]', ']'));
	}
	if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent));
	return { content: parts.join('\n'), isError: r.isError === true };
}

/** One server: initialized, its tools listed. */
export class McpClient {
	tools: McpToolInfo[] = [];

	constructor(
		readonly name: string,
		private conn: McpConnection
	) {}

	async connect(timeoutMs = CONNECT_TIMEOUT_MS) {
		await this.conn.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: { roots: { listChanged: false } }, clientInfo: { name: 'kingu-arkai', version: '1.0.0' } }, { timeoutMs });
		this.conn.notify('notifications/initialized');
		const tools: McpToolInfo[] = [];
		let cursor: string | undefined;
		do {
			const page = await this.conn.request('tools/list', cursor ? { cursor } : {}, { timeoutMs: REQUEST_TIMEOUT_MS });
			for (const t of isObj(page) && Array.isArray(page.tools) ? page.tools.filter(isObj) : []) {
				if (typeof t.name !== 'string' || !t.name) continue;
				const schema = isObj(t.inputSchema) ? t.inputSchema : {};
				tools.push({ name: t.name, description: typeof t.description === 'string' ? t.description : '', inputSchema: { ...schema, type: 'object', properties: isObj(schema.properties) ? schema.properties : {} } });
			}
			cursor = isObj(page) && typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined;
		} while (cursor && tools.length < MAX_TOOLS);
		this.tools = tools.slice(0, MAX_TOOLS);
	}

	async call(tool: string, args: Obj, signal: AbortSignal): Promise<{ content: string; isError: boolean }> {
		return resultText(await this.conn.request('tools/call', { name: tool, arguments: args }, { signal, timeoutMs: CALL_TIMEOUT_MS }));
	}

	close() {
		this.conn.close();
	}
}

/** A server or tool name in a function name: other characters become `_`. */
const clean = (s: string) => s.replace(NAME_CHARS, '_');

/** The model's name for a server's tool (`mcp__<server>__<tool>`), at most 64 characters. */
export function exposedName(server: string, tool: string): string {
	return `mcp__${clean(server)}__${clean(tool)}`.slice(0, MAX_NAME);
}

export type HubOptions = {
	cwd: string;
	env: Record<string, string | undefined>;
	log: (line: string) => void;
	/** The servers' state changed (an `mcp_status` goes out). */
	onChange: (servers: McpServerLive[]) => void;
	/** How a server is reached; tests pass their own. */
	connect?: (name: string, s: McpServerParams) => McpConnection;
};

type Entry = { status: 'pending' | 'connected' | 'failed' | 'needs-auth'; error: string | null; client: McpClient | null };

/** A run's MCP servers: connected in the background, their tools offered, calls routed, all closed at the end. */
export class McpHub {
	private entries = new Map<string, Entry>();
	private tools = new Map<string, { server: string; tool: string; def: ToolDef }>();
	private closed = false;
	/** Settles once every server connected or failed. */
	readonly ready: Promise<void>;

	constructor(
		servers: Record<string, McpServerParams>,
		private o: HubOptions
	) {
		const connect = o.connect ?? ((_name, s) => defaultConnection(s, o.cwd, o.env));
		this.ready = Promise.all(Object.entries(servers).map(([name, s]) => this.start(name, s, connect))).then(() => {});
	}

	private async start(name: string, s: McpServerParams, connect: NonNullable<HubOptions['connect']>) {
		const entry: Entry = { status: 'pending', error: null, client: null };
		this.entries.set(name, entry);
		let client: McpClient | null = null;
		try {
			client = new McpClient(name, connect(name, s));
			await client.connect();
			if (this.closed) return client.close();
			entry.client = client;
			entry.status = 'connected';
			for (const t of client.tools) {
				let exposed = exposedName(name, t.name);
				for (let n = 2; this.tools.has(exposed); n++) exposed = `${exposedName(name, t.name).slice(0, MAX_NAME - String(n).length - 1)}_${n}`;
				const description = (t.description || `${t.name} (MCP server ${name})`).slice(0, MAX_DESCRIPTION);
				this.tools.set(exposed, { server: name, tool: t.name, def: { name: exposed, description, parameters: t.inputSchema } });
			}
			this.o.log(`mcp ${name}: connected, ${client.tools.length} tools`);
		} catch (e) {
			client?.close();
			if (this.closed) return;
			entry.status = e instanceof McpAuthError ? 'needs-auth' : 'failed';
			entry.error = e instanceof Error ? e.message : String(e);
			this.o.log(`mcp ${name}: failed`);
		}
		this.changed();
	}

	private changed() {
		if (!this.closed) this.o.onChange(this.status());
	}

	status(): McpServerLive[] {
		return [...this.entries].map(([name, e]) => ({
			name,
			status: e.status,
			error: e.error,
			source: null,
			tools: e.client?.tools.map((t) => t.name) ?? []
		}));
	}

	/** The tools of the connected servers. */
	defs(): ToolDef[] {
		return [...this.tools.values()].map((t) => t.def);
	}

	has(name: string): boolean {
		return this.tools.has(name);
	}

	async call(name: string, args: Obj, signal: AbortSignal): Promise<{ content: string; isError: boolean }> {
		const t = this.tools.get(name);
		const client = t && this.entries.get(t.server)?.client;
		if (!t || !client) return { content: `The MCP tool ${name} is not available.`, isError: true };
		try {
			return await client.call(t.tool, args, signal);
		} catch (e) {
			return { content: `MCP server ${t.server}: ${e instanceof Error ? e.message : String(e)}`, isError: true };
		}
	}

	close() {
		if (this.closed) return;
		this.closed = true;
		for (const e of this.entries.values()) e.client?.close();
		this.tools.clear();
	}
}

function defaultConnection(s: McpServerParams, cwd: string, env: Record<string, string | undefined>): McpConnection {
	const type = s.type ?? 'stdio';
	if (type === 'stdio') return stdioConnection(s, cwd, env);
	if (!s.url) throw new Error('no url');
	return type === 'sse' ? new SseConnection(s.url, s.headers ?? {}, cwd) : new HttpConnection(s.url, s.headers ?? {}, cwd);
}
