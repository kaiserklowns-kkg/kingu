<script lang="ts">
	// The command center, laid out like kingu-old's (VS Code: MenuId.CommandCenter, commandCenterControl.ts,
	// and the chat contribution's agent status widget): Back / Forward, then the search pill, then the
	// Arkai chat button. `kingu.agentsControl.enabled`:
	// - compact (default): one pill holding the project and branch buttons, the search ("Search files
	//   and commands") and the agents status (needs input, in progress, unread); the Arkai chat button
	//   stands on its own after it.
	// - badge: the plain VS Code search box (folder name), then a separate badge with the Arkai chat
	//   button first and the status after it.
	// - hidden (or Zen Mode): the plain search box only.
	// A status section opens the Agents layout filtered to that group; clicking it again clears the filter.
	// The Arkai button toggles the chat (the secondary side bar); right-click or ↓ opens its menu.
	import Icon from './Icon.svelte';
	import PopupMenu, { menuItem, menuSeparator } from './PopupMenu.svelte';
	import { commands, keyOf } from './commands.svelte';
	import { keyLabel } from './keys';
	import { layout } from './layout.svelte';
	import { navigation } from './navigation.svelte';
	import { status as repoStatus } from './status.svelte';
	import { agentShortName, agentStatusView, commandCenterTooltip, statusAgents, type AgentsControlMode, type StatusSection } from './titlebar';
	import type { MenuNode } from './menus';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { adeTasks } from '#lib/ade/tasks.svelte.ts';
	import { projects } from '#lib/ade/projects.svelte.ts';
	import { openAgents } from '#lib/ade/agentsMode.svelte.ts';
	import { appMode } from './mode.svelte';
	import DebugToolbar from '#lib/debug/DebugToolbar.svelte';
	import { t } from '#lib/i18n/index.ts';

	/** `label`: the plain search box's (folder name or custom title); `compactLabel`: the unified pill's placeholder. */
	let { label, compactLabel, folderName }: { label: string; compactLabel: string; folderName: string | null } = $props();

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
	// No folder open: nothing can be unread (kingu-old hides the section in an empty window).
	const sections = $derived(view.sections.filter((s) => folderName || s.id !== 'unread'));
	const tooltip = $derived(commandCenterTooltip({ folderName, quickOpenKey: key('workbench.action.quickOpen'), commandsKey: key('workbench.action.showCommands') }));
	const quickAccessTooltip = $derived(`${t('titleBar.openQuickAccess')}${hint('workbench.action.quickOpen')}`);

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

	const NAV = 'grid size-[22px] shrink-0 place-items-center rounded-[5px] enabled:hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40';
	const PILL = 'flex h-[22px] min-w-0 items-center overflow-hidden rounded-md border border-(--vscode-commandCenter-border) bg-(--vscode-commandCenter-background) text-(--vscode-commandCenter-foreground)';
	const HOVER = 'hover:bg-(--vscode-commandCenter-activeBackground) hover:text-(--vscode-commandCenter-activeForeground)';
	const FOCUS = 'focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder)';
	// A hairline between neighbouring parts of a pill, 4px short of its top and bottom.
	const SEPARATOR = "relative before:absolute before:inset-y-1 before:left-0 before:w-px before:bg-(--vscode-commandCenter-border) before:content-['']";
</script>

{#snippet arkai(standalone: boolean)}
	<button
		class={[
			'grid shrink-0 place-items-center text-(--vscode-commandCenter-foreground)',
			FOCUS,
			standalone ? 'h-[22px] rounded-[5px] px-1 hover:bg-(--vscode-toolbar-hoverBackground)' : 'h-full px-[5px] hover:bg-(--vscode-commandCenter-activeBackground)'
		]}
		title={`${t('titleBar.chat.hover')}${hint('workbench.action.toggleAuxiliaryBar')}`}
		aria-label={t('titleBar.chat.aria')}
		aria-haspopup="menu"
		aria-expanded={menu !== null}
		onclick={toggleChat}
		oncontextmenu={chatContextMenu}
		onkeydown={chatKeyDown}
	>
		<Icon name="agent" size={16} />
	</button>
{/snippet}

{#snippet section(s: StatusSection, inPill: boolean)}
	<button
		class={[
			'flex h-full shrink-0 items-center gap-1 px-2 text-[11px] font-semibold',
			FOCUS,
			inPill && SEPARATOR,
			filtered(s.id) ? 'bg-(--vscode-inputOption-activeBackground) text-(--vscode-inputOption-activeForeground) hover:brightness-110' : 'hover:bg-(--vscode-commandCenter-activeBackground)'
		]}
		title={`${s.title}\n${t('titleBar.filterHint')}`}
		aria-label={`${s.title} — ${s.label}`}
		aria-pressed={filtered(s.id)}
		onclick={() => toggleFilter(s.id)}
	>
		{#if s.id === 'needsInput'}
			<Icon name="help" size={14} />
		{:else if s.id === 'inProgress'}
			<Icon name="circleDashed" size={14} />
		{:else}
			<span class="mx-[3px] size-2 rounded-full bg-current" aria-hidden="true"></span>
		{/if}
		<span class="whitespace-nowrap tabular-nums">{s.text}</span>
	</button>
{/snippet}

{#snippet segment(icon: 'folder' | 'branch', text: string, tip: string, command: string, first: boolean)}
	<button
		class={['flex h-[18px] min-w-0 items-center gap-1 rounded-[4px] px-[5px] whitespace-nowrap', HOVER, FOCUS]}
		title={tip}
		aria-label={`${tip}: ${text}`}
		onclick={() => commands.run(command)}
	>
		<span class="shrink-0"><Icon name={icon} size={14} /></span>
		<span class={['max-w-[180px] truncate', first && 'font-semibold']}>{text}</span>
		<span class="shrink-0 opacity-60"><Icon name="chevronDown" size={12} /></span>
	</button>
{/snippet}

<div class="command-center flex h-full min-w-0 items-center gap-1" role="toolbar" aria-label="Command Center">
	{#if navigationControl}
		<!-- Agents mode: back/forward walk the worktrees you looked at instead of editor locations. -->
		<button aria-label="Go Back" title="Go Back{hint('workbench.action.navigateBack')}" disabled={appMode.isAgents ? !appMode.canGoBack : !navigation.canGoBack} class={NAV} onclick={() => (appMode.isAgents ? appMode.back() : navigation.back())}>
			<Icon name="arrowLeft" size={16} />
		</button>
		<button aria-label="Go Forward" title="Go Forward{hint('workbench.action.navigateForward')}" disabled={appMode.isAgents ? !appMode.canGoForward : !navigation.canGoForward} class={NAV} onclick={() => (appMode.isAgents ? appMode.forward() : navigation.forward())}>
			<Icon name="arrowRight" size={16} />
		</button>
	{/if}
	{#if view.unified}
		<div class={[PILL, 'agent-status-pill compact ml-1.5 w-[min(600px,38vw)] text-xs']}>
			{#if folderName}
				<!-- Where the work is: the project (Open Recent) and its branch (Git: Checkout to...). -->
				<span class="flex min-w-0 shrink items-center gap-0.5 border-r border-(--vscode-commandCenter-border) pr-1.5 pl-0.5 mr-0.5">
					{@render segment('folder', folderName, t('titleBar.switchProject'), 'workbench.action.openRecent', true)}
					{#if repoStatus.branch}{@render segment('branch', repoStatus.branch, t('titleBar.switchBranch'), 'git.checkout', false)}{/if}
				</span>
			{/if}
			<button
				class={['command-center-center flex h-full min-w-0 flex-1 items-center px-2.5 text-left', folderName ? 'rounded-none' : 'rounded-l-[5px]', HOVER, FOCUS]}
				title={quickAccessTooltip}
				aria-label={quickAccessTooltip}
				onclick={() => commands.run('workbench.action.quickOpen')}
			>
				<span class="truncate opacity-60">{compactLabel}</span>
			</button>
			{#each sections as s (s.id)}{@render section(s, true)}{/each}
		</div>
		{@render arkai(true)}
	{:else}
		<div class={[PILL, 'mx-1.5 w-[min(600px,38vw)] hover:border-(--vscode-commandCenter-activeBorder)']}>
			<button
				class={['command-center-center flex h-full min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[5px] px-2 text-xs', HOVER, FOCUS]}
				title={tooltip}
				aria-label={tooltip}
				onclick={() => commands.run('workbench.action.quickOpen')}
			>
				<span class="shrink-0 opacity-80"><Icon name="search" size={14} /></span>
				<span class="truncate">{label}</span>
			</button>
		</div>
		{#if view.visible}
			<div class={[PILL, 'agent-status-badge shrink-0']}>
				{@render arkai(false)}
				{#each sections as s (s.id)}{@render section(s, true)}{/each}
			</div>
		{/if}
	{/if}
	<!-- debug.toolBarLocation: commandCenter -->
	<DebugToolbar placement="commandCenter" />
</div>

{#if menu}
	<PopupMenu items={menuItems} label={t('titleBar.chat.menu')} x={menu.x} y={menu.y} focusFirst={menu.keyboard} onRun={runMenu} onClose={() => (menu = null)} />
{/if}
