// The agent host: runs Claude Agent SDK sessions (one per run id) and speaks JSON-RPC.
//
// Each run is a streaming-input `query()`: the first prompt and every follow-up (`send`) go into
// one live session, so the conversation, tools and "allow always" grants carry over. A run ends
// on `stop` (or when the SDK fails); the app can continue it later with `start {resume}`.
// Permission prompts go out as `permission_request` events and wait for an `answer` request.
//
// Never write prompts, tool inputs or credentials to stderr: it ends up in the app log.

import type { CanUseTool, Options, PermissionResult, PermissionUpdate, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { normalize, summarizeTool } from './normalize.ts';
import {
	PERMISSION_MODES,
	type AgentEvent,
	type AnswerParams,
	type Decision,
	type RpcRequest,
	type RpcResponse,
	type SendParams,
	type StartParams
} from './protocol.ts';

/** The subset of the SDK's `Query` the host uses. */
export type QueryLike = AsyncIterable<unknown> & { interrupt(): Promise<unknown> };
export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => QueryLike;

export const DEFAULT_MODEL = 'claude-opus-5-5';
const DENIED_BY_USER = 'ผู้ใช้ไม่อนุญาต (The user denied this action.)';
/** After `stop`, how long to wait for the SDK to wind down before reporting the exit anyway. */
export const STOP_GRACE_MS = 5000;

/** Async queue feeding user messages into a streaming-input query. */
export class Inbox implements AsyncIterable<SDKUserMessage> {
	private items: SDKUserMessage[] = [];
	private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
	closed = false;

	push(text: string) {
		if (this.closed) throw new Error('run has ended');
		const msg: SDKUserMessage = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
		if (this.waiter) {
			const w = this.waiter;
			this.waiter = null;
			w({ value: msg, done: false });
		} else this.items.push(msg);
	}

	close() {
		this.closed = true;
		this.waiter?.({ value: undefined, done: true });
		this.waiter = null;
	}

	[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
		return {
			next: () => {
				const item = this.items.shift();
				if (item) return Promise.resolve({ value: item, done: false });
				if (this.closed) return Promise.resolve({ value: undefined, done: true });
				return new Promise((resolve) => (this.waiter = resolve));
			},
			return: () => {
				this.close();
				return Promise.resolve({ value: undefined, done: true });
			}
		};
	}
}

type Pending = { resolve: (r: PermissionResult) => void; input: Record<string, unknown>; suggestions: PermissionUpdate[]; tool: string };

class Run {
	readonly inbox = new Inbox();
	readonly abort = new AbortController();
	readonly pending = new Map<string, Pending>();
	query: QueryLike | null = null;
	stopped = false;
	exited = false;
	constructor(readonly id: number) {}
}

export type HostDeps = {
	query: QueryFn;
	/** Writes one protocol message (the caller adds the newline). */
	write: (msg: RpcResponse | { jsonrpc: '2.0'; method: string; params: unknown }) => void;
	/** Extra SDK options (e.g. `pathToClaudeCodeExecutable`, `env`). */
	options?: Partial<Options>;
	newId?: () => string;
	log?: (line: string) => void;
};

class RpcError extends Error {
	constructor(
		readonly code: number,
		message: string
	) {
		super(message);
	}
}
const INVALID_PARAMS = -32602;
const METHOD_NOT_FOUND = -32601;
const RUN_NOT_FOUND = 1;

function need<T>(cond: T, message: string): asserts cond {
	if (!cond) throw new RpcError(INVALID_PARAMS, message);
}

export class AgentHost {
	private runs = new Map<number, Run>();
	private newId: () => string;
	private log: (line: string) => void;

	constructor(private deps: HostDeps) {
		this.newId = deps.newId ?? (() => crypto.randomUUID());
		this.log = deps.log ?? (() => {});
	}

	emit(runId: number, event: AgentEvent) {
		this.deps.write({ jsonrpc: '2.0', method: 'event', params: { runId, event } });
	}

	/** Handles one input line; malformed lines get a JSON-RPC parse error. */
	async handleLine(line: string): Promise<void> {
		if (!line.trim()) return;
		let req: RpcRequest;
		try {
			req = JSON.parse(line);
		} catch {
			this.deps.write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
			return;
		}
		try {
			const result = await this.dispatch(req.method, req.params);
			this.deps.write({ jsonrpc: '2.0', id: req.id, result: result ?? null });
		} catch (e) {
			const code = e instanceof RpcError ? e.code : -32000;
			this.deps.write({ jsonrpc: '2.0', id: req.id, error: { code, message: e instanceof Error ? e.message : String(e) } });
		}
	}

	async dispatch(method: string, params: unknown): Promise<unknown> {
		const p = (params ?? {}) as Record<string, unknown>;
		switch (method) {
			case 'start':
				return this.start(p as StartParams);
			case 'send':
				return this.send(p as SendParams);
			case 'interrupt':
				return this.interrupt(this.run(p.runId));
			case 'stop':
				return this.stop(this.run(p.runId));
			case 'answer':
				return this.answer(p as AnswerParams);
			case 'shutdown':
				await Promise.all([...this.runs.values()].map((r) => this.stop(r)));
				return null;
			default:
				throw new RpcError(METHOD_NOT_FOUND, `unknown method ${method}`);
		}
	}

	get runCount() {
		return this.runs.size;
	}

	private run(id: unknown): Run {
		const run = typeof id === 'number' ? this.runs.get(id) : undefined;
		if (!run) throw new RpcError(RUN_NOT_FOUND, `no such run ${String(id)}`);
		return run;
	}

	start(p: StartParams) {
		need(Number.isInteger(p.runId), 'runId must be an integer');
		need(!this.runs.has(p.runId), `run ${p.runId} already exists`);
		need(typeof p.cwd === 'string' && p.cwd.startsWith('/'), 'cwd must be an absolute path');
		need(typeof p.prompt === 'string' && p.prompt.trim(), 'prompt is empty');
		const mode = p.permissionMode ?? 'default';
		need(PERMISSION_MODES.includes(mode), `unsupported permission mode ${mode}`);

		const run = new Run(p.runId);
		this.runs.set(run.id, run);
		const options: Options = {
			...this.deps.options,
			cwd: p.cwd,
			model: p.model || DEFAULT_MODEL,
			permissionMode: mode,
			resume: p.resume || undefined,
			includePartialMessages: true,
			// User + project settings: CLAUDE.md and the user's own allow/deny rules apply.
			settingSources: ['user', 'project', 'local'],
			abortController: run.abort,
			canUseTool: this.canUseTool(run),
			stderr: (data) => {
				for (const line of data.split('\n')) if (line.trim()) this.emit(run.id, { kind: 'stderr', line });
			}
		};
		run.inbox.push(p.prompt);
		this.emit(run.id, { kind: 'message', role: 'user', text: p.prompt });
		this.log(`run ${run.id} starting (mode ${mode}${p.resume ? ', resuming' : ''})`);
		try {
			run.query = this.deps.query({ prompt: run.inbox, options });
		} catch (e) {
			this.runs.delete(run.id);
			throw e;
		}
		void this.pump(run);
		return { runId: run.id };
	}

	private async pump(run: Run) {
		let failure: string | null = null;
		try {
			for await (const msg of run.query!) {
				if (run.exited) break;
				for (const ev of normalize(msg)) this.emit(run.id, ev);
			}
		} catch (e) {
			if (!run.stopped) failure = e instanceof Error ? e.message : String(e);
		}
		if (failure) this.emit(run.id, { kind: 'error', message: failure });
		this.finish(run, failure ? 1 : 0);
	}

	/** Emits the run's single `exit` and forgets it. */
	private finish(run: Run, code: number) {
		if (run.exited) return;
		run.exited = true;
		this.cancelPending(run);
		run.inbox.close();
		this.runs.delete(run.id);
		this.log(`run ${run.id} exited${run.stopped ? ' (stopped)' : ''}`);
		this.emit(run.id, { kind: 'exit', code: run.stopped ? null : code, signal: null, stopped: run.stopped });
	}

	private cancelPending(run: Run, message = 'cancelled') {
		for (const [requestId, p] of run.pending) {
			p.resolve({ behavior: 'deny', message, interrupt: true });
			this.emit(run.id, { kind: 'permission_resolved', request_id: requestId, decision: 'cancelled' });
		}
		run.pending.clear();
	}

	send(p: SendParams) {
		const run = this.run(p.runId);
		need(typeof p.text === 'string' && p.text.trim(), 'message is empty');
		run.inbox.push(p.text);
		this.emit(run.id, { kind: 'message', role: 'user', text: p.text });
		return null;
	}

	async interrupt(run: Run) {
		this.cancelPending(run, 'interrupted');
		await run.query?.interrupt();
		return null;
	}

	async stop(run: Run) {
		if (run.exited) return null;
		run.stopped = true;
		this.cancelPending(run, 'stopped');
		run.inbox.close();
		run.abort.abort();
		// The pump normally ends right away; don't let a wedged SDK keep the run alive.
		setTimeout(() => this.finish(run, 0), STOP_GRACE_MS).unref?.();
		return null;
	}

	answer(p: AnswerParams) {
		const run = this.run(p.runId);
		const pending = run.pending.get(p.requestId);
		if (!pending) throw new RpcError(RUN_NOT_FOUND, `no pending permission request ${p.requestId}`);
		const decision: Decision = p.decision;
		need(['allow', 'allow_always', 'deny'].includes(decision), `bad decision ${decision}`);
		run.pending.delete(p.requestId);
		pending.resolve(decisionResult(decision, pending, p.message));
		this.emit(run.id, { kind: 'permission_resolved', request_id: p.requestId, decision });
		this.log(`run ${run.id}: ${pending.tool} ${decision}`);
		return null;
	}

	private canUseTool(run: Run): CanUseTool {
		return (tool, input, opts) =>
			new Promise<PermissionResult>((resolve) => {
				if (run.exited || run.stopped) return resolve({ behavior: 'deny', message: 'stopped', interrupt: true });
				const requestId = this.newId();
				run.pending.set(requestId, { resolve, input, suggestions: opts.suggestions ?? [], tool });
				opts.signal?.addEventListener('abort', () => {
					if (!run.pending.delete(requestId)) return;
					resolve({ behavior: 'deny', message: 'cancelled', interrupt: true });
					this.emit(run.id, { kind: 'permission_resolved', request_id: requestId, decision: 'cancelled' });
				});
				const { summary, detail, diff } = summarizeTool(tool, input);
				this.emit(run.id, {
					kind: 'permission_request',
					request_id: requestId,
					tool,
					tool_use_id: opts.toolUseID ?? null,
					title: opts.title ?? null,
					input_summary: summary,
					detail: detail ?? opts.decisionReason ?? null,
					diff,
					input,
					can_always: !opts.suppressAlwaysAllowRule
				});
			});
	}
}

/** The SDK result for the user's answer; "always" grants are scoped to this session only. */
export function decisionResult(decision: Decision, p: Pick<Pending, 'input' | 'suggestions' | 'tool'>, message?: string | null): PermissionResult {
	if (decision === 'deny') return { behavior: 'deny', message: message?.trim() || DENIED_BY_USER };
	if (decision === 'allow') return { behavior: 'allow', updatedInput: p.input };
	const fromSuggestions = p.suggestions.map((s) => ({ ...s, destination: 'session' as const }));
	const updatedPermissions: PermissionUpdate[] = fromSuggestions.length
		? fromSuggestions
		: [{ type: 'addRules', rules: [{ toolName: p.tool }], behavior: 'allow', destination: 'session' }];
	return { behavior: 'allow', updatedInput: p.input, updatedPermissions };
}
