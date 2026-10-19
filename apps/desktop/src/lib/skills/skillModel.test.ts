import { describe, expect, test } from 'bun:test';
import { setLocale } from '#lib/i18n/index.ts';
import { canUnshare, firstCandidate, flagText, groupBySource, isLive, isTeamShareable, looksInstallable, originLabel, reviewFlags, teamSkillState, type PreparedSkills, type SkillCandidate, type SkillInfo, type SkillOrigin, type TeamSkill } from './skillModel.ts';

setLocale('en');

const C = '0123456789abcdef0123456789abcdef01234567';

const origin = (over: Partial<SkillOrigin> = {}): SkillOrigin => ({ kind: 'git', url: 'https://github.com/acme/skills', ref: 'main', commit: C, archiveSha256: null, local: null, path: 'skills/pdf', hash: 'h1', installedAt: 1, ...over });

const info = (over: Partial<SkillInfo> & Pick<SkillInfo, 'id' | 'source'>): SkillInfo => ({
	name: over.id.split(/[:/]/).pop() ?? '',
	description: '',
	dir: '/x',
	enabled: true,
	toggleable: true,
	inactive: false,
	error: null,
	snap: null,
	origin: null,
	flags: [],
	shareLink: null,
	...over
});

const shared = (over: Partial<TeamSkill> = {}): TeamSkill => ({ skill_name: 'pdf', description: 'd', git_url: 'https://github.com/acme/skills', git_ref: 'main', path: 'skills/pdf', commit_sha: C, content_sha256: 'h1', shared_by: 'dan', shared_at: '', note: null, ...over });

describe('skills view', () => {
	test('groups by source in a fixed order and leaves empty groups out', () => {
		const list = [info({ id: 'user:a', source: 'user' }), info({ id: 'managed:b', source: 'managed' }), info({ id: 'builtin:kingu', source: 'builtin' })];
		expect(groupBySource(list).map((g) => g.source)).toEqual(['managed', 'builtin', 'user']);
	});

	test('a skill is live when on, its snap is active and it has no error', () => {
		expect(isLive(info({ id: 'managed:a', source: 'managed' }))).toBe(true);
		expect(isLive(info({ id: 'managed:a', source: 'managed', enabled: false }))).toBe(false);
		expect(isLive(info({ id: 'snap:go/a', source: 'snap', inactive: true }))).toBe(false);
		expect(isLive(info({ id: 'managed:a', source: 'managed', error: 'bad' }))).toBe(false);
	});

	test('origin on one line', () => {
		expect(originLabel(origin())).toBe('github.com/acme/skills @ main · skills/pdf (0123456)');
		expect(originLabel(origin({ kind: 'file', url: null, ref: null, commit: null, local: '/tmp/pdf.skill', path: 'pdf' }))).toBe('/tmp/pdf.skill · pdf');
		expect(originLabel(origin({ url: 'git@example.com:t/s.git', ref: null, path: '' }))).toBe('git@example.com:t/s (0123456)');
	});

	test('review flags: one per path, risky first', () => {
		const flags = reviewFlags([
			{ kind: 'renamed', folder: 'x' },
			{ kind: 'script', path: 'run.sh' },
			{ kind: 'executable', path: 'run.sh' },
			{ kind: 'allowedTools', tools: 'Bash' },
			{ kind: 'binary', path: 'tool' }
		]);
		expect(flags.map((f) => f.kind)).toEqual(['binary', 'executable', 'allowedTools', 'renamed']);
		expect(flagText({ kind: 'hiddenSkipped', count: 2 })).toBe('2 hidden files are left out');
		expect(flagText({ kind: 'allowedTools', tools: 'Read, Bash' })).toBe('Pre-approves tools while active: Read, Bash');
	});

	test('only managed skills from a remote git commit can be shared with the team', () => {
		expect(isTeamShareable(info({ id: 'managed:pdf', source: 'managed', origin: origin() }))).toBe(true);
		expect(isTeamShareable(info({ id: 'managed:pdf', source: 'managed', origin: origin({ url: '/srv/s.git' }) }))).toBe(false);
		expect(isTeamShareable(info({ id: 'managed:pdf', source: 'managed', origin: origin({ url: 'FILE:///s' }) }))).toBe(false);
		expect(isTeamShareable(info({ id: 'managed:pdf', source: 'managed', origin: origin({ kind: 'archive', url: 'https://x/p.skill' }) }))).toBe(false);
		expect(isTeamShareable(info({ id: 'managed:pdf', source: 'managed', origin: origin({ commit: 'abc' }) }))).toBe(false);
		expect(isTeamShareable(info({ id: 'snap:go/pdf', source: 'snap', origin: origin() }))).toBe(false);
	});

	test('links the install box accepts', () => {
		for (const ok of ['https://github.com/o/r/tree/main/pdf', 'git@github.com:o/r.git', 'ssh://git@h/r.git', 'file:///srv/r.git', '/Users/me/pdf.skill']) expect(looksInstallable(ok)).toBe(true);
		for (const bad of ['', 'pdf', 'http ://x', 'ftp://x/y']) expect(looksInstallable(bad)).toBe(false);
	});

	test('team skills against what is installed', () => {
		const here = [info({ id: 'managed:pdf', source: 'managed', origin: origin() })];
		expect(teamSkillState(shared(), here)).toBe('match');
		expect(teamSkillState(shared({ content_sha256: 'h2' }), here)).toBe('different');
		expect(teamSkillState(shared({ skill_name: 'notes' }), here)).toBe('missing');
		expect(teamSkillState(shared(), [info({ id: 'user:pdf', source: 'user' })])).toBe('missing');
		expect(canUnshare(shared(), 'dan', 'dev')).toBe(true);
		expect(canUnshare(shared(), 'dee', 'dev')).toBe(false);
		expect(canUnshare(shared(), 'olive', 'lead')).toBe(true);
	});

	test('the review starts on the first installable candidate', () => {
		const c = (rel: string, error: string | null): SkillCandidate => ({ rel, name: rel, description: '', allowedTools: null, files: [], flags: [], hash: '', skillMd: '', truncated: false, error });
		const p = (candidates: SkillCandidate[]): PreparedSkills => ({ token: 't', origin: origin(), candidates, existing: [] });
		expect(firstCandidate(p([c('a', 'broken'), c('b', null)]))?.rel).toBe('b');
		expect(firstCandidate(p([c('a', 'broken')]))?.rel).toBe('a');
	});
});
