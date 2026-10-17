<script lang="ts">
	// The command center (VS Code: MenuId.CommandCenter, commandCenterControl.ts): Back / Forward,
	// the search pill (`.command-center-center`) and the agents status widget (`.agent-status`).
	// `kingu.agentsControl.enabled: compact` merges the search into the agents pill (VS Code's
	// unified look), `badge` puts the agents pill next to the search box.
	import Icon from './Icon.svelte';
	import PopupMenu, { menuItem, menuSeparator } from './PopupMenu.svelte';
	import { commands, keyOf } from './commands.svelte';
	import { keyLabel } from './keys';
	import { layout } from './layout.svelte';
	import { navigation } from './navigation.svelte';
	import { agentStatusView, commandCenterTooltip, type AgentsControlMode, type StatusSection } from './titlebar';
	import type { MenuNode } from './menus';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { adeTasks } from '#lib/ade/tasks.svelte.ts';
	import { openAgents } from '#lib/ade/agentsMode.svelte.ts';
	import { appMode } from './mode.svelte';

	let { label, folderName }: { label: string; folderName: string | null } = $props();

	const key = (command: string) => {
		const cmd = commands.get(command);
		const k = cmd && keyOf(cmd);
		return k ? keyLabel(k) : undefined;
	};
	const hint = (command: string) => (key(command) ? ` (${key(command)})` : '');

	const navigationControl = $derived(settings.get<boolean>('workbench.navigationControl.enabled'));
	const agentsMode = $derived(settings.get<AgentsControlMode>('kingu.agentsControl.enabled'));
	const status = $derived(agentStatusView(adeTasks.counts, agentsMode));
	const tooltip = $derived(commandCenterTooltip({ folderName, quickOpenKey: key('workbench.action.quickOpen'), commandsKey: key('workbench.action.showCommands') }));

	let menu = $state<{ x: number; y: number; keyboard: boolean } | null>(null);
	const menuItems = $derived<MenuNode[]>([
		menuItem('kingu.agents.newTask', 'New Task', { enabled: commands.enabled('kingu.agents.newTask') }),
		menuItem('kingu.agents.show', 'Show Agents'),
		menuItem('kingu.agents.openBoard', 'Board', { enabled: commands.enabled('kingu.agents.openBoard') }),
		menuSeparator,
		menuItem('workbench.action.toggleAgentsMode', 'Open in Agents', { keyLabel: key('workbench.action.toggleAgentsMode') }),
		menuSeparator,
		menuItem('kingu.agents.settings', 'Agent Settings')
	]);

	function openMenu(e: MouseEvent) {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		menu = { x: r.right - 248, y: r.bottom + 2, keyboard: e.detail === 0 };
	}

	function runMenu(node: MenuNode) {
		if (node.type !== 'item') return;
		if (node.id === 'kingu.agents.settings') void commands.run('workbench.action.openSettings');
		else void commands.run(node.id);
	}

	const DOT: Record<StatusSection['id'], string> = {
		needsInput: 'bg-(--vscode-editorWarning-foreground)',
		inProgress: 'bg-(--vscode-editorInfo-foreground) motion-safe:animate-pulse',
		unread: 'bg-(--vscode-textLink-foreground)'
	};

	const PILL =
		'flex h-[22px] min-w-0 items-center rounded-md border border-(--vscode-commandCenter-border) bg-(--vscode-commandCenter-background) text-(--vscode-commandCenter-foreground) hover:border-(--vscode-commandCenter-activeBorder)';
	const NAV = 'grid size-[22px] shrink-0 place-items-center rounded-[5px] enabled:hover:bg-(--vscode-toolbar-hoverBackground) disabled:opacity-40';
</script>

{#snippet search(unified: boolean)}
	<button
		class={[
			'command-center-center flex h-full min-w-0 flex-1 items-center justify-center gap-1.5 px-2 text-xs hover:bg-(--vscode-commandCenter-activeBackground)',
			unified ? 'rounded-l-[5px]' : 'rounded-[5px]'
		]}
		title={tooltip}
		aria-label={tooltip}
		onclick={() => commands.run('workbench.action.quickOpen')}
	>
		<span class="shrink-0 opacity-80"><Icon name="search" size={14} /></span>
		<span class="truncate">{label}</span>
	</button>
{/snippet}

{#snippet agentParts()}
	{#each status.sections as s (s.id)}
		<button
			class="flex h-full shrink-0 items-center gap-1 border-l border-(--vscode-commandCenter-border) px-1.5 text-xs hover:bg-(--vscode-commandCenter-activeBackground)"
			title="{s.title} — เปิดในโหมด Agents"
			aria-label="{s.title} — เปิดในโหมด Agents"
			onclick={() => openAgents(s.id)}
		>
			<span class={['size-2 rounded-full', DOT[s.id]]}></span>
			<span class="tabular-nums">{s.count}</span>
			<span class="sr-only">{s.label}</span>
		</button>
	{/each}
	<!-- Split button: the Agent panel (secondary side bar) / the Agents menu. -->
	<button
		class={['grid h-full w-[26px] shrink-0 place-items-center border-l border-(--vscode-commandCenter-border) hover:bg-(--vscode-commandCenter-activeBackground)', !layout.auxVisible && 'opacity-70']}
		title="Toggle Agent (Secondary Side Bar){hint('workbench.action.toggleAuxiliaryBar')}"
		aria-label="Toggle Agent (Secondary Side Bar)"
		aria-pressed={layout.auxVisible}
		onclick={() => commands.run('workbench.action.toggleAuxiliaryBar')}
	>
		<Icon name="agent" size={14} />
	</button>
	<button
		class="grid h-full w-4 shrink-0 place-items-center rounded-r-[5px] hover:bg-(--vscode-commandCenter-activeBackground)"
		title="Agents"
		aria-label="Agents menu"
		aria-haspopup="menu"
		aria-expanded={menu !== null}
		onclick={openMenu}
	>
		<Icon name="chevronDown" size={12} />
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
	{#if status.unified}
		<div class={[PILL, 'agent-status unified mx-1.5 w-[min(600px,38vw)]']}>
			{@render search(true)}
			{@render agentParts()}
		</div>
	{:else}
		<div class={[PILL, 'mx-1.5 w-[min(600px,38vw)]']}>{@render search(false)}</div>
		{#if status.visible}
			<div class={[PILL, 'agent-status badge shrink-0 overflow-hidden [&>button:first-child]:border-l-0']}>
				{@render agentParts()}
			</div>
		{/if}
	{/if}
</div>

{#if menu}
	<PopupMenu items={menuItems} label="Agents" x={menu.x} y={menu.y} focusFirst={menu.keyboard} onRun={runMenu} onClose={() => (menu = null)} />
{/if}
