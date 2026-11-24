// An ACP agent (Agent Client Protocol, protocol version 1: JSON-RPC 2.0 over stdio) as a chat
// run: Gemini CLI (`gemini --acp`), Qwen Code, OpenCode (`opencode acp`), goose, Cursor, Hermes,
// Kiro, Auggie and the other agents Rust knows (agent/runtimes.rs `KNOWN`, Orca's ACP launch
// specs), or any agent the user configures by command.
//
// - Handshake: `initialize` (no fs or terminal support offered, like old Kingu's host: the agent
//   reads and writes files itself, and OpenCode would repeat each approved edit as a write), then
//   `session/new`, or `session/load` / `session/resume` to continue a chat. History an agent
//   replays while loading is dropped: the chat has its own transcript.
// - `session/update`: message and thought chunks stream as `delta`s, tool calls become the chat's
//   tool rows (acpToolView), a `plan` becomes a TodoWrite row (the todo bar), commands the agent
//   offers become the composer's `/` list, `usage_update` the context ring.
// - `session/request_permission` goes through Kingu's safety check and permission mode first,
//   then to the user; the answer is the agent's own allow / reject option.
// - Per-agent differences (acpDialects.ts, Orca's dialects): an agent that enforces its own
//   permission mode (Droid, Kimi, Hermes, Qwen Code, goose) gets Kingu's mode written to it by its
//   own id; commands that would work behind the chat's back are withheld.
// - Before an edit tool call runs, the files it names are snapshotted (the working set); files it
//   changes without naming them are found by Rust's end-of-turn git check.
// - Reasoning effort (../effort.ts): only an agent whose session advertises a `thought_level`
//   config option; its levels go out as `effort_options`, the chat's pick via
//   `session/set_config_option`. Without one the chat shows no effort picker.
// - Sign-in (acpSignIn.ts): an agent whose dialect says how to sign it in does not fail its start
//   when signed out: the run waits on a `sign_in` event for the chat's Sign in — ACP
//   `authenticate` (Antigravity's server runs Google's OAuth itself; its link is shown, never
//   followed by Kingu) or the agent's own login in a terminal — then opens the session again.

import pkg from '../../package.json' with { type: 'json' };
import { RpcCallError, JsonRpcPeer, linesOf } from './rpc.ts';
import { ProcessSession, OPEN_TIMEOUT_MS, SessionError, UNSUPPORTED, spawnChild, type SpawnFn, type TurnEnd } from './session.ts';
import { acpMcpServers, acpOptionFor, acpOptions, acpToolOutput, acpToolView, agentModeFor, isObj, num, planTodos, str } from './tools.ts';
import { acpDialect, enforcedMode, modeSetting, withheldCommand } from './acpDialects.ts';
import { readSignInLine, SIGN_IN_TIMEOUT_MS, type SignInState } from './acpSignIn.ts';
import { acpThoughtLevels, type Effort } from '../effort.ts';
import { BROWSER_SERVER } from '../browser.ts';
import { modelOptions } from '../normalize.ts';
import type { ModelOption, PermissionMode } from '../protocol.ts';

export const ACP_PROTOCOL_VERSION = 1;
/** JSON-RPC error the ACP spec uses for "sign in first". */
const AUTH_REQUIRED = -32000;

type Obj = Record<string, unknown>;

/**
 * The agent's model setting (ACP session config options, category `model`, v1 names the field
 * `id` and v2 `configId`): the choices and the one in effect. Null when the agent advertises none.
 */
function modelSetting(configOptions: unknown): { configId: string; choices: { value: string; name: string }[]; current: string | null } | null {
	if (!Array.isArray(configOptions)) return null;
	for (const o of configOptions) {
		if (!o || typeof o !== 'object') continue;
		const opt = o as Record<string, unknown>;
		const configId = typeof opt.id === 'string' ? opt.id : typeof opt.configId === 'string' ? opt.configId : null;
		if (opt.category !== 'model' || !configId || !Array.isArray(opt.options)) continue;
		// Options may come flat or in groups (`{group, options}`).
		const flat = opt.options.flatMap((x) => (x && typeof x === 'object' && Array.isArray((x as { options?: unknown }).options) ? (x as { options: unknown[] }).options : [x]));
		const choices = flat.filter((x): x is { value: string; name: string } => !!x && typeof x === 'object' && typeof (x as { value?: unknown }).value === 'string').map((x) => ({ value: (x as { value: string }).value, name: typeof (x as { name?: unknown }).name === 'string' ? (x as { name: string }).name : String((x as { value?: unknown }).value) }));
		if (!choices.length) continue;
		const current = typeof opt.currentValue === 'string' ? (choices.find((c) => c.value === opt.currentValue)?.value ?? null) : null;
		return { configId, choices, current };
	}
	return null;
}

/**
 * Models from the older `session/new` field (`models.availableModels`, before ACP config options):
 * `{modelId, name, description}` each. Switching them is `session/set_model`.
 */
function legacyModels(models: unknown): { value: string; name: string; description: string }[] {
	if (!isObj(models) || !Array.isArray(models.availableModels)) return [];
	return models.availableModels.flatMap((m) => {
		const value = isObj(m) ? str(m.modelId) : null;
		return value ? [{ value, name: str(m.name) ?? value, description: str(m.description) ?? '' }] : [];
	});
}

/**
 * The agent's model choices before its first run (`host`'s `list_models`, a new chat's picker):
 * a throwaway process, one handshake up to `session/new` — where the config options arrive — and
 * no turn runs. `session/new` is the earliest point ACP names the models.
 */
export async function probeModels(spawn: SpawnFn | undefined, command: string, args: string[], cwd: string, env: Record<string, string | undefined> = {}): Promise<ModelOption[]> {
	const child = (spawn ?? spawnChild)([command, ...args], { cwd, env });
	const peer = new JsonRpcPeer({ write: (line) => void child.stdin.write(line), lines: linesOf(child.stdout) }, { header: true });
	try {
		const init = await peer.request<Obj>(
			'initialize',
			{ protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'kingu', title: 'Kingu', version: pkg.version } },
			OPEN_TIMEOUT_MS
		);
		if (num(init?.protocolVersion) !== ACP_PROTOCOL_VERSION) throw new Error(`the agent speaks ACP version ${String(init?.protocolVersion)}, Kingu speaks ${ACP_PROTOCOL_VERSION}`);
		const meta = acpDialect(command).sessionMeta;
		const r = await peer.request<Obj>('session/new', { cwd, mcpServers: [], ...(meta ? { _meta: meta } : {}) }, OPEN_TIMEOUT_MS);
		const models = modelSetting(r?.configOptions);
		if (models) return modelOptions(models.choices.map((c) => ({ value: c.value, displayName: c.name, description: '' })));
		return modelOptions(legacyModels(r?.models).map((m) => ({ value: m.value, displayName: m.name, description: m.description })));
	} finally {
		child.kill();
	}
}

export class AcpSession extends ProcessSession {
	private caps: Obj = {};
	/** Replayed history (`session/load`) is not shown again. */
	private loading = false;
	private models: Obj | null = null;
	private modes: Obj | null = null;
	/** The session's config options (the agent's own model / thought level knobs). */
	private configOptions: unknown = null;
	/** The agent's thought level setting (session config options), when it has one. */
	private thought: ReturnType<typeof acpThoughtLevels> = null;
	private planRows = 0;
	/** Tool call fields merged over `tool_call` and its updates. */
	private calls = new Map<string, Obj>();
	/** The skill index (../skills.ts) goes before the run's first message: ACP has no instructions field. */
	private skillsSent = false;
	/** What this agent does differently (acpDialects.ts), by its program. */
	private readonly dialect = acpDialect(this.init.command, this.init.env);
	/** This turn's reply was the agent's own failure notice (acpDialects.ts `failureNotice`). */
	private failedNotice: string | null = null;
	/** Agent mode values already reported as not offered (one notice each). */
	private readonly unoffered = new Set<string>();
	/** The sign-in methods `initialize` named (ids). */
	private authMethods: string[] = [];
	/** While the session waits for the chat's Sign in (acpSignIn.ts). */
	private signInGate: { resolve: () => void; reject: (e: Error) => void } | null = null;
	/** An `authenticate` is running. */
	private authenticating = false;
	/** The sign-in link already shown (the printed line and the browser helper may both report it). */
	private shownLink: string | null = null;
	/** The chat was told to sign in during this start. */
	private askedSignIn = false;

	protected peerOptions() {
		return { header: true };
	}

	protected async open() {
		const init = await this.peer.request<Obj>(
			'initialize',
			{ protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'kingu', title: 'Kingu', version: pkg.version } },
			OPEN_TIMEOUT_MS
		);
		if (num(init?.protocolVersion) !== ACP_PROTOCOL_VERSION) throw new Error(`the agent speaks ACP version ${String(init?.protocolVersion)}, Kingu speaks ${ACP_PROTOCOL_VERSION}`);
		this.caps = isObj(init.agentCapabilities) ? init.agentCapabilities : {};
		this.authMethods = Array.isArray(init.authMethods) ? init.authMethods.flatMap((m) => (isObj(m) && typeof m.id === 'string' ? [m.id] : [])) : [];
		const mcpServers = acpMcpServers(this.init.mcpServers, this.caps.mcpCapabilities);
		// Kingu's browser tools (../browserMcp.ts): only over HTTP, whose secret goes in a header on
		// this stdio; a stdio server would need it in its env or argv.
		const grant = this.init.browserMcp;
		if (grant && !(BROWSER_SERVER in this.init.mcpServers)) {
			if (isObj(this.caps.mcpCapabilities) && this.caps.mcpCapabilities.http === true) mcpServers.push({ type: 'http', name: BROWSER_SERVER, url: grant.url, headers: Object.entries(grant.headers).map(([name, value]) => ({ name, value })) });
			else this.log('browser tools left out: this agent takes no HTTP MCP servers');
		}
		const meta = this.dialect.sessionMeta;
		const base = { cwd: this.cwd, mcpServers, ...(meta ? { _meta: meta } : {}) };
		for (let tries = 0; ; tries++) {
			try {
				await this.openSession(base);
				break;
			} catch (e) {
				if (!this.signedOut(e)) throw e;
				const via = this.dialect.signIn;
				if (!via || this.stopped) throw new Error(this.signInMessage(e));
				if (via.via === 'browser' && this.authMethods.length && !this.authMethods.includes(via.method)) throw new Error(`${this.label()} does not offer this sign-in (${via.method}): update it, then start the chat again.`);
				await this.awaitSignIn(tries ? `${this.label()} is still not signed in.` : undefined);
			}
		}
		if (this.askedSignIn) this.signInEvent('signed_in');
		// An agent that enforces its own mode starts in Kingu's, or not at all (Orca: fail startup
		// rather than silently use a different permission mode).
		await this.applyMode(this.mode, true);
		this.reportModels();
		if (this.thought) {
			if (this.effort && this.effort !== this.thought.current) await this.effortChanged(this.effort).catch((e) => this.log(`effort not passed on: ${e instanceof Error ? e.message : 'error'}`));
			this.reportEffort();
		}
	}

	/** `session/new`, or `session/load` / `session/resume` to continue a chat. */
	private async openSession(base: Obj) {
		{
			const resume = this.init.resume;
			const sessionCaps = isObj(this.caps.sessionCapabilities) ? this.caps.sessionCapabilities : {};
			if (resume && this.caps.loadSession === true) {
				this.loading = true;
				try {
					this.session(await this.peer.request<Obj>('session/load', { ...base, sessionId: resume }, OPEN_TIMEOUT_MS));
				} finally {
					this.loading = false;
				}
				this.sessionId = resume;
			} else if (resume && sessionCaps.resume) {
				this.session(await this.peer.request<Obj>('session/resume', { ...base, sessionId: resume }, OPEN_TIMEOUT_MS));
				this.sessionId = resume;
			} else {
				if (resume) this.emit({ kind: 'stderr', line: 'this agent cannot continue an earlier session: a new one was started' });
				const r = await this.peer.request<Obj>('session/new', base, OPEN_TIMEOUT_MS);
				this.sessionId = str(r?.sessionId);
				if (!this.sessionId) throw new Error('the agent opened no session');
				this.session(r);
			}
		}
	}

	private label() {
		return this.dialect.label ?? this.program();
	}

	private signInEvent(state: SignInState, extra: { url?: string; error?: string } = {}) {
		const via = this.dialect.signIn;
		if (!via) return;
		this.emit({ kind: 'sign_in', state, via: via.via, agent: this.label(), ...(via.via === 'terminal' ? { login: via.login } : via.method !== 'oauth-personal' ? { method: via.method } : {}), ...extra });
	}

	/** Tells the chat to sign in and waits for its Sign in (`signIn`), or for the run to stop. */
	private awaitSignIn(error?: string) {
		this.askedSignIn = true;
		this.log('waiting for a sign-in');
		this.signInEvent('required', error ? { error } : {});
		return new Promise<void>((resolve, reject) => (this.signInGate = { resolve, reject }));
	}

	/**
	 * The chat's Sign in. `browser`: ACP `authenticate` with the dialect's method; the agent runs
	 * the sign-in itself and its link arrives as a `waiting` event. `terminal`: the user signed in
	 * from a terminal, so the session is asked for again. Answers at once; the outcome is events.
	 */
	async signIn(): Promise<null> {
		const gate = this.signInGate;
		const via = this.dialect.signIn;
		if (!gate || !via) throw new SessionError(UNSUPPORTED, 'this agent is not waiting for a sign-in');
		if (via.via === 'terminal') {
			this.signInGate = null;
			this.signInEvent('verifying');
			gate.resolve();
			return null;
		}
		if (this.authenticating) return null;
		this.authenticating = true;
		this.shownLink = null;
		this.signInEvent('starting');
		this.peer.request('authenticate', { methodId: via.method }, SIGN_IN_TIMEOUT_MS).then(
			() => {
				this.authenticating = false;
				if (this.signInGate !== gate) return;
				this.signInGate = null;
				this.signInEvent('verifying');
				gate.resolve();
			},
			(e) => {
				this.authenticating = false;
				if (this.signInGate !== gate || this.exited || this.stopped) return;
				this.signInEvent('failed', { error: e instanceof Error ? e.message : String(e) });
			}
		);
		return null;
	}

	/** The sign-in link in the agent's output: shown on the chat's card, never as agent output. */
	protected outputLine(line: string, source: 'stdout' | 'stderr') {
		if (this.dialect.signIn?.via !== 'browser') return false;
		const link = readSignInLine(line, source);
		if (link === undefined) return false;
		if (link === null) this.log('a sign-in link that is not a Google sign-in to this computer was not shown');
		else if (this.authenticating && link !== this.shownLink) {
			this.shownLink = link;
			this.signInEvent('waiting', { url: link });
		}
		return true;
	}

	/**
	 * Stop while the chat waits for a sign-in: no session is open yet, so there is none to keep and
	 * no turn to cancel. The run ends, as Stop does on the sign-in card (`stop`).
	 */
	override async interrupt() {
		if (this.signInGate) return this.stop();
		return super.interrupt();
	}

	protected closed() {
		const gate = this.signInGate;
		this.signInGate = null;
		gate?.reject(new Error('the run ended before signing in'));
		super.closed();
	}

	/** The agent's model choices (session config options, category `model`, else the older `models` field), as a `models` event. */
	private reportModels() {
		const m = modelSetting(this.configOptions);
		if (m) {
			this.emit({ kind: 'models', models: m.choices.map((c) => ({ value: c.value, display_name: c.name, description: '' })) });
			this.models = { currentModelId: m.current, availableModels: m.choices };
			return;
		}
		const legacy = legacyModels(this.models);
		if (legacy.length) this.emit({ kind: 'models', models: legacy.map((c) => ({ value: c.value, display_name: c.name, description: c.description })) });
	}

	private async modelChanged(value: string) {
		const m = modelSetting(this.configOptions);
		if (!m) {
			if (!legacyModels(this.models).some((c) => c.value === value)) throw new Error('this agent has no model to switch to');
			await this.peer.request('session/set_model', { sessionId: this.sessionId, modelId: value }, OPEN_TIMEOUT_MS);
			this.models = { ...this.models, currentModelId: value };
			return;
		}
		const r = await this.peer.request<Obj>('session/set_config_option', { sessionId: this.sessionId, configId: m.configId, value }, OPEN_TIMEOUT_MS);
		this.models = { currentModelId: value, availableModels: m.choices };
		if (Array.isArray(r?.configOptions)) {
			this.configOptions = r.configOptions;
			this.thought = acpThoughtLevels(r.configOptions);
		}
	}

	/** Another runtime's model (and mode / effort) change, from the chat's pickers. */
	async setOptions(model: string | undefined, mode: PermissionMode | undefined, _extra?: unknown, effort?: Effort) {
		if (model !== undefined) {
			await this.modelChanged(model).catch((e) => {
				throw new SessionError(UNSUPPORTED, e instanceof Error ? e.message : String(e));
			});
		}
		return super.setOptions(undefined, mode, _extra, effort);
	}

	/** The levels the agent offers (none: the chat hides its effort picker). */
	private reportEffort() {
		this.emit({ kind: 'effort_options', levels: this.thought ? [...this.thought.values.keys()] : [], current: this.thought?.current ?? null });
	}

	protected async effortChanged(effort: Effort) {
		const t = this.thought;
		const value = t?.values.get(effort);
		if (!t || !value) throw new Error(`this agent has no ${effort} reasoning level`);
		const r = await this.peer.request<Obj>('session/set_config_option', { sessionId: this.sessionId, configId: t.configId, value }, OPEN_TIMEOUT_MS);
		this.thought = acpThoughtLevels(r?.configOptions) ?? { ...t, current: effort };
	}

	private program() {
		return this.init.command.split('/').pop() ?? 'agent';
	}

	/** ACP's "auth required", or the agent's own way of saying it (acpDialects.ts). */
	private signedOut(e: unknown): e is RpcCallError {
		return e instanceof RpcCallError && (e.code === AUTH_REQUIRED || this.dialect.authRequired?.(e.code, e.data) === true);
	}

	/**
	 * English, like every message of the host (it knows no UI language): the chat shows this
	 * sentence in the UI's language (desktop chatParts.ts `hostErrorText`), the agent's own words after it.
	 */
	private signInMessage(e: RpcCallError) {
		return `Sign in to ${this.program()} in a terminal first. ${e.message}`;
	}

	/** What a new / loaded session says about itself: its modes and models. */
	private session(r: Obj | null) {
		if (!isObj(r)) return;
		if (isObj(r.modes)) this.modes = r.modes;
		if (isObj(r.models)) this.models = r.models;
		if (Array.isArray(r.configOptions)) {
			this.configOptions = r.configOptions;
			this.thought = acpThoughtLevels(r.configOptions);
		}
	}

	protected model() {
		return str(this.models?.currentModelId);
	}

	private async setAgentMode(modeId: string) {
		await this.peer.request('session/set_mode', { sessionId: this.sessionId, modeId }, OPEN_TIMEOUT_MS);
		if (this.modes) this.modes = { ...this.modes, currentModeId: modeId };
	}

	protected async modeChanged(mode: PermissionMode) {
		await this.applyMode(mode, false);
	}

	/**
	 * Kingu's permission mode as the agent's own. An agent that enforces its mode itself
	 * (`dialect.modes`, Orca's permissionModeConfig) gets its own value for it, through its mode
	 * config option (confirmed from the reply: a mode that did not take is an error, not a guess),
	 * else `session/set_mode`. A value this release does not offer cannot be set: the chat says so,
	 * since the agent then decides by its own configuration. Any other agent: a session mode it has
	 * by one of the usual ids, as before.
	 */
	private async applyMode(mode: PermissionMode, starting: boolean) {
		const available = this.modes?.availableModes;
		const enforced = this.dialect.modes;
		if (!enforced) {
			const modeId = agentModeFor(mode, available) ?? (starting ? null : agentModeFor('default', available));
			if (modeId && modeId !== this.modes?.currentModeId) await this.setAgentMode(modeId);
			return;
		}
		const knob = modeSetting(this.configOptions);
		const ids = (Array.isArray(available) ? available.filter(isObj) : []).map((m) => str(m.id));
		// Plan is Kingu's own (it denies what would change things); the agent's `plan` mode when it has one, else its ask mode.
		const plan = mode === 'plan' && (knob?.values.includes('plan') || ids.includes('plan')) ? 'plan' : null;
		const value = plan ?? enforcedMode(enforced, mode) ?? enforced.ask;
		if (knob?.values.includes(value)) {
			if (knob.current === value) return;
			const r = await this.peer.request<Obj>('session/set_config_option', { sessionId: this.sessionId, configId: knob.configId, value }, OPEN_TIMEOUT_MS);
			if (modeSetting(r?.configOptions)?.current !== value) throw new Error(`${this.program()} did not confirm its "${value}" permission mode`);
			this.configOptions = r.configOptions;
			this.thought = acpThoughtLevels(r.configOptions);
			return;
		}
		if (ids.includes(value)) {
			if (value !== this.modes?.currentModeId) await this.setAgentMode(value);
			return;
		}
		if (this.unoffered.has(value)) return;
		this.unoffered.add(value);
		this.emit({
			kind: 'stderr',
			line: `${this.program()} does not offer its "${value}" permission mode here, so Kingu could not set it: the agent follows its own configuration and may ask more, or less, than this chat's mode says`
		});
	}

	protected async prompt(turn: { text: string; images: { source: { media_type: string; data: string } }[] }): Promise<TurnEnd> {
		const promptCaps = isObj(this.caps.promptCapabilities) ? this.caps.promptCapabilities : {};
		const images = promptCaps.image === true ? turn.images : [];
		if (turn.images.length && !images.length) this.emit({ kind: 'stderr', line: 'this agent does not take images: they were left out' });
		// A command that would empty the agent's session under this chat, or lift its permission mode (acpDialects.ts).
		const withheld = withheldCommand(this.dialect, turn.text);
		if (withheld) return { ok: false, error: `/${withheld} is not available in a Kingu chat: it would change ${this.program()}'s session behind the chat. Start a new chat, or change the permission mode here.` };
		const skills = !this.skillsSent && this.init.skillIndex ? [{ type: 'text', text: this.init.skillIndex }] : [];
		this.skillsSent = true;
		const prompt = [...skills, ...images.map((i) => ({ type: 'image', mimeType: i.source.media_type, data: i.source.data })), { type: 'text', text: turn.text }];
		this.failedNotice = null;
		const r = await this.peer.request<Obj>('session/prompt', { sessionId: this.sessionId, prompt }).catch((e) => {
			// The agent's own "not signed in" (goose, Gemini, OMP, Auggie) reads as that, not as a bare RPC error.
			if (e instanceof RpcCallError && this.dialect.authRequired?.(e.code, e.data)) throw new Error(this.signInMessage(e));
			throw e;
		});
		const stop = str(r?.stopReason) ?? 'end_turn';
		const notice = this.failedNotice;
		this.failedNotice = null;
		if (notice && stop !== 'cancelled') return { ok: false, error: notice };
		switch (stop) {
			case 'end_turn':
				return { ok: true };
			case 'cancelled':
				return { ok: false, cancelled: true };
			case 'refusal':
				return { ok: false, error: 'the agent refused this request' };
			case 'max_tokens':
				return { ok: false, error: 'the agent reached its token limit' };
			case 'max_turn_requests':
				return { ok: false, error: 'the agent reached its limit of requests for one turn' };
			default:
				return { ok: true };
		}
	}

	protected async cancel() {
		if (this.sessionId) this.peer.notify('session/cancel', { sessionId: this.sessionId });
	}

	protected onNotification(method: string, params: unknown) {
		if (method !== 'session/update' || !isObj(params) || !isObj(params.update)) return;
		if (this.sessionId && params.sessionId !== this.sessionId) return;
		const u = params.update;
		const kind = str(u.sessionUpdate);
		if (kind === 'available_commands_update') return this.commands(u.availableCommands);
		if (kind === 'config_option_update') {
			if (Array.isArray(u.configOptions)) {
				// Kept whole: the mode option's current value is what a mode change compares with.
				this.configOptions = u.configOptions;
				this.thought = acpThoughtLevels(u.configOptions);
				this.reportEffort();
			}
			return;
		}
		if (kind === 'current_mode_update') {
			if (this.modes && str(u.currentModeId)) this.modes = { ...this.modes, currentModeId: u.currentModeId };
			return;
		}
		if (this.loading) return;
		switch (kind) {
			case 'agent_message_chunk':
				if (isObj(u.content) && u.content.type === 'text') {
					const text = str(u.content.text) ?? '';
					// The agent's failure notice as the whole chunk: the turn fails with it, not answers it.
					if (this.dialect.failureNotice?.test(text)) this.failedNotice = text.trim();
					else this.appendText(text);
				}
				return;
			case 'agent_thought_chunk':
				if (isObj(u.content) && u.content.type === 'text') this.appendThinking(str(u.content.text) ?? '');
				return;
			case 'tool_call':
			case 'tool_call_update':
				return this.toolCall(u);
			case 'plan': {
				const id = `plan-${++this.planRows}`;
				this.toolStarted(id, { name: 'TodoWrite', kind: 'think', paths: [], input: planTodos(u.entries) });
				this.toolFinished(id, '', false);
				return;
			}
			case 'usage_update': {
				const used = num(u.used);
				const size = num(u.size);
				if (used !== null && size) this.emit({ kind: 'context_usage', used_tokens: Math.round(used), max_tokens: Math.round(size) });
				return;
			}
			default:
				// user_message_chunk (the chat shows the sent message), session_info_update, …
				return;
		}
	}

	private commands(list: unknown) {
		const commands = (Array.isArray(list) ? list.filter(isObj) : []).flatMap((c) => {
			const name = str(c.name)?.replace(/^\//, '');
			if (!name || this.dialect.withheld?.includes(name.toLowerCase())) return [];
			return [{ name, description: str(c.description) ?? '', argument_hint: isObj(c.input) ? (str(c.input.hint) ?? '') : '' }];
		});
		this.emit({ kind: 'commands', commands });
	}

	/** Fields of `update` merged over what the tool call had (an update only sends what changed). */
	private merge(update: Obj): { id: string; call: Obj } | null {
		const id = str(update.toolCallId);
		if (!id) return null;
		const prev = this.calls.get(id) ?? {};
		const call: Obj = { ...prev };
		for (const [k, v] of Object.entries(update)) if (v !== undefined && v !== null && k !== 'sessionUpdate') call[k] = v;
		this.calls.set(id, call);
		return { id, call };
	}

	private toolCall(update: Obj) {
		const m = this.merge(update);
		if (!m) return;
		const status = str(m.call.status);
		const done = status === 'completed' || status === 'failed';
		this.toolStarted(m.id, acpToolView(m.call, this.cwd), !done);
		if (done) this.toolFinished(m.id, acpToolOutput(m.call), status === 'failed');
	}

	protected async onRequest(method: string, params: unknown): Promise<unknown> {
		if (method === 'session/request_permission' && isObj(params)) return this.permission(params);
		// The agent's own requests that only need an answer for the turn to go on (acpDialects.ts).
		const settled = this.dialect.settle?.(method);
		if (settled !== undefined) return settled;
		// fs/* and terminal/*: not offered in `initialize`.
		throw new RpcCallError(-32601, `method not found: ${method}`);
	}

	private async permission(params: Obj) {
		const cancelled = { outcome: { outcome: 'cancelled' } };
		if (this.sessionId && params.sessionId !== this.sessionId) return cancelled;
		const options = acpOptions(params.options);
		const m = isObj(params.toolCall) ? this.merge(params.toolCall) : null;
		const view = acpToolView(m?.call ?? {}, this.cwd);
		if (m) this.toolStarted(m.id, view);
		const title = str(m?.call.title);
		const canAlways = options.some((o) => o.kind === 'allow_always');
		// A question dressed as a permission request (Hermes) is the person's to answer in every mode.
		const decision = m && this.dialect.userOnly?.(m.id) ? await this.askUser(m.id, view, { title, canAlways }) : await this.ask(m?.id ?? null, view, title, canAlways);
		if (decision === 'cancelled') return cancelled;
		const optionId = acpOptionFor(decision, options);
		return optionId ? { outcome: { outcome: 'selected', optionId } } : cancelled;
	}
}
