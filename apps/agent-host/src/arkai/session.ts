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
//   clients are closed when the run ends. A server's form (`elicitation/create`) goes to the user
//   as a card (../mcpAsks.ts); its model call (`sampling/createMessage`) runs on this run's
//   provider and model once the user allowed it (`chat.mcp.serverSampling`, or the card).
// - Skills over MCP (mcpSkills.ts): a server's skills are listed in the instructions and loaded
//   with ReadSkill, asked of the user per server; `/<server>:<skill>` in a message asks for one.
// - Model routers (modelRouter.ts): on `model-router:<name>`, each turn runs on the route the
//   router picks for it, with that route's effort and guidance.
//
// Never log prompts, tool inputs, file contents or the API key.

import { askDeniedReason } from '../guards/asks.ts';
import { Guards } from '../guards/index.ts';
import { MAX_TOOL_RESULT_CHARS, truncate } from '../normalize.ts';
import type { McpAppParams, McpAppToolResultParams, McpAppToolsParams, PermissionMode } from '../protocol.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { arkaiEffortKind, arkaiReasoning, type Effort } from '../effort.ts';
import { INVALID_PARAMS, RUN_NOT_FOUND, RunSession, SessionError, UNSUPPORTED, type SessionInit, type Turn, type TurnEnd } from '../runtimes/session.ts';
import type { ToolKind, ToolView } from '../runtimes/tools.ts';
import { AnthropicClient } from './anthropic.ts';
import { coachInput, hintFor, parseArguments } from './coach.ts';
import { conversationTokens, estimateTokens, fitContext, summarise } from './context.ts';
import { historyMessages } from './history.ts';
import { exposedName, McpHub, resultText, type McpClient } from './mcp.ts';
import { appResult, AppToolCalls, AppToolRegistry, appToolDefs, checkAppRequest } from './mcpApps.ts';
import { isSkillLoad, mcpSkillIndex, READ_SKILL, READ_SKILL_DEF, skillArgumentHint, skillLabels } from './mcpSkills.ts';
import {
	chatModelPicker,
	isModelRouterModel,
	loadModelRouter,
	MODEL_ROUTER_FOLDER,
	modelRouterBriefing,
	modelRouterLabel,
	modelRouterNameOf,
	resolveModelRouter,
	routeKey,
	routeTurn,
	type ModelRouter,
	type ResolvedRoute,
	type RouterState
} from './modelRouter.ts';
import { elicitAsk, sampleAsk } from '../mcpAsks.ts';
import { RpcCallError } from '../runtimes/rpc.ts';
import { hasLeftoverToolCall, MAX_NUDGES, NUDGE, recoverToolCalls, stripToolMarkup, STRIPPED_PLACEHOLDER } from './leftover.ts';
import { ProviderError, type ChatClient, type Completion, type Msg, type TokenUsage, type ToolCall, type ToolDef } from './messages.ts';
import { callId, OpenAiClient } from './openai.ts';
import { systemPrompt } from './prompt.ts';
import { arkaiProvider, modelOf, type ArkaiProvider, type ArkaiSpec } from './spec.ts';
import { cap, isToolName, KIND, runTool, toolDefs, writtenPaths, type ToolName } from './tools.ts';
import { BROWSER_SERVER, browserToolOf, browserToolSpecs, callBrowser, qualified } from '../browser.ts';
import { maskEnv, RunSandbox } from '../sandbox/run.ts';
import { grantPrompt, grantWire, type Blocked, type SandboxGrant } from '../sandbox/retry.ts';

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
/** VS Code's answers to a refused unsandboxed run (copilotShellTools.ts). */
export const UNSANDBOXED_DISABLED = 'Unsandboxed execution is disabled by the chat.agent.sandbox.allowUnsandboxedCommands setting.';
export const UNSANDBOXED_DECLINED = 'User declined to run command outside the sandbox.';
/** VS Code declines MCP skill consent in Autopilot (copilotAgentSession.ts _handleMcpSkillConsentRequest). */
export const SKILL_BYPASS_DECLINED = 'Skills from MCP servers are loaded only when the user allows them, and Allow all does not answer that. Ask the user to switch to another permission mode to load this skill.';
export const SKILL_DECLINED = 'The user did not allow skills from this MCP server.';
/** The user chose Skip on "Allow sandbox … and retry?" (retry.ts). */
export const SANDBOX_GRANT_SKIPPED = 'The user did not allow this in the sandbox (Skip), so the command was not retried.';
/** Grants one Bash call may ask for, one after another (each a different one). */
const MAX_GRANT_ROUNDS = 3;

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
	if (view.name === READ_SKILL) {
		const server = String(view.input.server ?? '');
		return { text: `${READ_SKILL}(server:${server})`, key: `${READ_SKILL}:${server}` };
	}
	if (view.name === 'Bash' && typeof view.input.command === 'string') {
		const command = view.input.command.trim();
		if (SHELL_OPS.test(command)) return { text: `Bash(${command})`, key: `Bash=${command}` };
		const words = command.split(/\s+/);
		const prefix = words.length > 1 && /^[a-z][\w:.-]*$/i.test(words[1]!) ? `${words[0]} ${words[1]}` : words[0]!;
		return { text: `Bash(${prefix}:*)`, key: `Bash:${prefix}` };
	}
	const host = fetchHost(view);
	if (host) return { text: `WebFetch(domain:${host})`, key: `WebFetch:${host}` };
	return { text: view.name, key: view.name };
}

/** The host a WebFetch call asks for (an "always" answer covers that site only). */
function fetchHost(view: ToolView): string | null {
	if (view.name !== 'WebFetch' || typeof view.input.url !== 'string') return null;
	try {
		return new URL(view.input.url).host.toLowerCase() || null;
	} catch {
		return null;
	}
}

/** Whether an "always" grant covers the call. */
export function granted(grants: ReadonlySet<string>, view: ToolView): boolean {
	if (view.name === 'WebFetch') {
		const host = fetchHost(view);
		return host !== null && grants.has(`WebFetch:${host}`);
	}
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

/**
 * Whether `name` is left out by `disallowed` (the SDK's rules): its own name, `mcp__<server>` or
 * `mcp__<server>__*` for every tool of that server, `mcp__*` for every MCP tool.
 */
export function toolDisallowed(name: string, disallowed: readonly string[]): boolean {
	for (const d of disallowed) {
		if (d === name) return true;
		if (!name.startsWith('mcp__') || !d.startsWith('mcp__')) continue;
		if (d === 'mcp__*') return true;
		const server = d.endsWith('__*') ? d.slice(0, -3) : d;
		if (server.split('__').length === 2 && name.startsWith(`${server}__`)) return true;
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
	/** Sampling requests in flight (aborted when the run ends). */
	private sampling = new Set<AbortController>();
	/** The sandbox of this run's Bash commands (`chat.agent.sandbox.enabled`); null: off. */
	private sandbox: RunSandbox | null;
	/** Bash calls the user allowed to run outside the sandbox (asked each time, in every mode). */
	private unsandboxed = new Set<string>();
	/** The chat's model router selection (`model-router:<name>`); null: a model. */
	private routerModel: string | null = null;
	/** The router as last loaded, with its routes on this provider (reloaded on each switch). */
	private router: { router: ModelRouter; routes: ResolvedRoute[]; skipped: string[] } | null = null;
	/** The router's last pick, kept across turns. */
	private routerState: RouterState | null = null;
	/** The effort the route chose for this turn (undefined: the chat's own). */
	private routedEffort: Effort | undefined;
	/** The route's guidance for the main agent (modelRouterBriefing); '' when none. */
	private routerBriefing = '';
	/** MCP skills were offered as commands (so an empty list is sent once they are gone). */
	private skillCommands = false;
	/** Tools the chat's MCP Apps registered (mcpApps.ts), and the model's calls of them in flight. */
	private appTools = new AppToolRegistry();
	private appCalls: AppToolCalls;
	/** MCP Apps' own tool calls in flight (aborted when the run ends). */
	private appAborts = new Set<AbortController>();

	constructor(
		init: SessionInit,
		private fetchFn?: typeof fetch
	) {
		super(init);
		if (!init.arkai) throw new Error('arkai runtime without its spec');
		this.spec = init.arkai;
		this.provider = init.arkai.provider;
		this.modelId = init.arkai.model;
		if (isModelRouterModel(this.modelId)) {
			this.routerModel = this.modelId;
			// Until the first turn is routed: the provider's first model (only its settings are read).
			this.modelId = this.provider.models?.[0]?.id ?? this.modelId;
		}
		this.client = clientFor(this.provider, fetchFn);
		this.guards = init.safetyChecks || init.guardAsks ? new Guards(init.safetyChecks, init.guardAsks ?? null, () => this.mode) : null;
		this.sandbox = init.sandbox ? new RunSandbox(init.sandbox, init.cwd) : null;
		this.appCalls = new AppToolCalls((ev) => this.emit(ev), init.newId);
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
				// Without the masked variables, as Claude Code's servers get its masked env: a sandboxed command can
				// read any of the user's processes' launch environment (KERN_PROCARGS2), these servers' too.
				env: this.sandbox ? maskEnv(this.init.env, this.sandbox.config.maskedEnv) : this.init.env,
				log: (line) => this.log(line),
				onChange: (servers) => {
					this.emit({ kind: 'mcp_status', servers });
					this.emitSkillCommands();
				},
				handlers: (server) => ({ elicit: (params) => this.elicit(server, params), sample: (params) => this.sample(server, params) }),
				skills: this.init.mcpSkills !== false,
				apps: true
			}));
			this.emit({ kind: 'mcp_status', servers: hub.status() });
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([hub.ready, new Promise<void>((r) => (timer = setTimeout(r, MCP_WAIT_MS)))]);
			clearTimeout(timer);
		}
		this.log(`arkai on ${this.provider.id} (${this.provider.api}${this.settings().light ? ', light' : ''}), ${this.messages.length} earlier messages`);
		if (this.sandbox) {
			this.log(`sandbox on (network ${this.sandbox.config.allowNetwork ? 'open' : 'blocked'}, ${this.sandbox.config.maskedEnv.length} masked variables)${this.sandbox.problem ? `: ${this.sandbox.problem}` : ''}`);
			// Said in the chat too: with the setting on, commands are refused here rather than run bare.
			if (this.sandbox.problem) this.emit({ kind: 'stderr', line: `Sandbox: ${this.sandbox.problem}. Commands are not run unless you allow one outside the sandbox.` });
		}
	}

	/** The chat's selection: a model router stays the chat's model (its pick is per turn). */
	protected model() {
		return `${this.provider.id}/${this.routerModel ?? this.modelId}`;
	}

	/** The MCP skills as slash commands (`/<server>:<skill>`), as VS Code offers them. */
	private emitSkillCommands() {
		const skills = this.mcp?.skills.all() ?? [];
		if (!skills.length && !this.skillCommands) return;
		this.skillCommands = skills.length > 0;
		const labels = skillLabels(skills);
		this.emit({ kind: 'commands', commands: skills.map((s) => ({ name: labels.get(s)!, description: `${s.description} (MCP server ${s.server})`.slice(0, 500), argument_hint: skillArgumentHint(s) })) });
	}

	/** A message that starts with `/<server>:<skill>`: the model is told to load that skill first. */
	private withSkillInvocation(text: string): string {
		const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
		const skill = m && this.mcp?.skills.byLabel(m[1]!);
		if (!skill) return text;
		const rest = m[2]?.trim() ?? '';
		return `Use the skill "${m[1]}" from the MCP server "${skill.server}": load it with ${READ_SKILL} (server "${skill.server}", uri "${skill.uri}") and follow it.${rest ? `\n\n${rest}` : ''}`;
	}

	private settings() {
		return modelOf(this.provider, this.modelId);
	}

	private offered(): ToolDef[] {
		const off = this.init.disallowedTools ?? [];
		const own = toolDefs(this.settings().light, this.sandbox?.config ?? null).filter((t) => !toolDisallowed(t.name, off));
		const mcp = (this.mcp?.defs() ?? []).filter((t) => !toolDisallowed(t.name, off));
		if (!this.settings().light && this.mcp?.skills.all().length && !toolDisallowed(READ_SKILL, off)) own.push(READ_SKILL_DEF);
		own.push(...this.browserDefs().filter((t) => !toolDisallowed(t.name, off)));
		// MCP Apps' registered tools, from the next request on; never in place of another tool.
		const taken = new Set([...own, ...mcp].map((t) => t.name));
		mcp.push(...this.appTools.defs().filter((t) => !taken.has(t.name) && !toolDisallowed(t.name, off)));
		if (!mcp.length) return own;
		// Many servers' tools would not leave a small window room for the conversation.
		if (estimateTokens(JSON.stringify(mcp)) > this.settings().contextWindow * MCP_SHARE) {
			if (!this.mcpTooBig) this.log(`mcp tools left out: ${mcp.length} tools do not fit this model's context window`);
			this.mcpTooBig = true;
			return own;
		}
		return [...own, ...mcp];
	}

	/**
	 * Kingu's browser tools (../browser.ts) as Arkai's own, named as Claude gets them
	 * (`mcp__kingu__<tool>`): only with the app's session, not for a light model (its few tools),
	 * and not when a server of the run is named `kingu`.
	 */
	private browserDefs(): ToolDef[] {
		if (!this.init.browser || this.settings().light || BROWSER_SERVER in this.init.mcpServers) return [];
		return browserToolSpecs().map((t) => ({ name: qualified(t.name), description: t.description, parameters: t.inputSchema }));
	}

	private system(): string {
		const light = this.settings().light;
		const offered = !light && this.offered().some((t) => t.name === READ_SKILL);
		const extra = [light ? '' : (this.init.systemPromptAppend ?? ''), offered ? mcpSkillIndex(this.mcp!.skills.all()) : ''].filter((x) => x.trim()).join('\n\n');
		const prompt = systemPrompt(light, { cwd: this.cwd, platform: process.platform, date: new Date().toISOString().slice(0, 10), model: `${this.provider.id}/${this.modelId}` }, extra);
		return this.routerBriefing ? `${prompt}\n\n${this.routerBriefing}` : prompt;
	}

	protected async cancel() {
		this.abort?.abort();
	}

	protected kill(code: number) {
		this.abort?.abort();
		this.finish(code);
	}

	protected closed() {
		for (const a of this.sampling) a.abort();
		this.sampling.clear();
		for (const a of this.appAborts) a.abort();
		this.appAborts.clear();
		this.appCalls.cancelAll();
		this.appTools.clear();
		this.mcp?.close();
		this.sandbox?.dispose();
	}

	mcpClient(name: string): McpClient | null {
		return this.mcp?.client(name) ?? null;
	}

	/**
	 * A request of an MCP App in the chat to its server (mcpApps.ts): `resources/read`, `tools/call`
	 * of a tool visible to apps (through the permission rules, as the model's call would be), or
	 * `sampling/createMessage` (asked like the server's own). The server's answer as it gave it.
	 */
	async mcpApp(p: McpAppParams): Promise<unknown> {
		let req: ReturnType<typeof checkAppRequest>;
		try {
			req = checkAppRequest(p);
		} catch (e) {
			throw new SessionError(INVALID_PARAMS, e instanceof Error ? e.message : String(e));
		}
		const client = this.mcp?.client(req.server);
		if (this.exited || this.stopped || !client) throw new SessionError(RUN_NOT_FOUND, `MCP server ${req.server} is not connected in this chat`);
		if (req.method === 'sampling/createMessage') return this.sample(req.server, req.params);
		if (req.method === 'resources/read') return client.request('resources/read', { uri: req.params.uri as string });
		const name = req.params.name as string;
		if (!this.mcp!.appTool(req.server, name)) throw new SessionError(INVALID_PARAMS, `Tool not found on server: ${name}`);
		const args = (req.params.arguments ?? {}) as Record<string, unknown>;
		const exposed = exposedName(req.server, name);
		if (toolDisallowed(exposed, this.init.disallowedTools ?? [])) throw new SessionError(INVALID_PARAMS, `The tool ${name} is turned off for this chat.`);
		const view: ToolView = { name: exposed, input: args, kind: 'other', paths: [] };
		this.log(`mcp ${req.server}: its app calls a tool`);
		const gate = await this.gate(null, view, `The MCP App of ${req.server} wants to run ${name}`);
		if (gate !== true) throw new SessionError(INVALID_PARAMS, gate);
		const abort = new AbortController();
		this.appAborts.add(abort);
		try {
			return (await client.callRaw(name, args, abort.signal, req.params._meta as Record<string, unknown> | undefined)).raw;
		} finally {
			this.appAborts.delete(abort);
		}
	}

	/** The tools MCP App `appId` registered (`App.registerTool()`), offered from the next request; none: it is gone. */
	mcpAppTools(p: McpAppToolsParams) {
		if (typeof p.appId !== 'string' || !p.appId || p.appId.length > 200) throw new SessionError(INVALID_PARAMS, 'appId is empty');
		try {
			this.appTools.set(p.appId, appToolDefs(p.tools));
		} catch (e) {
			throw new SessionError(INVALID_PARAMS, e instanceof Error ? e.message : String(e));
		}
		return null;
	}

	/** The chat's answer to an `mcp_app_tool_call`. */
	mcpAppToolResult(p: McpAppToolResultParams) {
		try {
			return this.appCalls.answer(p);
		} catch (e) {
			throw new SessionError(RUN_NOT_FOUND, e instanceof Error ? e.message : String(e));
		}
	}

	/** A server's `elicitation/create`: the user's answer to its form (declined when it cannot be shown). */
	private async elicit(server: string, params: unknown): Promise<unknown> {
		const ask = elicitAsk(server, params);
		if (!ask) return { action: 'decline' };
		return this.asks.elicit(ask);
	}

	/**
	 * A server's `sampling/createMessage`, once allowed: one request to this run's model, without
	 * tools, its text as the answer (MCP has no multi-part sampling result). Refused: error -1,
	 * the spec's "user rejected".
	 */
	private async sample(server: string, params: unknown): Promise<unknown> {
		const ask = sampleAsk(server, params);
		if (!ask.messages.length) throw new RpcCallError(-32602, 'sampling/createMessage has no messages');
		if (!(await this.asks.allowSampling(ask))) throw new RpcCallError(-1, 'The user did not allow this model request.');
		if (this.exited || this.stopped) throw new RpcCallError(-1, 'The chat has ended.');
		const settings = this.settings();
		const abort = new AbortController();
		this.sampling.add(abort);
		try {
			const res = await this.client.complete({
				model: this.modelId,
				system: ask.systemPrompt ?? '',
				messages: ask.messages.map((m): Msg => (m.role === 'assistant' ? { role: 'assistant', text: m.text, calls: [] } : { role: 'user', text: m.text })),
				tools: [],
				maxTokens: Math.min(ask.maxTokens ?? settings.maxTokens, settings.maxTokens),
				signal: abort.signal,
				onText: () => {},
				onThinking: () => {}
			});
			this.log(`mcp ${server}: sampling answered`);
			return { role: 'assistant', content: { type: 'text', text: res.text }, model: this.model(), stopReason: res.stop === 'length' ? 'maxTokens' : 'endTurn' };
		} catch (e) {
			throw new RpcCallError(-32603, e instanceof Error ? e.message : String(e));
		} finally {
			this.sampling.delete(abort);
		}
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
	async setOptions(model: string | undefined, mode: PermissionMode | undefined, extra?: unknown, effort?: Effort) {
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
			if (isModelRouterModel(id)) {
				// Read again on the next turn; a pick of the same router is kept (VS Code's resolve).
				this.routerModel = id;
				this.router = null;
			} else {
				this.modelId = id;
				this.routerModel = null;
				this.router = null;
				this.routedEffort = undefined;
				this.routerBriefing = '';
			}
			this.log(`model changed (${this.provider.id})`);
		}
		if (mode !== undefined) this.mode = mode;
		// The next request carries it (../effort.ts).
		if (effort !== undefined) this.effort = effort;
		return { model: model ?? null, permissionMode: mode ?? null, ...(effort !== undefined ? { effort } : {}) };
	}

	// -------------------------------------------------------------------------------------------
	// The agent loop

	protected async prompt(turn: Turn): Promise<TurnEnd> {
		this.guards?.reset();
		const usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		if (turn.text.trim() === '/compact') return this.compactNow();
		if (this.routerModel) {
			const failed = await this.routeThisTurn(turn);
			if (failed === INTERRUPTED || this.stopped) return { ok: false, cancelled: true, usage: toUsage(usage) };
			if (failed) return { ok: false, error: failed, usage: toUsage(usage) };
		}
		const text = this.withSkillInvocation(turn.text);
		this.messages.push({ role: 'user', text, ...(turn.images.length ? { images: turn.images } : {}) });
		let nudges = 0;
		let overflowRetried = false;
		for (let step = 0; step < MAX_STEPS; step++) {
			if (this.stopped || this.exited) return { ok: false, cancelled: true, usage: toUsage(usage) };
			const abort = (this.abort = new AbortController());
			const tools = this.offered();
			const system = this.system();
			const settings = this.settings();
			// The chat's reasoning effort as this provider takes it (../effort.ts); null: nothing sent.
			const reasoning = arkaiReasoning(arkaiEffortKind(this.provider.api, this.provider.baseUrl, this.modelId), this.routedEffort ?? this.effort, settings.maxTokens);
			const maxTokens = reasoning?.maxTokens ?? settings.maxTokens;
			const fixed = estimateTokens(system) + estimateTokens(JSON.stringify(tools));
			const fitted = fitContext(this.messages, { window: settings.contextWindow, maxTokens, fixed, calibration: this.calibration });
			if (fitted.compacted) {
				this.messages = fitted.messages;
				this.log(`context compacted (${fitted.droppedTurns} turns summarised)`);
				this.emit({ kind: 'system', subtype: 'compact_boundary', session_id: this.reportedSession(), model: this.model() });
			}
			const estimate = fixed + conversationTokens(this.messages);
			let res: Completion;
			try {
				res = await this.request({
					model: this.modelId,
					system,
					messages: this.messages,
					tools,
					maxTokens,
					...(reasoning ? { extra: reasoning.body, keepThinking: reasoning.thinking } : {}),
					signal: abort.signal
				});
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
			this.messages.push({ role: 'assistant', text: clean, calls, ...(res.thinking?.length ? { thinking: res.thinking } : {}) });
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
		const skill = call.name === READ_SKILL;
		const browser = this.init.browser && !own && !(BROWSER_SERVER in this.init.mcpServers) ? browserToolOf(call.name) : null;
		const appTool = !own && !skill && !browser && !this.mcp?.has(call.name) ? this.appTools.owner(call.name) : null;
		const known = offered && (own || skill || !!browser || !!this.mcp?.has(call.name) || !!appTool);
		const input = 'input' in parsed ? coachInput(call.name, parsed.input) : {};
		const name = call.name as ToolName;
		const view: ToolView = { name: call.name, input, kind: known && own ? KIND[name] : skill ? 'read' : 'other', paths: known && own ? writtenPaths(name, input, this.cwd) : [] };
		const state = this.toolStarted(call.id, view, false);
		const done = (content: string, isError: boolean) => {
			this.toolFinished(call.id, truncate(content, MAX_TOOL_RESULT_CHARS), isError);
			return { content: isError ? withHint(call.name, content) : content, isError };
		};
		if ('error' in parsed) return done(parsed.error, true);
		if (!known) return done(`Unknown tool ${call.name}. The tools are: ${this.offered().map((t) => t.name).join(', ')}.`, true);
		if (browser) {
			// VS Code's asks (open, navigate to an address; everything in plan mode), not the general gate.
			const g = await this.browserGate(browser, input, call.id);
			if (g !== true) return done(g, true);
			// The text only: a screenshot's picture stays in the file its text names.
			const r = await callBrowser(browser, input, this.init.browser!);
			return done(cap(r.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n')), r.isError === true);
		}
		const gate = await this.gate(call.id, view);
		if (gate !== true) return done(gate, true);
		this.snapshot(call.id, state);
		if (skill) {
			const client = this.mcp?.client(String(input.server ?? ''));
			if (!client || typeof input.uri !== 'string') return done(`${READ_SKILL} needs the name of a connected MCP server that serves skills, and a uri.`, true);
			const r = await this.mcp!.skills.read(client, input.uri);
			return done(cap(r.content), r.isError);
		}
		if (appTool) {
			const r = await this.appCalls.call(appTool, call.name, input, signal);
			if (r.cancelled) return done(INTERRUPTED, true);
			// VS Code: the app's error text, or "MCP app tool … failed: …".
			if (!r.result) return done(`MCP app tool "${call.name}" failed: ${r.error ?? 'no result'}`, true);
			const text = resultText(r.result);
			return done(cap(text.content || (text.isError ? 'The MCP app tool returned an error.' : '')), text.isError);
		}
		if (!own) {
			// A tool with a UI resource: the chat renders its MCP App, then gets the server's own result.
			const app = this.mcp!.appOf(call.name);
			if (app) this.emit({ kind: 'mcp_app', tool_use_id: call.id, server: app.server, tool: app.tool, resource_uri: app.resourceUri, input, done: false });
			const r = await this.mcp!.callRaw(call.name, input, signal);
			if (app) this.emit({ kind: 'mcp_app', tool_use_id: call.id, server: app.server, tool: app.tool, resource_uri: app.resourceUri, input, done: true, result: appResult(r.raw, r) });
			return done(cap(r.content), r.isError);
		}
		const sandbox = this.sandbox && name === 'Bash' ? { run: this.sandbox, unsandboxed: this.unsandboxed.delete(call.id) } : null;
		let r = await runTool(name, input, { cwd: this.cwd, env: this.init.env, signal, sandbox });
		// VS Code 1.147's "retry with updated sandbox permissions": the sandbox stopped it and the user
		// may allow what it needed, then it runs again in the sandbox.
		const asked = new Set<string>();
		for (let round = 0; sandbox && !sandbox.unsandboxed && r.sandbox?.grant && round < MAX_GRANT_ROUNDS && !signal.aborted; round++) {
			const g = r.sandbox.grant;
			const key = JSON.stringify(g);
			if (asked.has(key)) break;
			asked.add(key);
			const answer = await this.askGrant(call.id, view, g, r.sandbox.blocked);
			if (answer === 'cancelled') return done(`${r.content}\n${INTERRUPTED}`, true);
			if (answer.deny) {
				r = { content: `${r.content}\n\n${answer.note ? `${SANDBOX_GRANT_SKIPPED} They said: ${answer.note}` : SANDBOX_GRANT_SKIPPED}`, isError: true };
				break;
			}
			sandbox.run.grant(g);
			const what = g.kind === 'domain' ? `network access to ${g.domains.join(', ')}` : `${g.access === 'read' ? 'read' : 'read/write'} access to ${g.path}`;
			this.log(`sandbox: the user allowed ${g.kind === 'domain' ? `${g.domains.length} domain(s)` : `${g.access} access to a path`} ${answer.saved ? 'and saved it to user settings' : 'for this session'}`);
			const again = await runTool(name, input, { cwd: this.cwd, env: this.init.env, signal, sandbox });
			r = { ...again, content: `The user allowed ${what} in the sandbox ${answer.saved ? '(saved to their settings)' : 'for this session'}; the command ran again.\n${again.content}` };
		}
		return done(r.content, r.isError);
	}

	/**
	 * "Allow sandbox path access and retry?" / "Retry … by allowing network access to …?" (retry.ts):
	 * asked in every mode, like leaving the sandbox. `saved`: the client wrote it to the user's
	 * settings first ("Allow for This User", `allow_user`); any other yes is for this session.
	 */
	private async askGrant(id: string, view: ToolView, g: SandboxGrant, blocked: Blocked[]): Promise<'cancelled' | { deny: true; note: string | null } | { deny: false; saved: boolean }> {
		const prompt = grantPrompt(g, this.sandbox!.home, blocked);
		let requestId = '';
		this.log(`sandbox: asking to allow ${g.kind === 'domain' ? 'network domains' : `${g.access} access to a path`} and retry`);
		const d = await this.askUser(id, view, {
			title: prompt.title,
			canAlways: false,
			detail: prompt.detail,
			sandboxGrant: grantWire(g, blocked),
			onRequest: (rid) => {
				requestId = rid;
				this.emit({ kind: 'guard_asked', request_id: rid, tool: view.name, tool_use_id: id, check: 'sandbox_retry', paths: g.kind === 'domain' ? g.domains : [g.path] });
			}
		});
		if (d === 'cancelled') return 'cancelled';
		if (d === 'deny') return { deny: true, note: this.takeNote(requestId) };
		return { deny: false, saved: d === 'allow_user' };
	}

	/**
	 * Whether the call may run: true, or why not (told to the model). `id`: its tool row (none for
	 * an MCP App's own call); `title`: the prompt's sentence when the user is asked.
	 */
	private async gate(id: string | null, view: ToolView, title: string | null = null): Promise<true | string> {
		// A sandboxed run's Bash call that asks to run outside the sandbox (VS Code's requestUnsandboxedExecution).
		const outside = !!this.sandbox && view.name === 'Bash' && view.input.requestUnsandboxedExecution === true;
		if (outside && !this.sandbox!.config.allowUnsandboxedCommands) return UNSANDBOXED_DISABLED;
		if (this.guards) {
			const verdict = this.guards.check(view.name, view.input);
			if (!verdict.allow) {
				// The check's name only: the command itself is never logged.
				this.log(`safety check blocked ${view.name} (${verdict.event.check}${verdict.event.threats.length ? `: ${verdict.event.threats.join(', ')}` : ''})`);
				this.emit({ kind: 'guard_blocked', tool_use_id: id, ...verdict.event });
				return verdict.reason;
			}
			const ask = outside ? null : this.guards.askFor(view.name, view.input);
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
		if (view.name === READ_SKILL && isSkillLoad(view.input.uri)) return this.skillConsent(id, view);
		const auto = arkaiDecision(this.mode, view.kind);
		if (outside) {
			if (auto === 'deny') return PLAN_DENIED;
			// Asked every time and in every mode, Allow all included: leaving the sandbox is the user's call.
			let requestId = '';
			const reason = typeof view.input.requestUnsandboxedExecutionReason === 'string' ? view.input.requestUnsandboxedExecutionReason.trim().slice(0, 500) : '';
			this.log('Bash asks to run outside the sandbox');
			const d = await this.askUser(id, view, {
				title: null,
				canAlways: false,
				detail: reason || null,
				onRequest: (rid) => {
					requestId = rid;
					this.emit({ kind: 'guard_asked', request_id: rid, tool: view.name, tool_use_id: id, check: 'unsandboxed', paths: [] });
				}
			});
			if (d === 'cancelled') return INTERRUPTED;
			if (d === 'deny') {
				const note = this.takeNote(requestId);
				return note ? `${UNSANDBOXED_DECLINED} They said: ${note}` : UNSANDBOXED_DECLINED;
			}
			if (id) this.unsandboxed.add(id);
			return true;
		}
		if (auto === 'allow') return true;
		if (auto === 'deny') return PLAN_DENIED;
		if (granted(this.grants, view)) return true;
		const rule = ruleFor(view);
		let requestId = '';
		const d = await this.askUser(id, view, { title, canAlways: true, rules: [rule.text], onRequest: (rid) => (requestId = rid) });
		if (d === 'cancelled') return INTERRUPTED;
		if (d === 'deny') {
			const note = this.takeNote(requestId);
			return note ? `${DENIED} They said: ${note}` : DENIED;
		}
		// Every "always" answer lasts for this run only: Arkai keeps no settings file of rules.
		if (d !== 'allow') this.grants.add(rule.key);
		return true;
	}

	/**
	 * Loading an MCP server's skill: asked per server (VS Code's "Allow Skills from <server>?"),
	 * in every permission mode; Allow all declines as VS Code's Autopilot does. "Always" lasts
	 * for this run.
	 */
	private async skillConsent(id: string | null, view: ToolView): Promise<true | string> {
		const rule = ruleFor(view);
		if (this.grants.has(rule.key)) return true;
		if (this.mode === 'bypassPermissions') return SKILL_BYPASS_DECLINED;
		const server = String(view.input.server ?? '');
		let requestId = '';
		const d = await this.askUser(id, view, { title: `Allow skills from ${server}?`, canAlways: true, rules: [rule.text], onRequest: (rid) => (requestId = rid) });
		if (d === 'cancelled') return INTERRUPTED;
		if (d === 'deny') {
			const note = this.takeNote(requestId);
			return note ? `${SKILL_DECLINED} They said: ${note}` : SKILL_DECLINED;
		}
		if (d !== 'allow') this.grants.add(rule.key);
		return true;
	}

	// -------------------------------------------------------------------------------------------
	// Model routers

	/** The efforts a model of this provider takes (none when it has no reasoning knob). */
	private effortsOf = (model: string): Effort[] => (arkaiEffortKind(this.provider.api, this.provider.baseUrl, model) ? ['low', 'medium', 'high', 'xhigh', 'max'] : []);

	/** Loads the chat's router; a string says why it cannot be used. */
	private loadRouter(): string | null {
		const name = modelRouterNameOf(this.routerModel!);
		const dir = join(this.init.env.HOME || homedir(), '.agents', MODEL_ROUTER_FOLDER);
		const parsed = loadModelRouter(dir, name, { readdir: (d) => readdirSync(d), readFile: (f) => readFileSync(f, 'utf8') });
		if (!parsed) return `The model router ${name} was not found in ~/.agents/${MODEL_ROUTER_FOLDER}.`;
		if (!parsed.router) return `The model router ${name} has a problem: ${parsed.diagnostics.find((d) => d.severity === 'error')?.message ?? 'it could not be read'}`;
		const { routes, skipped } = resolveModelRouter(parsed.router, (this.provider.models ?? []).map((m) => m.id), this.provider.id, this.effortsOf);
		if (!routes.length) return `None of the models in the model router ${modelRouterLabel(parsed.router)} are available at ${this.provider.name}.`;
		this.router = { router: parsed.router, routes, skipped };
		if (skipped.length) this.log(`model router ${name}: ${skipped.length} route(s) have no model at ${this.provider.id}`);
		return null;
	}

	/** The chat's earlier prompts and final answers, oldest first (what a follow-up decision sees). */
	private recentTurns(): { prompt: string; response: string }[] {
		const out: { prompt: string; response: string }[] = [];
		for (const m of this.messages) {
			if (m.role === 'user' && m.text !== NUDGE) out.push({ prompt: m.text.slice(0, 4000), response: '' });
			else if (m.role === 'assistant' && out.length && m.text.trim()) out[out.length - 1]!.response = m.text.slice(0, 4000);
		}
		return out;
	}

	/** Picks this turn's model, effort and guidance from the router; a string: the turn cannot run. */
	private async routeThisTurn(turn: Turn): Promise<string | null> {
		if (!this.router) {
			const failed = this.loadRouter();
			if (failed) return failed;
		}
		const { router, routes } = this.router!;
		const recent = this.recentTurns();
		const abort = (this.abort = new AbortController());
		let decision;
		try {
			decision = await routeTurn({
				router,
				routes,
				text: turn.text,
				hasImages: turn.images.length > 0,
				previous: this.routerState,
				recentTurns: recent,
				turns: recent.length,
				// The decision runs on the router's first model (the user's own provider; VS Code asks Copilot's).
				picker: chatModelPicker(this.client, routes[0]!.model),
				signal: abort.signal,
				log: (line) => this.log(line)
			});
		} catch {
			return INTERRUPTED;
		}
		const { route, effort, how } = decision;
		const switched = this.routerState && this.routerState.route !== routeKey(route);
		this.routerState = {
			router: router.name,
			route: routeKey(route),
			model: route.model,
			...(effort ? { effort } : {}),
			turnsSinceSwitch: how === 'kept' ? (this.routerState?.turnsSinceSwitch ?? 0) + 1 : 0
		};
		if (this.modelId !== route.model) this.calibration = 1;
		this.modelId = route.model;
		this.routedEffort = effort;
		this.routerBriefing = modelRouterBriefing(router, route);
		// The decision's numbers, never the message.
		this.log(`model router ${router.name}: ${switched ? 'switched' : how} ${routeKey(route)} (${route.model}${effort ? `, effort ${effort}` : ''})${decision.by ? ` by ${decision.by}` : ''}${decision.pick ? ` p=${JSON.stringify(decision.pick.probabilities)}` : ''}`);
		for (const n of decision.notices) this.emit({ kind: 'stderr', line: n });
		return null;
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
