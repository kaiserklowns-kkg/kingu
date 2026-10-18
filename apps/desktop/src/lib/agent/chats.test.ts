/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
	chatCwdPath,
	chatSendPlan,
	MAX_PROMPT,
	MAX_TITLE,
	newChat,
	newChatId,
	optionChange,
	patchChat,
	removeChat,
	renamedChatTitle,
	replayTranscript,
	runKey,
	historySections,
	initialChat,
	sortChats,
	type ChatMeta
} from './chats';
import type { AgentEvent, PermissionRequest, RunStatus } from './events';

const chat = (id: string, at: number, extra: Partial<ChatMeta> = {}): ChatMeta => ({
	...newChat({ prompt: `prompt ${id}`, cwd: { kind: 'folder' }, model: 'opus', permissionMode: 'default' }, at, id),
	...extra
});

describe('chat ids and new chats', () => {
	test('ids are what Rust accepts: lowercase letters, digits and -', () => {
		const ids = Array.from({ length: 50 }, (_, i) => newChatId(1_790_000_000_000 + i));
		for (const id of ids) expect(id).toMatch(/^c-[a-z0-9]+-[a-z0-9]{6}$/);
		expect(new Set(ids).size).toBe(50);
		expect(newChatId(36, () => 0.5)).toBe('c-10-iiiiii');
	});

	test('title from the first line, prompt cut to the limit, defaults kept', () => {
		const c = newChat({ prompt: '\n  อธิบาย   main.rs\nแล้วแก้ด้วย', cwd: { kind: 'task', slug: 'fix-login' }, model: '  ', permissionMode: 'plan' }, 5, 'c-1');
		expect(c).toEqual({
			id: 'c-1',
			title: 'อธิบาย main.rs',
			prompt: 'อธิบาย   main.rs\nแล้วแก้ด้วย',
			cwd: { kind: 'task', slug: 'fix-login' },
			session_id: null,
			model: null,
			permission_mode: 'plan',
			created_at: 5,
			updated_at: 5,
			last_run: null
		});
		const long = newChat({ prompt: 'ก'.repeat(MAX_PROMPT + 50), cwd: { kind: 'folder' }, model: 'opus', permissionMode: null }, 1);
		expect([...long.prompt].length).toBe(MAX_PROMPT);
		expect([...long.title].length).toBeLessThanOrEqual(60);
	});
});

describe('list reducers', () => {
	test('patch bumps updated_at and touches only that chat', () => {
		const list = [chat('a', 1), chat('b', 2)];
		const next = patchChat(list, 'a', { session_id: 's-1' }, 10);
		expect(next[0]).toEqual({ ...list[0], session_id: 's-1', updated_at: 10 });
		expect(next[1]).toBe(list[1]);
		expect(list[0].session_id).toBeNull();
	});

	test('rename trims to one line within the limit; empty or same is no change', () => {
		expect(renamedChatTitle('old', '  new\n title ')).toBe('new title');
		expect(renamedChatTitle('old', '   ')).toBeNull();
		expect(renamedChatTitle('old', ' old ')).toBeNull();
		expect([...(renamedChatTitle('x', 'ก'.repeat(MAX_TITLE + 9)) ?? '')].length).toBe(MAX_TITLE);
	});

	test('remove and sort newest activity first', () => {
		const list = [chat('a', 1), chat('b', 3), chat('c', 2, { updated_at: 9 })];
		expect(sortChats(list).map((c) => c.id)).toEqual(['c', 'b', 'a']);
		expect(removeChat(list, 'b').map((c) => c.id)).toEqual(['a', 'c']);
	});

	test('history: chats newest first with their live state, ADE tasks in their own section', () => {
		const status: Record<string, RunStatus> = { a: 'waiting', b: 'running', new: 'idle', old: 'running' };
		const h = historySections(
			[chat('a', 5), chat('b', 7), chat('c', 6)],
			[
				{ slug: 'old', title: 'Old', created_at: 1, updated_at: 2, terminal: true },
				{ slug: 'new', title: 'New', created_at: 1, updated_at: 9, terminal: false }
			],
			(r) => status[r.kind === 'chat' ? r.id : r.slug]
		);
		expect(h.chats.map((r) => [r.id, r.state])).toEqual([
			['b', 'working'],
			['c', null],
			['a', 'needsInput']
		]);
		expect(h.tasks.map((r) => [r.slug, r.state, r.terminal])).toEqual([
			['new', null, false],
			['old', 'working', true]
		]);
	});

	test('the panel opens on the most recent chat, never on a task', () => {
		expect(initialChat([chat('a', 1), chat('b', 3)])).toBe('b');
		expect(initialChat([])).toBeNull();
	});
});

describe('where and how a chat runs', () => {
	test('cwd: the folder or a task worktree under it', () => {
		expect(chatCwdPath('/r', { kind: 'folder' })).toBe('/r');
		expect(chatCwdPath('/r', { kind: 'task', slug: 'fix' })).toBe('/r/.kingu/worktrees/fix');
	});

	test('runs are keyed by folder and chat id', () => {
		expect(runKey('/a', 'c-1')).not.toBe(runKey('/b', 'c-1'));
	});

	test('a message goes into the live run, else resumes the session', () => {
		expect(chatSendPlan({ ended: false, sessionId: null }, 's-0')).toEqual({ kind: 'send' });
		expect(chatSendPlan({ ended: true, sessionId: 's-1' }, 's-0')).toEqual({ kind: 'start', resume: 's-1' });
		expect(chatSendPlan(undefined, 's-0')).toEqual({ kind: 'start', resume: 's-0' });
		expect(chatSendPlan(undefined, null)).toEqual({ kind: 'start', resume: null });
	});

	test('model / mode changes apply live only to a started, live run', () => {
		expect(optionChange({ ended: false }, 3)).toBe('live');
		expect(optionChange({ ended: false }, undefined)).toBe('next');
		expect(optionChange({ ended: true }, 3)).toBe('next');
		expect(optionChange(undefined, undefined)).toBe('next');
	});
});

describe('replaying a transcript', () => {
	const perm: PermissionRequest = {
		kind: 'permission_request',
		request_id: 'r1',
		tool: 'Bash',
		tool_use_id: null,
		title: null,
		input_summary: 'ls',
		detail: null,
		diff: null,
		input: {},
		can_always: true
	};
	const events: AgentEvent[] = [
		{ kind: 'system', subtype: 'init', session_id: 's-1', model: 'opus' },
		{ kind: 'message', role: 'user', text: 'สวัสดี' },
		{ kind: 'message', role: 'assistant', text: 'ครับ' },
		{ kind: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's-1', num_turns: 1, duration_ms: 1, total_cost_usd: 0.01 }
	];

	test('a finished run comes back as it was', () => {
		const s = replayTranscript([...events, { kind: 'exit', code: null, signal: null, stopped: true }]);
		expect(s.status).toBe('stopped');
		expect(s.sessionId).toBe('s-1');
		expect(s.items).toHaveLength(5);
		expect(s.result?.total_cost_usd).toBe(0.01);
	});

	test('a run cut off by a quit is closed, and its open prompt cancelled', () => {
		const s = replayTranscript([...events, perm]);
		expect(s.ended).toBe(true);
		expect(s.status).toBe('stopped');
		expect(s.pending).toEqual([]);
		expect(s.decisions.r1).toBe('cancelled');
	});

	test('runs follow each other: a failed first run does not mark the resumed one', () => {
		const s = replayTranscript([
			{ kind: 'error', message: 'boom' },
			{ kind: 'exit', code: 1, signal: null, stopped: false },
			...events,
			{ kind: 'exit', code: 0, signal: null, stopped: false }
		]);
		expect(s.status).toBe('done');
		expect(s.error).toBeNull();
		expect(s.items).toHaveLength(7);
	});

	test('an empty transcript is an ended, empty run', () => {
		const s = replayTranscript([]);
		expect(s).toMatchObject({ ended: true, status: 'done', items: [] });
	});
});
