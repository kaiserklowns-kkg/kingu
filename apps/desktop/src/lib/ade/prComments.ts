// A pull request's review threads (Orca's PR comments in the Checks panel), from Rust
// `worktree_pr_threads` (`gh api graphql`). Pure, so `bun test` covers it.

export type ThreadComment = { id: number; author: string; body: string; created_at: string; url: string };
export type ReviewThread = {
	id: string;
	resolved: boolean;
	outdated: boolean;
	path: string | null;
	line: number | null;
	start_line: number | null;
	comments: ThreadComment[];
};

export function unresolvedThreads(threads: ReviewThread[]): ReviewThread[] {
	return threads.filter((t) => !t.resolved);
}

/** `src/a.ts:8-10`, `src/a.ts:10`, `src/a.ts` or '' (a thread on the whole PR). */
export function threadLocation(t: Pick<ReviewThread, 'path' | 'line' | 'start_line'>): string {
	if (!t.path) return '';
	if (t.line == null) return t.path;
	return t.start_line != null && t.start_line !== t.line ? `${t.path}:${t.start_line}-${t.line}` : `${t.path}:${t.line}`;
}

/** First line of a comment body, trimmed to `max` characters, for the collapsed thread row. */
export function snippet(body: string, max = 120): string {
	const line = body.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Threads after one was resolved (or reopened) on GitHub. */
export function withResolved(threads: ReviewThread[], id: string, resolved: boolean): ReviewThread[] {
	return threads.map((t) => (t.id === id ? { ...t, resolved } : t));
}

// ---------------------------------------------------------------------------------------------
// Bots (Orca's PR comment audience filter; `kingu.pr.botAuthors` adds logins)

/** Review services that post from ordinary accounts, matched inside the login. */
const REVIEW_SERVICES = ['coderabbit', 'codex-connector', 'sonarcloud', 'sonarqube', 'codecov', 'greptile', 'sourcery-ai', 'deepsource', 'snyk', 'graphite-app', 'qodo'];

export type Audience = 'all' | 'people' | 'bots';

/** The logins of `kingu.pr.botAuthors`, lowercased, without `@`. */
export function botOverrides(setting: readonly unknown[] | undefined): Set<string> {
	return new Set((setting ?? []).filter((x): x is string => typeof x === 'string').map((x) => x.trim().replace(/^@/, '').toLowerCase()).filter(Boolean));
}

/** A bot: GitHub's `[bot]` accounts, a known review service, a `-bot`/`bot` login, or one the user listed. */
export function isBotAuthor(login: string, overrides: ReadonlySet<string>): boolean {
	const l = login.trim().replace(/^@/, '').toLowerCase();
	if (!l) return false;
	if (overrides.has(l) || l.endsWith('[bot]')) return true;
	if (REVIEW_SERVICES.some((s) => l.includes(s))) return true;
	return /(?:^|[-_])bot$/.test(l) || /dependabot|renovate/.test(l);
}

/** Threads whose first comment is from the chosen audience. */
export function byAudience(threads: ReviewThread[], audience: Audience, overrides: ReadonlySet<string>): ReviewThread[] {
	if (audience === 'all') return threads;
	return threads.filter((t) => isBotAuthor(t.comments[0]?.author ?? '', overrides) === (audience === 'bots'));
}
