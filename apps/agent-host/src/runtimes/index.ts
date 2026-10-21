// The agents a run can be besides the Claude Agent SDK (which host.ts runs itself, the `claude`
// runtime): ACP agents (acp.ts) and Codex's app server (codex.ts), each a child process, and
// Arkai (../arkai/), Kingu's own agent loop on a model the user brings, run in this process. Their
// runs take the same requests as the SDK's (send, interrupt, stop, answer, set_options) and emit
// the same events, so the chat (tool rows, approvals, edit snapshots, working set) is unchanged.
// What one cannot do (rewind, a model switch) the app hides for it (Rust agent/runtimes.rs).

import { AcpSession } from './acp.ts';
import { CodexSession } from './codex.ts';
import { ArkaiSession } from '../arkai/session.ts';
import { arkaiSpec, type ArkaiSpec } from '../arkai/spec.ts';
import { RUN_NOT_FOUND, RunSession, SessionError, type SessionInit, type SpawnFn } from './session.ts';
import type { AgentEvent, RuntimeSpec } from '../protocol.ts';

export { SessionError, UNSUPPORTED } from './session.ts';
export type { SpawnFn } from './session.ts';

const MAX_ARGS = 64;
const MAX_ARG = 4096;

export type CheckedRuntime = { kind: 'acp' | 'codex'; command: string; args: string[] } | { kind: 'arkai'; arkai: ArkaiSpec };

/** The checked spec of a non-Claude runtime; null for the Claude Agent SDK. Throws a message on a bad one. */
export function runtimeSpec(v: unknown): CheckedRuntime | null {
	if (v === undefined || v === null) return null;
	if (typeof v !== 'object' || Array.isArray(v)) throw new Error('runtime must be an object');
	const r = v as RuntimeSpec;
	if (r.kind === 'claude') return null;
	if (r.kind === 'arkai') return { kind: 'arkai', arkai: arkaiSpec(v) };
	if (r.kind !== 'acp' && r.kind !== 'codex') throw new Error(`unknown runtime ${String((r as { kind?: unknown }).kind)}`);
	if (typeof r.command !== 'string' || !r.command.startsWith('/') || r.command.includes('\0')) throw new Error('runtime command must be an absolute path');
	const args = r.args ?? [];
	if (!Array.isArray(args) || args.length > MAX_ARGS || !args.every((a) => typeof a === 'string' && a.length <= MAX_ARG && !a.includes('\0'))) throw new Error('runtime args must be strings');
	return { kind: r.kind, command: r.command, args };
}

export type RuntimesDeps = {
	emit: (runId: number, ev: AgentEvent) => void;
	log: (line: string) => void;
	newId: () => string;
	spawn?: SpawnFn;
	/** Arkai's HTTP requests (tests pass a fake). */
	fetch?: typeof fetch;
};

export class Runtimes {
	private runs = new Map<number, RunSession>();

	constructor(private deps: RuntimesDeps) {}

	has(id: unknown): boolean {
		return typeof id === 'number' && this.runs.has(id);
	}

	get size() {
		return this.runs.size;
	}

	get(id: unknown): RunSession {
		const run = typeof id === 'number' ? this.runs.get(id) : undefined;
		if (!run) throw new SessionError(RUN_NOT_FOUND, `no such run ${String(id)}`);
		return run;
	}

	start(kind: 'acp' | 'codex' | 'arkai', init: Omit<SessionInit, 'emit' | 'log' | 'newId' | 'spawn' | 'onExit'>) {
		const full: SessionInit = {
			...init,
			emit: (ev) => this.deps.emit(init.runId, ev),
			log: this.deps.log,
			newId: this.deps.newId,
			spawn: this.deps.spawn,
			onExit: () => this.runs.delete(init.runId)
		};
		const run = kind === 'acp' ? new AcpSession(full) : kind === 'codex' ? new CodexSession(full) : new ArkaiSession(full, this.deps.fetch);
		this.runs.set(init.runId, run);
		this.deps.log(`run ${init.runId} starting (${kind}, mode ${init.mode}${init.resume ? ', resuming' : ''})`);
		try {
			run.start();
		} catch (e) {
			this.runs.delete(init.runId);
			throw e;
		}
	}

	async shutdown() {
		await Promise.all([...this.runs.values()].map((r) => r.stop()));
	}
}
