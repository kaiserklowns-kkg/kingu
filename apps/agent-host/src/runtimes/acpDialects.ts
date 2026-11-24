// What differs between ACP agents beyond the protocol (Orca's per-agent dialects,
// src/main/acp/acp-dialects/*, and `permissionModeConfig` of its launch specs,
// src/main/<agent>/*-acp-launch-spec.ts). Only what changes whether a chat is correct:
//
// - Agent-enforced permission modes: Droid, Kimi, Hermes, Qwen Code and goose decide themselves
//   when to ask, by a session mode of their own with their own ids. Kingu's permission mode has to
//   be written to that mode, or "Ask" would run on whatever the agent's config says (a goose
//   configured `auto` never asks) and "Allow all" would be Kimi's ask-when-needed `yolo`.
// - Commands that would work behind the chat's back: empty the agent's session under the chat's
//   transcript, or switch the agent to approving everything itself.
// - Requests that look like a permission but are a question to the person (Hermes).
// - Agent-specific requests that need an answer for the turn to go on.
// - How the agent says "sign in first" when it does not use ACP's own error, and how the chat
//   signs it in (acpSignIn.ts): Antigravity's ACP server through ACP `authenticate`; `agy acp`,
//   Qwen Code and Cursor (`cursor-agent login`) through their own login in a terminal.
// - What a session must be opened with (Antigravity's server: `_meta` that keeps its workflow
//   tool from writing into the chat's folder).
// - Antigravity's server signs in with the account type the user chose (a Google sign-in, a Gemini
//   API key or Google Agent Platform's ADC): Rust names it in `KINGU_ANTIGRAVITY_AUTH_METHOD` of
//   the launch (agent/antigravity_auth.rs), and Sign in sends that method.
// - Replies that are wholly the agent's own failure notice (a rejected Gemini API key, no usable
//   gcloud credentials, an expired token) fail the turn instead of being its answer (Orca
//   `acpReplyNoticeFailure` with Antigravity's `TURN_FAILURE_NOTICE`).
//
// Not ported: tool output shapes (exit codes), sub-agents and background tasks, question forms
// (elicitation), `/compact`, model catalogs. Pure; the agent is known by its program name.

import type { PermissionMode } from '../protocol.ts';
import type { SignInVia } from './acpSignIn.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The agent's own session mode values for Orca's modes (`permissionModeConfig.values`). */
export type AgentModes = { ask: string; acceptEdits?: string; auto?: string; fullAccess?: string };

export type AcpDialect = {
	modes?: AgentModes;
	/** Commands left out of the composer's list and refused as a prompt. */
	withheld?: readonly string[];
	/** A permission request only the person answers, whatever the chat's mode (by its tool call id). */
	userOnly?(toolCallId: string): boolean;
	/** The reply to one of the agent's own requests; undefined: not one of them. */
	settle?(method: string): unknown;
	/** The error means "not signed in / not configured". */
	authRequired?(code: number, data: unknown): boolean;
	/** How the chat signs the agent in when it says so; without: "sign in in a terminal" and the run ends. */
	signIn?: SignInVia;
	/** The agent's name in the chat's sign-in card. */
	label?: string;
	/** `_meta` for `session/new`, `session/load` and `session/resume` (Orca's `sessionMeta`). */
	sessionMeta?: Record<string, unknown>;
	/** A reply chunk that is wholly this is the agent's failure notice: the turn fails with it. */
	failureNotice?: RegExp;
};

/** Rust agent/antigravity_auth.rs `AUTH_METHOD_ENV`. */
export const AUTH_METHOD_ENV = 'KINGU_ANTIGRAVITY_AUTH_METHOD';
/** The account types Antigravity's server signs in with (Orca `AntigravityChatAuthConfig.method`). */
export const ANTIGRAVITY_AUTH_METHODS = ['oauth-personal', 'gemini-api-key', 'agent-platform'] as const;

// Orca `TURN_FAILURE_NOTICE` (antigravity-dialect.ts): agy's expired-token and executor-error lines,
// a rejected key, the server's Gemini client that could not be made (no ADC), a lost agent.
const ANTIGRAVITY_FAILURE_NOTICE =
	/^\s*(?:\u26a0 (?:UNAUTHENTICATED \(code 401\)|agent executor error): [^\n]*|API key not valid\. Please pass a valid API key\.|Agent execution error: failed to create Gemini client: [^\n]*|Agent connection was lost and could not be re-established: Failed to rebuild agent: [\s\S]*)\s*$/u;

// Antigravity's ACP server (Orca `ANTIGRAVITY_MANAGED_LAUNCH_SPEC`): Kingu runs and signs it in.
const ANTIGRAVITY_SERVER: AcpDialect = {
	label: 'Antigravity',
	modes: { ask: 'default', acceptEdits: 'auto_edit', fullAccess: 'yolo' },
	// Logout would clear the account every Antigravity chat on this computer shares.
	withheld: ['logout'],
	signIn: { via: 'browser', method: 'oauth-personal' },
	// The server otherwise writes its workflow tool into every chat's folder.
	sessionMeta: { antigravity: { disabledTools: ['run_workflow'] } },
	failureNotice: ANTIGRAVITY_FAILURE_NOTICE
};

// Pi's prompt failure when the model has no key (OMP, and Auggie built on Pi).
const noApiKey = (code: number, data: unknown) => code === -32603 && isObj(data) && typeof data.details === 'string' && data.details.startsWith('No API key found for ');
// goose's own refusals when no provider, model or key is configured.
const GOOSE_NOT_CONFIGURED = /^(?:Failed to resolve provider and model|Error getting agent reply): Configuration value not found: /u;

const DIALECTS: Readonly<Record<string, AcpDialect>> = {
	droid: { modes: { ask: 'normal', auto: 'auto-medium', fullAccess: 'auto-high' } },
	// Kimi Code's `yolo` is "ask when needed"; `auto` never asks.
	kimi: { modes: { ask: 'default', auto: 'yolo', fullAccess: 'auto' } },
	hermes: {
		modes: { ask: 'ask', acceptEdits: 'workspace_session', fullAccess: 'session' },
		// /reset would empty the session under the chat's transcript.
		withheld: ['reset'],
		// Questions and model-switch confirmations arrive as permission requests.
		userOnly: (id) => /^(?:clarify|model-confirm)-/u.test(id)
	},
	qwen: {
		label: 'Qwen Code',
		// Qwen has no login command: `/auth` in its own CLI connects a provider (Orca's `loginCommand`).
		signIn: { via: 'terminal', login: ['qwen'] },
		modes: { ask: 'default', acceptEdits: 'auto-edit', auto: 'auto', fullAccess: 'yolo' },
		withheld: ['clear', 'reset', 'new'],
		// After each tool Qwen asks for prompts queued mid-turn (Kingu queues follow-ups itself); a
		// finished background task asks to start the turn that reports it.
		settle: (method) => (method === 'craft/drainMidTurnQueue' ? { messages: [], hasQueuedPrompt: false } : method === '_qwencode/start_turn' ? { accepted: true } : undefined)
	},
	goose: {
		modes: { ask: 'approve', auto: 'smart_approve', fullAccess: 'auto' },
		withheld: ['clear'],
		authRequired: (code, data) => code === -32603 && typeof data === 'string' && GOOSE_NOT_CONFIGURED.test(data)
	},
	// These switch Copilot to approving everything itself, behind the chat's permission mode.
	copilot: { withheld: ['allow-all', 'permissions', 'autopilot'] },
	gemini: { authRequired: (code) => code === 401 },
	// The host's `agy acp` keeps agy's own sign-in (Orca `ANTIGRAVITY_HOST_LAUNCH_SPEC`): agy has no
	// full-access mode, so Kingu answers its prompts under Allow all.
	agy: {
		label: 'Antigravity',
		modes: { ask: 'default', acceptEdits: 'accept-edits', fullAccess: 'default' },
		withheld: ['logout'],
		// Its updater would replace agy under the chat (Orca's `loginEnv`).
		signIn: { via: 'terminal', login: process.platform === 'win32' ? ['agy'] : ['env', 'AGY_CLI_DISABLE_AUTO_UPDATE=true', 'agy'] },
		failureNotice: ANTIGRAVITY_FAILURE_NOTICE
	},
	'agy_acp_server.par': ANTIGRAVITY_SERVER,
	agy_acp_server: ANTIGRAVITY_SERVER,
	omp: { authRequired: noApiKey },
	auggie: { authRequired: noApiKey },
	'cursor-agent': {
		label: 'Cursor',
		// Orca `agentSessionSetupFor('cursor').loginCommand` (its launch spec offers no authMethod:
		// `authenticate` while signed out opens a browser and waits): `cursor-agent login` in a terminal.
		signIn: { via: 'terminal', login: ['cursor-agent', 'login'] },
		// Progress reports Cursor sends as requests and waits on.
		settle: (method) => (['cursor/update_todos', 'cursor/task', 'cursor/generate_image'].includes(method) ? {} : undefined)
	}
};

const GENERIC: AcpDialect = {};

/**
 * The dialect of the agent `command` runs (its program name, whatever folder or extension); a
 * custom agent: none. `env`: the launch's; Antigravity's server signs in with the method it names.
 */
export function acpDialect(command: string, env?: Record<string, string | undefined>): AcpDialect {
	const program = (command.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '');
	const dialect = Object.hasOwn(DIALECTS, program) ? DIALECTS[program]! : GENERIC;
	const method = env?.[AUTH_METHOD_ENV];
	if (dialect !== ANTIGRAVITY_SERVER || !method || !(ANTIGRAVITY_AUTH_METHODS as readonly string[]).includes(method)) return dialect;
	return { ...dialect, signIn: { via: 'browser', method } };
}

/**
 * The agent's own mode for Kingu's permission mode. Ask and the reviewer (Claude's only) are the
 * agent's ask mode; "Accept edits" the agent's, else ask (Kingu then allows the edits it is asked
 * about); "Allow all" its full access. `plan` has no agent-enforced equivalent: null, and the
 * caller looks for a mode the agent itself calls `plan`, else asks.
 */
export function enforcedMode(modes: AgentModes, mode: PermissionMode): string | null {
	switch (mode) {
		case 'plan':
			return null;
		case 'acceptEdits':
			return modes.acceptEdits ?? modes.ask;
		case 'bypassPermissions':
			return modes.fullAccess ?? modes.ask;
		default:
			return modes.ask;
	}
}

/**
 * The session's mode setting (ACP session config options, category `mode`; Orca matches the
 * category, not an id): its id, values and current value. Null when the agent has none.
 */
export function modeSetting(configOptions: unknown): { configId: string; values: string[]; current: string | null } | null {
	if (!Array.isArray(configOptions)) return null;
	for (const o of configOptions) {
		// ACP v1 names the field `id`, v2 `configId`.
		const configId = isObj(o) ? (typeof o.id === 'string' ? o.id : typeof o.configId === 'string' ? o.configId : null) : null;
		if (!isObj(o) || o.category !== 'mode' || !configId || !Array.isArray(o.options)) continue;
		// Options may be grouped (`{ group, options: [...] }`).
		const flat = o.options.flatMap((x) => (isObj(x) && Array.isArray(x.options) ? x.options : [x]));
		const values = flat.flatMap((x) => (isObj(x) && typeof x.value === 'string' ? [x.value] : []));
		return { configId, values, current: typeof o.currentValue === 'string' ? o.currentValue : null };
	}
	return null;
}

/** The command a prompt runs (`/clear now` → `clear`), when the dialect withholds it; else null. */
export function withheldCommand(d: AcpDialect, text: string): string | null {
	const name = /^\s*\/([^\s/]+)/.exec(text)?.[1]?.toLowerCase();
	return name && d.withheld?.includes(name) ? name : null;
}
