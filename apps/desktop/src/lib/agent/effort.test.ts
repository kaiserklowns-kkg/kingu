import { describe, expect, test } from 'bun:test';
import { arkaiEffortKind, arkaiLevels, claudeLevels, CODEX_GUESS, effortDefaults, effortLabel, effortLevels, effortList, effortRows, modelDefault, runEffort, type EffortContext } from './effort.ts';
import { newChat } from './chats.ts';
import { parseCachedModels } from './modelChoices.ts';

const listed = [
	{ value: 'opus', display_name: 'Opus', description: '', efforts: ['off', 'low', 'medium', 'high', 'xhigh', 'max'] },
	{ value: 'haiku', display_name: 'Haiku', description: '' }
];
const ctx = (over: Partial<EffortContext>): EffortContext => ({ protocol: 'claude', model: null, listed, ...over });

describe('effort levels per runtime', () => {
	test('Claude Code: the listed model\'s levels; a model not listed yet by its family', () => {
		expect(claudeLevels('opus', listed)).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max']);
		expect(claudeLevels('haiku', listed)).toEqual([]);
		expect(claudeLevels('claude-sonnet-5', [])).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max']);
		expect(claudeLevels('claude-haiku-4-5', [])).toEqual([]);
		expect(claudeLevels(null, [])).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max']);
	});

	test('Codex: what it listed, else old\'s four; ACP only when advertised', () => {
		expect(effortLevels(ctx({ protocol: 'codex' }))).toEqual([...CODEX_GUESS]);
		expect(effortLevels(ctx({ protocol: 'codex', advertised: { levels: ['low', 'high', 'xhigh'], current: 'high' } }))).toEqual(['low', 'high', 'xhigh']);
		expect(effortLevels(ctx({ protocol: 'acp' }))).toEqual([]);
		expect(effortLevels(ctx({ protocol: 'acp', advertised: { levels: ['low', 'high'], current: null } }))).toEqual(['low', 'high']);
	});

	test('Arkai: by provider and model', () => {
		expect(arkaiLevels('anthropic', 'https://api.anthropic.com', 'claude-opus-5-5')).toEqual(['off', 'low', 'medium', 'high', 'max']);
		expect(arkaiLevels('anthropic', 'https://api.anthropic.com', 'claude-sonnet-4-5')).toEqual(['off', 'low', 'medium', 'high']);
		expect(arkaiLevels('openai', 'https://api.openai.com/v1', 'gpt-5-mini')).toEqual(['minimal', 'low', 'medium', 'high']);
		expect(arkaiLevels('openai', 'https://api.openai.com/v1', 'o4-mini')).toEqual(['low', 'medium', 'high']);
		expect(arkaiLevels('openai', 'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-2.5-flash')).toEqual(['off', 'low', 'medium', 'high']);
		expect(arkaiLevels('openai', 'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-2.5-pro')).toEqual(['low', 'medium', 'high']);
		expect(arkaiLevels('openai', 'http://127.0.0.1:11434/v1', 'llama3.2')).toEqual([]);
		expect(arkaiEffortKind('openai', 'https://openrouter.ai/api/v1', 'openai/o3')).toBe('openrouter');
		expect(effortLevels(ctx({ protocol: 'arkai', model: 'local/x', arkai: null }))).toEqual([]);
		expect(effortLevels(ctx({ protocol: 'arkai', model: 'oai/gpt-5', arkai: { api: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' } }))).toEqual(['minimal', 'low', 'medium', 'high']);
	});

	test('the model\'s default, shown while nothing is picked (old\'s resolveDefaultReasoningEffort)', () => {
		const all = effortList(['off', 'low', 'medium', 'high', 'max']);
		expect(modelDefault(all, ctx({ model: 'claude-sonnet-5' }))).toBe('high');
		expect(modelDefault(all, ctx({ model: 'claude-opus-5-5' }))).toBe('medium');
		expect(modelDefault(['low', 'high'], ctx({ protocol: 'codex', advertised: { levels: ['low', 'high'], current: 'low' } }))).toBe('low');
		expect(modelDefault(['minimal', 'low', 'medium', 'high'], ctx({ protocol: 'codex' }))).toBe('medium');
		expect(modelDefault(['off', 'low', 'medium', 'high'], ctx({ protocol: 'arkai', arkai: { api: 'anthropic', baseUrl: '', model: 'claude-sonnet-4-5' } }))).toBe('off');
		expect(modelDefault(['low'], ctx({}))).toBe('low');
		expect(modelDefault([], ctx({}))).toBeNull();
	});
});

describe('the effort a run starts with', () => {
	test('the chat\'s pick, else the runtime\'s default, else `*`, only when the model takes it', () => {
		const defaults = effortDefaults({ claude: 'max', '*': 'low', codex: 'ultra', arkai: 7 });
		expect(defaults).toEqual({ claude: 'max', '*': 'low' });
		expect(runEffort('high', defaults, 'claude', ['low', 'high', 'max'])).toBe('high');
		expect(runEffort(null, defaults, 'claude', ['low', 'high', 'max'])).toBe('max');
		expect(runEffort(undefined, defaults, 'codex', ['low', 'medium'])).toBe('low');
		expect(runEffort('max', defaults, 'codex', ['medium'])).toBeNull();
		expect(runEffort('high', {}, 'acp', [])).toBeNull();
		expect(effortDefaults(['high'])).toEqual({});
	});

	test('the picker\'s rows', () => {
		const rows = effortRows(['low', 'high'], 'high');
		expect(rows.map((r) => [r.id, r.checked])).toEqual([
			['low', false],
			['high', true]
		]);
		expect(rows[1]!.label).toBe(effortLabel('high'));
		expect(rows[1]!.description).toBeTruthy();
	});
});

describe('persistence', () => {
	test('a new chat keeps its effort; none is left out', () => {
		expect(newChat({ prompt: 'x', cwd: { kind: 'folder' }, model: null, permissionMode: null, effort: 'xhigh' }, 1).effort).toBe('xhigh');
		expect('effort' in newChat({ prompt: 'x', cwd: { kind: 'folder' }, model: null, permissionMode: null }, 1)).toBe(false);
	});

	test('the cached model list keeps each model\'s levels', () => {
		expect(parseCachedModels(JSON.stringify([{ value: 'opus', display_name: 'Opus', description: '', efforts: ['low', 'high'] }, { value: 'x', display_name: 'X', efforts: [1] }]))).toEqual([
			{ value: 'opus', display_name: 'Opus', description: '', efforts: ['low', 'high'] },
			{ value: 'x', display_name: 'X', description: '' }
		]);
	});
});
