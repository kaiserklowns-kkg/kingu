/// <reference types="bun" />
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setLocale } from '#lib/i18n/index.ts';
import { argsTemplate, fieldHint, parseArgsJson, parseField, resultText, runnableServers, schemaFields } from './mcpTools';

beforeAll(() => setLocale('en'));
afterAll(() => setLocale('en'));

const schema = {
	type: 'object',
	properties: {
		limit: { type: 'integer', description: 'max rows', default: 10 },
		sql: { type: 'string', description: 'the query' },
		mode: { type: 'string', enum: ['read', 'write'] },
		dry: { type: ['boolean', 'null'] },
		params: { type: 'array' }
	},
	required: ['sql']
};

describe('MCP tool form', () => {
	test('fields from the schema, required first', () => {
		const f = schemaFields(schema);
		expect(f.map((x) => [x.name, x.type, x.required])).toEqual([
			['sql', 'string', true],
			['limit', 'integer', false],
			['mode', 'string', false],
			['dry', 'boolean', false],
			['params', 'json', false]
		]);
		expect(f[2].choices).toEqual(['read', 'write']);
		expect(schemaFields(undefined)).toEqual([]);
	});

	test('typed values become JSON arguments', () => {
		const [sql, limit, mode, dry, params] = schemaFields(schema);
		expect(parseField(sql, '')).toEqual({ error: 'sql is required' });
		expect(parseField(sql, ' select 1 ')).toEqual({ value: ' select 1 ' });
		expect(parseField(limit, '')).toEqual({ value: undefined });
		expect(parseField(limit, '5')).toEqual({ value: 5 });
		expect('error' in parseField(limit, '2.5')).toBe(true);
		expect('error' in parseField(mode, 'drop')).toBe(true);
		expect(parseField(dry, 'yes')).toEqual({ value: true });
		expect(parseField(params, '[1, "a"]')).toEqual({ value: [1, 'a'] });
		expect('error' in parseField(params, '[1,')).toBe(true);
		expect(fieldHint(limit, '')).toBe('limit (integer, optional, Enter to skip) — max rows');
		expect(fieldHint(limit, 'x')).toBe('Type a number (integer)');
	});

	test('the JSON path', () => {
		expect(parseArgsJson('{"sql":"x"}')).toEqual({ value: { sql: 'x' } });
		expect(parseArgsJson('')).toEqual({ value: {} });
		expect('error' in parseArgsJson('[1]')).toBe(true);
		expect(JSON.parse(argsTemplate(schemaFields(schema)))).toEqual({ sql: '', limit: 10, mode: '', dry: false, params: null });
	});

	test('only stdio servers can be run here', () => {
		const out = runnableServers({ a: { command: 'x', args: [], env: {} }, b: { type: 'http', url: 'https://x' } });
		expect(Object.keys(out)).toEqual(['a']);
	});

	test('results as output lines', () => {
		const lines = resultText('go-db', 'query', { sql: 'x' }, {
			isError: true,
			content: [
				{ type: 'text', text: 'row 1' },
				{ type: 'image', mimeType: 'image/png', data: 'AAAA' },
				{ type: 'resource', resource: { uri: 'file:///a', text: 'body' } }
			],
			structuredContent: { rows: 1 }
		});
		expect(lines).toEqual(['▶ go-db · query {"sql":"x"}', '(the tool reported an error)', 'row 1', '[image image/png, 3 bytes]', '[resource file:///a]', 'body', '{\n  "rows": 1\n}', '']);
	});
});
