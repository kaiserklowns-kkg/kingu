// `modelCatalog.for(runtime)`: the models the last session of that runtime listed (agent-host
// `models` event, from the SDK's `supportedModels()`), kept in localStorage per runtime so each
// runtime's picker has its own models before any session starts.

import { chats } from './chats.svelte.ts';
import { parseCachedModels } from './modelChoices.ts';
import { CLAUDE_RUNTIME, runtimeOf } from './runtimes.ts';
import { invoke } from '@tauri-apps/api/core';
import { clientLog } from '../client-log.ts';
import type { ModelOption } from './events';

const KEY = 'kingu.chat.models';

/** Claude's list keeps the pre-runtime key, so its cache survives this change. */
const storageKey = (runtime: string) => (runtime === CLAUDE_RUNTIME ? KEY : `${KEY}:${runtime}`);

/** Every runtime's cached list, read once before any derived runs. */
function readAll(): Record<string, ModelOption[]> {
	const out: Record<string, ModelOption[]> = {};
	try {
		out[CLAUDE_RUNTIME] = parseCachedModels(localStorage.getItem(KEY));
		for (let k = 0; k < localStorage.length; k++) {
			const key = localStorage.key(k);
			if (key?.startsWith(`${KEY}:`)) {
				const list = parseCachedModels(localStorage.getItem(key));
				if (list.length) out[key.slice(KEY.length + 1)] = list;
			}
		}
	} catch {
		// Storage off: nothing cached until a runtime's session reports its models.
	}
	return out;
}

class ModelCatalog {
	byRuntime = $state<Record<string, ModelOption[]>>(readAll());

	for(runtime: string): ModelOption[] {
		return this.byRuntime[runtime] ?? [];
	}

	set(runtime: string, models: ModelOption[]) {
		if (!models.length) return;
		// replacing the record: the deriveds keep their dependency on the record itself
		this.byRuntime = { ...this.byRuntime, [runtime]: models };
		try {
			localStorage.setItem(storageKey(runtime), JSON.stringify(models));
		} catch {
			// Storage off: the list lasts until the app quits.
		}
	}
}

export const modelCatalog = new ModelCatalog();

/**
 * A runtime with no cached choices gets one ask before its first run (`agent_list_models`, a
 * throwaway session in the agent host): the result lands in the cache. Once per app — an agent
 * that names no models this way (or that is not installed) does not get asked again; its next
 * real session lists anyway.
 */
const probed = new Set<string>();
export function probeRuntimeModels(runtime: string) {
	if (probed.has(runtime) || modelCatalog.for(runtime).length) return;
	probed.add(runtime);
	invoke<ModelOption[]>('agent_list_models', { runtime })
		.then((models) => modelCatalog.set(runtime, Array.isArray(models) ? models : []))
		.catch((e) => clientLog('info', `agent_list_models ${runtime}: ${e}`));
}

chats.onEvent((id, ev) => {
	if (ev.kind !== 'models') return;
	const meta = chats.get(id);
	modelCatalog.set(meta ? runtimeOf(meta) : CLAUDE_RUNTIME, ev.models);
});
