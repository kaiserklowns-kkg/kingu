import { expect, test } from 'bun:test';
import { isTabColorId, tabColor, tabIcon, TAB_COLORS } from './tabAppearance.ts';
import { isTabColor } from './sessions.ts';

test('tab colors: own, else terminal.integrated.tabs.defaultColor, else none', () => {
	expect(tabColor('terminal.ansiRed', 'terminal.ansiBlue')).toBe('var(--vscode-terminal-ansiRed)');
	expect(tabColor(undefined, 'terminal.ansiBlue')).toBe('var(--vscode-terminal-ansiBlue)');
	expect(tabColor('red', null)).toBeUndefined();
	expect(TAB_COLORS.every(isTabColorId)).toBe(true);
	// Every pickable color survives a reload.
	expect(TAB_COLORS.every(isTabColor)).toBe(true);
});

test('tab icons fall back to the terminal icon', () => {
	expect(tabIcon('bug')).toBe('bug');
	expect(tabIcon('nope')).toBe('terminal');
	expect(tabIcon(undefined)).toBe('terminal');
});
