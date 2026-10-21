// Kingu's safety guards (old Kingu's Arkai guards): a PreToolUse hook, so they hold in every
// permission mode (canUseTool is skipped for what acceptEdits or the user's allow rules let
// through). A catastrophic Bash command (security.ts) and the third identical tool call in a row
// (repetition.ts) are denied; the model gets the reason as the tool's error, and the app a
// `guard_blocked` event so the chat says "Blocked by Kingu safety check".
// The "always ask" checks (asks.ts: writes outside the run's folder, deletes, protected paths, MCP
// tools) ask the user from the hook itself, so no mode or allow rule skips them: the app gets a
// `guard_asked` event (why), then an ordinary `permission_request` the user answers.

import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { HookCallbackMatcher, HookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '../protocol.ts';
import { askDeniedReason, askFor, parseEditRules, parsePatterns, type Ask, type AskConfig, type EditRule, type Rule } from './asks.ts';
import { RepetitionTracker, REPETITION_REASON } from './repetition.ts';
import { blockingThreats, blockReason, threatSummary } from './security.ts';

export type GuardBlocked = Extract<AgentEvent, { kind: 'guard_blocked' }>;

/** How long (seconds) the hook may wait for the user's answer to a safety ask: a day. */
export const ASK_TIMEOUT_S = 24 * 60 * 60;

/** Shell tools whose `command` input is scanned. */
const SHELL_TOOLS = new Set(['Bash']);

export type Verdict = { allow: true } | { allow: false; reason: string; event: Omit<GuardBlocked, 'kind' | 'tool_use_id'> };

/**
 * Asks the user about a call (an ordinary permission prompt the app answers): true when allowed,
 * else the user's message (or null). The host owns the prompt; the hook only waits.
 */
export type AskUser = (call: { tool: string; input: unknown; toolUseId: string | null; ask: Ask; signal?: AbortSignal }) => Promise<true | { message: string | null }>;

/** The existing part of `path` with symlinks resolved, the rest appended (a new file's folder counts). */
export function realpathExisting(path: string): string {
	const rest: string[] = [];
	let cur = path;
	for (let i = 0; i < 64; i++) {
		try {
			return join(realpathSync(cur), ...rest.reverse());
		} catch {
			const up = dirname(cur);
			if (up === cur) return path;
			rest.push(basename(cur));
			cur = up;
		}
	}
	return path;
}

/** One run's guards: the repetition count lives here and starts over with each user message. */
export class Guards {
	readonly repetition = new RepetitionTracker();
	readonly #rules: Rule[];
	readonly #editRules: EditRule[];

	/**
	 * `blocks`: the security and repetition checks (`safetyChecks`); `asks`: the always-ask checks
	 * of a run in `cwd`; `mode`: the run's permission mode now (Allow all skips the edit rules).
	 */
	constructor(
		readonly blocks = true,
		readonly asks: (AskConfig & { cwd: string }) | null = null,
		readonly mode: () => string = () => 'default'
	) {
		this.#rules = parsePatterns(asks?.protectedPaths ?? []);
		this.#editRules = parseEditRules(asks?.editRules ?? []);
	}

	/** Whether the call may run; when not, what the model and the app are told. */
	check(tool: string, input: unknown): Verdict {
		if (!this.blocks) return { allow: true };
		const command = SHELL_TOOLS.has(tool) && input && typeof input === 'object' ? (input as Record<string, unknown>).command : undefined;
		if (typeof command === 'string') {
			const threats = blockingThreats(command);
			if (threats.length) {
				const names = [...new Set(threats.map((m) => m.threat.name))];
				return { allow: false, reason: blockReason(threats), event: { tool, check: 'security', threats: names, detail: threatSummary(threats) } };
			}
		}
		if (!this.repetition.check(tool, input)) {
			return { allow: false, reason: REPETITION_REASON, event: { tool, check: 'repetition', threats: [], detail: '' } };
		}
		return { allow: true };
	}

	/** Why the user must be asked before the call runs, or null. */
	askFor(tool: string, input: unknown, realpath: (p: string) => string = realpathExisting): Ask | null {
		if (!this.asks) return null;
		return askFor(tool, input, this.asks.cwd, this.asks, this.#rules, realpath, { rules: this.#editRules, allowAll: this.mode() === 'bypassPermissions' });
	}

	/** A new user message: the repetition count starts over. */
	reset() {
		this.repetition.reset();
	}

	/** The SDK `PreToolUse` hook matcher (every tool). Without `askUser`, the asks are off. */
	hook(emit: (ev: AgentEvent) => void, log: (line: string) => void = () => {}, askUser?: AskUser): HookCallbackMatcher {
		return {
			// A safety ask waits for the user: a hook that timed out would let the call run unasked.
			...(askUser && this.asks ? { timeout: ASK_TIMEOUT_S } : {}),
			hooks: [
				async (input: HookInput, toolUseID, opts): Promise<SyncHookJSONOutput> => {
					if (input.hook_event_name !== 'PreToolUse') return {};
					const id = toolUseID ?? input.tool_use_id ?? null;
					const verdict = this.check(input.tool_name, input.tool_input);
					if (!verdict.allow) {
						// The check's name only: the command itself is never logged.
						log(`safety check blocked ${input.tool_name} (${verdict.event.check}${verdict.event.threats.length ? `: ${verdict.event.threats.join(', ')}` : ''})`);
						emit({ kind: 'guard_blocked', tool_use_id: id, ...verdict.event });
						return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.reason } };
					}
					const ask = askUser ? this.askFor(input.tool_name, input.tool_input) : null;
					if (!ask || !askUser) return {};
					log(`safety check asks about ${input.tool_name} (${ask.check})`);
					const answer = await askUser({ tool: input.tool_name, input: input.tool_input, toolUseId: id, ask, signal: opts?.signal });
					if (answer === true) return {};
					return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: askDeniedReason(ask, answer.message) } };
				}
			]
		};
	}
}
