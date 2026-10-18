import { describe, expect, test } from 'bun:test';
import { noticeFor } from './agentNotify';

const t = { title: 'แก้บั๊ก', lastEvent: 'Claude needs your permission to use Bash' };

describe('agent notifications', () => {
	test('needs a permission answer', () => {
		expect(noticeFor('running', 'waiting', t)).toEqual({ title: 'รอคุณอนุญาต: แก้บั๊ก', body: t.lastEvent, kind: 'attention' });
	});
	test('a finished turn and a failure', () => {
		expect(noticeFor('running', 'review', { title: 'x' })?.title).toBe('เสร็จรอบแล้ว: x');
		expect(noticeFor('running', 'failed', { title: 'x' })?.title).toBe('งานล้มเหลว: x');
	});
	test('nothing on the first sight, no change, or other moves', () => {
		expect(noticeFor(undefined, 'waiting', t)).toBeNull();
		expect(noticeFor('review', 'review', t)).toBeNull();
		expect(noticeFor('review', 'running', t)).toBeNull();
		expect(noticeFor('review', 'done', t)).toBeNull();
	});
});
