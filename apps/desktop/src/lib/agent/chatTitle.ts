// AI chat titles (VS Code's generateInitialChatTitleIfNeeded): after a chat's first answer, the
// source-control AI agent (Rust `ai_chat_title`, only when the user set that agent up) writes a
// 3–6 word title for it. The prompt and the cleanup of the agent's answer are here, pure, so
// `bun test` covers them; chats.svelte.ts runs it and applies the title unless the user renamed
// the chat meanwhile.

import { MAX_TITLE } from './chats';

/** What the prompt carries of the chat: the first request and the start of the answer. */
export const TITLE_REQUEST_CHARS = 2000;
export const TITLE_ANSWER_CHARS = 1500;
/** A title longer than this is not one (the agent answered something else). */
export const MAX_AI_TITLE = 80;

const cut = (s: string, max: number) => ([...s].length > max ? `${[...s].slice(0, max).join('')}…` : s);

export function chatTitlePrompt(request: string, answer: string | null): string {
	return [
		'Write a short title (3 to 6 words) for the chat below, in the language of the request.',
		'Reply with the title only: no quotes, no punctuation at the end, no explanation. Do not use any tools.',
		'',
		'<request>',
		cut(request.trim(), TITLE_REQUEST_CHARS),
		'</request>',
		...(answer?.trim() ? ['<answer>', cut(answer.trim(), TITLE_ANSWER_CHARS), '</answer>'] : [])
	].join('\n');
}

/** The title in the agent's answer (its first non-empty line, unquoted, without a `Title:` label); null when there is none. */
export function parseChatTitle(answer: string): string | null {
	const line = answer
		.split('\n')
		.map((l) => l.trim())
		.find((l) => l && !/^```/.test(l));
	if (!line) return null;
	const title = line
		.replace(/^(?:#+\s*|\*\*|title\s*:\s*|ชื่อ\s*:\s*)/i, '')
		.replace(/\*\*$/, '')
		.replace(/^["'“‘`«]+|["'”’`»]+$/g, '')
		.replace(/[.。!]+$/, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!title || [...title].length > MAX_AI_TITLE) return null;
	return [...title].slice(0, MAX_TITLE).join('');
}
