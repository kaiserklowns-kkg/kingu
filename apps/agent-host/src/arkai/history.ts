// A continued Arkai chat: its conversation rebuilt from the chat's transcript, which Rust keeps
// (`.kingu/chats/<id>.jsonl`) and sends with `start {runtime: {history}}`. The events are the
// ones this runtime emitted: user and assistant `message`s, `tool_use` and `tool_result`. A call
// whose result never came (the app quit mid-call) gets one saying so, and a markup-only answer
// from a small model is cleaned (leftover.ts).

import type { Msg, ToolCall } from './messages.ts';
import { stripToolMarkup } from './leftover.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export const NO_RESULT = '(no result: the run ended before this call finished)';

/** The conversation in `events` (oldest first); anything else in them is skipped. */
export function historyMessages(events: readonly unknown[]): Msg[] {
	const out: Msg[] = [];
	/** Calls of the current answer still waiting for their result. */
	let open = new Map<string, ToolCall>();
	let assistant: Extract<Msg, { role: 'assistant' }> | null = null;
	const closeCalls = () => {
		for (const c of open.values()) out.push({ role: 'tool', id: c.id, name: c.name, content: NO_RESULT, isError: true });
		open = new Map();
		assistant = null;
	};
	for (const ev of events) {
		if (!isObj(ev) || typeof ev.kind !== 'string' || ev.parent_tool_use_id) continue;
		switch (ev.kind) {
			case 'message': {
				const text = typeof ev.text === 'string' ? ev.text : '';
				if (ev.role === 'user') {
					closeCalls();
					if (text.trim()) out.push({ role: 'user', text });
				} else if (ev.role === 'assistant') {
					const clean = stripToolMarkup(text);
					if (!clean.trim()) break;
					// Text after tool results starts a new answer.
					if (assistant && !open.size && out[out.length - 1] === assistant && !assistant.calls.length) assistant.text += `\n\n${clean}`;
					else {
						closeCalls();
						assistant = { role: 'assistant', text: clean, calls: [] };
						out.push(assistant);
					}
				}
				break;
			}
			case 'tool_use': {
				const id = typeof ev.id === 'string' ? ev.id : '';
				const name = typeof ev.name === 'string' ? ev.name : '';
				if (!id || !name) break;
				const last = out[out.length - 1];
				// Calls belong to the answer right before them; after a tool result they start a new one.
				if (!assistant || last !== assistant) {
					closeCalls();
					assistant = { role: 'assistant', text: '', calls: [] };
					out.push(assistant);
				}
				const call = { id, name, arguments: JSON.stringify(isObj(ev.input) ? ev.input : {}) };
				assistant.calls.push(call);
				open.set(id, call);
				break;
			}
			case 'tool_result': {
				const id = typeof ev.tool_use_id === 'string' ? ev.tool_use_id : '';
				const call = open.get(id);
				if (!call) break;
				open.delete(id);
				out.push({ role: 'tool', id, name: call.name, content: typeof ev.content === 'string' ? ev.content : '', isError: ev.is_error === true });
				// The answer's results are all in: the next text or call is a new answer.
				if (!open.size) assistant = null;
				break;
			}
		}
	}
	for (const c of open.values()) out.push({ role: 'tool', id: c.id, name: c.name, content: NO_RESULT, isError: true });
	return out;
}
