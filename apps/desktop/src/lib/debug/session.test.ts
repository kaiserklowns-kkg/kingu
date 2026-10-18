/// <reference types="bun" />
// DebugSession against an in-process fake adapter. Adapter messages are delivered one per
// macrotask, like the Tauri Channel, so ordering races (initialized vs. the launch response) are real.
import { describe, expect, test } from 'bun:test';
import { DapClient, DapError } from './client.ts';
import type { DebugModel } from './model.ts';
import type { ProtocolMessage, Request, RunInTerminalArguments, SourceBreakpoint, StackFrame } from './protocol.ts';
import { DebugSession } from './session.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(cond: () => boolean, what: string) {
	for (let i = 0; i < 500; i++) {
		if (cond()) return;
		await tick();
	}
	throw new Error(`timed out: ${what}`);
}

/** Scripted like testdata/fake_dap.py, plus pause, next, evaluate and runInTerminal. */
class FakeAdapter {
	seq = 1;
	received: Request[] = [];
	lines: number[] = [];
	program = '';
	line = 0;
	client!: DapClient;
	pendingLaunch: Request | null = null;

	send(msg: Omit<ProtocolMessage, 'seq'>) {
		const json = JSON.stringify({ ...msg, seq: this.seq++ });
		setTimeout(() => this.client.handle(json), 0);
	}
	respond(req: Request, body?: unknown, success = true, message?: string) {
		this.send({ type: 'response', request_seq: req.seq, command: req.command, success, body, message } as ProtocolMessage);
	}
	event(event: string, body?: unknown) {
		this.send({ type: 'event', event, body } as ProtocolMessage);
	}

	receive(json: string) {
		const msg = JSON.parse(json) as ProtocolMessage;
		if (msg.type === 'response') {
			// Our runInTerminal was answered: the launch can complete.
			if (msg.command === 'runInTerminal' && this.pendingLaunch) {
				this.respond(this.pendingLaunch);
				this.event('initialized');
				this.pendingLaunch = null;
			}
			return;
		}
		if (msg.type !== 'request') return;
		this.received.push(msg);
		const args = msg.arguments ?? {};
		switch (msg.command) {
			case 'initialize':
				return this.respond(msg, { supportsConfigurationDoneRequest: true, exceptionBreakpointFilters: [{ filter: 'raised', label: 'Raised', default: false }, { filter: 'uncaught', label: 'Uncaught', default: true }] });
			case 'launch':
				this.program = args.program;
				if (args.console === 'integratedTerminal') {
					this.pendingLaunch = msg;
					this.send({ type: 'request', command: 'runInTerminal', arguments: { kind: 'integrated', cwd: '/ws', args: ['python3', args.program], env: { A: '1' } } } as ProtocolMessage);
					return;
				}
				// debugpy order: initialized first, the launch response only after configurationDone.
				this.pendingLaunch = null;
				this.event('initialized');
				this.launchReq = msg;
				return;
			case 'setBreakpoints':
				this.lines = (args.breakpoints as SourceBreakpoint[]).map((b) => b.line);
				return this.respond(msg, { breakpoints: this.lines.map((l, i) => ({ id: i + 1, verified: l !== 99, line: l, message: l === 99 ? 'no code' : undefined })) });
			case 'setExceptionBreakpoints':
				return this.respond(msg);
			case 'configurationDone':
				this.respond(msg);
				if (this.launchReq) this.respond(this.launchReq);
				this.event('output', { category: 'stdout', output: 'hello\n' });
				this.line = this.lines[0] ?? 1;
				return this.event('stopped', { reason: 'breakpoint', threadId: 1, allThreadsStopped: true });
			case 'threads':
				return this.respond(msg, { threads: [{ id: 1, name: 'main' }] });
			case 'stackTrace':
				return this.respond(msg, {
					stackFrames: [
						{ id: 100, name: 'inner', line: this.line, column: 5, source: { path: this.program } },
						{ id: 101, name: 'main', line: 30, column: 1, source: { path: this.program } }
					]
				});
			case 'scopes':
				return this.respond(msg, { scopes: [{ name: 'Locals', variablesReference: args.frameId * 10, expensive: false }, { name: 'Registers', variablesReference: 5, expensive: true }] });
			case 'variables':
				if (args.variablesReference === 1000) return this.respond(msg, { variables: [{ name: 'x', value: '42', type: 'int', variablesReference: 0 }, { name: 'v', value: 'Vec(2)', variablesReference: 7 }] });
				if (args.variablesReference === 7) return this.respond(msg, { variables: [{ name: '[0]', value: '1', variablesReference: 0 }] });
				return this.respond(msg, { variables: [{ name: 'argc', value: '1', variablesReference: 0 }] });
			case 'evaluate':
				if (args.expression === 'boom') return this.respond(msg, undefined, false, 'cannot evaluate');
				return this.respond(msg, { result: `${args.expression}=${args.frameId}`, variablesReference: 0 });
			case 'next':
				this.respond(msg);
				this.line += 1;
				return this.event('stopped', { reason: 'step', threadId: 1 });
			case 'continue':
				this.respond(msg, { allThreadsContinued: true });
				this.event('exited', { exitCode: 0 });
				return this.event('terminated');
			case 'pause':
				this.respond(msg);
				return this.event('stopped', { reason: 'pause', threadId: args.threadId });
			case 'disconnect':
				return this.respond(msg);
			default:
				return this.respond(msg, undefined, false, `unsupported ${msg.command}`);
		}
	}
	launchReq: Request | null = null;
}

function setup(config: Record<string, unknown> = {}, bps: Record<string, SourceBreakpoint[]> = { '/ws/main.py': [{ line: 12 }, { line: 99 }] }) {
	const adapter = new FakeAdapter();
	const client = new DapClient((json) => adapter.receive(json));
	adapter.client = client;
	const log = { models: [] as DebugModel[], stops: [] as (StackFrame | null)[], terminals: [] as RunInTerminalArguments[], terminated: 0 };
	const session = new DebugSession(client, { type: 'debugpy', request: 'launch', name: 'Current File', program: '/ws/main.py', ...config }, {
		breakpoints: () => bps,
		runInTerminal: async (args) => (log.terminals.push(args), { processId: 4242 }),
		changed: (m) => log.models.push(m),
		stopped: (f) => log.stops.push(f),
		terminated: () => log.terminated++
	});
	return { adapter, client, session, log };
}

describe('DebugSession', () => {
	test('the core loop: initialize, launch, breakpoints, stop, inspect, step, continue, terminate', async () => {
		const { adapter, session, log } = setup();
		await session.start();
		const commands = () => adapter.received.map((r) => r.command);
		// Breakpoints and configurationDone follow `initialized`; the default exception filter only.
		expect(commands().slice(0, 5)).toEqual(['initialize', 'launch', 'setBreakpoints', 'setExceptionBreakpoints', 'configurationDone']);
		expect(adapter.received[0].arguments).toMatchObject({ clientID: 'kingu', adapterID: 'debugpy', linesStartAt1: true, pathFormat: 'path', supportsRunInTerminalRequest: true });
		expect(adapter.received[2].arguments).toMatchObject({ source: { name: 'main.py', path: '/ws/main.py' }, breakpoints: [{ line: 12 }, { line: 99 }] });
		expect(adapter.received[3].arguments).toEqual({ filters: ['uncaught'] });

		await until(() => log.stops.length === 1, 'first stop');
		const m = session.model;
		expect(m.state).toBe('stopped');
		expect(m.verified['/ws/main.py'].map((b) => b.verified)).toEqual([true, false]);
		expect(log.stops[0]).toMatchObject({ id: 100, line: 12 });
		expect(m.scopes.map((s) => s.name)).toEqual(['Locals', 'Registers']);
		// Locals were expanded automatically; Registers (expensive) were not.
		expect(m.variables[1000].map((v) => `${v.name}=${v.value}`)).toEqual(['x=42', 'v=Vec(2)']);
		expect(m.variables[5]).toBeUndefined();
		expect(m.output).toEqual([{ category: 'stdout', text: 'hello\n' }]);

		// Lazy expansion, cached per stop.
		expect((await session.expand(7)).map((v) => v.name)).toEqual(['[0]']);
		const before = adapter.received.length;
		await session.expand(7);
		expect(adapter.received.length).toBe(before);

		// Watch / REPL evaluate in the selected frame; another frame changes scopes.
		expect((await session.evaluate('x + 1', 'watch')).result).toBe('x + 1=100');
		await expect(session.evaluate('boom', 'repl')).rejects.toBeInstanceOf(DapError);
		await session.selectFrame(101);
		expect(session.model.frameId).toBe(101);
		expect(session.model.variables[1010]).toBeDefined();
		expect((await session.evaluate('y', 'repl')).result).toBe('y=101');

		// Step over: running at once, then stopped one line further down.
		const stepped = session.next();
		expect(session.model.state).toBe('running');
		await stepped;
		await until(() => log.stops.length === 3, 'step stop');
		expect(session.model.stopped?.reason).toBe('step');
		expect(log.stops[2]).toMatchObject({ line: 13 });
		expect(adapter.received.find((r) => r.command === 'next')?.arguments).toEqual({ threadId: 1 });

		// A breakpoint set while debugging goes straight to the adapter.
		await session.setBreakpoints('/ws/other.py', [{ line: 3, condition: 'i == 2' }]);
		expect(session.model.verified['/ws/other.py']).toEqual([{ id: 1, verified: true, line: 3 }]);

		await session.continue();
		await until(() => log.terminated === 1, 'terminated');
		expect(session.model.state).toBe('terminated');
		expect(session.model.exitCode).toBe(0);
		expect(session.model.frames).toEqual([]);
		// Stepping a finished session does nothing.
		const n = adapter.received.length;
		await session.next();
		await session.setBreakpoints('/ws/main.py', []);
		expect(adapter.received.length).toBe(n);
		await session.disconnect();
		expect(adapter.received.at(-1)).toMatchObject({ command: 'disconnect', arguments: { terminateDebuggee: true } });
	});

	test('runInTerminal reverse request opens a terminal and answers the adapter', async () => {
		const { adapter, session, log } = setup({ console: 'integratedTerminal' });
		await session.start();
		expect(log.terminals).toEqual([{ kind: 'integrated', cwd: '/ws', args: ['python3', '/ws/main.py'], env: { A: '1' } }]);
		await until(() => session.model.state === 'stopped', 'stop');
		expect(adapter.received.map((r) => r.command)).toContain('configurationDone');
	});

	test('pause while running, noDebug and the adapter going away', async () => {
		const { adapter, session, log } = setup({}, {});
		const noDebug = new DebugSession(new DapClient(() => {}), { type: 'go', request: 'launch', name: 'x' }, { breakpoints: () => ({}), runInTerminal: async () => ({}), changed: () => {} }, { noDebug: true });
		expect(noDebug.noDebug).toBe(true);
		await session.start();
		await until(() => log.stops.length === 1, 'stop');
		await session.continue();
		await until(() => session.model.state === 'terminated', 'terminated');
		// A pause only makes sense while running.
		await session.pause();
		expect(adapter.received.some((r) => r.command === 'pause')).toBe(false);
		session.exited(1);
		expect(session.model.output.at(-1)?.text).toContain('code 1');
		await expect(session.client.request('threads')).rejects.toThrow('exited');
	});

	test('launch failures reject start()', async () => {
		const adapter = new FakeAdapter();
		const client = new DapClient((json) => {
			const msg = JSON.parse(json);
			if (msg.command === 'launch') adapter.respond(msg, { error: { id: 1, format: 'program not found: /nope' } }, false, 'launch failed');
			else adapter.receive(json);
		});
		adapter.client = client;
		const session = new DebugSession(client, { type: 'lldb', request: 'launch', name: 'x', program: '/nope' }, { breakpoints: () => ({}), runInTerminal: async () => ({}), changed: () => {} });
		await expect(session.start()).rejects.toThrow('program not found: /nope');
	});

	test('pause sends the first thread', async () => {
		const { adapter, session } = setup({}, {});
		session.model = { ...session.model, state: 'running' };
		await session.pause();
		expect(adapter.received.map((r) => [r.command, r.arguments])).toEqual([
			['threads', undefined],
			['pause', { threadId: 1 }]
		]);
	});
});
