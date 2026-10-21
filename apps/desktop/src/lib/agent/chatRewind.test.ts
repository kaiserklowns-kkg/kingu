import { describe, expect, test } from 'bun:test';
import { confirmAnswer, forkTitle, lastCheckpoint, rewoundMeta } from './chatRewind';
import type { Turn } from './chatParts';

const turn = (text: string | null, checkpoint?: number | null): Turn => ({
	request: text === null ? null : { text, files: [], images: [], sent: text },
	parts: [],
	result: null,
	done: true,
	checkpoint
});

describe('chat rewind', () => {
	test('retry rewinds to the last request only when it has a checkpoint', () => {
		expect(lastCheckpoint([turn('a', 0), turn('b', 1), turn(null)])).toBe(1);
		expect(lastCheckpoint([turn('a', 0), turn('old')])).toBeNull();
		expect(lastCheckpoint([])).toBeNull();
	});

	test('a rewind without a session drops its resume point', () => {
		expect(rewoundMeta({ session_id: 's-1', resume_at: 'u' })).toEqual({ session_id: 's-1', resume_at: 'u' });
		expect(rewoundMeta({ session_id: null, resume_at: 'u' })).toEqual({ session_id: null, resume_at: null });
	});

	test('fork titles get the prefix once', () => {
		const format = (title: string) => `Forked: ${title}`;
		expect(forkTitle('Fix login', 'Forked: ', format)).toBe('Forked: Fix login');
		expect(forkTitle('Forked: Fix login', 'Forked: ', format)).toBe('Forked: Fix login');
	});

	test('the confirm: Yes, Yes and stop asking, or Cancel', () => {
		expect(confirmAnswer(0)).toEqual({ go: true, dontAsk: false });
		expect(confirmAnswer(1)).toEqual({ go: true, dontAsk: true });
		expect(confirmAnswer(2)).toEqual({ go: false, dontAsk: false });
	});
});
