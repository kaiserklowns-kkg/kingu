import { describe, expect, test } from 'bun:test';
import { arkaiDefault, arkaiGroups, needsKey, parseArkaiProviders, splitArkaiModel, type ArkaiProviderInfo } from './arkai';
import { setLocale } from '#lib/i18n/index.ts';

const provider = (over: Partial<ArkaiProviderInfo>): ArkaiProviderInfo => ({
	id: 'p',
	name: 'P',
	api: 'openai',
	base_url: 'https://p/v1',
	local: false,
	has_key: true,
	implicit: false,
	models: [],
	error: null,
	...over
});

describe('Arkai models', () => {
	test('values are provider/model; the model may hold slashes', () => {
		expect(splitArkaiModel('openrouter/qwen/qwen3-coder')).toEqual({ provider: 'openrouter', model: 'qwen/qwen3-coder' });
		expect(splitArkaiModel('claude-opus-5-5')).toBeNull();
		expect(splitArkaiModel('Bad/x')).toBeNull();
		expect(splitArkaiModel('ollama/')).toBeNull();
		expect(splitArkaiModel(null)).toBeNull();
	});

	test('the Rust list is read loosely', () => {
		const list = parseArkaiProviders([
			{ id: 'ollama', name: 'Ollama', api: 'openai', base_url: 'http://127.0.0.1:11434/v1', local: true, has_key: false, implicit: true, models: [{ id: 'qwen3' }, { nope: 1 }], error: null },
			{ id: 'Bad', name: 'x' },
			'junk'
		]);
		expect(list.length).toBe(1);
		expect(list[0]!.models).toEqual([{ id: 'qwen3' }]);
		expect(parseArkaiProviders(null)).toEqual([]);
	});

	test('the picker groups models by provider, and keeps a model no provider lists', () => {
		setLocale('en');
		const ollama = [{ id: 'qwen3', contextWindow: 16384 }, { id: 'big', contextWindow: 65536 }, { id: 'forced', contextWindow: 65536, light: true }];
		const providers = [provider({ id: 'ollama', name: 'Ollama', local: true, models: ollama }), provider({ id: 'empty', models: [] }), provider({ id: 'or', name: 'OpenRouter', models: [{ id: 'a/b', name: 'B' }] })];
		expect(arkaiGroups(providers, 'or/a/b')).toEqual([
			{
				provider: 'ollama',
				label: 'Ollama',
				models: [
					// Light mode only for a small window (or when the settings say so), as the agent host decides.
					{ value: 'ollama/qwen3', label: 'qwen3', description: 'qwen3 · 16k · light mode' },
					{ value: 'ollama/big', label: 'big', description: 'big · 64k' },
					{ value: 'ollama/forced', label: 'forced', description: 'forced · 64k · light mode' }
				]
			},
			{ provider: 'or', label: 'OpenRouter', models: [{ value: 'or/a/b', label: 'B', description: 'a/b' }] }
		]);
		expect(arkaiGroups(providers, 'gone/m')[0]).toEqual({ provider: 'gone', label: 'gone', models: [{ value: 'gone/m', label: 'm', description: 'gone/m' }] });
		expect(arkaiDefault(providers, 'claude-opus-5-5')).toBe('ollama/qwen3');
		expect(arkaiDefault(providers, 'or/a/b')).toBe('or/a/b');
		expect(arkaiDefault([], null)).toBeNull();
	});

	test('a remote provider without a key needs one; a local one does not', () => {
		expect(needsKey(provider({ has_key: false }))).toBe(true);
		expect(needsKey(provider({ has_key: false, local: true }))).toBe(false);
	});
});
