<script lang="ts">
	import Icon, { type IconName } from './Icon.svelte';
	import { layout, type SideView } from './layout.svelte';
	import { keyLabel } from './keys';
	import { scm } from './scm.svelte';
	import { commands, keyOf } from './commands.svelte';
	import { adeTasks } from '#lib/ade/tasks.svelte.ts';

	/**
	 * `vertical`: the activity bar (`workbench.activityBar.location: default`). `horizontal`: the
	 * view icons at the top of the side bar (`top`). Accounts and Manage are always in the title bar.
	 */
	let { orientation = 'vertical' }: { orientation?: 'vertical' | 'horizontal' } = $props();
	const vertical = $derived(orientation === 'vertical');

	// Count badges (VS Code activitybar badge: bottom-right, 16px).
	const badges: Partial<Record<SideView, () => number>> = { scm: () => scm.count, agents: () => adeTasks.attentionCount };
	const views: { view: SideView; label: string; icon: IconName; command: string }[] = [
		{ view: 'explorer', label: 'Explorer', icon: 'files', command: 'workbench.view.explorer' },
		{ view: 'search', label: 'Search', icon: 'search', command: 'workbench.action.findInFiles' },
		{ view: 'scm', label: 'Source Control', icon: 'git', command: 'workbench.view.scm' },
		{ view: 'agents', label: 'Agents', icon: 'tasks', command: 'kingu.agents.show' }
	];
	/** `Explorer (⇧⌘E)`, from the command's live keybinding. */
	const titled = (label: string, command: string) => {
		const cmd = commands.get(command);
		const key = cmd && keyOf(cmd);
		return key ? `${label} (${keyLabel(key)})` : label;
	};
	const ITEM = $derived(vertical ? 'relative grid size-12 place-items-center' : 'relative grid h-full w-8 place-items-center');
	const ICON = $derived(vertical ? 24 : 16);
	const agentLabel = $derived(titled('Arkai', 'workbench.action.toggleAuxiliaryBar'));
</script>

<!-- 48px wide, 48px items, 24px icons, 2px active indicator on the left (VS Code activitybarPart);
     at the top of the side bar: 16px icons, the indicator below. -->
<nav
	aria-label="Activity Bar"
	class={
		vertical
			? 'mr-[4px] flex w-(--kg-activitybar-width) shrink-0 flex-col items-center rounded-[8px] border border-(--vscode-widget-border)'
			: 'flex h-full items-center'
	}
>
	{#each views as v (v.view)}
		{@const on = layout.sidebarVisible && layout.sideView === v.view}
		{@const badge = badges[v.view]?.() ?? 0}
		{@const label = titled(v.label, v.command)}
		<button
			aria-label={label}
			aria-pressed={on}
			title={label}
			class={[
				ITEM,
				vertical
					? on
						? 'text-(--vscode-activityBar-foreground)'
						: 'text-(--vscode-activityBar-inactiveForeground) hover:text-(--vscode-activityBar-foreground)'
					: on
						? 'text-(--vscode-foreground)'
						: 'text-(--vscode-foreground) opacity-60 hover:opacity-100'
			]}
			onclick={() => layout.showView(v.view)}
		>
			{#if on}<span class={vertical ? 'absolute inset-y-0 left-0 w-0.5 bg-(--vscode-activityBar-activeBorder)' : 'absolute inset-x-1 bottom-0 h-px bg-(--vscode-foreground)'}></span>{/if}
			<Icon name={v.icon} size={ICON} filled={on} />
			{#if badge}
				<span
					class={[
						'absolute rounded-full bg-(--vscode-activityBarBadge-background) text-center font-semibold text-(--vscode-activityBarBadge-foreground)',
						vertical ? 'right-1.5 bottom-1.5 h-4 min-w-4 px-1 text-[9px] leading-4' : 'top-0.5 right-0 h-3.5 min-w-3.5 px-0.5 text-[8px] leading-3.5'
					]}
				>
					{badge > 999 ? '999+' : badge}
				</span>
			{/if}
		</button>
	{/each}
	<button
		aria-label={agentLabel}
		aria-pressed={layout.auxVisible}
		title={agentLabel}
		class={[
			ITEM,
			layout.auxVisible ? 'text-(--vscode-activityBar-foreground)' : 'text-(--vscode-activityBar-inactiveForeground) hover:text-(--vscode-activityBar-foreground)'
		]}
		onclick={() => (layout.auxVisible = !layout.auxVisible)}
	>
		<Icon name="agent" size={ICON} />
	</button>
</nav>
