// Per-runtime model catalogs, kept so a chat can pick from its harness's known models before its
// next session starts. This mirrors the old Agents Window's session-type-scoped model providers.

import { chats } from './chats.svelte.ts';
import { CLAUDE_RUNTIME } from './runtimes.ts';
import { parseCachedModels } from './modelChoices.ts';
import type { ModelOption } from './events';

const KEY = 'kingu.chat.modelsByRuntime';
const LEGACY_KEY = 'kingu.chat.models';

function read(): Record<string, ModelOption[]> {
	try {
		const saved = localStorage.getItem(KEY);
		if (saved) {
			const value: unknown = JSON.parse(saved);
			if (value && typeof value === 'object' && !Array.isArray(value)) {
				return Object.fromEntries(Object.entries(value).flatMap(([runtime, models]) => {
					const parsed = parseCachedModels(JSON.stringify(models));
					return parsed.length ? [[runtime, parsed]] : [];
				}));
			}
		}
		const legacy = parseCachedModels(localStorage.getItem(LEGACY_KEY));
		return legacy.length ? { [CLAUDE_RUNTIME]: legacy } : {};
	} catch {
		return {};
	}
}

class ModelCatalog {
	private catalogs = $state<Record<string, ModelOption[]>>(read());

	get list() {
		return this.forRuntime(CLAUDE_RUNTIME);
	}

	forRuntime(runtime: string) {
		return this.catalogs[runtime] ?? [];
	}

	set(runtime: string, models: ModelOption[]) {
		if (!models.length) return;
		this.catalogs = { ...this.catalogs, [runtime]: models };
		try {
			localStorage.setItem(KEY, JSON.stringify(this.catalogs));
		} catch {
			// Storage off: the list lasts until the app quits.
		}
	}
}

export const modelCatalog = new ModelCatalog();
chats.onEvent((id, ev) => {
	if (ev.kind === 'models') modelCatalog.set(chats.get(id)?.runtime || CLAUDE_RUNTIME, ev.models);
});
