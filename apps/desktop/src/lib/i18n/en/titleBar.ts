// UI strings of the title bar's command center pill, its agents status and the Arkai chat button
// (workbench/CommandCenter.svelte, TitleBar.svelte, titlebar.ts). Thai in ../th/titleBar.ts.
export const titleBar = {
	'titleBar.search': 'Search',
	'titleBar.searchFilesAndCommands': 'Search files and commands',
	'titleBar.openQuickAccess': 'Open Quick Access',
	'titleBar.switchProject': 'Switch Project',
	'titleBar.switchBranch': 'Switch Branch',
	'titleBar.working.one': '{name} working',
	'titleBar.working.many': '{count} working',
	'titleBar.waiting.one': '{name} waiting for you',
	'titleBar.waiting.many': '{count} waiting for you',
	'titleBar.filterHint': 'Click to show only these sessions; click again to clear the filter',
	'titleBar.chat.hover': 'Toggle Chat (Arkai) — right-click for more',
	'titleBar.chat.aria': 'Toggle Chat, right-click for more chat actions',
	'titleBar.chat.menu': 'Chat'
} as const;
