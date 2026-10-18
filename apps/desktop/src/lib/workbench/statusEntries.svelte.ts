// Status bar entries the user hid from its context menu. VS Code keeps these in storage rather
// than settings (`workbench.statusbar.hidden`), so Kingu keeps them per machine as well.

import { SvelteSet } from 'svelte/reactivity';

const KEY = 'kingu.statusbar.hidden';

function load(): string[] {
	try {
		const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
		return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
	} catch {
		return [];
	}
}

class StatusEntries {
	hidden = new SvelteSet<string>(load());

	toggle(id: string) {
		if (this.hidden.has(id)) this.hidden.delete(id);
		else this.hidden.add(id);
		try {
			localStorage.setItem(KEY, JSON.stringify([...this.hidden]));
		} catch {
			// Storage unavailable: the choice lasts until the window reloads.
		}
	}
}

export const statusEntries = new StatusEntries();
