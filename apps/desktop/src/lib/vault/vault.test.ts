import { describe, expect, test } from 'bun:test';
import { commandLine, continuePlan, dateBucket, dayBefore, filterSessions, formatUsd, groupSessions, parseVaultKey, projectName, summarizeStats, vaultKey, type VaultSession, type VaultStats } from './vault';

const row = (over: Partial<VaultSession>): VaultSession => ({
	agent: 'claude',
	id: 'abc',
	path: `/h/.claude/projects/x/${over.id ?? 'abc'}.jsonl`,
	title: 'A session',
	preview: null,
	cwd: '/w/app',
	cwdExists: true,
	branch: null,
	model: null,
	created: 0,
	updated: 0,
	size: 1,
	resume: ['claude', '--resume', over.id ?? 'abc'],
	...over
});

describe('vault', () => {
	test('project names', () => {
		expect(projectName('/Users/me/Kingu')).toBe('Kingu');
		expect(projectName('/Users/me/Kingu/.kingu/worktrees/fix-login')).toBe('Kingu › fix-login');
		expect(projectName(null)).toBe('');
	});

	test('date sections are local calendar days', () => {
		const now = new Date(2026, 9, 18, 15, 0).getTime();
		expect(dateBucket(new Date(2026, 9, 18, 0, 5).getTime(), now)).toBe('today');
		expect(dateBucket(new Date(2026, 9, 17, 23, 59).getTime(), now)).toBe('yesterday');
		expect(dateBucket(new Date(2026, 9, 12, 9).getTime(), now)).toBe('week');
		expect(dateBucket(new Date(2026, 8, 25).getTime(), now)).toBe('month');
		expect(dateBucket(new Date(2025, 0, 1).getTime(), now)).toBe('older');
	});

	test('groups by project, agent and date', () => {
		const now = new Date(2026, 9, 18, 15).getTime();
		const rows = [row({ id: 'a', cwd: '/w/app', updated: now - 1000 }), row({ id: 'b', cwd: null, agent: 'codex', updated: now }), row({ id: 'c', cwd: '/w/api', agent: 'codex', updated: now - 3 * 86_400_000 })];
		expect(groupSessions(rows, 'project', now).map((g) => [g.key, g.rows.map((r) => r.id)])).toEqual([
			['/w/app', ['a']],
			['/w/api', ['c']],
			['', ['b']]
		]);
		expect(groupSessions(rows, 'agent', now).map((g) => [g.key, g.rows.length])).toEqual([
			['codex', 2],
			['claude', 1]
		]);
		expect(groupSessions(rows, 'date', now).map((g) => g.key)).toEqual(['today', 'week']);
	});

	test('filters by agent, words, folder and search hits', () => {
		const rows = [row({ id: 'a', title: 'Fix login', cwd: '/w/app/.kingu/worktrees/x' }), row({ id: 'b', agent: 'gemini', title: 'Docs', cwd: '/w/apple' })];
		expect(filterSessions(rows, { agents: ['gemini'] }).map((r) => r.id)).toEqual(['b']);
		expect(filterSessions(rows, { filter: 'LOGIN fix' }).map((r) => r.id)).toEqual(['a']);
		expect(filterSessions(rows, { folder: '/w/app' }).map((r) => r.id)).toEqual(['a']);
		expect(filterSessions(rows, { hits: [{ path: rows[1].path, excerpt: '' }] }).map((r) => r.id)).toEqual(['b']);
	});

	test('continue: Claude in the open folder resumes in the chat, the rest in a terminal', () => {
		const tasks = (s: string) => s === 'fix';
		expect(continuePlan(row({ cwd: '/w/app' }), '/w/app', tasks)).toEqual({ kind: 'chat', cwd: { kind: 'folder' } });
		expect(continuePlan(row({ cwd: '/w/app/.kingu/worktrees/fix' }), '/w/app/', tasks)).toEqual({ kind: 'chat', cwd: { kind: 'task', slug: 'fix' } });
		expect(continuePlan(row({ cwd: '/w/app/.kingu/worktrees/gone' }), '/w/app', tasks).kind).toBe('terminal');
		const codex = continuePlan(row({ agent: 'codex', cwd: '/w/app', resume: ['codex', 'resume', 'id-1'] }), '/w/app', tasks);
		expect(codex).toEqual({ kind: 'terminal', cwd: '/w/app', run: ['sh', '-c', 'cd -- "$1" && shift && exec "$@"', 'sh', '/w/app', 'codex', 'resume', 'id-1'] });
		expect(continuePlan(row({ cwd: '/elsewhere' }), '/w/app', tasks).kind).toBe('terminal');
		expect(continuePlan(row({ resume: null }), '/w/app', tasks)).toEqual({ kind: 'none', reason: 'noId' });
		expect(continuePlan(row({ cwdExists: false }), '/w/app', tasks)).toEqual({ kind: 'none', reason: 'noFolder' });
	});

	test('command lines quote what needs it', () => {
		expect(commandLine(['claude', '--resume', 'a-1'])).toBe('claude --resume a-1');
		expect(commandLine(['x', "it's"])).toBe(`x 'it'\\''s'`);
	});

	test('editor keys', () => {
		const key = vaultKey('codex', '/h/.codex/sessions/2026/10/16/rollout-x.jsonl');
		expect(parseVaultKey(key)).toEqual({ agent: 'codex', path: '/h/.codex/sessions/2026/10/16/rollout-x.jsonl' });
		expect(parseVaultKey('vault:nope:/x')).toBeNull();
		expect(parseVaultKey('vault:claude:relative')).toBeNull();
	});

	test('stats sums and the daily series', () => {
		const t = (input: number) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0 });
		const stats: VaultStats = {
			rows: [
				{ day: '2026-10-17', agent: 'claude', model: 'claude-sonnet-4-5', tokens: t(100), cost: 2, sessions: 1 },
				{ day: '2026-10-18', agent: 'codex', model: 'gpt-5', tokens: t(50), cost: 1, sessions: 1 },
				{ day: '2026-10-18', agent: 'codex', model: 'mystery', tokens: t(10), cost: null, sessions: 1 }
			],
			top: [],
			today: '2026-10-18',
			sessionsWithUsage: 2,
			sessionsTotal: 3,
			unpriced: ['mystery']
		};
		const s = summarizeStats(stats, 3);
		expect(s.total).toEqual({ tokens: t(160), cost: 3, unpriced: true });
		expect(s.byAgent.map((a) => [a.agent, a.sum.cost, a.sum.unpriced])).toEqual([
			['claude', 2, false],
			['codex', 1, true]
		]);
		expect(s.byModel.map((m) => m.model)).toEqual(['claude-sonnet-4-5', 'gpt-5', 'mystery']);
		expect(s.days.map((d) => [d.day, d.sum.cost])).toEqual([
			['2026-10-16', 0],
			['2026-10-17', 2],
			['2026-10-18', 1]
		]);
		expect(dayBefore('2026-03-01', 1)).toBe('2026-02-28');
		expect([formatUsd(0.004), formatUsd(0), formatUsd(12.4)]).toEqual(['<$0.01', '$0.00', '$12.40']);
	});
});
