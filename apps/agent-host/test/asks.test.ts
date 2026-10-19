// Kingu's always-ask checks (guards/asks.ts): protected-path patterns, deletes in shell commands,
// writes outside the run's folder, MCP tools; then the ask through the host: a `guard_asked`
// event and a permission prompt from the PreToolUse hook, in Allow all mode too, and no second
// prompt from canUseTool once the user said yes.

import { describe, expect, test } from 'bun:test';
import type { HookCallbackMatcher, Options, PermissionResult, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { AgentHost, type QueryFn } from '../src/host.ts';
import type { AgentEvent } from '../src/protocol.ts';
import { askDeniedReason, askFor, deletedPaths, insideCwd, isProtected, parsePatterns, shellWords } from '../src/guards/asks.ts';
import { ASK_TIMEOUT_S, Guards } from '../src/guards/index.ts';

const same = (p: string) => p;
const on = { outsideCwd: true, deletes: true, mcpTools: true };

describe('protected paths', () => {
	const rules = parsePatterns(['# secrets', '', '.env*', 'secrets/', '/config/prod.yml', 'keys/**/*.pem', '!.env.example']);

	test('gitignore-style matching', () => {
		const yes = ['.env', '.env.local', 'app/.env', 'secrets/a.txt', 'app/secrets/b', 'config/prod.yml', 'keys/x/y/z.pem', 'keys/z.pem'];
		const no = ['.env.example', 'envs', 'app/config/prod.yml', 'secretsx/a', 'keys/z.txt', 'src/main.ts'];
		expect(yes.filter((p) => !isProtected(rules, p))).toEqual([]);
		expect(no.filter((p) => isProtected(rules, p))).toEqual([]);
	});

	test('reading or writing one asks; outside the folder it is not ours to protect', () => {
		expect(askFor('Read', { file_path: '/w/.env' }, '/w', {}, rules, same)).toEqual({ check: 'protected', paths: ['/w/.env'] });
		expect(askFor('Edit', { file_path: 'secrets/k' }, '/w', {}, rules, same)?.check).toBe('protected');
		expect(askFor('Bash', { command: 'cat secrets/k | head' }, '/w', {}, rules, same)).toEqual({ check: 'protected', paths: ['secrets/k'] });
		expect(askFor('Read', { file_path: '/other/.env' }, '/w', {}, rules, same)).toBeNull();
		expect(askFor('Read', { file_path: '/w/src/a.ts' }, '/w', {}, rules, same)).toBeNull();
	});
});

describe('shell commands', () => {
	test('words and commands, quotes removed', () => {
		expect(shellWords(`FOO=1 rm -f "a b.txt" && echo 'x;y' | wc`)).toEqual([['FOO=1', 'rm', '-f', 'a b.txt'], ['echo', 'x;y'], ['wc']]);
	});

	test('deletes', () => {
		expect(deletedPaths('rm -rf build dist')).toEqual(['build', 'dist']);
		expect(deletedPaths('cd x && sudo /bin/rm a')).toEqual(['a']);
		expect(deletedPaths('git rm --cached a.ts')).toEqual(['a.ts']);
		expect(deletedPaths('git clean -fdx')).toEqual(['*']);
		expect(deletedPaths('find . -name "*.o" -delete')).toEqual(['.']);
		expect(deletedPaths('unlink x; rmdir y')).toEqual(['x', 'y']);
		expect(deletedPaths('echo rm -rf / && git status && npm rm lodash')).toBeNull();
		expect(deletedPaths('ls -la')).toBeNull();
	});
});

describe('askFor', () => {
	test('writes outside the folder', () => {
		expect(insideCwd('../x', '/w/a', same)).toMatchObject({ abs: '/w/x', inside: false });
		expect(insideCwd('b/../c', '/w/a', same)).toMatchObject({ abs: '/w/a/c', rel: 'c', inside: true });
		expect(askFor('Write', { file_path: '/etc/hosts', content: '' }, '/w', on, [], same)).toEqual({ check: 'outside_cwd', paths: ['/etc/hosts'] });
		expect(askFor('Edit', { file_path: '/w2/a' }, '/w', on, [], same)?.check).toBe('outside_cwd');
		expect(askFor('Edit', { file_path: '/w/a' }, '/w', on, [], same)).toBeNull();
		// Reading outside is not a write.
		expect(askFor('Read', { file_path: '/etc/hosts' }, '/w', on, [], same)).toBeNull();
		// A symlink out of the folder counts as outside.
		const real = (p: string) => p.replace('/w/link', '/elsewhere');
		expect(askFor('Write', { file_path: '/w/link/a' }, '/w', on, [], real)?.check).toBe('outside_cwd');
	});

	test('deletes, MCP tools, and each check off', () => {
		expect(askFor('Bash', { command: 'rm a.txt' }, '/w', on, [], same)).toEqual({ check: 'delete', paths: ['a.txt'] });
		expect(askFor('Bash', { command: 'rm a.txt' }, '/w', { ...on, deletes: false }, [], same)).toBeNull();
		expect(askFor('mcp__github__create_issue', {}, '/w', on, [], same)).toEqual({ check: 'mcp', paths: [] });
		expect(askFor('mcp__github__create_issue', {}, '/w', { ...on, mcpTools: false }, [], same)).toBeNull();
		expect(askFor('Write', { file_path: '/etc/x' }, '/w', {}, [], same)).toBeNull();
	});

	test('the model is told why, with what the user said', () => {
		expect(askDeniedReason({ check: 'delete', paths: [] }, ' not now ')).toContain('it deletes files). They said: not now');
	});

	test('Guards: asks only when configured', () => {
		expect(new Guards().askFor('Bash', { command: 'rm x' }, same)).toBeNull();
		expect(new Guards(false, { cwd: '/w', deletes: true }).askFor('Bash', { command: 'rm x' }, same)?.check).toBe('delete');
		// Blocks off: the security check lets everything through.
		expect(new Guards(false, null).check('Bash', { command: 'rm -rf /' }).allow).toBe(true);
	});
});

/** One prompt: each call through the PreToolUse hooks, then canUseTool unless the mode skips it (like the SDK). */
function askQuery(calls: { tool: string; input: Record<string, unknown> }[], seen: { options?: Options; denied: string[]; asked: number; ran: string[] }): QueryFn {
	return ({ prompt, options }) => {
		seen.options = options;
		const gen = (async function* () {
			for await (const _m of prompt as AsyncIterable<SDKUserMessage>) {
				let i = 0;
				for (const c of calls) {
					const id = `tu${++i}`;
					let denied = false;
					for (const m of (options.hooks?.PreToolUse ?? []) as HookCallbackMatcher[]) {
						for (const h of m.hooks) {
							const out = (await h(
								{ hook_event_name: 'PreToolUse', tool_name: c.tool, tool_input: c.input, tool_use_id: id, session_id: 's', transcript_path: '', cwd: options.cwd! },
								id,
								{ signal: new AbortController().signal }
							)) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
							if (out.hookSpecificOutput?.permissionDecision === 'deny') {
								denied = true;
								seen.denied.push(out.hookSpecificOutput.permissionDecisionReason ?? '');
							}
						}
					}
					if (denied) continue;
					if (options.permissionMode !== 'bypassPermissions') {
						seen.asked++;
						const r = (await options.canUseTool!(c.tool, c.input, { signal: new AbortController().signal, toolUseID: id, suggestions: [] } as never)) as PermissionResult;
						if (r.behavior !== 'allow') continue;
					}
					seen.ran.push(id);
				}
				yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's', num_turns: 1, duration_ms: 1, total_cost_usd: 0 };
			}
		})();
		return Object.assign(gen, { interrupt: async () => {} });
	};
}

async function askRun(calls: { tool: string; input: Record<string, unknown> }[], params: Record<string, unknown>, answer: (ev: Extract<AgentEvent, { kind: 'permission_request' }>) => string) {
	const out: { method?: string; params?: { runId: number; event: AgentEvent } }[] = [];
	const seen = { denied: [] as string[], asked: 0, ran: [] as string[] } as { options?: Options; denied: string[]; asked: number; ran: string[] };
	let n = 0;
	const host: AgentHost = new AgentHost({
		query: askQuery(calls, seen),
		newId: () => `r${++n}`,
		write: (m) => {
			const msg = JSON.parse(JSON.stringify(m));
			out.push(msg);
			const ev = msg.params?.event as AgentEvent | undefined;
			if (ev?.kind === 'permission_request') queueMicrotask(() => void host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'answer', params: { runId: 1, requestId: ev.request_id, decision: answer(ev) } })));
		}
	});
	await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'start', params: { runId: 1, cwd: '/w', prompt: 'x', ...params } }));
	for (let i = 0; i < 200 && !out.some((o) => o.params?.event?.kind === 'result'); i++) await Bun.sleep(5);
	return { events: out.filter((o) => o.method === 'event').map((o) => o.params!.event), seen };
}

describe('the safety ask in a run', () => {
	test('Allow all still asks before a delete, and says why first', async () => {
		const { events, seen } = await askRun([{ tool: 'Bash', input: { command: 'rm notes.txt' } }], { permissionMode: 'bypassPermissions', guardAsks: { deletes: true } }, () => 'allow');
		const kinds = events.map((e) => e.kind).filter((k) => k.startsWith('guard') || k.startsWith('permission'));
		expect(kinds).toEqual(['guard_asked', 'permission_request', 'permission_resolved']);
		expect(events.find((e) => e.kind === 'guard_asked')).toEqual({ kind: 'guard_asked', request_id: 'r1', tool: 'Bash', tool_use_id: 'tu1', check: 'delete', paths: ['notes.txt'] });
		expect(events.find((e) => e.kind === 'permission_request')).toMatchObject({ can_always: false, rules: [] });
		expect(seen.ran).toEqual(['tu1']);
		// The hook waits for the user: never cut short by the SDK's hook timeout.
		expect((seen.options?.hooks?.PreToolUse?.[0] as HookCallbackMatcher).timeout).toBe(ASK_TIMEOUT_S);
	});

	test('a no is the tool’s error, with the reason', async () => {
		const { seen } = await askRun([{ tool: 'Write', input: { file_path: '/etc/x', content: '' } }], { permissionMode: 'acceptEdits', guardAsks: { outsideCwd: true } }, () => 'deny');
		expect(seen.ran).toEqual([]);
		expect(seen.denied[0]).toContain('writes outside the project folder');
	});

	test('in Ask mode the yes is not asked for a second time', async () => {
		const { events, seen } = await askRun([{ tool: 'mcp__gh__x', input: {} }], { guardAsks: { mcpTools: true } }, () => 'allow');
		expect(events.filter((e) => e.kind === 'permission_request').length).toBe(1);
		expect([seen.asked, seen.ran]).toEqual([1, ['tu1']]);
	});

	test('in plan mode a yes at the safety ask still leaves the plan-mode prompt', async () => {
		const { events, seen } = await askRun([{ tool: 'Write', input: { file_path: '/etc/x', content: '' } }], { permissionMode: 'plan', guardAsks: { outsideCwd: true } }, () => 'allow');
		expect(events.filter((e) => e.kind === 'permission_request').length).toBe(2);
		expect(seen.asked).toBe(1);
	});

	test('no guardAsks: no ask, and with safetyChecks off no hook at all', async () => {
		const { events, seen } = await askRun([{ tool: 'Bash', input: { command: 'rm a' } }], { permissionMode: 'bypassPermissions', safetyChecks: false }, () => 'deny');
		expect(events.some((e) => e.kind === 'guard_asked')).toBe(false);
		expect(seen.options?.hooks).toBeUndefined();
		expect(seen.ran).toEqual(['tu1']);
	});

	test('bad guardAsks are refused', async () => {
		const out: string[] = [];
		const host = new AgentHost({ query: askQuery([], { denied: [], asked: 0, ran: [] }), write: (m) => out.push(JSON.stringify(m)) });
		await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'start', params: { runId: 1, cwd: '/w', prompt: 'x', guardAsks: { deletes: 'yes' } } }));
		expect(out[0]).toContain('guardAsks must be');
	});
});
