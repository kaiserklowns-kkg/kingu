// The command registry's unregister, run against the real commands.svelte.ts compiled the way the
// app compiles it (Svelte's dev mode): a `$state` list would hold proxies of the commands, so
// unregister (which compares the caller's own object) never found its command and Svelte warned
// `state_proxy_equality_mismatch` each time — dozens to thousands of times per page load.

import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { compileModule } from 'svelte/compiler';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HERE = import.meta.dir;
const LIB = join(HERE, '..');

// The registry's rune-using neighbours, stubbed (bun runs .svelte.ts files uncompiled).
const stubs: Record<string, Record<string, unknown>> = {
	[join(HERE, 'keybindings.svelte.ts')]: { keybindings: { user: { added: [], removed: [], when: {}, args: {} } } },
	[join(HERE, 'contextKeys.svelte.ts')]: { currentContext: () => ({}) },
	[join(HERE, 'mode.svelte.ts')]: { appMode: { isAgents: false } },
	[join(HERE, 'status.svelte.ts')]: { status: { flash: () => {} } },
	[join(LIB, 'settings', 'settings.svelte.ts')]: { settings: { get: () => undefined } }
};
for (const [path, exports] of Object.entries(stubs)) mock.module(path, () => exports);

type Registry = { all: { id: string }[]; get(id: string): unknown; register(cmd: { id: string; title: string; run: () => void }): () => void };
let commands: Registry;
let dir = '';
const warnings: string[] = [];
const warn = console.warn;

beforeAll(async () => {
	const source = readFileSync(join(HERE, 'commands.svelte.ts'), 'utf8');
	const ts = new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
	let { code } = compileModule(ts, { generate: 'client', dev: true, filename: 'commands.svelte.js' }).js;
	// Absolute specifiers, so the compiled copy imports from a temp folder.
	code = code.replace(/from ['"](\.\/[^'"]+|#lib\/[^'"]+|svelte[^'"]*)['"]/g, (_, spec: string) => {
		if (spec.startsWith('svelte')) return `from '${Bun.resolveSync(spec, HERE)}'`;
		const path = spec.startsWith('#lib/') ? join(LIB, spec.slice(5)) : join(HERE, spec.slice(2));
		const file = Object.keys(stubs).find((s) => s === path || s === `${path}.ts`) ?? Bun.resolveSync(path, HERE);
		return `from '${file}'`;
	});
	dir = mkdtempSync(join(tmpdir(), 'kingu-commands-'));
	writeFileSync(join(dir, 'commands.js'), code);
	console.warn = (...args: unknown[]) => void warnings.push(String(args[0]));
	commands = (await import(join(dir, 'commands.js'))).commands as Registry;
});

afterAll(() => {
	console.warn = warn;
	rmSync(dir, { recursive: true, force: true });
});

test('unregister removes the command it registered, without a proxy equality warning', () => {
	const off = commands.register({ id: 'test.proxyEquality', title: 'Test', run: () => {} });
	expect(commands.get('test.proxyEquality')).toBeDefined();
	off();
	expect(commands.get('test.proxyEquality')).toBeUndefined();
	expect(warnings.filter((w) => w.includes('state_proxy_equality_mismatch'))).toEqual([]);
});

test("a stale unregister leaves the command that replaced it under the same id", () => {
	const offOld = commands.register({ id: 'test.replaced', title: 'Old', run: () => {} });
	const offNew = commands.register({ id: 'test.replaced', title: 'New', run: () => {} });
	offOld();
	expect(commands.all.filter((c) => c.id === 'test.replaced')).toHaveLength(1);
	offNew();
	expect(commands.get('test.replaced')).toBeUndefined();
	expect(warnings.filter((w) => w.includes('state_proxy_equality_mismatch'))).toEqual([]);
});
