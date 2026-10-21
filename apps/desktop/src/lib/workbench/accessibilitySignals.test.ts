/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { hasFoldedAreaAt, lineSignalsToPlay, signalGain, signalModes, SIGNAL_IDS, SIGNAL_SETTINGS, SIGNAL_TONES, type LineSignal } from './accessibilitySignals';
import { SETTINGS } from '#lib/settings/registry.ts';

const state = (line: number, signals: LineSignal[], uri = 'file:///a.ts') => ({ line, uri, signals: new Set(signals) });

describe('accessibility signals', () => {
	test('auto plays only in screen reader mode; on and off are absolute', () => {
		expect(signalModes('lineHasError', { sound: 'auto', announcement: 'auto' }, { screenReader: false })).toEqual({ sound: false, announce: false });
		expect(signalModes('lineHasError', { sound: 'auto', announcement: 'auto' }, { screenReader: true })).toEqual({ sound: true, announce: true });
		expect(signalModes('lineHasError', { sound: 'on', announcement: 'off' }, { screenReader: false })).toEqual({ sound: true, announce: false });
		expect(signalModes('taskFailed', undefined, { screenReader: true })).toEqual({ sound: true, announce: true });
	});

	test('save: userGesture, always, never', () => {
		expect(signalModes('save', { sound: 'never', announcement: 'never' }, { screenReader: true, userGesture: true })).toEqual({ sound: false, announce: false });
		expect(signalModes('save', { sound: 'userGesture', announcement: 'always' }, { screenReader: false, userGesture: false })).toEqual({ sound: false, announce: true });
		expect(signalModes('save', { sound: 'userGesture' }, { screenReader: false, userGesture: true })).toEqual({ sound: true, announce: false });
	});

	test('moving to a line plays what holds there; staying plays what appeared', () => {
		expect(lineSignalsToPlay(null, state(3, ['lineHasBreakpoint', 'lineHasError']))).toEqual(['lineHasError', 'lineHasBreakpoint']);
		expect(lineSignalsToPlay(state(3, ['lineHasError']), state(4, ['lineHasError']))).toEqual(['lineHasError']);
		expect(lineSignalsToPlay(state(3, ['lineHasError']), state(3, ['lineHasError']))).toEqual([]);
		expect(lineSignalsToPlay(state(3, []), state(3, ['lineHasWarning']))).toEqual(['lineHasWarning']);
		expect(lineSignalsToPlay(state(3, ['lineHasError']), state(3, ['lineHasError'], 'file:///b.ts'))).toEqual(['lineHasError']);
	});

	test('a folded area is a jump in the visible ranges', () => {
		const visible = [
			{ startLineNumber: 1, endLineNumber: 10 },
			{ startLineNumber: 20, endLineNumber: 40 }
		];
		expect(hasFoldedAreaAt(10, visible)).toBe(true);
		expect(hasFoldedAreaAt(9, visible)).toBe(false);
		expect(hasFoldedAreaAt(40, visible)).toBe(false);
		expect(hasFoldedAreaAt(5, [{ startLineNumber: 1, endLineNumber: 5 }, { startLineNumber: 6, endLineNumber: 9 }])).toBe(false);
	});

	test('volume', () => {
		expect(signalGain(0)).toBe(0);
		expect(signalGain(100)).toBeCloseTo(0.17);
		expect(signalGain('loud')).toBeCloseTo(signalGain(70));
	});

	test('every signal has tones and a setting', () => {
		for (const id of SIGNAL_IDS) {
			expect(SIGNAL_TONES[id].length).toBeGreaterThan(0);
			expect(SETTINGS.some((s) => s.id === SIGNAL_SETTINGS[id])).toBe(true);
		}
	});
});
