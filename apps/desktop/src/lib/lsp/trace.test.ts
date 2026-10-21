/// <reference types="bun" />
// `<language>.trace.server`: the messages Kingu and a language server exchange, as the client logs them.
import { describe, expect, test } from 'bun:test';
import { JsonRpc } from './jsonrpc.ts';
import { formatTrace, traceValue, type TraceEvent } from './trace.ts';

const at = new Date(2026, 9, 21, 10, 21, 33);

describe('trace.server', () => {
	test('messages: one line per message; verbose adds params and results', () => {
		const req: TraceEvent = { kind: 'sendRequest', method: 'textDocument/hover', id: 12, params: { position: { line: 1 } } };
		expect(formatTrace(req, false, at)).toEqual([`[Trace - ${at.toLocaleTimeString('en-US')}] Sending request 'textDocument/hover - (12)'.`, '']);
		const verbose = formatTrace(req, true, at);
		expect(verbose[1]).toBe('Params: {');
		expect(verbose.at(-1)).toBe('');
		expect(formatTrace({ kind: 'receiveResponse', method: 'textDocument/hover', id: 12, ms: 3, result: null }, true, at)).toEqual([
			`[Trace - ${at.toLocaleTimeString('en-US')}] Received response 'textDocument/hover - (12)' in 3ms.`,
			'No result returned.',
			''
		]);
		expect(formatTrace({ kind: 'receiveResponse', method: 'x', id: 1, ms: 0, error: { code: -32601, message: 'nope' } }, false, at)[0]).toContain('Request failed: nope (-32601).');
		expect(formatTrace({ kind: 'receiveNotification', method: 'textDocument/publishDiagnostics' }, true, at)[1]).toBe('No parameters provided.');
	});

	test('the setting value', () => {
		expect(traceValue('verbose')).toBe('verbose');
		expect(traceValue('messages')).toBe('messages');
		expect(traceValue(undefined)).toBe('off');
		expect(traceValue('loud')).toBe('off');
	});

	test('JsonRpc reports every message to its tracer', async () => {
		const sent: string[] = [];
		const rpc = new JsonRpc((json) => sent.push(json));
		const events: TraceEvent[] = [];
		rpc.tracer = (ev) => events.push(ev);
		rpc.onRequest('workspace/configuration', () => [{}]);
		const pending = rpc.request('initialize', { a: 1 });
		rpc.notify('initialized', {});
		rpc.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } }));
		await pending;
		rpc.handle(JSON.stringify({ jsonrpc: '2.0', method: 'window/logMessage', params: { message: 'hi' } }));
		rpc.handle(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'workspace/configuration', params: {} }));
		await new Promise((r) => setTimeout(r, 0));
		expect(events.map((e) => `${e.kind} ${e.method}`)).toEqual([
			'sendRequest initialize',
			'sendNotification initialized',
			'receiveResponse initialize',
			'receiveNotification window/logMessage',
			'receiveRequest workspace/configuration',
			'sendResponse workspace/configuration'
		]);
		rpc.tracer = null;
		rpc.notify('exit');
		expect(events).toHaveLength(6);
		expect(sent).toHaveLength(4);
	});
});
