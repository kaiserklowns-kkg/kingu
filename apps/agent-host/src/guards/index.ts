// Kingu's safety guards (old Kingu's Arkai guards): a PreToolUse hook, so they hold in every
// permission mode (canUseTool is skipped for what acceptEdits or the user's allow rules let
// through). A catastrophic Bash command (security.ts) and the third identical tool call in a row
// (repetition.ts) are denied; the model gets the reason as the tool's error, and the app a
// `guard_blocked` event so the chat says "Blocked by Kingu safety check".

import type { HookCallbackMatcher, HookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '../protocol.ts';
import { RepetitionTracker, REPETITION_REASON } from './repetition.ts';
import { blockingThreats, blockReason, threatSummary } from './security.ts';

export type GuardBlocked = Extract<AgentEvent, { kind: 'guard_blocked' }>;

/** Shell tools whose `command` input is scanned. */
const SHELL_TOOLS = new Set(['Bash']);

export type Verdict = { allow: true } | { allow: false; reason: string; event: Omit<GuardBlocked, 'kind' | 'tool_use_id'> };

/** One run's guards: the repetition count lives here and starts over with each user message. */
export class Guards {
	readonly repetition = new RepetitionTracker();

	/** Whether the call may run; when not, what the model and the app are told. */
	check(tool: string, input: unknown): Verdict {
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

	/** A new user message: the repetition count starts over. */
	reset() {
		this.repetition.reset();
	}

	/** The SDK `PreToolUse` hook matcher (every tool). */
	hook(emit: (ev: GuardBlocked) => void, log: (line: string) => void = () => {}): HookCallbackMatcher {
		return {
			hooks: [
				async (input: HookInput, toolUseID): Promise<SyncHookJSONOutput> => {
					if (input.hook_event_name !== 'PreToolUse') return {};
					const verdict = this.check(input.tool_name, input.tool_input);
					if (verdict.allow) return {};
					// The check's name only: the command itself is never logged.
					log(`safety check blocked ${input.tool_name} (${verdict.event.check}${verdict.event.threats.length ? `: ${verdict.event.threats.join(', ')}` : ''})`);
					emit({ kind: 'guard_blocked', tool_use_id: toolUseID ?? input.tool_use_id ?? null, ...verdict.event });
					return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.reason } };
				}
			]
		};
	}
}
