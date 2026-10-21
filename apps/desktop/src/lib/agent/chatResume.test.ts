import { describe, expect, test } from 'bun:test';
import { chatsToResume } from './chatResume';
import type { ChatMeta } from './chats';

const chat = (id: string, over: Partial<ChatMeta> = {}): ChatMeta => ({
	id,
	title: id,
	prompt: '',
	cwd: { kind: 'folder' },
	session_id: 's-' + id,
	model: null,
	permission_mode: null,
	created_at: 1,
	updated_at: 1,
	last_run: null,
	...over
});

describe('resume chats cut off by a quit (Orca nativeChatResumeWorkOnRestart)', () => {
	test('only working chats with a session and no run now', () => {
		const list = [chat('a', { working: true }), chat('b'), chat('c', { working: true, session_id: null }), chat('d', { working: true })];
		expect(chatsToResume(list, (id) => id === 'd').map((c) => c.id)).toEqual(['a']);
	});
});
