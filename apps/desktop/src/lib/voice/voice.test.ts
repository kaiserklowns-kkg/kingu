import { describe, expect, test } from 'bun:test';
import { concat, encodeWav, level, resample, SAMPLE_RATE, toBase64 } from './wav.ts';
import { spaced, targetKind } from './target.ts';
import { elapsed, micConstraints, micErrorKey, onShortcut, voiceOptions } from './dictation.ts';
import { newTask } from '#lib/ade/model.ts';
import { en } from '#lib/i18n/en.ts';

describe('dictation audio', () => {
	test('16 kHz 16-bit mono WAV, clamped', () => {
		const wav = encodeWav(new Float32Array([0, 1, -1, 2]));
		const v = new DataView(wav.buffer);
		const text = (at: number, n: number) => String.fromCharCode(...wav.subarray(at, at + n));
		expect([text(0, 4), text(8, 4), text(12, 4), text(36, 4)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
		expect([v.getUint16(20, true), v.getUint16(22, true), v.getUint32(24, true), v.getUint16(34, true), v.getUint32(40, true)]).toEqual([1, 1, SAMPLE_RATE, 16, 8]);
		expect([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true), v.getInt16(50, true)]).toEqual([0, 32767, -32768, 32767]);
		expect(wav.length).toBe(44 + 8);
	});

	test('resamples 48 kHz to 16 kHz by averaging, and upsamples linearly', () => {
		const down = resample(new Float32Array([0, 0.3, 0.6, 0.9, 0.9, 0.9]), 48_000);
		expect([...down].map((x) => +x.toFixed(3))).toEqual([0.3, 0.9]);
		const up = resample(new Float32Array([0, 1]), 8_000);
		expect([...up].map((x) => +x.toFixed(2))).toEqual([0, 0.5, 1, 1]);
		expect(resample(new Float32Array([0.5]), SAMPLE_RATE)).toEqual(new Float32Array([0.5]));
	});

	test('joins chunks, measures the level, encodes base64 in chunks', () => {
		expect([...concat([new Float32Array([1]), new Float32Array([2, 3])])]).toEqual([1, 2, 3]);
		expect(level(new Float32Array([0.1, -0.7, 0.2]))).toBeCloseTo(0.7);
		expect(toBase64(new Uint8Array([104, 105]))).toBe('aGk=');
		const big = new Uint8Array(100_000).fill(65);
		expect(atob(toBase64(big)).length).toBe(100_000);
	});
});

describe('dictation target', () => {
	const el = (o: { tag: string; type?: string; editable?: boolean; inXterm?: boolean; readOnly?: boolean }) => ({
		tagName: o.tag,
		type: o.type,
		readOnly: o.readOnly,
		isContentEditable: !!o.editable,
		closest: (sel: string) => (sel === '.xterm' && o.inXterm ? ({} as Element) : null)
	});

	test('terminals, text boxes and editables take text; buttons and read-only boxes do not', () => {
		expect(targetKind(el({ tag: 'TEXTAREA', inXterm: true }))).toBe('terminal');
		expect(targetKind(el({ tag: 'TEXTAREA' }))).toBe('text');
		expect(targetKind(el({ tag: 'INPUT', type: 'text' }))).toBe('text');
		expect(targetKind(el({ tag: 'INPUT', type: 'checkbox' }))).toBeNull();
		expect(targetKind(el({ tag: 'INPUT', type: 'password' }))).toBeNull();
		expect(targetKind(el({ tag: 'TEXTAREA', readOnly: true }))).toBeNull();
		expect(targetKind(el({ tag: 'DIV', editable: true }))).toBe('editable');
		expect(targetKind(el({ tag: 'BUTTON' }))).toBeNull();
		expect(targetKind(null)).toBeNull();
	});

	test('a space separates dictated text from the word before it', () => {
		expect(spaced('fix the', 'login page')).toBe(' login page');
		expect(spaced('fix the ', 'login page')).toBe('login page');
		expect(spaced('', 'Hello')).toBe('Hello');
		expect(spaced('done', '.')).toBe('.');
	});
});

describe('dictation rules', () => {
	test('settings become the engine options', () => {
		const values: Record<string, unknown> = { 'kingu.voice.engine': 'openai', 'kingu.voice.language': ' th ', 'kingu.voice.localModel': '/m/ggml-base.bin' };
		expect(voiceOptions((k) => values[k] as never)).toEqual({ engine: 'openai', openaiModel: '', language: 'th', localModel: '/m/ggml-base.bin', whisperPath: '' });
		expect(voiceOptions(() => undefined)).toEqual({ engine: 'local', openaiModel: '', language: 'auto', localModel: '', whisperPath: '' });
	});

	test('the shortcut starts, and in toggle mode stops; hold stops on release', () => {
		expect(onShortcut('idle', 'toggle')).toBe('start');
		expect(onShortcut('idle', 'hold')).toBe('start');
		expect(onShortcut('listening', 'toggle')).toBe('stop');
		expect(onShortcut('listening', 'hold')).toBe('ignore');
		expect(onShortcut('transcribing', 'toggle')).toBe('ignore');
		expect(onShortcut('starting', 'toggle')).toBe('ignore');
	});

	test('time, microphone errors and constraints', () => {
		expect([elapsed(0), elapsed(65_400), elapsed(-5)]).toEqual(['0:00', '1:05', '0:00']);
		expect(micErrorKey(new DOMException('x', 'NotAllowedError'))).toBe('voice.error.micDenied');
		expect(micErrorKey({ name: 'NotFoundError' })).toBe('voice.error.noMic');
		expect(micErrorKey({ name: 'NotReadableError' })).toBe('voice.error.micBusy');
		expect(micErrorKey('weird')).toBe('voice.error.micUnavailable');
		for (const k of ['voice.error.micDenied', 'voice.error.noMic', 'voice.error.micBusy', 'voice.error.micUnavailable']) expect(k in en).toBe(true);
		expect(micConstraints('mic-1', true).audio).toMatchObject({ deviceId: { exact: 'mic-1' } });
		expect(micConstraints('mic-1', false).audio).not.toHaveProperty('deviceId');
		expect(micConstraints('', true).audio).not.toHaveProperty('deviceId');
	});
});

describe('orchestration', () => {
	test('a dispatched task records its dispatcher; yours has none', () => {
		expect(newTask({ slug: 'w', title: 'W', prompt: 'p', base: 'main', dispatchedBy: 'lead' }, 1).dispatched_by).toBe('lead');
		expect(newTask({ slug: 'w', title: 'W', prompt: 'p', base: 'main' }, 1)).not.toHaveProperty('dispatched_by');
	});
});
