import { describe, expect, test } from 'bun:test';
import { FALLBACK_MODELS, modelChoices, parseCachedModels } from './modelChoices.ts';

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
			{ value: 'claude-opus-5-5', label: 'claude-opus-5-5', description: '' },
			{ value: 'default', label: 'Default (recommended)', description: 'Opus' },
			{ value: 'sonnet', label: 'Sonnet', description: 'Fast' }
		]);
		expect(modelChoices('sonnet', 'sonnet', listed).map((c) => c.value)).toEqual(['default', 'sonnet']);
	});

	test('reads back only well-formed cached rows', () => {
		expect(parseCachedModels(JSON.stringify([{ value: 'opus', display_name: 'Opus' }, { value: 1 }, null]))).toEqual([{ value: 'opus', display_name: 'Opus', description: '' }]);
		expect(parseCachedModels('nope')).toEqual([]);
		expect(parseCachedModels(null)).toEqual([]);
	});
});
