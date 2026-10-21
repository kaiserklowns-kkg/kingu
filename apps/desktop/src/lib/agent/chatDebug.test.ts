import { describe, expect, test } from 'bun:test';
import { chatDebugKey, chatIdOfDebugKey, DEBUG_KINDS, filterDebugEvents, formatDuration, isChatDebugKey, kindCounts, rowTime, type DebugEvent, type DebugKind } from './chatDebug.ts';

const row = (seq: number, kind: DebugKind, name: string, detail: string, extra: Partial<DebugEvent> = {}): DebugEvent => ({ seq, t: 1000 + seq * 100, kind, name, detail, is_error: false, data: { kind }, ...extra });

// A recorded chat as Rust's chat_debug_events gives it (agent/chat_debug.rs builds the same fixture).
const LOG: DebugEvent[] = [
	row(0, 'run', 'Run started', 'claude · opus · 2 rules'),
	row(1, 'user', 'User message', 'Fix the login bug', { request: 0 }),
	row(2, 'tool', 'Read', 'src/login.rs', { duration_ms: 250, data: { kind: 'tool_use', input: { file_path: 'src/login.rs' }, result: { content: 'fn login() {}' } } }),
	row(3, 'hook', 'PostToolUse: fmt', 'error (exit 2) rustfmt failed', { is_error: true }),
	row(4, 'thinking', 'Thinking', 'the login form'),
	row(5, 'turn', 'Turn success', '3 turns · 2.6 s', { duration_ms: 2600 })
];
const ALL = new Set(DEBUG_KINDS);

describe('chat debug log', () => {
	test('editor keys name a chat id', () => {
		expect(chatDebugKey('c-1')).toBe('chat-debug://c-1');
		expect(isChatDebugKey('chat-debug://c-1')).toBe(true);
		expect(chatIdOfDebugKey('chat-debug://c-1')).toBe('c-1');
		expect(chatIdOfDebugKey('chat-debug://../x')).toBeNull();
		expect(chatIdOfDebugKey('chat://c-1')).toBeNull();
	});

	test('filters by kind, errors and comma-separated terms with exclusions', () => {
		const seqs = (kinds: Iterable<DebugKind>, query = '', errorsOnly = false) => filterDebugEvents(LOG, { kinds: new Set(kinds), query, errorsOnly }).map((e) => e.seq);
		expect(seqs(ALL)).toEqual([0, 1, 2, 3, 4, 5]);
		expect(seqs(['tool', 'hook'])).toEqual([2, 3]);
		expect(seqs(ALL, '', true)).toEqual([3]);
		expect(seqs(ALL, 'LOGIN')).toEqual([1, 2, 4]);
		expect(seqs(ALL, 'login, !thinking')).toEqual([1, 2]);
		expect(seqs(ALL, 'fn login()'), 'a tool result counts').toEqual([2]);
		expect(seqs(ALL, '!login')).toEqual([0, 3, 5]);
		expect(seqs(ALL, 'rustfmt, opus')).toEqual([0, 3]);
		expect(seqs(ALL, ' , ')).toEqual([0, 1, 2, 3, 4, 5]);
	});

	test('counts kinds and formats times', () => {
		expect(kindCounts(LOG)).toEqual({ run: 1, user: 1, tool: 1, hook: 1, thinking: 1, turn: 1 });
		expect([formatDuration(250), formatDuration(2600), formatDuration(65_000)]).toEqual(['250 ms', '2.6 s', '1 m 05 s']);
		const t = new Date(2026, 9, 21, 14, 3, 7, 250).getTime();
		expect(rowTime(t, t - 2600)).toEqual({ clock: '14:03:07.250', offset: '+2.6 s' });
		expect(rowTime(t, t + 5).offset).toBe('+0 ms');
	});
});
