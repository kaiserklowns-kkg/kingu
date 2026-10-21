// A fake MCP server for Arkai's tests, in this process: the same handler behind line pipes (as a
// stdio server would speak), Streamable HTTP and the older HTTP+SSE transport (Bun.serve on a
// free port). Tools: `echo` (its text back), `fail` (an error result), `slow` (answers after
// `release()`), and `ask_root` (asks the client for its roots first, stdio only). Over pipes,
// `elicit` and `sample` ask the client for a form / a model call and return its answer as JSON.
// Resources (two, one binary, and a template) and a prompt with an argument, when `extras`.

import type { Pipes } from '../../src/runtimes/rpc.ts';

type Msg = { jsonrpc?: string; id?: number | string; method?: string; params?: any; result?: any; error?: any };

export const TOOLS = [
	{ name: 'echo', description: 'Says the text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
	{ name: 'fail', description: 'Always fails', inputSchema: { type: 'object' } },
	{ name: 'slow', description: 'Answers when released', inputSchema: { type: 'object', properties: {} } },
	{ name: 'ask.root', inputSchema: { type: 'object', properties: {} } }
];

export const FORM = { type: 'object', properties: { title: { type: 'string', minLength: 1 }, priority: { type: 'string', enum: ['low', 'high'] }, count: { type: 'integer', minimum: 1 }, urgent: { type: 'boolean' } }, required: ['title'] };

export class FakeMcp {
	/** Methods asked, in order. */
	readonly asked: string[] = [];
	/** Headers of each HTTP request. */
	readonly headers: Record<string, string>[] = [];
	private slow: (() => void)[] = [];
	/** `tools/list` comes in two pages. */
	paged = true;
	/** HTTP answers with 401. */
	unauthorized = false;
	private server: ReturnType<typeof Bun.serve> | null = null;
	/** Streams of the legacy SSE transport, by session. */
	private streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
	deleted = 0;
	/** Resources and prompts are offered (and the `elicit` / `sample` tools listed). */
	extras = false;
	/** The client's `initialize` params. */
	init: any = null;

	release() {
		for (const r of this.slow.splice(0)) r();
	}

	/** The answer to one message (null for a notification); `ask` sends the server's own request. */
	async handle(m: Msg, ask?: (method: string, params?: unknown) => Promise<any>): Promise<Msg | null> {
		if (!m.method) return null;
		this.asked.push(m.method);
		if (m.id === undefined) return null;
		const ok = (result: unknown): Msg => ({ jsonrpc: '2.0', id: m.id, result });
		switch (m.method) {
			case 'initialize':
				this.init = m.params;
				return ok({ protocolVersion: '2025-03-26', capabilities: { tools: {}, ...(this.extras ? { resources: {}, prompts: {} } : {}) }, serverInfo: { name: 'fake', version: '1' } });
			case 'resources/list':
				return m.params?.cursor === 'r2'
					? ok({ resources: [{ uri: 'file:///logo.png', name: 'logo', mimeType: 'image/png' }] })
					: ok({ resources: [{ uri: 'memo://readme', name: 'readme', title: 'Read me', description: 'The notes', mimeType: 'text/plain' }], nextCursor: 'r2' });
			case 'resources/templates/list':
				return ok({ resourceTemplates: [{ uriTemplate: 'memo://notes/{topic}', name: 'notes', description: 'Notes on a topic' }] });
			case 'resources/read': {
				const uri = m.params?.uri;
				if (uri === 'file:///logo.png') return ok({ contents: [{ uri, mimeType: 'image/png', blob: 'AAAAAAAA' }] });
				if (typeof uri === 'string' && uri.startsWith('memo://')) return ok({ contents: [{ uri, mimeType: 'text/plain', text: `content of ${uri}` }] });
				return { jsonrpc: '2.0', id: m.id, error: { code: -32002, message: 'resource not found' } };
			}
			case 'prompts/list':
				return ok({ prompts: [{ name: 'review', title: 'Review code', description: 'Reviews a file', arguments: [{ name: 'file', description: 'Which file', required: true }, { name: 'tone' }] }] });
			case 'prompts/get': {
				const args = m.params?.arguments ?? {};
				if (m.params?.name !== 'review') return { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'no prompt' } };
				return ok({
					description: 'Review',
					messages: [
						{ role: 'user', content: { type: 'text', text: `Review ${args.file}${args.tone ? ` (${args.tone})` : ''}` } },
						{ role: 'user', content: { type: 'resource', resource: { uri: 'memo://style', mimeType: 'text/plain', text: 'style guide' } } },
						{ role: 'assistant', content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } }
					]
				});
			}
			case 'tools/list':
				if (this.extras) return ok({ tools: [...TOOLS, { name: 'elicit', inputSchema: { type: 'object' } }, { name: 'sample', inputSchema: { type: 'object' } }] });
				if (!this.paged) return ok({ tools: TOOLS });
				return m.params?.cursor === 'p2' ? ok({ tools: TOOLS.slice(2) }) : ok({ tools: TOOLS.slice(0, 2), nextCursor: 'p2' });
			case 'tools/call': {
				const { name, arguments: args } = m.params ?? {};
				if (name === 'echo') return ok({ content: [{ type: 'text', text: `echo: ${args?.text}` }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] });
				if (name === 'fail') return ok({ content: [{ type: 'text', text: 'it broke' }], isError: true });
				if (name === 'slow') {
					await new Promise<void>((r) => this.slow.push(r));
					return ok({ content: [{ type: 'text', text: 'slow done' }] });
				}
				if (name === 'ask.root') {
					const roots = ask ? await ask('roots/list') : null;
					return ok({ content: [{ type: 'text', text: JSON.stringify(roots) }] });
				}
				if (name === 'elicit') {
					const r = ask ? await ask('elicitation/create', { message: 'New ticket', requestedSchema: FORM }) : null;
					return ok({ content: [{ type: 'text', text: JSON.stringify(r) }] });
				}
				if (name === 'sample') {
					const r = ask ? await ask('sampling/createMessage', { messages: [{ role: 'user', content: { type: 'text', text: 'Summarise: hello' } }], systemPrompt: 'Be short', maxTokens: 50 }) : null;
					return ok({ content: [{ type: 'text', text: JSON.stringify(r) }] });
				}
				return { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `no tool ${name}` } };
			}
			default:
				return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } };
		}
	}

	/** Line pipes to the server, as a child's stdin / stdout would be. */
	pipes(): Pipes & { closed: boolean } {
		const queue: string[] = [];
		let wake: (() => void) | null = null;
		let next = 1000;
		const waiting = new Map<number, (v: any) => void>();
		const push = (m: Msg) => {
			queue.push(JSON.stringify(m));
			wake?.();
		};
		const ask = (method: string, params?: unknown) =>
			new Promise<any>((resolve) => {
				const id = ++next;
				waiting.set(id, resolve);
				push({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
			});
		const self = this;
		const state = { closed: false };
		const p = {
			get closed() {
				return state.closed;
			},
			set closed(v: boolean) {
				state.closed = v;
			},
			write(line: string) {
				const m = JSON.parse(line) as Msg;
				if (!m.method && typeof m.id === 'number' && waiting.has(m.id)) {
					waiting.get(m.id)!(m.error ? { error: m.error } : m.result);
					waiting.delete(m.id);
					return;
				}
				void self.handle(m, ask).then((r) => r && push(r));
			},
			lines: (async function* () {
				while (!state.closed) {
					if (!queue.length) await new Promise<void>((r) => (wake = r));
					while (queue.length) yield queue.shift()!;
				}
			})()
		};
		return p;
	}

	/** Serves `/mcp` (Streamable HTTP: lists as JSON, calls as an event stream) and `/sse` + `/messages` (HTTP+SSE). */
	serve(): string {
		this.server = Bun.serve({
			port: 0,
			idleTimeout: 0,
			fetch: async (req) => {
				const url = new URL(req.url);
				this.headers.push(Object.fromEntries(req.headers.entries()));
				if (this.unauthorized) return new Response('no', { status: 401 });
				if (url.pathname === '/mcp') {
					if (req.method === 'DELETE') {
						this.deleted++;
						return new Response(null, { status: 200 });
					}
					const m = (await req.json()) as Msg;
					const r = await this.handle(m);
					if (!r) return new Response(null, { status: 202 });
					const headers: Record<string, string> = m.method === 'initialize' ? { 'mcp-session-id': 'sess-1' } : {};
					if (m.method === 'tools/call')
						return new Response(`event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\nevent: message\ndata: ${JSON.stringify(r)}\n\n`, {
							headers: { ...headers, 'content-type': 'text/event-stream' }
						});
					return Response.json(r, { headers });
				}
				if (url.pathname === '/sse') {
					const session = `s${this.streams.size + 1}`;
					const stream = new ReadableStream<Uint8Array>({
						start: (c) => {
							this.streams.set(session, c);
							c.enqueue(new TextEncoder().encode(`: hello\n\nevent: endpoint\ndata: /messages?session=${session}\n\n`));
						}
					});
					return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
				}
				if (url.pathname === '/messages') {
					const c = this.streams.get(url.searchParams.get('session') ?? '');
					if (!c) return new Response('no session', { status: 404 });
					const m = (await req.json()) as Msg;
					void this.handle(m).then((r) => r && c.enqueue(new TextEncoder().encode(`event: message\ndata: ${JSON.stringify(r)}\n\n`)));
					return new Response('Accepted', { status: 202 });
				}
				return new Response('not found', { status: 404 });
			}
		});
		return `http://127.0.0.1:${this.server.port}`;
	}

	stop() {
		this.release();
		for (const c of this.streams.values()) {
			try {
				c.close();
			} catch {}
		}
		this.server?.stop(true);
	}
}
