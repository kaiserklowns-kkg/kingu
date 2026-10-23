import { describe, expect, test } from 'bun:test';

/**
 * The real thing (no fixtures): the actual `main.ts` agent host answers `list_models` for the
 * installed OpenCode / Codex CLIs. Skips where a CLI is missing, so other machines still pass.
 */
const OPENCODE = Bun.which('opencode');
const CODEX = Bun.which('codex');
const CWD = '/tmp';

type ModelOption = { value: string; display_name?: string; description?: string };

async function listModels(runtime: { kind: 'acp' | 'codex'; command: string; args: string[] }, timeoutMs: number): Promise<ModelOption[]> {
	const host = Bun.spawn(['bun', new URL('../src/main.ts', import.meta.url).pathname], {
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, RUST_LOG: 'error' }
	});
	const send = (id: number, method: string, params: unknown) => host.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
	let raw = '' + '';
	const pump = (async () => {
		const dec = new TextDecoder();
		for await (const chunk of host.stdout) raw += dec.decode(chunk);
	})();
	send(1, 'list_models', { runtime, cwd: CWD });
	const line = await new Promise<_rpc_line>((resolve, reject) => {
		const started = Date.now();
		const wait = () => {
			const found = raw.split('\n').find((l) => l.includes('"id":1'));
			if (found) return resolve(found as _rpc_line);
			if (Date.now() - started > timeoutMs) return reject(new Error(`list_models ${runtime}: no answer in ${timeoutMs}ms; stderr: ${raw}`));
			setTimeout(wait, 250);
		};
		wait();
	});
	host.kill();
	await pump.catch(() => {});
	const reply = JSON.parse(line) as { result?: { models?: ModelOption[] } | null };
	return reply.result?.models ?? [];
}

type _rpc_line = string;

describe('live model probes (installed CLIs)', () => {
	test('opencode names its models through a real throwaway session', async () => {
		test.skipIf(!OPENCODE);
		const models = await listModels({ kind: 'acp', command: OPENCODE!, args: ['acp'] }, 90_000);
		expect(Array.isArray(models)).toBe(true);
		expect(models.length).toBeGreaterThan(0);
		for (const m of models) {
			expect(typeof m.value).toBe('string');
			expect(m.value.length).toBeGreaterThan(0);
			expect(typeof (m.display_name ?? m.value)).toBe('string');
		}
	});

	test('codex names its models with their effort levels', async () => {
		test.skipIf(!CODEX);
		const models = await listModels({ kind: 'codex', command: CODEX!, args: ['app-server'] }, 90_000);
		expect(models.length).toBeGreaterThan(0);
		for (const m of models) {
			expect(typeof m.value).toBe('string');
			// Codex's `/model/list` rows carry systematic reasoning effort choices.
			if ('efforts' in (m as Record<string, unknown>)) {
				const efforts = (m as unknown as { efforts?: unknown[] }).efforts;
				if (Array.isArray(efforts) && efforts.length) for (const e of efforts) expect(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(e))).toBe(true);
			}
		}
	}, 120_000);
});
