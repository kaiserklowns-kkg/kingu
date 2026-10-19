// Smaller chat features, the pure parts (`bun test` covers them; chatExtras.svelte.ts runs them):
// the usage line under answers (kingu.chat.usage), follow-up suggestions (VS Code's chatFollowups:
// the prompt for the source-control AI agent and the cleanup of its answer), the text "Remember
// this" saves, and the editor tab key of a chat opened in the editor (VS Code's chatMoveActions).

import type { AgentEvent } from './events';

/** kingu.chat.usage: the cost and tokens of an answer never, on hover of the ⓘ, or always under it. */
export type UsageDisplay = 'never' | 'hover' | 'always';
export const usageDisplay = (setting: unknown): UsageDisplay => (setting === 'never' || setting === 'always' ? setting : 'hover');

/** What the follow-up prompt carries of the turn, and the suggestions kept. */
export const FOLLOWUP_REQUEST_CHARS = 1500;
export const FOLLOWUP_ANSWER_CHARS = 3000;
export const MAX_FOLLOWUPS = 3;
export const MAX_FOLLOWUP = 120;

const cut = (s: string, max: number) => ([...s].length > max ? `${[...s].slice(0, max).join('')}…` : s);

/** VS Code's followup provider, done by the source-control AI agent: up to 3 short next questions. */
export function followupPrompt(request: string, answer: string): string {
	return [
		`Suggest up to ${MAX_FOLLOWUPS} short follow-up requests the user might send next in the chat below, in the language of the request.`,
		'Each one line of at most 12 words, written as the user would type it. Reply with the lines only: no numbering, no quotes, no explanation. Do not use any tools.',
		'',
		'<request>',
		cut(request.trim(), FOLLOWUP_REQUEST_CHARS),
		'</request>',
		'<answer>',
		cut(answer.trim(), FOLLOWUP_ANSWER_CHARS),
		'</answer>'
	].join('\n');
}

/** The suggestions in the agent's answer: list markers and quotes dropped, duplicates and long lines left out. */
export function parseFollowups(answer: string): string[] {
	const out: string[] = [];
	for (const raw of answer.split('\n')) {
		const line = raw
			.trim()
			.replace(/^(?:[-*•]|\d+[.)])\s*/, '')
			.replace(/^["'“‘`]+|["'”’`]+$/g, '')
			.trim();
		if (!line || /^```/.test(line) || [...line].length > MAX_FOLLOWUP || out.includes(line)) continue;
		out.push(line);
		if (out.length === MAX_FOLLOWUPS) break;
	}
	return out;
}

/** "Remember this": a message's text as one memory line (its selection when there is one). */
export const MAX_MEMORY = 1000;
export function memoryText(text: string): string {
	const flat = text
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return [...flat].length > MAX_MEMORY ? `${[...flat].slice(0, MAX_MEMORY - 1).join('')}…` : flat;
}

/** The completion chime's sound for an event: a finished turn that did not fail, with the setting on. */
export function chimeFor(ev: AgentEvent, setting: unknown): string | null {
	if (ev.kind !== 'result' || ev.is_error) return null;
	return typeof setting === 'string' && setting && setting !== 'off' ? setting : null;
}

// ---------------------------------------------------------------------------------------------
// A chat in an editor tab: `chat://<id>`

export const CHAT_EDITOR_PREFIX = 'chat://';
export const chatEditorKey = (id: string) => CHAT_EDITOR_PREFIX + id;
export const isChatEditorKey = (key: string) => key.startsWith(CHAT_EDITOR_PREFIX);
/** The chat id of a chat editor tab (Rust's chat id alphabet), or null. */
export function chatIdOfEditorKey(key: string): string | null {
	if (!isChatEditorKey(key)) return null;
	const id = key.slice(CHAT_EDITOR_PREFIX.length);
	return /^[a-z0-9-]{1,64}$/.test(id) ? id : null;
}
