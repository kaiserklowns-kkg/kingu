/// <reference types="bun" />
// Hit counts, logpoints and conditions against the adapter's capabilities (VS Code's
// Breakpoint.supported and getBreakpointMessageAndIcon), Toggle Activate Breakpoints, Enable/Disable
// All, function breakpoints, exception filters (the Breakpoints view's checkboxes) and data breakpoints.
import { describe, expect, test } from 'bun:test';
import {
	addFunctionBreakpoint,
	breakpointMessage,
	dataBreakpoints,
	exceptionArgs,
	exceptionRows,
	functionBreakpoints,
	glyphs,
	isSupported,
	parseExceptionSettings,
	parseFunctionBreakpoints,
	parseStored,
	persistentData,
	setAllEnabled,
	setCondition,
	setException,
	setHitCondition,
	setLogMessage,
	sourceBreakpoints,
	toggle
} from './breakpoints.ts';
import type { ExceptionFilter } from './protocol.ts';

describe('source breakpoints', () => {
	test('condition, hit count and log message map to DAP SourceBreakpoint fields', () => {
		let m = toggle({}, 'a.ts', 3);
		m = setCondition(m, 'a.ts', 3, ' i > 1 ');
		m = setHitCondition(m, 'a.ts', 3, '>= 5');
		m = setLogMessage(m, 'a.ts', 8, 'i is {i}');
		expect(sourceBreakpoints(m['a.ts'])).toEqual([
			{ line: 3, condition: 'i > 1', hitCondition: '>= 5' },
			{ line: 8, logMessage: 'i is {i}' }
		]);
		// Clearing the hit count keeps the condition.
		m = setHitCondition(m, 'a.ts', 3, '  ');
		expect(m['a.ts'][0]).toEqual({ line: 3, condition: 'i > 1', enabled: true });
		// Deactivated breakpoints send nothing (and show disabled).
		expect(sourceBreakpoints(m['a.ts'], undefined, false)).toEqual([]);
		expect(glyphs(m['a.ts'], undefined, undefined, undefined, false).map((g) => g.kind)).toEqual(['disabled', 'disabled']);
		// Stored hit counts survive a reload.
		expect(parseStored(JSON.stringify({ 'a.ts': [{ line: 3, hitCondition: '5', logMessage: '' }] }))).toEqual({ 'a.ts': [{ line: 3, hitCondition: '5', enabled: true }] });
	});

	test('VS Code messages for the glyph hover', () => {
		expect(breakpointMessage({ condition: 'x', hitCondition: '3' })).toBe('Condition: x\nHit Count: 3');
		expect(breakpointMessage({ logMessage: 'v={v}' })).toBe('Log Message: v={v}');
		expect(breakpointMessage({ triggeredBy: 'a.ts:2' })).toBe('Hit after breakpoint: a.ts:2');
		expect(breakpointMessage({})).toBeNull();
	});

	test('a breakpoint using a feature the adapter lacks is shown unsupported', () => {
		const list = [
			{ line: 1, enabled: true, logMessage: 'hi' },
			{ line: 2, enabled: true, condition: 'x' },
			{ line: 3, enabled: true, hitCondition: '2' },
			{ line: 4, enabled: true }
		];
		const answer = list.map((b) => ({ verified: true, line: b.line }));
		expect(isSupported(list[0], { supportsLogPoints: true })).toBe(true);
		expect(isSupported(list[2], { supportsConditionalBreakpoints: true })).toBe(false);
		const none = glyphs(list, answer, undefined, {});
		expect(none.map((g) => g.kind)).toEqual(['unsupported', 'unsupported', 'unsupported', 'verified']);
		expect(none[1].hover).toBe('Breakpoints of this type are not supported by the debugger\nCondition: x');
		const all = glyphs(list, answer, undefined, { supportsLogPoints: true, supportsConditionalBreakpoints: true, supportsHitConditionalBreakpoints: true });
		expect(all.map((g) => g.kind)).toEqual(['log', 'conditional', 'conditional', 'verified']);
		// An unverified logpoint says so, unless the adapter gave a reason.
		expect(glyphs([list[0]], [{ verified: false }])[0].hover).toBe('Unverified Logpoint');
		expect(glyphs([list[0]], [{ verified: false, message: 'No code' }])[0].hover).toBe('No code');
	});

	test('Enable All / Disable All', () => {
		const m = toggle(toggle({}, 'a', 1), 'b', 2);
		const off = setAllEnabled(m, false);
		expect(Object.values(off).flat().every((b) => !b.enabled)).toBe(true);
		expect(Object.values(setAllEnabled(off, true)).flat().every((b) => b.enabled)).toBe(true);
	});
});

describe('function breakpoints', () => {
	test('added once by name, enabled ones sent, stored and read back', () => {
		let list = addFunctionBreakpoint([], ' main ');
		list = addFunctionBreakpoint(list, 'main');
		list = addFunctionBreakpoint(list, '');
		list = addFunctionBreakpoint(list, 'helper');
		expect(list.map((f) => f.name)).toEqual(['main', 'helper']);
		list = [{ ...list[0], condition: 'argc > 1' }, { ...list[1], enabled: false }];
		expect(functionBreakpoints(list)).toEqual([{ name: 'main', condition: 'argc > 1' }]);
		expect(functionBreakpoints(list, false)).toEqual([]);
		expect(parseFunctionBreakpoints(JSON.stringify([...list, { name: '' }, 3]))).toEqual([{ name: 'main', enabled: true, condition: 'argc > 1' }, { name: 'helper', enabled: false }]);
		expect(parseFunctionBreakpoints('nope')).toEqual([]);
	});
});

describe('exception breakpoints', () => {
	const filters: ExceptionFilter[] = [
		{ filter: 'raised', label: 'Raised Exceptions', supportsCondition: true },
		{ filter: 'uncaught', label: 'Uncaught Exceptions', default: true },
		{ filter: 'userUnhandled', label: 'User Uncaught Exceptions' }
	];

	test("the view's checkboxes: the user's choice, else the filter's default", () => {
		expect(exceptionRows(filters, {}).map((r) => [r.filter.filter, r.enabled])).toEqual([
			['raised', false],
			['uncaught', true],
			['userUnhandled', false]
		]);
		let state = setException({}, 'uncaught', false);
		state = setException(state, 'raised', true, ' type(e) is KeyError ');
		expect(exceptionRows(filters, state).map((r) => [r.filter.filter, r.enabled, r.condition ?? ''])).toEqual([
			['raised', true, 'type(e) is KeyError'],
			['uncaught', false, ''],
			['userUnhandled', false, '']
		]);
		// Unchecking keeps the condition for later; clearing it removes it.
		expect(setException(state, 'raised', false).raised).toEqual({ enabled: false, condition: 'type(e) is KeyError' });
		expect(setException(state, 'raised', true, '').raised).toEqual({ enabled: true });
	});

	test('setExceptionBreakpoints arguments: filters, or filterOptions with conditions', () => {
		const state = setException(setException({}, 'raised', true, 'x'), 'userUnhandled', true);
		expect(exceptionArgs(filters, state, {})).toEqual({ filters: ['raised', 'uncaught', 'userUnhandled'] });
		expect(exceptionArgs(filters, state, { supportsExceptionFilterOptions: true })).toEqual({
			filters: [],
			filterOptions: [{ filterId: 'raised', condition: 'x' }, { filterId: 'uncaught' }, { filterId: 'userUnhandled' }]
		});
		// A condition on a filter that takes none is not sent.
		const odd = setException({}, 'uncaught', true, 'y');
		expect(exceptionArgs(filters, odd, { supportsExceptionFilterOptions: true }).filterOptions).toContainEqual({ filterId: 'uncaught' });
	});

	test('the remembered filters and state are validated on load', () => {
		const text = JSON.stringify({ filters: [...filters, { label: 'no id' }], state: { raised: { enabled: true, condition: 'c' }, bad: { enabled: 'yes' } } });
		expect(parseExceptionSettings(text)).toEqual({ filters, state: { raised: { enabled: true, condition: 'c' } } });
		expect(parseExceptionSettings(null)).toEqual({ filters: [], state: {} });
	});
});

describe('data breakpoints', () => {
	test('enabled ones are sent; only those that can persist outlive the session', () => {
		const list = [
			{ dataId: 'a', description: 'x', accessType: 'write' as const, enabled: true, canPersist: false },
			{ dataId: 'b', description: 'y', accessType: 'read' as const, enabled: false, canPersist: true }
		];
		expect(dataBreakpoints(list)).toEqual([{ dataId: 'a', accessType: 'write' }]);
		expect(dataBreakpoints(list, false)).toEqual([]);
		expect(persistentData(list).map((d) => d.dataId)).toEqual(['b']);
	});
});
