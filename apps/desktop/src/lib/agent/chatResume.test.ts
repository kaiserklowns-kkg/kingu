import { describe, expect, test } from 'bun:test';
import { chatsToResume, interruptedChats, PARTIAL_TAIL, RESUME_PROMPT, resumePrompt } from './chatResume';
import { workersToReopen } from '#lib/ade/workerResume.ts';
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

	test('the offer lists cut-off chats newest first, never side chats', () => {
		const list = [chat('a', { interrupted: { at: 1, crash: false } }), chat('b', { interrupted: { at: 5, crash: true } }), chat('c'), chat('d', { interrupted: { at: 9, crash: false }, side_of: 'a' }), chat('e', { interrupted: null })];
		expect(interruptedChats(list).map((c) => c.id)).toEqual(['b', 'a']);
	});

	test("Orca's continuation message, with the end of a reply Kingu's checkpoint kept", () => {
		expect(RESUME_PROMPT).toContain("check whether your most recent action completed — don't repeat it if it did");
		expect(resumePrompt()).toBe(RESUME_PROMPT);
		expect(resumePrompt('   ')).toBe(RESUME_PROMPT);
		const short = resumePrompt('Step 1 done. Now step');
		expect(short.startsWith(RESUME_PROMPT)).toBe(true);
		expect(short).toContain('<cut-off-reply>\nStep 1 done. Now step\n</cut-off-reply>');
		const long = resumePrompt('x'.repeat(5000) + 'END');
		expect(long).toContain(`…${'x'.repeat(PARTIAL_TAIL - 3)}END`);
		expect(long.length).toBeLessThan(RESUME_PROMPT.length + PARTIAL_TAIL + 200);
	});
});

describe('workers (task agents) a restart took (Orca terminal worker restart offers)', () => {
	test('still listed, not done, each once', () => {
		const tasks = [
			{ slug: 'a', status: 'running' as const },
			{ slug: 'b', status: 'done' as const },
			{ slug: 'c', status: 'review' as const }
		];
		expect(workersToReopen(['a', 'b', 'c', 'gone', 'a'], tasks)).toEqual(['a', 'c']);
	});
});
