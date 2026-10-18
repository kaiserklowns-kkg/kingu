import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chatNoticeFor, noticeFor, noticeState } from './agentNotify';
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

describe('agent chat notifications', () => {
	test('approval, a question, a finished or failed turn; nothing else', () => {
		expect(chatNoticeFor({ kind: 'permission_request', tool: 'Bash' }, 'แก้บั๊ก')).toEqual({ title: 'แชตรอการอนุญาต: แก้บั๊ก', body: 'ต้องอนุญาตก่อนจึงจะทำงานต่อได้', kind: 'attention' });
		expect(chatNoticeFor({ kind: 'permission_request', tool: 'AskUserQuestion' }, 'x')?.title).toBe('แชตมีคำถาม: x');
		expect(chatNoticeFor({ kind: 'result', is_error: false }, 'x')).toMatchObject({ title: 'แชตเสร็จแล้ว: x', kind: 'finished' });
		expect(chatNoticeFor({ kind: 'result', is_error: true }, 'x')?.kind).toBe('attention');
		expect(chatNoticeFor({ kind: 'result', is_error: false }, 'x', 'attention')).toBeNull();
		expect(chatNoticeFor({ kind: 'tool_use' }, 'x')).toBeNull();
	});
});
