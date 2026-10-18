import { describe, expect, test } from 'bun:test';
import { delimiterFor, parseCsv } from './csv';

describe('parseCsv', () => {
	test('plain rows, CRLF and a trailing newline', () => {
		expect(parseCsv('a,b\r\n1,2\n')).toEqual([
			['a', 'b'],
			['1', '2']
		]);
	});
	test('quotes hold delimiters, doubled quotes and newlines', () => {
		expect(parseCsv('name,note\n"Doe, J","say ""hi""\nbye"')).toEqual([
			['name', 'note'],
			['Doe, J', 'say "hi"\nbye']
		]);
	});
	test('empty fields and TSV', () => {
		expect(parseCsv('a,,c')).toEqual([['a', '', 'c']]);
		expect(parseCsv('x\ty', delimiterFor('t.TSV'))).toEqual([['x', 'y']]);
	});
});
