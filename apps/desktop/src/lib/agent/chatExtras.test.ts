/// <reference types="bun" />
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setLocale } from '#lib/i18n/index.ts';
import { buildTurns } from './chatParts';
import { chatEditorKey, chatIdOfEditorKey, chimeFor, followupPrompt, isChatEditorKey, memoryText, parseFollowups, usageDisplay, MAX_FOLLOWUPS } from './chatExtras';
import { guardAskedText } from './guardText';
import { applyEvent, initialRun, type AgentEvent } from './events';
import { replayTranscript } from './chats';

beforeAll(() => setLocale('en'));
afterAll(() => setLocale('en'));

const done = (is_error = false): AgentEvent => ({ kind: 'result', subtype: 'success', is_error, result: 'ok', session_id: 's', num_turns: 1, duration_ms: 1, total_cost_usd: 0, usage: null });

describe('safety asks in the chat', () => {
	test('why Kingu asked, with the paths it is about', () => {
		expect(guardAskedText({ check: 'delete', paths: ['a.txt', 'b.txt'] })).toBe('Kingu asks first: it deletes files (a.txt, b.txt)');
		expect(guardAskedText({ check: 'delete', paths: ['*'] })).toBe('Kingu asks first: it deletes files');
		expect(guardAskedText({ check: 'mcp', paths: [] })).toBe('Kingu asks first: it calls an MCP tool');
		expect(guardAskedText({ check: 'outside_cwd', paths: ['1', '2', '3', '4'] })).toBe('Kingu asks first: it writes outside the project folder (1, 2, 3, …)');
		setLocale('th');
		expect(guardAskedText({ check: 'protected', paths: ['.env'] })).toBe('Kingu ขอถามก่อน: จะยุ่งกับไฟล์ที่ป้องกันไว้ (.kinguignore) (.env)');
		setLocale('en');
	});

	test('the approval card carries the reason', () => {
		const s = initialRun();
		const evs: AgentEvent[] = [
			{ kind: 'message', role: 'user', text: 'clean up' },
			{ kind: 'guard_asked', request_id: 'r1', tool: 'Bash', tool_use_id: 'tu1', check: 'delete', paths: ['old.log'] },
			{ kind: 'permission_request', request_id: 'r1', tool: 'Bash', tool_use_id: 'tu1', title: null, input_summary: 'rm old.log', detail: null, diff: null, input: {}, can_always: false, rules: [] }
		];
		for (const ev of evs) applyEvent(s, ev);
		const part = buildTurns(s)[0].parts.find((p) => p.kind === 'confirmation');
		expect(part).toMatchObject({ kind: 'confirmation', reason: 'Kingu asks first: it deletes files (old.log)' });
	});
});

describe('feedback', () => {
	test('the last vote on a request wins; null takes it back', () => {
		const s = initialRun();
		const evs: AgentEvent[] = [
			{ kind: 'message', role: 'user', text: 'a' },
			{ kind: 'checkpoint', request: 0 },
			{ kind: 'message', role: 'assistant', text: 'A' },
			done(),
			{ kind: 'message', role: 'user', text: 'b' },
			{ kind: 'checkpoint', request: 1 },
			{ kind: 'message', role: 'assistant', text: 'B' },
			done(),
			{ kind: 'feedback', request: 0, vote: 'up' },
			{ kind: 'feedback', request: 1, vote: 'down' },
			{ kind: 'feedback', request: 1, vote: null }
		];
		for (const ev of evs) applyEvent(s, ev);
		expect(buildTurns(s).map((t) => t.feedback ?? null)).toEqual(['up', null]);
	});

	test('a vote saved after the run ended does not reopen it', () => {
		const s = replayTranscript([{ kind: 'message', role: 'user', text: 'a' }, { kind: 'checkpoint', request: 0 }, done(), { kind: 'exit', code: 0, signal: null, stopped: false }, { kind: 'feedback', request: 0, vote: 'up' }]);
		expect([s.status, buildTurns(s)[0].feedback]).toEqual(['done', 'up']);
	});
});

describe('chat extras', () => {
	test('usage display', () => {
		expect([usageDisplay('never'), usageDisplay('always'), usageDisplay('hover'), usageDisplay(undefined), usageDisplay('x')]).toEqual(['never', 'always', 'hover', 'hover', 'hover']);
	});

	test('follow-ups: the prompt and the cleanup of the answer', () => {
		const p = followupPrompt('  ทำไม build พัง ', 'เพราะ X');
		expect(p).toContain('<request>\nทำไม build พัง\n</request>');
		expect(p).toContain('<answer>\nเพราะ X\n</answer>');
		expect(parseFollowups('1. Add a test\n- "Fix the lint"\n\n```\n* Add a test\nRun it again\nOne more')).toEqual(['Add a test', 'Fix the lint', 'Run it again']);
		expect(parseFollowups(`${'x'.repeat(200)}\nok`)).toEqual(['ok']);
		expect(parseFollowups('a\nb\nc\nd').length).toBe(MAX_FOLLOWUPS);
	});

	test('a memory is one line without code blocks', () => {
		expect(memoryText('Use **tabs**.\n\n```ts\nconst x = 1;\n```\nAlways.')).toBe('Use **tabs**. Always.');
		expect([...memoryText('ก'.repeat(2000))].length).toBe(1000);
	});

	test('the chime plays after a finished answer only', () => {
		expect(chimeFor(done(), 'Glass')).toBe('Glass');
		expect(chimeFor(done(true), 'Glass')).toBeNull();
		expect(chimeFor(done(), 'off')).toBeNull();
		expect(chimeFor(done(), undefined)).toBeNull();
		expect(chimeFor({ kind: 'error', message: 'x' }, 'tone')).toBeNull();
	});

	test('chat editor tab keys', () => {
		expect(chatEditorKey('c-1')).toBe('chat://c-1');
		expect(isChatEditorKey('chat://c-1')).toBe(true);
		expect(chatIdOfEditorKey('chat://c-1')).toBe('c-1');
		expect(chatIdOfEditorKey('chat://../x')).toBeNull();
		expect(chatIdOfEditorKey('src/chat.ts')).toBeNull();
	});
});
