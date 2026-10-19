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

import pkg from '../../package.json' with { type: 'json' };
import { RpcCallError } from './rpc.ts';
import { ProcessSession, OPEN_TIMEOUT_MS, type TurnEnd } from './session.ts';
import { acpMcpServers, acpOptionFor, acpOptions, acpToolOutput, acpToolView, agentModeFor, isObj, num, planTodos, str } from './tools.ts';
import type { PermissionMode } from '../protocol.ts';

export const ACP_PROTOCOL_VERSION = 1;
/** JSON-RPC error the ACP spec uses for "sign in first". */
const AUTH_REQUIRED = -32000;

type Obj = Record<string, unknown>;

export class AcpSession extends ProcessSession {
	private caps: Obj = {};
	/** Replayed history (`session/load`) is not shown again. */
	private loading = false;
	private models: Obj | null = null;
	private modes: Obj | null = null;
	private planRows = 0;
	/** Tool call fields merged over `tool_call` and its updates. */
	private calls = new Map<string, Obj>();

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
				this.session(r);
			}
		} catch (e) {
			if (e instanceof RpcCallError && e.code === AUTH_REQUIRED) {
				throw new Error(`ต้องลงชื่อเข้าใช้ ${this.program()} ก่อน: เปิดในเทอร์มินัลแล้วลงชื่อเข้าใช้ (Sign in to ${this.program()} in a terminal first.) ${e.message}`);
			}
			throw e;
		}
		const modeId = agentModeFor(this.mode, this.modes?.availableModes);
		if (modeId && modeId !== this.modes?.currentModeId) await this.setAgentMode(modeId);
	}

	private program() {
		return this.init.command.split('/').pop() ?? 'agent';
	}

	/** What a new / loaded session says about itself: its modes and models. */
	private session(r: Obj | null) {
		if (!isObj(r)) return;
		if (isObj(r.modes)) this.modes = r.modes;
		if (isObj(r.models)) this.models = r.models;
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
		const prompt = [...images.map((i) => ({ type: 'image', mimeType: i.source.media_type, data: i.source.data })), { type: 'text', text: turn.text }];
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
