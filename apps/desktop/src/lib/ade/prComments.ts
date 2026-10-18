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
