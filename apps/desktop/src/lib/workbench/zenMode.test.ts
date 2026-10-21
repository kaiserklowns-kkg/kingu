/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { CENTERED_DEFAULT, CENTERED_MIN, centeredShown, centeredSizes, dragMargin, enterZen, exitZenFullScreen, zenConfig, zenParts, type WorkbenchState } from './zenMode';
import { menuBarToggled } from './workbenchOptions';
import { SETTINGS } from '#lib/settings/registry.ts';

const defaults = (id: string) => SETTINGS.find((s) => s.id === id)?.default;
const shown: WorkbenchState = { fullscreen: false, centered: false, doNotDisturb: false, sideBar: true, panel: true, auxiliaryBar: false };

describe('zen mode settings', () => {
	test('the registered zenMode.* defaults are VS Code’s', () => {
		expect(zenConfig(defaults)).toEqual({
			fullScreen: true,
			centerLayout: true,
			showTabs: 'multiple',
			hideStatusBar: true,
			hideActivityBar: true,
			hideLineNumbers: true,
			restore: true,
			silentNotifications: true
		});
	});

	test('a wrong value falls back to the default', () => {
		const config = zenConfig((id) => ({ 'zenMode.showTabs': 'tabs', 'zenMode.fullScreen': 'yes' })[id]);
		expect(config.showTabs).toBe('multiple');
		expect(config.fullScreen).toBe(true);
	});

	test('the parts shown in zen mode follow the settings', () => {
		const config = zenConfig((id) => ({ 'zenMode.hideStatusBar': false, 'zenMode.showTabs': 'none', 'zenMode.hideLineNumbers': false })[id] ?? defaults(id));
		const { exit } = enterZen(shown, config);
		expect(zenParts(config, exit)).toEqual({ activityBar: false, statusBar: true, showTabs: 'none', lineNumbersOff: false, centered: true, errorsOnly: true });
	});
});

describe('entering and leaving zen mode', () => {
	const config = zenConfig(defaults);

	test('remembers what was visible and what it changed', () => {
		const { exit, toggleFullScreen } = enterZen(shown, config);
		expect(toggleFullScreen).toBe(true);
		expect(exit).toEqual({
			transitionedToFullScreen: true,
			transitionedToCenteredEditorLayout: true,
			handleNotificationsDoNotDisturbMode: true,
			wasVisible: { sideBar: true, panel: true, auxiliaryBar: false }
		});
	});

	test('a window already in full screen stays in it on exit', () => {
		const { exit, toggleFullScreen } = enterZen({ ...shown, fullscreen: true }, config);
		expect(toggleFullScreen).toBe(false);
		expect(exitZenFullScreen(exit, true)).toBe(false);
	});

	test('leaves full screen only when zen mode entered it and it is still on', () => {
		const { exit } = enterZen(shown, config);
		expect(exitZenFullScreen(exit, true)).toBe(true);
		expect(exitZenFullScreen(exit, false)).toBe(false);
	});

	test('zenMode.fullScreen off never enters full screen; do not disturb already on is left alone', () => {
		const { exit, toggleFullScreen } = enterZen({ ...shown, doNotDisturb: true, centered: true }, { ...config, fullScreen: false });
		expect(toggleFullScreen).toBe(false);
		expect(exit.handleNotificationsDoNotDisturbMode).toBe(false);
		expect(exit.transitionedToCenteredEditorLayout).toBe(false);
		expect(zenParts(config, exit).errorsOnly).toBe(false);
	});
});

describe('centered layout', () => {
	const grid = { columns: false, maximized: false, complexEditor: false };

	test('auto resize turns it off with columns or a side-by-side diff', () => {
		expect(centeredShown(true, true, grid)).toBe(true);
		expect(centeredShown(true, true, { ...grid, columns: true })).toBe(false);
		expect(centeredShown(true, true, { ...grid, columns: true, maximized: true })).toBe(true);
		expect(centeredShown(true, true, { ...grid, complexEditor: true })).toBe(false);
		expect(centeredShown(true, false, { ...grid, columns: true })).toBe(true);
		expect(centeredShown(false, true, grid)).toBe(false);
	});

	test('margins are ratios of the width, or centre a fixed width', () => {
		const [l, c, r] = centeredSizes(1000, CENTERED_DEFAULT, false);
		expect(l).toBeCloseTo(190.9);
		expect(r).toBeCloseTo(190.9);
		expect(l + c + r).toBeCloseTo(1000);
		expect(centeredSizes(1000, CENTERED_DEFAULT, true)).toEqual([50, 900, 50]);
		expect(centeredSizes(800, CENTERED_DEFAULT, true)).toEqual([0, 800, 0]);
		expect(centeredSizes(0, CENTERED_DEFAULT, false)).toEqual([0, 0, 0]);
	});

	test('dragging a margin keeps the other and the minimum editor width', () => {
		const next = dragMargin(CENTERED_DEFAULT, 1000, 'left', 100, false);
		expect(next.leftMarginRatio).toBeCloseTo(0.2909);
		expect(next.rightMarginRatio).toBeCloseTo(0.1909);
		const squeezed = dragMargin(CENTERED_DEFAULT, 1000, 'right', -5000, false);
		const [, center] = centeredSizes(1000, squeezed, false);
		expect(center).toBeCloseTo(CENTERED_MIN);
		// Fixed width: dragging the right sash rightward widens the editor on both sides.
		expect(dragMargin(CENTERED_DEFAULT, 1200, 'right', 50, true).targetWidth).toBe(1000);
		expect(dragMargin(CENTERED_DEFAULT, 1200, 'left', 1000, true).targetWidth).toBe(CENTERED_MIN);
	});
});

describe('toggle menu bar', () => {
	test('a shown menu bar becomes compact, any other classic', () => {
		expect(menuBarToggled('classic')).toBe('compact');
		expect(menuBarToggled('visible')).toBe('compact');
		expect(menuBarToggled(undefined)).toBe('compact');
		expect(menuBarToggled('compact')).toBe('classic');
		expect(menuBarToggled('toggle')).toBe('classic');
		expect(menuBarToggled('hidden')).toBe('classic');
	});
});
