import { describe, expect, test } from 'bun:test';
import {
	autoResumeOnShow,
	confirmHibernation,
	DEFAULT_IDLE_MINUTES,
	emptyPaneSleep,
	hibernationCandidates,
	idleMs,
	PANE_RESUME_AGENTS,
	paneAgent,
	paneConnected,
	paneHibernationRow,
	paneHibernationSupported,
	paneLaunchOf,
	paneResumeArgv,
	paneResumeLine,
	paneSleepFailed,
	paneSlept,
	panesPruned,
	paneWakes,
	paneWoken,
	parseSleepingPanes,
	serializeSleepingPanes,
	shellWord,
	sleepingPaneOf,
	turnStart,
	validSessionId,
	type HibernationRow,
	type PaneFacts,
	type PaneSleepState,
	type ReturnedTask
} from './hibernation';
import { applyHook, initialHookState } from './agentHooks';

const MIN = 60_000;
const row = (id: string, over: Partial<HibernationRow> = {}): HibernationRow => ({
	id,
	phase: 'idle',
	waiting: false,
	ended: false,
	resumable: true,
	foreground: false,
	hookAt: 0,
	outputAt: 1,
	seenAt: undefined,
	...over
});

describe('agent hibernation', () => {
	test('idle time: the setting in minutes, else the default', () => {
		expect(idleMs(5)).toBe(5 * MIN);
		for (const bad of [undefined, 0, -3, NaN, 'x', 24 * 60 + 1]) expect(idleMs(bad)).toBe(DEFAULT_IDLE_MINUTES * MIN);
	});

	test('only a finished, resumable, unseen CLI idle for the whole time goes', () => {
		const now = 100 * MIN;
		const idle = 30 * MIN;
		const rows = [
			row('quiet', { outputAt: now - 31 * MIN }),
			row('recent-output', { outputAt: now - 5 * MIN }),
			row('just-seen', { outputAt: now - 60 * MIN, seenAt: now - 2 * MIN }),
			row('late-hook', { outputAt: now - 60 * MIN, hookAt: now - 10 * MIN }),
			row('working', { phase: 'working', outputAt: 1 }),
			row('no-hooks', { phase: undefined, outputAt: 1 }),
			row('asks', { waiting: true, outputAt: 1 }),
			row('gone', { ended: true, outputAt: 1 }),
			row('no-session', { resumable: false, outputAt: 1 }),
			row('on-screen', { foreground: true, outputAt: 1 }),
			row('never-seen', { outputAt: undefined, hookAt: undefined }),
			row('subagents', { busy: true, outputAt: 1 }),
			// A draft typed after the turn ended, or keys typed while it worked, would be lost.
			row('draft', { outputAt: 1, turnAt: 10 * MIN, inputAt: 50 * MIN }),
			row('typed-at-start', { outputAt: 1, turnAt: 10 * MIN, inputAt: 10 * MIN }),
			row('typed-unknown-turn', { outputAt: 1, inputAt: 5 }),
			// An answer typed while it waited was consumed: a working stretch followed it.
			row('z-answered', { outputAt: 1, turnAt: 20 * MIN, inputAt: 19 * MIN }),
			row('a-quiet', { outputAt: now - idle })
		];
		expect(hibernationCandidates(rows, now, idle)).toEqual(['a-quiet', 'quiet', 'z-answered']);
	});

	const asleep = (over: Partial<ReturnedTask> = {}): ReturnedTask => ({ hibernated: true, running: false, resumable: true, resuming: false, ...over });

	test('a hibernated task on screen continues its session, once per showing', () => {
		expect(autoResumeOnShow('task', null, asleep())).toBe(true);
		// Already tried since it came on screen (a failed launch waits for the next return), or nothing shown.
		expect(autoResumeOnShow('task', 'task', asleep())).toBe(false);
		expect(autoResumeOnShow(null, null, asleep())).toBe(false);
		expect(autoResumeOnShow('gone', null, null)).toBe(false);
	});

	test('after a restart a task still hibernated wakes when first shown (Orca: hidden-agent resume deferral)', () => {
		// The record is the task's own `hibernated_at`: no wake armed in memory is needed any more.
		expect(autoResumeOnShow('task', null, asleep({ hibernated: true }))).toBe(true);
	});

	test('never what is not asleep, cannot continue, or is starting or running already', () => {
		expect(autoResumeOnShow('task', null, asleep({ hibernated: false }))).toBe(false);
		expect(autoResumeOnShow('task', null, asleep({ resumable: false }))).toBe(false);
		expect(autoResumeOnShow('task', null, asleep({ running: true }))).toBe(false);
		expect(autoResumeOnShow('task', null, asleep({ resuming: true }))).toBe(false);
	});

	test('two looks: a candidate is closed only when the look before agreed, with nothing between', () => {
		const now = 100 * MIN;
		const idle = 30 * MIN;
		const quiet = row('cli', { outputAt: now - 40 * MIN, outputs: 7, session: 's1' });
		const first = confirmHibernation({}, [quiet], now, idle);
		expect(first.confirmed).toEqual([]);
		expect(Object.keys(first.state)).toEqual(['cli']);
		const second = confirmHibernation(first.state, [quiet], now + MIN, idle);
		expect(second.confirmed).toEqual(['cli']);
		// Output between the looks (even inside the 500ms throttle of `outputAt`), a key, a new turn or session starts it over.
		for (const changed of [{ outputs: 8 }, { inputAt: 1, turnAt: 2 }, { hookAt: now - 35 * MIN }, { turnAt: 5 }, { session: 's2' }]) {
			const r = confirmHibernation(first.state, [{ ...quiet, ...changed }], now + MIN, idle);
			expect(r.confirmed).toEqual([]);
		}
		// One that stopped qualifying leaves the state, so it must qualify twice again.
		expect(confirmHibernation(first.state, [{ ...quiet, phase: 'working' }], now + MIN, idle).state).toEqual({});
	});
});

const TAG = '0a1b2c3d';
const KEY = `ade:${TAG}:fix-login:t3`;
const SESSION = '5f0c1a52-3d7e-4b6f-9a55-2f1d8f6f0c11';
const NOW = 100 * MIN;
const IDLE = 30 * MIN;
const idleHook = { phase: 'idle', permission: false, question: false, hooks: true, sessionId: SESSION, at: NOW - 40 * MIN };
const pane = (over: Partial<PaneFacts> = {}): PaneFacts => ({ key: KEY, foreground: 'claude', hookAgent: 'claude', hook: idleHook, lastOutput: NOW - 40 * MIN, onScreen: false, ...over });
const goes = (p: PaneFacts) => hibernationCandidates([paneHibernationRow(p)], NOW, IDLE).length === 1;

describe('per-pane hibernation: which panes may go', () => {
	test('a finished, resumable agent in a hidden pane, idle for the whole time', () => {
		expect(goes(pane())).toBe(true);
		expect(goes(pane({ lastOutput: NOW - 5 * MIN }))).toBe(false);
		expect(goes(pane({ seenAt: NOW - 5 * MIN }))).toBe(false);
		expect(goes(pane({ hook: { ...idleHook, at: NOW - 5 * MIN } }))).toBe(false);
	});

	test('never an agent that is working or waiting on a permission or a question', () => {
		expect(goes(pane({ hook: { ...idleHook, phase: 'working' } }))).toBe(false);
		expect(goes(pane({ hook: { ...idleHook, phase: 'waiting' } }))).toBe(false);
		expect(goes(pane({ hook: { ...idleHook, permission: true } }))).toBe(false);
		expect(goes(pane({ hook: { ...idleHook, question: true } }))).toBe(false);
		expect(goes(pane({ hook: { ...idleHook, phase: 'starting' } }))).toBe(false);
		expect(goes(pane({ hook: { ...idleHook, subagents: { a1: 'Explore' } } }))).toBe(false);
		// The real hook stream: a permission prompt, then a question, never read as idle.
		let h = applyHook(initialHookState(1), { kingu_hook: 'claude', event: 'Stop', payload: { hook_event_name: 'Stop', session_id: SESSION } }, 1);
		expect(goes(pane({ hook: h, lastOutput: 1 }))).toBe(true);
		h = applyHook(h, { kingu_hook: 'claude', event: 'PermissionRequest', payload: { hook_event_name: 'PermissionRequest', session_id: SESSION, tool_name: 'Bash' } }, 2);
		expect(goes(pane({ hook: h, lastOutput: 1 }))).toBe(false);
	});

	test('a pane on screen stays, and so does one with keys typed since its turn began', () => {
		expect(goes(pane({ onScreen: true }))).toBe(false);
		expect(goes(pane({ turnAt: NOW - 50 * MIN, inputAt: NOW - 45 * MIN }))).toBe(false);
		expect(goes(pane({ turnAt: NOW - 50 * MIN, inputAt: NOW - 55 * MIN }))).toBe(true);
		// A CLI that only reports finished turns: keys before that turn's end were its prompt.
		const notify = { ...idleHook, hooks: undefined };
		expect(goes(pane({ foreground: 'codex', hookAgent: undefined, hook: notify, inputAt: notify.at - 1 }))).toBe(true);
		expect(goes(pane({ foreground: 'codex', hookAgent: undefined, hook: notify, inputAt: notify.at + 1 }))).toBe(false);
	});

	test('a pane without a known session id, a resume command or its agent in front is left running', () => {
		expect(goes(pane({ hook: { ...idleHook, sessionId: undefined } }))).toBe(false);
		expect(goes(pane({ hook: { ...idleHook, sessionId: '--dangerous' } }))).toBe(false);
		expect(goes(pane({ hook: undefined }))).toBe(false);
		// At the prompt, another program in front of a stale hook file, an unknown job.
		expect(goes(pane({ foreground: null }))).toBe(false);
		expect(goes(pane({ foreground: 'vim' }))).toBe(false);
		expect(goes(pane({ foreground: undefined }))).toBe(false);
		// The hooks name another agent than the one in front.
		expect(goes(pane({ foreground: 'gemini' }))).toBe(false);
		// CLIs without a resume command Kingu can build from the session id.
		for (const [foreground, hookAgent] of [['pi', 'pi'], ['cursor-agent', 'cursor'], ['goose', 'goose'], ['agy', 'antigravity']]) expect(goes(pane({ foreground, hookAgent }))).toBe(false);
	});

	test('the working stretch begins when the phase turns to working', () => {
		expect(turnStart(undefined, 'idle', 'working', 7)).toBe(7);
		expect(turnStart(3, 'waiting', 'working', 7)).toBe(7);
		expect(turnStart(3, 'working', 'working', 7)).toBe(3);
		expect(turnStart(3, 'working', 'idle', 7)).toBe(3);
	});
});

describe('per-pane hibernation: the resume command per CLI', () => {
	test("each CLI's own command, as session history builds it", () => {
		expect(paneResumeArgv('claude', SESSION)).toEqual(['claude', '--resume', SESSION]);
		expect(paneResumeArgv('codex', SESSION)).toEqual(['codex', 'resume', SESSION]);
		expect(paneResumeArgv('gemini', SESSION)).toEqual(['gemini', '--resume', SESSION]);
		expect(paneResumeArgv('opencode', 'ses_1')).toEqual(['opencode', '--session', 'ses_1']);
		expect(paneResumeArgv('opencode2', 'ses_1')).toEqual(['opencode2', '--standalone', '--session', 'ses_1']);
		expect(paneResumeArgv('copilot', SESSION)).toEqual(['copilot', `--resume=${SESSION}`]);
		expect(paneResumeArgv('droid', SESSION)).toEqual(['droid', '--resume', SESSION]);
		expect(paneResumeArgv('grok', SESSION)).toEqual(['grok', '--resume', SESSION]);
		expect(paneResumeArgv('devin', SESSION)).toEqual(['devin', '--resume', SESSION]);
		expect(paneResumeArgv('kiro', SESSION)).toEqual(['kiro-cli', 'chat', '--tui', '--resume-id', SESSION]);
		expect(paneResumeArgv('kimi', SESSION)).toEqual(['kimi', '--session', SESSION]);
		expect(paneResumeArgv('codebuddy', SESSION)).toEqual(['codebuddy', '--resume', SESSION]);
		expect(paneResumeArgv('qoder', SESSION)).toEqual(['qodercli', '--resume', SESSION]);
		expect(paneResumeArgv('hermes', SESSION)).toEqual(['hermes', '--resume', SESSION]);
		expect(paneResumeArgv('muse', SESSION)).toEqual(['muse', 'resume', SESSION]);
		expect(paneResumeArgv('zcode', SESSION)).toEqual(['zcode', '--resume', SESSION]);
		expect(paneResumeArgv('jcode', SESSION)).toEqual(['jcode', '--resume', SESSION]);
		expect(paneResumeArgv('omp', SESSION)).toEqual(['omp', '--resume', SESSION]);
		// Every listed CLI has one, and none falls back to another CLI's command.
		for (const agent of PANE_RESUME_AGENTS) expect(paneResumeArgv(agent, SESSION)?.[0]).not.toBe(agent === 'claude' ? '' : 'claude');
	});

	test('no command: an unknown CLI, one that cannot resume by id, a bad session id', () => {
		for (const agent of ['pi', 'prime-agent', 'cursor', 'antigravity', 'goose', 'kilo', 'custom', 'dsh', '', null, undefined]) expect(paneResumeArgv(agent, SESSION)).toBeNull();
		for (const id of ['', ' ', ' padded ', '-p', '--resume', 'a\nb', 'a\u0007b', 'x'.repeat(513), null, undefined]) expect(paneResumeArgv('claude', id)).toBeNull();
		expect(validSessionId('x'.repeat(512))).toBe(true);
		expect(validSessionId(7)).toBe(false);
	});

	test('the agent of a pane is the known CLI in front of its shell', () => {
		expect(paneAgent('claude', 'claude')).toBe('claude');
		expect(paneAgent('codex')).toBe('codex');
		expect(paneAgent('kiro-cli')).toBe('kiro');
		expect(paneAgent('claude', 'gemini')).toBeNull();
		expect(paneAgent('zsh')).toBeNull();
		expect(paneAgent(null, 'claude')).toBeNull();
	});
});

describe('per-pane hibernation: the platform', () => {
	test('Windows panes are skipped outright: no foreground job or folder is read there', () => {
		// procinfo.rs reads the job in front of a shell and its folder on macOS and Linux only, and
		// closing the job needs job control; without this a Windows pane would silently never qualify.
		for (const p of ['Win32', 'Win64', 'Windows', 'win32']) expect(paneHibernationSupported(p)).toBe(false);
		for (const p of ['MacIntel', 'Linux x86_64', 'Linux aarch64', undefined]) expect(paneHibernationSupported(p)).toBe(true);
	});
});

describe('per-pane hibernation: resuming with the launch', () => {
	test('the launch command with the resume arguments after it (Orca buildAgentResumeStartupPlan)', () => {
		const env = ['env', 'FOO=1', 'claude', '--dangerously-skip-permissions', '--model', 'opus'];
		expect(paneResumeArgv('claude', SESSION, env)).toEqual(['env', 'FOO=1', 'claude', '--dangerously-skip-permissions', '--model', 'opus', '--resume', SESSION]);
		expect(paneResumeArgv('gemini', SESSION, ['gemini', '--yolo'])).toEqual(['gemini', '--yolo', '--resume', SESSION]);
		// A launch command that carries its subcommand keeps it once (Kiro's `chat --tui`, OpenCode 2's `--standalone`).
		expect(paneResumeArgv('kiro', SESSION, ['kiro-cli', 'chat', '--tui', '--trust-all-tools'])).toEqual(['kiro-cli', 'chat', '--tui', '--trust-all-tools', '--resume-id', SESSION]);
		expect(paneResumeArgv('opencode2', 'ses_1', ['opencode2', '--standalone'])).toEqual(['opencode2', '--standalone', '--session', 'ses_1']);
		expect(paneResumeArgv('copilot', SESSION, ['copilot', '--yolo'])).toEqual(['copilot', '--yolo', `--resume=${SESSION}`]);
		// A command override is the program the launch ran.
		expect(paneResumeArgv('codex', 'thr_1', ['/opt/codex-wrapper', '--model', 'o3'])).toEqual(['/opt/codex-wrapper', '--model', 'o3', 'resume', 'thr_1']);
	});

	test("claude: stale session selectors go, the session goes before a `--` (Orca buildClaudeResumeLaunchCommand)", () => {
		expect(paneResumeArgv('claude', SESSION, ['claude', '--resume', 'old', '-c', '--continue=x', '-r=y', '--model', 'opus'])).toEqual(['claude', '--model', 'opus', '--resume', SESSION]);
		expect(paneResumeArgv('claude', SESSION, ['claude', '-r', '--verbose'])).toEqual(['claude', '--verbose', '--resume', SESSION]);
		expect(paneResumeArgv('claude', SESSION, ['claude', '--model', 'opus', '--', '-c'])).toEqual(['claude', '--model', 'opus', '--resume', SESSION, '--', '-c']);
	});

	test("codex: Kingu's permission flags are dropped, so the thread keeps its own (Orca dropRecordedAgentPermissionArgs)", () => {
		expect(paneResumeArgv('codex', 'thr_1', ['codex', '--dangerously-bypass-approvals-and-sandbox', '-m', 'o3'])).toEqual(['codex', '-m', 'o3', 'resume', 'thr_1']);
		expect(paneResumeArgv('codex', 'thr_1', ['codex', '--approve-for-me'])).toEqual(['codex', 'resume', 'thr_1']);
	});

	test("launch arguments a profile leaves out on resume stay out (agentProfiles launchArgs.resume: false)", () => {
		expect(paneResumeArgv('hermes', SESSION, ['hermes', '--tui'])).toEqual(['hermes', '--resume', SESSION]);
		expect(paneResumeArgv('muse', SESSION, ['muse', '--trust-workspace', '--yolo'])).toEqual(['muse', '--yolo', 'resume', SESSION]);
	});

	test("the tab's launch counts only while the pane's agent runs with it", () => {
		const launch = { agent: 'claude', argv: ['env', 'FOO=1', 'claude', '--dangerously-skip-permissions', '--model', 'opus'] };
		// The job's command line: as the OS reports it (a native binary, or node and its script).
		expect(paneLaunchOf('claude', launch, ['claude', '--dangerously-skip-permissions', '--model', 'opus', 'fix it'])).toEqual(launch.argv);
		expect(paneLaunchOf('claude', launch, ['node', '/usr/lib/claude/cli.js', '--dangerously-skip-permissions', '--model', 'opus'])).toEqual(launch.argv);
		// Typed again by hand without those arguments, another agent, or a command line that cannot be read: none.
		expect(paneLaunchOf('claude', launch, ['claude'])).toBeUndefined();
		expect(paneLaunchOf('claude', launch, ['claude', '--model', 'opus', '--dangerously-skip-permissions'])).toBeUndefined();
		expect(paneLaunchOf('codex', launch, ['codex'])).toBeUndefined();
		expect(paneLaunchOf('claude', launch, [])).toBeUndefined();
		expect(paneLaunchOf('claude', undefined, ['claude'])).toBeUndefined();
		// A launch with no arguments of its own (only env) is the agent's whatever it was typed with.
		expect(paneLaunchOf('claude', { agent: 'claude', argv: ['env', 'FOO=1', 'claude'] }, ['claude'])).toEqual(['env', 'FOO=1', 'claude']);
	});
});

describe('per-pane hibernation: the stored record', () => {
	const record = { agent: 'claude', sessionId: SESSION, at: 1_700_000_000_000 };
	const full = { ...record, cwd: '/repo/.kingu/worktrees/fix-login/web', here: true, launch: ['env', 'FOO=1', 'claude', '--model', 'opus'] };

	test('round trip', () => {
		const panes = { [KEY]: full, [`ade:${TAG}:fix-login:t9`]: { agent: 'codex', sessionId: 'thr_1', at: 5 } };
		const stored = JSON.parse(JSON.stringify(serializeSleepingPanes(panes)));
		expect(stored.v).toBe(2);
		expect(parseSleepingPanes(stored, TAG)).toEqual(panes);
	});

	test("the record is what the pane ran when it was closed: agent, session, the agent's folder and launch", () => {
		expect(sleepingPaneOf(pane(), 42)).toEqual({ agent: 'claude', sessionId: SESSION, at: 42 });
		expect(sleepingPaneOf(pane(), 42, { cwd: '/w/sub', here: false }, ['claude', '--model', 'opus'])).toEqual({ agent: 'claude', sessionId: SESSION, at: 42, cwd: '/w/sub', here: false, launch: ['claude', '--model', 'opus'] });
		// A folder that is not absolute, or one that could not be read, is left out.
		expect(sleepingPaneOf(pane(), 42, { cwd: 'sub', here: true })).toEqual({ agent: 'claude', sessionId: SESSION, at: 42 });
		expect(sleepingPaneOf(pane(), 42, { cwd: null, here: null })).toEqual({ agent: 'claude', sessionId: SESSION, at: 42 });
		expect(sleepingPaneOf(pane({ hook: { ...idleHook, sessionId: undefined } }), 42)).toBeNull();
		expect(sleepingPaneOf(pane({ foreground: 'vim' }), 42)).toBeNull();
	});

	test('anything unexpected reads as nothing, entry by entry; a bad folder or launch only drops itself', () => {
		for (const raw of [null, 3, 'x', [], {}, { v: 3, panes: { [KEY]: record } }, { v: 2 }, { v: 2, panes: [] }, { [KEY]: record }]) expect(parseSleepingPanes(raw, TAG)).toBeNull();
		const mixed = {
			v: 2,
			panes: {
				[KEY]: { ...record, extra: true },
				'ade:ffffffff:fix-login:t3': record, // another folder's
				[`ade:${TAG}::t3`]: record, // the folder's own terminal, not a task's
				[`cli:${TAG}:fix-login:5`]: record, // a task's own agent keeps its record on the task
				[`ade:${TAG}:fix-login:t4`]: { ...record, agent: 'pi' },
				[`ade:${TAG}:fix-login:t5`]: { ...record, sessionId: '-x' },
				[`ade:${TAG}:fix-login:t6`]: { ...record, at: 'yesterday' },
				[`ade:${TAG}:fix-login:t7`]: null,
				[`ade:${TAG}:fix-login:t8`]: { ...record, cwd: 'relative', here: true, launch: [] },
				[`ade:${TAG}:fix-login:t9`]: { ...record, cwd: '/ok\nno', launch: ['claude', 3] },
				[`ade:${TAG}:fix-login:t10`]: { ...record, cwd: '/ok', here: 'yes', launch: ['claude'] }
			}
		};
		expect(parseSleepingPanes(mixed, TAG)).toEqual({
			[KEY]: record,
			[`ade:${TAG}:fix-login:t8`]: record,
			[`ade:${TAG}:fix-login:t9`]: record,
			[`ade:${TAG}:fix-login:t10`]: { ...record, cwd: '/ok', launch: ['claude'] }
		});
	});

	test('migration from v1: each record stays as it was, resuming in the worktree with the plain command', () => {
		// v1 (the first per-pane build) kept agent, session and time, and closed only agents running in
		// the worktree's own folder. Its records read as v2 records without folder or launch.
		const v1 = { v: 1, panes: { [KEY]: record, [`ade:${TAG}:fix-login:t4`]: { ...record, agent: 'pi' } } };
		const migrated = parseSleepingPanes(v1, TAG);
		expect(migrated).toEqual({ [KEY]: record });
		// Fields only v2 writes are not read from a v1 store.
		expect(parseSleepingPanes({ v: 1, panes: { [KEY]: full } }, TAG)).toEqual({ [KEY]: record });
		// A v1 pane's shell was closed with its agent: a new shell (in the worktree) types the plain resume, no `cd`.
		const state: PaneSleepState = { panes: migrated!, live: [], waking: [] };
		expect(paneResumeLine(state, KEY, false)).toBe(`claude --resume ${SESSION}`);
		// Written back, it is a v2 store.
		expect(serializeSleepingPanes(migrated!).v).toBe(2);
		// A folder with no store at all (every build before per-pane hibernation) has nothing asleep.
		expect(parseSleepingPanes(undefined, TAG)).toBeNull();
	});
});

describe('per-pane hibernation: the resume line', () => {
	const at = (r: object): PaneSleepState => ({ panes: { [KEY]: { agent: 'claude', sessionId: SESSION, at: 1, ...r } }, live: [KEY], waking: [] });

	test("the shell it was closed in is in the agent's folder already; a new one cds there first", () => {
		const r = at({ cwd: '/w/fix login', here: true, launch: ['env', 'FOO=a b', 'claude', '--model', 'opus'] });
		expect(paneResumeLine(r, KEY, true)).toBe(`env 'FOO=a b' claude --model opus --resume ${SESSION}`);
		expect(paneResumeLine(r, KEY, false)).toBe(`cd '/w/fix login' && env 'FOO=a b' claude --model opus --resume ${SESSION}`);
		// The agent ran in another folder than its shell's (it was started with `cd x && claude`): cd there too.
		expect(paneResumeLine(at({ cwd: '/w/sub', here: false }), KEY, true)).toBe(`cd /w/sub && claude --resume ${SESSION}`);
		// Unknown folder: as it is.
		expect(paneResumeLine(at({}), KEY, false)).toBe(`claude --resume ${SESSION}`);
		expect(paneResumeLine(emptyPaneSleep, KEY, true)).toBeNull();
	});

	test('words are quoted for the shell as kingu-ptyd quotes a `run`', () => {
		expect(shellWord('--model')).toBe('--model');
		expect(shellWord("it's")).toBe(`'it'\\''s'`);
		expect(shellWord('$(rm -rf ~)')).toBe(`'$(rm -rf ~)'`);
		expect(shellWord('')).toBe(`''`);
	});
});

describe('per-pane hibernation: waking', () => {
	const record = { agent: 'claude', sessionId: SESSION, at: 1 };
	const slept = paneSlept(emptyPaneSleep, KEY, record);
	const none = new Set<string>();
	const here = new Set([KEY]);

	test("closing keeps the shell: the pane is asleep with a live shell that a wake types into", () => {
		expect(slept).toEqual({ panes: { [KEY]: record }, live: [KEY], waking: [] });
		expect(paneResumeLine(slept, KEY, true)).toBe(`claude --resume ${SESSION}`);
	});

	test('resumes once on return', () => {
		// Hidden: nothing. Shown: one wake, claimed.
		expect(paneWakes(slept, none, none).wake).toEqual([]);
		const first = paneWakes(slept, none, here);
		expect(first.wake).toEqual([KEY]);
		expect(first.state.waking).toEqual([KEY]);
		// Still on screen at the next look, or looked at again while it starts: no second start.
		expect(paneWakes(first.state, here, here).wake).toEqual([]);
		expect(paneWakes(first.state, none, here).wake).toEqual([]);
		// Typed: the record is used up, so later returns start nothing.
		const up = paneWoken(first.state, KEY, 'typed');
		expect(up).toEqual(emptyPaneSleep);
		expect(paneWakes(up, none, here).wake).toEqual([]);
	});

	test('a wake that could not type keeps the record for the next return; the agent started by hand ends the sleep', () => {
		const waking = paneWakes(slept, none, here).state;
		const failed = paneWoken(waking, KEY, 'failed');
		expect(failed.panes).toEqual({ [KEY]: record });
		expect(failed.waking).toEqual([]);
		expect(paneWakes(failed, here, here).wake).toEqual([]);
		expect(paneWakes(failed, none, here).wake).toEqual([KEY]);
		expect(paneWoken(waking, KEY, 'taken')).toEqual(emptyPaneSleep);
	});

	test('after a restart: a live shell found on attach is woken by typing, a new shell types the resume itself', () => {
		const restored: PaneSleepState = { panes: { [KEY]: record }, live: [], waking: [] };
		// Not live yet: nothing to type into.
		expect(paneWakes(restored, none, here).wake).toEqual([]);
		const attached = paneConnected(restored, KEY, 'attached');
		expect(attached.live).toEqual([KEY]);
		expect(attached.panes).toEqual({ [KEY]: record });
		expect(paneWakes(attached, none, here).wake).toEqual([KEY]);
		// The shell was gone: the terminal started one that typed the resume (its `type`), so the record is used up.
		expect(paneConnected(restored, KEY, 'spawned')).toEqual(emptyPaneSleep);
		// No shell could start: the record stays.
		expect(paneConnected(restored, KEY, 'failed').panes).toEqual({ [KEY]: record });
	});

	test('a claim ends when the pane leaves the screen without reporting', () => {
		const waking = paneWakes(slept, none, here).state;
		const left = paneWakes(waking, here, none).state;
		expect(left.waking).toEqual([]);
		expect(paneWakes(left, none, here).wake).toEqual([KEY]);
	});

	test('reports of panes that do not sleep change nothing', () => {
		expect(paneConnected(slept, 'ade:0a1b2c3d:fix-login:t8', 'failed')).toBe(slept);
		expect(paneConnected(emptyPaneSleep, KEY, 'spawned')).toBe(emptyPaneSleep);
		expect(paneConnected(slept, KEY, 'attached')).toBe(slept);
		expect(paneWoken(emptyPaneSleep, KEY, 'typed')).toBe(emptyPaneSleep);
	});

	test('a failed close rolls the record back; a closed pane takes its record along', () => {
		expect(paneSleepFailed(slept, KEY)).toEqual(emptyPaneSleep);
		expect(panesPruned(slept, here)).toBe(slept);
		expect(panesPruned(slept, none)).toEqual(emptyPaneSleep);
	});
});
