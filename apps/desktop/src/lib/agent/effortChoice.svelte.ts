// The chat's reasoning effort with the app's state (effort.ts is the pure part): what the agents
// themselves offered last (`effort_options`, Codex and ACP agents, by runtime id, kept in
// localStorage so the picker has them before a session starts), the levels of a chat's model,
// and the effort its runs start with (`chats.effortFor`).

import { settings } from '#lib/settings/settings.svelte.ts';
import { chats } from './chats.svelte.ts';
import { modelCatalog } from './modelCatalog.svelte.ts';
import { arkaiProviders } from './arkai.svelte.ts';
import { splitArkaiModel } from './arkai.ts';
import { agentRuntimes } from './runtimes.svelte.ts';
import { runtimeOf, type RuntimeProtocol } from './runtimes.ts';
import { effortDefaults, effortLevels, effortList, isEffort, modelDefault, runEffort, type Effort, type EffortContext } from './effort.ts';
import type { ChatMeta } from './chats.ts';

const KEY = 'kingu.chat.effortOptions';
export const EFFORT_SETTING = 'kingu.chat.reasoningEffort';

type Advertised = { levels: Effort[]; current: Effort | null };

function read(): Record<string, Advertised> {
	try {
		const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
		if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
		return Object.fromEntries(
			Object.entries(v as Record<string, { levels?: unknown; current?: unknown }>)
				.filter(([, a]) => !!a && Array.isArray(a.levels))
				.map(([id, a]) => [id, { levels: effortList(a.levels as unknown[]), current: isEffort(a.current) ? a.current : null }])
		);
	} catch {
		return {};
	}
}

class EffortOptions {
	/** By runtime id: the levels the agent offered last, and its own default then. */
	byRuntime = $state<Record<string, Advertised>>(read());

	set(runtime: string, levels: readonly unknown[], current: unknown) {
		this.byRuntime[runtime] = { levels: effortList(levels), current: isEffort(current) ? current : null };
		try {
			localStorage.setItem(KEY, JSON.stringify(this.byRuntime));
		} catch {
			// Storage off: kept until the app quits.
		}
	}
}

export const effortOptions = new EffortOptions();

/** What the chat's picker shows: the levels, the one in effect, and whether it was picked or is the default. */
export type EffortState = { levels: Effort[]; current: Effort | null };

function context(runtime: string, protocol: RuntimeProtocol, model: string | null | undefined): EffortContext {
	const split = protocol === 'arkai' ? splitArkaiModel(model) : null;
	const provider = split ? arkaiProviders.list.find((p) => p.id === split.provider) : undefined;
	return {
		protocol,
		model,
		listed: modelCatalog.for(runtime),
		arkai: split && provider ? { api: provider.api, baseUrl: provider.base_url, model: split.model } : null,
		advertised: effortOptions.byRuntime[runtime] ?? null
	};
}

const protocolOf = (runtime: string): RuntimeProtocol => agentRuntimes.list.find((r) => r.id === runtime)?.protocol ?? (runtime === 'arkai' ? 'arkai' : 'claude');

/**
 * The chat's levels and the one in effect: its pick (or the runtime's default from
 * `kingu.chat.reasoningEffort`) when the model takes it, else the model's own default (shown,
 * never sent).
 */
export function effortState(runtime: string, model: string | null | undefined, chosen: Effort | null | undefined): EffortState {
	const c = context(runtime, protocolOf(runtime), model);
	const levels = effortLevels(c);
	return { levels, current: runEffort(chosen, effortDefaults(settings.get(EFFORT_SETTING)), runtime, levels) ?? modelDefault(levels, c) };
}

/** The effort a run of `meta` is started with; null: nothing is sent (the model's default). */
export function effortForChat(meta: ChatMeta): Effort | null {
	const runtime = runtimeOf(meta);
	const levels = effortLevels(context(runtime, protocolOf(runtime), meta.model));
	return runEffort(meta.effort, effortDefaults(settings.get(EFFORT_SETTING)), runtime, levels);
}

chats.effortFor = effortForChat;
chats.onEvent((id, ev) => {
	if (ev.kind !== 'effort_options') return;
	const meta = chats.get(id);
	if (meta) effortOptions.set(runtimeOf(meta), ev.levels, ev.current);
});
