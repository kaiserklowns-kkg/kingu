import { expect, test } from 'bun:test';
import { queueDefault, sendHowFor, sendMenu } from './requestQueuing';

test('Enter runs the default, ⌥Enter the other one', () => {
	expect(queueDefault('steer')).toBe('steer');
	expect(queueDefault('nonsense')).toBe('queue');
	expect(queueDefault(undefined)).toBe('queue');
	expect(sendHowFor('queue', false)).toBe('queue');
	expect(sendHowFor('queue', true)).toBe('steer');
	expect(sendHowFor('steer', true)).toBe('queue');
	expect(sendMenu('steer')).toEqual([
		{ how: 'queue', key: 'altEnter' },
		{ how: 'steer', key: 'enter' },
		{ how: 'stop', key: null }
	]);
});
