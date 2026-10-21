<script lang="ts">
	// The command center, laid out like kingu-old's (VS Code: MenuId.CommandCenter, commandCenterControl.ts,
	// and the chat contribution's agent status widget, agentTitleBarStatusWidget.ts): Back / Forward,
	// the search, then the Arkai chat button. The project and branch are not in here (kingu-old put them
	// at the front of the pill): TitleBar.svelte shows them as controls of their own on the left.
	// The search is a compact control, "Search" and its key (⌘P), opening Quick Open; it collapses to a
	// search icon when the bar is too narrow (`search`, from titleBarFit). `kingu.agentsControl.enabled`:
	// - compact (default): the agents status (needs input, in progress, unread) inside the search
	//   pill, after the search; the Arkai chat button stands on its own after it.
	// - badge: the search, then a separate badge with the Arkai chat button first and the status after it.
	// - hidden (or Zen Mode): no status; the Arkai chat button still stands after the search (not in Zen).
	// A status section opens the Agents layout filtered to that group; clicking it again clears the filter.
	// The Arkai button toggles the chat (the secondary side bar); right-click or ↓ opens its menu.
	import Codicon from './Codicon.svelte';
	import PopupMenu, { menuItem, menuSeparator } from './PopupMenu.svelte';
	import { commands, keyOf } from './commands.svelte';
	import { keyLabel } from './keys';
	import { layout } from './layout.svelte';
	import { navigation } from './navigation.svelte';
	import { agentShortName, agentStatusView, searchTooltip, statusAgents, type AgentsControlMode, type StatusSection } from './titlebar';
	import type { MenuNode } from './menus';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { adeTasks } from '#lib/ade/tasks.svelte.ts';
	import { projects } from '#lib/ade/projects.svelte.ts';
	import { openAgents } from '#lib/ade/agentsMode.svelte.ts';
	import { appMode } from './mode.svelte';
	import DebugToolbar from '#lib/debug/DebugToolbar.svelte';
	import { t } from '#lib/i18n/index.ts';

	let {
		label,
		hasFolder,
		search = 'box',
		searchWidth,
		fixedWidth = $bindable(0)
	}: {
		/** The search's label ("Search", or the customised window title). */
		label: string;
		/** A folder is open (kingu-old hides the unread section in an empty window). */
		hasFolder: boolean;
		/** The search as a box, or collapsed to its icon. */
		search?: 'box' | 'icon';
		/** The search box's width in px. */
		searchWidth?: number;
		/** Out: this control's width besides the search, for TitleBar's fitting. */
		fixedWidth?: number;
	} = $props();

	const key = (command: string) => {
		const cmd = commands.get(command);
		const k = cmd && keyOf(cmd);
		return k ? keyLabel(k) : undefined;
	};
	const hint = (command: string) => (key(command) ? ` (${key(command)})` : '');
	const title = (command: string, fallback: string) => commands.get(command)?.title ?? fallback;

	const navigationControl = $derived(settings.get<boolean>('workbench.navigationControl.enabled'));
	const agentsMode = $derived(settings.get<AgentsControlMode>('kingu.agentsControl.enabled'));

	// Each session's agent by name, so one session reads "Claude working" rather than "1 working".
	const agentOf = $derived.by(() => {
		const map = new Map<string, string | undefined>();
		for (const v of adeTasks.views) map.set(v.meta.slug, agentShortName(v.meta.agent));
		for (const p of projects.all) map.set(p.view.meta.slug, agentShortName(p.view.meta.agent));
		return map;
	});
	const agents = $derived(statusAgents(adeTasks.sessionStates.map((s) => ({ ...s, agent: agentOf.get(s.slug) }))));
	const view = $derived(agentStatusView(adeTasks.counts, agentsMode, { agents, zen: layout.zen }));
	const sections = $derived(view.sections.filter((s) => hasFolder || s.id !== 'unread'));
	const quickOpenKey = $derived(key('workbench.action.quickOpen'));
	const tooltip = $derived(searchTooltip(quickOpenKey));
	// The badge holds the Arkai button; otherwise it stands alone after the search (not in Zen Mode).
	const badge = $derived(view.visible && !view.unified);
	const standaloneArkai = $derived(!badge && !layout.zen);

	// --- Fitting ---------------------------------------------------------------------------------
	let root: HTMLDivElement | undefined = $state();
	let searchEl: HTMLElement | undefined = $state();
	$effect(() => {
		if (!root) return;
		const measure = () => (fixedWidth = Math.max(0, (root?.offsetWidth ?? 0) - (searchEl?.offsetWidth ?? 0)));
		const ro = new ResizeObserver(measure);
		ro.observe(root);
		if (searchEl) ro.observe(searchEl);
		measure();
		return () => ro.disconnect();
	});

	// --- Status filters ----------------------------------------------------------------------------
	// The filter a section click applied here; cleared again once its group empties (kingu-old restores
	// the previous filter the same way, and only the one it applied itself).
	let applied = $state<StatusSection['id'] | null>(null);
	const filtered = (id: StatusSection['id']) => appMode.isAgents && appMode.filter === id;
	function toggleFilter(id: StatusSection['id']) {
		if (filtered(id)) {
			appMode.filter = 'all';
			applied = null;
			return;
		}
		applied = id;
		openAgents(id);
	}
	$effect(() => {
		if (applied && adeTasks.counts[applied] === 0) {
			if (appMode.filter === applied) appMode.filter = 'all';
			applied = null;
		}
	});

	// --- The Arkai chat button's menu ----------------------------------------------------------------
	let menu = $state<{ x: number; y: number; keyboard: boolean } | null>(null);
	const menuItems = $derived<MenuNode[]>([
		menuItem('workbench.action.chat.open', title('workbench.action.chat.open', 'Open Chat'), { keyLabel: key('workbench.action.chat.open') }),
		menuItem('workbench.action.chat.newChat', title('workbench.action.chat.newChat', 'New Chat'), { keyLabel: key('workbench.action.chat.newChat') }),
		menuItem('workbench.action.chat.history', title('workbench.action.chat.history', 'Show Chats...'), { keyLabel: key('workbench.action.chat.history') }),
		menuSeparator,
		menuItem('kingu.agents.newTask', 'New Task', { enabled: commands.enabled('kingu.agents.newTask') }),
		menuItem('kingu.agents.show', 'Show Agents'),
		menuItem('kingu.agents.openBoard', 'Board', { enabled: commands.enabled('kingu.agents.openBoard') }),
		menuSeparator,
		menuItem('workbench.action.toggleAgentsMode', appMode.isAgents ? 'Open in Editor' : 'Open in Agents', { keyLabel: key('workbench.action.toggleAgentsMode') }),
		menuSeparator,
		menuItem('kingu.agents.settings', 'Agent Settings')
	]);

	function runMenu(node: MenuNode) {
		if (node.type !== 'item') return;
		if (node.id === 'kingu.agents.settings') void commands.run('workbench.action.openSettings');
		else void commands.run(node.id);
	}

	const toggleChat = () => void commands.run('workbench.action.toggleAuxiliaryBar');
	function chatContextMenu(e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		menu = { x: e.clientX, y: e.clientY, keyboard: false };
	}
	function chatKeyDown(e: KeyboardEvent) {
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
		e.preventDefault();
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		menu = { x: r.left, y: r.bottom + 2, keyboard: true };
	}

	const openQuickOpen = () => void commands.run('workbench.action.quickOpen');

	// VS Code's title bar action: 22px, a 16px icon in 3px padding, 6px corners (kingu-old's radius scale).
	const ACTION = 'grid size-[22px] shrink-0 place-items-center rounded-[6px] enabled:hover:bg-(--vscode-toolbar-hoverBackground) disabled:text-(--vscode-disabledForeground)';
	const FOCUS = 'focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder)';
	// kingu-old's `.agent-status-pill`: 22px inside a 1px border, 6px corners, no fill of its own.
	const PILL = 'flex h-6 min-w-0 shrink-0 items-center overflow-hidden rounded-[6px] border border-(--vscode-commandCenter-border) text-(--vscode-commandCenter-foreground)';
	// A hairline before a section, 4px short of the pill's top and bottom.
	const SEPARATOR = "relative before:absolute before:inset-y-1 before:left-0 before:w-px before:bg-(--vscode-commandCenter-border) before:content-['']";
</script>

{#snippet arkai(standalone: boolean)}
	<!-- kingu-old's `.agent-status-badge-section.sparkle`: the Arkai chat mark, 16px, in 4px padding. -->
	<button
		class={[
			'grid shrink-0 place-items-center text-(--vscode-commandCenter-foreground)',
			FOCUS,
			standalone ? 'h-[22px] rounded-[5px] px-1 hover:bg-(--vscode-toolbar-hoverBackground)' : 'h-full bg-(--vscode-commandCenter-background) px-[5px] hover:bg-(--vscode-commandCenter-activeBackground)'
		]}
		title={`${t('titleBar.chat.hover')}${hint('workbench.action.toggleAuxiliaryBar')}`}
		aria-label={t('titleBar.chat.aria')}
		aria-haspopup="menu"
		aria-expanded={menu !== null}
		onclick={toggleChat}
		oncontextmenu={chatContextMenu}
		onkeydown={chatKeyDown}
	>
		<Codicon id="arkai-chat" size={16} />
	</button>
{/snippet}

{#snippet section(s: StatusSection, separated: boolean)}
	<!-- `.agent-status-badge-section`: 0 8px (unread 0 8px 0 6px), 11px semibold. -->
	<button
		class={[
			'flex h-full shrink-0 items-center gap-1 text-[11px] font-semibold',
			s.id === 'unread' ? 'pr-2 pl-1.5' : 'px-2',
			FOCUS,
			separated && SEPARATOR,
			filtered(s.id)
				? 'bg-(--vscode-inputOption-activeBackground) text-(--vscode-inputOption-activeForeground) hover:brightness-110'
				: 'bg-(--vscode-commandCenter-background) hover:bg-(--vscode-commandCenter-activeBackground)'
		]}
		title={`${s.title}\n${t('titleBar.filterHint')}`}
		aria-label={`${s.title} — ${s.label}`}
		aria-pressed={filtered(s.id)}
		onclick={() => toggleFilter(s.id)}
	>
		{#if s.id === 'needsInput'}
			<!-- `.active.needs-input`: the warning colour (the filtered colour while filtered). -->
			<Codicon id="report-question" size={16} class={filtered(s.id) ? '' : 'text-(--vscode-notificationsWarningIcon-foreground)'} />
		{:else if s.id === 'inProgress'}
			<Codicon id="session-in-progress" size={16} />
		{:else}
			<Codicon id="circle-filled" size={8} />
		{/if}
		<span class="whitespace-nowrap tabular-nums">{s.text}</span>
	</button>
{/snippet}

<div bind:this={root} class="command-center flex h-6 min-w-0 items-center gap-1 text-xs" role="toolbar" aria-label="Command Center">
	{#if navigationControl}
		<!-- Agents mode: back/forward walk the worktrees you looked at instead of editor locations. -->
		<button aria-label="Go Back" title="Go Back{hint('workbench.action.navigateBack')}" disabled={appMode.isAgents ? !appMode.canGoBack : !navigation.canGoBack} class={[ACTION, FOCUS]} onclick={() => (appMode.isAgents ? appMode.back() : navigation.back())}>
			<Codicon id="arrow-left" size={16} />
		</button>
		<button aria-label="Go Forward" title="Go Forward{hint('workbench.action.navigateForward')}" disabled={appMode.isAgents ? !appMode.canGoForward : !navigation.canGoForward} class={[ACTION, FOCUS]} onclick={() => (appMode.isAgents ? appMode.forward() : navigation.forward())}>
			<Codicon id="arrow-right" size={16} />
		</button>
	{/if}
	<div class="agent-status-container flex min-w-0 items-center gap-1" role="group" aria-label="Agent Status">
		{#if search === 'icon'}
			<!-- Too narrow for the box: the search as one title bar action. -->
			<button bind:this={searchEl} class={[ACTION, FOCUS, 'text-(--vscode-commandCenter-foreground)']} title={tooltip} aria-label={tooltip} onclick={openQuickOpen}>
				<Codicon id="search" size={16} />
			</button>
			{#if view.unified && sections.length}
				<div class={PILL}>{#each sections as s, i (s.id)}{@render section(s, i > 0)}{/each}</div>
			{/if}
		{:else}
			<div class={['agent-status-pill', PILL]}>
				<!-- `.agent-status-input-area`: 0 10px, the label a placeholder (60%), the key after it. -->
				<button
					bind:this={searchEl}
					class={[
						'flex h-full min-w-0 shrink-0 items-center gap-1.5 bg-(--vscode-commandCenter-background) px-2.5 text-left',
						'hover:bg-(--vscode-commandCenter-activeBackground) hover:text-(--vscode-commandCenter-activeForeground)',
						FOCUS
					]}
					style:width={searchWidth ? `${searchWidth}px` : undefined}
					title={tooltip}
					aria-label={tooltip}
					onclick={openQuickOpen}
				>
					<span class="min-w-0 flex-1 truncate opacity-60">{label}</span>
					{#if quickOpenKey}<span class="shrink-0 text-[11px] opacity-70" aria-hidden="true">{quickOpenKey}</span>{/if}
				</button>
				{#if view.unified}{#each sections as s (s.id)}{@render section(s, true)}{/each}{/if}
			</div>
		{/if}
		{#if badge}
			<div class={['agent-status-badge', PILL]}>
				{@render arkai(false)}
				{#each sections as s (s.id)}{@render section(s, true)}{/each}
			</div>
		{:else if standaloneArkai}
			{@render arkai(true)}
		{/if}
	</div>
	<!-- debug.toolBarLocation: commandCenter -->
	<DebugToolbar placement="commandCenter" />
</div>

{#if menu}
	<PopupMenu items={menuItems} label={t('titleBar.chat.menu')} x={menu.x} y={menu.y} focusFirst={menu.keyboard} onRun={runMenu} onClose={() => (menu = null)} />
{/if}
