import { describe, expect, test } from 'bun:test';
import { pushNotice, type Notice } from './notifications';

const n = (id: number, message: string, severity: Notice['severity'] = 'error'): Notice => ({ id, severity, message, at: id, count: 1 });

describe('pushNotice', () => {
	test('newest first, capped', () => {
		let list: Notice[] = [];
		for (let i = 1; i <= 4; i++) list = pushNotice(list, n(i, `m${i}`), 3);
		expect(list.map((x) => x.message)).toEqual(['m4', 'm3', 'm2']);
	});

	test('a repeat bumps the count instead of adding a row', () => {
		const list = pushNotice(pushNotice([], n(1, 'boom')), n(2, 'boom'));
		expect(list).toEqual([{ id: 1, severity: 'error', message: 'boom', at: 2, count: 2 }]);
		expect(pushNotice(list, n(3, 'boom', 'warning'))).toHaveLength(2);
	});
});
