/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { appendArrayElement, arrayElements, parseJsonc, parseSettingsText, removeArrayElements, setProperty } from './jsonc';

describe('parseSettingsText', () => {
	test('reads comments and trailing commas', () => {
		const text = `// Kingu user settings
		{
			/* theme */ "workbench.colorTheme": "Light Modern",
			"editor.fontSize": 14, // bigger
		}`;
		expect(parseSettingsText(text)).toEqual({ 'workbench.colorTheme': 'Light Modern', 'editor.fontSize': 14 });
	});

	test('empty or comment-only files are empty settings', () => {
		expect(parseSettingsText('')).toEqual({});
		expect(parseSettingsText('  // nothing yet\n')).toEqual({});
	});

	test('rejects non-objects and broken JSON', () => {
		expect(() => parseSettingsText('[1, 2]')).toThrow();
		expect(() => parseSettingsText('{ "a": }')).toThrow();
	});

	test('strings keep their comment lookalikes', () => {
		expect(parseJsonc<object>('{ "editor.fontFamily": "a // b, /* c */", }')).toEqual({ 'editor.fontFamily': 'a // b, /* c */' });
	});
});

describe('setProperty', () => {
	const roundTrip = (text: string) => parseSettingsText(text);

	test('replaces an existing value and keeps comments', () => {
		const text = '{\n\t// size\n\t"editor.fontSize": 12,\n\t"editor.tabSize": 4\n}\n';
		const out = setProperty(text, 'editor.fontSize', 16);
		expect(out).toBe('{\n\t// size\n\t"editor.fontSize": 16,\n\t"editor.tabSize": 4\n}\n');
	});

	test('replaces a nested object value whole', () => {
		const out = setProperty('{ "a": { "b": [1, { "c": 2 }] }, "d": 1 }', 'a', true);
		expect(roundTrip(out)).toEqual({ a: true, d: 1 });
	});

	test('appends after the last property, with or without a trailing comma', () => {
		const a = setProperty('{\n\t"a": 1\n}', 'b', 'x');
		expect(a).toBe('{\n\t"a": 1,\n\t"b": "x"\n}');
		const b = setProperty('{\n  "a": 1, // last\n}', 'b', false);
		expect(roundTrip(b)).toEqual({ a: 1, b: false });
		expect(b).toContain('// last');
		expect(b).toContain('\n  "b": false');
	});

	test('inserts into an empty object or file', () => {
		expect(setProperty('{}', 'a', 1)).toBe('{\n\t"a": 1\n}');
		expect(roundTrip(setProperty('{\n\t// keep me\n}\n', 'a', 1))).toEqual({ a: 1 });
		expect(setProperty('{\n\t// keep me\n}\n', 'a', 1)).toContain('// keep me');
		expect(setProperty('', 'a', 1)).toBe('{\n\t"a": 1\n}\n');
	});

	test('removes a property in any position', () => {
		const text = '{\n\t"a": 1,\n\t"b": 2,\n\t"c": 3\n}';
		expect(setProperty(text, 'a', undefined)).toBe('{\n\t"b": 2,\n\t"c": 3\n}');
		expect(setProperty(text, 'b', undefined)).toBe('{\n\t"a": 1,\n\t"c": 3\n}');
		expect(roundTrip(setProperty(text, 'c', undefined))).toEqual({ a: 1, b: 2 });
		expect(roundTrip(setProperty('{ "only": 1 }', 'only', undefined))).toEqual({});
		expect(setProperty(text, 'missing', undefined)).toBe(text);
	});

	test('keys with escapes and strings with braces do not confuse the scanner', () => {
		const text = '{ "x": "}{,", "we\\"ird": 1 }';
		expect(roundTrip(setProperty(text, 'we"ird', 2))).toEqual({ x: '}{,', 'we"ird': 2 });
	});
});

describe('root array edits', () => {
	test('finds elements past comments and nested values', () => {
		const text = '// x\n[ { "a": [1, 2] }, /* c */ "s", 3 ]';
		expect(arrayElements(text)?.elements.map((e) => text.slice(e.start, e.end))).toEqual(['{ "a": [1, 2] }', '"s"', '3']);
		expect(arrayElements('{}')).toBeNull();
	});

	test('removes elements and fixes commas', () => {
		const text = '[\n\t1,\n\t// two\n\t2,\n\t3\n]\n';
		expect(removeArrayElements(text, [0])).toBe('[\n\t// two\n\t2,\n\t3\n]\n');
		expect(removeArrayElements(text, [2])).toBe('[\n\t1,\n\t// two\n\t2\n]\n');
		expect(parseJsonc<unknown>(removeArrayElements(text, [0, 1, 2]))).toEqual([]);
	});

	test('appends after the last element or into an empty array', () => {
		expect(parseJsonc<unknown>(appendArrayElement('[1]', { a: 1 }))).toEqual([1, { a: 1 }]);
		expect(parseJsonc<unknown>(appendArrayElement('[1,]', 2))).toEqual([1, 2]);
		expect(appendArrayElement('[]', 1)).toBe('[\n\t1\n]');
		expect(appendArrayElement('', 1)).toBe('[\n\t1\n]\n');
	});
});
