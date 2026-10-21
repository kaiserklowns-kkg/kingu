import { describe, expect, test } from 'bun:test';
import { filterChats, historyStatus, isFiltered, NO_FILTER, parseHistoryQuery, snippetParts, type HistoryStatus, type SearchHit } from './chatHistory.ts';

const chats = [
	{ id: 'a', title: 'Fix the login bug', runtime: 'claude' },
	{ id: 'b', title: 'Write docs', runtime: 'arkai' },
	{ id: 'c', title: 'Refactor', runtime: undefined },
	{ id: 'd', title: 'ล็อกอินไม่ได้', runtime: 'claude' }
];
const STATUS: Record<string, HistoryStatus> = { a: 'idle', b: 'failed', c: 'working', d: 'needsInput' };
const hit = (id: string, text = 'the login form'): SearchHit => ({ id, title: '', title_match: false, matches: 1, snippets: [{ kind: 'assistant', text, start: 4, len: 5 }] });
const facts = (hits: SearchHit[] | null = null, edited: string[] = []) => ({ status: (id: string) => STATUS[id], edited: new Set(edited), hits });
const ids = (rows: { chat: { id: string } }[]) => rows.map((r) => r.chat.id);

describe('chat history filters', () => {
	test('a chat status: its live run first, else how its last run ended', () => {
		expect(historyStatus('running', 'failed')).toBe('working');
		expect(historyStatus('starting', undefined)).toBe('working');
		expect(historyStatus('waiting', undefined)).toBe('needsInput');
		expect(historyStatus(undefined, 'failed')).toBe('failed');
		expect(historyStatus(undefined, 'idle')).toBe('idle');
		expect(historyStatus('done', undefined)).toBe('idle');
		expect(historyStatus(undefined, undefined)).toBe('idle');
	});

	test('the quick pick reads status:, runtime: and has:edits out of the text', () => {
		expect(parseHistoryQuery('  login  status:failed runtime:Arkai has:edits bug')).toEqual({ query: 'login bug', status: 'failed', runtime: 'arkai', edits: true });
		expect(parseHistoryQuery('status:nope has:x')).toEqual({ ...NO_FILTER, query: 'status:nope has:x' });
		expect(isFiltered(NO_FILTER)).toBe(false);
		expect(isFiltered({ ...NO_FILTER, query: ' ' })).toBe(false);
		expect(isFiltered({ ...NO_FILTER, edits: true })).toBe(true);
	});

	test('keeps chats by title, transcript hit, status, runtime and edits', () => {
		const f = (over: Partial<typeof NO_FILTER>, fx = facts()) => ids(filterChats(chats, { ...NO_FILTER, ...over }, fx));
		expect(f({})).toEqual(['a', 'b', 'c', 'd']);
		expect(f({ query: 'LOGIN' }), 'titles, case-insensitive').toEqual(['a']);
		expect(f({ query: 'login' }, facts([hit('c')])), 'and transcript hits').toEqual(['a', 'c']);
		expect(f({ query: 'ล็อก' })).toEqual(['d']);
		expect(f({ status: 'failed' })).toEqual(['b']);
		expect(f({ runtime: 'claude' }), 'no runtime is Claude').toEqual(['a', 'c', 'd']);
		expect(f({ edits: true }, facts(null, ['b', 'c']))).toEqual(['b', 'c']);
		expect(f({ edits: true, runtime: 'claude' }, facts(null, ['b', 'c']))).toEqual(['c']);
		const rows = filterChats(chats, { ...NO_FILTER, query: 'login' }, facts([hit('a'), hit('c')]));
		expect(rows.map((r) => r.hit?.id ?? null)).toEqual(['a', 'c']);
	});

	test('a snippet splits around its match', () => {
		expect(snippetParts(hit('a').snippets[0])).toEqual({ before: 'the ', match: 'login', after: ' form' });
		expect(snippetParts({ kind: 'user', text: '…แก้ล็อกอิน…', start: 4, len: 4 })).toEqual({ before: '…แก้', match: 'ล็อก', after: 'อิน…' });
	});
});
