// The launch spec (docs/AI-SURFACES.md §8.2): what the settings say a new run starts with, for
// either surface, in one shape. It only reads what the production paths already read and builds
// the same values (ADE: agentCommand + launchOptions in tasks.svelte.ts; chat: chats.defaults(),
// AgentPanel's start runtime and runEffort); launchSpec.test.ts holds it to them. The launch
// paths read it (Phase 4): tasks.svelte.ts, chats.svelte.ts defaults(), AgentPanel. Pure.

import { agentCommand, launchOptions, withLaunchOptions } from '#lib/ade/agentCli.ts';
import { profileOf } from '#lib/ade/agentProfiles.ts';
import { PERMISSION_MODES, type PermissionMode } from './chats.ts';
import { effortDefaults, type Effort } from './effort.ts';
import { CLAUDE_RUNTIME } from './runtimes.ts';
import type { Surface } from './agentCatalog.ts';

export type Get = (id: string) => unknown;

export type AdeLaunchSpec = {
	surface: 'ade';
	/** The CLI profile id (`custom` for a command no profile knows). */
	agentId: string;
	/** `kingu.agent.cli` with `kingu.agent.args.<id>` / the yolo flags: the base argv a profile launches. */
	argv: string[];
	/** `kingu.agent.cmdOverrides[<id>]`: the binary that replaces the program word. */
	program?: string;
	/** `kingu.agent.env.<id>` as `NAME=value` words. */
	env: string[];
	/** `kingu.agent.claudeAgentTeams` = `in-process` (claude only). */
	claudeTeams: boolean;
	/** `kingu.agent.cliPermissions`. */
	permissionMode: 'manual' | 'yolo';
	/** Whether the profile takes Snap MCP servers / skill plugins per run. */
	mcp: boolean;
	skills: boolean;
};

export type ChatLaunchSpec = {
	surface: 'ide';
	/** The chat runtime id. */
	agentId: string;
	runtime: string;
	/** `kingu.agent.model`; null: the runtime's default. */
	model: string | null;
	/** `kingu.chat.reasoningEffort` for the runtime (else `*`); null: the model's default. Not yet checked against the model's levels. */
	effort: Effort | null;
	/** `kingu.agent.permissionMode` (SDK mode). */
	permissionMode: PermissionMode;
	env: Record<string, string>;
};

export type LaunchSpec = AdeLaunchSpec | ChatLaunchSpec;

/**
 * The spec of a new run on `surface`. `agentId`: ADE — a `kingu.agent.cli` command to use instead
 * of the setting (the create form's pick); chat — a runtime id instead of `kingu.agent.runtime`.
 * `{ error }` when a setting is not usable (the launch would be refused).
 */
export function resolveLaunchSpec(o: { surface: 'ade'; agentId?: string; get: Get }): AdeLaunchSpec | { error: string };
export function resolveLaunchSpec(o: { surface: 'ide'; agentId?: string; get: Get }): ChatLaunchSpec;
export function resolveLaunchSpec(o: { surface: Surface; agentId?: string; get: Get }): LaunchSpec | { error: string };
export function resolveLaunchSpec({ surface, agentId, get }: { surface: Surface; agentId?: string; get: Get }): LaunchSpec | { error: string } {
	return surface === 'ade' ? adeSpec(agentId, get) : chatSpec(agentId, get);
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

function adeSpec(pick: string | undefined, get: Get): AdeLaunchSpec | { error: string } {
	const argv = adeCommand(pick, get);
	return argv ? adeLaunchSpec(argv, get) : { error: 'badCli' };
}

/**
 * The command a new terminal task runs (agentCommand): `pick` (the create form's) instead of
 * `kingu.agent.cli`, with the profile's args / yolo flags. Null when it is not a plain command.
 */
export function adeCommand(pick: string | undefined | null, get: Get): string[] | null {
	return agentCommand((k) => (k === 'kingu.agent.cli' && pick ? pick : str(get(k))));
}

/**
 * The spec of a launch of `argv` — a task's saved command, used as it is (its args are not added
 * again): the launch settings of its profile. `{ error }` when one is not usable.
 */
export function adeLaunchSpec(argv: readonly string[], get: Get): AdeLaunchSpec | { error: string } {
	const profile = profileOf(argv);
	const options = launchOptions(profile.id, get);
	if (typeof options === 'string') return { error: options };
	return {
		surface: 'ade',
		agentId: profile.id,
		argv: [...argv],
		...(options.program ? { program: options.program } : {}),
		env: options.env ?? [],
		claudeTeams: !!options.claudeTeams,
		permissionMode: get('kingu.agent.cliPermissions') === 'yolo' ? 'yolo' : 'manual',
		mcp: profile.mcp,
		skills: profile.skills
	};
}

function chatSpec(pick: string | undefined, get: Get): ChatLaunchSpec {
	const runtime = pick?.trim() || str(get('kingu.agent.runtime'))?.trim() || CLAUDE_RUNTIME;
	const mode = get('kingu.agent.permissionMode');
	const defaults = effortDefaults(get('kingu.chat.reasoningEffort'));
	return {
		surface: 'ide',
		agentId: runtime,
		runtime,
		model: str(get('kingu.agent.model'))?.trim() || null,
		effort: defaults[runtime] ?? defaults['*'] ?? null,
		permissionMode: PERMISSION_MODES.includes(mode as PermissionMode) ? (mode as PermissionMode) : 'default',
		env: {}
	};
}

/** A profile's launch argv with the spec's launch options (what tasks.svelte.ts does with launchOptions). */
export const applyLaunchSpec = (launchArgv: readonly string[], spec: AdeLaunchSpec) =>
	withLaunchOptions(launchArgv, { program: spec.program, env: spec.env, claudeTeams: spec.claudeTeams });
