// Agents run the Orca way: a CLI (`claude`, `codex`, …) in a terminal of the task's worktree,
// started with the prompt as its last argument. The other way is our timeline (the agent host's
// SDK session). A CLI task stores `cli:<command>` as its agent. Per-CLI behaviour (resume, MCP,
// status) lives in agentProfiles.ts. Pure, so `bun test` covers it.

import { programOf } from '#lib/ade/agentProfiles.ts';

export { claudeResume, claudeStart, cliResume } from '#lib/ade/agentProfiles.ts';

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

/** "claude" / "codex" for labels. */
export const cliName = (argv: string[]) => programOf(argv);

/** Output in the last 2.5s means the agent is working (Orca's spinner); otherwise it waits for you. */
export const WORKING_MS = 2500;
export const isWorking = (lastOutput: number | undefined, now: number) => lastOutput !== undefined && now - lastOutput < WORKING_MS;
