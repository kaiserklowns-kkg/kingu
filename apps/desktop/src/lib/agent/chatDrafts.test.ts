import { describe, expect, test } from 'bun:test';
import { parseDrafts, withDraft } from './chatDrafts.ts';

describe('chat drafts', () => {
	const day = 24 * 60 * 60_000;
	test('keeps recent, well-formed drafts', () => {
		const raw = JSON.stringify({ a: { text: 'hi', at: 100 * day }, old: { text: 'x', at: 1 }, bad: { text: 3, at: 1 }, empty: { text: '', at: 100 * day } });
		expect(parseDrafts(raw, 100 * day + 5)).toEqual({ a: { text: 'hi', at: 100 * day } });
		expect(parseDrafts('nope', 0)).toEqual({});
		expect(parseDrafts('[1]', 0)).toEqual({});
		expect(parseDrafts(null, 0)).toEqual({});
	});
	test('a blank draft is forgotten; the oldest go past 50', () => {
		let d = withDraft({}, 'a', 'hello', 1);
		expect(d).toEqual({ a: { text: 'hello', at: 1 } });
		expect(withDraft(d, 'a', '   ', 2)).toEqual({});
		for (let i = 0; i < 55; i++) d = withDraft(d, `c${i}`, 'x', 10 + i);
		expect(Object.keys(d).length).toBe(50);
		expect(d.a).toBeUndefined();
		expect(d.c54).toBeDefined();
	});
});
