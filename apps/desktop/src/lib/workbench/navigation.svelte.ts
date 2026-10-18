// Go Back / Go Forward (VS Code: workbench.action.navigateBack / navigateForward). The editor
// host of the active group offers cursor positions; this shows a recorded location again.

import { settings } from '#lib/settings/settings.svelte.ts';
import { editors } from './editors.svelte';
import { NavigationHistory, type Location } from './navigation';

class Navigation {
	#history = new NavigationHistory();
	canGoBack = $state(false);
	canGoForward = $state(false);

	record(loc: Location) {
		this.#history.record(loc);
		this.#sync();
	}

	back() {
		this.#show(this.#history.back(this.#inScope()));
	}

	forward() {
		this.#show(this.#history.forward(this.#inScope()));
	}

	/** `workbench.editor.navigationScope`: every location, the active group's, or the active editor's. */
	#inScope(): (loc: Location) => boolean {
		const scope = settings.get<'default' | 'editorGroup' | 'editor'>('workbench.editor.navigationScope');
		const group = editors.activeGroupId;
		const path = editors.active;
		if (scope === 'editorGroup') return (loc) => loc.group === undefined || loc.group === group;
		if (scope === 'editor') return (loc) => (loc.group === undefined || loc.group === group) && loc.path === path;
		return () => true;
	}

	/** Forgets the locations of files that cannot be shown any more. */
	remove(match: (path: string) => boolean) {
		this.#history.remove(match);
		this.#sync();
	}

	clear() {
		this.#history.clear();
		this.#sync();
	}

	#show(loc: Location | null) {
		this.#sync();
		if (!loc) return;
		// The reveal puts the cursor on the entry, so the editor's next `record` only updates it.
		const group = loc.group !== undefined && editors.group(loc.group) ? loc.group : undefined;
		editors.open(loc.path, { group, reveal: { line: loc.line, column: loc.column, focus: true } });
	}

	#sync() {
		this.canGoBack = this.#history.canGoBack;
		this.canGoForward = this.#history.canGoForward;
	}
}

export const navigation = new Navigation();
