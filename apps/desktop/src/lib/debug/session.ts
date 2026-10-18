// One debug session (VS Code: DebugSession + RawDebugSession): the DAP handshake, breakpoints,
// stepping and the lazy stack/scopes/variables fetches after a stop. No runes and no Tauri, so it
// is driven in unit tests by an in-process fake adapter; debug.svelte.ts wires it to the app.

import { DapClient } from './client.ts';
import type { LaunchConfig } from './launch.ts';
import { appendOutput, applyEvent, currentFrame, initialModel, selectFrame, withBreakpoints, withFrames, withScopes, withThreads, withVariables, type DebugModel } from './model.ts';
import type { Breakpoint, Capabilities, Event, RunInTerminalArguments, SourceBreakpoint, StackFrame, Thread, Variable } from './protocol.ts';
import { t } from '#lib/i18n/index.ts';

export type SessionHost = {
	/** Enabled breakpoints per absolute source path. */
	breakpoints: () => Record<string, SourceBreakpoint[]>;
	runInTerminal: (args: RunInTerminalArguments) => Promise<{ processId?: number; shellProcessId?: number }>;
	changed: (model: DebugModel) => void;
	/** The selected frame after a stop or a frame click (reveal its line). */
	stopped?: (frame: StackFrame | null) => void;
	/** The adapter sent `terminated`. */
	terminated?: () => void;
};

export type EvaluateResult = { result: string; type?: string; variablesReference: number };

const STACK_LEVELS = 50;

export class DebugSession {
	model: DebugModel = initialModel();
	capabilities: Capabilities = {};
	readonly client: DapClient;
	readonly config: LaunchConfig;
	readonly noDebug: boolean;
	#host: SessionHost;
	/** setBreakpoints is only sent once the adapter said `initialized`. */
	#configured = false;
	/** Bumped on every stop/resume, so a slow stack fetch for an old stop is dropped. */
	#epoch = 0;

	constructor(client: DapClient, config: LaunchConfig, host: SessionHost, { noDebug = false } = {}) {
		this.client = client;
		this.config = config;
		this.#host = host;
		this.noDebug = noDebug;
		client.onEvent = (ev) => void this.#onEvent(ev);
		client.onReverseRequest('runInTerminal', (args: RunInTerminalArguments) => host.runInTerminal(args));
		// Answered so adapters that ask (js-debug, debugpy subprocesses) do not hang; Kingu runs one session.
		client.onReverseRequest('startDebugging', () => {
			this.#output('console', t('tools.debug.childUnsupported'));
			return {};
		});
	}

	#set(model: DebugModel) {
		this.model = model;
		this.#host.changed(model);
	}

	#output(category: string, text: string) {
		this.#set(appendOutput(this.model, category, text));
	}

	/** initialize → launch/attach; breakpoints and configurationDone follow the `initialized` event. */
	async start(): Promise<void> {
		this.capabilities = await this.client.request<Capabilities>('initialize', {
			clientID: 'kingu',
			clientName: 'Kingu',
			adapterID: this.config.type,
			locale: 'th',
			linesStartAt1: true,
			columnsStartAt1: true,
			pathFormat: 'path',
			supportsVariableType: true,
			supportsRunInTerminalRequest: true,
			supportsStartDebuggingRequest: true,
			supportsProgressReporting: false,
			supportsInvalidatedEvent: false
		});
		const request = this.config.request === 'attach' ? 'attach' : 'launch';
		const args: Record<string, unknown> = { ...this.config };
		if (this.noDebug) args.noDebug = true;
		await this.client.request(request, args);
		if (this.model.state === 'initializing') this.#set({ ...this.model, state: 'running' });
	}

	async #onEvent(ev: Event) {
		this.#set(applyEvent(this.model, ev));
		switch (ev.event) {
			case 'initialized':
				await this.#configure();
				break;
			case 'stopped':
				await this.#fetchStack(ev.body?.threadId);
				break;
			case 'continued':
				this.#epoch++;
				break;
			case 'terminated':
				this.#epoch++;
				this.#host.terminated?.();
				break;
		}
	}

	async #configure() {
		this.#configured = true;
		const all = this.#host.breakpoints();
		await Promise.all(Object.keys(all).map((path) => this.setBreakpoints(path, all[path])));
		const filters = (this.capabilities.exceptionBreakpointFilters ?? []).filter((f) => f.default).map((f) => f.filter);
		if (this.capabilities.exceptionBreakpointFilters) await this.client.request('setExceptionBreakpoints', { filters }).catch(() => {});
		if (this.capabilities.supportsConfigurationDoneRequest) await this.client.request('configurationDone', {});
	}

	/** Sends a file's breakpoints (all of them: DAP replaces the set per file). No-op until configured. */
	async setBreakpoints(path: string, bps: SourceBreakpoint[]): Promise<void> {
		if (!this.#configured || this.model.state === 'terminated') return;
		const name = path.slice(path.lastIndexOf('/') + 1);
		try {
			const body = await this.client.request<{ breakpoints: Breakpoint[] }>('setBreakpoints', { source: { name, path }, breakpoints: bps, lines: bps.map((b) => b.line) });
			this.#set(withBreakpoints(this.model, path, body.breakpoints ?? []));
		} catch (e) {
			this.#output('stderr', `setBreakpoints ${name}: ${e instanceof Error ? e.message : e}\n`);
		}
	}

	async #fetchStack(threadId: number | undefined) {
		const epoch = ++this.#epoch;
		try {
			const { threads } = await this.client.request<{ threads: Thread[] }>('threads');
			if (epoch !== this.#epoch) return;
			this.#set(withThreads(this.model, threads ?? []));
			const tid = threadId ?? threads?.[0]?.id;
			if (tid === undefined) return;
			if (this.model.stopped && this.model.stopped.threadId === null) this.#set({ ...this.model, stopped: { ...this.model.stopped, threadId: tid } });
			const { stackFrames } = await this.client.request<{ stackFrames: StackFrame[] }>('stackTrace', { threadId: tid, startFrame: 0, levels: STACK_LEVELS });
			if (epoch !== this.#epoch) return;
			this.#set(withFrames(this.model, stackFrames ?? []));
			await this.#loadScopes(epoch);
			if (epoch === this.#epoch) this.#host.stopped?.(currentFrame(this.model));
		} catch (e) {
			if (epoch === this.#epoch) this.#output('stderr', `${e instanceof Error ? e.message : e}\n`);
		}
	}

	/** Scopes of the selected frame, with the first cheap scope (Locals) expanded like VS Code. */
	async #loadScopes(epoch: number) {
		const frameId = this.model.frameId;
		if (frameId === null) return;
		const { scopes } = await this.client.request<{ scopes: { name: string; variablesReference: number; expensive: boolean }[] }>('scopes', { frameId });
		if (epoch !== this.#epoch) return;
		this.#set(withScopes(this.model, frameId, scopes ?? []));
		const first = scopes?.find((s) => !s.expensive && s.variablesReference > 0);
		if (first) await this.expand(first.variablesReference);
	}

	async selectFrame(frameId: number) {
		if (this.model.state !== 'stopped') return;
		this.#set(selectFrame(this.model, frameId));
		const epoch = this.#epoch;
		await this.#loadScopes(epoch).catch((e) => this.#output('stderr', `${e}\n`));
		this.#host.stopped?.(currentFrame(this.model));
	}

	/** Children of a scope or structured variable (fetched once per stop). */
	async expand(ref: number): Promise<Variable[]> {
		if (ref <= 0) return [];
		const cached = this.model.variables[ref];
		if (cached) return cached;
		const epoch = this.#epoch;
		const { variables } = await this.client.request<{ variables: Variable[] }>('variables', { variablesReference: ref });
		if (epoch === this.#epoch) this.#set(withVariables(this.model, ref, variables ?? []));
		return variables ?? [];
	}

	#threadId(): number {
		return this.model.stopped?.threadId ?? this.model.threads[0]?.id ?? 1;
	}

	/** continue / next / stepIn / stepOut: the UI goes to "running" at once (some adapters send no `continued`). */
	async #resume(command: 'continue' | 'next' | 'stepIn' | 'stepOut') {
		if (this.model.state !== 'stopped') return;
		const threadId = this.#threadId();
		this.#epoch++;
		this.#set(applyEvent(this.model, { seq: 0, type: 'event', event: 'continued', body: { threadId, allThreadsContinued: true } }));
		try {
			await this.client.request(command, { threadId });
		} catch (e) {
			this.#output('stderr', `${command}: ${e instanceof Error ? e.message : e}\n`);
		}
	}

	continue() {
		return this.#resume('continue');
	}
	next() {
		return this.#resume('next');
	}
	stepIn() {
		return this.#resume('stepIn');
	}
	stepOut() {
		return this.#resume('stepOut');
	}

	async pause() {
		if (this.model.state !== 'running') return;
		let threadId = this.model.threads[0]?.id;
		if (threadId === undefined) {
			const { threads } = await this.client.request<{ threads: Thread[] }>('threads').catch(() => ({ threads: [] as Thread[] }));
			this.#set(withThreads(this.model, threads ?? []));
			threadId = threads?.[0]?.id ?? 1;
		}
		await this.client.request('pause', { threadId }).catch((e) => this.#output('stderr', `pause: ${e.message ?? e}\n`));
	}

	/** Watch expressions and the Debug Console REPL, in the selected frame. */
	evaluate(expression: string, context: 'watch' | 'repl' | 'hover'): Promise<EvaluateResult> {
		const frameId = this.model.frameId ?? undefined;
		return this.client.request<EvaluateResult>('evaluate', { expression, frameId, context });
	}

	/** The adapter's own restart; false when it has none (the caller stops and starts again). */
	async restart(): Promise<boolean> {
		if (!this.capabilities.supportsRestartRequest) return false;
		this.#epoch++;
		await this.client.request('restart', { arguments: this.config });
		return true;
	}

	/** Ends the debuggee too (VS Code's Stop for a launched program). Bounded: a hung adapter is killed by the caller. */
	async disconnect(ms = 2000): Promise<void> {
		const done = this.client.request('disconnect', { restart: false, terminateDebuggee: this.config.request !== 'attach' }).catch(() => {});
		await Promise.race([done, new Promise((r) => setTimeout(r, ms))]);
	}

	/** The adapter process is gone. */
	exited(code: number | null) {
		this.client.close('debug adapter exited');
		this.#epoch++;
		if (this.model.state !== 'terminated') this.#set(applyEvent(this.model, { seq: 0, type: 'event', event: 'terminated' }));
		if (code) this.#output('stderr', t('tools.debug.adapterExited', { code }));
	}
}
