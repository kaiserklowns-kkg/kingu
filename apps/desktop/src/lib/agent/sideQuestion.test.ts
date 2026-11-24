import { describe, expect, test } from 'bun:test';
import { isSideCommand, parseSideDraft, sideForkPoint, sideRefusal } from './sideQuestion.ts';
import type { Part } from './chatParts.ts';

const md = (text: string): Part => ({ kind: 'markdown', text });
const turn = (done: boolean, parts: Part[], checkpoint: number | null = null) => ({ done, parts, checkpoint });

describe('/side and /btw', () => {
	test('parses the whole message as the command and its question (Orca parseNativeChatSideChatDraft)', () => {
		expect(parseSideDraft('/btw what does foo do?')).toEqual({ question: 'what does foo do?' });
		expect(parseSideDraft('  /side   multi\nline ')).toEqual({ question: 'multi\nline' });
		expect(parseSideDraft('/BTW')).toEqual({ question: '' });
		expect(parseSideDraft('/btwx hi')).toBeNull();
		expect(parseSideDraft('ask /btw later')).toBeNull();
		expect(isSideCommand('side')).toBe(true);
		expect(isSideCommand('btw')).toBe(true);
		expect(isSideCommand('fork')).toBe(false);
	});

	test('idle: forks the whole chat once an answer exists', () => {
		expect(sideForkPoint([], false)).toEqual({ kind: 'noReply' });
		expect(sideForkPoint([turn(true, [])], false)).toEqual({ kind: 'noReply' });
		expect(sideForkPoint([turn(true, [md('hi')], 0)], false)).toEqual({ kind: 'ready', before: null });
	});

	test('while a reply runs: cut before the running request, never copying it', () => {
		const answered = turn(true, [md('done')], 0);
		expect(sideForkPoint([answered, turn(false, [md('partial')], 1)], true)).toEqual({ kind: 'ready', before: 1 });
		// The first reply still running: nothing finished to ask beside.
		expect(sideForkPoint([turn(false, [md('partial')], 0)], true)).toEqual({ kind: 'replyRunning' });
		// The running request's index unknown: it cannot be cut safely.
		expect(sideForkPoint([answered, turn(false, [], null)], true)).toEqual({ kind: 'replyRunning' });
		// Busy but the last turn already done (between turns): the whole chat.
		expect(sideForkPoint([answered], true)).toEqual({ kind: 'ready', before: null });
	});

	test('text only, then the fork point decides', () => {
		expect(sideRefusal({ kind: 'ready', before: null }, true)).toBe('textOnly');
		expect(sideRefusal({ kind: 'ready', before: 2 }, false)).toBeNull();
		expect(sideRefusal({ kind: 'replyRunning' }, false)).toBe('replyRunning');
		expect(sideRefusal({ kind: 'noReply' }, false)).toBe('noReply');
	});
});
