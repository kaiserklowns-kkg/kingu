// The chat view draws its icons as VS Code's chat does: product icons (`<Codicon id>`), by the
// ids kingu-old's chat uses (chatIcons.ts, the actions' `icon:`). Data that still names a Kingu
// icon (a context chip's, a menu row's) maps through `codiconOf`. Pure, for `bun test`.

import type { IconName } from '#lib/workbench/Icon.svelte';
import { isIconId, MASK_ICONS } from '#lib/workbench/codicons.ts';
import type { AgentApproval } from './chatInput.ts';
import type { ModeTone } from './composer.ts';

/** Each Kingu icon name as the codicon / registered icon VS Code draws for the same thing. */
export const ICON_CODICON: Record<IconName, string> = {
	files: 'files',
	search: 'search',
	git: 'source-control',
	agent: 'arkai-mark',
	settings: 'gear',
	account: 'account',
	chevronRight: 'chevron-right',
	arrowLeft: 'arrow-left',
	arrowRight: 'arrow-right',
	chevronDown: 'chevron-down',
	close: 'close',
	sidebarLeft: 'layout-sidebar-left',
	panelBottom: 'layout-panel',
	sidebarRight: 'layout-sidebar-right',
	branch: 'git-branch',
	error: 'error',
	bug: 'debug',
	bell: 'bell',
	question: 'comment-discussion',
	attach: 'attach',
	image: 'file-media',
	bellDot: 'bell-dot',
	bellSlash: 'bell-slash',
	clearAll: 'clear-all',
	pin: 'pin',
	warning: 'warning',
	info: 'info',
	keyboard: 'keyboard',
	folder: 'folder',
	file: 'file',
	plus: 'plus',
	minus: 'remove',
	ignored: 'circle-slash',
	discard: 'discard',
	goToFile: 'go-to-file',
	check: 'check',
	send: 'arrow-up-compact',
	chevronUp: 'chevron-up',
	newFile: 'new-file',
	newFolder: 'new-folder',
	collapseAll: 'collapse-all',
	replace: 'replace',
	tasks: 'project',
	clock: 'clock',
	trash: 'trash',
	play: 'play',
	stop: 'debug-stop',
	merge: 'git-merge',
	pullRequest: 'git-pull-request',
	refresh: 'refresh',
	kingu: 'arkai-mark',
	menu: 'menu',
	layout: 'layout',
	code: 'code',
	agentsLayout: 'layout',
	terminal: 'terminal',
	coffee: 'coffee',
	usage: 'graph',
	sparkle: 'sparkle',
	listChecks: 'checklist',
	checkCircle: 'pass',
	crosshair: 'target',
	unpin: 'pinned',
	sleep: 'watch',
	sliders: 'settings',
	help: 'question',
	bellOff: 'bell-slash',
	circleDashed: 'circle-large-outline',
	floating: 'window',
	maximize: 'screen-full',
	restore: 'screen-normal',
	fileText: 'file-text',
	chartBar: 'graph',
	eyeOff: 'eye-closed',
	eye: 'eye',
	shield: 'shield',
	filter: 'filter',
	sync: 'sync',
	publish: 'cloud-upload',
	more: 'ellipsis',
	activity: 'pulse',
	memory: 'database',
	cpu: 'chip',
	ports: 'plug',
	copy: 'copy',
	openExternal: 'link-external',
	stopProcess: 'stop-circle',
	commit: 'git-commit',
	replaceAll: 'replace-all',
	pause: 'debug-pause',
	stepOver: 'debug-step-over',
	stepInto: 'debug-step-into',
	stepOut: 'debug-step-out',
	breakpoint: 'circle-filled',
	snap: 'extensions',
	claude: 'chat-model-provider-claude',
	openai: 'chat-model-provider-openai',
	key: 'key',
	lock: 'lock',
	signIn: 'sign-in',
	arrowUp: 'arrow-up',
	arrowDown: 'arrow-down',
	note: 'note',
	edit: 'edit',
	columns: 'split-horizontal',
	rows: 'split-vertical',
	thumbsUp: 'thumbsup',
	thumbsDown: 'thumbsdown',
	bookmark: 'bookmark',
	infinity: 'agent',
	chat: 'comment-discussion',
	robot: 'robot',
	at: 'mention',
	grip: 'gripper',
	mic: 'mic',
	power: 'debug-disconnect',
	download: 'cloud-download',
	desktop: 'device-desktop',
	lightning: 'zap',
	chevronLeft: 'chevron-left'
};

/** The codicon id for a Kingu icon name. */
export const codiconOf = (name: IconName): string => ICON_CODICON[name];

/** VS Code's getCompactCodicon: `<id>-compact` where that icon exists (the chat input's 12px tier), else the id. */
export function compactCodicon(id: string): string {
	const compact = `${id}-compact`;
	return isIconId(compact) ? compact : id;
}

/** Whether `id` draws (a codicon, a registered icon, or one of Kingu's masked marks). */
export const drawsIcon = (id: string) => isIconId(id) || id in MASK_ICONS;

/**
 * The mode picker's icon, compact as VS Code draws it (modePickerActionItem): Agent's `agent`, Ask's
 * `question`, Plan's `tasklist`; a custom agent has none (its name alone).
 */
export const MODE_CODICON: Record<ModeTone, string | null> = { agent: compactCodicon('agent'), ask: compactCodicon('question'), plan: compactCodicon('tasklist'), custom: null };

/** The mode menu's icons (the built-in modes' own, full size); custom agents have none. */
export const MODE_MENU_CODICON = { agent: 'agent', ask: 'question', plan: 'tasklist' } as const;

/**
 * The permission picker's icon per run mode (kingu-old's agent host picker, getConfigIcon): Manual
 * permissions a key, editing automatically Claude's `edit`, Allow all a warning.
 */
export const PERMISSION_CODICON: Record<AgentApproval, string> = { default: 'key', acceptEdits: 'edit', bypassPermissions: 'warning' };
