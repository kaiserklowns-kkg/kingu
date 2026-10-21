// The agent host: runs Claude Agent SDK sessions (one per run id) and speaks JSON-RPC.
//
// Each run is a streaming-input `query()`: the first prompt and every follow-up (`send`) go into
// one live session, so the conversation, tools and "allow always" grants carry over. A run ends
// on `stop` (or when the SDK fails); the app can continue it later with `start {resume}`.
// Permission prompts go out as `permission_request` events and wait for an `answer` request.
//
// Never write prompts, tool inputs or credentials to stderr: it ends up in the app log.

import { readFileSync } from 'node:fs';
import type { CanUseTool, HookCallbackMatcher, Options, PermissionResult, PermissionUpdate, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { contextTokensOf, contextWindowOf, isUuid, mcpStatus, modelOptions, normalize, ruleTexts, slashCommands, summarizeTool } from './normalize.ts';
import { snapshotHooks } from './snapshots.ts';
import { Guards, type AskUser } from './guards/index.ts';
import { MAX_PATTERNS } from './guards/asks.ts';
import { checkAnswers, isAskUserQuestion, QUESTIONS_DISMISSED } from './questions.ts';
import { Runtimes, runtimeSpec, SessionError, type SpawnFn } from './runtimes/index.ts';
import { ARTIFACT_SERVER, ARTIFACT_TOOL, artifactServer, socketCaller, type CallApp } from './artifacts.ts';
import { readSkills, skillIndex } from './skills.ts';
import {
	DECISIONS,
	MCP_TYPES,
	PERMISSION_MODES,
	type AgentEvent,
	type AnswerParams,
	type Decision,
	type McpServerParams,
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
	/** The session's slash commands with descriptions (for the composer's `/` list). */
	supportedCommands?(): Promise<unknown[]>;
	/** The models the session can use (for the chat's model picker). */
	supportedModels?(): Promise<unknown[]>;
	/** How full the context window is (`detail: 'summary'` answers from the last response). */
	getContextUsage?(opts?: { detail?: 'summary' | 'full' }): Promise<{ totalTokens?: unknown; maxTokens?: unknown }>;
	/** The session's MCP servers, their status and tools (the MCP Servers view). */
	mcpServerStatus?(): Promise<unknown[]>;
};
export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => QueryLike;

export const DEFAULT_MODEL = 'claude-opus-5-5';
const DENIED_BY_USER = 'ผู้ใช้ไม่อนุญาต (The user denied this action.)';
/** After `stop`, how long to wait for the SDK to wind down before reporting the exit anyway. */
export const STOP_GRACE_MS = 5000;
/** How long a side request to the SDK (commands, context usage) may take before it is skipped. */
export const CONTROL_TIMEOUT_MS = 5000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('timed out')), ms);
		(timer as { unref?: () => void }).unref?.();
		p.then(
			(v) => (clearTimeout(timer), resolve(v)),
			(e) => (clearTimeout(timer), reject(e))
		);
	});
}

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

/** After the start, MCP servers are asked again this much later (they connect in the background). */
export const MCP_RECHECK_MS = 5000;

/** A server name as Claude Code puts it in tool names (`mcp__<name>__<tool>`). */
const MCP_NAME = /^[A-Za-z0-9_-]{1,81}$/;

/** Checks one `mcpServers` entry and turns it into the SDK's config (stdio, or http / sse). */
export function mcpConfig(name: string, s: McpServerParams): NonNullable<Options['mcpServers']>[string] {
	need(MCP_NAME.test(name), `mcp server ${name}: invalid name`);
	need(typeof s === 'object' && s !== null, `mcp server ${name}: not an object`);
	const type = s.type ?? 'stdio';
	need((MCP_TYPES as readonly string[]).includes(type), `mcp server ${name}: unsupported type ${String(type)}`);
	if (type === 'stdio') {
		need(typeof s.command === 'string' && s.command.trim(), `mcp server ${name}: command is empty`);
		return { type: 'stdio', command: s.command!, args: s.args ?? [], env: s.env ?? {} };
	}
	need(typeof s.url === 'string' && /^https?:\/\/[^\s]+$/.test(s.url), `mcp server ${name}: url must be http(s)`);
	const headers = s.headers ?? {};
	need(typeof headers === 'object' && !Array.isArray(headers) && Object.values(headers).every((v) => typeof v === 'string'), `mcp server ${name}: headers must map names to strings`);
	return { type: type as 'http' | 'sse', url: s.url!, ...(Object.keys(headers).length ? { headers } : {}) };
}

const isNames = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 200);

/** Rules appended to the system prompt; Rust keeps them under 128 KB. */
export const MAX_SYSTEM_APPEND = 256 * 1024;

/** The run's PreToolUse hooks: the safety checks first (a deny wins), then the snapshots. */
export function runHooks(guard: HookCallbackMatcher | null, snapshots: Partial<Record<'PreToolUse', HookCallbackMatcher[]>> | null): Options['hooks'] | null {
	const pre = [...(guard ? [guard] : []), ...(snapshots?.PreToolUse ?? [])];
	return pre.length ? { PreToolUse: pre } : null;
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
	/** Kingu's safety checks; null when the user turned them all off. */
	guards: Guards | null = null;
	/** Tool calls the user allowed at a safety ask: canUseTool does not ask about them again. */
	readonly guardApproved = new Set<string>();
	/** The session's permission mode (start, then setOptions). */
	mode = 'default';
	query: QueryLike | null = null;
	stopped = false;
	exited = false;
	/** The session's commands were asked for (once per run, after its first init). */
	commandsAsked = false;
	/** An `mcp_status` was sent (so an empty list after it is sent too). */
	mcpReported = false;
	/** Context tokens of the main agent's latest API call (`contextTokensOf`). */
	contextTokens: number | null = null;
	/** Kingu's artifact tool is this run's (its `kingu` MCP server was added). */
	artifacts = false;
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
	/** Starts another runtime's agent process (runtimes/; tests may pass their own). */
	spawn?: SpawnFn;
	/** Calls the app for the artifact tool (artifacts.ts); default: its socket from `KINGU_CLI_RUNTIME`. */
	callApp?: CallApp;
	/** Arkai's HTTP requests to the user's model provider (tests pass a fake). */
	fetch?: typeof fetch;
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
	/** Runs of the other runtimes (ACP agents, Codex): same requests, same events. */
	private others: Runtimes;

	constructor(private deps: HostDeps) {
		this.read = deps.readFile ?? ((path) => readFileSync(path));
		this.newId = deps.newId ?? (() => crypto.randomUUID());
		this.log = deps.log ?? (() => {});
		this.others = new Runtimes({ emit: (id, ev) => this.emit(id, ev), log: (line) => this.log(line), newId: () => this.newId(), spawn: deps.spawn, fetch: deps.fetch });
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
			const code = e instanceof RpcError || e instanceof SessionError ? e.code : -32000;
			this.deps.write({ jsonrpc: '2.0', id: req.id, error: { code, message: e instanceof Error ? e.message : String(e) } });
		}
	}

	async dispatch(method: string, params: unknown): Promise<unknown> {
		const p = (params ?? {}) as Record<string, unknown>;
		if (this.others.has(p.runId)) return this.dispatchOther(method, p);
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
				await this.others.shutdown();
				return null;
			default:
				throw new RpcError(METHOD_NOT_FOUND, `unknown method ${method}`);
		}
	}

	/** A request for a run of another runtime (runtimes/). */
	private async dispatchOther(method: string, p: Record<string, unknown>): Promise<unknown> {
		const run = this.others.get(p.runId);
		switch (method) {
			case 'send': {
				const s = p as SendParams;
				need(typeof s.text === 'string' && s.text.trim(), 'message is empty');
				return run.send(s.text, imageBlocks(s.images, this.read), s.images ?? [], shownText(s.text, s.images));
			}
			case 'interrupt':
				return run.interrupt();
			case 'stop':
				return run.stop();
			case 'answer':
				return run.answer(p as AnswerParams);
			case 'set_options': {
				const o = p as SetOptionsParams;
				const model = o.model ?? undefined;
				const mode = o.permissionMode ?? undefined;
				need(mode === undefined || PERMISSION_MODES.includes(mode), `unsupported permission mode ${String(mode)}`);
				need(model === undefined || (typeof model === 'string' && model.trim() && model.length <= 300), 'model must be a non-empty string');
				need(model !== undefined || mode !== undefined, 'nothing to change');
				return run.setOptions(model, mode, o.provider);
			}
			case 'start':
				throw new RpcError(INVALID_PARAMS, `run ${String(p.runId)} already exists`);
			default:
				throw new RpcError(METHOD_NOT_FOUND, `unknown method ${method}`);
		}
	}

	get runCount() {
		return this.runs.size + this.others.size;
	}

	private run(id: unknown): Run {
		const run = typeof id === 'number' ? this.runs.get(id) : undefined;
		if (!run) throw new RpcError(RUN_NOT_FOUND, `no such run ${String(id)}`);
		return run;
	}

	start(p: StartParams) {
		need(Number.isInteger(p.runId), 'runId must be an integer');
		need(!this.runs.has(p.runId) && !this.others.has(p.runId), `run ${p.runId} already exists`);
		need(typeof p.cwd === 'string' && p.cwd.startsWith('/'), 'cwd must be an absolute path');
		need(typeof p.prompt === 'string' && p.prompt.trim(), 'prompt is empty');
		const mode = p.permissionMode ?? 'default';
		need(PERMISSION_MODES.includes(mode), `unsupported permission mode ${mode}`);

		const mcp = p.mcpServers ?? {};
		need(typeof mcp === 'object' && !Array.isArray(mcp), 'mcpServers must be an object');
		const mcpServers = Object.fromEntries(Object.entries(mcp).map(([name, s]) => [name, mcpConfig(name, s)]));
		const projectMcp = p.projectMcp ?? null;
		need(projectMcp === null || (typeof projectMcp === 'object' && isNames(projectMcp.enabled ?? []) && isNames(projectMcp.disabled ?? [])), 'projectMcp must list server names');
		const disallowed = p.disallowedTools ?? [];
		need(isNames(disallowed), 'disallowedTools must be tool names');
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
		need(p.safetyChecks === undefined || p.safetyChecks === null || typeof p.safetyChecks === 'boolean', 'safetyChecks must be a boolean');
		const asks = p.guardAsks ?? null;
		need(
			asks === null ||
				(typeof asks === 'object' &&
					!Array.isArray(asks) &&
					[asks.outsideCwd, asks.deletes, asks.mcpTools].every((v) => v === undefined || typeof v === 'boolean') &&
					(asks.protectedPaths === undefined || (Array.isArray(asks.protectedPaths) && asks.protectedPaths.length <= MAX_PATTERNS && asks.protectedPaths.every((x) => typeof x === 'string' && x.length <= 500)))),
			'guardAsks must be flags and up to 500 path patterns'
		);
		const append = p.systemPromptAppend ?? '';
		need(typeof append === 'string' && append.length <= MAX_SYSTEM_APPEND, 'systemPromptAppend must be a string of at most 256 KB');
		const resumeAt = p.resumeAt || undefined;
		need(resumeAt === undefined || (isUuid(resumeAt) && p.resume), 'resumeAt must be a message uuid, with resume');
		let other: ReturnType<typeof runtimeSpec>;
		try {
			other = runtimeSpec(p.runtime);
		} catch (e) {
			throw new RpcError(INVALID_PARAMS, e instanceof Error ? e.message : String(e));
		}
		if (other) {
			// Another runtime: no rewinding into a session (only the SDK can), no Claude plugins: the
			// plugins' skills go in as an index the agent reads them from (skills.ts).
			// Arkai reads the project rules and asks Kingu's always-ask checks itself.
			need(resumeAt === undefined, 'this runtime cannot resume at a message');
			const arkai = other.kind === 'arkai' ? other.arkai : undefined;
			const index = skillIndex(readSkills(plugins));
			this.others.start(other.kind, {
				runId: p.runId,
				cwd: p.cwd,
				command: other.kind === 'arkai' ? '' : other.command,
				args: other.kind === 'arkai' ? [] : other.args,
				...(arkai ? { arkai, systemPromptAppend: [append.trim(), index].filter(Boolean).join('\n\n'), guardAsks: asks ? { ...asks, cwd: p.cwd } : null } : { skillIndex: index }),
				prompt: p.prompt,
				shownPrompt: shownText(p.prompt, p.images),
				images,
				imagePaths: p.images ?? [],
				mode,
				resume: p.resume || null,
				mcpServers: mcp,
				disallowedTools: disallowed,
				env: runEnv(this.deps.options?.env ?? process.env, extraEnv, unset),
				snapshots: p.snapshots === true,
				safetyChecks: p.safetyChecks !== false
			});
			return { runId: p.runId };
		}

		const run = new Run(p.runId);
		run.mode = mode;
		// Kingu's artifact tool (artifacts.ts), over the app's `kingu` socket; not when a server of the run is named `kingu`.
		const cliRuntime = extraEnv.KINGU_CLI_RUNTIME || (this.deps.options?.env ?? process.env).KINGU_CLI_RUNTIME;
		const call = this.deps.callApp ?? (cliRuntime ? socketCaller(cliRuntime) : null);
		if (call && !(ARTIFACT_SERVER in mcpServers)) {
			mcpServers[ARTIFACT_SERVER] = artifactServer({ cwd: p.cwd, call, emit: (ev) => this.emit(run.id, ev) });
			run.artifacts = true;
		}
		if (p.safetyChecks !== false || asks) run.guards = new Guards(p.safetyChecks !== false, asks ? { ...asks, cwd: p.cwd, trustedTools: run.artifacts ? [ARTIFACT_TOOL] : [] } : null);
		this.runs.set(run.id, run);
		const hooks = runHooks(
			run.guards?.hook((ev) => this.emit(run.id, ev), (line) => this.log(`run ${run.id}: ${line}`), this.askGuard(run)) ?? null,
			p.snapshots ? snapshotHooks(p.cwd, (ev) => this.emit(run.id, ev), (line) => this.log(`run ${run.id}: ${line}`)) : null
		);
		const options: Options = {
			...this.deps.options,
			cwd: p.cwd,
			model: p.model || DEFAULT_MODEL,
			permissionMode: mode,
			// Lets the user switch a live session to "Allow all" (`setPermissionMode`); the mode
			// itself only ever comes from the user's pick, which the app confirms first.
			allowDangerouslySkipPermissions: true,
			resume: p.resume || undefined,
			// Rewind / fork: the session up to `resumeAt`, as a new session (the original stays whole).
			...(resumeAt ? { resumeSessionAt: resumeAt, forkSession: true } : {}),
			...(Object.keys(mcpServers).length ? { mcpServers } : {}),
			// The project's .mcp.json (Claude Code reads it itself): only what Kingu trusts runs; a
			// rejected name wins over any approval in the user's Claude settings.
			...(projectMcp && (projectMcp.enabled?.length || projectMcp.disabled?.length)
				? { settings: { enabledMcpjsonServers: projectMcp.enabled ?? [], disabledMcpjsonServers: projectMcp.disabled ?? [] } }
				: {}),
			// MCP servers the user turned off (also ones from their own Claude settings).
			...(disallowed.length ? { disallowedTools: disallowed } : {}),
			// Skills only: Kingu owns the MCP connections (mcpServers above), so a plugin never adds its own.
			...(plugins.length ? { plugins: plugins.map((path) => ({ type: 'local' as const, path, skipMcpDiscovery: true })) } : {}),
			...(accountEnv ? { env: accountEnv } : {}),
			includePartialMessages: true,
			// Hook outcomes (hook_response) for the chat's Agent Debug Log.
			includeHookEvents: true,
			// Subagents' text and thinking too (not only their tool calls): the chat nests them under the Task call.
			forwardSubagentText: true,
			// User + project settings: CLAUDE.md and the user's own allow/deny rules apply.
			settingSources: ['user', 'project', 'local'],
			// Rules files the SDK does not read itself (AGENTS.md, .cursor/rules, …), after Claude Code's own prompt.
			...(append.trim() ? { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append } } : {}),
			abortController: run.abort,
			canUseTool: this.canUseTool(run),
			// Before a tool runs (in every permission mode): the safety checks, then an edited file's prior content.
			...(hooks ? { hooks } : {}),
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
				const m = msg as Record<string, unknown> | null;
				const tokens = m && typeof m === 'object' ? contextTokensOf(m) : null;
				if (tokens !== null) run.contextTokens = tokens;
				for (const ev of normalize(msg)) this.emit(run.id, ev);
				if (m?.type === 'system' && m.subtype === 'init' && !run.commandsAsked) {
					void this.listCommands(run);
					void this.reportMcp(run);
					setTimeout(() => void this.reportMcp(run), MCP_RECHECK_MS).unref?.();
				}
				if (m?.type === 'result') {
					void this.reportContext(run, contextWindowOf(m));
					void this.reportMcp(run);
				}
			}
		} catch (e) {
			if (!run.stopped) failure = e instanceof Error ? e.message : String(e);
		}
		if (failure) this.emit(run.id, { kind: 'error', message: failure });
		this.finish(run, failure ? 1 : 0);
	}

	/**
	 * The session's slash commands, with descriptions, as a `commands` event, and its models as a
	 * `models` event (each skipped on failure).
	 */
	private async listCommands(run: Run) {
		run.commandsAsked = true;
		const q = run.query;
		if (q?.supportedCommands) {
			try {
				const list = await withTimeout(q.supportedCommands(), CONTROL_TIMEOUT_MS);
				if (!run.exited) this.emit(run.id, { kind: 'commands', commands: slashCommands(list) });
			} catch (e) {
				this.log(`run ${run.id}: commands not listed: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		if (q?.supportedModels) {
			try {
				const models = modelOptions(await withTimeout(q.supportedModels(), CONTROL_TIMEOUT_MS));
				if (!run.exited && models.length) this.emit(run.id, { kind: 'models', models });
			} catch (e) {
				this.log(`run ${run.id}: models not listed: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	}

	/** The session's MCP servers now, as an `mcp_status` event (skipped on failure or when there are none). */
	private async reportMcp(run: Run) {
		const q = run.query;
		if (run.exited || !q?.mcpServerStatus) return;
		try {
			const servers = mcpStatus(await withTimeout(q.mcpServerStatus(), CONTROL_TIMEOUT_MS));
			if (!run.exited && (servers.length || run.mcpReported)) {
				run.mcpReported = true;
				this.emit(run.id, { kind: 'mcp_status', servers });
			}
		} catch (e) {
			this.log(`run ${run.id}: MCP status not read: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/**
	 * After a turn: how full the context window is, as a `context_usage` event. The SDK's own count
	 * when it has one, else the main agent's last call against the result's `contextWindow`.
	 */
	private async reportContext(run: Run, window: number | null) {
		let used = run.contextTokens;
		let max = window;
		const q = run.query;
		if (q?.getContextUsage) {
			try {
				const u = await withTimeout(q.getContextUsage({ detail: 'summary' }), CONTROL_TIMEOUT_MS);
				if (typeof u?.totalTokens === 'number' && typeof u.maxTokens === 'number' && u.maxTokens > 0) {
					used = u.totalTokens;
					max = u.maxTokens;
				}
			} catch (e) {
				this.log(`run ${run.id}: context usage not read: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		if (run.exited || used === null || !max) return;
		this.emit(run.id, { kind: 'context_usage', used_tokens: Math.round(used), max_tokens: Math.round(max) });
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
		run.guards?.reset();
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
			run.mode = mode;
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
		need(DECISIONS.includes(decision), `bad decision ${decision}`);
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

	/**
	 * A safety ask (guards/asks.ts) as an ordinary permission prompt, preceded by a `guard_asked`
	 * event saying why. Allowed: the call goes on, and canUseTool lets it through without a second prompt.
	 */
	private askGuard(run: Run): AskUser {
		return ({ tool, input, toolUseId, ask, signal }) =>
			new Promise((resolve) => {
				if (run.exited || run.stopped) return resolve({ message: 'stopped' });
				const requestId = this.newId();
				const done = (r: PermissionResult) => {
					if (r.behavior === 'allow') {
						if (toolUseId) run.guardApproved.add(toolUseId);
						resolve(true);
					} else resolve({ message: r.message && r.message !== DENIED_BY_USER ? r.message : null });
				};
				const fields = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
				run.pending.set(requestId, { resolve: done, input: fields, suggestions: [], tool });
				signal?.addEventListener('abort', () => {
					if (!run.pending.delete(requestId)) return;
					done({ behavior: 'deny', message: 'cancelled', interrupt: true });
					this.emit(run.id, { kind: 'permission_resolved', request_id: requestId, decision: 'cancelled' });
				});
				this.emit(run.id, { kind: 'guard_asked', request_id: requestId, tool, tool_use_id: toolUseId, check: ask.check, paths: ask.paths.slice(0, 20) });
				const { summary, detail, diff } = summarizeTool(tool, input);
				this.emit(run.id, {
					kind: 'permission_request',
					request_id: requestId,
					tool,
					tool_use_id: toolUseId,
					title: null,
					input_summary: summary,
					detail,
					diff,
					input,
					// A safety ask is answered each time: never a rule to keep.
					can_always: false,
					rules: []
				});
			});
	}

	private canUseTool(run: Run): CanUseTool {
		return (tool, input, opts) =>
			new Promise<PermissionResult>((resolve) => {
				if (run.exited || run.stopped) return resolve({ behavior: 'deny', message: 'stopped', interrupt: true });
				// Just allowed at Kingu's safety ask: no second prompt for the same call. Never in plan mode,
				// whose own prompt is what keeps it read-only.
				if (opts.toolUseID && run.guardApproved.delete(opts.toolUseID) && run.mode !== 'plan') return resolve({ behavior: 'allow', updatedInput: input });
				// Publishing an artifact only writes to the project's .kingu/artifacts (plan mode still asks).
				if (tool === ARTIFACT_TOOL && run.artifacts && run.mode !== 'plan') return resolve({ behavior: 'allow', updatedInput: input });
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
					can_always: !opts.suppressAlwaysAllowRule && !isAskUserQuestion(tool),
					rules: ruleTexts(opts.suggestions)
				});
			});
	}
}

/** Where each "always" answer saves its rules (SDK `PermissionUpdateDestination`). */
const DESTINATION = { allow_always: 'session', allow_workspace: 'localSettings', allow_user: 'userSettings' } as const;

/**
 * The SDK result for the user's answer. "Always" grants go to the session, this folder's
 * `.claude/settings.local.json` (not committed) or the user's settings, by `DESTINATION`.
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
	const destination = DESTINATION[decision];
	// Saved to a settings file: only allow rules (a suggested mode switch or extra directory stays
	// a session matter, never the user's or folder's default).
	const kept = destination === 'session' ? p.suggestions : p.suggestions.filter((s) => s.type === 'addRules' && s.behavior === 'allow');
	const fromSuggestions = kept.map((s) => ({ ...s, destination }));
	const updatedPermissions: PermissionUpdate[] = fromSuggestions.length ? fromSuggestions : [{ type: 'addRules', rules: [{ toolName: p.tool }], behavior: 'allow', destination }];
	return { behavior: 'allow', updatedInput: p.input, updatedPermissions };
}
