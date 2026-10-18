// `modelCatalog.list`: the models the last session listed (agent-host `models` event, from the SDK's
// `supportedModels()`), kept in localStorage so the picker has them before any session starts.

import { chats } from './chats.svelte.ts';
import { parseCachedModels } from './modelChoices.ts';
import type { ModelOption } from './events';

const KEY = 'kingu.chat.models';

function read(): ModelOption[] {
	try {
		return parseCachedModels(localStorage.getItem(KEY));
	} catch {
		return [];
	}
}

class ModelCatalog {
	list = $state<ModelOption[]>(read());

	set(models: ModelOption[]) {
		if (!models.length) return;
		this.list = models;
		try {
			localStorage.setItem(KEY, JSON.stringify(models));
		} catch {
			// Storage off: the list lasts until the app quits.
		}
	}
}

export const modelCatalog = new ModelCatalog();
chats.onEvent((_, ev) => {
	if (ev.kind === 'models') modelCatalog.set(ev.models);
});
