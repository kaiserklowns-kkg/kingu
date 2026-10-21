<script lang="ts">
	import { listWheel } from '#lib/workbench/listWheel.ts';
	// Call Hierarchy / Type Hierarchy section of the Explorer (VS Code: references-view's tree with
	// its title actions: switch direction, refresh, clear).
	import { t } from '#lib/i18n/index.ts';
	import Icon from './Icon.svelte';
	import { symbolCodicon } from './breadcrumbs';
	import { hierarchy } from './hierarchy.svelte';

	const root = $derived(hierarchy.roots[0]?.item.name ?? '');
	const message = $derived(
		hierarchy.direction === 'incoming'
			? t('language.hierarchy.incoming', { name: root })
			: hierarchy.direction === 'outgoing'
				? t('language.hierarchy.outgoing', { name: root })
				: hierarchy.direction === 'supertypes'
					? t('language.hierarchy.supertypes', { name: root })
					: t('language.hierarchy.subtypes', { name: root })
	);
	const flip = $derived(
		hierarchy.kind === 'call'
			? hierarchy.direction === 'incoming'
				? { label: t('language.hierarchy.showOutgoing'), to: 'outgoing' as const }
				: { label: t('language.hierarchy.showIncoming'), to: 'incoming' as const }
			: hierarchy.direction === 'subtypes'
				? { label: t('language.hierarchy.showSupertypes'), to: 'supertypes' as const }
				: { label: t('language.hierarchy.showSubtypes'), to: 'subtypes' as const }
	);
	let selected = $state<string | null>(null);
</script>

<section class="flex min-h-0 flex-1 flex-col border-t border-(--vscode-sideBarSectionHeader-border)" aria-label={hierarchy.title} data-view="hierarchy">
	<div class="group flex h-(--kg-row-height) shrink-0 items-center pr-1">
		<span class="flex h-full min-w-0 flex-1 items-center gap-0.5 px-0.5 text-[11px] font-bold uppercase text-(--vscode-sideBarTitle-foreground)">
			<Icon name="chevronDown" size={16} />
			<span class="truncate">{hierarchy.title}</span>
		</span>
		<div class="flex items-center">
			{#each [
				{ label: flip.label, icon: 'sync' as const, run: () => hierarchy.setDirection(flip.to) },
				{ label: t('language.hierarchy.refresh'), icon: 'refresh' as const, run: () => hierarchy.refresh() },
				{ label: t('language.hierarchy.clear'), icon: 'close' as const, run: () => hierarchy.clear() }
			] as a (a.label)}
				<button class="grid size-[22px] place-items-center rounded text-(--vscode-icon-foreground) hover:bg-(--vscode-toolbar-hoverBackground)" aria-label={a.label} title={a.label} onclick={() => void a.run()}>
					<Icon name={a.icon} size={16} />
				</button>
			{/each}
		</div>
	</div>
	<p class="truncate px-5 pb-1 text-xs text-(--vscode-descriptionForeground)">{message}</p>
	<div role="tree" aria-label={hierarchy.title} class="min-h-0 flex-1 overflow-y-auto" use:listWheel>
		{#each hierarchy.rows as row (row.node.id)}
			{@const n = row.node}
			<button
				role="treeitem"
				aria-selected={selected === n.id}
				aria-expanded={n.children?.length === 0 ? undefined : n.expanded}
				class={[
					'mx-1.5 flex h-(--kg-row-height) w-[calc(100%-12px)] items-center gap-1 rounded-md pr-2 text-left',
					selected === n.id ? 'bg-(--vscode-list-activeSelectionBackground) text-(--vscode-list-activeSelectionForeground)' : 'hover:bg-(--vscode-list-hoverBackground)'
				]}
				style:padding-left="{8 + row.depth * 8}px"
				title={n.item.detail ? `${n.item.name} — ${n.item.detail}` : n.item.name}
				onclick={(e) => {
					selected = n.id;
					if ((e.target as HTMLElement).closest('[data-twistie]')) void hierarchy.toggle(n);
					else hierarchy.open(n, false);
				}}
				ondblclick={() => hierarchy.open(n, true)}
				onkeydown={(e) => {
					if (e.key === 'Enter') hierarchy.open(n, true);
					else if ((e.key === 'ArrowRight' && !n.expanded) || (e.key === 'ArrowLeft' && n.expanded)) void hierarchy.toggle(n);
					else return;
					e.preventDefault();
				}}
			>
				<span class="flex w-4 shrink-0 justify-center text-(--vscode-icon-foreground)" data-twistie>
					{#if n.children?.length !== 0}<Icon name={n.expanded ? 'chevronDown' : 'chevronRight'} size={16} />{/if}
				</span>
				<span class={['codicon shrink-0', symbolCodicon(n.item.kind)]} aria-hidden="true"></span>
				<span class="min-w-0 truncate">{n.item.name}</span>
				{#if n.item.detail}<span class="min-w-0 truncate text-xs opacity-70">{n.item.detail}</span>{/if}
				{#if n.loading}<span class="ml-auto text-xs opacity-70">{t('language.hierarchy.loading')}</span>{/if}
			</button>
		{/each}
	</div>
</section>
