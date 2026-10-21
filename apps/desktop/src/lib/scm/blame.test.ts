/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { blameBuffer, formatTemplate, fromNow, parseBlamePorcelain, templateTokens, UNCOMMITTED } from './blame';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

// Real `git blame --porcelain` shape: a commit's fields only the first time it appears.
const PORCELAIN = [
	`${A} 1 1 2`,
	'author Ann',
	'author-mail <ann@example.com>',
	'author-time 1700000000',
	'author-tz +0700',
	'committer Ann',
	'committer-mail <ann@example.com>',
	'committer-time 1700000100',
	'committer-tz +0700',
	'summary First commit',
	'boundary',
	'filename a.txt',
	'\tone',
	`${A} 2 2`,
	'\ttwo',
	`${B} 3 3 1`,
	'author Bo',
	'author-mail <bo@example.com>',
	'author-time 1700086400',
	'author-tz +0000',
	'committer Bo',
	'committer-mail <bo@example.com>',
	'committer-time 1700086400',
	'committer-tz +0000',
	'summary Second: a much longer subject line that goes on and on past fifty',
	`previous ${A} a.txt`,
	'filename a.txt',
	'\tthree',
	`${UNCOMMITTED} 4 4 1`,
	'author Not Committed Yet',
	'author-mail <not.committed.yet>',
	'author-time 1700090000',
	'author-tz +0000',
	'committer Not Committed Yet',
	'committer-mail <not.committed.yet>',
	'committer-time 1700090000',
	'committer-tz +0000',
	'summary Version of a.txt from a.txt',
	'filename a.txt',
	'\tfour',
	`${A} 3 5`,
	'\t\tauthor looks like a field but is a line',
	''
].join('\n');

describe('parseBlamePorcelain', () => {
	test('one entry per line, commits shared between their lines', () => {
		const b = parseBlamePorcelain(PORCELAIN);
		expect(b.lines.length).toBe(5);
		expect(b.lines.map((c) => c?.hash[0])).toEqual(['a', 'a', 'b', '0', 'a']);
		expect(b.lines[0]).toBe(b.lines[1]);
		const first = b.commits.get(A)!;
		expect(first).toMatchObject({ authorName: 'Ann', authorEmail: 'ann@example.com', authorTime: 1700000000, committerTime: 1700000100, subject: 'First commit', uncommitted: false });
		expect(b.commits.get(UNCOMMITTED)!.uncommitted).toBe(true);
		expect(b.commits.size).toBe(3);
	});
	test('empty output blames nothing', () => {
		expect(parseBlamePorcelain('').lines).toEqual([]);
	});
});

describe('blameBuffer', () => {
	const blame = parseBlamePorcelain(PORCELAIN);
	const saved = 'one\ntwo\nthree\nfour\nfive\n';
	test('a saved buffer takes the blame as is', () => {
		const lines = blameBuffer(blame, saved, saved);
		expect(lines.map((l) => (l.kind === 'commit' ? l.commit.authorName : l.unsaved ? 'unsaved' : 'uncommitted'))).toEqual(['Ann', 'Ann', 'Bo', 'uncommitted', 'Ann']);
	});
	test('unsaved edits are uncommitted and the lines below keep their commit', () => {
		const buffer = 'zero\none\ntwo\nTHREE\nfour\nfive\n';
		const lines = blameBuffer(blame, saved, buffer);
		expect(lines.map((l) => (l.kind === 'commit' ? l.commit.authorName : l.unsaved ? 'unsaved' : 'uncommitted'))).toEqual(['unsaved', 'Ann', 'Ann', 'unsaved', 'uncommitted', 'Ann']);
	});
});

describe('templates', () => {
	const c = parseBlamePorcelain(PORCELAIN).commits.get(B)!;
	const now = (1700086400 + 3 * 86400) * 1000;
	test('VS Code’s default templates', () => {
		const tokens = templateTokens(c, { nowMs: now, locale: 'en' });
		expect(tokens.subject).toBe('Second: a much longer subject line that goes on an…');
		expect(tokens.hashShort).toBe('bbbbbbb');
		expect(formatTemplate('${subject}, ${authorName} (${authorDateAgo})', tokens)).toBe('Second: a much longer subject line that goes on an…, Bo (3 days ago)');
		expect(formatTemplate('${authorName} (${authorDateAgo}) ${unknown} ${hash}', tokens)).toBe(`Bo (3 days ago) \${unknown} ${B}`);
	});
	test('fromNow picks the largest unit and speaks the UI language', () => {
		const at = 1_000_000;
		expect(fromNow(at, (at + 5) * 1000, 'en')).toBe('now');
		expect(fromNow(at, (at + 2 * 3600) * 1000, 'en')).toBe('2 hours ago');
		expect(fromNow(at, (at + 400 * 86400) * 1000, 'en')).toBe('last year');
		expect(fromNow(at, (at + 3 * 86400) * 1000, 'th')).toBe('3 วันที่ผ่านมา');
	});
});
