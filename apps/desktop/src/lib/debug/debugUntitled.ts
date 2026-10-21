// A source only the debug adapter has (a `sourceReference`: eval'd code, node internals) shown in a
// new untitled editor (VS Code opens a read-only `debug:` document; Kingu has no such scheme yet).

import { editors } from '#lib/workbench/editors.svelte.ts';
import { nextUntitledKey } from '#lib/workbench/untitled.ts';
import { getEntry } from '#lib/workbench/editorModels.ts';

export async function openUntitledWith(content: string, _name: string): Promise<void> {
	const key = nextUntitledKey(editors.allTabs().map((t) => t.path));
	editors.open(key, { preview: false });
	// The editor makes the model as it shows the tab.
	for (let i = 0; i < 100; i++) {
		const model = getEntry(key)?.model;
		if (model) {
			model.setValue(content);
			return;
		}
		await new Promise((r) => setTimeout(r, 20));
	}
}
