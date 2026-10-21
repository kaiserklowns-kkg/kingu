// One run of an agent other than the Claude Agent SDK. `RunSession` keeps what every such run
// shares: the turn queue (a message sent mid-turn waits for the turn to end, like the SDK's
// inbox), streamed text, tool rows, permission prompts, file snapshots, the `result` of each turn
// and the single `exit`. `ProcessSession` adds a child process speaking JSON-RPC on stdio (ACP
// agents, `codex app-server`; the protocol is the subclass's, acp.ts and codex.ts). Arkai
// (arkai/session.ts) runs its agent loop in this process instead.
//
// Never write prompts, tool inputs or file contents to the log.

import { blockingThreats, threatSummary } from '../guards/security.ts';
import { snapshotOf } from '../snapshots.ts';
import { DECISIONS, type AgentEvent, type AnswerParams, type Decision, type McpServerParams, type PermissionMode, type Usage } from '../protocol.ts';
import { summarizeTool } from '../normalize.ts';
import { JsonRpcPeer, linesOf, type PeerOptions } from './rpc.ts';
import { autoDecision, SESSION_ID, type ToolKind, type ToolView } from './tools.ts';
import type { ImageBlock } from '../host.ts';
import type { ArkaiSpec } from '../arkai/spec.ts';
import type { AskConfig } from '../guards/asks.ts';

/** A spawned agent process (Bun's `Subprocess` fits; tests may pass their own). */
export type Child = {
	stdin: { write(data: string): unknown; end(): unknown };
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	kill(signal?: number | NodeJS.Signals): void;
};
export type SpawnFn = (cmd: string[], opts: { cwd: string; env: Record<string, string | undefined> }) => Child;

export const spawnChild: SpawnFn = (cmd, { cwd, env }) => Bun.spawn(cmd, { cwd, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }) as unknown as Child;

/** After `stop`, how long the agent gets to exit before it is killed (and the exit reported anyway). */
export const KILL_GRACE_MS = 3000;
/** The agent's handshake (initialize, new / load session) may take this long. */
export const OPEN_TIMEOUT_MS = 60_000;

export class SessionError extends Error {
	constructor(
		readonly code: number,
		message: string
	) {
		super(message);
	}
}
export const RUN_NOT_FOUND = 1;
export const UNSUPPORTED = 2;
export const INVALID_PARAMS = -32602;

export type SessionInit = {
	runId: number;
	cwd: string;
	command: string;
	args: string[];
	prompt: string;
	shownPrompt: string;
	images: ImageBlock[];
	imagePaths: string[];
	mode: PermissionMode;
	resume: string | null;
	mcpServers: Record<string, McpServerParams>;
	/** Arkai only: tools it must not offer (`disallowedTools`; `mcp__<server>` covers that server). */
	disallowedTools?: string[];
	env: Record<string, string | undefined>;
	snapshots: boolean;
	safetyChecks: boolean;
	emit: (ev: AgentEvent) => void;
	log: (line: string) => void;
	newId: () => string;
	spawn?: SpawnFn;
	/** Called once, after the `exit` event. */
	onExit: () => void;
	/** Arkai only (arkai/): the provider, model and earlier conversation. */
	arkai?: ArkaiSpec;
	/** Arkai only: project rules after its system prompt (and the skill index, ../skills.ts). */
	systemPromptAppend?: string;
	/** Codex and ACP: the enabled skills (../skills.ts), for the agent's instructions; '' or absent: none. */
	skillIndex?: string;
	/** Arkai only: Kingu's always-ask checks (the other runtimes ask through their agent). */
	guardAsks?: (AskConfig & { cwd: string }) | null;
};

export type Turn = { text: string; images: ImageBlock[]; imagePaths: string[] };
/** How a turn ended, as the subclass reports it. */
export type TurnEnd = { ok: boolean; cancelled?: boolean; error?: string | null; usage?: Usage | null };
type Pending = { resolve: (d: Decision | 'cancelled') => void; tool: string };
/** A tool row as emitted: its view, and whether its result went out. */
type ToolState = { view: ToolView; done: boolean; snapped: Set<string> };
/** What a permission prompt offers besides the tool call itself. */
export type AskOptions = { title: string | null; canAlways: boolean; rules?: string[]; detail?: string | null; onRequest?: (requestId: string) => void };

export abstract class RunSession {
	protected readonly cwd: string;
	protected mode: PermissionMode;
	protected sessionId: string | null = null;
	private queue: Turn[] = [];
	private busy = false;
	private opened = false;
	protected stopped = false;
	protected exited = false;
	private turns = 0;
	private text = '';
	private thinking = '';
	private lastText: string | null = null;
	private pending = new Map<string, Pending>();
	/** The user's words with a `deny`, by request id (Arkai tells the model). */
	protected readonly denyNotes = new Map<string, string>();
	protected tools = new Map<string, ToolState>();

	constructor(protected readonly init: SessionInit) {
		this.cwd = init.cwd;
		this.mode = init.mode;
	}

	/** The handshake: open (or resume) the agent session; sets `sessionId`. */
	protected abstract open(): Promise<void>;
	/** Sends one user message and resolves when the agent's turn is over. */
	protected abstract prompt(turn: Turn): Promise<TurnEnd>;
	/** Asks the agent to end the current turn early. */
	protected abstract cancel(): Promise<void>;
	/** Starts the run: its first turn goes once the session is open. */
	abstract start(): void;
	/** Ends the run (a failed handshake: `code` 1); the `exit` event goes out by `finish`. */
	protected abstract kill(code: number): void;
	abstract stop(): Promise<null>;
	/** A mid-session change of the permission mode (the policy is Kingu's; the agent may hear of it too). */
	protected async modeChanged(_mode: PermissionMode): Promise<void> {}

	protected emit(ev: AgentEvent) {
		if (!this.exited) this.init.emit(ev);
	}
	protected log(line: string) {
		this.init.log(`run ${this.init.runId}: ${line}`);
	}

	get live() {
		return !this.exited;
	}

	/** Queues the first prompt and opens the session; each turn runs once it is open. */
	protected begin() {
		this.queue.push({ text: this.init.prompt, images: this.init.images, imagePaths: this.init.imagePaths });
		this.emit({ kind: 'message', role: 'user', text: this.init.shownPrompt });
		void this.boot();
	}

	private async boot() {
		try {
			await this.open();
		} catch (e) {
			if (this.stopped || this.exited) return;
			this.emit({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
			this.kill(1);
			return;
		}
		this.opened = true;
		this.emit({ kind: 'system', subtype: 'init', session_id: this.reportedSession(), model: this.model() });
		void this.pump();
	}

	/** The model the agent says it uses, for the `system` event. */
	protected model(): string | null {
		return null;
	}

	/** The session id when Rust can keep it. */
	protected reportedSession(): string | null {
		return this.sessionId && SESSION_ID.test(this.sessionId) ? this.sessionId : null;
	}

	private async pump() {
		if (this.busy || !this.opened || this.exited || this.stopped) return;
		const turn = this.queue.shift();
		if (!turn) return;
		this.busy = true;
		const started = Date.now();
		this.lastText = null;
		let end: TurnEnd;
		try {
			end = await this.prompt(turn);
		} catch (e) {
			end = { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
		this.flush();
		this.turns++;
		if (!this.exited && !this.stopped) {
			const error = end.error?.trim() || null;
			this.emit({
				kind: 'result',
				subtype: end.ok ? 'success' : end.cancelled ? 'error_during_execution' : 'error',
				is_error: !end.ok,
				// A cancelled turn has no text: the chat shows it as stopped.
				result: end.ok ? this.lastText : end.cancelled ? null : error,
				session_id: this.reportedSession(),
				num_turns: this.turns,
				duration_ms: Date.now() - started,
				total_cost_usd: null,
				usage: end.usage ?? null
			});
		}
		this.busy = false;
		void this.pump();
	}

	// -------------------------------------------------------------------------------------------
	// Streamed text

	protected appendText(text: string) {
		if (!text) return;
		if (this.thinking) this.flushThinking();
		this.text += text;
		this.emit({ kind: 'delta', block: 'text', text });
	}

	protected appendThinking(text: string) {
		if (!text) return;
		this.thinking += text;
		this.emit({ kind: 'delta', block: 'thinking', text });
	}

	private flushThinking() {
		if (this.thinking.trim()) this.emit({ kind: 'thinking', text: this.thinking });
		this.thinking = '';
	}

	/** Ends the streamed thinking and text as whole `thinking` / `message` events (before a tool row, and at the turn's end). */
	protected flush() {
		this.flushThinking();
		if (this.text.trim()) {
			this.emit({ kind: 'message', role: 'assistant', text: this.text });
			this.lastText = this.text;
		}
		this.text = '';
	}

	/** Replaces the text streamed since the last flush (its whole `message` goes out with this instead). */
	protected replaceStreamed(text: string) {
		this.text = text;
	}

	/** Whether text was streamed since the last flush (a completed message item then adds nothing). */
	protected get streaming() {
		return this.text.length > 0;
	}

	// -------------------------------------------------------------------------------------------
	// Tool rows

	/** Emits the tool's row once (and its files' snapshots while it has not run yet). */
	protected toolStarted(id: string, view: ToolView, running = true) {
		let state = this.tools.get(id);
		if (!state) {
			this.flush();
			state = { view, done: false, snapped: new Set() };
			this.tools.set(id, state);
			this.emit({ kind: 'tool_use', id, name: view.name, input: view.input });
		} else {
			// Later updates may name more files; the row itself stays as first sent.
			state.view = { ...state.view, paths: [...new Set([...state.view.paths, ...view.paths])] };
		}
		if (running && !state.done) this.snapshot(id, state);
		return state;
	}

	protected toolFinished(id: string, content: string, isError: boolean) {
		const state = this.tools.get(id);
		if (!state || state.done) return;
		state.done = true;
		this.emit({ kind: 'tool_result', tool_use_id: id, content, is_error: isError });
	}

	/** The prior content of each file an edit is about to change (the chat's working set and Undo). */
	protected snapshot(id: string, state: ToolState) {
		if (!this.init.snapshots) return;
		if (state.view.kind !== 'edit' && state.view.kind !== 'delete' && state.view.kind !== 'move') return;
		for (const path of state.view.paths) {
			if (state.snapped.has(path)) continue;
			state.snapped.add(path);
			try {
				this.emit(snapshotOf(state.view.name, id, path, this.cwd));
			} catch {
				this.log('snapshot failed');
			}
		}
	}

	// -------------------------------------------------------------------------------------------
	// Permission prompts

	/**
	 * Kingu's answer to the agent's permission request: the safety check on shell commands, then
	 * the permission mode's policy, else the user's (a `permission_request` event).
	 */
	protected async ask(toolUseId: string | null, view: ToolView, title: string | null, canAlways: boolean): Promise<Decision | 'cancelled'> {
		if (this.exited || this.stopped) return 'cancelled';
		const command = view.name === 'Bash' && typeof view.input.command === 'string' ? view.input.command : null;
		if (command && this.init.safetyChecks) {
			const threats = blockingThreats(command);
			if (threats.length) {
				const names = [...new Set(threats.map((t) => t.threat.name))];
				// The check's name only: the command itself is never logged.
				this.log(`safety check blocked ${view.name} (security: ${names.join(', ')})`);
				this.emit({ kind: 'guard_blocked', tool: view.name, tool_use_id: toolUseId, check: 'security', threats: names, detail: threatSummary(threats) });
				return 'deny';
			}
		}
		const auto = autoDecision(this.mode, view.kind as ToolKind);
		if (auto) return auto;
		return this.askUser(toolUseId, view, { title, canAlways });
	}

	/** The user's answer: a `permission_request` event, answered by `answer` (or cancelled). */
	protected askUser(toolUseId: string | null, view: ToolView, o: AskOptions): Promise<Decision | 'cancelled'> {
		if (this.exited || this.stopped) return Promise.resolve('cancelled');
		const requestId = this.init.newId();
		const { summary, detail, diff } = summarizeTool(view.name, view.input);
		return new Promise((resolve) => {
			this.pending.set(requestId, { resolve, tool: view.name });
			o.onRequest?.(requestId);
			this.emit({
				kind: 'permission_request',
				request_id: requestId,
				tool: view.name,
				tool_use_id: toolUseId,
				title: o.title,
				input_summary: summary,
				detail: detail ?? o.detail ?? null,
				diff,
				input: view.input,
				can_always: o.canAlways,
				rules: o.rules ?? []
			});
		});
	}

	answer(p: AnswerParams) {
		const pending = this.pending.get(p.requestId);
		if (!pending) throw new SessionError(RUN_NOT_FOUND, `no pending permission request ${p.requestId}`);
		if (!DECISIONS.includes(p.decision)) throw new SessionError(INVALID_PARAMS, `bad decision ${p.decision}`);
		if (p.answers != null) throw new SessionError(INVALID_PARAMS, `${pending.tool} takes no answers`);
		this.pending.delete(p.requestId);
		if (p.decision === 'deny' && p.message?.trim()) this.denyNotes.set(p.requestId, p.message.trim());
		pending.resolve(p.decision);
		this.emit({ kind: 'permission_resolved', request_id: p.requestId, decision: p.decision });
		this.log(`${pending.tool} ${p.decision}`);
		return null;
	}

	protected cancelPending() {
		for (const [requestId, p] of this.pending) {
			p.resolve('cancelled');
			this.emit({ kind: 'permission_resolved', request_id: requestId, decision: 'cancelled' });
		}
		this.pending.clear();
	}

	// -------------------------------------------------------------------------------------------
	// Requests from the app

	send(text: string, images: ImageBlock[], imagePaths: string[], shown: string) {
		if (this.exited || this.stopped) throw new SessionError(RUN_NOT_FOUND, 'run has ended');
		this.queue.push({ text, images, imagePaths });
		this.emit({ kind: 'message', role: 'user', text: shown });
		void this.pump();
		return null;
	}

	async interrupt() {
		this.cancelPending();
		if (this.busy) await this.cancel().catch(() => {});
		return null;
	}

	/** Whether a turn is running. */
	protected get running() {
		return this.busy;
	}

	/** `extra`: what a runtime may need besides the model id (Arkai: the model's provider). */
	async setOptions(model: string | undefined, mode: PermissionMode | undefined, _extra?: unknown): Promise<{ model: string | null; permissionMode: PermissionMode | null }> {
		if (model !== undefined) throw new SessionError(UNSUPPORTED, 'this agent cannot change the model mid-session');
		if (mode !== undefined) {
			this.mode = mode;
			await this.modeChanged(mode).catch((e) => this.log(`mode not passed on: ${e instanceof Error ? e.message : 'error'}`));
		}
		return { model: null, permissionMode: mode ?? null };
	}

	/** The run's single `exit` (pending prompts cancelled, streamed text flushed). */
	protected finish(code: number) {
		if (this.exited) return;
		this.cancelPending();
		this.closed();
		this.flush();
		this.log(`exited${this.stopped ? ' (stopped)' : ''}`);
		this.init.emit({ kind: 'exit', code: this.stopped ? null : code, signal: null, stopped: this.stopped });
		this.exited = true;
		this.init.onExit();
	}

	/** What the subclass lets go of when the run ends. */
	protected closed() {}
}

/** A run whose agent is a child process speaking JSON-RPC on stdio (ACP agents, `codex app-server`). */
export abstract class ProcessSession extends RunSession {
	protected peer!: JsonRpcPeer;
	private child!: Child;

	/** The JSON-RPC framing (`header`); requests and notifications go to the subclass. */
	protected abstract peerOptions(): Pick<PeerOptions, 'header'>;
	protected abstract onRequest(method: string, params: unknown): Promise<unknown>;
	protected abstract onNotification(method: string, params: unknown): void;

	start() {
		const { command, args, cwd, env } = this.init;

		this.child = (this.init.spawn ?? spawnChild)([command, ...args], { cwd, env });
		this.peer = new JsonRpcPeer(
			{ write: (line) => void this.child.stdin.write(line), lines: linesOf(this.child.stdout) },
			{
				...this.peerOptions(),
				onRequest: (m, p) => this.onRequest(m, p),
				onNotification: (m, p) => {
					try {
						this.onNotification(m, p);
					} catch (e) {
						this.log(`${m} not handled: ${e instanceof Error ? e.message : 'error'}`);
					}
				},
				onJunk: (line) => this.emit({ kind: 'raw', line: line.slice(0, 2000) })
			}
		);
		void (async () => {
			for await (const line of linesOf(this.child.stderr)) if (line.trim()) this.emit({ kind: 'stderr', line });
		})().catch(() => {});
		void this.child.exited.then(
			(code) => this.finish(code),
			() => this.finish(1)
		);
		this.begin();
	}


	async stop() {
		if (this.exited) return null;
		this.stopped = true;
		this.cancelPending();
		if (this.running) await Promise.race([this.cancel().catch(() => {}), new Promise((r) => setTimeout(r, 500))]);
		try {
			this.child.stdin.end();
		} catch {
			// Already closed.
		}
		this.kill(0);
		return null;
	}

	/** Ends the process: SIGTERM, SIGKILL after the grace period, and the exit reported by then at the latest. */
	protected kill(code: number) {
		try {
			this.child.kill('SIGTERM');
		} catch {
			// Already gone.
		}
		setTimeout(() => {
			if (this.exited) return;
			try {
				this.child.kill('SIGKILL');
			} catch {
				// Already gone.
			}
			this.finish(code);
		}, KILL_GRACE_MS).unref?.();
	}

	protected closed() {
		this.peer?.close();
	}
}
