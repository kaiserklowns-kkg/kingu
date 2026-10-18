/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { chatTitlePrompt, MAX_AI_TITLE, parseChatTitle, TITLE_REQUEST_CHARS } from './chatTitle';

describe('chat title prompt', () => {
	test('asks for 3–6 words with the request and the start of the answer', () => {
		const p = chatTitlePrompt('  แก้บั๊ก login ที่ redirect วน  ', 'ปัญหาอยู่ที่ middleware');
		expect(p).toContain('3 to 6 words');
		expect(p).toContain('<request>\nแก้บั๊ก login ที่ redirect วน\n</request>');
		expect(p).toContain('<answer>\nปัญหาอยู่ที่ middleware\n</answer>');
		expect(chatTitlePrompt('x', null)).not.toContain('<answer>');
		expect([...chatTitlePrompt('ก'.repeat(TITLE_REQUEST_CHARS + 100), null)].length).toBeLessThan(TITLE_REQUEST_CHARS + 300);
	});
});

describe('parsing the title', () => {
	test('the first line, without quotes, labels or a final period', () => {
		expect(parseChatTitle('Fix login redirect loop\n')).toBe('Fix login redirect loop');
		expect(parseChatTitle('"Fix login redirect loop."')).toBe('Fix login redirect loop');
		expect(parseChatTitle('\n\nTitle: Explain the chat store')).toBe('Explain the chat store');
		expect(parseChatTitle('**แก้บั๊กหน้า login**')).toBe('แก้บั๊กหน้า login');
		expect(parseChatTitle('# Refactor  agent   host')).toBe('Refactor agent host');
		expect(parseChatTitle('```\nAdd tests\n```')).toBe('Add tests');
	});

	test('nothing usable is null', () => {
		expect(parseChatTitle('')).toBeNull();
		expect(parseChatTitle('  \n ')).toBeNull();
		expect(parseChatTitle('""')).toBeNull();
		expect(parseChatTitle('x'.repeat(MAX_AI_TITLE + 1))).toBeNull();
	});
});
