// Agents run the Orca way: a CLI (`claude`, `codex`, …) in a terminal of the task's worktree,
// started with the prompt as its last argument. The other way is our timeline (the agent host's
// SDK session). A CLI task stores `cli:<command>` as its agent. Pure, so `bun test` covers it.

export type RunMode = 'terminal' | 'timeline';
export const CLI_PREFIX = 'cli:';

/** A setting word: no spaces, quotes or shell syntax (Rust also quotes each argument). */
const WORD = /^[A-Za-z0-9._/=:@%+,-]+$/;

/** `kingu.agent.cli` ("claude", "codex --full-auto", …) as argv, or null when it is not a plain command. */
export function parseCliCommand(command: string): string[] | null {
	const argv = command.trim().split(/\s+/).filter(Boolean);
	return argv.length && argv.every((a) => WORD.test(a)) ? argv : null;
}

export const isCliAgent = (agent: string) => agent.startsWith(CLI_PREFIX);
export const cliAgent = (argv: string[]) => CLI_PREFIX + argv.join(' ');
/** The argv saved in a task's `agent`, or null for a timeline task. */
export const cliOf = (agent: string) => (isCliAgent(agent) ? parseCliCommand(agent.slice(CLI_PREFIX.length)) : null);

/** Start: the command with the prompt as one last argument (a multi-line prompt stays one argument). */
export const cliStart = (argv: string[], prompt: string) => [...argv, prompt];

const programOf = (argv: string[]) => argv[0].split('/').pop() ?? argv[0];

/** Continue the latest session in that worktree, for the CLIs that can; null when it cannot. */
export function cliResume(argv: string[]): string[] | null {
	const program = programOf(argv);
	if (program === 'claude') return [...argv, '--continue'];
	if (program === 'codex') return [...argv, 'resume', '--last'];
	return null;
}

/** "claude" / "codex" for labels. */
export const cliName = (argv: string[]) => programOf(argv);

/** Output in the last 2.5s means the agent is working (Orca's spinner); otherwise it waits for you. */
export const WORKING_MS = 2500;
export const isWorking = (lastOutput: number | undefined, now: number) => lastOutput !== undefined && now - lastOutput < WORKING_MS;

export const isClaude = (argv: string[]) => programOf(argv) === 'claude';

/**
 * claude, started the way Kingu can follow it: a session id we choose (so a restart resumes exactly
 * this session with `--resume`) and `--settings` hooks that report its state. Both before the prompt.
 */
export function claudeStart(argv: string[], prompt: string, sessionId: string, settings: string | null): string[] {
	return [...argv, '--session-id', sessionId, ...(settings ? ['--settings', settings] : []), prompt];
}

/** Continue the task's own session when its id is known, else the latest one in the worktree. */
export function claudeResume(argv: string[], sessionId: string | null, settings: string | null): string[] {
	return [...argv, ...(sessionId ? ['--resume', sessionId] : ['--continue']), ...(settings ? ['--settings', settings] : [])];
}
