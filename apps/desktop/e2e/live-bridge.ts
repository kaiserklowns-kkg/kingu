/**
 * The e2e bridge: one real agent host (`main.ts`), one HTTP door. `agent_list_models` from the
 * page is answered by the real sidecar against the installed CLIs — no fixture answers here.
 * The runtime id → command table duplicates src-tauri's `agent/runtimes.rs::KNOWN`; both must
 * change together until one source of truth reaches the tests.
 */
import type { Subprocess } from 'bun';

import { existsSync, mkdirSync, realpathSync } from 'node:fs';

// The list_models probes spawn their CLI with this cwd; it must exist before the first ask.
mkdirSync('/tmp/kingu-e2e', { recursive: true });

const KNOWN: Record<string, { kind: 'acp' | 'codex'; args: string[] }> = {
	opencode: { kind: 'acp', args: ['acp'] },
	codex: { kind: 'codex', args: ['app-server'] },
	gemini: { kind: 'acp', args: ['--experimental-acp'] },
	qwen: { kind: 'acp', args: ['--experimental-acp'] },
	goose: { kind: 'acp', args: ['acp'] },
	grok: { kind: 'acp', args: ['agent', 'stdio'] },
	omp: { kind: 'acp', args: ['acp'] }
};

const host = Bun.spawn(['bun', new URL('../../agent-host/src/main.ts', import.meta.url).pathname], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' });
let nextId = 1;
let raw = '';
const pump = (async () => {
	const dec = new TextDecoder();
	for await (const chunk of host.stdout) raw += dec.decode(chunk);
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

async function ask(method: string, params: unknown): Promise<unknown> {
	const id = nextId++;
	host.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
	const reply = await new Promise<string>((resolve, reject) => {
		const started = Date.now();
		const wait = () => {
			const found = raw.split('\n').find((line) => line.includes(`"id":${id},`) || line.endsWith(`"id":${id}}`) || line.includes(`"id": ${id},`));
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

const live: BunServe = Bun.serve({
	port: 4179,
	idleTimeout: 120,
	async fetch(request) {
		const url = new URL(request.url);
		// The page's origin (the Vite dev server) crosses to this door: CORS, widely.
		if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'content-type' } });
		const cors = { 'Access-Control-Allow-Origin': '*' };
		if (request.method === 'GET' && url.pathname === '/') return new Response(null, { status: 204, headers: cors }); // the webServer probe
		if (url.pathname !== '/invoke') return new Response('no such path', { status: 404, headers: cors });
		const { command, args } = (await request.json()) as { command: string; args: Record<string, unknown> };
		try {
			if (command !== 'agent_list_models') return Response.json({ ok: false, error: `the bridge speaks list_models only, asked for ${command}` }, { status: 400, headers: cors });
			const id = String(args?.runtime ?? '');
			const known = KNOWN[id];
			const commandPath = known ? resolveCli(id) : null;
			if (!known || !commandPath) return Response.json({ ok: false, error: `unknown runtime ${id}` }, { status: 400, headers: cors });
			const result = await ask('list_models', { runtime: { kind: known.kind, command: commandPath, args: known.args }, cwd: '/tmp/kingu-e2e' });
			// The Rust command returns the bare Vec; the page awaits that shape.
			const models = (result as { models?: unknown } | null)?.models ?? [];
			return Response.json({ ok: true, value: models }, { headers: cors });
		} catch (e) {
			return Response.json({ ok: false, error: String(e) }, { status: 200, headers: cors });
		}
	}
});

type BunServe = { stop(options?: { closeActiveConnections?: boolean }): unknown };
console.log(`[live-bridge] agent host ${host.pid} ready, door on ${live.port}`);
process.on('SIGTERM', () => {
	host.kill();
	process.exit(0);
});
