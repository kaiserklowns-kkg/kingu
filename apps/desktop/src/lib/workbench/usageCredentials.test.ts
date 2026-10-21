import { describe, expect, test } from 'bun:test';
import { SCHEMA } from '#lib/settings/registry.ts';
import { tIn } from '#lib/i18n/index.ts';
import { CLI_SIGN_INS, pastable, SECRET_FIELDS, SECRET_IDS, toStatus } from './usageCredentials.ts';

describe('usage provider credentials', () => {
	test('one field per Keychain id, its settings registered, its texts in both languages', () => {
		expect(SECRET_FIELDS.map((f) => f.id)).toEqual([...SECRET_IDS]);
		for (const f of SECRET_FIELDS) {
			for (const id of f.settings) expect([id, SCHEMA.has(id)]).toEqual([id, true]);
			for (const l of ['en', 'th'] as const) expect([f.id, !!tIn(l, f.label), !!tIn(l, f.hint)]).toEqual([f.id, true, true]);
		}
		expect(CLI_SIGN_INS.map((c) => c.provider)).toEqual(['cursor', 'grok', 'kimi', 'antigravity']);
	});

	test('Rust answers only whether each is saved', () => {
		expect(toStatus({ 'minimax.cookie': true, 'other.id': true })).toEqual({ 'opencode.apiKey': false, 'opencode.cookie': false, 'minimax.apiKey': false, 'minimax.cookie': true, 'zcode.apiKey': false });
		expect(Object.values(toStatus(null)).every((v) => v === false)).toBe(true);
	});

	test('a pasted value is one non-empty line', () => {
		expect(pastable('  sk-1 ')).toBe(true);
		expect(pastable(' ')).toBe(false);
		expect(pastable('a\nb')).toBe(false);
	});
});
