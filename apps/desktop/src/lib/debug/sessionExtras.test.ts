/// <reference types="bun" />
// DebugSession's newer DAP requests against an in-process fake adapter: disassemble, instruction
// breakpoints, stepping by instruction, Step Into Target, read/write memory and the `memory` event,
// loaded sources and their events, breakpoint locations (inline breakpoints), the `invalidated`
// refresh and the output hook serverReadyAction reads.
import { describe, expect, test } from 'bun:test';
import { DapClient } from './client.ts';
import type { Capabilities, InstructionBreakpoint, ProtocolMessage, Request, SourceBreakpoint } from './protocol.ts';
import { DebugSession } from './session.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(cond: () => boolean, what: string) {
	for (let i = 0; i < 500; i++) {
		if (cond()) return;
		await tick();
	}
	throw new Error(`timed out: ${what}`);
}

const MEMORY = Uint8Array.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0xff, 0x10]);

class Adapter {
	seq = 1;
	received: Request[] = [];
	client!: DapClient;
	memory = Uint8Array.from(MEMORY);
	stackCalls = 0;
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
				return this.respond(msg, { breakpoints: a.breakpoints.map((b: SourceBreakpoint, i: number) => ({ id: i + 1, verified: true, line: b.line, column: b.column })) });
			case 'setInstructionBreakpoints':
				return this.respond(msg, { breakpoints: a.breakpoints.map((b: InstructionBreakpoint) => ({ verified: b.instructionReference !== '0xdead' })) });
			case 'configurationDone':
				this.respond(msg);
				return this.stop();
			case 'threads':
				return this.respond(msg, { threads: [{ id: 1, name: 'main' }] });
			case 'stackTrace':
				this.stackCalls++;
				return this.respond(msg, { stackFrames: [{ id: 1, name: 'f', line: 3, column: 1, source: { path: '/ws/a.c' }, instructionPointerReference: '0x1000' }] });
			case 'scopes':
				return this.respond(msg, { scopes: [{ name: 'Locals', variablesReference: 10, expensive: false }] });
			case 'variables':
				return this.respond(msg, { variables: [{ name: 'buf', value: '"Hello"', variablesReference: 0, memoryReference: '0x2000' }] });
			case 'disassemble': {
				const base = parseInt(a.memoryReference, 16);
				const list = Array.from({ length: a.instructionCount }, (_, i) => ({ address: `0x${(base + (a.instructionOffset + i) * 4).toString(16)}`, instruction: `nop ${a.instructionOffset + i}`, instructionBytes: '1f2003d5' }));
				return this.respond(msg, { instructions: list });
			}
			case 'readMemory': {
				const from = parseInt(a.memoryReference, 16) - 0x2000 + a.offset;
				const bytes = this.memory.slice(Math.max(0, from), Math.max(0, from + a.count));
				return this.respond(msg, { address: `0x${(0x2000 + a.offset).toString(16)}`, data: btoa(String.fromCharCode(...bytes)), unreadableBytes: Math.max(0, a.count - bytes.length) });
			}
			case 'writeMemory': {
				const bytes = Uint8Array.from(atob(a.data), (c) => c.charCodeAt(0));
				this.memory.set(bytes, a.offset);
				this.respond(msg, { bytesWritten: bytes.length });
				return this.event('memory', { memoryReference: a.memoryReference, offset: a.offset, count: bytes.length });
			}
			case 'loadedSources':
				return this.respond(msg, { sources: [{ name: 'a.js', path: '/ws/a.js' }, { name: 'internal', sourceReference: 7 }] });
			case 'source':
				return this.respond(msg, { content: `// source ${a.sourceReference}` });
			case 'breakpointLocations':
				return this.respond(msg, { breakpoints: [{ line: a.line, column: 1 }, { line: a.line, column: 9 }, { line: a.line, column: 20 }] });
			case 'stepInTargets':
				return this.respond(msg, { targets: [{ id: 1, label: 'foo()' }, { id: 2, label: 'bar()' }] });
			case 'next':
			case 'stepIn':
			case 'stepOut':
				this.respond(msg);
				return this.stop('step');
			default:
				return this.respond(msg, {});
		}
	}
}

function setup(caps: Capabilities, hooks: { output?: string[]; memory?: [string, number, number][]; instructions?: InstructionBreakpoint[] } = {}) {
	const adapter = new Adapter({ supportsConfigurationDoneRequest: true, ...caps });
	const client = new DapClient((json) => adapter.receive(json));
	adapter.client = client;
	const stops: number[] = [];
	const session = new DebugSession(client, { type: 'lldb', request: 'launch', name: 'Launch', program: '/ws/a.out' }, {
		breakpoints: () => ({ '/ws/a.c': [{ line: 3 }, { line: 3, column: 9 }] }),
		instructionBreakpoints: () => hooks.instructions ?? [],
		runInTerminal: async () => ({}),
		changed: () => {},
		stopped: (f) => f && stops.push(f.line),
		output: (text) => hooks.output?.push(text),
		memory: (ref, offset, count) => hooks.memory?.push([ref, offset, count])
	});
	return { adapter, session, stops };
}

const stopped = (s: DebugSession) => until(() => s.model.state === 'stopped' && s.model.scopes.length > 0, 'stop');

describe('DebugSession: disassembly and instruction breakpoints', () => {
	test('initialize announces memory references; disassemble asks around a reference', async () => {
		const { adapter, session } = setup({ supportsDisassembleRequest: true });
		await session.start();
		await stopped(session);
		expect(adapter.received[0].arguments.supportsMemoryReferences).toBe(true);
		expect(session.model.frames[0].instructionPointerReference).toBe('0x1000');
		const list = await session.disassemble('0x1000', -2, 4);
		expect(list.map((i) => i.address)).toEqual(['0xff8', '0xffc', '0x1000', '0x1004']);
		expect(adapter.received.find((r) => r.command === 'disassemble')?.arguments).toEqual({ memoryReference: '0x1000', offset: 0, instructionOffset: -2, instructionCount: 4, resolveSymbols: true });
	});

	test('without the capability nothing is asked', async () => {
		const { adapter, session } = setup({});
		await session.start();
		await stopped(session);
		expect(await session.disassemble('0x1000', 0, 4)).toEqual([]);
		expect(await session.readMemory('0x2000', 0, 4)).toBeNull();
		expect(await session.loadedSources()).toEqual([]);
		expect(await session.breakpointLocations('/ws/a.c', 3)).toEqual([]);
		expect(await session.stepInTargets()).toEqual([]);
		expect(adapter.received.some((r) => ['disassemble', 'readMemory', 'loadedSources', 'breakpointLocations', 'stepInTargets'].includes(r.command))).toBe(false);
	});

	test('instruction breakpoints go at configuration and on change', async () => {
		const { adapter, session } = setup({ supportsInstructionBreakpoints: true }, { instructions: [{ instructionReference: '0x1004', offset: 0 }] });
		await session.start();
		await stopped(session);
		expect(adapter.received.find((r) => r.command === 'setInstructionBreakpoints')?.arguments).toEqual({ breakpoints: [{ instructionReference: '0x1004', offset: 0 }] });
		const answer = await session.setInstructionBreakpoints([{ instructionReference: '0xdead', offset: 0 }]);
		expect(answer).toEqual([{ verified: false }]);
	});

	test('stepping sends a granularity only to an adapter that takes one', async () => {
		const withIt = setup({ supportsSteppingGranularity: true });
		await withIt.session.start();
		await stopped(withIt.session);
		await withIt.session.next('instruction');
		await stopped(withIt.session);
		await withIt.session.stepIn('instruction');
		await stopped(withIt.session);
		await withIt.session.stepOut();
		expect(withIt.adapter.received.filter((r) => ['next', 'stepIn', 'stepOut'].includes(r.command)).map((r) => r.arguments)).toEqual([
			{ threadId: 1, granularity: 'instruction' },
			{ threadId: 1, granularity: 'instruction' },
			{ threadId: 1 }
		]);
		const without = setup({});
		await without.session.start();
		await stopped(without.session);
		await without.session.next('instruction');
		expect(without.adapter.received.find((r) => r.command === 'next')?.arguments).toEqual({ threadId: 1 });
	});

	test('Step Into Target: the targets of the frame, then stepIn with the chosen one', async () => {
		const { adapter, session } = setup({ supportsStepInTargetsRequest: true });
		await session.start();
		await stopped(session);
		const targets = await session.stepInTargets();
		expect(targets.map((x) => x.label)).toEqual(['foo()', 'bar()']);
		expect(adapter.received.find((r) => r.command === 'stepInTargets')?.arguments).toEqual({ frameId: 1 });
		await session.stepIn(undefined, 2);
		expect(adapter.received.find((r) => r.command === 'stepIn')?.arguments).toEqual({ threadId: 1, targetId: 2 });
	});
});

describe('DebugSession: memory', () => {
	test('readMemory decodes base64 and counts unreadable bytes', async () => {
		const { session } = setup({ supportsReadMemoryRequest: true });
		await session.start();
		await stopped(session);
		await until(() => !!session.model.variables[10], 'locals');
		expect(session.model.variables[10][0].memoryReference).toBe('0x2000');
		const read = await session.readMemory('0x2000', 0, 12);
		expect([...read!.bytes]).toEqual([...MEMORY]);
		expect(read!.unreadable).toBe(4);
		expect(read!.address).toBe('0x2000');
	});

	test('writeMemory sends base64; the memory event reaches the host', async () => {
		const memory: [string, number, number][] = [];
		const { adapter, session } = setup({ supportsReadMemoryRequest: true, supportsWriteMemoryRequest: true }, { memory });
		await session.start();
		await stopped(session);
		expect(await session.writeMemory('0x2000', 1, Uint8Array.from([0x61, 0x62]))).toBe(2);
		expect(adapter.received.find((r) => r.command === 'writeMemory')?.arguments).toEqual({ memoryReference: '0x2000', offset: 1, data: btoa('ab') });
		await until(() => memory.length > 0, 'memory event');
		expect(memory).toEqual([['0x2000', 1, 2]]);
		expect([...(await session.readMemory('0x2000', 0, 3))!.bytes]).toEqual([0x48, 0x61, 0x62]);
	});

	test('a read-only adapter writes nothing', async () => {
		const { adapter, session } = setup({ supportsReadMemoryRequest: true });
		await session.start();
		await stopped(session);
		expect(await session.writeMemory('0x2000', 0, Uint8Array.from([1]))).toBe(0);
		expect(adapter.received.some((r) => r.command === 'writeMemory')).toBe(false);
	});
});

describe('DebugSession: loaded sources, breakpoint locations, events', () => {
	test('loadedSources fills the model; loadedSource events keep it current only after that', async () => {
		const { adapter, session } = setup({ supportsLoadedSourcesRequest: true });
		await session.start();
		await stopped(session);
		adapter.event('loadedSource', { reason: 'new', source: { name: 'early.js', path: '/ws/early.js' } });
		await tick();
		await tick();
		expect(session.model.loadedSources).toBeUndefined();
		await session.loadedSources();
		expect(session.model.loadedSources?.map((s) => s.name)).toEqual(['a.js', 'internal']);
		adapter.event('loadedSource', { reason: 'new', source: { name: 'b.js', path: '/ws/b.js' } });
		adapter.event('loadedSource', { reason: 'removed', source: { name: 'a.js', path: '/ws/a.js' } });
		await until(() => session.model.loadedSources?.length === 2 && session.model.loadedSources[1].name === 'b.js', 'events');
		expect(session.model.loadedSources?.map((s) => s.name)).toEqual(['internal', 'b.js']);
		expect(await session.source({ name: 'internal', sourceReference: 7 })).toEqual({ content: '// source 7' });
		expect(await session.source({ name: 'a.js', path: '/ws/a.js' })).toBeNull();
	});

	test('column breakpoints are sent with their column; breakpointLocations asks for a line', async () => {
		const { adapter, session } = setup({ supportsBreakpointLocationsRequest: true });
		await session.start();
		await stopped(session);
		expect(adapter.received.find((r) => r.command === 'setBreakpoints')?.arguments.breakpoints).toEqual([{ line: 3 }, { line: 3, column: 9 }]);
		const locs = await session.breakpointLocations('/ws/a.c', 3);
		expect(locs.map((l) => l.column)).toEqual([1, 9, 20]);
		expect(adapter.received.find((r) => r.command === 'breakpointLocations')?.arguments).toEqual({ source: { name: 'a.c', path: '/ws/a.c' }, line: 3 });
	});

	test('output reaches the host (not telemetry); invalidated refetches the stack without a new stop', async () => {
		const output: string[] = [];
		const { adapter, session, stops } = setup({}, { output });
		await session.start();
		await stopped(session);
		adapter.event('output', { category: 'stdout', output: 'listening on port 3000\n' });
		adapter.event('output', { category: 'telemetry', output: 'secret' });
		await until(() => output.length > 0, 'output');
		await tick();
		expect(output).toEqual(['listening on port 3000\n']);
		const calls = adapter.stackCalls;
		const before = stops.length;
		adapter.event('invalidated', { areas: ['variables'] });
		await until(() => adapter.stackCalls > calls, 'refetch');
		await tick();
		await tick();
		expect(stops.length).toBe(before);
	});
});
