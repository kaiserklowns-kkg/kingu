// Git blame for the editor (VS Code's extensions/git/src/blame.ts): `git blame --porcelain`
// parsed into one entry per line, VS Code's `git.blame.*.template` tokens, and the lines of an
// unsaved buffer mapped onto the blamed (saved) file. Pure, so bun tests cover it.

import { diffLines, mapLine, splitLines } from './lineDiff';

export const UNCOMMITTED = '0000000000000000000000000000000000000000';

export type BlameCommit = {
	hash: string;
	authorName: string;
	authorEmail: string;
	/** Unix seconds. */
	authorTime: number;
	committerTime: number;
	subject: string;
	/** Not committed yet (the all-zero commit). */
	uncommitted: boolean;
};

export type Blame = {
	/** `lines[i]` blames line `i + 1` of the blamed file. */
	lines: (BlameCommit | null)[];
	commits: Map<string, BlameCommit>;
};

/**
 * Parses `git blame --porcelain`: a header `<hash> <orig> <final> [<count>]` per line group, the
 * commit's fields the first time it appears, and the line itself after a tab.
 */
export function parseBlamePorcelain(text: string): Blame {
	const commits = new Map<string, BlameCommit>();
	const lines: (BlameCommit | null)[] = [];
	let current: BlameCommit | null = null;
	let finalLine = 0;
	for (const raw of text.split('\n')) {
		if (raw.startsWith('\t')) {
			if (current && finalLine > 0) lines[finalLine - 1] = current;
			continue;
		}
		const header = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/.exec(raw);
		if (header) {
			const hash = header[1];
			finalLine = Number(header[3]);
			current = commits.get(hash) ?? null;
			if (!current) {
				current = { hash, authorName: '', authorEmail: '', authorTime: 0, committerTime: 0, subject: '', uncommitted: hash === UNCOMMITTED };
				commits.set(hash, current);
			}
			continue;
		}
		if (!current) continue;
		const sp = raw.indexOf(' ');
		const key = sp < 0 ? raw : raw.slice(0, sp);
		const value = sp < 0 ? '' : raw.slice(sp + 1);
		if (key === 'author') current.authorName = value;
		else if (key === 'author-mail') current.authorEmail = value.replace(/^<|>$/g, '');
		else if (key === 'author-time') current.authorTime = Number(value) || 0;
		else if (key === 'committer-time') current.committerTime = Number(value) || 0;
		else if (key === 'summary') current.subject = value;
	}
	for (let i = 0; i < lines.length; i++) lines[i] ??= null;
	return { lines, commits };
}

/** What a buffer line shows: a commit, or not committed yet (`unsaved`: only in the editor). */
export type LineBlame = { kind: 'commit'; commit: BlameCommit } | { kind: 'uncommitted'; unsaved: boolean };

/**
 * The blame of each line of `buffer`, from the blame of the saved file `saved`: unchanged lines
 * keep their commit, edited ones are not committed yet. `lines[i]` is buffer line `i + 1`.
 */
export function blameBuffer(blame: Blame, saved: string, buffer: string): LineBlame[] {
	const s = splitLines(saved);
	const b = splitLines(buffer);
	const changes = saved === buffer ? [] : diffLines(s, b);
	const out: LineBlame[] = [];
	for (let line = 1; line <= Math.max(b.length, 1); line++) {
		const at = mapLine(changes, line);
		const commit = at === null ? null : blame.lines[at - 1];
		if (at === null) out.push({ kind: 'uncommitted', unsaved: true });
		else if (!commit || commit.uncommitted) out.push({ kind: 'uncommitted', unsaved: false });
		else out.push({ kind: 'commit', commit });
	}
	return out;
}

/** VS Code's `_subjectMaxLength` for the template's `${subject}`. */
export const SUBJECT_MAX = 50;

const truncate = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max)}…`);

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
	['year', 365 * 24 * 3600],
	['month', 30 * 24 * 3600],
	['week', 7 * 24 * 3600],
	['day', 24 * 3600],
	['hour', 3600],
	['minute', 60],
	['second', 1]
];

/** "3 days ago" in `locale` (VS Code's fromNow with `useFullTimeWords`). */
export function fromNow(seconds: number, nowMs: number, locale: string): string {
	const diff = Math.round(nowMs / 1000 - seconds);
	const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
	if (Math.abs(diff) < 30) return rtf.format(0, 'second');
	for (const [unit, size] of UNITS) if (Math.abs(diff) >= size) return rtf.format(-Math.floor(diff / size), unit);
	return rtf.format(0, 'second');
}

export type TemplateTokens = { hash: string; hashShort: string; subject: string; authorName: string; authorEmail: string; authorDate: string; authorDateAgo: string };

/** The tokens of `${…}` in the `git.blame.*.template` settings. */
export function templateTokens(c: BlameCommit, opts: { nowMs: number; locale: string; shortLength?: number }): TemplateTokens {
	return {
		hash: c.hash,
		hashShort: c.hash.slice(0, opts.shortLength ?? 7),
		subject: truncate(c.subject, SUBJECT_MAX),
		authorName: c.authorName,
		authorEmail: c.authorEmail,
		authorDate: new Date(c.authorTime * 1000).toLocaleString(opts.locale),
		authorDateAgo: fromNow(c.authorTime, opts.nowMs, opts.locale)
	};
}

/** `template` with its `${token}`s replaced; unknown tokens stay as written (VS Code). */
export function formatTemplate(template: string, tokens: TemplateTokens): string {
	return template.replace(/\$\{(\w+)\}/g, (all, name: string) => (name in tokens ? tokens[name as keyof TemplateTokens] : all));
}
