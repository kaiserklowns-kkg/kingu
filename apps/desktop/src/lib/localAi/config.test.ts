import { describe, expect, test } from 'bun:test';
import { resolveSettings } from '#lib/settings/registry.ts';
import { searchSettingsFrom } from '#lib/settings/mappings.ts';
import { completesScheme, completionRequest, endpointFrom, hitRow, pause, semanticConfigFrom } from './config';

/** Settings as the registry resolves them: defaults under `user`. */
function getter(user: Record<string, unknown> = {}) {
	const values = resolveSettings(user, {});
	return <T>(id: string) => values.get(id)?.value as T;
}

describe('Local AI config', () => {
	test('everything that sends code is off by default, on Ollama locally', () => {
		const get = getter();
		expect([get('kingu.completions.enabled'), get('kingu.semanticSearch.enabled'), get('kingu.search.smart')]).toEqual([false, false, false]);
		expect(endpointFrom(get)).toEqual({ provider: 'ollama', url: 'http://127.0.0.1:11434', api_key: '' });
		expect(semanticConfigFrom(get)).toMatchObject({ enabled: false, model: 'bge-m3', use_ignore_files: true });
	});

	test('builds the completion request from settings', () => {
		const get = getter({
			'kingu.completions.provider': 'openai',
			'kingu.completions.endpoint': ' http://localhost:1234/v1 ',
			'kingu.completions.apiKey': 'k',
			'kingu.completions.model': ' qwen2.5-coder ',
			'kingu.completions.fimTemplate': 'deepseek',
			'kingu.completions.maxTokens': 32
		});
		expect(completionRequest(get, 7, 'a', 'b')).toEqual({
			id: 7,
			endpoint: { provider: 'openai', url: 'http://localhost:1234/v1', api_key: 'k' },
			model: 'qwen2.5-coder',
			template: 'deepseek',
			prefix: 'a',
			suffix: 'b',
			max_tokens: 32
		});
	});

	test('semantic search takes the exclude settings', () => {
		const get = getter({ 'kingu.semanticSearch.enabled': true, 'files.exclude': { '**/gen': true }, 'search.useIgnoreFiles': false });
		const config = semanticConfigFrom(get);
		expect(config.enabled).toBe(true);
		expect(config.exclude_globs).toContain('**/gen');
		expect(config.use_ignore_files).toBe(false);
	});

	test('smart search reaches the Rust search options', () => {
		expect(searchSettingsFrom(getter(), true).smart).toBe(false);
		expect(searchSettingsFrom(getter({ 'kingu.search.smart': true }), true).smart).toBe(true);
	});

	test('completes real files only', () => {
		expect([completesScheme('file'), completesScheme('git-head'), completesScheme('kingu-disk')]).toEqual([true, false, false]);
	});

	test('pause waits, or stops early when cancelled', async () => {
		expect(await pause(0, () => false)).toBe(true);
		expect(await pause(10_000, () => true)).toBe(false);
	});

	test('shows a hit with its place and score', () => {
		expect(hitRow({ path: 'src/a.ts', line: 12, text: 'export function ledger()', start_line: 1, end_line: 60, score: 0.834 })).toEqual({
			label: 'export function ledger()',
			description: 'src/a.ts:12 · 83%'
		});
		expect(hitRow({ path: 'b.md', line: 1, text: '', start_line: 1, end_line: 1, score: 0.5 }).label).toBe('b.md');
	});
});
