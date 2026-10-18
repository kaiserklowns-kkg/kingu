/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { answersFor, ASK_KEY_STEP_MS, askKeysFor, claudeAskKeys, codexAskKeys, isAnswered, isComplete, parseAsk, textAskKeys, typeAskKeys, type AskPrompt } from './ask';

const input = {
	questions: [
		{ question: 'Which library?', header: 'Library', multiSelect: false, options: [{ label: 'date-fns', description: 'small' }, { label: 'luxon', description: 'zones' }, { label: 'dayjs', description: '' }] },
		{ question: 'Which targets?', header: 'Targets', multiSelect: true, options: [{ label: 'web', description: '' }, { label: 'ios', description: '' }] }
	]
};
const prompt = parseAsk(input)!;
const single: AskPrompt = { questions: [prompt.questions[0]] };
const multi: AskPrompt = { questions: [prompt.questions[1]] };

describe('parseAsk', () => {
	test('reads questions, headers, options and multiSelect', () => {
		expect(prompt.questions[0]).toEqual({
			question: 'Which library?',
			header: 'Library',
			multiSelect: false,
			options: [{ label: 'date-fns', description: 'small' }, { label: 'luxon', description: 'zones' }, { label: 'dayjs' }]
		});
		expect(prompt.questions[1].multiSelect).toBe(true);
	});
	test('codex JSON strings, string options; nothing to ask is null', () => {
		expect(parseAsk(JSON.stringify({ questions: [{ question: 'Go?', options: ['yes', 'no'] }] }))).toEqual({ questions: [{ question: 'Go?', multiSelect: false, options: [{ label: 'yes' }, { label: 'no' }] }] });
		for (const bad of [null, undefined, 'nope', {}, { questions: [] }, { questions: [{}] }, { question: 'flat?' }]) expect(parseAsk(bad)).toBeNull();
	});
});

describe('answers', () => {
	test('a single-select takes exactly one option or own words', () => {
		const q = prompt.questions[0];
		expect(isAnswered(q, undefined)).toBe(false);
		expect(isAnswered(q, { indices: [1] })).toBe(true);
		expect(isAnswered(q, { indices: [], other: '  moment  ' })).toBe(true);
		expect(isAnswered(q, { indices: [], other: '   ' })).toBe(false);
		expect(isAnswered(q, { indices: [0, 1] })).toBe(false);
		expect(isAnswered(q, { indices: [0], other: 'also' })).toBe(false);
	});
	test('a multi-select takes any mix but needs something', () => {
		const q = prompt.questions[1];
		expect(isAnswered(q, { indices: [] })).toBe(false);
		expect(isAnswered(q, { indices: [1, 0], other: 'android' })).toBe(true);
	});
	test('the answers map is keyed by question text, multi-select joined by ", " in option order', () => {
		const sels = [{ indices: [1] }, { indices: [1, 0], other: ' android ' }];
		expect(isComplete(prompt, sels)).toBe(true);
		expect(isComplete(prompt, [sels[0]])).toBe(false);
		expect(answersFor(prompt, sels)).toEqual({ 'Which library?': 'luxon', 'Which targets?': 'web, ios, android' });
		expect(answersFor(prompt, [{ indices: [], other: 'temporal' }, { indices: [0] }])).toEqual({ 'Which library?': 'temporal', 'Which targets?': 'web' });
	});
});

describe('terminal keystrokes', () => {
	test('claude: a lone single-select is its option number, nothing else', () => {
		expect(claudeAskKeys(single, [{ indices: [2] }])).toEqual([{ raw: '3' }]);
	});
	test('claude: own words go through the "Type something" row', () => {
		expect(claudeAskKeys(single, [{ indices: [], other: 'temporal' }])).toEqual([{ raw: '4' }, { text: 'temporal' }, { raw: '\r' }]);
	});
	test('claude: a lone multi-select toggles, steps to Submit and confirms', () => {
		expect(claudeAskKeys(multi, [{ indices: [1, 0] }])).toEqual([{ raw: '1' }, { raw: '2' }, { raw: '\x1b[C' }, { raw: '\r' }]);
	});
	test('claude: several questions end on the Submit tab', () => {
		expect(claudeAskKeys(prompt, [{ indices: [0] }, { indices: [1], other: 'tv' }])).toEqual([
			{ raw: '1' },
			{ raw: '2' },
			{ raw: '3' },
			{ text: 'tv' },
			{ raw: '\r' },
			{ raw: '\x1b[C' },
			{ raw: '\r' }
		]);
	});
	test('codex: the digit submits; own words become notes on the "none" row', () => {
		expect(codexAskKeys(single, [{ indices: [1] }])).toEqual([{ raw: '2' }]);
		expect(codexAskKeys(single, [{ indices: [], other: 'x' }])).toEqual([{ raw: '\x1b[A' }, { raw: '\t' }, { text: 'x' }, { raw: '\r' }]);
	});
	test('typeAskKeys writes one group per step, pastes text, and stops when the terminal is no longer the task CLI', async () => {
		const writes: string[] = [];
		const waits: number[] = [];
		let live = true;
		const io = {
			write: async (d: string) => void writes.push(d),
			paste: (t: string) => `[${t}]`,
			wait: async (ms: number) => void waits.push(ms),
			live: () => live
		};
		expect(await typeAskKeys([{ raw: '4' }, { text: 'temporal' }, { raw: '\r' }], io)).toBe(true);
		expect(writes).toEqual(['4', '[temporal]', '\r']);
		expect(waits).toEqual([ASK_KEY_STEP_MS, ASK_KEY_STEP_MS]);

		writes.length = 0;
		io.write = async (d: string) => {
			writes.push(d);
			live = false; // e.g. the task's CLI restarted under a new terminal key
		};
		expect(await typeAskKeys([{ raw: '1' }, { raw: '\r' }], io)).toBe(false);
		expect(writes).toEqual(['1']);
	});
	test('other CLIs get each answer pasted and submitted; askKeysFor picks by CLI', () => {
		expect(textAskKeys(prompt, [{ indices: [0] }, { indices: [0, 1] }])).toEqual([{ text: 'date-fns' }, { raw: '\r' }, { text: 'web, ios' }, { raw: '\r' }]);
		expect(askKeysFor('claude', single, [{ indices: [0] }])).toEqual([{ raw: '1' }]);
		expect(askKeysFor('codex', single, [{ indices: [0] }])).toEqual([{ raw: '1' }]);
		expect(askKeysFor('copilot', single, [{ indices: [0] }])).toEqual([{ text: 'date-fns' }, { raw: '\r' }]);
	});
});
