// One catalog of the agents Kingu knows (docs/AI-SURFACES.md §8.1): the ADE's CLI profiles
// (ade/agentProfiles.ts, run in a task terminal) joined with the chat's runtimes (runtimes.ts,
// run through the agent host) by id — `codex`, `gemini`, `qwen`, … are both. Read-only: nothing
// in the UI or a launch reads it yet (Phase 2). Pure, so `bun test` covers it.

import { CUSTOM, PROFILES, type AgentProfile } from '#lib/ade/agentProfiles.ts';
import { CLAUDE, type RuntimeInfo } from './runtimes.ts';

/** Where an agent can run: the IDE's agent chat, the ADE's task terminal. */
export type Surface = 'ide' | 'ade';

export type AgentCapabilities = {
	/** Structured events + transcript (a chat runtime). */
	structured: boolean;
	/** A TUI in a PTY (a CLI profile). */
	terminal: boolean;
	/** A session can be continued: the CLI's resume, or the chat's session id. */
	resume: boolean;
	/** A chat can be forked / rewound at an anchor. */
	fork: boolean;
	/** The chat's model picker. */
	models: boolean;
	/** The chat's effort picker without the agent advertising levels (ACP agents only show it when they do). */
	effort: boolean;
};

export type CatalogEntry = {
	id: string;
	title: string;
	cliProfile?: AgentProfile;
	chatRuntime?: RuntimeInfo;
	surfaces: Surface[];
	capabilities: AgentCapabilities;
};

function entry(id: string, cliProfile: AgentProfile | undefined, chatRuntime: RuntimeInfo | undefined): CatalogEntry {
	const surfaces: Surface[] = [...(chatRuntime ? (['ide'] as const) : []), ...(cliProfile ? (['ade'] as const) : [])];
	return {
		id,
		title: cliProfile?.title ?? chatRuntime?.name ?? id,
		...(cliProfile ? { cliProfile } : {}),
		...(chatRuntime ? { chatRuntime } : {}),
		surfaces,
		capabilities: {
			structured: !!chatRuntime,
			terminal: !!cliProfile,
			resume: !!chatRuntime || !!cliProfile?.canResume,
			fork: !!chatRuntime?.features.rewind,
			models: !!chatRuntime?.features.models,
			effort: !!chatRuntime && chatRuntime.protocol !== 'acp'
		}
	};
}

/**
 * Every agent: the CLI profiles in profile order (with their chat runtime when one has the same
 * id), then the chat runtimes no profile has (Arkai, custom ACP agents). `runtimes` is the Rust
 * list (parseRuntimes); Claude is there even before it answers. The `custom` command is not an
 * agent of its own and stays out.
 */
export function agentCatalog(runtimes: readonly RuntimeInfo[] = [CLAUDE]): CatalogEntry[] {
	const chat = new Map<string, RuntimeInfo>([[CLAUDE.id, CLAUDE]]);
	for (const r of runtimes) chat.set(r.id, r);
	const out = PROFILES.map((p) => entry(p.id, p, chat.get(p.id)));
	const cli = new Set(PROFILES.map((p) => p.id));
	for (const r of chat.values()) if (!cli.has(r.id) && r.id !== CUSTOM.id) out.push(entry(r.id, undefined, r));
	return out;
}

/** The entry of `id`, or undefined. */
export const catalogEntry = (catalog: readonly CatalogEntry[], id: string) => catalog.find((e) => e.id === id);

/** The entries that run on `surface`. */
export const onSurface = (catalog: readonly CatalogEntry[], surface: Surface) => catalog.filter((e) => e.surfaces.includes(surface));
