// Title bar model (VS Code: browser/parts/titlebar/titlebarPart.ts, commandCenterControl.ts, the
// agent status widget of the chat contribution, layout controls). Pure, so it is unit-testable;
// TitleBar.svelte and AgentsTitleBar.svelte render it.

import type { TaskStatus } from '#lib/ade/model.ts';
import { cliOf } from '#lib/ade/agentCli.ts';
import { profileOf, programOf } from '#lib/ade/agentProfiles.ts';
import { t } from '#lib/i18n/index.ts';

// --- Sizes -------------------------------------------------------------------------------------

export type AppMode = 'workbench' | 'agents';

/** VS Code: 35px with the command center, 30px without; the Agents layout 44px (35px compact). */
export function titleBarHeight(mode: AppMode, opts: { commandCenter: boolean; compactAgents: boolean }): number {
	if (mode === 'agents') return opts.compactAgents ? 35 : 44;
	return opts.commandCenter ? 35 : 30;
}

// --- Command center ----------------------------------------------------------------------------

/**
 * The search pill's label: the workspace name, or the whole window title when `window.title` is
 * customised, or "Search" with no folder open (VS Code commandCenterControl).
 */
export function commandCenterLabel(opts: { folderName: string | null | undefined; title: string; customTitle: boolean }): string {
	if (opts.customTitle) return opts.title;
	return opts.folderName || 'Search';
}

/**
 * The compact (unified) pill's placeholder (kingu-old agentTitleBarStatusWidget + kinguTitleBarContext):
 * with a folder open the project and branch buttons name it, so the search reads "Search files and
 * commands"; a customised `window.title` still wins; "Search" with no folder.
 */
export function compactSearchLabel(opts: { folderName: string | null | undefined; title: string; customTitle: boolean }): string {
	if (opts.customTitle) return opts.title;
	return opts.folderName ? t('titleBar.searchFilesAndCommands') : t('titleBar.search');
}

/** `Search kingu (⌘P) — Show and Run Commands (⇧⌘P)`. */
export function commandCenterTooltip(opts: { folderName: string | null | undefined; quickOpenKey?: string; commandsKey?: string }): string {
	const what = opts.folderName ? `Search ${opts.folderName}` : 'Search';
	const qo = opts.quickOpenKey ? ` (${opts.quickOpenKey})` : '';
	const cmds = opts.commandsKey ? ` — Show and Run Commands (${opts.commandsKey})` : '';
	return `${what}${qo}${cmds}`;
}

// --- Agents status widget ----------------------------------------------------------------------

/** `kingu.agentsControl.enabled`. */
export type AgentsControlMode = 'hidden' | 'badge' | 'compact';
export const AGENTS_CONTROL_MODES: readonly AgentsControlMode[] = ['hidden', 'badge', 'compact'];

/** Groups the Agents layout can be filtered to (a status section click). */
export type AgentsFilter = 'all' | 'needsInput' | 'inProgress' | 'unread';

export type AgentCounts = { needsInput: number; inProgress: number; unread: number };

/** One agent session as the widget sees it. */
export type SessionState = {
	status: TaskStatus;
	/** Unanswered permission requests. */
	pending: number;
	/** Unix ms the run last finished a turn (review/failed). */
	finishedAt?: number;
	/** Unix ms the user last looked at the session. */
	viewedAt?: number;
};

/** Needs input: waiting for a permission answer. In progress: working. Unread: finished since last viewed. */
export function countSessions(sessions: SessionState[]): AgentCounts {
	const out: AgentCounts = { needsInput: 0, inProgress: 0, unread: 0 };
	for (const s of sessions) {
		if (s.pending > 0 || s.status === 'waiting') out.needsInput++;
		else if (s.status === 'running') out.inProgress++;
		else if ((s.status === 'review' || s.status === 'failed') && (s.finishedAt ?? 0) > (s.viewedAt ?? 0)) out.unread++;
	}
	return out;
}

/** Whether a session belongs in a filtered group. */
export function inFilter(s: SessionState, filter: AgentsFilter): boolean {
	if (filter === 'all') return true;
	const c = countSessions([s]);
	return c[filter] > 0;
}

export type StatusSection = {
	id: Exclude<AgentsFilter, 'all'>;
	count: number;
	label: string;
	title: string;
	/** What the section shows after its icon: "Claude working", "2 waiting for you", or the unread count. */
	text: string;
};

const SECTION_TEXT: Record<StatusSection['id'], [label: () => string, title: (n: number) => string]> = {
	needsInput: [() => t('workbench.titlebar.needsInput'), (count) => t('workbench.titlebar.needsInputTitle', { count })],
	inProgress: [() => t('workbench.titlebar.inProgress'), (count) => t('workbench.titlebar.inProgressTitle', { count })],
	unread: [() => t('workbench.titlebar.unread'), (count) => t('workbench.titlebar.unreadTitle', { count })]
};

/**
 * A status in words (kingu-old's title bar): the agent's name when one session is in it
 * ("Claude working", "Codex waiting for you"), the count when several are or the name is unknown.
 */
export function agentStatusText(kind: 'working' | 'waiting', names: readonly (string | undefined)[]): string {
	const name = names.length === 1 ? names[0] : undefined;
	if (name) return t(kind === 'working' ? 'titleBar.working.one' : 'titleBar.waiting.one', { name });
	return t(kind === 'working' ? 'titleBar.working.many' : 'titleBar.waiting.many', { count: names.length });
}

/** "Claude" / "Codex" / "Gemini" for a task's `agent` (`cli:<command>`, or a timeline agent id like `claude-code`). */
export function agentShortName(agent: string | null | undefined): string | undefined {
	if (!agent) return undefined;
	if (agent.startsWith('cli:')) {
		const argv = cliOf(agent);
		if (!argv) return undefined;
		const profile = profileOf(argv);
		if (profile.id === 'custom') return programOf(argv) || undefined;
		return profile.title.replace(/^GitHub /, '').replace(/ (CLI|Code|Agent)$/, '');
	}
	const word = agent.split(/[-_:\s]/)[0];
	return word ? word[0].toUpperCase() + word.slice(1) : undefined;
}

/** A session with the short name of its agent, for the status words. */
export type NamedSession = SessionState & { agent?: string };

/** The agents' names in each status group, in session order (an unknown agent is `undefined`). */
export function statusAgents(sessions: readonly NamedSession[]): Record<StatusSection['id'], (string | undefined)[]> {
	const out: Record<StatusSection['id'], (string | undefined)[]> = { needsInput: [], inProgress: [], unread: [] };
	for (const s of sessions) {
		const c = countSessions([s]);
		const id = c.needsInput ? 'needsInput' : c.inProgress ? 'inProgress' : c.unread ? 'unread' : null;
		if (id) out[id].push(s.agent);
	}
	return out;
}

export type AgentStatusView = {
	visible: boolean;
	/** `compact`: the status sits inside the search pill and the Arkai chat button stands beside it. */
	unified: boolean;
	/**
	 * Sections with a non-zero count. Compact (inside the pill, populating inward): needs input, in
	 * progress, unread. Badge (its own pill, after the chat button): unread, in progress, needs input.
	 */
	sections: StatusSection[];
};

export function agentStatusView(
	counts: AgentCounts,
	mode: AgentsControlMode,
	opts: { agents?: Record<StatusSection['id'], (string | undefined)[]>; zen?: boolean } = {}
): AgentStatusView {
	// Zen Mode hides every agent distraction, like kingu-old.
	if (mode === 'hidden' || opts.zen) return { visible: false, unified: false, sections: [] };
	const order = mode === 'compact' ? (['needsInput', 'inProgress', 'unread'] as const) : (['unread', 'inProgress', 'needsInput'] as const);
	const words = (id: StatusSection['id'], count: number): string => {
		if (id === 'unread') return String(count);
		const names = opts.agents?.[id];
		const known = names && names.length === count ? names : Array.from({ length: count }, () => undefined);
		return agentStatusText(id === 'inProgress' ? 'working' : 'waiting', known);
	};
	const sections = order
		.filter((id) => counts[id] > 0)
		.map((id) => ({ id, count: counts[id], label: SECTION_TEXT[id][0](), title: SECTION_TEXT[id][1](counts[id]), text: words(id, counts[id]) }));
	return { visible: true, unified: mode === 'compact', sections };
}

/** The Agents layout's session pill: "N sessions require input" takes over from the workspace label. */
export function sessionsAttentionLabel(needsInput: number): string | null {
	if (needsInput <= 0) return null;
	return t('workbench.titlebar.sessionsNeedInput', { count: needsInput });
}

// --- Layout controls ---------------------------------------------------------------------------

export type LayoutControlType = 'toggles' | 'menu' | 'both';
/** `layoutMenu`: the Configure Layout menu button; `customizeLayout`: the Customize Layout... button. */
export type LayoutControlItem = 'customizeLayout' | 'toggleSidebar' | 'togglePanel' | 'toggleAuxiliaryBar' | 'layoutMenu';

/**
 * `workbench.layoutControl.type` (VS Code layoutActions): the three toggles; one Configure Layout
 * menu button; or both, which is Customize Layout... (it opens the layout picker straight away)
 * followed by the three toggles.
 */
export function layoutControlItems(enabled: boolean, type: LayoutControlType): LayoutControlItem[] {
	if (!enabled) return [];
	const toggles: LayoutControlItem[] = ['toggleSidebar', 'togglePanel', 'toggleAuxiliaryBar'];
	if (type === 'toggles') return toggles;
	if (type === 'menu') return ['layoutMenu'];
	return ['customizeLayout', ...toggles];
}

// --- Right toolbar and overflow ----------------------------------------------------------------

/** VS Code caps the title bar's action toolbar at 12 items. */
export const TOOLBAR_MAX = 12;
export const TOOLBAR_GAP = 4;
export const ICON_ITEM_WIDTH = 24;

export type ToolbarItem = { id: string; width: number };

/** The right toolbar, from the center outward: Open in Agents, layout controls, notifications, accounts, manage. */
export function titleToolbar(opts: { openInAgents: boolean; layout: LayoutControlItem[]; notifications?: boolean; globalActions: boolean }): ToolbarItem[] {
	const ids: string[] = [];
	if (opts.openInAgents) ids.push('openInAgents');
	ids.push(...opts.layout);
	if (opts.notifications) ids.push('notifications');
	if (opts.globalActions) ids.push('accounts', 'manage');
	return ids.slice(0, TOOLBAR_MAX).map((id) => ({ id, width: ICON_ITEM_WIDTH }));
}

/**
 * Items (ordered from the center outward) that do not fit in `available` px. Like VS Code's
 * `.overflowing` title bar, the ones next to the center go first so the outermost (accounts,
 * manage) stay reachable.
 */
export function overflowHidden(items: ToolbarItem[], available: number, gap = TOOLBAR_GAP): Set<string> {
	const hidden = new Set<string>();
	const width = (list: ToolbarItem[]) => list.reduce((w, i) => w + i.width, 0) + Math.max(0, list.length - 1) * gap;
	let shown = [...items];
	while (shown.length && width(shown) > available) {
		hidden.add(shown[0].id);
		shown = shown.slice(1);
	}
	return hidden;
}

// --- Title bar context menu --------------------------------------------------------------------

export type TitleBarToggle = { command: string; label: string; setting: string };

/** Right-click on the title bar (VS Code: MenuId.TitleBarContext). Each writes its setting. */
export const TITLE_BAR_TOGGLES: TitleBarToggle[] = [
	{ command: 'workbench.action.toggleCommandCenter', label: 'Command Center', setting: 'window.commandCenter' },
	{ command: 'workbench.action.toggleNavigationControl', label: 'Navigation Controls', setting: 'workbench.navigationControl.enabled' },
	{ command: 'workbench.action.toggleLayoutControl', label: 'Layout Controls', setting: 'workbench.layoutControl.enabled' },
	{ command: 'kingu.action.toggleAgentsControl', label: 'Agents Status', setting: 'kingu.agentsControl.enabled' },
	{ command: 'kingu.action.toggleOpenInAgents', label: 'Open in Agents', setting: 'kingu.titleBar.openInAgents.enabled' }
];

/** Checked state of a toggle from its setting value (the agents control is "on" unless hidden). */
export const toggleChecked = (value: unknown) => (typeof value === 'string' ? value !== 'hidden' : value === true);

// --- Session history (Agents layout back / forward) --------------------------------------------

/** Back/forward through the sessions shown in the Agents layout (VS Code's agent session history). */
export class SessionHistory {
	#stack: string[] = [];
	#index = -1;
	static readonly LIMIT = 50;

	get current(): string | null {
		return this.#stack[this.#index] ?? null;
	}
	get canGoBack() {
		return this.#index > 0;
	}
	get canGoForward() {
		return this.#index < this.#stack.length - 1;
	}

	record(slug: string) {
		if (this.current === slug) return;
		this.#stack = [...this.#stack.slice(0, this.#index + 1), slug].slice(-SessionHistory.LIMIT);
		this.#index = this.#stack.length - 1;
	}

	back(): string | null {
		if (!this.canGoBack) return null;
		return this.#stack[--this.#index];
	}

	forward(): string | null {
		if (!this.canGoForward) return null;
		return this.#stack[++this.#index];
	}

	/** Drops a removed session (and adjacent duplicates left behind); removing the current one goes back. */
	remove(slug: string) {
		const next: string[] = [];
		let index = -1;
		this.#stack.forEach((s, i) => {
			if (s !== slug && next[next.length - 1] !== s) next.push(s);
			if (i === this.#index) index = next.length - 1;
		});
		this.#stack = next;
		this.#index = index;
	}
}

// --- Mode switching ----------------------------------------------------------------------------

/** Parts of the app state a mode switch must leave alone (the workbench's layout and editors). */
export type ModeState = {
	mode: AppMode;
	workbench: { sidebarVisible: boolean; panelVisible: boolean; auxVisible: boolean; activeEditor: string | null };
	agents: { sessionsVisible: boolean; panelVisible: boolean; activeSession: string | null };
};

/** Switching only flips `mode`; workbench layout and editors, and the Agents layout's own parts, are kept. */
export function switchMode(state: ModeState, to: AppMode = state.mode === 'agents' ? 'workbench' : 'agents'): ModeState {
	return { ...state, mode: to };
}
