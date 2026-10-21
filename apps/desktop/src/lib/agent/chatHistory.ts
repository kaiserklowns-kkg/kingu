// Finding a chat again (VS Code's agent sessions filter, agentSessionsFilter.ts): the history
// list's search box and filters, and the Show Chats quick pick. Titles match here; transcripts are
// searched by Rust (`chat_search`, agent/chat_debug.rs), whose hits come in as `hits`. Pure, so
// `bun test` covers it; chatHistory.svelte.ts keeps the state.

import type { RunStatus } from './events';
import type { ChatMeta } from './chats.ts';
import { runtimeOf } from './runtimes.ts';

/** Mirrors Rust `chat_debug::SearchHit`. */
export type SearchSnippet = { kind: 'user' | 'assistant' | 'tool' | 'result'; text: string; start: number; len: number };
export type SearchHit = { id: string; title: string; title_match: boolean; matches: number; snippets: SearchSnippet[] };

/** What the status filter tells apart. */
export const HISTORY_STATUSES = ['working', 'needsInput', 'idle', 'failed'] as const;
export type HistoryStatus = (typeof HISTORY_STATUSES)[number];

export type HistoryFilter = { query: string; status: HistoryStatus | null; runtime: string | null; edits: boolean };
export const NO_FILTER: HistoryFilter = { query: '', status: null, runtime: null, edits: false };

export const isFiltered = (f: HistoryFilter) => !!f.query.trim() || f.status !== null || f.runtime !== null || f.edits;

/** A chat's status for the filter: its live run's, else how its last run ended. */
export function historyStatus(live: RunStatus | undefined, last: RunStatus | undefined): HistoryStatus {
	const s = live ?? last;
	if (s === 'running' || s === 'starting') return 'working';
	if (s === 'waiting') return 'needsInput';
	if (s === 'failed') return 'failed';
	return 'idle';
}

/**
 * The query's own filters, typed in the quick pick (`status:failed`, `runtime:arkai`, `has:edits`),
 * over `base`; the rest of the text is the search.
 */
export function parseHistoryQuery(text: string, base: HistoryFilter = NO_FILTER): HistoryFilter {
	const out: HistoryFilter = { ...base, query: '' };
	const words: string[] = [];
	for (const w of text.split(/\s+/).filter(Boolean)) {
		const m = /^(status|runtime|has):(\S+)$/i.exec(w);
		const key = m?.[1].toLowerCase();
		const value = m?.[2] ?? '';
		if (key === 'status' && (HISTORY_STATUSES as readonly string[]).includes(value)) out.status = value as HistoryStatus;
		else if (key === 'runtime') out.runtime = value.toLowerCase();
		else if (key === 'has' && value.toLowerCase() === 'edits') out.edits = true;
		else words.push(w);
	}
	out.query = words.join(' ');
	return out;
}

/** Case-insensitive substring of the title (VS Code's sessions filter matches the label). */
const titleHas = (title: string, q: string) => title.toLocaleLowerCase().includes(q.toLocaleLowerCase());

export type HistoryFacts = {
	/** Status per chat id (`historyStatus`). */
	status: (id: string) => HistoryStatus;
	/** Chats that recorded edits (`chats_with_edits`). */
	edited: ReadonlySet<string>;
	/** Rust's transcript hits for `filter.query` (null: none yet, titles only). */
	hits: readonly SearchHit[] | null;
};

/** The chats of `list` the filter keeps, in `list`'s order, and the hit (snippets) of each. */
export function filterChats<T extends Pick<ChatMeta, 'id' | 'title' | 'runtime'>>(list: readonly T[], filter: HistoryFilter, facts: HistoryFacts): { chat: T; hit: SearchHit | null }[] {
	const q = filter.query.trim();
	const byId = new Map((facts.hits ?? []).map((h) => [h.id, h]));
	const out: { chat: T; hit: SearchHit | null }[] = [];
	for (const chat of list) {
		if (filter.status && facts.status(chat.id) !== filter.status) continue;
		if (filter.runtime && runtimeOf(chat) !== filter.runtime) continue;
		if (filter.edits && !facts.edited.has(chat.id)) continue;
		const hit = byId.get(chat.id) ?? null;
		if (q && !titleHas(chat.title, q) && !hit) continue;
		out.push({ chat, hit: hit && hit.snippets.length ? hit : null });
	}
	return out;
}

/** The first snippet as text with its match marked, for a list row's second line. */
export function snippetParts(s: SearchSnippet): { before: string; match: string; after: string } {
	const chars = [...s.text];
	return { before: chars.slice(0, s.start).join(''), match: chars.slice(s.start, s.start + s.len).join(''), after: chars.slice(s.start + s.len).join('') };
}
