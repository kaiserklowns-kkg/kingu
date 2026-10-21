import { describe, expect, test } from 'bun:test';
import { autoInsertAt, customDataUris, type ContentChange } from './htmlExtras.ts';

const typed = (text: string, line = 3, column = 10, rangeLength = 0): ContentChange => ({ text, rangeLength, range: { startLineNumber: line, startColumn: column } });
const on = { autoClose: true, autoQuote: true };

describe('html auto insert', () => {
	test('> and / close tags, = creates quotes, after the typed character', () => {
		expect(autoInsertAt([typed('>')], on, false)).toEqual({ kind: 'autoClose', line: 3, column: 11 });
		expect(autoInsertAt([typed('/')], on, false)).toEqual({ kind: 'autoClose', line: 3, column: 11 });
		expect(autoInsertAt([typed('=')], on, false)).toEqual({ kind: 'autoQuote', line: 3, column: 11 });
		// A paste ending in `>` counts, from where it ends.
		expect(autoInsertAt([typed('<div>', 1, 1)], on, false)).toEqual({ kind: 'autoClose', line: 1, column: 6 });
		// Only the last change of the edit (several cursors).
		expect(autoInsertAt([typed('a'), typed('>', 5, 2)], on, false)).toEqual({ kind: 'autoClose', line: 5, column: 3 });
	});

	test('nothing for other edits, undo/redo or when switched off', () => {
		expect(autoInsertAt([typed('a')], on, false)).toBeNull();
		expect(autoInsertAt([typed('>', 3, 10, 2)], on, false)).toBeNull();
		expect(autoInsertAt([typed('a\n>')], on, false)).toBeNull();
		expect(autoInsertAt([typed('')], on, false)).toBeNull();
		expect(autoInsertAt([], on, false)).toBeNull();
		expect(autoInsertAt([typed('>')], on, true)).toBeNull();
		expect(autoInsertAt([typed('>')], { autoClose: false, autoQuote: true }, false)).toBeNull();
		expect(autoInsertAt([typed('=')], { autoClose: true, autoQuote: false }, false)).toBeNull();
	});
});

describe('custom data', () => {
	test('folder values against their folder; the first folder also takes the workspace file and user values', () => {
		const uris = customDataUris(
			[
				{ path: '/w/app', value: ['./data/html.json', 'https://example.com/tags.json'] },
				{ path: '/w/lib', value: ['../shared/more.json', 42] }
			],
			['ws.json'],
			['/abs/user.json', 'rel user.json', '']
		);
		expect(uris).toEqual([
			'file:///w/app/data/html.json',
			'https://example.com/tags.json',
			'file:///w/app/ws.json',
			'file:///abs/user.json',
			'file:///w/app/rel%20user.json',
			'file:///w/shared/more.json'
		]);
	});

	test('no folders or no values: nothing', () => {
		expect(customDataUris([], ['a.json'], ['b.json'])).toEqual([]);
		expect(customDataUris([{ path: '/w' }], undefined, 'x')).toEqual([]);
		expect(customDataUris([{ path: '/w', value: ['a.json', './a.json'] }], undefined, undefined)).toEqual(['file:///w/a.json']);
	});
});
