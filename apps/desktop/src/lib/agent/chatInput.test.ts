/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { hashTrigger, modeOf, permissionFor, recallPrompt, shouldDrain, turnBusy } from './chatInput';
import { splitMarkdown } from './chatMarkdown';

describe('↑/↓ prompt history', () => {
	const h = ['one', 'two', 'three'];

	test('↑ from an empty input recalls the newest, then older ones, stopping at the oldest', () => {
		let s = recallPrompt(h, null, 'up', '')!;
		expect(s).toEqual({ cursor: 2, text: 'three' });
		s = recallPrompt(h, s.cursor, 'up', s.text)!;
		expect(s).toEqual({ cursor: 1, text: 'two' });
		s = recallPrompt(h, 0, 'up', 'one')!;
		expect(s).toEqual({ cursor: 0, text: 'one' });
	});

	test('↓ goes forward and past the newest back to an empty input', () => {
		expect(recallPrompt(h, 1, 'down', 'two')).toEqual({ cursor: 2, text: 'three' });
		expect(recallPrompt(h, 2, 'down', 'three')).toEqual({ cursor: null, text: '' });
	});

	test('a typed input, no history or ↓ when not browsing leave the key alone', () => {
		expect(recallPrompt(h, null, 'up', 'draft')).toBeNull();
		expect(recallPrompt(h, null, 'down', '')).toBeNull();
		expect(recallPrompt([], null, 'up', '')).toBeNull();
		// The recalled text was edited: it is the user's own now.
		expect(recallPrompt(h, 2, 'up', 'three!')).toBeNull();
	});
});

describe('Ask / Agent', () => {
	test('Ask is plan mode; Agent keeps its approval choice', () => {
		expect(modeOf('plan')).toBe('ask');
		expect(modeOf('acceptEdits')).toBe('agent');
		expect(modeOf(null)).toBe('agent');
		expect(permissionFor('ask', 'acceptEdits')).toBe('plan');
		expect(permissionFor('agent', 'acceptEdits')).toBe('acceptEdits');
		expect(permissionFor('agent', null)).toBe('default');
	});
});

describe('queue', () => {
	test('a request waits while a turn starts, runs or waits for approval', () => {
		expect(turnBusy(undefined)).toBe(false);
		expect(turnBusy({ ended: false, status: 'running' })).toBe(true);
		expect(turnBusy({ ended: false, status: 'waiting' })).toBe(true);
		expect(turnBusy({ ended: false, status: 'starting' })).toBe(true);
		expect(turnBusy({ ended: false, status: 'idle' })).toBe(false);
		expect(turnBusy({ ended: true, status: 'done' })).toBe(false);
	});

	test('the queue is sent when the turn ends, not after the user ended the session', () => {
		expect(shouldDrain(1, { ended: false, status: 'idle' })).toBe(true);
		expect(shouldDrain(0, { ended: false, status: 'idle' })).toBe(false);
		expect(shouldDrain(1, { ended: false, status: 'running' })).toBe(false);
		expect(shouldDrain(1, { ended: true, status: 'done' })).toBe(true);
		expect(shouldDrain(1, { ended: true, status: 'failed' })).toBe(true);
		expect(shouldDrain(1, { ended: true, status: 'stopped' })).toBe(false);
	});
});

test('# opens the file picker only at the start of a word', () => {
	expect(hashTrigger('#', 1)).toBe(0);
	expect(hashTrigger('look at #', 9)).toBe(8);
	expect(hashTrigger('issue#', 6)).toBe(-1);
	expect(hashTrigger('a # b', 2)).toBe(-1);
});

test('markdown: code blocks split out with their language, prose rendered', () => {
	const segs = splitMarkdown('# Title\n\nSome `code` and a [link](https://x.dev).\n\n```ts\nconst a = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
	expect(segs.map((s) => s.kind)).toEqual(['markdown', 'code', 'markdown']);
	expect(segs[1]).toEqual({ kind: 'code', lang: 'ts', code: 'const a = 1;' });
	const html = (segs[0] as { html: string }).html;
	expect(html).toContain('<h1');
	expect(html).toContain('<code>code</code>');
	expect(html).toContain('data-href="https://x.dev"');
	expect((segs[2] as { html: string }).html).toContain('<table>');
	expect(splitMarkdown('<script>alert(1)</script>')[0]).toMatchObject({ kind: 'markdown' });
	expect((splitMarkdown('<script>alert(1)</script>')[0] as { html: string }).html).not.toContain('<script>');
});
