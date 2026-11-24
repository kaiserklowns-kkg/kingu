import { describe, expect, test } from 'bun:test';
import { draftSummary, hasDraftContent, parseDrafts, sameDraft, withDraft } from './chatDrafts.ts';

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
	test('keeps attachments with the text; attachments alone are a draft (VS Code IChatDraft)', () => {
		const file = { path: '/tmp/a.png', name: 'a.png', image: true };
		const pick = { path: 'src/x.ts', range: { startLine: 2, endLine: 4 } };
		const d = withDraft({}, 'a', { text: '', files: [file], picked: [pick] }, 1);
		expect(d.a).toEqual({ text: '', files: [file], picked: [pick], at: 1 });
		expect(parseDrafts(JSON.stringify(d), 2)).toEqual(d);
		// Malformed attachments are dropped; with nothing left the draft goes.
		const raw = JSON.stringify({ b: { text: '', at: 1, files: [{ path: 3 }], picked: [{ path: 'x', range: { startLine: 'a' } }] } });
		expect(parseDrafts(raw, 2)).toEqual({});
		expect(withDraft(d, 'a', { text: ' ', files: [], picked: [] }, 3)).toEqual({});
	});
	test('same content is not saved again; summary is the first line, else the attachment count', () => {
		expect(sameDraft({ text: 'hi' }, { text: 'hi', files: [] })).toBe(true);
		expect(sameDraft(undefined, { text: '  ' })).toBe(true);
		expect(sameDraft({ text: 'hi' }, { text: 'hi', picked: [{ path: 'a' }] })).toBe(false);
		expect(hasDraftContent({ text: '', picked: [{ path: 'a' }] })).toBe(true);
		expect(draftSummary({ text: '\n  first line\nsecond' })).toEqual({ text: 'first line' });
		expect(draftSummary({ text: ' ', files: [{ path: 'p', name: 'p', image: false }], picked: [{ path: 'q' }] })).toEqual({ files: 2 });
	});
});
