// One debug session (VS Code: DebugSession + RawDebugSession): the DAP handshake, breakpoints of
// every kind, stepping (back too), run to cursor, jump to cursor, restart frame, the lazy
// stack/scopes/variables fetches after a stop, hover/watch/REPL evaluation and REPL completions.
// No runes and no Tauri, so it is driven in unit tests by an in-process fake adapter;
// debug.svelte.ts wires it to the app.

import { DapClient } from './client.ts';
import { hoverFromVariables } from './hover.ts';
import { adapterType, type LaunchConfig } from './launch.ts';
import { appendOutput, applyEvent, currentFrame, initialModel, selectFrame, withBreakpoints, withFrames, withLoadedSources, withScopes, withThreads, withVariables, type DebugModel } from './model.ts';
import type {
	Breakpoint,
	BreakpointLocation,
	Capabilities,
	CompletionItem,
	DataBreakpoint,
	DataBreakpointInfo,
	DisassembledInstruction,
	Event,
	FunctionBreakpoint,
	GotoTarget,
	InstructionBreakpoint,
	RunInTerminalArguments,
	Source,
	SourceBreakpoint,
	StackFrame,
	StartDebuggingArguments,
	SteppingGranularity,
	StepInTarget,
	Thread,
	Variable
} from './protocol.ts';
import { t } from '#lib/i18n/index.ts';

export type ExceptionArgs = { filters: string[]; filterOptions?: { filterId: string; condition?: string }[] };

export type SessionHost = {
	/** Enabled breakpoints per absolute source path. */
	breakpoints: () => Record<string, SourceBreakpoint[]>;
	/** Function breakpoints to send (VS Code: Add Function Breakpoint). */
	functionBreakpoints?: () => FunctionBreakpoint[];
	/** Exception filters the adapter offers: the arguments for setExceptionBreakpoints. */
	exceptionArgs?: (caps: Capabilities) => ExceptionArgs;
	dataBreakpoints?: () => DataBreakpoint[];
	/** Instruction breakpoints (the Disassembly view's), sent once configured. */
	instructionBreakpoints?: () => InstructionBreakpoint[];
	runInTerminal: (args: RunInTerminalArguments) => Promise<{ processId?: number; shellProcessId?: number }>;
	/** The adapter asks for a child session (js-debug: one per debugged process). */
	startDebugging?: (args: StartDebuggingArguments) => Promise<void>;
	changed: (model: DebugModel) => void;
	/** The selected frame after a stop or a frame click (reveal its line). */
	stopped?: (frame: StackFrame | null) => void;
	/** The adapter sent `terminated`. */
	terminated?: () => void;
	/** Program output the adapter sent (serverReadyAction watches it). */
	output?: (text: string) => void;
	/** The adapter's `memory` event: bytes changed (the Memory view reads them again). */
	memory?: (memoryReference: string, offset: number, count: number) => void;
};

export type EvaluateResult = { result: string; type?: string; variablesReference: number; memoryReference?: string };
/** readMemory's answer with the bytes decoded; `unreadable` bytes follow the readable ones. */
export type MemoryRead = { address: string; bytes: Uint8Array; unreadable: number };

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
	/** What was last sent per file, so a temporary Run to Cursor breakpoint can be added and taken away. */
	#sent = new Map<string, SourceBreakpoint[]>();
	/** `breakpoint` events by id: js-debug can report a breakpoint verified before its setBreakpoints answer arrives. */
	#bpEvents = new Map<number, Breakpoint>();
	#runTo: { path: string; line: number } | null = null;

	constructor(client: DapClient, config: LaunchConfig, host: SessionHost, { noDebug = false } = {}) {
		this.client = client;
		this.config = config;
		this.#host = host;
		this.noDebug = noDebug;
		client.onEvent = (ev) => void this.#onEvent(ev);
		client.onReverseRequest('runInTerminal', (args: RunInTerminalArguments) => host.runInTerminal(args));
		client.onReverseRequest('startDebugging', async (args: StartDebuggingArguments) => {
			if (!host.startDebugging) {
				this.#output('console', t('tools.debug.childUnsupported'));
				return {};
			}
			await host.startDebugging(args);
			return {};
		});
	}

	get configured() {
		return this.#configured;
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
		const type = adapterType(this.config.type);
		this.capabilities = await this.client.request<Capabilities>('initialize', {
			clientID: 'kingu',
			clientName: 'Kingu',
			adapterID: type,
			locale: 'th',
			linesStartAt1: true,
			columnsStartAt1: true,
			pathFormat: 'path',
			supportsVariableType: true,
			supportsVariablePaging: false,
			supportsRunInTerminalRequest: true,
			supportsStartDebuggingRequest: true,
			supportsProgressReporting: false,
			supportsInvalidatedEvent: true,
			supportsMemoryReferences: true,
			supportsMemoryEvent: true,
			supportsArgsCanBeInterpretedByShell: false
		});
		const request = this.config.request === 'attach' ? 'attach' : 'launch';
		const args: Record<string, unknown> = { ...this.config, type };
		if (this.noDebug) args.noDebug = true;
		await this.client.request(request, args);
		if (this.model.state === 'initializing') this.#set({ ...this.model, state: 'running' });
	}

	async #onEvent(ev: Event) {
		const bp = ev.event === 'breakpoint' ? (ev.body?.breakpoint as Breakpoint | undefined) : undefined;
		if (bp?.id !== undefined) this.#bpEvents.set(bp.id, { ...this.#bpEvents.get(bp.id), ...bp });
		this.#set(applyEvent(this.model, ev));
		switch (ev.event) {
			case 'initialized':
				await this.#configure();
				break;
			case 'stopped':
				this.#clearRunTo();
				await this.#fetchStack(ev.body?.threadId);
				break;
			case 'continued':
				this.#epoch++;
				break;
			case 'terminated':
				this.#epoch++;
				this.#runTo = null;
				this.#host.terminated?.();
				break;
			case 'output':
				if (ev.body?.category !== 'telemetry') this.#host.output?.(String(ev.body?.output ?? ''));
				break;
			case 'memory':
				this.#host.memory?.(String(ev.body?.memoryReference ?? ''), Number(ev.body?.offset ?? 0), Number(ev.body?.count ?? 0));
				break;
			case 'invalidated':
				// Stacks or variables changed while stopped (a memory write, the adapter's own reasons): fetched again.
				if (this.model.state === 'stopped') await this.#fetchStack(this.model.stopped?.threadId ?? ev.body?.threadId ?? undefined, false);
				break;
		}
	}

	async #configure() {
		this.#configured = true;
		const all = this.#host.breakpoints();
		await Promise.all(Object.keys(all).map((path) => this.setBreakpoints(path, all[path])));
		const fns = this.#host.functionBreakpoints?.() ?? [];
		if (this.capabilities.supportsFunctionBreakpoints && fns.length) await this.setFunctionBreakpoints(fns);
		const data = this.#host.dataBreakpoints?.() ?? [];
		if (this.capabilities.supportsDataBreakpoints && data.length) await this.setDataBreakpoints(data);
		const instructions = this.#host.instructionBreakpoints?.() ?? [];
		if (this.capabilities.supportsInstructionBreakpoints && instructions.length) await this.setInstructionBreakpoints(instructions);
		if (this.capabilities.exceptionBreakpointFilters) await this.setExceptionBreakpoints(this.#host.exceptionArgs?.(this.capabilities) ?? { filters: this.capabilities.exceptionBreakpointFilters.filter((f) => f.default).map((f) => f.filter) });
		if (this.capabilities.supportsConfigurationDoneRequest) await this.client.request('configurationDone', {});
	}

	#live() {
		return this.#configured && this.model.state !== 'terminated';
	}

	/** Sends a file's breakpoints (all of them: DAP replaces the set per file). No-op until configured. */
	async setBreakpoints(path: string, bps: SourceBreakpoint[]): Promise<void> {
		this.#sent.set(path, bps);
		if (!this.#live()) return;
		const name = path.slice(path.lastIndexOf('/') + 1);
		const temp = this.#runTo?.path === path && !bps.some((b) => b.line === this.#runTo!.line) ? [{ line: this.#runTo.line }] : [];
		const send = [...bps, ...temp];
		try {
			const body = await this.client.request<{ breakpoints: Breakpoint[] }>('setBreakpoints', { source: { name, path }, breakpoints: send, lines: send.map((b) => b.line) });
			// The temporary one is the user's business only while it exists: the glyphs read the rest.
			// js-debug answers a repeated set of the same breakpoints (its child sends `initialized` twice) with none: the
			// earlier answer, whose ids its later `breakpoint` events update, still holds.
			const before = this.model.verified[path];
			const got = (body.breakpoints ?? []).slice(0, bps.length);
			const kept = !got.length && bps.length && before?.length === bps.length ? before : got;
			const answer = kept.map((b) => (b.id !== undefined && this.#bpEvents.has(b.id) ? { ...b, ...this.#bpEvents.get(b.id) } : b));
			this.#set(withBreakpoints(this.model, path, answer));
		} catch (e) {
			this.#output('stderr', `setBreakpoints ${name}: ${e instanceof Error ? e.message : e}\n`);
		}
	}

	/** Function breakpoints; the adapter's answer per breakpoint, in order (undefined when unsupported). */
	async setFunctionBreakpoints(bps: FunctionBreakpoint[]): Promise<Breakpoint[] | undefined> {
		if (!this.#live() || !this.capabilities.supportsFunctionBreakpoints) return undefined;
		try {
			const body = await this.client.request<{ breakpoints: Breakpoint[] }>('setFunctionBreakpoints', { breakpoints: bps });
			this.#set({ ...this.model, functionVerified: body.breakpoints ?? [] });
			return body.breakpoints ?? [];
		} catch (e) {
			this.#output('stderr', `setFunctionBreakpoints: ${e instanceof Error ? e.message : e}\n`);
			return undefined;
		}
	}

	async setExceptionBreakpoints(args: ExceptionArgs): Promise<void> {
		if (!this.#live() || !this.capabilities.exceptionBreakpointFilters) return;
		await this.client.request('setExceptionBreakpoints', args).catch((e) => this.#output('stderr', `setExceptionBreakpoints: ${e instanceof Error ? e.message : e}\n`));
	}

	/** Whether a variable can be watched for changes, and how (VS Code: dataBreakpointInfo). */
	async dataBreakpointInfo(variablesReference: number, name: string): Promise<DataBreakpointInfo | null> {
		if (!this.capabilities.supportsDataBreakpoints || this.model.state !== 'stopped') return null;
		return this.client.request<DataBreakpointInfo>('dataBreakpointInfo', { variablesReference, name, frameId: this.model.frameId ?? undefined }).catch(() => null);
	}

	async setDataBreakpoints(bps: DataBreakpoint[]): Promise<void> {
		if (!this.#live() || !this.capabilities.supportsDataBreakpoints) return;
		await this.client.request('setDataBreakpoints', { breakpoints: bps }).catch((e) => this.#output('stderr', `setDataBreakpoints: ${e instanceof Error ? e.message : e}\n`));
	}

	/** `reveal`: the host hears of the stop (an `invalidated` refresh is not a new stop). */
	async #fetchStack(threadId: number | undefined, reveal = true) {
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
			if (epoch === this.#epoch && reveal) this.#host.stopped?.(currentFrame(this.model));
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

	/** Variables view: Set Value (supportsSetVariable). The parent's children are fetched again. */
	async setVariable(parentRef: number, name: string, value: string): Promise<Variable | null> {
		if (!this.capabilities.supportsSetVariable || this.model.state !== 'stopped') return null;
		const v = await this.client.request<{ value: string; type?: string; variablesReference?: number }>('setVariable', { variablesReference: parentRef, name, value });
		const list = this.model.variables[parentRef];
		if (list) this.#set(withVariables(this.model, parentRef, list.map((x) => (x.name === name ? { ...x, value: v.value, type: v.type ?? x.type, variablesReference: v.variablesReference ?? x.variablesReference } : x))));
		return { name, value: v.value, type: v.type, variablesReference: v.variablesReference ?? 0 };
	}

	#threadId(): number {
		return this.model.stopped?.threadId ?? this.model.threads[0]?.id ?? 1;
	}

	/** continue / next / stepIn / stepOut / stepBack / reverseContinue: the UI goes to "running" at
	 * once (some adapters send no `continued`). */
	async #resume(command: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'stepBack' | 'reverseContinue', extra: Record<string, unknown> = {}) {
		if (this.model.state !== 'stopped') return;
		const threadId = this.#threadId();
		this.#epoch++;
		this.#set(applyEvent(this.model, { seq: 0, type: 'event', event: 'continued', body: { threadId, allThreadsContinued: true } }));
		try {
			await this.client.request(command, { threadId, ...extra });
		} catch (e) {
			this.#output('stderr', `${command}: ${e instanceof Error ? e.message : e}\n`);
		}
	}

	/** `granularity` (VS Code: `instruction` while the Disassembly view has focus) goes only to an
	 * adapter with supportsSteppingGranularity. */
	#step(granularity?: SteppingGranularity): Record<string, unknown> {
		return granularity && this.capabilities.supportsSteppingGranularity ? { granularity } : {};
	}

	continue() {
		return this.#resume('continue');
	}
	next(granularity?: SteppingGranularity) {
		return this.#resume('next', this.#step(granularity));
	}
	/** Step Into; with `targetId`, into that target of the line (Step Into Target). */
	stepIn(granularity?: SteppingGranularity, targetId?: number) {
		return this.#resume('stepIn', { ...this.#step(granularity), ...(targetId !== undefined ? { targetId } : {}) });
	}
	stepOut(granularity?: SteppingGranularity) {
		return this.#resume('stepOut', this.#step(granularity));
	}

	/** Step Into Target's choices in a frame (supportsStepInTargetsRequest). */
	async stepInTargets(frameId = this.model.frameId): Promise<StepInTarget[]> {
		if (!this.capabilities.supportsStepInTargetsRequest || this.model.state !== 'stopped' || frameId === null) return [];
		const body = await this.client.request<{ targets: StepInTarget[] }>('stepInTargets', { frameId }).catch(() => ({ targets: [] as StepInTarget[] }));
		return body.targets ?? [];
	}

	// --- Disassembly, memory, loaded sources, column breakpoints ----------------------------------

	/** Instructions around a memory reference (supportsDisassembleRequest); `instructionOffset` may be negative. */
	async disassemble(memoryReference: string, instructionOffset: number, instructionCount: number, offset = 0): Promise<DisassembledInstruction[]> {
		if (!this.capabilities.supportsDisassembleRequest || this.model.state === 'terminated') return [];
		const body = await this.client.request<{ instructions: DisassembledInstruction[] }>('disassemble', { memoryReference, offset, instructionOffset, instructionCount, resolveSymbols: true });
		return body?.instructions ?? [];
	}

	/** The Disassembly view's breakpoints (supportsInstructionBreakpoints); the adapter's answer in order. */
	async setInstructionBreakpoints(bps: InstructionBreakpoint[]): Promise<Breakpoint[] | undefined> {
		if (!this.#live() || !this.capabilities.supportsInstructionBreakpoints) return undefined;
		try {
			const body = await this.client.request<{ breakpoints: Breakpoint[] }>('setInstructionBreakpoints', { breakpoints: bps });
			return body.breakpoints ?? [];
		} catch (e) {
			this.#output('stderr', `setInstructionBreakpoints: ${e instanceof Error ? e.message : e}\n`);
			return undefined;
		}
	}

	/** Bytes at a memory reference (supportsReadMemoryRequest), the base64 `data` decoded. */
	async readMemory(memoryReference: string, offset: number, count: number): Promise<MemoryRead | null> {
		if (!this.capabilities.supportsReadMemoryRequest || this.model.state === 'terminated') return null;
		const body = await this.client.request<{ address: string; unreadableBytes?: number; data?: string }>('readMemory', { memoryReference, offset, count });
		const bin = atob(body?.data ?? '');
		const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
		return { address: body?.address ?? memoryReference, bytes, unreadable: body?.unreadableBytes ?? 0 };
	}

	/** Writes bytes (supportsWriteMemoryRequest); the number written. */
	async writeMemory(memoryReference: string, offset: number, bytes: Uint8Array): Promise<number> {
		if (!this.capabilities.supportsWriteMemoryRequest || this.model.state === 'terminated') return 0;
		const data = btoa(String.fromCharCode(...bytes));
		const body = await this.client.request<{ bytesWritten?: number }>('writeMemory', { memoryReference, offset, data });
		return body?.bytesWritten ?? bytes.length;
	}

	/** Loaded Scripts: every source the debuggee has loaded (supportsLoadedSourcesRequest); later
	 * `loadedSource` events keep `model.loadedSources` current. */
	async loadedSources(): Promise<Source[]> {
		if (!this.capabilities.supportsLoadedSourcesRequest || this.model.state === 'terminated') return [];
		const body = await this.client.request<{ sources: Source[] }>('loadedSources', {}).catch(() => ({ sources: [] as Source[] }));
		this.#set(withLoadedSources(this.model, body.sources ?? []));
		return this.model.loadedSources ?? [];
	}

	/** The text of a source only the adapter has (sourceReference > 0, no file on disk). */
	async source(source: Source): Promise<{ content: string; mimeType?: string } | null> {
		if (!source.sourceReference) return null;
		return this.client.request<{ content: string; mimeType?: string }>('source', { source, sourceReference: source.sourceReference }).catch(() => null);
	}

	/** Where on a line breakpoints can go (supportsBreakpointLocationsRequest): the inline breakpoint candidates. */
	async breakpointLocations(path: string, line: number): Promise<BreakpointLocation[]> {
		if (!this.capabilities.supportsBreakpointLocationsRequest || !this.#live()) return [];
		const name = path.slice(path.lastIndexOf('/') + 1);
		const body = await this.client.request<{ breakpoints: BreakpointLocation[] }>('breakpointLocations', { source: { name, path }, line }).catch(() => ({ breakpoints: [] as BreakpointLocation[] }));
		return body.breakpoints ?? [];
	}
	/** Step Back / Reverse Continue (supportsStepBack). */
	stepBack() {
		return this.capabilities.supportsStepBack ? this.#resume('stepBack') : Promise.resolve();
	}
	reverseContinue() {
		return this.capabilities.supportsStepBack ? this.#resume('reverseContinue') : Promise.resolve();
	}

	/** Run to Cursor (VS Code: debugService.runTo): a temporary breakpoint at the line, then continue;
	 * it goes away at the next stop. */
	async runTo(path: string, line: number) {
		if (this.model.state !== 'stopped') return;
		this.#runTo = { path, line };
		await this.setBreakpoints(path, this.#sent.get(path) ?? []);
		await this.continue();
	}

	#clearRunTo() {
		const r = this.#runTo;
		if (!r) return;
		this.#runTo = null;
		void this.setBreakpoints(r.path, this.#sent.get(r.path) ?? []);
	}

	/** Jump to Cursor (VS Code: debug.jumpToCursor, supportsGotoTargetsRequest): moves execution to
	 * the line without running the code in between. False when the adapter offers no target there. */
	async jumpTo(path: string, line: number): Promise<boolean> {
		if (!this.capabilities.supportsGotoTargetsRequest || this.model.state !== 'stopped') return false;
		const name = path.slice(path.lastIndexOf('/') + 1);
		const { targets } = await this.client.request<{ targets: GotoTarget[] }>('gotoTargets', { source: { name, path }, line });
		const target = targets?.[0];
		if (!target) return false;
		const threadId = this.#threadId();
		this.#epoch++;
		await this.client.request('goto', { threadId, targetId: target.id });
		return true;
	}

	/** Call Stack: Restart Frame (supportsRestartFrame). */
	async restartFrame(frameId: number) {
		if (!this.capabilities.supportsRestartFrame || this.model.state !== 'stopped') return;
		this.#epoch++;
		this.#set(applyEvent(this.model, { seq: 0, type: 'event', event: 'continued', body: { threadId: this.#threadId(), allThreadsContinued: true } }));
		await this.client.request('restartFrame', { frameId }).catch((e) => this.#output('stderr', `restartFrame: ${e instanceof Error ? e.message : e}\n`));
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

	/** Watch expressions, hovers and the Debug Console REPL, in the selected frame. */
	evaluate(expression: string, context: 'watch' | 'repl' | 'hover' | 'clipboard'): Promise<EvaluateResult> {
		const frameId = this.model.frameId ?? undefined;
		return this.client.request<EvaluateResult>('evaluate', { expression, frameId, context });
	}

	/** The debug hover (VS Code: DebugHoverWidget): `evaluate` in the hover context when the adapter
	 * supports it, else the variable of that name (a.b.c walks the children) in the frame's scopes. */
	async hover(expression: string): Promise<EvaluateResult | null> {
		if (this.model.state !== 'stopped' || !expression) return null;
		if (this.capabilities.supportsEvaluateForHovers) return this.evaluate(expression, 'hover').catch(() => null);
		const found = await hoverFromVariables(expression, this.model.scopes, (ref) => this.expand(ref).catch(() => []));
		return found ? { result: found.value, type: found.type, variablesReference: found.variablesReference } : null;
	}

	/** Debug Console completions (supportsCompletionsRequest). `column` is 1-based, in `text`. */
	async completions(text: string, column: number): Promise<CompletionItem[]> {
		if (!this.capabilities.supportsCompletionsRequest || this.model.state === 'terminated') return [];
		const frameId = this.model.frameId ?? undefined;
		const { targets } = await this.client.request<{ targets: CompletionItem[] }>('completions', { text, column, frameId }).catch(() => ({ targets: [] as CompletionItem[] }));
		return targets ?? [];
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
