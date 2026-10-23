// An ACP agent (Agent Client Protocol, protocol version 1: JSON-RPC 2.0 over stdio) as a chat
// run: Gemini CLI (`gemini --experimental-acp`), Qwen Code, OpenCode (`opencode acp`), goose,
// or any agent the user configures by command.
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
// - Before an edit tool call runs, the files it names are snapshotted (the working set); files it
//   changes without naming them are found by Rust's end-of-turn git check.
// - Reasoning effort (../effort.ts): only an agent whose session advertises a `thought_level`
//   config option; its levels go out as `effort_options`, the chat's pick via
//   `session/set_config_option`. Without one the chat shows no effort picker.

import pkg from '../../package.json' with { type: 'json' };
import { RpcCallError, JsonRpcPeer, linesOf } from './rpc.ts';
import { ProcessSession, OPEN_TIMEOUT_MS, SessionError, UNSUPPORTED, spawnChild, type SpawnFn, type TurnEnd } from './session.ts';
import { acpMcpServers, acpOptionFor, acpOptions, acpToolOutput, acpToolView, agentModeFor, isObj, num, planTodos, str } from './tools.ts';
import { acpThoughtLevels, type Effort } from '../effort.ts';
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
		const r = await peer.request<Obj>('session/new', { cwd, mcpServers: [] }, OPEN_TIMEOUT_MS);
		const models = modelSetting(r?.configOptions);
		return models ? modelOptions(models.choices.map((c) => ({ value: c.value, displayName: c.name, description: '' }))) : [];
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
		const mcpServers = acpMcpServers(this.init.mcpServers, this.caps.mcpCapabilities);
		const base = { cwd: this.cwd, mcpServers };
		try {
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
				this.session(r);			}
		} catch (e) {
			if (e instanceof RpcCallError && e.code === AUTH_REQUIRED) {
				throw new Error(`ต้องลงชื่อเข้าใช้ ${this.program()} ก่อน: เปิดในเทอร์มินัลแล้วลงชื่อเข้าใช้ (Sign in to ${this.program()} in a terminal first.) ${e.message}`);
			}
			throw e;
		}
		const modeId = agentModeFor(this.mode, this.modes?.availableModes);
		if (modeId && modeId !== this.modes?.currentModeId) await this.setAgentMode(modeId);
		this.reportModels();
		if (this.thought) {
			if (this.effort && this.effort !== this.thought.current) await this.effortChanged(this.effort).catch((e) => this.log(`effort not passed on: ${e instanceof Error ? e.message : 'error'}`));
			this.reportEffort();
		}
	}

	/** The agent's model choices (session config options, category `model`), as a `models` event. */
	private reportModels() {
		const m = modelSetting(this.configOptions);
		// shortcut: an agent advertising models only in the legacy `models` field of session/new gets no picker
		if (!m) return;
		this.emit({ kind: 'models', models: m.choices.map((c) => ({ value: c.value, display_name: c.name, description: '' })) });
		this.models = { currentModelId: m.current, availableModels: m.choices };
	}

	private async modelChanged(value: string) {
		const m = modelSetting(this.configOptions);
		if (!m) throw new Error('this agent has no model to switch to');
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
		const modeId = agentModeFor(mode, this.modes?.availableModes) ?? agentModeFor('default', this.modes?.availableModes);
		if (modeId && modeId !== this.modes?.currentModeId) await this.setAgentMode(modeId);
	}

	protected async prompt(turn: { text: string; images: { source: { media_type: string; data: string } }[] }): Promise<TurnEnd> {
		const promptCaps = isObj(this.caps.promptCapabilities) ? this.caps.promptCapabilities : {};
		const images = promptCaps.image === true ? turn.images : [];
		if (turn.images.length && !images.length) this.emit({ kind: 'stderr', line: 'this agent does not take images: they were left out' });
		const skills = !this.skillsSent && this.init.skillIndex ? [{ type: 'text', text: this.init.skillIndex }] : [];
		this.skillsSent = true;
		const prompt = [...skills, ...images.map((i) => ({ type: 'image', mimeType: i.source.media_type, data: i.source.data })), { type: 'text', text: turn.text }];
		const r = await this.peer.request<Obj>('session/prompt', { sessionId: this.sessionId, prompt });
		const stop = str(r?.stopReason) ?? 'end_turn';
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
				if (isObj(u.content) && u.content.type === 'text') this.appendText(str(u.content.text) ?? '');
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
			if (!name) return [];
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
		const decision = await this.ask(m?.id ?? null, view, title, options.some((o) => o.kind === 'allow_always'));
		if (decision === 'cancelled') return cancelled;
		const optionId = acpOptionFor(decision, options);
		return optionId ? { outcome: { outcome: 'selected', optionId } } : cancelled;
	}
}
