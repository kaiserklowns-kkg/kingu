/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { appendOutput, applyEvent, currentFrame, frameLocation, initialModel, OUTPUT_LIMIT, selectFrame, stateLabel, withBreakpoints, withFrames, withScopes, withVariables } from './model.ts';
import type { Event } from './protocol.ts';

const ev = (event: string, body?: unknown): Event => ({ seq: 1, type: 'event', event, body });

test('stopped → frames → scopes → variables, cleared on continue', () => {
	let m = applyEvent(initialModel(), ev('stopped', { reason: 'breakpoint', threadId: 7 }));
	expect(m.state).toBe('stopped');
	expect(m.stopped).toEqual({ threadId: 7, reason: 'breakpoint', description: undefined });
	expect(stateLabel(m)).toBe('หยุด (breakpoint)');
	// The top frame without source (a libc frame) is skipped when selecting.
	m = withFrames(m, [
		{ id: 1, name: '__pthread_kill', line: 0, column: 0, presentationHint: 'subtle' },
		{ id: 2, name: 'main', line: 4, column: 3, source: { path: '/ws/src/main.c' } }
	]);
	expect(currentFrame(m)?.name).toBe('main');
	m = withScopes(m, 2, [{ name: 'Locals', variablesReference: 10, expensive: false }]);
	m = withScopes(m, 99, [{ name: 'stale', variablesReference: 1, expensive: false }]);
	expect(m.scopes.map((s) => s.name)).toEqual(['Locals']);
	m = withVariables(m, 10, [{ name: 'x', value: '1', variablesReference: 0 }]);
	expect(m.variables[10][0].value).toBe('1');
	expect(selectFrame(m, 2)).toBe(m);
	const other = selectFrame(m, 1);
	expect([other.frameId, other.scopes, other.variables]).toEqual([1, [], {}]);

	m = applyEvent(m, ev('continued', { threadId: 7 }));
	expect([m.state, m.frames, m.frameId, m.stopped]).toEqual(['running', [], null, null]);
});

test('output, exit and termination', () => {
	let m = applyEvent(initialModel(), ev('output', { category: 'stdout', output: 'สวัสดี\n' }));
	m = applyEvent(m, ev('output', { category: 'telemetry', output: '{"x":1}' }));
	m = applyEvent(m, ev('exited', { exitCode: 3 }));
	m = applyEvent(m, ev('terminated'));
	expect(m.output[0]).toEqual({ category: 'stdout', text: 'สวัสดี\n' });
	expect(m.output).toHaveLength(2);
	expect(m.output[1].text).toContain('exit code 3');
	expect([m.state, m.exitCode, stateLabel(m)]).toEqual(['terminated', 3, 'จบแล้ว']);
	// A late `continued` does not revive a finished session.
	expect(applyEvent(m, ev('continued', {})).state).toBe('terminated');
	expect(stateLabel(null)).toBe('');
});

test('output is capped', () => {
	let m = initialModel();
	for (let i = 0; i < OUTPUT_LIMIT + 10; i++) m = appendOutput(m, 'stdout', `${i}\n`);
	expect(m.output).toHaveLength(OUTPUT_LIMIT);
	expect(m.output[0].text).toBe('10\n');
	expect(appendOutput(m, 'stdout', '')).toBe(m);
});

test('breakpoint events update verification by id', () => {
	let m = withBreakpoints(initialModel(), '/ws/a.go', [
		{ id: 1, verified: false, line: 3 },
		{ id: 2, verified: true, line: 8 }
	]);
	m = applyEvent(m, ev('breakpoint', { reason: 'changed', breakpoint: { id: 1, verified: true, line: 4 } }));
	expect(m.verified['/ws/a.go']).toEqual([
		{ id: 1, verified: true, line: 4 },
		{ id: 2, verified: true, line: 8 }
	]);
	expect(applyEvent(m, ev('breakpoint', { breakpoint: { verified: true } }))).toBe(m);
});

test('frame locations are workspace-relative or null', () => {
	const f = (path?: string) => ({ id: 1, name: 'f', line: 12, column: 0, source: path ? { path } : undefined });
	expect(frameLocation(f('/Users/me/ws/src/ไฟล์.rs'), '/Users/me/ws')).toEqual({ rel: 'src/ไฟล์.rs', line: 12, column: 1 });
	expect(frameLocation(f('/Users/me/wsx/a.rs'), '/Users/me/ws')).toBeNull();
	expect(frameLocation(f(), '/Users/me/ws')).toBeNull();
	expect(frameLocation(null, '/ws')).toBeNull();
});

test('output of another kind starts on a new line', () => {
	let m = appendOutput(initialModel(), 'console', 'warning: no rust plugin.');
	m = appendOutput(m, 'stdout', 'answer = 42\n');
	m = appendOutput(m, 'stdout', 'more');
	expect(m.output.map((o) => o.text)).toEqual(['warning: no rust plugin.', '\nanswer = 42\n', 'more']);
});
