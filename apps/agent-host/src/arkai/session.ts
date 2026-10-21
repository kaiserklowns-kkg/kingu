// An Arkai run: Kingu's own agent loop in this process, on a model the user brings (an
// OpenAI-compatible server, Ollama, or the Anthropic API; spec.ts). Each user message is a turn:
// the model answers (streamed), its tool calls run one by one through the same checks as the
// Claude runtime, their results go back, until it answers without a call.
//
// - Tool calls: arguments repaired (coach.ts), then Kingu's safety checks (guards/: a
//   catastrophic command or the third identical call is refused, the always-ask checks ask), the
//   permission mode, and the user's answer ("allow always" lasts for this run); an edit's file is
//   snapshotted just before it runs, so the chat's working set and Undo work as for Claude.
// - Small models: calls written as text become real ones (leftover.ts), or the model is sent
//   back to make them (at most twice per message); light mode (prompt.ts) for a small window.
// - Context: the conversation is made to fit the model's window before each request (context.ts);
//   `/compact` summarises it at once.
// - A continued chat gets its conversation back from the transcript (history.ts); the session
//   id is Arkai's own and stays the same.
// - MCP servers (mcp.ts): the run's servers connect while it opens (and later ones join when
//   ready); their tools are offered as `mcp__<server>__<tool>`, gated like the rest, and the
//   clients are closed when the run ends.
//
// Never log prompts, tool inputs, file contents or the API key.

import { askDeniedReason } from '../guards/asks.ts';
import { Guards } from '../guards/index.ts';
import { MAX_TOOL_RESULT_CHARS, truncate } from '../normalize.ts';
import type { PermissionMode } from '../protocol.ts';
import { RunSession, SessionError, UNSUPPORTED, type SessionInit, type Turn, type TurnEnd } from '../runtimes/session.ts';
import type { ToolKind, ToolView } from '../runtimes/tools.ts';
import { AnthropicClient } from './anthropic.ts';
import { coachInput, hintFor, parseArguments } from './coach.ts';
import { conversationTokens, estimateTokens, fitContext, summarise } from './context.ts';
import { historyMessages } from './history.ts';
import { McpHub } from './mcp.ts';
import { hasLeftoverToolCall, MAX_NUDGES, NUDGE, recoverToolCalls, stripToolMarkup, STRIPPED_PLACEHOLDER } from './leftover.ts';
import { ProviderError, type ChatClient, type Completion, type Msg, type TokenUsage, type ToolCall, type ToolDef } from './messages.ts';
import { callId, OpenAiClient } from './openai.ts';
import { systemPrompt } from './prompt.ts';
import { arkaiProvider, modelOf, type ArkaiProvider, type ArkaiSpec } from './spec.ts';
import { cap, isToolName, KIND, runTool, toolDefs, writtenPaths, type ToolName } from './tools.ts';

/** Model requests per user message before the turn is ended. */
export const MAX_STEPS = 60;
/** Tries of a request that failed for a passing reason (rate limit, overload) before any text came. */
const RETRIES = 2;
const RETRY_DELAY_MS = 1500;
/** How long the first turn waits for the MCP servers to connect (slower ones join later). */
export const MCP_WAIT_MS = 10_000;
/** MCP tool definitions may take at most this share of the context window (else none are offered). */
const MCP_SHARE = 0.25;

export const DENIED = 'The user did not allow this call.';
export const PLAN_DENIED = 'Plan mode: this call would change files or run a command, which the user has not allowed yet. Describe what you would do instead.';
export const INTERRUPTED = 'Interrupted by the user.';

/** What Arkai decides by itself in a permission mode; null: ask the user. */
export function arkaiDecision(mode: PermissionMode, kind: ToolKind): 'allow' | 'deny' | null {
	const looks = kind === 'read' || kind === 'search' || kind === 'think';
	switch (mode) {
		case 'bypassPermissions':
			return 'allow';
		case 'plan':
			return looks ? 'allow' : kind === 'other' ? null : 'deny';
		case 'acceptEdits':
			return looks || kind === 'edit' ? 'allow' : null;
		default:
			return looks ? 'allow' : null;
	}
}

const SHELL_OPS = /[;&|`<>\n]|\$\(/;

/** What an "allow always" answer keeps: a readable rule and how to match later calls. */
export function ruleFor(view: ToolView): { text: string; key: string } {
	if (view.name === 'Bash' && typeof view.input.command === 'string') {
		const command = view.input.command.trim();
		if (SHELL_OPS.test(command)) return { text: `Bash(${command})`, key: `Bash=${command}` };
		const words = command.split(/\s+/);
		const prefix = words.length > 1 && /^[a-z][\w:.-]*$/i.test(words[1]!) ? `${words[0]} ${words[1]}` : words[0]!;
		return { text: `Bash(${prefix}:*)`, key: `Bash:${prefix}` };
	}
	return { text: view.name, key: view.name };
}

/** Whether an "always" grant covers the call. */
export function granted(grants: ReadonlySet<string>, view: ToolView): boolean {
	if (view.name !== 'Bash') return grants.has(view.name);
	const command = typeof view.input.command === 'string' ? view.input.command.trim() : '';
	if (grants.has(`Bash=${command}`)) return true;
	if (SHELL_OPS.test(command)) return false;
	for (const g of grants) {
		if (!g.startsWith('Bash:')) continue;
		const prefix = g.slice(5);
		if (command === prefix || command.startsWith(`${prefix} `)) return true;
	}
	return false;
}

export function clientFor(provider: ArkaiProvider, fetchFn?: typeof fetch): ChatClient {
	return provider.api === 'anthropic' ? new AnthropicClient(provider, fetchFn) : new OpenAiClient(provider, fetchFn);
}

const toUsage = (u: TokenUsage) => ({ input_tokens: u.input, output_tokens: u.output, cache_read_input_tokens: u.cacheRead, cache_creation_input_tokens: u.cacheWrite });

export class ArkaiSession extends RunSession {
	private spec: ArkaiSpec;
	private provider: ArkaiProvider;
	private modelId: string;
	private client: ChatClient;
	private messages: Msg[] = [];
	private abort: AbortController | null = null;
	private guards: Guards | null;
	/** "Allow always" answers of this run. */
	private grants = new Set<string>();
	/** The provider's input count over our estimate, from the last request. */
	private calibration = 1;
	private mcp: McpHub | null = null;
	/** The MCP tools were left out for the window: said once in the log. */
	private mcpTooBig = false;

	constructor(
		init: SessionInit,
		private fetchFn?: typeof fetch
	) {
		super(init);
		if (!init.arkai) throw new Error('arkai runtime without its spec');
		this.spec = init.arkai;
		this.provider = init.arkai.provider;
		this.modelId = init.arkai.model;
		this.client = clientFor(this.provider, fetchFn);
		this.guards = init.safetyChecks || init.guardAsks ? new Guards(init.safetyChecks, init.guardAsks ?? null) : null;
	}

	start() {
		this.begin();
	}

	protected async open() {
		this.sessionId = this.init.resume ?? crypto.randomUUID();
		if (this.init.resume && this.spec.history?.length) this.messages = historyMessages(this.spec.history);
		if (Object.keys(this.init.mcpServers).length) {
			const hub = (this.mcp = new McpHub(this.init.mcpServers, {
				cwd: this.cwd,
				env: this.init.env,
				log: (line) => this.log(line),
				onChange: (servers) => this.emit({ kind: 'mcp_status', servers })
			}));
			this.emit({ kind: 'mcp_status', servers: hub.status() });
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([hub.ready, new Promise<void>((r) => (timer = setTimeout(r, MCP_WAIT_MS)))]);
			clearTimeout(timer);
		}
		this.log(`arkai on ${this.provider.id} (${this.provider.api}${this.settings().light ? ', light' : ''}), ${this.messages.length} earlier messages`);
	}

	protected model() {
		return `${this.provider.id}/${this.modelId}`;
	}

	private settings() {
		return modelOf(this.provider, this.modelId);
	}

	private offered(): ToolDef[] {
		const own = toolDefs(this.settings().light);
		const mcp = this.mcp?.defs() ?? [];
		if (!mcp.length) return own;
		// Many servers' tools would not leave a small window room for the conversation.
		if (estimateTokens(JSON.stringify(mcp)) > this.settings().contextWindow * MCP_SHARE) {
			if (!this.mcpTooBig) this.log(`mcp tools left out: ${mcp.length} tools do not fit this model's context window`);
			this.mcpTooBig = true;
			return own;
		}
		return [...own, ...mcp];
	}

	private system(): string {
		const light = this.settings().light;
		return systemPrompt(light, { cwd: this.cwd, platform: process.platform, date: new Date().toISOString().slice(0, 10), model: this.model() }, light ? '' : (this.init.systemPromptAppend ?? ''));
	}

	protected async cancel() {
		this.abort?.abort();
	}

	protected kill(code: number) {
		this.abort?.abort();
		this.finish(code);
	}

	protected closed() {
		this.mcp?.close();
	}

	async stop() {
		if (this.exited) return null;
		this.stopped = true;
		this.cancelPending();
		this.abort?.abort();
		this.finish(0);
		return null;
	}

	/** A model of this provider switches now; another provider's comes with its config (`extra`). */
	async setOptions(model: string | undefined, mode: PermissionMode | undefined, extra?: unknown) {
		if (model !== undefined) {
			const slash = model.indexOf('/');
			const providerId = slash > 0 ? model.slice(0, slash) : this.provider.id;
			const id = slash > 0 ? model.slice(slash + 1) : model;
			if (!id.trim()) throw new SessionError(UNSUPPORTED, 'no model given');
			if (providerId !== this.provider.id) {
				let next: ArkaiProvider;
				try {
					next = arkaiProvider(extra);
				} catch {
					throw new SessionError(UNSUPPORTED, `the provider ${providerId} is not set up`);
				}
				if (next.id !== providerId) throw new SessionError(UNSUPPORTED, `the provider ${providerId} is not set up`);
				this.provider = next;
				this.client = clientFor(next, this.fetchFn);
				this.calibration = 1;
			}
			this.modelId = id;
			this.log(`model changed (${this.provider.id})`);
		}
		if (mode !== undefined) this.mode = mode;
		return { model: model ?? null, permissionMode: mode ?? null };
	}

	// -------------------------------------------------------------------------------------------
	// The agent loop

	protected async prompt(turn: Turn): Promise<TurnEnd> {
		this.guards?.reset();
		const usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		if (turn.text.trim() === '/compact') return this.compactNow();
		this.messages.push({ role: 'user', text: turn.text, ...(turn.images.length ? { images: turn.images } : {}) });
		let nudges = 0;
		let overflowRetried = false;
		for (let step = 0; step < MAX_STEPS; step++) {
			if (this.stopped || this.exited) return { ok: false, cancelled: true, usage: toUsage(usage) };
			const abort = (this.abort = new AbortController());
			const tools = this.offered();
			const system = this.system();
			const settings = this.settings();
			const fixed = estimateTokens(system) + estimateTokens(JSON.stringify(tools));
			const fitted = fitContext(this.messages, { window: settings.contextWindow, maxTokens: settings.maxTokens, fixed, calibration: this.calibration });
			if (fitted.compacted) {
				this.messages = fitted.messages;
				this.log(`context compacted (${fitted.droppedTurns} turns summarised)`);
				this.emit({ kind: 'system', subtype: 'compact_boundary', session_id: this.reportedSession(), model: this.model() });
			}
			const estimate = fixed + conversationTokens(this.messages);
			let res: Completion;
			try {
				res = await this.request({ model: this.modelId, system, messages: this.messages, tools, maxTokens: settings.maxTokens, signal: abort.signal });
			} catch (e) {
				if (abort.signal.aborted || this.stopped) return { ok: false, cancelled: true, usage: toUsage(usage) };
				if (e instanceof ProviderError && e.contextOverflow && !overflowRetried) {
					// Our estimate was low: count more per character and try once more.
					overflowRetried = true;
					this.calibration = Math.min(3, this.calibration * 1.6);
					this.flush();
					continue;
				}
				return { ok: false, error: e instanceof Error ? e.message : String(e), usage: toUsage(usage) };
			}
			if (res.usage) {
				usage.input += res.usage.input;
				usage.output += res.usage.output;
				usage.cacheRead += res.usage.cacheRead;
				usage.cacheWrite += res.usage.cacheWrite;
				if (res.usage.input > 0) this.calibration = res.usage.input / Math.max(1, estimate);
				this.emit({ kind: 'context_usage', used_tokens: res.usage.input + res.usage.cacheRead + res.usage.output, max_tokens: settings.contextWindow });
			}
			let text = res.text;
			let calls = res.calls;
			if (!calls.length) {
				// A call written as text: made a real one when it names an offered tool.
				const recovered = recoverToolCalls(text, tools);
				if (recovered) {
					calls = recovered.calls.map((c) => ({ id: callId(), name: c.name, arguments: c.arguments }));
					text = recovered.text;
					this.replaceStreamed(text);
					this.log(`recovered ${calls.length} tool call(s) written as text`);
				} else if (hasLeftoverToolCall(text) && nudges < MAX_NUDGES) {
					nudges++;
					const clean = stripToolMarkup(text);
					this.replaceStreamed(clean);
					this.flush();
					this.messages.push({ role: 'assistant', text: clean || STRIPPED_PLACEHOLDER, calls: [] }, { role: 'user', text: NUDGE });
					this.log(`tool call written as text: model sent back (${nudges})`);
					continue;
				}
			}
			const clean = stripToolMarkup(text);
			if (clean !== text) this.replaceStreamed(clean);
			this.messages.push({ role: 'assistant', text: clean, calls });
			if (!calls.length) {
				if (res.stop === 'length' && !clean.trim()) return { ok: false, error: 'the model stopped at its answer length limit', usage: toUsage(usage) };
				return { ok: true, usage: toUsage(usage) };
			}
			this.flush();
			for (let i = 0; i < calls.length; i++) {
				const call = calls[i]!;
				if (abort.signal.aborted || this.stopped) {
					// Every call needs its result, or the next request is refused.
					for (const c of calls.slice(i)) this.messages.push({ role: 'tool', id: c.id, name: c.name, content: INTERRUPTED, isError: true });
					return { ok: false, cancelled: true, usage: toUsage(usage) };
				}
				const r = await this.runCall(call, abort.signal);
				this.messages.push({ role: 'tool', id: call.id, name: call.name, content: r.content, isError: r.isError });
			}
			if (abort.signal.aborted || this.stopped) return { ok: false, cancelled: true, usage: toUsage(usage) };
		}
		return { ok: false, error: `stopped after ${MAX_STEPS} model requests in one turn`, usage: toUsage(usage) };
	}

	/** One model request, streamed into the chat; asked again after a passing failure before any text came. */
	private async request(req: Omit<Parameters<ChatClient['complete']>[0], 'onText' | 'onThinking'>): Promise<Completion> {
		for (let attempt = 0; ; attempt++) {
			let streamed = false;
			try {
				return await this.client.complete({
					...req,
					onText: (t) => {
						streamed = true;
						this.appendText(t);
					},
					onThinking: (t) => {
						streamed = true;
						this.appendThinking(t);
					}
				});
			} catch (e) {
				const passing = e instanceof ProviderError ? e.retryable : !(e instanceof Error && e.name === 'AbortError');
				if (streamed || req.signal.aborted || !passing || attempt >= RETRIES) throw e;
				this.log(`request failed${e instanceof ProviderError ? ` (HTTP ${e.status})` : ''}, trying again`);
				await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
				if (req.signal.aborted) throw e;
			}
		}
	}

	/** `/compact`: everything so far summarised into a few lines. */
	private compactNow(): TurnEnd {
		if (this.messages.length) {
			const settings = this.settings();
			this.messages = [{ role: 'user', text: summarise(this.messages, Math.floor(settings.contextWindow * 0.15 * 3.5)) }, { role: 'assistant', text: 'Understood.', calls: [] }];
			this.emit({ kind: 'system', subtype: 'compact_boundary', session_id: this.reportedSession(), model: this.model() });
		}
		return { ok: true, usage: null };
	}

	// -------------------------------------------------------------------------------------------
	// Tool calls

	private async runCall(call: ToolCall, signal: AbortSignal): Promise<{ content: string; isError: boolean }> {
		const parsed = parseArguments(call.arguments);
		const offered = this.offered().some((t) => t.name === call.name);
		const own = isToolName(call.name);
		const known = offered && (own || !!this.mcp?.has(call.name));
		const input = 'input' in parsed ? coachInput(call.name, parsed.input) : {};
		const name = call.name as ToolName;
		const view: ToolView = { name: call.name, input, kind: known && own ? KIND[name] : 'other', paths: known && own ? writtenPaths(name, input, this.cwd) : [] };
		const state = this.toolStarted(call.id, view, false);
		const done = (content: string, isError: boolean) => {
			this.toolFinished(call.id, truncate(content, MAX_TOOL_RESULT_CHARS), isError);
			return { content: isError ? withHint(call.name, content) : content, isError };
		};
		if ('error' in parsed) return done(parsed.error, true);
		if (!known) return done(`Unknown tool ${call.name}. The tools are: ${this.offered().map((t) => t.name).join(', ')}.`, true);
		const gate = await this.gate(call.id, view);
		if (gate !== true) return done(gate, true);
		this.snapshot(call.id, state);
		if (!own) {
			const r = await this.mcp!.call(call.name, input, signal);
			return done(cap(r.content), r.isError);
		}
		const r = await runTool(name, input, { cwd: this.cwd, env: this.init.env, signal });
		return done(r.content, r.isError);
	}

	/** Whether the call may run: true, or why not (told to the model). */
	private async gate(id: string, view: ToolView): Promise<true | string> {
		if (this.guards) {
			const verdict = this.guards.check(view.name, view.input);
			if (!verdict.allow) {
				// The check's name only: the command itself is never logged.
				this.log(`safety check blocked ${view.name} (${verdict.event.check}${verdict.event.threats.length ? `: ${verdict.event.threats.join(', ')}` : ''})`);
				this.emit({ kind: 'guard_blocked', tool_use_id: id, ...verdict.event });
				return verdict.reason;
			}
			const ask = this.guards.askFor(view.name, view.input);
			if (ask) {
				this.log(`safety check asks about ${view.name} (${ask.check})`);
				let requestId = '';
				const d = await this.askUser(id, view, {
					title: null,
					// A safety ask is answered each time: never a rule to keep.
					canAlways: false,
					onRequest: (rid) => {
						requestId = rid;
						this.emit({ kind: 'guard_asked', request_id: rid, tool: view.name, tool_use_id: id, check: ask.check, paths: ask.paths.slice(0, 20) });
					}
				});
				if (d === 'cancelled') return INTERRUPTED;
				if (d === 'deny') return askDeniedReason(ask, this.takeNote(requestId));
				// Allowed at the safety ask: no second prompt, except in plan mode, whose own rule keeps it read-only.
				if (this.mode !== 'plan') return true;
			}
		}
		const auto = arkaiDecision(this.mode, view.kind);
		if (auto === 'allow') return true;
		if (auto === 'deny') return PLAN_DENIED;
		if (granted(this.grants, view)) return true;
		const rule = ruleFor(view);
		let requestId = '';
		const d = await this.askUser(id, view, { title: null, canAlways: true, rules: [rule.text], onRequest: (rid) => (requestId = rid) });
		if (d === 'cancelled') return INTERRUPTED;
		if (d === 'deny') {
			const note = this.takeNote(requestId);
			return note ? `${DENIED} They said: ${note}` : DENIED;
		}
		// Every "always" answer lasts for this run only: Arkai keeps no settings file of rules.
		if (d !== 'allow') this.grants.add(rule.key);
		return true;
	}

	private takeNote(requestId: string): string | null {
		const note = this.denyNotes.get(requestId) ?? null;
		this.denyNotes.delete(requestId);
		return note;
	}
}

/** A failed call's error with the tool coach's hint (coach.ts) when one fits. */
function withHint(tool: string, error: string): string {
	const hint = hintFor(tool, error);
	return hint ? `${error}\n${hint}` : error;
}
