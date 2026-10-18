import { describe, expect, test } from 'bun:test';
import { completeCommand, filterCommands, kinguCommands, localCommandFor, mergeCommands, moveActive, parseCommand, slashQuery, type FileCommand } from './slashCommands';

describe('slash commands', () => {
	test('the / query only while the caret is in the first word', () => {
		expect(slashQuery('/', 1)).toBe('');
		expect(slashQuery('/rev', 4)).toBe('rev');
		expect(slashQuery('/rev', 2)).toBe('r');
		expect(slashQuery('/review 12', 10)).toBeNull();
		expect(slashQuery('fix /review', 11)).toBeNull();
		expect(slashQuery('/a/b', 4)).toBeNull();
		expect(slashQuery('/x', 0)).toBeNull();
	});

	test('Kingu first, then the session, then files it does not list', () => {
		const local = kinguCommands({ clear: () => {}, model: () => {} }, (n) => `do ${n}`);
		expect(local.map((c) => c.name)).toEqual(['clear', 'model']);
		expect(kinguCommands({ clear: () => {}, model: () => {}, fork: () => {} }, String).map((c) => c.name)).toEqual(['clear', 'model', 'fork']);
		const files: FileCommand[] = [
			{ name: 'review', description: 'file', argument_hint: '', source: 'project' },
			{ name: 'standup', description: 'Mine', argument_hint: '', source: 'user' }
		];
		const session = [
			{ name: 'compact', description: 'Summarize', argument_hint: '<how>' },
			{ name: 'review', description: 'session', argument_hint: '<pr>' },
			{ name: 'clear', description: 'sdk clear', argument_hint: '' }
		];
		const all = mergeCommands(local, session, files);
		expect(all.map((c) => [c.name, c.source])).toEqual([
			['clear', 'kingu'],
			['model', 'kingu'],
			['compact', 'session'],
			['review', 'session'],
			['standup', 'user']
		]);
		expect(all.find((c) => c.name === 'compact')?.argumentHint).toBe('<how>');
	});

	test('filters by prefix, then substring', () => {
		const items = ['compact', 'clear', 'pr-comments', 'context'].map((name) => ({ name, description: '', argumentHint: '', source: 'session' as const }));
		expect(filterCommands(items, 'co').map((c) => c.name)).toEqual(['compact', 'context', 'pr-comments']);
		expect(filterCommands(items, 'CL').map((c) => c.name)).toEqual(['clear']);
		expect(filterCommands(items, '', 2)).toHaveLength(2);
	});

	test('picking completes the word and keeps the rest', () => {
		expect(completeCommand('/rev', 'review')).toEqual({ text: '/review ', caret: 8 });
		expect(completeCommand('/re 12', 'review')).toEqual({ text: '/review 12', caret: 8 });
	});

	test('parses commands and finds Kingu ones', () => {
		expect(parseCommand(' /compact keep the API notes ')).toEqual({ name: 'compact', args: 'keep the API notes' });
		expect(parseCommand('/clear')).toEqual({ name: 'clear', args: '' });
		expect(parseCommand('/usr/bin/env')).toBeNull();
		expect(parseCommand('hello')).toBeNull();
		const local = [{ name: 'clear' }, { name: 'model' }];
		expect(localCommandFor('/model', local)?.command.name).toBe('model');
		expect(localCommandFor('/compact', local)).toBeNull();
	});

	test('arrow keys wrap', () => {
		expect(moveActive(0, 3, 'up')).toBe(2);
		expect(moveActive(2, 3, 'down')).toBe(0);
		expect(moveActive(0, 0, 'down')).toBe(0);
	});
});
