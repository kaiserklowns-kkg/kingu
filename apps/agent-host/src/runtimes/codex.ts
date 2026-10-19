// Codex as a chat run, over `codex app-server` (JSON-RPC on stdio without the `"jsonrpc"` member),
// the protocol old Kingu's host used: `initialize` + `initialized`, `thread/start` (or
// `thread/resume` to continue a chat), then one `turn/start` per message, ending at its
// `turn/completed` notification.
//
// - Items: `agentMessage` / `reasoning` stream as `delta`s; `commandExecution`, `fileChange`,
//   `mcpToolCall` and `webSearch` become tool rows (codexToolView); `turn/plan/updated` the todo bar.
// - Approvals (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`) go
//   through Kingu's safety check and permission mode, then to the user. The approval policy and
//   sandbox follow the permission mode (codexPolicy). Requests Kingu cannot show (MCP
//   elicitation, a tool asking for input) are declined.
// - A file change's files are snapshotted when its item starts, before the patch is applied.

import pkg from '../../package.json' with { type: 'json' };
import { RpcCallError } from './rpc.ts';
import { ProcessSession, OPEN_TIMEOUT_MS, type TurnEnd } from './session.ts';
import { codexDecision, codexPolicy, codexToolResult, codexToolView, isObj, num, planTodos, str } from './tools.ts';
import type { PermissionMode, Usage } from '../protocol.ts';

type Obj = Record<string, unknown>;
type Waiting = { turnId: string | null; resolve: (end: TurnEnd) => void };

export class CodexSession extends ProcessSession {
	private threadModel: string | null = null;
	private turnId: string | null = null;
	private waiting: Waiting | null = null;
	/** `turn/completed` that came before `turn/start` answered. */
	private early = new Map<string, TurnEnd>();
	private usage: Usage | null = null;
	/** An interrupt that came before `turn/start` named the turn: sent once it does. */
	private interruptWanted = false;
	private planRows = 0;
	/** Items seen by id (an approval names its item). */
	private items = new Map<string, Obj>();

	protected peerOptions() {
		return { header: false };
	}

	protected async open() {
		await this.peer.request('initialize', { clientInfo: { name: 'kingu_desktop', title: 'Kingu', version: pkg.version } }, OPEN_TIMEOUT_MS);
		this.peer.notify('initialized');
		// The enabled skills (../skills.ts) as developer instructions: Codex's own config stays untouched.
		const params = { ...codexPolicy(this.mode), ...(this.init.skillIndex ? { developerInstructions: this.init.skillIndex } : {}) };
		let r: Obj | null = null;
		if (this.init.resume) {
			try {
				r = await this.peer.request<Obj>('thread/resume', { threadId: this.init.resume, cwd: this.cwd, ...params }, OPEN_TIMEOUT_MS);
			} catch (e) {
				// A thread Codex never saved (or removed): start over.
				this.emit({ kind: 'stderr', line: `codex could not continue the earlier thread: ${e instanceof Error ? e.message : 'error'}` });
			}
		}
		r ??= await this.peer.request<Obj>('thread/start', { cwd: this.cwd, ...params }, OPEN_TIMEOUT_MS);
		const thread = isObj(r?.thread) ? r.thread : {};
		this.sessionId = str(thread.id) ?? this.init.resume;
		if (!this.sessionId) throw new Error('codex opened no thread');
		this.threadModel = str(r?.model);
	}

	protected model() {
		return this.threadModel;
	}

	protected async prompt(turn: { text: string; imagePaths: string[] }): Promise<TurnEnd> {
		const input = [{ type: 'text', text: turn.text }, ...turn.imagePaths.map((path) => ({ type: 'localImage', path }))];
		this.early.clear();
		this.interruptWanted = false;
		const done = new Promise<TurnEnd>((resolve) => (this.waiting = { turnId: null, resolve }));
		const r = await this.peer.request<Obj>('turn/start', { threadId: this.sessionId, input, approvalPolicy: codexPolicy(this.mode).approvalPolicy });
		const id = isObj(r?.turn) ? str(r.turn.id) : null;
		this.turnId = id;
		if (this.waiting) this.waiting.turnId = id;
		if (this.interruptWanted) {
			this.interruptWanted = false;
			void this.cancel().catch(() => {});
		}
		const early = id ? this.early.get(id) : undefined;
		if (early) {
			this.early.delete(id!);
			this.complete(early);
		}
		// The process exiting ends the turn too (the peer rejects nothing here: no request is open).
		const ended = this.peer.ended.then((): TurnEnd => ({ ok: false, error: 'codex exited' }));
		const end = await Promise.race([done, ended]);
		this.turnId = null;
		return { ...end, usage: this.usage };
	}

	private complete(end: TurnEnd) {
		const w = this.waiting;
		this.waiting = null;
		w?.resolve(end);
	}

	protected async cancel() {
		if (!this.turnId) this.interruptWanted = true;
		else if (this.sessionId) await this.peer.request('turn/interrupt', { threadId: this.sessionId, turnId: this.turnId }, 10_000);
	}

	protected async modeChanged(_mode: PermissionMode) {
		// The next `turn/start` carries the new approval policy.
	}

	protected onNotification(method: string, params: unknown) {
		const p = isObj(params) ? params : {};
		switch (method) {
			case 'item/agentMessage/delta':
				return this.appendText(str(p.delta) ?? '');
			case 'item/reasoning/summaryTextDelta':
			case 'item/reasoning/textDelta':
				return this.appendThinking(str(p.delta) ?? '');
			case 'item/started':
				if (isObj(p.item)) this.itemStarted(p.item);
				return;
			case 'item/completed':
				if (isObj(p.item)) this.itemCompleted(p.item);
				return;
			case 'turn/plan/updated': {
				const id = `plan-${++this.planRows}`;
				this.toolStarted(id, { name: 'TodoWrite', kind: 'think', paths: [], input: planTodos(p.plan) });
				this.toolFinished(id, '', false);
				return;
			}
			case 'thread/tokenUsage/updated':
				return this.tokenUsage(p.tokenUsage);
			case 'turn/completed': {
				const turn = isObj(p.turn) ? p.turn : {};
				const status = str(turn.status) ?? 'completed';
				const err = isObj(turn.error) ? str(turn.error.message) : null;
				const end: TurnEnd = status === 'completed' ? { ok: true } : status === 'interrupted' ? { ok: false, cancelled: true } : { ok: false, error: err ?? `turn ${status}` };
				const id = str(turn.id);
				if (this.waiting && (!id || this.waiting.turnId === id)) this.complete(end);
				else if (id) this.early.set(id, end);
				return;
			}
			case 'error': {
				const e = isObj(p.error) ? p.error : {};
				if (p.willRetry !== true && str(e.message)) this.emit({ kind: 'stderr', line: `codex: ${str(e.message)}` });
				return;
			}
			default:
				return;
		}
	}

	private itemStarted(item: Obj) {
		const id = str(item.id);
		if (!id) return;
		this.items.set(id, item);
		const view = codexToolView(item, this.cwd);
		if (view) this.toolStarted(id, view);
	}

	private itemCompleted(item: Obj) {
		const id = str(item.id);
		if (!id) return;
		this.items.set(id, item);
		switch (item.type) {
			case 'agentMessage':
				// Streamed already; a message that came whole is added now.
				if (!this.streaming) this.appendText(str(item.text) ?? '');
				this.flush();
				return;
			case 'reasoning': {
				const parts = [item.text, ...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])];
				const text = parts.map((x) => str(x) ?? '').filter(Boolean)[0] ?? '';
				if (!this.streaming && text) this.appendThinking(text);
				return;
			}
		}
		const view = codexToolView(item, this.cwd);
		if (!view) return;
		this.toolStarted(id, view, false);
		const r = codexToolResult(item);
		this.toolFinished(id, r.content, r.is_error);
	}

	private tokenUsage(u: unknown) {
		if (!isObj(u)) return;
		const total = isObj(u.total) ? u.total : {};
		const last = isObj(u.last) ? u.last : {};
		this.usage = {
			input_tokens: num(total.inputTokens) ?? 0,
			output_tokens: num(total.outputTokens) ?? 0,
			cache_read_input_tokens: num(total.cachedInputTokens) ?? 0,
			cache_creation_input_tokens: 0
		};
		const used = num(last.totalTokens) ?? num(last.inputTokens);
		const max = num(u.modelContextWindow);
		if (used !== null && max) this.emit({ kind: 'context_usage', used_tokens: Math.round(used), max_tokens: Math.round(max) });
	}

	protected async onRequest(method: string, params: unknown): Promise<unknown> {
		const p = isObj(params) ? params : {};
		switch (method) {
			case 'item/commandExecution/requestApproval': {
				const id = str(p.itemId);
				const item = (id && this.items.get(id)) || { type: 'commandExecution', id, command: p.command, cwd: p.cwd };
				const view = codexToolView({ ...item, ...(p.command ? { command: p.command } : {}) }, this.cwd)!;
				if (str(p.reason)) view.input.description = p.reason;
				if (id) this.toolStarted(id, view);
				return { decision: codexDecision(await this.ask(id, view, null, true)) };
			}
			case 'item/fileChange/requestApproval': {
				const id = str(p.itemId);
				const item = (id && this.items.get(id)) || { type: 'fileChange', id, changes: [] };
				const view = codexToolView(item, this.cwd)!;
				if (id) this.toolStarted(id, view);
				return { decision: codexDecision(await this.ask(id, view, str(p.reason), true)) };
			}
			case 'mcpServer/elicitation/request':
				return { action: 'decline', content: null };
			case 'item/tool/requestUserInput':
				return { answers: {} };
			case 'applyPatchApproval':
			case 'execCommandApproval':
				// The old protocol's approvals: this client only speaks the item ones.
				return { decision: 'abort' };
			default:
				throw new RpcCallError(-32601, `method not found: ${method}`);
		}
	}
}
