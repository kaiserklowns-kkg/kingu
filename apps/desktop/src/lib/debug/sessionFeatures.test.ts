/// <reference types="bun" />
// DebugSession's VS Code debugger features against an in-process fake adapter whose capabilities
// each test chooses: exception filters, function and data breakpoints, the hover (evaluate vs.
// the scopes' variables), Run to Cursor, Jump to Cursor, Restart Frame, Step Back, REPL
// completions, Set Value and js-debug's child sessions.
import { describe, expect, test } from 'bun:test';
import { exceptionArgs } from './breakpoints.ts';
import { DapClient } from './client.ts';
import type { Capabilities, ProtocolMessage, Request, SourceBreakpoint, StartDebuggingArguments } from './protocol.ts';
import { DebugSession } from './session.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(cond: () => boolean, what: string) {
	for (let i = 0; i < 500; i++) {
		if (cond()) return;
		await tick();
	}
	throw new Error(`timed out: ${what}`);
}

class Adapter {
	seq = 1;
	received: Request[] = [];
	client!: DapClient;
	sent: Record<string, SourceBreakpoint[]> = {};
	line = 10;
	constructor(readonly caps: Capabilities) {}
	send(msg: Omit<ProtocolMessage, 'seq'>) {
		const json = JSON.stringify({ ...msg, seq: this.seq++ });
		setTimeout(() => this.client.handle(json), 0);
	}
	respond(req: Request, body?: unknown, success = true) {
		this.send({ type: 'response', request_seq: req.seq, command: req.command, success, body } as ProtocolMessage);
	}
	event(event: string, body?: unknown) {
		this.send({ type: 'event', event, body } as ProtocolMessage);
	}
	stop(reason = 'breakpoint') {
		this.event('stopped', { reason, threadId: 1 });
	}
	receive(json: string) {
		const msg = JSON.parse(json) as ProtocolMessage;
		if (msg.type !== 'request') return;
		this.received.push(msg);
		const a = msg.arguments ?? {};
		switch (msg.command) {
			case 'initialize':
				return this.respond(msg, this.caps);
			case 'launch':
				this.respond(msg);
				return this.event('initialized');
			case 'setBreakpoints':
				this.sent[a.source.path] = a.breakpoints;
				return this.respond(msg, { breakpoints: a.breakpoints.map((b: SourceBreakpoint, i: number) => ({ id: i + 1, verified: true, line: b.line })) });
			case 'setFunctionBreakpoints':
				return this.respond(msg, { breakpoints: a.breakpoints.map((b: { name: string }) => ({ verified: b.name !== 'missing', message: b.name === 'missing' ? 'no function' : undefined })) });
			case 'configurationDone':
				this.respond(msg);
				return this.stop();
			case 'threads':
				return this.respond(msg, { threads: [{ id: 1, name: 'main' }] });
			case 'stackTrace':
				return this.respond(msg, { stackFrames: [{ id: 1, name: 'f', line: this.line, column: 1, source: { path: '/ws/a.js' } }] });
			case 'scopes':
				return this.respond(msg, { scopes: [{ name: 'Locals', variablesReference: 10, expensive: false }, { name: 'Closure', variablesReference: 20, expensive: false }, { name: 'Globals', variablesReference: 30, expensive: true }] });
			case 'variables':
				if (a.variablesReference === 10) return this.respond(msg, { variables: [{ name: 'user', value: '{…}', variablesReference: 11 }, { name: 'n', value: '3', variablesReference: 0 }] });
				if (a.variablesReference === 11) return this.respond(msg, { variables: [{ name: 'name', value: '"ana"', variablesReference: 0 }] });
				if (a.variablesReference === 20) return this.respond(msg, { variables: [{ name: 'n', value: '3', variablesReference: 0 }] });
				return this.respond(msg, { variables: [{ name: 'n', value: 'other', variablesReference: 0 }] });
			case 'evaluate':
				return this.respond(msg, { result: `<${a.context}:${a.expression}>`, variablesReference: 0 });
			case 'continue':
				this.respond(msg, {});
				this.line = 20;
				return this.stop('breakpoint');
			case 'gotoTargets':
				return this.respond(msg, { targets: a.line === 99 ? [] : [{ id: 7, label: `line ${a.line}`, line: a.line }] });
			case 'goto':
				this.respond(msg);
				this.line = 15;
				return this.stop('goto');
			case 'restartFrame':
				this.respond(msg);
				return this.stop('restart');
			case 'stepBack':
			case 'reverseContinue':
				this.respond(msg);
				this.line -= 1;
				return this.stop('step');
			case 'completions':
				return this.respond(msg, { targets: [{ label: 'length' }, { label: 'log', text: 'log()' }] });
			case 'setVariable':
				return this.respond(msg, { value: a.value, type: 'number' });
			case 'dataBreakpointInfo':
				return this.respond(msg, { dataId: `${a.variablesReference}:${a.name}`, description: a.name, accessTypes: ['write'], canPersist: false });
			default:
				return this.respond(msg, {});
		}
	}
}

function setup(caps: Capabilities, opts: { type?: string; started?: StartDebuggingArguments[] } = {}) {
	const adapter = new Adapter(caps);
	const client = new DapClient((json) => adapter.receive(json));
	adapter.client = client;
	const stops: number[] = [];
	const session = new DebugSession(client, { type: opts.type ?? 'pwa-node', request: 'launch', name: 'Launch', program: '/ws/a.js' }, {
		breakpoints: () => ({ '/ws/a.js': [{ line: 10, hitCondition: '>= 2' }] }),
		functionBreakpoints: () => [{ name: 'main' }, { name: 'missing', condition: 'x' }],
		exceptionArgs: (c) => exceptionArgs(c.exceptionBreakpointFilters ?? [], { uncaught: { enabled: false }, all: { enabled: true, condition: 'e.code' } }, c),
		dataBreakpoints: () => [],
		runInTerminal: async () => ({}),
		startDebugging: async (args) => void opts.started?.push(args),
		changed: () => {},
		stopped: (f) => f && stops.push(f.line)
	});
	return { adapter, session, stops };
}

const FILTERS = [
	{ filter: 'all', label: 'Caught Exceptions', supportsCondition: true },
	{ filter: 'uncaught', label: 'Uncaught Exceptions', default: true }
];

describe('DebugSession features', () => {
	test('js-debug types go to the adapter as pwa-*; breakpoints, function and exception breakpoints follow the capabilities', async () => {
		const { adapter, session } = setup({ supportsConfigurationDoneRequest: true, supportsFunctionBreakpoints: true, supportsHitConditionalBreakpoints: true, supportsExceptionFilterOptions: true, exceptionBreakpointFilters: FILTERS }, { type: 'node' });
		await session.start();
		await until(() => session.model.scopes.length > 0, 'stop');
		expect(adapter.received[0].arguments.adapterID).toBe('pwa-node');
		expect(adapter.received[1].arguments.type).toBe('pwa-node');
		expect(adapter.sent['/ws/a.js']).toEqual([{ line: 10, hitCondition: '>= 2' }]);
		const fn = adapter.received.find((r) => r.command === 'setFunctionBreakpoints');
		expect(fn?.arguments).toEqual({ breakpoints: [{ name: 'main' }, { name: 'missing', condition: 'x' }] });
		expect(session.model.functionVerified.map((b) => b.verified)).toEqual([true, false]);
		// filterOptions with the condition: only the user's checked filter (the default one was turned off).
		expect(adapter.received.find((r) => r.command === 'setExceptionBreakpoints')?.arguments).toEqual({ filters: [], filterOptions: [{ filterId: 'all', condition: 'e.code' }] });
	});

	test('an adapter without function breakpoints is not asked; without filter options only filter ids go', async () => {
		const { adapter, session } = setup({ supportsConfigurationDoneRequest: true, exceptionBreakpointFilters: FILTERS }, { type: 'lldb' });
		await session.start();
		await until(() => session.model.scopes.length > 0, 'stop');
		expect(adapter.received.some((r) => r.command === 'setFunctionBreakpoints')).toBe(false);
		expect(await session.setFunctionBreakpoints([{ name: 'x' }])).toBeUndefined();
		expect(adapter.received.find((r) => r.command === 'setExceptionBreakpoints')?.arguments).toEqual({ filters: ['all'] });
		expect(adapter.received[0].arguments.adapterID).toBe('lldb');
	});

	test('hover: evaluate in the hover context when supported, else the variable from the scopes', async () => {
		const evaluating = setup({ supportsConfigurationDoneRequest: true, supportsEvaluateForHovers: true });
		await evaluating.session.start();
		await until(() => evaluating.session.model.scopes.length > 0, 'stop');
		expect((await evaluating.session.hover('user.name'))?.result).toBe('<hover:user.name>');

		const { adapter, session } = setup({ supportsConfigurationDoneRequest: true });
		await session.start();
		await until(() => session.model.scopes.length > 0, 'stop');
		expect((await session.hover('user.name'))?.result).toBe('"ana"');
		// `n` is 3 in both cheap scopes (Globals is expensive and never read).
		expect((await session.hover('n'))?.result).toBe('3');
		expect(await session.hover('nope')).toBeNull();
		expect(adapter.received.some((r) => r.command === 'evaluate')).toBe(false);
		expect(adapter.received.some((r) => r.command === 'variables' && r.arguments.variablesReference === 30)).toBe(false);
	});

	test('Run to Cursor adds a temporary breakpoint, continues and removes it at the next stop', async () => {
		const { adapter, session, stops } = setup({ supportsConfigurationDoneRequest: true });
		await session.start();
		await until(() => stops.length === 1, 'first stop');
		await session.runTo('/ws/a.js', 20);
		await until(() => stops.length === 2, 'run to stop');
		expect(stops).toEqual([10, 20]);
		const sends = adapter.received.filter((r) => r.command === 'setBreakpoints').map((r) => r.arguments.breakpoints.map((b: SourceBreakpoint) => b.line));
		expect(sends).toEqual([[10], [10, 20], [10]]);
		// The glyphs only ever see the user's breakpoint.
		expect(session.model.verified['/ws/a.js']).toHaveLength(1);
	});

	test('Jump to Cursor uses goto targets; Restart Frame and Step Back need their capabilities', async () => {
		const { adapter, session, stops } = setup({ supportsConfigurationDoneRequest: true, supportsGotoTargetsRequest: true, supportsRestartFrame: true, supportsStepBack: true });
		await session.start();
		await until(() => stops.length === 1, 'stop');
		expect(await session.jumpTo('/ws/a.js', 99)).toBe(false);
		expect(await session.jumpTo('/ws/a.js', 15)).toBe(true);
		await until(() => stops.length === 2, 'goto stop');
		expect(adapter.received.find((r) => r.command === 'goto')?.arguments).toEqual({ threadId: 1, targetId: 7 });
		await session.restartFrame(1);
		await until(() => stops.length === 3, 'restart stop');
		await session.stepBack();
		await until(() => stops.length === 4, 'step back');
		expect(stops.at(-1)).toBe(14);

		const plain = setup({ supportsConfigurationDoneRequest: true });
		await plain.session.start();
		await until(() => plain.stops.length === 1, 'stop');
		expect(await plain.session.jumpTo('/ws/a.js', 15)).toBe(false);
		await plain.session.stepBack();
		await plain.session.restartFrame(1);
		expect(plain.adapter.received.map((r) => r.command)).not.toContain('stepBack');
		expect(plain.adapter.received.map((r) => r.command)).not.toContain('restartFrame');
	});

	test('REPL completions, Set Value and data breakpoints', async () => {
		const { adapter, session } = setup({ supportsConfigurationDoneRequest: true, supportsCompletionsRequest: true, supportsSetVariable: true, supportsDataBreakpoints: true });
		await session.start();
		await until(() => session.model.scopes.length > 0, 'stop');
		expect((await session.completions('console.l', 10)).map((c) => c.label)).toEqual(['length', 'log']);
		expect(adapter.received.find((r) => r.command === 'completions')?.arguments).toEqual({ text: 'console.l', column: 10, frameId: 1 });
		await session.setVariable(10, 'n', '4');
		expect(session.model.variables[10].find((v) => v.name === 'n')).toMatchObject({ value: '4', type: 'number' });
		const info = await session.dataBreakpointInfo(10, 'n');
		expect(info).toMatchObject({ dataId: '10:n', accessTypes: ['write'] });
		await session.setDataBreakpoints([{ dataId: '10:n', accessType: 'write' }]);
		expect(adapter.received.find((r) => r.command === 'setDataBreakpoints')?.arguments).toEqual({ breakpoints: [{ dataId: '10:n', accessType: 'write' }] });

		const none = setup({ supportsConfigurationDoneRequest: true });
		await none.session.start();
		await until(() => none.session.model.scopes.length > 0, 'stop');
		expect(await none.session.completions('x', 2)).toEqual([]);
		expect(await none.session.dataBreakpointInfo(10, 'n')).toBeNull();
	});

	test("js-debug's startDebugging reverse request goes to the host and is answered", async () => {
		const started: StartDebuggingArguments[] = [];
		const { adapter, session } = setup({ supportsConfigurationDoneRequest: true }, { started });
		await session.start();
		adapter.send({ type: 'request', command: 'startDebugging', arguments: { request: 'launch', configuration: { type: 'pwa-node', __pendingTargetId: 'abc' } } } as ProtocolMessage);
		await until(() => started.length === 1, 'child');
		expect(started[0].configuration.__pendingTargetId).toBe('abc');
	});
});
