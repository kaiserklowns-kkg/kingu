// The PreToolUse snapshot hook, through a fake SDK that runs the hooks the way the SDK does
// (before the tool, in every permission mode) and then performs the edit itself.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookCallbackMatcher, Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { AgentHost, type QueryFn } from '../src/host.ts';
import type { AgentEvent } from '../src/protocol.ts';
import { editPath, MAX_SNAPSHOT_BYTES, snapshotOf } from '../src/snapshots.ts';

type Edit = { tool: string; input: Record<string, unknown>; apply: () => void };
type Snap = Extract<AgentEvent, { kind: 'file_snapshot' }>;

/** For each prompt: run the PreToolUse hooks whose matcher fits, then apply the edit (no canUseTool: acceptEdits). */
function editingQuery(edits: Edit[], seen: { options?: Options }): QueryFn {
	return ({ prompt, options }) => {
		seen.options = options;
		const gen = (async function* () {
			for await (const _m of prompt as AsyncIterable<SDKUserMessage>) {
				let i = 0;
				for (const e of edits) {
					const id = `tu${++i}`;
					for (const m of (options.hooks?.PreToolUse ?? []) as HookCallbackMatcher[]) {
						if (m.matcher && !new RegExp(`^(${m.matcher})$`).test(e.tool)) continue;
						for (const h of m.hooks)
							await h(
								{ hook_event_name: 'PreToolUse', tool_name: e.tool, tool_input: e.input, tool_use_id: id, session_id: 's', transcript_path: '', cwd: options.cwd! },
								id,
								{ signal: new AbortController().signal }
							);
					}
					e.apply();
				}
				yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's', num_turns: 1, duration_ms: 1, total_cost_usd: 0 };
			}
		})();
		return Object.assign(gen, { interrupt: async () => {} });
	};
}

function dir() {
	return realpathSync(mkdtempSync(join(tmpdir(), 'kingu-snap-')));
}

async function runEdits(cwd: string, edits: Edit[], snapshots = true) {
	const out: { method?: string; params?: { runId: number; event: AgentEvent } }[] = [];
	const seen: { options?: Options } = {};
	const host = new AgentHost({ query: editingQuery(edits, seen), write: (m) => out.push(JSON.parse(JSON.stringify(m))) });
	await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'start', params: { runId: 1, cwd, prompt: 'แก้ไฟล์', permissionMode: 'acceptEdits', snapshots } }));
	for (let i = 0; i < 200 && !out.some((o) => o.params?.event?.kind === 'result'); i++) await Bun.sleep(5);
	const events = out.filter((o) => o.method === 'event').map((o) => o.params!.event);
	return { events, snaps: events.filter((e): e is Snap => e.kind === 'file_snapshot'), options: seen.options! };
}

describe('PreToolUse snapshots', () => {
	test('each edit tool sends the content before the edit, then the edit runs', async () => {
		const cwd = dir();
		writeFileSync(join(cwd, 'a.txt'), 'เดิม\n');
		mkdirSync(join(cwd, 'nb'));
		writeFileSync(join(cwd, 'nb/n.ipynb'), '{"cells":[]}');
		const { snaps, events } = await runEdits(cwd, [
			{ tool: 'Edit', input: { file_path: join(cwd, 'a.txt') }, apply: () => writeFileSync(join(cwd, 'a.txt'), 'ใหม่\n') },
			{ tool: 'Write', input: { file_path: 'new/b.txt' }, apply: () => (mkdirSync(join(cwd, 'new')), writeFileSync(join(cwd, 'new/b.txt'), 'b')) },
			{ tool: 'MultiEdit', input: { file_path: join(cwd, 'a.txt') }, apply: () => writeFileSync(join(cwd, 'a.txt'), 'สาม\n') },
			{ tool: 'NotebookEdit', input: { notebook_path: join(cwd, 'nb/n.ipynb') }, apply: () => {} },
			{ tool: 'Bash', input: { command: 'touch x' }, apply: () => {} }
		]);
		expect(snaps.length).toBe(4);
		const [a, b, a2, nb] = snaps as [Snap, Snap, Snap, Snap];
		expect(a).toMatchObject({ tool: 'Edit', tool_use_id: 'tu1', path: join(cwd, 'a.txt'), existed: true, skipped: null });
		expect(Buffer.from(a.content_b64!, 'base64').toString()).toBe('เดิม\n');
		expect(b).toMatchObject({ tool: 'Write', path: join(cwd, 'new/b.txt'), existed: false, content_b64: null, skipped: null });
		expect(Buffer.from(a2.content_b64!, 'base64').toString()).toBe('ใหม่\n');
		expect(nb).toMatchObject({ tool: 'NotebookEdit', existed: true });
		// Snapshots come before the turn's result.
		expect(events.findIndex((e) => e.kind === 'result')).toBeGreaterThan(events.indexOf(nb));
		expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('สาม\n');
	});

	test('no snapshot hook unless the run asks for snapshots (the safety checks stay)', async () => {
		const cwd = dir();
		const { snaps, options } = await runEdits(cwd, [{ tool: 'Write', input: { file_path: join(cwd, 'x') }, apply: () => {} }], false);
		expect(snaps).toEqual([]);
		expect(options.hooks?.PreToolUse?.length).toBe(1);
		expect(options.hooks?.PreToolUse?.[0]?.matcher).toBeUndefined();
	});

	test('outside the cwd, symlinks and huge files are reported without content', () => {
		const cwd = dir();
		const other = dir();
		writeFileSync(join(other, 'secret'), 'x');
		symlinkSync(join(other, 'secret'), join(cwd, 'link'));
		symlinkSync(other, join(cwd, 'linkdir'));
		writeFileSync(join(cwd, 'big'), Buffer.alloc(MAX_SNAPSHOT_BYTES));
		expect(snapshotOf('Edit', 't', join(other, 'secret'), cwd)).toMatchObject({ skipped: 'outside', content_b64: null });
		expect(snapshotOf('Edit', 't', join(cwd, '../x'), cwd).skipped).toBe('outside');
		expect(snapshotOf('Edit', 't', join(cwd, 'link'), cwd)).toMatchObject({ skipped: 'symlink', content_b64: null });
		expect(snapshotOf('Edit', 't', join(cwd, 'linkdir/secret'), cwd)).toMatchObject({ skipped: 'outside', content_b64: null });
		expect(snapshotOf('Write', 't', join(cwd, 'big'), cwd)).toMatchObject({ skipped: 'too_large', size: MAX_SNAPSHOT_BYTES, content_b64: null });
	});

	test('odd inputs never block the edit', async () => {
		const cwd = dir();
		mkdirSync(join(cwd, 'd'));
		const { snaps, events } = await runEdits(cwd, [
			{ tool: 'Write', input: { file_path: 'a\0b' }, apply: () => {} },
			{ tool: 'Write', input: { file_path: join(cwd, 'd') }, apply: () => {} }
		]);
		expect(snaps).toEqual([expect.objectContaining({ skipped: 'unreadable', existed: true })]);
		expect(events.some((e) => e.kind === 'result')).toBe(true);
	});

	test('rejects a non-boolean snapshots flag', async () => {
		const out: { error?: { message: string } }[] = [];
		const host = new AgentHost({ query: editingQuery([], {}), write: (m) => out.push(m as never) });
		await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'start', params: { runId: 1, cwd: '/r', prompt: 'x', snapshots: 'yes' } }));
		expect(out[0]?.error?.message).toContain('snapshots');
	});

	test('editPath reads the tool path field', () => {
		expect(editPath('Edit', { file_path: 'src/a.ts' }, '/r')).toBe('/r/src/a.ts');
		expect(editPath('NotebookEdit', { notebook_path: '/r/n.ipynb' }, '/x')).toBe('/r/n.ipynb');
		expect(editPath('Read', { file_path: '/r/a' }, '/r')).toBeNull();
		expect(editPath('Write', { file_path: 3 }, '/r')).toBeNull();
	});
});
