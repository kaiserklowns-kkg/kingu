// The agent host: runs Claude Agent SDK sessions (one per run id) and speaks JSON-RPC.
//
// Each run is a streaming-input `query()`: the first prompt and every follow-up (`send`) go into
// one live session, so the conversation, tools and "allow always" grants carry over. A run ends
// on `stop` (or when the SDK fails); the app can continue it later with `start {resume}`.
// Permission prompts go out as `permission_request` events and wait for an `answer` request.
//
// Never write prompts, tool inputs or credentials to stderr: it ends up in the app log.

import { readFileSync } from 'node:fs';
import type { CanUseTool, Options, PermissionResult, PermissionUpdate, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { isUuid, normalize, summarizeTool } from './normalize.ts';
import { snapshotHooks } from './snapshots.ts';
import { checkAnswers, isAskUserQuestion, QUESTIONS_DISMISSED } from './questions.ts';
import {
	PERMISSION_MODES,
	type AgentEvent,
	type AnswerParams,
	type Decision,
	type PermissionMode,
	type SetOptionsParams,
	type RpcRequest,
	type RpcResponse,
	type SendParams,
	type StartParams
} from './protocol.ts';

/** The subset of the SDK's `Query` the host uses. */
export type QueryLike = AsyncIterable<unknown> & {
	interrupt(): Promise<unknown>;
	/** Mid-session changes (streaming input only); optional so older fakes still fit. */
	setModel?(model?: string): Promise<void>;
	setPermissionMode?(mode: PermissionMode): Promise<void>;
};
export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => QueryLike;

export const DEFAULT_MODEL = 'claude-opus-5-5';
const DENIED_BY_USER = 'ผู้ใช้ไม่อนุญาต (The user denied this action.)';
/** After `stop`, how long to wait for the SDK to wind down before reporting the exit anyway. */
export const STOP_GRACE_MS = 5000;

/** An image content block (base64), as the Messages API takes it. */
export type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string } };

const MEDIA_TYPES: Record<string, ImageBlock['source']['media_type']> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
/** Claude's limits as Orca applies them: 5 MB per image, 20 per message, 20 MB in all. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES = 20;
export const MAX_IMAGES_TOTAL = 20 * 1024 * 1024;

/** Reads attached image files into content blocks; throws on anything outside the limits. */
export function imageBlocks(paths: unknown, read: (path: string) => Uint8Array): ImageBlock[] {
	if (paths === undefined || paths === null) return [];
	if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string' && p.startsWith('/'))) throw new RpcError(INVALID_PARAMS, 'images must be absolute paths');
	if (paths.length > MAX_IMAGES) throw new RpcError(INVALID_PARAMS, `at most ${MAX_IMAGES} images per message`);
	let total = 0;
	return paths.map((path: string) => {
		const media = MEDIA_TYPES[path.split('.').pop()?.toLowerCase() ?? ''];
		if (!media) throw new RpcError(INVALID_PARAMS, `${path}: not a png, jpeg, gif or webp image`);
		const bytes = read(path);
		if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new RpcError(INVALID_PARAMS, `${path}: an image must be 1 byte to 5 MB`);
		total += bytes.length;
		if (total > MAX_IMAGES_TOTAL) throw new RpcError(INVALID_PARAMS, 'attached images exceed 20 MB');
		return { type: 'image', source: { type: 'base64', media_type: media, data: Buffer.from(bytes).toString('base64') } };
	});
}

/** The user message the timeline shows: the text, and which images went with it. */
export function shownText(text: string, images: readonly string[] | undefined): string {
	if (!images?.length) return text;
	return `${text}\n\n[แนบรูป: ${images.map((p) => p.split('/').pop()).join(', ')}]`;
}

/** Async queue feeding user messages into a streaming-input query. */
export class Inbox implements AsyncIterable<SDKUserMessage> {
	private items: SDKUserMessage[] = [];
	private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
	closed = false;

	/** Images go first, then the text (Orca's order: a slash command must still lead the text). */
	push(text: string, images: ImageBlock[] = []) {
		if (this.closed) throw new Error('run has ended');
		const content = images.length ? [...images, { type: 'text' as const, text }] : text;
		const msg: SDKUserMessage = { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
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
	/** Reads an attached image file (tests pass a fake). */
	readFile?: (path: string) => Uint8Array;
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
const UNSUPPORTED = 2;

function need<T>(cond: T, message: string): asserts cond {
	if (!cond) throw new RpcError(INVALID_PARAMS, message);
}

/** `base` with `set` over it and `unset` removed: one run's env for its AI account. */
export function runEnv(base: Record<string, string | undefined>, set: Record<string, string>, unset: string[]): Record<string, string | undefined> {
	const env = { ...base, ...set };
	for (const k of unset) delete env[k];
	return env;
}

export class AgentHost {
	private runs = new Map<number, Run>();
	private newId: () => string;
	private log: (line: string) => void;

	private read: (path: string) => Uint8Array;

	constructor(private deps: HostDeps) {
		this.read = deps.readFile ?? ((path) => readFileSync(path));
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
			case 'set_options':
				return this.setOptions(p as SetOptionsParams);
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

		const mcp = p.mcpServers ?? {};
		need(typeof mcp === 'object' && !Array.isArray(mcp), 'mcpServers must be an object');
		for (const [name, s] of Object.entries(mcp)) need(typeof s?.command === 'string' && s.command.trim(), `mcp server ${name}: command is empty`);
		const plugins = p.plugins ?? [];
		need(Array.isArray(plugins) && plugins.every((d) => typeof d === 'string' && d.startsWith('/')), 'plugins must be absolute paths');
		const extraEnv = p.env ?? {};
		const unset = p.unsetEnv ?? [];
		const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
		need(typeof extraEnv === 'object' && !Array.isArray(extraEnv) && Object.entries(extraEnv).every(([k, v]) => ENV_NAME.test(k) && typeof v === 'string'), 'env must map variable names to strings');
		need(Array.isArray(unset) && unset.every((k) => typeof k === 'string' && ENV_NAME.test(k)), 'unsetEnv must be variable names');
		const accountEnv = Object.keys(extraEnv).length || unset.length ? runEnv(this.deps.options?.env ?? process.env, extraEnv, unset) : null;
		const images = imageBlocks(p.images, this.read);
		need(p.snapshots === undefined || p.snapshots === null || typeof p.snapshots === 'boolean', 'snapshots must be a boolean');
		const resumeAt = p.resumeAt || undefined;
		need(resumeAt === undefined || (isUuid(resumeAt) && p.resume), 'resumeAt must be a message uuid, with resume');

		const run = new Run(p.runId);
		this.runs.set(run.id, run);
		const options: Options = {
			...this.deps.options,
			cwd: p.cwd,
			model: p.model || DEFAULT_MODEL,
			permissionMode: mode,
			resume: p.resume || undefined,
			// Rewind / fork: the session up to `resumeAt`, as a new session (the original stays whole).
			...(resumeAt ? { resumeSessionAt: resumeAt, forkSession: true } : {}),
			...(Object.keys(mcp).length
				? { mcpServers: Object.fromEntries(Object.entries(mcp).map(([name, s]) => [name, { type: 'stdio' as const, command: s.command, args: s.args ?? [], env: s.env ?? {} }])) }
				: {}),
			// Skills only: Kingu owns the MCP connections (mcpServers above), so a plugin never adds its own.
			...(plugins.length ? { plugins: plugins.map((path) => ({ type: 'local' as const, path, skipMcpDiscovery: true })) } : {}),
			...(accountEnv ? { env: accountEnv } : {}),
			includePartialMessages: true,
			// Subagents' text and thinking too (not only their tool calls): the chat nests them under the Task call.
			forwardSubagentText: true,
			// User + project settings: CLAUDE.md and the user's own allow/deny rules apply.
			settingSources: ['user', 'project', 'local'],
			abortController: run.abort,
			canUseTool: this.canUseTool(run),
			// Before an edit tool runs (in every permission mode): the file's prior content.
			...(p.snapshots ? { hooks: snapshotHooks(p.cwd, (ev) => this.emit(run.id, ev), (line) => this.log(`run ${run.id}: ${line}`)) } : {}),
			stderr: (data) => {
				for (const line of data.split('\n')) if (line.trim()) this.emit(run.id, { kind: 'stderr', line });
			}
		};
		run.inbox.push(p.prompt, images);
		this.emit(run.id, { kind: 'message', role: 'user', text: shownText(p.prompt, p.images) });
		this.log(`run ${run.id} starting (mode ${mode}${p.resume ? (resumeAt ? ', resuming at a message' : ', resuming') : ''})`);
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
		run.inbox.push(p.text, imageBlocks(p.images, this.read));
		this.emit(run.id, { kind: 'message', role: 'user', text: shownText(p.text, p.images) });
		return null;
	}

	/**
	 * Changes the live session's model and/or permission mode (the SDK's `setModel` /
	 * `setPermissionMode`); they apply from the next response on. Returns what was applied.
	 */
	async setOptions(p: SetOptionsParams) {
		const run = this.run(p.runId);
		const model = p.model ?? undefined;
		const mode = p.permissionMode ?? undefined;
		need(model === undefined || (typeof model === 'string' && model.trim() && model.length <= 200), 'model must be a non-empty string');
		need(mode === undefined || PERMISSION_MODES.includes(mode), `unsupported permission mode ${String(mode)}`);
		need(model !== undefined || mode !== undefined, 'nothing to change');
		const q = run.query;
		need(q && !run.exited, 'run has ended');
		if (model !== undefined) {
			if (!q.setModel) throw new RpcError(UNSUPPORTED, 'this agent SDK cannot change the model mid-session');
			await q.setModel(model);
		}
		if (mode !== undefined) {
			if (!q.setPermissionMode) throw new RpcError(UNSUPPORTED, 'this agent SDK cannot change the permission mode mid-session');
			await q.setPermissionMode(mode);
		}
		this.log(`run ${run.id}: options changed${model !== undefined ? ' (model)' : ''}${mode !== undefined ? ` (mode ${mode})` : ''}`);
		return { model: model ?? null, permissionMode: mode ?? null };
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
		// Checked before the request is taken: bad answers leave the question waiting.
		let result: PermissionResult;
		try {
			result = decisionResult(decision, pending, p.message, p.answers);
		} catch (e) {
			throw new RpcError(INVALID_PARAMS, e instanceof Error ? e.message : String(e));
		}
		run.pending.delete(p.requestId);
		pending.resolve(result);
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
					// Answering a question is never a rule to keep.
					can_always: !opts.suppressAlwaysAllowRule && !isAskUserQuestion(tool)
				});
			});
	}
}

/**
 * The SDK result for the user's answer; "always" grants are scoped to this session only.
 * AskUserQuestion is answered, not allowed: its answers go back in `updatedInput.answers`
 * (questions.ts), and allowing it without them throws.
 */
export function decisionResult(
	decision: Decision,
	p: Pick<Pending, 'input' | 'suggestions' | 'tool'>,
	message?: string | null,
	answers?: Record<string, string> | null
): PermissionResult {
	const question = isAskUserQuestion(p.tool);
	if (decision === 'deny') return { behavior: 'deny', message: message?.trim() || (question ? QUESTIONS_DISMISSED : DENIED_BY_USER) };
	if (question) return { behavior: 'allow', updatedInput: { ...p.input, answers: checkAnswers(p.input, answers) } };
	if (answers != null) throw new Error(`${p.tool} takes no answers`);
	if (decision === 'allow') return { behavior: 'allow', updatedInput: p.input };
	const fromSuggestions = p.suggestions.map((s) => ({ ...s, destination: 'session' as const }));
	const updatedPermissions: PermissionUpdate[] = fromSuggestions.length
		? fromSuggestions
		: [{ type: 'addRules', rules: [{ toolName: p.tool }], behavior: 'allow', destination: 'session' }];
	return { behavior: 'allow', updatedInput: p.input, updatedPermissions };
}
