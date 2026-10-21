// View: Maximize Panel Size (VS Code: workbench.action.toggleMaximizedPanel): the panel takes the
// editor area; again restores its size. Shared by the panel's button and the command. Below or
// above the editor it is the height that grows, beside it the width.

import { settings } from '#lib/settings/settings.svelte.ts';
import { layout } from './layout.svelte';

/** Title bar, status bar and the editor's minimum, which a maximized panel leaves. */
const CHROME_HEIGHT = 35 + 22 + 70;
const MIN_EDITOR_WIDTH = 220;

class PanelSize {
	#restore = $state<{ height: number; width: number } | null>(null);
	maximized = $derived(this.#restore !== null);

	toggle() {
		const r = this.#restore;
		if (r) {
			layout.panelHeight = r.height;
			layout.panelWidth = r.width;
			this.#restore = null;
			return;
		}
		this.#restore = { height: layout.panelHeight, width: layout.panelWidth };
		const beside = ['left', 'right'].includes(settings.get<string>('workbench.panel.defaultLocation'));
		if (beside) layout.panelWidth = Math.max(400, window.innerWidth - layout.sidebarWidth * Number(layout.sidebarVisible) - MIN_EDITOR_WIDTH);
		else layout.panelHeight = Math.max(160, window.innerHeight - CHROME_HEIGHT);
		layout.panelVisible = true;
	}
}

export const panelSize = new PanelSize();
