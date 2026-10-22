// The chat's reasoning effort mapped to each runtime's own knob (src/effort.ts).

import { describe, expect, test } from 'bun:test';
import { acpThoughtLevels, arkaiEffortKind, arkaiReasoning, checkEffort, claudeStartOptions, codexEffort, codexLevels, EFFORTS, normalizeLevel } from '../src/effort.ts';

describe('effort', () => {
	test('checkEffort', () => {
		expect(checkEffort(undefined)).toBeUndefined();
		expect(checkEffort(null)).toBeUndefined();
		for (const e of EFFORTS) expect(checkEffort(e)).toBe(e);
		expect(() => checkEffort('ultra')).toThrow('unsupported reasoning effort');
		expect(() => checkEffort(3)).toThrow();
	});

	test('Claude Agent SDK: effort, or thinking off', () => {
		expect(claudeStartOptions(undefined)).toEqual({});
		expect(claudeStartOptions('off')).toEqual({ maxThinkingTokens: 0 });
		expect(claudeStartOptions('minimal')).toEqual({ effort: 'low' });
		for (const e of ['low', 'medium', 'high', 'xhigh', 'max'] as const) expect(claudeStartOptions(e)).toEqual({ effort: e });
	});

	test('Codex: turn/start effort and summary', () => {
		expect(codexEffort(undefined)).toBeNull();
		expect(codexEffort('off')).toEqual({ effort: 'none', summary: 'none' });
		expect(codexEffort('minimal')).toEqual({ effort: 'minimal', summary: 'auto' });
		expect(codexEffort('high')).toEqual({ effort: 'high', summary: 'auto' });
		expect(codexEffort('xhigh')).toEqual({ effort: 'xhigh', summary: 'auto' });
		expect(codexEffort('max')).toEqual({ effort: 'xhigh', summary: 'auto' });
		expect(codexLevels([{ reasoningEffort: 'high' }, 'none', { reasoningEffort: 'low' }, { reasoningEffort: 'weird' }, 7])).toEqual(['off', 'low', 'high']);
		expect(codexLevels(null)).toEqual([]);
	});

	test('agent level names', () => {
		expect(normalizeLevel('Extra High')).toBe('xhigh');
		expect(normalizeLevel('extra_high')).toBe('xhigh');
		expect(normalizeLevel('NONE')).toBe('off');
		expect(normalizeLevel('Maximum')).toBe('max');
		expect(normalizeLevel('turbo')).toBeNull();
	});

	test('ACP thought_level config option', () => {
		const opts = [
			{ id: 'model', category: 'model', options: [{ value: 'm' }] },
			{ id: 'effort', category: 'thought_level', currentValue: 'think-hard', options: [{ group: 'g', options: [{ value: 'quick', name: 'Low' }, { value: 'think-hard', name: 'High' }] }, { value: 'odd', name: 'Odd' }] }
		];
		const t = acpThoughtLevels(opts)!;
		expect(t.configId).toBe('effort');
		expect([...t.values]).toEqual([
			['low', 'quick'],
			['high', 'think-hard']
		]);
		expect(t.current).toBe('high');
		expect(acpThoughtLevels([{ id: 'model', category: 'model', options: [] }])).toBeNull();
		expect(acpThoughtLevels(undefined)).toBeNull();
	});

	test('Arkai: which knob a model has', () => {
		expect(arkaiEffortKind('anthropic', 'https://api.anthropic.com', 'claude-opus-5-5')).toBe('anthropic-adaptive');
		expect(arkaiEffortKind('anthropic', 'https://api.anthropic.com', 'claude-sonnet-4-6')).toBe('anthropic-adaptive');
		expect(arkaiEffortKind('anthropic', 'https://api.anthropic.com', 'claude-sonnet-4-5-20250929')).toBe('anthropic-budget');
		expect(arkaiEffortKind('anthropic', 'https://api.anthropic.com', 'claude-3-7-sonnet-latest')).toBe('anthropic-budget');
		expect(arkaiEffortKind('anthropic', 'https://api.anthropic.com', 'claude-3-5-haiku-latest')).toBeNull();
		expect(arkaiEffortKind('openai', 'https://api.openai.com/v1', 'gpt-5.1')).toBe('openai');
		expect(arkaiEffortKind('openai', 'https://api.openai.com/v1', 'o3-mini')).toBe('openai');
		expect(arkaiEffortKind('openai', 'https://api.openai.com/v1', 'gpt-4o')).toBeNull();
		expect(arkaiEffortKind('openai', 'https://openrouter.ai/api/v1', 'openai/gpt-5')).toBe('openrouter');
		expect(arkaiEffortKind('openai', 'https://openrouter.ai/api/v1', 'anthropic/claude-sonnet-4-5')).toBe('openrouter');
		expect(arkaiEffortKind('openai', 'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-2.5-pro')).toBe('gemini');
		expect(arkaiEffortKind('openai', 'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-2.0-flash')).toBeNull();
		expect(arkaiEffortKind('openai', 'http://127.0.0.1:11434/v1', 'qwen3:8b')).toBeNull();
	});

	test('Arkai: the body fields per provider', () => {
		expect(arkaiReasoning(null, 'high', 8192)).toBeNull();
		expect(arkaiReasoning('openai', null, 8192)).toBeNull();
		expect(arkaiReasoning('anthropic-adaptive', 'high', 8192)).toEqual({ body: { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }, maxTokens: 8192, thinking: true });
		expect(arkaiReasoning('anthropic-adaptive', 'off', 8192)).toEqual({ body: { thinking: { type: 'disabled' } }, maxTokens: 8192, thinking: false });
		expect(arkaiReasoning('anthropic-budget', 'medium', 8192)).toEqual({ body: { thinking: { type: 'enabled', budget_tokens: 8192 } }, maxTokens: 16_384, thinking: true });
		expect(arkaiReasoning('anthropic-budget', 'off', 8192)).toBeNull();
		expect(arkaiReasoning('openai', 'minimal', 8192)?.body).toEqual({ reasoning_effort: 'minimal' });
		expect(arkaiReasoning('openai', 'off', 8192)?.body).toEqual({ reasoning_effort: 'none' });
		expect(arkaiReasoning('openrouter', 'max', 8192)?.body).toEqual({ reasoning: { effort: 'high' } });
		expect(arkaiReasoning('openrouter', 'off', 8192)?.body).toEqual({ reasoning: { enabled: false } });
		expect(arkaiReasoning('gemini', 'low', 8192)?.body).toEqual({ extra_body: { google: { thinking_config: { thinking_budget: 1024, include_thoughts: true } } } });
		expect(arkaiReasoning('gemini', 'off', 8192)?.body).toEqual({ extra_body: { google: { thinking_config: { thinking_budget: 0, include_thoughts: false } } } });
	});
});
