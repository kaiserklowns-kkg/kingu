// A terminal tab's icon and color (VS Code's Change Icon / Change Color, terminal.integrated.tabs.defaultColor). Pure.

import type { IconName } from '#lib/workbench/Icon.svelte';
import { cssVariable } from '#lib/theme/colors.ts';

/** The icons a terminal tab may take: Kingu's icons named after their VS Code codicon. */
export const TAB_ICONS: readonly { icon: IconName; codicon: string }[] = [
	{ icon: 'terminal', codicon: 'terminal' },
	{ icon: 'code', codicon: 'code' },
	{ icon: 'bug', codicon: 'debug' },
	{ icon: 'play', codicon: 'play' },
	{ icon: 'git', codicon: 'source-control' },
	{ icon: 'branch', codicon: 'git-branch' },
	{ icon: 'folder', codicon: 'folder' },
	{ icon: 'file', codicon: 'file' },
	{ icon: 'search', codicon: 'search' },
	{ icon: 'settings', codicon: 'settings-gear' },
	{ icon: 'tasks', codicon: 'tasklist' },
	{ icon: 'sparkle', codicon: 'sparkle' },
	{ icon: 'robot', codicon: 'robot' },
	{ icon: 'cpu', codicon: 'chip' },
	{ icon: 'memory', codicon: 'server' },
	{ icon: 'clock', codicon: 'clock' },
	{ icon: 'coffee', codicon: 'coffee' },
	{ icon: 'key', codicon: 'key' },
	{ icon: 'bell', codicon: 'bell' },
	{ icon: 'pin', codicon: 'pin' }
];

export const isTabIcon = (v: unknown): v is IconName => TAB_ICONS.some((i) => i.icon === v);

/** The ANSI colors a tab may take (VS Code's color picker and terminal.integrated.tabs.defaultColor). */
export const TAB_COLORS = ['terminal.ansiBlack', 'terminal.ansiRed', 'terminal.ansiGreen', 'terminal.ansiYellow', 'terminal.ansiBlue', 'terminal.ansiMagenta', 'terminal.ansiCyan', 'terminal.ansiWhite'] as const;
export type TabColor = (typeof TAB_COLORS)[number];

export const isTabColorId = (v: unknown): v is TabColor => TAB_COLORS.includes(v as TabColor);

/** The CSS color of a tab: its own color, else terminal.integrated.tabs.defaultColor, else none. */
export function tabColor(own: string | undefined, fallback: unknown): string | undefined {
	const id = isTabColorId(own) ? own : isTabColorId(fallback) ? fallback : undefined;
	return id ? `var(${cssVariable(id)})` : undefined;
}

/** The icon a tab shows: its own, else the terminal icon. */
export const tabIcon = (own: string | undefined): IconName => (isTabIcon(own) ? own : 'terminal');
