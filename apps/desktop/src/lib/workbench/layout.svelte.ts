// Workbench part visibility and sizes (VS Code: IWorkbenchLayoutService, layout.ts).
// Defaults and minimums follow VS Code: sidebar/aux 300 (min 170), panel min height 77.
// Zen Mode and the centered editor layout follow layout.ts (the pure parts are in zenMode.ts).
// Like VS Code's layout state, what is shown (parts, the side bar's view, the panel's tab, Zen
// Mode, the centered layout) is kept per workspace (workspaceStorage.svelte.ts), with the panel
// hidden in a workspace never opened before; the sizes are shared by every window.

import { getCurrentWindow } from '@tauri-apps/api/window';
import { settings } from '#lib/settings/settings.svelte.ts';
import { notifications } from './notifications.svelte';
import { workspaceStorage } from './workspaceStorage.svelte';
import { withSaved } from './workspaceState';
import { CENTERED_DEFAULT, enterZen, exitZenFullScreen, zenConfig, zenParts, type CenteredState, type ZenExitInfo, type ZenParts } from './zenMode';

/** `snap:<key>`: a snap's side bar view (snaps/contributions.ts viewKey). */
export type SideView = 'explorer' | 'search' | 'scm' | 'debug' | 'testing' | 'snaps' | 'agents' | 'vault' | 'artifacts' | `snap:${string}`;
/** `snap:<key>`: a snap's panel view. */
export type PanelTab = 'problems' | 'output' | 'debugConsole' | 'terminal' | 'refactorPreview' | `snap:${string}`;

const KEY = 'kingu.workbench.layout';
export const SIDEBAR_MIN = 170;
export const PANEL_MIN = 77;
/** Shared by every window. */
const SIZES = ['sidebarWidth', 'panelHeight', 'auxWidth', 'panelWidth'] as const;

/** Per workspace, with what a workspace opened for the first time shows (VS Code: panel hidden). */
const WORKSPACE_DEFAULTS: {
	sidebarVisible: boolean;
	panelVisible: boolean;
	auxVisible: boolean;
	sideView: SideView;
	panelTab: PanelTab;
	centered: boolean;
	centeredState: CenteredState;
	zen: boolean;
	zenExit: ZenExitInfo | null;
} = { sidebarVisible: true, panelVisible: false, auxVisible: true, sideView: 'explorer', panelTab: 'terminal', centered: false, centeredState: CENTERED_DEFAULT, zen: false, zenExit: null };
const WORKSPACE_KEYS = Object.keys(WORKSPACE_DEFAULTS) as (keyof typeof WORKSPACE_DEFAULTS)[];

function readSaved(): Record<string, unknown> {
	try {
		return JSON.parse(localStorage.getItem(KEY) ?? '{}');
	} catch {
		return {};
	}
}

class Layout {
	sidebarVisible = $state(WORKSPACE_DEFAULTS.sidebarVisible);
	panelVisible = $state(WORKSPACE_DEFAULTS.panelVisible);
	auxVisible = $state(WORKSPACE_DEFAULTS.auxVisible);
	sidebarWidth = $state(300);
	panelHeight = $state(260);
	auxWidth = $state(360);
	/** Width of the panel when it sits left or right of the editor (`workbench.panel.defaultLocation`). */
	panelWidth = $state(400);
	sideView = $state<SideView>('explorer');
	panelTab = $state<PanelTab>('terminal');
	/** Zen Mode (VS Code ⌘K Z): the editor alone, as the zenMode.* settings say (zenMode.ts). */
	zen = $state(false);
	/** What entering Zen Mode changed; persisted with `zen` for zenMode.restore. */
	zenExit = $state.raw<ZenExitInfo | null>(null);
	/** View: Toggle Centered Layout (VS Code's MAIN_EDITOR_CENTERED), persisted. */
	centered = $state(false);
	/** The centered layout's margins (VS Code's CenteredViewState), persisted. */
	centeredState = $state.raw<CenteredState>(CENTERED_DEFAULT);
	/** The window is in (native) full screen; kept current by installLayoutCommands. */
	fullscreen = $state(false);

	/** The zenMode.* settings while Zen Mode is on, else null. */
	get zenParts(): ZenParts | null {
		return this.zen && this.zenExit ? zenParts(zenConfig((id) => settings.get(id)), this.zenExit) : null;
	}

	/** Centered as asked for, or by Zen Mode (zenMode.centerLayout). */
	get centeredRequested(): boolean {
		const parts = this.zenParts;
		return parts ? parts.centered || (this.centered && !this.zenExit?.transitionedToCenteredEditorLayout) : this.centered;
	}

	/**
	 * VS Code's toggleZenMode: hides the side bars and the panel, the activity bar, status bar and
	 * line numbers as configured, centers the editor, enters full screen and silences
	 * notifications; toggling again restores exactly what it changed. Zen Mode and its exit info
	 * are persisted: restoreZen() keeps or ends them at startup (zenMode.restore).
	 */
	toggleZen() {
		const config = zenConfig((id) => settings.get(id));
		if (!this.zen) {
			const { exit, toggleFullScreen } = enterZen(
				{ fullscreen: this.fullscreen, centered: this.centered, doNotDisturb: notifications.doNotDisturb, sideBar: this.sidebarVisible, panel: this.panelVisible, auxiliaryBar: this.auxVisible },
				config
			);
			this.zenExit = exit;
			this.sidebarVisible = this.panelVisible = this.auxVisible = false;
			this.zen = true;
			if (config.silentNotifications && exit.handleNotificationsDoNotDisturbMode) notifications.setDoNotDisturb(true);
			if (toggleFullScreen) void this.setFullScreen(true);
			return;
		}
		const exit = this.zenExit;
		this.zen = false;
		this.zenExit = null;
		if (!exit) return;
		if (exit.wasVisible.panel) this.panelVisible = true;
		if (exit.wasVisible.auxiliaryBar) this.auxVisible = true;
		if (exit.wasVisible.sideBar) this.sidebarVisible = true;
		if (exit.handleNotificationsDoNotDisturbMode) notifications.setDoNotDisturb(false);
		if (exitZenFullScreen(exit, this.fullscreen)) void this.setFullScreen(false);
	}

	/** View: Toggle Full Screen (the native full screen, like VS Code's default `window.nativeFullScreen`). */
	async setFullScreen(on: boolean) {
		try {
			await getCurrentWindow().setFullscreen(on);
			this.fullscreen = on;
		} catch {
			// Not in a Tauri window (tests) or refused by the OS.
		}
	}

	/** Startup, once the settings are read: a window closed in Zen Mode reopens in it with
	 * zenMode.restore (full screen again if Zen Mode had entered it), else Zen Mode ends. */
	restoreZen() {
		if (!this.zen) return;
		if (!this.zenExit) {
			this.zen = false;
			return;
		}
		if (!zenConfig((id) => settings.get(id)).restore) this.toggleZen();
		else if (this.zenExit.transitionedToFullScreen && !this.fullscreen) void this.setFullScreen(true);
	}

	/** The window left full screen: Zen Mode that entered it ends too (VS Code). */
	fullscreenChanged(on: boolean) {
		if (on === this.fullscreen) return;
		this.fullscreen = on;
		if (!on && this.zen && this.zenExit?.transitionedToFullScreen) this.toggleZen();
	}

	constructor() {
		// An older build kept everything here for every window: the sizes stay, the rest goes to
		// the first workspace this window opens (workspaceStorage).
		const saved = readSaved();
		for (const k of SIZES) {
			if (k in saved && typeof saved[k] === typeof this[k]) (this as Record<string, unknown>)[k] = saved[k];
		}
		workspaceStorage.register(KEY, WORKSPACE_KEYS, (state) => this.#show(state), saved);
		$effect.root(() => {
			$effect(() => {
				const snapshot = Object.fromEntries(SIZES.map((k) => [k, this[k]]));
				try {
					localStorage.setItem(KEY, JSON.stringify(snapshot));
				} catch {
					// Storage can be unavailable; layout then resets on the next launch.
				}
			});
			$effect(() => {
				const snapshot = Object.fromEntries(WORKSPACE_KEYS.map((k) => [k, this[k]]));
				if (workspaceStorage.scope !== undefined) workspaceStorage.save(KEY, snapshot);
			});
		});
	}

	/** Another workspace in this window (or the first one): its parts, views and modes. */
	#show(saved: Record<string, unknown> | null) {
		const next = withSaved(WORKSPACE_DEFAULTS, saved);
		for (const k of WORKSPACE_KEYS) (this as Record<string, unknown>)[k] = next[k];
		// The new workspace's Zen Mode is kept or ended like at startup (zenMode.restore).
		if (settings.loaded) this.restoreZen();
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
