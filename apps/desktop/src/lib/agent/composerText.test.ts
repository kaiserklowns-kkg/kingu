import { describe, expect, test } from 'bun:test';
import { taskTitleFromPrompt } from './composerText';

describe('taskTitleFromPrompt', () => {
	test('uses the first non-empty line, whitespace collapsed', () => {
		expect(taskTitleFromPrompt('\n  แก้บั๊ก   หน้า login \nรายละเอียด')).toBe('แก้บั๊ก หน้า login');
	});
	test('cuts long lines with an ellipsis', () => {
		const t = taskTitleFromPrompt('a'.repeat(100), 10);
		expect(t).toBe('a'.repeat(9) + '…');
		expect([...t].length).toBe(10);
	});
	test('empty prompt gives an empty title', () => {
		expect(taskTitleFromPrompt('  \n ')).toBe('');
	});
});
