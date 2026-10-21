import { describe, expect, test } from 'bun:test';
import { FALLBACK_MODELS, friendlyModel, modelChoices, modelSublabel, parseCachedModels } from './modelChoices.ts';

describe('modelChoices', () => {
	const listed = [
		{ value: 'default', display_name: 'Default (recommended)', description: 'Opus' },
		{ value: 'sonnet', display_name: 'Sonnet', description: 'Fast' }
	];

	test('falls back to the aliases until a session lists its models', () => {
		expect(modelChoices(null, null, []).map((c) => c.value)).toEqual(FALLBACK_MODELS.map((m) => m.value));
	});

	test("the listed models, with the chat's own and the default first when not listed", () => {
		expect(modelChoices('claude-opus-5-5', 'sonnet', listed)).toEqual([
			{ value: 'claude-opus-5-5', label: 'Opus 5.5', description: 'claude-opus-5-5' },
			{ value: 'default', label: 'Default (recommended)', description: 'Opus' },
			{ value: 'sonnet', label: 'Sonnet', description: 'Fast' }
		]);
		expect(modelChoices('sonnet', 'sonnet', listed).map((c) => c.value)).toEqual(['default', 'sonnet']);
	});

	test('friendly names and second lines that never repeat the label', () => {
		expect(friendlyModel('claude-opus-5-5')).toBe('Opus 5.5');
		expect(friendlyModel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
		expect(friendlyModel('opus')).toBe('Opus');
		expect(friendlyModel('claude-opus-4-1[1m]')).toBe('Opus 4.1 1M');
		expect(friendlyModel('gpt-5')).toBe('gpt-5');
		expect(modelSublabel({ value: 'opus', label: 'Opus', description: '' })).toBeUndefined();
		expect(modelSublabel({ value: 'sonnet', label: 'Sonnet', description: 'sonnet' })).toBeUndefined();
		expect(modelSublabel({ value: 'sonnet', label: 'Sonnet', description: 'Fast' })).toBe('Fast');
		expect(modelSublabel({ value: 'claude-opus-5-5', label: 'Opus 5.5', description: '' })).toBe('claude-opus-5-5');
	});

	test('reads back only well-formed cached rows', () => {
		expect(parseCachedModels(JSON.stringify([{ value: 'opus', display_name: 'Opus' }, { value: 1 }, null]))).toEqual([{ value: 'opus', display_name: 'Opus', description: '' }]);
		expect(parseCachedModels('nope')).toEqual([]);
		expect(parseCachedModels(null)).toEqual([]);
	});
});
