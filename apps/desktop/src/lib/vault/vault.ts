// AI Vault (old Kingu's kinguVault*): every agent's past sessions on this machine, read by Rust
// (src-tauri/src/vault). Pure: the row and stats types, grouping by project / agent / date,
// filters, what "Continue here" does for a session, and the stats sums the usage page shows.

export type VaultAgent = 'claude' | 'codex' | 'gemini' | 'opencode' | 'cursor';
export const VAULT_AGENTS: readonly VaultAgent[] = ['claude', 'codex', 'gemini', 'opencode', 'cursor'];
/** Product names, the same in every language. */
export const AGENT_NAME: Record<VaultAgent, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', opencode: 'OpenCode', cursor: 'Cursor CLI' };

export type VaultSession = {
	agent: VaultAgent;
	id: string;
	path: string;
	title: string;
	preview: string | null;
	cwd: string | null;
	cwdExists: boolean;
	branch: string | null;
	model: string | null;
	/** Unix ms. */
	created: number;
	updated: number;
	size: number;
	resume: string[] | null;
};

export type VaultTurn = { role: 'user' | 'assistant' | 'tool'; text: string; at: number | null };
export type VaultTranscript = { turns: VaultTurn[]; truncated: boolean };
export type VaultHit = { path: string; excerpt: string };
export type VaultSearch = { hits: VaultHit[]; searched: number; total: number; stopped: 'complete' | 'limit' | 'budget' | 'cancelled' };

export type GroupBy = 'project' | 'agent' | 'date';
export type DateBucket = 'today' | 'yesterday' | 'week' | 'month' | 'older';
/** A list section: `key` is a cwd ('' for none), an agent or a date bucket. */
export type Group = { kind: GroupBy; key: string; rows: VaultSession[] };

/** The last path segment of a working directory (a task worktree reads `repo › slug`). */
export function projectName(cwd: string | null): string {
	if (!cwd) return '';
	const wt = /^(.*)\/\.kingu\/worktrees\/([^/]+)\/?$/.exec(cwd);
	const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;
	return wt ? `${base(wt[1])} › ${wt[2]}` : base(cwd);
}

const DAY = 86_400_000;

/** Which date section `t` falls in, by local calendar days before `now`. */
export function dateBucket(t: number, now: number): DateBucket {
	const start = new Date(now);
	start.setHours(0, 0, 0, 0);
	const today = start.getTime();
	if (t >= today) return 'today';
	if (t >= today - DAY) return 'yesterday';
	if (t >= today - 6 * DAY) return 'week';
	if (t >= today - 29 * DAY) return 'month';
	return 'older';
}

const BUCKETS: DateBucket[] = ['today', 'yesterday', 'week', 'month', 'older'];

/** Rows (newest first) in sections: projects and agents by their newest session, dates in order. */
export function groupSessions(rows: readonly VaultSession[], by: GroupBy, now: number): Group[] {
	const sorted = [...rows].sort((a, b) => b.updated - a.updated);
	const keyOf = (s: VaultSession) => (by === 'project' ? (s.cwd ?? '') : by === 'agent' ? s.agent : dateBucket(s.updated, now));
	const groups = new Map<string, VaultSession[]>();
	for (const s of sorted) {
		const k = keyOf(s);
		const list = groups.get(k);
		if (list) list.push(s);
		else groups.set(k, [s]);
	}
	const out = [...groups].map(([key, list]) => ({ kind: by, key, rows: list }));
	if (by === 'date') out.sort((a, b) => BUCKETS.indexOf(a.key as DateBucket) - BUCKETS.indexOf(b.key as DateBucket));
	// Sessions with no recorded folder go last.
	else if (by === 'project') out.sort((a, b) => Number(a.key === '') - Number(b.key === ''));
	return out;
}

/**
 * The rows a list shows: of the chosen agents, matching every word of `filter` in the title,
 * folder, branch, model or latest message, and (when a full-text search ran) only its hits.
 */
export function filterSessions(rows: readonly VaultSession[], opts: { agents?: readonly VaultAgent[]; filter?: string; hits?: readonly VaultHit[] | null; folder?: string | null }): VaultSession[] {
	const words = (opts.filter ?? '').toLowerCase().split(/\s+/).filter(Boolean);
	const hit = opts.hits ? new Set(opts.hits.map((h) => h.path)) : null;
	const inFolder = (cwd: string | null) => !opts.folder || (!!cwd && (cwd === opts.folder || cwd.startsWith(opts.folder.replace(/\/+$/, '') + '/')));
	return rows.filter((s) => {
		if (opts.agents?.length && !opts.agents.includes(s.agent)) return false;
		if (hit && !hit.has(s.path)) return false;
		if (!inFolder(s.cwd)) return false;
		const hay = [s.title, s.cwd ?? '', s.branch ?? '', s.model ?? '', s.preview ?? '', s.id].join(' ').toLowerCase();
		return words.every((w) => hay.includes(w));
	});
}

/** `argv` typed into a shell so that it runs in `cwd` (each argument is quoted by the terminal). */
export function inFolder(cwd: string, argv: readonly string[]): string[] {
	return ['sh', '-c', 'cd -- "$1" && shift && exec "$@"', 'sh', cwd, ...argv];
}

/** The shell line of a resume command, for Copy (simple quoting, like the terminal's). */
export function commandLine(argv: readonly string[]): string {
	return argv.map((a) => (/^[A-Za-z0-9_\-./=:@%+,]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

/** Chat folders as chats.ts names them. */
export type ContinueCwd = { kind: 'folder' } | { kind: 'task'; slug: string };

export type ContinuePlan =
	/** A Claude Code session of the open folder or one of its task worktrees: resumed in Kingu's chat. */
	| { kind: 'chat'; cwd: ContinueCwd }
	/** The agent's own resume command in a terminal of the session's folder. */
	| { kind: 'terminal'; run: string[]; cwd: string }
	| { kind: 'none'; reason: 'noId' | 'noFolder' };

/**
 * What "Continue here" does. Kingu's chat runs Claude Code's SDK, which resumes a session only in
 * the folder it ran in, so a Claude session continues in the chat when that folder is the open
 * one (or a task worktree of it, `taskExists`); everything else gets its CLI's resume command.
 */
export function continuePlan(s: VaultSession, root: string | null, taskExists: (slug: string) => boolean): ContinuePlan {
	if (!s.resume) return { kind: 'none', reason: 'noId' };
	if (!s.cwd || !s.cwdExists) return { kind: 'none', reason: 'noFolder' };
	const cwd = s.cwd.replace(/\/+$/, '');
	if (s.agent === 'claude' && root) {
		const r = root.replace(/\/+$/, '');
		if (cwd === r) return { kind: 'chat', cwd: { kind: 'folder' } };
		const slug = cwd.startsWith(`${r}/.kingu/worktrees/`) ? cwd.slice(`${r}/.kingu/worktrees/`.length) : null;
		if (slug && !slug.includes('/') && taskExists(slug)) return { kind: 'chat', cwd: { kind: 'task', slug } };
	}
	return { kind: 'terminal', run: inFolder(cwd, s.resume), cwd };
}

// ---------------------------------------------------------------------------------------------
// Stats (Rust vault_stats)

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type StatRow = { day: string; agent: VaultAgent; model: string | null; tokens: Tokens; cost: number | null; sessions: number };
export type TopSession = { agent: VaultAgent; path: string; title: string; cwd: string | null; updated: number; tokens: Tokens; cost: number; partial: boolean };
export type VaultStats = { rows: StatRow[]; top: TopSession[]; today: string; sessionsWithUsage: number; sessionsTotal: number; unpriced: string[] };

export const ZERO: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const plus = (a: Tokens, b: Tokens): Tokens => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite });
/** Tokens that are not cache reads (cache reads are most of a long session and cost a tenth). */
export const freshTokens = (t: Tokens) => t.input + t.output + t.cacheWrite;

/** A total: tokens, the priced cost, and whether some of it ran on an unpriced model. */
export type Sum = { tokens: Tokens; cost: number; unpriced: boolean };
const add = (s: Sum, r: StatRow): Sum => ({ tokens: plus(s.tokens, r.tokens), cost: s.cost + (r.cost ?? 0), unpriced: s.unpriced || r.cost === null });
const EMPTY: Sum = { tokens: ZERO, cost: 0, unpriced: false };

/** `YYYY-MM-DD` `n` days before `day` (calendar arithmetic in UTC, so no time zone shifts it). */
export function dayBefore(day: string, n: number): string {
	const [y, m, d] = day.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}

export type StatsSummary = {
	total: Sum;
	byAgent: { agent: VaultAgent; sum: Sum }[];
	byModel: { model: string; agent: VaultAgent; sum: Sum }[];
	/** The last `days` days, oldest first, empty days included. */
	days: { day: string; sum: Sum }[];
};

/** The usage page's totals: by agent and model (largest cost first) and the daily series. */
export function summarizeStats(stats: VaultStats, days: number): StatsSummary {
	let total = EMPTY;
	const agents = new Map<VaultAgent, Sum>();
	const models = new Map<string, { model: string; agent: VaultAgent; sum: Sum }>();
	const perDay = new Map<string, Sum>();
	for (const r of stats.rows) {
		total = add(total, r);
		agents.set(r.agent, add(agents.get(r.agent) ?? EMPTY, r));
		const key = `${r.agent}\u0000${r.model ?? ''}`;
		const m = models.get(key) ?? { model: r.model ?? '', agent: r.agent, sum: EMPTY };
		models.set(key, { ...m, sum: add(m.sum, r) });
		perDay.set(r.day, add(perDay.get(r.day) ?? EMPTY, r));
	}
	const bySize = (a: Sum, b: Sum) => b.cost - a.cost || freshTokens(b.tokens) - freshTokens(a.tokens);
	return {
		total,
		byAgent: [...agents].map(([agent, sum]) => ({ agent, sum })).sort((a, b) => bySize(a.sum, b.sum)),
		byModel: [...models.values()].sort((a, b) => bySize(a.sum, b.sum)),
		days: Array.from({ length: Math.max(1, days) }, (_, i) => dayBefore(stats.today, Math.max(1, days) - 1 - i)).map((day) => ({ day, sum: perDay.get(day) ?? EMPTY }))
	};
}

/** `1.2M`, `34.5k`, `980`. */
export const compactTokens = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

/** `$12.40`, `<$0.01` (never `$0.00` for something that cost money). */
export const formatUsd = (usd: number) => (usd > 0 && usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`);

/** Editor tab of a transcript: `vault:<agent>:<path>`. */
export const VAULT_PREFIX = 'vault:';
export const vaultKey = (agent: VaultAgent, path: string) => `${VAULT_PREFIX}${agent}:${path}`;
export const isVaultKey = (key: string) => key.startsWith(VAULT_PREFIX);
export function parseVaultKey(key: string): { agent: VaultAgent; path: string } | null {
	const m = /^vault:([a-z]+):(\/.*)$/.exec(key);
	return m && (VAULT_AGENTS as readonly string[]).includes(m[1]) ? { agent: m[1] as VaultAgent, path: m[2] } : null;
}
