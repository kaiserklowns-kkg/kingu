/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
	agentShortName,
	agentStatusText,
	agentStatusView,
	countSessions,
	inFilter,
	layoutControlItems,
	layoutToggleIcon,
	overflowHidden,
	rightSideWidth,
	SEARCH_MIN_WIDTH,
	SEARCH_WIDTH,
	searchBoxLabel,
	searchTooltip,
	SessionHistory,
	sessionsAttentionLabel,
	statusAgents,
	switchMode,
	TITLE_BAR_TOGGLES,
	titleBarFit,
	titleBarHeight,
	titleBranch,
	titleToolbar,
	toggleChecked,
	TOOLBAR_MAX,
	type ModeState,
	type SessionState
} from './titlebar';

describe('title bar sizes and command center', () => {
	test('heights follow VS Code: 35 / 30 without command center, Agents 44 / 35 compact', () => {
		expect(titleBarHeight('workbench', { commandCenter: true, compactAgents: false })).toBe(35);
		expect(titleBarHeight('workbench', { commandCenter: false, compactAgents: true })).toBe(30);
		expect(titleBarHeight('agents', { commandCenter: false, compactAgents: false })).toBe(44);
		expect(titleBarHeight('agents', { commandCenter: true, compactAgents: true })).toBe(35);
	});

	test('search: "Search" and its key; a customised window title still wins', () => {
		expect(searchBoxLabel({ title: 'main.ts — kingu', customTitle: false })).toBe('Search');
		expect(searchBoxLabel({ title: 'main.ts — kingu', customTitle: true })).toBe('main.ts — kingu');
		expect(searchTooltip('⌘P')).toBe('Open Quick Access (⌘P)');
		expect(searchTooltip()).toBe('Open Quick Access');
	});
});

describe('project and branch', () => {
	test('the active repository: branch or detached head, * when dirty, the repository first when several', () => {
		expect(titleBranch({ repo: { branch: 'main' } })).toEqual({ label: 'main', interactive: true, tooltip: 'Switch Branch\nmain' });
		expect(titleBranch({ repo: { branch: 'main', dirty: true, name: 'kingu', multiple: true } })?.tooltip).toBe('Switch Branch\nkingu (Git) - main*');
		expect(titleBranch({ repo: { branch: null, head: 'a1b2c3d', detached: true } })).toEqual({ label: 'a1b2c3d', interactive: true, tooltip: 'Switch Branch\na1b2c3d (detached HEAD)' });
		expect(titleBranch({ repo: { branch: null, head: null } })).toBeNull();
	});

	test("no repository: the folder's branch; the Agents layout: the worktree's, shown only", () => {
		expect(titleBranch({ folderBranch: 'dev' })).toEqual({ label: 'dev', interactive: true, tooltip: 'Switch Branch' });
		expect(titleBranch({})).toBeNull();
		expect(titleBranch({ worktreeBranch: 'kingu/fix-x', repo: { branch: 'main' } })).toEqual({ label: 'kingu/fix-x', interactive: false, tooltip: "The selected worktree's branch" });
		expect(titleBranch({ worktreeBranch: null, repo: { branch: 'main' } })).toBeNull();
	});
});

describe('fitting the bar', () => {
	// kingu-old's window: 1140px; macOS traffic lights (78px) and a 150px project and branch; the
	// toolbar with Open in Agents (186px); back/forward and the Arkai button around the search (80px).
	const base = { width: 1140, leftWidth: 78 + 150, rightWidth: 186, contextWidth: 150, centerFixed: 22 + 4 + 22 + 4 + 4 + 24 };
	const sides = 20 + 228 + 186 + 80;

	test('wide: the search at its width', () => {
		expect(titleBarFit(base)).toEqual({ search: 'box', searchWidth: SEARCH_WIDTH });
	});

	test('narrower: the search narrows, then becomes an icon before the project and branch truncate', () => {
		// The left keeps its content (228 > 20% of 700): 700 - 20 - 228 - 186 - 80 = 186.
		expect(titleBarFit({ ...base, width: 700 })).toEqual({ search: 'box', searchWidth: 186 });
		expect(titleBarFit({ ...base, width: sides + SEARCH_MIN_WIDTH }).search).toBe('box');
		expect(titleBarFit({ ...base, width: sides + SEARCH_MIN_WIDTH - 1 })).toEqual({ search: 'icon', searchWidth: 0 });
		// The icon still fits: nothing truncates.
		expect(titleBarFit({ ...base, width: sides + 22 })).toEqual({ search: 'icon', searchWidth: 0 });
	});

	test('narrower still: the project and branch give back what the icon lacks, down to a floor', () => {
		expect(titleBarFit({ ...base, width: sides + 22 - 30 })).toEqual({ search: 'icon', searchWidth: 0, contextMaxWidth: 120 });
		expect(titleBarFit({ ...base, width: 400 }).contextMaxWidth).toBe(48);
		// No project open: nothing to truncate.
		expect(titleBarFit({ ...base, width: 400, leftWidth: 78, contextWidth: 0 })).toEqual({ search: 'icon', searchWidth: 0 });
	});

	test("the right side's natural width: items, 4px gaps, 4px padding and macOS's 8px", () => {
		const items = titleToolbar({ openInAgents: true, layout: layoutControlItems(true, 'both'), globalActions: true });
		expect(rightSideWidth(items, true)).toBe(24 + 6 * 22 + 6 * 4 + 4 + 8);
		expect(rightSideWidth(items, false)).toBe(24 + 6 * 22 + 6 * 4 + 4);
		expect(rightSideWidth([], true)).toBe(0);
	});
});

describe('agents status', () => {
	const s = (over: Partial<SessionState>): SessionState => ({ status: 'review', pending: 0, ...over });
	const sessions: SessionState[] = [
		s({ status: 'waiting', pending: 2 }),
		s({ status: 'running', pending: 1 }), // a pending request wins over running
		s({ status: 'running' }),
		s({ status: 'review', finishedAt: 200, viewedAt: 100 }), // unread
		s({ status: 'failed', finishedAt: 200 }), // unread, never viewed
		s({ status: 'review', finishedAt: 100, viewedAt: 300 }), // read
		s({ status: 'done', finishedAt: 500 })
	];

	test('counts needs input / in progress / unread', () => {
		expect(countSessions(sessions)).toEqual({ needsInput: 2, inProgress: 1, unread: 2 });
		expect(countSessions([])).toEqual({ needsInput: 0, inProgress: 0, unread: 0 });
		expect(sessions.filter((x) => inFilter(x, 'unread')).length).toBe(2);
		expect(sessions.filter((x) => inFilter(x, 'all')).length).toBe(sessions.length);
	});

	test('hidden shows nothing, badge a separate pill, compact the unified pill; zero sections are hidden', () => {
		const counts = { needsInput: 1, inProgress: 0, unread: 3 };
		expect(agentStatusView(counts, 'hidden')).toEqual({ visible: false, unified: false, sections: [] });
		// Badge: its own pill after the chat button, unread first (kingu-old's original order).
		const badge = agentStatusView(counts, 'badge');
		expect([badge.visible, badge.unified]).toEqual([true, false]);
		expect(badge.sections.map((x) => [x.id, x.count, x.text])).toEqual([
			['unread', 3, '3'],
			['needsInput', 1, '1 waiting for you']
		]);
		// Compact: inside the search pill, populating inward from needs input.
		const compact = agentStatusView({ needsInput: 1, inProgress: 2, unread: 3 }, 'compact');
		expect([compact.visible, compact.unified]).toEqual([true, true]);
		expect(compact.sections.map((x) => x.id)).toEqual(['needsInput', 'inProgress', 'unread']);
		// Nothing to report: the widget stays (the chat button), with no sections.
		expect(agentStatusView({ needsInput: 0, inProgress: 0, unread: 0 }, 'compact')).toEqual({ visible: true, unified: true, sections: [] });
		// Zen Mode hides it whatever the setting.
		expect(agentStatusView(counts, 'compact', { zen: true }).visible).toBe(false);
	});

	test('status in words: the agent by name when it is the only one, else the count', () => {
		expect([
			agentStatusText('working', ['Claude']),
			agentStatusText('working', ['Claude', 'Claude', 'Codex']),
			agentStatusText('waiting', ['Codex']),
			agentStatusText('waiting', ['Claude', undefined]),
			agentStatusText('working', [undefined])
		]).toEqual(['Claude working', '3 working', 'Codex waiting for you', '2 waiting for you', '1 working']);
		const agents = statusAgents([
			{ status: 'running', pending: 0, agent: 'Claude' },
			{ status: 'waiting', pending: 0, agent: 'Codex' },
			{ status: 'running', pending: 1, agent: 'Gemini' },
			{ status: 'review', pending: 0, finishedAt: 2, agent: 'Amp' },
			{ status: 'done', pending: 0, agent: 'Aider' }
		]);
		expect(agents).toEqual({ needsInput: ['Codex', 'Gemini'], inProgress: ['Claude'], unread: ['Amp'] });
		const view = agentStatusView({ needsInput: 2, inProgress: 1, unread: 1 }, 'compact', { agents });
		expect(view.sections.map((x) => x.text)).toEqual(['2 waiting for you', 'Claude working', '1']);
	});

	test('agent short names', () => {
		expect([
			agentShortName('claude-code'),
			agentShortName('cli:claude --model opus'),
			agentShortName('cli:codex --full-auto'),
			agentShortName('cli:copilot'),
			agentShortName('cli:my-agent'),
			agentShortName(''),
			agentShortName(undefined)
		]).toEqual(['Claude', 'Claude', 'Codex', 'Copilot', 'my-agent', undefined, undefined]);
	});

	test('session pill attention label', () => {
		expect(sessionsAttentionLabel(0)).toBeNull();
		expect(sessionsAttentionLabel(1)).toBe('1 session requires input');
		expect(sessionsAttentionLabel(3)).toBe('3 sessions require input');
	});
});

describe('layout controls and toolbar', () => {
	test('items per workbench.layoutControl.type', () => {
		expect(layoutControlItems(true, 'toggles')).toEqual(['toggleSidebar', 'togglePanel', 'toggleAuxiliaryBar']);
		expect(layoutControlItems(true, 'menu')).toEqual(['layoutMenu']);
		expect(layoutControlItems(true, 'both')).toEqual(['customizeLayout', 'toggleSidebar', 'togglePanel', 'toggleAuxiliaryBar']);
		expect(layoutControlItems(false, 'both')).toEqual([]);
	});

	test('toolbar order from the center outward; accounts/manage only with the activity bar elsewhere', () => {
		const layout = layoutControlItems(true, 'both');
		expect(titleToolbar({ openInAgents: true, layout, globalActions: false }).map((i) => i.id)).toEqual(['openInAgents', ...layout]);
		expect(titleToolbar({ openInAgents: false, layout: [], globalActions: true }).map((i) => i.id)).toEqual(['accounts', 'manage']);
		expect(titleToolbar({ openInAgents: true, layout, notifications: true, globalActions: true }).map((i) => i.id)).toEqual([
			'openInAgents',
			...layout,
			'notifications',
			'accounts',
			'manage'
		]);
		const many = titleToolbar({ openInAgents: true, layout: [...layout, ...layout, ...layout, ...layout], globalActions: true });
		expect(many.length).toBe(TOOLBAR_MAX);
	});

	test('overflow hides the items next to the center first', () => {
		const items = titleToolbar({ openInAgents: true, layout: layoutControlItems(true, 'both'), globalActions: true });
		// Open in Agents 24px, 6 items × 22px, 6 gaps × 4px = 180px.
		expect(overflowHidden(items, 180).size).toBe(0);
		expect([...overflowHidden(items, 179)]).toEqual(['openInAgents']);
		expect([...overflowHidden(items, 22 * 3 + 8)]).toEqual(['openInAgents', 'customizeLayout', 'toggleSidebar', 'togglePanel']);
		expect([...overflowHidden(items, 0)].length).toBe(items.length);
	});

	test("layout toggles: VS Code's icon ids, -off while hidden, the side bars trading icons on the right", () => {
		expect(layoutToggleIcon('toggleSidebar', false, false)).toBe('panel-left-off');
		expect(layoutToggleIcon('toggleSidebar', true, false)).toBe('panel-left');
		expect(layoutToggleIcon('toggleSidebar', true, true)).toBe('panel-right');
		expect(layoutToggleIcon('togglePanel', false, false)).toBe('panel-layout-icon-off');
		expect(layoutToggleIcon('togglePanel', true, true)).toBe('panel-layout-icon');
		expect(layoutToggleIcon('toggleAuxiliaryBar', true, false)).toBe('auxiliarybar-right-layout-icon');
		expect(layoutToggleIcon('toggleAuxiliaryBar', false, false)).toBe('auxiliarybar-right-off-layout-icon');
		expect(layoutToggleIcon('toggleAuxiliaryBar', false, true)).toBe('auxiliarybar-left-off-layout-icon');
	});

	test('context menu toggles and their settings', () => {
		expect(TITLE_BAR_TOGGLES.map((t) => t.label)).toEqual(['Command Center', 'Navigation Controls', 'Layout Controls', 'Agents Status', 'Open in Agents']);
		expect([toggleChecked(true), toggleChecked(false), toggleChecked('compact'), toggleChecked('badge'), toggleChecked('hidden')]).toEqual([true, false, true, true, false]);
	});
});

describe('Agents mode', () => {
	test('session history: back, forward, a new session drops the forward stack, removal', () => {
		const h = new SessionHistory();
		expect([h.canGoBack, h.canGoForward, h.current]).toEqual([false, false, null]);
		h.record('a');
		h.record('b');
		h.record('b');
		h.record('c');
		expect(h.back()).toBe('b');
		expect(h.back()).toBe('a');
		expect(h.back()).toBeNull();
		expect(h.forward()).toBe('b');
		h.record('d');
		expect(h.canGoForward).toBe(false);
		expect(h.back()).toBe('b');
		h.remove('b');
		expect(h.current).toBe('a');
		expect(h.forward()).toBe('d');
	});

	test('switching modes keeps the workbench layout and editors, and the Agents layout parts', () => {
		const start: ModeState = {
			mode: 'workbench',
			workbench: { sidebarVisible: false, panelVisible: true, auxVisible: false, activeEditor: 'src/main.ts' },
			agents: { sessionsVisible: false, panelVisible: true, activeSession: 'fix-bug' }
		};
		const agents = switchMode(start);
		expect(agents.mode).toBe('agents');
		expect(agents.workbench).toEqual(start.workbench);
		expect(agents.agents).toEqual(start.agents);
		const back = switchMode(agents);
		expect(back).toEqual(start);
		expect(switchMode(start, 'workbench')).toEqual(start);
	});
});
