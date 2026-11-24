import { expect, test } from 'bun:test';
import { paneAgentLaunch } from './paneLaunch.ts';
import { paneTrustRequest } from './paneTrust.ts';
import { agentArgsSetting, agentEnvSetting, AUTO_ARGS, UPDATE_PROMPT_ARGS, UPDATE_PROMPT_ENV, YOLO_ARGS, YOLO_ENV } from './agentCli.ts';
import { PROFILES } from './agentProfiles.ts';

const from = (s: Record<string, unknown>) => (k: string) => s[k];
const argv = (pick: string, s: Record<string, unknown> = {}, prompt?: string) => {
	const r = paneAgentLaunch(pick, from(s), prompt);
	if ('error' in r) throw new Error(r.error);
	return r.argv;
};

test("an agent tab starts with Orca's launch command, not the bare program", () => {
	expect(argv('kiro-cli')).toEqual(['kiro-cli', 'chat', '--tui']);
	expect(argv('hermes')).toEqual(['hermes', '--tui']);
	expect(argv('acli')).toEqual(['acli', 'rovodev', 'run']);
	expect(argv('dsh-tui')).toEqual(['dsh-tui', '.']);
	expect(argv('opencode2')).toEqual(['opencode2', '--standalone']);
	expect(argv('command-code')).toEqual(['command-code', '--trust']);
	expect(argv('muse')).toEqual(['muse', '--trust-workspace']);
	expect(argv('claude')).toEqual(['claude']);
	expect(argv('codex')).toEqual(['codex']);
	expect(argv('goose')).toEqual(['goose']);
});

test('each agent gets its own arguments, environment and command override, whatever kingu.agent.cli names', () => {
	const s = {
		'kingu.agent.cli': 'claude --model opus',
		[agentArgsSetting('codex')]: '--full-auto',
		[agentArgsSetting('kiro')]: '--trust-all-tools',
		[agentEnvSetting('codex')]: { CODEX_HOME: '/tmp/c' },
		[agentEnvSetting('goose')]: { GOOSE_MODE: 'auto' },
		'kingu.agent.cmdOverrides': { cursor: '/opt/bin/cursor-agent', kiro: 'kiro-nightly' }
	};
	expect(argv('codex', s)).toEqual(['env', 'CODEX_HOME=/tmp/c', 'codex', '--full-auto']);
	expect(argv('goose', s)).toEqual(['env', 'GOOSE_MODE=auto', 'goose']);
	expect(argv('cursor-agent', s)).toEqual(['/opt/bin/cursor-agent']);
	// The launch arguments go right after the program; the user's follow them.
	expect(argv('kiro-cli', s)).toEqual(['kiro-nightly', 'chat', '--tui', '--trust-all-tools']);
	// The default CLI's own flags are not another agent's.
	expect(argv('gemini', s)).toEqual(['gemini']);
	// A whole command keeps its flags.
	expect(argv('claude --model opus', s)).toEqual(['claude', '--model', 'opus']);
});

test('yolo adds the bypass flags of the agent that starts, unless it has arguments of its own', () => {
	const yolo = { 'kingu.agent.cliPermissions': 'yolo', [agentArgsSetting('codex')]: '--full-auto' };
	expect(argv('gemini', yolo)).toEqual(['gemini', '--yolo']);
	expect(argv('kiro-cli', yolo)).toEqual(['kiro-cli', 'chat', '--tui', '--trust-all-tools']);
	expect(argv('codex', yolo)).toEqual(['codex', '--full-auto']);
	expect(argv('claude', yolo)).toEqual(['claude', '--dangerously-skip-permissions']);
});

test('claude agent teams and a prompt go in the way a task gets them', () => {
	expect(argv('claude', { 'kingu.agent.claudeAgentTeams': 'in-process' })).toEqual(['env', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1', 'claude', '--teammate-mode', 'in-process']);
	expect(argv('claude', {}, 'review the diff')).toEqual(['env', 'DISABLE_AUTOUPDATER=1', 'claude', '--', 'review the diff']);
	expect(argv('gemini', { [agentArgsSetting('gemini')]: '--model pro' }, 'fix it')).toEqual(['gemini', '--model', 'pro', '--prompt-interactive', 'fix it']);
	expect(argv('hermes', {}, 'fix it')).toEqual(['hermes', 'chat', '--query=fix it', '--tui']);
	expect(argv('grok', {}, '--help')).toEqual(['env', 'GROK_DISABLE_AUTOUPDATER=1', 'grok', '--', '--help']);
	// A CLI that takes no prompt at launch says so; its argv is still the fresh launch.
	expect(paneAgentLaunch('kiro-cli', from({}), 'fix it')).toEqual({ argv: ['kiro-cli', 'chat', '--tui'], launch: { agent: 'kiro', argv: ['kiro-cli', 'chat', '--tui'] }, needsSession: true });
	expect(paneAgentLaunch('claude', from({}), 'x')).toEqual({ argv: ['env', 'DISABLE_AUTOUPDATER=1', 'claude', '--', 'x'], launch: { agent: 'claude', argv: ['claude'] } });
});

test('the tab keeps the launch without its prompt, for a hibernated agent to resume with', () => {
	const yolo = from({ 'kingu.agent.cliPermissions': 'yolo', [agentEnvSetting('claude')]: { FOO: '1' } });
	const launch = paneAgentLaunch('claude', yolo, 'review the diff');
	expect('launch' in launch && launch.launch).toEqual({ agent: 'claude', argv: ['env', 'FOO=1', 'claude', '--dangerously-skip-permissions'] });
	expect('argv' in launch && launch.argv.at(-1)).toBe('review the diff');
});

test('an unusable setting refuses the launch', () => {
	expect('error' in paneAgentLaunch('claude; rm -rf /', from({}))).toBe(true);
	expect('error' in paneAgentLaunch('codex', from({ [agentArgsSetting('codex')]: '$(whoami)' }))).toBe(true);
	expect('error' in paneAgentLaunch('codex', from({ 'kingu.agent.cmdOverrides': { codex: 'a b' } }))).toBe(true);
	expect('error' in paneAgentLaunch('codex', from({ [agentEnvSetting('codex')]: { 'BAD NAME': 'x' } }))).toBe(true);
});

test('every profile starts in a tab without files of a run', () => {
	for (const p of PROFILES) {
		const r = paneAgentLaunch(p.bins[0], from({}));
		expect('argv' in r && r.argv.length > 0 && !r.needsSession).toBe(true);
	}
});

// Every word a permission mode or the update-prompt suppression can add, to prove a launch has none.
const PERMISSION_WORDS = new Set([...Object.values(YOLO_ARGS), ...Object.values(AUTO_ARGS)].flat().filter((w) => w.startsWith('-')));
const PERMISSION_ENV = new Set(Object.values(YOLO_ENV).flatMap((e) => Object.keys(e)));
const UPDATE_WORDS = new Set([...Object.values(UPDATE_PROMPT_ARGS).flat(), ...Object.values(UPDATE_PROMPT_ENV).flatMap((e) => Object.entries(e).map(([k, v]) => `${k}=${v}`))]);
const envNames = (a: string[]) => (a[0] === 'env' ? a.slice(1).filter((w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)).map((w) => w.slice(0, w.indexOf('='))) : []);

test('by default no agent starts with a yolo or auto flag or environment, with or without a prompt', () => {
	for (const p of PROFILES) {
		// `manual` written out, an unknown value and no value at all are the same: nothing added.
		for (const s of [{}, { 'kingu.agent.cliPermissions': 'manual' }, { 'kingu.agent.cliPermissions': 'YOLO' }, { 'kingu.agent.cliPermissions': true }]) {
			for (const prompt of [undefined, 'fix it']) {
				const r = paneAgentLaunch(p.bins[0], from(s), prompt);
				if ('error' in r) throw new Error(r.error);
				// The prompt is one word of its own; a profile's launch arguments (`droid`'s none, kiro's `chat --tui`) are not permission flags.
				const words = r.argv.filter((w) => w !== prompt);
				expect([p.id, words.filter((w) => PERMISSION_WORDS.has(w))]).toEqual([p.id, []]);
				expect([p.id, envNames(r.argv).filter((n) => PERMISSION_ENV.has(n))]).toEqual([p.id, []]);
			}
		}
	}
});

test('auto adds its flags for claude, codex and cursor only; every other agent keeps asking', () => {
	const auto = { 'kingu.agent.cliPermissions': 'auto' };
	expect(argv('claude', auto)).toEqual(['claude', '--permission-mode', 'auto']);
	expect(argv('codex', auto)).toEqual(['codex', '--approve-for-me']);
	expect(argv('cursor-agent', auto)).toEqual(['cursor-agent', '--auto-review']);
	for (const p of PROFILES.filter((p) => !(p.id in AUTO_ARGS))) expect([p.id, argv(p.bins[0], auto)]).toEqual([p.id, argv(p.bins[0])]);
	// Arguments of your own win, as under yolo; a command that already sets a permission gets none.
	expect(argv('codex', { ...auto, [agentArgsSetting('codex')]: '--search' })).toEqual(['codex', '--search']);
	expect(argv('claude --permission-mode plan', auto)).toEqual(['claude', '--permission-mode', 'plan']);
	expect(argv('cursor-agent -f', auto)).toEqual(['cursor-agent', '-f']);
});

test("yolo gives Goose its environment (Orca's YOLO_TUI_AGENT_ENV), never over a GOOSE_MODE of yours", () => {
	const yolo = { 'kingu.agent.cliPermissions': 'yolo' };
	expect(argv('goose', yolo)).toEqual(['env', 'GOOSE_MODE=auto', 'goose']);
	expect(argv('goose', { ...yolo, [agentEnvSetting('goose')]: { GOOSE_MODE: 'approve', X: '1' } })).toEqual(['env', 'GOOSE_MODE=approve', 'X=1', 'goose']);
	expect(argv('goose', { 'kingu.agent.cliPermissions': 'auto' })).toEqual(['goose']);
	// No other agent gets an environment from the mode.
	for (const p of PROFILES.filter((p) => p.id !== 'goose')) expect([p.id, envNames(argv(p.bins[0], yolo)).filter((n) => PERMISSION_ENV.has(n))]).toEqual([p.id, []]);
});

test('yolo adds no second permission option to a command that sets one', () => {
	const yolo = { 'kingu.agent.cliPermissions': 'yolo' };
	expect(argv('claude --permission-mode plan', yolo)).toEqual(['claude', '--permission-mode', 'plan']);
	expect(argv('codex --full-auto', yolo)).toEqual(['codex', '--full-auto']);
	expect(argv('codex -c approval_policy=never', yolo)).toEqual(['codex', '-c', 'approval_policy=never']);
	expect(argv('codex -c model=o3', yolo)).toEqual(['codex', '-c', 'model=o3', '--dangerously-bypass-approvals-and-sandbox']);
	expect(argv('kimi --yolo', yolo)).toEqual(['kimi', '--yolo']);
	expect(argv('gemini --approval-mode=plan', yolo)).toEqual(['gemini', '--approval-mode=plan']);
	expect(argv('claude --model opus', yolo)).toEqual(['claude', '--model', 'opus', '--dangerously-skip-permissions']);
});

test('claude: a variadic flag in its args does not take the prompt; a wrapper override gets no `--` (Orca 907b43c04)', () => {
	const env = ['env', 'DISABLE_AUTOUPDATER=1'];
	expect(argv('claude', { [agentArgsSetting('claude')]: '--disallowedTools Agent' }, 'fix it')).toEqual([...env, 'claude', '--disallowedTools', 'Agent', '--', 'fix it']);
	// Options already ended: a second `--` would be the prompt.
	expect(argv('claude', { [agentArgsSetting('claude')]: '--model opus --' }, 'fix it')).toEqual([...env, 'claude', '--model', 'opus', '--', 'fix it']);
	expect(argv('claude', { 'kingu.agent.cmdOverrides': { claude: 'happy' } }, 'fix it')).toEqual([...env, 'happy', 'fix it']);
	expect(argv('claude', { 'kingu.agent.cmdOverrides': { claude: '/opt/bin/claude' } }, 'fix it')).toEqual([...env, '/opt/bin/claude', '--', 'fix it']);
});

test("a launch with a prompt keeps the CLI's update prompt away; a bare start does not", () => {
	expect(argv('codex', {}, 'fix it')).toEqual(['codex', '-c', 'check_for_update_on_startup=false', 'fix it']);
	expect(argv('cursor-agent', {}, 'fix it')).toEqual(['cursor-agent', '--disable-auto-update', 'fix it']);
	expect(argv('aider', { [agentArgsSetting('aider')]: '--check-update' }, 'fix it')).toEqual(['aider', '--check-update', '--no-check-update', '--no-show-release-notes']);
	expect(argv('opencode', {}, 'fix it')).toEqual(['env', 'OPENCODE_DISABLE_AUTOUPDATE=true', 'opencode', '--prompt', 'fix it']);
	expect(argv('kimi', {}, 'fix it')).toEqual(['env', 'KIMI_CODE_NO_AUTO_UPDATE=1', 'KIMI_CLI_NO_AUTO_UPDATE=1', 'kimi']);
	expect(argv('pi', {}, 'fix it')).toEqual(['env', 'PI_SKIP_VERSION_CHECK=1', 'pi', 'fix it']);
	// Already there, or set by you: not added again, and yours wins.
	expect(argv('codex', { [agentArgsSetting('codex')]: '-c check_for_update_on_startup=true' }, 'x')).toEqual(['codex', '-c', 'check_for_update_on_startup=true', 'x']);
	expect(argv('claude', { [agentEnvSetting('claude')]: { DISABLE_AUTOUPDATER: '0' } }, 'x')).toEqual(['env', 'DISABLE_AUTOUPDATER=0', 'claude', '--', 'x']);
	// No prompt: the CLI starts as it always did.
	for (const p of PROFILES) expect([p.id, argv(p.bins[0]).filter((w) => UPDATE_WORDS.has(w))]).toEqual([p.id, []]);
});

test('an agent tab asks for its folder to be trusted: the task worktree, else the open folder; not on an SSH host or when turned off', () => {
	const on = { enabled: undefined, remote: false };
	expect(paneTrustRequest('fix-bug', ['env', 'A=1', '/opt/bin/codex', 'x'], on)).toEqual({ slug: 'fix-bug', program: 'codex' });
	expect(paneTrustRequest('', ['claude'], on)).toEqual({ slug: null, program: 'claude' });
	expect(paneTrustRequest('', ['claude'], { enabled: false, remote: false })).toBeNull();
	expect(paneTrustRequest('fix-bug', ['claude'], { enabled: true, remote: true })).toBeNull();
	expect(paneTrustRequest('', [], on)).toBeNull();
});
