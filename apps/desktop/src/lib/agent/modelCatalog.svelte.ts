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
	/** Runtimes whose one-off model ask is running (the picker says so — the ask can be slow). */
	busy = $state<Record<string, true>>({});
	/** Runtimes whose last ask failed (the picker offers a retry on the next open). */
	failed = $state<Record<string, true>>({});

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
 * throwaway session in the agent host): the result lands in the cache. A failure only blocks the
 * next ask until the picker opens again.
 */
const probed = new Set<string>();
export function probeRuntimeModels(runtime: string) {
	// Claude names no probe (its own list has a fixed fallback) — nothing to ask the sidecar for.
	if (runtime === 'claude') return;
	if (modelCatalog.busy[runtime] || (modelCatalog.for(runtime).length && !modelCatalog.failed[runtime])) return;
	if (modelCatalog.failed[runtime]) probed.delete(runtime);
	if (probed.has(runtime)) return;
	probed.add(runtime);
	modelCatalog.busy = { ...modelCatalog.busy, [runtime]: true };
	invoke<ModelOption[]>('agent_list_models', { runtime })
		.then((models) => {
			modelCatalog.set(runtime, Array.isArray(models) ? models : []);
			modelCatalog.failed = rest(modelCatalog.failed, runtime);
		})
		.catch((e) => {
			modelCatalog.failed = { ...modelCatalog.failed, [runtime]: true };
			// The picker shows a retry hint; the reason goes to the log for a report.
			clientLog('info', `agent_list_models ${runtime}: ${e}`);
		})
		.finally(() => (modelCatalog.busy = rest(modelCatalog.busy, runtime)));
}

const rest = (rec: Record<string, true>, key: string): Record<string, true> => {
	const { [key]: _gone, ...out } = rec;
	return out;
};


chats.onEvent((id, ev) => {
	if (ev.kind !== 'models') return;
	const meta = chats.get(id);
	modelCatalog.set(meta ? runtimeOf(meta) : CLAUDE_RUNTIME, ev.models);
});
