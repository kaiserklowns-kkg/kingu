import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { bellAction, BELL_THROTTLE_MS, noticeFor, noticeState } from './agentNotify';
import { setLocale } from '#lib/i18n/index.ts';

// These tests check the Thai UI text.
beforeAll(() => setLocale('th'));
afterAll(() => setLocale('en'));

const t = { title: 'แก้บั๊ก', lastEvent: 'Claude needs your permission to use Bash' };

describe('agent notifications', () => {
	test('needs a permission answer', () => {
		expect(noticeFor('running', 'waiting', t)).toEqual({ title: 'รอคุณอนุญาต: แก้บั๊ก', body: t.lastEvent, kind: 'attention' });
	});
	test('a finished turn and a failure', () => {
		expect(noticeFor('running', 'review', { title: 'x' })?.title).toBe('เสร็จรอบแล้ว: x');
		expect(noticeFor('running', 'failed', { title: 'x' })?.title).toBe('งานล้มเหลว: x');
	});
	test('a question is its own notice, also after a permission prompt', () => {
		expect(noticeState('waiting', true)).toBe('question');
		expect(noticeState('waiting', false)).toBe('waiting');
		expect(noticeState('review', true)).toBe('review');
		expect(noticeFor('running', 'question', { title: 'x', lastEvent: 'ใช้ branch ไหน?' })).toEqual({ title: 'agent ถามคุณ: x', body: 'ใช้ branch ไหน?', kind: 'attention' });
		expect(noticeFor('waiting', 'question', { title: 'x' })?.kind).toBe('attention');
		expect(noticeFor('question', 'question', { title: 'x' })).toBeNull();
	});
	test('nothing on the first sight, no change, or other moves', () => {
		expect(noticeFor(undefined, 'waiting', t)).toBeNull();
		expect(noticeFor('review', 'review', t)).toBeNull();
		expect(noticeFor('review', 'running', t)).toBeNull();
		expect(noticeFor('review', 'done', t)).toBeNull();
	});
});

describe('terminal bell', () => {
	test('off, or the terminal is on screen: nothing', () => {
		expect(bellAction(false, false, undefined, 0)).toEqual({ mark: false, notify: false });
		expect(bellAction(true, true, undefined, 0)).toEqual({ mark: false, notify: false });
	});
	test('a hidden terminal is marked; it notifies at most once per throttle window', () => {
		expect(bellAction(true, false, undefined, 5)).toEqual({ mark: true, notify: true });
		expect(bellAction(true, false, 5, 5 + BELL_THROTTLE_MS - 1)).toEqual({ mark: true, notify: false });
		expect(bellAction(true, false, 5, 5 + BELL_THROTTLE_MS)).toEqual({ mark: true, notify: true });
	});
});
