/**
 * The e2e bridge: one real agent host (`main.ts`), one HTTP door. `agent_list_models`,
 * `agent_start` and `agent_send` from the page are answered by the real sidecar against the
 * installed CLIs — no fixture answers these. The run's `event` notifications stream back
 * through SSE (`/events?runId=<n>`), `index`-numbered for the page's Tauri channel callback.
 * The runtime id → command table duplicates src-tauri's `agent/runtimes.rs::KNOWN`; both must
 * change together until one source of truth reaches the tests.
 */
import { existsSync, mkdirSync, realpathSync } from 'node:fs';

// The agent runs (and the probes) use this cwd with the CLIs; it must exist.
mkdirSync('/tmp/kingu-e2e', { recursive: true });

const KNOWN: Record<string, { name: string; kind: 'acp' | 'codex'; args: string[] }> = {
	opencode: { name: 'OpenCode', kind: 'acp', args: ['acp'] },
	codex: { name: 'Codex', kind: 'codex', args: ['app-server'] },
	gemini: { name: 'Gemini CLI', kind: 'acp', args: ['--experimental-acp'] },
	qwen: { name: 'Qwen Code', kind: 'acp', args: ['--experimental-acp'] },
	goose: { name: 'goose', kind: 'acp', args: ['acp'] },
	grok: { name: 'Grok', kind: 'acp', args: ['agent', 'stdio'] },
	omp: { name: 'oh-my-pi', kind: 'acp', args: ['acp'] }
};

const host = Bun.spawn(['bun', new URL('../../agent-host/src/main.ts', import.meta.url).pathname], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' });
let nextId = 1;
let nextRun = 1;
let raw = '';
/** Every complete JSON-RPC line the host wrote (partial chunks fold at the newline they end). */
const hostLines: string[] = [];
let partial = '';
const pump = (async () => {
	const dec = new TextDecoder();
	for await (const chunk of host.stdout) {
		const text = partial + dec.decode(chunk);
		raw += text; // full log for debugging
		const lines = text.split('\n');
		partial = lines.pop() ?? '';
		for (const line of lines) {
			hostLines.push(line);
			handleHostMessage(line);
		}
	}
})();

/**
 * PATH in a test runner can hold a dead per-shell alias (fnm's multishell bin), so unresolved
 * symlinks fall through to a durable CLI of the same name (fnm's default install).
 */
function resolveCli(name: string): string | null {
	for (const candidate of [Bun.which(name), `${process.env.HOME}/.local/share/fnm/aliases/default/bin/${name}`]) {
		if (candidate && existsSync(candidate)) return (realpathSync(candidate) || candidate) as string;
	}
	return null;
}

const runs = new Map<number, { buffer: { index: number; message: unknown }[]; subs: Set<(line: string) => void> }>();
function eventOf(runId: number, message: unknown) {
	const run = runs.get(runId) ?? { buffer: [], subs: new Set() };
	runs.set(runId, run);
	const line = `data: ${JSON.stringify({ index: run.buffer.length, message })}\n\n`;
	run.buffer.push({ index: run.buffer.length, message });
	for (const sub of run.subs) sub(line);
}

/** A real host event notification: `event` with `{ runId, event }`. */
function handleHostMessage(line: string) {
	if (!line.trim()) return;
	let msg: { method?: string; params?: { runId?: number; event?: unknown } };
	try {
		msg = JSON.parse(line);
	} catch {
		return; // the host's multiline logs and similar
	}
	if (msg.method === 'event' && msg.params?.runId != null) eventOf(msg.params.runId, msg.params.event);
}

async function ask(method: string, params: unknown): Promise<unknown> {
	const id = nextId++;
	// Complete lines only: scan the reply among the ones the pump finished after this ask started.
	const fromLine = hostLines.length;
	host.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
	const reply = await new Promise<string>((resolve, reject) => {
		const started = Date.now();
		const wait = () => {
			const found = hostLines.slice(fromLine).find((line) => line.includes(`"id":${id},`) || line.endsWith(`"id":${id}}`) || line.includes(`"id": ${id},`));
			if (found) return resolve(found);
			if (Date.now() - started > 90_000) return reject(new Error(`${method}: no answer from the agent host`));
			setTimeout(wait, 200);
		};
		wait();
	});
	const parsed = JSON.parse(reply) as { result?: unknown; error?: { message?: string } };
	if (parsed.error) throw new Error(parsed.error.message ?? 'agent host error');
	return parsed.result;
}

const cors = { 'Access-Control-Allow-Origin': '*' };
const sseHeaders = { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' };

function startParams(args: Record<string, unknown>): Record<string, unknown> | null {
	const id = String(args?.runtime ?? '');
	const known = KNOWN[id];
	const commandPath = known ? resolveCli(id) : null;
	if (!known || !commandPath) return null;
	return {
		runId: nextRun++,
		cwd: '/tmp/kingu-e2e',
		prompt: String(args?.prompt ?? ''),
		model: (args?.model as string | null) ?? null,
		permissionMode: (args?.permissionMode as string | null) ?? null,
		images: (args?.images as string[] | null) ?? [],
		runtime: { kind: known.kind, command: commandPath, args: known.args }
	};
}

function response(value: unknown, status = 200) {
	return Response.json({ ok: true, value }, { status, headers: cors });
}
function failure(error: unknown, status = 200) {
	return Response.json({ ok: false, error: String(error) }, { status, headers: cors });
}

const live = Bun.serve({
	port: 4179,
	idleTimeout: 240,
	async fetch(request) {
		const url = new URL(request.url);
		// The page's origin (the Vite dev server) crosses to this door: CORS, widely.
		if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'POST, GET', 'Access-Control-Allow-Headers': 'content-type' } });
		if (request.method === 'GET' && url.pathname === '/') return new Response(null, { status: 204, headers: cors }); // the webServer probe
		if (url.pathname !== '/invoke' && url.pathname !== '/events') return new Response('no such path', { status: 404, headers: cors });

		if (request.method === 'GET' && url.pathname === '/events') {
			const runId = Number(url.searchParams.get('runId'));
			const run = runs.get(runId);
			if (!run) return failure(`no run ${runId}`, 404);
			return new Response(
				new ReadableStream({
					start(controller) {
						const enc = new TextEncoder();
						for (const item of run.buffer) controller.enqueue(enc.encode(`data: ${JSON.stringify(item)}\n\n`));
						run.subs.add((line) => {
							try {
								controller.enqueue(enc.encode(line));
							} catch {
								// the page navigated away: drop it
							}
						});
					}
				}),
				{ headers: sseHeaders }
			);
		}

		const { command, args } = (await request.json()) as { command: string; args: Record<string, unknown> };
		try {
			switch (command) {
				case 'agent_runtimes': {
					// The real resolution, minus the user's custom ACP agents (settings hold those):
					// Claude and Arkai are always there; a known runtime joins when its CLI is on PATH.
					const onPath = (kind: string): boolean => !!resolveCli(kind);
					const features = (protocol: 'claude' | 'arkai' | 'acp' | 'codex') => ({ rewind: protocol === 'claude' || protocol === 'arkai', models: true });
					return response([
						{ id: 'claude', name: 'Claude Code', protocol: 'claude', features: features('claude'), custom: false },
						{ id: 'arkai', name: 'Arkai', protocol: 'arkai', features: features('arkai'), custom: false },
						...Object.entries(KNOWN)
							.filter(([id]) => onPath(id))
							.map(([id, { name, kind }]) => ({ id, name, protocol: kind, features: features(kind), custom: false }))
					]);
				}
				case 'agent_list_models': {					const start = startParams({ runtime: args.runtime });
					if (!start) return failure(`unknown runtime ${String(args?.runtime ?? '')}`);
					const result = await ask('list_models', { runtime: start.runtime, cwd: start.cwd });
					// The Rust command returns the bare Vec; the page awaits that shape.
					return response((result as { models?: unknown } | null)?.models ?? []);
				}
				case 'agent_start': {
					const start = startParams(args);
					if (!start) return failure(`unknown runtime ${String(args?.runtime ?? '')}`);
					const runId = start.runId;
					runs.set(runId!, { buffer: [], subs: new Set() });
					await ask('start', start);
					return response(runId);
				}
				case 'agent_send':
					await ask('send', { runId: args.runId, text: args.text, images: (args.images as string[] | null) ?? [] });
					return response(null);
				case 'agent_interrupt':
					await ask('interrupt', { runId: args.runId });
					return response(null);
				case 'agent_answer_permission':
					await ask('answer', { runId: args.runId, requestId: args.requestId, decision: args.decision, message: args.message ?? null, answers: args.answers ?? null });
					return response(null);
				case 'agent_set_options':
					// The page changes the live run's model / permission mode / effort; the host maps it per runtime.
					await ask('set_options', { runId: args.runId, model: args.model ?? null, permissionMode: args.permissionMode ?? null, effort: args.effort ?? null });
					return response(null);
				default:
					return failure(`the bridge speaks agent_runtimes/list_models/start/send/interrupt/answer/set_options only, asked for ${command}`, 400);
			}
		} catch (e) {
			return failure(e);
		}
	}
});

pump.then(() => {}); // events flow; the host's own replies are in `raw`
process.on('SIGTERM', () => {
	host.kill();
	process.exit(0);
});
console.log(`[live-bridge] agent host ${host.pid} ready, door on ${live.port}`);
