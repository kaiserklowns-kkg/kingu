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
 * The search control's label. kingu-old's pill said "Search files and commands" behind the project
 * and branch; Kingu shows those as title bar controls of their own, so the search says "Search"
 * (its key beside it). A customised `window.title` still wins, as in VS Code's command center.
 */
export function searchBoxLabel(opts: { title: string; customTitle: boolean }): string {
	return opts.customTitle ? opts.title : t('titleBar.search');
}

/** The search control's tooltip, kingu-old's `Open Quick Access (⌘P)`. */
export function searchTooltip(quickOpenKey?: string): string {
	return quickOpenKey ? `${t('titleBar.openQuickAccess')} (${quickOpenKey})` : t('titleBar.openQuickAccess');
}

// --- Project and branch ------------------------------------------------------------------------

export type TitleBranch = {
	/** What the control shows: the branch (or detached head), `*` when the working tree has changes. */
	label: string;
	/** Opens the branch picker (Git: Checkout to...); a worktree's branch in the Agents layout only shows. */
	interactive: boolean;
	/** Tooltip, with what the status bar's branch item (which this replaces) said. */
	tooltip: string;
};

/** The repository the branch control describes (the workbench's active one). */
export type TitleRepo = { branch?: string | null; head?: string | null; detached?: boolean; dirty?: boolean; name?: string; multiple?: boolean };

/**
 * The title bar's branch control, which replaces the status bar's branch item: the selected
 * worktree's branch in the Agents layout (`worktreeBranch` given), else the active repository's
 * (its branch or detached head, `*` when dirty, its name first when there are several), else the
 * folder's branch.
 */
export function titleBranch(opts: { worktreeBranch?: string | null; repo?: TitleRepo | null; folderBranch?: string | null }): TitleBranch | null {
	if (opts.worktreeBranch !== undefined) {
		return opts.worktreeBranch ? { label: opts.worktreeBranch, interactive: false, tooltip: t('titleBar.worktreeBranch') } : null;
	}
	const r = opts.repo;
	if (r) {
		const name = r.branch ?? r.head;
		if (!name) return null;
		const label = `${name}${r.dirty ? '*' : ''}`;
		const where = r.multiple && r.name ? `${r.name} (Git) - ` : '';
		const detached = r.detached ? ` ${t('titleBar.detached')}` : '';
		return { label, interactive: true, tooltip: `${t('titleBar.switchBranch')}\n${where}${label}${detached}` };
	}
	return opts.folderBranch ? { label: opts.folderBranch, interactive: true, tooltip: t('titleBar.switchBranch') } : null;
}

// --- Fitting the bar ---------------------------------------------------------------------------

/** VS Code's `.titlebar-center` margin, each side. */
export const CENTER_MARGIN = 10;
/** The search control's width when there is room, and the least it narrows to before it becomes an icon. */
export const SEARCH_WIDTH = 240;
export const SEARCH_MIN_WIDTH = 120;
/** The collapsed search: one title bar action. */
export const SEARCH_ICON_WIDTH = 22;
/** The project and branch controls never shrink below this together (their icons and an ellipsis stay). */
export const CONTEXT_MIN_WIDTH = 48;

export type TitleBarFit = {
	search: 'box' | 'icon';
	/** The search box's width (`box`; 0 for the icon). */
	searchWidth: number;
	/** A cap on the project and branch controls, only when even the search icon does not fit. */
	contextMaxWidth?: number;
};

/**
 * How the center fits between the sides (VS Code titlebarpart.css: left and right 20% each but never
 * below their content, the center what is left less its 10px margins). The search gives way first:
 * it narrows to SEARCH_MIN_WIDTH, then becomes an icon; only then do the project and branch labels
 * truncate. `leftWidth` / `rightWidth`: the sides' natural content widths (the left's includes
 * `contextWidth`, the project and branch); `centerFixed`: the center's content besides the search.
 */
export function titleBarFit(opts: { width: number; leftWidth: number; rightWidth: number; contextWidth: number; centerFixed: number }): TitleBarFit {
	const side = (w: number) => Math.max(opts.width * 0.2, w);
	const room = opts.width - CENTER_MARGIN * 2 - side(opts.leftWidth) - side(opts.rightWidth) - opts.centerFixed;
	if (room >= SEARCH_MIN_WIDTH) return { search: 'box', searchWidth: Math.min(SEARCH_WIDTH, Math.floor(room)) };
	const deficit = SEARCH_ICON_WIDTH - room;
	// Only the left's overflow past its 20% share comes back by truncating it.
	const give = Math.min(deficit, opts.leftWidth - opts.width * 0.2);
	if (deficit <= 0 || opts.contextWidth <= 0 || give <= 0) return { search: 'icon', searchWidth: 0 };
	return { search: 'icon', searchWidth: 0, contextMaxWidth: Math.max(CONTEXT_MIN_WIDTH, Math.floor(opts.contextWidth - give)) };
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

/** A layout toggle in the title bar. */
export type LayoutToggle = 'toggleSidebar' | 'togglePanel' | 'toggleAuxiliaryBar';

/**
 * A layout toggle's icon id (VS Code layoutActions.ts, panelActions.ts, auxiliaryBarActions.ts: the
 * `toggled` icon while the part shows, the `-off` one while it is hidden). With the side bar on the
 * right the two side bars trade icons.
 */
export function layoutToggleIcon(id: LayoutToggle, on: boolean, sidebarRight: boolean): string {
	if (id === 'togglePanel') return on ? 'panel-layout-icon' : 'panel-layout-icon-off';
	if (id === 'toggleSidebar') return `panel-${sidebarRight ? 'right' : 'left'}${on ? '' : '-off'}`;
	return `auxiliarybar-${sidebarRight ? 'left' : 'right'}${on ? '' : '-off'}-layout-icon`;
}

// --- Right toolbar and overflow ----------------------------------------------------------------

/** VS Code caps the title bar's action toolbar at 12 items. */
export const TOOLBAR_MAX = 12;
export const TOOLBAR_GAP = 4;
/** A title bar action: 22px (a 16px icon, 3px padding), as in kingu-old. */
export const ICON_ITEM_WIDTH = 22;
/** Open in Agents at rest: its 16px tile and 4px padding each side. */
export const OPEN_IN_AGENTS_WIDTH = 24;

export type ToolbarItem = { id: string; width: number };

/** The right toolbar, from the center outward: Open in Agents, layout controls, notifications, accounts, manage. */
export function titleToolbar(opts: { openInAgents: boolean; layout: LayoutControlItem[]; notifications?: boolean; globalActions: boolean }): ToolbarItem[] {
	const ids: string[] = [];
	if (opts.openInAgents) ids.push('openInAgents');
	ids.push(...opts.layout);
	if (opts.notifications) ids.push('notifications');
	if (opts.globalActions) ids.push('accounts', 'manage');
	return ids.slice(0, TOOLBAR_MAX).map((id) => ({ id, width: id === 'openInAgents' ? OPEN_IN_AGENTS_WIDTH : ICON_ITEM_WIDTH }));
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

/**
 * The right side's natural width: its items and gaps, the toolbar's 4px right padding and, on macOS,
 * the 8px VS Code shifts it in by (`right: 8px`), so the last icon ends 12px from the edge.
 */
export function rightSideWidth(items: ToolbarItem[], mac: boolean, gap = TOOLBAR_GAP): number {
	if (!items.length) return 0;
	return items.reduce((w, i) => w + i.width, 0) + (items.length - 1) * gap + 4 + (mac ? 8 : 0);
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
