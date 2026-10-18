// Workbench part visibility and sizes (VS Code: IWorkbenchLayoutService, layout.ts).
// Defaults and minimums follow VS Code: sidebar/aux 300 (min 170), panel min height 77.

export type SideView = 'explorer' | 'search' | 'scm' | 'agents';
export type PanelTab = 'problems' | 'output' | 'terminal';

const KEY = 'kingu.workbench.layout';
export const SIDEBAR_MIN = 170;
export const PANEL_MIN = 77;
const PERSISTED = ['sidebarVisible', 'panelVisible', 'auxVisible', 'sidebarWidth', 'panelHeight', 'auxWidth', 'panelWidth', 'sideView', 'panelTab'] as const;

function readSaved(): Record<string, unknown> {
	try {
		return JSON.parse(localStorage.getItem(KEY) ?? '{}');
	} catch {
		return {};
	}
}

class Layout {
	sidebarVisible = $state(true);
	panelVisible = $state(true);
	auxVisible = $state(true);
	sidebarWidth = $state(300);
	panelHeight = $state(260);
	auxWidth = $state(360);
	/** Width of the panel when it sits left or right of the editor (`workbench.panel.defaultLocation`). */
	panelWidth = $state(400);
	sideView = $state<SideView>('explorer');
	panelTab = $state<PanelTab>('terminal');
	/** Zen Mode (VS Code ⌘K Z): only the editor and the title bar; not persisted. */
	zen = $state(false);
	#beforeZen: { sidebar: boolean; panel: boolean; aux: boolean } | null = null;

	/** Hides the side bars, the panel and the status bar; toggling again restores them as they were. */
	toggleZen() {
		if (!this.zen) {
			this.#beforeZen = { sidebar: this.sidebarVisible, panel: this.panelVisible, aux: this.auxVisible };
			this.sidebarVisible = this.panelVisible = this.auxVisible = false;
			this.zen = true;
			return;
		}
		const b = this.#beforeZen;
		if (b) [this.sidebarVisible, this.panelVisible, this.auxVisible] = [b.sidebar, b.panel, b.aux];
		this.#beforeZen = null;
		this.zen = false;
	}

	constructor() {
		const saved = readSaved();
		for (const k of PERSISTED) {
			if (k in saved && typeof saved[k] === typeof this[k]) (this as Record<string, unknown>)[k] = saved[k];
		}
		$effect.root(() => {
			$effect(() => {
				const snapshot = Object.fromEntries(PERSISTED.map((k) => [k, this[k]]));
				try {
					localStorage.setItem(KEY, JSON.stringify(snapshot));
				} catch {
					// Storage can be unavailable; layout then resets on the next launch.
				}
			});
		});
	}

	/** Activity bar click: VS Code toggles the sidebar off when the active view is clicked again. */
	showView(view: SideView) {
		if (this.sidebarVisible && this.sideView === view) this.sidebarVisible = false;
		else {
			this.sideView = view;
			this.sidebarVisible = true;
		}
	}

	showPanel(tab: PanelTab) {
		this.panelTab = tab;
		this.panelVisible = true;
	}
}

export const layout = new Layout();
