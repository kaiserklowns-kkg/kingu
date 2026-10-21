<script lang="ts">
	import Icon, { type IconName } from './Icon.svelte';
	import { settings } from '#lib/settings/settings.svelte.ts';
	import { layout, type SideView } from './layout.svelte';
	import { keyLabel } from './keys';
	import { scm } from './scm.svelte';
	import { commands, keyOf } from './commands.svelte';
	import { adeTasks } from '#lib/ade/tasks.svelte.ts';
	import { snaps } from '#lib/snaps/snaps.svelte.ts';
	import { testing } from '#lib/testing/testing.svelte.ts';
	import { pendingTrustCount } from '#lib/snaps/snapModel.ts';
	import { viewsOf } from '#lib/snaps/contributions.ts';
	import { activityBarMetrics, activityClickHides } from './workbenchOptions';
	import { t } from '#lib/i18n/index.ts';
	import type { Edge } from './workbenchGrid';

	/**
	 * `vertical`: the activity bar (`workbench.activityBar.location: default`, 36px wide with
	 * `workbench.activityBar.compact`). `horizontal`: the view icons at the top or bottom of the side
	 * bar (`top`, `bottom`). Accounts and Manage are always in the title bar.
	 * `join` (vertical): how its card meets the side bar's (workbenchGrid railJoin).
	 */
	let { orientation = 'vertical', join = { railSquare: null, gap: 'right' } }: { orientation?: 'vertical' | 'horizontal'; join?: { railSquare: Edge | null; gap: Edge | null } } = $props();
	const vertical = $derived(orientation === 'vertical');
	// kingu-old's floating rail (floatingPanels.css `.part.activitybar`): a 10px card on the surface
	// border, square where it meets the side bar.
	const RAIL = $derived([
		'flex shrink-0 flex-col items-center rounded-(--vscode-cornerRadius-large) border border-(--vscode-modernActivityBar-border,var(--vscode-surface-border,var(--vscode-widget-border,transparent)))',
		join.railSquare === 'right' && 'rounded-r-none',
		join.railSquare === 'left' && 'rounded-l-none',
		join.gap === 'right' && 'mr-[4px]',
		join.gap === 'left' && 'ml-[4px]'
	]);

	// Count badges (VS Code activitybar badge: bottom-right, 16px).
	const badges: Partial<Record<SideView, () => number>> = { scm: () => scm.count, snaps: () => pendingTrustCount(snaps.list), agents: () => adeTasks.attentionCount, testing: () => testing.badge };
	const builtinViews: { view: SideView; label: string; icon: IconName; command: string }[] = [
		{ view: 'explorer', label: 'Explorer', icon: 'files', command: 'workbench.view.explorer' },
		{ view: 'search', label: 'Search', icon: 'search', command: 'workbench.action.findInFiles' },
		{ view: 'scm', label: 'Source Control', icon: 'git', command: 'workbench.view.scm' },
		{ view: 'debug', label: 'Run and Debug', icon: 'bug', command: 'workbench.view.debug' },
		{ view: 'testing', label: 'Testing', icon: 'listChecks', command: 'workbench.view.testing' },
		{ view: 'snaps', label: 'Snaps', icon: 'snap', command: 'workbench.view.snaps' },
		{ view: 'agents', label: 'Agents', icon: 'tasks', command: 'kingu.agents.show' },
		{ view: 'vault', label: t('vault.title'), icon: 'clock', command: 'kingu.vault.show' },
		{ view: 'artifacts', label: t('artifacts.title'), icon: 'layout', command: 'kingu.artifacts.show' }
	];
	// Snaps' side bar views after Kingu's own (VS Code: an extension's view container).
	const views = $derived([...builtinViews, ...viewsOf(snaps.all, 'sidebar').map((v) => ({ view: `snap:${v.key}` as SideView, label: `${v.view.name} (${v.snap.name})`, icon: 'snap' as IconName, command: '' }))]);
	/** `Explorer (⇧⌘E)`, from the command's live keybinding. */
	const titled = (label: string, command: string) => {
		const cmd = commands.get(command);
		const key = cmd && keyOf(cmd);
		return key ? `${label} (${keyLabel(key)})` : label;
	};
	const metrics = $derived(activityBarMetrics(settings.get<boolean>('workbench.activityBar.compact')));
	const ITEM = $derived(vertical ? 'relative grid w-full place-items-center' : 'relative grid h-full w-8 place-items-center');
	const ICON = $derived(vertical ? metrics.icon : 16);
	/** `workbench.activityBar.iconClickBehavior` (only for the vertical activity bar, like VS Code): `focus` keeps the side bar open. */
	function select(view: SideView) {
		if (vertical && layout.sideView === view && !activityClickHides(settings.get<string>('workbench.activityBar.iconClickBehavior'), layout.sidebarVisible, true)) {
			layout.sidebarVisible = true;
			return;
		}
		layout.showView(view);
	}
</script>

<!-- 48px wide, 48px items, 24px icons, 2px active indicator on the left (VS Code activitybarPart);
     at the top of the side bar: 16px icons, the indicator below. -->
<nav
	aria-label="Activity Bar"
	class={vertical ? RAIL : 'flex h-full items-center'}
	style:width={vertical ? `${metrics.width}px` : undefined}
>
	{#each views.filter((v) => v.view !== 'artifacts' || settings.get<boolean>('kingu.artifacts.showButton') !== false) as v (v.view)}
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
			style:height={vertical ? `${metrics.item}px` : undefined}
			onclick={() => select(v.view)}
		>
			{#if on}<span class={vertical ? 'absolute inset-y-0 left-0 w-0.5 bg-(--vscode-activityBar-activeBorder)' : 'absolute inset-x-1 bottom-0 h-px bg-(--vscode-foreground)'}></span>{/if}
			<Icon name={v.icon} size={ICON} filled={on} />
			{#if badge}
				<span
					class={[
						'absolute rounded-full bg-(--vscode-activityBarBadge-background) text-center font-semibold text-(--vscode-activityBarBadge-foreground)',
						vertical ? (metrics.width < 48 ? 'right-0.5 bottom-0 h-4 min-w-4 px-1 text-[9px] leading-4' : 'right-1.5 bottom-1.5 h-4 min-w-4 px-1 text-[9px] leading-4') : 'top-0.5 right-0 h-3.5 min-w-3.5 px-0.5 text-[8px] leading-3.5'
					]}
				>
					{badge > 999 ? '999+' : badge}
				</span>
			{/if}
		</button>
	{/each}
	<!-- No Arkai item here: the chat is the title bar's Arkai button and the secondary side bar (⌥⌘B). -->
</nav>
