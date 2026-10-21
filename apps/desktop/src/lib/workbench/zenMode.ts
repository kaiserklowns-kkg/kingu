// Zen Mode and the centered editor layout as pure functions (VS Code: layout.ts toggleZenMode /
// centerMainEditorLayout, base/browser/ui/centered/centeredViewLayout.ts), so bun tests can check
// them. layout.svelte.ts holds the state and applies the results.

export type ZenShowTabs = 'multiple' | 'single' | 'none';

/** The zenMode.* settings (VS Code's ZenModeConfiguration). */
export type ZenConfig = {
	fullScreen: boolean;
	centerLayout: boolean;
	showTabs: ZenShowTabs;
	hideStatusBar: boolean;
	hideActivityBar: boolean;
	hideLineNumbers: boolean;
	restore: boolean;
	silentNotifications: boolean;
};

export function zenConfig(get: (id: string) => unknown): ZenConfig {
	const bool = (id: string, fallback: boolean) => (typeof get(id) === 'boolean' ? (get(id) as boolean) : fallback);
	const tabs = get('zenMode.showTabs');
	return {
		fullScreen: bool('zenMode.fullScreen', true),
		centerLayout: bool('zenMode.centerLayout', true),
		showTabs: tabs === 'single' || tabs === 'none' ? tabs : 'multiple',
		hideStatusBar: bool('zenMode.hideStatusBar', true),
		hideActivityBar: bool('zenMode.hideActivityBar', true),
		hideLineNumbers: bool('zenMode.hideLineNumbers', true),
		restore: bool('zenMode.restore', true),
		silentNotifications: bool('zenMode.silentNotifications', true)
	};
}

/** What entering Zen Mode changed, so leaving it undoes only that (VS Code's ZEN_MODE_EXIT_INFO). */
export type ZenExitInfo = {
	transitionedToFullScreen: boolean;
	transitionedToCenteredEditorLayout: boolean;
	/** Do Not Disturb was off on entry, so Zen Mode may turn it on (and off again on exit). */
	handleNotificationsDoNotDisturbMode: boolean;
	wasVisible: { sideBar: boolean; panel: boolean; auxiliaryBar: boolean };
};

export type WorkbenchState = { fullscreen: boolean; centered: boolean; doNotDisturb: boolean; sideBar: boolean; panel: boolean; auxiliaryBar: boolean };

/** Entering Zen Mode: what to remember, and whether the window goes full screen. */
export function enterZen(state: WorkbenchState, config: ZenConfig): { exit: ZenExitInfo; toggleFullScreen: boolean } {
	const toggleFullScreen = !state.fullscreen && config.fullScreen;
	return {
		toggleFullScreen,
		exit: {
			transitionedToFullScreen: toggleFullScreen,
			transitionedToCenteredEditorLayout: !state.centered && config.centerLayout,
			handleNotificationsDoNotDisturbMode: !state.doNotDisturb,
			wasVisible: { sideBar: state.sideBar, panel: state.panel, auxiliaryBar: state.auxiliaryBar }
		}
	};
}

/** Leaving Zen Mode: leave full screen only when Zen Mode entered it and the window is still in it. */
export function exitZenFullScreen(exit: ZenExitInfo, fullscreen: boolean): boolean {
	return exit.transitionedToFullScreen && fullscreen;
}

/** What the workbench shows while Zen Mode is on (the side bars and the panel are always hidden). */
export type ZenParts = { activityBar: boolean; statusBar: boolean; showTabs: ZenShowTabs; lineNumbersOff: boolean; centered: boolean; errorsOnly: boolean };

export function zenParts(config: ZenConfig, exit: ZenExitInfo): ZenParts {
	return {
		activityBar: !config.hideActivityBar,
		statusBar: !config.hideStatusBar,
		showTabs: config.showTabs,
		lineNumbersOff: config.hideLineNumbers,
		centered: config.centerLayout,
		errorsOnly: config.silentNotifications && exit.handleNotificationsDoNotDisturbMode
	};
}

// --- Centered editor layout ---------------------------------------------------------------------

/** VS Code's CenteredViewState: the center width for `centeredLayoutFixedWidth`, else margin ratios. */
export type CenteredState = { targetWidth: number; leftMarginRatio: number; rightMarginRatio: number };
export const CENTERED_DEFAULT: CenteredState = { targetWidth: 900, leftMarginRatio: 0.1909, rightMarginRatio: 0.1909 };
/** Smallest editor width the margins leave (VS Code's editor part minimum). */
export const CENTERED_MIN = 220;

/**
 * Whether the centered layout shows: asked for, unless `workbench.editor.centeredLayoutAutoResize`
 * and the grid has more than one column (and no group is maximized) or a side-by-side diff shows.
 */
export function centeredShown(requested: boolean, autoResize: boolean, grid: { columns: boolean; maximized: boolean; complexEditor: boolean }): boolean {
	if (!requested) return false;
	return !(autoResize && ((grid.columns && !grid.maximized) || grid.complexEditor));
}

/** [left margin, editor, right margin] in px for an editor area `width` wide. */
export function centeredSizes(width: number, state: CenteredState, fixedWidth: boolean): [number, number, number] {
	if (width <= 0) return [0, 0, 0];
	if (fixedWidth) {
		const center = Math.min(width, state.targetWidth);
		const margin = (width - center) / 2;
		return [Math.floor(margin), center, Math.ceil(margin)];
	}
	const left = state.leftMarginRatio * width;
	const right = state.rightMarginRatio * width;
	return [left, width - left - right, right];
}

/** Dragging a margin's sash by `delta` px (positive = rightward); the editor keeps CENTERED_MIN. */
export function dragMargin(state: CenteredState, width: number, side: 'left' | 'right', delta: number, fixedWidth: boolean): CenteredState {
	if (width <= 0) return state;
	const [l, c, r] = centeredSizes(width, state, fixedWidth);
	if (fixedWidth) {
		// The margins stay equal: dragging one side widens or narrows the editor on both.
		const grow = side === 'left' ? -delta : delta;
		return { ...state, targetWidth: Math.max(CENTERED_MIN, Math.min(width, c + 2 * grow)) };
	}
	let left = l;
	let right = r;
	if (side === 'left') left = Math.max(0, Math.min(l + delta, width - r - CENTERED_MIN));
	else right = Math.max(0, Math.min(r - delta, width - l - CENTERED_MIN));
	return { targetWidth: width - left - right, leftMarginRatio: left / width, rightMarginRatio: right / width };
}
