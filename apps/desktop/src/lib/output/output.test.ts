/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { afterClear, appendLines, filterLines, isOutputKey, outputChannelOf, outputKey, parseLineFilter, smartScrollLock, sortChannels, textLines } from './output.ts';

describe('output channels', () => {
	test('appendLines splits text, drops a trailing newline and keeps the limit', () => {
		expect(appendLines(['a'], 'b\r\nc\n')).toEqual(['a', 'b', 'c']);
		expect(appendLines(['a', 'b'], ['c', 'd'], 3)).toEqual(['b', 'c', 'd']);
		expect(textLines('')).toEqual([]);
		expect(textLines('x\ny\n')).toEqual(['x', 'y']);
	});

	test('editor keys', () => {
		expect(outputKey('Git')).toBe('output:Git');
		expect(isOutputKey('output:Git')).toBe(true);
		expect(isOutputKey('src/output.ts')).toBe(false);
		expect(outputChannelOf('output:TypeScript language server')).toBe('TypeScript language server');
	});

	test('filter: terms, ! excludes, case-insensitive', () => {
		expect(parseLineFilter(' err, !debug ,')).toEqual({ include: ['err'], exclude: ['debug'] });
		const lines = ['[info] start', '[error] boom', '[debug] error detail'];
		expect(filterLines(lines, 'ERROR')).toEqual(['[error] boom', '[debug] error detail']);
		expect(filterLines(lines, 'error, !debug')).toEqual(['[error] boom']);
		expect(filterLines(lines, '!info')).toEqual(['[error] boom', '[debug] error detail']);
		expect(filterLines(lines, '  ')).toBe(lines);
	});

	test('afterClear shows what came after the last cleared line', () => {
		expect(afterClear(['a', 'b', 'c'], null)).toEqual(['a', 'b', 'c']);
		expect(afterClear(['a', 'b', 'c'], 'b')).toEqual(['c']);
		expect(afterClear(['x', 'y'], 'gone')).toEqual(['x', 'y']);
	});

	test('sortChannels and smart scroll', () => {
		expect(sortChannels([{ label: 'Tasks' }, { label: 'Git' }, { label: 'Kingu' }]).map((c) => c.label)).toEqual(['Git', 'Kingu', 'Tasks']);
		expect(smartScrollLock(false, true, false)).toBe(true);
		expect(smartScrollLock(true, true, true)).toBe(false);
		expect(smartScrollLock(true, false, true)).toBe(true);
	});
});
