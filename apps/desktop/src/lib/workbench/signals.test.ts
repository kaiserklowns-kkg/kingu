import { describe, expect, test } from 'bun:test';
import { plays, taskSignal } from './signals';

describe('accessibility signals', () => {
	test('status changes that sound', () => {
		expect(taskSignal('running', 'waiting')).toBe('attention');
		expect(taskSignal('running', 'review')).toBe('done');
		expect(taskSignal('running', 'failed')).toBe('failed');
		expect(taskSignal(undefined, 'waiting')).toBeNull();
		expect(taskSignal('waiting', 'waiting')).toBeNull();
		expect(taskSignal('waiting', 'running')).toBeNull();
		expect(taskSignal('review', 'done')).toBeNull();
	});
	test('modes', () => {
		expect(plays('off', 'attention')).toBe(false);
		expect(plays('agents', 'done')).toBe(true);
		expect(plays('agents', 'error')).toBe(false);
		expect(plays('all', 'error')).toBe(true);
	});
});
