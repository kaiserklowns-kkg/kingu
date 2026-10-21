// The settings groups the system settings page shows as Orca panes (its SettingsSection: icon in
// the table of contents, big title and description, settings in one card, label left / control
// right) instead of the VS Code settings editor: Orca's own areas, the AI Capabilities and ADE
// sections. The IDE and system groups keep VS Code's editor.

import type { IconName } from '../workbench/Icon.svelte';
import type { Locale, MessageKey } from '../i18n/index';

/** A pane's description: a `settings.pane.*` text without parameters. */
type PaneText = Exclude<Extract<MessageKey, `settings.pane.${string}`>, 'settings.pane.project'>;

/** `title`: the name in the table of contents and over the pane when it is not the group's (Orca's "Agents"). */
export type Pane = { icon: IconName; description: PaneText; title?: string };

export const PANES: Readonly<Record<string, Pane>> = {
	Agent: { icon: 'agent', description: 'settings.pane.agent', title: 'Agents' },
	Orchestration: { icon: 'agentsLayout', description: 'settings.pane.orchestration' },
	Voice: { icon: 'mic', description: 'settings.pane.voice' },
	'Local AI': { icon: 'cpu', description: 'settings.pane.localAi' },
	'Agent Chat': { icon: 'chat', description: 'settings.pane.agentChat' },
	Notifications: { icon: 'bell', description: 'settings.pane.notifications' },
	Worktrees: { icon: 'branch', description: 'settings.pane.worktrees' },
	Repository: { icon: 'code', description: 'settings.pane.repository' },
	'ADE Sidebar': { icon: 'sidebarLeft', description: 'settings.pane.adeSidebar' },
	'ADE Terminal': { icon: 'terminal', description: 'settings.pane.adeTerminal' },
	'Source Control AI': { icon: 'sparkle', description: 'settings.pane.sourceControlAi' },
	'Pull Requests': { icon: 'pullRequest', description: 'settings.pane.pullRequests' }
};

export const isPane = (group: string | null): group is string => group !== null && Object.hasOwn(PANES, group);

/**
 * The table of contents selection of the open folder's project pane (Orca's per-project settings
 * under Projects): its repository-scope values of the groups below.
 */
export const PROJECT_PANE = '@project';
export const PROJECT_GROUPS = ['Repository', 'Worktrees', 'Source Control AI', 'Pull Requests'];

/**
 * An entry of Orca's part of the table of contents: a dedicated page, a settings group (a pane of
 * rows), or an Orca pane drawn from its spec (orcaPane.ts ORCA_PANES).
 */
export type NavItem = { page: string } | { group: string } | { pane: string };

/**
 * The top of the table of contents in Orca's sidebar order (AI Capabilities, Set Up, Workflows,
 * Interface), holding Kingu's dedicated pages and the AI and ADE panes; VS Code's part (all
 * settings, System, IDE, Snaps) follows it, then Projects.
 */
export const ORCA_NAV: readonly {
	id: string;
	label: 'settings.sections.aiCapabilities' | 'settings.nav.setup' | 'settings.nav.workflows' | 'settings.nav.interface' | 'panes.advanced.title' | 'panes.experimental.title';
	items: readonly NavItem[];
}[] = [
	{
		id: 'ai',
		label: 'settings.sections.aiCapabilities',
		items: [{ group: 'Agent' }, { page: 'arkai' }, { page: 'accounts' }, { group: 'Orchestration' }, { page: 'voice' }, { page: 'mcp' }, { page: 'skills' }, { page: 'memories' }, { group: 'Local AI' }]
	},
	{ id: 'setup', label: 'settings.nav.setup', items: [{ page: 'account' }, { pane: 'general' }] },
	{ id: 'workflows', label: 'settings.nav.workflows', items: [{ pane: 'automations' }, { pane: 'git' }, { pane: 'terminal' }, { pane: 'floating' }] },
	{
		id: 'interface',
		label: 'settings.nav.interface',
		items: [{ pane: 'appearance' }, { pane: 'chat' }, { pane: 'input' }, { pane: 'notifications' }, { page: 'shortcuts' }, { page: 'usage' }]
	},
	{ id: 'advanced', label: 'panes.advanced.title', items: [{ pane: 'advanced' }] },
	{ id: 'experimental', label: 'panes.experimental.title', items: [{ pane: 'experimental' }] }
];

/** Groups a dedicated page shows (the Voice page draws the Voice group's settings). */
export const PAGE_GROUPS: readonly string[] = ['Voice'];

/** Sections of the registry's table of contents that ORCA_NAV shows instead. */
export const ORCA_SECTION_IDS = new Set(['ai', 'ade']);

const REFERENCE = /\s*\((?:VS Code|Cursor|Orca|Claude Code)[^()]*(?:\([^()]*\)[^()]*)*\)/g;

/**
 * A registry description in the UI language: they read "ไทย (English.)", with the source setting
 * named as "(VS Code: …)" or "(Orca: …)". Orca's rows say it once, so this keeps one language and
 * drops the references; a text without a trailing English part is returned as it is.
 */
export function paneText(text: string, locale: Locale): string {
	if (!text.endsWith(')')) return text;
	let depth = 0;
	let i = text.length - 1;
	for (; i >= 0; i--) {
		if (text[i] === ')') depth++;
		else if (text[i] === '(' && --depth === 0) break;
	}
	const thai = text.slice(0, i).trim();
	const english = text.slice(i + 1, -1).trim();
	if (i <= 0 || !/[\u0E00-\u0E7F]/.test(thai) || /[\u0E00-\u0E7F]/.test(english)) return text.replace(REFERENCE, '');
	return (locale === 'th' ? thai : english).replace(REFERENCE, '').trim();
}

/** A setting's row label from its id, with acronyms as written (`kingu.agent.ask.mcpTools` → "MCP Tools"). */
export const paneLabel = (label: string) => label.replace(/\b(Mcp|Ai|Cli|Pr|Prs|Tui|Acp|Url|Api|Jis|Osc52|Fim|Id)\b/g, (w) => w.toUpperCase());

/** Settings the Agent pane's catalog (pages/AgentCatalog.svelte) edits, so they are not rows too. */
export const AGENT_CATALOG_IDS = ['kingu.agent.cli', 'kingu.agent.cliPermissions', 'kingu.agent.disabled', 'kingu.agent.cmdOverrides', 'kingu.agent.args.*', 'kingu.agent.env.*'];

/** Dedicated pages with a badge in the table of contents (Orca marks AI Provider Accounts optional). */
export const PAGE_BADGES: Readonly<Partial<Record<string, 'settings.page.optional'>>> = { accounts: 'settings.page.optional' };
